import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from qualify_stem_installation import installer_terminal, expected_runtime_backend
from qualify_ai_native import hide_owned_separator_metadata, require_gpu_placement, qualification_environment


class InstallerReceiptTests(unittest.TestCase):
    def test_native_fixtures_isolate_hugging_face_cache_without_changing_parent_environment(self):
        import os
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"HF_HOME": "external-cache"}):
            root = Path(directory)
            environment = qualification_environment(root)
            self.assertEqual(environment["HF_HOME"], str(root.resolve() / "huggingface-cache"))
            self.assertEqual(environment["HF_HUB_CACHE"], str(root.resolve() / "huggingface-cache/hub"))
            self.assertEqual(environment["HUGGINGFACE_HUB_CACHE"], environment["HF_HUB_CACHE"])
            self.assertEqual(os.environ["HF_HOME"], "external-cache")

    def test_cuda_success_requires_measured_model_placement_and_allocation(self):
        for receipt in ({}, {"parameterBytesByDevice": {"cpu": 100}, "cudaPeakAllocatedBytes": 100},
                        {"parameterBytesByDevice": {"cuda:0": 100}, "cudaPeakAllocatedBytes": 0}):
            with self.subTest(receipt=receipt), self.assertRaises(RuntimeError):
                require_gpu_placement({"status": "pass", "diagnostics": {"deviceReceipt": receipt}}, "cuda")
        require_gpu_placement({"status": "pass", "diagnostics": {"deviceReceipt": {
            "parameterBytesByDevice": {"cuda:0": 100}, "cudaPeakAllocatedBytes": 100}}}, "cuda")

    def test_automatic_upgrade_fixture_hides_only_owned_metadata_and_can_restore_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".openstudio-ai-qualification").write_text("owned-test-data-v1")
            runtime = root / "user-data/stem-runtime"
            metadata = runtime / "python/Lib/site-packages/audio_separator-0.41.1.dist-info"
            metadata.mkdir(parents=True); (metadata / "METADATA").write_text("original")
            original, hidden = hide_owned_separator_metadata(root, runtime)
            self.assertFalse(original.exists()); self.assertEqual((hidden / "METADATA").read_text(), "original")
            hidden.rename(original)
            self.assertEqual((original / "METADATA").read_text(), "original")

    def test_automatic_upgrade_fixture_refuses_an_external_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory); root = parent / "owned"; root.mkdir()
            (root / ".openstudio-ai-qualification").write_text("owned-test-data-v1")
            external = parent / "external"; external.mkdir()
            with self.assertRaises(ValueError): hide_owned_separator_metadata(root, external)

    def test_runtime_readiness_and_roformer_execution_are_distinct(self):
        self.assertEqual(expected_runtime_backend("directml", "cpu"), "directml")
        self.assertEqual(expected_runtime_backend("cuda", "cpu"), "cuda")
        self.assertEqual(expected_runtime_backend("cuda", "cuda"), "cuda")
        self.assertEqual(expected_runtime_backend("cpu", "cpu"), "cpu")

    def test_app_detail_log_terminal_survives_trailing_structured_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installer-detail.log"
            ready = {"state": "ready", "selectedBackend": "cuda"}
            path.write_text("ordinary pip output\n" + json.dumps(ready) + "\n" +
                            json.dumps({"event": "installer_ready", "selectedBackend": "cuda"}) + "\n",
                            encoding="utf-8")
            self.assertEqual(installer_terminal(path), ready)

    def test_failure_after_probe_is_not_reported_as_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installer-detail.log"
            path.write_text('{"state":"probing_runtime"}\n{"state":"error","errorCode":"failed"}\n', encoding="utf-8")
            self.assertEqual(installer_terminal(path)["state"], "error")


if __name__ == "__main__":
    unittest.main()
