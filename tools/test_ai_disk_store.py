import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch
from ai_disk_store import DiskWeightStore, cleanup_stale_stores


class DiskStoreTests(unittest.TestCase):
    def test_mapped_parameters_preserve_bytes_dtype_and_ties(self):
        with tempfile.TemporaryDirectory() as directory:
            model = torch.nn.Sequential(torch.nn.Linear(32, 16), torch.nn.Linear(16, 8).bfloat16())
            original = [p.detach().clone() for p in model.parameters()]
            store = DiskWeightStore([model, model], root=Path(directory))
            owned = store.directory
            try:
                self.assertEqual(len(store.bindings), len(original))
                for value, expected in zip(model.parameters(), original):
                    self.assertTrue(torch.equal(value, expected))
                    self.assertEqual(value.dtype, expected.dtype)
                    staging = torch.empty_like(value)
                    store.read_into(value, staging)
                    self.assertTrue(torch.equal(staging, expected))
                cleanup_stale_stores(Path(directory))
                self.assertTrue(owned.exists())
            finally:
                store.close()
            self.assertFalse(owned.exists())

    def test_truncated_file_fails_instead_of_using_partial_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            model = torch.nn.Linear(4, 4)
            store = DiskWeightStore([model], root=Path(directory))
            try:
                # Simulate an incomplete read without truncating an active
                # Windows mapping (which the OS correctly disallows).
                with patch.object(store.reader, "readinto", return_value=0):
                    with self.assertRaisesRegex(OSError, "truncated"):
                        store.read_into(model.weight, torch.empty_like(model.weight))
            finally:
                store.close()

    def test_quota_failure_keeps_original_model_intact(self):
        with tempfile.TemporaryDirectory() as directory:
            model = torch.nn.Linear(4, 4)
            original = model.weight.detach().clone()
            with self.assertRaisesRegex(RuntimeError, "quota"):
                DiskWeightStore([model], root=Path(directory), quota_bytes=1)
            self.assertTrue(torch.equal(model.weight, original))
            self.assertFalse(list(Path(directory).iterdir()))

    def test_stale_cleanup_only_removes_owned_inactive_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stale = root / "worker-123-stale"
            stale.mkdir()
            (stale / "weights.bin").write_bytes(b"weights")
            (stale / "owner.json").write_text(json.dumps({"kind": "openstudio-weight-store", "pid": 123}))
            foreign = root / "worker-unowned"
            foreign.mkdir()
            with patch("psutil.pid_exists", return_value=False):
                cleanup_stale_stores(root)
            self.assertFalse(stale.exists())
            self.assertTrue(foreign.exists())


if __name__ == "__main__":
    unittest.main()
