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


class AutomaticBackendValidationTests(unittest.TestCase):
    def test_native_maintenance_arguments_are_accepted_by_real_cli(self):
        class ParsedArguments(Exception):
            pass
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(sys, "argv", ["install_ai_tools.py", "--runtime-root", directory,
                "--models-dir", directory, "--required-backend", "cuda", "--skip-generation-checkpoints"]),
            patch.object(installer, "write_log"), patch.object(installer, "log_event"),
            patch.object(installer, "probe_hardware_requirements", side_effect=ParsedArguments),
        ):
            # Reach the first hardware operation through the actual parser;
            # --help would accept unknown arguments without validating them.
            with self.assertRaises(ParsedArguments):
                installer.main()

    def test_required_backend_rejects_import_failure_or_cpu_fallback(self):
        for report in ({"runtimeReady": False, "selectedBackend": "cuda"},
                       {"runtimeReady": True, "selectedBackend": "cpu"},
                       {"runtimeReady": True, "selectedBackend": "directml"}):
            with self.subTest(report=report), self.assertRaises(installer.InstallerStepError) as error:
                installer.required_backend_validation_command(report, "cuda", Path("python"))
            self.assertEqual(error.exception.error_code, "required_backend_unavailable")

    def run_validation(self, backend, torch):
        import contextlib
        import io
        command = installer.required_backend_validation_command(
            {"runtimeReady": True, "selectedBackend": backend}, backend, Path("python"))
        with patch.dict(sys.modules, {"torch": torch}), contextlib.redirect_stdout(io.StringIO()):
            exec(command[-1], {})

    def torch(self, *, available=True, hip=None, gpu_tensor=True):
        from types import SimpleNamespace as NS
        class Tensor:
            is_cuda = gpu_tensor
            def __mul__(self, _other): return self
            def sum(self): return NS(item=lambda: 256.0)
        return NS(version=NS(hip=hip), cuda=NS(is_available=lambda: available, synchronize=Mock()),
                  full=Mock(return_value=Tensor()))

    def test_required_cuda_checks_allocation_kernel_result_and_sync(self):
        torch = self.torch()
        self.run_validation("cuda", torch)
        self.assertEqual(torch.full.call_args.kwargs["device"], "cuda:0")
        torch.cuda.synchronize.assert_called_once()

    def test_cuda_label_does_not_accept_unavailable_gpu_or_cpu_tensor_or_rocm(self):
        for torch in (self.torch(available=False), self.torch(gpu_tensor=False), self.torch(hip="7.2")):
            with self.assertRaises(AssertionError): self.run_validation("cuda", torch)

    def test_cpu_validation_does_not_initialize_cuda(self):
        torch = self.torch(available=False, gpu_tensor=False)
        self.run_validation("cpu", torch)
        self.assertEqual(torch.full.call_args.kwargs["device"], "cpu")
        torch.cuda.synchronize.assert_not_called()

    def test_required_backend_disables_directml_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = root / "openstudio-ai-backend-plans/ai-runtime-install-plan-windows-directml.json"
            plan.parent.mkdir(); plan.touch()
            with patch.object(installer.platform, "system", return_value="Windows"), patch.object(
                    installer, "load_backend_install_plan", return_value={"backend": "directml"}):
                self.assertEqual(installer.resolve_fallback_backend_install_plan(root, "cuda")[0], "directml")
                self.assertIsNone(installer.resolve_fallback_backend_install_plan(root, "cuda", required_backend="cuda"))


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


class WindowsBackendFallbackTests(unittest.TestCase):
    def test_managed_candidates_activate_on_all_platforms_without_replacing_active_files(self):
        for system in ("Windows", "Linux", "Darwin"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "stem-runtime"
                root.mkdir()
                original = root / "original.txt"
                original.write_text("working")
                candidate = root.with_name("stem-runtime-candidate-" + "a" * 32)
                candidate.mkdir()
                with patch.object(installer.platform, "system", return_value=system), patch.object(installer, "log_event"):
                    installer.activate_windows_runtime(candidate, candidate)
                self.assertEqual((root.parent / "stem-runtime-active.txt").read_text().strip(), candidate.name)
                self.assertEqual(original.read_text(), "working")

    def tearDown(self):
        installer.cleanup_pending_runtime_candidate()

    def test_directml_candidate_preserves_source_runtime_until_activation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "stem-runtime"
            python = root / "python" / "python.exe"
            dll = root / "python" / "Lib" / "site-packages" / "onnxruntime" / "capi" / "onnxruntime_providers_shared.dll"
            dll.parent.mkdir(parents=True)
            python.touch()
            dll.write_bytes(b"original CUDA runtime")

            with patch.object(installer, "log_event", Mock()):
                candidate, candidate_python = installer.prepare_windows_fallback_runtime(root, python)

            self.assertNotEqual(candidate, root)
            self.assertTrue(candidate_python.is_file())
            (candidate / dll.relative_to(root)).write_bytes(b"DirectML runtime")
            self.assertEqual(dll.read_bytes(), b"original CUDA runtime")
            self.assertFalse((Path(temp_dir) / "stem-runtime-active.txt").exists())

            with (
                patch.object(installer.platform, "system", return_value="Windows"),
                patch.object(installer, "log_event", Mock()),
            ):
                installer.activate_windows_runtime(root, candidate)

            self.assertEqual(
                (Path(temp_dir) / "stem-runtime-active.txt").read_text().strip(),
                candidate.name,
            )
            self.assertIsNone(installer.PENDING_RUNTIME_CANDIDATE)

    def test_activation_failure_keeps_previous_selection_and_cleans_candidate(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "stem-runtime"
            python = root / "python" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            marker = Path(temp_dir) / "stem-runtime-active.txt"
            marker.write_text("stem-runtime\n")
            with patch.object(installer, "log_event", Mock()):
                candidate, _ = installer.prepare_windows_fallback_runtime(root, python)

            with (
                patch.object(installer.platform, "system", return_value="Windows"),
                patch.object(installer.os, "replace", side_effect=PermissionError("locked")),
            ):
                with self.assertRaises(installer.InstallerStepError):
                    installer.activate_windows_runtime(root, candidate)

            self.assertEqual(marker.read_text(), "stem-runtime\n")
            installer.cleanup_pending_runtime_candidate()
            self.assertFalse(candidate.exists())


if __name__ == "__main__":
    unittest.main()
