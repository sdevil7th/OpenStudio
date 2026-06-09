import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "tools" / "cleanup_openstudio_storage.ps1"


class CleanupOpenStudioStorageTests(unittest.TestCase):
    def run_cleanup(self, openstudio_root: Path, ace_cache_root: Path, *extra_args: str) -> str:
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if not powershell:
            self.skipTest("PowerShell is not available")

        command = [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SCRIPT_PATH),
            "-OpenStudioRoot",
            str(openstudio_root),
            "-AceCacheRoot",
            str(ace_cache_root),
            "-MinLogAgeDays",
            "30",
            *extra_args,
        ]
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout

    def test_dry_run_reports_stale_runtime_backups_and_old_logs_without_deleting(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "OpenStudio"
            site_packages = root / "stem-runtime" / "Lib" / "site-packages"
            stale_torch = site_packages / "~orch"
            active_torch = site_packages / "torch"
            old_logs = root / "logs" / "ai"
            stale_torch.mkdir(parents=True)
            active_torch.mkdir(parents=True)
            old_logs.mkdir(parents=True)
            (stale_torch / "torch_cuda.dll").write_bytes(b"x" * 32)
            (active_torch / "__init__.py").write_text("# active torch\n", encoding="utf-8")
            old_log = old_logs / "old.jsonl"
            old_log.write_text("log\n", encoding="utf-8")
            old_time = time.time() - (60 * 60 * 24 * 45)
            os.utime(old_log, (old_time, old_time))

            ace_cache = Path(temp_dir) / "ace-step"
            (ace_cache / "checkpoints").mkdir(parents=True)
            (ace_cache / "diffusers").mkdir(parents=True)

            output = self.run_cleanup(root, ace_cache)

            self.assertIn("DRY RUN", output)
            self.assertIn("~orch", output)
            self.assertIn("old.jsonl", output)
            self.assertIn("Legacy ACE checkpoints cache not included", output)
            self.assertTrue(stale_torch.exists())
            self.assertTrue(old_log.exists())
            self.assertTrue(active_torch.exists())

    def test_dry_run_can_include_legacy_ace_cache_when_diffusers_cache_exists(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "OpenStudio"
            root.mkdir()
            ace_cache = Path(temp_dir) / "ace-step"
            legacy = ace_cache / "checkpoints"
            diffusers = ace_cache / "diffusers"
            legacy.mkdir(parents=True)
            diffusers.mkdir(parents=True)
            (legacy / "legacy.bin").write_bytes(b"x" * 64)
            (diffusers / "model.bin").write_bytes(b"x" * 64)

            output = self.run_cleanup(root, ace_cache, "-IncludeLegacyAceCache")

            self.assertIn("legacy-ace-cache", output)
            self.assertIn(str(legacy), output)
            self.assertTrue(legacy.exists())
            self.assertTrue(diffusers.exists())


if __name__ == "__main__":
    unittest.main()
