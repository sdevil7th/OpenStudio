#!/usr/bin/env python3
"""OpenStudio-owned ACE-Step 1.5 graph runner."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import platform
import sys
import wave
from pathlib import Path
from typing import Any

import numpy as np


PHASE_RANGES: dict[str, tuple[float, float]] = {
    "loading_text_encoders": (0.08, 0.24),
    "encoding_conditioning": (0.24, 0.48),
    "loading_diffusion_model": (0.48, 0.56),
    "sampling": (0.56, 0.9),
    "decoding_audio": (0.9, 0.97),
    "writing_output": (0.97, 0.99),
    "done": (1.0, 1.0),
}

CURRENT_PHASE = "loading_text_encoders"
CURRENT_MESSAGE = ""


class OpenStudioAceLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage().lower()
        suppressed_messages = (
            "comfy_kitchen",
            "comfy kitchen",
            "unable to parse pyproject.toml",
            "pydantic-settings",
            "pydantic_settings",
        )
        return not any(item in message for item in suppressed_messages)


def install_openstudio_ace_log_filter() -> None:
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.ERROR)
    if not any(isinstance(item, OpenStudioAceLogFilter) for item in root_logger.filters):
        root_logger.addFilter(OpenStudioAceLogFilter())
    for handler in root_logger.handlers:
        if not any(isinstance(item, OpenStudioAceLogFilter) for item in handler.filters):
            handler.addFilter(OpenStudioAceLogFilter())


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_phase(phase: str, message: str, *, details: dict[str, Any] | None = None) -> None:
    global CURRENT_PHASE, CURRENT_MESSAGE
    CURRENT_PHASE = phase
    CURRENT_MESSAGE = message
    start, _end = PHASE_RANGES.get(phase, (0.0, 0.0))
    payload: dict[str, Any] = {
        "kind": "phase",
        "phase": phase,
        "message": message,
        "progress": start,
    }
    if details:
        payload["details"] = details
    emit(payload)


def progress_hook(current: int, total: int, preview: Any = None, **kwargs: Any) -> None:
    start, end = PHASE_RANGES.get(CURRENT_PHASE, (0.0, 0.0))
    fraction = 0.0
    if total:
        try:
            fraction = max(0.0, min(1.0, float(current) / float(total)))
        except Exception:
            fraction = 0.0
    emit(
        {
            "kind": "progress",
            "phase": CURRENT_PHASE,
            "message": CURRENT_MESSAGE,
            "current": current,
            "total": total,
            "fraction": fraction,
            "progress": start + ((end - start) * fraction),
            "nodeId": kwargs.get("node_id"),
        }
    )


class OpenStudioAceExecutorServer:
    def __init__(self) -> None:
        self.client_id = None
        self.last_node_id = None
        self.messages: list[tuple[str, dict[str, Any]]] = []

    def send_sync(self, event: str, data: dict[str, Any], client_id: Any | None = None) -> None:
        self.messages.append((event, data))


def choose_existing(base_dir: Path, relative_candidates: list[str]) -> str:
    for relative in relative_candidates:
        candidate = base_dir / relative
        if candidate.is_file():
            return Path(relative).name
    raise FileNotFoundError(
        "OpenStudio ACE is missing required local model files. Run OpenStudio AI setup "
        "while connected to the internet, then retry generation offline. Missing one of: "
        + ", ".join(relative_candidates)
    )


def enable_offline_generation_mode() -> None:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_DATASETS_OFFLINE", "1")


def normalize_timesignature(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "4"
    if "/" in raw:
        return raw.split("/", 1)[0].strip()
    return raw


def seed_for_graph(value: Any) -> int:
    try:
        seed = int(value)
    except Exception:
        return 0
    return seed if seed >= 0 else 0


def unwrap_executor_output(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return value


def build_openstudio_ace_prompt(
    *,
    request: dict[str, Any],
    unet_name: str,
    clip_name1: str,
    clip_name2: str,
    vae_name: str,
) -> dict[str, dict[str, Any]]:
    request_seed = seed_for_graph(request.get("seed", 0))
    return {
        "104": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": unet_name,
                "weight_dtype": str(request.get("model_mode", "default") or "default"),
            },
        },
        "105": {
            "class_type": "DualCLIPLoader",
            "inputs": {
                "clip_name1": clip_name1,
                "clip_name2": clip_name2,
                "type": "ace",
                "device": str(request.get("clip_device", "default") or "default"),
            },
        },
        "106": {
            "class_type": "VAELoader",
            "inputs": {
                "vae_name": vae_name,
            },
        },
        "78": {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {
                "model": ["104", 0],
                "shift": float(request["shift"]),
            },
        },
        "94": {
            "class_type": "TextEncodeAceStepAudio1.5",
            "inputs": {
                "clip": ["105", 0],
                "tags": str(request["prompt"]),
                "lyrics": str(request["lyrics"]),
                "seed": request_seed,
                "bpm": int(request["bpm"]),
                "duration": float(request["duration"]),
                "timesignature": normalize_timesignature(request["timesignature"]),
                "language": str(request["language"]),
                "keyscale": str(request["keyscale"]),
                "generate_audio_codes": bool(request["generate_audio_codes"]),
                "cfg_scale": float(request["cfg_scale"]),
                "temperature": float(request["temperature"]),
                "top_p": float(request["top_p"]),
                "top_k": int(request["top_k"]),
                "min_p": float(request["min_p"]),
            },
        },
        "98": {
            "class_type": "EmptyAceStep1.5LatentAudio",
            "inputs": {
                "seconds": float(request["duration"]),
                "batch_size": 1,
            },
        },
        "47": {
            "class_type": "ConditioningZeroOut",
            "inputs": {
                "conditioning": ["94", 0],
            },
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["78", 0],
                "seed": request_seed,
                "steps": int(request["inferenceSteps"]),
                "cfg": float(request["guidance_scale"]),
                "sampler_name": str(request.get("sampler_name", "euler") or "euler"),
                "scheduler": str(request.get("scheduler", "simple") or "simple"),
                "positive": ["94", 0],
                "negative": ["47", 0],
                "latent_image": ["98", 0],
                "denoise": float(request.get("denoise", 1.0) or 1.0),
            },
        },
        "18": {
            "class_type": "VAEDecodeAudio",
            "inputs": {
                "samples": ["3", 0],
                "vae": ["106", 0],
            },
        },
    }


async def init_openstudio_ace_nodes(nodes_module: Any, backend_root: Path) -> None:
    if hasattr(nodes_module, "load_custom_node"):
        await nodes_module.load_custom_node(
            str(backend_root / "comfy_extras" / "nodes_ace.py"),
            module_parent="comfy_extras",
        )
        await nodes_module.load_custom_node(
            str(backend_root / "comfy_extras" / "nodes_audio.py"),
            module_parent="comfy_extras",
        )
    elif hasattr(nodes_module, "init_extra_nodes"):
        await nodes_module.init_extra_nodes(init_custom_nodes=False, init_api_nodes=False)

    from comfy_extras.nodes_model_advanced import NODE_CLASS_MAPPINGS as advanced_node_mappings

    nodes_module.NODE_CLASS_MAPPINGS.update(
        {
            key: value
            for key, value in advanced_node_mappings.items()
            if key == "ModelSamplingAuraFlow"
        }
    )


def get_backend_root() -> Path:
    backend_root = Path(__file__).with_name("openstudio_ace_backend") / "vendor_runtime"
    required = (
        backend_root / "nodes.py",
        backend_root / "folder_paths.py",
        backend_root / "comfy" / "sd.py",
        backend_root / "comfy_extras" / "nodes_ace.py",
    )
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError(
            "OpenStudio ACE split backend is missing packaged runtime files: "
            + ", ".join(missing)
        )
    return backend_root


def get_runtime_workspace(output_path: Path) -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        workspace = (
            Path(local_app_data).expanduser().resolve()
            / "OpenStudio"
            / "runtime"
            / "ace-split"
        )
    else:
        workspace = output_path.parent / ".openstudio-ace-split-runtime"
    for folder_name in ("output", "temp", "input"):
        (workspace / folder_name).mkdir(parents=True, exist_ok=True)
    return workspace


def configure_vendor_paths(*, checkpoint_root: Path, workspace_root: Path) -> None:
    import folder_paths

    folder_paths.add_model_folder_path(
        "diffusion_models", str(checkpoint_root / "diffusion_models"), True
    )
    folder_paths.add_model_folder_path(
        "text_encoders", str(checkpoint_root / "text_encoders"), True
    )
    folder_paths.add_model_folder_path("vae", str(checkpoint_root / "vae"), True)
    folder_paths.set_output_directory(str(workspace_root / "output"))
    folder_paths.set_temp_directory(str(workspace_root / "temp"))
    folder_paths.set_input_directory(str(workspace_root / "input"))
    folder_paths.filename_list_cache.clear()


def save_audio_to_wav(audio: dict[str, Any], output_path: Path) -> None:
    waveform = audio["waveform"][0].cpu().numpy()
    sample_rate = int(audio["sample_rate"])
    waveform = np.clip(waveform, -1.0, 1.0)
    pcm = (waveform.T * 32767.0).astype(np.int16)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output_path), "wb") as handle:
        handle.setnchannels(pcm.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def build_runtime_fingerprint(
    *,
    backend_root: Path,
    checkpoint_root: Path,
    latent: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fingerprint: dict[str, Any] = {
        "pythonExecutable": sys.executable,
        "pythonVersion": sys.version,
        "platform": platform.platform(),
        "backendRoot": str(backend_root),
        "checkpointRoot": str(checkpoint_root),
        "decodeMode": "full",
    }
    try:
        import torch
        import comfy.model_management

        intermediate_dtype = comfy.model_management.intermediate_dtype()
        intermediate_device = comfy.model_management.intermediate_device()
        fingerprint.update(
            {
                "torchVersion": str(getattr(torch, "__version__", "")),
                "cudaVersion": str(getattr(torch.version, "cuda", "") or ""),
                "cudaAvailable": bool(torch.cuda.is_available()),
                "intermediateDtype": str(intermediate_dtype),
                "intermediateDevice": str(intermediate_device),
            }
        )
        if torch.cuda.is_available():
            device_index = torch.cuda.current_device()
            fingerprint["cudaDeviceName"] = torch.cuda.get_device_name(device_index)
            fingerprint["cudaDeviceIndex"] = int(device_index)
    except Exception as exc:
        fingerprint["runtimeFingerprintError"] = f"{type(exc).__name__}: {exc}"

    if isinstance(latent, dict):
        latent_samples = latent.get("samples")
        if hasattr(latent_samples, "dtype"):
            fingerprint["latentDtype"] = str(latent_samples.dtype)
        if hasattr(latent_samples, "device"):
            fingerprint["latentDevice"] = str(latent_samples.device)
        if hasattr(latent_samples, "shape"):
            fingerprint["latentShape"] = list(latent_samples.shape)
    return fingerprint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the OpenStudio ACE split graph")
    parser.add_argument("--checkpoint-root", required=True)
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def run_ace_split_request(
    *,
    checkpoint_root: Path,
    request: dict[str, Any],
    output_path: Path,
) -> int:
    install_openstudio_ace_log_filter()
    backend_root = get_backend_root()
    workspace_root = get_runtime_workspace(output_path)

    sys.argv = [
        sys.argv[0],
        "--disable-auto-launch",
        "--disable-all-custom-nodes",
        "--disable-api-nodes",
        "--base-directory",
        str(workspace_root),
    ]
    sys.path.insert(0, str(backend_root))

    unet_name = choose_existing(
        checkpoint_root,
        [
            "diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors",
            "diffusion_models/acestep_v1.5_turbo.safetensors",
        ],
    )
    clip_name1 = choose_existing(
        checkpoint_root,
        ["text_encoders/qwen_0.6b_ace15.safetensors"],
    )
    clip_name2 = choose_existing(
        checkpoint_root,
        [
            "text_encoders/qwen_4b_ace15.safetensors",
            "text_encoders/qwen_1.7b_ace15.safetensors",
        ],
    )
    vae_name = choose_existing(
        checkpoint_root,
        ["vae/ace_1.5_vae.safetensors"],
    )
    enable_offline_generation_mode()

    configure_vendor_paths(checkpoint_root=checkpoint_root, workspace_root=workspace_root)

    import comfy.utils
    import execution
    import nodes

    comfy.utils.set_progress_bar_global_hook(progress_hook)
    asyncio.run(init_openstudio_ace_nodes(nodes, backend_root))

    try:
        emit_phase(
            "loading_diffusion_model",
            "Preparing the OpenStudio ACE graph...",
            details={
                "unetName": unet_name,
                "clipName1": clip_name1,
                "clipName2": clip_name2,
                "vaeName": vae_name,
            },
        )

        emit_phase(
            "encoding_conditioning",
            "Encoding conditioning with TextEncodeAceStepAudio1.5...",
            details={
                "generateAudioCodes": bool(request["generate_audio_codes"]),
                "duration": float(request["duration"]),
                "bpm": int(request["bpm"]),
                "timesignature": normalize_timesignature(request["timesignature"]),
                "language": request["language"],
                "keyscale": request["keyscale"],
            },
        )
        emit(
            {
                "kind": "diagnostic",
                "phase": "encoding_conditioning",
                "label": "runtime_fingerprint",
                "fingerprint": build_runtime_fingerprint(
                    backend_root=backend_root,
                    checkpoint_root=checkpoint_root,
                ),
            }
        )

        emit_phase(
            "sampling",
            "Sampling the OpenStudio ACE latent graph...",
            details={
                "steps": int(request["inferenceSteps"]),
                "samplerCfg": float(request["guidance_scale"]),
                "shift": float(request["shift"]),
                "samplerName": str(request.get("sampler_name", "euler") or "euler"),
                "scheduler": str(request.get("scheduler", "simple") or "simple"),
                "denoise": float(request.get("denoise", 1.0) or 1.0),
            },
        )

        prompt = build_openstudio_ace_prompt(
            request=request,
            unet_name=unet_name,
            clip_name1=clip_name1,
            clip_name2=clip_name2,
            vae_name=vae_name,
        )
        server = OpenStudioAceExecutorServer()
        executor = execution.PromptExecutor(server, cache_args={"ram": 0.0})
        executor.execute(
            prompt,
            str(request.get("requestId", "") or "openstudio-ace-request"),
            extra_data={},
            execute_outputs=["18"],
        )
        if not executor.success:
            raise RuntimeError("OpenStudio ACE graph execution failed.")

        decoded_cache_entry = asyncio.run(executor.caches.outputs.get("18"))
        if decoded_cache_entry is None or not getattr(decoded_cache_entry, "outputs", None):
            raise RuntimeError("OpenStudio ACE graph did not produce decoded audio.")
        audio = unwrap_executor_output(decoded_cache_entry.outputs[0])
        if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
            raise RuntimeError("OpenStudio ACE graph produced an invalid decoded audio object.")

        latent_cache_entry = asyncio.run(executor.caches.outputs.get("3"))
        latent_shape = None
        if latent_cache_entry is not None and getattr(latent_cache_entry, "outputs", None):
            latent_output = unwrap_executor_output(latent_cache_entry.outputs[0])
            if isinstance(latent_output, dict):
                latent_samples = latent_output.get("samples")
                if hasattr(latent_samples, "shape"):
                    latent_shape = list(latent_samples.shape)

        emit_phase(
            "decoding_audio",
            "Decoded audio with the OpenStudio ACE graph.",
            details={
                "decodeMode": "executor",
                "durationSeconds": float(request["duration"]),
            },
        )

        emit_phase("writing_output", "Writing generated audio to WAV...")
        save_audio_to_wav(audio, output_path)

        emit(
            {
                "kind": "result",
                "progress": 1.0,
                "phase": "done",
                "outputPath": str(output_path),
                "assets": {
                    "unetName": unet_name,
                    "clipName1": clip_name1,
                    "clipName2": clip_name2,
                    "vaeName": vae_name,
                },
                "conditioningSummary": {
                    "positiveEntries": 1,
                    "negativeEntries": 1,
                    "latentShape": latent_shape,
                },
            }
        )
        return 0
    except Exception:
        raise


def main() -> int:
    args = parse_args()
    checkpoint_root = Path(args.checkpoint_root).expanduser().resolve()
    request = json.loads(args.request_json)
    output_path = Path(args.output).expanduser().resolve()
    return run_ace_split_request(
        checkpoint_root=checkpoint_root,
        request=request,
        output_path=output_path,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        emit(
            {
                "kind": "error",
                "phase": CURRENT_PHASE,
                "message": str(exc),
                "errorType": type(exc).__name__,
            }
        )
        raise
