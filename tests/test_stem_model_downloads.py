"""Exercise stem cache readiness and atomic downloads using real temporary files."""

from collections import deque
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import ai_runtime_probe as probe
import install_ai_tools as installer


class Response(io.BytesIO):
    status = 200

    def __init__(self, body: bytes, length: int | None = None, before_read=None):
        super().__init__(body)
        self.headers = {} if length is None else {"Content-Length": str(length)}
        self.before_read = before_read

    def getcode(self):
        return self.status

    def read(self, size=-1):
        if self.before_read:
            self.before_read()
        return super().read(size)


class StemModelDownloadsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ("emit", "log_event", "emit_model_download_status"):
            mock = patch.object(installer, name, Mock())
            mock.start()
            self.addCleanup(mock.stop)

    def download_file(self, target: Path, urls=None):
        return installer.download_file_with_retries(
            urls=urls or ["https://example.test/model.ckpt"], target_path=target,
            file_label="the checkpoint", file_index=0, file_count=1,
            recent_lines=deque(maxlen=12), install_source="downloadedRuntime",
            requires_external_python=False, python_detected=False,
            build_runtime_mode="downloaded-runtime", completed_bytes=0,
        )

    def download_model(self, targets):
        with patch.object(installer, "resolve_model_download_plan", return_value=targets):
            return installer.download_model(
                Path(sys.executable), self.root / "runtime", self.root, "model.ckpt",
                backend_requested="cpu", install_source="downloadedRuntime",
                requires_external_python=False, python_detected=False,
                build_runtime_mode="downloaded-runtime",
            )

    def test_probe_rejects_missing_empty_directory_and_pending_models(self):
        model = self.root / "model.ckpt"
        (self.root / "model.ckpt.part").write_bytes(b"pending download")
        for kind in ("missing", "empty", "directory", "healthy"):
            if kind == "empty":
                model.touch()
            elif kind == "directory":
                model.unlink()
                model.mkdir()
            elif kind == "healthy":
                model.rmdir()
                model.write_bytes(b"complete model fixture")
            with (self.subTest(kind=kind),
                  patch.object(probe, "resolve_music_gen_snapshot", return_value=None),
                  patch.dict(sys.modules, {"torch": None})):
                report = probe.probe_runtime_capabilities(
                    models_dir=str(self.root), model_name=model.name,
                    music_checkpoint_root=str(self.root / "ace"), acceleration_mode="cpu-only",
                )
                self.assertEqual(report["modelInstalled"], kind == "healthy")

    def test_unreadable_model_is_not_ready(self):
        model = self.root / "model.ckpt"
        with patch.object(Path, "is_file", side_effect=PermissionError("denied")):
            self.assertFalse(probe.is_nonempty_model_file(model))

    def test_empty_or_truncated_response_preserves_existing_file_and_removes_partial(self):
        for body, length in ((b"", None), (b"short", 100)):
            with self.subTest(body=body, length=length):
                target = self.root / "model.ckpt"
                target.write_bytes(b"previous healthy model")
                with patch.object(installer, "urlopen", return_value=Response(body, length)):
                    with self.assertRaises(installer.ModelDownloadError) as failure:
                        self.download_file(target)
                self.assertEqual(failure.exception.error_code, "model_transfer_interrupted")
                self.assertEqual(target.read_bytes(), b"previous healthy model")
                self.assertFalse((self.root / "model.ckpt.part").exists())

    def test_successful_download_replaces_only_after_complete_transfer(self):
        target = self.root / "model.ckpt"
        target.write_bytes(b"previous model")
        response = Response(b"replacement model", 17,
                            before_read=lambda: self.assertEqual(target.read_bytes(), b"previous model"))
        with patch.object(installer, "urlopen", return_value=response):
            self.assertEqual(self.download_file(target), 17)
        self.assertEqual(target.read_bytes(), b"replacement model")
        self.assertFalse((self.root / "model.ckpt.part").exists())

    def test_network_failover_is_bounded_and_preserves_existing_model(self):
        target = self.root / "model.ckpt"
        urls = ["https://first.test/model.ckpt", "https://second.test/model.ckpt"]
        target.write_bytes(b"previous model")
        with patch.object(installer, "urlopen", side_effect=[URLError("offline"), Response(b"replacement", 11)]) as download:
            self.assertEqual(self.download_file(target, urls), 11)
        self.assertEqual(download.call_count, 2)
        self.assertEqual(target.read_bytes(), b"replacement")

        with patch.object(installer, "urlopen", side_effect=URLError("offline")) as download:
            with self.assertRaises(installer.ModelDownloadError):
                self.download_file(target, urls)
        self.assertEqual(download.call_count, 2)
        self.assertEqual(target.read_bytes(), b"replacement")
        self.assertFalse((self.root / "model.ckpt.part").exists())

    def test_healthy_checkpoint_and_config_are_reused_without_download(self):
        targets = []
        for filename in ("model.ckpt", "model.yaml"):
            (self.root / filename).write_bytes(b"healthy cached file")
            targets.append({"filename": filename, "urls": ["https://example.test/model"]})
        with patch.object(installer, "download_file_with_retries") as download:
            self.assertEqual(self.download_model(targets), self.root / "model.ckpt")
        download.assert_not_called()

    def test_empty_checkpoint_and_config_are_downloaded_atomically(self):
        targets = []
        for filename in ("model.ckpt", "model.yaml"):
            (self.root / filename).touch()
            (self.root / f"{filename}.part").write_bytes(b"old partial")
            targets.append({"filename": filename, "urls": ["https://example.test/model"]})
        with patch.object(installer, "urlopen", side_effect=[Response(b"weights", 7), Response(b"config", 6)]):
            self.download_model(targets)
        self.assertEqual((self.root / "model.ckpt").read_bytes(), b"weights")
        self.assertEqual((self.root / "model.yaml").read_bytes(), b"config")
        self.assertFalse(list(self.root.glob("*.part")))

    def test_directory_model_path_fails_without_removing_user_data(self):
        directory = self.root / "model.ckpt"
        directory.mkdir()
        (directory / "keep.txt").write_text("preserve this directory")
        targets = [{"filename": "model.ckpt", "urls": ["https://example.test/model"]}]
        with patch.object(installer, "urlopen") as download:
            with self.assertRaises(SystemExit) as failure:
                self.download_model(targets)
        self.assertEqual(failure.exception.code, 1)
        self.assertEqual(installer.emit.call_args.kwargs["errorCode"], "model_path_invalid")
        self.assertEqual((directory / "keep.txt").read_text(), "preserve this directory")
        download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
