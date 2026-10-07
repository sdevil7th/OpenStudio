import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).resolve().parents[1] / 'tools/run-linux-qualification.py')
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class NativeDiagnosticsTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux process-group cleanup')
    def test_child_cleanup_survives_parent_exit_and_ignored_sigterm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pid_file = root / 'child.pid'
            child = ('import os,signal,time; from pathlib import Path; '
                     'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                     f'Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)')
            parent = ('import subprocess,sys,time; from pathlib import Path; '
                      f'subprocess.Popen([sys.executable,"-c",{child!r}]); '
                      f'p=Path({str(pid_file)!r}); '
                      'exec("while not p.exists(): time.sleep(0.01)")')
            self.assertEqual(qualification.execute([sys.executable, '-c', parent],
                             root / 'parent.log', os.environ.copy(), 5), 0)
            pid = int(pid_file.read_text())
            stat = Path(f'/proc/{pid}/stat')
            deadline = time.monotonic() + 1
            while stat.exists() and stat.read_text().split(') ', 1)[1][0] != 'Z' and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(not stat.exists() or stat.read_text().split(') ', 1)[1][0] == 'Z')

    def test_broad_qualification_cannot_inherit_narrow_fixture_selectors(self):
        inherited = {
            'DISPLAY': ':2', 'OPENSTUDIO_FORCE_PACKAGED_FRONTEND': '1',
            'OPENSTUDIO_RECORDING_FIXTURES_ONLY': '1',
            'OPENSTUDIO_METRONOME_FIXTURES_ONLY': '1',
            'OPENSTUDIO_RT_SAFETY_FIXTURES_ONLY': '1',
        }
        env = qualification.qualification_environment(inherited)
        self.assertEqual(env, {'DISPLAY': ':2', 'OPENSTUDIO_FORCE_PACKAGED_FRONTEND': '1'})
        self.assertEqual(inherited['OPENSTUDIO_RECORDING_FIXTURES_ONLY'], '1')

    def test_successful_harness_does_not_hide_shutdown_leak_or_assertion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'window-lifecycle.log').write_text(
                'success=true\n*** Leaked objects detected: 42 instance(s) of class DynamicObject\n'
                'JUCE Assertion failure in juce_LeakedObjectDetector.h:116\n')
            result = qualification.runtime_diagnostics(root)
            self.assertEqual(result['status'], 'fail')
            self.assertEqual([item['line'] for item in result['failures']], [2, 3])
            self.assertTrue(all(item['log'] == 'window-lifecycle.log' for item in result['failures']))

    def test_clean_shutdown_does_not_fail_on_routine_driver_logging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'startup.log').write_text('jack server is not running\nApplication Check-out.\n')
            self.assertEqual(qualification.runtime_diagnostics(root)['status'], 'pass')


if __name__ == '__main__':
    unittest.main()
