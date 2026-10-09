import unittest

import numpy as np

from dancing_cats_backend.analyzer import (
    SongAnalysis,
    SongBar,
    SongSegment,
    _estimate_bpm,
    _infer_beat_positions,
    _label_sections,
    _section_slices,
)


class AnalyzerTests(unittest.TestCase):
    def test_estimates_tempo_and_positions_from_downbeats(self):
        beats = [index * 0.5 for index in range(16)]
        downbeats = beats[::4]

        self.assertEqual(_estimate_bpm(beats), 120)
        self.assertEqual(
            _infer_beat_positions(beats, downbeats),
            [1, 2, 3, 4] * 4,
        )

    def test_section_boundaries_keep_sections_long_enough(self):
        novelty = np.asarray([0, 0.1, 0.2, 0.3, 3, 0.2, 0.1, 0.2, 2, 0.1, 0.2, 0.1])
        sections = _section_slices(novelty, len(novelty), duration=90)

        self.assertEqual(sections[0][0], 0)
        self.assertEqual(sections[-1][1], len(novelty))
        self.assertTrue(all(right - left >= 3 for left, right in sections))

    def test_labels_repeated_high_energy_pattern_as_chorus(self):
        bars = [
            SongBar(index, index + 1, energy, energy, energy, 0.5, "stable")
            for index, energy in enumerate([0.3] * 4 + [0.9] * 4 + [0.4] * 4 + [0.9] * 4)
        ]
        sections = [(0, 4), (4, 8), (8, 12), (12, 16)]
        labels, _ = _label_sections(sections, ["A", "B", "C", "B"], bars)

        self.assertEqual(labels[1], "chorus")
        self.assertEqual(labels[3], "chorus")

    def test_serializes_extended_structure_metadata(self):
        analysis = SongAnalysis(
            bpm=120,
            beats=[0, 0.5],
            downbeats=[0],
            beat_positions=[1, 2],
            segments=[SongSegment(0, 1, "intro", 0.4, pattern_id="A")],
            duration=1,
            bars=[SongBar(0, 1, 0.4, 0.3, 0.2, 0.1, "stable")],
        )

        payload = analysis.to_dict()
        self.assertEqual(payload["segments"][0]["patternId"], "A")
        self.assertIn("onsetDensity", payload["bars"][0])

        restored = SongAnalysis.from_dict(payload)
        self.assertEqual(restored, analysis)


if __name__ == "__main__":
    unittest.main()
