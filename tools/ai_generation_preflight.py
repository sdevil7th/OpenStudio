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
    if model == "ace-step-v15-xl-turbo":
        from ai_runtime_probe import resolve_music_gen_snapshot
        snapshot = resolve_music_gen_snapshot(root)
        if snapshot is not None:
            return snapshot
    elif (root / "model_index.json").is_file() or (model == "minimax-music-3" and (root / "modular_model_index.json").is_file()):
        return root
    raise ValueError("The selected local model snapshot is unavailable.")


def preflight(model, root, request):
    from ai_execution_policy import configure_allocator_environment
    configure_allocator_environment(model)
    import torch
    from ai_execution_policy import select_device, activate_device, device_budget, host_available
    selected = select_device(torch)
    activate_device(torch, selected)
    params, workflow = request["params"], request["workflow"]
    if not isinstance(params, dict):
        raise ValueError("Generation parameters must be an object.")
    from ai_model_variants import requested_variant, variant_root, validate_variant, require_int8_device
    variant = requested_variant(params)
    from ai_compilation import validate_optimization
    optimization = validate_optimization(params.get("generationOptimization", "standard"), model, variant)
    compilation_policy = None
    if optimization == "compile" and model == "stable-audio-3-medium":
        from ai_compiler_profile import validate_compiler_device
        compilation_policy = validate_compiler_device(torch, selected.device)
    if optimization == "fp8-storage":
        from ai_layerwise_storage import validate_fp8_device
        validate_fp8_device(torch, selected.device)
    if variant == "int8":
        root = variant_root(model)
        validate_variant(root, model)
        require_int8_device(torch)
    root = resolve_root(root, model)
    startup_policy = None
    if optimization == "rocm-fast-startup":
        from ai_rocm_startup import validate_rocm_startup
        startup_policy = validate_rocm_startup(torch, selected.device, root)
    duration = request_duration(model, workflow, params)
    gpu = selected.family in {"cuda", "rocm", "xpu"}
    bf16 = selected.family in {"cuda", "rocm"} and torch.cuda.is_bf16_supported()
    width = 2 if bf16 else 4
    weights = checkpoint_storage_bytes(root, width)
    ram = host_available()
    free_gpu = device_budget(torch, selected.device) if gpu else None
    reserve = int((3 + max(0, duration - 30) / 60) * GIB)
    if startup_policy:
        from ai_rocm_startup import rocm_startup_reserve
        reserve = rocm_startup_reserve(duration)
    components = [checkpoint_storage_bytes(child, width) for child in root.iterdir() if child.is_dir()]
    largest = max((value for value in components if value is not None), default=weights or 0)
    from diffusers_audio_pipeline import plan_audio_memory, plan_minimax_memory
    placement = plan_audio_memory(free_gpu, weights or 0, largest, duration,
        allow_group=model != "stable-audio-3-medium", reserve_bytes=reserve if startup_policy else None) if gpu else "resident"
    required_gpu = ((weights if placement == "resident" else largest) + reserve
                    if gpu and weights is not None and placement != "group-offload" else None)
    minimax_memory = None
    if model == "minimax-music-3" and selected.family in {"cuda", "rocm"} and variant != "int8":
        from ai_execution_policy import minimax_checkpoint_memory, minimax_prompt_tokens
        import stable_audio3_generate as worker
        previous_model = worker.MODEL_ID
        try:
            worker.MODEL_ID = model
            normalized, _ = worker.build_generation_request(workflow, params)
        finally:
            worker.MODEL_ID = previous_model
        tokens = minimax_prompt_tokens(root, normalized["prompt"], normalized["lyrics"])
        minimax_memory = minimax_checkpoint_memory(root,float_bytes=width,duration=duration,
            prompt_tokens=tokens,free_vram=free_gpu,available_ram=ram)
        if minimax_memory:
            placement = minimax_memory["placement"]
            required_gpu = minimax_memory["requiredDeviceBytes"]
    report = {"schemaVersion": 1, "checkedAt": time.time(), "modelId": model, "duration": duration,
        "device": selected.device, "deviceName": selected.name, "unifiedMemory": selected.unified_memory,
        "precision": "BF16" if bf16 else "FP32", "placement": placement,
        "estimateBasis": "Checkpoint weights and duration-dependent working reserve; runtime peaks may differ.",
        "memory": [], "notes": [], "status": "warning"}
    report["optimization"] = optimization
    if compilation_policy:
        report["compilationPolicy"] = compilation_policy
        report["placement"] = "resident"
        report["notes"].append("Compiled generation requires resident placement. This conservative estimate can differ from measured peaks; first-generation compilation adds startup time.")
    if startup_policy:
        if placement != "resident":
            raise ValueError("Faster AMD startup currently requires resident placement; choose Automatic for offloading")
        report["startupPolicy"] = startup_policy
        report["activationReserveBytes"] = reserve
        report["notes"].append("Qualified AMD fast convolution selection; precision and musical settings are unchanged. This preference applies to a new worker.")
    if optimization == "fp8-storage":
        report["precision"] = "FP8 transformer storage / BF16 computation"
        report["placement"] = "resident"
        report["notes"].append("FP8 storage is an explicit local setting. This conservative estimate retains original weight bytes; processing details report actual allocation. Audition the result.")
    required_ram = weights + 3 * GIB if weights is not None else None
    if minimax_memory:
        required_ram = minimax_memory["requiredHostBytes"]
        report.update(loadingPlan=minimax_memory, promptTokens=tokens,
                      estimateBasis="Model size, song length, lyrics, and space needed while loading.")
        if minimax_memory["loadingBacking"] == "disk":
            report["notes"].append("Automatic memory management loads the model in stages and temporarily keeps inactive parts on disk. It keeps the selected precision; transfers can be slow.")
    qualification_error = ""
    strict = False
    if model == "minimax-music-3" and "modelVariant" not in params:
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
    if variant == "int8":
        strict = True
        report.update(modelVariant="int8", precision="INT8 / original audio components",
                      placement="model-offload" if model == "minimax-music-3" else "resident")
        required_gpu = (weights or 0) + reserve
        if model == "minimax-music-3":
            from types import SimpleNamespace
            from ai_execution_policy import minimax_prompt_tokens, minimax_kv_bytes
            import stable_audio3_generate as worker
            worker.MODEL_ID = model
            normalized, _ = worker.build_generation_request(workflow, params)
            tokens = minimax_prompt_tokens(root, normalized["prompt"], normalized["lyrics"])
            config = json.loads((root / "language_model/config.json").read_text(encoding="utf-8"))
            kv = minimax_kv_bytes(SimpleNamespace(**config), duration=duration, prompt_tokens=tokens, element_size=2)
            ar = sum(checkpoint_storage_bytes(root / name, 2) or 0 for name in ("language_model", "rvq_depth_decoder"))
            required_gpu = max(ar, largest) + kv + 3 * GIB // 2
            required_ram = max(6 * GIB, (weights or 0) - ar + 3 * GIB)
            report.update(promptTokens=tokens)
            report["notes"].append("INT8 keeps MiniMax's active stage on the GPU. Inactive weights use a temporary disk cache (about 15 GiB); first load takes longer.")
        report["notes"].append("INT8 reduces weight memory. Speed and audio quality depend on the model and request.")
    report["memory"].append(memory_row("Unified system memory" if selected.unified_memory else "System RAM", ram, required_ram))
    if gpu:
        report["memory"].append(memory_row("GPU memory", free_gpu, required_gpu))
    report["status"] = assess_memory(report["memory"], strict=strict)
    if strict and qualification_error and not options:
        report["status"] = "blocked"
    if (minimax_memory and free_gpu is not None
            and free_gpu < minimax_memory["minimumDeviceBytes"]):
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
