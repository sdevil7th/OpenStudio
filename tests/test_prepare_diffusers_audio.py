"""Setup contracts without downloading weights or requiring an AI runtime."""
import fnmatch
import io
import json
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
        self.plan = [types.SimpleNamespace(file_size=1024, will_download=True),
                     types.SimpleNamespace(file_size=512, will_download=False)]
        self.hub = types.SimpleNamespace(hf_hub_download=Mock(), snapshot_download=Mock(
            side_effect=lambda *args, **kwargs: self.plan if kwargs.get("dry_run") else str(self.source)))
        patcher = patch.dict(sys.modules, {"huggingface_hub": self.hub})
        patcher.start()
        self.addCleanup(patcher.stop)
        progress_patcher = patch.object(setup, "hub_progress_class", return_value=Mock())
        progress_patcher.start()
        self.addCleanup(progress_patcher.stop)

    def test_progress_reports_real_bytes_and_resets_for_validation(self):
        output = io.StringIO()
        with patch("sys.stdout", output):
            setup.report_progress("Downloading model files", 512, 2048)
            setup.report_progress("Checking model can load")
        events = [json.loads(line.removeprefix("OPENSTUDIO_SETUP_PROGRESS ")) for line in output.getvalue().splitlines()]
        self.assertEqual(events[0]["bytesDownloaded"], 512)
        self.assertEqual(events[0]["bytesTotal"], 2048)
        self.assertEqual(events[1]["bytesTotal"], 0)

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

    def test_download_preflight_reports_fixed_total_and_reused_bytes(self):
        with patch.object(setup, "prepare"), patch.object(setup, "report_progress") as report:
            setup.download(setup.STABLE_MODEL, self.destination, self.cache)
        self.assertTrue(self.hub.snapshot_download.call_args_list[0].kwargs["dry_run"])
        report.assert_any_call("Downloading model files", 512, 1536, 512)
        setup.hub_progress_class.assert_called_once_with(1536, 512)

    def test_empty_download_plan_is_rejected_before_creating_staging(self):
        self.plan.clear()
        with self.assertRaisesRegex(RuntimeError, "no files"):
            setup.download(setup.STABLE_MODEL, self.destination, self.cache)
        self.assertEqual(self.hub.snapshot_download.call_count, 1)
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


class HubProgressTests(unittest.TestCase):
    def test_aggregated_byte_callback_works_without_terminal_and_ignores_file_count(self):
        class ProgressBar:
            def __init__(self, *, total, disable):
                self.total, self.n, self.disabled = total, 0, disable
                self.display()

        modules = {"huggingface_hub.utils": types.SimpleNamespace(tqdm=ProgressBar),
                   "tqdm.auto": types.SimpleNamespace(tqdm=ProgressBar)}
        with patch.dict(sys.modules, modules), patch.object(setup, "report_progress") as report:
            progress_class = setup.hub_progress_class(total_bytes=4096, cached_bytes=1024)
            bar = progress_class(name="huggingface_hub.snapshot_download", total=2048, disable=True)
            self.assertFalse(bar.disabled)
            bar.n = 512
            bar.last_report = 0
            bar.display()
            report.assert_called_with("Downloading model files", 1536, 4096, 1024)
            bar.total = 8192
            bar.last_report = 0
            bar.display()
            report.assert_called_with("Downloading model files", 1536, 4096, 1024)
            count = report.call_count
            progress_class(total=23, disable=True)
            progress_class(name="huggingface_hub.snapshot_download.transfer", total=2048, disable=True)
            self.assertEqual(report.call_count, count)


class StableConversionTests(unittest.TestCase):
    def test_windows_converter_uses_supported_reader_without_changing_upstream_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination, cache = root / "source", root / "staging", root / "cache"
            for name in ["model.safetensors", "model_config.json", "t5gemma-b-b-ul2/config.json",
                         "t5gemma-b-b-ul2/model.safetensors", "t5gemma-b-b-ul2/tokenizer.model"]:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture")
            cache.mkdir()
            converter = cache / f"convert_stable_audio_3_{setup.DIFFUSERS_REVISION}.py"
            script = b"def convert(args):\n    load_file(args.checkpoint_path, device='cpu')\n"
            converter.write_bytes(script)
            for platform, expected in [("win32", {"device": "cpu", "backend": "pread"}),
                                       ("linux", {"device": "cpu"})]:
                loader = Mock()
                namespace = {"load_file": loader}
                exec(script, namespace)
                with patch.object(setup.sys, "platform", platform), \
                     patch.object(setup, "CONVERTER_SHA256", setup.hashlib.sha256(script).hexdigest()), \
                     patch.object(setup.runpy, "run_path", return_value=namespace), \
                     patch.object(setup, "DiffusersAudioSession") as validate, \
                     patch.dict(os.environ):
                    setup.prepare(source, destination, cache)
                loader.assert_called_once_with(str(source / "model.safetensors"), **expected)
                validate.assert_called_once_with(destination, setup.STABLE_MODEL)
                self.assertEqual(converter.read_bytes(), script)


if __name__ == "__main__":
    unittest.main()
