#!/usr/bin/env python3
"""OpenStudio Stable Audio 3 generation worker."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
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
from ai_execution_policy import worker_version
SCRIPT_VERSION = worker_version(SCRIPT_PATH)
MODEL_ID = "stable-audio-3-medium"
MODEL_LABEL = "Stable Audio 3 Medium"
STABLE_AUDIO_DEFAULT_STEPS = 8
STABLE_AUDIO_MIN_STEPS = 4
STABLE_AUDIO_MAX_STEPS = 32
STABLE_AUDIO_DEFAULT_CFG_SCALE = 1.0
STABLE_AUDIO_MIN_CFG_SCALE = 1.0
STABLE_AUDIO_MAX_CFG_SCALE = 1.0
SOURCE_WORKFLOWS = {"variation", "inpaint-selection", "continue-clip"}
STABLE_SOURCE_DEFAULT_NOISE_AMOUNT = 0.5
STABLE_SOURCE_DEFAULT_EXTENSION_SECONDS = 8.0
STABLE_CONTINUATION_OVERLAP_SECONDS = 0.5
MIN_SOURCE_PEAK = 1.0e-5
MIN_SOURCE_RMS = 1.0e-6
MIN_OUTPUT_PEAK = 1.0e-4
MIN_OUTPUT_RMS = 1.0e-5


def ffmpeg_binary_name() -> str:
    return "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"


def _candidate_ffmpeg_path(path: Path, binary_name: str) -> Path:
    return path / binary_name if path.is_dir() else path


def resolve_ffmpeg_executable() -> tuple[str | None, list[str]]:
    binary_name = ffmpeg_binary_name()
    searched: list[str] = []

    env_path = os.environ.get("OPENSTUDIO_FFMPEG_PATH", "").strip()
    if env_path:
        candidate = _candidate_ffmpeg_path(Path(env_path).expanduser(), binary_name)
        searched.append(str(candidate))
        if candidate.is_file():
            return str(candidate), searched

    path_match = shutil.which("ffmpeg")
    searched.append("PATH:ffmpeg")
    if path_match:
        return path_match, searched

    candidate_dirs = [
        SCRIPT_PATH.parent / "ffmpeg-runtime",
        SCRIPT_PATH.parent.parent,
        SCRIPT_PATH.parent.parent / "tools" / "ffmpeg-runtime",
        Path.cwd(),
        Path.cwd() / "tools" / "ffmpeg-runtime",
    ]
    seen: set[str] = set()
    for directory in candidate_dirs:
        candidate = directory / binary_name
        key = str(candidate.resolve(strict=False))
        if key in seen:
            continue
        seen.add(key)
        searched.append(str(candidate))
        if candidate.is_file():
            return str(candidate), searched

    return None, searched


def emit_payload(payload: dict[str, Any]) -> None:
    payload.setdefault("modelId", MODEL_ID)
    for key in ("message", "error", "statusNote"):
        if isinstance(payload.get(key), str):
            payload[key] = payload[key].replace("Stable Audio 3 Medium", MODEL_LABEL)
    if payload.get("backend") == "stable-audio-3":
        payload["backend"] = "diffusers-audio"
        payload.setdefault("runtimeProfile", "")
        payload.setdefault("lmModel", "")
        payload.setdefault("attemptMode", "")
        payload.setdefault("lmBackend", "")
        payload.setdefault("lmStage", "")
    # stdout is a JSON wire protocol; Windows console code pages must not alter it.
    print(json.dumps(payload, ensure_ascii=True), file=ORIGINAL_STDOUT, flush=True)


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


def normalize_audio_channels(data: np.ndarray, target_channels: int) -> np.ndarray:
    target_channels = max(1, int(target_channels))
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    if data.ndim != 2:
        raise RuntimeError("Source audio must be mono or multichannel PCM.")

    current_channels = data.shape[1]
    if current_channels == target_channels:
        return data.astype(np.float32, copy=False)
    if target_channels == 1:
        return np.mean(data, axis=1, keepdims=True).astype(np.float32, copy=False)
    if current_channels == 1:
        return np.repeat(data, target_channels, axis=1).astype(np.float32, copy=False)
    if current_channels > target_channels:
        return data[:, :target_channels].astype(np.float32, copy=False)

    repeats = int(np.ceil(target_channels / current_channels))
    return np.tile(data, (1, repeats))[:, :target_channels].astype(np.float32, copy=False)


def write_float_wav(path: Path, data: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data.astype(np.float32, copy=False), sample_rate, subtype="FLOAT")


def resample_wav_with_ffmpeg(
    input_path: Path,
    output_path: Path,
    *,
    sample_rate: int,
    channels: int,
) -> None:
    ffmpeg, searched_locations = resolve_ffmpeg_executable()
    if not ffmpeg:
        searched = "\n".join(f"  - {location}" for location in searched_locations)
        raise RuntimeError(
            "FFmpeg is required to resample source audio for Stable Audio 3. "
            f"Searched locations:\n{searched}"
        )

    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-ac",
        str(max(1, int(channels))),
        "-ar",
        str(max(1, int(sample_rate))),
        "-c:a",
        "pcm_f32le",
        "-f",
        "wav",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or "FFmpeg failed to resample the source audio."
        raise RuntimeError(f"Stable Audio 3 source resample failed: {detail}")


def get_model_audio_format(model: Any) -> tuple[int, int]:
    model_config = getattr(model, "model_config", {}) if model is not None else {}
    inner_model = model

    sample_rate = getattr(inner_model, "sample_rate", None)
    if not sample_rate and isinstance(model_config, dict):
        sample_rate = model_config.get("sample_rate")

    channels = getattr(inner_model, "io_channels", None)
    if not channels and isinstance(model_config, dict):
        channels = model_config.get("audio_channels")

    return max(1, normalize_int(sample_rate, 44100)), max(1, normalize_int(channels, 2))


def prepare_source_segment(
    params: dict[str, Any],
    output_path: Path,
    request_id: str,
    *,
    target_sample_rate: int,
    target_channels: int,
) -> tuple[Path, dict[str, Any]]:
    source = source_payload(params)
    source_file = Path(normalize_text(source.get("filePath"))).expanduser()
    if not source_file.exists():
        raise RuntimeError(f"Source audio file does not exist: {source_file}")

    info = sf.info(str(source_file))
    target_sample_rate = max(1, int(target_sample_rate))
    target_channels = max(1, int(target_channels))
    clip_offset = max(0.0, normalize_float(source.get("clipOffset"), 0.0))
    clip_duration = max(0.01, normalize_float(source.get("clipDuration"), 0.0))
    start_frame = int(round(clip_offset * info.samplerate))
    frame_count = int(round(clip_duration * info.samplerate))
    data, samplerate = sf.read(str(source_file), start=start_frame, frames=frame_count, always_2d=True)
    if data.size == 0:
        raise RuntimeError("Source clip segment is empty after applying clip offset and duration.")
    actual_duration = float(data.shape[0]) / float(samplerate)
    if actual_duration < 0.05:
        raise RuntimeError("Source clip segment is too short for Stable Audio source generation.")

    prepared_data = normalize_audio_channels(data, target_channels)
    segment_path = output_path.parent / f"{request_id}_stable_source.wav"
    resampled_from = None
    if samplerate != target_sample_rate:
        resampled_from = output_path.parent / f"{request_id}_stable_source_original.wav"
        write_float_wav(resampled_from, prepared_data, samplerate)
        resample_wav_with_ffmpeg(
            resampled_from,
            segment_path,
            sample_rate=target_sample_rate,
            channels=target_channels,
        )
        prepared_data, prepared_samplerate = sf.read(str(segment_path), always_2d=True, dtype="float32")
    else:
        prepared_samplerate = target_sample_rate
        write_float_wav(segment_path, prepared_data, prepared_samplerate)

    source_peak = float(np.max(np.abs(prepared_data))) if prepared_data.size else 0.0
    source_rms = float(np.sqrt(np.mean(np.square(prepared_data)))) if prepared_data.size else 0.0
    if source_peak < MIN_SOURCE_PEAK or source_rms < MIN_SOURCE_RMS:
        raise RuntimeError("Source clip is near-silent. Stable Audio source workflows need an audible source clip.")
    source_stats = analyze_audio_array(prepared_data.astype(np.float32), prepared_samplerate)
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
        "sourceSampleRate": prepared_samplerate,
        "sourceChannels": int(prepared_data.shape[1]) if prepared_data.ndim == 2 else 1,
        "originalSampleRate": samplerate,
        "originalChannels": int(info.channels),
        "preparedSampleRate": prepared_samplerate,
        "preparedChannels": int(prepared_data.shape[1]) if prepared_data.ndim == 2 else 1,
        "resampledSourcePath": str(resampled_from) if resampled_from else "",
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
    # Preserve unedited context and float headroom; default PCM16 would clip
    # and requantize samples outside a requested inpaint selection.
    sf.write(str(output_path), audio_array, sample_rate, subtype="FLOAT")
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
    from diffusers_audio_pipeline import MINIMAX_MODEL, model_workflows, normalize_song_lyrics
    if workflow not in model_workflows(MODEL_ID):
        raise ValueError(f"{MODEL_ID} does not support {workflow}.")
    prompt = normalize_text(params.get("prompt")).strip()
    if MODEL_ID == MINIMAX_MODEL:
        duration = clamp_float(normalize_float(params.get("duration"), 60), 5, 300)
        lyrics = normalize_song_lyrics(normalize_text(params.get("lyrics")))
        if workflow == "structured-song":
            lyrics = "\n".join(f"[{tag}]\n{normalize_text(params.get(tag)).strip()}"
                               for tag in ("verse", "chorus", "bridge") if normalize_text(params.get(tag)).strip())
            prompt = "\n".join(part for part in (prompt, normalize_text(params.get("vocals")), normalize_text(params.get("arrangement"))) if part)
        if not prompt or not lyrics:
            raise ValueError("MiniMax song generation needs a music description and lyrics.")
        steps = clamp_int(normalize_int(params.get("steps"), 30), 1, 100)
        return dict(prompt=prompt, lyrics=lyrics, duration=duration, steps=steps,
                    seed=normalize_int(params.get("seed"), -1)), {
                        "expectedOutputDuration": 0,  # The model may stop early.
                        "effectiveSteps": steps, "parameterAdjustments": [],
                    }
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
        "sourceOriginalSampleRate": None,
        "sourceOriginalChannels": None,
        "sourcePreparedSampleRate": None,
        "sourcePreparedChannels": None,
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
        details["sourceOriginalSampleRate"] = source_meta.get("originalSampleRate")
        details["sourceOriginalChannels"] = source_meta.get("originalChannels")
        details["sourcePreparedSampleRate"] = source_meta.get("preparedSampleRate")
        details["sourcePreparedChannels"] = source_meta.get("preparedChannels")

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


class ExecutionPolicyError(RuntimeError):
    """A valid model/request cannot use its qualified execution policy."""


class StableAudioWorker:
    def __init__(self, model_root: Path) -> None:
        self.model_root = model_root
        self._variant = "legacy"
        self._model: Any | None = None
        self._lock = threading.Lock()
        self._conservative = False
        self._phase = ("generating_audio", "Preparing audio generation.", -1.0)
        self._phase_lock = threading.Lock()
        self._progress_context = None
        self._request_started = time.monotonic()
        self._request_duration = None
        self._request_prompt_tokens = 5000
        self._selection_note = ""

    def unload(self) -> None:
        import gc
        if self._model is not None and callable(getattr(self._model, "close", None)):
            self._model.close()
        self._model = None
        gc.collect()
        if "torch" in sys.modules:
            torch = sys.modules["torch"]
            for kind in ("cuda", "xpu"):
                api = getattr(torch, kind, None)
                if api is not None and api.is_available():
                    api.empty_cache()
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()

    def _phase_update(self, phase, message, fraction):
        with self._phase_lock:
            self._phase = (phase, message, fraction)
        if self._progress_context is not None:
            emit_payload({**self._progress_context, "state": "generating", "phase": phase,
                "message": message, "progress": max(0, fraction), "phaseProgress": fraction,
                "elapsedMs": int((time.monotonic() - self._request_started) * 1000),
                "statusNote": self._execution_note()})

    def _emit_loading_progress(self, request_id: str, workflow: str, stop_event: threading.Event) -> None:
        while not stop_event.wait(8.0):
            elapsed_ms = int((time.monotonic() - self._request_started) * 1000)
            emit_payload({
                "state": "loading",
                "progress": 0.0,
                "phaseProgress": -1.0,
                "phase": "loading_model",
                "message": "Still loading the local Stable Audio 3 Medium snapshot...",
                "statusNote": self._selection_note or "Checking the execution policy before loading weights.",
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "requestId": request_id,
                "elapsedMs": elapsed_ms,
                "protocolVersion": WORKER_PROTOCOL_VERSION,
                "scriptVersion": SCRIPT_VERSION,
            })

    def _emit_generation_progress(self, request_id: str, workflow: str, stop_event: threading.Event) -> None:
        while not stop_event.wait(8.0):
            elapsed_ms = int((time.monotonic() - self._request_started) * 1000)
            with self._phase_lock:
                phase, message, fraction = self._phase
            emit_payload({
                "state": "generating",
                "progress": max(0.0, fraction),
                "phaseProgress": fraction,
                "phase": phase,
                "message": message,
                "statusNote": self._execution_note(),
                "backend": "stable-audio-3",
                "modelId": MODEL_ID,
                "workflowId": workflow,
                "requestId": request_id,
                "elapsedMs": elapsed_ms,
                "protocolVersion": WORKER_PROTOCOL_VERSION,
                "scriptVersion": SCRIPT_VERSION,
            })

    def _load_local_model(self, workflow: str, request_id: str) -> Any:
        from diffusers_audio_pipeline import DiffusersAudioSession
        options, qualification_note = {}, ""
        if MODEL_ID == "minimax-music-3" and not self._conservative and self._variant == "legacy":
            import torch
            from ai_execution_policy import qualified_minimax_options
            options, qualification_note = qualified_minimax_options(torch, self.model_root,
                self._request_duration, self._request_prompt_tokens)
            if qualification_note and not options:
                raise ExecutionPolicyError(qualification_note + " Generation stopped before loading unquantized weights. "
                                   "Free the required memory or requalify the local INT8 profile for this request/runtime.")
        self._selection_note = (
            ("INT8 language model; original-precision audio components. " if MODEL_ID == "minimax-music-3"
             else "INT8 diffusion transformer; original-precision audio components. ") + qualification_note
            if options or self._variant == "int8" else "Unquantized model; standard memory placement.")
        self._phase_update("loading_model", "Loading the selected model precision.", -1.0)
        from ai_model_variants import variant_root
        selected_root = variant_root(MODEL_ID) if self._variant == "int8" else self.model_root
        model = DiffusersAudioSession(selected_root, MODEL_ID, conservative=self._conservative,
            request_duration=self._request_duration, request_prompt_tokens=self._request_prompt_tokens, **options)
        if qualification_note:
            model.execution_details["localQualification"] = qualification_note
        if options:
            model.execution_details["quantizedStage"] = "qualified-local"
        return model

    def _execution_note(self) -> str:
        summary = getattr(self._model, "execution_summary", None)
        if callable(summary):
            return " ".join(part for part in (summary(), self._selection_note) if part)
        return self._selection_note or "Checking the execution policy before loading weights."

    def _load_model(self, workflow: str, request_id: str) -> Any:
        with self._lock:
            if (self._model is not None and (getattr(self._model, "_partial", None) is not None
                                            or getattr(self._model, "_int8_stage", None) is not None)
                    and (self._request_duration > self._model.request_duration
                         or self._request_prompt_tokens > self._model.request_prompt_tokens)):
                self.unload()
            if self._model is not None and self._model.needs_reload():
                was_int8 = getattr(self._model, "quantization", "none") == "int8"
                self.unload()
                self._conservative = not was_int8
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
            except ExecutionPolicyError:
                raise
            except Exception as exc:
                raise RuntimeError(
                    "Could not load the imported Stable Audio 3 Medium snapshot from "
                    f"{self.model_root}: {exc}. OpenStudio will not download models during generation."
                ) from exc
            finally:
                stop_event.set()
                heartbeat.join(timeout=1.0)
            return self._model

    def generate(self, workflow: str, params_json: str, output_path: Path, request_id: str) -> bool:
        completed = False
        try:
            params = json.loads(params_json)
            from ai_model_variants import requested_variant, variant_root, validate_variant
            variant = requested_variant(params) if "modelVariant" in params else "legacy"
            if variant == "int8":
                validate_variant(variant_root(MODEL_ID), MODEL_ID)
            if variant != self._variant:
                self.unload()
                self._conservative = False
                self._variant = variant
            self._request_started = time.monotonic()
            self._progress_context = {"modelId": MODEL_ID, "workflowId": workflow, "requestId": request_id}
            self._selection_note = ""
            self._phase_update("loading_model", "Checking model precision and request memory.", -1.0)
            # Structured songs expand verse/chorus/bridge and arrangement into
            # the actual LM input. Budget that normalized text before loading
            # or deciding whether a warm placement can be reused.
            budget_params = build_generation_request(workflow, params)[0] if MODEL_ID == "minimax-music-3" else params
            self._request_duration = clamp_float(normalize_float(budget_params.get("duration"), 60), 5, 300)
            if MODEL_ID == "minimax-music-3":
                from ai_execution_policy import minimax_prompt_tokens
                self._request_prompt_tokens = minimax_prompt_tokens(variant_root(MODEL_ID) if variant == "int8" else self.model_root,
                    normalize_text(budget_params.get("prompt")), normalize_text(budget_params.get("lyrics")),
                    tokenizer=getattr(getattr(self._model, "pipe", None), "tokenizer", None))
            self._phase_update("generating_audio", "Preparing audio generation.", -1.0)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            emit_payload({
                "state": "loading",
                "progress": 0.05,
                "phaseProgress": -1.0,
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
            self._selection_note = (
                ("INT8 language model; original-precision audio components." if MODEL_ID == "minimax-music-3"
                 else "INT8 diffusion transformer; original-precision audio components.")
                if getattr(model, "quantization", "none") == "int8" else "Unquantized model; standard memory placement.")
            target_sample_rate, target_channels = get_model_audio_format(model)

            segment_path = None
            source_meta = None
            source_audio = None
            if workflow in SOURCE_WORKFLOWS:
                segment_path, meta = prepare_source_segment(
                    params,
                    output_path,
                    request_id,
                    target_sample_rate=target_sample_rate,
                    target_channels=target_channels,
                )
                source_meta = meta
                source_audio = load_audio_tuple(segment_path)
            kwargs, request_details = build_generation_request(
                workflow,
                params,
                source_audio=source_audio,
                source_meta=source_meta,
            )
            # Resolve a random seed once so an OOM retry keeps the same request.
            if kwargs.get("seed", -1) < 0:
                kwargs["seed"] = int.from_bytes(os.urandom(4), "little")
            source_clip_id = normalize_text(request_details.get("sourceClipId"))
            effective_steps = normalize_int(request_details.get("effectiveSteps"), STABLE_AUDIO_DEFAULT_STEPS)
            effective_cfg_scale = normalize_float(request_details.get("effectiveCfgScale"), STABLE_AUDIO_DEFAULT_CFG_SCALE)
            parameter_adjustments = request_details.get("parameterAdjustments") or []

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
                    "execution": getattr(model, "execution_details", {}),
                    "workflow": workflow,
                    "sourceSegment": str(segment_path) if segment_path else "",
                    "sourceOriginalSampleRate": request_details.get("sourceOriginalSampleRate"),
                    "sourceOriginalChannels": request_details.get("sourceOriginalChannels"),
                    "sourcePreparedSampleRate": request_details.get("sourcePreparedSampleRate"),
                    "sourcePreparedChannels": request_details.get("sourcePreparedChannels"),
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
                    else self._execution_note()
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
                import torch
                for attempt in range(2):
                    try:
                        audio = model.generate(workflow=workflow, progress_callback=self._phase_update, **kwargs)
                        break
                    except torch.OutOfMemoryError as exc:
                        if getattr(model, "quantization", "none") == "int8":
                            raise RuntimeError("Not enough memory for this INT8 request. Generation stopped; "
                                               "it will not retry with unquantized weights. Close other GPU applications "
                                               "or reduce the requested duration.") from exc
                        if attempt or self._conservative:
                            raise RuntimeError("Not enough memory for this request even with reduced-memory offloading. Close other GPU applications or choose a smaller model/duration.") from exc
                        # Release traceback tensors before rebuilding hooks. No
                        # output has been published and all request values stay fixed.
                        exc.__traceback__ = None
                        model = None
                        self.unload()
                        self._conservative = True
                        self._phase_update("loading_model", "Memory limit reached; reloading with reduced-memory offloading.", -1.0)
                        model = self._load_model(workflow, request_id)
            finally:
                generation_stop_event.set()
                generation_heartbeat.join(timeout=1.0)

            sample_rate = target_sample_rate
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
                "phaseProgress": -1.0,
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
                "generationDetails": {"execution": getattr(model, "execution_details", {}), "resolvedSeed": kwargs["seed"]},
            })
            completed = True
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
        finally:
            self._progress_context = None
            if not completed:
                model = None
                self.unload()


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
    server.settimeout(1.0)
    last_request_finished = time.monotonic()
    port = server.getsockname()[1]
    emit_payload({
        "event": "ready",
        "modelId": MODEL_ID,
        "port": port,
        "pid": os.getpid(),
        "backend": "stable-audio-3",
        "sessionMode": "persistent",
        "protocolVersion": WORKER_PROTOCOL_VERSION,
        "scriptVersion": SCRIPT_VERSION,
        "scriptPath": str(SCRIPT_PATH),
    })

    while True:
        try:
            connection, _ = server.accept()
        except socket.timeout:
            from ai_execution_policy import release_idle_weights, host_available
            if worker._model is not None and release_idle_weights(
                    time.monotonic() - last_request_finished, host_available()):
                worker.unload()
                worker._conservative = False
            continue
        with connection:
            request = read_framed_json(connection)
            request_id = normalize_text(request.get("requestId")) or str(uuid.uuid4())
            if request.get("modelId") != MODEL_ID:
                write_framed_json(connection, {"accepted": False, "requestId": request_id,
                                              "error": "Worker model does not match the request."})
                continue
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
            last_request_finished = time.monotonic()


def main() -> int:
    parser = argparse.ArgumentParser()
    global MODEL_ID, MODEL_LABEL
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--model-id", choices=["stable-audio-3-medium", "minimax-music-3"], default="stable-audio-3-medium")
    parser.add_argument("--model-root", required=True)
    args = parser.parse_args()
    MODEL_ID = args.model_id
    from ai_execution_policy import configure_allocator_environment
    configure_allocator_environment(MODEL_ID)
    MODEL_LABEL = "MiniMax Music 3" if MODEL_ID == "minimax-music-3" else "Stable Audio 3 Medium"
    if not args.worker:
        raise SystemExit("--worker is required")
    run_worker(Path(args.model_root).expanduser())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
