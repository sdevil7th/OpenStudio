#!/usr/bin/env python3
"""OpenStudio Stable Audio 3 generation worker."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import numpy as np
import soundfile as sf

ORIGINAL_STDOUT = sys.stdout
WORKER_PROTOCOL_VERSION = 2
MAX_FRAMED_PAYLOAD_BYTES = 8 * 1024 * 1024
SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_VERSION = hashlib.md5(SCRIPT_PATH.read_bytes()).hexdigest()[:16]
MODEL_ID = "stable-audio-3-medium"
STABLE_AUDIO_DEFAULT_STEPS = 8
STABLE_AUDIO_MIN_STEPS = 4
STABLE_AUDIO_MAX_STEPS = 32
STABLE_AUDIO_DEFAULT_CFG_SCALE = 1.0
STABLE_AUDIO_MIN_CFG_SCALE = 0.1
STABLE_AUDIO_MAX_CFG_SCALE = 3.0
SOURCE_WORKFLOWS = {"variation", "inpaint-selection", "continue-clip"}
STABLE_SOURCE_DEFAULT_NOISE_AMOUNT = 0.5
STABLE_SOURCE_DEFAULT_EXTENSION_SECONDS = 8.0
STABLE_CONTINUATION_OVERLAP_SECONDS = 0.5
MIN_SOURCE_PEAK = 1.0e-5
MIN_SOURCE_RMS = 1.0e-6
MIN_OUTPUT_PEAK = 1.0e-4
MIN_OUTPUT_RMS = 1.0e-5


def emit_payload(payload: dict[str, Any]) -> None:
    if payload.get("backend") == "stable-audio-3":
        payload.setdefault("runtimeProfile", "")
        payload.setdefault("lmModel", "")
        payload.setdefault("attemptMode", "")
        payload.setdefault("lmBackend", "")
        payload.setdefault("lmStage", "")
    print(json.dumps(payload, ensure_ascii=False), file=ORIGINAL_STDOUT, flush=True)


def normalize_text(value: Any, fallback: str = "") -> str:
    if value is None:
        return fallback
    return str(value)


def normalize_float(value: Any, fallback: float) -> float:
    try:
        if value is None or value == "":
            return fallback
        parsed = float(value)
        if np.isfinite(parsed):
            return parsed
    except Exception:
        pass
    return fallback


def normalize_int(value: Any, fallback: int) -> int:
    try:
        if value is None or value == "":
            return fallback
        return int(float(value))
    except Exception:
        return fallback


def clamp_float(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def clamp_int(value: int, minimum: int, maximum: int) -> int:
    return min(maximum, max(minimum, value))


def source_payload(params: dict[str, Any]) -> dict[str, Any]:
    source = params.get("source")
    return source if isinstance(source, dict) else {}


def prepare_source_segment(params: dict[str, Any], output_path: Path, request_id: str) -> tuple[Path, dict[str, Any]]:
    source = source_payload(params)
    source_file = Path(normalize_text(source.get("filePath"))).expanduser()
    if not source_file.exists():
        raise RuntimeError(f"Source audio file does not exist: {source_file}")

    info = sf.info(str(source_file))
    clip_offset = max(0.0, normalize_float(source.get("clipOffset"), 0.0))
    clip_duration = max(0.01, normalize_float(source.get("clipDuration"), 0.0))
    start_frame = int(round(clip_offset * info.samplerate))
    frame_count = int(round(clip_duration * info.samplerate))
    data, samplerate = sf.read(str(source_file), start=start_frame, frames=frame_count, always_2d=True)
    if data.size == 0:
        raise RuntimeError("Source clip segment is empty after applying clip offset and duration.")
    actual_duration = float(data.shape[0]) / float(samplerate)
    source_peak = float(np.max(np.abs(data))) if data.size else 0.0
    source_rms = float(np.sqrt(np.mean(np.square(data)))) if data.size else 0.0
    if actual_duration < 0.05:
        raise RuntimeError("Source clip segment is too short for Stable Audio source generation.")
    if source_peak < MIN_SOURCE_PEAK or source_rms < MIN_SOURCE_RMS:
        raise RuntimeError("Source clip is near-silent. Stable Audio source workflows need an audible source clip.")
    segment_path = output_path.parent / f"{request_id}_stable_source.wav"
    sf.write(str(segment_path), data, samplerate)
    source_stats = analyze_audio_array(data.astype(np.float32), samplerate)
    return segment_path, {
        "clipDuration": actual_duration,
        "requestedClipDuration": clip_duration,
        "extensionDuration": max(
            0.01,
            normalize_float(source.get("extensionDuration"), STABLE_SOURCE_DEFAULT_EXTENSION_SECONDS),
        ),
        "inpaintRange": source.get("inpaintRange") if isinstance(source.get("inpaintRange"), dict) else None,
        "sourceClipId": normalize_text(source.get("sourceClipId")),
        "sourcePeak": source_peak,
        "sourceRms": source_rms,
        "sourceSampleRate": samplerate,
        "sourceStats": source_stats,
    }


def audio_to_array(audio: Any) -> np.ndarray:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().float().numpy()
    audio_array = np.asarray(audio)
    if audio_array.ndim == 3:
        audio_array = audio_array[0]
    if audio_array.ndim == 2 and audio_array.shape[0] <= 8:
        audio_array = audio_array.T
    if audio_array.ndim == 1:
        audio_array = np.stack([audio_array, audio_array], axis=-1)
    if not np.all(np.isfinite(audio_array)):
        bad_samples = int(audio_array.size - np.count_nonzero(np.isfinite(audio_array)))
        raise RuntimeError(f"Stable Audio returned {bad_samples} non-finite samples; refusing to write a corrupted WAV.")
    peak = float(np.max(np.abs(audio_array))) if audio_array.size else 0.0
    if peak > 0.98:
        audio_array = audio_array * (0.98 / peak)
    return audio_array.astype(np.float32)


def analyze_audio_array(audio_array: np.ndarray, sample_rate: int) -> dict[str, Any]:
    if audio_array.size == 0:
        return {
            "sampleRate": sample_rate,
            "durationSeconds": 0.0,
            "peak": 0.0,
            "rms": 0.0,
            "clippedFraction": 0.0,
        }
    abs_audio = np.abs(audio_array)
    return {
        "sampleRate": sample_rate,
        "durationSeconds": round(float(audio_array.shape[0]) / float(sample_rate), 3),
        "peak": round(float(np.max(abs_audio)), 6),
        "rms": round(float(np.sqrt(np.mean(np.square(audio_array)))), 6),
        "clippedFraction": round(float(np.mean(abs_audio >= 0.999)), 8),
    }


def minimum_expected_duration(expected_duration: float) -> float:
    if expected_duration <= 0.0:
        return 0.25
    return max(0.25, expected_duration * 0.75)


def near_silent_message(workflow: str, role: str) -> str:
    if workflow == "continue-clip" and role == "tail":
        return "Stable Audio produced a near-silent continuation; try a clearer continuation direction or longer source context."
    if workflow == "variation":
        return "Stable Audio produced a near-silent variation; try a clearer variation direction or a higher Variation Amount."
    if workflow == "inpaint-selection":
        return "Stable Audio produced near-silent inpaint audio; try a clearer replacement direction or a wider time selection."
    return "Stable Audio produced near-silent audio; try a clearer prompt."


def validate_audio_stats(
    stats: dict[str, Any],
    *,
    workflow: str,
    role: str,
    expected_duration: float,
) -> None:
    min_duration = minimum_expected_duration(expected_duration)
    duration = normalize_float(stats.get("durationSeconds"), 0.0)
    peak = normalize_float(stats.get("peak"), 0.0)
    rms = normalize_float(stats.get("rms"), 0.0)
    if duration < min_duration:
        raise RuntimeError(
            f"Stable Audio returned only {duration:.2f}s for {role}; expected about {expected_duration:.2f}s."
        )
    if peak < MIN_OUTPUT_PEAK or rms < MIN_OUTPUT_RMS:
        raise RuntimeError(near_silent_message(workflow, role))


def match_tail_loudness(
    audio_array: np.ndarray,
    *,
    target_peak: float = 0.0,
    target_rms: float = 0.0,
) -> np.ndarray:
    if audio_array.size == 0:
        return audio_array
    peak = float(np.max(np.abs(audio_array)))
    rms = float(np.sqrt(np.mean(np.square(audio_array))))
    if peak < 1.0e-5 or rms < 1.0e-6 or target_rms <= rms:
        return audio_array
    desired_scale = target_rms / rms
    headroom_scale = 0.98 / peak if peak > 0.0 else 1.0
    target_peak_scale = target_peak / peak if target_peak > peak else desired_scale
    scale = min(desired_scale, headroom_scale, target_peak_scale, 12.0)
    if scale <= 1.25:
        return audio_array
    return np.clip(audio_array * scale, -0.98, 0.98)


def prepare_output_audio(
    audio: Any,
    *,
    sample_rate: int,
    workflow: str,
    crop_start_seconds: float,
    expected_output_duration: float,
    target_peak: float,
    target_rms: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    audio_array = audio_to_array(audio)
    full_output_stats = analyze_audio_array(audio_array, sample_rate)
    tail_stats = None
    if crop_start_seconds > 0.0:
        start_frame = max(0, int(round(crop_start_seconds * sample_rate)))
        audio_array = audio_array[start_frame:]
        if audio_array.size == 0:
            raise RuntimeError("Stable Audio continuation returned no tail after cropping source context.")
        tail_stats = analyze_audio_array(audio_array, sample_rate)
        validate_audio_stats(
            tail_stats,
            workflow=workflow,
            role="tail",
            expected_duration=expected_output_duration,
        )
        audio_array = match_tail_loudness(
            audio_array,
            target_peak=target_peak,
            target_rms=target_rms,
        )
    output_stats = analyze_audio_array(audio_array, sample_rate)
    validate_audio_stats(
        output_stats,
        workflow=workflow,
        role="output",
        expected_duration=expected_output_duration,
    )
    return audio_array, {
        "fullOutputStats": full_output_stats,
        "tailStats": tail_stats,
        "outputStats": output_stats,
        "cropStartSeconds": crop_start_seconds,
        "expectedOutputDuration": expected_output_duration,
        "validation": "passed",
    }


def write_audio(
    output_path: Path,
    audio: Any,
    sample_rate: int = 44100,
    crop_start_seconds: float = 0.0,
    target_peak: float = 0.0,
    target_rms: float = 0.0,
    workflow: str = "text-to-audio",
    expected_output_duration: float = 0.0,
) -> dict[str, Any]:
    audio_array, diagnostics = prepare_output_audio(
        audio,
        sample_rate=sample_rate,
        workflow=workflow,
        crop_start_seconds=crop_start_seconds,
        expected_output_duration=expected_output_duration,
        target_peak=target_peak,
        target_rms=target_rms,
    )
    sf.write(str(output_path), audio_array, sample_rate)
    return diagnostics


def load_audio_tuple(path: Path) -> tuple[int, Any]:
    try:
        import torchaudio

        waveform, sample_rate = torchaudio.load(str(path))
        return sample_rate, waveform
    except Exception:
        try:
            import torch
        except Exception as exc:
            raise RuntimeError("Stable Audio source workflows need torchaudio or torch available in the runtime.") from exc

        data, sample_rate = sf.read(str(path), always_2d=True)
        tensor = torch.from_numpy(data.T.astype(np.float32))
        return sample_rate, tensor


def build_generation_request(
    workflow: str,
    params: dict[str, Any],
    *,
    source_audio: tuple[int, Any] | None = None,
    source_meta: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    prompt = normalize_text(params.get("prompt")).strip()
    if workflow in SOURCE_WORKFLOWS and not prompt:
        raise RuntimeError(
            "Stable Audio source workflows need a direction prompt. Describe how the source should change or continue."
        )

    duration = max(1.0, normalize_float(params.get("duration"), 30.0))
    kwargs: dict[str, Any] = {
        "prompt": prompt,
        "duration": duration,
    }
    details: dict[str, Any] = {
        "sourceClipId": "",
        "continuationCropStart": 0.0,
        "continuationOverlap": 0.0,
        "targetPeak": 0.0,
        "targetRms": 0.0,
        "expectedOutputDuration": duration,
        "sourceStats": None,
        "effectiveNoiseAmount": None,
    }

    negative_prompt = normalize_text(params.get("negative_prompt")).strip()
    if negative_prompt:
        kwargs["negative_prompt"] = negative_prompt

    seed = normalize_int(params.get("seed"), -1)
    if seed >= 0:
        kwargs["seed"] = seed

    requested_steps = normalize_int(params.get("steps"), STABLE_AUDIO_DEFAULT_STEPS)
    requested_cfg_scale = normalize_float(params.get("cfg_scale"), STABLE_AUDIO_DEFAULT_CFG_SCALE)
    effective_steps = clamp_int(
        requested_steps,
        STABLE_AUDIO_MIN_STEPS,
        STABLE_AUDIO_MAX_STEPS,
    )
    effective_cfg_scale = clamp_float(
        requested_cfg_scale,
        STABLE_AUDIO_MIN_CFG_SCALE,
        STABLE_AUDIO_MAX_CFG_SCALE,
    )
    kwargs["steps"] = effective_steps
    kwargs["cfg_scale"] = effective_cfg_scale
    details["effectiveSteps"] = effective_steps
    details["effectiveCfgScale"] = effective_cfg_scale
    parameter_adjustments: list[str] = []
    if effective_steps != requested_steps:
        parameter_adjustments.append(f"steps {requested_steps} -> {effective_steps}")
    if effective_cfg_scale != requested_cfg_scale:
        parameter_adjustments.append(f"cfg_scale {requested_cfg_scale} -> {effective_cfg_scale}")
    details["parameterAdjustments"] = parameter_adjustments

    if workflow in SOURCE_WORKFLOWS:
        if source_audio is None or source_meta is None:
            raise RuntimeError("Stable Audio source workflow is missing prepared source audio.")

        clip_duration = max(0.01, normalize_float(source_meta.get("clipDuration"), 0.0))
        details["sourceClipId"] = normalize_text(source_meta.get("sourceClipId"))
        details["sourceStats"] = source_meta.get("sourceStats")
        details["targetPeak"] = normalize_float(source_meta.get("sourcePeak"), 0.0)
        details["targetRms"] = normalize_float(source_meta.get("sourceRms"), 0.0)

        if workflow == "continue-clip":
            extension_duration = max(
                1.0,
                normalize_float(params.get("extension_duration"), normalize_float(source_meta.get("extensionDuration"), STABLE_SOURCE_DEFAULT_EXTENSION_SECONDS)),
            )
            overlap = min(STABLE_CONTINUATION_OVERLAP_SECONDS, max(0.0, clip_duration * 0.25))
            mask_start = max(0.0, clip_duration - overlap)
            kwargs["duration"] = clip_duration + extension_duration
            kwargs["inpaint_audio"] = source_audio
            kwargs["inpaint_mask_start_seconds"] = mask_start
            kwargs["inpaint_mask_end_seconds"] = clip_duration + extension_duration
            details["continuationCropStart"] = clip_duration
            details["continuationOverlap"] = overlap
            details["expectedOutputDuration"] = extension_duration
        elif workflow == "inpaint-selection":
            inpaint_range = source_meta.get("inpaintRange") or {}
            kwargs["duration"] = clip_duration
            kwargs["inpaint_audio"] = source_audio
            kwargs["inpaint_mask_start_seconds"] = normalize_float(
                params.get("inpaint_start"),
                normalize_float(inpaint_range.get("start"), 0.0),
            )
            kwargs["inpaint_mask_end_seconds"] = normalize_float(
                params.get("inpaint_end"),
                normalize_float(inpaint_range.get("end"), clip_duration),
            )
            details["expectedOutputDuration"] = clip_duration
        else:
            kwargs["duration"] = clip_duration
            kwargs["init_audio"] = source_audio
            noise_amount = clamp_float(
                normalize_float(params.get("noise_amount"), STABLE_SOURCE_DEFAULT_NOISE_AMOUNT),
                0.0,
                1.0,
            )
            kwargs["init_noise_level"] = noise_amount
            details["effectiveNoiseAmount"] = noise_amount
            details["expectedOutputDuration"] = clip_duration

    return kwargs, details


class StableAudioWorker:
    def __init__(self, model_root: Path) -> None:
        self.model_root = model_root
        self._model: Any | None = None
        self._lock = threading.Lock()

    def _emit_loading_progress(self, request_id: str, workflow: str, stop_event: threading.Event) -> None:
        started = time.monotonic()
        while not stop_event.wait(8.0):
            elapsed_ms = int((time.monotonic() - started) * 1000)
            progress = min(0.18, 0.07 + (elapsed_ms / 300000.0) * 0.10)
            emit_payload({
                "state": "loading",
                "progress": progress,
                "phase": "loading_model",
                "message": "Still loading the local Stable Audio 3 Medium snapshot...",
                "statusNote": "First load can take several minutes while weights move into memory.",
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "requestId": request_id,
                "elapsedMs": elapsed_ms,
                "protocolVersion": WORKER_PROTOCOL_VERSION,
                "scriptVersion": SCRIPT_VERSION,
            })

    def _emit_generation_progress(self, request_id: str, workflow: str, stop_event: threading.Event) -> None:
        started = time.monotonic()
        while not stop_event.wait(8.0):
            elapsed_ms = int((time.monotonic() - started) * 1000)
            progress = min(0.92, 0.20 + (elapsed_ms / 360000.0) * 0.72)
            emit_payload({
                "state": "generating",
                "progress": progress,
                "phase": "generating_audio",
                "message": "Still generating with Stable Audio 3 Medium...",
                "statusNote": "Sampling and decoding can take several minutes for longer durations.",
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "requestId": request_id,
                "elapsedMs": elapsed_ms,
                "protocolVersion": WORKER_PROTOCOL_VERSION,
                "scriptVersion": SCRIPT_VERSION,
            })

    def _disable_unavailable_triton_flex_attention(self) -> None:
        try:
            import triton  # noqa: F401
            return
        except Exception:
            pass

        try:
            import stable_audio_3.models.transformer as transformer

            transformer.flex_attention_available = False
            transformer.flex_attention = None
            transformer.flex_attention_compiled = None
        except Exception:
            pass

    def _load_local_model(self, workflow: str, request_id: str) -> Any:
        config_path = self.model_root / "model_config.json"
        ckpt_path = self.model_root / "model.safetensors"
        text_encoder_path = self.model_root / "t5gemma-b-b-ul2"
        missing = [
            str(path)
            for path in (config_path, ckpt_path, text_encoder_path)
            if not path.exists()
        ]
        if missing:
            raise RuntimeError("Stable Audio 3 local model snapshot is incomplete: " + ", ".join(missing))

        emit_payload({
            "state": "loading",
            "progress": 0.06,
            "phase": "loading_model_config",
            "message": "Reading local Stable Audio 3 model config...",
            "backend": "stable-audio-3",
            "modelId": MODEL_ID,
            "workflowId": workflow,
            "requestId": request_id,
        })

        import torch
        from stable_audio_3 import StableAudioModel
        from stable_audio_3.loading_utils import load_diffusion_cond
        self._disable_unavailable_triton_flex_attention()

        device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        model_half = device != "cpu"
        with config_path.open("r", encoding="utf-8") as handle:
            model_config = copy.deepcopy(json.load(handle))

        conditioning_configs = (
            model_config
            .get("model", {})
            .get("conditioning", {})
            .get("configs", [])
        )
        for conditioner in conditioning_configs:
            if conditioner.get("type") == "t5gemma":
                conditioner_config = conditioner.setdefault("config", {})
                conditioner_config.pop("repo_id", None)
                conditioner_config.pop("subfolder", None)
                conditioner_config["model_path"] = str(text_encoder_path)

        emit_payload({
            "state": "loading",
            "progress": 0.08,
            "phase": "loading_model_weights",
            "message": "Loading local Stable Audio 3 weights...",
            "statusNote": f"Using {device.upper()} from the imported OpenStudio model folder.",
            "backend": "stable-audio-3",
            "modelId": MODEL_ID,
            "workflowId": workflow,
            "requestId": request_id,
        })

        model = load_diffusion_cond(
            model_config,
            str(ckpt_path),
            device=device,
            model_half=model_half,
        )
        model.use_lora = False
        model.lora_names = []

        emit_payload({
            "state": "loading",
            "progress": 0.18,
            "phase": "model_ready",
            "message": "Stable Audio 3 Medium model is loaded.",
            "backend": "stable-audio-3",
            "modelId": MODEL_ID,
            "workflowId": workflow,
            "requestId": request_id,
        })
        return StableAudioModel(model, model_config, device, model_half)

    def _load_model(self, workflow: str, request_id: str) -> Any:
        with self._lock:
            if self._model is not None:
                return self._model

            stop_event = threading.Event()
            heartbeat = threading.Thread(
                target=self._emit_loading_progress,
                args=(request_id, workflow, stop_event),
                daemon=True,
            )
            heartbeat.start()
            try:
                self._model = self._load_local_model(workflow, request_id)
            except Exception as exc:
                raise RuntimeError(
                    "Could not load the imported Stable Audio 3 Medium snapshot from "
                    f"{self.model_root}. OpenStudio will not fall back to a Hugging Face download during generation."
                ) from exc
            finally:
                stop_event.set()
                heartbeat.join(timeout=1.0)
            return self._model

    def generate(self, workflow: str, params_json: str, output_path: Path, request_id: str) -> bool:
        try:
            params = json.loads(params_json)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            emit_payload({
                "state": "loading",
                "progress": 0.05,
                "phase": "loading_model",
                "message": "Loading Stable Audio 3 Medium...",
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "requestId": request_id,
                "protocolVersion": WORKER_PROTOCOL_VERSION,
                "scriptVersion": SCRIPT_VERSION,
            })
            model = self._load_model(workflow, request_id)

            segment_path = None
            source_meta = None
            source_audio = None
            if workflow in SOURCE_WORKFLOWS:
                segment_path, meta = prepare_source_segment(params, output_path, request_id)
                source_meta = meta
                source_audio = load_audio_tuple(segment_path)
            kwargs, request_details = build_generation_request(
                workflow,
                params,
                source_audio=source_audio,
                source_meta=source_meta,
            )
            source_clip_id = normalize_text(request_details.get("sourceClipId"))
            effective_steps = normalize_int(request_details.get("effectiveSteps"), STABLE_AUDIO_DEFAULT_STEPS)
            effective_cfg_scale = normalize_float(request_details.get("effectiveCfgScale"), STABLE_AUDIO_DEFAULT_CFG_SCALE)
            parameter_adjustments = request_details.get("parameterAdjustments") or []

            lora_path = normalize_text(params.get("lora_path"))
            if lora_path:
                if not Path(lora_path).expanduser().exists():
                    raise RuntimeError(f"LoRA file does not exist: {lora_path}")
                if hasattr(model, "load_lora"):
                    model.load_lora([str(Path(lora_path).expanduser())])
                else:
                    raise RuntimeError("The installed Stable Audio runtime does not support LoRA loading.")
                if hasattr(model, "set_lora_strength"):
                    model.set_lora_strength(normalize_float(params.get("lora_strength"), 1.0))

            emit_payload({
                "state": "generating",
                "progress": 0.2,
                "phase": "generating_audio",
                "message": "Generating with Stable Audio 3 Medium...",
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "sourceClipId": source_clip_id,
                "requestId": request_id,
                "effectiveSteps": effective_steps,
                "effectiveCfgScale": effective_cfg_scale,
                "sourceStats": request_details.get("sourceStats"),
                "generationDetails": {
                    "workflow": workflow,
                    "sourceSegment": str(segment_path) if segment_path else "",
                    "duration": kwargs.get("duration"),
                    "initNoiseLevel": kwargs.get("init_noise_level"),
                    "inpaintMaskStartSeconds": kwargs.get("inpaint_mask_start_seconds"),
                    "inpaintMaskEndSeconds": kwargs.get("inpaint_mask_end_seconds"),
                    "continuationCropStart": request_details.get("continuationCropStart"),
                    "continuationOverlap": request_details.get("continuationOverlap"),
                    "expectedOutputDuration": request_details.get("expectedOutputDuration"),
                },
                "statusNote": (
                    "Adjusted Stable Audio 3 Medium parameters to the supported safe range: "
                    + ", ".join(parameter_adjustments)
                    if parameter_adjustments
                    else "Using Stable Audio 3 Medium recommended sampling range."
                ),
            })

            generation_stop_event = threading.Event()
            generation_heartbeat = threading.Thread(
                target=self._emit_generation_progress,
                args=(request_id, workflow, generation_stop_event),
                daemon=True,
            )
            generation_heartbeat.start()
            try:
                try:
                    audio = model.generate(**kwargs)
                except TypeError as exc:
                    unsupported = ["negative_prompt", "steps", "cfg_scale"]
                    retry_kwargs = dict(kwargs)
                    for key in unsupported:
                        retry_kwargs.pop(key, None)
                    if retry_kwargs == kwargs:
                        raise
                    if workflow != "text-to-audio":
                        raise RuntimeError(
                            "The installed Stable Audio 3 runtime does not expose source-audio generation parameters."
                        ) from exc
                    audio = model.generate(**retry_kwargs)
            finally:
                generation_stop_event.set()
                generation_heartbeat.join(timeout=1.0)

            sample_rate = int(getattr(model, "sample_rate", 44100) or 44100)
            if isinstance(audio, tuple) and len(audio) == 2:
                first, second = audio
                if isinstance(first, (int, float)):
                    sample_rate = int(first)
                    audio = second
                elif isinstance(second, (int, float)):
                    sample_rate = int(second)
                    audio = first
            emit_payload({
                "state": "generating",
                "progress": 0.95,
                "phase": "writing_audio",
                "message": "Writing Stable Audio 3 output...",
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "sourceClipId": source_clip_id,
                "requestId": request_id,
            })
            output_stats = write_audio(
                output_path,
                audio,
                sample_rate,
                normalize_float(request_details.get("continuationCropStart"), 0.0),
                target_peak=normalize_float(request_details.get("targetPeak"), 0.0),
                target_rms=normalize_float(request_details.get("targetRms"), 0.0),
                workflow=workflow,
                expected_output_duration=normalize_float(request_details.get("expectedOutputDuration"), 0.0),
            )
            emit_payload({
                "state": "done",
                "progress": 1.0,
                "phase": "done",
                "message": "Stable Audio 3 generation complete.",
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "sourceClipId": source_clip_id,
                "outputFile": str(output_path),
                "requestId": request_id,
                "effectiveSteps": effective_steps,
                "effectiveCfgScale": effective_cfg_scale,
                "outputStats": output_stats.get("outputStats"),
                "fullOutputStats": output_stats.get("fullOutputStats"),
                "tailStats": output_stats.get("tailStats"),
                "outputDiagnostics": output_stats,
            })
            return True
        except Exception as exc:
            emit_payload({
                "state": "error",
                "progress": 0.0,
                "phase": "error",
                "message": str(exc),
                "error": str(exc),
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "requestId": request_id,
                "failureDetail": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
            })
            return False


def recv_exact(connection: socket.socket, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    while byte_count > 0:
        data = connection.recv(byte_count)
        if not data:
            raise ConnectionError("Socket closed before payload was received.")
        chunks.append(data)
        byte_count -= len(data)
    return b"".join(chunks)


def read_framed_json(connection: socket.socket) -> dict[str, Any]:
    header = recv_exact(connection, 4)
    (payload_size,) = struct.unpack(">I", header)
    if payload_size <= 0 or payload_size > MAX_FRAMED_PAYLOAD_BYTES:
        raise ValueError(f"Invalid worker payload size: {payload_size}")
    return json.loads(recv_exact(connection, payload_size).decode("utf-8"))


def write_framed_json(connection: socket.socket, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    connection.sendall(struct.pack(">I", len(encoded)))
    connection.sendall(encoded)


def run_worker(model_root: Path) -> None:
    worker = StableAudioWorker(model_root)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    emit_payload({
        "event": "ready",
        "port": port,
        "pid": os.getpid(),
        "backend": "stable-audio-3",
        "sessionMode": "persistent",
        "protocolVersion": WORKER_PROTOCOL_VERSION,
        "scriptVersion": SCRIPT_VERSION,
        "scriptPath": str(SCRIPT_PATH),
    })

    while True:
        connection, _ = server.accept()
        with connection:
            request = read_framed_json(connection)
            request_id = normalize_text(request.get("requestId")) or str(uuid.uuid4())
            write_framed_json(connection, {
                "accepted": True,
                "requestId": request_id,
                "protocolVersion": WORKER_PROTOCOL_VERSION,
                "scriptVersion": SCRIPT_VERSION,
                "pid": os.getpid(),
            })
            worker.generate(
                workflow=normalize_text(request.get("workflow")),
                params_json=normalize_text(request.get("params"), "{}"),
                output_path=Path(normalize_text(request.get("output"))).expanduser(),
                request_id=request_id,
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--model-root", required=True)
    args = parser.parse_args()
    if not args.worker:
        raise SystemExit("--worker is required")
    run_worker(Path(args.model_root).expanduser())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
