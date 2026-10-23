"""Analyze standalone reverb research exports; no perceptual quality assertions.

Example:
    python tools/analyze_reverb_audit.py --report output/reverb-audit/all-modes-release.json

The WAV responses are finite capture windows, not complete impulse responses.
Envelope and spectral distances are diagnostics, never listening-test results.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf


BAND_CENTERS = (125, 250, 500, 1000, 2000, 4000, 8000)
ENVELOPE_SECONDS = 0.05


def find_native_report(document: Any) -> dict[str, Any]:
    """Accept the native result directly or a containing regression report."""
    candidates: list[dict[str, Any]] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            cases = value.get("cases")
            if isinstance(cases, list) and cases and all(
                isinstance(row, dict) and "type" in row and "file" in row for row in cases
            ):
                candidates.append(value)
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)

    visit(document)
    if len(candidates) != 1:
        raise ValueError(f"Expected one reverb cases/file report, found {len(candidates)}")
    return candidates[0]


def correlation(first: np.ndarray, second: np.ndarray) -> float | None:
    norm = float(np.linalg.norm(first) * np.linalg.norm(second))
    if norm == 0:
        return None
    return float(np.clip(np.dot(first, second) / norm, -1, 1))


def response_metrics(samples: np.ndarray, rate: int, arrival_relative: float) -> dict[str, Any]:
    if samples.ndim != 2 or samples.shape[1] != 2 or not len(samples) or rate <= 0:
        raise ValueError("Expected a nonempty two-channel WAV with a positive sample rate")
    finite = bool(np.isfinite(samples).all())
    result: dict[str, Any] = {
        "sampleRate": rate,
        "frames": len(samples),
        "channels": 2,
        "capturedSeconds": len(samples) / rate,
        "finite": finite,
        "nonzero": bool(np.any(samples != 0)) if finite else False,
        "windowLimited": True,
    }
    if not finite:
        result["error"] = "Nonfinite WAV samples; descriptors were not computed"
        return result
    energy_by_frame = np.einsum("ij,ij->i", samples, samples)
    energy = float(energy_by_frame.sum())
    peak = float(np.max(np.abs(samples)))
    result.update(capturedEnergy=energy, peak=peak)
    if energy == 0:
        result["error"] = "Zero response; descriptors were not computed"
        return result

    threshold = peak * arrival_relative
    arrivals = np.flatnonzero(np.max(np.abs(samples), axis=1) >= threshold)
    result["firstArrivalSeconds"] = int(arrivals[0]) / rate
    result["arrivalAmplitudeThreshold"] = threshold
    early_frames = min(len(samples), math.ceil(0.08 * rate))
    result["early80msEnergyFraction"] = float(energy_by_frame[:early_frames].sum() / energy)
    times = np.arange(len(samples), dtype=np.float64) / rate
    result["energyCentroidSeconds"] = float(np.dot(times, energy_by_frame) / energy)
    cumulative = np.cumsum(energy_by_frame)
    for label, fraction in (("05", 0.05), ("50", 0.5), ("95", 0.95)):
        index = min(len(samples) - 1, int(np.searchsorted(cumulative, energy * fraction)))
        result[f"energyTime{label}Seconds"] = index / rate
    last_500ms = min(len(samples), math.ceil(0.5 * rate))
    result["last500msEnergyFraction"] = float(energy_by_frame[-last_500ms:].sum() / energy)
    result["endAboveArrivalThreshold"] = bool(np.max(np.abs(samples[-min(len(samples), math.ceil(0.1 * rate)):])) >= threshold)
    result["stereoCorrelation"] = correlation(samples[:, 0], samples[:, 1])
    mid = (samples[:, 0] + samples[:, 1]) * 0.5
    side = (samples[:, 0] - samples[:, 1]) * 0.5
    mid_energy, side_energy = float(np.dot(mid, mid)), float(np.dot(side, side))
    result["sideEnergyFraction"] = side_energy / (mid_energy + side_energy)

    # Rectangular, whole-capture FFT. Parseval weights account for the rFFT's
    # omitted negative frequencies; no taper alters the measured band energy.
    spectrum = np.fft.rfft(samples, axis=0)
    spectral_energy = np.sum(np.abs(spectrum) ** 2, axis=1)
    weights = np.full(len(spectral_energy), 2.0)
    weights[0] = 1.0
    if len(samples) % 2 == 0:
        weights[-1] = 1.0
    spectral_energy *= weights / len(samples)
    frequencies = np.fft.rfftfreq(len(samples), 1 / rate)
    bands: list[dict[str, Any]] = []
    for center in BAND_CENTERS:
        lower, upper = center / math.sqrt(2), center * math.sqrt(2)
        mask = (frequencies >= lower) & (frequencies < upper)
        value = float(spectral_energy[mask].sum())
        bands.append({"centerHz": center, "lowerHz": lower, "upperHz": upper,
                      "capturedEnergy": value, "fractionOfCapturedEnergy": value / energy,
                      "withinNyquist": upper <= rate / 2})
    selected_energy = sum(band["capturedEnergy"] for band in bands)
    for band in bands:
        band["fractionOfSelectedBands"] = band["capturedEnergy"] / selected_energy if selected_energy > 0 else None
    result["selectedBandEnergyFraction"] = selected_energy / energy
    result["bands"] = bands

    window_frames = max(1, round(ENVELOPE_SECONDS * rate))
    envelope = []
    for begin in range(0, len(samples), window_frames):
        end = min(len(samples), begin + window_frames)
        value = float(np.sqrt(energy_by_frame[begin:end].sum() / ((end - begin) * 2)))
        envelope.append({"startSeconds": begin / rate, "durationSeconds": (end - begin) / rate, "rms": value})
    result["rmsEnvelope50ms"] = envelope
    return result


def decoded_hash(samples: np.ndarray, rate: int) -> str:
    # Treat positive and negative zero as numerically identical.
    canonical = np.ascontiguousarray(np.where(samples == 0, 0.0, samples), dtype="<f8")
    digest = hashlib.sha256(f"{rate}:{canonical.shape}".encode("ascii"))
    digest.update(canonical.tobytes())
    return digest.hexdigest()


def normalize_vector(values: list[float]) -> np.ndarray:
    vector = np.asarray(values, dtype=np.float64)
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 0 else vector


def pairwise_metrics(modes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pairs = []
    eligible = [mode for mode in modes if mode.get("finite") and mode.get("nonzero") and "bands" in mode]
    for first, second in itertools.combinations(eligible, 2):
        pair: dict[str, Any] = {"firstType": first["type"], "firstName": first["name"],
                                "secondType": second["type"], "secondName": second["name"],
                                "classification": "diagnostic_only"}
        matching = (first["sampleRate"] == second["sampleRate"] and first["frames"] == second["frames"])
        pair["matchingCaptureWindow"] = matching
        if not matching:
            pair["error"] = "Different capture lengths/rates; distances not computed"
            pairs.append(pair)
            continue
        first_env = normalize_vector([entry["rms"] for entry in first["rmsEnvelope50ms"]])
        second_env = normalize_vector([entry["rms"] for entry in second["rmsEnvelope50ms"]])
        pair["envelopeDistance"] = float(np.linalg.norm(first_env - second_env) / math.sqrt(2))
        first_band = [band["fractionOfSelectedBands"] for band in first["bands"]]
        second_band = [band["fractionOfSelectedBands"] for band in second["bands"]]
        if all(value is not None for value in first_band + second_band):
            pair["spectralDistance"] = float(np.abs(np.asarray(first_band) - np.asarray(second_band)).sum() * 0.5)
            pair["combinedDistance"] = (pair["envelopeDistance"] + pair["spectralDistance"]) * 0.5
        pair["exactDecodedDuplicate"] = first["decodedSHA256"] == second["decodedSHA256"]
        pairs.append(pair)
    return sorted(pairs, key=lambda row: (row.get("combinedDistance", math.inf), row["firstType"], row["secondType"]))


def mode_csv_row(mode: dict[str, Any]) -> dict[str, Any]:
    row = {key: value for key, value in mode.items() if not isinstance(value, (dict, list))}
    for center, band in zip(BAND_CENTERS, mode.get("bands", [])):
        row[f"band{center}HzFraction"] = band["fractionOfCapturedEnergy"]
        row[f"band{center}HzSelectedNormalized"] = band["fractionOfSelectedBands"]
    return row


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = list(dict.fromkeys(key for row in rows for key in row))
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def analyze(report_path: Path, responses_dir: Path | None, arrival_relative: float,
            expected_modes: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    native = find_native_report(json.loads(report_path.read_text(encoding="utf-8-sig")))
    if responses_dir is None:
        candidate = Path(native.get("directory", ""))
        responses_dir = candidate if candidate.is_dir() else report_path.parent / "responses"
    modes = []
    hash_groups: dict[str, list[dict[str, Any]]] = {}
    for case in native["cases"]:
        mode: dict[str, Any] = {"type": case["type"], "name": case.get("name", str(case["type"])),
                                "file": case["file"], "classification": "diagnostic_only"}
        for key in ("selectorReadback", "fileWritten", "nominalTailSeconds", "prepareMs", "medianUs",
                    "p95Us", "p99Us", "maxUs", "deadlineOverruns", "impulseEnergy"):
            if key in case:
                mode[key] = case[key]
        path = responses_dir / case["file"]
        mode["path"] = str(path.resolve())
        try:
            samples, rate = sf.read(path, dtype="float64", always_2d=True)
            mode.update(response_metrics(samples, rate, arrival_relative))
            if mode["finite"]:
                mode["decodedSHA256"] = decoded_hash(samples, rate)
                hash_groups.setdefault(mode["decodedSHA256"], []).append(mode)
            mode["sampleRateMatchesNative"] = rate == native.get("sampleRate", rate)
            mode["durationMatchesNative"] = abs(len(samples) / rate - native.get("responseSeconds", len(samples) / rate)) <= 1 / rate
            mode["tailMayBeTruncated"] = bool(mode.get("endAboveArrivalThreshold", False) or case.get("nominalTailSeconds", 0) > len(samples) / rate)
        except (OSError, RuntimeError, ValueError) as error:
            mode.update(finite=False, nonzero=False, error=str(error))
        modes.append(mode)
    modes.sort(key=lambda mode: mode["type"])
    duplicates = [{"types": [mode["type"] for mode in group], "names": [mode["name"] for mode in group],
                   "decodedSHA256": digest} for digest, group in hash_groups.items() if len(group) > 1]
    checks = {
        "expectedModeCount": expected_modes == 0 or len(modes) == expected_modes,
        "uniqueTypeIds": len({mode["type"] for mode in modes}) == len(modes),
        "selectorReadback": all(mode.get("selectorReadback") is True for mode in modes),
        "wavExportsMarkedWritten": all(mode.get("fileWritten") is True for mode in modes),
        "finiteResponses": all(mode.get("finite") is True for mode in modes),
        "nonzeroResponses": all(mode.get("nonzero") is True for mode in modes),
        "captureRateAndDuration": all(mode.get("sampleRateMatchesNative") and mode.get("durationMatchesNative") for mode in modes),
    }
    pairs = pairwise_metrics(modes)
    result = {
        "classification": "diagnostic_only",
        "audioQuality": "not_asserted",
        "perceptualDistinctness": "not_asserted",
        "acousticFidelity": "not_asserted",
        "sourceReport": str(report_path.resolve()),
        "nativeBuild": native.get("build"),
        "nativeCpu": native.get("cpu"),
        "nativeInput": native.get("input"),
        "modeCount": len(modes),
        "expectedModeCount": expected_modes,
        "deterministicChecks": checks,
        "deterministicPass": all(checks.values()),
        "exactDecodedDuplicateGroups": duplicates,
        "definitions": {
            "window": "All energy, centroid, quantiles, bands and envelopes describe only captured WAV samples. Long tails may be truncated; no RT60 or complete-tail claim is made.",
            "arrival": f"First sample whose maximum absolute channel amplitude is at least {arrival_relative:g} times the response peak ({20 * math.log10(arrival_relative):.1f} dB relative).",
            "earlyEnergy": "Energy before 80 ms measured from excitation time, not from first arrival; stereo channel energies are summed.",
            "quantiles": "Times at which 5%, 50% and 95% of captured energy have accumulated.",
            "stereoCorrelation": "Zero-lag L/R dot product divided by channel L2 norms, without subtracting the means; undefined for a silent channel.",
            "bands": "Whole-capture rectangular rFFT with Parseval weighting. Seven adjoining octave bands have bounds center/sqrt(2) to center*sqrt(2), centers 125–8000 Hz. Fractions are reported against captured energy and against selected-band energy.",
            "envelope": "RMS over nonoverlapping 50 ms windows, averaging both channels; a final partial window uses its actual duration.",
            "envelopeDistance": "Euclidean distance between unit-L2-normalized RMS envelope vectors divided by sqrt(2); range 0–1 for nonnegative vectors. Overall level is removed.",
            "spectralDistance": "Half the L1 distance between selected-band-normalized energy vectors (total variation, range 0–1). Phase, fine resonances and modulation are omitted.",
            "combinedDistance": "Uncalibrated arithmetic mean of envelopeDistance and spectralDistance, used solely to order diagnostic candidates.",
            "exactDuplicates": "Identical decoded float64 sample values, channel shape and sample rate (positive/negative zero canonicalized), grouped by SHA-256; file-container metadata is ignored. This is not an audibility test.",
            "timing": "Native timings are copied unchanged as diagnostic_only; they are not audio-device/dropout qualification or a portable CPU guarantee.",
        },
        "modes": modes,
        "nearestDiagnosticPairs": [pair for pair in pairs if "combinedDistance" in pair][:30],
        "pairCount": len(pairs),
    }
    return result, pairs


def self_test() -> None:
    # Hand-computable delayed stereo impulse: catches time origin, energy
    # quantiles, stereo normalization, and channel averaging errors.
    rate = 1000
    impulse = np.zeros((200, 2))
    impulse[25] = (0.25, -0.25)
    descriptor = response_metrics(impulse, rate, 1e-4)
    assert descriptor["finite"] and descriptor["nonzero"]
    assert descriptor["capturedEnergy"] == 0.125
    assert descriptor["firstArrivalSeconds"] == 0.025
    assert descriptor["energyCentroidSeconds"] == 0.025
    assert all(descriptor[f"energyTime{key}Seconds"] == 0.025 for key in ("05", "50", "95"))
    assert descriptor["early80msEnergyFraction"] == 1
    assert descriptor["stereoCorrelation"] == -1
    assert descriptor["sideEnergyFraction"] == 1
    assert np.isclose(descriptor["rmsEnvelope50ms"][0]["rms"], 0.25 / math.sqrt(50))
    zero = response_metrics(np.zeros_like(impulse), rate, 1e-4)
    assert zero["finite"] and not zero["nonzero"] and "bands" not in zero
    invalid = impulse.copy()
    invalid[0, 0] = np.nan
    assert not response_metrics(invalid, rate, 1e-4)["finite"]
    signed_zero = impulse.copy()
    signed_zero[signed_zero == 0] = -0.0
    assert decoded_hash(impulse, rate) == decoded_hash(signed_zero, rate)
    # A bin-centered sinusoid isolates a known octave band and checks FFT
    # normalization without relying on a reverb implementation.
    rate = 48000
    tone = np.sin(2 * np.pi * 1000 * np.arange(rate) / rate) * 0.25
    descriptor = response_metrics(np.column_stack((tone, tone)), rate, 1e-4)
    band = next(item for item in descriptor["bands"] if item["centerHz"] == 1000)
    assert np.isclose(band["fractionOfCapturedEnergy"], 1, atol=1e-12)
    assert np.isclose(descriptor["stereoCorrelation"], 1, atol=1e-12)
    first = {**descriptor, "type": 0, "name": "fixture", "decodedSHA256": "same"}
    second = {**descriptor, "type": 1, "name": "repeat", "decodedSHA256": "same"}
    pair = pairwise_metrics([first, second])[0]
    assert pair["envelopeDistance"] == pair["spectralDistance"] == 0
    assert pair["exactDecodedDuplicate"]
    print("Deterministic analyzer fixtures: pass. Audio quality: not_asserted.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="Native all-mode JSON, or containing regression report")
    parser.add_argument("--output-dir", type=Path, help="Defaults to a folder named <report-stem>-analysis beside the report")
    parser.add_argument("--responses-dir", type=Path, help="Override native WAV directory")
    parser.add_argument("--arrival-relative", type=float, default=1e-4, help="Arrival threshold relative to each response peak (default: 0.0001)")
    parser.add_argument("--expected-modes", type=int, default=41, help="Expected mode count, or 0 to allow a subset")
    parser.add_argument("--self-test", action="store_true", help="Run deterministic analyzer fixtures")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        if args.report is None:
            return 0
    if args.report is None:
        parser.error("--report is required unless running --self-test")
    if not 0 < args.arrival_relative <= 1:
        parser.error("--arrival-relative must be greater than 0 and at most 1")
    if args.expected_modes < 0:
        parser.error("--expected-modes must be nonnegative")
    try:
        result, pairs = analyze(args.report, args.responses_dir, args.arrival_relative, args.expected_modes)
        output = args.output_dir or args.report.parent / f"{args.report.stem}-analysis"
        output.mkdir(parents=True, exist_ok=True)
        (output / "analysis.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        write_csv(output / "modes.csv", [mode_csv_row(mode) for mode in result["modes"]])
        write_csv(output / "pairwise.csv", pairs)
        print(json.dumps({"deterministicPass": result["deterministicPass"], "modeCount": result["modeCount"],
                          "exactDuplicateGroups": result["exactDecodedDuplicateGroups"],
                          "pairCount": result["pairCount"], "outputDirectory": str(output.resolve()),
                          "responseMetrics": "diagnostic_only", "perceptualDistinctness": "not_asserted"}, indent=2))
        return 0 if result["deterministicPass"] else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Reverb audit analysis failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
