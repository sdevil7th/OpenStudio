#!/usr/bin/env python3
"""Headless real-model matrix. No app windows, model downloads, or quality claims.

Run with the intended runtime's Python. A long input (>30 seconds) is needed
to exercise actual section splitting. Logs and a machine-readable report stay
in --output-dir. Inference is sequential so cases do not compete for memory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def source_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def worker_dependency_hashes(script):
    root = Path(script).resolve().parent
    names = [Path(script).name, "ai_runtime_probe.py", "ai_execution_policy.py", "ai_memory_manager.py",
             "ai_system_memory.py", "ai_telemetry.py", "ai_attention_policy.py", "stem_chunking.py", "stem_streaming.py", "stem_acceleration.py",
             "windows-ai-acceleration-manifest.json"]
    manifest = root/"ai-worker-modules.json"
    if manifest.is_file():
        names += [manifest.name, *json.loads(manifest.read_text())["modules"]]
    return {name: source_hash(root / name) for name in dict.fromkeys(names) if (root / name).is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--worker-script", default=str(Path(__file__).with_name("stem_separator.py")),
                        help="Worker from repository tools or a built app's scripts directory")
    parser.add_argument("--memory-mode", choices=["automatic", "streaming-preview"], default="automatic")
    parser.add_argument("--precision", choices=["default", "fp32", "fp16", "bf16"], default="default")
    parser.add_argument("--performance-mode", choices=["standard", "qualified-fast"], default="standard")
    parser.add_argument("--qualification-host-memory-mb", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--expected-auto-backend", required=True, choices=["cpu", "cuda", "rocm", "directml", "mps", "coreml"])
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--modes", nargs="+", choices=["auto", "cpu-only"], default=["auto", "cpu-only"])
    parser.add_argument("--sections", nargs="+", type=int, choices=[0, 30], default=[0, 30])
    args = parser.parse_args()
    import numpy as np
    import soundfile as sf
    root = Path(args.output_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    source = sf.info(args.input)
    report = {"input": str(Path(args.input).resolve()), "source": str(source),
              "sourceSha256": source_hash(args.input),
              "subjectiveAudioQuality": "not_asserted", "modelOffload": "unsupported_by_engine",
              "cases": []}
    for mode in args.modes:
        for chunk in args.sections:
            name = f"{mode}-sections-{chunk}"
            out = root / name
            out.mkdir(exist_ok=True)
            command = [sys.executable, "-u", "-X", "faulthandler", str(Path(args.worker_script).resolve()),
                       "--input", str(Path(args.input).resolve()), "--models-dir", str(Path(args.models_dir).resolve()),
                       "--output-dir", str(out), "--acceleration-mode", mode, "--chunk-duration", str(chunk)]
            command += ["--qualification-telemetry", "--memory-mode", args.memory_mode]
            command += ["--precision", args.precision]
            command += ["--performance-mode", args.performance_mode]
            if args.qualification_host_memory_mb:
                command += ["--qualification-host-memory-mb", str(args.qualification_host_memory_mb)]
            started = time.monotonic()
            case = {"name": name, "expectedBackend": "cpu" if mode == "cpu-only" else args.expected_auto_backend,
                    "actualSectionSplitting": chunk > 0 and source.duration > chunk, "status": "fail"}
            case["workerSha256"] = hashlib.sha256(Path(args.worker_script).read_bytes()).hexdigest()
            case["qualificationHostMemoryLimitMB"] = args.qualification_host_memory_mb
            case["workerDependenciesSha256"] = worker_dependency_hashes(args.worker_script)
            log = root / f"{name}.log"
            try:
                with log.open("wb") as output:
                    process = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, timeout=args.timeout)
                case["exitCode"] = process.returncode
                assert hashlib.sha256(Path(args.worker_script).read_bytes()).hexdigest() == case["workerSha256"], "worker changed during qualification"
                assert worker_dependency_hashes(args.worker_script) == case["workerDependenciesSha256"], "worker dependency changed during qualification"
                messages = []
                for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
                    try:
                        message = json.loads(line)
                        if isinstance(message, dict):
                            messages.append(message)
                    except ValueError:
                        pass
                terminal = messages[-1] if messages else {}
                skipped_silence = any(message.get("inference") == "skipped_digital_silence" for message in messages)
                case["inference"] = "skipped_digital_silence" if skipped_silence else "executed"
                case["terminal"] = terminal
                case["executionDetails"] = next((m["executionDetails"] for m in messages if "executionDetails" in m), {})
                case["runtimeVersions"] = next((m["versions"] for m in messages if "versions" in m), {})
                effective_chunk = terminal.get("memoryPlan", {}).get("chunk_duration", chunk)
                case["effectiveSectionSeconds"] = effective_chunk
                case["actualSectionSplitting"] = effective_chunk > 0 and source.duration > effective_chunk
                assert process.returncode == 0 and terminal.get("state") == "done", "worker did not complete"
                assert terminal.get("backend") == case["expectedBackend"], "unexpected execution backend"
                receipt = terminal.get("deviceReceipt", {})
                devices = receipt.get("parameterBytesByDevice", {})
                assert devices and sum(devices.values()) > 0, "model tensor placement was not observed"
                if case["expectedBackend"] in {"cuda", "rocm"}:
                    assert all(device.startswith("cuda:") for device in devices), "model parameters are not all on the GPU"
                    assert receipt.get("cudaPeakAllocatedBytes", 0) > 0, "no GPU memory allocation observed"
                    if not skipped_silence:
                        assert receipt["cudaPeakAllocatedBytes"] > terminal.get("gpuResidentBaselineBytes", receipt["cudaPeakAllocatedBytes"]), "no GPU activation allocation during inference"
                    if case["expectedBackend"] == "cuda":
                        assert receipt.get("torchCudaVersion") and not receipt.get("torchHipVersion"), "not an NVIDIA CUDA build"
                elif case["expectedBackend"] == "cpu":
                    assert set(devices) == {"cpu"}, "CPU-only mode placed weights on an accelerator"
                stems = terminal.get("stems", {})
                assert set(stems) == {"Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"}, "missing stems"
                files = []
                for stem, filename in stems.items():
                    with sf.SoundFile(filename) as audio:
                        rate = audio.samplerate
                        assert rate == 44100 and audio.channels == 2 and len(audio) > 0
                        assert abs(len(audio) / rate - source.duration) <= 2 / rate, "duration mismatch"
                        for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
                            assert np.isfinite(block).all(), "nonfinite output"
                        files.append({"stem": stem, "frames": len(audio), "rate": rate, "channels": audio.channels})
                case["files"] = files
                case["status"] = "pass"
            except (AssertionError, OSError, subprocess.TimeoutExpired) as exc:
                case["error"] = str(exc)
            case["elapsedSeconds"] = round(time.monotonic() - started, 3)
            report["cases"].append(case)
            (root / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(name, case["status"], case.get("error", ""), flush=True)
    return 0 if all(case["status"] == "pass" for case in report["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
