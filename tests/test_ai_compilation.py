import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"tools"))
from ai_compilation import CompilationWorkspace, validate_optimization


class CompilationOwnershipTests(unittest.TestCase):
    def test_incompatible_optimization_fails_before_model_loading(self):
        for value,model,variant in [("compile","minimax-music-3","original"),
                ("torchao-int8","stable-audio-3-medium","int8"),
                ("disk-offload","stable-audio-3-medium","original"),
                ("rocm-fast-startup","stable-audio-3-medium","original"),
                ("rocm-fast-startup","ace-step-v15-xl-turbo","int8"),
                ("torchao-int8","stable-audio-3-medium","original"),
                ("torchao-int8","ace-step-v15-xl-turbo","original"),
                ("unknown","ace-step-v15-xl-turbo","original")]:
            with self.subTest(value=value,model=model,variant=variant), self.assertRaises(ValueError):
                validate_optimization(value,model,variant)

    def test_live_reservations_prevent_overbooking_and_cleanup_keeps_foreign_data(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            root=Path(directory)
            foreign=root/("compile-"+"a"*32)
            foreign.mkdir()
            (foreign/".owner.json").write_text(json.dumps({"kind":"foreign"}))
            (foreign/"precious").write_text("untouched")
            owner=CompilationWorkspace(root,quota_bytes=1000,reservation_bytes=700)
            with self.assertRaisesRegex(RuntimeError,"quota"):
                CompilationWorkspace(root,quota_bytes=1000,reservation_bytes=700)
            (owner.directory/"cache").write_bytes(b"compiled")
            self.assertGreater(owner.check(),0)
            owner.close()
            self.assertEqual((foreign/"precious").read_text(),"untouched")
            self.assertEqual(list(root.glob("compile-*")),[foreign])

    def test_reclaims_only_retired_pid_birth_and_enforces_actual_cache_size(self):
        import psutil
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            root=Path(directory)
            stale=root/("compile-"+"b"*32)
            stale.mkdir()
            (stale/".owner.json").write_text(json.dumps({"kind":"openstudio-compile-v1",
                "pid":os.getpid(),"birth":psutil.Process().create_time()-10,"reservation":700}))
            (stale/"cache").write_text("dead worker data")
            owner=CompilationWorkspace(root,quota_bytes=2000,reservation_bytes=700)
            self.assertFalse(stale.exists())
            (owner.directory/"oversize").write_bytes(b"x"*701)
            with self.assertRaisesRegex(RuntimeError,"reservation"):
                owner.check()
            owner.close()


if __name__ == "__main__":
    unittest.main()
