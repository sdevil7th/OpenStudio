"""Analyze existing native guitar and factory-impulse renders without changing WAVs.

Descriptors are diagnostic_only. They do not assert audibility, perceived
uniqueness, musical quality, or a calibrated acoustic RT60.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

from analyze_reverb_audit import decoded_hash, pairwise_metrics, response_metrics


def db_ratio(value: float, reference: float) -> float:
    return 20 * math.log10(max(value, 1e-30) / max(reference, 1e-30))


def rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values, dtype=np.float64))))


def energy(values: np.ndarray) -> float:
    return float(np.sum(np.square(values, dtype=np.float64)))


def correlation(first: np.ndarray, second: np.ndarray) -> float:
    numerator = float(np.sum(first * second, dtype=np.float64))
    return numerator / max(math.sqrt(energy(first) * energy(second)), 1e-30)


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def spectrum(values: np.ndarray, rate: int) -> dict:
    frequencies, power = signal.welch(values, rate, nperseg=8192, axis=0)
    power = np.sum(power, axis=1)
    total = float(np.sum(power))
    edges = [0, 80, 250, 1000, 4000, 8000, rate / 2 + 1]
    return {
        "centroidHz": float(np.dot(frequencies, power) / max(total, 1e-30)),
        "bands": [
            {"lowHz": low, "highHz": high,
             "energyFraction": float(np.sum(power[(frequencies >= low) & (frequencies < high)]) / max(total, 1e-30))}
            for low, high in zip(edges, edges[1:])
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-pack", type=Path, default=Path("output/reverb-shared-guitar-project"))
    parser.add_argument("--factory-report", type=Path, default=Path("output/reverb-completion/reverb-factory-debug-final.json"))
    parser.add_argument("--output", type=Path, default=Path("output/reverb-implementation-review"))
    args = parser.parse_args()
    native = load(args.project_pack / "native-release.json")["checks"][0]
    manifest = load(args.project_pack / "manifest.json")
    evidence = manifest["sourceEvidence"]
    directory = Path(native["directory"])
    baseline, rate = sf.read(directory / native["baselineFile"], dtype="float32", always_2d=True)
    if rate != native["sampleRate"] or baseline.shape[1] != 2:
        raise ValueError("Unexpected native baseline format")
    first = round(evidence["timelineOnsetDiagnostic"]["rms_db_-30"] * rate)
    last = round((evidence["clipStartSeconds"] + evidence["sourceDurationSeconds"]) * rate)
    source = baseline[first:last]
    source_spectrum = spectrum(source, rate)
    rows, waveforms, envelopes = [], [], []
    for row in native["cases"]:
        dry, dry_rate = sf.read(directory / row["files"]["dry"], dtype="float32", always_2d=True)
        mixed, mixed_rate = sf.read(directory / row["files"]["wet100"], dtype="float32", always_2d=True)
        if dry_rate != rate or mixed_rate != rate or dry.shape != baseline.shape or mixed.shape != baseline.shape:
            raise ValueError(f"Mismatched capture: {row['typeName']}")
        wet = mixed - dry
        if not np.isfinite(wet).all():
            raise ValueError(f"Nonfinite wet residual: {row['typeName']}")
        active = wet[first:last]
        direct = dry[first:last]
        mid, side = np.mean(active, axis=1), (active[:, 0] - active[:, 1]) * .5
        wet_rms, dry_rms = rms(active), rms(direct)
        wet_spectrum = spectrum(active, rate)
        direct_gain = .7 * 10**(row.get("outputTrimDb", 0)/20)
        dry_difference = direct - direct_gain * source
        tail = wet[last:]
        last_second = wet[-rate:]
        window = round(.1 * rate)
        usable = len(active) // window * window
        envelope = np.sqrt(np.mean(np.square(active[:usable].reshape(-1, window, 2), dtype=np.float64), axis=(1, 2)))
        compressed = signal.resample_poly(active, 1, 4, axis=0).reshape(-1)
        waveforms.append(compressed / max(math.sqrt(energy(compressed)), 1e-30))
        envelopes.append(envelope / max(math.sqrt(energy(envelope)), 1e-30))
        startup = np.max(np.abs((dry - direct_gain * baseline)[:round(.05 * rate)]))
        settled = np.max(np.abs((dry - direct_gain * baseline)[round(.05 * rate):]))
        entry = {
            "type": row["type"], "name": row["typeName"], "classification": "diagnostic_only",
            "wet100VsDryDb": db_ratio(wet_rms, dry_rms),
            "wetRms": wet_rms, "dryRms": dry_rms,
            "wetDryZeroLagCorrelation": correlation(active, direct),
            "wetLeftRightCorrelation": correlation(active[:, 0], active[:, 1]),
            "wetLeftVsRightDb": db_ratio(rms(active[:, 0]), rms(active[:, 1])),
            "wetSideEnergyFraction": energy(side) / max(energy(mid) + energy(side), 1e-30),
            "wetMonoFoldVsStereoRmsDb": db_ratio(rms(mid), wet_rms),
            "wetMeanVsRmsDb": db_ratio(float(np.max(np.abs(np.mean(active, axis=0, dtype=np.float64)))), wet_rms),
            "wetSpectrum": wet_spectrum,
            "wetVsSourceCentroidRatio": wet_spectrum["centroidHz"] / max(source_spectrum["centroidHz"], 1e-30),
            "tailRmsVsActiveDb": db_ratio(rms(tail), wet_rms),
            "lastSecondRmsVsActiveDb": db_ratio(rms(last_second), wet_rms),
            "lastSecondRmsDbfs": db_ratio(rms(last_second), 1),
            "lastSecondPeak": float(np.max(np.abs(last_second))),
            "dryDifferenceRmsVsBaselineDb": db_ratio(rms(dry_difference), direct_gain * rms(source)),
            "dryDifferenceMaxFirst50ms": float(startup), "dryDifferenceMaxAfter50ms": float(settled),
            "mixedPeak": float(np.max(np.abs(mixed))),
        }
        rows.append(entry)
        print(f"Analyzed {row['type'] + 1}/41: {row['typeName']}", flush=True)
    waves = np.asarray(waveforms, dtype=np.float32)
    envs = np.asarray(envelopes, dtype=np.float64)
    wave_correlations, envelope_correlations = waves @ waves.T, envs @ envs.T
    pairs = [
        {"firstType": rows[a]["type"], "firstName": rows[a]["name"],
         "secondType": rows[b]["type"], "secondName": rows[b]["name"],
         "wetWaveformCorrelation": float(np.clip(wave_correlations[a, b], -1, 1)),
         "wetEnvelopeCosine": float(np.clip(envelope_correlations[a, b], -1, 1)),
         "classification": "diagnostic_only"}
        for a in range(len(rows)) for b in range(a + 1, len(rows))
    ]
    factory = load(args.factory_report)["checks"][0]
    impulse_rows = []
    for row in factory["cases"]:
        if not row.get("canonicalProfile"):
            continue
        samples, ir_rate = sf.read(Path(factory["directory"]) / row["file"], dtype="float64", always_2d=True)
        impulse_rows.append({"type": row["type"], "name": row["name"],
                             "decodedSHA256": decoded_hash(samples, ir_rate),
                             **response_metrics(samples, ir_rate, 1e-4)})
    if len(rows) != 41 or len(impulse_rows) != 41:
        raise ValueError("Expected all 41 project and canonical impulse rows")
    report = {
        "classification": "diagnostic_only", "audioQuality": "not_asserted",
        "audibility": "not_asserted", "perceivedUniqueness": "not_asserted",
        "source": str(directory), "activeSeconds": [first / rate, last / rate],
        "sourceSpectrum": source_spectrum, "voices": rows,
        "highestWaveformCorrelationPairs": sorted(pairs, key=lambda p: abs(p["wetWaveformCorrelation"]), reverse=True)[:30],
        "highestEnvelopeSimilarityPairs": sorted(pairs, key=lambda p: p["wetEnvelopeCosine"], reverse=True)[:15],
        "canonicalImpulseMetrics": impulse_rows,
        "canonicalImpulseClosestDescriptorPairs": pairwise_metrics(impulse_rows)[:20],
        "scope": "Same actual guitar through all authored voices; per-voice wet100 minus wet0 at Dry .7 and the reported per-voice Output trim. Full active-window Welch spectrum/stereo/tail; waveform correlations use polyphase 4x downsampling. Common source strongly biases envelope similarity. Factory impulses are only 2s long and retain authored Output, so no complete-tail or acoustic RT60 claim. No WAVs rewritten.",
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "render-analysis.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    scalar_rows = [{k: v for k, v in row.items() if not isinstance(v, dict)} for row in rows]
    with (args.output / "guitar-voices.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(scalar_rows[0]))
        writer.writeheader(); writer.writerows(scalar_rows)
    print("Complete: 41 guitar voices, 820 pairs, 41 canonical impulse descriptors; diagnostic_only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
