#!/usr/bin/env python3
"""
OpenStudio AI Tools installer.

Release builds prepare the AI runtime outside this script by downloading a
versioned OpenStudio-managed runtime archive, verifying it, and extracting it
into the user's OpenStudio data directory. This helper then verifies the
prepared runtime and downloads the required model.

Dev or intentionally unbundled builds may still bootstrap a fresh runtime from
an external Python interpreter.
"""

from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime, timezone
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from ai_runtime_probe import probe_runtime_capabilities

DEFAULT_MODEL_NAME = "BS-Roformer-SW.ckpt"
FALLBACK_MIN_PYTHON = (3, 10)
FALLBACK_MAX_PYTHON_EXCLUSIVE = (3, 14)

LOG_PATH: Path | None = None
SESSION_ID = ""
RUNTIME_CANDIDATE = ""
FALLBACK_ATTEMPTED = False


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_log(message: str) -> None:
    if LOG_PATH is None:
        return
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8", errors="replace") as handle:
        handle.write(message.rstrip() + "\n")


def log_event(component: str, phase: str, event: str, **kwargs) -> None:
    payload = {
        "timestamp": utc_now_iso(),
        "component": component,
        "phase": phase,
        "event": event,
        "platform": platform.system().lower(),
        "sessionId": SESSION_ID,
        "runtimeCandidate": RUNTIME_CANDIDATE,
        "fallbackAttempted": FALLBACK_ATTEMPTED,
    }
    payload.update(kwargs)
    write_log(json.dumps(payload, ensure_ascii=True))


def emit(state: str, progress: float, **kwargs) -> None:
    payload = {"state": state, "progress": round(progress, 4)}
    if SESSION_ID:
        payload["sessionId"] = SESSION_ID
    if RUNTIME_CANDIDATE:
        payload["runtimeCandidate"] = RUNTIME_CANDIDATE
    payload["fallbackAttempted"] = FALLBACK_ATTEMPTED
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
        runtime_root / "python" / "python.exe",
        runtime_root / "python" / "python",
        runtime_root / "Scripts" / "python.exe",
        runtime_root / "Scripts" / "python",
        runtime_root / "python" / "bin" / "python3",
        runtime_root / "python" / "bin" / "python",
        runtime_root / "python3",
        runtime_root / "bin" / "python3",
        runtime_root / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate
    fail(
        f"Could not find a Python executable inside {runtime_root}.",
        error_code="runtime_validation_failed",
        installSource="downloadedRuntime",
        requiresExternalPython=False,
        buildRuntimeMode="downloaded-runtime",
    )
    raise AssertionError("unreachable")


def get_requirement_specifiers() -> list[str]:
    if platform.system() == "Windows":
        return ["audio-separator[dml]==0.41.1", "onnxruntime-gpu>=1.17"]
    return ["audio-separator[cpu]==0.41.1"]


def log_subprocess_output(result: subprocess.CompletedProcess[str], description: str) -> None:
    write_log(f"$ {description}")
    write_log(f"[exitCode] {result.returncode}")
    if result.stdout:
        write_log("[stdout]")
        write_log(result.stdout)
    if result.stderr:
        write_log("[stderr]")
        write_log(result.stderr)


