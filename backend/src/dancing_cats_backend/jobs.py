from __future__ import annotations

import hashlib
import json
import logging
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .analyzer import analyze_music, analyzer_model_name, warm_up_analyzer
from .choreography import build_choreography, load_motion_map
from .config import Settings
from .youtube import download_audio, extract_video_id


LOGGER = logging.getLogger(__name__)


@dataclass
class Job:
    job_id: str
    video_id: str
    cache_key: str
    status: str = "queued"
    stage: str = "queued"
    error: str | None = None


class JobManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="music-analysis")
        self.warmup_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model-warmup")
        self.lock = threading.Lock()
        self.jobs: dict[str, Job] = {}
        self.active_by_key: dict[str, str] = {}
        self.warmup_executor.submit(self._warm_up)

    def submit(self, youtube_url: str, asset_id: str, force: bool = False) -> Job:
        video_id = extract_video_id(youtube_url)
        motion_map, asset_version = load_motion_map(self.settings.assets_dir, asset_id)
        cache_key = hashlib.sha256(
            f"{video_id}:{asset_id}:{asset_version}:{analyzer_model_name()}:planner-v4".encode()
        ).hexdigest()[:24]
        with self.lock:
            active_id = self.active_by_key.get(cache_key)
            if active_id and self.jobs[active_id].status in {"queued", "running"}:
                active = self.jobs[active_id]
                LOGGER.info(
                    "Reusing analysis job %s for video %s: status=%s stage=%s",
                    active.job_id,
                    active.video_id,
                    active.status,
                    active.stage,
                )
                return active
            job = Job(job_id=uuid.uuid4().hex, video_id=video_id, cache_key=cache_key)
            if self.map_path(cache_key).is_file() and not force:
                job.status = "complete"
                job.stage = "cached"
                LOGGER.info(
                    "Analysis job %s for video %s: status=complete stage=cached",
                    job.job_id,
                    video_id,
                )
            self.jobs[job.job_id] = job
            if job.status != "complete":
                self.active_by_key[cache_key] = job.job_id
                LOGGER.info(
                    "Analysis job %s for video %s: status=queued stage=queued",
                    job.job_id,
                    video_id,
                )
                self.executor.submit(
                    self._run,
                    job.job_id,
                    youtube_url,
                    motion_map,
                    asset_version,
                )
            return job

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def map_path(self, cache_key: str) -> Path:
        return self.settings.cache_dir / f"{cache_key}.json"

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=False)
        self.warmup_executor.shutdown(wait=False, cancel_futures=False)

    def _run(
        self,
        job_id: str,
        youtube_url: str,
        motion_map: dict,
        asset_version: str,
    ) -> None:
        self._set_status(job_id, "running", stage="downloading")
        job = self.get(job_id)
        if job is None:
            return
        LOGGER.info("Starting analysis job %s for video %s", job_id, job.video_id)
        started_at = time.perf_counter()
        try:
            with tempfile.TemporaryDirectory(prefix="dancing-cats-") as temporary:
                stage_started_at = time.perf_counter()
                audio = download_audio(
                    youtube_url,
                    Path(temporary),
                    self.settings.max_duration_seconds,
                )
                LOGGER.info(
                    "Analysis job %s downloaded and converted audio in %.2fs",
                    job_id,
                    time.perf_counter() - stage_started_at,
                )
                self._set_status(job_id, "running", stage="analyzing")
                stage_started_at = time.perf_counter()
                analysis = analyze_music(audio.wav_path)
                LOGGER.info(
                    "Analysis job %s ran %s inference in %.2fs",
                    job_id,
                    analyzer_model_name(),
                    time.perf_counter() - stage_started_at,
                )
                self._set_status(job_id, "running", stage="planning")
                stage_started_at = time.perf_counter()
                choreography = build_choreography(
                    analysis,
                    motion_map,
                    video_id=audio.video_id,
                    title=audio.title,
                    asset_version=asset_version,
                )
                destination = self.map_path(job.cache_key)
                temporary_map = destination.with_suffix(".tmp")
                temporary_map.write_text(
                    json.dumps(choreography, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                temporary_map.replace(destination)
                LOGGER.info(
                    "Analysis job %s planned and stored choreography in %.2fs",
                    job_id,
                    time.perf_counter() - stage_started_at,
                )
            self._set_status(job_id, "complete", stage="complete")
            LOGGER.info(
                "Analysis job %s completed with %d choreography cues in %.2fs",
                job_id,
                len(choreography["cues"]),
                time.perf_counter() - started_at,
            )
        except Exception as error:
            LOGGER.exception("Analysis job %s failed for video %s", job_id, job.video_id)
            self._set_status(job_id, "error", stage="error", error=_safe_error(error))
        finally:
            with self.lock:
                self.active_by_key.pop(job.cache_key, None)

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
                        "Analysis job %s for video %s: status=%s stage=%s",
                        job.job_id,
                        job.video_id,
                        status,
                        stage,
                    )


def _safe_error(error: Exception) -> str:
    message = str(error).strip() or error.__class__.__name__
    return message[-1000:]
