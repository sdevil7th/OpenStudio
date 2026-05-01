#!/usr/bin/env python3
"""
OpenStudio AI music generation helper.

This script supports two modes:
1. One-shot CLI generation for direct invocation.
2. A persistent localhost worker used by the native app so ACE-Step models stay warm.
"""

from __future__ import annotations

import argparse
import ctypes
import functools
import hashlib
import importlib.util
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
from importlib import metadata
from pathlib import Path
from typing import Any

from ai_runtime_probe import (
    DEFAULT_MUSIC_GEN_MODEL,
    REQUIRED_MUSIC_GEN_NATIVE_FILES,
    find_local_comfy_native_assets,
    get_windows_cuda_pytorch_packages,
    get_windows_flash_attn_asset,
    get_windows_triton_package_spec,
    get_music_generation_required_paths,
    resolve_music_gen_checkpoint_root,
)
DEFAULT_INFER_STEP = 8
DEFAULT_LM_MODEL = "qwen_4b_ace15.safetensors"
DEFAULT_LM_SELECTION = "auto"
DEFAULT_RUNTIME_PROFILE = "native-xl-turbo"
HEARTBEAT_INTERVAL_SEC = 5.0
ORIGINAL_STDOUT = sys.stdout
ORIGINAL_STDERR = sys.stderr
WORKER_PROTOCOL_VERSION = 2
MAX_FRAMED_PAYLOAD_BYTES = 8 * 1024 * 1024
SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_VERSION = hashlib.md5(SCRIPT_PATH.read_bytes()).hexdigest()[:16]
DECODE_STALL_THRESHOLD_COLD_SEC = 240.0
GENERATION_MODE_LM_FIRST = "lm_first"
GENERATION_MODE_DIT_MANUAL = "dit_manual"
GENERATION_MODE_OPTIONS = {
    GENERATION_MODE_LM_FIRST,
    GENERATION_MODE_DIT_MANUAL,
}
LM_SHAPE_MISMATCH_MARKERS = (
    "error generating from formatted prompt",
    "size of tensor a",
    "must match the size of tensor b",
)

ACTIVE_TRACE_LOCK = threading.Lock()
ACTIVE_TRACE_SESSION: "AITraceSession | None" = None
ACTIVE_PROGRESS_REPORTER: "ProgressReporter | None" = None
LM_DIAGNOSTICS_INSTALLED = False

RUNTIME_PROFILE_SPECS: dict[str, dict[str, Any]] = {
    "native-xl-turbo": {
        "label": "OpenStudio ACE Split",
        "runtimeProfileName": "openstudio-ace-split",
        "lmModel": DEFAULT_LM_MODEL,
        "requiredAssets": tuple(spec["relativePath"] for spec in REQUIRED_MUSIC_GEN_NATIVE_FILES),
        "fallbackProfiles": (),
        "notes": (
            "Targets the packaged OpenStudio ACE-Step 1.5 split graph.",
        ),
    },
}

LM_MODEL_OPTIONS = {
    DEFAULT_LM_SELECTION,
    "qwen_1.7b_ace15.safetensors",
    "qwen_4b_ace15.safetensors",
}
DEFAULT_MUSICAL_METADATA = {
    "bpm": 120,
    "duration": 30.0,
    "timesignature": "4/4",
    "keyscale": "C major",
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
ACE15_MANAGED_4B_CONFIG_OVERRIDES = {
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
}

PHASE_PROGRESS_BOUNDS: dict[str, tuple[float, float]] = {
    "validating_request": (0.04, 0.08),
    "loading_text_encoders": (0.08, 0.2),
    "encoding_conditioning": (0.2, 0.42),
    "loading_diffusion_model": (0.42, 0.5),
    "sampling": (0.5, 0.9),
    "decoding_audio": (0.9, 0.96),
    "writing_output": (0.96, 0.99),
    "done": (1.0, 1.0),
    "error": (0.0, 0.0),
}


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


def resolve_openstudio_native_backend() -> dict[str, str]:
    runner_path = (SCRIPT_PATH.parent / "openstudio_ace_runner.py").resolve()
    backend_root = (SCRIPT_PATH.parent / "openstudio_ace_backend").resolve()
    vendor_root = backend_root / "vendor_runtime"
    required_paths = (
        runner_path,
        backend_root / "__init__.py",
        vendor_root / "nodes.py",
        vendor_root / "folder_paths.py",
        vendor_root / "comfy" / "sd.py",
        vendor_root / "comfy_extras" / "nodes_ace.py",
    )
    missing = [str(path) for path in required_paths if not path.exists()]
    if missing:
        raise GenerationFailure(
            "The packaged OpenStudio ACE split backend is incomplete: " + ", ".join(missing),
            progress=0.04,
            failureKind="native_asset_missing",
        )
    return {
        "pythonExe": sys.executable,
        "runnerPath": str(runner_path),
        "backendRoot": str(backend_root),
        "runtimeKind": "openstudio_ace_executor",
    }


def resolve_native_split_backend() -> dict[str, str]:
    return resolve_openstudio_native_backend()


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int((time.time() % 1) * 1000):03d}Z"


def trace_safe_request_id(request_id: str) -> str:
    normalized = normalize_text(request_id)
    if not normalized:
        return "unknown-request"
    return "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in normalized)[:96]


def summarize_value(value: Any, *, depth: int = 0) -> Any:
    if depth > 3:
        return f"<{type(value).__name__}>"
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        items = list(value.items())[:20]
        return {
            str(key): summarize_value(item, depth=depth + 1)
            for key, item in items
        }
    if isinstance(value, (list, tuple)):
        items = list(value)[:20]
        return [summarize_value(item, depth=depth + 1) for item in items]
    if hasattr(value, "shape") and hasattr(value, "dtype"):
        summary = {
            "type": type(value).__name__,
            "shape": list(getattr(value, "shape", [])),
            "dtype": str(getattr(value, "dtype", "")),
        }
        device = getattr(value, "device", None)
        if device is not None:
            summary["device"] = str(device)
        numel = getattr(value, "numel", None)
        if callable(numel):
            try:
                summary["numel"] = int(numel())
            except Exception:
                pass
        return summary
    if isinstance(value, BaseException):
        return {"type": type(value).__name__, "message": str(value)}
    if hasattr(value, "__dict__") and depth < 2:
        try:
            return {
                "__class__": type(value).__name__,
                **{
                    str(key): summarize_value(item, depth=depth + 1)
                    for key, item in list(vars(value).items())[:20]
                },
            }
        except Exception:
            pass
    return repr(value)


def summarize_traceback_frames(tb: Any) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    cursor = tb
    while cursor is not None:
        frame = cursor.tb_frame
        code = frame.f_code
        filename = str(code.co_filename)
        if "acestep" in filename.lower() or filename == str(SCRIPT_PATH):
            frames.append(
                {
                    "file": filename,
                    "line": int(cursor.tb_lineno),
                    "function": code.co_name,
                    "locals": {
                        str(key): summarize_value(value)
                        for key, value in list(frame.f_locals.items())[:30]
                    },
                }
            )
        cursor = cursor.tb_next
    return frames[-8:]


def count_prompt_tokens(handler: Any, formatted_prompt: str) -> int | None:
    tokenizer = getattr(handler, "tokenizer", None)
    if tokenizer is None or not formatted_prompt:
        return None
    try:
        encoded = tokenizer(formatted_prompt, return_tensors="pt")
        input_ids = encoded.get("input_ids") if isinstance(encoded, dict) else None
        if input_ids is None:
            return None
        shape = getattr(input_ids, "shape", None)
        if shape is not None and len(shape) >= 2:
            return int(shape[-1])
    except Exception:
        return None
    return None


