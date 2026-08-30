import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf


REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import generate_music as music  # noqa: E402
import ai_runtime_probe  # noqa: E402


class AceDiffusersGenerationTests(unittest.TestCase):
    def test_default_music_generation_cache_root_is_diffusers(self):
        with mock.patch.object(ai_runtime_probe.Path, "home", return_value=Path("C:/Users/example")):
            root = ai_runtime_probe.resolve_music_gen_checkpoint_root("")

        self.assertEqual(root.as_posix(), "C:/Users/example/.cache/ace-step/diffusers")

    def test_text_to_music_kwargs_match_reference_pipeline_contract(self):
        spec = music.build_generation_spec(
            "text-to-music",
            {
                "prompt": "melodic rock, clear vocal hook",
                "lyrics": "[verse]\nhello",
                "duration": 30,
                "language": "en",
                "inferenceSteps": 8,
                "shift": 3,
                "bpm": 120,
                "keyscale": "C major",
                "timesignature": "4/4",
                "seed": -1,
            },
        )

        kwargs = music.build_diffusers_kwargs(spec, generator=None)

        self.assertEqual(kwargs["prompt"], "melodic rock, clear vocal hook")
        self.assertEqual(kwargs["lyrics"], "[verse]\nhello")
        self.assertEqual(kwargs["audio_duration"], 30.0)
        self.assertEqual(kwargs["vocal_language"], "en")
        self.assertEqual(kwargs["num_inference_steps"], 8)
        self.assertEqual(kwargs["guidance_scale"], 1.0)
        self.assertEqual(kwargs["shift"], 3)
        self.assertEqual(kwargs["task_type"], "text2music")
        self.assertEqual(kwargs["bpm"], 120)
        self.assertEqual(kwargs["keyscale"], "C major")
        self.assertEqual(kwargs["timesignature"], "4/4")
        self.assertIsNone(kwargs["generator"])
        self.assertIsNone(spec.seed)

    def test_fixed_seed_is_preserved_but_random_seed_is_none(self):
        _requested, random_seed = music.normalize_seed(-1)
        fixed_requested, fixed_seed = music.normalize_seed("42")

        self.assertIsNone(random_seed)
        self.assertEqual(fixed_requested, 42)
        self.assertEqual(fixed_seed, 42)

    def test_cover_maps_to_reference_audio_and_strength(self):
        spec = music.build_generation_spec(
            "variation",
            {
                "prompt": "make it brighter",
                "audio_cover_strength": 0.55,
                "inferenceSteps": 8,
            },
            source_request=music.SourceRequest(path=Path("source.wav"), source_duration=12.5),
        )
        kwargs = music.build_diffusers_kwargs(
            spec,
            reference_audio="ref",
            source_duration=12.5,
        )

        self.assertEqual(kwargs["task_type"], "cover")
        self.assertEqual(kwargs["reference_audio"], "ref")
        self.assertEqual(kwargs["audio_cover_strength"], 0.55)
        self.assertEqual(kwargs["audio_duration"], 12.5)

    def test_cover_uses_stricter_source_preservation_default(self):
        spec = music.build_generation_spec(
            "variation",
            {
                "prompt": "make it brighter",
                "inferenceSteps": 8,
            },
            source_request=music.SourceRequest(path=Path("source.wav"), source_duration=12.5),
        )

        self.assertEqual(spec.audio_cover_strength, 0.85)

    def test_source_workflows_preserve_project_timing_metadata(self):
        source_request = music.SourceRequest(path=Path("source.wav"), source_duration=12.5)
        spec = music.build_generation_spec(
            "variation",
            {
                "prompt": "make it brighter",
                "bpm": 100,
                "timesignature": "4/4",
                "inferenceSteps": 8,
            },
            source_request=source_request,
        )
        kwargs = music.build_diffusers_kwargs(
            spec,
            reference_audio="ref",
            source_duration=12.5,
        )

        self.assertEqual(kwargs["bpm"], 100)
        self.assertEqual(kwargs["timesignature"], "4/4")

    def test_cover_preserves_source_audio_when_runtime_supports_it(self):
        spec = music.build_generation_spec(
            "variation",
            {
                "prompt": "make it brighter",
                "audio_cover_strength": 0.55,
                "inferenceSteps": 8,
            },
            source_request=music.SourceRequest(path=Path("source.wav"), source_duration=12.5),
        )
        kwargs = music.build_diffusers_kwargs(
            spec,
            src_audio="src",
            reference_audio="ref",
            source_duration=12.5,
        )

        self.assertEqual(kwargs["task_type"], "cover")
        self.assertEqual(kwargs["src_audio"], "src")
        self.assertEqual(kwargs["reference_audio"], "ref")

    def test_source_audio_cover_capability_detects_missing_tokenizers(self):
        class MissingCoverRuntime:
            audio_tokenizer = None
            audio_token_detokenizer = None

        class SourceCoverRuntime:
            audio_tokenizer = object()
            audio_token_detokenizer = object()

        self.assertFalse(music.DiffusersAcePipelineManager._supports_source_audio_cover(MissingCoverRuntime()))
        self.assertTrue(music.DiffusersAcePipelineManager._supports_source_audio_cover(SourceCoverRuntime()))

    def test_repaint_maps_to_src_audio_reference_audio_and_clip_range(self):
        spec = music.build_generation_spec(
            "inpaint-selection",
            {
                "prompt": "replace naturally",
                "source": {"inpaintRange": {"start": 1.0, "end": 4.0}},
            },
            source_request=music.SourceRequest(path=Path("source.wav"), source_duration=10.0),
        )
        kwargs = music.build_diffusers_kwargs(
            spec,
            src_audio="src",
            reference_audio="ref",
            source_duration=10.0,
        )

        self.assertEqual(kwargs["task_type"], "repaint")
        self.assertEqual(kwargs["src_audio"], "src")
        self.assertEqual(kwargs["reference_audio"], "ref")
        self.assertEqual(kwargs["repainting_start"], 1.0)
        self.assertEqual(kwargs["repainting_end"], 4.0)
        self.assertEqual(kwargs["audio_duration"], 10.0)

    def test_continue_uses_extended_repaint_duration(self):
        spec = music.build_generation_spec(
            "continue-clip",
            {"prompt": "continue the same idea", "extension_duration": 8},
            source_request=music.SourceRequest(
                path=Path("source.wav"),
                source_duration=10.0,
                extension_duration=8.0,
            ),
        )
        kwargs = music.build_diffusers_kwargs(
            spec,
            src_audio="src",
            reference_audio="ref",
            source_duration=18.0,
        )

        self.assertEqual(kwargs["task_type"], "repaint")
        self.assertEqual(kwargs["src_audio"], "src")
        self.assertEqual(kwargs["reference_audio"], "ref")
        self.assertEqual(kwargs["audio_duration"], 18.0)
        self.assertEqual(kwargs["repainting_start"], 10.0)
        self.assertEqual(kwargs["repainting_end"], 18.0)

    def test_ffmpeg_resolver_prefers_env_override(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            override = Path(temp_dir) / music.ffmpeg_binary_name()
            override.write_bytes(b"")

            with mock.patch.dict(os.environ, {"OPENSTUDIO_FFMPEG_PATH": str(override)}), \
                 mock.patch.object(music.shutil, "which", return_value=str(Path(temp_dir) / "path-ffmpeg")):
                resolved, searched = music.resolve_ffmpeg_executable()

            self.assertEqual(resolved, str(override))
            self.assertEqual(searched[0], str(override))

    def test_ffmpeg_resolver_finds_source_tree_pinned_runtime(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            tools_dir = Path(temp_dir) / "tools"
            runtime_dir = tools_dir / "ffmpeg-runtime"
            runtime_dir.mkdir(parents=True)
            bundled = runtime_dir / music.ffmpeg_binary_name()
            bundled.write_bytes(b"")

            with mock.patch.dict(os.environ, {"OPENSTUDIO_FFMPEG_PATH": ""}), \
                 mock.patch.object(music.shutil, "which", return_value=None), \
                 mock.patch.object(music, "SCRIPT_PATH", tools_dir / "generate_music.py"):
                resolved, searched = music.resolve_ffmpeg_executable()

            self.assertEqual(resolved, str(bundled))
            self.assertIn(str(bundled), searched)

    def test_ffmpeg_resolver_finds_packaged_artifact_binary(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_dir = Path(temp_dir) / "OpenStudio_artefacts" / "Debug"
            scripts_dir = artifact_dir / "scripts"
            scripts_dir.mkdir(parents=True)
            bundled = artifact_dir / music.ffmpeg_binary_name()
            bundled.write_bytes(b"")

            with mock.patch.dict(os.environ, {"OPENSTUDIO_FFMPEG_PATH": ""}), \
                 mock.patch.object(music.shutil, "which", return_value=None), \
                 mock.patch.object(music, "SCRIPT_PATH", scripts_dir / "generate_music.py"):
                resolved, searched = music.resolve_ffmpeg_executable()

            self.assertEqual(resolved, str(bundled))
            self.assertIn(str(bundled), searched)

    def test_missing_ffmpeg_error_lists_searched_locations_for_resample(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source.wav"
            converted = Path(temp_dir) / "converted.wav"
            data = np.linspace(-0.5, 0.5, 44_100, dtype=np.float32)
            sf.write(str(source), data, 44_100)

            with mock.patch.object(music, "resolve_ffmpeg_executable", return_value=(None, ["missing-a", "missing-b"])):
                with self.assertRaises(music.GenerationFailure) as context:
                    music.convert_to_wav(source, converted, 48_000)

            self.assertIn("FFmpeg is required to resample source audio for ACE-Step", str(context.exception))
            self.assertIn("Searched locations", str(context.exception))
            self.assertIn("missing-a", str(context.exception))

    def test_source_conversion_resamples_to_48k_stereo_when_ffmpeg_available(self):
        ffmpeg, _searched = music.resolve_ffmpeg_executable()
        if not ffmpeg:
            self.skipTest("FFmpeg is not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source.wav"
            converted = Path(temp_dir) / "converted.wav"
            data = np.linspace(-0.5, 0.5, 44_100, dtype=np.float32)
            sf.write(str(source), data, 44_100)

            music.convert_to_wav(source, converted, 48_000)

            info = sf.info(str(converted))
            self.assertEqual(info.samplerate, 48_000)
            self.assertEqual(info.channels, 2)

    def test_source_conversion_loads_48k_stereo_tensor(self):
        class FakeTensor:
            def __init__(self, array):
                self.array = array
                self.shape = array.shape

            def float(self):
                return self

        class FakeTorch:
            @staticmethod
            def from_numpy(array):
                return FakeTensor(array)

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source.wav"
            converted = Path(temp_dir) / "converted.wav"
            data = np.linspace(-0.5, 0.5, 48_000, dtype=np.float32)
            sf.write(str(source), data, 48_000)

            with mock.patch.object(music, "resolve_ffmpeg_executable", return_value=(None, [])):
                music.convert_to_wav(source, converted, 48_000)
            with mock.patch.dict(sys.modules, {"torch": FakeTorch}):
                tensor = music.load_audio_tensor(converted, 48_000)

            self.assertEqual(list(tensor.shape), [2, 48_000])

    def test_variation_postprocess_reduces_loud_generated_audio_to_source_level(self):
        sample_rate = 48_000
        seconds = 1.0
        t = np.arange(int(sample_rate * seconds), dtype=np.float32) / sample_rate
        source = np.sin(2 * np.pi * 220 * t).reshape(-1, 1).astype(np.float32) * 0.1
        generated = np.repeat((np.sin(2 * np.pi * 220 * t).reshape(-1, 1) * 0.8).astype(np.float32), 2, axis=1)

        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "source.wav"
            sf.write(str(source_path), source, sample_rate)

            processed = music.postprocess_variation_audio(
                generated,
                source_path,
                target_duration=seconds,
                samplerate=sample_rate,
            )

        self.assertLess(music.active_rms(processed), 0.12)
        self.assertLessEqual(float(np.max(np.abs(processed))), 10.0 ** (-1.0 / 20.0) + 1.0e-5)

    def test_variation_postprocess_does_not_excessively_boost_quiet_generated_audio(self):
        sample_rate = 48_000
        seconds = 1.0
        t = np.arange(int(sample_rate * seconds), dtype=np.float32) / sample_rate
        source = np.repeat((np.sin(2 * np.pi * 220 * t).reshape(-1, 1) * 0.8).astype(np.float32), 2, axis=1)
        generated = np.repeat((np.sin(2 * np.pi * 220 * t).reshape(-1, 1) * 0.05).astype(np.float32), 2, axis=1)

        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "source.wav"
            sf.write(str(source_path), source, sample_rate)

            processed = music.postprocess_variation_audio(
                generated,
                source_path,
                target_duration=seconds,
                samplerate=sample_rate,
            )

        self.assertLess(music.active_rms(processed), 0.08)

    def test_variation_postprocess_preserves_source_leading_silence(self):
        sample_rate = 48_000
        seconds = 2.0
        t = np.arange(sample_rate, dtype=np.float32) / sample_rate
        silence = np.zeros((sample_rate, 2), dtype=np.float32)
        tone = np.repeat((np.sin(2 * np.pi * 220 * t).reshape(-1, 1) * 0.2).astype(np.float32), 2, axis=1)
        source = np.vstack([silence, tone])
        generated = np.vstack([tone, silence])

        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "source.wav"
            sf.write(str(source_path), source, sample_rate)

            processed = music.postprocess_variation_audio(
                generated,
                source_path,
                target_duration=seconds,
                samplerate=sample_rate,
            )

        onset_seconds = music.detect_first_active_frame(processed, sample_rate) / sample_rate
        self.assertGreaterEqual(onset_seconds, 0.98)
        self.assertLessEqual(onset_seconds, 1.03)

    def test_worker_accepts_current_protocol_without_loading_model(self):
        payload = {
            "command": "generate",
            "workflow": "text-to-music",
            "params": json.dumps({"prompt": "test"}),
            "output": "out.wav",
            "requestId": "request",
            "protocolVersion": music.WORKER_PROTOCOL_VERSION,
            "scriptVersion": music.SCRIPT_VERSION,
        }

        self.assertEqual(payload["protocolVersion"], 2)
        self.assertEqual(payload["scriptVersion"], music.SCRIPT_VERSION)


if __name__ == "__main__":
    unittest.main()
