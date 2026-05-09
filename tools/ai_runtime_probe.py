#!/usr/bin/env python3
"""
OpenStudio AI runtime capability probe.

This script is intentionally lightweight and returns a single JSON object that
describes what the managed AI runtime can do on the current machine.
"""

from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from importlib import metadata
from pathlib import Path
from typing import Any

from openstudio_ace_backend.runtime_resolver import backend_status

DEFAULT_MUSIC_GEN_MODEL = "acestep-v15-xl-turbo"
DEFAULT_MUSIC_GEN_MODEL_REPO = "Comfy-Org/ace_step_1.5_ComfyUI_files"
DEFAULT_MUSIC_GEN_SHARED_REPO = "Comfy-Org/ace_step_1.5_ComfyUI_files"
REQUIRED_MUSIC_GEN_PYTHON = (3, 11)
REQUIRED_MUSIC_GEN_NATIVE_FILES: tuple[dict[str, str], ...] = (
    {
        "id": "diffusion_model",
        "label": "ACE-Step XL Turbo diffusion model",
        "relativePath": "diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors",
        "sourceRelativePaths": (
            "diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors",
            "unet/acestep_v1.5_xl_turbo_bf16.safetensors",
        ),
    },
    {
        "id": "vae",
        "label": "ACE-Step 1.5 VAE",
        "relativePath": "vae/ace_1.5_vae.safetensors",
        "sourceRelativePaths": ("vae/ace_1.5_vae.safetensors",),
    },
    {
        "id": "text_encoder_0_6b",
        "label": "ACE-Step Qwen 0.6B text encoder",
        "relativePath": "text_encoders/qwen_0.6b_ace15.safetensors",
        "sourceRelativePaths": ("text_encoders/qwen_0.6b_ace15.safetensors",),
    },
    {
        "id": "text_encoder_4b",
        "label": "ACE-Step Qwen 4B text encoder",
        "relativePath": "text_encoders/qwen_4b_ace15.safetensors",
        "sourceRelativePaths": ("text_encoders/qwen_4b_ace15.safetensors",),
    },
)
MUSIC_RUNTIME_PROFILE_SPECS: dict[str, dict[str, Any]] = {
    "native-xl-turbo": {
        "label": "OpenStudio ACE Split",
        "runtimeProfileName": "openstudio-ace-split",
        "lmModel": "qwen_4b_ace15.safetensors",
        "requiredAssets": tuple(spec["relativePath"] for spec in REQUIRED_MUSIC_GEN_NATIVE_FILES),
    },
}
WINDOWS_ACCELERATION_MANIFEST_PATH = Path(__file__).with_name(
    "windows-ai-acceleration-manifest.json"
)
ASSISTANT_RUNTIME_MANIFEST_PATH = Path(__file__).with_name(
    "assistant-runtime-profiles.json"
)
ASSISTANT_VERIFIED_STATUS_ENV = "OPENSTUDIO_ASSISTANT_STATUS_FILE"
AUDIO_UNDERSTANDING_STATUS_ENV = "OPENSTUDIO_AUDIO_UNDERSTANDING_STATUS_FILE"
_WINDOWS_ACCELERATION_MANIFEST_CACHE: dict[str, Any] | None = None
_ASSISTANT_RUNTIME_MANIFEST_CACHE: dict[str, Any] | None = None


def load_windows_acceleration_manifest() -> dict[str, Any]:
    global _WINDOWS_ACCELERATION_MANIFEST_CACHE
    if _WINDOWS_ACCELERATION_MANIFEST_CACHE is None:
        _WINDOWS_ACCELERATION_MANIFEST_CACHE = json.loads(
            WINDOWS_ACCELERATION_MANIFEST_PATH.read_text(encoding="utf-8")
        )
    return _WINDOWS_ACCELERATION_MANIFEST_CACHE


def load_assistant_runtime_manifest() -> dict[str, Any]:
    global _ASSISTANT_RUNTIME_MANIFEST_CACHE
    if _ASSISTANT_RUNTIME_MANIFEST_CACHE is None:
        if not ASSISTANT_RUNTIME_MANIFEST_PATH.exists():
            _ASSISTANT_RUNTIME_MANIFEST_CACHE = {
                "schemaVersion": 1,
                "downloadPolicy": "single_verified_profile",
                "verificationRequired": True,
                "defaultOrder": [],
                "profiles": {},
            }
        else:
            _ASSISTANT_RUNTIME_MANIFEST_CACHE = json.loads(
                ASSISTANT_RUNTIME_MANIFEST_PATH.read_text(encoding="utf-8")
            )
    return _ASSISTANT_RUNTIME_MANIFEST_CACHE


def get_windows_acceleration_target() -> dict[str, Any]:
    return load_windows_acceleration_manifest().get("target", {})


def get_windows_cuda_pytorch_index_url() -> str:
    return str(
        get_windows_acceleration_target()
        .get("pytorch", {})
        .get("indexUrl", "https://download.pytorch.org/whl/cu128")
    )


def get_windows_cuda_pytorch_packages() -> tuple[str, ...]:
    pytorch = get_windows_acceleration_target().get("pytorch", {})
    return tuple(
        str(package).strip()
        for package in pytorch.get("packages", [])
        if str(package).strip()
    )


def get_windows_triton_package_spec() -> str:
    return str(
        get_windows_acceleration_target()
        .get("tritonWindows", {})
        .get("package", "triton-windows")
    ).strip()


def get_windows_flash_attn_asset() -> dict[str, Any]:
    return dict(get_windows_acceleration_target().get("flashAttn", {}))


def _strip_local_version(version: str | None) -> str:
    if not version:
        return ""
    return str(version).split("+", 1)[0].strip()


def _expected_torch_packages_by_name() -> dict[str, str]:
    expected: dict[str, str] = {}
    for package in get_windows_cuda_pytorch_packages():
        name, separator, version = str(package).partition("==")
        if separator and name and version:
            expected[name.strip()] = version.strip()
    return expected


def _get_windows_expected_stack_versions() -> dict[str, str]:
    target = get_windows_acceleration_target()
    triton_spec = get_windows_triton_package_spec()
    triton_name, _separator, triton_version = triton_spec.partition("==")
    flash_attn = get_windows_flash_attn_asset()
    expected = _expected_torch_packages_by_name()
    expected["triton-windows"] = triton_version.strip()
    expected["flash-attn"] = str(flash_attn.get("version", "")).strip()
    expected["cuda"] = str(target.get("cuda", "")).strip()
    return expected


