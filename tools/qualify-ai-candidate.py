"""Publish a local MiniMax INT8 calibration after explicit sample audition.

Run with the staged interpreter. This does not install packages or qualify
other hardware, request ranges, attention kernels, or quantization recipes.
"""
from __future__ import annotations

import argparse
import hashlib
from importlib import metadata
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace

from ai_execution_policy import GIB, MINIMAX_ALLOCATOR, MINIMAX_PROMPT_MEASUREMENT, minimax_kv_bytes, model_storage_identity, minimax_prompt_tokens, worker_version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--functional-report", type=Path,
                        help="Required normal cold/warm generation evidence when --report is capacity-only.")
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--audition-artifact", type=Path, required=True)
    parser.add_argument("--audition-accepted", action="store_true", required=True,
                        help="Only pass after the user explicitly accepted this exact artifact.")
    args = parser.parse_args()
    candidate = json.loads(args.candidate_manifest.read_text(encoding="utf-8"))
    report = json.loads(args.report.read_text(encoding="utf-8-sig"))
    packages = {name: metadata.version(name) for name in
                ("torch", "diffusers", "transformers", "accelerate", "bitsandbytes")}
    generation_mode = report.get("generationMode", "normal")
    if generation_mode not in {"normal", "eos-suppressed-capacity-only"}:
        raise ValueError("Unknown generation evidence mode.")
    functional = None
    if generation_mode != "normal":
        if args.functional_report is None:
            raise ValueError("Capacity-only evidence requires separate normal cold/warm generation evidence.")
        functional = json.loads(args.functional_report.read_text(encoding="utf-8-sig"))
        if (functional.get("generationMode", "normal") != "normal" or functional.get("status") != "pass"
                or len(functional.get("runs", [])) < 2
                or any(functional.get(key) != report.get(key) for key in
                       ("workerVersion", "modelStorageIdentity", "policy",
                        "allocatorConfig", "allocatorBackend"))
                or any(functional.get("hardware", {}).get(key) != report.get("hardware", {}).get(key)
                       for key in ("os", "architecture", "torch", "cuda", "hip", "packages"))
                or any(functional.get("selectedDevice", {}).get(key) != report.get("selectedDevice", {}).get(key)
                       for key in ("device", "family", "name", "total_bytes"))
                or [(item.get("uuid"), item.get("driver_version")) for item in functional.get("linkBeforeLoad", {}).get("devices", [])]
                   != [(item.get("uuid"), item.get("driver_version")) for item in report.get("linkBeforeLoad", {}).get("devices", [])]
                or any(run.get("status") != "pass" or run.get("index") != index
                       or run.get("warm") is not (index > 0)
                       or not math.isfinite(run.get("generatedSeconds", 0)) or run.get("generatedSeconds", 0) <= 0
                       for index, run in enumerate(functional["runs"]))):
            raise ValueError("Normal functional evidence does not match capacity evidence.")
    if (candidate["recipe"] != {"package": "bitsandbytes", "version": "0.50.2"}
            or candidate["state"] != "import_only"
            or Path(candidate["python"]).resolve() != Path(sys.executable).resolve()
            or any(packages[name] != version for name, version in candidate["baseline"]["packages"].items())
            or packages["bitsandbytes"] != "0.50.2"):
        raise ValueError("Candidate does not match the staged interpreter and pinned base stack.")
    environment = Path(sys.executable).resolve().parent.parent
    if environment.parent != args.candidate_manifest.resolve().parent:
        raise ValueError("Candidate environment must remain inside its staging root.")
    wheel = environment / "wheels" / candidate["wheel"]
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != candidate["sha256"]:
        raise ValueError("Staged wheel provenance changed.")
    if (report.get("status") != "pass" or len(report["runs"]) < 2
            or report.get("allocatorConfig") != MINIMAX_ALLOCATOR or report.get("allocatorBackend") != "native"
            or report.get("modelStorageIdentity") != model_storage_identity(args.model_root)
            or report["workerVersion"] != worker_version(Path(__file__).with_name("stable_audio3_generate.py"))
            or report["policy"] != {"attention": "native", "placement": "model-offload", "quantization": "int8", "compile": False}
            or report["hardware"]["os"] != "Windows" or report["selectedDevice"]["family"] != "cuda"
            or report["hardware"]["torch"] != packages["torch"]
            or any(report["hardware"]["packages"][name] != packages[name]
                   for name in ("diffusers", "transformers", "accelerate"))
            or any(run["status"] != "pass" or run.get("index") != index
                   or run.get("warm") is not (index > 0)
                   or not math.isfinite(run["generatedSeconds"]) or run["generatedSeconds"] <= 0
                   for index, run in enumerate(report["runs"]))):
        raise ValueError("Report does not establish matching first/warm INT8 CUDA forwards.")
    import stable_audio3_generate as worker
    previous_model = worker.MODEL_ID
    try:
        worker.MODEL_ID = "minimax-music-3"
        request, _ = worker.build_generation_request(report["request"]["workflow"], report["request"]["params"])
    finally:
        worker.MODEL_ID = previous_model
    prompt_tokens = minimax_prompt_tokens(args.model_root, request["prompt"], request["lyrics"])
    if (report["initialExecution"].get("promptMeasurement") != MINIMAX_PROMPT_MEASUREMENT
            or report["initialExecution"].get("promptTokens") != prompt_tokens):
        raise ValueError("Report does not establish the actual prompt token count.")
    config = json.loads((args.model_root / "language_model/config.json").read_text(encoding="utf-8"))
    kv_config = {key: config[key] for key in ("num_hidden_layers", "num_key_value_heads", "head_dim")}
    kv_bytes = minimax_kv_bytes(SimpleNamespace(**kv_config), duration=request["duration"],
                               prompt_tokens=prompt_tokens, element_size=2)
    generated = min(run["generatedSeconds"] for run in report["runs"])
    if generation_mode != "normal":
        if any(run["generatedSeconds"] < request["duration"] - .05
               or run.get("capacityEvidence", {}).get("mode") != generation_mode
               or run.get("capacityEvidence", {}).get("semanticCalls", 0) != int(request["duration"] * 25) + 1
               for run in report["runs"]):
            raise ValueError("Capacity evidence did not exercise every requested frame.")
        for run in report["runs"]:
            lifetime = run.get("outputLifetime", {})
            if not lifetime.get("device"):
                raise ValueError("Capacity evidence does not establish waveform placement.")
            if lifetime["device"].startswith("cuda") and (lifetime.get("outputBytes", 0) <= 0
                    or lifetime.get("allocatedBeforeRelease", 0) - lifetime.get("allocatedAfterRelease", 0)
                       < lifetime["outputBytes"]):
                raise ValueError("Capacity evidence did not release the previous GPU waveform.")
    max_duration = request["duration"] if generated >= request["duration"] - .05 else int(generated)
    matches = [item for item in report["linkBeforeLoad"]["devices"]
               if item["name"] == report["selectedDevice"]["name"]]
    if len(matches) != 1 or max_duration < 5:
        raise ValueError("The physical GPU or tested output duration is ambiguous.")
    initial = report["initialExecution"]
    reserve = initial.get("deviceReserveBytes", 3*GIB)
    if reserve not in {3*GIB//2, 2*GIB, 3*GIB}:
        raise ValueError("Report has no qualified device reserve.")
    artifact = args.audition_artifact.resolve(strict=True)
    profile = {"schemaVersion": 1, "state": "qualified-local", "policy": "minimax-int8-stage-v1",
        "modelId": "minimax-music-3", "environment": environment.name, "packages": packages,
        "scriptVersion": worker_version(Path(__file__).with_name("stable_audio3_generate.py")),
        "modelStorageIdentity": model_storage_identity(args.model_root),
        "hardware": {"uuid": matches[0]["uuid"], "driver": matches[0]["driver_version"]},
        "kvConfig": kv_config, "stageWeightBytes": initial["requiredDeviceBytes"] - kv_bytes - reserve,
        "deviceReserveBytes": reserve,
        "allocatorConfig": report["allocatorConfig"],
        "minimumFreeHostBytes": initial["weightsBytes"] + 3*GIB,
        "maxDuration": max_duration, "maxPromptTokens": prompt_tokens,
        "promptMeasurement": MINIMAX_PROMPT_MEASUREMENT,
        "audition": {"status": "accepted", "artifact": str(artifact),
                     "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()},
        "evidence": {"report": str(args.report.resolve()), "workerVersion": report["workerVersion"],
                     "generationMode": generation_mode,
                     "functionalReport": str(args.functional_report.resolve()) if functional is not None else None,
                     "scope": "Local functional/capacity tests; acceptance applies to the named audition artifact."}}
    destination = environment.parent / "minimax-int8-qualified.json"
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(profile, indent=2), encoding="utf-8")
    temporary.replace(destination)
    print(json.dumps(profile, indent=2))


if __name__ == "__main__":
    main()
