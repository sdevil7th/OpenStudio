"""Long-tail and rate diagnostics; no listening or acoustic-model assertions."""
from pathlib import Path
import argparse
import json
import math
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt


def decay(samples, rate):
    energy = np.square(samples).sum(axis=1)
    total = float(energy.sum())
    edc = np.cumsum(energy[::-1])[::-1]
    db = 10 * np.log10(np.maximum(edc / max(total, 1e-30), 1e-30))
    take = (db <= -5) & (db >= -25)
    # Sample the fit every millisecond; preserve original-time coordinates.
    indices = np.flatnonzero(take)[::max(1, rate // 1000)]
    fit = None
    if len(indices) > 10:
        t = indices / rate
        slope, intercept = np.polyfit(t, db[indices], 1)
        residual = np.square(db[indices] - (slope * t + intercept)).sum()
        variance = np.square(db[indices] - db[indices].mean()).sum()
        fit = {"t20ExtrapolatedSeconds": float(-60 / slope),
               "rSquared": float(1 - residual / max(variance, 1e-30)),
               "fitWindowSeconds": [float(t[0]), float(t[-1])]}
    cumulative = np.cumsum(energy)
    return {"energy": total, "t95Seconds": float(np.searchsorted(cumulative, total * .95) / rate),
            "energyAfterOneSecondFraction": float(energy[rate:].sum() / max(total, 1e-30)),
            "lastSecondEnergyFraction": float(energy[-rate:].sum() / max(total, 1e-30)),
            "fitDiagnostic": fit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--directory", type=Path, default=Path("output/reverb-correction/long-responses"))
    parser.add_argument("--output", type=Path, default=Path("output/reverb-correction/long-analysis.json"))
    args = parser.parse_args()
    source = json.loads(args.report.read_text(encoding="utf-8-sig"))["checks"][0]
    rows, buffers = [], {}
    for case in source["cases"]:
        samples, rate = sf.read(args.directory / case["file"], always_2d=True)
        row = {**case, "wideband": decay(samples, rate), "bands": {}}
        for centre in (250, 1000, 4000):
            sos = butter(2, [centre / math.sqrt(2), centre * math.sqrt(2)], btype="bandpass", fs=rate, output="sos")
            row["bands"][str(centre)] = decay(sosfilt(sos, samples, axis=0), rate)
        rows.append(row)
        if case["kind"] == "rate" and rate == 48000:
            buffers[(case["type"], case["mode"])] = samples
    parity = [{"type": t, "maxError": float(np.abs(buffers[t, 0] - buffers[t, 1]).max())}
              for t in sorted({key[0] for key in buffers})]
    rates = []
    for t in sorted({r["type"] for r in rows if r["kind"] == "rate"}):
        for band in ("250", "1000", "4000"):
            result = {"type": t, "bandHz": int(band)}
            for mode, name in ((0, "legacy"), (1, "corrected")):
                fits = [r["bands"][band]["fitDiagnostic"] for r in rows
                        if r["kind"] == "rate" and r["type"] == t and r["mode"] == mode]
                times = [f["t20ExtrapolatedSeconds"] for f in fits if f]
                result[name] = {"rangeSeconds": [min(times), max(times)], "maxToMinRatio": max(times) / min(times)} if times else None
            rates.append(result)
    report = {"status": "diagnostic_only", "subjectiveQuality": "not_asserted", "secondsPerResponse": 20,
              "notes": "Causal octave-band filters; Schroeder energy decay -5..-25 dB fit. Estimates are not guaranteed knob RT60. Rate differences also include delay interpolation, resampling, filters and modulation.",
              "reference48kParity": parity, "rateDecayRanges": rates, "cases": rows}
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"responses": len(rows), "reference48kMaxError": max(r["maxError"] for r in parity), "output": str(args.output)}))


if __name__ == "__main__":
    main()
