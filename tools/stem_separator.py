#!/usr/bin/env python3
"""
Studio13 Stem Separator — Python subprocess for BS-RoFormer source separation.

Called by C++ AudioEngine via juce::ChildProcess. Communicates progress via
JSON lines on stdout. Writes individual stem WAV files to the output directory.

Usage:
    python stem_separator.py --input audio.wav --output-dir ./stems
        [--model BS-Roformer-SW.ckpt] [--stems vocals,drums,bass,guitar,piano,other]
        [--gpu] [--sample-rate 44100]

Output (stdout JSON lines):
    {"state": "loading", "progress": 0.0}
    {"state": "analyzing", "progress": 0.35}
    {"state": "writing", "progress": 0.95}
    {"state": "done", "progress": 1.0, "stems": {"Vocals": "/path/to/vocals.wav", ...}}
    {"state": "error", "progress": 0.0, "error": "message"}
"""

import argparse
import json
import os
import sys
import traceback

def emit(state: str, progress: float = 0.0, **kwargs):
    """Print a JSON progress line to stdout for C++ to read."""
    msg = {"state": state, "progress": round(progress, 4)}
    msg.update(kwargs)
    print(json.dumps(msg), flush=True)

def install_tqdm_hook():
    """Monkey-patch tqdm so its progress updates emit JSON lines on stdout.
    audio-separator's demix() uses `from tqdm import tqdm`, so we must patch
    tqdm.std.tqdm (the real class) before audio-separator is imported.
    This ensures the `from tqdm import tqdm` in the separator module picks up
    our patched version."""
    try:
        import tqdm
        import tqdm.std
        _orig_tqdm = tqdm.std.tqdm

        class _ProgressTqdm(_orig_tqdm):
            def __init__(self, *args, **kwargs):
                # Redirect tqdm output to devnull to suppress stderr progress bar,
                # but keep all internal state intact (disable=True skips attribute init)
                kwargs['file'] = open(os.devnull, 'w')
                super().__init__(*args, **kwargs)

            def update(self, n=1):
                super().update(n)
                if self.total and self.total > 0:
                    frac = self.n / self.total
                    # Map tqdm 0..1 to our progress range 0.2..0.9
                    mapped = 0.2 + frac * 0.7
                    emit("analyzing", mapped)

        # Patch everywhere tqdm.tqdm is referenced
        tqdm.std.tqdm = _ProgressTqdm
        tqdm.tqdm = _ProgressTqdm
    except ImportError:
        pass  # tqdm not installed — progress will jump from 0.2 to 0.9

def find_model_file(model_name: str, models_dir: str) -> str:
    """Find model filename — returns just the name (not full path).
    audio-separator uses model_file_dir to locate files, and needs the
    filename to match its internal registry for architecture lookup."""
    local_path = os.path.join(models_dir, model_name)
    if os.path.isfile(local_path):
        return model_name
    # Check without extension variations
    for ext in ['.ckpt', '.pth', '.onnx']:
        if os.path.isfile(os.path.join(models_dir, model_name + ext)):
            return model_name + ext
    # Return the name as-is — audio-separator will try to download it
    return model_name

