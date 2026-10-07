#!/usr/bin/env python3
"""Exercise built frontend controls in the system WebKitGTK using real X11 input.

Run under xvfb-run with python3-gi, gir1.2-webkit2-4.1 and libXtst installed.
This intentionally uses the distribution's browser, not Playwright's WebKit.
It checks UI behavior with the frontend's mock bridge, not native audio/backend I/O.
"""
import argparse
import ctypes
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frontend-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    frontend = args.frontend_dir.resolve()
    output = args.output.resolve()
    if not (frontend / 'index.html').is_file():
        parser.error('Build the frontend first; index.html is missing')
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error('Use a fresh output directory to preserve previous evidence')

    # XTest injects into DISPLAY. Do not let GTK choose an unrelated Wayland
    # session inherited from the user's desktop when running under Xvfb.
    os.environ['GDK_BACKEND'] = 'x11'
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    gi.require_version('WebKit2', '4.1')
    from gi.repository import Gdk, GLib, Gtk, WebKit2

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(frontend)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    window = Gtk.Window()
    window.set_decorated(False)
    window.set_default_size(1200, 900)
    browser = WebKit2.WebView.new_with_context(WebKit2.WebContext.new_ephemeral())
    window.add(browser)
    x11 = ctypes.CDLL('libX11.so.6')
    xtest = ctypes.CDLL('libXtst.so.6')
    x11.XOpenDisplay.restype = ctypes.c_void_p
    display = x11.XOpenDisplay(None)
    if not display:
        raise SystemExit('An X11 display is required; use xvfb-run')
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x11.XStringToKeysym.restype = ctypes.c_ulong
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XKeysymToKeycode.restype = ctypes.c_uint
    xtest.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    report = {'engine': 'system WebKitGTK', 'version': [WebKit2.get_major_version(),
              WebKit2.get_minor_version(), WebKit2.get_micro_version()],
              'backend': 'frontend mock bridge; audio not asserted', 'checks': [], 'success': False}
    finished = False

    def check(name, passed, detail=None):
        report['checks'].append({'id': name, 'status': 'pass' if passed else 'fail', 'detail': detail})
        if not passed:
            raise AssertionError(name)

    def audit():
        selector = 'input[aria-label^="Volume fader for"]'
        for _ in range(60):
            ready = yield ('js', f'document.querySelector({json.dumps(selector)}) !== null')
            if ready:
                break
            yield ('wait', 250)
        check('main_controls_ready', ready)
        report['userAgent'] = yield ('js', 'navigator.userAgent')
        yield ('js', "[...document.querySelectorAll('button')].find(e => e.textContent === 'Use these profiles')?.click()")
        yield ('js', "document.querySelector('button[aria-label=\"Add new audio track\"]').click()")
        yield ('wait', 500)
        count = yield ('js', f'document.querySelectorAll({json.dumps(selector)}).length')
        check('master_and_track_present', count == 2, count)
        for index in range(count):
            element = f'document.querySelectorAll({json.dumps(selector)})[{index}]'
            info = yield ('js', f'''(() => {{const e = {element}; return {{
                label: e.getAttribute('aria-label'), rect: e.getBoundingClientRect().toJSON(),
                parent: e.parentElement.getBoundingClientRect().toJSON(), value: Number(e.value),
                orientation: e.getAttribute('aria-orientation')}};}})()''')
            rect, parent = info['rect'], info['parent']
            check(f'fader_{index}_geometry', rect['height'] > rect['width'] * 3
                  and rect['width'] >= 12 and rect['left'] >= parent['left'] - 1
                  and rect['right'] <= parent['right'] + 1 and rect['top'] >= parent['top'] - 1
                  and rect['bottom'] <= parent['bottom'] + 1, info)
            check(f'fader_{index}_accessible_orientation', info['orientation'] == 'vertical')
            x = rect['x'] + rect['width'] / 2
            yield ('click', x, rect['y'] + rect['height'] * 0.8)
            low = yield ('js', f'Number({element}.value)')
            yield ('click', x, rect['y'] + rect['height'] * 0.2)
            high = yield ('js', f'Number({element}.value)')
            check(f'fader_{index}_vertical_axis', low < -30 and high > -10 and high - low > 25,
                  {'lowerClick': low, 'upperClick': high})
            y = rect['y'] + rect['height'] * 0.5
            yield ('move', x, y)
            yield ('down',)
            start = yield ('js', f'Number({element}.value)')
            yield ('move', x + 100, y)
            sideways = yield ('js', f'Number({element}.value)')
            yield ('up',)
            check(f'fader_{index}_sideways_stable', abs(start - sideways) < 0.11)
            undo = yield ('js', 'document.querySelector("button[aria-label=Undo]").getBoundingClientRect().toJSON()')
            yield ('click', undo['x'] + undo['width'] / 2, undo['y'] + undo['height'] / 2)
            restored = yield ('js', f'Number({element}.value)')
            check(f'fader_{index}_single_undo', abs(restored - high) < 0.11, restored)
            yield ('click', x, y)
            yield ('key', 'Home')
            minimum = yield ('js', f'Number({element}.value)')
            yield ('key', 'End')
            maximum = yield ('js', f'Number({element}.value)')
            check(f'fader_{index}_keyboard_endpoints', minimum == -60 and maximum == 12)
        for label in ('Audio Settings', 'Plugin Browser'):
            if label == 'Plugin Browser':
                rect = yield ('js', '''document.querySelector('button[aria-label="Insert menu"]').getBoundingClientRect().toJSON()''')
                yield ('click', rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2)
                trigger = '''[...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.includes("Virtual Instrument on New Track"))'''
            else:
                trigger = 'document.querySelector(' + json.dumps('button[aria-label="' + label + '"]') + ')'

            rect = yield ('js', trigger + '.getBoundingClientRect().toJSON()')
            yield ('click', rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2)
            for _ in range(30):
                ready = yield ('js', "!!document.querySelector('[role=dialog][aria-modal=true]')")
                if ready:
                    break
                yield ('wait', 100)
            check(label + '_dialog_ready', ready)
            count_before = yield ('js', f'document.querySelectorAll({json.dumps(selector)}).length')
            for tab_index in range(12):
                yield ('key', 'Tab')
                inside = yield ('js', "!!document.activeElement?.closest('[role=dialog][aria-modal=true]')")
                check(f'{label}_focus_contained_{tab_index}', inside)
            yield ('chord', ['Control_L', 't'])
            after = yield ('js', f'document.querySelectorAll({json.dumps(selector)}).length')
            check(label + '_blocks_background_track_insert', after == count_before, after)
            yield ('key', 'Escape')
            yield ('wait', 400)
            closed = yield ('js', "!document.querySelector('[role=dialog][aria-modal=true]')")
            check(label + '_escape_closes', closed)
        # Allow the last native input repaint before retaining the screenshot.
        yield ('wait', 250)
        report['success'] = True

    steps = audit()

    def finish(error=None):
        nonlocal finished
        if finished:
            return False
        finished = True
        if error:
            report['success'] = False
            report['error'] = str(error)
        (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        try:
            width, height = window.get_size()
            pixbuf = Gdk.pixbuf_get_from_window(window.get_window(), 0, 0, width, height)
            pixbuf.savev(str(output / 'controls.png'), 'png', [], [])
        except Exception as exception:
            print('Screenshot unavailable:', exception)
        Gtk.main_quit()
        return False

    def advance(value=None):
        if finished:
            return False
        try:
            command = steps.send(value)
            operation = command[0]
            if operation == 'js':
                def evaluated(view, result, *_args):
                    try:
                        advance(json.loads(view.evaluate_javascript_finish(result).to_string()))
                    except Exception as exception:
                        finish(exception)
                browser.evaluate_javascript(f'JSON.stringify(({command[1]}) ?? null)', -1,
                                            None, None, None, evaluated, None)
            elif operation == 'wait':
                GLib.timeout_add(command[1], advance)
            else:
                if operation in ('click', 'move'):
                    origin = window.get_window().get_origin()
                    scale = window.get_scale_factor()
                    xtest.XTestFakeMotionEvent(display, -1, round((command[1] + origin[-2]) * scale),
                                              round((command[2] + origin[-1]) * scale), 0)
                if operation in ('click', 'down'):
                    xtest.XTestFakeButtonEvent(display, 1, 1, 0)
                if operation in ('click', 'up'):
                    xtest.XTestFakeButtonEvent(display, 1, 0, 0)
                if operation == 'key':
                    key = x11.XKeysymToKeycode(display, x11.XStringToKeysym(command[1].encode()))
                    xtest.XTestFakeKeyEvent(display, key, 1, 0)
                    xtest.XTestFakeKeyEvent(display, key, 0, 0)
                if operation == 'chord':
                    keys = [x11.XKeysymToKeycode(display, x11.XStringToKeysym(key.encode())) for key in command[1]]
                    for key in keys:
                        xtest.XTestFakeKeyEvent(display, key, 1, 0)
                    for key in reversed(keys):
                        xtest.XTestFakeKeyEvent(display, key, 0, 0)
                x11.XFlush(display)
                GLib.timeout_add(200, advance)
        except StopIteration:
            finish()
        except Exception as exception:
            finish(exception)
        return False

    try:
        window.show_all()
        browser.load_uri(f'http://127.0.0.1:{server.server_port}/')
        GLib.timeout_add(500, advance)
        GLib.timeout_add_seconds(60, lambda: finish('Timed out'))
        Gtk.main()
    finally:
        window.destroy()
        x11.XCloseDisplay(display)
        server.shutdown()
        server.server_close()
    print(json.dumps(report, indent=2))
    return 0 if report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
