import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "openstudio_builder", Path(__file__).resolve().parents[1] / "build.py"
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def wait_for_file(path):
    deadline = time.monotonic() + 5
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    if not path.exists():
        raise AssertionError(f"Child did not create {path}")


def process_is_running(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1][0]
        return state != "Z"
    except FileNotFoundError:
        return False


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux process-group integration")
class PosixLifecycleTests(unittest.TestCase):
    def tearDown(self):
        builder.cleanup()

    def test_unrelated_openstudio_survives_orphan_check_and_owned_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "sentinel-ready"
            sentinel_code = (
                "import ctypes,time; from pathlib import Path; "
                "ctypes.CDLL(None).prctl(15,b'OpenStudio',0,0,0); "
                f"Path({str(ready)!r}).touch(); time.sleep(60)"
            )
            sentinel = subprocess.Popen(
                [sys.executable, "-c", sentinel_code], start_new_session=True
            )
            try:
                wait_for_file(ready)
                builder.kill_orphaned_openstudio()
                self.assertIsNone(sentinel.poll())
                builder.cpp_process = builder.start_owned_process(
                    [sys.executable, "-c", "import time; time.sleep(60)"]
                )
                owned = builder.cpp_process
                self.assertEqual(os.getpgid(owned.pid), owned.pid)
                self.assertNotEqual(os.getpgid(owned.pid), os.getpgrp())
                builder.cleanup()
                self.assertIsNotNone(owned.poll())
                self.assertIsNone(sentinel.poll())
                builder.cleanup()  # Repeated cleanup must remain harmless.
                self.assertIsNone(sentinel.poll())
            finally:
                sentinel.terminate()
                sentinel.wait(timeout=5)

    def test_cleanup_removes_sigterm_ignoring_child_after_parent_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            child_pid_file = Path(directory) / "child.pid"
            child_code = (
                "import os,signal,time; from pathlib import Path; "
                "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                f"Path({str(child_pid_file)!r}).write_text(str(os.getpid())); "
                "time.sleep(60)"
            )
            parent_code = (
                "import subprocess,sys,time; from pathlib import Path; "
                f"subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
                f"ready=Path({str(child_pid_file)!r}); "
                "exec('while not ready.exists(): time.sleep(0.01)')"
            )
            owned = builder.start_owned_process([sys.executable, "-c", parent_code])
            try:
                wait_for_file(child_pid_file)
                child_pid = int(child_pid_file.read_text())
                self.assertEqual(owned.wait(timeout=5), 0)
                self.assertTrue(process_is_running(child_pid))
                builder.stop_owned_process(owned, timeout_seconds=0.15)
                deadline = time.monotonic() + 1
                while process_is_running(child_pid) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(process_is_running(child_pid))
            finally:
                builder.stop_owned_process(owned, timeout_seconds=0.1)

    def test_refuses_to_signal_builder_group(self):
        process = mock.Mock(pid=os.getpgrp())
        with mock.patch.object(builder.os, "killpg") as signal_group:
            with self.assertRaisesRegex(RuntimeError, "builder's own process group"):
                builder.stop_owned_process(process)
        signal_group.assert_not_called()


class WindowsOrphanContractTests(unittest.TestCase):
    def test_windows_keeps_existing_tasklist_and_taskkill_contract(self):
        result = mock.Mock(stdout='"OpenStudio.exe","4321","Console","1","42 K"\n')
        with mock.patch.object(builder.platform, "system", return_value="Windows"), \
                mock.patch.object(builder.subprocess, "run", return_value=result) as run, \
                mock.patch.object(builder.time, "sleep"):
            builder.kill_orphaned_openstudio()
        self.assertEqual(run.call_args_list[0].args[0][0], "tasklist")
        self.assertEqual(
            run.call_args_list[1].args[0], ["taskkill", "/F", "/T", "/PID", "4321"]
        )


if __name__ == "__main__":
    unittest.main()
