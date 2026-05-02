import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import Mock, patch


REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import install_ai_tools as installer  # noqa: E402


class FailCalled(Exception):
    def __init__(self, message: str, **kwargs) -> None:
        super().__init__(message)
        self.message = message
        self.kwargs = kwargs


class RepairWindowsReusedRuntimeTests(unittest.TestCase):
    def make_runtime_layout(self, temp_dir: str) -> tuple[Path, Path, Path, Path]:
        runtime_root = Path(temp_dir) / "stem-runtime"
        runtime_python = runtime_root / "Scripts" / "python.exe"
        site_packages = runtime_root / "Lib" / "site-packages"
        bootstrap_python = Path(temp_dir) / "python311.exe"
        runtime_python.parent.mkdir(parents=True, exist_ok=True)
        site_packages.mkdir(parents=True, exist_ok=True)
        runtime_python.touch()
        bootstrap_python.touch()
        return runtime_root, runtime_python, site_packages, bootstrap_python

    def fail_stub(self, message: str, **kwargs):
        raise FailCalled(message, **kwargs)

    def test_healthy_reused_runtime_skips_repair(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_root, runtime_python, _site_packages, bootstrap_python = self.make_runtime_layout(temp_dir)
            with (
                patch.object(installer.platform, "system", return_value="Windows"),
                patch.object(installer, "probe_windows_reused_runtime_health", return_value=True),
                patch.object(installer, "run_step_process") as run_step_process,
                patch.object(installer, "terminate_windows_runtime_lock_holders") as terminate_holders,
                patch.object(installer, "emit", Mock()),
                patch.object(installer, "log_event", Mock()),
            ):
                returned_python, returned_version, reused = installer.repair_windows_reused_runtime(
                    runtime_python,
                    runtime_root,
                    bootstrap_python,
                    (3, 11, 9),
                    (3, 11, 9),
                    install_source="externalPython",
                    requires_external_python=True,
                    python_detected=True,
                    build_runtime_mode="unbundled-dev",
                )

            self.assertEqual(returned_python, runtime_python)
            self.assertEqual(returned_version, (3, 11, 9))
            self.assertTrue(reused)
            run_step_process.assert_not_called()
            terminate_holders.assert_not_called()

    def test_locked_runtime_file_triggers_single_rebuild(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_root, runtime_python, site_packages, bootstrap_python = self.make_runtime_layout(temp_dir)
            locked_file = site_packages / "81d243bd2c585b0f4821__mypyc.cp311-win_amd64.pyd"
            rebuild_python = runtime_root / "Scripts" / "python.exe"
            repair_result = CompletedProcess(
                args=["pip", "install"],
                returncode=1,
                stdout="",
                stderr=(
                    "ERROR: Could not install packages due to an OSError: [WinError 5] "
                    f"Access is denied: '{locked_file}'\nCheck the permissions.\n"
                ),
            )

            with (
                patch.object(installer.platform, "system", return_value="Windows"),
                patch.object(installer, "probe_windows_reused_runtime_health", return_value=False),
                patch.object(installer, "run_step_process", return_value=repair_result) as run_step_process,
                patch.object(installer, "remove_tree_with_retries", return_value=[]),
                patch.object(installer, "run_step") as run_step,
                patch.object(installer, "resolve_runtime_python", return_value=rebuild_python),
                patch.object(installer, "read_python_version_info", return_value=(3, 11, 9)),
                patch.object(installer, "emit", Mock()),
                patch.object(installer, "log_event", Mock()),
            ):
                returned_python, returned_version, reused = installer.repair_windows_reused_runtime(
                    runtime_python,
                    runtime_root,
                    bootstrap_python,
                    (3, 11, 9),
                    (3, 11, 9),
                    install_source="externalPython",
                    requires_external_python=True,
                    python_detected=True,
                    build_runtime_mode="unbundled-dev",
                )

            self.assertEqual(returned_python, rebuild_python)
            self.assertEqual(returned_version, (3, 11, 9))
            self.assertFalse(reused)
            run_step_process.assert_called_once()
            run_step.assert_called_once()
            self.assertEqual(run_step.call_args.kwargs["error_code"], "runtime_locked_rebuild_failed")

    def test_non_lock_failure_does_not_rebuild(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_root, runtime_python, _site_packages, bootstrap_python = self.make_runtime_layout(temp_dir)
            repair_result = CompletedProcess(
                args=["pip", "install"],
                returncode=1,
                stdout="",
                stderr="ERROR: Could not find a version that satisfies the requirement broken-package\n",
            )

            with (
                patch.object(installer.platform, "system", return_value="Windows"),
                patch.object(installer, "probe_windows_reused_runtime_health", return_value=False),
                patch.object(installer, "run_step_process", return_value=repair_result),
                patch.object(installer, "remove_tree_with_retries") as remove_tree,
                patch.object(installer, "run_step") as run_step,
                patch.object(installer, "fail", side_effect=self.fail_stub),
                patch.object(installer, "emit", Mock()),
                patch.object(installer, "log_event", Mock()),
            ):
                with self.assertRaises(FailCalled) as failure:
                    installer.repair_windows_reused_runtime(
                        runtime_python,
                        runtime_root,
                        bootstrap_python,
                        (3, 11, 9),
                        (3, 11, 9),
                        install_source="externalPython",
                        requires_external_python=True,
                        python_detected=True,
                        build_runtime_mode="unbundled-dev",
                    )

            self.assertEqual(failure.exception.kwargs["error_code"], "dependency_bootstrap_failed")
            remove_tree.assert_not_called()
            run_step.assert_not_called()

    def test_locked_runtime_remove_failure_reports_specific_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_root, runtime_python, site_packages, bootstrap_python = self.make_runtime_layout(temp_dir)
            locked_file = site_packages / "81d243bd2c585b0f4821__mypyc.cp311-win_amd64.pyd"
            repair_result = CompletedProcess(
                args=["pip", "install"],
                returncode=1,
                stdout="",
                stderr=(
                    "ERROR: Could not install packages due to an OSError: [WinError 5] "
                    f"Access is denied: '{locked_file}'\nCheck the permissions.\n"
                ),
            )

            with (
                patch.object(installer.platform, "system", return_value="Windows"),
                patch.object(installer, "probe_windows_reused_runtime_health", return_value=False),
                patch.object(installer, "run_step_process", return_value=repair_result),
                patch.object(installer, "remove_tree_with_retries", side_effect=OSError("still locked")),
                patch.object(installer, "run_step") as run_step,
                patch.object(installer, "fail", side_effect=self.fail_stub),
                patch.object(installer, "emit", Mock()),
                patch.object(installer, "log_event", Mock()),
            ):
                with self.assertRaises(FailCalled) as failure:
                    installer.repair_windows_reused_runtime(
                        runtime_python,
                        runtime_root,
                        bootstrap_python,
                        (3, 11, 9),
                        (3, 11, 9),
                        install_source="externalPython",
                        requires_external_python=True,
                        python_detected=True,
                        build_runtime_mode="unbundled-dev",
                    )

            self.assertEqual(failure.exception.kwargs["error_code"], "runtime_rebuild_remove_failed")
            run_step.assert_not_called()


if __name__ == "__main__":
    unittest.main()