def _set_music_generation_status(
    report: dict[str, Any],
    *,
    ready: bool,
    message: str = "",
    error_code: str = "",
) -> None:
    report["musicGenerationReady"] = ready
    report["musicGenerationStatusMessage"] = message
    report["musicGenerationFailureCode"] = error_code


def _is_music_generation_python_compatible() -> bool:
    return sys.version_info[:2] == REQUIRED_MUSIC_GEN_PYTHON


def _get_dist_version(package_name: str) -> str | None:
    try:
        return metadata.version(package_name)
    except metadata.PackageNotFoundError:
        return None


def _has_distribution(package_name: str) -> bool:
    return _get_dist_version(package_name) is not None


def _has_module(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _try_import_module(module_name: str) -> tuple[bool, str]:
    try:
        __import__(module_name)
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    return True, ""


def _has_windows_nvidia_hardware() -> bool:
    if platform.system() != "Windows":
        return False
    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return False

    return result.returncode == 0 and bool((result.stdout or "").strip())


def _ensure_optional_music_acceleration_paths() -> None:
    try:
        import acestep

        nano_vllm_root = (
            Path(acestep.__file__).resolve().parent / "third_parts" / "nano-vllm"
        )
        if nano_vllm_root.exists():
            nano_vllm_root_str = str(nano_vllm_root)
            if nano_vllm_root_str not in sys.path:
                sys.path.insert(0, nano_vllm_root_str)
    except Exception:
        pass


def _probe_music_generation_acceleration(
    *,
    compute_backend: str,
    report: dict[str, Any],
) -> tuple[bool, str]:
    if compute_backend != "cuda":
        if report.get("platform") == "windows" and _has_windows_nvidia_hardware():
            report["backendDecisionTrace"].append(
                "ACE-Step CUDA acceleration unavailable on a Windows NVIDIA machine"
            )
            return (
                False,
                "ACE-Step CUDA acceleration is required on this Windows NVIDIA machine, "
                "but the managed runtime is not exposing CUDA to PyTorch yet.",
            )
        return True, ""

    _ensure_optional_music_acceleration_paths()
    missing: list[str] = []
    mismatch_details: list[str] = []
    import_failures: list[str] = []

    for module_name, friendly_name in (
        ("nanovllm", "nano-vllm"),
        ("triton", "triton"),
        ("flash_attn", "flash-attn"),
    ):
        import_ok, import_error = _try_import_module(module_name)
        if not import_ok:
            if not _has_module(module_name):
                missing.append(friendly_name)
            else:
                import_failures.append(f"{friendly_name} ({import_error})")

    if report.get("platform") == "windows":
        expected_versions = _get_windows_expected_stack_versions()
        installed_versions = {
            "torch": report.get("torchVersion"),
            "torchvision": _get_dist_version("torchvision"),
            "torchaudio": _get_dist_version("torchaudio"),
            "triton-windows": _get_dist_version("triton-windows"),
            "flash-attn": _get_dist_version("flash-attn"),
        }

        for package_name in ("torch", "torchvision", "torchaudio"):
            expected_version = expected_versions.get(package_name, "")
            installed_version = str(installed_versions.get(package_name) or "")
            if not installed_version:
                missing.append(package_name)
                continue

            if (
                _strip_local_version(installed_version) != expected_version
                or expected_versions.get("cuda", "") not in installed_version
            ):
                mismatch_details.append(
                    f"{package_name}={installed_version} (expected {expected_version}+{expected_versions.get('cuda', '')})"
                )

        for package_name in ("triton-windows", "flash-attn"):
            expected_version = expected_versions.get(package_name, "")
            installed_version = str(installed_versions.get(package_name) or "")
            if not installed_version:
                if package_name not in missing:
                    missing.append(package_name)
                continue
            if _strip_local_version(installed_version) != expected_version:
                mismatch_details.append(
                    f"{package_name}={installed_version} (expected {expected_version})"
                )

    if not missing and not mismatch_details and not import_failures:
        report["backendDecisionTrace"].append(
            "ACE-Step accelerated LM runtime detected with the pinned Windows CUDA stack"
        )
        return True, "ACE-Step accelerated LM runtime is installed."

    detail_parts: list[str] = []
    if missing:
        detail_parts.append("missing " + ", ".join(missing))
    if mismatch_details:
        detail_parts.append("mismatched " + "; ".join(mismatch_details))
    if import_failures:
        detail_parts.append("import failures " + "; ".join(import_failures))

    report["backendDecisionTrace"].append(
        "ACE-Step CUDA acceleration incomplete: " + " | ".join(detail_parts)
    )
    return (
        False,
        "ACE-Step music generation is installed, but the pinned Windows CUDA acceleration "
        "stack is incomplete: " + " | ".join(detail_parts) + ".",
    )


def _can_import_music_generation_bridge() -> tuple[bool, str]:
    try:
        import acestep.handler  # noqa: F401
        import acestep.inference  # noqa: F401
        import acestep.llm_inference  # noqa: F401
        import av  # noqa: F401
        import torchsde  # noqa: F401
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    return True, ""


def _normalize_arch(machine: str) -> str:
    value = machine.lower()
    if value in {"amd64", "x86_64"}:
        return "x64"
    if value in {"arm64", "aarch64"}:
        return "arm64"
    return value


def _run_capture(command: list[str], timeout_sec: float = 5.0) -> tuple[bool, str]:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    output = (completed.stdout or completed.stderr or "").strip()
    return completed.returncode == 0, output


def _get_system_ram_gb() -> float:
    if platform.system().lower() == "windows":
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return round(status.ullTotalPhys / (1024 ** 3), 2)
        except Exception:
            pass

    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        pages = os.sysconf("SC_PHYS_PAGES")
        return round((page_size * pages) / (1024 ** 3), 2)
    except Exception:
        return 0.0


def _get_free_disk_gb() -> float:
    try:
        return round(shutil.disk_usage(Path.home()).free / (1024 ** 3), 2)
    except Exception:
        return 0.0


def _probe_nvidia_gpu() -> dict[str, Any]:
    ok, output = _run_capture(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.free,compute_cap",
            "--format=csv,noheader,nounits",
        ],
        timeout_sec=5.0,
    )
    gpus: list[dict[str, Any]] = []
    if ok:
        for line in output.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 4:
                continue
            total_mb = float(parts[1]) if parts[1].replace(".", "", 1).isdigit() else 0.0
            free_mb = float(parts[2]) if parts[2].replace(".", "", 1).isdigit() else 0.0
            gpus.append(
                {
                    "name": parts[0],
                    "vramGb": round(total_mb / 1024, 2),
                    "freeVramGb": round(free_mb / 1024, 2),
                    "computeCapability": parts[3],
                }
            )
    return {
        "available": bool(gpus),
        "gpus": gpus,
        "bestVramGb": max((gpu["vramGb"] for gpu in gpus), default=0.0),
        "bestFreeVramGb": max((gpu["freeVramGb"] for gpu in gpus), default=0.0),
        "probeMessage": "" if gpus else output,
    }


