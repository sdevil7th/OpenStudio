import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from qualify_stem_installation import installer_terminal, expected_runtime_backend


class InstallerReceiptTests(unittest.TestCase):
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
