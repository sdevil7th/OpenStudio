import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf


MODULE_PATH = Path(__file__).with_name("stable_audio3_generate.py")
SPEC = importlib.util.spec_from_file_location("stable_audio3_generate", MODULE_PATH)
assert SPEC and SPEC.loader
stable_audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stable_audio)


class ExecutionProgressTests(unittest.TestCase):
    def test_unicode_status_round_trips_through_ascii_console(self):
        buffer = io.BytesIO()
        stream = io.TextIOWrapper(buffer, encoding="ascii")
        message = "GPU \u00b7 bfloat16 \u2014 preparing"
        with mock.patch.object(stable_audio, "ORIGINAL_STDOUT", stream):
            stable_audio.emit_payload({"message": message})
        self.assertEqual(json.loads(buffer.getvalue().decode("utf-8"))["message"], message)

    def test_real_stage_survives_heartbeat_and_decode_resets_percentage(self):
        worker = stable_audio.StableAudioWorker(Path("unused"))
        worker._phase_update("denoising", "Denoising step 3/8.", 3/8)
        stop = mock.Mock()
        stop.wait.side_effect = [False, True]
        with mock.patch.object(stable_audio, "emit_payload") as emit:
            worker._emit_generation_progress("request", "text-to-audio", stop)
        self.assertEqual(emit.call_args.args[0]["phaseProgress"], 3/8)
        worker._phase_update("decoding_audio", "Decoding waveform.", -1)
        stop.wait.side_effect = [False, True]
        with mock.patch.object(stable_audio, "emit_payload") as emit:
            worker._emit_generation_progress("request", "text-to-audio", stop)
        self.assertEqual(emit.call_args.args[0]["phaseProgress"], -1)
        self.assertEqual(emit.call_args.args[0]["phase"], "decoding_audio")

    def test_oom_retries_once_without_changing_request_or_publishing_partial_audio(self):
        import torch
        worker = stable_audio.StableAudioWorker(Path("unused"))
        first = mock.Mock()
        first.generate.side_effect = torch.OutOfMemoryError("test capacity")
        second = mock.Mock()
        second.generate.return_value = np.ones((2, 44100)) * .1
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(worker, "_load_model", side_effect=[first, second]), \
             mock.patch.object(worker, "unload") as unload, \
             mock.patch.object(stable_audio, "get_model_audio_format", return_value=(44100, 2)), \
             mock.patch.object(stable_audio, "write_audio", return_value={}) as write, \
             mock.patch.object(stable_audio, "emit_payload"):
            self.assertTrue(worker.generate("text-to-audio", '{"prompt":"piano","duration":1,"seed":123}', Path(directory)/"out.wav", "request"))
            self.assertEqual(first.generate.call_args, second.generate.call_args)
            self.assertEqual(first.generate.call_args.kwargs["seed"], 123)
            self.assertEqual(write.call_count, 1)
            unload.assert_called_once()
        self.assertTrue(worker._conservative)

    def test_heartbeat_retains_execution_policy(self):
        worker = stable_audio.StableAudioWorker(Path("unused-model"))
        worker._model = mock.Mock(execution_summary=lambda: "CUDA · bfloat16 · CPU layer offload")
        stop = mock.Mock()
        stop.wait.side_effect = [False, False, True]
        with mock.patch.object(stable_audio, "emit_payload") as emit:
            worker._emit_generation_progress("request", "lyrics-style", stop)
        self.assertEqual(emit.call_count, 2)
        for call in emit.call_args_list:
            self.assertEqual(call.args[0]["statusNote"], "CUDA · bfloat16 · CPU layer offload")


def source_meta(duration: float = 10.0) -> dict:
    return {
        "clipDuration": duration,
        "extensionDuration": 8.0,
        "sourceClipId": "clip-1",
        "sourcePeak": 0.5,
        "sourceRms": 0.1,
        "originalSampleRate": 44100,
        "originalChannels": 2,
        "preparedSampleRate": 44100,
        "preparedChannels": 2,
        "sourceStats": {
            "sampleRate": 44100,
            "durationSeconds": duration,
            "peak": 0.5,
            "rms": 0.1,
            "clippedFraction": 0.0,
        },
    }


