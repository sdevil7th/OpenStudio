"""Optional standalone Tk interface. Never linked to or started by OpenStudio."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path


def create_window(root):
    import tkinter as tk
    from tkinter import filedialog, font, messagebox, ttk
    from .cli import parser, run
    from .display import install_dpi_scaling, scrollable_content

    root.title("OpenStudio — Offline support")
    root.minsize(480, 360)
    root.geometry("820x720")
    frame = scrollable_content(root)
    frame.columnconfigure(1, weight=1)
    heading_font = font.Font(root, name='SupportHeading', family='Segoe UI', size=17, weight='bold')
    root._support_heading_font = heading_font
    ttk.Label(frame, text="Offline support", font=heading_font).grid(row=0, column=0, columnspan=3, sticky="w")
    ttk.Label(frame, text="Close OpenStudio first. Close this support window before reopening the DAW.\nNo uploads, live telemetry, or changes to your media and projects.", wraplength=680).grid(row=1, column=0, columnspan=3, sticky="w", pady=(8, 14))
    choices = {"Collect existing evidence": "collect", "Inspect audio export": "audio",
               "Inspect MIDI export": "midi", "Create reviewed ZIP": "bundle"}
    operation = tk.StringVar(value=next(iter(choices)))
    ttk.Label(frame, text="Operation").grid(row=2, column=0, sticky="w")
    combo = ttk.Combobox(frame, textvariable=operation, values=list(choices), state="readonly")
    combo.grid(row=2, column=1, columnspan=2, sticky="ew", pady=5)
    variables = {key: tk.StringVar() for key in ("input", "context", "output", "description", "clips")}
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    variables["output"].set(str(Path.home() / "OpenStudio-support" / stamp))
    labels, fields, operation_controls = {}, {}, {}
    controls = [combo]
    for index, (key, label) in enumerate((("input", "Log folder (optional)"), ("context", "Render report (optional)"),
                                         ("output", "New review folder"), ("description", "What happened?"),
                                         ("clips", "MIDI clip IDs (optional)")), start=3):
        labels[key] = ttk.Label(frame, text=label)
        labels[key].grid(row=index, column=0, sticky="w", padx=(0, 12))
        fields[key] = [labels[key]]
        entry = ttk.Entry(frame, textvariable=variables[key])
        entry.grid(row=index, column=1, columnspan=1 if key in {"input", "context", "output"} else 2, sticky="ew", pady=5)
        controls.append(entry)
        fields[key].append(entry)
        if key in {"input", "context", "output"}:
            def browse(which=key):
                action = choices[operation.get()]
                if which == "output":
                    if action == "bundle":
                        value = filedialog.asksaveasfilename(title="New support ZIP", defaultextension=".zip")
                    else:
                        parent = filedialog.askdirectory(title="Parent folder for a NEW review folder")
                        value = str(Path(parent) / datetime.now().strftime("support-%Y%m%d-%H%M%S")) if parent else ""
                elif which == "input" and action in {"collect", "bundle"}:
                    value = filedialog.askdirectory(title="Evidence folder")
                else:
                    value = filedialog.askopenfilename(title="Choose existing file")
                if value:
                    variables[which].set(value)
            button = ttk.Button(frame, text="Browse…", command=browse)
            button.grid(row=index, column=2, padx=(8, 0))
            controls.append(button)
            fields[key].append(button)
    dumps, reviewed = tk.BooleanVar(), tk.BooleanVar()
    for row, variable, label in ((8, dumps, "Include unredacted crash dumps (can contain private memory and credentials)"),
                                 (9, reviewed, "I reviewed every file in the report folder before creating this ZIP")):
        control = ttk.Checkbutton(frame, text=label, variable=variable)
        control.grid(row=row, column=0, columnspan=3, sticky="w", pady=5)
        controls.append(control)
        operation_controls[row] = control
    ttk.Label(frame, text="Redaction is best effort. Review the report folder before creating a ZIP.\nAttach the ZIP to your support request yourself; nothing is sent automatically.", wraplength=680).grid(row=10, column=0, columnspan=3, sticky="w", pady=8)
    display = tk.Text(frame, height=12, wrap="word", state="disabled")
    display.grid(row=12, column=0, columnspan=3, sticky="nsew", pady=(12, 0))
    frame.rowconfigure(12, weight=1)
    executor = ThreadPoolExecutor(max_workers=1)
    state = {"future": None, "lastReview": None, "lastOutput": None}

    def show(text):
        display.configure(state="normal")
        display.delete("1.0", "end")
        display.insert("end", text)
        display.configure(state="disabled")

    def selected(_event=None):
        action = choices[operation.get()]
        labels["input"].configure(text="Log folder (optional)" if action == "collect" else "Review folder" if action == "bundle" else "Exported file")
        labels["context"].configure(text="Saved project (optional)" if action == "midi" else "Render report (optional)")
        labels["output"].configure(text="New ZIP file" if action == "bundle" else "New review folder")
        if action == "bundle" and state["lastReview"]:
            variables["input"].set(state["lastReview"])
            variables["output"].set(state["lastReview"] + ".zip")
        elif action != "bundle":
            variables["output"].set(str(Path.home() / 'OpenStudio-support' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')))
        dumps.set(False)
        reviewed.set(False)
        for key, widgets in fields.items():
            visible = (key not in {'description', 'clips', 'context'} or
                       key == 'description' and action == 'collect' or
                       key == 'clips' and action == 'midi' or
                       key == 'context' and action != 'bundle')
            for widget in widgets:
                widget.grid() if visible else widget.grid_remove()
        for row, visible in ((8, action == 'collect'), (9, action == 'bundle')):
            operation_controls[row].grid() if visible else operation_controls[row].grid_remove()

    def poll():
        future = state["future"]
        if not future.done():
            root.after(100, poll)
            return
        try:
            _code, message = future.result()
            show(message + "\nOutput: " + variables["output"].get())
            state["lastOutput"] = variables["output"].get()
            if choices[operation.get()] != "bundle":
                state["lastReview"] = variables["output"].get()
        except Exception as exc:
            show("Could not complete: " + str(exc))
        state["future"] = None
        for control in controls:
            control.configure(state="readonly" if control is combo else "normal")

    def start():
        action = choices[operation.get()]
        input_value, context = variables["input"].get().strip(), variables["context"].get().strip()
        output = variables["output"].get().strip()
        if not output or (action != "collect" and not input_value):
            messagebox.showerror("Missing path", "Choose the input and a new output location.")
            return
        args = [action]
        if action != "collect":
            args.append(input_value)
        elif input_value:
            args += ["--log-dir", input_value]
        if context and action in {"audio", "collect", "midi"}:
            args += ["--project" if action == "midi" else "--route-report", context]
        if action == "collect":
            args += ["--description", variables["description"].get()]
            if dumps.get():
                args.append("--include-dumps")
        if action == "midi":
            for clip in variables["clips"].get().split(","):
                if clip.strip():
                    args += ["--clip-id", clip.strip()]
        if action == "bundle" and reviewed.get():
            args.append("--reviewed")
        args += ["--output", output]
        parsed = parser().parse_args(args)
        for control in controls:
            control.configure(state="disabled")
        show("Working offline. Keep OpenStudio closed until this operation finishes.")
        state["future"] = executor.submit(run, parsed)
        root.after(100, poll)

    button = ttk.Button(frame, text="Run selected operation", command=start)
    button.grid(row=11, column=0, columnspan=3, sticky="w")
    controls.append(button)
    def open_output():
        import os
        import subprocess
        import sys
        if not state['lastOutput']:
            messagebox.showinfo('No report yet', 'Run an operation first, then open its output folder here.')
            return
        path = Path(state['lastOutput']).absolute()
        if not path.is_dir():
            path = path.parent
        try:
            if sys.platform == 'win32':
                os.startfile(path)
            else:
                subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', str(path)])
        except OSError as exc:
            messagebox.showerror('Could not open folder', str(exc))
    folder_button = ttk.Button(frame, text='Open output folder', command=open_output)
    folder_button.grid(row=11, column=1, columnspan=2, sticky='e')
    controls.append(folder_button)
    combo.bind("<<ComboboxSelected>>", selected)
    selected()

    def close():
        if state["future"] is not None:
            messagebox.showinfo("Operation running", "Wait for inspection to finish before closing or reopening OpenStudio.")
            return
        executor.shutdown(wait=True)
        root.destroy()
    root.protocol("WM_DELETE_WINDOW", close)
    root._support_apply_dpi = install_dpi_scaling(root)
    return close


def launch():
    import tkinter as tk
    root = tk.Tk()
    create_window(root)
    root.mainloop()
