#!/usr/bin/env python3
"""
OpenStudio Stem Separator - Python subprocess for BS-RoFormer source separation.

Called by C++ AudioEngine via juce::ChildProcess. Communicates progress via
JSON lines on stdout. Writes individual stem WAV files to the output directory.

Usage:
    python stem_separator.py --input audio.wav --output-dir ./stems
        [--model BS-Roformer-SW.ckpt] [--stems vocals,drums,bass,guitar,piano,other]
        [--gpu] [--sample-rate 44100]

Output (stdout JSON lines):
    {"state": "loading", "progress": 0.0}
    {"state": "analyzing", "progress": 0.35}
    {"state": "writing", "progress": 0.95}
    {"state": "done", "progress": 1.0, "stems": {"Vocals": "/path/to/vocals.wav", ...}}
    {"state": "error", "progress": 0.0, "error": "message"}
"""

import argparse
import ctypes
import faulthandler
import json
import logging
import os
import re
import sys
import traceback
from contextlib import nullcontext
from importlib import metadata

from ai_runtime_probe import probe_runtime_capabilities

EMIT_CONTEXT = {}
LAST_PHASE = "startup"


def configure_process(acceleration_mode):
    """Apply child-only policy before importing any native ML libraries."""
    faulthandler.enable()
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ.setdefault(name, str(calculate_cpu_thread_cap()))
    if acceleration_mode == "cpu-only":
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
        os.environ["HIP_VISIBLE_DEVICES"] = "-1"
        os.environ["ROCR_VISIBLE_DEVICES"] = "-1"


def create_separator(separator_class, backend, **kwargs):
    """Override the supported device-setup seam, before any model is loaded.

    CPU visibility variables alone do not disable Apple MPS or DirectML.
    Do not globally monkey-patch torch, or let dependency auto-detection undo
    the explicit CPU policy.
    """
    if backend == "cpu":
        class CpuSeparator(separator_class):
            def setup_torch_device(self, system_info):
                import torch
                self.torch_device_cpu = torch.device("cpu")
                self.torch_device = self.torch_device_cpu
                self.torch_device_mps = None
                self.onnx_execution_provider = ["CPUExecutionProvider"]
        separator_class = CpuSeparator
    return separator_class(**kwargs)


