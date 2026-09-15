import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ai_generation_preflight import memory_row, assess_memory, request_duration


class HardwarePreflightTests(unittest.TestCase):
    def test_small_real_shortfall_is_not_rounded_away(self):
        row = memory_row("GPU", int(13.640 * 1024**3), int(13.675 * 1024**3))
        self.assertGreater(row["shortfallBytes"], 0)
        self.assertEqual(assess_memory([row], strict=True), "blocked")
        self.assertEqual(assess_memory([row]), "warning")

    def test_unknown_memory_cannot_claim_fit(self):
        self.assertEqual(assess_memory([memory_row("GPU", None, 100)]), "warning")

    def test_source_continuation_includes_context(self):
        self.assertEqual(request_duration("stable-audio-3-medium", "continue-clip",
            {"duration": 30, "source": {"clipDuration": 100, "extensionDuration": 20}}), 120)

    def test_model_limits_and_invalid_duration(self):
        self.assertEqual(request_duration("ace-step-v15-xl-turbo", "text-to-music", {"duration": 195}), 195)
        with self.assertRaises(ValueError):
            request_duration("minimax-music-3", "lyrics-style", {"duration": float("nan")})


if __name__ == "__main__":
    unittest.main()
