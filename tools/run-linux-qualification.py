#!/usr/bin/env python3
"""Check an actual Linux executable/AppImage, retaining evidence and child cleanup.

Prerequisites/asset checks run by default. --desktop explicitly exercises visible
native windows; --render exercises the headless native render/export suite.
--features runs device-switch/runtime safety and engine regressions sequentially.
Neither passing test establishes subjective audio quality or all feature support.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import time


def execute(command, log, env, timeout, executable=None, cwd=None):
    with log.open('w') as stream:
        process = subprocess.Popen([str(arg) for arg in command], executable=executable,
                                   stdout=stream, stderr=subprocess.STDOUT, env=env,
                                   start_new_session=True, cwd=cwd)
        try:
            return process.wait(timeout=timeout)
        finally:
            # Dispose only this test's session, including WebKit/helper descendants
            # on a timeout or crash. Never pkill a user's unrelated OpenStudio.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            # A parent can exit before its browser/helper descendants. Give its
            # group a bounded grace period, then dispose remaining descendants.
            deadline = time.monotonic() + 2
            while True:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                if time.monotonic() >= deadline:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    break
                time.sleep(0.02)



def runtime_diagnostics(output):
    """A passing report/exit code must not hide JUCE shutdown failures."""
    failures = []
    for log in sorted(output.glob('*.log')):
        for number, line in enumerate(log.read_text(errors='replace').splitlines(), 1):
            if '*** Leaked objects detected:' in line or 'JUCE Assertion failure' in line:
                failures.append({'log': log.name, 'line': number, 'message': line.strip()})
    return {'id': 'native-runtime-diagnostics',
            'status': 'fail' if failures else 'pass', 'failures': failures}


def qualification_environment(source):
    env = source.copy()
    # Broad qualification must not silently inherit developer-only selectors
    # that make a tiny fixture subset stand in for the full native suites.
    for selector in ('OPENSTUDIO_RECORDING_FIXTURES_ONLY',
                     'OPENSTUDIO_METRONOME_FIXTURES_ONLY',
                     'OPENSTUDIO_RT_SAFETY_FIXTURES_ONLY'):
        env.pop(selector, None)
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--desktop', action='store_true')
    parser.add_argument('--safe-mode', action='store_true', help='Run desktop lifecycle with --ui-safe-mode')
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--features', action='store_true')
    parser.add_argument('--nam-fixtures', type=Path, help='NAM Core example_models directory for installed-app engine checks; copied into evidence, never into the application')
    args = parser.parse_args()
    if args.safe_mode and not args.desktop:
        parser.error('--safe-mode requires --desktop')
    app = args.app.absolute()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error('Use a fresh output directory; existing qualification evidence is retained')
    env = qualification_environment(os.environ)
    if args.desktop and not env.get('DISPLAY'):
        raise SystemExit('--desktop requires DISPLAY/XAUTHORITY for an accessible desktop')
    with app.open('rb') as binary:
        hasher = hashlib.sha256()
        for block in iter(lambda: binary.read(1024 * 1024), b''):
            hasher.update(block)
        digest = hasher.hexdigest()
    result = {'app': str(app), 'sha256': digest,
              'osRelease': Path('/etc/os-release').read_text(), 'checks': [],
              'profileIsolation': 'Per-check WebKit XDG data/cache; pinned JUCE config, system audio and desktop remain shared',
              'windowStartupMode': 'safe' if args.safe_mode else 'normal',
              'audioQuality': 'not_asserted', 'startedAt': time.time()}
    checks = result['checks']
    engine_cwd = None
    if args.nam_fixtures:
        source = args.nam_fixtures.resolve()
        if not (source / 'wavenet_a1_standard.nam').is_file():
            parser.error('--nam-fixtures must contain wavenet_a1_standard.nam')
        engine_cwd = output / 'fixture-root'
        destination = engine_cwd / 'build/_deps/neural_amp_modeler_core-src/example_models'
        destination.mkdir(parents=True)
        fixtures = []
        for model in sorted(source.glob('*.nam')):
            shutil.copyfile(model, destination / model.name)
            fixtures.append({'name': model.name, 'sha256': hashlib.sha256(model.read_bytes()).hexdigest()})
        result['namFixtures'] = {'source': str(source), 'models': fixtures}
    else:
        result['namFixtures'] = {'source': 'legacy working-directory/executable-relative lookup; availability is checked by the engine'}

    def test_env(label):
        isolated = env.copy()
        for variable, folder in (('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache')):
            path = output / 'profiles' / label / folder
            path.mkdir(parents=True, exist_ok=True)
            isolated[variable] = str(path)
        return isolated

    try:
        for label, argv0 in (('startup', str(app)), ('runtime-path-argv0', '/tmp/OpenStudio download.AppImage'),
                            ('runtime-path-inherited-appdir', str(app))):
            report = output / f'{label}.txt'
            report.unlink(missing_ok=True)
            startup_env = test_env(label)
            if label == 'runtime-path-inherited-appdir':
                # A stale launcher environment must not redirect the assets/AI
                # scripts to a different installation, even with valid sentinels.
                fake_root = output / 'unrelated-appdir'
                fake_bin = fake_root / 'usr/bin'
                (fake_bin / 'webui').mkdir(parents=True)
                (fake_bin / 'OpenStudio').write_text('unrelated executable')
                (fake_bin / 'webui/index.html').write_text('unrelated frontend')
                startup_env.update(APPDIR=str(fake_root), APPIMAGE='/tmp/unrelated.AppImage')
            code = execute([argv0, '--startup-self-test', '--report', report],
                           output / f'{label}.log', startup_env, 60, executable=str(app))
            contents = report.read_text() if report.exists() else ''
            passed = code == 0 and 'shellReady=true' in contents
            if label == 'runtime-path-inherited-appdir':
                passed = passed and str(fake_bin) not in contents
            checks.append({'id': label, 'status': 'pass' if passed else 'fail', 'exitCode': code})
        if args.desktop:
            report = output / 'window-lifecycle.json'
            report.unlink(missing_ok=True)
            code = execute([app, '--window-lifecycle-harness', '--report', report,
                            *(['--ui-safe-mode'] if args.safe_mode else [])],
                           output / 'window-lifecycle.log', test_env('windows'), 180)
            data = json.loads(report.read_text()) if report.exists() else {}
            required = {'main_frontend_ready', 'mixer_frontend_ready', 'mixer_reopened_frontend_ready',
                        'midi_frontend_ready', 'midi_reopened_frontend_ready',
                        'plugin_frontend_ready', 'plugin_reopened_frontend_ready',
                        'plugin_removed_editor_stays_closed'}
            passed = {c['id'] for c in data.get('checks', []) if c.get('status') == 'pass'}
            okay = code == 0 and data.get('success') is True and required <= passed
            checks.append({'id': 'native-window-lifecycle', 'status': 'pass' if okay else 'fail',
                           'missingChecks': sorted(required - passed), 'exitCode': code,
                           'checkCount': len(data.get('checks', [])), 'testScope': 'native main/detached lifecycle'})
        if args.render:
            report = output / 'render-export.json'
            report.unlink(missing_ok=True)
            code = execute([app, '--render-export-regression-headless', '--output-dir', output,
                            '--report', report], output / 'render-export.log', test_env('render'), 300)
            data = json.loads(report.read_text()) if report.exists() else {}
            okay = code == 0 and data.get('objectiveGateStatus') == 'pass'
            checks.append({'id': 'render-export', 'status': 'pass' if okay else 'fail', 'exitCode': code,
                           'checkCount': len(data.get('checks', [])), 'testScope': 'native render/export objective suite'})
        if args.features:
            runtime = output / 'runtime'
            if runtime.exists():
                raise ValueError('Use a fresh output directory for feature qualification; previous evidence is retained')
            code = execute([app, '--runtime-safety-self-test', runtime], output / 'runtime.log', test_env('runtime'), 180)
            report = runtime / 'result.json'
            data = json.loads(report.read_text()) if report.exists() else {}
            checks.append({'id': 'runtime-safety', 'status': 'pass' if code == 0 and data.get('passed') is True else 'fail', 'exitCode': code,
                           'checkCount': len(data.get('checks', [])), 'testScope': 'native runtime safety and recording fault injection'})
            report = output / 'engine.json'
            report.unlink(missing_ok=True)
            code = execute([app, '--automated-regression-headless', '--report', report], output / 'engine.log', test_env('engine'), 600, cwd=engine_cwd)
            data = json.loads(report.read_text()) if report.exists() else {}
            checks.append({'id': 'engine-features', 'status': 'pass' if code == 0 and data.get('overallPass') is True else 'fail', 'exitCode': code,
                           'suiteCount': len(data.get('suites', [])), 'testScope': 'full native engine objective suites; fixture selectors cleared'})
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        checks.append({'id': 'qualification-error', 'status': 'fail', 'detail': str(error)})
    checks.append(runtime_diagnostics(output))
    result['success'] = bool(checks) and all(c['status'] == 'pass' for c in checks)
    (output / 'qualification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return 0 if result['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
