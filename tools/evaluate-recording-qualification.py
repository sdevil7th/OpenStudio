#!/usr/bin/env python3
"""Evaluate before/after native diagnostics and a captured PCM WAV without claiming listening quality."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import wave

COUNTERS = ("recordingWriteLockMissCount", "recordingWriterBufferOverflowCount", "audioDeviceXRunCount",
            "audioDeviceStopCount", "audioDeviceErrorCount", "audioCallbackArrivalGapCount")


def evaluate(before: dict, after: dict, audio: Path, seconds: float) -> dict:
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("Capture duration must be a positive finite number")
    checks = []
    for counter in COUNTERS:
        start, end = before.get(counter), after.get(counter)
        known = all(isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) and value >= 0 for value in (start, end))
        delta = end - start if known else None
        checks.append({"id": counter, "status": "not_asserted" if not known else "pass" if delta == 0 else "fail",
                       "delta": delta, "detail": "unsupported/missing" if not known else "counter reset" if delta < 0 else "measured"})
    with wave.open(str(audio), "rb") as recording:
        frames, rate, channels = recording.getnframes(), recording.getframerate(), recording.getnchannels()
        duration = frames / rate
        # Read every byte to detect truncated payloads, with bounded memory.
        frame_bytes = channels * recording.getsampwidth()
        bytes_read = 0
        digest = hashlib.sha256()
        while block := recording.readframes(65536):
            bytes_read += len(block)
            digest.update(block)
    checks.append({"id": "wav_payload", "status": "pass" if frames > 0 and bytes_read == frames * frame_bytes else "fail"})
    checks.append({"id": "capture_duration", "status": "pass" if abs(duration - seconds) <= 0.25 else "fail",
                   "expectedSeconds": seconds, "actualSeconds": duration})
    checks.append({"id": "device_sample_rate", "status": "not_asserted" if after.get("sampleRate") is None
                   else "pass" if before.get("sampleRate") == after.get("sampleRate") == rate else "fail"})
    status = "fail" if any(c["status"] == "fail" for c in checks) else "not_asserted" if any(c["status"] == "not_asserted" for c in checks) else "pass"
    return {"schemaVersion": 1, "status": status, "checks": checks,
            "capture": {"path": str(audio), "frames": frames, "sampleRate": rate, "channels": channels, "pcmSha256": digest.hexdigest()},
            "clockDrift": "not_asserted", "microphoneIdentity": "not_asserted", "permissionRecovery": "not_asserted",
            "audibleQuality": "not_asserted", "waveformInspection": "diagnostic_only"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = evaluate(json.loads(args.before.read_text(encoding="utf-8")),
                          json.loads(args.after.read_text(encoding="utf-8")), args.audio, args.seconds)
    except (OSError, ValueError, wave.Error, EOFError) as error:
        report = {"schemaVersion": 1, "status": "fail", "error": str(error)}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Recording qualification: {report['status']} ({args.report})")
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
