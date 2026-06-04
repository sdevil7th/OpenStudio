#!/usr/bin/env python3
"""
OpenStudio ACE-Step Diffusers generation helper.

The native app talks to this script in two modes:
1. one-shot CLI generation for probes/debugging
2. a persistent localhost worker so the ACE-Step Diffusers pipeline stays warm
"""

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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf

from ai_runtime_probe import (
    DEFAULT_MUSIC_GEN_MODEL,
    DEFAULT_MUSIC_GEN_MODEL_REPO,
    resolve_music_gen_checkpoint_root,
)


DEFAULT_UI_MODEL_ID = DEFAULT_MUSIC_GEN_MODEL
DEFAULT_DIFFUSERS_MODEL_ID = DEFAULT_MUSIC_GEN_MODEL_REPO
DEFAULT_SAMPLE_RATE = 48_000
DEFAULT_DURATION_SECONDS = 30.0
DEFAULT_STEPS = 8
DEFAULT_SHIFT = 3.0
DEFAULT_LANGUAGE = "en"
DEFAULT_TIMESIGNATURE = "4/4"
DEFAULT_KEYSCALE = "C major"
DEFAULT_BPM = 120
HEARTBEAT_INTERVAL_SEC = 5.0
WORKER_PROTOCOL_VERSION = 2
MAX_FRAMED_PAYLOAD_BYTES = 8 * 1024 * 1024
SOURCE_WORKFLOWS = {"variation", "inpaint-selection", "continue-clip"}
SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_VERSION = hashlib.md5(SCRIPT_PATH.read_bytes()).hexdigest()[:16]
ORIGINAL_STDOUT = sys.stdout
ORIGINAL_STDERR = sys.stderr


ProgressCallback = Callable[[str, float, str], None]


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
        SCRIPT_PATH.parent,
        SCRIPT_PATH.parent.parent,
        Path.cwd(),
        Path.cwd() / "tools",
        SCRIPT_PATH.parent / "tools",
        SCRIPT_PATH.parent.parent / "tools",
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


class GenerationFailure(RuntimeError):
    def __init__(self, message: str, *, progress: float = 0.0, **payload: Any) -> None:
        super().__init__(message)
        self.message = message
        self.progress = progress
        self.payload = payload


class StructuredStderrMirror:
    def __init__(self, downstream: Any) -> None:
        self._downstream = downstream
        self._buffer = ""
        self._lock = threading.Lock()

    def write(self, data: str) -> int:
        written = self._downstream.write(data)
        self._downstream.flush()
        if not data:
            return written

        lines: list[str] = []
        with self._lock:
            self._buffer += data
            while True:
                newline_pos = self._buffer.find("\n")
                carriage_pos = self._buffer.find("\r")
                candidates = [pos for pos in (newline_pos, carriage_pos) if pos >= 0]
                if not candidates:
                    break
                split_pos = min(candidates)
                line = self._buffer[:split_pos].strip()
                self._buffer = self._buffer[split_pos + 1 :]
                if line:
                    lines.append(line)

        for line in lines:
            emit_payload(
                {
                    "event": "stderr",
                    "phase": "stderr",
                    "message": line,
                    "line": line,
                    "pid": os.getpid(),
                }
            )
        return written

    def flush(self) -> None:
        self._downstream.flush()

    def isatty(self) -> bool:
        return bool(getattr(self._downstream, "isatty", lambda: False)())


def install_stream_mirrors() -> None:
    sys.stderr = StructuredStderrMirror(ORIGINAL_STDERR)


def emit_payload(payload: dict[str, Any]) -> None:
    normalized = dict(payload)
    if "progress" in normalized:
        normalized["progress"] = round(float(normalized.get("progress", 0.0)), 4)
    ORIGINAL_STDOUT.write(json.dumps(normalized, ensure_ascii=False) + "\n")
    ORIGINAL_STDOUT.flush()


def emit(state: str, progress: float, **kwargs: Any) -> None:
    payload = {"state": state, "progress": progress}
    payload.update(kwargs)
    emit_payload(payload)


def normalize_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def normalize_int(value: Any, default: int) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def normalize_optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return None
    return parsed


def normalize_float(value: Any, default: float) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def normalize_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def normalize_timesignature(value: Any) -> str:
    text = normalize_text(value, DEFAULT_TIMESIGNATURE)
    if "/" in text:
        return text
    parsed = normalize_int(text, 4)
    return f"{max(1, parsed)}/4"


def normalize_seed(value: Any) -> tuple[int | None, int | None]:
    if value is None or value == "":
        return None, None
    requested = normalize_int(value, -1)
    if requested < 0:
        return requested, None
    return requested, min(requested, (2**31) - 1)


def get_openstudio_log_root() -> Path:
    override = os.environ.get("OPENSTUDIO_AI_TRACE_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve()

    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        if local_app_data:
            return Path(local_app_data).expanduser().resolve() / "OpenStudio" / "logs"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "OpenStudio" / "logs"

    xdg_state_home = os.environ.get("XDG_STATE_HOME", "").strip()
    if xdg_state_home:
        return Path(xdg_state_home).expanduser().resolve() / "OpenStudio" / "logs"
    return Path.home() / ".local" / "state" / "OpenStudio" / "logs"


def get_ai_trace_root() -> Path:
    root = get_openstudio_log_root() / "ai" / "music-generation"
    root.mkdir(parents=True, exist_ok=True)
    return root


def trace_safe_request_id(request_id: str) -> str:
    normalized = normalize_text(request_id, "unknown-request")
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in normalized)[:96]


class AITraceSession:
    def __init__(self, *, request_id: str, workflow: str, session_mode: str, model_id: str) -> None:
        self.request_id = trace_safe_request_id(request_id)
        self.path = get_ai_trace_root() / f"{int(time.time())}_{self.request_id}.jsonl"
        self._lock = threading.Lock()
        self.log_event(
            "session_started",
            workflow=workflow,
            sessionMode=session_mode,
            modelId=model_id,
            scriptVersion=SCRIPT_VERSION,
        )

    def trace_path(self) -> str:
        return str(self.path)

    def log_event(self, event: str, **payload: Any) -> None:
        record = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "event": event,
            "requestId": self.request_id,
            **payload,
        }
        try:
            with self._lock:
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        except Exception:
            pass

    def finalize(self) -> None:
        self.log_event("session_finished")