def _probe_wsl_cuda() -> dict[str, Any]:
    system = platform.system().lower()
    if system == "linux":
        ok, output = _run_capture(["nvidia-smi", "-L"], timeout_sec=5.0)
        return {
            "available": ok,
            "message": output if not ok else "CUDA visible from Linux runtime.",
        }
    if system != "windows":
        return {
            "available": False,
            "message": "WSL2 CUDA is only relevant on Windows hosts.",
        }

    ok, output = _run_capture(
        [
            "wsl.exe",
            "-e",
            "sh",
            "-lc",
            (
                "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi -L; "
                "elif [ -x /usr/lib/wsl/lib/nvidia-smi ]; then /usr/lib/wsl/lib/nvidia-smi -L; "
                "else echo 'nvidia-smi was not found in the default WSL distro.' >&2; exit 127; fi"
            ),
        ],
        timeout_sec=8.0,
    )
    return {
        "available": ok,
        "message": output if output else ("WSL2 CUDA is visible." if ok else "WSL2 CUDA was not detected."),
    }


def _current_platform_key() -> str:
    system = platform.system().lower()
    if system == "darwin":
        return "darwin"
    if system == "windows":
        return "windows"
    if system == "linux":
        return "linux"
    return system or "unknown"


def _format_platforms(platforms: list[str]) -> str:
    labels = {
        "darwin": "macOS",
        "linux": "Linux",
        "windows": "Windows",
    }
    return ", ".join(labels.get(value, value) for value in platforms)


def _get_assistant_verified_status_path() -> Path:
    configured = os.environ.get(ASSISTANT_VERIFIED_STATUS_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".openstudio" / "assistant-runtime-status.json").resolve()


def _get_audio_understanding_verified_status_path() -> Path:
    configured = os.environ.get(AUDIO_UNDERSTANDING_STATUS_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".openstudio" / "audio-understanding-runtime-status.json").resolve()


def _load_assistant_verified_status(manifest: dict[str, Any]) -> dict[str, Any]:
    status_path = _get_assistant_verified_status_path()
    if not status_path.exists():
        return {
            "verified": False,
            "statusPath": str(status_path),
            "profileId": "",
        }
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "verified": False,
            "statusPath": str(status_path),
            "profileId": "",
            "error": f"{type(exc).__name__}: {exc}",
        }
    profile_id = str(status.get("profileId", "")).strip()
    verified = bool(status.get("verified")) and profile_id in manifest.get("profiles", {})
    attempted_profile_id = str(status.get("attemptedProfileId", "")).strip()
    if attempted_profile_id not in manifest.get("profiles", {}):
        attempted_profile_id = profile_id if profile_id in manifest.get("profiles", {}) else ""
    return {
        **status,
        "verified": verified,
        "statusPath": str(status_path),
        "profileId": profile_id if verified else "",
        "attemptedProfileId": attempted_profile_id,
    }


def _load_audio_understanding_verified_status(analyzer_manifest: dict[str, Any]) -> dict[str, Any]:
    status_path = _get_audio_understanding_verified_status_path()
    if not status_path.exists():
        return {
            "verified": False,
            "statusPath": str(status_path),
            "profileId": "",
        }
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "verified": False,
            "statusPath": str(status_path),
            "profileId": "",
            "error": f"{type(exc).__name__}: {exc}",
        }
    profiles = analyzer_manifest.get("profiles", {})
    profile_id = str(status.get("profileId", "")).strip()
    verified = bool(status.get("verified")) and profile_id in profiles
    attempted_profile_id = str(status.get("attemptedProfileId", "")).strip()
    if attempted_profile_id not in profiles:
        attempted_profile_id = profile_id if profile_id in profiles else ""
    return {
        **status,
        "verified": verified,
        "statusPath": str(status_path),
        "profileId": profile_id if verified else "",
        "attemptedProfileId": attempted_profile_id,
    }


def _profile_prefilter_reason(
    profile: dict[str, Any],
    *,
    platform_key: str,
    system_ram_gb: float,
    free_disk_gb: float,
    gpu_status: dict[str, Any],
    wsl_cuda_status: dict[str, Any],
) -> str:
    ram_tolerance_gb = 0.5
    vram_tolerance_gb = 0.25
    supported_platforms = [
        str(value).strip().lower()
        for value in profile.get("supportedPlatforms", [])
        if str(value).strip()
    ]
    if supported_platforms and platform_key not in supported_platforms:
        return f"Profile supports {_format_platforms(supported_platforms)}."
    if bool(profile.get("candidateOnly")):
        return "Candidate profile requires an explicit verification implementation before installer selection."
    if system_ram_gb + ram_tolerance_gb < float(profile.get("minRamGb", 0)):
        return f"Requires at least {profile.get('minRamGb')}GB system RAM."
    if free_disk_gb < float(profile.get("minFreeDiskGb", 0)):
        return f"Requires at least {profile.get('minFreeDiskGb')}GB free disk."
    min_vram = float(profile.get("minVramGb", 0))
    if min_vram > 0 and float(gpu_status.get("bestVramGb", 0)) + vram_tolerance_gb < min_vram:
        return f"Requires at least {profile.get('minVramGb')}GB VRAM."
    runtime_family = str(profile.get("runtimeFamily", ""))
    if "vllm" in runtime_family and "wsl" in runtime_family and not bool(wsl_cuda_status.get("available")):
        return "Requires WSL2 CUDA visibility from a real Linux distro before download."
    if "linux-cuda" in runtime_family and platform_key != "linux":
        return "Linux CUDA profiles can only be installed on Linux."
    if "cuda" in str(profile.get("gpuOffloadPolicy", "")) and not bool(gpu_status.get("available")):
        return "Requires an NVIDIA GPU visible to the host."
    return ""


