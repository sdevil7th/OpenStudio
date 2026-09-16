"""Opt-in local-weight integration check. Never plays audio or installs models."""
import argparse
import json
from pathlib import Path
import time

import numpy as np
import soundfile as sf
import torch
import stable_audio3_generate as worker_module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    worker = worker_module.StableAudioWorker(args.model_root.resolve())
    events = []
    worker_module.emit_payload = events.append
    results = []
    source = args.output_dir / "text-to-audio.wav"
    source_params = {"source": {"filePath": str(source.resolve()), "clipOffset": 0,
        "clipDuration": 4, "sourceClipId": "smoke-source"}}
    cases = [
        ("text-to-audio", {"prompt": "A solo clean electric bass playing a steady rhythmic riff, dry studio recording.", "duration": 4}),
        ("variation", {**source_params, "prompt": "A close variation of the same solo bass riff.", "noise_amount": .4}),
        ("inpaint-selection", {**source_params, "prompt": "The same solo bass riff, matching the surrounding notes.", "inpaint_start": 1, "inpaint_end": 2}),
        ("continue-clip", {**source_params, "prompt": "Continue the same solo bass riff.", "extension_duration": 2}),
    ]
    for workflow, params in cases:
        start = time.monotonic()
        output = args.output_dir / f"{workflow}.wav"
        success = worker.generate(workflow, json.dumps({**params, "seed": 123, "steps": 8}), output, f"smoke-{workflow}")
        result = {"workflow": workflow, "status": "pass" if success else "fail", "seconds": time.monotonic() - start}
        if success:
            audio, rate = sf.read(output, always_2d=True, dtype="float32")
            result.update(sampleRate=rate, frames=len(audio), channels=audio.shape[1], peak=float(np.abs(audio).max()), finite=bool(np.isfinite(audio).all()))
            if workflow == "inpaint-selection":
                original, _ = sf.read(source, always_2d=True, dtype="float32")
                result["untouchedPcmExact"] = bool(np.array_equal(audio[:rate], original[:rate]) and np.array_equal(audio[2*rate:], original[2*rate:]))
                if not result["untouchedPcmExact"]: result["status"] = "fail"
        else:
            result["error"] = next((event.get("error") for event in reversed(events) if event.get("state") == "error"), "Unknown failure")
        results.append(result)
        print(json.dumps(result), flush=True)
        if not success: break
    report = {"results": results, "subjective_audio_quality": "not_asserted", "events": events}
    (args.output_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if len(results) == len(cases) and all(row["status"] == "pass" for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
