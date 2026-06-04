#!/usr/bin/env python3
"""
OpenStudio AI runtime capability probe.

This script is intentionally lightweight and returns a single JSON object that
describes what the managed AI runtime can do on the current machine.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import subprocess
import sys
import time
from importlib import metadata
from pathlib import Path
from typing import Any

DEFAULT_MUSIC_GEN_MODEL = "ace-step-v15-xl-turbo"
DEFAULT_MUSIC_GEN_MODEL_REPO = "ACE-Step/acestep-v15-xl-turbo-diffusers"
DEFAULT_MUSIC_GEN_SHARED_REPO = DEFAULT_MUSIC_GEN_MODEL_REPO
REQUIRED_MUSIC_GEN_PYTHON = (3, 11)
REQUIRED_MUSIC_GEN_NATIVE_FILES: tuple[dict[str, str], ...] = ()
MUSIC_RUNTIME_PROFILE_SPECS: dict[str, dict[str, Any]] = {
    "ace-diffusers": {
        "label": "ACE-Step Diffusers",
        "runtimeProfileName": "ace-diffusers",
        "lmModel": "",
        "requiredAssets": (),
    },
}
WINDOWS_ACCELERATION_MANIFEST_PATH = Path(__file__).with_name(
    "windows-ai-acceleration-manifest.json"
)
_WINDOWS_ACCELERATION_MANIFEST_CACHE: dict[str, Any] | None = None


def load_windows_acceleration_manifest() -> dict[str, Any]:
    global _WINDOWS_ACCELERATION_MANIFEST_CACHE
    if _WINDOWS_ACCELERATION_MANIFEST_CACHE is None:
        _WINDOWS_ACCELERATION_MANIFEST_CACHE = json.loads(
            WINDOWS_ACCELERATION_MANIFEST_PATH.read_text(encoding="utf-8")
        )
    return _WINDOWS_ACCELERATION_MANIFEST_CACHE


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
    return (3, 11) <= sys.version_info[:2] < (3, 13)


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
        from diffusers import AceStepPipeline  # noqa: F401
        import soundfile  # noqa: F401
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
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


def resolve_music_gen_checkpoint_root(checkpoint_root: str = "") -> Path:
    if checkpoint_root.strip():
        return Path(checkpoint_root).expanduser().resolve()
    return (Path.home() / ".cache" / "ace-step" / "diffusers").resolve()


def get_candidate_ace_model_roots() -> list[Path]:
    candidates: list[Path] = []
    model_dir = os.environ.get("OPENSTUDIO_ACE_MODEL_DIR", "").strip()
    if model_dir:
        candidates.append(Path(model_dir).expanduser())

    ace_root = os.environ.get("OPENSTUDIO_ACE_ROOT", "").strip()
    if ace_root:
        candidates.append(Path(ace_root).expanduser() / "models")

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


def find_local_ace_native_assets(
    extra_roots: list[Path] | None = None,
) -> tuple[dict[str, Path], list[str]]:
    found: dict[str, Path] = {}
    searched_roots: list[str] = []

    candidate_roots = list(extra_roots or []) + get_candidate_ace_model_roots()
    unique_roots: list[Path] = []
    seen_roots: set[str] = set()
    for candidate_root in candidate_roots:
        try:
            resolved_root = candidate_root.expanduser().resolve()
        except OSError:
            resolved_root = candidate_root.expanduser()
        root_key = str(resolved_root).lower()
        if root_key in seen_roots:
            continue
        seen_roots.add(root_key)
        unique_roots.append(resolved_root)

    for model_root in unique_roots:
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

    return {
        "checkpointRoot": str(root),
        "modelId": model_name,
        "modelRepoId": DEFAULT_MUSIC_GEN_MODEL_REPO,
        "sharedRepoId": DEFAULT_MUSIC_GEN_SHARED_REPO,
        "mainModelPath": "",
        "sharedPaths": [],
        "requiredPaths": [],
        "missingPaths": [],
        "layoutValid": True,
        "requiredAssets": [],
    }


def get_music_runtime_profiles(checkpoint_root: str = "") -> dict[str, Any]:
    profiles: dict[str, dict[str, Any]] = {}
    available_profiles: list[str] = []
    unavailable_profiles: list[dict[str, Any]] = []
    for profile_id, spec in MUSIC_RUNTIME_PROFILE_SPECS.items():
        profile = {
            "id": profile_id,
            "label": spec["label"],
            "runtimeProfileName": spec["runtimeProfileName"],
            "lmModel": spec["lmModel"],
            "requiredAssets": list(spec["requiredAssets"]),
            "missingAssets": [],
            "available": True,
        }
        profiles[profile_id] = profile
        available_profiles.append(profile_id)

    default_profile = "ace-diffusers"
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
        "diffusersVersion": None,
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
    }

    if models_dir and model_name:
        report["modelInstalled"] = (Path(models_dir) / model_name).exists()

    runtime_profiles = get_music_runtime_profiles(music_checkpoint_root)
    report["musicGenerationRuntimeProfiles"] = runtime_profiles["profiles"]
    report["musicGenerationAvailableProfiles"] = runtime_profiles["availableProfiles"]
    report["musicGenerationUnavailableProfiles"] = runtime_profiles["unavailableProfiles"]
    report["musicGenerationDefaultProfile"] = runtime_profiles["defaultProfile"]
    report["musicGenerationWarmSessionCapable"] = runtime_profiles["warmSessionCapable"]
    report["musicGenerationBackendRoot"] = "diffusers"

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
    report["diffusersVersion"] = _get_dist_version("diffusers")
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

    if not _is_music_generation_python_compatible():
        _set_music_generation_status(
            report,
            ready=False,
            message=(
                "ACE-Step Diffusers currently requires Python 3.11.x or 3.12.x, "
                f"but this managed runtime is using Python {report['pythonVersion']}."
            ),
            error_code="music_generation_python_incompatible",
        )
        report["backendDecisionTrace"].append(
            "music generation python incompatible: expected 3.11.x or 3.12.x, "
            f"got {report['pythonVersion']}"
        )
    elif report["diffusersVersion"] is None:
        _set_music_generation_status(
            report,
            ready=False,
            message="ACE-Step Diffusers dependencies are not installed in the managed AI runtime yet.",
            error_code="missing_ace_diffusers_runtime",
        )
        report["backendDecisionTrace"].append("diffusers package not installed")
    else:
        bridge_import_ok, bridge_import_error = _can_import_music_generation_bridge()
        if bridge_import_ok:
            report["musicGenerationComputeBackend"] = "cuda" if torch.cuda.is_available() else "cpu"
            if report["musicGenerationComputeBackend"] != "cuda":
                _set_music_generation_status(
                    report,
                    ready=False,
                    message="ACE-Step Diffusers requires CUDA on this backend.",
                    error_code="cuda_required",
                )
                report["musicGenerationPerformanceReady"] = False
                report["musicGenerationPerformanceStatusMessage"] = "CUDA is required for ACE-Step Diffusers."
                report["backendDecisionTrace"].append("ace diffusers cuda unavailable")
            else:
                report["musicGenerationPerformanceReady"] = True
                report["musicGenerationPerformanceStatusMessage"] = "ACE-Step Diffusers CUDA runtime is available."
                _set_music_generation_status(
                    report,
                    ready=True,
                    message="ACE-Step Diffusers backend is ready.",
                )
        else:
            _set_music_generation_status(
                report,
                ready=False,
                message="ACE-Step Diffusers dependencies are installed, but the pipeline could not be imported. Repair or reinstall Audio Generation setup.",
                error_code="broken_ace_diffusers_runtime",
            )
            report["backendDecisionTrace"].append("ace diffusers import failed: " + bridge_import_error)

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
        help="ACE-Step Diffusers cache root to validate (default: ~/.cache/ace-step/diffusers)",
    )
    parser.add_argument(
        "--music-gen-model",
        default=DEFAULT_MUSIC_GEN_MODEL,
        help="OpenStudio ACE-Step model id to validate",
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
