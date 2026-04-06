#!/usr/bin/env python3
"""
OpenStudio AI runtime capability probe.

This script is intentionally lightweight and returns a single JSON object that
describes what the managed AI runtime can do on the current machine.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from importlib import metadata
from pathlib import Path
from typing import Any


def _get_dist_version(package_name: str) -> str | None:
    try:
        return metadata.version(package_name)
    except metadata.PackageNotFoundError:
        return None


def _has_distribution(package_name: str) -> bool:
    return _get_dist_version(package_name) is not None


def _normalize_arch(machine: str) -> str:
    value = machine.lower()
    if value in {"amd64", "x86_64"}:
        return "x64"
    if value in {"arm64", "aarch64"}:
        return "arm64"
    return value


def probe_runtime_capabilities(
    *,
    models_dir: str = "",
    model_name: str = "",
    acceleration_mode: str = "auto",
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "runtimeReady": False,
        "restartRequired": False,
        "platform": platform.system().lower(),
        "architecture": _normalize_arch(platform.machine()),
        "pythonVersion": platform.python_version(),
        "runtimeExecutable": sys.executable,
        "accelerationMode": acceleration_mode,
        "audioSeparatorVersion": None,
        "torchVersion": None,
        "onnxRuntimePackages": {},
        "onnxProviders": [],
        "packagedBackends": [],
        "supportedBackends": ["cpu"],
        "selectedBackend": "cpu",
        "modelInstalled": False,
        "modelVersion": model_name or "",
        "fallbackReason": "",
    }

    if models_dir and model_name:
        report["modelInstalled"] = (Path(models_dir) / model_name).exists()

    try:
        import torch
        import onnxruntime as ort
        import audio_separator.separator  # noqa: F401
    except Exception as exc:
        report["fallbackReason"] = f"runtime import failed: {type(exc).__name__}: {exc}"
        return report

    report["runtimeReady"] = True
    report["audioSeparatorVersion"] = _get_dist_version("audio-separator")
    report["torchVersion"] = getattr(torch, "__version__", None)
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
    report["onnxProviders"] = ort_providers

    packaged_backends: list[str] = []
    if (
        report["platform"] == "windows"
        and not str(report["torchVersion"] or "").endswith("+cpu")
        and _has_distribution("onnxruntime-gpu")
        and "CUDAExecutionProvider" in ort_providers
    ):
        packaged_backends.append("cuda")

    if (
        report["platform"] == "windows"
        and _has_distribution("onnxruntime-directml")
        and _has_distribution("torch_directml")
        and "DmlExecutionProvider" in ort_providers
    ):
        packaged_backends.append("directml")

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
    if report["platform"] == "darwin" and report["architecture"] == "arm64" and mps_available:
        packaged_backends.append("mps")

    packaged_backends.append("cpu")
    report["packagedBackends"] = list(dict.fromkeys(packaged_backends))

    supported_backends: list[str] = []
    fallback_reason = ""

    if acceleration_mode == "cpu-only":
        fallback_reason = "acceleration mode forced CPU-only"
    elif report["platform"] == "windows":
        cuda_available = bool(torch.cuda.is_available() and "cuda" in report["packagedBackends"])
        if cuda_available:
            supported_backends.append("cuda")

        dml_available = False
        if "directml" in report["packagedBackends"]:
            try:
                import torch_directml  # type: ignore

                dml_available = bool(torch_directml.is_available())
            except Exception:
                dml_available = False

        if dml_available:
            supported_backends.append("directml")

        if not supported_backends:
            fallback_reason = "no GPU backend could be configured on this Windows machine"
    elif report["platform"] == "darwin" and report["architecture"] == "arm64":
        if "coreml" in report["packagedBackends"]:
            supported_backends.append("coreml")
        if mps_available:
            supported_backends.append("mps")
        if not supported_backends:
            fallback_reason = "no Apple Silicon acceleration backend could be configured"
    else:
        fallback_reason = "no accelerated backend is supported for this platform"

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
    else:
        report["selectedBackend"] = "cpu"

    report["fallbackReason"] = fallback_reason
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe OpenStudio AI runtime capabilities")
    parser.add_argument("--models-dir", default="", help="Optional models directory")
    parser.add_argument("--model", default="", help="Optional model filename to check")
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
    )
    print(json.dumps(report), flush=True)
    return 0 if report.get("runtimeReady") else 1


if __name__ == "__main__":
    raise SystemExit(main())