def main():
    parser = argparse.ArgumentParser(description="Studio13 Stem Separator")
    parser.add_argument("--input", required=True, help="Input audio file path")
    parser.add_argument("--output-dir", required=True, help="Output directory for stem WAV files")
    parser.add_argument("--model", default="BS-Roformer-SW.ckpt",
                        help="Model filename or path (default: BS-Roformer-SW.ckpt)")
    parser.add_argument("--models-dir", default="",
                        help="Directory containing model files")
    parser.add_argument("--stems", default="vocals,drums,bass,guitar,piano,other",
                        help="Comma-separated list of stems to extract")
    parser.add_argument("--gpu", action="store_true", help="Use GPU acceleration (CUDA on Windows/Linux, MPS on macOS)")
    parser.add_argument("--sample-rate", type=int, default=44100,
                        help="Output sample rate (default: 44100)")
    args = parser.parse_args()

    # Validate input
    if not os.path.isfile(args.input):
        emit("error", error=f"Input file not found: {args.input}")
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)
    requested_stems = [s.strip().capitalize() for s in args.stems.split(",")]

    # Ensure bundled ffmpeg is on PATH (audio-separator requires it)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # Dev build: tools/ is next to stem_separator.py
    if os.path.isfile(os.path.join(script_dir, "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")):
        os.environ["PATH"] = script_dir + os.pathsep + os.environ.get("PATH", "")
    # Installed build: scripts/ dir, ffmpeg next to it or in parent
    else:
        parent_dir = os.path.dirname(script_dir)
        for candidate in [parent_dir, os.path.join(parent_dir, "tools")]:
            ffname = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
            if os.path.isfile(os.path.join(candidate, ffname)):
                os.environ["PATH"] = candidate + os.pathsep + os.environ.get("PATH", "")
                break

    emit("loading", 0.0)

    # Hook tqdm before audio-separator imports it, so demix() progress is captured
    install_tqdm_hook()

    try:
        from audio_separator.separator import Separator
    except ImportError:
        emit("error", error="audio-separator package not installed. Run: pip install audio-separator[gpu]")
        sys.exit(1)

    try:
        # Resolve model path
        model_file = args.model
        if args.models_dir:
            model_file = find_model_file(args.model, args.models_dir)

        # Initialize separator (GPU auto-detected via PyTorch/ONNX Runtime)
        separator = Separator(
            output_dir=args.output_dir,
            output_format="WAV",
            output_single_stem=None,
            # Store downloaded models in our models dir
            model_file_dir=args.models_dir if args.models_dir else None,
        )

        emit("loading", 0.1)

        # Load model
        separator.load_model(model_filename=model_file)
        emit("loading", 0.2)

        # Run separation
        emit("analyzing", 0.2)

        # The separate() method returns a list of output file paths
        output_files = separator.separate(args.input)

        emit("writing", 0.9)

        # Map output files to stem names
        # audio-separator names files like: input_(Vocals).wav, input_(Drums).wav, etc.
        # We need to map them to our expected stem names
        stem_map = {}
        stem_names_lower = {s.lower(): s for s in requested_stems}

        # Aliases for stem name matching (audio-separator output names vary by model)
        stem_aliases = {
            "vocals": ["vocals", "vocal", "voice", "singing"],
            "drums": ["drums", "drum", "percussion"],
            "bass": ["bass"],
            "guitar": ["guitar", "guitars"],
            "piano": ["piano", "keys", "keyboard"],
            "other": ["other", "instrumental", "residual", "remainder", "no_"],
        }

        for fpath in output_files:
            # Resolve relative paths against output_dir
            if not os.path.isabs(fpath):
                fpath = os.path.join(args.output_dir, fpath)
            # Skip files that weren't written (e.g. near-silent stems)
            if not os.path.isfile(fpath):
                continue
            fname = os.path.basename(fpath).lower()
            matched = False
            for stem_key, stem_name in stem_names_lower.items():
                aliases = stem_aliases.get(stem_key, [stem_key])
                if any(alias in fname for alias in aliases):
                    clean_name = f"{stem_name}.wav"
                    clean_path = os.path.join(args.output_dir, clean_name)
                    if os.path.abspath(fpath) != os.path.abspath(clean_path):
                        if os.path.exists(clean_path):
                            os.remove(clean_path)
                        os.rename(fpath, clean_path)
                    stem_map[stem_name] = clean_path
                    matched = True
                    break
            # If no match and we haven't mapped "Other" yet, assign unmatched files to "Other"
            if not matched and "Other" in stem_names_lower.values() and "Other" not in stem_map:
                clean_name = "Other.wav"
                clean_path = os.path.join(args.output_dir, clean_name)
                if os.path.abspath(fpath) != os.path.abspath(clean_path):
                    if os.path.exists(clean_path):
                        os.remove(clean_path)
                    os.rename(fpath, clean_path)
                stem_map["Other"] = clean_path

        # Remove stems the user didn't request
        final_stems = {}
        for stem_name in requested_stems:
            if stem_name in stem_map:
                final_stems[stem_name] = stem_map[stem_name]

        if not final_stems:
            # Fallback: return all output files as-is if mapping failed
            emit("error", error=f"Could not map output files to stems. Files: {output_files}")
            sys.exit(1)

        emit("done", 1.0, stems=final_stems)

    except Exception as e:
        emit("error", error=f"{type(e).__name__}: {str(e)}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
