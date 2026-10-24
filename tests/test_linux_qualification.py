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
    @staticmethod
    def runtime_report():
        return {
            'passed': True,
            'checks': [{'name': 'json_document_posix_rename_failure_preserves_both_files',
                        'status': 'pass'}],
            'posixAtomicPublicationPermissionFailure': 'pass',
            'subjectiveAudio': 'not_asserted', 'hardwareDrivers': 'not_asserted',
        }

    def test_runtime_safety_accepts_nonempty_native_checks_and_posix_failure_proof(self):
        report = self.runtime_report()
        report['checks'].extend({'name': f'native_contract_{index}', 'status': 'pass'}
                                for index in range(368))
        result = qualification.runtime_safety_check(report, 0)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['checkCount'], 369)
        self.assertTrue(result['checksPassed'])
        self.assertEqual(result['posixAtomicPublicationPermissionFailure'], 'pass')

    def test_runtime_safety_rejects_missing_or_malformed_checks(self):
        report = self.runtime_report()
        del report['checks']
        self.assertEqual(qualification.runtime_safety_check(report, 0)['status'], 'fail')
        for checks in ([], None, True, 'pass', {'status': 'pass'}, [None], [{}]):
            with self.subTest(checks=checks):
                report['checks'] = checks
                result = qualification.runtime_safety_check(report, 0)
                self.assertEqual(result['status'], 'fail')
                self.assertFalse(result['checksPassed'])

    def test_runtime_safety_rejects_failed_check_despite_passing_summary(self):
        report = self.runtime_report()
        report['checks'].append({'name': 'recording_failure', 'status': 'fail'})
        result = qualification.runtime_safety_check(report, 0)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['checksPassed'])

    def test_runtime_safety_requires_posix_failure_to_be_asserted(self):
        report = self.runtime_report()
        del report['posixAtomicPublicationPermissionFailure']
        result = qualification.runtime_safety_check(report, 0)
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['posixAtomicPublicationPermissionFailure'], 'missing')
        for status in ('not_asserted: root can bypass directory write permissions',
                       'fail', None, True):
            with self.subTest(status=status):
                report['posixAtomicPublicationPermissionFailure'] = status
                result = qualification.runtime_safety_check(report, 0)
                self.assertEqual(result['status'], 'fail')
                self.assertEqual(result['posixAtomicPublicationPermissionFailure'], status)

    def test_runtime_safety_requires_true_summary_and_successful_exit(self):
        report = self.runtime_report()
        self.assertEqual(qualification.runtime_safety_check(report, 1)['status'], 'fail')
        for passed in (False, None, 'true', 1):
            with self.subTest(passed=passed):
                report['passed'] = passed
                self.assertEqual(qualification.runtime_safety_check(report, 0)['status'], 'fail')

    def test_runtime_safety_rejects_malformed_report(self):
        for report in (None, [], 'passed', True):
            with self.subTest(report=report):
                result = qualification.runtime_safety_check(report, 0)
                self.assertEqual(result['status'], 'fail')
                self.assertEqual(result['checkCount'], 0)

    def test_safe_recovery_boot_cannot_stand_in_for_normal_pitch_editing(self):
        report = {
            'startupMode': 'safe', 'success': True,
            'checks': [{'id': name, 'status': 'pass'} for name in (
                'main_frontend_ready', 'mixer_frontend_ready', 'mixer_reopened_frontend_ready',
                'midi_frontend_ready', 'midi_reopened_frontend_ready',
                'plugin_frontend_ready', 'plugin_reopened_frontend_ready',
                'plugin_removed_editor_stays_closed', 'pitch_safe_cycle_1_frontend_ready',
                'pitch_safe_cycle_2_frontend_ready')],
        }
        self.assertEqual(qualification.window_lifecycle_check(report, 0, True)['status'], 'pass')
        normal = qualification.window_lifecycle_check(report, 0, False)
        self.assertEqual(normal['status'], 'fail')
        self.assertIn('pitch_native_relative_shift_committed', normal['missingChecks'])
        self.assertFalse(normal['startupModeMatches'])
        report['checks'].pop()
        self.assertEqual(qualification.window_lifecycle_check(report, 0, True)['status'], 'fail')

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
            'OPENSTUDIO_NAM_FUZZ_ONLY': '1',
            'OPENSTUDIO_NAM_TWO_RACK_CPU_ONLY': '1',
            'OPENSTUDIO_NAM_TWO_RACK_CPU_CONTRACTS_ONLY': '1',
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