class ProgressReporter:
    def __init__(
        self,
        *,
        model_id: str,
        diffusers_model_id: str,
        cache_root: Path,
        request_id: str,
        session_mode: str,
        trace_path: str = "",
        backend: str = "unknown",
        run_mode: str = "cold",
    ) -> None:
        self.model_id = model_id
        self.diffusers_model_id = diffusers_model_id
        self.cache_root = cache_root
        self.request_id = request_id
        self.session_mode = session_mode
        self.backend = backend
        self.run_mode = run_mode
        self.trace_path = trace_path
        self.started_at = time.monotonic()
        self._lock = threading.Lock()
        self._stop_heartbeat = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None
        self._payload: dict[str, Any] = {
            "state": "idle",
            "progress": 0.0,
            "phase": "idle",
            "message": "",
            "backend": backend,
            "backendFamily": "ace_diffusers",
            "modelId": model_id,
            "musicGenerationModelId": model_id,
            "musicGenerationModelRepoId": diffusers_model_id,
            "musicGenerationCheckpointRoot": str(cache_root),
            "runMode": run_mode,
            "sessionMode": session_mode,
            "runtimeProfile": "ace-diffusers",
            "lmModel": "",
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "scriptVersion": SCRIPT_VERSION,
            "requestId": request_id,
            "tracePath": trace_path or None,
        }

    def _elapsed_ms(self) -> int:
        return int((time.monotonic() - self.started_at) * 1000)

    def _timestamp_ms(self) -> int:
        return int(time.time() * 1000)

    def _emit_locked(self, *, heartbeat: bool = False) -> None:
        payload = {key: value for key, value in self._payload.items() if value is not None}
        payload["elapsedMs"] = self._elapsed_ms()
        payload["heartbeatTs"] = self._timestamp_ms()
        if heartbeat:
            payload["heartbeat"] = True
        emit_payload(payload)

    def start_heartbeat(self) -> None:
        if self._heartbeat_thread is not None:
            return

        def loop() -> None:
            while not self._stop_heartbeat.wait(HEARTBEAT_INTERVAL_SEC):
                with self._lock:
                    state = str(self._payload.get("state", "idle"))
                    if state not in {"done", "error", "cancelled"}:
                        self._emit_locked(heartbeat=True)

        self._heartbeat_thread = threading.Thread(
            target=loop,
            name="OpenStudioAceDiffusersHeartbeat",
            daemon=True,
        )
        self._heartbeat_thread.start()

    def stop_heartbeat(self) -> None:
        self._stop_heartbeat.set()
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join(timeout=2.0)
            self._heartbeat_thread = None

    def set_backend(self, backend: str) -> None:
        with self._lock:
            self.backend = backend
            self._payload["backend"] = backend

    def update(self, state: str, progress: float, *, phase: str, message: str, **extra: Any) -> None:
        with self._lock:
            self._payload.update(
                {
                    "state": state,
                    "progress": progress,
                    "phase": phase,
                    "message": message,
                    "backend": self.backend,
                    "runMode": self.run_mode,
                    **extra,
                }
            )
            self._emit_locked()

    def progress(self, phase: str, progress: float, message: str) -> None:
        self.update("generating", progress, phase=phase, message=message)

    def fail(self, message: str, *, progress: float = 0.0, **extra: Any) -> None:
        self.update(
            "error",
            progress,
            phase="error",
            message=message,
            error=message,
            **extra,
        )

    def done(self, output_file: str) -> None:
        self.update(
            "done",
            1.0,
            phase="done",
            message="Music generation completed.",
            outputFile=output_file,
        )


@dataclass
class SourceRequest:
    path: Path
    source_duration: float
    extension_duration: float = 0.0


@dataclass
class GenerationSpec:
    workflow: str
    prompt: str
    lyrics: str
    vocal_language: str
    duration: float
    requested_seed: int | None
    seed: int | None
    steps: int
    shift: float
    bpm: int | None
    keyscale: str | None
    timesignature: str | None
    mode: str = "text_to_audio"
    audio_task: str | None = None
    repainting_start: float | None = None
    repainting_end: float | None = None
    audio_cover_strength: float = 1.0
    continuation_tail_duration: float = 0.0


