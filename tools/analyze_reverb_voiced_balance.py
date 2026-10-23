"""Summarize native authored-voice exports; musical conclusions are not asserted."""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

import soundfile as sf
from analyze_reverb_audit import decoded_hash, pairwise_metrics, response_metrics
from prepare_reverb_balance import balance_result


def factory_result(document: object) -> dict:
    if isinstance(document, dict):
        if document.get("everyTypeAuthored") is True and isinstance(document.get("cases"), list):
            return document
        for value in document.values():
            try:
                return factory_result(value)
            except ValueError:
                pass
    elif isinstance(document, list):
        for value in document:
            try:
                return factory_result(value)
            except ValueError:
                pass
    raise ValueError("No all-type factory result found")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--factory-report", type=Path, required=True)
    parser.add_argument("--balance-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    load = lambda path: json.loads(path.read_text(encoding="utf-8-sig"))
    factory = factory_result(load(args.factory_report))
    balance = balance_result(load(args.balance_report))
    canonical = [row for row in factory["cases"] if row.get("canonicalProfile") is True]
    if len(canonical) != 41 or {row["type"] for row in canonical} != set(range(41)):
        raise ValueError("Expected one exported canonical impulse for each of the 41 types")
    directory = Path(factory["directory"])
    modes, hashes = [], {}
    for row in canonical:
        samples, rate = sf.read(directory / row["file"], dtype="float64", always_2d=True)
        mode = {"type": row["type"], "name": row["name"], **response_metrics(samples, rate, 1e-4)}
        if not mode["finite"] or not mode["nonzero"]:
            raise ValueError(f"Invalid canonical impulse: {row['name']}")
        digest = decoded_hash(samples, rate)
        mode["decodedSHA256"] = digest
        hashes.setdefault(digest, []).append(row["type"])
        modes.append(mode)
    material_rows = {}
    for material in balance["materials"]:
        rows = [row for row in balance["cases"] if row["material"] == material]
        if len(rows) != 41 or any(row["pass"] is not True for row in rows):
            raise ValueError(f"Incomplete or failed native mix rows: {material}")
        material_rows[material] = {
            "count": len(rows),
            "medianWet50VsDryDb": statistics.median(row["wet50VsDryDb"] for row in rows),
            "medianWet100VsDryDb": statistics.median(row["wet100VsDryDb"] for row in rows),
            "wet100RmsAtLeastDryRms": sum(row["wet100VsDryDb"] >= 0 for row in rows),
            "weakestWet100": sorted(
                [{"type": row["type"], "name": row["name"], "db": row["wet100VsDryDb"]} for row in rows],
                key=lambda row: row["db"],
            )[:5],
        }
    pairs = pairwise_metrics(modes)
    summary = {
        "classification": "diagnostic_only", "audioQuality": "not_asserted",
        "perceivedUniqueness": "not_asserted", "audibility": "not_asserted", "dominance": "not_asserted",
        "canonicalImpulseCount": len(modes), "pairCount": len(pairs),
        "exactDecodedDuplicateGroups": [types for types in hashes.values() if len(types) > 1],
        "nearestDiagnosticPairs": pairs[:20], "materials": material_rows,
        "maximumMixedPeak": balance["maximumMixedPeak"],
        "samplesAboveUnityDiagnostic": balance["samplesAboveUnityDiagnostic"],
        "samplesAtSafetyBoundDiagnostic": balance["samplesAtSafetyBoundDiagnostic"],
        "scope": "Ten-second native mix pack with per-source excitation windows, Dry .7/Wet .5 or1/Output0. Impulse distances remove overall level and are uncalibrated descriptors, never a listening gate.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Summarized {len(modes)} voices/{len(pairs)} pairs and {len(balance['cases'])} native mix rows; diagnostic_only")


if __name__ == "__main__":
    main()
