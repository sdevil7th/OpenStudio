#!/usr/bin/env python3
"""
OpenStudio AI Tools installer.

Creates a per-user Python virtual environment for optional stem separation,
installs the CPU-only audio-separator dependency set, and downloads the
required BS-RoFormer model into the user's model cache.

Progress is emitted as JSON lines on stdout so the native app can surface
live install status inside the UI.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REQUIREMENT_SPEC = "audio-separator[cpu]==0.41.1"
DEFAULT_MODEL_NAME = "BS-Roformer-SW.ckpt"


def emit(state: str, progress: float, **kwargs) -> None:
    payload = {"state": state, "progress": round(progress, 4)}
    payload.update(kwargs)
    print(json.dumps(payload), flush=True)


def fail(message: str, *, state: str = "error", progress: float = 0.0) -> None:
    emit(state, progress, error=message)
    sys.exit(1)


def run_step(command: list[str], *, progress: float, description: str, cwd: Path | None = None) -> None:
    emit("installing", progress, message=description)
    result = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        detail = detail[-1200:] if detail else "Unknown installer failure."
        fail(f"{description} failed. {detail}", progress=progress)


def resolve_venv_python(runtime_root: Path) -> Path:
    candidates = [
        runtime_root / "Scripts" / "python.exe",
        runtime_root / "Scripts" / "python",
        runtime_root / "bin" / "python3",
        runtime_root / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    fail(f"Could not find the virtual environment Python inside {runtime_root}.")
    raise AssertionError("unreachable")


def main() -> None:
    parser = argparse.ArgumentParser(description="Install OpenStudio AI tools")
    parser.add_argument("--runtime-root", required=True, help="Directory for the per-user virtual environment")
    parser.add_argument("--models-dir", required=True, help="Directory where stem-separation models should be stored")
    parser.add_argument("--model", default=DEFAULT_MODEL_NAME, help="Stem-separation model filename")
    args = parser.parse_args()

    runtime_root = Path(args.runtime_root).expanduser().resolve()
    models_dir = Path(args.models_dir).expanduser().resolve()

    if sys.version_info < (3, 10):
        fail("Python 3.10 or newer is required for OpenStudio AI Tools.")

    emit("checking", 0.05, message=f"Using Python {platform.python_version()}")

    runtime_root.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)

    emit("creating_venv", 0.15, message="Creating AI tools environment")
    run_step([sys.executable, "-m", "venv", str(runtime_root)], progress=0.2, description="Creating Python virtual environment")

    venv_python = resolve_venv_python(runtime_root)

    run_step(
        [str(venv_python), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
        progress=0.35,
        description="Upgrading pip tooling",
    )

    run_step(
        [str(venv_python), "-m", "pip", "install", REQUIREMENT_SPEC],
        progress=0.65,
        description="Installing stem separation packages",
    )

    emit("installing", 0.8, message="Preparing stem model download")
    model_bootstrap = (
        "from audio_separator.separator import Separator; "
        f"Separator(output_dir=r'{models_dir}', model_file_dir=r'{models_dir}').load_model(model_filename=r'{args.model}')"
    )
    run_step(
        [str(venv_python), "-c", model_bootstrap],
        progress=0.9,
        description="Downloading stem separation model",
    )

    model_path = models_dir / args.model
    if not model_path.exists():
        fail(f"Model download finished, but {model_path.name} was not found in {models_dir}.", progress=0.95)

    emit(
        "ready",
        1.0,
        message="AI tools are ready.",
        runtimeRoot=str(runtime_root),
        modelsDir=str(models_dir),
        modelPath=str(model_path),
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        fail("AI tools installation was cancelled.", state="cancelled", progress=0.0)
