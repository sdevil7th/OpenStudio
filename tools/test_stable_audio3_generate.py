import importlib.util
import unittest
from pathlib import Path

import numpy as np


MODULE_PATH = Path(__file__).with_name("stable_audio3_generate.py")
SPEC = importlib.util.spec_from_file_location("stable_audio3_generate", MODULE_PATH)
assert SPEC and SPEC.loader
stable_audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stable_audio)


def source_meta(duration: float = 10.0) -> dict:
    return {
        "clipDuration": duration,
        "extensionDuration": 8.0,
        "sourceClipId": "clip-1",
        "sourcePeak": 0.5,
        "sourceRms": 0.1,
        "sourceStats": {
            "sampleRate": 44100,
            "durationSeconds": duration,
            "peak": 0.5,
            "rms": 0.1,
            "clippedFraction": 0.0,
        },
    }


class StableAudioSourceHelpersTest(unittest.TestCase):
    def test_variation_builds_init_audio_with_expected_noise(self) -> None:
        source_audio = (44100, object())
        kwargs, details = stable_audio.build_generation_request(
            "variation",
            {"prompt": "make this brighter"},
            source_audio=source_audio,
            source_meta=source_meta(),
        )

        self.assertIs(kwargs["init_audio"], source_audio)
        self.assertEqual(kwargs["init_noise_level"], 0.5)
        self.assertEqual(kwargs["duration"], 10.0)
        self.assertEqual(details["effectiveNoiseAmount"], 0.5)

    def test_continue_uses_overlap_but_crops_at_original_clip_end(self) -> None:
        source_audio = (44100, object())
        kwargs, details = stable_audio.build_generation_request(
            "continue-clip",
            {"prompt": "continue the groove", "extension_duration": 8},
            source_audio=source_audio,
            source_meta=source_meta(duration=10.0),
        )

        self.assertIs(kwargs["inpaint_audio"], source_audio)
        self.assertEqual(kwargs["duration"], 18.0)
        self.assertEqual(kwargs["inpaint_mask_start_seconds"], 9.5)
        self.assertEqual(kwargs["inpaint_mask_end_seconds"], 18.0)
        self.assertEqual(details["continuationCropStart"], 10.0)
        self.assertEqual(details["expectedOutputDuration"], 8.0)

    def test_silent_continuation_tail_fails_validation(self) -> None:
        audio = np.zeros((44100 * 2, 2), dtype=np.float32)
        with self.assertRaisesRegex(RuntimeError, "near-silent continuation"):
            stable_audio.prepare_output_audio(
                audio,
                sample_rate=44100,
                workflow="continue-clip",
                crop_start_seconds=1.0,
                expected_output_duration=1.0,
                target_peak=0.5,
                target_rms=0.1,
            )

    def test_valid_continuation_tail_passes_validation(self) -> None:
        sample_rate = 44100
        source = np.zeros((sample_rate, 2), dtype=np.float32)
        t = np.linspace(0, 1, sample_rate, endpoint=False)
        tail = (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        tail = np.stack([tail, tail], axis=-1)
        audio = np.concatenate([source, tail], axis=0)

        output, diagnostics = stable_audio.prepare_output_audio(
            audio,
            sample_rate=sample_rate,
            workflow="continue-clip",
            crop_start_seconds=1.0,
            expected_output_duration=1.0,
            target_peak=0.5,
            target_rms=0.1,
        )

        self.assertGreater(output.shape[0], 0)
        self.assertEqual(diagnostics["validation"], "passed")
        self.assertGreater(diagnostics["tailStats"]["rms"], 0.01)


if __name__ == "__main__":
    unittest.main()
