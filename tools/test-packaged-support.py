"""Exercise the actual packaged GUI executable with no Python/Node on its PATH."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import wave
import zipfile

sys.path.insert(0, str(Path(__file__).parent))
from test_openstudio_support import midi_bytes, project


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    args = parser.parse_args()
    from support_package import layout
    _root, executable, _resources = layout(args.bundle)
    path = os.environ['SystemRoot'] + '/System32;' + os.environ['SystemRoot'] if os.name == 'nt' else '/usr/bin:/bin'
    environment = dict(os.environ, PATH=path)
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    for key in ('PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_PATH'):
        environment.pop(key, None)
    def invoke(*arguments, expected=0):
        result = subprocess.run([str(executable), *map(str, arguments)], env=environment,
                                timeout=60, capture_output=True, text=True, **flags)
        if result.returncode != expected:
            detail = result.stdout + result.stderr
            if arguments[0] == '--self-test' and Path(arguments[1]).is_file():
                detail += Path(arguments[1]).read_text()
            raise AssertionError(f'Packaged operation {arguments[0]} exited {result.returncode}; expected {expected}: {detail}')
    with tempfile.TemporaryDirectory(prefix='support-package-test-') as directory:
        root = Path(directory)
        if os.name != 'nt':
            # Keep only the OS process-list utility; /usr/bin may contain Python
            # on CI images and must not accidentally satisfy a runtime dependency.
            utilities = root / 'utilities'; utilities.mkdir()
            (utilities / 'ps').symlink_to(shutil.which('ps'))
            environment['PATH'] = str(utilities)
        invoke('--self-test', root / 'selftest.json')
        assert json.loads((root / 'selftest.json').read_text())['status'] == 'pass'
        logs = root / 'logs'; logs.mkdir()
        (logs / 'debug_log.txt').write_text('Export failed: C:/Users/Alice/Private.wav\n')
        (logs / 'take.wav').write_bytes(b'never collect private audio')
        invoke('collect', '--log-dir', logs, '--output', root / 'review')
        invoke('bundle', root / 'review', '--output', root / 'unreviewed.zip', expected=1)
        assert not (root / 'unreviewed.zip').exists()
        invoke('bundle', root / 'review', '--reviewed', '--output', root / 'reviewed.zip')
        with zipfile.ZipFile(root / 'reviewed.zip') as archive:
            assert 'evidence-01.txt' in archive.namelist()
            evidence = archive.read('evidence-01.txt')
            assert b'Alice' not in evidence and b'Private' not in evidence
            assert 'take.wav' not in archive.namelist()
        with wave.open(str(root / 'audio.wav'), 'wb') as stream:
            stream.setparams((2, 2, 48000, 480, 'NONE', 'not compressed'))
            stream.writeframes(b'\0' * 480 * 4)
        invoke('audio', root / 'audio.wav', '--output', root / 'audio-report')
        audio = json.loads((root / 'audio-report/report.json').read_text())
        assert next(c for c in audio['checks'] if c['id'] == 'decode')['status'] == 'pass'
        (root / 'export.mid').write_bytes(midi_bytes())
        (root / 'project.osproj').write_text(json.dumps(project()))
        invoke('midi', root / 'export.mid', '--project', root / 'project.osproj', '--output', root / 'midi-report')
        midi = json.loads((root / 'midi-report/report.json').read_text())
        assert midi['comparison']['status'] == 'pass', midi
        invoke('collect', '--output', root / 'review', expected=1)
    print('PASS: packaged GUI construction, collection, privacy, reviewed ZIP, audio, MIDI project comparison, no overwrite; no external Python/Node.')


if __name__ == '__main__':
    main()
