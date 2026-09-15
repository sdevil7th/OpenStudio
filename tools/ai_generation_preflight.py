"""Read-only request preflight: hardware, checkpoint headers and tokenizer only.

No model weights, inference, downloads, or changes to installed qualifications.
Estimates are advisory except for the existing locally qualified MiniMax policy.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import time

from ai_execution_policy import GIB, checkpoint_storage_bytes

MODELS = {"minimax-music-3", "stable-audio-3-medium", "ace-step-v15-xl-turbo"}


def memory_row(label, available, required=None):
    return {"label": label, "availableBytes": available, "requiredBytes": required,
            "shortfallBytes": max(0, required - available) if required is not None and available is not None else None}


def assess_memory(rows, *, strict=False):
    missing = any(row["availableBytes"] is None or row["requiredBytes"] is None for row in rows)
    short = any(row["shortfallBytes"] for row in rows)
    return "blocked" if strict and short else "warning" if short or missing else "ready"


def request_duration(model, workflow, params):
    minimum, maximum = (10, 600) if model == "ace-step-v15-xl-turbo" else (5, 300 if model == "minimax-music-3" else 360)
    duration = float(params.get("duration", 60))
    source = params.get("source") or {}
    if workflow in {"variation", "inpaint-selection", "continue-clip"} and source.get("clipDuration"):
        duration = float(source["clipDuration"])
        if workflow == "continue-clip":
            duration += float(source.get("extensionDuration", params.get("duration", 30)))
    if not math.isfinite(duration):
        raise ValueError("Duration must be finite.")
    return min(maximum, max(minimum, duration))


def resolve_root(root, model):
    if (root / "model_index.json").is_file() or (model == "minimax-music-3" and (root / "modular_model_index.json").is_file()):
        return root
    if model == "ace-step-v15-xl-turbo":
        from huggingface_hub import try_to_load_from_cache
        from ai_runtime_probe import DEFAULT_MUSIC_GEN_MODEL_REPO
        cached = try_to_load_from_cache(DEFAULT_MUSIC_GEN_MODEL_REPO, "model_index.json", cache_dir=str(root))
        if isinstance(cached, str):
            return Path(cached).parent
    raise ValueError("The selected local model snapshot is unavailable.")


def preflight(model, root, request):
    from ai_execution_policy import configure_allocator_environment
    configure_allocator_environment(model)
    import torch
    from ai_execution_policy import select_device, activate_device, device_budget, host_available
    selected = select_device(torch)
    activate_device(torch, selected)
    root = resolve_root(root, model)
    params, workflow = request["params"], request["workflow"]
    if not isinstance(params, dict):
        raise ValueError("Generation parameters must be an object.")
    duration = request_duration(model, workflow, params)
    gpu = selected.family in {"cuda", "rocm", "xpu"}
    bf16 = selected.family in {"cuda", "rocm"} and torch.cuda.is_bf16_supported()
    width = 2 if bf16 else 4
    weights = checkpoint_storage_bytes(root, width)
    ram = host_available()
    free_gpu = device_budget(torch, selected.device) if gpu else None
    reserve = int((3 + max(0, duration - 30) / 60) * GIB)
    components = [checkpoint_storage_bytes(child, width) for child in root.iterdir() if child.is_dir()]
    largest = max((value for value in components if value is not None), default=weights or 0)
    from diffusers_audio_pipeline import plan_audio_memory, plan_minimax_memory
    placement = plan_audio_memory(free_gpu, weights or 0, largest, duration,
        allow_group=model != "stable-audio-3-medium") if gpu else "resident"
    required_gpu = ((weights if placement == "resident" else largest) + reserve
                    if gpu and weights is not None and placement != "group-offload" else None)
    if model == "minimax-music-3" and selected.family in {"cuda", "rocm"}:
        placement = plan_minimax_memory(free_vram=free_gpu, available_ram=ram,
            weights_bytes=weights or 0,
            language_model_bytes=checkpoint_storage_bytes(root / "language_model", width) or 0,
            bf16=bf16).mode
        scale = 1 if bf16 else 2
        required_gpu = (max(weights or 0, 23 * scale * GIB) + 3 * GIB if placement == "resident"
                        else 22 * scale * GIB + 3 * GIB if placement == "model-offload" else None)
    report = {"schemaVersion": 1, "checkedAt": time.time(), "modelId": model, "duration": duration,
        "device": selected.device, "deviceName": selected.name, "unifiedMemory": selected.unified_memory,
        "precision": "BF16" if bf16 else "FP32", "placement": placement,
        "estimateBasis": "Checkpoint weights and duration-dependent working reserve; runtime peaks may differ.",
        "memory": [], "notes": [], "status": "warning"}
    required_ram = weights + 3 * GIB if weights is not None else None
    qualification_error = ""
    strict = False
    if model == "minimax-music-3":
        import stable_audio3_generate as worker
        from ai_execution_policy import minimax_prompt_tokens, qualified_minimax_options, minimax_kv_bytes, model_storage_identity
        from types import SimpleNamespace
        worker.MODEL_ID = model
        normalized, _ = worker.build_generation_request(workflow, params)
        tokens = minimax_prompt_tokens(root, normalized["prompt"], normalized["lyrics"])
        report["promptTokens"] = tokens
        options, qualification_error = qualified_minimax_options(torch, root, duration, tokens)
        profile_path = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "OpenStudio/ai-candidates/minimax-int8-qualified.json"
        if selected.family == "cuda" and profile_path.is_file() and profile_path.stat().st_size < 65536:
            profile = json.loads(profile_path.read_text(encoding="utf-8"))
            if profile.get("modelStorageIdentity") == model_storage_identity(root):
                config = json.loads((root / "language_model/config.json").read_text(encoding="utf-8"))
                kv = minimax_kv_bytes(SimpleNamespace(**config), duration=duration, prompt_tokens=tokens, element_size=2)
                stage, headroom = int(profile["stageWeightBytes"]), int(profile["deviceReserveBytes"])
                if not 0 < stage < 1024 * GIB or headroom not in {3 * GIB // 2, 2 * GIB, 3 * GIB}:
                    raise ValueError("Local calibration contains invalid memory estimates.")
                required_gpu = stage + kv + headroom
                required_ram = int(profile["minimumFreeHostBytes"])
                report.update(precision="INT8 language model / original audio precision", placement="model-offload",
                              estimateBasis="Local INT8 calibration plus this request's measured token count and cache reserve.")
                if not options:
                    report["estimateBasis"] = "Last local INT8 calibration estimate; this execution path is currently unavailable."
        strict = bool(options or qualification_error)
        if qualification_error and not options:
            report["notes"].append(qualification_error)
    report["memory"].append(memory_row("Unified system memory" if selected.unified_memory else "System RAM", ram, required_ram))
    if gpu:
        report["memory"].append(memory_row("GPU memory", free_gpu, required_gpu))
    report["status"] = assess_memory(report["memory"], strict=strict)
    if strict and qualification_error and not options:
        report["status"] = "blocked"
    if ram is not None and ram < 2 * GIB:
        report["status"] = "blocked"
    if any(row["shortfallBytes"] for row in report["memory"]):
        report["notes"].append("Close unused applications or shorten the request to reduce memory pressure.")
    if not strict and placement != "resident":
        report["status"] = "warning" if report["status"] == "ready" else report["status"]
        report["notes"].append("CPU offloading is likely; transfers can make generation slower.")
    if selected.family == "cpu":
        report["notes"].append("Generation will run on the CPU and may be slow.")
        if report["status"] == "ready":
            report["status"] = "warning"
    if workflow in {"variation", "inpaint-selection", "continue-clip"}:
        report["notes"].append("Source-workflow estimate includes clip context; the prepared segment may use less memory.")
    report["notes"].append("Memory availability can change. Generation checks its execution policy again before loading.")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-id", choices=sorted(MODELS), required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        if args.request.stat().st_size > 256 * 1024:
            raise ValueError("Generation request is too large.")
        result = preflight(args.model_id, args.model_root,
                           json.loads(args.request.read_text(encoding="utf-8-sig")))
    except Exception as exc:
        result = {"schemaVersion": 1, "status": "unavailable", "modelId": args.model_id,
                  "checkedAt": time.time(), "memory": [], "notes": [f"Hardware check unavailable: {exc}"]}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