class AITraceSession:
    def __init__(
        self,
        *,
        request_id: str,
        workflow: str,
        session_mode: str,
        model_id: str,
    ) -> None:
        self.request_id = normalize_text(request_id) or str(uuid.uuid4())
        self.workflow = normalize_text(workflow) or "text-to-music"
        self.session_mode = normalize_text(session_mode) or "persistent"
        self.model_id = normalize_text(model_id) or DEFAULT_MUSIC_GEN_MODEL
        self.root = get_ai_trace_root()
        self.root.mkdir(parents=True, exist_ok=True)
        self.started_at = time.time()
        timestamp = time.strftime("%Y%m%d_%H%M%S", time.localtime(self.started_at))
        basename = f"{timestamp}_{trace_safe_request_id(self.request_id)}"
        self.jsonl_path = (self.root / f"{basename}.jsonl").resolve()
        self.summary_path = (self.root / f"{basename}.txt").resolve()
        self.latest_failure_path = (self.root / "latest_failure.txt").resolve()
        self._lock = threading.Lock()
        self._metadata: dict[str, Any] = {
            "requestId": self.request_id,
            "workflow": self.workflow,
            "sessionMode": self.session_mode,
            "musicGenerationModelId": self.model_id,
            "pid": os.getpid(),
            "scriptPath": str(SCRIPT_PATH),
            "scriptVersion": SCRIPT_VERSION,
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "argv": list(sys.argv),
        }
        self._last_payload: dict[str, Any] = {}
        self._terminal_payload: dict[str, Any] = {}
        self.log_event("trace_started", mirror=True, **self._metadata)

    def trace_path(self) -> str:
        return str(self.jsonl_path)

    def set_metadata(self, **metadata: Any) -> None:
        with self._lock:
            self._metadata.update({key: summarize_value(value) for key, value in metadata.items() if value is not None})

    def log_event(self, event: str, *, mirror: bool = False, **payload: Any) -> None:
        entry = {
            "ts": utc_timestamp(),
            "event": event,
            **self._metadata,
            **{key: summarize_value(value) for key, value in payload.items()},
        }
        line = json.dumps(entry, ensure_ascii=False)
        try:
            with self._lock:
                with self.jsonl_path.open("a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
        except Exception as exc:
            ORIGINAL_STDERR.write(f"[OpenStudio AI][trace-error] failed to write trace event {event}: {exc}\n")
            ORIGINAL_STDERR.flush()
        if mirror:
            ORIGINAL_STDERR.write(f"[OpenStudio AI][trace] {event}: {line}\n")
            ORIGINAL_STDERR.flush()

    def record_payload(self, payload: dict[str, Any]) -> None:
        normalized = {str(key): summarize_value(value) for key, value in payload.items()}
        with self._lock:
            self._last_payload = normalized
            state = str(normalized.get("state", ""))
            if state in {"done", "error", "cancelled"}:
                self._terminal_payload = normalized
        self.log_event("progress_payload", payload=normalized)

    def _build_summary_text(self) -> str:
        payload = self._terminal_payload or self._last_payload
        lines = [
            f"Request ID: {self.request_id}",
            f"Workflow: {self.workflow}",
            f"Session mode: {self.session_mode}",
            f"Model: {self.model_id}",
            f"Trace JSONL: {self.jsonl_path}",
            f"Summary TXT: {self.summary_path}",
            "",
            f"Final state: {payload.get('state', '')}",
            f"Failure kind: {payload.get('failureKind', '')}",
            f"Failure detail: {payload.get('failureDetail', '')}",
            f"LM backend: {payload.get('lmBackend', '')}",
            f"LM stage: {payload.get('lmStage', '')}",
            f"Runtime profile: {payload.get('runtimeProfile', '')}",
            f"LM model: {payload.get('lmModel', '')}",
            f"Trace path: {payload.get('tracePath', self.trace_path())}",
            f"Last stderr: {payload.get('lastStderrLine', '')}",
            f"Last stdout: {payload.get('lastStdoutLine', '')}",
            "",
            "Metadata:",
            json.dumps(self._metadata, indent=2, ensure_ascii=False),
            "",
            "Terminal payload:",
            json.dumps(payload, indent=2, ensure_ascii=False),
        ]
        return "\n".join(lines).strip() + "\n"

    def finalize(self) -> None:
        summary_text = self._build_summary_text()
        payload = self._terminal_payload or self._last_payload
        try:
            self.summary_path.write_text(summary_text, encoding="utf-8")
            if str(payload.get("state", "")) == "error":
                self.latest_failure_path.write_text(summary_text, encoding="utf-8")
        except Exception as exc:
            ORIGINAL_STDERR.write(f"[OpenStudio AI][trace-error] failed to finalize trace summary: {exc}\n")
            ORIGINAL_STDERR.flush()
        self.log_event(
            "trace_finalized",
            mirror=True,
            tracePath=self.trace_path(),
            summaryPath=str(self.summary_path),
            terminalState=payload.get("state"),
            failureKind=payload.get("failureKind"),
        )


def set_active_diagnostics_context(
    trace_session: AITraceSession | None,
    reporter: "ProgressReporter | None",
) -> None:
    global ACTIVE_TRACE_SESSION, ACTIVE_PROGRESS_REPORTER
    with ACTIVE_TRACE_LOCK:
        ACTIVE_TRACE_SESSION = trace_session
        ACTIVE_PROGRESS_REPORTER = reporter


def get_active_trace_session() -> AITraceSession | None:
    with ACTIVE_TRACE_LOCK:
        return ACTIVE_TRACE_SESSION


def get_active_progress_reporter() -> "ProgressReporter | None":
    with ACTIVE_TRACE_LOCK:
        return ACTIVE_PROGRESS_REPORTER


def emit_payload(payload: dict[str, Any]) -> None:
    normalized = dict(payload)
    normalized["progress"] = round(float(normalized.get("progress", 0.0)), 4)
    ORIGINAL_STDOUT.write(json.dumps(normalized) + "\n")
    ORIGINAL_STDOUT.flush()
    trace_session = get_active_trace_session()
    if trace_session is not None:
        trace_session.record_payload(normalized)


def emit(state: str, progress: float, **kwargs: Any) -> None:
    payload = {"state": state, "progress": progress}
    payload.update(kwargs)
    emit_payload(payload)


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

        lines_to_emit: list[str] = []
        with self._lock:
            self._buffer += data
            while True:
                newline_pos = self._buffer.find("\n")
                carriage_pos = self._buffer.find("\r")
                split_pos_candidates = [pos for pos in (newline_pos, carriage_pos) if pos >= 0]
                if not split_pos_candidates:
                    break
                split_pos = min(split_pos_candidates)
                line = self._buffer[:split_pos].strip()
                self._buffer = self._buffer[split_pos + 1 :]
                if line:
                    lines_to_emit.append(line)

        for line in lines_to_emit:
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


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_int(value: Any, default: int) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def normalize_float(value: Any, default: float) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def normalize_timesignature(value: Any) -> str:
    raw = normalize_text(value)
    if not raw:
        return "4/4"
    if "/" in raw:
        return raw
    try:
        beats = int(float(raw))
    except ValueError:
        return raw
    return f"{beats}/4"


def normalize_generation_mode(raw_params: dict[str, Any]) -> str:
    direct_value = normalize_text(raw_params.get("generationMode")).lower()
    if direct_value in GENERATION_MODE_OPTIONS:
        return direct_value

    if "generate_audio_codes" in raw_params:
        return (
            GENERATION_MODE_LM_FIRST
            if normalize_bool(raw_params.get("generate_audio_codes"), True)
            else GENERATION_MODE_DIT_MANUAL
        )

    return GENERATION_MODE_LM_FIRST


def normalize_infer_method(value: Any) -> str:
    normalized = normalize_text(value).lower()
    if normalized in {"ode", "sde"}:
        return normalized
    return "ode"


def normalize_time_signature_for_generation(value: str) -> str:
    normalized = normalize_text(value)
    if "/" in normalized:
        return normalized.split("/", 1)[0].strip()
    return normalized


def has_explicit_musical_metadata(params: dict[str, Any]) -> bool:
    return (
        normalize_int(params.get("bpm"), DEFAULT_MUSICAL_METADATA["bpm"])
        != DEFAULT_MUSICAL_METADATA["bpm"]
        or normalize_float(
            params.get("duration"),
            DEFAULT_MUSICAL_METADATA["duration"],
        )
        != DEFAULT_MUSICAL_METADATA["duration"]
        or normalize_timesignature(
            params.get("timesignature"),
        )
        != DEFAULT_MUSICAL_METADATA["timesignature"]
        or (normalize_text(params.get("keyscale")) or DEFAULT_MUSICAL_METADATA["keyscale"])
        != DEFAULT_MUSICAL_METADATA["keyscale"]
    )


def normalize_generation_params(raw_params: dict[str, Any]) -> dict[str, Any]:
    generation_mode = normalize_generation_mode(raw_params)
    generate_audio_codes = generation_mode == GENERATION_MODE_LM_FIRST
    normalized = {
        "prompt": normalize_text(raw_params.get("prompt")),
        "lyrics": normalize_text(raw_params.get("lyrics")),
        "seed": normalize_int(raw_params.get("seed"), -1),
        "bpm": normalize_int(raw_params.get("bpm"), DEFAULT_MUSICAL_METADATA["bpm"]),
        "duration": normalize_float(
            raw_params.get("duration"),
            DEFAULT_MUSICAL_METADATA["duration"],
        ),
        "timesignature": normalize_timesignature(raw_params.get("timesignature")),
        "language": normalize_text(raw_params.get("language")) or "en",
        "keyscale": normalize_text(raw_params.get("keyscale"))
        or DEFAULT_MUSICAL_METADATA["keyscale"],
        "generate_audio_codes": generate_audio_codes,
        "cfg_scale": normalize_float(raw_params.get("cfg_scale"), 2.0),
        "guidance_scale": normalize_float(raw_params.get("guidance_scale"), 1.0),
        "shift": normalize_float(raw_params.get("shift"), 3.0),
        "temperature": normalize_float(raw_params.get("temperature"), 0.85),
        "top_p": normalize_float(raw_params.get("top_p"), 0.9),
        "top_k": normalize_int(raw_params.get("top_k"), 0),
        "min_p": normalize_float(raw_params.get("min_p"), 0.0),
        "inferMethod": normalize_infer_method(raw_params.get("inferMethod")),
        "debugForceLmShapeMismatch": normalize_bool(
            raw_params.get("debugForceLmShapeMismatch"),
            False,
        ),
        "debugDecodeStallSeconds": max(
            0.0,
            normalize_float(raw_params.get("debugDecodeStallSeconds"), 0.0),
        ),
        "runtimeProfile": DEFAULT_RUNTIME_PROFILE,
        "lmModel": DEFAULT_LM_MODEL,
        "inferenceSteps": normalize_int(
            raw_params.get("inferenceSteps"), DEFAULT_INFER_STEP
        ),
    }
    return normalized


def get_installed_checkpoint_assets(checkpoint_root: Path) -> set[str]:
    if not checkpoint_root.exists():
        return set()
    return {
        str(path.relative_to(checkpoint_root)).replace("\\", "/")
        for path in checkpoint_root.rglob("*")
        if path.is_file()
    }


def build_runtime_profile_catalog(checkpoint_root: Path) -> dict[str, Any]:
    installed_assets = get_installed_checkpoint_assets(checkpoint_root)
    profiles: dict[str, dict[str, Any]] = {}
    available_profile_ids: list[str] = []
    unavailable_profiles: list[dict[str, Any]] = []

    for profile_id, spec in RUNTIME_PROFILE_SPECS.items():
        missing_assets = [
            asset for asset in spec.get("requiredAssets", ()) if asset not in installed_assets
        ]
        profile = {
            "id": profile_id,
            "label": spec["label"],
            "runtimeProfileName": spec["runtimeProfileName"],
            "lmModel": spec["lmModel"],
            "requiredAssets": list(spec.get("requiredAssets", ())),
            "missingAssets": missing_assets,
            "available": not missing_assets,
            "notes": list(spec.get("notes", ())),
        }
        profiles[profile_id] = profile
        if profile["available"]:
            available_profile_ids.append(profile_id)
        else:
            unavailable_profiles.append(profile)

    default_profile = (
        DEFAULT_RUNTIME_PROFILE
        if profiles.get(DEFAULT_RUNTIME_PROFILE, {}).get("available")
        else next(iter(available_profile_ids), "")
    )
    return {
        "defaultProfile": default_profile,
        "profiles": profiles,
        "availableProfiles": available_profile_ids,
        "unavailableProfiles": unavailable_profiles,
        "warmSessionCapable": True,
    }


def resolve_runtime_selection(
    *,
    requested_profile: str,
    requested_lm_model: str,
    checkpoint_root: Path,
) -> dict[str, Any]:
    catalog = build_runtime_profile_catalog(checkpoint_root)
    profiles = catalog["profiles"]
    status_notes: list[str] = []

    selected_profile = (
        requested_profile if requested_profile in profiles else DEFAULT_RUNTIME_PROFILE
    )
    selected_profile_info = profiles.get(selected_profile)

    if selected_profile_info is None:
        selected_profile = catalog["defaultProfile"] or DEFAULT_RUNTIME_PROFILE
        selected_profile_info = profiles.get(selected_profile)

    if selected_profile_info is None:
        raise GenerationFailure(
            "No ACE-Step runtime profile definitions are available in this bridge.",
            progress=0.04,
        )

    if not selected_profile_info["available"]:
        raise GenerationFailure(
            "Native XL Turbo split-model assets are missing for the primary ACE-Step path.",
            progress=0.04,
            runtimeProfile=selected_profile,
            availableProfiles=catalog["availableProfiles"],
            unavailableProfiles=catalog["unavailableProfiles"],
        )

    return {
        "requestedProfile": requested_profile,
        "selectedProfile": selected_profile,
        "selectedProfileLabel": selected_profile_info["label"],
        "runtimeProfileName": selected_profile_info["runtimeProfileName"],
        "requestedLmModel": DEFAULT_LM_MODEL,
        "selectedLmModel": DEFAULT_LM_MODEL,
        "catalog": catalog,
        "statusNotes": status_notes,
    }


def validate_checkpoint_layout(checkpoint_root: Path, model_id: str) -> dict[str, Any]:
    hydrate_native_split_assets(checkpoint_root)
    layout = get_music_generation_required_paths(
        checkpoint_root=str(checkpoint_root),
        model_name=model_id,
    )
    if not layout["layoutValid"]:
        raise GenerationFailure(
            "Pinned ACE-Step checkpoint layout is incomplete.",
            progress=0.05,
            musicGenerationModelId=model_id,
            musicGenerationCheckpointRoot=str(checkpoint_root),
            musicGenerationMissingPaths=layout["missingPaths"],
        )
    if normalize_bool(os.environ.get("OPENSTUDIO_USE_LEGACY_ACE_WRAPPER"), False):
        ensure_hidden_legacy_lm_bridge(checkpoint_root)
    return layout


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


def hydrate_native_split_assets(checkpoint_root: Path) -> list[str]:
    found_sources, _searched_dirs = find_local_comfy_native_assets()
    imported_assets: list[str] = []

    for spec in REQUIRED_MUSIC_GEN_NATIVE_FILES:
        destination = checkpoint_root / Path(spec["relativePath"])
        if destination.exists() and destination.is_file():
            continue

        source_file = found_sources.get(spec["id"])
        if source_file is None:
            continue

        hardlink_or_copy_file(source_file, destination)
        imported_assets.append(spec["relativePath"])

    if imported_assets:
        trace_session = get_active_trace_session()
        if trace_session is not None:
            trace_session.log_event(
                "native_assets_hydrated",
                mirror=True,
                importedAssets=imported_assets,
                checkpointRoot=str(checkpoint_root),
            )
    return imported_assets


def ensure_hidden_legacy_lm_bridge(checkpoint_root: Path) -> None:
    target_dir = checkpoint_root / DEFAULT_LM_MODEL
    target_model = target_dir / "model.safetensors"
    template_dir = checkpoint_root / "acestep-5Hz-lm-1.7B"
    template_config = template_dir / "config.json"
    source_qwen_4b = checkpoint_root / "text_encoders" / "qwen_4b_ace15.safetensors"
    if not template_config.exists() or not source_qwen_4b.exists():
        return

    config = json.loads(template_config.read_text(encoding="utf-8"))
    config.update(ACE15_MANAGED_4B_CONFIG_OVERRIDES)
    config["layer_types"] = ["full_attention"] * int(config["num_hidden_layers"])
    target_dir.mkdir(parents=True, exist_ok=True)

    for shared_name in ACE15_MANAGED_LM_SHARED_FILES:
        source_file = template_dir / shared_name
        if source_file.exists() and source_file.is_file():
            shutil.copy2(source_file, target_dir / shared_name)

    (target_dir / "config.json").write_text(
        json.dumps(config, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    link_mode = "existing"
    if not target_model.exists():
        link_mode = hardlink_or_copy_file(source_qwen_4b, target_model)
    (target_dir / "openstudio-source.json").write_text(
        json.dumps(
            {
                "source": "nativeSplitAssets",
                "sourceFile": str(source_qwen_4b),
                "generatedAt": utc_timestamp(),
                "linkMode": link_mode,
                "targetName": DEFAULT_LM_MODEL,
            },
            indent=2,
            ensure_ascii=True,
        )
        + "\n",
        encoding="utf-8",
    )


def lower_process_priority_for_cpu() -> None:
    if sys.platform != "win32":
        return
    try:
        BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.GetCurrentProcess()
        kernel32.SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS)
    except Exception:
        pass


def ensure_optional_acceleration_paths() -> None:
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


def has_optional_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def get_distribution_version(package_name: str) -> str | None:
    try:
        return metadata.version(package_name)
    except metadata.PackageNotFoundError:
        return None


def strip_local_version(version: str | None) -> str:
    if not version:
        return ""
    return str(version).split("+", 1)[0].strip()


def resolve_lm_backend(device: str) -> tuple[str, str, bool]:
    ensure_optional_acceleration_paths()

    if device != "cuda":
        return "pt", f"PyTorch fallback on {device.upper()}", False

    missing: list[str] = []
    import_failures: list[str] = []
    for module_name, friendly_name in (
        ("nanovllm", "nano-vllm"),
        ("triton", "triton"),
        ("flash_attn", "flash-attn"),
    ):
        if not has_optional_module(module_name):
            missing.append(friendly_name)
            continue
        try:
            __import__(module_name)
        except Exception as exc:
            import_failures.append(f"{friendly_name} ({type(exc).__name__}: {exc})")

    expected_torch_versions: dict[str, str] = {}
    for package in get_windows_cuda_pytorch_packages():
        name, separator, version = str(package).partition("==")
        if separator and name and version:
            expected_torch_versions[name.strip()] = version.strip()

    triton_spec = get_windows_triton_package_spec()
    _triton_name, _separator, triton_version = triton_spec.partition("==")
    flash_attn_asset = get_windows_flash_attn_asset()

    version_mismatches: list[str] = []
    try:
        import torch

        torch_version = getattr(torch, "__version__", "")
    except Exception as exc:
        missing.append(f"torch ({type(exc).__name__}: {exc})")
        torch_version = ""

    installed_versions = {
        "torch": torch_version,
        "torchvision": get_distribution_version("torchvision") or "",
        "torchaudio": get_distribution_version("torchaudio") or "",
        "triton-windows": get_distribution_version("triton-windows") or "",
        "flash-attn": get_distribution_version("flash-attn") or "",
    }

    for package_name, expected_version in expected_torch_versions.items():
        installed_version = installed_versions.get(package_name, "")
        if not installed_version:
            if package_name not in missing:
                missing.append(package_name)
            continue
        if strip_local_version(installed_version) != expected_version or "cu128" not in installed_version:
            version_mismatches.append(
                f"{package_name}={installed_version} (expected {expected_version}+cu128)"
            )

    installed_triton_version = installed_versions["triton-windows"]
    if not installed_triton_version:
        if "triton-windows" not in missing and "triton" not in missing:
            missing.append("triton-windows")
    elif strip_local_version(installed_triton_version) != triton_version.strip():
        version_mismatches.append(
            f"triton-windows={installed_triton_version} (expected {triton_version.strip()})"
        )

    installed_flash_version = installed_versions["flash-attn"]
    expected_flash_version = str(flash_attn_asset.get("version", "")).strip()
    if not installed_flash_version:
        if "flash-attn" not in missing:
            missing.append("flash-attn")
    elif strip_local_version(installed_flash_version) != expected_flash_version:
        version_mismatches.append(
            f"flash-attn={installed_flash_version} (expected {expected_flash_version})"
        )

    if not missing and not import_failures and not version_mismatches:
        return "vllm", "nano-vllm acceleration available", True

    details: list[str] = []
    if missing:
        details.append("missing " + ", ".join(missing))
    if import_failures:
        details.append("import failures " + "; ".join(import_failures))
    if version_mismatches:
        details.append("mismatched " + "; ".join(version_mismatches))
    return "pt", "PyTorch fallback (" + " | ".join(details) + ")", False


def classify_phase(description: str) -> str:
    lowered = description.strip().lower()
    if "phase 1" in lowered or "phase 2" in lowered:
        return "encoding_conditioning"
    if "preparing inputs" in lowered:
        return "loading_diffusion_model"
    if "generating music" in lowered:
        return "sampling"
    if "decoding audio" in lowered:
        return "decoding_audio"
    if "preparing audio data" in lowered:
        return "decoding_audio"
    return "sampling"


def is_lm_shape_mismatch(error_text: str) -> bool:
    lowered = normalize_text(error_text).lower()
    if not lowered:
        return False
    return all(marker in lowered for marker in LM_SHAPE_MISMATCH_MARKERS)


def is_out_of_memory_error(error_text: str) -> bool:
    lowered = normalize_text(error_text).lower()
    if not lowered:
        return False
    return any(
        marker in lowered
        for marker in (
            "out of memory",
            "cuda error: out of memory",
            "cuda out of memory",
            "cublas_status_alloc_failed",
            "ran out of gpu memory",
        )
    )


def classify_generation_failure_kind(
    error_text: str,
    *,
    generation_mode: str,
) -> str:
    if generation_mode == GENERATION_MODE_LM_FIRST and is_lm_shape_mismatch(error_text):
        return "native_conditioning_failure"
    lowered = normalize_text(error_text).lower()
    if is_out_of_memory_error(lowered):
        if any(marker in lowered for marker in ("decode", "decoding", "vae", "audio", "finalizing")):
            return "native_decode_failure"
        return "native_sampling_failure"
    if "missing" in lowered and any(
        marker in lowered for marker in ("text encoder", "diffusion", "vae", "asset", "checkpoint")
    ):
        return "native_asset_missing"
    if "formatted prompt" in lowered or "conditioning" in lowered:
        return "native_conditioning_failure"
    if "decode" in lowered:
        return "native_decode_failure"
    return "native_sampling_failure"


def build_native_split_request(params: dict[str, Any]) -> dict[str, Any]:
    request_timesignature = normalize_timesignature(params.get("timesignature"))
    if "/" in request_timesignature:
        request_timesignature = request_timesignature.split("/", 1)[0].strip() or "4"
    request = {
        "prompt": normalize_text(params.get("prompt")),
        "lyrics": normalize_text(params.get("lyrics")),
        "seed": normalize_int(params.get("seed"), -1),
        "bpm": normalize_int(params.get("bpm"), DEFAULT_MUSICAL_METADATA["bpm"]),
        "duration": normalize_float(params.get("duration"), DEFAULT_MUSICAL_METADATA["duration"]),
        "timesignature": request_timesignature,
        "language": normalize_text(params.get("language")) or "en",
        "keyscale": normalize_text(params.get("keyscale")) or DEFAULT_MUSICAL_METADATA["keyscale"],
        "generate_audio_codes": normalize_bool(params.get("generate_audio_codes"), True),
        "cfg_scale": normalize_float(params.get("cfg_scale"), 2.0),
        "guidance_scale": normalize_float(params.get("guidance_scale"), 1.0),
        "inferenceSteps": normalize_int(params.get("inferenceSteps"), DEFAULT_INFER_STEP),
        "shift": normalize_float(params.get("shift"), 3.0),
        "temperature": normalize_float(params.get("temperature"), 0.85),
        "top_p": normalize_float(params.get("top_p"), 0.9),
        "top_k": normalize_int(params.get("top_k"), 0),
        "min_p": normalize_float(params.get("min_p"), 0.0),
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": 1.0,
        "clip_type": "ace",
        "model_mode": "default",
        "decode_mode": "full",
    }
    return request


def log_native_split_request_payload(
    *,
    request_id: str,
    workflow: str,
    session_mode: str,
    normalized_params: dict[str, Any],
    runtime_selection: dict[str, Any],
    split_request: dict[str, Any],
    split_runtime: dict[str, str],
) -> None:
    diagnostic_payload = {
        "requestId": request_id,
        "workflow": workflow,
        "sessionMode": session_mode,
        "normalizedParams": normalized_params,
        "runtimeSelection": {
            "selectedProfile": runtime_selection["selectedProfile"],
            "selectedLmModel": runtime_selection["selectedLmModel"],
            "runtimeProfileName": runtime_selection["runtimeProfileName"],
            "statusNotes": runtime_selection["statusNotes"],
        },
        "backendFamily": "openstudio_ace_split",
        "nativeSplitRequest": split_request,
        "backendRuntime": split_runtime,
    }
    trace_session = get_active_trace_session()
    if trace_session is not None:
        trace_session.set_metadata(
            normalizedParams=normalized_params,
            runtimeSelection=diagnostic_payload["runtimeSelection"],
            nativeSplitRequest=split_request,
            backendRuntime=split_runtime,
            backendFamily="openstudio_ace_split",
        )
        trace_session.log_event(
            "native_split_request",
            mirror=True,
            normalizedParams=normalized_params,
            runtimeSelection=diagnostic_payload["runtimeSelection"],
            nativeSplitRequest=split_request,
            backendRuntime=split_runtime,
        )
    ORIGINAL_STDERR.write(
        "[OpenStudio AI] native_split_request "
        + json.dumps(diagnostic_payload, ensure_ascii=False)
        + "\n"
    )
    ORIGINAL_STDERR.flush()


def update_reporter_from_openstudio_ace_event(
    reporter: "ProgressReporter",
    event: dict[str, Any],
    *,
    backend_label: str,
    selection: dict[str, Any],
    status_note: str,
) -> None:
    kind = normalize_text(event.get("kind")).lower()
    phase = normalize_text(event.get("phase")) or "sampling"
    progress = normalize_float(event.get("progress"), 0.0)
    message = normalize_text(event.get("message")) or phase.replace("_", " ").title()
    details = event.get("details") if isinstance(event.get("details"), dict) else None

    if kind == "phase":
        reporter.update(
            "loading" if phase != "done" else "done",
            progress,
            phase=phase,
            message=message,
            lmBackend=backend_label,
            phaseProgress=0.0,
            statusNote=status_note,
            backendFamily="openstudio_ace_split",
            runtimeProfile=selection["selectedProfile"],
            lmModel=selection["selectedLmModel"],
            failureDetail=normalize_text(event.get("errorType")) or None,
            loadedAssets=details,
        )
        return

    if kind == "progress":
        fraction = normalize_float(event.get("fraction"), 0.0)
        reporter.update(
            "loading",
            progress,
            phase=phase,
            message=message,
            lmBackend=backend_label,
            phaseProgress=fraction,
            statusNote=status_note,
            backendFamily="openstudio_ace_split",
            runtimeProfile=selection["selectedProfile"],
            lmModel=selection["selectedLmModel"],
        )
        return

    if kind == "result":
        reporter.update(
            "writing",
            0.99,
            phase="writing_output",
            message="Finalizing OpenStudio ACE output...",
            lmBackend=backend_label,
            statusNote=status_note,
            backendFamily="openstudio_ace_split",
            runtimeProfile=selection["selectedProfile"],
            lmModel=selection["selectedLmModel"],
            loadedAssets=event.get("assets"),
        )


def run_native_split_generation(
    *,
    reporter: "ProgressReporter",
    trace_session: AITraceSession,
    request_id: str,
    workflow: str,
    session_mode: str,
    normalized_params: dict[str, Any],
    selection: dict[str, Any],
    checkpoint_root: Path,
    output_path: Path,
) -> str:
    split_runtime = resolve_native_split_backend()
    split_request = build_native_split_request(normalized_params)
    runtime_kind = split_runtime.get("runtimeKind", "openstudio_ace_executor")
    status_note = (
        "OpenStudio's native ACE graph is using explicit BPM, duration, time signature, key, "
        + ("and LM audio-code generation." if split_request["generate_audio_codes"] else "with LM audio-code generation disabled.")
    )
    log_native_split_request_payload(
        request_id=request_id,
        workflow=workflow,
        session_mode=session_mode,
        normalized_params=normalized_params,
        runtime_selection=selection,
        split_request=split_request,
        split_runtime=split_runtime,
    )
    command = [
        split_runtime["pythonExe"],
        split_runtime["runnerPath"],
    ]
    command.extend(["--checkpoint-root", str(checkpoint_root)])
    command.extend(
        [
            "--request-json",
            json.dumps(split_request, ensure_ascii=False),
            "--output",
            str(output_path),
        ]
    )

    trace_session.log_event(
        "native_split_spawn",
        mirror=True,
        command=command,
        runtimeKind=runtime_kind,
    )

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    final_output = ""
    last_stdout_line = ""
    last_stderr_line = ""

    def pump_stderr() -> None:
        nonlocal last_stderr_line
        if process.stderr is None:
            return
        for line in process.stderr:
            cleaned = line.rstrip()
            if cleaned:
                last_stderr_line = cleaned
                trace_session.log_event("native_split_stderr", line=cleaned)

    stderr_thread = threading.Thread(target=pump_stderr, name="OpenStudioAcesplitStderr", daemon=True)
    stderr_thread.start()

    try:
        if process.stdout is None:
            raise GenerationFailure(
                "OpenStudio ACE split runner did not expose stdout.",
                progress=0.1,
                failureKind="native_conditioning_failure",
            )
        for line in process.stdout:
            cleaned = line.rstrip()
            if not cleaned:
                continue
            last_stdout_line = cleaned
            try:
                event = json.loads(cleaned)
            except json.JSONDecodeError:
                trace_session.log_event("native_split_stdout", line=cleaned)
                continue

            trace_session.log_event("native_split_event", payload=event)
            kind = normalize_text(event.get("kind")).lower()
            if kind == "error":
                error_message = normalize_text(event.get("message")) or "OpenStudio ACE split generation failed."
                error_phase = normalize_text(event.get("phase")).lower()
                reporter.set_failure_detail(
                    error_message or normalize_text(event.get("errorType"))
                )
                raise GenerationFailure(
                    error_message,
                    progress=normalize_float(event.get("progress"), 0.24),
                    failureKind=(
                        "native_decode_failure"
                        if error_phase == "decoding_audio"
                        else classify_generation_failure_kind(
                            error_message,
                            generation_mode=(
                                GENERATION_MODE_LM_FIRST
                                if split_request["generate_audio_codes"]
                                else GENERATION_MODE_DIT_MANUAL
                            ),
                        )
                    ),
                )
            if kind == "result":
                final_output = normalize_text(event.get("outputPath"))
            update_reporter_from_openstudio_ace_event(
                reporter,
                event,
                backend_label="openstudio-ace-split",
                selection=selection,
                status_note=status_note,
            )

            if reporter.should_abort():
                process.kill()
                failure_detail = normalize_text(getattr(reporter, "_failure_detail", ""))
                if is_out_of_memory_error(failure_detail):
                    raise GenerationFailure(
                        "ACE-Step ran out of GPU memory while finalizing audio.",
                        progress=normalize_float(event.get("progress"), 0.95),
                        failureKind="native_decode_failure",
                        failureDetail=failure_detail,
                    )
                raise GenerationFailure(
                    "ACE-Step decode stalled while finalizing audio.",
                    progress=normalize_float(event.get("progress"), 0.95),
                    failureKind="decode_stalled",
                    failureDetail=failure_detail or None,
                )
    finally:
        if process.stdout is not None:
            process.stdout.close()
        process.wait(timeout=None)
        stderr_thread.join(timeout=2.0)
        if last_stdout_line:
            reporter.set_last_stdout_line(last_stdout_line)
        if last_stderr_line:
            reporter.set_last_stderr_line(last_stderr_line)
        trace_session.set_metadata(
            nativeRunnerExitCode=process.returncode,
            lastStdoutLine=last_stdout_line,
            lastStderrLine=last_stderr_line,
        )

    if process.returncode != 0:
        runner_error = last_stderr_line or last_stdout_line or "unknown error"
        raise GenerationFailure(
            "OpenStudio ACE split runner exited with "
            f"code {process.returncode}: {runner_error}",
            progress=0.24,
            failureKind=classify_generation_failure_kind(
                runner_error,
                generation_mode=(
                    GENERATION_MODE_LM_FIRST
                    if split_request["generate_audio_codes"]
                    else GENERATION_MODE_DIT_MANUAL
                ),
            ),
        )
    if not final_output:
        final_output = str(output_path)
    return final_output


def resolve_one_shot_params_json(args: argparse.Namespace) -> str:
    params_sources = [
        bool(getattr(args, "params", "")),
        bool(getattr(args, "params_file", "")),
        bool(getattr(args, "params_stdin", False)),
    ]
    if sum(1 for source in params_sources if source) != 1:
        raise SystemExit(
            "Exactly one of --params, --params-file, or --params-stdin is required unless --worker is used."
        )
    if getattr(args, "params", ""):
        return str(args.params)
    if getattr(args, "params_file", ""):
        return Path(args.params_file).expanduser().resolve().read_text(encoding="utf-8-sig")
    return sys.stdin.read()


def build_generation_param_payload(
    params: dict[str, Any],
    *,
    generation_mode: str,
) -> dict[str, Any]:
    use_lm_audio_codes = bool(params.get("generate_audio_codes", True))
    lyrics = normalize_text(params.get("lyrics"))
    instrumental = not lyrics

    return {
        "task_type": "text2music",
        "caption": normalize_text(params.get("prompt")),
        "lyrics": lyrics,
        "instrumental": instrumental,
        "vocal_language": normalize_text(params.get("language")) or "en",
        "bpm": params["bpm"],
        "keyscale": normalize_text(params.get("keyscale")),
        "timesignature": normalize_time_signature_for_generation(params.get("timesignature", "")),
        "duration": params["duration"],
        "inference_steps": max(4, params["inferenceSteps"]),
        "seed": params["seed"],
        "guidance_scale": params["guidance_scale"],
        "shift": params["shift"],
        "infer_method": normalize_infer_method(params.get("inferMethod")),
        "thinking": use_lm_audio_codes,
        "lm_temperature": params["temperature"],
        "lm_cfg_scale": params["cfg_scale"],
        "lm_top_k": params["top_k"],
        "lm_top_p": params["top_p"],
        "use_cot_metas": False,
        "use_cot_caption": use_lm_audio_codes,
        "use_cot_language": use_lm_audio_codes,
        "use_constrained_decoding": use_lm_audio_codes,
    }


def build_generation_params(params: dict[str, Any], *, generation_mode: str):
    from acestep.inference import GenerationParams

    return GenerationParams(**build_generation_param_payload(params, generation_mode=generation_mode))


def log_normalized_request_payload(
    *,
    request_id: str,
    workflow: str,
    session_mode: str,
    normalized_params: dict[str, Any],
    runtime_selection: dict[str, Any],
    generation_param_payload: dict[str, Any],
) -> None:
    diagnostic_payload = {
        "requestId": request_id,
        "workflow": workflow,
        "sessionMode": session_mode,
        "normalizedParams": normalized_params,
        "runtimeSelection": {
            "selectedProfile": runtime_selection["selectedProfile"],
            "selectedLmModel": runtime_selection["selectedLmModel"],
            "runtimeProfileName": runtime_selection["runtimeProfileName"],
            "statusNotes": runtime_selection["statusNotes"],
        },
        "generationParams": generation_param_payload,
    }
    trace_session = get_active_trace_session()
    if trace_session is not None:
        trace_session.set_metadata(
            normalizedParams=normalized_params,
            runtimeSelection=diagnostic_payload["runtimeSelection"],
            generationParams=generation_param_payload,
        )
        trace_session.log_event(
            "normalized_request",
            mirror=True,
            normalizedParams=normalized_params,
            runtimeSelection=diagnostic_payload["runtimeSelection"],
            generationParams=generation_param_payload,
        )
    ORIGINAL_STDERR.write(
        "[OpenStudio AI] normalized_request "
        + json.dumps(diagnostic_payload, ensure_ascii=False)
        + "\n"
    )
    ORIGINAL_STDERR.flush()


def build_method_call_details(handler: Any, method_name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
    details: dict[str, Any] = {}
    if method_name == "initialize":
        details.update(
            {
                "checkpointDir": kwargs.get("checkpoint_dir", args[0] if len(args) > 0 else None),
                "lmModelPath": kwargs.get("lm_model_path", args[1] if len(args) > 1 else None),
                "backend": kwargs.get("backend", args[2] if len(args) > 2 else None),
                "device": kwargs.get("device", args[3] if len(args) > 3 else None),
                "offloadToCpu": kwargs.get("offload_to_cpu", args[4] if len(args) > 4 else None),
                "dtype": kwargs.get("dtype", args[5] if len(args) > 5 else None),
            }
        )
    elif method_name in {"build_formatted_prompt", "build_formatted_prompt_with_cot"}:
        caption = kwargs.get("caption", args[0] if len(args) > 0 else "")
        lyrics = kwargs.get("lyrics", args[1] if len(args) > 1 else "")
        details.update(
            {
                "captionLength": len(normalize_text(caption)),
                "lyricsLength": len(normalize_text(lyrics)),
                "generationPhase": kwargs.get("generation_phase"),
            }
        )
        if method_name == "build_formatted_prompt_with_cot":
            cot_text = kwargs.get("cot_text", args[2] if len(args) > 2 else "")
            details["cotLength"] = len(normalize_text(cot_text))
    elif method_name == "generate_from_formatted_prompt":
        formatted_prompt = kwargs.get("formatted_prompt", args[0] if len(args) > 0 else "")
        details.update(
            {
                "formattedPromptLength": len(normalize_text(formatted_prompt)),
                "formattedPromptTokenCount": count_prompt_tokens(handler, normalize_text(formatted_prompt)),
                "useConstrainedDecoding": kwargs.get("use_constrained_decoding", True),
                "stopAtReasoning": kwargs.get("stop_at_reasoning", False),
                "cfg": summarize_value(kwargs.get("cfg", args[1] if len(args) > 1 else None)),
            }
        )
    elif method_name in {"_run_pt_single", "_run_pt", "_run_vllm"}:
        formatted_prompt = kwargs.get("formatted_prompt")
        if formatted_prompt is None and args:
            formatted_prompt = args[0]
        prompt_value = normalize_text(formatted_prompt if isinstance(formatted_prompt, str) else "")
        details.update(
            {
                "backend": "vllm" if method_name == "_run_vllm" else "pt",
                "formattedPromptLength": len(prompt_value),
                "formattedPromptTokenCount": count_prompt_tokens(handler, prompt_value),
                "temperature": kwargs.get("temperature", args[1] if len(args) > 1 else None),
                "cfgScale": kwargs.get("cfg_scale", args[2] if len(args) > 2 else None),
                "topK": kwargs.get("top_k", args[4] if len(args) > 4 else None),
                "topP": kwargs.get("top_p", args[5] if len(args) > 5 else None),
                "targetDuration": kwargs.get("target_duration"),
                "userMetadata": summarize_value(kwargs.get("user_metadata")),
                "generationPhase": kwargs.get("generation_phase"),
                "captionLength": len(normalize_text(kwargs.get("caption", ""))),
                "lyricsLength": len(normalize_text(kwargs.get("lyrics", ""))),
                "cotLength": len(normalize_text(kwargs.get("cot_text", ""))),
            }
        )
    return {key: value for key, value in details.items() if value is not None}


def summarize_method_result(handler: Any, method_name: str, result: Any) -> dict[str, Any]:
    if method_name == "initialize" and isinstance(result, tuple):
        return {
            "status": summarize_value(result[0] if len(result) > 0 else None),
            "ok": summarize_value(result[1] if len(result) > 1 else None),
        }
    if method_name in {"build_formatted_prompt", "build_formatted_prompt_with_cot"}:
        text = normalize_text(result)
        return {
            "formattedPromptLength": len(text),
            "formattedPromptTokenCount": count_prompt_tokens(handler, text),
        }
    if method_name == "generate_from_formatted_prompt" and isinstance(result, tuple):
        cot_text = normalize_text(result[0] if len(result) > 0 else "")
        codes = normalize_text(result[1] if len(result) > 1 else "")
        return {
            "cotLength": len(cot_text),
            "codesLength": len(codes),
        }
    return {"result": summarize_value(result)}


def install_lm_diagnostics_instrumentation() -> None:
    global LM_DIAGNOSTICS_INSTALLED
    if LM_DIAGNOSTICS_INSTALLED:
        return

    import acestep.llm_inference as lli

    handler_cls = lli.LLMHandler
    methods_to_wrap = (
        ("initialize", "initialize_lm"),
        ("build_formatted_prompt", "build_formatted_prompt"),
        ("build_formatted_prompt_with_cot", "build_formatted_prompt_with_cot"),
        ("generate_from_formatted_prompt", "generate_from_formatted_prompt"),
        ("_run_pt", "run_pt"),
        ("_run_pt_single", "run_pt_single"),
        ("_run_vllm", "run_vllm"),
    )

    for method_name, lm_stage in methods_to_wrap:
        original = getattr(handler_cls, method_name, None)
        if original is None:
            trace_session = get_active_trace_session()
            if trace_session is not None:
                trace_session.log_event(
                    "lm_symbol_missing",
                    mirror=True,
                    method=method_name,
                    lmStage=lm_stage,
                )
            continue
        if getattr(original, "_openstudio_ai_instrumented", False):
            continue

        @functools.wraps(original)
        def wrapped(self: Any, *args: Any, __original=original, __method_name=method_name, __lm_stage=lm_stage, **kwargs: Any) -> Any:
            trace_session = get_active_trace_session()
            reporter = get_active_progress_reporter()
            call_details = build_method_call_details(self, __method_name, args, kwargs)
            if reporter is not None:
                reporter.set_lm_stage(__lm_stage)
            if trace_session is not None:
                trace_session.log_event(
                    "lm_stage_enter",
                    method=__method_name,
                    lmStage=__lm_stage,
                    details=call_details,
                )
            try:
                result = __original(self, *args, **kwargs)
            except Exception as exc:
                failure_detail = f"{type(exc).__name__}: {exc}"
                if reporter is not None:
                    reporter.set_lm_stage(__lm_stage)
                    reporter.set_failure_detail(failure_detail)
                if trace_session is not None:
                    trace_session.log_event(
                        "lm_stage_exception",
                        mirror=True,
                        method=__method_name,
                        lmStage=__lm_stage,
                        details=call_details,
                        failureDetail=failure_detail,
                        exceptionType=type(exc).__name__,
                        traceback="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                        tracebackFrames=summarize_traceback_frames(exc.__traceback__),
                    )
                raise
            if trace_session is not None:
                trace_session.log_event(
                    "lm_stage_exit",
                    method=__method_name,
                    lmStage=__lm_stage,
                    details=summarize_method_result(self, __method_name, result),
                )
            return result

        setattr(wrapped, "_openstudio_ai_instrumented", True)
        setattr(handler_cls, method_name, wrapped)

    LM_DIAGNOSTICS_INSTALLED = True


class ProgressReporter:
    def __init__(
        self,
        *,
        model_id: str,
        checkpoint_root: Path,
        backend: str = "unknown",
        run_mode: str = "cold",
        session_mode: str = "persistent",
        runtime_profile: str = DEFAULT_RUNTIME_PROFILE,
        lm_model: str = DEFAULT_LM_MODEL,
        request_id: str = "",
        trace_path: str = "",
    ) -> None:
        self.model_id = model_id
        self.checkpoint_root = checkpoint_root
        self.backend = backend
        self.run_mode = run_mode
        self.session_mode = session_mode
        self.runtime_profile = runtime_profile
        self.lm_model = lm_model
        self.request_id = normalize_text(request_id) or str(uuid.uuid4())
        self.started_at = time.monotonic()
        self._lock = threading.Lock()
        self._stop_heartbeat = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None
        self._last_progress_emit_at = self.started_at
        self._phase_entered_at = self.started_at
        self._decode_stall_reported = False
        self._abort_due_to_stall = False
        self._attempt_mode = "lm_dit"
        self._attempt_index = 1
        self._prior_failure = ""
        self._debug_decode_stall_seconds = 0.0
        self._debug_decode_stall_used = False
        self.trace_path = normalize_text(trace_path)
        self._failure_detail = ""
        self._lm_stage = ""
        self._lm_backend = ""
        self._payload: dict[str, Any] = {
            "state": "idle",
            "progress": 0.0,
            "phase": "idle",
            "message": "",
            "backend": backend,
            "musicGenerationModelId": model_id,
            "musicGenerationCheckpointRoot": str(checkpoint_root),
            "runMode": run_mode,
            "sessionMode": session_mode,
            "runtimeProfile": runtime_profile,
            "lmModel": lm_model,
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "scriptVersion": SCRIPT_VERSION,
            "requestId": self.request_id,
            "attemptMode": self._attempt_mode,
            "attemptIndex": self._attempt_index,
            "tracePath": self.trace_path or None,
        }

    def _timestamp_ms(self) -> int:
        return int(time.time() * 1000)

    def _elapsed_ms(self) -> int:
        return int((time.monotonic() - self.started_at) * 1000)

    def _last_progress_age_ms_locked(self) -> int:
        return int((time.monotonic() - self._last_progress_emit_at) * 1000)

    def _decode_stall_threshold_sec_locked(self) -> float:
        return DECODE_STALL_THRESHOLD_COLD_SEC

    def _emit_locked(self, *, heartbeat: bool = False) -> None:
        payload = dict(self._payload)
        payload["elapsedMs"] = self._elapsed_ms()
        payload["heartbeatTs"] = self._timestamp_ms()
        payload["lastProgressAgeMs"] = self._last_progress_age_ms_locked()
        progress = float(payload.get("progress", 0.0))
        if progress > 0.02:
            payload["etaMs"] = max(
                0,
                int((payload["elapsedMs"] / progress) - payload["elapsedMs"]),
            )
        if heartbeat:
            payload["heartbeat"] = True
        emit_payload(payload)

    def start_heartbeat(self) -> None:
        if self._heartbeat_thread is not None:
            return

        def heartbeat_loop() -> None:
            while not self._stop_heartbeat.wait(HEARTBEAT_INTERVAL_SEC):
                stall_payload: dict[str, Any] | None = None
                with self._lock:
                    state = str(self._payload.get("state", "idle"))
                    if state in {"idle", "done", "error", "cancelled"}:
                        continue
                    phase = str(self._payload.get("phase", ""))
                    if (
                        phase == "decoding_audio"
                        and not self._decode_stall_reported
                        and self._last_progress_age_ms_locked()
                        >= int(self._decode_stall_threshold_sec_locked() * 1000)
                    ):
                        self._decode_stall_reported = True
                        self._abort_due_to_stall = True
                        prior_failure = normalize_text(self._prior_failure)
                        failure_detail = normalize_text(self._failure_detail)
                        failure_kind = "decode_stalled"
                        phase_name = "decode_stalled"
                        message = "ACE-Step decode stalled while finalizing audio."
                        if is_out_of_memory_error(failure_detail):
                            failure_kind = "native_decode_failure"
                            phase_name = "error"
                            message = "ACE-Step ran out of GPU memory while finalizing audio."
                        if prior_failure:
                            message += f" Prior failure: {prior_failure}"
                        self._payload.update(
                            {
                                "state": "error",
                                "progress": float(self._payload.get("progress", 0.0)),
                                "phase": phase_name,
                                "message": message,
                                "error": message,
                                "failureKind": failure_kind,
                                "priorFailure": prior_failure or None,
                                "phaseElapsedMs": int(
                                    (time.monotonic() - self._phase_entered_at) * 1000
                                ),
                            }
                        )
                        stall_payload = dict(self._payload)
                        stall_payload["elapsedMs"] = self._elapsed_ms()
                        stall_payload["heartbeatTs"] = self._timestamp_ms()
                        stall_payload["lastProgressAgeMs"] = self._last_progress_age_ms_locked()
                        stall_payload["heartbeat"] = True
                    else:
                        self._emit_locked(heartbeat=True)
                if stall_payload is not None:
                    emit_payload(stall_payload)

        self._heartbeat_thread = threading.Thread(
            target=heartbeat_loop,
            name="OpenStudioAIMusicHeartbeat",
            daemon=True,
        )
        self._heartbeat_thread.start()

    def stop_heartbeat(self) -> None:
        self._stop_heartbeat.set()
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join(timeout=2.0)
            self._heartbeat_thread = None

    def update(
        self,
        state: str,
        progress: float,
        *,
        phase: str,
        message: str,
        **extra: Any,
    ) -> None:
        with self._lock:
            phase_changed = phase != str(self._payload.get("phase", ""))
            if phase_changed:
                self._phase_entered_at = time.monotonic()
                self._decode_stall_reported = False
            payload = {
                "state": state,
                "progress": progress,
                "phase": phase,
                "message": message,
                "backend": self.backend,
                "runMode": self.run_mode,
                "sessionMode": self.session_mode,
                "runtimeProfile": self.runtime_profile,
                "lmModel": self.lm_model,
                "protocolVersion": WORKER_PROTOCOL_VERSION,
                "scriptVersion": SCRIPT_VERSION,
                "requestId": self.request_id,
                "attemptMode": self._attempt_mode,
                "attemptIndex": self._attempt_index,
                "priorFailure": self._prior_failure or None,
                "tracePath": self.trace_path or None,
                "failureDetail": self._failure_detail or None,
                "lmBackend": self._lm_backend or None,
                "lmStage": self._lm_stage or None,
                **extra,
            }
            payload = {key: value for key, value in payload.items() if value is not None}
            self._payload.update(payload)
            self._last_progress_emit_at = time.monotonic()
            self._emit_locked()

    def set_backend(self, backend: str) -> None:
        with self._lock:
            self.backend = backend
            self._payload["backend"] = backend

    def set_lm_backend(self, lm_backend: str) -> None:
        with self._lock:
            self._lm_backend = normalize_text(lm_backend)
            if self._lm_backend:
                self._payload["lmBackend"] = self._lm_backend
            else:
                self._payload.pop("lmBackend", None)

    def set_lm_stage(self, lm_stage: str) -> None:
        with self._lock:
            self._lm_stage = normalize_text(lm_stage)
            if self._lm_stage:
                self._payload["lmStage"] = self._lm_stage
            else:
                self._payload.pop("lmStage", None)

    def set_failure_detail(self, failure_detail: str) -> None:
        with self._lock:
            self._failure_detail = normalize_text(failure_detail)
            if self._failure_detail:
                self._payload["failureDetail"] = self._failure_detail
            else:
                self._payload.pop("failureDetail", None)

    def set_last_stdout_line(self, line: str) -> None:
        with self._lock:
            cleaned = normalize_text(line)
            if cleaned:
                self._payload["lastStdoutLine"] = cleaned
            else:
                self._payload.pop("lastStdoutLine", None)

    def set_last_stderr_line(self, line: str) -> None:
        with self._lock:
            cleaned = normalize_text(line)
            if cleaned:
                self._payload["lastStderrLine"] = cleaned
            else:
                self._payload.pop("lastStderrLine", None)

    def set_request_context(
        self,
        *,
        attempt_mode: str,
        attempt_index: int,
        prior_failure: str = "",
        debug_decode_stall_seconds: float = 0.0,
    ) -> None:
        with self._lock:
            self._attempt_mode = attempt_mode
            self._attempt_index = max(1, int(attempt_index))
            self._prior_failure = normalize_text(prior_failure)
            self._debug_decode_stall_seconds = max(0.0, float(debug_decode_stall_seconds))
            self._debug_decode_stall_used = False
            self._payload["attemptMode"] = self._attempt_mode
            self._payload["attemptIndex"] = self._attempt_index
            if self._prior_failure:
                self._payload["priorFailure"] = self._prior_failure
            else:
                self._payload.pop("priorFailure", None)

    def set_runtime_context(
        self,
        *,
        run_mode: str,
        session_mode: str,
        runtime_profile: str,
        lm_model: str,
    ) -> None:
        with self._lock:
            self.run_mode = run_mode
            self.session_mode = session_mode
            self.runtime_profile = runtime_profile
            self.lm_model = lm_model
            self._payload["runMode"] = run_mode
            self._payload["sessionMode"] = session_mode
            self._payload["runtimeProfile"] = runtime_profile
            self._payload["lmModel"] = lm_model

    def _map_stage_progress(
        self, phase: str, raw_progress: float
    ) -> tuple[float, float | None]:
        start, end = PHASE_PROGRESS_BOUNDS.get(phase, (0.0, 1.0))
        phase_progress: float | None = None

        if phase == "lm_phase_1" and 0.0 <= raw_progress <= 0.5:
            phase_progress = min(1.0, max(0.0, raw_progress / 0.5))
        elif phase == "lm_phase_2" and raw_progress >= 0.5:
            phase_progress = min(1.0, max(0.0, (raw_progress - 0.5) / 0.5))
        elif phase == "dit_generation" and 0.0 <= raw_progress <= 1.0:
            phase_progress = min(1.0, max(0.0, raw_progress))
        elif phase == "decoding_audio" and 0.0 <= raw_progress <= 1.0:
            phase_progress = min(1.0, max(0.0, raw_progress))
        elif phase == "preparing_audio" and 0.0 <= raw_progress <= 1.0:
            phase_progress = min(1.0, max(0.0, raw_progress))

        if phase_progress is None:
            return start, None
        return start + ((end - start) * phase_progress), phase_progress

    def ace_progress(self, value: float, desc: str | None = None, **_: Any) -> None:
        description = normalize_text(desc) or "Generating music..."
        phase = classify_phase(description)
        should_debug_stall = False
        if (
            phase == "decoding_audio"
            and self._debug_decode_stall_seconds > 0
            and not self._debug_decode_stall_used
        ):
            self._debug_decode_stall_used = True
            should_debug_stall = True
        mapped_progress, phase_progress = self._map_stage_progress(phase, float(value))
        self.update(
            "generating",
            mapped_progress,
            phase=phase,
            message=description,
            phaseProgress=phase_progress,
        )
        if should_debug_stall:
            time.sleep(self._debug_decode_stall_seconds)

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

    def should_abort(self) -> bool:
        with self._lock:
            return self._abort_due_to_stall


class WorkerSession:
    def __init__(self, checkpoint_root: Path, model_id: str) -> None:
        self.checkpoint_root = checkpoint_root
        self.model_id = model_id
        self.runtime_handlers: dict[str, Any] | None = None
        self.runtime_signature: tuple[str, str] | None = None
        self.backend = "unknown"
        self._busy = False

    def _ensure_runtime_handlers(
        self,
        reporter: ProgressReporter,
        *,
        lm_model: str,
    ) -> dict[str, Any]:
        if self.runtime_handlers is not None and self.runtime_signature == (
            self.model_id,
            lm_model,
        ):
            reporter.set_backend(self.backend)
            return self.runtime_handlers

        reporter.update(
            "loading",
            0.08,
            phase="loading_runtime",
            message="Loading the legacy ACE-Step runtime bridge...",
        )
        try:
            from acestep.handler import AceStepHandler
            from acestep.llm_inference import LLMHandler
            install_lm_diagnostics_instrumentation()
        except Exception as exc:  # pragma: no cover - runtime dependent
            raise GenerationFailure(
                f"ACE-Step is not available in this runtime: {exc}",
                progress=0.08,
            ) from exc

        checkpoint_storage_root = self.checkpoint_root.parent
        dit_handler = AceStepHandler(
            persistent_storage_path=str(checkpoint_storage_root)
        )
        llm_handler = LLMHandler(
            persistent_storage_path=str(checkpoint_storage_root)
        )

        device = "cuda"
        try:
            import torch

            if not torch.cuda.is_available():
                device = "cpu"
        except Exception:
            device = "cpu"

        self.backend = device
        reporter.set_backend(device)
        if device == "cpu":
            lower_process_priority_for_cpu()

        reporter.update(
            "loading",
            0.12,
            phase="initializing_model",
            message=f"Initializing ACE-Step on {device.upper()}...",
        )
        lm_backend, lm_backend_reason, lm_acceleration_ready = resolve_lm_backend(device)
        reporter.set_lm_backend(lm_backend)
        if sys.platform == "win32" and device == "cuda" and not lm_acceleration_ready:
            raise GenerationFailure(
                "OpenStudio requires the pinned Windows ACE-Step acceleration stack before music generation can start. "
                + lm_backend_reason,
                progress=0.12,
                lmBackend=lm_backend,
                lmBackendReason=lm_backend_reason,
            )
        init_status, init_ok = dit_handler.initialize_service(
            project_root=str(self.checkpoint_root),
            config_path=self.model_id,
            device=device,
            use_flash_attention=device == "cuda" and lm_acceleration_ready,
            compile_model=False,
            offload_to_cpu=device == "cpu",
            offload_dit_to_cpu=False,
        )
        if not init_ok:
            raise GenerationFailure(
                f"ACE-Step model initialization failed: {init_status}",
                progress=0.12,
            )

        reporter.update(
            "loading",
            0.18,
            phase="initializing_lm",
            message="Initializing ACE-Step language model...",
        )
        lm_status, lm_ok = llm_handler.initialize(
            checkpoint_dir=str(self.checkpoint_root),
            lm_model_path=lm_model,
            backend=lm_backend,
            device=device,
            offload_to_cpu=device == "cpu",
            dtype=dit_handler.dtype,
        )
        if not lm_ok:
            raise GenerationFailure(
                f"ACE-Step LM initialization failed: {lm_status}",
                progress=0.18,
            )
        actual_lm_backend = normalize_text(getattr(llm_handler, "llm_backend", "")) or lm_backend
        if actual_lm_backend != lm_backend:
            lm_backend_reason = (
                lm_backend_reason
                + f"; ACE-Step runtime fell back to {actual_lm_backend}"
            )
        reporter.set_lm_backend(actual_lm_backend)

        self.runtime_handlers = {
            "dit_handler": dit_handler,
            "llm_handler": llm_handler,
            "device": device,
            "lm_backend": actual_lm_backend,
            "lm_backend_reason": lm_backend_reason,
            "lm_model": lm_model,
        }
        self.runtime_signature = (self.model_id, lm_model)
        return self.runtime_handlers

    def _run_generation(
        self,
        *,
        workflow: str,
        raw_params_json: str,
        output_path: Path,
        session_mode: str,
        request_id: str,
    ) -> str:
        if workflow == "continuation":
            raise GenerationFailure(
                "Continuation workflow is not yet supported by this ACE-Step bridge.",
                progress=0.1,
            )

        try:
            raw_params = json.loads(raw_params_json)
        except json.JSONDecodeError as exc:
            raise GenerationFailure(f"Invalid params JSON: {exc}") from exc

        output_path.parent.mkdir(parents=True, exist_ok=True)
        layout = validate_checkpoint_layout(self.checkpoint_root, self.model_id)
        selection = resolve_runtime_selection(
            requested_profile=normalize_text(raw_params.get("runtimeProfile"))
            or DEFAULT_RUNTIME_PROFILE,
            requested_lm_model=normalize_text(raw_params.get("lmModel"))
            or DEFAULT_LM_SELECTION,
            checkpoint_root=self.checkpoint_root,
        )
        use_legacy_wrapper = normalize_bool(
            os.environ.get("OPENSTUDIO_USE_LEGACY_ACE_WRAPPER"),
            False,
        )
        run_mode = (
            "warm"
            if use_legacy_wrapper
            and self.runtime_handlers is not None
            and self.runtime_signature == (self.model_id, selection["selectedLmModel"])
            else "cold"
        )
        trace_session = AITraceSession(
            request_id=request_id,
            workflow=workflow,
            session_mode=session_mode,
            model_id=self.model_id,
        )
        trace_session.set_metadata(
            rawParams=raw_params,
            selectedProfile=selection["selectedProfile"],
            selectedLmModel=selection["selectedLmModel"],
            runtimeProfileName=selection["runtimeProfileName"],
            nativeRequiredAssets=layout.get("requiredAssets", []),
            outputPath=str(output_path),
            checkpointRoot=str(self.checkpoint_root),
            runMode=run_mode,
            workerPid=os.getpid(),
        )

        reporter = ProgressReporter(
            model_id=self.model_id,
            checkpoint_root=self.checkpoint_root,
            backend=self.backend,
            run_mode=run_mode,
            session_mode=session_mode,
            runtime_profile=selection["selectedProfile"],
            lm_model=selection["selectedLmModel"],
            request_id=request_id,
            trace_path=trace_session.trace_path(),
        )
        set_active_diagnostics_context(trace_session, reporter)
        reporter.start_heartbeat()

        try:
            reporter.update(
                "loading",
                0.05,
                phase="validating_request",
                message=(
                    "Validating the ACE-Step request "
                    f"({selection['selectedProfileLabel']} / {selection['selectedLmModel']})..."
                ),
                runMode=run_mode,
                runtimeProfile=selection["selectedProfile"],
                lmModel=selection["selectedLmModel"],
                statusNote=" ".join(selection["statusNotes"]).strip() or None,
            )
            params = normalize_generation_params(raw_params)
            reporter.set_runtime_context(
                run_mode=run_mode,
                session_mode=session_mode,
                runtime_profile=selection["selectedProfile"],
                lm_model=selection["selectedLmModel"],
            )
            trace_session.set_metadata(
                backend=self.backend,
                tracePath=trace_session.trace_path(),
            )
            generation_mode = (
                GENERATION_MODE_LM_FIRST
                if bool(params.get("generate_audio_codes", True))
                else GENERATION_MODE_DIT_MANUAL
            )
            use_lm_audio_codes = generation_mode == GENERATION_MODE_LM_FIRST
            status_notes = list(selection["statusNotes"])
            status_notes.append(
                "OpenStudio's native split graph is using TextEncodeAceStepAudio1.5 -> AuraFlow -> KSampler -> VAEDecodeAudio."
            )
            status_notes.append(
                "Manual workflow mode is active; explicit BPM, duration, time signature, language, and key are passed directly to the split graph encoder."
            )
            if use_lm_audio_codes:
                status_notes.append(
                    "LM audio-code generation is enabled to match the native split graph workflow."
                )
            else:
                status_notes.append(
                    "LM audio-code generation is disabled for manual direct conditioning."
                )
            attempt_mode = (
                "legacy_ace_wrapper" if use_legacy_wrapper else "native_split_graph"
            )
            reporter.set_request_context(
                attempt_mode=attempt_mode,
                attempt_index=1,
                debug_decode_stall_seconds=params["debugDecodeStallSeconds"],
            )
            reporter.set_lm_stage("encoding_conditioning")
            trace_session.log_event(
                "request_contract",
                mirror=True,
                rawParams=raw_params,
                normalizedParams=params,
                backendFamily=("legacy_ace_wrapper" if use_legacy_wrapper else "openstudio_ace_split"),
                workflowMode="manual",
                generateAudioCodes=use_lm_audio_codes,
            )

            reporter.update(
                "loading",
                0.08,
                phase="loading_text_encoders",
                message=(
                    "Launching the OpenStudio ACE split runner "
                    f"({selection['selectedProfileLabel']} / {selection['selectedLmModel']})..."
                ),
                lmBackend=("legacy-ace-wrapper" if use_legacy_wrapper else "openstudio-ace-split"),
                phaseProgress=0.0,
                statusNote=" ".join(status_notes).strip() or None,
            )
            if not use_legacy_wrapper:
                reporter.set_lm_backend("openstudio-ace-split")
                trace_session.set_metadata(
                    lmBackend="openstudio-ace-split",
                    backendFamily="openstudio_ace_split",
                )
                final_output = run_native_split_generation(
                    reporter=reporter,
                    trace_session=trace_session,
                    request_id=request_id,
                    workflow=workflow,
                    session_mode=session_mode,
                    normalized_params=params,
                    selection=selection,
                    checkpoint_root=self.checkpoint_root,
                    output_path=output_path,
                )
                final_output_path = Path(final_output).expanduser().resolve()
                if final_output_path != output_path.resolve():
                    reporter.update(
                        "writing",
                        0.96,
                        phase="writing_output",
                        message="Copying the generated audio into OpenStudio's output path...",
                    )
                    try:
                        shutil.copyfile(final_output_path, output_path)
                    except Exception as exc:  # pragma: no cover - file-system dependent
                        raise GenerationFailure(
                            f"Failed to save generated audio: {exc}",
                            progress=0.97,
                        ) from exc

                reporter.done(str(output_path))
                return str(output_path)

            trace_session.log_event(
                "legacy_wrapper_requested",
                mirror=True,
                note="OPENSTUDIO_USE_LEGACY_ACE_WRAPPER is enabled; routing to the old ACE-Step wrapper path.",
            )
            runtime_handlers = self._ensure_runtime_handlers(
                reporter,
                lm_model=selection["selectedLmModel"],
            )
            reporter.set_lm_backend(runtime_handlers.get("lm_backend", ""))
            trace_session.set_metadata(
                lmBackend=runtime_handlers.get("lm_backend"),
                lmBackendReason=runtime_handlers.get("lm_backend_reason"),
                backendFamily="legacy_ace_wrapper",
            )
            try:
                from acestep.inference import (
                    GenerationConfig,
                    generate_music,
                )
            except Exception as exc:  # pragma: no cover - runtime dependent
                raise GenerationFailure(
                    f"ACE-Step inference API is not available in this runtime: {exc}",
                    progress=0.2,
                ) from exc

            generation_config = GenerationConfig(
                batch_size=1,
                allow_lm_batch=False,
                use_random_seed=params["seed"] < 0,
                seeds=None if params["seed"] < 0 else [params["seed"]],
                audio_format="wav",
            )
            generation_param_payload = build_generation_param_payload(
                params,
                generation_mode=generation_mode,
            )
            generation_params = build_generation_params(
                params,
                generation_mode=generation_mode,
            )
            log_normalized_request_payload(
                request_id=request_id,
                workflow=workflow,
                session_mode=session_mode,
                normalized_params=params,
                runtime_selection=selection,
                generation_param_payload=generation_param_payload,
            )
            trace_session.log_event(
                "legacy_request_contract",
                mirror=True,
                generationParams=generation_param_payload,
            )
            reporter.update(
                "loading",
                0.2,
                phase="encoding_conditioning",
                message=(
                    "Submitting the request to the legacy ACE-Step wrapper "
                    f"({runtime_handlers.get('lm_backend', 'pt').upper()} LM / {selection['selectedLmModel']})..."
                ),
                lmBackend=runtime_handlers.get("lm_backend"),
                lmBackendReason=runtime_handlers.get("lm_backend_reason"),
                phaseProgress=0.0,
                statusNote=" ".join(status_notes).strip() or None,
            )

            generation_error: str | None = None
            result = None
            if params["debugForceLmShapeMismatch"] and use_lm_audio_codes:
                generation_error = (
                    "❌ Error generating from formatted prompt: "
                    "The size of tensor a (151669) must match the size of tensor b "
                    "(217204) at non-singleton dimension 1"
                )
            else:
                try:
                    trace_session.log_event(
                        "generate_music_enter",
                        generationMode=generation_mode,
                        lmBackend=runtime_handlers.get("lm_backend"),
                        lmModel=selection["selectedLmModel"],
                        generateAudioCodes=bool(params.get("generate_audio_codes", True)),
                        explicitMusicalMetadata=has_explicit_musical_metadata(params),
                    )
                    result = generate_music(
                        runtime_handlers["dit_handler"],
                        runtime_handlers["llm_handler"],
                        generation_params,
                        generation_config,
                        save_dir=str(output_path.parent),
                        progress=reporter.ace_progress,
                    )
                    trace_session.log_event(
                        "generate_music_exit",
                        result=summarize_value(result),
                    )
                except Exception as exc:  # pragma: no cover - runtime/model dependent
                    reporter.set_failure_detail(f"{type(exc).__name__}: {exc}")
                    trace_session.log_event(
                        "generate_music_exception",
                        mirror=True,
                        exceptionType=type(exc).__name__,
                        failureDetail=f"{type(exc).__name__}: {exc}",
                        traceback="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                        tracebackFrames=summarize_traceback_frames(exc.__traceback__),
                    )
                    generation_error = str(exc)

            if generation_error is None and (
                result is None or not result.success or not result.audios
            ):
                generation_error = (
                    result.error
                    if result is not None
                    else "ACE-Step generation did not return any audio outputs."
                ) or "ACE-Step generation did not return any audio outputs."

            if generation_error is None and reporter.should_abort():
                raise GenerationFailure(
                    "ACE-Step decode stalled while finalizing audio.",
                    progress=0.95,
                    failureKind="decode_stalled",
                    priorFailure=reporter._prior_failure or None,
                )

            if generation_error is not None:
                reporter.set_failure_detail(generation_error)
                raise GenerationFailure(
                    f"ACE-Step generation failed: {generation_error}",
                    progress=0.2,
                    failureKind=classify_generation_failure_kind(
                        generation_error,
                        generation_mode=generation_mode,
                    ),
                )

            if not result.success or not result.audios:
                raise GenerationFailure(
                    result.error
                    or "ACE-Step generation did not return any audio outputs.",
                    progress=0.2,
                )

            output_candidate = normalize_text(result.audios[0].get("path"))
            if not output_candidate:
                raise GenerationFailure(
                    "ACE-Step generation finished without an output file path.",
                    progress=0.92,
                )

            reporter.update(
                "writing",
                0.96,
                phase="writing_output",
                message="Writing the generated audio file...",
            )
            try:
                shutil.copyfile(output_candidate, output_path)
            except Exception as exc:  # pragma: no cover - file-system dependent
                raise GenerationFailure(
                    f"Failed to save generated audio: {exc}",
                    progress=0.97,
                ) from exc

            reporter.done(str(output_path))
            return str(output_path)
        except GenerationFailure as failure:
            reporter.set_failure_detail(
                normalize_text(
                    failure.payload.get("failureDetail")
                    or failure.payload.get("error")
                    or failure.message
                )
            )
            reporter.fail(
                failure.message,
                progress=failure.progress,
                **failure.payload,
            )
            return ""
        finally:
            reporter.stop_heartbeat()
            trace_session.finalize()
            set_active_diagnostics_context(None, None)

    def generate(
        self,
        *,
        workflow: str,
        raw_params_json: str,
        output_path: Path,
        session_mode: str,
        request_id: str,
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
        try:
            return bool(
                self._run_generation(
                    workflow=workflow,
                    raw_params_json=raw_params_json,
                    output_path=output_path,
                    session_mode=session_mode,
                    request_id=request_id,
                )
            )
        finally:
            self._busy = False


def recv_exact(connection: socket.socket, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    bytes_remaining = byte_count
    while bytes_remaining > 0:
        data = connection.recv(bytes_remaining)
        if not data:
            raise ConnectionError("Socket closed before the framed payload was fully received.")
        chunks.append(data)
        bytes_remaining -= len(data)
    return b"".join(chunks)


def recv_framed_json(connection: socket.socket) -> dict[str, Any]:
    header = recv_exact(connection, 4)
    payload_length = struct.unpack(">I", header)[0]
    if payload_length <= 0 or payload_length > MAX_FRAMED_PAYLOAD_BYTES:
        raise ValueError(f"Invalid framed payload length: {payload_length}")
    payload_bytes = recv_exact(connection, payload_length)
    decoded = payload_bytes.decode("utf-8", errors="replace")
    parsed = json.loads(decoded)
    if not isinstance(parsed, dict):
        raise ValueError("Framed payload must decode to a JSON object.")
    parsed["_framedPayloadLength"] = payload_length
    return parsed


def send_framed_json(connection: socket.socket, payload: dict[str, Any]) -> int:
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(payload_bytes) > MAX_FRAMED_PAYLOAD_BYTES:
        raise ValueError(
            f"Framed payload exceeds the maximum allowed size: {len(payload_bytes)} bytes"
        )
    connection.sendall(struct.pack(">I", len(payload_bytes)) + payload_bytes)
    return len(payload_bytes)


def run_worker_server(checkpoint_root: Path, model_id: str) -> None:
    session = WorkerSession(checkpoint_root=checkpoint_root, model_id=model_id)
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
        message="ACE-Step worker is ready.",
        port=port,
        backend=session.backend,
        sessionMode="persistent",
        protocolVersion=WORKER_PROTOCOL_VERSION,
        scriptVersion=SCRIPT_VERSION,
        pid=os.getpid(),
        scriptPath=str(SCRIPT_PATH),
        musicGenerationModelId=model_id,
        musicGenerationCheckpointRoot=str(checkpoint_root),
        availableProfiles=build_runtime_profile_catalog(checkpoint_root)["availableProfiles"],
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
                        },
                    )
                    continue

                command = normalize_text(request.get("command"))
                request_id = normalize_text(request.get("requestId")) or str(uuid.uuid4())
                request_protocol_version = normalize_int(
                    request.get("protocolVersion"), WORKER_PROTOCOL_VERSION
                )
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

                workflow = normalize_text(request.get("workflow")) or "text-to-music"
                raw_params_json = request.get("params")
                output = normalize_text(request.get("output"))
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

                framed_payload_length = int(request.get("_framedPayloadLength", 0))
                send_framed_json(
                    connection,
                    {
                        "accepted": True,
                        "requestId": request_id,
                        "protocolVersion": WORKER_PROTOCOL_VERSION,
                        "scriptVersion": SCRIPT_VERSION,
                        "pid": os.getpid(),
                        "framedPayloadLength": framed_payload_length,
                    },
                )
                session.generate(
                    workflow=workflow,
                    raw_params_json=raw_params_json,
                    output_path=Path(output).expanduser().resolve(),
                    session_mode="persistent",
                    request_id=request_id,
                )
    finally:
        server.close()


def run_one_shot(args: argparse.Namespace) -> int:
    if not args.workflow or not args.output:
        raise SystemExit(
            "--workflow and --output are required unless --worker is used."
        )
    raw_params_json = resolve_one_shot_params_json(args)

    session = WorkerSession(
        checkpoint_root=resolve_music_gen_checkpoint_root(args.checkpoint_root),
        model_id=args.music_gen_model,
    )
    success = session.generate(
        workflow=args.workflow,
        raw_params_json=raw_params_json,
        output_path=Path(args.output).expanduser().resolve(),
        session_mode=normalize_text(getattr(args, "session_mode", "")) or "oneshot",
        request_id=normalize_text(getattr(args, "request_id", "")) or str(uuid.uuid4()),
    )
    return 0 if success else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate music with ACE-Step")
    parser.add_argument("--worker", action="store_true", help="Run as a persistent worker")
    parser.add_argument("--workflow", help="Workflow id to execute")
    parser.add_argument("--params", help="Workflow parameters JSON")
    parser.add_argument("--params-file", help="Path to workflow parameters JSON")
    parser.add_argument("--params-stdin", action="store_true", help="Read workflow parameters JSON from stdin")
    parser.add_argument("--output", help="Output WAV file path")
    parser.add_argument("--request-id", help="Request identifier for diagnostics")
    parser.add_argument(
        "--checkpoint-root",
        required=True,
        help="Pinned ACE-Step checkpoint root",
    )
    parser.add_argument(
        "--music-gen-model",
        default=DEFAULT_MUSIC_GEN_MODEL,
        help="Pinned ACE-Step model id",
    )
    parser.add_argument(
        "--session-mode",
        default="oneshot",
        help="Session mode label to include in progress payloads",
    )
    return parser.parse_args()


def main() -> None:
    install_stream_mirrors()
    args = parse_args()
    checkpoint_root = resolve_music_gen_checkpoint_root(args.checkpoint_root)
    if args.worker:
        run_worker_server(checkpoint_root=checkpoint_root, model_id=args.music_gen_model)
        return

    raise SystemExit(run_one_shot(args))


if __name__ == "__main__":
    main()
