"""Prepare diagnostic RMS-matched wet-only Reverb examples and a local player.

This is QA tooling: production DSP never reads these files. Whole-file stereo
RMS is not perceived loudness; synthetic-vowel is not a recorded human voice.
"""
from __future__ import annotations

import argparse
import html
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf

TYPE_NAMES = (
    "Room", "Hall", "Plate", "Chamber", "Spring", "Shimmer", "Nonlinear", "Convolution",
    "Church", "Ambience", "Vintage hall", "Vintage random", "Contour room", "Open hall", "Diffuse loop",
    "Magnetic heads", "Positioned room", "Rising space", "Bloom field", "Cloud field", "Vowel hall",
    "Drifting hall", "Drifting chamber", "Drifting diffuse", "Clear plate", "Clear room", "Clear random",
    "Radiant hall", "Diffuse plate", "Compact room", "Cross chamber", "Ensemble space", "Reflection field",
    "Vault", "Grain hall", "Grain plate", "Shaped reflections", "Long nave", "Grand gallery", "Aperture chamber", "Aperture hall",
)


def prepare(report: Path, destination: Path) -> dict:
    native = json.loads(report.read_text(encoding="utf-8-sig"))
    check = next(item for item in native["checks"] if "listening pack" in item.get("plugin", ""))
    if not check["pass"]:
        raise ValueError("Native export did not pass finite/file sanity")
    raw = Path(check["directory"])
    rows = check["cases"]
    destination.mkdir(parents=True, exist_ok=True)
    measured = []
    for row in rows:
        audio, rate = sf.read(raw / row["file"], dtype="float64", always_2d=True)
        if rate != 48000 or audio.shape != (48000 * 8, 2) or not np.isfinite(audio).all():
            raise ValueError(f"Invalid export: {row['file']}")
        rms = float(np.sqrt(np.mean(np.square(audio))))
        peak = float(np.max(np.abs(audio)))
        if rms <= 0 or peak <= 0:
            raise ValueError(f"Silent export: {row['file']}")
        measured.append({**row, "typeName": TYPE_NAMES[row["type"]], "rawRms": rms, "rawPeak": peak})
    targets = {}
    for material in sorted({row["material"] for row in measured}):
        group = [row for row in measured if row["material"] == material]
        # One shared target per material prevents per-file peak caps from
        # destroying the RMS match. Leave at least 0.9 peak headroom.
        targets[material] = min(10 ** (-26 / 20), *(0.9 * row["rawRms"] / row["rawPeak"] for row in group))
    max_error = 0.0
    for row in measured:
        audio, rate = sf.read(raw / row["file"], dtype="float64", always_2d=True)
        target = targets[row["material"]]
        gain = target / row["rawRms"]
        file = destination / row["file"]
        sf.write(file, audio * gain, rate, subtype="FLOAT")
        decoded, _ = sf.read(file, dtype="float64", always_2d=True)
        actual = float(np.sqrt(np.mean(np.square(decoded))))
        max_error = max(max_error, abs(actual - target))
        row.update({"matchGainDb": 20 * math.log10(gain), "targetRms": target,
                    "matchedRms": actual, "matchedPeak": float(np.max(np.abs(decoded)))})
    result = {"pass": max_error < 1e-7, "count": len(measured), "matching": "diagnostic_only",
              "method": "8-second whole-file stereo RMS, shared peak-safe target per material",
              "maxRmsError": max_error, "targets": targets, "cases": measured,
              "audioQuality": "not_asserted", "perceivedLoudness": "not_asserted",
              "recordedVoice": "not_asserted", "tailCompleteness": "not_asserted"}
    (destination / "manifest.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    sections = []
    for material in targets:
        cards = []
        for row in measured:
            if row["material"] != material:
                continue
            label = html.escape(row["label"] if row["label"].startswith("Factory-")
                                else row["typeName"] + row["label"][7:])
            file = html.escape(row["file"], quote=True)
            return_level = "Calibrated" if row.get("returnMode", 0) >= 0.5 else "Original"
            cards.append(f'<article><b>{label}</b><small>Type {row["type"]}; return {return_level}; match gain {row["matchGainDb"]:+.1f} dB</small>'
                         f'<audio controls preload="none" src="{file}"></audio></article>')
        sections.append(f'<section><h2>{html.escape(material)}</h2><div class="grid">{"".join(cards)}</div></section>')
    page = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    page += '<title>OpenStudio Reverb listening comparisons</title><style>body{font:16px system-ui;background:#151719;color:#eee;margin:2rem;max-width:1200px}small{display:block;color:#bbb;margin:.4rem 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}article{background:#24272b;padding:1rem;border-radius:.5rem}audio{width:100%}a{color:#89cfff}</style>'
    page += '<h1>OpenStudio Reverb listening comparisons</h1><p>Wet-only examples with a common whole-file RMS within each material. Use the same playback volume. This match is diagnostic and does not prove equal perceived loudness or better sound. All inputs are generated; synthetic-vowel is not a recorded voice. Three seconds of excitation, then five seconds of tail; long tails can be truncated.</p>'
    page += '<p>Compare all 41 modes with Original processing and Original return levels, the eight preserved Factory voices, 41 authored Voiced profiles and the Voiced collection, and six Original/Refined pairs with motion off. Factory examples use Calibrated returns. Each Processing pair uses identical settings apart from Processing. This player compares character after RMS matching; use the <a href="../../reverb-voiced-balance/index.html">authored-voice native Wet/Dry balance player</a> for 50%/100% levels, or the <a href="../../reverb-balance/index.html">default-bank balance player</a>. <a href="manifest.json">Settings and matching manifest</a>; raw native state files are in ../raw.</p>'
    page += ''.join(sections) + '<script>document.addEventListener("play",e=>{if(e.target instanceof HTMLAudioElement)document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()})},true)</script></html>'
    (destination / "index.html").write_text(page, encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("output/reverb-listening/matched"))
    args = parser.parse_args()
    result = prepare(args.report, args.output_dir)
    print(json.dumps({key: result[key] for key in ("pass", "count", "maxRmsError", "matching", "audioQuality")}))
    raise SystemExit(0 if result["pass"] else 1)
