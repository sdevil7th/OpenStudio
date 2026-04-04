#!/usr/bin/env python3
"""
OpenStudio AI Tools installer.

For release builds, this script copies a bundled Python runtime seed into the
user runtime directory, verifies that audio-separator can be imported, and
downloads the required BS-RoFormer model into the user's model cache.

For dev or unbundled builds, it can fall back to bootstrapping a fresh virtual
environment from an external Python interpreter.

Progress is emitted as JSON lines on stdout so the native app can surface
friendly installer states inside the UI.
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

LOG_PATH: Path | None = None


def write_log(message: str) -> None:
    if LOG_PATH is None:
        return
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8", errors="replace") as handle:
        handle.write(message.rstrip() + "\n")


def emit(state: str, progress: float, **kwargs) -> None:
    payload = {"state": state, "progress": round(progress, 4)}
    payload.update(kwargs)
    if LOG_PATH is not None and "detailLogPath" not in payload:
        payload["detailLogPath"] = str(LOG_PATH)
    print(json.dumps(payload), flush=True)


def fail(
    message: str,
    *,
    state: str = "error",
    progress: float = 0.0,
    error_code: str = "unknown_error",
    **kwargs,
) -> None:
    emit(state, progress, error=message, errorCode=error_code, **kwargs)
    sys.exit(1)


def resolve_runtime_python(runtime_root: Path) -> Path:
    candidates = [
        runtime_root / "python.exe",
        runtime_root / "python",
        runtime_root / "Scripts" / "python.exe",
        runtime_root / "Scripts" / "python",
        runtime_root / "python3",
        runtime_root / "bin" / "python3",
        runtime_root / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    fail(
        f"Could not find a Python executable inside {runtime_root}.",
        error_code="runtime_verification_failed",
        installSource="bundledRuntime",
        requiresExternalPython=False,
    )
    raise AssertionError("unreachable")


def log_subprocess_output(result: subprocess.CompletedProcess[str], description: str) -> None:
    write_log(f"$ {description}")
    if result.stdout:
        write_log("[stdout]")
        write_log(result.stdout)
    if result.stderr:
        write_log("[stderr]")
        write_log(result.stderr)


def run_step(
    command: list[str],
    *,
    state: str,
    progress: float,
    description: str,
    install_source: str,
    requires_external_python: bool,
    error_code: str,
    python_detected: bool,
    cwd: Path | None = None,
) -> None:
    emit(
        state,
        progress,
        message=description,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
    )
    result = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    log_subprocess_output(result, " ".join(command))
    if result.returncode != 0:
        fail(
            f"{description} failed. See the install log for details.",
            progress=progress,
            error_code=error_code,
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
        )


def copy_seed_runtime(seed_runtime: Path, runtime_root: Path) -> None:
    if not seed_runtime.exists():
        fail(
            "OpenStudio could not find its bundled AI tools runtime.",
            error_code="runtime_seed_missing",
            installSource="bundledRuntime",
            requiresExternalPython=False,
        )

    emit(
        "copying_runtime",
        0.15,
        message="Copying the built-in AI tools runtime",
        installSource="bundledRuntime",
        requiresExternalPython=False,
        pythonDetected=False,
    )
    write_log(f"Copying bundled runtime from {seed_runtime} to {runtime_root}")
    try:
        if runtime_root.exists():
            shutil.rmtree(runtime_root)
        shutil.copytree(seed_runtime, runtime_root)
    except Exception as exc:  # pragma: no cover - defensive filesystem branch
        write_log(f"Runtime copy failed: {exc}")
        fail(
            "OpenStudio could not prepare the built-in AI tools runtime.",
            progress=0.15,
            error_code="runtime_copy_failed",
            installSource="bundledRuntime",
            requiresExternalPython=False,
        )


def verify_runtime(runtime_python: Path, *, install_source: str, requires_external_python: bool, python_detected: bool) -> None:
    run_step(
        [
            str(runtime_python),
            "-c",
            "import audio_separator.separator; print('ok')",
        ],
        state="verifying_runtime",
        progress=0.45,
        description="Verifying the AI tools runtime",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="runtime_verification_failed",
        python_detected=python_detected,
    )


def bootstrap_runtime(runtime_root: Path, bootstrap_python: Path) -> Path:
    install_source = "externalPython"
    requires_external_python = True
    python_detected = True

    if runtime_root.exists():
        shutil.rmtree(runtime_root)

    run_step(
        [str(bootstrap_python), "-m", "venv", str(runtime_root)],
        state="creating_venv",
        progress=0.2,
        description="Creating the AI tools environment",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
    )

    runtime_python = resolve_runtime_python(runtime_root)

    run_step(
        [str(runtime_python), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
        state="installing",
        progress=0.35,
        description="Upgrading Python packaging tools",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
    )

    run_step(
        [str(runtime_python), "-m", "pip", "install", REQUIREMENT_SPEC],
        state="installing",
        progress=0.65,
        description="Installing stem separation packages",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
    )

    return runtime_python


def download_model(runtime_python: Path, models_dir: Path, model_name: str, *, install_source: str, requires_external_python: bool, python_detected: bool) -> Path:
    emit(
        "downloading_model",
        0.8,
        message="Downloading the stem separation model",
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
    )
    model_bootstrap = (
        "from audio_separator.separator import Separator; "
        f"Separator(output_dir=r'{models_dir}', model_file_dir=r'{models_dir}').load_model(model_filename=r'{model_name}')"
    )
    run_step(
        [str(runtime_python), "-c", model_bootstrap],
        state="downloading_model",
        progress=0.9,
        description="Downloading the stem separation model",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="model_download_failed",
        python_detected=python_detected,
    )

    model_path = models_dir / model_name
    if not model_path.exists():
        fail(
            f"OpenStudio could not verify the downloaded stem model in {models_dir}.",
            progress=0.95,
            error_code="model_download_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
        )
    return model_path


def main() -> None:
    global LOG_PATH

    parser = argparse.ArgumentParser(description="Install OpenStudio AI tools")
    parser.add_argument("--runtime-root", required=True, help="Directory for the prepared AI runtime")
    parser.add_argument("--models-dir", required=True, help="Directory where stem-separation models should be stored")
    parser.add_argument("--model", default=DEFAULT_MODEL_NAME, help="Stem-separation model filename")
    parser.add_argument("--seed-runtime", help="Directory containing the bundled AI runtime seed")
    parser.add_argument("--bootstrap-with", help="Python executable to use for fallback bootstrapping")
    parser.add_argument("--log-path", help="Detailed installer log file path")
    args = parser.parse_args()

    runtime_root = Path(args.runtime_root).expanduser().resolve()
    models_dir = Path(args.models_dir).expanduser().resolve()
    seed_runtime = Path(args.seed_runtime).expanduser().resolve() if args.seed_runtime else None
    bootstrap_python = Path(args.bootstrap_with).expanduser().resolve() if args.bootstrap_with else None
    LOG_PATH = Path(args.log_path).expanduser().resolve() if args.log_path else None

    if LOG_PATH is not None:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOG_PATH.write_text("", encoding="utf-8")

    write_log(f"OpenStudio AI tools installer started on {platform.platform()}")
    write_log(f"sys.executable={sys.executable}")
    write_log(f"runtime_root={runtime_root}")
    write_log(f"models_dir={models_dir}")

    runtime_root.parent.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)

    if seed_runtime and seed_runtime.exists():
        install_source = "bundledRuntime"
        requires_external_python = False
        python_detected = False
        copy_seed_runtime(seed_runtime, runtime_root)
        runtime_python = resolve_runtime_python(runtime_root)
        verify_runtime(
            runtime_python,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
        )
    else:
        install_source = "externalPython"
        requires_external_python = True
        python_detected = bootstrap_python is not None and bootstrap_python.exists()

        if bootstrap_python is None or not bootstrap_python.exists():
            fail(
                "Python 3.10 or newer is required for this build before AI tools can be installed.",
                state="pythonMissing",
                error_code="python_missing",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=False,
            )

        if sys.version_info < (3, 10):
            fail(
                "Python 3.10 or newer is required for OpenStudio AI Tools.",
                state="pythonMissing",
                error_code="python_missing",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=True,
            )

        emit(
            "checking",
            0.05,
            message=f"Using Python {platform.python_version()}",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=True,
        )
        runtime_python = bootstrap_runtime(runtime_root, bootstrap_python)
        verify_runtime(
            runtime_python,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=True,
        )

    model_path = download_model(
        runtime_python,
        models_dir,
        args.model,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
    )

    emit(
        "ready",
        1.0,
        message="AI tools are ready.",
        runtimeRoot=str(runtime_root),
        modelsDir=str(models_dir),
        modelPath=str(model_path),
        runtimeInstalled=True,
        modelInstalled=True,
        available=True,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        fail("AI tools installation was cancelled.", state="cancelled", progress=0.0, error_code="cancelled")
