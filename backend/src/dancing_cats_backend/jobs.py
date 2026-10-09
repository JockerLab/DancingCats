from __future__ import annotations

import hashlib
import json
import logging
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .analyzer import SongAnalysis, analyze_music, analyzer_model_name, warm_up_analyzer
from .choreography import build_choreography, load_motion_map
from .config import Settings
from .youtube import download_audio, extract_video_id


LOGGER = logging.getLogger(__name__)
ANALYSIS_CACHE_VERSION = "track-analysis-v1"
PLANNER_VERSION = "planner-v5"


@dataclass
class Job:
    job_id: str
    video_id: str
    track_key: str
    map_keys: dict[str, str]
    status: str = "queued"
    stage: str = "queued"
    error: str | None = None


class JobManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        # Download and ML inference stay serialized to avoid CPU/RAM contention.
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="music-analysis")
        self.warmup_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model-warmup")
        self.lock = threading.Lock()
        self.jobs: dict[str, Job] = {}
        self.active_by_key: dict[str, str] = {}
        self.warmup_executor.submit(self._warm_up)

    def submit(self, youtube_url: str, asset_ids: list[str], force: bool = False) -> Job:
        video_id = extract_video_id(youtube_url)
        requested_ids = list(dict.fromkeys(asset_ids))
        if not requested_ids:
            raise ValueError("At least one asset is required")

        assets: dict[str, tuple[dict[str, Any], str]] = {
            asset_id: load_motion_map(self.settings.assets_dir, asset_id)
            for asset_id in requested_ids
        }
        track_key = hashlib.sha256(
            f"{video_id}:{analyzer_model_name()}:{ANALYSIS_CACHE_VERSION}".encode()
        ).hexdigest()[:24]
        map_keys = {
            asset_id: hashlib.sha256(
                f"{track_key}:{asset_id}:{version}:{PLANNER_VERSION}".encode()
            ).hexdigest()[:24]
            for asset_id, (_, version) in assets.items()
        }
        batch_key = hashlib.sha256(
            f"{track_key}:{','.join(sorted(map_keys.values()))}".encode()
        ).hexdigest()[:24]

        with self.lock:
            active_id = self.active_by_key.get(batch_key)
            if active_id and self.jobs[active_id].status in {"queued", "running"}:
                active = self.jobs[active_id]
                LOGGER.info(
                    "Reusing batch job %s for video %s: status=%s stage=%s",
                    active.job_id,
                    active.video_id,
                    active.status,
                    active.stage,
                )
                return active

            job = Job(
                job_id=uuid.uuid4().hex,
                video_id=video_id,
                track_key=track_key,
                map_keys=map_keys,
            )
            if all(self.map_path(key).is_file() for key in map_keys.values()) and not force:
                job.status = "complete"
                job.stage = "cached"
                LOGGER.info(
                    "Batch job %s for video %s: status=complete stage=cached assets=%s",
                    job.job_id,
                    video_id,
                    ",".join(requested_ids),
                )
            self.jobs[job.job_id] = job
            if job.status != "complete":
                self.active_by_key[batch_key] = job.job_id
                LOGGER.info(
                    "Batch job %s for video %s: status=queued stage=queued assets=%s",
                    job.job_id,
                    video_id,
                    ",".join(requested_ids),
                )
                self.executor.submit(
                    self._run,
                    job.job_id,
                    batch_key,
                    youtube_url,
                    assets,
                    force,
                )
            return job

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def map_path(self, cache_key: str) -> Path:
        return self.settings.cache_dir / f"{cache_key}.json"

    def analysis_path(self, track_key: str) -> Path:
        return self.settings.data_dir / "analyses" / f"{track_key}.json"

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=False)
        self.warmup_executor.shutdown(wait=False, cancel_futures=False)

    def _run(
        self,
        job_id: str,
        batch_key: str,
        youtube_url: str,
        assets: dict[str, tuple[dict[str, Any], str]],
        force: bool,
    ) -> None:
        job = self.get(job_id)
        if job is None:
            return
        LOGGER.info("Starting batch job %s for video %s", job_id, job.video_id)
        started_at = time.perf_counter()
        try:
            analysis_cache = self.analysis_path(job.track_key)
            if analysis_cache.is_file() and not force:
                self._set_status(job_id, "running", stage="analyzing")
                cached = json.loads(analysis_cache.read_text(encoding="utf-8"))
                analysis = SongAnalysis.from_dict(cached["song"])
                title = str(cached.get("title", ""))
                video_id = str(cached.get("videoId", job.video_id))
                LOGGER.info(
                    "Batch job %s reused cached track analysis %s",
                    job_id,
                    job.track_key,
                )
            else:
                self._set_status(job_id, "running", stage="downloading")
                with tempfile.TemporaryDirectory(prefix="dancing-cats-") as temporary:
                    stage_started_at = time.perf_counter()
                    audio = download_audio(
                        youtube_url,
                        Path(temporary),
                        self.settings.max_duration_seconds,
                    )
                    LOGGER.info(
                        "Batch job %s downloaded and converted audio in %.2fs",
                        job_id,
                        time.perf_counter() - stage_started_at,
                    )
                    self._set_status(job_id, "running", stage="analyzing")
                    stage_started_at = time.perf_counter()
                    analysis = analyze_music(audio.wav_path)
                    title = audio.title
                    video_id = audio.video_id
                    LOGGER.info(
                        "Batch job %s ran %s inference in %.2fs",
                        job_id,
                        analyzer_model_name(),
                        time.perf_counter() - stage_started_at,
                    )
                self._store_json(
                    analysis_cache,
                    {
                        "schemaVersion": 1,
                        "videoId": video_id,
                        "title": title,
                        "analyzer": analyzer_model_name(),
                        "song": analysis.to_dict(),
                    },
                )

            self._set_status(job_id, "running", stage="planning")
            stage_started_at = time.perf_counter()
            pending = {
                asset_id: asset
                for asset_id, asset in assets.items()
                if force or not self.map_path(job.map_keys[asset_id]).is_file()
            }
            cue_counts: dict[str, int] = {}
            if pending:
                with ThreadPoolExecutor(
                    max_workers=min(4, len(pending)),
                    thread_name_prefix="choreography-planner",
                ) as planner:
                    futures = {
                        planner.submit(
                            build_choreography,
                            analysis,
                            motion_map,
                            video_id=video_id,
                            title=title,
                            asset_version=asset_version,
                        ): asset_id
                        for asset_id, (motion_map, asset_version) in pending.items()
                    }
                    for future in as_completed(futures):
                        asset_id = futures[future]
                        choreography = future.result()
                        self._store_json(
                            self.map_path(job.map_keys[asset_id]),
                            choreography,
                        )
                        cue_counts[asset_id] = len(choreography["cues"])
            LOGGER.info(
                "Batch job %s planned %d/%d asset maps in parallel in %.2fs",
                job_id,
                len(pending),
                len(assets),
                time.perf_counter() - stage_started_at,
            )
            self._set_status(job_id, "complete", stage="complete")
            LOGGER.info(
                "Batch job %s completed %d asset maps in %.2fs; new cue counts=%s",
                job_id,
                len(assets),
                time.perf_counter() - started_at,
                cue_counts,
            )
        except Exception as error:
            LOGGER.exception("Batch job %s failed for video %s", job_id, job.video_id)
            self._set_status(job_id, "error", stage="error", error=_safe_error(error))
        finally:
            with self.lock:
                self.active_by_key.pop(batch_key, None)

    @staticmethod
    def _store_json(destination: Path, payload: dict[str, Any]) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(f".{uuid.uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(destination)

    def _warm_up(self) -> None:
        try:
            warm_up_analyzer()
        except Exception:
            LOGGER.exception("Unable to warm up the rhythm analyzer; the first job will retry")

    def _set_status(
        self,
        job_id: str,
        status: str,
        *,
        stage: str,
        error: str | None = None,
    ) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job:
                changed = job.status != status or job.stage != stage
                job.status = status
                job.stage = stage
                job.error = error
                if changed:
                    LOGGER.info(
                        "Batch job %s for video %s: status=%s stage=%s",
                        job.job_id,
                        job.video_id,
                        status,
                        stage,
                    )


def _safe_error(error: Exception) -> str:
    message = str(error).strip() or error.__class__.__name__
    return message[-1000:]
