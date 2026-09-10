"""Setup contracts without downloading weights or requiring an AI runtime."""
import fnmatch
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import prepare_diffusers_audio as setup


class HubSetupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "snapshot"
        self.source.mkdir()
        self.destination = self.root / "staging"
        self.cache = self.root / "cache"
        self.hub = types.SimpleNamespace(hf_hub_download=Mock(), snapshot_download=Mock(return_value=str(self.source)))
        patcher = patch.dict(sys.modules, {"huggingface_hub": self.hub})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_stable_download_uses_pinned_distilled_repo_then_converts(self):
        with patch.object(setup, "prepare") as convert, patch.dict(os.environ, {"HF_TOKEN": "test-only"}):
            setup.download(setup.STABLE_MODEL, self.destination, self.cache)
            self.assertNotIn("HF_TOKEN", os.environ)
        call = self.hub.snapshot_download.call_args
        self.assertEqual(call.args, ("stabilityai/stable-audio-3-medium",))
        self.assertEqual(len(call.kwargs["revision"]), 40)
        self.assertIn("t5gemma-b-b-ul2/*", call.kwargs["allow_patterns"])
        convert.assert_called_once_with(self.source, self.destination, self.cache)
        self.assertTrue(self.source.is_dir())

    def test_minimax_copies_supported_components_and_validates_before_success(self):
        for name in ("language_model/model-00001-of-00004.safetensors", "qwen_7B/legacy.safetensors", "dav.pth", "modular_model_index.json", "LICENSE"):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture", encoding="utf-8")
        with patch.object(setup, "DiffusersAudioSession") as validate:
            setup.download(setup.MINIMAX_MODEL, self.destination, self.cache)
        patterns = self.hub.snapshot_download.call_args.kwargs["allow_patterns"]
        self.assertTrue(any(fnmatch.fnmatch("language_model/model-00004-of-00004.safetensors", p) for p in patterns))
        self.assertFalse(any(fnmatch.fnmatch("qwen_7B/legacy.safetensors", p) for p in patterns))
        self.assertTrue((self.destination / "language_model/model-00001-of-00004.safetensors").is_file())
        self.assertFalse((self.destination / "qwen_7B").exists())
        self.assertFalse((self.destination / "dav.pth").exists())
        validate.assert_called_once_with(self.destination, setup.MINIMAX_MODEL)

    def test_denied_access_never_downloads_weights_or_creates_staging(self):
        self.hub.hf_hub_download.side_effect = PermissionError("access denied")
        with self.assertRaises(PermissionError):
            setup.download(setup.STABLE_MODEL, self.destination, self.cache)
        self.hub.snapshot_download.assert_not_called()
        self.assertFalse(self.destination.exists())

    def test_access_probe_does_not_download_weights(self):
        setup.download(setup.STABLE_MODEL, self.destination, self.cache, check_access=True)
        self.hub.snapshot_download.assert_not_called()
        self.assertFalse(self.destination.exists())

    def test_existing_destination_is_never_overwritten(self):
        self.destination.mkdir()
        marker = self.destination / "working-model"
        marker.write_text("retained", encoding="utf-8")
        with self.assertRaises(ValueError):
            setup.download(setup.MINIMAX_MODEL, self.destination, self.cache)
        self.hub.snapshot_download.assert_not_called()
        self.assertEqual(marker.read_text(), "retained")

    def test_failed_conversion_and_validation_propagate(self):
        with patch.object(setup, "prepare", side_effect=RuntimeError("conversion failed")):
            with self.assertRaisesRegex(RuntimeError, "conversion failed"):
                setup.download(setup.STABLE_MODEL, self.destination, self.cache)
        with patch.object(setup, "DiffusersAudioSession", side_effect=RuntimeError("missing shard")):
            with self.assertRaisesRegex(RuntimeError, "missing shard"):
                setup.download(setup.MINIMAX_MODEL, self.destination, self.cache)
        self.assertTrue(self.source.is_dir())


if __name__ == "__main__":
    unittest.main()