def _audio_understanding_profile_reason(
    profile: dict[str, Any],
    *,
    platform_key: str,
    system_ram_gb: float,
    free_disk_gb: float,
    gpu_status: dict[str, Any],
    wsl_cuda_status: dict[str, Any],
    license_accepted: bool,
) -> str:
    ram_tolerance_gb = 0.5
    vram_tolerance_gb = 0.25
    supported_platforms = [
        str(value).strip().lower()
        for value in profile.get("supportedPlatforms", [])
        if str(value).strip()
    ]
    if supported_platforms and platform_key not in supported_platforms:
        return f"Profile supports {_format_platforms(supported_platforms)}."
    if system_ram_gb + ram_tolerance_gb < float(profile.get("minRamGb", 0)):
        return f"Requires at least {profile.get('minRamGb')}GB system RAM."
    if free_disk_gb < float(profile.get("minFreeDiskGb", 0)):
        return f"Requires at least {profile.get('minFreeDiskGb')}GB free disk."
    min_vram = float(profile.get("minVramGb", 0))
    if min_vram > 0 and float(gpu_status.get("bestVramGb", 0)) + vram_tolerance_gb < min_vram:
        return f"Requires at least {profile.get('minVramGb')}GB VRAM."
    runtime_family = str(profile.get("runtimeFamily", ""))
    if "wsl" in runtime_family and not bool(wsl_cuda_status.get("available")):
        return "Requires WSL2 CUDA visibility from a real Linux distro before download."
    if "linux-cuda" in runtime_family and platform_key != "linux":
        return "Linux CUDA profiles can only be installed on Linux."
    if "cuda" in str(profile.get("gpuOffloadPolicy", "")) and not bool(gpu_status.get("available")):
        return "Requires an NVIDIA GPU visible to the host."
    if bool(profile.get("requiresLicenseAcceptance")) and not license_accepted:
        return "License acceptance is required before installing this core analyzer."
    if bool(profile.get("candidateOnly")):
        return "Candidate analyzer requires explicit implementation and smoke-test verification before installer selection."
    return ""


def _classify_audio_understanding_status(failure_code: str, status_error: str) -> str:
    combined = f"{failure_code} {status_error}".lower()
    if "license" in combined:
        return "license_blocked"
    if "out of memory" in combined or "cuda oom" in combined or "oom" in combined:
        return "oom"
    if "unsupported" in combined or "no_supported" in combined:
        return "unsupported"
    return "failed"


def get_audio_understanding_runtime_status(
    *,
    manifest: dict[str, Any],
    platform_key: str,
    system_ram_gb: float,
    free_disk_gb: float,
    gpu_status: dict[str, Any],
    wsl_cuda_status: dict[str, Any],
) -> dict[str, Any]:
    analyzer_manifest = manifest.get("audioUnderstanding", {})
    if not isinstance(analyzer_manifest, dict):
        analyzer_manifest = {}
    profiles = analyzer_manifest.get("profiles", {})
    if not isinstance(profiles, dict):
        profiles = {}
    order = list(analyzer_manifest.get("defaultOrder", [])) or list(profiles.keys())
    verified_status = _load_audio_understanding_verified_status(analyzer_manifest)
    license_accepted = bool(verified_status.get("licenseAccepted"))

    prefilter_profiles: list[str] = []
    unavailable_profiles: list[dict[str, Any]] = []
    for profile_id in order:
        profile = dict(profiles.get(profile_id, {}))
        if not profile:
            continue
        reason = _audio_understanding_profile_reason(
            profile,
            platform_key=platform_key,
            system_ram_gb=system_ram_gb,
            free_disk_gb=free_disk_gb,
            gpu_status=gpu_status,
            wsl_cuda_status=wsl_cuda_status,
            license_accepted=license_accepted,
        )
        if reason:
            unavailable_profiles.append(
                {
                    "id": profile_id,
                    "label": profile.get("label", profile_id),
                    "reason": reason,
                    "runtimeFamily": profile.get("runtimeFamily", ""),
                }
            )
        else:
            prefilter_profiles.append(profile_id)

    selected_profile = str(verified_status.get("profileId", ""))
    attempted_profile = str(verified_status.get("attemptedProfileId", "")).strip()
    status_error = str(verified_status.get("error", "")).strip()
    failure_code = str(verified_status.get("failureCode", "")).strip()
    prefilter_profile = prefilter_profiles[0] if prefilter_profiles else ""
    runtime_ready = bool(verified_status.get("verified")) and bool(selected_profile)

    if runtime_ready:
        status_value = "ready"
        status_message = f"Core music analyzer verified with {selected_profile}."
    elif status_error or failure_code:
        status_value = _classify_audio_understanding_status(failure_code, status_error)
        status_message = (
            "Core music analyzer verification failed"
            + (f" for {attempted_profile}" if attempted_profile else "")
            + (f": {status_error}" if status_error else ".")
        )
    elif not profiles:
        status_value = "unsupported"
        status_message = "No core music analyzer profiles are listed in the runtime manifest."
    elif prefilter_profile:
        status_value = "not_installed"
        status_message = (
            f"Core music analyzer {prefilter_profile} can be smoke-tested, "
            "but it is not installed. OpenStudio cannot hear selected audio until it is verified."
        )
    elif any("license" in str(item.get("reason", "")).lower() for item in unavailable_profiles):
        status_value = "license_blocked"
        status_message = (
            "Core music analyzer candidates require license acceptance before installation. "
            "OpenStudio should not use blocked analyzer models in distributed builds."
        )
    elif any("candidate analyzer" in str(item.get("reason", "")).lower() for item in unavailable_profiles):
        status_value = "not_installed"
        status_message = (
            "Core music analyzer candidates require explicit implementation and smoke-test verification. "
            "OpenStudio cannot use them as analyzer defaults yet."
        )
    else:
        status_value = "unsupported"
        status_message = "No core music analyzer profile passed the local hardware prefilter."

    if not failure_code and status_value == "unsupported" and profiles:
        failure_code = "audio_understanding_no_supported_profile"
    elif not failure_code and status_value == "license_blocked":
        failure_code = "audio_understanding_license_blocked"
    elif not failure_code and status_value == "oom":
        failure_code = "audio_understanding_oom"
    elif not failure_code and status_value == "failed":
        failure_code = "audio_understanding_failed"

    return {
        "audioUnderstandingManifestAvailable": bool(analyzer_manifest),
        "audioUnderstandingRuntimeReady": runtime_ready,
        "audioUnderstandingVerificationRequired": bool(analyzer_manifest.get("verificationRequired", False)),
        "audioUnderstandingDownloadPolicy": str(analyzer_manifest.get("downloadPolicy", "single_verified_profile")),
        "audioUnderstandingStatus": status_value,
        "audioUnderstandingStatusMessage": status_message,
        "audioUnderstandingFailureCode": failure_code,
        "audioUnderstandingSelectedProfile": selected_profile,
        "audioUnderstandingAttemptedProfile": attempted_profile,
        "audioUnderstandingPrefilterProfile": prefilter_profile,
        "audioUnderstandingRuntimeProfiles": profiles,
        "audioUnderstandingAvailableProfiles": [selected_profile] if runtime_ready else [],
        "audioUnderstandingPrefilterProfiles": prefilter_profiles,
        "audioUnderstandingUnavailableProfiles": unavailable_profiles,
        "audioUnderstandingVerifiedStatusPath": str(
            verified_status.get("statusPath", _get_audio_understanding_verified_status_path())
        ),
    }


