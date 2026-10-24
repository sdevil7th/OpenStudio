#!/usr/bin/env python3
"""Pair archived/current NAM fuzz audition WAVs without loudness normalization.

Clean50 legacy examples are explicitly reconstructed from frozen native wet and
octave-only endpoints using the original linear parallel blend law. No retired
DSP is included in production and no baseline file is modified.
"""
from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import sys


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_float_wave(path: Path) -> tuple[int, int, array.array]:
    raw = path.read_bytes()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError(f"Expected RIFF WAVE: {path}")
    position, fmt, payload = 12, None, None
    while position + 8 <= len(raw):
        name, count = struct.unpack_from("<4sI", raw, position)
        position += 8
        chunk = raw[position:position + count]
        if len(chunk) != count:
            raise ValueError(f"Truncated WAVE chunk: {path}")
        if name == b"fmt ":
            fmt = chunk
        elif name == b"data":
            payload = chunk
        position += count + count % 2
    if fmt is None or payload is None or len(fmt) < 16:
        raise ValueError(f"Missing audio chunks: {path}")
    code, channels, rate, _, alignment, bits = struct.unpack_from("<HHIIHH", fmt)
    if code == 0xFFFE and len(fmt) >= 40:
        code = struct.unpack_from("<H", fmt, 24)[0]
    if code != 3 or bits != 32 or alignment != channels * 4 or len(payload) % alignment:
        raise ValueError(f"Expected native IEEE float32 output: {path}")
    values = array.array("f")
    values.frombytes(payload)
    if sys.byteorder != "little":
        values.byteswap()
    if not values or not all(math.isfinite(value) for value in values):
        raise ValueError(f"Empty/nonfinite audio: {path}")
    return rate, channels, values