def safe_resolve(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path


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
    build_runtime_mode: str,
    cwd: Path | None = None,
) -> None:
    log_event(
        "installer",
        state,
        "step_start",
        description=description,
        command=command,
        buildRuntimeMode=build_runtime_mode,
    )
    emit(
        state,
        progress,
        message=description,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
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
        log_event(
            "installer",
            state,
            "step_failed",
            description=description,
            exitCode=result.returncode,
            errorCode=error_code,
        )
        fail(
            f"{description} failed. See the install log for details.",
            progress=progress,
            error_code=error_code,
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )
    log_event(
        "installer",
        state,
        "step_succeeded",
        description=description,
        exitCode=result.returncode,
    )


def stream_step(
    command: list[str],
    *,
    state: str,
    progress: float,
    description: str,
    install_source: str,
    requires_external_python: bool,
    error_code: str,
    python_detected: bool,
    build_runtime_mode: str,
    cwd: Path | None = None,
) -> None:
    log_event(
        "installer",
        state,
        "step_start",
        description=description,
        command=command,
        buildRuntimeMode=build_runtime_mode,
    )
    emit(
        state,
        progress,
        message=description,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )
    write_log(f"$ {' '.join(command)}")
    recent_lines: deque[str] = deque(maxlen=12)

    with subprocess.Popen(
        command,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    ) as process:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if not line:
                continue
            recent_lines.append(line)
            write_log(line)
        return_code = process.wait()

    write_log(f"[exitCode] {return_code}")
    if return_code != 0:
        detail = " ".join(recent_lines).strip()
        log_event(
            "installer",
            state,
            "step_failed",
            description=description,
            exitCode=return_code,
            errorCode=error_code,
            lastOutput=detail,
        )
        fail(
            f"{description} failed. {detail if detail else 'See the install log for details.'}",
            progress=progress,
            error_code=error_code,
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )
    log_event(
        "installer",
        state,
        "step_succeeded",
        description=description,
        exitCode=return_code,
    )


def verify_runtime(
    runtime_python: Path,
    runtime_root: Path,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    if (runtime_root / "pyvenv.cfg").exists():
        fail(
            f"The extracted AI runtime at {runtime_root} still looks like a virtual environment and is not relocatable.",
            progress=0.6,
            error_code="runtime_not_relocatable",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    if not (runtime_root / ".openstudio-ai-runtime.json").exists():
        fail(
            f"The extracted AI runtime at {runtime_root} is missing OpenStudio runtime metadata.",
            progress=0.6,
            error_code="runtime_validation_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    resolved_runtime_python = safe_resolve(runtime_python)
    resolved_current_python = safe_resolve(Path(sys.executable))
    same_interpreter = resolved_runtime_python == resolved_current_python

    write_log(f"runtime_python={resolved_runtime_python}")
    write_log(f"current_python={resolved_current_python}")
    write_log(f"verificationMode={'in-process' if same_interpreter else 'subprocess'}")
    log_event(
        "installer",
        "verifying_runtime",
        "verification_start",
        runtimePython=str(resolved_runtime_python),
        currentPython=str(resolved_current_python),
        verificationMode="in-process" if same_interpreter else "subprocess",
    )

    emit(
        "verifying_runtime",
        0.65,
        message="Verifying the AI tools runtime",
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )

    verification_mode = "in-process" if same_interpreter else "subprocess"
    write_log(f"verificationMode={verification_mode}")

    if same_interpreter:
        try:
            import audio_separator.separator  # noqa: F401
        except Exception as exc:
            write_log(f"[in-process verification error] {type(exc).__name__}: {exc}")
            log_event(
                "installer",
                "verifying_runtime",
                "verification_failed",
                verificationMode="in-process",
                errorCode="runtime_validation_failed",
                exceptionType=type(exc).__name__,
                exceptionMessage=str(exc),
            )
            fail(
                f"Verifying the AI tools runtime failed: {type(exc).__name__}: {exc}",
                progress=0.65,
                error_code="runtime_validation_failed",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
            )

        write_log("[in-process verification] import audio_separator.separator succeeded")
        log_event(
            "installer",
            "verifying_runtime",
            "verification_succeeded",
            verificationMode="in-process",
        )
        return

    run_step(
        [str(runtime_python), "-c", "import audio_separator.separator; print('ok')"],
        state="verifying_runtime",
        progress=0.65,
        description="Verifying the AI tools runtime",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="runtime_validation_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=runtime_root,
    )


def probe_runtime(
    runtime_root: Path,
    models_dir: Path,
    model_name: str,
    *,
    acceleration_mode: str,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> dict[str, object]:
    log_event(
        "probe",
        "probing_runtime",
        "probe_start",
        accelerationMode=acceleration_mode,
        modelName=model_name,
    )
    emit(
        "probing_runtime",
        0.96,
        message="Checking AI runtime capabilities",
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )

    metadata_path = runtime_root / ".openstudio-ai-runtime.json"
    runtime_version = ""
    if metadata_path.exists():
        try:
            runtime_version = json.loads(metadata_path.read_text(encoding="utf-8")).get("runtimeVersion", "")
        except Exception:
            runtime_version = ""

    report = probe_runtime_capabilities(
        models_dir=str(models_dir),
        model_name=model_name,
        acceleration_mode=acceleration_mode,
    )
    report["runtimeVersion"] = runtime_version
    report["modelVersion"] = model_name

    write_log(f"supportedBackends={','.join(report.get('supportedBackends', []))}")
    write_log(f"selectedBackend={report.get('selectedBackend', 'cpu')}")
    if report.get("fallbackReason"):
        write_log(f"fallbackReason={report['fallbackReason']}")
    if report.get("backendDecisionTrace"):
        write_log(f"backendDecisionTrace={' | '.join(report['backendDecisionTrace'])}")

    if not report.get("runtimeReady"):
        log_event(
            "probe",
            "probing_runtime",
            "probe_failed",
            errorCode=report.get("errorCode", "runtime_validation_failed"),
            fallbackReason=report.get("fallbackReason", ""),
            supportedBackends=report.get("supportedBackends", []),
            selectedBackend=report.get("selectedBackend", "cpu"),
            probeDurationMs=report.get("probeDurationMs", 0),
        )
        fail(
            "OpenStudio could not validate the managed AI runtime on this machine.",
            progress=0.96,
            error_code="runtime_validation_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    log_event(
        "probe",
        "probing_runtime",
        "probe_succeeded",
        supportedBackends=report.get("supportedBackends", []),
        selectedBackend=report.get("selectedBackend", "cpu"),
        fallbackReason=report.get("fallbackReason", ""),
        probeDurationMs=report.get("probeDurationMs", 0),
    )
    return report


def bootstrap_runtime(runtime_root: Path, bootstrap_python: Path) -> Path:
    install_source = "externalPython"
    requires_external_python = True
    python_detected = True
    build_runtime_mode = "unbundled-dev"

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
        build_runtime_mode=build_runtime_mode,
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
        build_runtime_mode=build_runtime_mode,
    )

    run_step(
        [str(runtime_python), "-m", "pip", "install", *get_requirement_specifiers()],
        state="installing",
        progress=0.55,
        description="Installing stem separation packages",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    return runtime_python


def format_supported_python_range() -> str:
    return "Python 3.10 through 3.13"


def download_model(
    runtime_python: Path,
    models_dir: Path,
    model_name: str,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> Path:
    log_event(
        "installer",
        "downloading_model",
        "model_download_start",
        modelName=model_name,
    )
    emit(
        "downloading_model",
        0.82,
        message="Downloading the stem separation model",
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )
    if safe_resolve(runtime_python) == safe_resolve(Path(sys.executable)):
        try:
            from audio_separator.separator import Separator

            write_log("[in-process model download] starting")
            Separator(
                output_dir=str(models_dir),
                model_file_dir=str(models_dir),
                use_directml=(platform.system() == "Windows"),
            ).load_model(model_filename=model_name)
            write_log("[in-process model download] completed")
        except Exception as exc:
            write_log(f"[in-process model download error] {type(exc).__name__}: {exc}")
            log_event(
                "installer",
                "downloading_model",
                "model_download_failed",
                errorCode="model_download_failed",
                exceptionType=type(exc).__name__,
                exceptionMessage=str(exc),
            )
            fail(
                f"Downloading the stem separation model failed: {type(exc).__name__}: {exc}",
                progress=0.92,
                error_code="model_download_failed",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
            )
    else:
        model_bootstrap = (
            "from audio_separator.separator import Separator; "
            f"Separator(output_dir=r'{models_dir}', model_file_dir=r'{models_dir}', use_directml={platform.system() == 'Windows'}).load_model(model_filename=r'{model_name}')"
        )
        stream_step(
            [str(runtime_python), "-c", model_bootstrap],
            state="downloading_model",
            progress=0.92,
            description="Downloading the stem separation model",
            install_source=install_source,
            requires_external_python=requires_external_python,
            error_code="model_download_failed",
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )

    model_path = models_dir / model_name
    if not model_path.exists():
        log_event(
            "installer",
            "downloading_model",
            "model_download_failed",
            errorCode="model_download_failed",
            reason="model file missing after download",
            modelPath=str(model_path),
        )
        fail(
            f"OpenStudio could not verify the downloaded stem model in {models_dir}.",
            progress=0.95,
            error_code="model_download_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )
    log_event(
        "installer",
        "downloading_model",
        "model_download_succeeded",
        modelPath=str(model_path),
    )
    return model_path


def main() -> None:
    global LOG_PATH, SESSION_ID, RUNTIME_CANDIDATE, FALLBACK_ATTEMPTED

    parser = argparse.ArgumentParser(description="Install OpenStudio AI tools")
    parser.add_argument("--runtime-root", required=True, help="Directory for the prepared AI runtime")
    parser.add_argument("--models-dir", required=True, help="Directory where stem-separation models should be stored")
    parser.add_argument("--model", default=DEFAULT_MODEL_NAME, help="Stem-separation model filename")
    parser.add_argument("--bootstrap-with", help="Python executable to use for dev fallback bootstrapping")
    parser.add_argument("--verify-existing-runtime", action="store_true", help="Verify the already-prepared OpenStudio runtime and download the model")
    parser.add_argument("--log-path", help="Detailed installer log file path")
    parser.add_argument("--session-id", default="", help="Install session id for correlated logging")
    parser.add_argument("--runtime-candidate", default="", help="Selected runtime candidate identity")
    parser.add_argument("--fallback-attempted", action="store_true", help="True when this install is using a fallback runtime candidate")
    args = parser.parse_args()

    runtime_root = Path(args.runtime_root).expanduser().resolve()
    models_dir = Path(args.models_dir).expanduser().resolve()
    bootstrap_python = Path(args.bootstrap_with).expanduser().resolve() if args.bootstrap_with else None
    LOG_PATH = Path(args.log_path).expanduser().resolve() if args.log_path else None
    SESSION_ID = args.session_id
    RUNTIME_CANDIDATE = args.runtime_candidate
    FALLBACK_ATTEMPTED = bool(args.fallback_attempted)

    if LOG_PATH is not None:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOG_PATH.write_text("", encoding="utf-8")

    write_log(f"OpenStudio AI tools installer started on {platform.platform()}")
    write_log(f"sys.executable={sys.executable}")
    write_log(f"runtime_root={runtime_root}")
    write_log(f"models_dir={models_dir}")
    if SESSION_ID:
        write_log(f"sessionId={SESSION_ID}")
    if RUNTIME_CANDIDATE:
        write_log(f"runtimeCandidate={RUNTIME_CANDIDATE}")
    write_log(f"fallbackAttempted={FALLBACK_ATTEMPTED}")
    log_event(
        "installer",
        "startup",
        "installer_started",
        pythonExecutable=sys.executable,
        runtimeRoot=str(runtime_root),
        modelsDir=str(models_dir),
        verifyExistingRuntime=bool(args.verify_existing_runtime),
    )

    runtime_root.parent.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)

    if args.verify_existing_runtime:
        install_source = "downloadedRuntime"
        requires_external_python = False
        python_detected = False
        build_runtime_mode = "downloaded-runtime"
        runtime_python = resolve_runtime_python(runtime_root)
        verify_runtime(
            runtime_python,
            runtime_root,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
    else:
        install_source = "externalPython"
        requires_external_python = True
        python_detected = bootstrap_python is not None and bootstrap_python.exists()
        build_runtime_mode = "unbundled-dev"

        if bootstrap_python is None or not bootstrap_python.exists():
            fail(
                f"{format_supported_python_range()} is required for this dev build before AI tools can be installed.",
                state="pythonMissing",
                error_code="python_missing",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=False,
                buildRuntimeMode=build_runtime_mode,
            )

        if sys.version_info < FALLBACK_MIN_PYTHON or sys.version_info >= FALLBACK_MAX_PYTHON_EXCLUSIVE:
            fail(
                f"This dev fallback only supports {format_supported_python_range()}. Reinstall a proper release build or use a supported Python version.",
                state="pythonMissing",
                error_code="unsupported_python_version",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=True,
                buildRuntimeMode=build_runtime_mode,
            )

        emit(
            "checking",
            0.05,
            message=f"Using Python {platform.python_version()}",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=True,
            buildRuntimeMode=build_runtime_mode,
        )
        runtime_python = bootstrap_runtime(runtime_root, bootstrap_python)
        verify_runtime(
            runtime_python,
            runtime_root,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=True,
            build_runtime_mode=build_runtime_mode,
        )

    model_path = download_model(
        runtime_python,
        models_dir,
        args.model,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    runtime_probe = probe_runtime(
        runtime_root,
        models_dir,
        args.model,
        acceleration_mode="auto",
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
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
        buildRuntimeMode=build_runtime_mode,
        supportedBackends=runtime_probe.get("supportedBackends", []),
        selectedBackend=runtime_probe.get("selectedBackend", "cpu"),
        runtimeVersion=runtime_probe.get("runtimeVersion", ""),
        modelVersion=runtime_probe.get("modelVersion", args.model),
        verificationMode="in-process" if safe_resolve(runtime_python) == safe_resolve(Path(sys.executable)) else "subprocess",
        restartRequired=bool(runtime_probe.get("restartRequired", False)),
    )
    log_event(
        "installer",
        "ready",
        "installer_ready",
        runtimeVersion=runtime_probe.get("runtimeVersion", ""),
        modelVersion=runtime_probe.get("modelVersion", args.model),
        supportedBackends=runtime_probe.get("supportedBackends", []),
        selectedBackend=runtime_probe.get("selectedBackend", "cpu"),
        verificationMode="in-process" if safe_resolve(runtime_python) == safe_resolve(Path(sys.executable)) else "subprocess",
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        fail("AI tools installation was cancelled.", state="cancelled", progress=0.0, error_code="cancelled")