def prepare_source_segment(
    *,
    raw_params: dict[str, Any],
    output_path: Path,
    request_id: str,
) -> SourceRequest:
    source = raw_params.get("source")
    if not isinstance(source, dict):
        raise GenerationFailure("Source-audio workflow requires a source clip payload.")

    source_file = Path(normalize_text(source.get("filePath"))).expanduser()
    if not source_file.exists():
        raise GenerationFailure(f"Source audio file does not exist: {source_file}")

    clip_offset = max(0.0, normalize_float(source.get("clipOffset"), 0.0))
    source_info = sf.info(str(source_file))
    fallback_duration = max(0.01, float(source_info.frames) / max(1, source_info.samplerate) - clip_offset)
    clip_duration = max(0.01, normalize_float(source.get("clipDuration"), fallback_duration))
    start_frame = int(round(clip_offset * source_info.samplerate))
    frame_count = int(round(clip_duration * source_info.samplerate))
    data, samplerate = sf.read(
        str(source_file),
        start=start_frame,
        frames=frame_count,
        always_2d=True,
    )
    if data.size == 0:
        raise GenerationFailure("Source clip segment is empty after applying clip offset and duration.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    segment_path = output_path.parent / f"{trace_safe_request_id(request_id)}_source_segment.wav"
    sf.write(str(segment_path), data, samplerate)
    extension_duration = max(
        0.01,
        normalize_float(raw_params.get("extension_duration", source.get("extensionDuration")), 20.0),
    )
    return SourceRequest(
        path=segment_path,
        source_duration=clip_duration,
        extension_duration=extension_duration,
    )


def build_generation_spec(
    workflow: str,
    raw_params: dict[str, Any],
    *,
    source_request: SourceRequest | None = None,
) -> GenerationSpec:
    prompt = normalize_text(raw_params.get("prompt"))
    if not prompt:
        raise GenerationFailure("ACE-Step generation requires a prompt.", progress=0.05)

    requested_seed, resolved_seed = normalize_seed(raw_params.get("seed"))
    steps = int(clamp(normalize_int(raw_params.get("inferenceSteps", raw_params.get("steps")), DEFAULT_STEPS), 1, 60))
    shift = clamp(normalize_float(raw_params.get("shift"), DEFAULT_SHIFT), 1.0, 10.0)
    duration = clamp(normalize_float(raw_params.get("duration"), DEFAULT_DURATION_SECONDS), 10.0, 600.0)
    bpm = normalize_optional_int(raw_params.get("bpm"))
    if bpm is not None:
        bpm = int(clamp(bpm, 20, 300))

    spec = GenerationSpec(
        workflow=workflow,
        prompt=prompt,
        lyrics=normalize_text(raw_params.get("lyrics")),
        vocal_language=normalize_text(raw_params.get("language", raw_params.get("vocal_language")), DEFAULT_LANGUAGE),
        duration=duration,
        requested_seed=requested_seed,
        seed=resolved_seed,
        steps=steps,
        shift=shift,
        bpm=bpm,
        keyscale=normalize_text(raw_params.get("keyscale")) or None,
        timesignature=normalize_timesignature(raw_params.get("timesignature")) or None,
    )

    if workflow == "variation":
        if source_request is None:
            raise GenerationFailure("Variation requires a source clip.")
        spec.mode = "audio_to_audio"
        spec.audio_task = "cover"
        spec.duration = source_request.source_duration
        spec.audio_cover_strength = clamp(
            normalize_float(raw_params.get("audio_cover_strength"), 0.85),
            0.0,
            1.0,
        )
    elif workflow == "inpaint-selection":
        if source_request is None:
            raise GenerationFailure("Inpaint requires a source clip.")
        inpaint_range = {}
        source = raw_params.get("source")
        if isinstance(source, dict) and isinstance(source.get("inpaintRange"), dict):
            inpaint_range = source["inpaintRange"]
        start = normalize_float(
            raw_params.get("repainting_start", raw_params.get("inpaint_start", inpaint_range.get("start"))),
            0.0,
        )
        end = normalize_float(
            raw_params.get("repainting_end", raw_params.get("inpaint_end", inpaint_range.get("end"))),
            source_request.source_duration,
        )
        start = clamp(start, 0.0, source_request.source_duration)
        end = clamp(end, start + 0.01, source_request.source_duration)
        spec.mode = "audio_to_audio"
        spec.audio_task = "repaint"
        spec.duration = source_request.source_duration
        spec.repainting_start = start
        spec.repainting_end = end
    elif workflow == "continue-clip":
        if source_request is None:
            raise GenerationFailure("Continue requires a source clip.")
        extension_duration = max(0.01, source_request.extension_duration)
        spec.mode = "audio_to_audio"
        spec.audio_task = "repaint"
        spec.duration = source_request.source_duration + extension_duration
        spec.repainting_start = source_request.source_duration
        spec.repainting_end = source_request.source_duration + extension_duration
        spec.continuation_tail_duration = extension_duration

    return spec


def convert_to_wav(input_path: Path, output_path: Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg, searched_locations = resolve_ffmpeg_executable()
    if ffmpeg:
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-ac",
            "2",
            "-ar",
            str(sample_rate),
            "-f",
            "wav",
            str(output_path),
        ]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            detail = result.stderr.strip() or "FFmpeg failed to convert the source audio."
            raise GenerationFailure(detail, progress=0.22, failureKind="source_audio_conversion_failed")
        return output_path

    data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
    if sr != sample_rate:
        searched = "\n".join(f"  - {location}" for location in searched_locations)
        raise GenerationFailure(
            "FFmpeg is required to resample source audio for ACE-Step. "
            f"Searched locations:\n{searched}",
            progress=0.22,
            failureKind="source_audio_conversion_failed",
        )
    sf.write(str(output_path), normalize_audio_array(data), sample_rate)
    return output_path


def normalize_audio_array(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        data = np.stack([data, data], axis=-1)
    if data.ndim != 2:
        raise ValueError("Audio must be mono or stereo.")
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    elif data.shape[1] > 2:
        data = data[:, :2]
    return np.clip(data.astype(np.float32, copy=False), -1.0, 1.0)


def load_audio_tensor(path: Path, sample_rate: int = DEFAULT_SAMPLE_RATE):
    import torch

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if sr != sample_rate:
        raise GenerationFailure(f"Expected {sample_rate} Hz source audio, got {sr} Hz.", progress=0.22)
    data = normalize_audio_array(data)
    return torch.from_numpy(data.T.copy()).float()


def pad_audio_tensor(audio_tensor: Any, *, target_duration: float, sample_rate: int):
    target_frames = max(1, int(round(target_duration * sample_rate)))
    current_frames = int(audio_tensor.shape[-1])
    if current_frames >= target_frames:
        return audio_tensor[..., :target_frames]

    import torch

    pad_frames = target_frames - current_frames
    padding = torch.zeros(
        (*audio_tensor.shape[:-1], pad_frames),
        dtype=audio_tensor.dtype,
        device=audio_tensor.device,
    )
    return torch.cat([audio_tensor, padding], dim=-1)


def output_to_soundfile_array(audio: Any) -> np.ndarray:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().float().numpy()
    data = np.asarray(audio, dtype=np.float32)
    if data.ndim == 3:
        data = data[0]
    if data.ndim == 2 and data.shape[0] <= 8 and data.shape[1] > data.shape[0]:
        data = data.T
    elif data.ndim == 1:
        data = np.stack([data, data], axis=-1)
    return normalize_audio_array(data)


def write_wav(audio: Any, output_path: Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output_path), output_to_soundfile_array(audio), sample_rate)
    return output_path


def normalize_audio_headroom(data: np.ndarray, *, headroom: float = 0.98) -> np.ndarray:
    if data.size == 0:
        return data
    peak = float(np.max(np.abs(data)))
    if peak > headroom and peak > 1.0e-9:
        data = data * (headroom / peak)
    return np.clip(data, -headroom, headroom)


def read_audio_segment(path: Path) -> tuple[np.ndarray, int]:
    data, samplerate = sf.read(str(path), dtype="float32", always_2d=True)
    return normalize_audio_array(data), samplerate


def mono_mix(data: np.ndarray) -> np.ndarray:
    normalized = normalize_audio_array(data)
    return np.mean(normalized, axis=1, dtype=np.float32)


def detect_first_active_frame(
    data: np.ndarray,
    samplerate: int,
    *,
    threshold_ratio: float = 0.08,
    minimum_threshold: float = 1.0e-5,
) -> int:
    mono = mono_mix(data)
    if mono.size == 0:
        return 0
    peak = float(np.max(np.abs(mono)))
    if peak <= minimum_threshold:
        return 0

    threshold = max(minimum_threshold, peak * threshold_ratio)
    frame_size = max(1, int(round(samplerate * 0.02)))
    hop_size = max(1, int(round(samplerate * 0.005)))
    last_start = max(0, mono.size - frame_size)
    for start in range(0, last_start + 1, hop_size):
        frame = mono[start : start + frame_size]
        if frame.size == 0:
            continue
        rms = float(np.sqrt(np.mean(np.square(frame, dtype=np.float64))))
        if rms >= threshold:
            active_indices = np.flatnonzero(np.abs(frame) >= threshold)
            if active_indices.size > 0:
                return start + int(active_indices[0])
            return start
    return 0


def active_rms(data: np.ndarray) -> float:
    mono = mono_mix(data)
    if mono.size == 0:
        return 0.0
    peak = float(np.max(np.abs(mono)))
    if peak <= 1.0e-9:
        return 0.0
    threshold = max(1.0e-5, peak * 0.05)
    active = np.abs(mono) >= threshold
    if int(np.count_nonzero(active)) < max(1, mono.size // 200):
        active = np.abs(mono) > 1.0e-7
    if not np.any(active):
        return 0.0
    return float(np.sqrt(np.mean(np.square(mono[active], dtype=np.float64))))


def fit_audio_length(data: np.ndarray, target_frames: int) -> np.ndarray:
    target = max(1, int(target_frames))
    if data.shape[0] == target:
        return data
    if data.shape[0] > target:
        return data[:target]
    pad = np.zeros((target - data.shape[0], data.shape[1]), dtype=data.dtype)
    return np.vstack([data, pad])


def align_generated_onset_to_source(
    generated: np.ndarray,
    source: np.ndarray,
    samplerate: int,
    *,
    tolerance_seconds: float = 0.02,
) -> np.ndarray:
    target_frames = generated.shape[0]
    source_onset = detect_first_active_frame(source, samplerate)
    generated_onset = detect_first_active_frame(generated, samplerate)
    delta = int(source_onset - generated_onset)
    tolerance_frames = int(round(tolerance_seconds * samplerate))
    if abs(delta) <= tolerance_frames:
        return generated
    if delta > 0:
        pad = np.zeros((delta, generated.shape[1]), dtype=generated.dtype)
        return fit_audio_length(np.vstack([pad, generated]), target_frames)
    return fit_audio_length(generated[-delta:], target_frames)


def match_generated_loudness_to_source(
    generated: np.ndarray,
    source: np.ndarray,
    *,
    headroom: float = 10.0 ** (-1.0 / 20.0),
    max_upward_gain: float = 1.25,
) -> np.ndarray:
    source_level = active_rms(source)
    generated_level = active_rms(generated)
    if source_level <= 1.0e-9 or generated_level <= 1.0e-9:
        return normalize_audio_headroom(generated, headroom=headroom)

    gain = source_level / generated_level
    gain = min(gain, max_upward_gain)
    peak = float(np.max(np.abs(generated)))
    if peak > 1.0e-9:
        gain = min(gain, headroom / peak)
    return normalize_audio_headroom(generated * gain, headroom=headroom)


def postprocess_variation_audio(
    generated: np.ndarray,
    source_path: Path,
    *,
    target_duration: float,
    samplerate: int,
) -> np.ndarray:
    source, source_samplerate = read_audio_segment(source_path)
    if source_samplerate != samplerate:
        converted_path = source_path.with_name(source_path.stem + "_postprocess_48k.wav")
        convert_to_wav(source_path, converted_path, samplerate)
        source, _source_samplerate = read_audio_segment(converted_path)

    target_frames = max(1, int(round(target_duration * samplerate)))
    generated = fit_audio_length(normalize_audio_array(generated), target_frames)
    source = fit_audio_length(source, target_frames)
    generated = align_generated_onset_to_source(generated, source, samplerate)
    return match_generated_loudness_to_source(generated, source)


def crop_continuation_tail(
    *,
    generated_path: Path,
    output_path: Path,
    source_duration: float,
    extension_duration: float,
) -> None:
    info = sf.info(str(generated_path))
    start_frame = max(0, int(round(source_duration * info.samplerate)))
    frame_count = max(1, int(round(extension_duration * info.samplerate)))
    data, samplerate = sf.read(
        str(generated_path),
        start=start_frame,
        frames=frame_count,
        always_2d=True,
    )
    if data.size == 0:
        raise GenerationFailure(
            "ACE-Step continuation completed, but no generated tail was available to import.",
            progress=0.97,
        )
    sf.write(str(output_path), normalize_audio_headroom(data), samplerate)


def build_diffusers_kwargs(
    spec: GenerationSpec,
    *,
    generator: Any = None,
    src_audio: Any = None,
    reference_audio: Any = None,
    source_duration: float | None = None,
) -> dict[str, Any]:
    audio_duration = spec.duration
    if spec.audio_task == "repaint" and source_duration and spec.workflow != "continue-clip":
        audio_duration = source_duration

    kwargs: dict[str, Any] = {
        "prompt": spec.prompt.strip(),
        "lyrics": spec.lyrics or "",
        "audio_duration": float(audio_duration),
        "vocal_language": spec.vocal_language.strip() or DEFAULT_LANGUAGE,
        "num_inference_steps": spec.steps,
        "guidance_scale": 1.0,
        "shift": spec.shift,
        "generator": generator,
        "output_type": "pt",
        "return_dict": True,
        "task_type": "text2music",
    }
    if spec.bpm is not None:
        kwargs["bpm"] = spec.bpm
    if spec.keyscale:
        kwargs["keyscale"] = spec.keyscale
    if spec.timesignature:
        kwargs["timesignature"] = spec.timesignature

    if spec.mode == "audio_to_audio" and spec.audio_task == "repaint":
        kwargs.update(
            {
                "task_type": "repaint",
                "src_audio": src_audio,
                "reference_audio": reference_audio,
                "repainting_start": spec.repainting_start,
                "repainting_end": spec.repainting_end,
            }
        )
    elif spec.mode == "audio_to_audio" and spec.audio_task == "cover":
        kwargs.update(
            {
                "task_type": "cover",
                "reference_audio": reference_audio,
                "audio_cover_strength": spec.audio_cover_strength,
            }
        )
        if src_audio is not None:
            kwargs["src_audio"] = src_audio
    return kwargs


class DiffusersAcePipelineManager:
    def __init__(self, *, model_id: str, cache_root: Path, enable_group_offload: bool) -> None:
        self.model_id = model_id
        self.cache_root = cache_root
        self.enable_group_offload = enable_group_offload
        self.pipe = None
        self.sample_rate = DEFAULT_SAMPLE_RATE
        self.backend = "unknown"
        self._load_lock = threading.Lock()

    def load(self, reporter: ProgressReporter | None = None):
        if self.pipe is not None:
            return self.pipe

        with self._load_lock:
            if self.pipe is not None:
                return self.pipe

            if reporter:
                reporter.update("loading", 0.05, phase="loading_model", message="Checking CUDA availability.")
            import torch

            if not torch.cuda.is_available():
                raise GenerationFailure(
                    "ACE-Step XL Turbo requires a CUDA GPU for this Diffusers backend.",
                    progress=0.05,
                    failureKind="cuda_required",
                )

            self.backend = "cuda"
            if reporter:
                reporter.set_backend("cuda")
                reporter.update("loading", 0.08, phase="loading_model", message="Loading ACE-Step Diffusers pipeline.")

            self.cache_root.mkdir(parents=True, exist_ok=True)
            os.environ.setdefault("HF_HOME", str(self.cache_root))
            os.environ.setdefault("HF_ENABLE_PARALLEL_LOADING", "YES")
            os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

            from diffusers import AceStepPipeline

            pipe = AceStepPipeline.from_pretrained(
                self.model_id,
                torch_dtype=torch.bfloat16,
                cache_dir=str(self.cache_root),
            )

            if reporter:
                reporter.update("loading", 0.14, phase="loading_model", message="Configuring ACE-Step VAE tiling.")
            if hasattr(pipe, "enable_vae_tiling"):
                pipe.enable_vae_tiling()
            elif hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
                pipe.vae.enable_tiling()

            if self.enable_group_offload and hasattr(pipe, "transformer"):
                if reporter:
                    reporter.update("loading", 0.17, phase="loading_model", message="Enabling transformer group offload.")
                pipe.transformer.enable_group_offload(
                    onload_device=torch.device("cuda"),
                    offload_device=torch.device("cpu"),
                    offload_type="leaf_level",
                    use_stream=True,
                    record_stream=True,
                )
                if reporter:
                    reporter.update("loading", 0.2, phase="loading_model", message="Moving ACE-Step pipeline components to CUDA.")
                for name, component in pipe.components.items():
                    if name == "transformer" or not hasattr(component, "to"):
                        continue
                    component.to(torch.device("cuda"))
            else:
                if reporter:
                    reporter.update("loading", 0.2, phase="loading_model", message="Moving ACE-Step pipeline to CUDA.")
                pipe.to("cuda")

            self.pipe = pipe
            self.sample_rate = int(getattr(pipe, "sample_rate", DEFAULT_SAMPLE_RATE))
            if reporter:
                reporter.update("loading", 0.24, phase="loading_model", message="ACE-Step Diffusers pipeline is ready.")
            return pipe

    def generate(
        self,
        *,
        spec: GenerationSpec,
        source_request: SourceRequest | None,
        output_path: Path,
        reporter: ProgressReporter,
    ) -> Path:
        pipe = self.load(reporter)
        sample_rate = int(getattr(pipe, "sample_rate", self.sample_rate))
        source_duration: float | None = None
        src_audio = None
        reference_audio = None
        source_structure_conditioning: bool | None = None
        source_pattern_warning = ""

        if spec.mode == "audio_to_audio":
            if source_request is None:
                raise GenerationFailure("ACE-Step source workflow requires source audio.", progress=0.2)
            reporter.update("generating", 0.22, phase="preprocessing_audio", message="Converting source audio to 48 kHz stereo.")
            wav_path = output_path.parent / f"{trace_safe_request_id(reporter.request_id)}_48k_stereo.wav"
            convert_to_wav(source_request.path, wav_path, sample_rate)
            audio_tensor = load_audio_tensor(wav_path, sample_rate)
            source_audio_tensor = audio_tensor
            if spec.workflow == "continue-clip":
                audio_tensor = pad_audio_tensor(
                    audio_tensor,
                    target_duration=spec.duration,
                    sample_rate=sample_rate,
                )
            source_duration = float(audio_tensor.shape[-1]) / sample_rate

            if spec.audio_task == "repaint":
                if spec.repainting_start is None or spec.repainting_end is None:
                    raise GenerationFailure("Repaint start and end are required.", progress=0.22)
                if spec.repainting_end > source_duration + 0.001:
                    raise GenerationFailure(
                        f"Repaint end ({spec.repainting_end:.2f}s) exceeds source duration ({source_duration:.2f}s).",
                        progress=0.22,
                    )
                src_audio = audio_tensor
                reference_audio = source_audio_tensor
            elif spec.audio_task == "cover":
                reference_audio = source_audio_tensor
                if self._supports_source_audio_cover(pipe):
                    src_audio = source_audio_tensor
                    source_structure_conditioning = True
                else:
                    source_structure_conditioning = False
                    source_pattern_warning = (
                        "ACE-Step Diffusers source-audio cover conditioning is unavailable because this runtime "
                        "does not include audio tokenizer/detokenizer weights. The generated clip will be loudness- "
                        "and onset-aligned, but source-pattern preservation is diagnostic_only."
                    )

        generator = self._generator(spec.seed)
        kwargs = build_diffusers_kwargs(
            spec,
            generator=generator,
            src_audio=src_audio,
            reference_audio=reference_audio,
            source_duration=source_duration,
        )
        kwargs["callback_on_step_end"] = self._step_callback(spec.steps, reporter)
        kwargs["callback_on_step_end_tensor_inputs"] = ["latents"]

        reporter.update(
            "generating",
            0.28,
            phase="denoising",
            message=f"Starting ACE-Step denoising with {spec.steps} step(s).",
            requestedSeed=spec.requested_seed,
            resolvedSeed=spec.seed,
            backendFamily="ace_diffusers",
            diffusersRequestSummary=summarize_diffusers_kwargs(kwargs),
            sourceStructureConditioning=source_structure_conditioning,
            sourcePatternWarning=source_pattern_warning or None,
        )

        import torch

        with torch.inference_mode():
            result = pipe(**kwargs)

        reporter.update("generating", 0.94, phase="saving", message="Saving generated WAV.")
        if spec.workflow == "continue-clip":
            full_output_path = output_path.parent / f"{trace_safe_request_id(reporter.request_id)}_full.wav"
            write_wav(result.audios, full_output_path, sample_rate)
            crop_continuation_tail(
                generated_path=full_output_path,
                output_path=output_path,
                source_duration=source_request.source_duration if source_request else 0.0,
                extension_duration=spec.continuation_tail_duration,
            )
        elif spec.workflow == "variation" and source_request is not None:
            generated = output_to_soundfile_array(result.audios)
            processed = postprocess_variation_audio(
                generated,
                source_request.path,
                target_duration=source_request.source_duration,
                samplerate=sample_rate,
            )
            sf.write(str(output_path), processed, sample_rate)
        else:
            write_wav(result.audios, output_path, sample_rate)
        return output_path

    @staticmethod
    def _generator(seed: int | None):
        if seed is None:
            return None
        import torch

        return torch.Generator(device="cuda").manual_seed(seed)

    @staticmethod
    def _supports_source_audio_cover(pipe: Any) -> bool:
        return (
            getattr(pipe, "audio_tokenizer", None) is not None
            and getattr(pipe, "audio_token_detokenizer", None) is not None
        )

    @staticmethod
    def _step_callback(total_steps: int, reporter: ProgressReporter):
        total = max(1, int(total_steps))

        def callback(_pipe: Any, step_index: int, _timestep: Any, callback_kwargs: dict[str, Any]) -> dict[str, Any]:
            done = min(total, int(step_index) + 1)
            fraction = 0.3 + (done / total) * 0.6
            reporter.update(
                "generating",
                fraction,
                phase="denoising",
                message=f"Denoising step {done}/{total}.",
                phaseProgress=done / total,
            )
            return callback_kwargs

        return callback


def summarize_diffusers_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key, value in kwargs.items():
        if key.startswith("callback"):
            continue
        if key in {"src_audio", "reference_audio"} and value is not None:
            summary[key] = {
                "type": type(value).__name__,
                "shape": list(getattr(value, "shape", [])),
                "dtype": str(getattr(value, "dtype", "")),
            }
        elif key == "generator":
            summary[key] = value is not None
        else:
            summary[key] = value
    return summary


class WorkerSession:
    def __init__(self, *, ui_model_id: str, diffusers_model_id: str, cache_root: Path, enable_group_offload: bool) -> None:
        self.ui_model_id = ui_model_id
        self.diffusers_model_id = diffusers_model_id
        self.cache_root = cache_root
        self.manager = DiffusersAcePipelineManager(
            model_id=diffusers_model_id,
            cache_root=cache_root,
            enable_group_offload=enable_group_offload,
        )
        self._busy = False

    def generate(
        self,
        *,
        workflow: str,
        raw_params_json: str,
        output_path: Path,
        session_mode: str,
        request_id: str,
        request_model_id: str = "",
    ) -> bool:
        if self._busy:
            emit(
                "error",
                0.0,
                phase="busy",
                message="Another generation is already active in the worker.",
                error="Another generation is already active in the worker.",
                requestId=request_id,
                protocolVersion=WORKER_PROTOCOL_VERSION,
                scriptVersion=SCRIPT_VERSION,
            )
            return False

        self._busy = True
        trace_session = AITraceSession(
            request_id=request_id,
            workflow=workflow,
            session_mode=session_mode,
            model_id=request_model_id or self.ui_model_id,
        )
        reporter = ProgressReporter(
            model_id=request_model_id or self.ui_model_id,
            diffusers_model_id=self.diffusers_model_id,
            cache_root=self.cache_root,
            request_id=request_id,
            session_mode=session_mode,
            trace_path=trace_session.trace_path(),
            backend=self.manager.backend,
            run_mode="warm" if self.manager.pipe is not None else "cold",
        )
        reporter.start_heartbeat()
        try:
            try:
                raw_params = json.loads(raw_params_json)
                if not isinstance(raw_params, dict):
                    raise ValueError("params JSON must decode to an object")
            except Exception as exc:
                raise GenerationFailure(f"Invalid params JSON: {exc}", progress=0.03) from exc

            reporter.update(
                "loading",
                0.04,
                phase="validating_request",
                message="Validating ACE-Step Diffusers request.",
            )
            output_path.parent.mkdir(parents=True, exist_ok=True)
            source_request = (
                prepare_source_segment(
                    raw_params=raw_params,
                    output_path=output_path,
                    request_id=request_id,
                )
                if workflow in SOURCE_WORKFLOWS
                else None
            )
            spec = build_generation_spec(workflow, raw_params, source_request=source_request)
            trace_session.log_event(
                "request_contract",
                rawParams=raw_params,
                normalizedSpec={
                    "workflow": spec.workflow,
                    "duration": spec.duration,
                    "steps": spec.steps,
                    "shift": spec.shift,
                    "requestedSeed": spec.requested_seed,
                    "resolvedSeed": spec.seed,
                    "mode": spec.mode,
                    "audioTask": spec.audio_task,
                    "bpm": spec.bpm,
                    "keyscale": spec.keyscale,
                    "timesignature": spec.timesignature,
                    "vocalLanguage": spec.vocal_language,
                },
                backendFamily="ace_diffusers",
                diffusersModelId=self.diffusers_model_id,
                cacheRoot=str(self.cache_root),
            )
            final_output = self.manager.generate(
                spec=spec,
                source_request=source_request,
                output_path=output_path,
                reporter=reporter,
            )
            reporter.done(str(final_output))
            return True
        except GenerationFailure as failure:
            trace_session.log_event(
                "generation_failed",
                error=failure.message,
                payload=failure.payload,
            )
            reporter.fail(failure.message, progress=failure.progress, **failure.payload)
            return False
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"
            trace_session.log_event(
                "generation_exception",
                error=detail,
                traceback="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
            )
            reporter.fail(
                f"ACE-Step Diffusers generation failed: {detail}",
                progress=0.0,
                failureKind="ace_diffusers_failure",
                failureDetail=detail,
            )
            return False
        finally:
            reporter.stop_heartbeat()
            trace_session.finalize()
            self._busy = False


def recv_exact(connection: socket.socket, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining > 0:
        data = connection.recv(remaining)
        if not data:
            raise ConnectionError("Socket closed before the framed payload was fully received.")
        chunks.append(data)
        remaining -= len(data)
    return b"".join(chunks)


def recv_framed_json(connection: socket.socket) -> dict[str, Any]:
    header = recv_exact(connection, 4)
    payload_length = struct.unpack(">I", header)[0]
    if payload_length <= 0 or payload_length > MAX_FRAMED_PAYLOAD_BYTES:
        raise ValueError(f"Invalid framed payload length: {payload_length}")
    payload = recv_exact(connection, payload_length)
    parsed = json.loads(payload.decode("utf-8", errors="replace"))
    if not isinstance(parsed, dict):
        raise ValueError("Framed payload must decode to a JSON object.")
    parsed["_framedPayloadLength"] = payload_length
    return parsed


def send_framed_json(connection: socket.socket, payload: dict[str, Any]) -> int:
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(payload_bytes) > MAX_FRAMED_PAYLOAD_BYTES:
        raise ValueError(f"Framed payload exceeds the maximum allowed size: {len(payload_bytes)} bytes")
    connection.sendall(struct.pack(">I", len(payload_bytes)) + payload_bytes)
    return len(payload_bytes)


def run_worker_server(
    *,
    ui_model_id: str,
    diffusers_model_id: str,
    cache_root: Path,
    enable_group_offload: bool,
) -> None:
    session = WorkerSession(
        ui_model_id=ui_model_id,
        diffusers_model_id=diffusers_model_id,
        cache_root=cache_root,
        enable_group_offload=enable_group_offload,
    )
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]

    emit(
        "idle",
        0.0,
        event="ready",
        phase="worker_ready",
        message="ACE-Step Diffusers worker is ready.",
        port=port,
        backend=session.manager.backend,
        backendFamily="ace_diffusers",
        sessionMode="persistent",
        protocolVersion=WORKER_PROTOCOL_VERSION,
        scriptVersion=SCRIPT_VERSION,
        pid=os.getpid(),
        scriptPath=str(SCRIPT_PATH),
        modelId=ui_model_id,
        musicGenerationModelId=ui_model_id,
        musicGenerationModelRepoId=diffusers_model_id,
        musicGenerationCheckpointRoot=str(cache_root),
        availableProfiles=["ace-diffusers"],
        warmSessionCapable=True,
    )

    try:
        while True:
            connection, _address = server.accept()
            with connection:
                try:
                    request = recv_framed_json(connection)
                except Exception as exc:
                    send_framed_json(
                        connection,
                        {
                            "accepted": False,
                            "error": f"Invalid worker request frame: {exc}",
                            "failureKind": "worker_protocol",
                            "protocolVersion": WORKER_PROTOCOL_VERSION,
                            "scriptVersion": SCRIPT_VERSION,
                            "pid": os.getpid(),
                        },
                    )
                    continue

                command = normalize_text(request.get("command"))
                request_id = normalize_text(request.get("requestId"), str(uuid.uuid4()))
                request_protocol_version = normalize_int(request.get("protocolVersion"), WORKER_PROTOCOL_VERSION)
                request_script_version = normalize_text(request.get("scriptVersion"))
                if command == "shutdown":
                    send_framed_json(
                        connection,
                        {
                            "accepted": True,
                            "requestId": request_id,
                            "protocolVersion": WORKER_PROTOCOL_VERSION,
                            "scriptVersion": SCRIPT_VERSION,
                            "pid": os.getpid(),
                        },
                    )
                    break

                if request_protocol_version != WORKER_PROTOCOL_VERSION:
                    send_framed_json(
                        connection,
                        {
                            "accepted": False,
                            "requestId": request_id,
                            "error": (
                                "Worker protocol mismatch: "
                                f"app={request_protocol_version}, worker={WORKER_PROTOCOL_VERSION}"
                            ),
                            "failureKind": "worker_protocol",
                            "protocolVersion": WORKER_PROTOCOL_VERSION,
                            "scriptVersion": SCRIPT_VERSION,
                            "pid": os.getpid(),
                        },
                    )
                    continue

                if request_script_version and request_script_version != SCRIPT_VERSION:
                    send_framed_json(
                        connection,
                        {
                            "accepted": False,
                            "requestId": request_id,
                            "error": (
                                "Worker script version mismatch: "
                                f"app={request_script_version}, worker={SCRIPT_VERSION}"
                            ),
                            "failureKind": "worker_protocol",
                            "protocolVersion": WORKER_PROTOCOL_VERSION,
                            "scriptVersion": SCRIPT_VERSION,
                            "pid": os.getpid(),
                        },
                    )
                    continue

                if command != "generate":
                    send_framed_json(
                        connection,
                        {
                            "accepted": False,
                            "requestId": request_id,
                            "error": f"Unsupported worker command: {command}",
                            "failureKind": "worker_protocol",
                            "protocolVersion": WORKER_PROTOCOL_VERSION,
                            "scriptVersion": SCRIPT_VERSION,
                            "pid": os.getpid(),
                        },
                    )
                    continue

                workflow = normalize_text(request.get("workflow"), "text-to-music")
                raw_params_json = request.get("params")
                output = normalize_text(request.get("output"))
                request_model_id = normalize_text(request.get("modelId"), ui_model_id)
                if not isinstance(raw_params_json, str) or not output:
                    send_framed_json(
                        connection,
                        {
                            "accepted": False,
                            "error": "Generate requests require params JSON and output path.",
                            "requestId": request_id,
                            "failureKind": "worker_protocol",
                            "protocolVersion": WORKER_PROTOCOL_VERSION,
                            "scriptVersion": SCRIPT_VERSION,
                            "pid": os.getpid(),
                        },
                    )
                    continue

                send_framed_json(
                    connection,
                    {
                        "accepted": True,
                        "requestId": request_id,
                        "protocolVersion": WORKER_PROTOCOL_VERSION,
                        "scriptVersion": SCRIPT_VERSION,
                        "pid": os.getpid(),
                        "framedPayloadLength": int(request.get("_framedPayloadLength", 0)),
                    },
                )
                session.generate(
                    workflow=workflow,
                    raw_params_json=raw_params_json,
                    output_path=Path(output).expanduser().resolve(),
                    session_mode="persistent",
                    request_id=request_id,
                    request_model_id=request_model_id,
                )
    finally:
        server.close()


def resolve_one_shot_params_json(args: argparse.Namespace) -> str:
    sources = [
        bool(getattr(args, "params", "")),
        bool(getattr(args, "params_file", "")),
        bool(getattr(args, "params_stdin", False)),
    ]
    if sum(1 for source in sources if source) != 1:
        raise SystemExit("Exactly one of --params, --params-file, or --params-stdin is required unless --worker is used.")
    if args.params:
        return str(args.params)
    if args.params_file:
        return Path(args.params_file).expanduser().resolve().read_text(encoding="utf-8-sig")
    return sys.stdin.read()


def run_one_shot(args: argparse.Namespace) -> int:
    if not args.workflow or not args.output:
        raise SystemExit("--workflow and --output are required unless --worker is used.")
    raw_params_json = resolve_one_shot_params_json(args)
    cache_root = resolve_cache_root(args)
    session = WorkerSession(
        ui_model_id=args.music_gen_model,
        diffusers_model_id=args.model_id,
        cache_root=cache_root,
        enable_group_offload=(
            not args.disable_group_offload
            and normalize_bool(os.environ.get("OPENSTUDIO_ACE_ENABLE_GROUP_OFFLOAD"), True)
        ),
    )
    success = session.generate(
        workflow=args.workflow,
        raw_params_json=raw_params_json,
        output_path=Path(args.output).expanduser().resolve(),
        session_mode=normalize_text(args.session_mode, "oneshot"),
        request_id=normalize_text(args.request_id, str(uuid.uuid4())),
        request_model_id=args.music_gen_model,
    )
    return 0 if success else 1


def resolve_cache_root(args: argparse.Namespace) -> Path:
    explicit_cache_root = normalize_text(getattr(args, "cache_root", ""))
    if explicit_cache_root:
        return Path(explicit_cache_root).expanduser().resolve()
    checkpoint_root = normalize_text(getattr(args, "checkpoint_root", ""))
    return resolve_music_gen_checkpoint_root(checkpoint_root)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate music with ACE-Step Diffusers")
    parser.add_argument("--worker", action="store_true", help="Run as a persistent worker")
    parser.add_argument("--workflow", help="Workflow id to execute")
    parser.add_argument("--params", help="Workflow parameters JSON")
    parser.add_argument("--params-file", help="Path to workflow parameters JSON")
    parser.add_argument("--params-stdin", action="store_true", help="Read workflow parameters JSON from stdin")
    parser.add_argument("--output", help="Output WAV file path")
    parser.add_argument("--request-id", help="Request identifier for diagnostics")
    parser.add_argument("--checkpoint-root", default="", help="Compatibility alias for --cache-root")
    parser.add_argument("--cache-root", default="", help="Hugging Face cache root for ACE-Step Diffusers")
    parser.add_argument("--music-gen-model", default=DEFAULT_UI_MODEL_ID, help="OpenStudio UI model id")
    parser.add_argument("--model-id", default=DEFAULT_DIFFUSERS_MODEL_ID, help="Diffusers ACE-Step model repo id")
    parser.add_argument("--session-mode", default="oneshot", help="Session mode label to include in progress payloads")
    parser.add_argument("--disable-group-offload", action="store_true", help="Disable Diffusers transformer group offload")
    return parser.parse_args()


def main() -> None:
    install_stream_mirrors()
    args = parse_args()
    cache_root = resolve_cache_root(args)
    enable_group_offload = (
        not args.disable_group_offload
        and normalize_bool(os.environ.get("OPENSTUDIO_ACE_ENABLE_GROUP_OFFLOAD"), True)
    )
    if args.worker:
        run_worker_server(
            ui_model_id=args.music_gen_model,
            diffusers_model_id=args.model_id,
            cache_root=cache_root,
            enable_group_offload=enable_group_offload,
        )
        return
    raise SystemExit(run_one_shot(args))


if __name__ == "__main__":
    main()
