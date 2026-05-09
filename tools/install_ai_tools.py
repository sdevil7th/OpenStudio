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
import hashlib
import json
import math
import os
import platform
import re
import shlex
import socket
import shutil
import subprocess
import sys
import threading
import time
import wave
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from pathlib import Path
from typing import Any

from ai_runtime_probe import (
    DEFAULT_MUSIC_GEN_MODEL,
    DEFAULT_MUSIC_GEN_MODEL_REPO,
    DEFAULT_MUSIC_GEN_SHARED_REPO,
    REQUIRED_MUSIC_GEN_NATIVE_FILES,
    ASSISTANT_VERIFIED_STATUS_ENV,
    AUDIO_UNDERSTANDING_STATUS_ENV,
    find_local_comfy_native_assets,
    get_assistant_runtime_status,
    get_windows_cuda_pytorch_index_url,
    get_windows_cuda_pytorch_packages,
    get_windows_flash_attn_asset,
    get_windows_triton_package_spec,
    get_music_generation_required_paths,
    get_music_runtime_profiles,
    probe_runtime_capabilities,
    resolve_music_gen_checkpoint_root,
)

DEFAULT_MODEL_NAME = "BS-Roformer-SW.ckpt"
FALLBACK_MIN_PYTHON = (3, 10)
FALLBACK_MAX_PYTHON_EXCLUSIVE = (3, 13)
MUSIC_GEN_REQUIRED_PYTHON = (3, 11)
MUSIC_GEN_SPACE_REPO = "ACE-Step/Ace-Step-v1.5"
MUSIC_GEN_SPACE_REPO_TYPE = "space"
MUSIC_GEN_SOURCE_DIRNAME = "ace-step-v1.5-source"
MUSIC_GEN_HUB_CACHE_DIRNAME = ".hub-cache"
MODEL_DOWNLOAD_MANIFEST_URL = "https://raw.githubusercontent.com/TRvlvr/application_data/main/filelists/download_checks.json"
UVR_MODEL_REPO_URL_PREFIX = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models"
UVR_MODEL_CONFIG_URL_PREFIX = f"{UVR_MODEL_REPO_URL_PREFIX}/mdx_model_data/mdx_c_configs"
AUDIO_SEPARATOR_MODEL_REPO_URL_PREFIX = "https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs"
AUDIO_SEPARATOR_HF_REPO_URL_PREFIX = "https://huggingface.co/lainlives/audio-separator-models/resolve/main"
DOWNLOAD_CHUNK_SIZE = 1024 * 512
DOWNLOAD_TIMEOUT_SECONDS = 60
DOWNLOAD_HEARTBEAT_SECONDS = 5.0
MODEL_DOWNLOAD_PROGRESS_START = 0.82
MODEL_DOWNLOAD_PROGRESS_END = 0.95
ASSISTANT_MODELS_DIRNAME = "assistant"
ANALYZER_MODELS_DIRNAME = "audio-understanding"
ASSISTANT_LOCAL_RUNTIME_PACKAGES: tuple[str, ...] = (
    "huggingface_hub>=0.34,<1.0",
    "accelerate>=1.12,<2",
    "transformers==4.57.6",
    "soundfile>=0.12",
    "qwen-omni-utils>=0.0.4",
)
ANALYZER_LOCAL_RUNTIME_PACKAGES: tuple[str, ...] = (
    "huggingface_hub>=0.34,<1.0",
    "accelerate>=1.12,<2",
    "transformers==4.57.6",
    "soundfile>=0.12",
    "librosa>=0.10,<1",
)
ASSISTANT_AUTOAWQ_DEPENDENCY_PACKAGES: tuple[str, ...] = (
    "datasets>=2.20,<4",
    "zstandard>=0.22",
)
ASSISTANT_AUTOAWQ_PACKAGE = "autoawq==0.2.9"
ASSISTANT_WINDOWS_FLASH_ATTN_ENV = "OPENSTUDIO_ASSISTANT_SKIP_FLASH_ATTN"
ASSISTANT_TORCH_PACKAGES_BY_PLATFORM: dict[str, tuple[str, ...]] = {
    "windows": (
        "torch==2.8.0",
        "torchvision==0.23.0",
        "torchaudio==2.8.0",
    ),
    "linux": (
        "torch==2.5.1",
        "torchvision==0.20.1",
        "torchaudio==2.5.1",
    ),
    "darwin": (
        "torch",
        "torchvision",
        "torchaudio",
    ),
}
ASSISTANT_TORCH_INDEX_BY_PLATFORM: dict[str, str] = {
    "windows": "windows-acceleration-manifest",
    "linux": "https://download.pytorch.org/whl/cu121",
    "darwin": "",
}
ASSISTANT_LINUX_ACCELERATION_PACKAGES: tuple[str, ...] = (
    "triton",
    "flash-attn",
)
ACE15_COMFY_TEXT_ENCODER_FILENAMES: dict[str, str] = {
    "acestep-5Hz-lm-0.6B": "qwen_0.6b_ace15.safetensors",
    "acestep-5Hz-lm-1.7B": "qwen_1.7b_ace15.safetensors",
    "acestep-5Hz-lm-4B": "qwen_4b_ace15.safetensors",
}
ACE15_MANAGED_LM_CONFIG_OVERRIDES: dict[str, dict[str, Any]] = {
    "acestep-5Hz-lm-0.6B": {
        "hidden_size": 1024,
        "intermediate_size": 3072,
        "num_hidden_layers": 28,
        "num_attention_heads": 16,
        "num_key_value_heads": 8,
        "max_position_embeddings": 32768,
        "max_window_layers": 28,
        "vocab_size": 151669,
        "architectures": ["Qwen3Model"],
        "model_type": "qwen3",
    },
    "acestep-5Hz-lm-1.7B": {
        "hidden_size": 2048,
        "intermediate_size": 6144,
        "num_hidden_layers": 28,
        "num_attention_heads": 16,
        "num_key_value_heads": 8,
        "max_position_embeddings": 40960,
        "max_window_layers": 28,
        "vocab_size": 217204,
        "architectures": ["Qwen3Model"],
        "model_type": "qwen3",
    },
    "acestep-5Hz-lm-4B": {
        "hidden_size": 2560,
        "intermediate_size": 9728,
        "num_hidden_layers": 36,
        "num_attention_heads": 32,
        "num_key_value_heads": 8,
        "max_position_embeddings": 40960,
        "max_window_layers": 36,
        "vocab_size": 217204,
        "architectures": ["Qwen3Model"],
        "model_type": "qwen3",
    },
}
ACE15_MANAGED_LM_SHARED_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "added_tokens.json",
    "chat_template.jinja",
)
WINDOWS_REUSED_RUNTIME_REPAIR_PACKAGES = (
    "audio-separator==0.41.1",
    "requests>=2",
    "certifi>=2023.5.7",
    "charset_normalizer<4,>=2",
    "idna<4,>=2.5",
    "urllib3<3,>=1.26",
)

LOG_PATH: Path | None = None
SESSION_ID = ""
RUNTIME_CANDIDATE = ""
FALLBACK_ATTEMPTED = False
START_TIME_MONOTONIC = time.monotonic()


class InstallerStepError(Exception):
    def __init__(self, message: str, *, error_code: str, progress: float) -> None:
        super().__init__(message)
        self.message = message
        self.error_code = error_code
        self.progress = progress


class ModelDownloadError(Exception):
    def __init__(self, message: str, *, error_code: str) -> None:
        super().__init__(message)
        self.message = message
        self.error_code = error_code


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
    payload.setdefault("lastPhase", state)
    payload.setdefault("elapsedMs", int((time.monotonic() - START_TIME_MONOTONIC) * 1000))
    if LOG_PATH is not None and "detailLogPath" not in payload:
        payload["detailLogPath"] = str(LOG_PATH)
    serialized = json.dumps(payload)
    write_log(serialized)
    # When OpenStudio launches this installer it tails the install log directly
    # and does not drain the child process stdout pipe. Continuing to print every
    # structured progress update would eventually block the installer once the
    # pipe buffer fills, which is exactly what can happen during large model
    # downloads. Keep stdout for standalone/debug runs that do not provide a
    # log path, and allow forcing stdout explicitly for troubleshooting.
    should_print_stdout = LOG_PATH is None or os.environ.get("OPENSTUDIO_INSTALLER_FORCE_STDOUT") == "1"
    if should_print_stdout:
        try:
            print(serialized, flush=True)
        except (BrokenPipeError, OSError):
            pass


def fail(
    message: str,
    *,
    state: str = "error",
    progress: float = 0.0,
    error_code: str = "unknown_error",
    **kwargs,
) -> None:
    emit(state, progress, error=message, errorCode=error_code, terminalReason=error_code, **kwargs)
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


def _detect_linux_gpu_backend() -> str:
    """Detect available GPU backend on Linux. Returns 'cuda', 'rocm', or 'cpu'."""
    # NVIDIA: nvidia-smi exits 0 when a GPU is present and the driver is loaded
    try:
        result = subprocess.run(
            ["nvidia-smi"], capture_output=True, timeout=5
        )
        if result.returncode == 0:
            return "cuda"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    # AMD ROCm: rocm-smi exits 0 when ROCm-compatible hardware is present
    try:
        result = subprocess.run(
            ["rocm-smi"], capture_output=True, timeout=5
        )
        if result.returncode == 0:
            return "rocm"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return "cpu"