def get_assistant_runtime_status() -> dict[str, Any]:
    manifest = load_assistant_runtime_manifest()
    profiles = manifest.get("profiles", {})
    order = list(manifest.get("defaultOrder", [])) or list(profiles.keys())
    platform_key = _current_platform_key()
    system_ram_gb = _get_system_ram_gb()
    free_disk_gb = _get_free_disk_gb()
    gpu_status = _probe_nvidia_gpu()
    wsl_cuda_status = _probe_wsl_cuda()
    verified_status = _load_assistant_verified_status(manifest)

    prefilter_profiles: list[str] = []
    unavailable_profiles: list[dict[str, Any]] = []
    for profile_id in order:
        profile = dict(profiles.get(profile_id, {}))
        if not profile:
            continue
        reason = _profile_prefilter_reason(
            profile,
            platform_key=platform_key,
            system_ram_gb=system_ram_gb,
            free_disk_gb=free_disk_gb,
            gpu_status=gpu_status,
            wsl_cuda_status=wsl_cuda_status,
        )
        if reason:
            unavailable_profiles.append(
                {
                    "id": profile_id,
                    "label": profile.get("label", profile_id),
                    "reason": reason,
                    "runtimeFamily": profile.get("runtimeFamily", ""),
                }
            )
        else:
            prefilter_profiles.append(profile_id)

    selected_profile = str(verified_status.get("profileId", ""))
    attempted_profile = str(verified_status.get("attemptedProfileId", "")).strip()
    status_error = str(verified_status.get("error", "")).strip()
    prefilter_profile = prefilter_profiles[0] if prefilter_profiles else ""
    runtime_ready = bool(verified_status.get("verified")) and bool(selected_profile)
    status_message = (
        f"Assistant runtime verified with {selected_profile}."
        if runtime_ready
        else (
            (
                "Assistant runtime verification failed"
                + (f" for {attempted_profile}" if attempted_profile else "")
                + f": {status_error}"
                + (
                    f" Retry will try {prefilter_profile}."
                    if prefilter_profile and prefilter_profile != attempted_profile
                    else ""
                )
            )
            if status_error
            else (
                f"Assistant installer can preselect {prefilter_profile}, but no assistant model has been downloaded or verified yet."
                if prefilter_profile
                else "No assistant runtime profile passed the local hardware prefilter."
            )
        )
    )
    failure_code = ""
    if not runtime_ready and not prefilter_profile:
        failure_code = "assistant_no_supported_profile" if profiles else "assistant_manifest_missing"
    if status_error:
        failure_code = str(verified_status.get("failureCode", "assistant_verification_failed")) or "assistant_verification_failed"

    audio_understanding_status = get_audio_understanding_runtime_status(
        manifest=manifest,
        platform_key=platform_key,
        system_ram_gb=system_ram_gb,
        free_disk_gb=free_disk_gb,
        gpu_status=gpu_status,
        wsl_cuda_status=wsl_cuda_status,
    )

    return {
        "assistantManifestAvailable": ASSISTANT_RUNTIME_MANIFEST_PATH.exists(),
        "assistantRuntimeReady": runtime_ready,
        "assistantVerificationRequired": bool(manifest.get("verificationRequired", True)),
        "assistantDownloadPolicy": str(manifest.get("downloadPolicy", "single_verified_profile")),
        "assistantStatusMessage": status_message,
        "assistantFailureCode": failure_code,
        "assistantSelectedProfile": selected_profile,
        "assistantAttemptedProfile": attempted_profile,
        "assistantPrefilterProfile": prefilter_profile,
        "assistantRuntimeProfiles": profiles,
        "assistantAvailableProfiles": [selected_profile] if runtime_ready else [],
        "assistantPrefilterProfiles": prefilter_profiles,
        "assistantUnavailableProfiles": unavailable_profiles,
        "assistantVerifiedStatusPath": str(verified_status.get("statusPath", _get_assistant_verified_status_path())),
        "assistantHardware": {
            "platform": platform_key,
            "systemRamGb": system_ram_gb,
            "freeDiskGb": free_disk_gb,
            "nvidia": gpu_status,
            "wslCuda": wsl_cuda_status,
        },
        **audio_understanding_status,
    }


def resolve_music_gen_checkpoint_root(checkpoint_root: str = "") -> Path:
    if checkpoint_root.strip():
        return Path(checkpoint_root).expanduser().resolve()
    return (Path.home() / ".cache" / "ace-step" / "checkpoints").resolve()


def get_openstudio_native_backend_root() -> Path:
    return Path(backend_status(Path(__file__))[1])


def get_openstudio_native_backend_status() -> tuple[bool, str, list[str]]:
    return backend_status(Path(__file__))


def get_candidate_comfy_model_roots() -> list[Path]:
    candidates = [
        Path(os.environ.get("COMFYUI_MODEL_DIR", "")).expanduser(),
        Path(os.environ.get("COMFYUI_ROOT", "")).expanduser() / "models",
    ]
    home = Path.home()
    candidates.extend(
        [
            home / "Documents" / "ComfyUI" / "models",
            home / "Documents" / "Codes" / "ComfyUI" / "models",
            home / "ComfyUI" / "models",
        ]
    )

    unique_candidates: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        candidate_str = str(candidate).strip()
        if not candidate_str or candidate_str == ".":
            continue
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved).lower()
        if key in seen:
            continue
        seen.add(key)
        unique_candidates.append(resolved)
    return unique_candidates


