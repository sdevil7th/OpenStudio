"""Qualify saved-sound parity and measured partial frequencies in native captures.

Run after the Corrected/Legacy instrument-audit and audit-shared-guitar cases.
Requires numpy, scipy and soundfile. No listening verdict is inferred.
"""
from pathlib import Path
import argparse
import json
import math

import numpy as np
import soundfile as sf


ROOT = Path(__file__).resolve().parents[1] / "output/free-plugin-repairs"
INSTRUMENTS = ("synth-default", "synth-sine", "piano-legacy", "piano-expressive",
               "guitar-legacy", "guitar-loop", "drums-legacy", "drums-articulated")
EFFECTS = ("chorus", "compressor", "delay", "eq", "gain-phase", "gate", "graphic-eq",
           "limiter", "pitch-correct", "preamp", "saturator")
RATES = (44100, 48000, 96000, 192000)


def expected_archives() -> set[Path]:
    instruments = {f"{kind}-{rate}.wav" for kind in INSTRUMENTS for rate in RATES}
    instruments |= {f"{kind}-note-{note}.wav" for kind in INSTRUMENTS[:6] for note in (40, 100)}
    instruments |= {f"{kind}-control-{variant}.wav" for kind in INSTRUMENTS[6:] for variant in range(2, 8)}
    instruments |= {f"{kind}-{suffix}.wav" for kind in INSTRUMENTS[6:] for suffix in ("all-notes-off", "single-crash")}
    guitar = {f"{kind}-{variant}.wav" for kind in EFFECTS for variant in ("default", "probe")}
    guitar.add("00-source-nam-only.wav")
    return {Path("instruments/native") / name for name in instruments} | {Path("guitar") / name for name in guitar}


def validate_archive(directory: Path) -> list[Path]:
    expected = expected_archives()
    found = {path.relative_to(directory) for folder in ("instruments/native", "guitar")
             for path in (directory / folder).glob("*.wav")}
    if found != expected:
        raise ValueError(f"Incomplete archived capture matrix in {directory}: missing={sorted(map(str, expected-found))}; unexpected={sorted(map(str, found-expected))}")
    return sorted(expected)


def instrument_invariants(report: dict, mode: str) -> list[dict]:
    if report.get("overallPass") is not True or len(report.get("checks", [])) != 1 or report["checks"][0].get("pass") is not True:
        raise ValueError(f"Failed or ambiguous {mode} native instrument report")
    rows = report["checks"][0].get("invariants")
    if (not isinstance(rows, list) or len(rows) != len(INSTRUMENTS)
            or any(not isinstance(row, dict) for row in rows)
            or {row.get("kind") for row in rows} != set(INSTRUMENTS)):
        raise ValueError(f"Expected each of the eight instrument invariant identities once: {mode}")
    for row in rows:
        for key in ("partitionMaximumError", "stateAudioRoundTripMaximumError", "incomingAudioDiscardedMaximumError",
                    "velocity25Rms", "velocity50Rms", "velocity100Rms"):
            value = row.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f"Invalid instrument invariant {mode}/{row['kind']}/{key}")
    return rows


def analyze(root: Path, baseline: Path | None = None, legacy: Path | None = None,
            corrected: Path | None = None, output: Path | None = None) -> dict:
    baseline, legacy, corrected = baseline or root / "audit-before", legacy or root / "legacy", corrected or root / "corrected"
    archives = validate_archive(baseline)
    validate_archive(legacy)
    invariant_rows = {mode: instrument_invariants(json.loads((directory / "instrument-audit.json").read_text(encoding="utf-8-sig")), mode)
                      for mode, directory in (("legacy", legacy), ("corrected", corrected))}
    from scipy.signal import find_peaks

    parity = []
    for relative in archives:
        before, current = baseline / relative, legacy / relative
        a, rate = sf.read(before, always_2d=True)
        b, current_rate = sf.read(current, always_2d=True)
        if rate != current_rate or a.shape != b.shape or not a.size or not np.isfinite(a).all() or not np.isfinite(b).all():
            raise ValueError(f"Invalid or mismatched archived audio: {relative}")
        error = float(np.max(np.abs(a - b)))
        release_change = before.name.endswith("all-notes-off.wav")
        parity.append({"file": str(relative), "maximumError": error,
                       "status": "intentional_CC123_release_change" if release_change else
                       ("pass" if error == 0 else "fail")})

    partials = []
    for mode in ("legacy", "corrected"):
        for instrument, ratios in (("piano-legacy", (2.003, 3.011, 5.031, 1.497)),
                                   ("guitar-legacy", (2.01, 3.02, 5.07))):
            for rate in (44100, 48000, 96000, 192000):
                path = (legacy if mode == "legacy" else corrected) / "instruments/native" / f"{instrument}-{rate}.wav"
                audio, actual_rate = sf.read(path, always_2d=True)
                if rate != actual_rate or len(audio) < round(1.4 * rate) or not np.isfinite(audio).all():
                    raise ValueError(f"Invalid partial-frequency capture: {path}")
                signal = audio[int(.1 * rate):int(1.4 * rate), 0]
                # Same time window and <= .05 Hz zero-padded frequency grid at every rate.
                length = 1 << int(np.ceil(np.log2(rate / .05)))
                spectrum = np.abs(np.fft.rfft(signal * np.hanning(len(signal)), length))
                frequencies = np.fft.rfftfreq(length, 1 / rate)
                peaks, _ = find_peaks(spectrum)
                for ratio in ratios:
                    target = 440 * ratio
                    nearby = peaks[np.abs(frequencies[peaks] - target) < 18]
                    if not len(nearby):
                        raise ValueError(f"No measurable partial near {target} Hz: {path}")
                    measured = float(frequencies[nearby[np.argmax(spectrum[nearby])]])
                    partials.append({"signalPath": mode, "instrument": instrument, "rate": rate,
                                     "targetHz": target, "measuredHz": measured,
                                     "status": ("pass" if abs(measured - target) < .1 else "fail")
                                     if mode == "corrected" else "diagnostic_only"})

    invariants = []
    for mode in ("legacy", "corrected"):
        for row in invariant_rows[mode]:
            okay = (row["partitionMaximumError"] < 1e-6
                    and row["stateAudioRoundTripMaximumError"] == 0
                    and row["incomingAudioDiscardedMaximumError"] == 0
                    and 0 < row["velocity25Rms"] < row["velocity50Rms"] < row["velocity100Rms"])
            invariants.append({"signalPath": mode, **row, "status": "pass" if okay else "fail"})
    passed = not any(row["status"] == "fail" for row in parity + partials + invariants)
    result = {"overallPass": passed, "legacyWaveforms": parity, "partialFrequencies": partials,
              "instrumentInvariants": invariants, "audioQuality": "not_asserted",
              "scope": "Exact archived recall except intended CC123 releases; measured partial pitch, not timbral authenticity"}
    destination = output or root / "waveform-qualification.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"{'PASS' if passed else 'FAIL'}: {len(parity)} archived WAVs, {len(partials)} partial measurements, "
          f"{len(invariants)} instrument invariant rows. {destination}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--legacy", type=Path)
    parser.add_argument("--corrected", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = analyze(args.root.resolve(), args.baseline, args.legacy, args.corrected, args.output)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    return 0 if result["overallPass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
