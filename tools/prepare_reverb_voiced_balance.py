#!/usr/bin/env python3
"""Build the native-level canonical Reverb player for generated/recorded DI inputs.

Uses an explicit six-variant balance configuration and byte-preserving WAV
publication. Recorded guitar is labelled explicitly; no human voice or listening
acceptance is fabricated, and no output gain matching is performed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import prepare_reverb_balance as base
from reverb_qa_common import finite_number, load_json, result_directory


MATERIAL_NAMES = {
    "percussion": "Percussion (generated)",
    "synthetic-vowel": "Synthetic vowel (generated)",
    "sustained-chord": "Sustained chord (generated)",
    "recorded-guitar-low-notes": "Low guitar notes (recorded DI)",
    "recorded-guitar-high-notes": "High guitar notes (recorded DI)",
    "recorded-guitar-layered-chord": "Layered guitar chord (recorded DI notes)",
    "juce-singing-sample": "JUCE singing sample (short bundled audio)",
}


CONFIGURATION = base.PlayerConfiguration(
    title="OpenStudio Reverb voiced balance",
    materials=tuple(MATERIAL_NAMES.items()),
    variants=(("dry", "Dry only - 70%"), ("original100", "Original return - Wet 100%"),
              ("calibrated25", "Calibrated return - Wet 25%"),
              ("calibrated50", "Calibrated return - Wet 50%"),
              ("calibrated75", "Calibrated return - Wet 75%"),
              ("calibrated100", "Calibrated return - Wet 100%")),
    authored_output=True,
    optional_metrics=(*base.OPTIONAL_METRICS, "excitationSeconds", "wet25VsDryDb", "wet75VsDryDb"),
    introduction=("These are 41 explicitly authored canonical voices. Three inputs are generated; "
                  "three arrange CC0 recorded electric-guitar DI notes. The seventh is the short bundled "
                  "JUCE singing sample; performer, recording chain and binary recording credits remain "
                  "unverified, for local diagnostic QA only. The synthetic vowel is not a human voice. "
                  "All inputs use the same fixed 0.5 input gain; preparation gains are documented in "
                  '<a href="recorded-source-manifest.json">recorded-source provenance</a>. '
                  "This input scaling does not normalize the output."),
)


def prepare(result_path: Path, output: Path) -> dict:
    report = load_json(result_path)
    native = base.balance_result(report, tuple(key for key, _ in CONFIGURATION.variants))
    if native.get("materials") != list(MATERIAL_NAMES):
        raise ValueError("Expected the seven declared generated/recorded source materials in order")
    directory = result_directory(native, result_path)
    source_manifest = directory / native.get("recordedSourceManifest", "recorded-source-manifest.json")
    provenance = load_json(source_manifest)
    recorded = provenance.get("materials", [])
    if len(recorded) != 4 or {row.get("material") for row in recorded} != set(list(MATERIAL_NAMES)[3:]):
        raise ValueError("Recorded source provenance must describe the four recorded materials")
    if finite_number(native.get("commonInputGain"), "commonInputGain") != .5:
        raise ValueError("Expected the declared fixed 0.5 input gain")
    for row in native["cases"]:
        for key in ("samplesAboveUnityDiagnostic", "samplesAtSafetyBoundDiagnostic"):
            if key not in row:
                raise ValueError(f"Missing clipping diagnostics: {row['type']}/{row['material']}/{key}")
    extra = {key: native[key] for key in ("sources", "commonInputGain", "realRecordedVoice", "tailCompleteness",
             "samplesAboveUnityDiagnostic", "samplesAtSafetyBoundDiagnostic")}
    extra.update({"sourceScaling": "Fixed common input 0.5 gain; source preparation gains are recorded separately. No output normalization.",
                  "recordedSourceManifest": "recorded-source-manifest.json",
                  "maximumMixedPeakDiagnostic": native["maximumMixedPeak"]})
    manifest = base.prepare(result_path, output, CONFIGURATION, extra)
    (output.resolve() / "recorded-source-manifest.json").write_text(
        json.dumps(provenance, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", type=Path, default=Path("output/reverb-voiced-balance/native-release.json"))
    parser.add_argument("--output", type=Path, default=Path("output/reverb-voiced-balance"))
    args = parser.parse_args()
    manifest = prepare(args.result, args.output)
    print(json.dumps({key: manifest[key] for key in ("pass", "count", "audioFileCount", "nativeStatus", "normalization", "realRecordedVoice", "samplesAboveUnityDiagnostic", "samplesAtSafetyBoundDiagnostic")}))


if __name__ == "__main__":
    main()
