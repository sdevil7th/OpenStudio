import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import install_ai_tools as installer  # noqa: E402


def hardware(system_ram_mb: int, *, gpu_backend: str = "none", gpu_memory_mb: int = 0) -> dict:
    return {
        "systemRamMb": system_ram_mb,
        "gpuBackend": gpu_backend,
        "gpuMemoryMb": gpu_memory_mb,
        "audioGenerationGpuSupported": gpu_backend in {"cuda", "rocm"},
    }


class InstallAiToolsFeatureGatingTests(unittest.TestCase):
    def test_no_gpu_8gb_ram_allows_stem_only_and_skips_audio_backend_steps(self):
        selected_features = installer.filter_compatible_features(
            [installer.FEATURE_STEM_SEPARATION],
            hardware(8192),
        )
        self.assertEqual(selected_features, [installer.FEATURE_STEM_SEPARATION])

        install_plan = {
            "id": "test-plan",
            "steps": [
                {
                    "type": "pip_install",
                    "description": "Install audio-separator runtime",
                    "features": [installer.FEATURE_STEM_SEPARATION],
                    "packages": ["audio-separator[cpu]==0.35.0"],
                },
                {
                    "type": "pip_install",
                    "description": "Install ACE-Step runtime dependencies",
                    "features": [installer.FEATURE_AUDIO_GENERATION],
                    "packages": ["ace-step==0.2.0"],
                },
            ],
        }

        with (
            patch.object(installer, "stream_step") as stream_step,
            patch.object(installer, "emit", Mock()),
            patch.object(installer, "log_event", Mock()),
            patch.object(installer, "write_log", Mock()),
        ):
            installer.apply_backend_install_plan(
                Path("python"),
                Path("runtime"),
                install_plan,
                backend_requested="cpu",
                selected_features=selected_features,
                install_source="downloadedRuntime",
                requires_external_python=False,
                python_detected=False,
                build_runtime_mode="downloaded-runtime",
            )

        stream_step.assert_called_once()
        command = stream_step.call_args.args[0]
        self.assertIn("audio-separator[cpu]==0.35.0", command)
        self.assertNotIn("ace-step==0.2.0", command)

    def test_no_gpu_blocks_audio_generation_before_download(self):
        selected_features = installer.filter_compatible_features(
            [installer.FEATURE_AUDIO_GENERATION],
            hardware(16384),
        )
        payload = installer.build_feature_payload(
            [installer.FEATURE_AUDIO_GENERATION],
            hardware(16384),
        )

        self.assertEqual(selected_features, [])
        self.assertIn(
            "supported GPU with at least 8 GB memory was not detected",
            installer.hardware_block_message([installer.FEATURE_AUDIO_GENERATION], payload),
        )

    def test_cuda_gpu_with_16gb_ram_and_8gb_vram_allows_audio_generation(self):
        selected_features = installer.filter_compatible_features(
            [installer.FEATURE_AUDIO_GENERATION],
            hardware(16384, gpu_backend="cuda", gpu_memory_mb=8192),
        )
        payload = installer.build_feature_payload(
            selected_features,
            hardware(16384, gpu_backend="cuda", gpu_memory_mb=8192),
        )

        self.assertEqual(selected_features, [installer.FEATURE_AUDIO_GENERATION])
        self.assertTrue(payload[installer.FEATURE_AUDIO_GENERATION]["compatible"])
        self.assertFalse(payload[installer.FEATURE_AUDIO_GENERATION]["blocked"])

    def test_4gb_ram_blocks_stem_separation_before_download(self):
        selected_features = installer.filter_compatible_features(
            [installer.FEATURE_STEM_SEPARATION],
            hardware(4096),
        )
        payload = installer.build_feature_payload(
            [installer.FEATURE_STEM_SEPARATION],
            hardware(4096),
        )

        self.assertEqual(selected_features, [])
        self.assertIn(
            "at least 8 GB system RAM is required",
            installer.hardware_block_message([installer.FEATURE_STEM_SEPARATION], payload),
        )

    def test_native_bridge_keeps_legacy_boolean_install_as_stem_default(self):
        stem_separator_source = (REPO_ROOT / "Source" / "StemSeparator.cpp").read_text(encoding="utf-8")
        main_component_source = (REPO_ROOT / "Source" / "MainComponent.cpp").read_text(encoding="utf-8")
        installer_source = (REPO_ROOT / "tools" / "install_ai_tools.py").read_text(encoding="utf-8")

        self.assertIn('options->setProperty("selectedFeatures", selectedFeatures);', stem_separator_source)
        self.assertIn('selectedFeatures.add(kFeatureStemSeparation);', stem_separator_source)
        self.assertIn('args[0].isString()', main_component_source)
        self.assertIn('audioEngine.installAiTools(userConfirmedDownload)', main_component_source)
        self.assertIn("available=stem_separation_ready", installer_source)
        self.assertIn("musicGenerationReady=FEATURE_AUDIO_GENERATION in install_features and music_generation_ready", installer_source)


if __name__ == "__main__":
    unittest.main()