def find_local_comfy_native_assets() -> tuple[dict[str, Path], list[str]]:
    found: dict[str, Path] = {}
    searched_roots: list[str] = []

    for model_root in get_candidate_comfy_model_roots():
        searched_roots.append(str(model_root))
        if not model_root.is_dir():
            continue

        for spec in REQUIRED_MUSIC_GEN_NATIVE_FILES:
            if spec["id"] in found:
                continue
            for source_relative in spec.get("sourceRelativePaths", (spec["relativePath"],)):
                candidate = model_root / Path(source_relative)
                if candidate.exists() and candidate.is_file():
                    found[spec["id"]] = candidate.resolve()
                    break

    return found, searched_roots


def get_music_generation_required_paths(
    checkpoint_root: str = "",
    model_name: str = DEFAULT_MUSIC_GEN_MODEL,
) -> dict[str, Any]:
    root = resolve_music_gen_checkpoint_root(checkpoint_root)
    required_paths = [root / Path(spec["relativePath"]) for spec in REQUIRED_MUSIC_GEN_NATIVE_FILES]
    missing_paths = [str(path) for path in required_paths if not path.exists()]

    return {
        "checkpointRoot": str(root),
        "modelId": model_name,
        "modelRepoId": DEFAULT_MUSIC_GEN_MODEL_REPO,
        "sharedRepoId": DEFAULT_MUSIC_GEN_SHARED_REPO,
        "mainModelPath": str(required_paths[0]) if required_paths else "",
        "sharedPaths": [str(path) for path in required_paths[1:]],
        "requiredPaths": [str(path) for path in required_paths],
        "missingPaths": missing_paths,
        "layoutValid": not missing_paths,
        "requiredAssets": [
            {
                "id": spec["id"],
                "label": spec["label"],
                "relativePath": spec["relativePath"],
                "path": str(root / Path(spec["relativePath"])),
            }
            for spec in REQUIRED_MUSIC_GEN_NATIVE_FILES
        ],
    }


def get_music_runtime_profiles(checkpoint_root: str = "") -> dict[str, Any]:
    root = resolve_music_gen_checkpoint_root(checkpoint_root)
    installed_assets = (
        {
            str(path.relative_to(root)).replace("\\", "/")
            for path in root.rglob("*")
            if path.is_file()
        }
        if root.exists()
        else set()
    )

    profiles: dict[str, dict[str, Any]] = {}
    available_profiles: list[str] = []
    unavailable_profiles: list[dict[str, Any]] = []
    for profile_id, spec in MUSIC_RUNTIME_PROFILE_SPECS.items():
        missing_assets = [asset for asset in spec["requiredAssets"] if asset not in installed_assets]
        profile = {
            "id": profile_id,
            "label": spec["label"],
            "runtimeProfileName": spec["runtimeProfileName"],
            "lmModel": spec["lmModel"],
            "requiredAssets": list(spec["requiredAssets"]),
            "missingAssets": missing_assets,
            "available": not missing_assets,
        }
        profiles[profile_id] = profile
        if profile["available"]:
            available_profiles.append(profile_id)
        else:
            unavailable_profiles.append(profile)

    default_profile = (
        "native-xl-turbo"
        if profiles.get("native-xl-turbo", {}).get("available")
        else next(iter(available_profiles), "")
    )
    return {
        "defaultProfile": default_profile,
        "profiles": profiles,
        "availableProfiles": available_profiles,
        "unavailableProfiles": unavailable_profiles,
        "warmSessionCapable": True,
    }