def runtime_versions():
    result = {"python": sys.version, "executable": sys.executable}
    for name in ("audio-separator", "torch", "torchaudio", "numpy", "librosa", "audioread", "onnxruntime",
                 "onnxruntime-gpu", "onnxruntime-directml", "torch-directml"):
        try:
            result[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    return result


def describe_worker_failure(error, logged_error=""):
    # The pinned loader logs the real exception then calls sys.exit(1).
    # Preserve that diagnostic so the native owner can classify a genuine OOM.
    detail = logged_error if isinstance(error, SystemExit) and logged_error else str(error)
    message = f"{type(error).__name__}: {detail}"
    lower = message.lower()
    kind = "device_oom" if any(text in lower for text in
        ("cuda out of memory", "hip out of memory", "mps backend out of memory")) else "worker_error"
    return message, kind


class WorkerFailureCapture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.message = ""

    def emit(self, record):
        if record.levelno >= logging.ERROR:
            # Later dependency messages can replace the cause with advice to
            # redownload a perfectly valid checkpoint. Retain the first cause
            # and bounded follow-up context instead of only the last message.
            self.message = (self.message + "\n" + record.getMessage()).strip()[:4096]


def configure_short_roformer_input(engine):
    """Pad a partial inference window, then discard only the padded output.

    The pinned engine otherwise uses a negative overlap-add start when a file
    (or final section) is shorter than one model window. Keep its window size,
    weights and reconstruction unchanged for every complete window.
    """
    if not getattr(engine, "is_roformer", False):
        return
    original = engine.demix

    def demix(mix):
        import numpy as np
        config = engine.model_data_cfgdict
        segment = engine.segment_size if engine.override_model_segment_size else config.inference.dim_t
        hop = getattr(config.model, "stft_hop_length", None) or config.audio.hop_length
        minimum = int(hop) * (int(segment) - 1)
        length = mix.shape[-1]
        if length >= minimum:
            return original(mix)
        padded = np.pad(mix, [(0, 0)] * (mix.ndim - 1) + [(0, minimum - length)])
        result = original(padded)
        if isinstance(result, dict):
            return {name: audio[..., :length] for name, audio in result.items()}
        return result[..., :length]

    engine.demix = demix


def configure_roformer_output(engine):
    """Keep silent sections as real files so the chunk merger retains timing."""
    original = engine.write_audio

    def write_audio(stem_path, stem_source):
        import numpy as np
        import soundfile as sf
        audio = np.asarray(stem_source)
        if not audio.size or not np.isfinite(audio).all():
            raise ValueError("Stem output is empty or contains nonfinite samples")
        target = os.path.join(engine.output_dir, stem_path) if engine.output_dir else stem_path
        if np.max(np.abs(audio)) < 1e-6:
            # Upstream omits near-silent files, but still returns their names.
            # Preserve their samples and duration, rather than losing a section.
            os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
            sf.write(target, audio, engine.sample_rate, subtype="PCM_16")
        else:
            original(stem_path, stem_source)
        if not os.path.isfile(target):
            raise OSError(f"Stem writer did not produce {target}")

    engine.write_audio = write_audio


def separate_audio(separator, input_path, output_dir, requested_stems, sample_rate):
    """Digital silence is valid audio; upstream incorrectly rejects it as empty."""
    import numpy as np
    import soundfile as sf
    try:
        with sf.SoundFile(input_path) as source:
            frames, source_rate = len(source), source.samplerate
            silent = frames > 0
            for block in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
                if np.any(block):
                    silent = False
                    break
    except (RuntimeError, sf.LibsndfileError):
        # Retain the dependency's decoding support for formats libsndfile cannot read.
        silent = False
    if not silent:
        return separator.separate(input_path)
    emit("writing", 0.9, phase="silent_input", inference="skipped_digital_silence")
    output_frames = round(frames * sample_rate / source_rate)
    files = []
    for stem in requested_stems:
        target = os.path.join(output_dir, stem + ".wav")
        with sf.SoundFile(target, "w", samplerate=sample_rate, channels=2, subtype="PCM_16") as output:
            remaining = output_frames
            while remaining:
                count = min(remaining, 65536)
                output.write(np.zeros((count, 2), dtype="float32"))
                remaining -= count
        files.append(os.path.abspath(target))
    return files

def emit(state: str, progress: float = 0.0, **kwargs):
    """Print a JSON progress line to stdout for C++ to read."""
    global LAST_PHASE
    LAST_PHASE = kwargs.get("phase", LAST_PHASE)
    msg = {"state": state, "progress": round(progress, 4), "phase": LAST_PHASE}
    if EMIT_CONTEXT:
        msg.update(EMIT_CONTEXT)
    msg.update(kwargs)
    print(json.dumps(msg), flush=True)


def set_emit_context(**kwargs):
    EMIT_CONTEXT.clear()
    EMIT_CONTEXT.update(kwargs)

def install_tqdm_hook():
    """Monkey-patch tqdm so its progress updates emit JSON lines on stdout.
    audio-separator's demix() uses `from tqdm import tqdm`, so we must patch
    tqdm.std.tqdm (the real class) before audio-separator is imported.
    This ensures the `from tqdm import tqdm` in the separator module picks up
    our patched version."""
    try:
        import tqdm
        import tqdm.std
        _orig_tqdm = tqdm.std.tqdm

        class _ProgressTqdm(_orig_tqdm):
            def __init__(self, *args, **kwargs):
                # Redirect tqdm output to devnull to suppress stderr progress bar,
                # but keep all internal state intact (disable=True skips attribute init)
                kwargs['file'] = open(os.devnull, 'w')
                super().__init__(*args, **kwargs)

            def update(self, n=1):
                super().update(n)
                if self.total and self.total > 0:
                    frac = self.n / self.total
                    # Map tqdm 0..1 to our progress range 0.2..0.9
                    mapped = 0.2 + frac * 0.7
                    emit("analyzing", mapped)

        # Patch everywhere tqdm.tqdm is referenced
        tqdm.std.tqdm = _ProgressTqdm
        tqdm.tqdm = _ProgressTqdm
    except ImportError:
        pass  # tqdm not installed — progress will jump from 0.2 to 0.9

def find_model_file(model_name: str, models_dir: str) -> str:
    """Find model filename — returns just the name (not full path).
    audio-separator uses model_file_dir to locate files, and needs the
    filename to match its internal registry for architecture lookup."""
    local_path = os.path.join(models_dir, model_name)
    if os.path.isfile(local_path):
        return model_name
    # Check without extension variations
    for ext in ['.ckpt', '.pth', '.onnx']:
        if os.path.isfile(os.path.join(models_dir, model_name + ext)):
            return model_name + ext
    # Return the name as-is — audio-separator will try to download it
    return model_name


def detect_separator_backend(separator) -> str:
    providers = list(getattr(separator, "onnx_execution_provider", []) or [])
    torch_device = getattr(getattr(separator, "torch_device", None), "type", "")

    if torch_device == "cuda":
        import torch
        return "rocm" if torch.version.hip else "cuda"
    if torch_device == "cpu":
        return "cpu"
    if torch_device == "mps":
        return "mps"
    if "privateuseone" in torch_device:
        return "directml"
    if "CUDAExecutionProvider" in providers:
        return "cuda"
    if "DmlExecutionProvider" in providers or "privateuseone" in torch_device:
        return "directml"
    if "CoreMLExecutionProvider" in providers:
        return "coreml"
    if torch_device == "mps":
        return "mps"
    return "cpu"


def calculate_cpu_thread_cap() -> int:
    logical_cores = os.cpu_count() or 4
    reserved = 2 if logical_cores > 2 else 1
    return max(1, min(8, logical_cores - reserved))


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


def apply_cpu_fallback_limits() -> int:
    thread_cap = calculate_cpu_thread_cap()
    os.environ.setdefault("OMP_NUM_THREADS", str(thread_cap))
    os.environ.setdefault("MKL_NUM_THREADS", str(thread_cap))
    os.environ.setdefault("OPENBLAS_NUM_THREADS", str(thread_cap))

    try:
        import torch

        torch.set_num_threads(thread_cap)
        if hasattr(torch, "set_num_interop_threads"):
            torch.set_num_interop_threads(1)
    except Exception:
        pass

    lower_process_priority_for_cpu()
    return thread_cap

def main():
    parser = argparse.ArgumentParser(description="OpenStudio Stem Separator")
    parser.add_argument("--input", required=True, help="Input audio file path")
    parser.add_argument("--output-dir", required=True, help="Output directory for stem WAV files")
    parser.add_argument("--model", default="BS-Roformer-SW.ckpt",
                        help="Model filename or path (default: BS-Roformer-SW.ckpt)")
    parser.add_argument("--models-dir", default="",
                        help="Directory containing model files")
    parser.add_argument("--stems", default="vocals,drums,bass,guitar,piano,other",
                        help="Comma-separated list of stems to extract")
    parser.add_argument("--gpu", action="store_true", help="Deprecated compatibility flag for automatic acceleration")
    parser.add_argument("--acceleration-mode", choices=["auto", "cpu-only"], default="auto",
                        help="Acceleration policy (default: auto)")
    parser.add_argument("--sample-rate", type=int, default=44100,
                        help="Output sample rate (default: 44100)")
    parser.add_argument("--chunk-duration", type=int, choices=[0, 30], default=0,
                        help="Bound host-memory use with 30-second sections; 0 uses normal processing")
    parser.add_argument("--memory-mode", choices=["automatic", "streaming-preview"], default="automatic",
                        help="Explicit candidate: rolling buffers with temporary disk storage")
    parser.add_argument("--precision", choices=["default", "fp32", "fp16", "bf16"], default="default",
                        help="Explicit qualification experiment; never changed automatically")
    parser.add_argument("--performance-mode", choices=["standard", "qualified-fast"], default="standard",
                        help="Opt-in faster recipe; unmatched runtimes retain standard precision")
    parser.add_argument("--qualification-gpu-fraction", type=float, default=0,
                        help=argparse.SUPPRESS)
    parser.add_argument("--qualification-host-memory-mb", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--job-id", default="", help=argparse.SUPPRESS)
    parser.add_argument("--qualification-telemetry", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    # An explicit CPU request takes precedence over the legacy --gpu alias.
    acceleration_mode = args.acceleration_mode
    configure_process(acceleration_mode)
    startup = {"versions": runtime_versions()} if args.qualification_telemetry else {}
    emit("loading", phase="startup", **startup,
         accelerationMode=acceleration_mode, chunkDuration=args.chunk_duration)

    # Validate input
    if not os.path.isfile(args.input):
        emit("error", error=f"Input file not found: {args.input}")
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)
    requested_stems = [s.strip().capitalize() for s in args.stems.split(",")]

    # Ensure bundled ffmpeg is on PATH (audio-separator requires it)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(script_dir)
    ffname = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    candidates = [
        os.path.join(script_dir, "ffmpeg-runtime"),
        parent_dir,
        os.path.join(parent_dir, "tools", "ffmpeg-runtime"),
    ]
    for candidate in candidates:
        if os.path.isfile(os.path.join(candidate, ffname)):
            os.environ["PATH"] = candidate + os.pathsep + os.environ.get("PATH", "")
            break

    emit("loading", 0.0, phase="import_separator")

    # Hook tqdm before audio-separator imports it, so demix() progress is captured
    install_tqdm_hook()

    try:
        from audio_separator.separator import Separator
    except Exception as exc:
        emit("error", phase="import_separator", error=f"Could not import audio-separator: {type(exc).__name__}: {exc}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

    failure_capture = None
    telemetry = None
    if args.qualification_telemetry:
        from ai_telemetry import WorkerTelemetry
        telemetry = WorkerTelemetry()
        telemetry.start()
    measure = telemetry.measure if telemetry else nullcontext
    try:
        # Resolve model path
        model_file = args.model
        if args.models_dir:
            model_file = find_model_file(args.model, args.models_dir)

        emit("loading", phase="probe_runtime")
        capability_report = probe_runtime_capabilities(
            models_dir=args.models_dir,
            model_name=model_file,
            acceleration_mode=acceleration_mode,
        )
        probed_backend = capability_report.get("selectedBackend", "cpu")
        import torch
        from ai_execution_policy import worker_threads, runtime_capabilities, model_execution_capabilities, stem_execution_backend
        selected_backend, model_fallback_reason = stem_execution_backend(probed_backend, model_file)
        fallback_reason = model_fallback_reason or capability_report.get("fallbackReason", "")
        from ai_memory_manager import (available_host_memory, plan_stem_memory, module_storage_bytes,
                                       model_execution_receipt)
        from ai_execution_policy import device_budget
        import soundfile as sf
        from dataclasses import asdict
        try:
            source_info = sf.info(args.input)
            duration, source_rate, channels = source_info.duration, source_info.samplerate, source_info.channels
        except (RuntimeError, OSError):
            # FFmpeg/audioread may support a format libsndfile cannot inspect.
            duration, source_rate, channels = None, args.sample_rate, 2
        model_path = model_file if os.path.isfile(model_file) else os.path.join(args.models_dir, model_file)
        from stem_acceleration import qualified_fast_recipe, PROFILE as ROCM_FAST_PROFILE
        if args.performance_mode != "standard" and args.precision != "default":
            raise ValueError("Choose either a performance recipe or an experimental precision")
        performance = qualified_fast_recipe(torch, selected_backend, model_path, args.performance_mode)
        if performance["profile"] == ROCM_FAST_PROFILE:
            args.precision = performance["precision"]
        from importlib.metadata import version as package_version
        import shutil
        streaming_disk = (int(max(0, duration or 0)*args.sample_rate)*112 + 1024**3)
        streaming_qualified = (sys.platform in {"win32", "linux"} and selected_backend in {"cpu", "cuda", "rocm"}
            and os.path.basename(model_file) == "BS-Roformer-SW.ckpt" and channels in {1, 2}
            and duration is not None and package_version("audio-separator") == "0.41.1"
            and shutil.disk_usage(args.output_dir).free >= streaming_disk)
        if args.memory_mode == "streaming-preview" and (sys.platform not in {"win32", "linux"}
                or selected_backend not in {"cpu", "cuda", "rocm"}):
            raise ValueError("Rolling reconstruction is not qualified on this platform/backend; use Automatic or 30-second sections")
        available_ram = available_host_memory()
        if args.qualification_host_memory_mb:
            if not 256 <= args.qualification_host_memory_mb <= 16384:
                raise ValueError("Qualification RAM limit must be between 256 and 16384 MiB")
            limit = args.qualification_host_memory_mb*1024**2
            available_ram = min(available_ram, limit) if available_ram is not None else limit
        memory_plan = plan_stem_memory(backend=selected_backend, duration=duration,
            sample_rate=source_rate, channels=channels,
            model_bytes=os.path.getsize(model_path) if os.path.isfile(model_path) else 700 * 1024 ** 2,
            available_ram=available_ram,
            free_vram=device_budget(torch, "cuda:0") if selected_backend in {"cuda", "rocm"} else None,
            requested_sections=args.chunk_duration, precision=args.precision,
            allow_streaming=streaming_qualified, qualified_rocm_fast=performance["profile"] == ROCM_FAST_PROFILE)
        if args.memory_mode == "streaming-preview":
            from dataclasses import replace
            memory_plan = replace(memory_plan, chunk_duration=0,
                                  memory_mode="streaming",
                                  reason=memory_plan.reason + "; explicit rolling buffers with temporary disk")
        if memory_plan.backend != selected_backend:
            fallback_reason = memory_plan.reason
        selected_backend = memory_plan.backend
        EMIT_CONTEXT["performancePolicy"] = performance
        if args.qualification_host_memory_mb:
            EMIT_CONTEXT["qualificationHostMemoryLimitMB"] = args.qualification_host_memory_mb
        if selected_backend == "cpu" and performance["profile"] == ROCM_FAST_PROFILE:
            # The opt-in accelerated recipe must not turn a valid CPU memory
            # fallback into an unsupported FP16 CPU request.
            args.precision = "default"
            performance.update(profile="standard", precision="default",
                reason="GPU memory budget selected CPU; using standard CPU precision")
        from ai_attention_policy import attention_candidates
        torch.set_num_threads(worker_threads(cpu=selected_backend == "cpu"))
        thread_cap = 0
        if selected_backend == "cpu":
            thread_cap = apply_cpu_fallback_limits()

        set_emit_context(
            backend=selected_backend,
            probedBackend=probed_backend,
            supportedBackends=capability_report.get("supportedBackends", ["cpu"]),
            accelerationMode=acceleration_mode,
            threadCap=thread_cap,
            fallbackReason=fallback_reason,
            memoryPlan=asdict(memory_plan),
        )

        # Initialize separator (hardware selection is handled by the managed runtime policy)
        emit("loading", phase="initialize_separator", backend=selected_backend)
        separator = create_separator(Separator, selected_backend,
            output_dir=args.output_dir,
            output_format="WAV",
            output_single_stem=None,
            use_directml=(sys.platform == "win32" and selected_backend == "directml"),
            use_autocast=(selected_backend == "cuda" and args.precision == "default"),
            sample_rate=args.sample_rate,
            chunk_duration=memory_plan.chunk_duration or None,
            # Store downloaded models in our models dir
            model_file_dir=args.models_dir if args.models_dir else None,
        )
        failure_capture = WorkerFailureCapture()
        separator.logger.addHandler(failure_capture)

        selected_backend = detect_separator_backend(separator)
        if memory_plan.chunk_duration:
            from stem_chunking import install_sample_accurate_chunking
            install_sample_accurate_chunking()
        if args.precision not in {"default", "fp32"} and selected_backend not in {"cuda", "rocm"}:
            raise ValueError("Experimental reduced precision requires a supported CUDA/ROCm device")
        if args.precision == "bf16" and not torch.cuda.is_bf16_supported():
            raise ValueError("This device/runtime does not support BF16")
        if selected_backend == "cpu" and thread_cap == 0:
            thread_cap = apply_cpu_fallback_limits()
        set_emit_context(
            backend=selected_backend,
            probedBackend=probed_backend,
            supportedBackends=capability_report.get("supportedBackends", ["cpu"]),
            accelerationMode=acceleration_mode,
            threadCap=thread_cap,
            fallbackReason=fallback_reason,
            memoryPlan=asdict(memory_plan),
        )
        emit("loading", 0.1, phase="load_model")

        # Load model
        if selected_backend in {"cuda", "rocm"}:
            if args.qualification_gpu_fraction:
                if not 0 < args.qualification_gpu_fraction <= .25:
                    raise ValueError("Invalid qualification allocator limit")
                emit("loading", phase="load_model", faultInjection="after_admission_gpu_allocator_limit",
                     gpuAllocatorFraction=args.qualification_gpu_fraction)
                torch.cuda.set_per_process_memory_fraction(args.qualification_gpu_fraction,
                                                           torch.cuda.current_device())
        with measure("loadModel"):
            separator.load_model(model_filename=model_file)
        from ai_attention_policy import configure_roformer_attention
        loaded = getattr(separator, "model_instance", None)
        configure_short_roformer_input(loaded)
        configure_roformer_output(loaded)
        if telemetry:
            telemetry.wrap(loaded, "prepare_mix", "decode")
            telemetry.wrap(loaded, "demix", "demix")
            telemetry.wrap(loaded, "final_process", "writeOutput")
        attention_details = configure_roformer_attention(getattr(loaded, "model_run", None))
        attention_details["candidates"] = attention_candidates(selected_backend)
        model_run = getattr(loaded, "model_run", None)
        from ai_execution_policy import configure_roformer_precision
        precision_details = configure_roformer_precision(model_run, args.precision)
        using_gpu = selected_backend in {"cuda", "rocm"}
        if using_gpu and (model_run is None or not any(
                tensor.is_cuda and tensor.numel() > 0 for tensor in model_run.parameters())):
            raise RuntimeError("GPU backend selected but RoFormer parameters were not loaded into GPU memory")
        measurements = {}
        if telemetry:
            receipt = model_execution_receipt(torch, model_run, separator.torch_device)
            measurements = {"deviceReceipt": receipt, "modelStorage": module_storage_bytes([model_run])}
            if using_gpu:
                EMIT_CONTEXT["gpuResidentBaselineBytes"] = receipt["cudaAllocatedBytes"]
                torch.cuda.reset_peak_memory_stats(separator.torch_device)
        emit("loading", 0.2, executionDetails={
            "hardware": runtime_capabilities(torch), "effectiveBackend": selected_backend,
            "capabilities": model_execution_capabilities("bs-roformer", selected_backend),
            "attention": attention_details,
            "memoryPlan": asdict(memory_plan), **measurements,
            "precision": args.precision, "precisionQualification": "existing_default" if args.precision == "default" else "explicit_experiment_not_promoted",
            "precisionDetails": precision_details,
            "performancePolicy": performance,
            "placement": "resident weights; output sections use CPU memory"})

        # Run separation
        emit("analyzing", 0.2, phase="separate")

        # The separate() method returns a list of output file paths
        mapping_output_dir = args.output_dir
        precision_context = torch.autocast("cuda", dtype=torch.bfloat16 if args.precision == "bf16" else torch.float16) if args.precision in {"bf16", "fp16"} else nullcontext()
        with measure("separate"), precision_context:
            if memory_plan.memory_mode == "streaming":
                from stem_streaming import separate_streaming
                output_files, mapping_output_dir = separate_streaming(separator, args.input, args.output_dir,
                    requested_stems, telemetry, emit, job_id=args.job_id or None)
            else:
                output_files = separate_audio(separator, args.input, args.output_dir, requested_stems, args.sample_rate)
        if not output_files:
            raise RuntimeError(failure_capture.message or "Separator produced no output files")

        emit("writing", 0.9, phase="map_outputs")

        # Map output files to stem names
        # audio-separator names files like: input_(Vocals).wav, input_(Drums).wav, etc.
        # We need to map them to our expected stem names
        stem_map = {}
        stem_names_lower = {s.lower(): s for s in requested_stems}

        # Aliases for stem name matching (audio-separator output names vary by model)
        stem_aliases = {
            "vocals": ["vocals", "vocal", "voice", "singing"],
            "drums": ["drums", "drum", "percussion"],
            "bass": ["bass"],
            "guitar": ["guitar", "guitars"],
            "piano": ["piano", "keys", "keyboard"],
            "other": ["other", "instrumental", "residual", "remainder", "no_"],
        }

        for fpath in output_files:
            # Resolve relative paths against output_dir
            if not os.path.isabs(fpath):
                fpath = os.path.join(args.output_dir, fpath)
            # Skip files that weren't written (e.g. near-silent stems)
            if not os.path.isfile(fpath):
                continue
            fname = os.path.basename(fpath).lower()
            match = re.search(r"_\(([^)]+)\)", fname)
            stem_label = match.group(1) if match else os.path.splitext(fname)[0]
            matched = False
            for stem_key, stem_name in stem_names_lower.items():
                aliases = stem_aliases.get(stem_key, [stem_key])
                if stem_label in aliases:
                    clean_name = f"{stem_name}.wav"
                    clean_path = os.path.join(mapping_output_dir, clean_name)
                    if os.path.abspath(fpath) != os.path.abspath(clean_path):
                        if os.path.exists(clean_path):
                            os.remove(clean_path)
                        os.rename(fpath, clean_path)
                    stem_map[stem_name] = clean_path
                    matched = True
                    break
            # If no match and we haven't mapped "Other" yet, assign unmatched files to "Other"
            if not matched and "Other" in stem_names_lower.values() and "Other" not in stem_map:
                clean_name = "Other.wav"
                clean_path = os.path.join(mapping_output_dir, clean_name)
                if os.path.abspath(fpath) != os.path.abspath(clean_path):
                    if os.path.exists(clean_path):
                        os.remove(clean_path)
                    os.rename(fpath, clean_path)
                stem_map["Other"] = clean_path

        # Remove stems the user didn't request
        final_stems = {}
        for stem_name in requested_stems:
            if stem_name in stem_map:
                final_stems[stem_name] = stem_map[stem_name]

        missing = [name for name in requested_stems if name not in final_stems]
        if missing:
            raise RuntimeError(f"Missing requested stem files: {', '.join(missing)}. Files: {output_files}")

        details = {}
        if telemetry:
            telemetry.stop()
            details = {"telemetry": telemetry.snapshot(),
                       "deviceReceipt": model_execution_receipt(torch, model_run, separator.torch_device)}
        emit("done", 1.0, phase="complete", stems=final_stems, **details)

    except (Exception, SystemExit) as e:
        message, failure_kind = describe_worker_failure(e, getattr(failure_capture, "message", ""))
        details = {}
        if telemetry:
            telemetry.stop()
            details["telemetry"] = telemetry.snapshot()
        emit("error", error=message, failureKind=failure_kind, **details)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
