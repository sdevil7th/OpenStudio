"""Headless, time-bounded local-model benchmarks. Never installs or plays audio.

One process owns one policy, preventing hook/allocator leakage across policies.
Reports are written after each repetition so timeouts retain completed evidence.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict
import json
import math
import os
from pathlib import Path
import statistics
import signal
import subprocess
import sys
import time


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--model", choices=["minimax-music-3", "stable-audio-3-medium", "ace-step-v15-xl-turbo", "bs-roformer"])
    value.add_argument("--input", type=Path, help="Local WAV for BS-Roformer qualification.")
    value.add_argument("--model-root", type=Path)
    value.add_argument("--output-dir", type=Path, required=True)
    value.add_argument("--request", type=Path, help="JSON with workflow and params; source paths must be local.")
    value.add_argument("--duration", type=float, default=5)
    value.add_argument("--repeats", type=int, default=3)
    value.add_argument("--device")
    value.add_argument("--attention", choices=["native", "flash", "xformers", "aiter", "sage"], default="native")
    value.add_argument("--placement", choices=["auto", "resident", "model-offload", "partial-resident", "partial-resident-disk", "group-offload"], default="auto")
    value.add_argument("--quantization", choices=["none", "int8", "torchao-int8"], default="none")
    value.add_argument("--int8-reserve-gib", type=float, choices=[1.5, 2, 3], default=3)
    value.add_argument("--compile", action="store_true", help="Qualify repeated-block compilation in this isolated worker.")
    value.add_argument("--minimax-capacity-only", action="store_true",
                       help="Stress maximum frames by suppressing EOS in this test process; not normal audio evidence.")
    value.add_argument("--timeout", type=float, default=180)
    value.add_argument("--min-available-ram-mb", type=int, default=2048,
                       help="Stop the benchmark if system RAM remains below this floor for two seconds.")
    value.add_argument("--probe", action="store_true")
    value.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    return value


def save(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, default=str), encoding="utf-8")
    temporary.replace(path)


@contextmanager
def capacity_sampling(enabled):
    """Test-only EOS mask; production workers never import this harness."""
    if not enabled:
        yield None
        return
    from diffusers.modular_pipelines.minimax_music3 import encoders
    import hashlib
    original = encoders._sample_top_k
    evidence = {"mode": "eos-suppressed-capacity-only", "semanticCalls": 0,
                "encoderSha256": hashlib.sha256(Path(encoders.__file__).read_bytes()).hexdigest()}
    def sample(logits, generator):
        if logits.shape[-1] > encoders._AUDIO_END_TOKEN_ID:
            logits = logits.clone()
            logits[..., encoders._AUDIO_END_TOKEN_ID] = -float("inf")
            evidence["semanticCalls"] += 1
        return original(logits, generator)
    encoders._sample_top_k = sample
    try:
        yield evidence
    finally:
        encoders._sample_top_k = original


def wait_bounded(child, args):
    from ai_execution_policy import host_available
    deadline = time.monotonic() + args.timeout
    low_since = None
    minimum_available, observations = None, 0
    try:
        while True:
            try:
                return child.wait(timeout=min(1, max(.01, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                now = time.monotonic()
                if now >= deadline:
                    raise
                available = host_available()
                if available is not None:
                    observations += 1
                    minimum_available = available if minimum_available is None else min(minimum_available, available)
                if available is not None and available < args.min_available_ram_mb * 1024**2:
                    low_since = now if low_since is None else low_since
                    if now - low_since >= 2:
                        raise MemoryError("Benchmark stopped to preserve the system RAM reserve.")
                else:
                    low_since = None
    finally:
        if getattr(args, "output_dir", None) is not None:
            save(args.output_dir / "host-memory.json", {"scope": "Whole-system free RAM sampled each second during load and generation",
                "minimumAvailableRamBytes": minimum_available, "observations": observations,
                "floorBytes": args.min_available_ram_mb * 1024**2})


def run(args):
    if args.model == "bs-roformer":
        return run_separation(args)
    from ai_execution_policy import configure_allocator_environment, allocator_environment
    configure_allocator_environment(args.model)
    if args.compile:
        # Must precede Torch/Diffusers imports. The production worker uses
        # setdefault('1'); removing it after Dynamo import can be too late.
        os.environ["TORCHDYNAMO_DISABLE"] = "0"
        os.environ["TORCHINDUCTOR_CACHE_DIR"] = str((args.output_dir / "compile-cache").resolve())
        os.environ["TRITON_CACHE_DIR"] = str((args.output_dir / "compile-cache" / "triton").resolve())
    import faulthandler
    faulthandler.enable()
    import torch
    import soundfile as sf
    import numpy as np
    from ai_execution_policy import select_device, activate_device, runtime_capabilities, worker_version, nvidia_link_snapshot, model_storage_identity
    from ai_attention_policy import attention_candidates
    from diffusers_audio_pipeline import DiffusersAudioSession, memory_snapshot
    selected = select_device(torch, args.device)
    activate_device(torch, selected)
    report = {"hardware": runtime_capabilities(torch), "selectedDevice": asdict(selected),
              "attentionCandidates": attention_candidates(selected.family), "runs": [],
              "subjectiveAudioQuality": "not_asserted", "contention": "not_measured",
              "generationMode": "eos-suppressed-capacity-only" if args.minimax_capacity_only else "normal",
              "outputLifetime": "Waveform released after writing, before next request",
              "policy": {"attention": args.attention, "placement": args.placement,
                         "quantization": args.quantization, "compile": args.compile},
              "workerVersion": worker_version(Path(__file__).with_name(
                  "generate_music.py" if args.model == "ace-step-v15-xl-turbo" else "stable_audio3_generate.py"))}
    report["linkBeforeLoad"] = nvidia_link_snapshot() if selected.family == "cuda" else {}
    report["allocatorConfig"] = allocator_environment()
    report["allocatorBackend"] = torch.cuda.memory.get_allocator_backend() if selected.family == "cuda" else None
    report_path = args.output_dir / "report.json"
    if args.model_root is not None:
        report["modelRoot"] = str(args.model_root.resolve())
        report["modelStorageIdentity"] = model_storage_identity(args.model_root)
    save(report_path, report)
    if args.probe:
        from ai_attention_policy import probe_native_attention
        from ai_execution_policy import probe_transfer_bandwidth
        report["attentionOperators"] = probe_native_attention(torch, selected.device)
        report["transfers"] = probe_transfer_bandwidth(torch, selected.device)
        if args.quantization == "int8":
            from ai_execution_policy import probe_int8
            try:
                report["quantizationOperator"] = probe_int8(torch, selected.device)
            except Exception as exc:
                report["quantizationOperator"] = {"state": "fail", "error": f"{type(exc).__name__}: {exc}"}
                report["status"] = "fail"
                save(report_path, report)
                return 1
        if args.compile:
            from ai_execution_policy import probe_compile
            try:
                report["compilationOperator"] = probe_compile(torch, selected.device)
            except Exception as exc:
                report["compilationOperator"] = {"state": "fail", "error": f"{type(exc).__name__}: {exc}"}
                report["status"] = "fail"
                save(report_path, report)
                return 1
        save(report_path, report)

        return 0
    request = json.loads(args.request.read_text(encoding="utf-8-sig")) if args.request else {
        "workflow": "lyrics-style" if args.model == "minimax-music-3" else
                    "text-to-music" if args.model == "ace-step-v15-xl-turbo" else "text-to-audio",
        "params": {"prompt": "A mellow acoustic song with a clear solo vocal and gentle guitar.",
                   "lyrics": "[verse]\nMorning light upon the sea\nA quiet song comes back to me",
                   "duration": args.duration, "seed": 123, "steps": 8}}
    report["request"] = request
    session = None
    start = time.perf_counter()
    try:
        if args.model == "ace-step-v15-xl-turbo":
            from generate_music import DiffusersAcePipelineManager
            session = DiffusersAcePipelineManager(model_id=str(args.model_root), cache_root=args.model_root,
                enable_group_offload=True, requested_device=selected.device, attention=args.attention,
                quantization=args.quantization, placement=args.placement)
            session.load()
        else:
            from ai_execution_policy import minimax_prompt_tokens
            budget_params = request["params"]
            if args.model == "minimax-music-3":
                import stable_audio3_generate as worker
                worker.MODEL_ID = args.model
                budget_params, _ = worker.build_generation_request(request["workflow"], request["params"])
                if args.request is None:
                    budget_params["duration"] = args.duration
            session = DiffusersAudioSession(args.model_root, args.model,
                request_duration=float(budget_params.get("duration", args.duration)),
                request_prompt_tokens=minimax_prompt_tokens(args.model_root, budget_params.get("prompt", ""),
                    budget_params.get("lyrics", "")) if args.model == "minimax-music-3" else 5000,
                requested_device=selected.device, attention=args.attention, placement=args.placement,
                quantization=args.quantization, int8_reserve_bytes=int(args.int8_reserve_gib * 1024**3))
        report["loadSeconds"] = time.perf_counter() - start
        report["initialExecution"] = dict(getattr(session, "execution_details", {}))
        save(report_path, report)
        for index in range(args.repeats):
            events = []
            output_lifetime = None
            start = time.perf_counter()
            last_progress = 0
            last_phase = None
            def progress(phase, message, fraction):
                nonlocal last_progress, last_phase
                elapsed = time.perf_counter() - start
                event = {"phase": phase, "message": message, "fraction": fraction, "seconds": elapsed}
                events.append(event)
                if phase != last_phase or elapsed - last_progress >= 2:
                    last_progress = elapsed
                    last_phase = phase
                    event["memory"] = memory_snapshot(selected.device)
                    save(args.output_dir / "progress.json", {"run": index, **event,
                         "memory": event["memory"]})
            output = args.output_dir / f"run-{index}.wav"
            if args.model == "ace-step-v15-xl-turbo":
                from generate_music import build_generation_spec, prepare_source_segment, SOURCE_WORKFLOWS
                class Reporter:
                    request_id = f"benchmark-{index}"
                    def update(self, *positional, **kw):
                        progress(kw.get("phase"), kw.get("message"), kw.get("phaseProgress"))
                    def set_backend(self, _backend): pass
                source_request = prepare_source_segment(raw_params=request["params"], output_path=output,
                    request_id=f"bench-{index}") if request["workflow"] in SOURCE_WORKFLOWS else None
                spec = build_generation_spec(request["workflow"], request["params"], source_request=source_request)
                if args.compile and index == 0:
                    from ai_execution_policy import compile_components
                    session.configure_memory(spec.duration, Reporter())
                    report["compilation"] = compile_components(session.pipe.components, selected.device)
                session.generate(spec=spec, source_request=source_request, output_path=output, reporter=Reporter())
                data, rate = sf.read(output, always_2d=True)
            else:
                # Use the worker's request/source normalization, never invent a
                # different source-edit contract for a benchmark.
                import stable_audio3_generate as worker
                worker.MODEL_ID = args.model
                if args.compile and index == 0:
                    from ai_execution_policy import compile_components
                    report["compilation"] = compile_components(session.pipe.components, selected.device)
                params = request["params"]
                source_audio = source_meta = None
                if request["workflow"] in worker.SOURCE_WORKFLOWS:
                    source_path, source_meta = worker.prepare_source_segment(params, output, f"bench-{index}",
                        target_sample_rate=session.sample_rate, target_channels=session.io_channels)
                    source_audio = worker.load_audio_tuple(source_path)
                kwargs, request_details = worker.build_generation_request(request["workflow"], params,
                    source_audio=source_audio, source_meta=source_meta)
                # Subsecond durations are available only in the direct harness
                # for bounded forward qualification; the app keeps its limits.
                if args.request is None:
                    kwargs["duration"] = args.duration
                with capacity_sampling(args.minimax_capacity_only) as capacity_evidence:
                    audio = session.generate(workflow=request["workflow"], **kwargs,
                        progress_callback=progress)
                rate = session.sample_rate
                if args.request is None and args.duration < 1:
                    # Explicit microbenchmarks only establish finite forwards.
                    data = worker.audio_to_array(audio)
                    sf.write(output, data, rate, subtype="FLOAT")
                    report["outputValidation"] = "subsecond_forward_only"
                else:
                    diagnostics = worker.write_audio(output, audio, rate,
                        crop_start_seconds=float(request_details.get("continuationCropStart", 0)),
                        target_peak=float(request_details.get("targetPeak", 0)),
                        target_rms=float(request_details.get("targetRms", 0)),
                        workflow=request["workflow"],
                        expected_output_duration=float(request_details.get("expectedOutputDuration", 0)))
                    data, rate = sf.read(output, always_2d=True)
                    report["outputValidation"] = diagnostics
                # Match the request-scoped worker's output lifetime. MiniMax
                # defaults to a CPU ndarray; other adapters can return CUDA
                # tensors. Do not assume retained host audio occupies VRAM.
                import weakref
                output_ref = weakref.ref(audio) if isinstance(audio, torch.Tensor) and audio.is_cuda else None
                output_lifetime = {"device": str(audio.device) if isinstance(audio, torch.Tensor) else "cpu",
                                   "type": type(audio).__name__}
                if output_ref is not None:
                    output_lifetime.update(outputBytes=audio.numel() * audio.element_size(),
                                           allocatedBeforeRelease=torch.cuda.memory_allocated(selected.device))
                del audio
                if output_ref is not None and output_ref() is not None:
                    raise RuntimeError("Previous GPU waveform is still retained before the next request.")
                if output_ref is not None:
                    output_lifetime["allocatedAfterRelease"] = torch.cuda.memory_allocated(selected.device)
            seconds = time.perf_counter() - start
            valid = bool(data.size and np.isfinite(data).all() and data.ndim == 2 and data.shape[1] == 2)
            if args.minimax_capacity_only:
                # Window stitching can add fractional-second padding. Capacity
                # requires at least the requested duration, not sample equality.
                valid = valid and len(data)/rate >= kwargs["duration"] - .05
            report["runs"].append({"index": index, "seconds": seconds, "warm": index > 0,
                "generatedSeconds": len(data)/rate, "sampleRate": rate, "status": "pass" if valid else "fail",
                "execution": dict(session.execution_details), "events": events})
            if args.minimax_capacity_only:
                report["runs"][-1]["capacityEvidence"] = capacity_evidence
            if output_lifetime is not None:
                report["runs"][-1]["outputLifetime"] = output_lifetime
            report["linkAfterGeneration"] = nvidia_link_snapshot() if selected.family == "cuda" else {}
            save(report_path, report)
            print(json.dumps({"run": index, "seconds": seconds, "status": "pass" if valid else "fail"}), flush=True)
            if not valid:
                report["status"] = "fail"
                return 1
        warm = [item["seconds"] for item in report["runs"] if item["warm"]]
        if warm:
            report["warmSeconds"] = {"median": statistics.median(warm), "min": min(warm), "max": max(warm)}
        report["status"] = "pass"
        return 0
    except Exception as exc:
        report.update(status="fail", error=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        try:
            if session is not None:
                if callable(getattr(session, "close", None)):
                    session.close()
                elif callable(getattr(session, "unload", None)):
                    session.unload()
        except Exception as exc:
            report.update(status="fail", cleanupError=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            save(report_path, report)


def run_separation(args):
    """Run the actual one-shot separator worker and validate each returned stem."""
    import numpy as np
    import soundfile as sf
    if args.attention != "native" or args.placement != "auto" or args.quantization != "none" or args.compile:
        raise ValueError("BS-Roformer uses its own automatic SDPA/chunk adapter, not Diffusers tuning switches.")
    if args.device not in {None, "cpu"}:
        raise ValueError("The separator worker supports automatic device selection or explicit CPU.")
    if args.input is None or not args.input.is_file() or not (args.model_root / "BS-Roformer-SW.ckpt").is_file():
        raise ValueError("BS-Roformer requires --input and the local BS-Roformer-SW.ckpt in --model-root.")
    report = {"model": args.model, "input": str(args.input.resolve()), "runs": [],
              "subjectiveAudioQuality": "not_asserted", "contention": "not_measured"}
    path = args.output_dir / "report.json"
    source = sf.info(args.input)
    save(path, report)
    try:
        for index in range(args.repeats):
            destination = (args.output_dir / f"run-{index}").resolve()
            command = [sys.executable, str(Path(__file__).with_name("stem_separator.py")),
                "--input", str(args.input.resolve()), "--output-dir", str(destination),
                "--models-dir", str(args.model_root), "--acceleration-mode", "cpu-only" if args.device == "cpu" else "auto"]
            start = time.perf_counter()
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            (args.output_dir / f"separation-{index}.log").write_text(result.stdout + result.stderr, encoding="utf-8")
            events = []
            for line in result.stdout.splitlines():
                try:
                    event = json.loads(line)
                    if isinstance(event, dict) and "state" in event:
                        events.append(event)
                except json.JSONDecodeError:
                    pass
            completed = next((event for event in reversed(events) if event.get("state") == "done"), {})
            execution = next((event["executionDetails"] for event in reversed(events) if "executionDetails" in event), {})
            outputs = {}
            for name, filename in completed.get("stems", {}).items():
                audio, rate = sf.read(filename, always_2d=True)
                valid = bool(audio.size and np.isfinite(audio).all() and audio.shape[1] == 2
                             and abs(len(audio)/rate - source.duration) < .05)
                outputs[name] = {"status": "pass" if valid else "fail", "duration": len(audio)/rate, "path": filename}
            valid = result.returncode == 0 and bool(outputs) and all(x["status"] == "pass" for x in outputs.values())
            report["runs"].append({"index": index, "warm": False, "workerReuse": "one-shot separator",
                "seconds": time.perf_counter()-start, "execution": execution, "stems": outputs,
                "status": "pass" if valid else "fail", "exitCode": result.returncode})
            save(path, report)
            if not valid:
                report["status"] = "fail"
                return 1
        report["status"] = "pass"
        return 0
    finally:
        save(path, report)

def main():
    args = parser().parse_args()
    if args.minimax_capacity_only and (args.model != "minimax-music-3" or args.probe):
        raise SystemExit("Capacity-only EOS suppression requires MiniMax generation.")
    if (args.repeats < 1 or args.repeats > 20 or not math.isfinite(args.timeout) or args.timeout <= 0
            or not math.isfinite(args.duration) or args.duration <= 0 or args.min_available_ram_mb < 256):
        raise SystemExit("Use 1-20 repeats, positive finite duration/timeout, and a RAM floor of at least 256 MiB.")
    if args.compile and (args.placement != "resident" or args.quantization != "none"):
        raise SystemExit("Compilation evaluation currently requires unquantized resident placement.")
    if args.int8_reserve_gib != 3 and (args.model != "minimax-music-3" or args.quantization != "int8" or args.placement != "model-offload"):
        raise SystemExit("Reduced reserves are MiniMax INT8 stage candidates only.")
    if not args.probe and (not args.model or not args.model_root or not args.model_root.is_dir()):
        raise SystemExit("Generation requires --model and a local --model-root directory.")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if not args.child:
        with (args.output_dir / "worker.log").open("w", encoding="utf-8") as log:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--child"],
                stdout=log, stderr=subprocess.STDOUT,
                start_new_session=os.name != "nt",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
            try:
                code = wait_bounded(child, args)
                path = args.output_dir / "report.json"
                report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
                if code != 0 and report.get("status") not in {"fail", "timeout", "cancelled"}:
                    report.update(status="crashed", exitCode=code)
                    save(path, report)
                return code
            except (subprocess.TimeoutExpired, KeyboardInterrupt, MemoryError) as exc:
                # Windows venv python.exe is a launcher with a Python child.
                # Killing only the launcher leaves model inference running.
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                        stdout=log, stderr=subprocess.STDOUT,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=15)
                else:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=15)
                path = args.output_dir / "report.json"
                report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
                report.update(status="cancelled" if isinstance(exc, KeyboardInterrupt) else
                              "resource_limit" if isinstance(exc, MemoryError) else "timeout",
                              timeoutSeconds=args.timeout)
                save(path, report)
                return 2
            finally:
                from ai_disk_store import cleanup_stale_stores
                cleanup_stale_stores()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