def write_float_wave(path: Path, rate: int, channels: int, values: array.array) -> None:
    encoded = array.array("f", values)
    if sys.byteorder != "little":
        encoded.byteswap()
    payload = encoded.tobytes()
    fmt = struct.pack("<HHIIHH", 3, channels, rate, rate * channels * 4, channels * 4, 32)
    fact = struct.pack("<I", len(values) // channels)
    body = b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt + b"fact" + struct.pack("<I", 4) + fact + b"data" + struct.pack("<I", len(payload)) + payload
    with path.open("xb") as stream:
        stream.write(b"RIFF" + struct.pack("<I", len(body)) + body)


def measurements(path: Path) -> dict:
    rate, channels, values = read_float_wave(path)
    return {"sha256": sha256(path), "sampleRate": rate, "channels": channels,
            "frames": len(values) // channels, "samplePeak": max(abs(value) for value in values),
            "rms": math.sqrt(sum(value * value for value in values) / len(values)),
            "samplesAboveUnity": sum(abs(value) > 1 for value in values)}


def same_controls(before: dict, after: dict, *, legacy_clean: bool = False) -> None:
    for key in ("direct", "down", "up", "bassProfile", "seconds"):
        if before[key] != after[key]:
            raise ValueError(f"Different comparison {key}: {after['file']}")
    for key, value in before["fuzz"].items():
        expected = 0.5 if legacy_clean and key == "cleanMix" else value
        if after["fuzz"][key] != expected:
            raise ValueError(f"Different fuzz {key}: {after['file']}")
    if before["source"].get("sha256") != after["source"].get("sha256"):
        raise ValueError(f"Different input source: {after['file']}")
    if (before["source"].get("renderedInputSha256") is not None
            and before["source"]["renderedInputSha256"] != after["source"].get("renderedInputSha256")):
        raise ValueError(f"Different processed input samples: {after['file']}")


def same_full_chain(before: dict, after: dict) -> None:
    for key in ("direct", "down", "up", "bassProfile", "seconds", "stageMask", "setting", "fuzzVoice", "rackState"):
        if before[key] != after[key]:
            raise ValueError(f"Different full-chain {key}: {after['file']}")
    if before["source"] != after["source"]:
        raise ValueError(f"Different full-chain input: {after['file']}")
    for key in ("ampSha256", "cabSha256", "ampIncludesCab"):
        if before["resources"][key] != after["resources"][key]:
            raise ValueError(f"Different full-chain resource {key}: {after['file']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=Path("output/nam-fuzz-refinement/baseline/audition/manifest.json"))
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expect-vintage-only", action="store_true",
                        help="Require every Bass/Sustain/Gated output to remain byte-identical for a Guitar/Vintage-only change")
    args = parser.parse_args()
    before_path, after_path = args.baseline.resolve(), args.after.resolve()
    baseline, current = json.loads(before_path.read_text(encoding="utf-8-sig")), json.loads(after_path.read_text(encoding="utf-8-sig"))
    baseline_rows = baseline["listening"] + baseline.get("fullChainListening", [])
    current_rows = current["listening"] + current.get("fullChainListening", [])
    for row in baseline_rows + current_rows:
        if Path(row["file"]).name != row["file"] or not row["file"].endswith(".wav"):
            raise ValueError("Expected a local WAV basename in the audit manifest")
    before_rows = {row["file"]: row for row in baseline_rows}
    if len(before_rows) != len(baseline_rows):
        raise ValueError("Duplicate baseline file entries")
    current_names = {row["file"] for row in current_rows}
    if len(current_names) != len(current_rows):
        raise ValueError("Duplicate current file entries")
    missing = set(before_rows) - current_names
    if missing:
        raise ValueError(f"Missing baseline comparison files: {', '.join(sorted(missing))}")
    baseline_full_chain = {row["file"] for row in baseline.get("fullChainListening", [])}
    current_full_chain = {row["file"] for row in current.get("fullChainListening", [])}
    if baseline_full_chain != current_full_chain:
        raise ValueError("Full-chain before/after coverage differs; capture both builds with the same resources")
    baseline_pedal = {row["file"] for row in baseline["listening"]}
    for filename in current_names - set(before_rows):
        if (filename in current_full_chain or "-combined-clean50-" not in filename
                or filename.replace("-combined-clean50-", "-combined-") not in baseline_pedal):
            raise ValueError(f"Unsupported additional comparison file: {filename}")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output / "before").mkdir()
    (output / "after").mkdir()
    comparisons = []
    for after in current_rows:
        filename = after["file"]
        after_file = after_path.parent / filename
        before_file = output / "before" / filename
        full_chain = "stageMask" in after
        derived = "-combined-clean50-" in filename and filename not in before_rows
        if derived:
            wet_name = filename.replace("-combined-clean50-", "-combined-")
            before = before_rows[wet_name]
            same_controls(before, after, legacy_clean=True)
            incoming_name = f"{after['material']}-octave-only.wav"
            wet_path, incoming_path = before_path.parent / wet_name, before_path.parent / incoming_name
            rate, channels, wet = read_float_wave(wet_path)
            other_rate, other_channels, incoming = read_float_wave(incoming_path)
            if (rate, channels, len(wet)) != (other_rate, other_channels, len(incoming)):
                raise ValueError("Legacy endpoint formats differ")
            clean_gain = 10 ** (after["fuzz"]["levelDb"] / 20)
            combined = array.array("f", (0.5 * value + 0.5 * clean_gain * clean for value, clean in zip(wet, incoming)))
            write_float_wave(before_file, rate, channels, combined)
            provenance = {"kind": "QA reconstruction from archived native endpoints; not a separate old-DSP render",
                          "formula": "0.5 * archived all-wet + 0.5 * gain(LevelDb) * archived octave-only",
                          "wetSha256": sha256(wet_path), "incomingSha256": sha256(incoming_path)}
        else:
            before = before_rows[filename]
            if full_chain:
                same_full_chain(before, after)
            else:
                same_controls(before, after)
            shutil.copyfile(before_path.parent / filename, before_file)
            provenance = {"kind": "archived native output", "source": str(before_path.parent / filename)}
        after_destination = output / "after" / filename
        shutil.copyfile(after_file, after_destination)
        old_metrics, new_metrics = measurements(before_file), measurements(after_destination)
        if (filename.endswith("-dry.wav") or filename.endswith("-octave-only.wav")) and old_metrics["sha256"] != new_metrics["sha256"]:
            raise ValueError(f"Unexpected dry/octave-only change: {filename}")
        if full_chain and not after["stageMask"] & 1 and old_metrics["sha256"] != new_metrics["sha256"]:
            raise ValueError(f"Unexpected fuzz-off full-chain change: {filename}")
        unchanged_voice = after["fuzzVoice"] != 0 if full_chain else after["fuzz"]["voice"] != 0
        if args.expect_vintage_only and (after["bassProfile"] or unchanged_voice) and old_metrics["sha256"] != new_metrics["sha256"]:
            raise ValueError(f"Unexpected output change outside Guitar/Vintage: {filename}")
        if (old_metrics["sampleRate"], old_metrics["channels"], old_metrics["frames"]) != (new_metrics["sampleRate"], new_metrics["channels"], new_metrics["frames"]):
            raise ValueError(f"Different comparison audio format: {filename}")
        comparisons.append({"file": filename, "before": old_metrics, "after": new_metrics,
                            "baselineProvenance": provenance,
                            "controls": after["rackState"] if full_chain else after["fuzz"],
                            "fullChain": full_chain,
                            "interpretation": "diagnostic_only; no sound-quality pass or output loudness normalization"})
    manifest = {"audioQuality": "not_asserted", "outputProcessing": "Raw native float32 levels; no limiting, normalization or automatic loudness matching.",
                "scope": "Pedal-stage exports plus explicit full-chain NAM amp/cab comparisons where present. See per-row fullChain and source/resource provenance; no universal rig-quality claim.",
                "baselineManifest": str(before_path), "baselineManifestSha256": sha256(before_path),
                "afterManifest": str(after_path), "afterManifestSha256": sha256(after_path), "comparisons": comparisons}
    manifest["expectVintageOnly"] = args.expect_vintage_only
    (output / "comparison.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "listening-order.txt").write_text(
        "Compare matching filenames in before/ and after/ at the same playback volume.\n"
        "Native levels are retained without output loudness matching. full-chain filenames include the explicitly supplied NAM amp and cabinet IR; other files are pedal-stage only.\n"
        "Clean50 before files are reconstructed only when missing from the baseline; such reconstructions are explicitly identified in comparison.json.\n"
        "Bass is synthetic unless the source manifest identifies an explicit supplied recording.\n"
        "Audio quality remains not_asserted pending audition of these exact files.\n\n"
        + "\n".join(row["file"] for row in comparisons) + "\n", encoding="utf-8")
    print(json.dumps({"directory": str(output), "pairs": len(comparisons), "quality": "not_asserted"}))


if __name__ == "__main__":
    main()
