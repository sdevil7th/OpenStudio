import importlib.util
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).resolve().parents[1] / 'tools/run-linux-qualification.py')
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class NativeDiagnosticsTests(unittest.TestCase):
    def test_launcher_uses_fresh_child_without_replacing_window_manager_evidence(self):
        workflows = Path(__file__).resolve().parents[1] / '.github/workflows'
        for name in ('verify.yml', 'release.yml'):
            with self.subTest(workflow=name):
                commands = []
                for line in (workflows / name).read_text(encoding='utf-8').splitlines():
                    if 'tools/run-linux-qualification.py' not in line:
                        continue
                    # Both folded `run:` values and shell block commands carry
                    # the CLI on one line; parse its arguments, not exact text.
                    command = shlex.split(line.strip().removeprefix('run: '))
                    if '--app' in command and command[command.index('--app') + 1].endswith('.AppImage'):
                        commands.append(command)
                self.assertEqual(len(commands), 1, 'Each workflow must qualify its finished AppImage')
                command = commands[0]
                self.assertIn('--output', command)
                configured_output = Path(command[command.index('--output') + 1])
                self.assertFalse(configured_output.is_absolute(), 'Evidence must stay in the checkout artifacts')
                self.assert_launcher_evidence_isolation(configured_output)

    def assert_launcher_evidence_isolation(self, configured_output):
        # This composes the real CLI freshness guard with mocked native results;
        # it does not launch or qualify an actual Linux application.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'OpenStudio.AppImage'
            app.write_bytes(b'fixture only; never executed')
            parent = root / 'output/linux-appimage'
            parent.mkdir(parents=True)
            retained = parent / 'window-manager-lifecycle.json'
            original = b'{"fixture":"retained window-manager evidence"}\n'
            retained.write_bytes(original)
            launcher = (root / configured_output).resolve()
            self.assertTrue(launcher.is_relative_to(parent.resolve()),
                            'Both phases must remain inside the retained AppImage artifact directory')
            argv = ['run-linux-qualification.py', '--app', str(app), '--desktop', '--output']
            error_output = io.StringIO()
            with mock.patch.object(sys, 'argv', [*argv, str(parent)]), \
                 mock.patch.object(qualification, 'execute') as execute, redirect_stderr(error_output):
                with self.assertRaises(SystemExit) as rejected:
                    qualification.main()
            self.assertEqual(rejected.exception.code, 2)
            self.assertIn('Use a fresh output directory', error_output.getvalue())
            execute.assert_not_called()
            self.assertEqual(retained.read_bytes(), original)

            def native_fixture(command, log, _env, _timeout, **_):
                report = Path(command[command.index('--report') + 1])
                self.assertEqual(report.parent, launcher.resolve())
                log.write_text('mock native fixture\n')
                if '--startup-self-test' in command:
                    report.write_text('shellReady=true\n')
                else:
                    self.assertIn('--window-lifecycle-harness', command)
                    report.write_text(json.dumps({
                        'success': True, 'startupMode': 'normal',
                        'checks': [{'id': name, 'status': 'pass'} for name in (
                            'main_frontend_ready', 'mixer_frontend_ready', 'mixer_reopened_frontend_ready',
                            'midi_frontend_ready', 'midi_reopened_frontend_ready',
                            'plugin_frontend_ready', 'plugin_reopened_frontend_ready',
                            'plugin_removed_editor_stays_closed', 'pitch_cycle_1_interactive_ready',
                            'pitch_cycle_2_interactive_ready', 'pitch_native_relative_shift_committed',
                            'pitch_native_undo_preserved')],
                    }))
                return 0

            read_text = Path.read_text

            def read_fixture_os(path, *args, **kwargs):
                if path == Path('/etc/os-release'):
                    return 'NAME="Mock Linux fixture"\n'
                return read_text(path, *args, **kwargs)

            with mock.patch.object(sys, 'argv', [*argv, str(launcher)]), \
                 mock.patch.dict(os.environ, {'DISPLAY': ':fixture'}), \
                 mock.patch.object(qualification.Path, 'read_text', read_fixture_os), \
                 mock.patch.object(qualification, 'execute', side_effect=native_fixture) as execute, \
                 redirect_stdout(io.StringIO()):
                self.assertEqual(qualification.main(), 0)
            self.assertEqual(execute.call_count, 4)
            self.assertEqual(retained.read_bytes(), original)
            result_path = launcher / 'qualification.json'
            result = json.loads(result_path.read_text())
            self.assertTrue(result['success'])
            self.assertEqual(result['audioQuality'], 'not_asserted')
            self.assertEqual({check['id'] for check in result['checks']}, {
                'startup', 'runtime-path-argv0', 'runtime-path-inherited-appdir',
                'native-window-lifecycle', 'native-runtime-diagnostics'})

            # Reusing even the child remains forbidden and must preserve both reports.
            launcher_evidence = result_path.read_bytes()
            with mock.patch.object(sys, 'argv', [*argv, str(launcher)]), \
                 mock.patch.object(qualification, 'execute') as execute, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as rejected:
                    qualification.main()
            self.assertEqual(rejected.exception.code, 2)
            execute.assert_not_called()
            self.assertEqual(result_path.read_bytes(), launcher_evidence)
            self.assertEqual(retained.read_bytes(), original)

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
