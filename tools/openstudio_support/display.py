"""Display adaptation for the explicitly opened companion, never the DAW."""
import sys


def install_dpi_scaling(root):
    """Tk 8.6 needs its fonts refreshed when a PMv2 window changes monitors."""
    if sys.platform != 'win32':
        return None
    import ctypes
    from tkinter import font
    api = ctypes.windll.user32.GetDpiForWindow
    api.argtypes = [ctypes.c_void_p]
    api.restype = ctypes.c_uint
    fonts = [(font.nametofont(name, root=root), int(root.tk.call('font', 'configure', name, '-size')))
             for name in font.names(root)]
    current = 0

    def apply(dpi):
        nonlocal current
        if dpi <= 0 or dpi == current:
            return
        initial = current == 0
        current = dpi
        root.tk.call('tk', 'scaling', dpi / 72)
        # Use explicit pixel sizes; Tk otherwise retains cached point metrics.
        for item, size in fonts:
            pixels = size * dpi / 72 if size > 0 else -size * dpi / 96
            item.configure(size=-max(1, round(pixels)))
        if initial:
            scale = dpi / 96
            width = min(round(820 * scale), round(root.winfo_screenwidth() * .9))
            height = min(round(720 * scale), round(root.winfo_screenheight() * .85))
            root.minsize(min(round(480 * scale), width), min(round(360 * scale), height))
            root.geometry(f'{width}x{height}')

    def moved(event):
        if event.widget is root:
            apply(api(root.winfo_id()))

    root.bind('<Configure>', moved, add='+')
    apply(api(root.winfo_id()))
    return apply


def scrollable_content(root):
    """Keep every operation reachable on a small or highly scaled display."""
    import tkinter as tk
    from tkinter import ttk
    host = ttk.Frame(root)
    host.pack(fill='both', expand=True)
    host.rowconfigure(0, weight=1)
    host.columnconfigure(0, weight=1)
    canvas = tk.Canvas(host, highlightthickness=0)
    canvas.grid(row=0, column=0, sticky='nsew')
    vertical = ttk.Scrollbar(host, orient='vertical', command=canvas.yview)
    vertical.grid(row=0, column=1, sticky='ns')
    horizontal = ttk.Scrollbar(host, orient='horizontal', command=canvas.xview)
    horizontal.grid(row=1, column=0, sticky='ew')
    canvas.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
    frame = ttk.Frame(canvas, padding=18)
    window = canvas.create_window(0, 0, anchor='nw', window=frame)

    def layout(_event=None):
        canvas.itemconfigure(window, width=max(canvas.winfo_width(), frame.winfo_reqwidth()),
                             height=max(canvas.winfo_height(), frame.winfo_reqheight()))
        canvas.configure(scrollregion=canvas.bbox(window))

    frame.bind('<Configure>', layout)
    canvas.bind('<Configure>', layout)

    def reveal_focus(event):
        widget = event.widget
        if not str(widget).startswith(str(frame) + '.'):
            return
        # Tab navigation must reveal off-screen controls as well as focus them.
        left = widget.winfo_rootx() - frame.winfo_rootx()
        top = widget.winfo_rooty() - frame.winfo_rooty()
        for axis, start, size, extent, visible in (
            ('x', left, widget.winfo_width(), frame.winfo_width(), canvas.winfo_width()),
            ('y', top, widget.winfo_height(), frame.winfo_height(), canvas.winfo_height()),
        ):
            position = getattr(canvas, axis + 'view')()[0] * extent
            if start < position:
                getattr(canvas, axis + 'view_moveto')(max(0, start - 8) / max(1, extent))
            elif start + size > position + visible:
                getattr(canvas, axis + 'view_moveto')((start + size + 8 - visible) / max(1, extent))

    root.bind('<FocusIn>', reveal_focus, add='+')
    return frame
