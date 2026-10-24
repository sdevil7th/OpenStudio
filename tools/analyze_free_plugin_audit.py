"""Summarize native free-plugin audit captures; no listening verdicts.

Run from the checkout root after the audit focused cases. Requires numpy and
soundfile, as do the other offline audio-analysis tools in this repository.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math

import numpy as np
import soundfile as sf
from analyze_free_plugin_repairs import EFFECTS
from reverb_qa_common import load_json, result_directory, source_project_evidence


ROOT = Path(__file__).resolve().parents[1]


def db(value):
    return 20 * math.log10(max(float(value), 1e-15))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def analyze(directory: Path, root: Path, baseline_report: Path) -> dict:
    out = directory.resolve()
    baseline_document = load_json(baseline_report)
    baseline_checks = [row for row in baseline_document.get("checks", []) if "baselineFile" in row]
    if baseline_document.get("overallPass") is not True or len(baseline_checks) != 1 or baseline_checks[0].get("pass") is not True:
        raise ValueError("Failed or ambiguous native shared-guitar baseline report")
    baseline = baseline_checks[0]
    native_directory = result_directory(baseline, baseline_report)
    timeline, timeline_rate = sf.read(native_directory / baseline["sourceTimelineFile"], always_2d=True)
    if timeline_rate != baseline.get("sampleRate"):
        raise ValueError("Source timeline rate differs from its native report")
    evidence = source_project_evidence(baseline, baseline_report, timeline, timeline_rate)
    source_path = out / "guitar/00-source-nam-only.wav"
    source, rate = sf.read(source_path, always_2d=True, dtype="float64")
    reference = native_directory / baseline["baselineFile"]
    reference_audio, reference_rate = sf.read(reference, always_2d=True, dtype="float64")
    if reference_rate != rate or source.shape != reference_audio.shape or not np.array_equal(source, reference_audio):
        raise ValueError("Audited NAM-only source is not an exact copy of the declared native baseline")
    manifest_document = load_json(out / "audit-shared-guitar.json")
    if manifest_document.get("overallPass") is not True or len(manifest_document.get("checks", [])) != 1:
        raise ValueError("Failed or ambiguous native guitar capture report")
    manifest = manifest_document["checks"][0]
    expected = {(name.replace("-", " ").casefold(), variant) for name in EFFECTS for variant in (0, 1)}
    captures = manifest.get("cases", [])
    actual = {(row.get("name", "").casefold(), row.get("variant")) for row in captures}
    if (manifest.get("pass") is not True or len(captures) != 22 or actual != expected
            or any(type(row.get("variant")) is not int for row in captures)):
        raise ValueError("Expected each of eleven effects with default/probe variants exactly once")
    rows = []
    active = slice(round(evidence["timelineOnsetDiagnostic"]["rms_db_-30"] * rate),
                   round((evidence["clipStartSeconds"] + evidence["sourceDurationSeconds"]) * rate))
    if not 0 <= active.start < active.stop <= len(source) or not np.isfinite(source).all():
        raise ValueError("Invalid native guitar source or diagnostic measurement span")
    dry_rms = np.sqrt(np.mean(source[active] ** 2))
    if dry_rms <= 0:
        raise ValueError("Silent guitar source measurement window")
    for row in captures:
        path = Path(row["file"])
        path = path if path.is_absolute() else out / path
        audio, fs = sf.read(path, always_2d=True, dtype="float64")
        if fs != rate or audio.shape != source.shape or not np.isfinite(audio).all():
            raise ValueError(f"Invalid or mismatched guitar capture: {path}")
        rms = np.sqrt(np.mean(audio[active] ** 2))
        delta = np.sqrt(np.mean((audio[active] - source[active]) ** 2))
        rows.append({"plugin": row["name"], "variant": row["variant"], "file": str(path.resolve()),
                     "sha256": digest(path), "finite": True,
                     "peakDbFS": db(np.max(np.abs(audio))), "activeRmsDbFS": db(rms),
                     "activeRmsGainDb": db(rms / dry_rms), "activeDifferenceRelativeDb": db(delta / dry_rms),
                     "aboveUnitySamples": int(np.count_nonzero(np.abs(audio) > 1)),
                     "latencyTrimmedSamples": row["latencyTrimmed"], "status": "diagnostic_only"})

    motion = []
    for character in (0, 1):
        audio, fs = sf.read(out / f"modulation/motion-character-{character}.wav", always_2d=True)
        if fs <= 0 or len(audio) <= round(.1 * fs) + 1 or not np.isfinite(audio).all():
            raise ValueError("Invalid chorus motion capture")
        steps = np.abs(np.diff(audio[round(.1 * fs):, 0]))
        motion.append({"character": character, "maximumStep": float(np.max(steps)),
                       "p99Step": float(np.quantile(steps, .99)),
                       "maximumToP99": float(np.max(steps) / max(np.quantile(steps, .99), 1e-30)), "status": "diagnostic_only"})

    native = []
    for path in sorted(out.rglob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeError, ValueError):
            continue
        if "overallPass" in data:
            native.append({"file": str(path.resolve()), "selectedCase": data.get("selectedCase"),
                           "topLevelPass": data["overallPass"],
                           "interpretation": "Inspect per-case behavioral verdicts; capture success alone is not a sound-quality pass."})
    result = {
        "audioQuality": "not_asserted", "analysisStatus": "diagnostic_only",
        "provenance": {"project": evidence["projectPath"], "projectSha256": digest(Path(evidence["projectPath"])),
                       "projectMatchesAuditedSource": digest(Path(evidence["projectPath"])) == evidence["projectSha256"],
                       "recordingMatchesAuditedSource": digest(Path(evidence["sourcePath"])) == evidence["sourceSha256"],
                       "sourceSha256": digest(source_path), "rate": rate, "durationSeconds": len(source) / rate,
                       "copiedSourceSamplesExact": reference_rate == rate and bool(np.array_equal(source, reference_audio)),
                       "sourcePeakDbFS": db(np.max(np.abs(source))), "activeSourceRmsDbFS": db(dry_rms),
                       "firstThreeSecondsRmsDbFS": db(np.sqrt(np.mean(source[:rate * 3] ** 2))),
                       "route": "Previously reconstructed PlaybackEngine + saved NAM TrackProcessor capture; additional standalone effect only. Not a new complete AudioEngine/device export."},
        "guitar": rows, "chorusMotion": motion, "nativeReports": native, "workspaceRoot": str(root.resolve()),
    }
    (out / "signal-summary.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote signal-summary.json: {len(rows)} guitar effect captures, {len(native)} native reports.")
    print(json.dumps(result["provenance"], indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--baseline-report", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        analyze(args.directory or root / "output/free-plugin-audit", root,
                args.baseline_report or root / "output/reverb-shared-guitar-project/native-release.json")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