def probe_runtime_capabilities(
    *,
    models_dir: str = "",
    model_name: str = "",
    acceleration_mode: str = "auto",
    music_checkpoint_root: str = "",
    music_model_id: str = DEFAULT_MUSIC_GEN_MODEL,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    music_layout = get_music_generation_required_paths(
        checkpoint_root=music_checkpoint_root,
        model_name=music_model_id,
    )
    assistant_status = get_assistant_runtime_status()
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "baseRuntimeReady": False,
        "runtimeReady": False,
        "restartRequired": False,
        "platform": platform.system().lower(),
        "architecture": _normalize_arch(platform.machine()),
        "pythonVersion": platform.python_version(),
        "runtimeExecutable": sys.executable,
        "accelerationMode": acceleration_mode,
        "audioSeparatorVersion": None,
        "aceStepVersion": None,
        "torchVersion": None,
        "torchvisionVersion": None,
        "torchaudioVersion": None,
        "tritonWindowsVersion": None,
        "flashAttnVersion": None,
        "onnxRuntimePackages": {},
        "onnxProviders": [],
        "packagedBackends": [],
        "supportedBackends": ["cpu"],
        "selectedBackend": "cpu",
        "modelInstalled": False,
        "musicGenerationReady": False,
        "musicGenerationLayoutValid": bool(music_layout["layoutValid"]),
        "musicGenerationStatusMessage": "",
        "musicGenerationFailureCode": "",
        "musicGenerationPerformanceReady": False,
        "musicGenerationPerformanceStatusMessage": "",
        "musicGenerationComputeBackend": "cpu",
        "musicGenerationModelId": music_layout["modelId"],
        "musicGenerationModelRepoId": music_layout["modelRepoId"],
        "musicGenerationSharedRepoId": music_layout["sharedRepoId"],
        "musicGenerationCheckpointRoot": music_layout["checkpointRoot"],
        "musicGenerationBackendRoot": "",
        "musicGenerationMainModelPath": music_layout["mainModelPath"],
        "musicGenerationRequiredPaths": music_layout["requiredPaths"],
        "musicGenerationMissingPaths": music_layout["missingPaths"],
        "musicGenerationRuntimeProfiles": {},
        "musicGenerationAvailableProfiles": [],
        "musicGenerationUnavailableProfiles": [],
        "musicGenerationDefaultProfile": "",
        "musicGenerationWarmSessionCapable": True,
        "modelVersion": model_name or "",
        "fallbackReason": "",
        "errorCode": "",
        "backendDecisionTrace": [],
        "probeDurationMs": 0,
        **assistant_status,
    }

    if models_dir and model_name:
        report["modelInstalled"] = (Path(models_dir) / model_name).exists()

    runtime_profiles = get_music_runtime_profiles(music_checkpoint_root)
    report["musicGenerationRuntimeProfiles"] = runtime_profiles["profiles"]
    report["musicGenerationAvailableProfiles"] = runtime_profiles["availableProfiles"]
    report["musicGenerationUnavailableProfiles"] = runtime_profiles["unavailableProfiles"]
    report["musicGenerationDefaultProfile"] = runtime_profiles["defaultProfile"]
    report["musicGenerationWarmSessionCapable"] = runtime_profiles["warmSessionCapable"]
    backend_runtime_ok, backend_root, backend_missing = get_openstudio_native_backend_status()
    report["musicGenerationBackendRoot"] = backend_root

    report["baseRuntimeReady"] = True

    try:
        import torch
        import onnxruntime as ort
        import audio_separator.separator  # noqa: F401
    except Exception as exc:
        report["fallbackReason"] = f"runtime import failed: {type(exc).__name__}: {exc}"
        report["errorCode"] = "probe_import_failed"
        report["backendDecisionTrace"].append("import audio_separator.separator failed")
        report["probeDurationMs"] = round((time.perf_counter() - started_at) * 1000, 3)
        return report

    report["runtimeReady"] = True
    report["audioSeparatorVersion"] = _get_dist_version("audio-separator")
    report["aceStepVersion"] = _get_dist_version("ace-step")
    report["torchVersion"] = getattr(torch, "__version__", None)
    report["torchvisionVersion"] = _get_dist_version("torchvision")
    report["torchaudioVersion"] = _get_dist_version("torchaudio")
    report["tritonWindowsVersion"] = _get_dist_version("triton-windows")
    report["flashAttnVersion"] = _get_dist_version("flash-attn")
    report["onnxRuntimePackages"] = {
        "onnxruntime": _get_dist_version("onnxruntime"),
        "onnxruntime-gpu": _get_dist_version("onnxruntime-gpu"),
        "onnxruntime-directml": _get_dist_version("onnxruntime-directml"),
        "onnxruntime-silicon": _get_dist_version("onnxruntime-silicon"),
        "torch-directml": _get_dist_version("torch_directml"),
    }

    try:
        ort_providers = list(ort.get_available_providers())
    except Exception:
        ort_providers = []
        report["backendDecisionTrace"].append("onnxruntime.get_available_providers failed")
    report["onnxProviders"] = ort_providers

    if not music_layout["layoutValid"]:
        _set_music_generation_status(
            report,
            ready=False,
            message="Pinned ACE-Step native split-model files are still missing.",
            error_code="missing_checkpoint_files",
        )
        report["backendDecisionTrace"].append(
            "music generation checkpoint layout missing: "
            + ", ".join(music_layout["missingPaths"])
        )
    elif not _is_music_generation_python_compatible():
        _set_music_generation_status(
            report,
            ready=False,
            message=(
                "Pinned ACE-Step music generation currently requires Python "
                f"{REQUIRED_MUSIC_GEN_PYTHON[0]}.{REQUIRED_MUSIC_GEN_PYTHON[1]}.x, "
                f"but this managed runtime is using Python {report['pythonVersion']}."
            ),
            error_code="music_generation_python_incompatible",
        )
        report["backendDecisionTrace"].append(
            "music generation python incompatible: "
            f"expected {REQUIRED_MUSIC_GEN_PYTHON[0]}.{REQUIRED_MUSIC_GEN_PYTHON[1]}.x, "
            f"got {report['pythonVersion']}"
        )
    elif report["aceStepVersion"] is None:
        _set_music_generation_status(
            report,
            ready=False,
            message="ACE-Step is not installed in the managed AI runtime yet.",
            error_code="missing_ace_step_runtime",
        )
        report["backendDecisionTrace"].append("ace-step package not installed")
    elif not backend_runtime_ok:
        _set_music_generation_status(
            report,
            ready=False,
            message=(
                "ACE-Step 1.5 assets are installed, but the packaged OpenStudio split backend "
                "is missing runtime files: " + ", ".join(backend_missing)
            ),
            error_code="missing_openstudio_native_backend",
        )
        report["backendDecisionTrace"].append(
            "openstudio native backend missing: " + ", ".join(backend_missing)
        )
    elif str(report["aceStepVersion"]).startswith("1."):
        try:
            import torchaudio  # noqa: F401
        except Exception as exc:
            _set_music_generation_status(
                report,
                ready=False,
                message=(
                    "ACE-Step 1.5 dependencies are installed, but this runtime cannot "
                    f"load torchaudio yet: {exc}"
                ),
                error_code="torchaudio_runtime_incompatible",
            )
            report["backendDecisionTrace"].append(f"torchaudio import failed: {exc}")
        else:
            bridge_import_ok, bridge_import_error = _can_import_music_generation_bridge()
            if bridge_import_ok:
                report["musicGenerationComputeBackend"] = "cuda" if torch.cuda.is_available() else "cpu"
                acceleration_ready, acceleration_message = _probe_music_generation_acceleration(
                    compute_backend=report["musicGenerationComputeBackend"],
                    report=report,
                )
                report["musicGenerationPerformanceReady"] = acceleration_ready
                report["musicGenerationPerformanceStatusMessage"] = acceleration_message
                _set_music_generation_status(
                    report,
                    ready=True,
                    message="OpenStudio ACE split backend is ready.",
                )
            else:
                _set_music_generation_status(
                    report,
                    ready=False,
                    message=(
                        "ACE-Step 1.5 is installed, but the packaged OpenStudio split backend "
                        f"cannot import its ACE-Step bridge in this environment: {bridge_import_error}"
                    ),
                    error_code="broken_v15_runtime_bridge",
                )
                report["backendDecisionTrace"].append(
                    "openstudio split backend ace-step import failed: " + bridge_import_error
                )
    else:
        _set_music_generation_status(
            report,
            ready=False,
            message=(
                "The managed runtime still has the legacy ACE-Step "
                f"{report['aceStepVersion']} package, but the pinned model requires the "
                "ACE-Step 1.5 split backend."
            ),
            error_code="legacy_ace_step_runtime",
        )
        report["backendDecisionTrace"].append(
            f"legacy ace-step runtime detected: {report['aceStepVersion']}"
        )

    packaged_backends: list[str] = []
    if (
        report["platform"] == "windows"
        and not str(report["torchVersion"] or "").endswith("+cpu")
        and _has_distribution("onnxruntime-gpu")
        and "CUDAExecutionProvider" in ort_providers
    ):
        packaged_backends.append("cuda")
        report["backendDecisionTrace"].append("packaged cuda runtime detected")

    if (
        report["platform"] == "windows"
        and _has_distribution("onnxruntime-directml")
        and _has_distribution("torch_directml")
        and "DmlExecutionProvider" in ort_providers
    ):
        packaged_backends.append("directml")
        report["backendDecisionTrace"].append("packaged directml runtime detected")

    if (
        report["platform"] == "linux"
        and not str(report["torchVersion"] or "").endswith("+cpu")
        and _has_distribution("onnxruntime-gpu")
        and "CUDAExecutionProvider" in ort_providers
    ):
        packaged_backends.append("cuda")
        report["backendDecisionTrace"].append("packaged cuda runtime detected (linux)")

    if report["platform"] == "linux":
        # ROCm: torch built against ROCm exposes torch.version.hip
        try:
            if hasattr(torch, "version") and getattr(torch.version, "hip", None) is not None:
                packaged_backends.append("rocm")
                report["backendDecisionTrace"].append("packaged rocm runtime detected (linux)")
        except Exception:
            pass

    mps_available = bool(
        hasattr(torch.backends, "mps")
        and torch.backends.mps.is_available()
    )
    if (
        report["platform"] == "darwin"
        and report["architecture"] == "arm64"
        and "CoreMLExecutionProvider" in ort_providers
    ):
        packaged_backends.append("coreml")
        report["backendDecisionTrace"].append("packaged coreml runtime detected")
    if report["platform"] == "darwin" and report["architecture"] == "arm64" and mps_available:
        packaged_backends.append("mps")
        report["backendDecisionTrace"].append("packaged mps runtime detected")

    packaged_backends.append("cpu")
    report["packagedBackends"] = list(dict.fromkeys(packaged_backends))

    supported_backends: list[str] = []
    fallback_reason = ""

    if acceleration_mode == "cpu-only":
        fallback_reason = "acceleration mode forced CPU-only"
        report["backendDecisionTrace"].append("requested acceleration mode forced cpu-only")
    elif report["platform"] == "windows":
        cuda_available = bool(torch.cuda.is_available() and "cuda" in report["packagedBackends"])
        if cuda_available:
            supported_backends.append("cuda")
            report["backendDecisionTrace"].append("cuda backend available on current machine")

        dml_available = False
        if "directml" in report["packagedBackends"]:
            try:
                import torch_directml  # type: ignore

                dml_available = bool(torch_directml.is_available())
            except Exception:
                dml_available = False
                report["backendDecisionTrace"].append("torch_directml import or availability check failed")

        if dml_available:
            supported_backends.append("directml")
            report["backendDecisionTrace"].append("directml backend available on current machine")

        if not supported_backends:
            fallback_reason = "no GPU backend could be configured on this Windows machine"
            report["errorCode"] = "probe_backend_unavailable"
    elif report["platform"] == "darwin" and report["architecture"] == "arm64":
        if "coreml" in report["packagedBackends"]:
            supported_backends.append("coreml")
            report["backendDecisionTrace"].append("coreml backend available on current machine")
        if mps_available:
            supported_backends.append("mps")
            report["backendDecisionTrace"].append("mps backend available on current machine")
        if not supported_backends:
            fallback_reason = "no Apple Silicon acceleration backend could be configured"
            report["errorCode"] = "probe_backend_unavailable"
    elif report["platform"] == "linux":
        if "cuda" in report["packagedBackends"] and torch.cuda.is_available():
            supported_backends.append("cuda")
            report["backendDecisionTrace"].append("cuda backend available on linux machine")
        if "rocm" in report["packagedBackends"]:
            try:
                # ROCm appears as CUDA to torch.cuda on linux; double-check via hip version
                rocm_available = bool(
                    torch.cuda.is_available()
                    and getattr(torch.version, "hip", None) is not None
                )
                if rocm_available:
                    supported_backends.append("rocm")
                    report["backendDecisionTrace"].append("rocm backend available on linux machine")
            except Exception:
                pass
        if not supported_backends:
            fallback_reason = "no GPU backend could be configured on this Linux machine"
            report["errorCode"] = "probe_backend_unavailable"
    else:
        fallback_reason = "no accelerated backend is supported for this platform"
        report["errorCode"] = "probe_backend_unavailable"

    supported_backends.append("cpu")
    report["supportedBackends"] = list(dict.fromkeys(supported_backends))

    if acceleration_mode == "cpu-only":
        report["selectedBackend"] = "cpu"
    elif report["platform"] == "windows":
        if "cuda" in report["supportedBackends"]:
            report["selectedBackend"] = "cuda"
        elif "directml" in report["supportedBackends"]:
            report["selectedBackend"] = "directml"
        else:
            report["selectedBackend"] = "cpu"
    elif report["platform"] == "darwin" and report["architecture"] == "arm64":
        if "coreml" in report["supportedBackends"]:
            report["selectedBackend"] = "coreml"
        elif "mps" in report["supportedBackends"]:
            report["selectedBackend"] = "mps"
        else:
            report["selectedBackend"] = "cpu"
    elif report["platform"] == "linux":
        if "cuda" in report["supportedBackends"]:
            report["selectedBackend"] = "cuda"
        elif "rocm" in report["supportedBackends"]:
            report["selectedBackend"] = "rocm"
        else:
            report["selectedBackend"] = "cpu"
    else:
        report["selectedBackend"] = "cpu"

    report["fallbackReason"] = fallback_reason
    if not report["errorCode"]:
        report["errorCode"] = ""
    report["probeDurationMs"] = round((time.perf_counter() - started_at) * 1000, 3)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe OpenStudio AI runtime capabilities")
    parser.add_argument("--models-dir", default="", help="Optional models directory")
    parser.add_argument("--model", default="", help="Optional model filename to check")
    parser.add_argument(
        "--music-gen-checkpoint-root",
        default="",
        help="Pinned ACE-Step checkpoint root to validate",
    )
    parser.add_argument(
        "--music-gen-model",
        default=DEFAULT_MUSIC_GEN_MODEL,
        help="Pinned ACE-Step model id to validate",
    )
    parser.add_argument(
        "--acceleration-mode",
        choices=["auto", "cpu-only"],
        default="auto",
        help="Acceleration policy to evaluate",
    )
    args = parser.parse_args()

    report = probe_runtime_capabilities(
        models_dir=args.models_dir,
        model_name=args.model,
        acceleration_mode=args.acceleration_mode,
        music_checkpoint_root=args.music_gen_checkpoint_root,
        music_model_id=args.music_gen_model,
    )
    print(json.dumps(report), flush=True)
    return 0 if report.get("baseRuntimeReady") else 1


if __name__ == "__main__":
    raise SystemExit(main())
