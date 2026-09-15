"""Headless qualification of the real persistent worker protocol and cancellation."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["minimax-music-3", "stable-audio-3-medium"], required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--request", type=Path, action="append", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--expect-quantization", choices=["none", "int8"])
    parser.add_argument("--expect-rejection", help="Expected error text; assert rejection before inference/output.")
    parser.add_argument("--cancel-request", type=Path,
                        help="Optional different request for active cancellation, e.g. a larger warm-reload boundary.")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    if args.expect_rejection and (args.expect_quantization or args.cancel_request or len(args.request) != 1):
        parser.error("Rejection checks take one request and no expected quantization")
    import numpy as np
    import soundfile as sf
    from ai_execution_policy import host_available, GIB, worker_version
    from stable_audio3_generate import read_framed_json, write_framed_json
    destination = args.output_dir.resolve()
    if destination.is_dir() and any(destination.iterdir()):
        parser.error("Use a fresh output directory so stale artifacts cannot pass verification")
    destination.mkdir(parents=True, exist_ok=True)
    report = {"status": "running", "runs": [], "audioQuality": "not_asserted"}
    def save_report():
        (destination / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    save_report()
    script = Path(__file__).with_name("stable_audio3_generate.py").resolve()
    messages = queue.Queue()
    deadline = time.monotonic() + args.timeout
    low_since = None
    with (destination / "stderr.log").open("w", encoding="utf-8") as errors, (
            destination / "events.jsonl").open("w", encoding="utf-8") as events:
        process = subprocess.Popen([sys.executable, str(script), "--worker", "--model-id", args.model,
            "--model-root", str(args.model_root.resolve())], stdout=subprocess.PIPE, stderr=errors,
            text=True, encoding="utf-8", errors="replace", start_new_session=os.name != "nt",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
        def read_output():
            for line in process.stdout:
                events.write(line)
                events.flush()
                try:
                    value = json.loads(line)
                    if isinstance(value, dict):
                        messages.put(value)
                except json.JSONDecodeError:
                    pass
        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        def next_event():
            nonlocal low_since
            while time.monotonic() < deadline:
                available = host_available()
                low_since = (low_since or time.monotonic()) if available is not None and available < 2*GIB else None
                if low_since is not None and time.monotonic() - low_since >= 2:
                    raise MemoryError("Worker check reached its host RAM reserve.")
                try:
                    return messages.get(timeout=.5)
                except queue.Empty:
                    if process.poll() is not None:
                        raise RuntimeError(f"Worker exited unexpectedly ({process.returncode}).")
            raise TimeoutError("Worker protocol check timed out.")
        def send(port, request, output, request_id, model=None):
            with socket.create_connection(("127.0.0.1", port), timeout=10) as connection:
                write_framed_json(connection, {"modelId": model or args.model,
                    "requestId": request_id, "workflow": request["workflow"],
                    "params": json.dumps(request["params"]), "output": str(output)})
                return read_framed_json(connection)
        try:
            ready = next_event()
            while ready.get("event") != "ready":
                ready = next_event()
            if ready["scriptVersion"] != worker_version(script) or ready["modelId"] != args.model:
                raise ValueError("Worker identity did not match the requested implementation/model.")
            report["worker"] = ready
            requests = [json.loads(path.read_text(encoding="utf-8-sig")) for path in args.request]
            if send(ready["port"], requests[0], destination / "wrong-model.wav", "wrong-model", "wrong-model")["accepted"]:
                raise ValueError("Worker accepted another model's request.")
            report["wrongModelRejected"] = True
            for index, request in enumerate(requests):
                output = destination / f"run-{index}.wav"
                request_id = f"protocol-{index}"
                started = time.perf_counter()
                selection_event = None
                if not send(ready["port"], request, output, request_id)["accepted"]:
                    raise ValueError("Worker rejected a valid request.")
                while True:
                    event = next_event()
                    if event.get("requestId") != request_id:
                        continue
                    if args.expect_quantization:
                        execution = event.get("generationDetails", {}).get("execution", {})
                        selected = execution.get("quantization")
                        if selected is not None and selected != args.expect_quantization:
                            raise ValueError("Worker selected the wrong precision before completion.")
                        if (args.expect_quantization == "int8" and event.get("phase") == "loading_model"
                                and "INT8 language model" in event.get("statusNote", "")):
                            selection_event = event
                    if args.expect_rejection and event.get("phase") in {"generating_tokens", "denoising", "decoding_audio"}:
                        raise ValueError("Expected preflight rejection, but inference started.")
                    if event.get("state") == "error":
                        if args.expect_rejection and args.expect_rejection in event.get("error", ""):
                            report["rejectionEvent"] = event
                            report["rejectionSeconds"] = time.perf_counter() - started
                            break
                        raise RuntimeError(event.get("error"))
                    if event.get("state") == "done":
                        if args.expect_rejection:
                            raise ValueError("Expected rejection, but generation completed.")
                        break
                if args.expect_rejection:
                    if output.exists():
                        raise ValueError("Rejected request published output.")
                    report.update(status="pass", rejectedBeforeInference=True)
                    continue
                audio, rate = sf.read(output, always_2d=True)
                if not audio.size or audio.shape[1] != 2 or not np.isfinite(audio).all():
                    raise ValueError("Worker returned invalid stereo audio.")
                details = event.get("generationDetails", {})
                if (args.expect_quantization is not None
                        and details.get("execution", {}).get("quantization") != args.expect_quantization):
                    raise ValueError("Worker did not select the expected quantization policy.")
                requested_seed = request["params"].get("seed", -1)
                if requested_seed >= 0 and details.get("resolvedSeed") != requested_seed:
                    raise ValueError("Worker changed the requested seed.")
                if args.model == "minimax-music-3" and event.get("effectiveSteps") != request["params"].get("steps", 30):
                    raise ValueError("Worker changed the requested MiniMax step count.")
                if index == 0 and args.expect_quantization == "int8" and selection_event is None:
                    raise ValueError("Cold worker did not expose INT8 selection before inference.")
                report["runs"].append({"workflow": request["workflow"], "seconds": time.perf_counter()-started,
                    "generatedSeconds": len(audio)/rate, "generationDetails": event.get("generationDetails"),
                    "effectiveSteps": event.get("effectiveSteps"), "selectionEvent": selection_event,
                    "workerPid": ready["pid"], "output": str(output)})
                save_report()
            if not args.expect_rejection:
                cancelled = destination / "cancelled.wav"
                cancellation_request = (json.loads(args.cancel_request.read_text(encoding="utf-8-sig"))
                                        if args.cancel_request else requests[0])
                report["cancellationRequest"] = cancellation_request
                if not send(ready["port"], cancellation_request, cancelled, "cancel-check")["accepted"]:
                    raise ValueError("Worker rejected the cancellation fixture.")
                cancel_execution = None
                while True:
                    event = next_event()
                    if event.get("requestId") == "cancel-check":
                        execution = event.get("generationDetails", {}).get("execution", {})
                        if execution:
                            cancel_execution = execution
                            if args.expect_quantization and execution.get("quantization") != args.expect_quantization:
                                raise ValueError("Cancellation request selected the wrong precision.")
                        advanced = (bool(re.search(r"Composing audio: [1-9][0-9]* of", event.get("message", "")))
                                    if args.model == "minimax-music-3" else event.get("phaseProgress", 0) > 0)
                        if advanced and event.get("phase") in {"generating_tokens", "denoising"}:
                            if args.expect_quantization and cancel_execution is None:
                                raise ValueError("Cancellation request did not expose its execution policy.")
                            report["cancellationEvent"] = event
                            report["cancellationExecution"] = cancel_execution
                            break
                    if event.get("requestId") == "cancel-check" and event.get("state") in {"done", "error"}:
                        raise ValueError("Cancellation fixture did not reach an active inference phase.")
                report.update(status="pass", cancellation="active worker will be terminated before publication")
        except Exception as exc:
            report.update(status="fail", error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=errors,
                        stderr=errors, check=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    import signal
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=15)
            reader.join(timeout=5)
            process.stdout.close()
            report["workerStopped"] = process.poll() is not None
            report["cancelledOutputAbsent"] = not (destination / "cancelled.wav").exists()
            report["wrongModelOutputAbsent"] = not (destination / "wrong-model.wav").exists()
            if not report["cancelledOutputAbsent"] or not report["wrongModelOutputAbsent"]:
                report["status"] = "fail"
            save_report()
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
