"""Explicit package qualification only. Never invoked on ordinary GUI startup."""
import json
from pathlib import Path
import tempfile


def run_selftest(output):
    from .common import require_closed
    try:
        require_closed()
        import tkinter as tk
        import numpy as np
        import soundfile as sf
        from .gui import create_window
        from .packaged import prepare_project
        root = tk.Tk()
        root.withdraw()
        close = create_window(root)
        root.update_idletasks()
        close()
        with tempfile.TemporaryDirectory(prefix='support-self-test-') as directory:
            path = Path(directory)
            sf.write(path / 'silence.wav', np.zeros((16, 2)), 48000, subtype='PCM_16')
            assert sf.info(path / 'silence.wav').frames == 16
            project = path / 'test.osproj'
            project.write_text(json.dumps({'version': '1.2.0', 'tempo': 120, 'tracks': []}))
            assert prepare_project(project)['tracks'] == []
        result = {'status': 'pass', 'gui': 'constructed_hidden', 'audioDecoder': 'pass',
                  'embeddedMIDISerializer': 'pass', 'closedAppGuard': 'pass'}
        import sys
        if sys.platform == 'win32':
            import ctypes
            length = ctypes.c_uint32(0)
            api = ctypes.windll.kernel32.GetCurrentPackageFullName
            if api(ctypes.byref(length), None) == 122:
                name = ctypes.create_unicode_buffer(length.value)
                if api(ctypes.byref(length), name) == 0:
                    result['packageIdentity'] = name.value
    except Exception as exc:
        result = {'status': 'fail', 'error': str(exc)}
    with output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
    return 0 if result['status'] == 'pass' else 1
