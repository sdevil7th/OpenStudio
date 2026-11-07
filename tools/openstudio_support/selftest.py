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
        display_check = 'not_applicable'
        import sys
        if sys.platform == 'win32':
            import ctypes
            user32 = ctypes.windll.user32
            user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
            user32.AreDpiAwarenessContextsEqual.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            if getattr(sys, 'frozen', False):
                assert user32.AreDpiAwarenessContextsEqual(user32.GetThreadDpiAwarenessContext(), -4), 'PMv2 manifest not active'
            from tkinter import font
            sizes = []
            for dpi in (96, 144, 192, 96):
                root._support_apply_dpi(dpi)
                root.update_idletasks()
                sizes.append(font.nametofont('TkDefaultFont', root=root).metrics('linespace'))
            assert sizes[0] < sizes[1] < sizes[2] and sizes[0] == sizes[3], sizes
            display_check = 'PMv2_context_and_font_scaling' if getattr(sys, 'frozen', False) else 'font_scaling'
        close()
        with tempfile.TemporaryDirectory(prefix='support-self-test-') as directory:
            path = Path(directory)
            from .collection import collect
            from .identity import native_ids
            import struct
            import uuid
            identity = uuid.UUID('00112233-4455-6677-8899-aabbccddeeff')
            native = path / 'fixture.macho'
            native.write_bytes(struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 1, 24, 0, 0)
                               + struct.pack('<II', 0x1b, 24) + identity.bytes)
            assert native_ids(native) == ['macho:' + str(identity).upper()]
            (path / 'PluginList.xml').write_text('<KNOWNPLUGINS><PLUGIN name="Fixture" format="VST3" pluginState="private"/></KNOWNPLUGINS>')
            evidence, files, _ = collect([path])
            assert len(files) == 1 and b'private' not in next(iter(files.values()))
            (path / 'plugin_scan_debug.txt').write_text(
                'PluginManager: Failed: C:/private/Private - FX.vst3 - probe exited with code 7\n')
            job_id = 'a' * 32 + '/' + 'b' * 32
            journal = path / 'WorkRecovery' / job_id / 'job.json'
            journal.parent.mkdir(parents=True)
            journal.write_text(json.dumps({'kind': 'recording', 'version': 1, 'id': job_id,
                                           'writeFault': 2, 'path': '/data/private/take.wav',
                                           'projectNotes': 'private'}))
            evidence, files, _ = collect([path])
            assert len(files) == 3 and all(b'private' not in data for data in files.values())
            assert any(b'probe exited with code 7' in data for data in files.values())
            assert any(b'flush_failed' in data for data in files.values())
            sf.write(path / 'silence.wav', np.zeros((16, 2)), 48000, subtype='PCM_16')
            assert sf.info(path / 'silence.wav').frames == 16
            project = path / 'test.osproj'
            project.write_text(json.dumps({'version': '1.2.0', 'tempo': 120, 'tracks': []}))
            assert prepare_project(project)['tracks'] == []
        result = {'status': 'pass', 'gui': 'constructed_hidden', 'audioDecoder': 'pass',
                  'nativeIdentity': 'pass', 'pluginSettingsCollection': 'pass',
                  'pluginFailureReason': 'pass', 'recordingRecoveryCollection': 'pass',
                  'embeddedMIDISerializer': 'pass', 'closedAppGuard': 'pass', 'displayScaling': display_check}
        if sys.platform == 'win32':
            import ctypes
            length = ctypes.c_uint32(0)
            api = ctypes.windll.kernel32.GetCurrentPackageFullName
            if api(ctypes.byref(length), None) == 122:
                name = ctypes.create_unicode_buffer(length.value)
                if api(ctypes.byref(length), name) == 0:
                    result['packageIdentity'] = name.value
    except Exception as exc:
        import traceback
        result = {'status': 'fail', 'error': str(exc), 'traceback': traceback.format_exc()}
    with output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
    return 0 if result['status'] == 'pass' else 1
