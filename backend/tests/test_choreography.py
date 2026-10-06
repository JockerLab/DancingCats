import unittest

from dancing_cats_backend.analyzer import SongAnalysis, SongSegment
from dancing_cats_backend.choreography import build_choreography


class ChoreographyTests(unittest.TestCase):
    def test_builds_contiguous_cues_with_motion_metadata(self):
        beats = [index * 0.5 for index in range(49)]
        analysis = SongAnalysis(
            bpm=120,
            beats=beats,
            downbeats=beats[::4],
            beat_positions=[index % 4 + 1 for index in range(len(beats))],
            segments=[SongSegment(0, 24.5, "chorus", 0.9)],
            duration=24.5,
        )
        motion_map = {
            "id": "test-cats",
            "segments": [
                {
                    "id": "a", "beats": 8, "energy": 0.5,
                    "sourceStart": 0, "sourceEnd": 4,
                    "entryPose": "front", "exitPose": "side", "next": ["b"],
                },
                {
                    "id": "b", "beats": 8, "energy": 0.9,
                    "sourceStart": 4, "sourceEnd": 8,
                    "entryPose": "side", "exitPose": "front", "next": ["a"],
                },
            ],
        }
        result = build_choreography(
            analysis,
            motion_map,
            video_id="_VvPjfjOpxE",
            title="Test",
            asset_version="abc",
        )
        self.assertEqual(len(result["cues"]), 6)
        self.assertEqual(result["cues"][0]["start"], 0)
        self.assertEqual(result["cues"][0]["end"], result["cues"][1]["start"])
        self.assertNotIn("scale", result["cues"][0])
        self.assertNotIn("mirror", result["cues"][0])
        self.assertIn("motionProfile", result["cues"][0])
        self.assertEqual({cue["segmentId"] for cue in result["cues"]}, {"a", "b"})

    def test_energy_selection_does_not_reproduce_the_native_loop(self):
        beats = [index * 0.5 for index in range(33)]
        analysis = SongAnalysis(
            bpm=120,
            beats=beats,
            downbeats=beats[::4],
            beat_positions=[index % 4 + 1 for index in range(len(beats))],
            segments=[SongSegment(0, 16.5, "drop", 0.95)],
            duration=16.5,
        )
        motion_map = {
            "id": "test-cats",
            "segments": [
                {
                    "id": "low", "beats": 8, "energy": 0.2,
                    "sourceStart": 0, "sourceEnd": 4,
                    "entryPose": "a", "exitPose": "b", "next": ["medium"],
                },
                {
                    "id": "medium", "beats": 8, "energy": 0.6,
                    "sourceStart": 4, "sourceEnd": 8,
                    "entryPose": "b", "exitPose": "c", "next": ["high"],
                },
                {
                    "id": "high", "beats": 8, "energy": 0.95,
                    "sourceStart": 8, "sourceEnd": 12,
                    "entryPose": "c", "exitPose": "a", "next": ["low"],
                },
            ],
        }
        result = build_choreography(
            analysis,
            motion_map,
            video_id="_VvPjfjOpxE",
            title="Test",
            asset_version="abc",
        )
        segment_ids = [cue["segmentId"] for cue in result["cues"]]
        self.assertNotEqual(segment_ids[:3], ["low", "medium", "high"])
        self.assertNotIn("low", segment_ids)
        self.assertIn("high", segment_ids)
        self.assertTrue(all(left != right for left, right in zip(segment_ids, segment_ids[1:])))

    def test_repeats_loopable_motion_with_a_limit(self):
        beats = [index * 0.5 for index in range(41)]
        analysis = SongAnalysis(
            bpm=140,
            beats=beats,
            downbeats=beats[::4],
            beat_positions=[index % 4 + 1 for index in range(len(beats))],
            segments=[SongSegment(0, 20.5, "chorus", 0.95)],
            duration=20.5,
        )
        motion_map = {
            "id": "test-cats",
            "segments": [
                {
                    "id": "calm", "beats": 4, "energy": 0.2,
                    "sourceStart": 0, "sourceEnd": 2,
                    "entryPose": "a", "exitPose": "a", "next": ["dynamic"],
                    "hardCutSafe": True, "loopable": False, "maxConsecutive": 1,
                },
                {
                    "id": "dynamic", "beats": 4, "energy": 0.95,
                    "sourceStart": 2, "sourceEnd": 4,
                    "entryPose": "b", "exitPose": "b", "next": ["dynamic", "calm"],
                    "hardCutSafe": True, "loopable": True, "maxConsecutive": 2,
                    "sectionAffinity": ["chorus"], "tempoRange": [120, 180],
                },
            ],
        }
        result = build_choreography(
            analysis,
            motion_map,
            video_id="_VvPjfjOpxE",
            title="Test",
            asset_version="abc",
        )
        segment_ids = [cue["segmentId"] for cue in result["cues"]]
        self.assertIn(("dynamic", "dynamic"), zip(segment_ids, segment_ids[1:]))
        self.assertNotIn(
            ("dynamic", "dynamic", "dynamic"),
            zip(segment_ids, segment_ids[1:], segment_ids[2:]),
        )


if __name__ == "__main__":
    unittest.main()
