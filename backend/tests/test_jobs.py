import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from dancing_cats_backend.analyzer import SongAnalysis, SongSegment
from dancing_cats_backend.config import Settings
from dancing_cats_backend.jobs import JobManager
from dancing_cats_backend.youtube import DownloadedAudio


class BatchJobTests(unittest.TestCase):
    def test_analyzes_track_once_and_plans_all_assets(self):
        analysis = SongAnalysis(
            bpm=120,
            beats=[index * 0.5 for index in range(17)],
            downbeats=[0, 2, 4, 6, 8],
            beat_positions=[index % 4 + 1 for index in range(17)],
            segments=[SongSegment(0, 8.5, "chorus", 0.8)],
            duration=8.5,
        )
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            assets = root / "assets"
            (assets / "cats" / "a").mkdir(parents=True)
            (assets / "cats" / "b").mkdir(parents=True)
            (assets / "catalog.json").write_text(json.dumps({
                "assets": [
                    {"id": "a", "motionMap": "cats/a/motion-map.json"},
                    {"id": "b", "motionMap": "cats/b/motion-map.json"},
                ]
            }))
            for asset_id in ("a", "b"):
                (assets / "cats" / asset_id / "motion-map.json").write_text(json.dumps({
                    "id": asset_id,
                    "segments": [{
                        "id": "move", "beats": 4, "energy": 0.8,
                        "sourceStart": 0, "sourceEnd": 2,
                    }],
                }))
            settings = Settings(
                project_root=root,
                data_dir=root / "data",
                cache_dir=root / "data" / "maps",
                assets_dir=assets,
                host="127.0.0.1",
                port=8765,
                max_duration_seconds=900,
            )
            settings.prepare()
            downloaded = DownloadedAudio("_VvPjfjOpxE", "Test", 8.5, root / "audio.wav")

            with patch("dancing_cats_backend.jobs.warm_up_analyzer"), patch(
                "dancing_cats_backend.jobs.download_audio", return_value=downloaded
            ) as download, patch(
                "dancing_cats_backend.jobs.analyze_music", return_value=analysis
            ) as analyze, patch(
                "dancing_cats_backend.jobs.build_choreography",
                side_effect=lambda _analysis, motion_map, **_kwargs: {
                    "assetId": motion_map["id"],
                    "cues": [{"start": 0, "end": 2}],
                },
            ) as plan:
                manager = JobManager(settings)
                job = manager.submit(
                    "https://www.youtube.com/watch?v=_VvPjfjOpxE",
                    ["a", "b"],
                )
                deadline = time.monotonic() + 3
                while job.status in {"queued", "running"} and time.monotonic() < deadline:
                    time.sleep(0.01)

                self.assertEqual(job.status, "complete")
                self.assertEqual(download.call_count, 1)
                self.assertEqual(analyze.call_count, 1)
                self.assertEqual(plan.call_count, 2)
                self.assertTrue(manager.analysis_path(job.track_key).is_file())
                self.assertTrue(all(manager.map_path(key).is_file() for key in job.map_keys.values()))

                cached = manager.submit(
                    "https://www.youtube.com/watch?v=_VvPjfjOpxE",
                    ["a", "b"],
                )
                self.assertEqual(cached.stage, "cached")
                self.assertEqual(download.call_count, 1)
                self.assertEqual(analyze.call_count, 1)
                manager.shutdown()


if __name__ == "__main__":
    unittest.main()