def read_python_version_info(python_executable: Path) -> tuple[int, int, int] | None:
    try:
        result = subprocess.run(
            [
                str(python_executable),
                "-c",
                "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}')",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if result.returncode != 0:
        return None

    version_text = result.stdout.strip()
    parts = version_text.split(".")
    if len(parts) != 3:
        return None

    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def format_python_version(version: tuple[int, int, int] | None) -> str:
    if version is None:
        return "unknown"
    return ".".join(str(part) for part in version)


def is_music_generation_python_compatible(version: tuple[int, int, int] | None) -> bool:
    return version is not None and version[:2] == MUSIC_GEN_REQUIRED_PYTHON


def find_windows_python_311() -> Path | None:
    if platform.system() != "Windows":
        return None

    py_launcher = shutil.which("py")
    if not py_launcher:
        return None

    try:
        result = subprocess.run(
            [
                py_launcher,
                "-3.11",
                "-c",
                "import sys; print(sys.executable)",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if result.returncode != 0:
        return None

    candidate = Path(result.stdout.strip()).expanduser()
    if candidate.exists():
        return candidate.resolve()
    return None


def is_windows_nvidia_machine() -> bool:
    if platform.system() != "Windows":
        return False

    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError, subprocess.SubprocessError):
        return False

    return result.returncode == 0 and bool(result.stdout.strip())


def terminate_windows_runtime_lock_holders(runtime_root: Path) -> list[str]:
    if platform.system() != "Windows":
        return []

    resolved_runtime_root = safe_resolve(runtime_root)
    runtime_python = safe_resolve(runtime_root / "Scripts" / "python.exe")
    runtime_root_text = str(resolved_runtime_root).replace("\\", "\\\\").replace("'", "''")
    runtime_python_text = str(runtime_python).replace("\\", "\\\\").replace("'", "''")
    powershell_script = f"""
$runtimeRoot = [System.IO.Path]::GetFullPath('{runtime_root_text}')
$runtimePython = [System.IO.Path]::GetFullPath('{runtime_python_text}')
Get-CimInstance Win32_Process | ForEach-Object {{
    $exe = $_.ExecutablePath
    $cmd = $_.CommandLine
    $matchesRuntime = $false

    if ($exe) {{
        try {{
            $resolvedExe = [System.IO.Path]::GetFullPath($exe)
            if ($resolvedExe -ieq $runtimePython -or $resolvedExe.StartsWith($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {{
                $matchesRuntime = $true
            }}
        }} catch {{
        }}
    }}

    if (-not $matchesRuntime -and $cmd) {{
        if (
            $cmd.IndexOf('generate_music.py --worker', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            -or $cmd.IndexOf($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        ) {{
            $matchesRuntime = $true
        }}
    }}

    if ($matchesRuntime) {{
        [PSCustomObject]@{{
            ProcessId = $_.ProcessId
            Name = $_.Name
        }}
    }}
}} | ConvertTo-Json -Compress
"""

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", powershell_script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return []

    if result.returncode != 0:
        return []

    stdout = (result.stdout or "").strip()
    if not stdout:
        return []

    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError:
        return []

    if isinstance(parsed, dict):
        process_rows = [parsed]
    elif isinstance(parsed, list):
        process_rows = [row for row in parsed if isinstance(row, dict)]
    else:
        return []

    killed: list[str] = []
    for row in process_rows:
        pid = row.get("ProcessId")
        name = str(row.get("Name", "")).strip() or "process"
        try:
            pid_int = int(pid)
        except (TypeError, ValueError):
            continue

        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid_int), "/F", "/T"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                check=False,
            )
            killed.append(f"{pid_int}:{name}")
        except (OSError, subprocess.SubprocessError):
            continue

    return killed


def _handle_remove_readonly(func: Any, path: str, exc_info: Any) -> None:
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    func(path)


def remove_tree_with_retries(target: Path, *, retries: int = 3, retry_delay_seconds: float = 1.0) -> list[str]:
    terminated_processes: list[str] = []
    if not target.exists():
        return terminated_processes

    if platform.system() == "Windows":
        terminated_processes.extend(terminate_windows_runtime_lock_holders(target))
        if terminated_processes:
            time.sleep(retry_delay_seconds)

    last_error: OSError | None = None
    for attempt in range(1, retries + 1):
        try:
            shutil.rmtree(target, onerror=_handle_remove_readonly)
            return terminated_processes
        except OSError as exc:
            last_error = exc
            if platform.system() == "Windows":
                terminated_processes.extend(terminate_windows_runtime_lock_holders(target))
                if attempt < retries:
                    time.sleep(retry_delay_seconds)
                    continue
            raise

    if last_error is not None:
        raise last_error
    return terminated_processes


def get_candidate_comfy_text_encoder_dirs() -> list[Path]:
    candidates: list[Path] = []

    for env_name in (
        "OPENSTUDIO_ACESTEP_TEXT_ENCODER_DIR",
        "COMFYUI_TEXT_ENCODER_DIR",
    ):
        raw = os.environ.get(env_name, "").strip()
        if raw:
            candidates.append(Path(raw).expanduser())

    home = Path.home()
    candidates.extend(
        [
            home / "Documents" / "ComfyUI" / "models" / "text_encoders",
            home / "Documents" / "Codes" / "ComfyUI" / "models" / "text_encoders",
            home / "ComfyUI" / "models" / "text_encoders",
        ]
    )

    unique_candidates: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.expanduser().resolve()
        except OSError:
            resolved = candidate.expanduser()
        key = str(resolved).lower()
        if key in seen:
            continue
        seen.add(key)
        unique_candidates.append(resolved)
    return unique_candidates


def find_local_comfy_text_encoder_assets() -> tuple[dict[str, Path], list[str]]:
    found: dict[str, Path] = {}
    searched_dirs: list[str] = []

    for candidate_dir in get_candidate_comfy_text_encoder_dirs():
        searched_dirs.append(str(candidate_dir))
        if not candidate_dir.is_dir():
            continue
        for target_name, source_filename in ACE15_COMFY_TEXT_ENCODER_FILENAMES.items():
            if target_name in found:
                continue
            candidate = candidate_dir / source_filename
            if candidate.exists() and candidate.is_file():
                found[target_name] = candidate.resolve()

    return found, searched_dirs


def hardlink_or_copy_file(source: Path, destination: Path) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    try:
        os.link(source, destination)
        return "hardlink"
    except OSError:
        shutil.copy2(source, destination)
        return "copy"


def synthesize_managed_ace15_lm_checkpoint(
    *,
    checkpoint_root: Path,
    target_name: str,
    source_safetensors: Path,
    template_checkpoint_dir: Path,
) -> Path:
    if target_name not in ACE15_MANAGED_LM_CONFIG_OVERRIDES:
        raise ValueError(f"Unsupported ACE15 managed LM target: {target_name}")

    target_dir = checkpoint_root / target_name
    target_dir.mkdir(parents=True, exist_ok=True)

    template_config_path = template_checkpoint_dir / "config.json"
    if not template_config_path.exists():
        raise FileNotFoundError(f"Template config is missing: {template_config_path}")

    config = json.loads(template_config_path.read_text(encoding="utf-8"))
    config.update(ACE15_MANAGED_LM_CONFIG_OVERRIDES[target_name])
    if "num_hidden_layers" in config:
        config["layer_types"] = ["full_attention"] * int(config["num_hidden_layers"])

    for shared_name in ACE15_MANAGED_LM_SHARED_FILES:
        source_file = template_checkpoint_dir / shared_name
        if source_file.exists() and source_file.is_file():
            shutil.copy2(source_file, target_dir / shared_name)

    (target_dir / "config.json").write_text(
        json.dumps(config, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    link_mode = hardlink_or_copy_file(source_safetensors, target_dir / "model.safetensors")
    metadata = {
        "source": "localModelImport",
        "sourceFile": str(source_safetensors),
        "linkMode": link_mode,
        "generatedAt": utc_now_iso(),
        "targetName": target_name,
    }
    (target_dir / "openstudio-source.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    return target_dir


def hydrate_comfy_runtime_profiles(checkpoint_root: Path) -> dict[str, Any]:
    template_dir = checkpoint_root / "acestep-5Hz-lm-1.7B"
    if not template_dir.is_dir():
        return {
            "importedTargets": [],
            "searchedDirs": [],
            "foundSources": {},
            "missingTargets": list(ACE15_COMFY_TEXT_ENCODER_FILENAMES.keys()),
            "error": f"Template checkpoint is missing: {template_dir}",
        }

    found_sources, searched_dirs = find_local_comfy_text_encoder_assets()
    imported_targets: list[str] = []
    missing_targets: list[str] = []

    for target_name in ACE15_COMFY_TEXT_ENCODER_FILENAMES:
        target_dir = checkpoint_root / target_name
        if (target_dir / "model.safetensors").exists():
            continue

        source_safetensors = found_sources.get(target_name)
        if source_safetensors is None:
            missing_targets.append(target_name)
            continue

        synthesize_managed_ace15_lm_checkpoint(
            checkpoint_root=checkpoint_root,
            target_name=target_name,
            source_safetensors=source_safetensors,
            template_checkpoint_dir=template_dir,
        )
        imported_targets.append(target_name)

    return {
        "importedTargets": imported_targets,
        "searchedDirs": searched_dirs,
        "foundSources": {key: str(value) for key, value in found_sources.items()},
        "missingTargets": missing_targets,
        "error": "",
    }


def hydrate_native_split_assets(checkpoint_root: Path) -> dict[str, Any]:
    found_sources, searched_dirs = find_local_comfy_native_assets()
    imported_assets: list[str] = []
    missing_assets: list[str] = []

    for spec in REQUIRED_MUSIC_GEN_NATIVE_FILES:
        destination = checkpoint_root / Path(spec["relativePath"])
        if destination.exists() and destination.is_file():
            continue

        source_file = found_sources.get(spec["id"])
        if source_file is None:
            missing_assets.append(spec["relativePath"])
            continue

        hardlink_or_copy_file(source_file, destination)
        imported_assets.append(spec["relativePath"])

    return {
        "importedAssets": imported_assets,
        "searchedDirs": searched_dirs,
        "foundSources": {key: str(value) for key, value in found_sources.items()},
        "missingAssets": missing_assets,
    }


def get_requirement_specifiers(*, python_version: tuple[int, int, int] | None) -> list[str]:
    if platform.system() == "Windows":
        windows_audio_separator_variant = (
            "audio-separator[gpu]==0.41.1"
            if is_windows_nvidia_machine()
            else "audio-separator[dml]==0.41.1"
        )
        return [
            windows_audio_separator_variant,
            "hf_xet>=1.4.2",
            "huggingface_hub>=0.34,<1.0",
        ]
    if platform.system() == "Linux":
        backend = _detect_linux_gpu_backend()
        if backend == "cuda":
            return [
                "audio-separator[gpu]==0.41.1",
                "hf_xet>=1.4.2",
                "huggingface_hub>=0.34,<1.0",
            ]
        # ROCm and CPU both start from the CPU base; the backend plan swaps torch wheels
        return [
            "audio-separator[cpu]==0.41.1",
            "hf_xet>=1.4.2",
            "huggingface_hub>=0.34,<1.0",
        ]
    return [
        "audio-separator[cpu]==0.41.1",
        "hf_xet>=1.4.2",
        "huggingface_hub>=0.34,<1.0",
    ]


def get_music_generation_runtime_requirements(
    *,
    python_version: tuple[int, int, int] | None,
) -> list[str]:
    if not is_music_generation_python_compatible(python_version):
        return []

    return [
        "transformers==4.57.6",
        "diffusers==0.35.2",
        "accelerate>=1.12,<2",
        "vector-quantize-pytorch>=1.27.15",
        "torchsde>=0.2.6",
        "av>=12.0.0",
        "huggingface_hub>=0.34,<1.0",
        "loguru>=0.7.3",
        "xxhash>=3.5.0",
    ]


def compute_file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().lower()


def download_url_to_path(url: str, destination: Path) -> None:
    request = Request(url, headers={"User-Agent": "OpenStudio-AI-Installer/1.0"})
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response, destination.open(
        "wb"
    ) as output:
        while True:
            chunk = response.read(DOWNLOAD_CHUNK_SIZE)
            if not chunk:
                break
            output.write(chunk)


def install_pinned_wheel(
    runtime_python: Path,
    runtime_root: Path,
    *,
    wheel_url: str,
    wheel_sha256: str,
    wheel_filename: str,
    description: str,
    state: str,
    progress: float,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    step_label: str | None = None,
    step_index: int = 0,
    step_count: int = 0,
    download_hint: str = "",
    is_large_download: bool = False,
    raise_on_error: bool = False,
    error_code: str = "dependency_bootstrap_failed",
) -> None:
    emit(
        state,
        progress,
        message=description,
        stepLabel=step_label or description,
        stepIndex=step_index,
        stepCount=step_count,
        downloadHint=download_hint,
        isLargeDownload=is_large_download,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )

    cache_dir = runtime_root / ".openstudio-pinned-wheels"
    wheel_path = cache_dir / wheel_filename
    expected_sha256 = wheel_sha256.removeprefix("sha256:").strip().lower()

    try:
        should_download = True
        if wheel_path.exists():
            should_download = compute_file_sha256(wheel_path) != expected_sha256
            if should_download:
                wheel_path.unlink()

        if should_download:
            download_url_to_path(wheel_url, wheel_path)

        actual_sha256 = compute_file_sha256(wheel_path)
        if actual_sha256 != expected_sha256:
            raise InstallerStepError(
                f"{description} failed. Downloaded wheel checksum mismatch.",
                error_code=error_code,
                progress=progress,
            )
    except InstallerStepError:
        raise
    except Exception as exc:
        if raise_on_error:
            raise InstallerStepError(
                f"{description} failed: {type(exc).__name__}: {exc}",
                error_code=error_code,
                progress=progress,
            ) from exc
        fail(
            f"{description} failed: {type(exc).__name__}: {exc}",
            progress=progress,
            error_code=error_code,
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    run_step(
        [
            str(runtime_python),
            "-m",
            "pip",
            "install",
            "--no-deps",
            str(wheel_path),
        ],
        state=state,
        progress=progress,
        description=description,
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code=error_code,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=runtime_root,
        raise_on_error=raise_on_error,
        step_label=step_label,
        step_index=step_index,
        step_count=step_count,
        download_hint=download_hint,
        is_large_download=is_large_download,
    )


def apply_windows_cuda_pytorch_overlay(
    runtime_python: Path,
    runtime_root: Path,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    run_step(
        [
            str(runtime_python),
            "-m",
            "pip",
            "uninstall",
            "-y",
            "torch",
            "torchvision",
            "torchaudio",
        ],
        state="installing",
        progress=0.575,
        description="Removing CPU PyTorch wheels before enabling CUDA music generation",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=runtime_root,
    )

    stream_step(
        [
            str(runtime_python),
            "-m",
            "pip",
            "install",
            "--verbose",
            "--index-url",
            get_windows_cuda_pytorch_index_url(),
            *get_windows_cuda_pytorch_packages(),
        ],
        state="installing",
        progress=0.59,
        description="Installing CUDA PyTorch wheels for ACE-Step music generation",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=runtime_root,
        step_label="Installing CUDA PyTorch wheels for ACE-Step music generation",
        download_hint="This is the largest Windows AI runtime step. OpenStudio is downloading and installing the pinned CUDA PyTorch wheels, which can stay quiet for several minutes.",
        is_large_download=True,
    )


def install_windows_music_acceleration_stack(
    runtime_python: Path,
    runtime_root: Path,
    *,
    state: str,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    step_index_offset: int = 0,
    step_count: int = 0,
    raise_on_error: bool = False,
    error_code: str = "music_acceleration_setup_failed",
) -> None:
    triton_package = get_windows_triton_package_spec()
    flash_attn_asset = get_windows_flash_attn_asset()

    run_step(
        [
            str(runtime_python),
            "-m",
            "pip",
            "install",
            "--upgrade",
            triton_package,
        ],
        state=state,
        progress=0.605,
        description="Installing Triton for the ACE-Step accelerated LM runtime",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code=error_code,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=runtime_root,
        raise_on_error=raise_on_error,
        step_label="Installing Triton for music generation",
        step_index=step_index_offset + 1,
        step_count=step_count,
        download_hint="OpenStudio is installing the Windows Triton runtime used by ACE-Step acceleration.",
        is_large_download=True,
    )

    install_pinned_wheel(
        runtime_python,
        runtime_root,
        wheel_url=str(flash_attn_asset.get("url", "")).strip(),
        wheel_sha256=str(flash_attn_asset.get("sha256", "")).strip(),
        wheel_filename=str(
            flash_attn_asset.get("fileName")
            or flash_attn_asset.get("filename")
            or "flash_attn.whl"
        ).strip(),
        description="Installing Flash Attention for the ACE-Step accelerated LM runtime",
        state=state,
        progress=0.615,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        step_label="Installing Flash Attention for music generation",
        step_index=step_index_offset + 2,
        step_count=step_count,
        download_hint="OpenStudio is installing the pinned Flash Attention wheel for the Windows ACE-Step stack.",
        is_large_download=True,
        raise_on_error=raise_on_error,
        error_code=error_code,
    )


def download_music_generation_source(
    runtime_python: Path,
    runtime_root: Path,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    raise_on_error: bool = False,
) -> Path:
    source_root = runtime_root / MUSIC_GEN_SOURCE_DIRNAME
    run_step(
        [
            str(runtime_python),
            "-c",
            (
                "from pathlib import Path\n"
                "from huggingface_hub import snapshot_download\n"
                f"source_root = Path(r'{source_root}')\n"
                "source_root.mkdir(parents=True, exist_ok=True)\n"
                "snapshot_download(\n"
                f"    repo_id=r'{MUSIC_GEN_SPACE_REPO}',\n"
                f"    repo_type=r'{MUSIC_GEN_SPACE_REPO_TYPE}',\n"
                "    local_dir=str(source_root),\n"
                ")\n"
                "print('ok')\n"
            ),
        ],
        state="installing",
        progress=0.52,
        description="Preparing the ACE-Step 1.5 runtime source",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=runtime_root,
        raise_on_error=raise_on_error,
    )
    return source_root


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


def is_path_within(path: Path, root: Path) -> bool:
    resolved_path = safe_resolve(path)
    resolved_root = safe_resolve(root)
    try:
        resolved_path.relative_to(resolved_root)
        return True
    except ValueError:
        return False


def extract_windows_access_denied_path(output: str) -> Path | None:
    match = re.search(r"Access is denied:\s*['\"]([^'\"]+)['\"]", output, re.IGNORECASE)
    if match is None:
        return None
    return Path(match.group(1))


def read_json_file(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def fetch_json(url: str, *, timeout: int = DOWNLOAD_TIMEOUT_SECONDS) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": "OpenStudio-AI-Installer/1.0"})
    with urlopen(request, timeout=timeout) as response:
        payload = response.read()
    return json.loads(payload.decode("utf-8"))


def resolve_audio_separator_models_json(runtime_root: Path) -> Path:
    candidates = [
        runtime_root / "Lib" / "site-packages" / "audio_separator" / "models.json",
        runtime_root / "lib" / "site-packages" / "audio_separator" / "models.json",
        runtime_root / "python" / "Lib" / "site-packages" / "audio_separator" / "models.json",
        runtime_root / "python" / "lib" / "site-packages" / "audio_separator" / "models.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate

    for candidate in runtime_root.rglob("models.json"):
        if candidate.parent.name == "audio_separator":
            return candidate

    raise ModelDownloadError(
        f"OpenStudio could not find audio_separator/models.json inside {runtime_root}.",
        error_code="model_manifest_missing",
    )


def append_activity_line(recent_lines: deque[str], line: str) -> list[str]:
    recent_lines.append(line)
    write_log(line)
    return list(recent_lines)


def emit_model_download_status(
    *,
    progress: float,
    message: str,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    step_label: str,
    activity_lines: list[str],
    bytes_downloaded: int = 0,
    bytes_total: int = 0,
    status_warning: str = "",
    status_warning_code: str = "",
) -> None:
    payload: dict[str, Any] = {
        "message": message,
        "stepLabel": step_label,
        "stepIndex": 1,
        "stepCount": 1,
        "downloadHint": "The stem model download can take a while on slower connections.",
        "isLargeDownload": True,
        "activityLines": activity_lines,
        "installSource": install_source,
        "requiresExternalPython": requires_external_python,
        "pythonDetected": python_detected,
        "buildRuntimeMode": build_runtime_mode,
    }
    if bytes_downloaded > 0:
        payload["bytesDownloaded"] = bytes_downloaded
    if bytes_total > 0:
        payload["bytesTotal"] = bytes_total
    if status_warning:
        payload["statusWarning"] = status_warning
    if status_warning_code:
        payload["statusWarningCode"] = status_warning_code
    emit("downloading_model", progress, **payload)


def load_model_manifests(runtime_root: Path, recent_lines: deque[str]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    append_activity_line(recent_lines, "Resolving model manifests...")
    bundled_manifest_path = resolve_audio_separator_models_json(runtime_root)
    bundled_manifest = read_json_file(bundled_manifest_path)
    log_event(
        "installer",
        "downloading_model",
        "bundled_model_manifest_loaded",
        manifestPath=str(bundled_manifest_path),
    )
    append_activity_line(recent_lines, f"Loaded bundled model list from {bundled_manifest_path}")

    try:
        uvr_manifest = fetch_json(MODEL_DOWNLOAD_MANIFEST_URL)
        log_event(
            "installer",
            "downloading_model",
            "uvr_model_manifest_loaded",
            manifestUrl=MODEL_DOWNLOAD_MANIFEST_URL,
        )
        append_activity_line(recent_lines, "Loaded UVR model manifest")
    except Exception as exc:
        uvr_manifest = None
        log_event(
            "installer",
            "downloading_model",
            "uvr_model_manifest_failed",
            manifestUrl=MODEL_DOWNLOAD_MANIFEST_URL,
            errorCode="model_manifest_fetch_failed",
            exceptionType=type(exc).__name__,
            exceptionMessage=str(exc),
        )
        append_activity_line(recent_lines, "Could not load the UVR model manifest; continuing with bundled model metadata")

    return uvr_manifest, bundled_manifest


def build_simple_model_entry(model_name: str, model_type: str, files: list[str], source: str, friendly_name: str) -> dict[str, Any]:
    ordered_files = list(dict.fromkeys(files))
    if model_name in ordered_files:
        ordered_files = [model_name, *[entry for entry in ordered_files if entry != model_name]]
    return {
        "source": source,
        "modelType": model_type,
        "filename": model_name,
        "friendlyName": friendly_name,
        "downloadFiles": ordered_files,
    }


def find_model_in_manifest(manifest: dict[str, Any], model_name: str, *, source: str) -> dict[str, Any] | None:
    for key, models in manifest.items():
        if not key.endswith("_download_list") or not isinstance(models, dict):
            continue

        model_type = key.removesuffix("_download_list").upper()
        for friendly_name, value in models.items():
            if isinstance(value, str):
                if value == model_name:
                    return build_simple_model_entry(model_name, model_type, [value], source, friendly_name)
                continue

            if not isinstance(value, dict):
                continue

            if model_type == "DEMUCS":
                yaml_name = next((entry for entry in value.keys() if isinstance(entry, str) and entry.endswith(".yaml")), "")
                download_files = list(value.values())
                if yaml_name and (yaml_name == model_name or model_name in download_files):
                    return build_simple_model_entry(model_name, model_type, download_files, source, friendly_name)
                continue

            matching_model_key = next((entry for entry in value.keys() if entry == model_name), None)
            matching_yaml_value = next((entry for entry in value.values() if entry == model_name), None)
            if matching_model_key is None and matching_yaml_value is None:
                continue

            model_file = matching_model_key or next(iter(value.keys()))
            sidecar_file = value[model_file]
            return build_simple_model_entry(model_name, model_type, [model_file, sidecar_file], source, friendly_name)

    return None


def build_download_urls(*, source: str, model_type: str, filename: str) -> list[str]:
    if filename.startswith("http://") or filename.startswith("https://"):
        return [filename]

    if source == "audio_separator":
        return [
            f"{AUDIO_SEPARATOR_HF_REPO_URL_PREFIX}/{filename}",
            f"{AUDIO_SEPARATOR_MODEL_REPO_URL_PREFIX}/{filename}",
        ]

    if model_type == "MDX23C" and filename.endswith(".yaml"):
        return [
            f"{UVR_MODEL_CONFIG_URL_PREFIX}/{filename}",
            f"{AUDIO_SEPARATOR_MODEL_REPO_URL_PREFIX}/{filename}",
        ]

    return [
        f"{UVR_MODEL_REPO_URL_PREFIX}/{filename}",
        f"{AUDIO_SEPARATOR_MODEL_REPO_URL_PREFIX}/{filename}",
    ]


def resolve_model_download_plan(runtime_root: Path, model_name: str, recent_lines: deque[str]) -> list[dict[str, Any]]:
    uvr_manifest, bundled_manifest = load_model_manifests(runtime_root, recent_lines)

    candidates: list[dict[str, Any]] = []

    bundled_match = find_model_in_manifest(bundled_manifest, model_name, source="audio_separator")
    if bundled_match is not None:
        candidates.append(bundled_match)

    if uvr_manifest is not None:
        uvr_match = find_model_in_manifest(uvr_manifest, model_name, source="uvr")
        if uvr_match is not None:
            candidates.append(uvr_match)

    if not candidates:
        raise ModelDownloadError(
            f"OpenStudio could not resolve download information for the stem model {model_name}.",
            error_code="model_manifest_missing",
        )

    selected = candidates[0]
    log_event(
        "installer",
        "downloading_model",
        "model_resolution_succeeded",
        modelName=model_name,
        source=selected["source"],
        modelType=selected["modelType"],
        friendlyName=selected["friendlyName"],
        downloadFiles=selected["downloadFiles"],
    )
    append_activity_line(
        recent_lines,
        f"Resolved {model_name} via {selected['source']} model metadata ({selected['friendlyName']})",
    )

    targets: list[dict[str, Any]] = []
    for entry in selected["downloadFiles"]:
        filename = urlparse(entry).path.rsplit("/", 1)[-1] if entry.startswith("http") else entry
        targets.append(
            {
                "filename": filename,
                "urls": build_download_urls(
                    source=selected["source"],
                    model_type=selected["modelType"],
                    filename=entry,
                ),
            }
        )

    return targets


def _calculate_download_progress(file_index: int, file_count: int, file_progress: float) -> float:
    normalized = (file_index + max(0.0, min(file_progress, 1.0))) / max(file_count, 1)
    return MODEL_DOWNLOAD_PROGRESS_START + (MODEL_DOWNLOAD_PROGRESS_END - MODEL_DOWNLOAD_PROGRESS_START) * normalized


def download_file_with_retries(
    *,
    urls: list[str],
    target_path: Path,
    file_label: str,
    file_index: int,
    file_count: int,
    recent_lines: deque[str],
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    completed_bytes: int,
) -> int:
    temp_path = target_path.with_suffix(target_path.suffix + ".part")
    if temp_path.exists():
        temp_path.unlink()

    activity_line = f"Preparing to download {file_label}"
    activity_lines = append_activity_line(recent_lines, activity_line)
    emit_model_download_status(
        progress=_calculate_download_progress(file_index, file_count, 0.0),
        message=f"Connecting to the host for {file_label}",
        step_label=f"Connecting to the host for {file_label}",
        activity_lines=activity_lines,
        bytes_downloaded=completed_bytes,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    for url_index, url in enumerate(urls):
        append_activity_line(recent_lines, f"Attempting {file_label} from {url}")
        log_event(
            "installer",
            "downloading_model",
            "model_file_download_started",
            fileName=target_path.name,
            fileLabel=file_label,
            url=url,
            attempt=url_index + 1,
        )

        heartbeat_stop = threading.Event()
        heartbeat_payload: dict[str, Any] = {
            "progress": _calculate_download_progress(file_index, file_count, 0.0),
            "message": f"Connecting to the host for {file_label}",
            "stepLabel": f"Connecting to the host for {file_label}",
            "activityLines": list(recent_lines),
            "bytesDownloaded": completed_bytes,
            "bytesTotal": 0,
        }
        heartbeat_lock = threading.Lock()

        def heartbeat_loop() -> None:
            while not heartbeat_stop.wait(DOWNLOAD_HEARTBEAT_SECONDS):
                with heartbeat_lock:
                    payload = dict(heartbeat_payload)
                emit_model_download_status(
                    progress=payload["progress"],
                    message=payload["message"],
                    step_label=payload["stepLabel"],
                    activity_lines=payload["activityLines"],
                    bytes_downloaded=payload.get("bytesDownloaded", 0),
                    bytes_total=payload.get("bytesTotal", 0),
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                )

        heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
        heartbeat_thread.start()

        downloaded = 0
        total_size = 0
        try:
            request = Request(url, headers={"User-Agent": "OpenStudio-AI-Installer/1.0"})
            with urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                status_code = getattr(response, "status", response.getcode())
                if status_code != 200:
                    raise HTTPError(url, status_code, "Unexpected status code", response.headers, None)

                content_length_header = response.headers.get("Content-Length", "0")
                total_size = int(content_length_header or "0")
                with heartbeat_lock:
                    heartbeat_payload["message"] = f"Downloading {file_label}"
                    heartbeat_payload["stepLabel"] = f"Downloading {file_label}"
                    heartbeat_payload["bytesDownloaded"] = completed_bytes
                    heartbeat_payload["bytesTotal"] = completed_bytes + total_size if total_size > 0 else 0

                with temp_path.open("wb") as handle:
                    while True:
                        chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                        if not chunk:
                            break
                        handle.write(chunk)
                        downloaded += len(chunk)

                        file_progress = downloaded / total_size if total_size > 0 else 0.0
                        aggregate_downloaded = completed_bytes + downloaded
                        aggregate_total = completed_bytes + total_size if total_size > 0 else 0
                        activity_lines = list(recent_lines)
                        progress = _calculate_download_progress(file_index, file_count, file_progress)

                        with heartbeat_lock:
                            heartbeat_payload["progress"] = progress
                            heartbeat_payload["message"] = f"Downloading {file_label}"
                            heartbeat_payload["stepLabel"] = f"Downloading {file_label}"
                            heartbeat_payload["activityLines"] = activity_lines
                            heartbeat_payload["bytesDownloaded"] = aggregate_downloaded
                            heartbeat_payload["bytesTotal"] = aggregate_total

                        emit_model_download_status(
                            progress=progress,
                            message=f"Downloading {file_label}",
                            step_label=f"Downloading {file_label}",
                            activity_lines=activity_lines,
                            bytes_downloaded=aggregate_downloaded,
                            bytes_total=aggregate_total,
                            install_source=install_source,
                            requires_external_python=requires_external_python,
                            python_detected=python_detected,
                            build_runtime_mode=build_runtime_mode,
                        )

            temp_path.replace(target_path)
            final_size = target_path.stat().st_size
            completed_total = completed_bytes + final_size
            append_activity_line(recent_lines, f"Finished downloading {target_path.name}")
            log_event(
                "installer",
                "downloading_model",
                "model_file_download_succeeded",
                fileName=target_path.name,
                fileLabel=file_label,
                url=url,
                bytesDownloaded=final_size,
            )
            emit_model_download_status(
                progress=_calculate_download_progress(file_index + 1, file_count, 0.0),
                message=f"Downloaded {file_label}",
                step_label=f"Downloaded {file_label}",
                activity_lines=list(recent_lines),
                bytes_downloaded=completed_total,
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
            )
            return final_size
        except HTTPError as exc:
            append_activity_line(recent_lines, f"{target_path.name} was not available at {url} ({exc.code})")
            log_event(
                "installer",
                "downloading_model",
                "model_file_download_http_error",
                fileName=target_path.name,
                url=url,
                httpStatus=exc.code,
            )
            if temp_path.exists():
                temp_path.unlink()
            if url_index == len(urls) - 1:
                raise ModelDownloadError(
                    f"OpenStudio could not find {target_path.name} at the published model URLs.",
                    error_code="model_url_unavailable",
                ) from exc
        except (TimeoutError, socket.timeout) as exc:
            if temp_path.exists():
                temp_path.unlink()
            error_code = "model_download_timeout" if downloaded == 0 else "model_transfer_interrupted"
            message = (
                f"OpenStudio timed out before {target_path.name} started downloading."
                if downloaded == 0
                else f"OpenStudio lost connection while downloading {target_path.name}."
            )
            append_activity_line(recent_lines, message)
            raise ModelDownloadError(message, error_code=error_code) from exc
        except (URLError, OSError) as exc:
            if temp_path.exists():
                temp_path.unlink()
            error_code = "model_download_timeout" if downloaded == 0 else "model_transfer_interrupted"
            message = (
                f"OpenStudio could not start downloading {target_path.name}: {exc}."
                if downloaded == 0
                else f"OpenStudio lost connection while downloading {target_path.name}: {exc}."
            )
            append_activity_line(recent_lines, message)
            if url_index == len(urls) - 1:
                raise ModelDownloadError(message, error_code=error_code) from exc
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=1)

    raise ModelDownloadError(
        f"OpenStudio could not download {target_path.name}.",
        error_code="model_download_failed",
    )


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
    raise_on_error: bool = False,
    step_label: str | None = None,
    step_index: int = 0,
    step_count: int = 0,
    download_hint: str = "",
    is_large_download: bool = False,
) -> None:
    result = run_step_process(
        command,
        state=state,
        progress=progress,
        description=description,
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code=error_code,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=cwd,
        step_label=step_label,
        step_index=step_index,
        step_count=step_count,
        download_hint=download_hint,
        is_large_download=is_large_download,
    )
    if result.returncode != 0:
        if raise_on_error:
            raise InstallerStepError(
                f"{description} failed. See the install log for details.",
                error_code=error_code,
                progress=progress,
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


def normalize_installer_command(command: list[str]) -> list[str]:
    normalized = list(command)
    if (
        len(normalized) >= 4
        and normalized[1:4] == ["-m", "pip", "install"]
        and "--no-cache-dir" not in normalized
    ):
        normalized.insert(4, "--no-cache-dir")
    return normalized


def run_step_process(
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
    raise_on_error: bool = False,
    step_label: str | None = None,
    step_index: int = 0,
    step_count: int = 0,
    download_hint: str = "",
    is_large_download: bool = False,
) -> subprocess.CompletedProcess[str]:
    command = normalize_installer_command(command)
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
        stepLabel=step_label or description,
        stepIndex=step_index,
        stepCount=step_count,
        downloadHint=download_hint,
        isLargeDownload=is_large_download,
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
    else:
        log_event(
            "installer",
            state,
            "step_succeeded",
            description=description,
            exitCode=result.returncode,
        )
    return result


def probe_windows_reused_runtime_health(runtime_python: Path) -> bool:
    if platform.system() != "Windows":
        return False

    health_check = (
        "from importlib import import_module, metadata\n"
        "required = ['audio_separator', 'requests', 'certifi', 'charset_normalizer', 'idna', 'urllib3']\n"
        "for module_name in required:\n"
        "    import_module(module_name)\n"
        "version = metadata.version('audio-separator')\n"
        "if version != '0.41.1':\n"
        "    raise SystemExit(f'unexpected audio-separator version: {version}')\n"
        "print('ok')\n"
    )
    result = subprocess.run(
        [str(runtime_python), "-c", health_check],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    log_subprocess_output(result, f"{runtime_python} -c <reused runtime health check>")
    if result.returncode == 0:
        log_event(
            "installer",
            "installing",
            "reused_runtime_health_check_succeeded",
            runtimePython=str(runtime_python),
        )
        return True

    log_event(
        "installer",
        "installing",
        "reused_runtime_health_check_failed",
        runtimePython=str(runtime_python),
        exitCode=result.returncode,
    )
    return False


def classify_windows_runtime_lock_error(
    result: subprocess.CompletedProcess[str],
    runtime_root: Path,
) -> tuple[bool, str]:
    if platform.system() != "Windows":
        return False, ""

    output = "\n".join(part for part in (result.stderr, result.stdout) if part).strip()
    if not output:
        return False, ""
    if "[WinError 5]" not in output and "Access is denied" not in output:
        return False, ""

    locked_path = extract_windows_access_denied_path(output)
    if locked_path is None:
        return False, ""

    site_packages = runtime_root / "Lib" / "site-packages"
    if not is_path_within(locked_path, site_packages):
        return False, str(safe_resolve(locked_path))

    return True, str(safe_resolve(locked_path))


def repair_windows_reused_runtime(
    runtime_python: Path,
    runtime_root: Path,
    bootstrap_python: Path,
    runtime_python_version: tuple[int, int, int] | None,
    bootstrap_python_version: tuple[int, int, int] | None,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> tuple[Path, tuple[int, int, int] | None, bool]:
    if platform.system() != "Windows":
        run_step(
            [
                str(runtime_python),
                "-m",
                "pip",
                "install",
                "--ignore-installed",
                "--no-deps",
                *WINDOWS_REUSED_RUNTIME_REPAIR_PACKAGES,
            ],
            state="installing",
            progress=0.3,
            description="Repairing the AI tools environment",
            install_source=install_source,
            requires_external_python=requires_external_python,
            error_code="dependency_bootstrap_failed",
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        return runtime_python, runtime_python_version, True

    if probe_windows_reused_runtime_health(runtime_python):
        log_event(
            "installer",
            "installing",
            "reused_runtime_repair_skipped",
            runtimePython=str(runtime_python),
            runtimePythonVersion=format_python_version(runtime_python_version),
        )
        emit(
            "installing",
            0.3,
            message="Reused AI tools environment looks healthy",
            stepLabel="Reused AI tools environment looks healthy",
            activityLines=[
                f"Existing runtime uses Python {format_python_version(runtime_python_version)}.",
                "audio-separator and the networking packages are already importable.",
            ],
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )
        return runtime_python, runtime_python_version, True

    terminated_before_repair = terminate_windows_runtime_lock_holders(runtime_root)
    if terminated_before_repair:
        log_event(
            "installer",
            "installing",
            "runtime_lock_holders_terminated_before_repair",
            runtimeRoot=str(runtime_root),
            terminatedProcesses=terminated_before_repair,
        )

    repair_result = run_step_process(
        [
            str(runtime_python),
            "-m",
            "pip",
            "install",
            "--ignore-installed",
            "--no-deps",
            *WINDOWS_REUSED_RUNTIME_REPAIR_PACKAGES,
        ],
        state="installing",
        progress=0.3,
        description="Repairing the AI tools environment",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    if repair_result.returncode == 0:
        return runtime_python, runtime_python_version, True

    is_locked_runtime, locked_path = classify_windows_runtime_lock_error(repair_result, runtime_root)
    if not is_locked_runtime:
        fail(
            "Repairing the AI tools environment failed. See the install log for details.",
            progress=0.3,
            error_code="dependency_bootstrap_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    log_event(
        "installer",
        "installing",
        "runtime_locked_file_detected",
        runtimeRoot=str(runtime_root),
        lockedPath=locked_path,
        exitCode=repair_result.returncode,
    )
    emit(
        "installing",
        0.31,
        message="A locked AI runtime file was detected. Rebuilding the AI tools environment.",
        stepLabel="Rebuilding the AI tools environment on Windows",
        activityLines=[
            "Windows denied access while pip was replacing a managed runtime file.",
            f"Locked file: {locked_path}",
            f"OpenStudio will rebuild only {runtime_root.name} and keep downloaded models/checkpoints.",
        ],
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )

    try:
        terminated_runtime_processes = remove_tree_with_retries(runtime_root)
    except OSError as exc:
        fail(
            f"OpenStudio could not rebuild the managed runtime because '{runtime_root}' could not be removed: {exc}",
            state="installing",
            progress=0.31,
            error_code="runtime_rebuild_remove_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    if terminated_runtime_processes:
        log_event(
            "installer",
            "installing",
            "runtime_lock_holders_terminated",
            runtimeRoot=str(runtime_root),
            terminatedProcesses=terminated_runtime_processes,
        )

    log_event(
        "installer",
        "creating_venv",
        "runtime_locked_rebuild_started",
        runtimeRoot=str(runtime_root),
        bootstrapPython=str(bootstrap_python),
        bootstrapPythonVersion=format_python_version(bootstrap_python_version),
        lockedPath=locked_path,
    )
    run_step(
        [str(bootstrap_python), "-m", "venv", str(runtime_root)],
        state="creating_venv",
        progress=0.32,
        description="Rebuilding the AI tools environment on Windows",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="runtime_locked_rebuild_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    runtime_python = resolve_runtime_python(runtime_root)
    runtime_python_version = read_python_version_info(runtime_python) or bootstrap_python_version
    log_event(
        "installer",
        "creating_venv",
        "runtime_locked_rebuild_succeeded",
        runtimeRoot=str(runtime_root),
        runtimePython=str(runtime_python),
        runtimePythonVersion=format_python_version(runtime_python_version),
    )
    return runtime_python, runtime_python_version, False


def ensure_runtime_pip(
    runtime_python: Path,
    *,
    progress: float,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    probe = subprocess.run(
        [str(runtime_python), "-m", "pip", "--version"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    log_subprocess_output(probe, f"{runtime_python} -m pip --version")
    if probe.returncode == 0:
        log_event(
            "installer",
            "installing",
            "runtime_pip_available",
            runtimePython=str(runtime_python),
        )
        return

    log_event(
        "installer",
        "installing",
        "runtime_pip_missing",
        runtimePython=str(runtime_python),
        exitCode=probe.returncode,
    )
    run_step(
        [str(runtime_python), "-m", "ensurepip", "--upgrade"],
        state="installing",
        progress=progress,
        description="Repairing Python packaging support in the AI tools environment",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
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
    raise_on_error: bool = False,
    step_label: str | None = None,
    step_index: int = 0,
    step_count: int = 0,
    download_hint: str = "",
    is_large_download: bool = False,
) -> None:
    command = normalize_installer_command(command)
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
        stepLabel=step_label or description,
        stepIndex=step_index,
        stepCount=step_count,
        downloadHint=download_hint,
        isLargeDownload=is_large_download,
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
            emit(
                state,
                progress,
                message=description,
                stepLabel=step_label or description,
                stepIndex=step_index,
                stepCount=step_count,
                downloadHint=download_hint,
                isLargeDownload=is_large_download,
                activityLines=list(recent_lines),
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
            )
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
        if raise_on_error:
            raise InstallerStepError(
                f"{description} failed. {detail if detail else 'See the install log for details.'}",
                error_code=error_code,
                progress=progress,
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
    require_audio_separator: bool,
    require_music_generation: bool = False,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    raise_on_error: bool = False,
) -> None:
    # Downloaded OpenStudio runtimes must be relocatable, so they should not retain
    # virtualenv markers or depend on external metadata that a plain dev venv lacks.
    # The external-Python fallback intentionally creates a venv in runtime_root, and
    # that layout is valid for the unbundled dev path.
    requires_relocatable_runtime = (
        install_source == "downloadedRuntime" and not requires_external_python
    )

    if requires_relocatable_runtime and (runtime_root / "pyvenv.cfg").exists():
        if raise_on_error:
            raise InstallerStepError(
                f"The extracted AI runtime at {runtime_root} still looks like a virtual environment and is not relocatable.",
                error_code="runtime_not_relocatable",
                progress=0.6,
            )
        fail(
            f"The extracted AI runtime at {runtime_root} still looks like a virtual environment and is not relocatable.",
            progress=0.6,
            error_code="runtime_not_relocatable",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    if requires_relocatable_runtime and not (runtime_root / ".openstudio-ai-runtime.json").exists():
        if raise_on_error:
            raise InstallerStepError(
                f"The extracted AI runtime at {runtime_root} is missing OpenStudio runtime metadata.",
                error_code="runtime_validation_failed",
                progress=0.6,
            )
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
    verification_scope = "full" if require_audio_separator else "base"

    write_log(f"runtime_python={resolved_runtime_python}")
    write_log(f"current_python={resolved_current_python}")
    write_log(f"verificationMode={'in-process' if same_interpreter else 'subprocess'}")
    write_log(f"verificationScope={verification_scope}")
    log_event(
        "installer",
        "verifying_base_runtime" if not require_audio_separator else "verifying_runtime",
        "verification_start",
        runtimePython=str(resolved_runtime_python),
        currentPython=str(resolved_current_python),
        verificationMode="in-process" if same_interpreter else "subprocess",
        verificationScope=verification_scope,
    )

    emit(
        "verifying_base_runtime" if not require_audio_separator else "verifying_runtime",
        0.65,
        message="Verifying the AI tools base runtime" if not require_audio_separator else "Verifying the AI tools runtime",
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )

    verification_mode = "in-process" if same_interpreter else "subprocess"
    write_log(f"verificationMode={verification_mode}")

    if same_interpreter:
        try:
            if require_audio_separator:
                import audio_separator.separator  # noqa: F401
            else:
                import pip  # noqa: F401
            if require_music_generation:
                import acestep  # noqa: F401
        except Exception as exc:
            write_log(f"[in-process verification error] {type(exc).__name__}: {exc}")
            log_event(
                "installer",
                "verifying_base_runtime" if not require_audio_separator else "verifying_runtime",
                "verification_failed",
                verificationMode="in-process",
                verificationScope=verification_scope,
                errorCode="runtime_validation_failed",
                exceptionType=type(exc).__name__,
                exceptionMessage=str(exc),
            )
            if raise_on_error:
                raise InstallerStepError(
                    f"Verifying the AI tools {'base runtime' if not require_audio_separator else 'runtime'} failed: {type(exc).__name__}: {exc}",
                    error_code="base_runtime_invalid" if not require_audio_separator else "runtime_validation_failed",
                    progress=0.65,
                )
            fail(
                f"Verifying the AI tools {'base runtime' if not require_audio_separator else 'runtime'} failed: {type(exc).__name__}: {exc}",
                progress=0.65,
                error_code="base_runtime_invalid" if not require_audio_separator else "runtime_validation_failed",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
            )

        write_log(
            "[in-process verification] "
            + (
                "runtime imports succeeded"
                if require_audio_separator or require_music_generation
                else "pip import succeeded"
            )
        )
        log_event(
            "installer",
            "verifying_base_runtime" if not require_audio_separator else "verifying_runtime",
            "verification_succeeded",
            verificationMode="in-process",
            verificationScope=verification_scope,
        )
        return

    run_step(
        (
            [
                str(runtime_python),
                "-c",
                "import audio_separator.separator; import acestep; print('ok')",
            ]
            if require_audio_separator and require_music_generation
            else [str(runtime_python), "-c", "import audio_separator.separator; print('ok')"]
            if require_audio_separator
            else [str(runtime_python), "-c", "import acestep; print('ok')"]
            if require_music_generation
            else [str(runtime_python), "-m", "pip", "--version"]
        ),
        state="verifying_runtime" if require_audio_separator else "verifying_base_runtime",
        progress=0.65,
        description="Verifying the AI tools runtime" if require_audio_separator else "Verifying the AI tools base runtime",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="runtime_validation_failed" if require_audio_separator else "base_runtime_invalid",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=runtime_root,
        raise_on_error=raise_on_error,
    )


def load_backend_install_plan(install_plan_path: Path) -> dict[str, Any]:
    try:
        install_plan = json.loads(install_plan_path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(
            f"OpenStudio could not parse the backend install plan: {type(exc).__name__}: {exc}",
            progress=0.68,
            error_code="backend_install_plan_invalid",
            installSource="downloadedRuntime",
            requiresExternalPython=False,
            pythonDetected=False,
            buildRuntimeMode="downloaded-runtime",
        )
        raise AssertionError("unreachable")

    if not isinstance(install_plan, dict) or not isinstance(install_plan.get("steps"), list):
        fail(
            "OpenStudio received an invalid backend install plan.",
            progress=0.68,
            error_code="backend_install_plan_invalid",
            installSource="downloadedRuntime",
            requiresExternalPython=False,
            pythonDetected=False,
            buildRuntimeMode="downloaded-runtime",
        )
        raise AssertionError("unreachable")

    return install_plan


def apply_backend_install_plan(
    runtime_python: Path,
    runtime_root: Path,
    install_plan: dict[str, Any],
    *,
    backend_requested: str,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    plan_id = str(install_plan.get("id", "")).strip()
    package_source = str(install_plan.get("packageSource", "")).strip()
    steps = install_plan.get("steps", [])

    write_log(f"backendRequested={backend_requested}")
    write_log(f"installPlanId={plan_id}")
    write_log(f"packageSource={package_source}")
    log_event(
        "installer",
        "installing_backend",
        "backend_install_start",
        backendRequested=backend_requested,
        installPlanId=plan_id,
        packageSource=package_source,
        stepCount=len(steps),
    )

    emit(
        "installing_backend",
        0.74,
        message=f"Installing the {backend_requested} AI backend",
        stepLabel=f"Installing the {backend_requested} AI backend",
        stepIndex=1 if steps else 0,
        stepCount=len(steps),
        backendRequested=backend_requested,
        installPlanId=plan_id,
        packageSource=package_source,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )

    for index, step in enumerate(steps, start=1):
        step_type = str(step.get("type", "")).strip()
        description = str(step.get("description", f"Applying backend install step {index}")).strip()
        step_label = str(step.get("stepLabel", description)).strip() or description
        download_hint = str(step.get("downloadHint", "")).strip()
        is_large_download = bool(step.get("isLargeDownload", False))
        step_progress = min(0.74 + (0.12 * index / max(len(steps), 1)), 0.86)
        step_error_code = str(step.get("errorCode", "backend_install_failed")).strip() or "backend_install_failed"
        non_fatal_for_stem_separation = bool(step.get("nonFatalForStemSeparation", False))
        try:
            if step_type == "pip_install":
                command: list[str] = [str(runtime_python), "-m", "pip", "install", "--upgrade"]
                index_url = str(step.get("indexUrl", "")).strip()
                if index_url:
                    command += ["--index-url", index_url]
                extra_index_urls = step.get("extraIndexUrls", [])
                if isinstance(extra_index_urls, list):
                    for extra_index_url in extra_index_urls:
                        if str(extra_index_url).strip():
                            command += ["--extra-index-url", str(extra_index_url).strip()]
                packages = step.get("packages", [])
                if not isinstance(packages, list) or not packages:
                    fail(
                        f"Backend install plan step {index} is missing packages.",
                        progress=0.74,
                        error_code="backend_install_plan_invalid",
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )
                command += [str(package) for package in packages]
                stream_step(
                    command,
                    state="installing_backend",
                    progress=step_progress,
                    description=description,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    error_code=step_error_code,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    cwd=runtime_root,
                    raise_on_error=True,
                    step_label=step_label,
                    step_index=index,
                    step_count=len(steps),
                    download_hint=download_hint,
                    is_large_download=is_large_download,
                )
            elif step_type == "pip_uninstall":
                packages = step.get("packages", [])
                if not isinstance(packages, list) or not packages:
                    fail(
                        f"Backend install plan step {index} is missing packages.",
                        progress=0.74,
                        error_code="backend_install_plan_invalid",
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )
                run_step(
                    [str(runtime_python), "-m", "pip", "uninstall", "-y", *[str(package) for package in packages]],
                    state="installing_backend",
                    progress=step_progress,
                    description=description,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    error_code=step_error_code,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    cwd=runtime_root,
                    raise_on_error=True,
                    step_label=step_label,
                    step_index=index,
                    step_count=len(steps),
                    download_hint=download_hint,
                    is_large_download=is_large_download,
                )
            elif step_type == "install_pinned_wheel":
                wheel_url = str(step.get("url", "")).strip()
                wheel_sha256 = str(step.get("sha256", "")).strip()
                wheel_filename = str(step.get("fileName", "")).strip()
                if not wheel_url or not wheel_sha256 or not wheel_filename:
                    fail(
                        f"Backend install plan step {index} is missing a pinned wheel URL, file name, or checksum.",
                        progress=0.74,
                        error_code="backend_install_plan_invalid",
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )
                install_pinned_wheel(
                    runtime_python,
                    runtime_root,
                    wheel_url=wheel_url,
                    wheel_sha256=wheel_sha256,
                    wheel_filename=wheel_filename,
                    description=description,
                    state="installing_backend",
                    progress=step_progress,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    step_label=step_label,
                    step_index=index,
                    step_count=len(steps),
                    download_hint=download_hint,
                    is_large_download=is_large_download,
                    raise_on_error=True,
                    error_code=step_error_code,
                )
            elif step_type == "hf_snapshot_pip_install":
                repo_id = str(step.get("repoId", "")).strip()
                repo_type = str(step.get("repoType", "model")).strip() or "model"
                local_dir_name = str(step.get("localDirName", "")).strip()
                if not repo_id or not local_dir_name:
                    fail(
                        f"Backend install plan step {index} is missing a Hugging Face repo id or localDirName.",
                        progress=0.74,
                        error_code="backend_install_plan_invalid",
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )
                source_root = runtime_root / local_dir_name
                run_step(
                    [
                        str(runtime_python),
                        "-c",
                        (
                            "from pathlib import Path\n"
                            "from huggingface_hub import snapshot_download\n"
                            f"source_root = Path(r'{source_root}')\n"
                            "source_root.mkdir(parents=True, exist_ok=True)\n"
                            "snapshot_download(\n"
                            f"    repo_id=r'{repo_id}',\n"
                            f"    repo_type=r'{repo_type}',\n"
                            "    local_dir=str(source_root),\n"
                            ")\n"
                            "print('ok')\n"
                        ),
                    ],
                    state="installing_backend",
                    progress=step_progress,
                    description=description,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    error_code=step_error_code,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    cwd=runtime_root,
                    raise_on_error=True,
                    step_label=step_label,
                    step_index=index,
                    step_count=len(steps),
                    download_hint=download_hint,
                    is_large_download=is_large_download,
                )
                run_step(
                    [
                        str(runtime_python),
                        "-m",
                        "pip",
                        "install",
                        "--no-deps",
                        str(source_root),
                    ],
                    state="installing_backend",
                    progress=step_progress,
                    description=f"Installing {repo_id} into the managed runtime",
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    error_code=step_error_code,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    cwd=runtime_root,
                    raise_on_error=True,
                    step_label=step_label,
                    step_index=index,
                    step_count=len(steps),
                    download_hint=download_hint,
                    is_large_download=is_large_download,
                )
            else:
                fail(
                    f"Unsupported backend install step type '{step_type}'.",
                    progress=0.74,
                    error_code="backend_install_plan_invalid",
                    installSource=install_source,
                    requiresExternalPython=requires_external_python,
                    pythonDetected=python_detected,
                    buildRuntimeMode=build_runtime_mode,
                )
        except InstallerStepError as exc:
            if not non_fatal_for_stem_separation:
                raise

            log_event(
                "installer",
                "installing_backend",
                "backend_install_step_degraded",
                backendRequested=backend_requested,
                installPlanId=plan_id,
                stepIndex=index,
                stepType=step_type,
                errorCode=exc.error_code,
                errorMessage=exc.message,
            )
            emit(
                "installing_backend",
                step_progress,
                message=description,
                stepLabel=step_label,
                stepIndex=index,
                stepCount=len(steps),
                downloadHint=download_hint,
                isLargeDownload=is_large_download,
                activityLines=[
                    f"{description} could not be completed.",
                    exc.message,
                    "OpenStudio will keep going and mark music generation as incomplete if acceleration is still unavailable.",
                ],
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
            )

    log_event(
        "installer",
        "installing_backend",
        "backend_install_succeeded",
        backendRequested=backend_requested,
        installPlanId=plan_id,
        packageSource=package_source,
    )


def probe_runtime(
    runtime_python: Path,
    runtime_root: Path,
    models_dir: Path,
    model_name: str,
    *,
    acceleration_mode: str,
    music_checkpoint_root: Path,
    music_model_id: str,
    backend_requested: str,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    raise_on_error: bool = False,
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

    resolved_runtime_python = safe_resolve(runtime_python)
    resolved_current_python = safe_resolve(Path(sys.executable))

    if resolved_runtime_python == resolved_current_python:
        report = probe_runtime_capabilities(
            models_dir=str(models_dir),
            model_name=model_name,
            acceleration_mode=acceleration_mode,
            music_checkpoint_root=str(music_checkpoint_root),
            music_model_id=music_model_id,
        )
    else:
        probe_script = Path(__file__).with_name("ai_runtime_probe.py")
        probe_command = [
            str(runtime_python),
            str(probe_script),
            "--models-dir",
            str(models_dir),
            "--model",
            model_name,
            "--music-gen-checkpoint-root",
            str(music_checkpoint_root),
            "--music-gen-model",
            music_model_id,
            "--acceleration-mode",
            acceleration_mode,
        ]
        result = subprocess.run(
            probe_command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=runtime_root,
        )
        if result.stdout:
            for line in result.stdout.splitlines():
                write_log(line)
        if result.stderr:
            for line in result.stderr.splitlines():
                write_log(line)

        report_line = ""
        for line in reversed(result.stdout.splitlines() if result.stdout else []):
            candidate = line.strip()
            if candidate.startswith("{") and candidate.endswith("}"):
                report_line = candidate
                break

        if report_line:
            try:
                report = json.loads(report_line)
            except json.JSONDecodeError:
                report = {
                    "runtimeReady": False,
                    "fallbackReason": "runtime probe returned invalid JSON",
                    "errorCode": "probe_output_invalid",
                    "supportedBackends": ["cpu"],
                    "selectedBackend": "cpu",
                    "backendDecisionTrace": ["runtime probe returned invalid JSON"],
                    "probeDurationMs": 0,
                }
        else:
            report = {
                "runtimeReady": False,
                "fallbackReason": "runtime probe produced no JSON output",
                "errorCode": "probe_output_missing",
                "supportedBackends": ["cpu"],
                "selectedBackend": "cpu",
                "backendDecisionTrace": ["runtime probe produced no JSON output"],
                "probeDurationMs": 0,
            }
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
        if raise_on_error:
            raise InstallerStepError(
                "OpenStudio could not validate the managed AI runtime on this machine.",
                error_code="backend_probe_failed" if backend_requested else "runtime_validation_failed",
                progress=0.96,
            )
        fail(
            "OpenStudio could not validate the managed AI runtime on this machine.",
            progress=0.96,
            error_code="backend_probe_failed" if backend_requested else "runtime_validation_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )

    requested_backend = backend_requested.strip().lower()
    selected_backend = str(report.get("selectedBackend", "cpu")).strip().lower()
    if requested_backend and selected_backend != requested_backend:
        message = (
            f"OpenStudio installed the {requested_backend} AI backend, "
            f"but the runtime probe selected {selected_backend or 'cpu'}."
        )
        log_event(
            "probe",
            "probing_runtime",
            "backend_probe_failed",
            backendRequested=requested_backend,
            supportedBackends=report.get("supportedBackends", []),
            selectedBackend=selected_backend or "cpu",
            fallbackReason=report.get("fallbackReason", ""),
            probeDurationMs=report.get("probeDurationMs", 0),
        )
        if raise_on_error:
            raise InstallerStepError(
                message,
                error_code="backend_probe_failed",
                progress=0.96,
            )
        fail(
            message,
            progress=0.96,
            error_code="backend_probe_failed",
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


def resolve_fallback_backend_install_plan(runtime_root: Path, backend_requested: str) -> tuple[str, dict[str, Any]] | None:
    normalized_backend = backend_requested.strip().lower()

    if platform.system() == "Windows":
        # CUDA failed → try DirectML as fallback
        if normalized_backend != "cuda":
            return None
        fallback_plan_path = (
            runtime_root / "openstudio-ai-backend-plans" / "ai-runtime-install-plan-windows-directml.json"
        )
        if not fallback_plan_path.exists():
            return None
        return ("directml", load_backend_install_plan(fallback_plan_path))

    if platform.system() == "Linux":
        # Linux GPU backends are hardware-specific. Do not silently retry the
        # same failed backend or fall back to CPU after GPU setup was selected.
        return None

    return None


def bootstrap_runtime(runtime_root: Path, bootstrap_python: Path) -> Path:
    install_source = "externalPython"
    requires_external_python = True
    python_detected = True
    build_runtime_mode = "unbundled-dev"
    reused_existing_runtime = False
    runtime_python_version: tuple[int, int, int] | None = None
    bootstrap_python_version = read_python_version_info(bootstrap_python)
    force_runtime_rebuild = str(os.environ.get("OPENSTUDIO_FORCE_RUNTIME_REBUILD", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    if runtime_root.exists():
        existing_runtime_python = resolve_runtime_python(runtime_root)
        if existing_runtime_python.exists():
            if platform.system() == "Windows":
                existing_runtime_version = read_python_version_info(existing_runtime_python)
                rebuild_windows_runtime = force_runtime_rebuild or (
                    bootstrap_python_version is not None
                    and existing_runtime_version is not None
                    and existing_runtime_version[:2] != bootstrap_python_version[:2]
                )

                if rebuild_windows_runtime:
                    print("Rebuilding the AI tools environment on Windows")
                    log_event(
                        "installer",
                        "creating_venv",
                        "venv_rebuild_windows_reset",
                        runtimeRoot=str(runtime_root),
                        runtimePython=str(existing_runtime_python),
                        runtimePythonVersion=format_python_version(existing_runtime_version),
                        bootstrapPython=str(bootstrap_python),
                        bootstrapPythonVersion=format_python_version(bootstrap_python_version),
                        forceRuntimeRebuild=force_runtime_rebuild,
                    )
                    emit(
                        "creating_venv",
                        0.18,
                        message="Rebuilding the AI tools environment on Windows",
                        stepLabel="Rebuilding the AI tools environment on Windows",
                        activityLines=[
                            "OpenStudio is rebuilding the managed runtime on Windows.",
                            f"Selected interpreter uses Python {format_python_version(bootstrap_python_version)}.",
                        ],
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )
                    try:
                        terminated_runtime_processes = remove_tree_with_retries(runtime_root)
                    except OSError as exc:
                        fail(
                            f"OpenStudio could not rebuild the managed runtime because '{runtime_root}' is still locked or could not be removed: {exc}",
                            state="creating_venv",
                            progress=0.18,
                            error_code="runtime_rebuild_remove_failed",
                            installSource=install_source,
                            requiresExternalPython=requires_external_python,
                            pythonDetected=python_detected,
                            buildRuntimeMode=build_runtime_mode,
                        )
                    if terminated_runtime_processes:
                        log_event(
                            "installer",
                            "creating_venv",
                            "runtime_lock_holders_terminated",
                            runtimeRoot=str(runtime_root),
                            terminatedProcesses=terminated_runtime_processes,
                        )
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
                    runtime_python_version = read_python_version_info(runtime_python)
                else:
                    reused_existing_runtime = True
                    print("Reusing the existing AI tools environment on Windows")
                    log_event(
                        "installer",
                        "creating_venv",
                        "venv_reused_windows",
                        runtimeRoot=str(runtime_root),
                        runtimePython=str(existing_runtime_python),
                        runtimePythonVersion=format_python_version(existing_runtime_version),
                        bootstrapPython=str(bootstrap_python),
                        bootstrapPythonVersion=format_python_version(bootstrap_python_version),
                    )
                    emit(
                        "creating_venv",
                        0.2,
                        message="Reusing the AI tools environment",
                        stepLabel="Reusing the AI tools environment",
                        activityLines=[
                            f"Existing runtime uses Python {format_python_version(existing_runtime_version)}.",
                            f"Selected interpreter uses Python {format_python_version(bootstrap_python_version)}.",
                        ],
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )
                    runtime_python = existing_runtime_python
                    runtime_python_version = existing_runtime_version
            elif (
                bootstrap_python_version is not None
                and (existing_runtime_version := read_python_version_info(existing_runtime_python)) is not None
                and existing_runtime_version[:2] != bootstrap_python_version[:2]
            ):
                print(
                    "Rebuilding the AI tools environment to match the selected Python "
                    f"{format_python_version(bootstrap_python_version)} runtime"
                )
                log_event(
                    "installer",
                    "creating_venv",
                    "venv_rebuild_required",
                    runtimeRoot=str(runtime_root),
                    runtimePython=str(existing_runtime_python),
                    runtimePythonVersion=format_python_version(existing_runtime_version),
                    bootstrapPython=str(bootstrap_python),
                    bootstrapPythonVersion=format_python_version(bootstrap_python_version),
                )
                emit(
                    "creating_venv",
                    0.18,
                    message="Rebuilding the AI tools environment for the selected Python version",
                    stepLabel="Rebuilding the AI tools environment for the selected Python version",
                    activityLines=[
                        f"Existing runtime uses Python {format_python_version(existing_runtime_version)}.",
                        f"Selected interpreter uses Python {format_python_version(bootstrap_python_version)}.",
                    ],
                    installSource=install_source,
                    requiresExternalPython=requires_external_python,
                    pythonDetected=python_detected,
                    buildRuntimeMode=build_runtime_mode,
                )
                try:
                    remove_tree_with_retries(runtime_root)
                except OSError as exc:
                    fail(
                        f"OpenStudio could not rebuild the managed runtime because '{runtime_root}' could not be removed: {exc}",
                        state="creating_venv",
                        progress=0.18,
                        error_code="runtime_rebuild_remove_failed",
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )
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
                runtime_python_version = read_python_version_info(runtime_python)
            else:
                reused_existing_runtime = True
                print("Reusing the existing AI tools environment")
                log_event(
                    "installer",
                    "creating_venv",
                    "venv_reused",
                    runtimeRoot=str(runtime_root),
                    runtimePython=str(existing_runtime_python),
                )
                emit(
                    "creating_venv",
                    0.2,
                    message="Reusing the AI tools environment",
                    stepLabel="Reusing the AI tools environment",
                    installSource=install_source,
                    requiresExternalPython=requires_external_python,
                    pythonDetected=python_detected,
                    buildRuntimeMode=build_runtime_mode,
                )
                runtime_python = existing_runtime_python
                runtime_python_version = read_python_version_info(runtime_python)
        else:
            try:
                remove_tree_with_retries(runtime_root)
            except OSError as exc:
                fail(
                    f"OpenStudio could not rebuild the managed runtime because '{runtime_root}' could not be removed: {exc}",
                    state="creating_venv",
                    progress=0.18,
                    error_code="runtime_rebuild_remove_failed",
                    installSource=install_source,
                    requiresExternalPython=requires_external_python,
                    pythonDetected=python_detected,
                    buildRuntimeMode=build_runtime_mode,
                )
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
            runtime_python_version = read_python_version_info(runtime_python)
    else:
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
        runtime_python_version = read_python_version_info(runtime_python)

    if reused_existing_runtime:
        ensure_runtime_pip(
            runtime_python,
            progress=0.27,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        site_packages = runtime_python.parent.parent / "Lib" / "site-packages"
        broken_entries: list[Path] = []
        for candidate_name in ("acestep", "ace_step-0.2.0.dist-info"):
            candidate = site_packages / candidate_name
            if candidate.is_dir():
                try:
                    is_empty = not any(candidate.iterdir())
                except OSError:
                    is_empty = False
                if is_empty:
                    broken_entries.append(candidate)

        if broken_entries:
            for broken_entry in broken_entries:
                shutil.rmtree(broken_entry, ignore_errors=True)
            repaired_names = ", ".join(path.name for path in broken_entries)
            print(f"Removed broken ACE-Step package entries: {repaired_names}")
            log_event(
                "installer",
                "installing",
                "broken_ace_step_package_removed",
                removedEntries=[str(path) for path in broken_entries],
            )
            emit(
                "installing",
                0.28,
                message="Repairing the ACE-Step package installation",
                stepLabel="Repairing the ACE-Step package installation",
                activityLines=[f"Removed broken ACE-Step package entries: {repaired_names}"],
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
            )

        if not is_music_generation_python_compatible(runtime_python_version):
            incompatible_entries: list[Path] = []
            for candidate in site_packages.glob("ace_step*.dist-info"):
                if candidate.is_dir():
                    incompatible_entries.append(candidate)
            legacy_package_dir = site_packages / "acestep"
            if legacy_package_dir.is_dir():
                incompatible_entries.append(legacy_package_dir)

            if incompatible_entries:
                for incompatible_entry in incompatible_entries:
                    shutil.rmtree(incompatible_entry, ignore_errors=True)
                removed_names = ", ".join(path.name for path in incompatible_entries)
                print(f"Removed incompatible ACE-Step package entries: {removed_names}")
                log_event(
                    "installer",
                    "installing",
                    "incompatible_ace_step_package_removed",
                    removedEntries=[str(path) for path in incompatible_entries],
                    runtimePythonVersion=format_python_version(runtime_python_version),
                )
                emit(
                    "installing",
                    0.29,
                    message="Removing incompatible ACE-Step runtime entries",
                    stepLabel="Removing incompatible ACE-Step runtime entries",
                    activityLines=[
                        f"Removed incompatible ACE-Step package entries: {removed_names}",
                        f"Music generation requires Python {MUSIC_GEN_REQUIRED_PYTHON[0]}.{MUSIC_GEN_REQUIRED_PYTHON[1]}.x; current runtime is Python {format_python_version(runtime_python_version)}.",
                    ],
                    installSource=install_source,
                    requiresExternalPython=requires_external_python,
                    pythonDetected=python_detected,
                    buildRuntimeMode=build_runtime_mode,
                )

        runtime_python, runtime_python_version, reused_existing_runtime = repair_windows_reused_runtime(
            runtime_python,
            runtime_root,
            bootstrap_python,
            runtime_python_version,
            bootstrap_python_version,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )

    ensure_runtime_pip(
        runtime_python,
        progress=0.34,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

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
        [
            str(runtime_python),
            "-m",
            "pip",
            "install",
            *get_requirement_specifiers(python_version=runtime_python_version),
        ],
        state="installing",
        progress=0.55,
        description="Installing AI audio packages",
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="dependency_bootstrap_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    if (
        platform.system() == "Windows"
        and is_music_generation_python_compatible(runtime_python_version)
        and is_windows_nvidia_machine()
    ):
        log_event(
            "installer",
            "installing",
            "windows_cuda_music_overlay_selected",
            runtimePython=str(runtime_python),
            runtimePythonVersion=format_python_version(runtime_python_version),
            pytorchIndexUrl=get_windows_cuda_pytorch_index_url(),
        )
        emit(
            "installing",
            0.57,
            message="Preparing CUDA acceleration for ACE-Step music generation",
            stepLabel="Preparing CUDA acceleration for ACE-Step music generation",
            activityLines=[
                "NVIDIA hardware detected on this Windows machine.",
                "Installing CUDA-capable PyTorch wheels for the ACE-Step runtime.",
            ],
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
        )
    music_generation_setup_error: InstallerStepError | None = None
    music_generation_requirements = get_music_generation_runtime_requirements(
        python_version=runtime_python_version
    )
    if music_generation_requirements:
        try:
            if (
                platform.system() == "Windows"
                and is_windows_nvidia_machine()
                and is_music_generation_python_compatible(runtime_python_version)
            ):
                apply_windows_cuda_pytorch_overlay(
                    runtime_python,
                    runtime_root,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                )
                install_windows_music_acceleration_stack(
                    runtime_python,
                    runtime_root,
                    state="installing",
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    raise_on_error=True,
                    error_code="music_acceleration_setup_failed",
                )

            run_step(
                [
                    str(runtime_python),
                    "-m",
                    "pip",
                    "install",
                    *music_generation_requirements,
                ],
                state="installing",
                progress=0.6,
                description="Installing ACE-Step 1.5 runtime dependencies",
                install_source=install_source,
                requires_external_python=requires_external_python,
                error_code="music_generation_runtime_install_failed",
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
                raise_on_error=True,
            )

            ace_step_source_root = download_music_generation_source(
                runtime_python,
                runtime_root,
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
                raise_on_error=True,
            )

            run_step(
                [
                    str(runtime_python),
                    "-m",
                    "pip",
                    "install",
                    "--no-deps",
                    str(ace_step_source_root),
                ],
                state="installing",
                progress=0.62,
                description="Installing the ACE-Step 1.5 split backend",
                install_source=install_source,
                requires_external_python=requires_external_python,
                error_code="music_generation_runtime_install_failed",
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
                raise_on_error=True,
            )
        except InstallerStepError as exc:
            music_generation_setup_error = exc
            log_event(
                "installer",
                "installing",
                "music_generation_setup_degraded",
                errorCode=exc.error_code,
                errorMessage=exc.message,
            )
            emit(
                "installing",
                0.63,
                message="Stem separation packages are ready, but music generation acceleration could not be fully installed",
                stepLabel="Continuing with stem separation only",
                activityLines=[
                    "OpenStudio will finish stem separation setup and then report music generation as incomplete.",
                    exc.message,
                ],
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
            )

    return runtime_python


def format_supported_python_range() -> str:
    if platform.system() == "Windows":
        return "Python 3.11"
    return "Python 3.10 through 3.12"


def download_model(
    runtime_python: Path,
    runtime_root: Path,
    models_dir: Path,
    model_name: str,
    *,
    backend_requested: str,
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
        stepLabel="Downloading the stem separation model",
        stepIndex=1,
        stepCount=1,
        downloadHint="The stem model download can take a while on slower connections.",
        isLargeDownload=True,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
    )
    recent_lines: deque[str] = deque(maxlen=12)
    completed_bytes = 0

    try:
        targets = resolve_model_download_plan(runtime_root, model_name, recent_lines)
        for file_index, target in enumerate(targets):
            target_path = models_dir / target["filename"]
            file_label = (
                "the stem separation checkpoint"
                if target_path.suffix.lower() in {".ckpt", ".onnx", ".pth", ".th"}
                else "the model configuration"
            )

            if target_path.exists() and target_path.is_file():
                existing_size = target_path.stat().st_size
                completed_bytes += existing_size
                append_activity_line(recent_lines, f"Using cached {target_path.name}")
                emit_model_download_status(
                    progress=_calculate_download_progress(file_index + 1, len(targets), 0.0),
                    message=f"Using cached {file_label}",
                    step_label=f"Using cached {file_label}",
                    activity_lines=list(recent_lines),
                    bytes_downloaded=completed_bytes,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                )
                continue

            completed_bytes += download_file_with_retries(
                urls=target["urls"],
                target_path=target_path,
                file_label=file_label,
                file_index=file_index,
                file_count=len(targets),
                recent_lines=recent_lines,
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
                completed_bytes=completed_bytes,
            )
    except ModelDownloadError as exc:
        log_event(
            "installer",
            "downloading_model",
            "model_download_failed",
            errorCode=exc.error_code,
            exceptionType=type(exc).__name__,
            exceptionMessage=exc.message,
        )
        fail(
            exc.message,
            progress=0.92,
            error_code=exc.error_code,
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
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


def download_music_gen_model(
    runtime_python: Path,
    music_gen_model: str,
    music_gen_checkpoint_root: Path,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    checkpoint_root = resolve_music_gen_checkpoint_root(str(music_gen_checkpoint_root))
    layout = get_music_generation_required_paths(
        checkpoint_root=str(checkpoint_root),
        model_name=music_gen_model,
    )
    runtime_profiles = get_music_runtime_profiles(str(checkpoint_root))
    native_profile = runtime_profiles["profiles"].get("native-xl-turbo", {})
    missing_profile_assets = list(native_profile.get("missingAssets", []))
    log_event(
        "installer",
        "downloading_model",
        "music_generation_prepare_start",
        musicGenModel=music_gen_model,
        musicGenCheckpointRoot=str(checkpoint_root),
        musicGenModelRepo=DEFAULT_MUSIC_GEN_MODEL_REPO,
        musicGenSharedRepo=DEFAULT_MUSIC_GEN_SHARED_REPO,
        musicGenerationAvailableProfiles=runtime_profiles.get("availableProfiles", []),
        musicGenerationMissingProfileAssets=missing_profile_assets,
    )

    checkpoint_root.mkdir(parents=True, exist_ok=True)

    if layout["layoutValid"] and not missing_profile_assets:
        emit(
            "downloading_model",
            0.97,
            message="Pinned ACE-Step music generation model and runtime profiles are already installed",
            stepLabel="Pinned ACE-Step music generation model and runtime profiles are already installed",
            stepIndex=1,
            stepCount=1,
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
            musicGenerationModelId=music_gen_model,
            musicGenerationCheckpointRoot=str(checkpoint_root),
            musicGenerationLayoutValid=True,
            musicGenerationAvailableProfiles=runtime_profiles.get("availableProfiles", []),
            musicGenerationDefaultProfile=runtime_profiles.get("defaultProfile", ""),
        )
        log_event(
            "installer",
            "downloading_model",
            "music_generation_prepare_skipped_existing",
            musicGenModel=music_gen_model,
            musicGenCheckpointRoot=str(checkpoint_root),
        )
        return

    hub_cache_dir = checkpoint_root.parent / MUSIC_GEN_HUB_CACHE_DIRNAME
    hub_cache_dir.mkdir(parents=True, exist_ok=True)

    shared_repo_download_lines = [
        "snapshot_download(",
        f"    repo_id=r'{DEFAULT_MUSIC_GEN_SHARED_REPO}',",
        "    local_dir=str(checkpoint_root),",
        "    cache_dir=str(hub_cache_dir),",
        "    local_dir_use_symlinks=False,",
    ]
    if missing_profile_assets:
        patterns = [
            f"{asset}/*" for asset in missing_profile_assets
        ] + [
            f"{asset}/**" for asset in missing_profile_assets
        ]
        shared_repo_download_lines.append(f"    allow_patterns={patterns!r},")
    shared_repo_download_lines.append(")")

    bootstrap_lines = [
        "from pathlib import Path",
        "from huggingface_hub import snapshot_download",
        f"checkpoint_root = Path(r'{checkpoint_root}')",
        f"hub_cache_dir = Path(r'{hub_cache_dir}')",
        "checkpoint_root.mkdir(parents=True, exist_ok=True)",
        "hub_cache_dir.mkdir(parents=True, exist_ok=True)",
        *shared_repo_download_lines,
    ]
    use_legacy_wrapper = str(os.environ.get("OPENSTUDIO_USE_LEGACY_ACE_WRAPPER", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if use_legacy_wrapper and not (checkpoint_root / music_gen_model).exists():
        bootstrap_lines.extend(
            [
                "snapshot_download(",
                f"    repo_id=r'{DEFAULT_MUSIC_GEN_MODEL_REPO}',",
                f"    local_dir=str(checkpoint_root / r'{music_gen_model}'),",
                "    cache_dir=str(hub_cache_dir),",
                "    local_dir_use_symlinks=False,",
                ")",
            ]
        )
    bootstrap_lines.append("print('ok')")
    bootstrap = "\n".join(bootstrap_lines)

    stream_step(
        [str(runtime_python), "-c", bootstrap],
        state="downloading_model",
        progress=0.97,
        description=(
            "Downloading the pinned ACE-Step XL Turbo model"
            if not missing_profile_assets
            else "Downloading the pinned ACE-Step fast runtime profile assets"
        ),
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="music_model_download_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        step_label=(
            "Downloading the pinned ACE-Step XL Turbo model"
            if not missing_profile_assets
            else "Downloading the pinned ACE-Step Native XL Turbo profile assets"
        ),
        step_index=1,
        step_count=1,
        download_hint=(
            "Downloading pinned ACE-Step repositories into the configured checkpoint root."
            if not missing_profile_assets
            else "Downloading the missing ACE-Step assets required for the Native XL Turbo profile."
        ),
        is_large_download=True,
    )

    layout = get_music_generation_required_paths(
        checkpoint_root=str(checkpoint_root),
        model_name=music_gen_model,
    )
    runtime_profiles = get_music_runtime_profiles(str(checkpoint_root))
    if not layout["layoutValid"]:
        fail(
            "OpenStudio could not verify the pinned ACE-Step checkpoint layout after download.",
            progress=0.97,
            error_code="music_model_download_failed",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
            musicGenerationModelId=music_gen_model,
            musicGenerationCheckpointRoot=str(checkpoint_root),
        )
    imported_profile_targets: list[str] = []
    native_asset_import = {
        "importedAssets": [],
        "searchedDirs": [],
        "foundSources": {},
        "missingAssets": [],
    }
    comfy_profile_import = {
        "importedTargets": [],
        "searchedDirs": [],
        "foundSources": {},
        "missingTargets": [],
        "error": "",
    }
    if "native-xl-turbo" not in runtime_profiles.get("availableProfiles", []):
        native_asset_import = hydrate_native_split_assets(checkpoint_root)
        imported_native_assets = list(native_asset_import.get("importedAssets", []))
        if imported_native_assets:
            emit(
                "downloading_model",
                0.972,
                message="Importing local ACE-Step split-model assets",
                stepLabel="Importing local ACE-Step split-model assets",
                stepIndex=1,
                stepCount=1,
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
                musicGenerationModelId=music_gen_model,
                musicGenerationCheckpointRoot=str(checkpoint_root),
                musicGenerationImportedNativeAssets=imported_native_assets,
            )
            log_event(
                "installer",
                "downloading_model",
                "music_generation_imported_native_assets",
                musicGenModel=music_gen_model,
                musicGenCheckpointRoot=str(checkpoint_root),
                importedAssets=imported_native_assets,
                searchedDirs=native_asset_import.get("searchedDirs", []),
                foundSources=native_asset_import.get("foundSources", {}),
            )

        runtime_profiles = get_music_runtime_profiles(str(checkpoint_root))

    if use_legacy_wrapper and not (checkpoint_root / "acestep-5Hz-lm-4B" / "model.safetensors").exists():
        comfy_profile_import = hydrate_comfy_runtime_profiles(checkpoint_root)
        imported_profile_targets = list(comfy_profile_import.get("importedTargets", []))
        if imported_profile_targets:
            emit(
                "downloading_model",
                0.975,
                message="Importing local legacy ACE runtime profile assets",
                stepLabel="Importing local legacy ACE runtime profile assets",
                stepIndex=1,
                stepCount=1,
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=python_detected,
                buildRuntimeMode=build_runtime_mode,
                musicGenerationModelId=music_gen_model,
                musicGenerationCheckpointRoot=str(checkpoint_root),
                musicGenerationImportedProfiles=imported_profile_targets,
            )
            log_event(
                "installer",
                "downloading_model",
                "music_generation_imported_local_profiles",
                musicGenModel=music_gen_model,
                musicGenCheckpointRoot=str(checkpoint_root),
                importedTargets=imported_profile_targets,
                searchedDirs=comfy_profile_import.get("searchedDirs", []),
                foundSources=comfy_profile_import.get("foundSources", {}),
            )
        elif comfy_profile_import.get("error"):
            log_event(
                "installer",
                "downloading_model",
                "music_generation_local_profile_import_skipped",
                musicGenModel=music_gen_model,
                musicGenCheckpointRoot=str(checkpoint_root),
                error=comfy_profile_import.get("error", ""),
                searchedDirs=comfy_profile_import.get("searchedDirs", []),
            )

        runtime_profiles = get_music_runtime_profiles(str(checkpoint_root))

    if "native-xl-turbo" not in runtime_profiles.get("availableProfiles", []):
        native_profile = runtime_profiles["profiles"].get("native-xl-turbo", {})
        missing_profile_assets = list(native_profile.get("missingAssets", []))
        searched_dirs = list(
            dict.fromkeys(
                list(native_asset_import.get("searchedDirs", []))
                + list(comfy_profile_import.get("searchedDirs", []))
            )
        )
        fail(
            "OpenStudio installed the ACE-Step split backend, but could not verify the Native XL Turbo split-model assets afterward. "
            + (
                "Still missing: " + ", ".join(missing_profile_assets) + ". "
                if missing_profile_assets
                else ""
            )
            + (
                "Looked for local ACE-Step model files in: " + ", ".join(searched_dirs) + "."
                if searched_dirs
                else "No local ACE-Step model directories were configured or discovered."
            ),
            progress=0.97,
            error_code="music_profile_assets_incomplete",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=python_detected,
            buildRuntimeMode=build_runtime_mode,
            musicGenerationModelId=music_gen_model,
            musicGenerationCheckpointRoot=str(checkpoint_root),
            musicGenerationAvailableProfiles=runtime_profiles.get("availableProfiles", []),
            musicGenerationDefaultProfile=runtime_profiles.get("defaultProfile", ""),
            musicGenerationMissingProfileAssets=missing_profile_assets,
            musicGenerationLocalProfileImportSearchedDirs=searched_dirs,
            musicGenerationLocalProfileImportFoundSources=found_sources,
        )

    log_event(
        "installer",
        "downloading_model",
        "music_generation_prepare_succeeded",
        musicGenModel=music_gen_model,
        musicGenCheckpointRoot=str(checkpoint_root),
        musicGenerationAvailableProfiles=runtime_profiles.get("availableProfiles", []),
        importedTargets=imported_profile_targets,
    )


def _assistant_status_payload(status: dict[str, Any]) -> dict[str, Any]:
    return {
        "assistantManifestAvailable": status.get("assistantManifestAvailable", False),
        "assistantRuntimeReady": status.get("assistantRuntimeReady", False),
        "assistantVerificationRequired": status.get("assistantVerificationRequired", True),
        "assistantDownloadPolicy": status.get("assistantDownloadPolicy", "single_verified_profile"),
        "assistantStatusMessage": status.get("assistantStatusMessage", ""),
        "assistantFailureCode": status.get("assistantFailureCode", ""),
        "assistantSelectedProfile": status.get("assistantSelectedProfile", ""),
        "assistantAttemptedProfile": status.get("assistantAttemptedProfile", ""),
        "assistantPrefilterProfile": status.get("assistantPrefilterProfile", ""),
        "assistantRuntimeProfiles": status.get("assistantRuntimeProfiles", {}),
        "assistantAvailableProfiles": status.get("assistantAvailableProfiles", []),
        "assistantPrefilterProfiles": status.get("assistantPrefilterProfiles", []),
        "assistantUnavailableProfiles": status.get("assistantUnavailableProfiles", []),
        "assistantVerifiedStatusPath": status.get("assistantVerifiedStatusPath", ""),
        "assistantHardware": status.get("assistantHardware", {}),
        "audioUnderstandingManifestAvailable": status.get("audioUnderstandingManifestAvailable", False),
        "audioUnderstandingRuntimeReady": status.get("audioUnderstandingRuntimeReady", False),
        "audioUnderstandingVerificationRequired": status.get("audioUnderstandingVerificationRequired", False),
        "audioUnderstandingDownloadPolicy": status.get("audioUnderstandingDownloadPolicy", "single_verified_profile"),
        "audioUnderstandingStatus": status.get("audioUnderstandingStatus", "not_installed"),
        "audioUnderstandingStatusMessage": status.get("audioUnderstandingStatusMessage", ""),
        "audioUnderstandingFailureCode": status.get("audioUnderstandingFailureCode", ""),
        "audioUnderstandingSelectedProfile": status.get("audioUnderstandingSelectedProfile", ""),
        "audioUnderstandingAttemptedProfile": status.get("audioUnderstandingAttemptedProfile", ""),
        "audioUnderstandingPrefilterProfile": status.get("audioUnderstandingPrefilterProfile", ""),
        "audioUnderstandingRuntimeProfiles": status.get("audioUnderstandingRuntimeProfiles", {}),
        "audioUnderstandingAvailableProfiles": status.get("audioUnderstandingAvailableProfiles", []),
        "audioUnderstandingPrefilterProfiles": status.get("audioUnderstandingPrefilterProfiles", []),
        "audioUnderstandingUnavailableProfiles": status.get("audioUnderstandingUnavailableProfiles", []),
        "audioUnderstandingVerifiedStatusPath": status.get("audioUnderstandingVerifiedStatusPath", ""),
    }


def _emit_assistant_status(
    status: dict[str, Any],
    *,
    progress: float,
    message: str,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    emit(
        "downloading_model",
        progress,
        message=message,
        stepLabel=message,
        stepIndex=1,
        stepCount=1,
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
        **_assistant_status_payload(status),
    )


def _assistant_verified_status_path(status: dict[str, Any]) -> Path:
    configured = os.environ.get(ASSISTANT_VERIFIED_STATUS_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    status_path = str(status.get("assistantVerifiedStatusPath", "")).strip()
    if status_path:
        return Path(status_path).expanduser().resolve()
    return (Path.home() / ".openstudio" / "assistant-runtime-status.json").resolve()


def _write_assistant_verified_status(
    status_path: Path,
    *,
    verified: bool,
    profile_id: str,
    profile: dict[str, Any],
    model_path: str,
    runtime_path: str,
    verification: dict[str, Any],
    error: str = "",
    failure_code: str = "",
) -> None:
    status_path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "verified": verified,
        "profileId": profile_id if verified else "",
        "attemptedProfileId": profile_id,
        "modelRepo": profile.get("modelRepo", ""),
        "modelRevision": profile.get("modelRevision", "main"),
        "runtimeFamily": profile.get("runtimeFamily", ""),
        "installScope": profile.get("installScope", "local"),
        "modelPath": model_path,
        "runtimePath": runtime_path,
        "verification": verification,
        "verifiedAt": utc_now_iso(),
    }
    if error:
        payload["error"] = error
    if failure_code:
        payload["failureCode"] = failure_code
    status_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")


def _assistant_model_asset_report(model_root: Path) -> dict[str, Any]:
    required_files = ("config.json", "tokenizer_config.json")
    missing = [name for name in required_files if not (model_root / name).exists()]
    weight_files = [
        str(path.relative_to(model_root))
        for pattern in ("*.safetensors", "*.bin", "*.gguf")
        for path in model_root.rglob(pattern)
    ]
    return {
        "modelRoot": str(model_root),
        "missingFiles": missing,
        "weightFileCount": len(weight_files),
        "sampleWeightFiles": weight_files[:8],
        "assetsPresent": not missing and bool(weight_files),
    }


def _write_assistant_smoke_wav(path: Path, *, duration_seconds: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = 16000
    amplitude = 0.2
    frequency = 440.0
    frame_count = sample_rate * max(1, duration_seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        frames = bytearray()
        for frame_index in range(frame_count):
            sample = int(32767 * amplitude * math.sin(2.0 * math.pi * frequency * frame_index / sample_rate))
            frames.extend(sample.to_bytes(2, byteorder="little", signed=True))
        handle.writeframes(bytes(frames))


def _assistant_verification_script(
    *,
    profile_id: str,
    profile: dict[str, Any],
    model_path: str,
    smoke_wav_path: str,
) -> str:
    prompt = (
        "Listen to the audio and return only strict JSON with this exact shape: "
        "{\"version\":1,\"summary\":\"runtime ok\",\"actions\":[{\"kind\":\"ai.getRuntimeStatus\",\"params\":{}}]}. "
        "Do not wrap it in markdown."
    )
    return f"""
from __future__ import annotations

import json
import os
from pathlib import Path

profile_id = {profile_id!r}
model_path = Path({model_path!r}).expanduser()
smoke_wav_path = Path({smoke_wav_path!r}).expanduser()
attention_backend = {str(profile.get("attentionBackend", "")).strip()!r}
flash_attention_required = {bool(profile.get("flashAttentionRequired", False))!r}
triton_required = {bool(profile.get("tritonRequired", False))!r}
required_files = ("config.json", "tokenizer_config.json")
missing = [name for name in required_files if not (model_path / name).exists()]
weight_files = [
    path for pattern in ("*.safetensors", "*.bin", "*.gguf")
    for path in model_path.rglob(pattern)
]
if missing or not weight_files:
    raise RuntimeError(
        "Assistant model assets are incomplete: "
        + json.dumps({{"missingFiles": missing, "weightFileCount": len(weight_files)}})
    )

sample_plan = {{
    "version": 1,
    "summary": "runtime ok",
    "actions": [
        {{"kind": "ai.getRuntimeStatus", "params": {{}}}},
    ],
}}
if sample_plan.get("version") != 1 or not isinstance(sample_plan.get("actions"), list):
    raise RuntimeError("Assistant action schema smoke test failed.")

if os.environ.get("OPENSTUDIO_ASSISTANT_ASSET_ONLY_VERIFY", "").strip().lower() in {{"1", "true", "yes", "on"}}:
    print(json.dumps({{
        "profileId": profile_id,
        "modelLoadVerified": False,
        "assetOnly": True,
        "schemaSmokeVerified": True,
        "modelPath": str(model_path),
    }}))
    raise SystemExit(0)

import torch
if flash_attention_required:
    import flash_attn  # noqa: F401
if triton_required:
    import triton  # noqa: F401
from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor

load_kwargs = {{
    "device_map": "auto",
    "torch_dtype": torch.bfloat16 if torch.cuda.is_available() else "auto",
    "enable_audio_output": False,
}}
if attention_backend:
    load_kwargs["attn_implementation"] = attention_backend
model = Qwen2_5OmniForConditionalGeneration.from_pretrained(str(model_path), **load_kwargs)
processor = Qwen2_5OmniProcessor.from_pretrained(str(model_path))
conversation = [
    {{
        "role": "system",
        "content": [
            {{
                "type": "text",
                "text": "You are OpenStudio's local DAW assistant. Return strict JSON action plans only.",
            }},
        ],
    }},
    {{
        "role": "user",
        "content": [
            {{"type": "audio", "path": str(smoke_wav_path)}},
            {{"type": "text", "text": {prompt!r}}},
        ],
    }},
]
inputs = processor.apply_chat_template(
    conversation,
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
    padding=True,
    use_audio_in_video=False,
)
target_device = getattr(getattr(model, "thinker", model), "device", getattr(model, "device", None))
if target_device is not None:
    inputs = inputs.to(target_device)
generated = model.generate(
    **inputs,
    use_audio_in_video=False,
    return_audio=False,
    thinker_max_new_tokens=96,
)
if isinstance(generated, tuple):
    generated = generated[0]
input_ids = inputs.get("input_ids") if hasattr(inputs, "get") else None
if input_ids is not None and hasattr(generated, "ndim") and generated.ndim == 2:
    prompt_token_count = int(input_ids.shape[-1])
    if generated.shape[-1] > prompt_token_count:
        generated = generated[:, prompt_token_count:]
decoded = processor.batch_decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False)
raw_text = "\\n".join(decoded).strip()
def extract_first_json_object(text):
    stripped = text.strip()
    candidates = [stripped]
    if "```" in stripped:
        parts = stripped.replace("```json", "```").split("```")
        if len(parts) >= 3:
            candidates.insert(0, parts[1].strip())
    decoder = json.JSONDecoder()
    last_error = None
    for candidate in candidates:
        start = candidate.find("{{")
        while start >= 0:
            try:
                value, _ = decoder.raw_decode(candidate[start:])
            except json.JSONDecodeError as exc:
                last_error = exc
                start = candidate.find("{{", start + 1)
                continue
            if not isinstance(value, dict):
                raise RuntimeError("Model returned JSON, but the root was not an object.")
            return value
    if last_error is not None:
        raise last_error
    raise RuntimeError("Model did not return a JSON object.")
plan = extract_first_json_object(raw_text)
actions = plan.get("actions")
if plan.get("version") != 1 or not isinstance(actions, list) or not actions:
    raise RuntimeError("Model did not return a valid OpenStudio assistant action plan.")
if actions[0].get("kind") != "ai.getRuntimeStatus":
    raise RuntimeError("Model action-plan smoke test returned an unexpected action.")
print(json.dumps({{
    "profileId": profile_id,
    "modelLoadVerified": True,
    "assetOnly": False,
    "schemaSmokeVerified": True,
    "modelPath": str(model_path),
    "responsePreview": raw_text[:500],
}}))
"""


def _run_assistant_local_step(
    command: list[str],
    *,
    description: str,
    progress: float,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
    cwd: Path | None = None,
) -> None:
    stream_step(
        command,
        state="downloading_model",
        progress=progress,
        description=description,
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="assistant_runtime_prepare_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=cwd,
        raise_on_error=True,
        step_label=description,
        step_index=1,
        step_count=1,
        download_hint="OpenStudio is preparing the selected local Qwen assistant profile.",
        is_large_download=True,
    )


def _current_platform_key() -> str:
    system = platform.system().lower()
    if system == "darwin":
        return "darwin"
    if system == "windows":
        return "windows"
    if system == "linux":
        return "linux"
    return system or "unknown"


def _assistant_torch_install_command(runtime_python: Path, profile: dict[str, Any]) -> list[str]:
    platform_key = _current_platform_key()
    packages = list(ASSISTANT_TORCH_PACKAGES_BY_PLATFORM.get(platform_key, ("torch", "torchvision", "torchaudio")))
    index_url = str(profile.get("torchIndexUrl", "")).strip()
    if index_url == "windows-acceleration-manifest":
        index_url = get_windows_cuda_pytorch_index_url()
    if not index_url:
        index_url = ASSISTANT_TORCH_INDEX_BY_PLATFORM.get(platform_key, "")
        if index_url == "windows-acceleration-manifest":
            index_url = get_windows_cuda_pytorch_index_url()

    command = [str(runtime_python), "-m", "pip", "install", "--upgrade", *packages]
    if index_url:
        command.extend(["--index-url", index_url])
    return command


def _assistant_runtime_packages(profile: dict[str, Any]) -> list[str]:
    packages = list(ASSISTANT_LOCAL_RUNTIME_PACKAGES)
    if _assistant_requires_autoawq(profile):
        packages.extend(ASSISTANT_AUTOAWQ_DEPENDENCY_PACKAGES)
    return packages


def _assistant_requires_autoawq(profile: dict[str, Any]) -> bool:
    return str(profile.get("quantization", "")).upper() == "AWQ"


def _prepare_local_assistant_quantization_runtime(
    runtime_python: Path,
    profile: dict[str, Any],
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    if not _assistant_requires_autoawq(profile):
        return

    _run_assistant_local_step(
        [
            str(runtime_python),
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--no-deps",
            ASSISTANT_AUTOAWQ_PACKAGE,
        ],
        description="Installing AutoAWQ for the Qwen assistant runtime",
        progress=0.981,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )


def _prepare_local_assistant_acceleration(
    runtime_python: Path,
    runtime_root: Path,
    profile: dict[str, Any],
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    platform_key = _current_platform_key()
    runtime_family = str(profile.get("runtimeFamily", ""))
    triton_enabled = bool(profile.get("tritonEnabled", profile.get("tritonRequired", False)))
    flash_enabled = bool(profile.get("flashAttentionEnabled", False))

    if platform_key == "windows" and "cuda" in runtime_family:
        if triton_enabled:
            _run_assistant_local_step(
                [str(runtime_python), "-m", "pip", "install", "--upgrade", get_windows_triton_package_spec()],
                description="Installing Triton for the Qwen assistant runtime",
                progress=0.979,
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
            )
        if flash_enabled and os.environ.get(ASSISTANT_WINDOWS_FLASH_ATTN_ENV, "").strip().lower() not in {"1", "true", "yes", "on"}:
            flash_attn_asset = get_windows_flash_attn_asset()
            install_pinned_wheel(
                runtime_python,
                runtime_root,
                wheel_url=str(flash_attn_asset.get("url", "")).strip(),
                wheel_sha256=str(flash_attn_asset.get("sha256", "")).strip(),
                wheel_filename=str(
                    flash_attn_asset.get("fileName")
                    or flash_attn_asset.get("filename")
                    or "flash_attn.whl"
                ),
                description="Installing Flash Attention for the Qwen assistant runtime",
                state="downloading_model",
                progress=0.98,
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
                step_label="Installing Flash Attention for the Qwen assistant",
                step_index=1,
                step_count=1,
                download_hint="OpenStudio is installing the pinned Windows Flash Attention wheel used by Qwen Omni.",
                is_large_download=True,
                raise_on_error=True,
                error_code="assistant_acceleration_setup_failed",
            )
        return

    if platform_key == "linux" and "cuda" in runtime_family:
        packages: list[str] = []
        if triton_enabled:
            packages.append("triton")
        if flash_enabled:
            packages.append("flash-attn")
        if packages:
            _run_assistant_local_step(
                [
                    str(runtime_python),
                    "-m",
                    "pip",
                    "install",
                    "--upgrade",
                    "--no-build-isolation",
                    *packages,
                ],
                description="Installing Qwen assistant attention acceleration packages",
                progress=0.98,
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
            )


def _prepare_local_assistant_profile(
    runtime_python: Path,
    runtime_root: Path,
    models_dir: Path,
    *,
    profile_id: str,
    profile: dict[str, Any],
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> dict[str, Any]:
    profile_root = models_dir / ASSISTANT_MODELS_DIRNAME / profile_id
    model_root = profile_root / "model"
    smoke_wav = profile_root / str(profile.get("audioSmokeTestFile", "assistant_smoke_10s.wav"))
    profile_root.mkdir(parents=True, exist_ok=True)
    _write_assistant_smoke_wav(
        smoke_wav,
        duration_seconds=int(profile.get("defaultAudioWindowSeconds", 10) or 10),
    )

    _run_assistant_local_step(
        _assistant_torch_install_command(runtime_python, profile),
        description="Installing the Qwen assistant CUDA tensor runtime",
        progress=0.978,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    _prepare_local_assistant_acceleration(
        runtime_python,
        runtime_root,
        profile,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    _run_assistant_local_step(
        [str(runtime_python), "-m", "pip", "install", "--upgrade", *_assistant_runtime_packages(profile)],
        description="Installing the Qwen assistant Python packages",
        progress=0.98,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    _prepare_local_assistant_quantization_runtime(
        runtime_python,
        profile,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    download_script = (
        "from pathlib import Path\n"
        "from huggingface_hub import snapshot_download\n"
        f"model_root = Path(r'{model_root}')\n"
        "model_root.mkdir(parents=True, exist_ok=True)\n"
        "snapshot_download(\n"
        f"    repo_id={str(profile.get('modelRepo', '')).strip()!r},\n"
        f"    revision={str(profile.get('modelRevision', 'main')).strip() or 'main'!r},\n"
        "    local_dir=str(model_root),\n"
        "    local_dir_use_symlinks=False,\n"
        ")\n"
        "print('downloaded:' + str(model_root))\n"
    )
    _run_assistant_local_step(
        [str(runtime_python), "-c", download_script],
        description=f"Downloading {profile.get('label', profile_id)}",
        progress=0.982,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    asset_report = _assistant_model_asset_report(model_root)
    verify_script = _assistant_verification_script(
        profile_id=profile_id,
        profile=profile,
        model_path=str(model_root),
        smoke_wav_path=str(smoke_wav),
    )
    _run_assistant_local_step(
        [str(runtime_python), "-c", verify_script],
        description=f"Verifying {profile.get('label', profile_id)}",
        progress=0.984,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=profile_root,
    )
    return {
        **asset_report,
        "runtimePath": str(runtime_python),
        "modelPath": str(model_root),
        "smokeWavPath": str(smoke_wav),
        "modelLoadVerified": os.environ.get("OPENSTUDIO_ASSISTANT_ASSET_ONLY_VERIFY", "").strip().lower() not in {"1", "true", "yes", "on"},
        "schemaSmokeVerified": True,
    }


def _audio_understanding_verified_status_path(status: dict[str, Any]) -> Path:
    configured = os.environ.get(AUDIO_UNDERSTANDING_STATUS_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    status_path = str(status.get("audioUnderstandingVerifiedStatusPath", "")).strip()
    if status_path:
        return Path(status_path).expanduser().resolve()
    return (Path.home() / ".openstudio" / "audio-understanding-runtime-status.json").resolve()


def _write_audio_understanding_verified_status(
    status_path: Path,
    *,
    verified: bool,
    profile_id: str,
    profile: dict[str, Any],
    model_path: str,
    runtime_path: str,
    verification: dict[str, Any],
    error: str = "",
    failure_code: str = "",
) -> None:
    status_path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "verified": verified,
        "profileId": profile_id if verified else "",
        "attemptedProfileId": profile_id,
        "modelRepo": profile.get("modelRepo", ""),
        "modelRevision": profile.get("modelRevision", "main"),
        "runtimeFamily": profile.get("runtimeFamily", ""),
        "installScope": profile.get("installScope", "local"),
        "modelPath": model_path,
        "runtimePath": runtime_path,
        "serviceScript": profile.get("serviceScript", ""),
        "license": profile.get("license", ""),
        "requiresLicenseAcceptance": bool(profile.get("requiresLicenseAcceptance", False)),
        "verification": verification,
        "verifiedAt": utc_now_iso(),
    }
    if error:
        payload["error"] = error
    if failure_code:
        payload["failureCode"] = failure_code
    status_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")


def _audio_understanding_verification_script(
    *,
    profile_id: str,
    profile: dict[str, Any],
    model_path: str,
    smoke_wav_path: str,
    service_script_path: str,
) -> str:
    prompt = str(
        profile.get("startupTestPrompt")
        or "Return strict JSON describing genre, tempo feel, instruments, vocals, production notes, and suggested DAW actions."
    )
    return f"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

profile_id = {profile_id!r}
model_path = Path({model_path!r}).expanduser()
smoke_wav_path = Path({smoke_wav_path!r}).expanduser()
service_script_path = Path({service_script_path!r}).expanduser()
required_files = ("config.json", "tokenizer_config.json")
missing = [name for name in required_files if not (model_path / name).exists()]
weight_files = [
    path for pattern in ("*.safetensors", "*.bin", "*.gguf")
    for path in model_path.rglob(pattern)
]
if missing or not weight_files:
    raise RuntimeError(
        "Audio analyzer model assets are incomplete: "
        + json.dumps({{"missingFiles": missing, "weightFileCount": len(weight_files)}})
    )
if not service_script_path.exists():
    raise RuntimeError("Audio analyzer service script is missing: " + str(service_script_path))
if not smoke_wav_path.exists():
    raise RuntimeError("Audio analyzer smoke WAV is missing: " + str(smoke_wav_path))

if os.environ.get("OPENSTUDIO_ASSISTANT_ASSET_ONLY_VERIFY", "").strip().lower() in {{"1", "true", "yes", "on"}}:
    print(json.dumps({{
        "profileId": profile_id,
        "modelLoadVerified": False,
        "assetOnly": True,
        "schemaSmokeVerified": True,
        "modelPath": str(model_path),
        "serviceScript": str(service_script_path),
    }}))
    raise SystemExit(0)

request = {{
    "schemaVersion": 1,
    "prompt": {prompt!r},
    "modelPath": str(model_path),
    "clip": {{
        "clipId": "assistant-smoke",
        "clipName": "Analyzer smoke test",
        "filePath": str(smoke_wav_path),
    }},
}}
with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
    json.dump(request, handle, ensure_ascii=True)
    request_path = handle.name
try:
    result = subprocess.run(
        [sys.executable, str(service_script_path), "--request", request_path],
        text=True,
        capture_output=True,
        timeout=240,
        check=False,
    )
finally:
    try:
        Path(request_path).unlink(missing_ok=True)
    except Exception:
        pass
output = (result.stdout or "") + "\\n" + (result.stderr or "")
if result.returncode != 0:
    raise RuntimeError("Audio analyzer service failed: " + output.strip()[:1200])
decoder = json.JSONDecoder()
parsed = None
start = output.find("{{")
while start >= 0:
    try:
        value, _ = decoder.raw_decode(output[start:])
    except json.JSONDecodeError:
        start = output.find("{{", start + 1)
        continue
    if isinstance(value, dict):
        parsed = value
        break
    start = output.find("{{", start + 1)
if not isinstance(parsed, dict) or not parsed.get("ok"):
    raise RuntimeError("Audio analyzer did not return an ok JSON object: " + output.strip()[:1200])
summary = parsed.get("summary") if isinstance(parsed.get("summary"), dict) else parsed
if not isinstance(summary, dict) or not str(summary.get("promptReadySummary") or "").strip():
    raise RuntimeError("Audio analyzer smoke test did not return a prompt-ready summary.")
print(json.dumps({{
    "profileId": profile_id,
    "modelLoadVerified": True,
    "assetOnly": False,
    "schemaSmokeVerified": True,
    "modelPath": str(model_path),
    "serviceScript": str(service_script_path),
    "responsePreview": output.strip()[:500],
}}))
"""


def _prepare_local_audio_understanding_profile(
    runtime_python: Path,
    runtime_root: Path,
    models_dir: Path,
    *,
    profile_id: str,
    profile: dict[str, Any],
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> dict[str, Any]:
    profile_root = models_dir / ANALYZER_MODELS_DIRNAME / profile_id
    model_root = profile_root / "model"
    smoke_wav = profile_root / str(profile.get("audioSmokeTestFile", "assistant_smoke_10s.wav"))
    profile_root.mkdir(parents=True, exist_ok=True)
    _write_assistant_smoke_wav(
        smoke_wav,
        duration_seconds=int(profile.get("defaultAudioWindowSeconds", 10) or 10),
    )

    _run_assistant_local_step(
        _assistant_torch_install_command(runtime_python, profile),
        description="Installing the core music analyzer CUDA tensor runtime",
        progress=0.987,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    _prepare_local_assistant_acceleration(
        runtime_python,
        runtime_root,
        profile,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    _run_assistant_local_step(
        [str(runtime_python), "-m", "pip", "install", "--upgrade", *ANALYZER_LOCAL_RUNTIME_PACKAGES],
        description="Installing the core music analyzer Python packages",
        progress=0.988,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    download_script = (
        "from pathlib import Path\n"
        "from huggingface_hub import snapshot_download\n"
        f"model_root = Path(r'{model_root}')\n"
        "model_root.mkdir(parents=True, exist_ok=True)\n"
        "snapshot_download(\n"
        f"    repo_id={str(profile.get('modelRepo', '')).strip()!r},\n"
        f"    revision={str(profile.get('modelRevision', 'main')).strip() or 'main'!r},\n"
        "    local_dir=str(model_root),\n"
        "    local_dir_use_symlinks=False,\n"
        ")\n"
        "print('downloaded:' + str(model_root))\n"
    )
    _run_assistant_local_step(
        [str(runtime_python), "-c", download_script],
        description=f"Downloading {profile.get('label', profile_id)}",
        progress=0.989,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    service_script = str(profile.get("serviceScript", "")).strip()
    service_path = Path(__file__).resolve().with_name(service_script)
    asset_report = _assistant_model_asset_report(model_root)
    verify_script = _audio_understanding_verification_script(
        profile_id=profile_id,
        profile=profile,
        model_path=str(model_root),
        smoke_wav_path=str(smoke_wav),
        service_script_path=str(service_path),
    )
    _run_assistant_local_step(
        [str(runtime_python), "-c", verify_script],
        description=f"Verifying {profile.get('label', profile_id)}",
        progress=0.99,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        cwd=profile_root,
    )
    return {
        **asset_report,
        "runtimePath": str(runtime_python),
        "modelPath": str(model_root),
        "smokeWavPath": str(smoke_wav),
        "serviceScript": str(service_path),
        "modelLoadVerified": os.environ.get("OPENSTUDIO_ASSISTANT_ASSET_ONLY_VERIFY", "").strip().lower() not in {"1", "true", "yes", "on"},
        "schemaSmokeVerified": True,
    }


def prepare_audio_understanding_runtime(
    runtime_python: Path,
    runtime_root: Path,
    models_dir: Path,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> dict[str, Any]:
    status = get_assistant_runtime_status()
    if bool(status.get("audioUnderstandingRuntimeReady")):
        _emit_assistant_status(
            status,
            progress=0.99,
            message=str(status.get("audioUnderstandingStatusMessage", "Core music analyzer is already verified.")),
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        return status

    profiles = status.get("audioUnderstandingRuntimeProfiles", {})
    if not isinstance(profiles, dict):
        profiles = {}

    profile_ids: list[str] = []
    preferred_profile = str(status.get("audioUnderstandingPrefilterProfile", "")).strip()
    if preferred_profile:
        profile_ids.append(preferred_profile)
    prefilter_profiles = status.get("audioUnderstandingPrefilterProfiles", [])
    if isinstance(prefilter_profiles, list):
        for candidate in prefilter_profiles:
            candidate_id = str(candidate).strip()
            if candidate_id and candidate_id not in profile_ids:
                profile_ids.append(candidate_id)

    if not profile_ids:
        _emit_assistant_status(
            status,
            progress=0.99,
            message=str(status.get("audioUnderstandingStatusMessage", "No core music analyzer profile passed the local hardware prefilter.")),
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        return status

    download_policy = str(status.get("audioUnderstandingDownloadPolicy", "single_verified_profile"))
    status_path = _audio_understanding_verified_status_path(status)
    if download_policy != "single_verified_profile":
        message = f"Unsupported core music analyzer download policy: {download_policy}."
        profile_id = profile_ids[0]
        profile = dict(profiles.get(profile_id, {}))
        _write_audio_understanding_verified_status(
            status_path,
            verified=False,
            profile_id=profile_id,
            profile=profile,
            model_path="",
            runtime_path="",
            verification={},
            error=message,
            failure_code="audio_understanding_download_policy_unsupported",
        )
        refreshed = get_assistant_runtime_status()
        _emit_assistant_status(
            refreshed,
            progress=0.99,
            message=message,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        return refreshed

    last_refreshed = status
    last_message = str(status.get("audioUnderstandingStatusMessage", "No core music analyzer profile could be verified."))
    last_failure_code = "audio_understanding_runtime_prepare_failed"

    for profile_index, profile_id in enumerate(profile_ids):
        profile = dict(profiles.get(profile_id, {}))
        if not profile:
            last_message = f"Core music analyzer profile {profile_id} is not present in the manifest."
            last_failure_code = "audio_understanding_profile_missing"
            continue

        log_event(
            "installer",
            "downloading_model",
            "audio_understanding_prepare_start",
            profileId=profile_id,
            profileIndex=profile_index,
            profileCount=len(profile_ids),
            modelRepo=profile.get("modelRepo", ""),
            runtimeFamily=profile.get("runtimeFamily", ""),
        )
        try:
            if str(profile.get("installScope", "local")) != "local":
                raise RuntimeError("Only local core music analyzer profiles are implemented in this release.")
            verification = _prepare_local_audio_understanding_profile(
                runtime_python,
                runtime_root,
                models_dir,
                profile_id=profile_id,
                profile=profile,
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
            )
            _write_audio_understanding_verified_status(
                status_path,
                verified=True,
                profile_id=profile_id,
                profile=profile,
                model_path=str(verification.get("modelPath", "")),
                runtime_path=str(verification.get("runtimePath", "")),
                verification=verification,
            )
            refreshed = get_assistant_runtime_status()
            _emit_assistant_status(
                refreshed,
                progress=0.991,
                message=str(refreshed.get("audioUnderstandingStatusMessage", "Core music analyzer verified.")),
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
            )
            log_event(
                "installer",
                "downloading_model",
                "audio_understanding_prepare_succeeded",
                profileId=profile_id,
                statusPath=str(status_path),
                modelPath=verification.get("modelPath", ""),
            )
            return refreshed
        except InstallerStepError as exc:
            last_message = exc.message
            last_failure_code = exc.error_code
        except Exception as exc:
            last_message = f"{type(exc).__name__}: {exc}"
            last_failure_code = "audio_understanding_runtime_prepare_failed"

        _write_audio_understanding_verified_status(
            status_path,
            verified=False,
            profile_id=profile_id,
            profile=profile,
            model_path="",
            runtime_path="",
            verification={},
            error=last_message,
            failure_code=last_failure_code,
        )
        last_refreshed = get_assistant_runtime_status()
        remaining_profiles = len(profile_ids) - profile_index - 1
        retry_suffix = f" Trying the next core analyzer profile ({remaining_profiles} remaining)." if remaining_profiles > 0 else ""
        _emit_assistant_status(
            last_refreshed,
            progress=0.991,
            message=str(last_refreshed.get("audioUnderstandingStatusMessage", last_message)) + retry_suffix,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        log_event(
            "installer",
            "downloading_model",
            "audio_understanding_prepare_failed",
            profileId=profile_id,
            profileIndex=profile_index,
            profileCount=len(profile_ids),
            willTryNext=remaining_profiles > 0,
            errorCode=last_failure_code,
            errorMessage=last_message,
        )

    _emit_assistant_status(
        last_refreshed,
        progress=0.991,
        message=str(last_refreshed.get("audioUnderstandingStatusMessage", last_message)),
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    return last_refreshed


def _run_wsl_script(
    script: str,
    *,
    description: str,
    progress: float,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> None:
    stream_step(
        ["wsl.exe", "-e", "sh", "-lc", script],
        state="downloading_model",
        progress=progress,
        description=description,
        install_source=install_source,
        requires_external_python=requires_external_python,
        error_code="assistant_runtime_prepare_failed",
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
        raise_on_error=True,
        step_label=description,
        step_index=1,
        step_count=1,
        download_hint="OpenStudio is preparing the selected Qwen assistant profile inside WSL.",
        is_large_download=True,
    )


def _prepare_wsl_assistant_profile(
    *,
    profile_id: str,
    profile: dict[str, Any],
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> dict[str, Any]:
    runtime_root_shell = f"$HOME/.openstudio/assistant-runtimes/{profile_id}"
    model_root_shell = f"$HOME/.openstudio/assistant-models/{profile_id}/model"
    smoke_wav_shell = f"$HOME/.openstudio/assistant-models/{profile_id}/{profile.get('audioSmokeTestFile', 'assistant_smoke_10s.wav')}"
    runtime_root_py = f"~/.openstudio/assistant-runtimes/{profile_id}"
    model_root_py = f"~/.openstudio/assistant-models/{profile_id}/model"
    smoke_wav_py = f"~/.openstudio/assistant-models/{profile_id}/{profile.get('audioSmokeTestFile', 'assistant_smoke_10s.wav')}"
    torch_packages = " ".join(shlex.quote(package) for package in ASSISTANT_TORCH_PACKAGES_BY_PLATFORM["linux"])
    local_packages = " ".join(shlex.quote(package) for package in _assistant_runtime_packages(profile))
    autoawq_install = (
        f'"$runtime_root/venv/bin/python" -m pip install --upgrade --no-deps {shlex.quote(ASSISTANT_AUTOAWQ_PACKAGE)}'
        if _assistant_requires_autoawq(profile)
        else ":"
    )
    torch_index_url = shlex.quote(get_windows_cuda_pytorch_index_url())

    setup_script = f"""
set -e
runtime_root="{runtime_root_shell}"
python3 -m venv "$runtime_root/venv"
"$runtime_root/venv/bin/python" -m pip install --upgrade pip wheel setuptools
"$runtime_root/venv/bin/python" -m pip install --upgrade {torch_packages} --index-url {torch_index_url}
"$runtime_root/venv/bin/python" -m pip install --upgrade {local_packages}
{autoawq_install}
"""
    _run_wsl_script(
        setup_script,
        description="Preparing the Qwen assistant WSL runtime",
        progress=0.978,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    download_script = f"""
set -e
runtime_root="{runtime_root_shell}"
model_root="{model_root_shell}"
"$runtime_root/venv/bin/python" - <<'PY'
from pathlib import Path
from huggingface_hub import snapshot_download
model_root = Path({model_root_py!r}).expanduser()
model_root.mkdir(parents=True, exist_ok=True)
snapshot_download(
    repo_id={str(profile.get('modelRepo', '')).strip()!r},
    revision={str(profile.get('modelRevision', 'main')).strip() or 'main'!r},
    local_dir=str(model_root),
    local_dir_use_symlinks=False,
)
print("downloaded:" + str(model_root))
PY
"""
    _run_wsl_script(
        download_script,
        description=f"Downloading {profile.get('label', profile_id)} inside WSL",
        progress=0.982,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    verify_body = _assistant_verification_script(
        profile_id=profile_id,
        profile=profile,
        model_path=model_root_py,
        smoke_wav_path=smoke_wav_py,
    )
    verify_script = f"""
set -e
runtime_root="{runtime_root_shell}"
smoke_wav="{smoke_wav_shell}"
mkdir -p "$(dirname "$smoke_wav")"
"$runtime_root/venv/bin/python" - <<'PY'
from pathlib import Path
import math
import wave
path = Path({smoke_wav_py!r}).expanduser()
path.parent.mkdir(parents=True, exist_ok=True)
sample_rate = 16000
frame_count = sample_rate * {int(profile.get('defaultAudioWindowSeconds', 10) or 10)}
frames = bytearray()
for frame_index in range(frame_count):
    sample = int(32767 * 0.2 * math.sin(2.0 * math.pi * 440.0 * frame_index / sample_rate))
    frames.extend(sample.to_bytes(2, byteorder="little", signed=True))
with wave.open(str(path), "wb") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(sample_rate)
    handle.writeframes(bytes(frames))
PY
"$runtime_root/venv/bin/python" - <<'PY'
{verify_body}
PY
"""
    _run_wsl_script(
        verify_script,
        description=f"Verifying {profile.get('label', profile_id)} inside WSL",
        progress=0.984,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    return {
        "runtimePath": f"{runtime_root_py}/venv/bin/python",
        "modelPath": model_root_py,
        "smokeWavPath": smoke_wav_py,
        "assetsPresent": True,
        "modelLoadVerified": os.environ.get("OPENSTUDIO_ASSISTANT_ASSET_ONLY_VERIFY", "").strip().lower() not in {"1", "true", "yes", "on"},
        "schemaSmokeVerified": True,
    }


def prepare_assistant_runtime(
    runtime_python: Path,
    runtime_root: Path,
    models_dir: Path,
    *,
    install_source: str,
    requires_external_python: bool,
    python_detected: bool,
    build_runtime_mode: str,
) -> dict[str, Any]:
    status = get_assistant_runtime_status()
    if bool(status.get("assistantRuntimeReady")):
        _emit_assistant_status(
            status,
            progress=0.984,
            message=str(status.get("assistantStatusMessage", "Assistant runtime is already verified.")),
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        return status

    profiles = status.get("assistantRuntimeProfiles", {})
    if not isinstance(profiles, dict):
        profiles = {}

    profile_ids: list[str] = []
    preferred_profile = str(status.get("assistantPrefilterProfile", "")).strip()
    if preferred_profile:
        profile_ids.append(preferred_profile)
    prefilter_profiles = status.get("assistantPrefilterProfiles", [])
    if isinstance(prefilter_profiles, list):
        for candidate in prefilter_profiles:
            candidate_id = str(candidate).strip()
            if candidate_id and candidate_id not in profile_ids:
                profile_ids.append(candidate_id)

    if not profile_ids:
        _emit_assistant_status(
            status,
            progress=0.984,
            message=str(status.get("assistantStatusMessage", "No assistant runtime profile passed the local hardware prefilter.")),
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        return status

    download_policy = str(status.get("assistantDownloadPolicy", "single_verified_profile"))
    if download_policy != "single_verified_profile":
        message = f"Unsupported assistant download policy: {download_policy}."
        status_path = _assistant_verified_status_path(status)
        profile_id = profile_ids[0]
        profile = dict(profiles.get(profile_id, {}))
        _write_assistant_verified_status(
            status_path,
            verified=False,
            profile_id=profile_id,
            profile=profile,
            model_path="",
            runtime_path="",
            verification={},
            error=message,
            failure_code="assistant_download_policy_unsupported",
        )
        refreshed = get_assistant_runtime_status()
        _emit_assistant_status(
            refreshed,
            progress=0.984,
            message=message,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        return refreshed

    status_path = _assistant_verified_status_path(status)
    last_refreshed = status
    last_message = str(status.get("assistantStatusMessage", "No assistant runtime profile could be verified."))
    last_failure_code = "assistant_runtime_prepare_failed"

    for profile_index, profile_id in enumerate(profile_ids):
        profile = dict(profiles.get(profile_id, {}))
        if not profile:
            last_message = f"Assistant runtime profile {profile_id} is not present in the manifest."
            last_failure_code = "assistant_profile_missing"
            log_event(
                "installer",
                "downloading_model",
                "assistant_prepare_skipped",
                profileId=profile_id,
                reason=last_message,
            )
            continue

        log_event(
            "installer",
            "downloading_model",
            "assistant_prepare_start",
            profileId=profile_id,
            profileIndex=profile_index,
            profileCount=len(profile_ids),
            modelRepo=profile.get("modelRepo", ""),
            runtimeFamily=profile.get("runtimeFamily", ""),
            installScope=profile.get("installScope", "local"),
        )
        try:
            install_scope = str(profile.get("installScope", "local"))
            if install_scope == "wsl":
                verification = _prepare_wsl_assistant_profile(
                    profile_id=profile_id,
                    profile=profile,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                )
            else:
                verification = _prepare_local_assistant_profile(
                    runtime_python,
                    runtime_root,
                    models_dir,
                    profile_id=profile_id,
                    profile=profile,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                )
            _write_assistant_verified_status(
                status_path,
                verified=True,
                profile_id=profile_id,
                profile=profile,
                model_path=str(verification.get("modelPath", "")),
                runtime_path=str(verification.get("runtimePath", "")),
                verification=verification,
            )
            refreshed = get_assistant_runtime_status()
            _emit_assistant_status(
                refreshed,
                progress=0.986,
                message=str(refreshed.get("assistantStatusMessage", "Assistant runtime verified.")),
                install_source=install_source,
                requires_external_python=requires_external_python,
                python_detected=python_detected,
                build_runtime_mode=build_runtime_mode,
            )
            log_event(
                "installer",
                "downloading_model",
                "assistant_prepare_succeeded",
                profileId=profile_id,
                statusPath=str(status_path),
                modelPath=verification.get("modelPath", ""),
            )
            return refreshed
        except InstallerStepError as exc:
            last_message = exc.message
            last_failure_code = exc.error_code
        except Exception as exc:
            last_message = f"{type(exc).__name__}: {exc}"
            last_failure_code = "assistant_runtime_prepare_failed"

        _write_assistant_verified_status(
            status_path,
            verified=False,
            profile_id=profile_id,
            profile=profile,
            model_path="",
            runtime_path="",
            verification={},
            error=last_message,
            failure_code=last_failure_code,
        )
        last_refreshed = get_assistant_runtime_status()
        remaining_profiles = len(profile_ids) - profile_index - 1
        retry_suffix = f" Trying the next hardware-passing profile ({remaining_profiles} remaining)." if remaining_profiles > 0 else ""
        _emit_assistant_status(
            last_refreshed,
            progress=0.986,
            message=str(last_refreshed.get("assistantStatusMessage", last_message)) + retry_suffix,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        log_event(
            "installer",
            "downloading_model",
            "assistant_prepare_failed",
            profileId=profile_id,
            profileIndex=profile_index,
            profileCount=len(profile_ids),
            willTryNext=remaining_profiles > 0,
            errorCode=last_failure_code,
            errorMessage=last_message,
        )

    if last_refreshed is status and last_message:
        _write_assistant_verified_status(
            status_path,
            verified=False,
            profile_id=profile_ids[-1],
            profile={},
            model_path="",
            runtime_path="",
            verification={},
            error=last_message,
            failure_code=last_failure_code,
        )
        last_refreshed = get_assistant_runtime_status()

    _emit_assistant_status(
        last_refreshed,
        progress=0.986,
        message=str(last_refreshed.get("assistantStatusMessage", last_message)),
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )
    return last_refreshed


def main() -> None:
    global LOG_PATH, SESSION_ID, RUNTIME_CANDIDATE, FALLBACK_ATTEMPTED
    global START_TIME_MONOTONIC

    parser = argparse.ArgumentParser(description="Install OpenStudio AI tools")
    parser.add_argument("--runtime-root", required=True, help="Directory for the prepared AI runtime")
    parser.add_argument("--models-dir", required=True, help="Directory where stem-separation models should be stored")
    parser.add_argument("--model", default=DEFAULT_MODEL_NAME, help="Stem-separation model filename")
    parser.add_argument("--music-gen-model", default=DEFAULT_MUSIC_GEN_MODEL, help="Music-generation model identifier")
    parser.add_argument("--music-gen-checkpoint-root", default="", help="Pinned ACE-Step checkpoint root")
    parser.add_argument("--bootstrap-with", help="Python executable to use for dev fallback bootstrapping")
    parser.add_argument("--verify-existing-runtime", action="store_true", help="Verify the already-prepared OpenStudio runtime and download the model")
    parser.add_argument("--log-path", help="Detailed installer log file path")
    parser.add_argument("--session-id", default="", help="Install session id for correlated logging")
    parser.add_argument("--runtime-candidate", default="", help="Selected runtime candidate identity")
    parser.add_argument("--fallback-attempted", action="store_true", help="True when this install is using a fallback runtime candidate")
    parser.add_argument("--backend-requested", default="", help="Requested backend overlay identity for Windows base runtimes")
    parser.add_argument("--backend-install-plan", default="", help="Path to a JSON backend install plan")
    args = parser.parse_args()

    runtime_root = Path(args.runtime_root).expanduser().resolve()
    models_dir = Path(args.models_dir).expanduser().resolve()
    music_gen_checkpoint_root = resolve_music_gen_checkpoint_root(args.music_gen_checkpoint_root)
    bootstrap_python = Path(args.bootstrap_with).expanduser().resolve() if args.bootstrap_with else None
    LOG_PATH = Path(args.log_path).expanduser().resolve() if args.log_path else None
    SESSION_ID = args.session_id
    RUNTIME_CANDIDATE = args.runtime_candidate
    FALLBACK_ATTEMPTED = bool(args.fallback_attempted)
    START_TIME_MONOTONIC = time.monotonic()

    if LOG_PATH is not None:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOG_PATH.write_text("", encoding="utf-8")

    write_log(f"OpenStudio AI tools installer started on {platform.platform()}")
    write_log(f"sys.executable={sys.executable}")
    write_log(f"runtime_root={runtime_root}")
    write_log(f"models_dir={models_dir}")
    write_log(f"music_gen_checkpoint_root={music_gen_checkpoint_root}")
    write_log(f"music_gen_model={args.music_gen_model}")
    if SESSION_ID:
        write_log(f"sessionId={SESSION_ID}")
    if RUNTIME_CANDIDATE:
        write_log(f"runtimeCandidate={RUNTIME_CANDIDATE}")
    write_log(f"fallbackAttempted={FALLBACK_ATTEMPTED}")
    if args.backend_requested:
        write_log(f"backendRequested={args.backend_requested}")
    if args.backend_install_plan:
        write_log(f"backendInstallPlan={args.backend_install_plan}")
    log_event(
        "installer",
        "startup",
        "installer_started",
        pythonExecutable=sys.executable,
        runtimeRoot=str(runtime_root),
        modelsDir=str(models_dir),
        musicGenCheckpointRoot=str(music_gen_checkpoint_root),
        musicGenModel=args.music_gen_model,
        verifyExistingRuntime=bool(args.verify_existing_runtime),
        backendRequested=args.backend_requested,
        backendInstallPlan=args.backend_install_plan,
    )

    runtime_root.parent.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)
    effective_backend_requested = args.backend_requested.strip()

    if args.verify_existing_runtime:
        install_source = "downloadedRuntime"
        requires_external_python = False
        python_detected = False
        build_runtime_mode = "downloaded-runtime"
        runtime_python = resolve_runtime_python(runtime_root)
        backend_install_plan = None
        backend_requested = args.backend_requested.strip()
        effective_backend_requested = backend_requested
        if args.backend_install_plan:
            backend_install_plan = load_backend_install_plan(Path(args.backend_install_plan).expanduser().resolve())
        verify_runtime(
            runtime_python,
            runtime_root,
            require_audio_separator=backend_install_plan is None,
            require_music_generation=False,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=python_detected,
            build_runtime_mode=build_runtime_mode,
        )
        if backend_install_plan is not None:
            effective_backend_requested = backend_requested or str(backend_install_plan.get("backend", "")).strip() or "cpu"
            try:
                apply_backend_install_plan(
                    runtime_python,
                    runtime_root,
                    backend_install_plan,
                    backend_requested=effective_backend_requested,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                )
                verify_runtime(
                    runtime_python,
                    runtime_root,
                    require_audio_separator=True,
                    require_music_generation=False,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    raise_on_error=True,
                )
                probe_runtime(
                    runtime_python,
                    runtime_root,
                    models_dir,
                    args.model,
                    acceleration_mode="auto",
                    music_checkpoint_root=music_gen_checkpoint_root,
                    music_model_id=args.music_gen_model,
                    backend_requested=effective_backend_requested,
                    install_source=install_source,
                    requires_external_python=requires_external_python,
                    python_detected=python_detected,
                    build_runtime_mode=build_runtime_mode,
                    raise_on_error=True,
                )
            except InstallerStepError as primary_exc:
                fallback_plan = resolve_fallback_backend_install_plan(runtime_root, effective_backend_requested)
                if fallback_plan is None or FALLBACK_ATTEMPTED:
                    fail(
                        primary_exc.message,
                        progress=primary_exc.progress,
                        error_code=primary_exc.error_code,
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
                    )

                fallback_backend_requested, fallback_backend_install_plan = fallback_plan
                failed_backend_requested = effective_backend_requested
                FALLBACK_ATTEMPTED = True
                effective_backend_requested = fallback_backend_requested
                write_log(f"fallbackAttempted={FALLBACK_ATTEMPTED}")
                write_log(f"backendRequested={effective_backend_requested}")
                log_event(
                    "installer",
                    "installing_backend",
                    "backend_fallback_started",
                    failedBackend=failed_backend_requested,
                    fallbackBackend=fallback_backend_requested,
                    previousErrorCode=primary_exc.error_code,
                    previousErrorMessage=primary_exc.message,
                )
                emit(
                    "installing_backend",
                    0.74,
                    message=f"Falling back to the {fallback_backend_requested} AI backend",
                    backendRequested=fallback_backend_requested,
                    terminalReason="backend_fallback_started",
                    installSource=install_source,
                    requiresExternalPython=requires_external_python,
                    pythonDetected=python_detected,
                    buildRuntimeMode=build_runtime_mode,
                )

                try:
                    apply_backend_install_plan(
                        runtime_python,
                        runtime_root,
                        fallback_backend_install_plan,
                        backend_requested=fallback_backend_requested,
                        install_source=install_source,
                        requires_external_python=requires_external_python,
                        python_detected=python_detected,
                        build_runtime_mode=build_runtime_mode,
                    )
                    verify_runtime(
                        runtime_python,
                        runtime_root,
                        require_audio_separator=True,
                        require_music_generation=False,
                        install_source=install_source,
                        requires_external_python=requires_external_python,
                        python_detected=python_detected,
                        build_runtime_mode=build_runtime_mode,
                        raise_on_error=True,
                    )
                    probe_runtime(
                        runtime_python,
                        runtime_root,
                        models_dir,
                        args.model,
                        acceleration_mode="auto",
                        music_checkpoint_root=music_gen_checkpoint_root,
                        music_model_id=args.music_gen_model,
                        backend_requested=fallback_backend_requested,
                        install_source=install_source,
                        requires_external_python=requires_external_python,
                        python_detected=python_detected,
                        build_runtime_mode=build_runtime_mode,
                        raise_on_error=True,
                    )
                    log_event(
                        "installer",
                        "installing_backend",
                        "backend_fallback_succeeded",
                        backendRequested=fallback_backend_requested,
                    )
                except InstallerStepError as fallback_exc:
                    log_event(
                        "installer",
                        "installing_backend",
                        "backend_fallback_failed",
                        backendRequested=fallback_backend_requested,
                        errorCode=fallback_exc.error_code,
                        errorMessage=fallback_exc.message,
                    )
                    fail(
                        fallback_exc.message,
                        progress=fallback_exc.progress,
                        error_code="backend_fallback_exhausted",
                        installSource=install_source,
                        requiresExternalPython=requires_external_python,
                        pythonDetected=python_detected,
                        buildRuntimeMode=build_runtime_mode,
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

        bootstrap_python_version = read_python_version_info(bootstrap_python)
        if (
            bootstrap_python_version is not None
            and (
                bootstrap_python_version[:2] < FALLBACK_MIN_PYTHON
                or bootstrap_python_version[:2] >= FALLBACK_MAX_PYTHON_EXCLUSIVE
            )
        ):
            fail(
                f"This dev fallback only supports {format_supported_python_range()}. Reinstall a proper release build or use a supported Python version.",
                state="pythonMissing",
                error_code="unsupported_python_version",
                installSource=install_source,
                requiresExternalPython=requires_external_python,
                pythonDetected=True,
                buildRuntimeMode=build_runtime_mode,
            )

        preferred_music_gen_python = find_windows_python_311()
        if preferred_music_gen_python is not None and safe_resolve(preferred_music_gen_python) != safe_resolve(bootstrap_python):
            write_log(f"musicGenPreferredPython={preferred_music_gen_python}")
            log_event(
                "installer",
                "checking",
                "music_generation_python_selected",
                selectedPython=str(preferred_music_gen_python),
                previousPython=str(bootstrap_python),
            )
            bootstrap_python = preferred_music_gen_python
            bootstrap_python_version = read_python_version_info(bootstrap_python)

        emit(
            "checking",
            0.05,
            message=f"Using Python {format_python_version(bootstrap_python_version)}",
            installSource=install_source,
            requiresExternalPython=requires_external_python,
            pythonDetected=True,
            buildRuntimeMode=build_runtime_mode,
        )
        runtime_python = bootstrap_runtime(runtime_root, bootstrap_python)
        verify_runtime(
            runtime_python,
            runtime_root,
            require_audio_separator=True,
            require_music_generation=False,
            install_source=install_source,
            requires_external_python=requires_external_python,
            python_detected=True,
            build_runtime_mode=build_runtime_mode,
        )

    model_path = download_model(
        runtime_python,
        runtime_root,
        models_dir,
        args.model,
        backend_requested=effective_backend_requested,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    download_music_gen_model(
        runtime_python,
        args.music_gen_model,
        music_gen_checkpoint_root,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    prepare_assistant_runtime(
        runtime_python,
        runtime_root,
        models_dir,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    prepare_audio_understanding_runtime(
        runtime_python,
        runtime_root,
        models_dir,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    verify_runtime(
        runtime_python,
        runtime_root,
        require_audio_separator=True,
        require_music_generation=False,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    runtime_probe = probe_runtime(
        runtime_python,
        runtime_root,
        models_dir,
        args.model,
        acceleration_mode="auto",
        music_checkpoint_root=music_gen_checkpoint_root,
        music_model_id=args.music_gen_model,
        backend_requested=effective_backend_requested,
        install_source=install_source,
        requires_external_python=requires_external_python,
        python_detected=python_detected,
        build_runtime_mode=build_runtime_mode,
    )

    music_generation_ready = bool(runtime_probe.get("musicGenerationReady", False))
    music_generation_layout_valid = bool(runtime_probe.get("musicGenerationLayoutValid", False))
    music_generation_status_message = runtime_probe.get("musicGenerationStatusMessage", "")
    music_generation_performance_ready = bool(runtime_probe.get("musicGenerationPerformanceReady", True))
    music_generation_performance_message = runtime_probe.get("musicGenerationPerformanceStatusMessage", "")
    assistant_status_message = runtime_probe.get("assistantStatusMessage", "")
    if assistant_status_message:
        write_log(f"assistantRuntimeStatus={assistant_status_message}")
    assistant_manifest_available = bool(runtime_probe.get("assistantManifestAvailable", False))
    assistant_runtime_ready = bool(runtime_probe.get("assistantRuntimeReady", False))
    audio_understanding_manifest_available = bool(runtime_probe.get("audioUnderstandingManifestAvailable", False))
    audio_understanding_runtime_ready = bool(runtime_probe.get("audioUnderstandingRuntimeReady", False))
    ready_message = (
        (
            (
                "AI tools are ready."
                if (
                    (not assistant_manifest_available or assistant_runtime_ready)
                    and (not audio_understanding_manifest_available or audio_understanding_runtime_ready)
                )
                else (
                    "Stem separation and music generation are ready, but the local assistant still needs verification."
                    if assistant_manifest_available and not assistant_runtime_ready
                    else "AI tools are installed, but the core music analyzer still needs verification."
                )
            )
        )
        if music_generation_ready and music_generation_layout_valid and music_generation_performance_ready
        else (
            "AI tools are installed, but music generation acceleration is incomplete."
            if music_generation_ready and music_generation_layout_valid
            else "Stem separation is ready, but music generation still needs the OpenStudio ACE split backend."
        )
    )

    emit(
        "ready",
        1.0,
        message=ready_message,
        runtimeRoot=str(runtime_root),
        modelsDir=str(models_dir),
        modelPath=str(model_path),
        runtimeInstalled=True,
        modelInstalled=True,
        available=True,
        musicGenerationReady=music_generation_ready,
        musicGenerationLayoutValid=music_generation_layout_valid,
        musicGenerationStatusMessage=music_generation_status_message,
        musicGenerationFailureCode=runtime_probe.get("musicGenerationFailureCode", ""),
        musicGenerationPerformanceReady=music_generation_performance_ready,
        musicGenerationPerformanceStatusMessage=music_generation_performance_message,
        musicGenerationModelId=runtime_probe.get("musicGenerationModelId", args.music_gen_model),
        musicGenerationModelRepoId=runtime_probe.get("musicGenerationModelRepoId", DEFAULT_MUSIC_GEN_MODEL_REPO),
        musicGenerationSharedRepoId=runtime_probe.get("musicGenerationSharedRepoId", DEFAULT_MUSIC_GEN_SHARED_REPO),
        musicGenerationCheckpointRoot=runtime_probe.get("musicGenerationCheckpointRoot", str(music_gen_checkpoint_root)),
        assistantManifestAvailable=runtime_probe.get("assistantManifestAvailable", False),
        assistantRuntimeReady=runtime_probe.get("assistantRuntimeReady", False),
        assistantVerificationRequired=runtime_probe.get("assistantVerificationRequired", True),
        assistantDownloadPolicy=runtime_probe.get("assistantDownloadPolicy", "single_verified_profile"),
        assistantStatusMessage=assistant_status_message,
        assistantFailureCode=runtime_probe.get("assistantFailureCode", ""),
        assistantSelectedProfile=runtime_probe.get("assistantSelectedProfile", ""),
        assistantAttemptedProfile=runtime_probe.get("assistantAttemptedProfile", ""),
        assistantPrefilterProfile=runtime_probe.get("assistantPrefilterProfile", ""),
        assistantRuntimeProfiles=runtime_probe.get("assistantRuntimeProfiles", {}),
        assistantAvailableProfiles=runtime_probe.get("assistantAvailableProfiles", []),
        assistantPrefilterProfiles=runtime_probe.get("assistantPrefilterProfiles", []),
        assistantUnavailableProfiles=runtime_probe.get("assistantUnavailableProfiles", []),
        assistantVerifiedStatusPath=runtime_probe.get("assistantVerifiedStatusPath", ""),
        assistantHardware=runtime_probe.get("assistantHardware", {}),
        audioUnderstandingManifestAvailable=runtime_probe.get("audioUnderstandingManifestAvailable", False),
        audioUnderstandingRuntimeReady=runtime_probe.get("audioUnderstandingRuntimeReady", False),
        audioUnderstandingVerificationRequired=runtime_probe.get("audioUnderstandingVerificationRequired", True),
        audioUnderstandingDownloadPolicy=runtime_probe.get("audioUnderstandingDownloadPolicy", "single_verified_profile"),
        audioUnderstandingStatus=runtime_probe.get("audioUnderstandingStatus", "not_installed"),
        audioUnderstandingStatusMessage=runtime_probe.get("audioUnderstandingStatusMessage", ""),
        audioUnderstandingFailureCode=runtime_probe.get("audioUnderstandingFailureCode", ""),
        audioUnderstandingSelectedProfile=runtime_probe.get("audioUnderstandingSelectedProfile", ""),
        audioUnderstandingAttemptedProfile=runtime_probe.get("audioUnderstandingAttemptedProfile", ""),
        audioUnderstandingPrefilterProfile=runtime_probe.get("audioUnderstandingPrefilterProfile", ""),
        audioUnderstandingRuntimeProfiles=runtime_probe.get("audioUnderstandingRuntimeProfiles", {}),
        audioUnderstandingAvailableProfiles=runtime_probe.get("audioUnderstandingAvailableProfiles", []),
        audioUnderstandingPrefilterProfiles=runtime_probe.get("audioUnderstandingPrefilterProfiles", []),
        audioUnderstandingUnavailableProfiles=runtime_probe.get("audioUnderstandingUnavailableProfiles", []),
        audioUnderstandingVerifiedStatusPath=runtime_probe.get("audioUnderstandingVerifiedStatusPath", ""),
        aceStepVersion=runtime_probe.get("aceStepVersion"),
        installSource=install_source,
        requiresExternalPython=requires_external_python,
        pythonDetected=python_detected,
        buildRuntimeMode=build_runtime_mode,
        supportedBackends=runtime_probe.get("supportedBackends", []),
        backendRequested=effective_backend_requested,
        selectedBackend=runtime_probe.get("selectedBackend", "cpu"),
        runtimeVersion=runtime_probe.get("runtimeVersion", ""),
        modelVersion=runtime_probe.get("modelVersion", args.model),
        verificationMode="in-process" if safe_resolve(runtime_python) == safe_resolve(Path(sys.executable)) else "subprocess",
        restartRequired=bool(runtime_probe.get("restartRequired", False)),
        statusWarning=music_generation_performance_message if music_generation_ready and music_generation_layout_valid and not music_generation_performance_ready else "",
        statusWarningCode="music_generation_acceleration_incomplete" if music_generation_ready and music_generation_layout_valid and not music_generation_performance_ready else "",
    )
    log_event(
        "installer",
        "ready",
        "installer_ready",
        runtimeVersion=runtime_probe.get("runtimeVersion", ""),
        modelVersion=runtime_probe.get("modelVersion", args.model),
        backendRequested=effective_backend_requested,
        supportedBackends=runtime_probe.get("supportedBackends", []),
        selectedBackend=runtime_probe.get("selectedBackend", "cpu"),
        verificationMode="in-process" if safe_resolve(runtime_python) == safe_resolve(Path(sys.executable)) else "subprocess",
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        fail("AI tools installation was cancelled.", state="cancelled", progress=0.0, error_code="cancelled")
