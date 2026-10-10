"""Study metric controls; run with the study's Python environment."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from lib import frame_stats, gross_pitch_error, nearest_frames


class StudyMetrics(unittest.TestCase):
    def test_twenty_percent_is_relative_to_reference_hz(self):
        reference = np.full(7, 100.0)
        estimates = np.array([79.0, 80.0, 82.0, 100.0, 118.0, 120.0, 121.0])
        np.testing.assert_array_equal(
            gross_pitch_error(estimates, reference),
            [True, False, False, False, False, False, True],
        )
        counts = frame_stats(estimates, reference)
        self.assertEqual(counts["gross"], 2)
        self.assertEqual(counts["fine_n"], 5)

    def test_silence_does_not_create_a_pitch_denominator(self):
        counts = frame_stats(np.array([0.0, 100.0, 0.0]), np.array([100.0, 0.0, 0.0]))
        self.assertEqual(counts["both_voiced"], 0)
        self.assertEqual(counts["gross"], 0)
        self.assertEqual(counts["miss"], 1)
        self.assertEqual(counts["false_alarm"], 1)

    def test_nearest_samples_are_not_ceiling_samples_or_extrapolated(self):
        times = np.array([0.0, 0.01, 0.02])
        values = np.array([100.0, 200.0, 300.0])
        targets = np.array([-0.001, 0.0, 0.004, 0.006, 0.02, 0.021])
        np.testing.assert_array_equal(
            nearest_frames(times, values, targets), [0, 100, 100, 200, 300, 0]
        )
        np.testing.assert_array_equal(
            nearest_frames(np.array([]), np.array([]), targets), np.zeros(6)
        )

    def test_tracker_offsets_identify_the_same_reference_instant(self):
        # Target system's time .030 at offset .026 means reference time .004.
        # The other tracker's offset .019 puts that instant at .023, nearest .020.
        times = np.array([0.02, 0.03])
        target = np.array([0.030 - 0.026 + 0.019])
        np.testing.assert_array_equal(
            nearest_frames(times, np.array([100.0, 200.0]), target), [100.0]
        )


if __name__ == "__main__":
    unittest.main()