class StableAudioSourceHelpersTest(unittest.TestCase):
    def write_tone(self, path: Path, sample_rate: int, channels: int = 1) -> None:
        t = np.linspace(0, 1, sample_rate, endpoint=False)
        audio = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        if channels > 1:
            audio = np.stack([audio for _ in range(channels)], axis=-1)
        sf.write(str(path), audio, sample_rate)

    def test_prepare_source_segment_converts_channels_without_ffmpeg_when_rate_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            source_path = temp_path / "mono_source.wav"
            output_path = temp_path / "out.wav"
            self.write_tone(source_path, 44100, channels=1)

            with mock.patch.object(stable_audio, "resolve_ffmpeg_executable", side_effect=AssertionError("ffmpeg should not be used")):
                segment_path, meta = stable_audio.prepare_source_segment(
                    {
                        "source": {
                            "filePath": str(source_path),
                            "clipOffset": 0,
                            "clipDuration": 1.0,
                            "sourceClipId": "clip-1",
                        }
                    },
                    output_path,
                    "request",
                    target_sample_rate=44100,
                    target_channels=2,
                )

            info = sf.info(str(segment_path))
            self.assertEqual(info.samplerate, 44100)
            self.assertEqual(info.channels, 2)
            self.assertEqual(info.subtype, "FLOAT")
            self.assertEqual(meta["originalSampleRate"], 44100)
            self.assertEqual(meta["originalChannels"], 1)
            self.assertEqual(meta["preparedSampleRate"], 44100)
            self.assertEqual(meta["preparedChannels"], 2)
            self.assertEqual(meta["sourceStats"]["sampleRate"], 44100)

    def test_prepare_source_segment_resamples_to_model_rate_when_ffmpeg_available(self) -> None:
        ffmpeg, _searched = stable_audio.resolve_ffmpeg_executable()
        if not ffmpeg:
            self.skipTest("FFmpeg is not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            source_path = temp_path / "low_rate_source.wav"
            output_path = temp_path / "out.wav"
            self.write_tone(source_path, 22050, channels=1)

            segment_path, meta = stable_audio.prepare_source_segment(
                {
                    "source": {
                        "filePath": str(source_path),
                        "clipOffset": 0,
                        "clipDuration": 1.0,
                        "sourceClipId": "clip-1",
                    }
                },
                output_path,
                "request",
                target_sample_rate=44100,
                target_channels=2,
            )

            info = sf.info(str(segment_path))
            self.assertEqual(info.samplerate, 44100)
            self.assertEqual(info.channels, 2)
            self.assertEqual(info.subtype, "FLOAT")
            self.assertEqual(meta["originalSampleRate"], 22050)
            self.assertEqual(meta["originalChannels"], 1)
            self.assertEqual(meta["preparedSampleRate"], 44100)
            self.assertEqual(meta["preparedChannels"], 2)
            self.assertEqual(meta["sourceStats"]["sampleRate"], 44100)

    def test_prepare_source_segment_requires_ffmpeg_for_sample_rate_conversion(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            source_path = temp_path / "high_rate_source.wav"
            output_path = temp_path / "out.wav"
            self.write_tone(source_path, 48000, channels=2)

            with mock.patch.object(stable_audio, "resolve_ffmpeg_executable", return_value=(None, ["missing-a", "missing-b"])):
                with self.assertRaisesRegex(RuntimeError, "FFmpeg is required to resample source audio for Stable Audio 3") as context:
                    stable_audio.prepare_source_segment(
                        {
                            "source": {
                                "filePath": str(source_path),
                                "clipOffset": 0,
                                "clipDuration": 1.0,
                                "sourceClipId": "clip-1",
                            }
                        },
                        output_path,
                        "request",
                        target_sample_rate=44100,
                        target_channels=2,
                    )

            self.assertIn("missing-a", str(context.exception))

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
        self.assertEqual(details["sourcePreparedSampleRate"], 44100)
        self.assertEqual(details["sourcePreparedChannels"], 2)

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
