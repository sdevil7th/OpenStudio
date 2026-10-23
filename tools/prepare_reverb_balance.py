"""Build a local native-level Reverb balance player without normalizing audio.

This QA tool references native WAVs unchanged, or copies their bytes unchanged
when publishing to another directory. Native RMS diagnostics do not establish
perceived loudness, wet-return audibility, dominance, or subjective quality.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import html
import json
import math
from pathlib import Path
from reverb_qa_common import finite_number, load_json, publish_audio, result_directory, wav_metadata, write_player


MATERIALS = ("percussion", "synthetic-vowel", "sustained-chord")
VARIANTS = ("dry", "original100", "calibrated50", "calibrated100")
METRICS = ("dryRms", "wet50Rms", "wet100Rms", "wet50VsDryDb", "wet100VsDryDb")
OPTIONAL_METRICS = ("originalWet100Rms", "original100VsDryDb", "calibrationDb",
                    "wetHalfMaxError", "calibrationMaxError", "wetTailEnergy")


@dataclass(frozen=True)
class PlayerConfiguration:
    title: str = "OpenStudio Reverb native balance"
    materials: tuple[tuple[str, str], ...] = (
        ("percussion", "Percussion (generated)"),
        ("synthetic-vowel", "Synthetic vowel (generated)"),
        ("sustained-chord", "Sustained chord (generated)"),
    )
    variants: tuple[tuple[str, str], ...] = (
        ("dry", "Dry only - 70%"), ("original100", "Original return - Wet 100%"),
        ("calibrated50", "Calibrated return - Wet 50%"),
        ("calibrated100", "Calibrated return - Wet 100%"),
    )
    introduction: str = "All sources are generated; synthetic vowel is not a recorded human voice."
    authored_output: bool = False
    optional_metrics: tuple[str, ...] = OPTIONAL_METRICS


DEFAULT_CONFIGURATION = PlayerConfiguration()

HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title><link rel="stylesheet" href="player.css">
</head><body><main>
<h1>__TITLE__</h1>
<p>These native mixed outputs use <strong>Dry 70% and __OUTPUT__</strong>.
The dry-only reference also uses Dry 70%. <strong>No normalization or RMS matching</strong>
has been applied. Keep the same playback volume when comparing.</p>
<p>Return level Original / Calibrated is separate from Processing Original / Refined.
__INTRO__
RMS measurements are <code>diagnostic_only</code>. Audibility, dominance, perceived
loudness and audio quality are <code>not_asserted</code>; listening is required.</p>
<div class="selectors">
<label>Reverb type<select id="type" aria-label="Reverb type"></select></label>
<label>Source material<select id="material" aria-label="Source material"></select></label>
</div>
<h2 id="selection" role="status" aria-live="polite"></h2>
<p id="native-status"></p>
<section class="cards" aria-label="Native balance audio comparisons"></section>
<section aria-labelledby="diagnostics-heading">
<h2 id="diagnostics-heading">Native RMS diagnostics</h2>
<p>These are native wet/dry component measurements. The players above contain the
mixed output, except the dry-only reference. Ratios do not prove which component
sounds dominant. The native report defines the measurement window.</p>
<p id="measurement-window"></p><dl id="metrics"></dl><p id="peaks"></p>
</section>
<p><a href="manifest.json">Native levels and file manifest</a></p>
</main><script id="balance-data" type="application/json">__DATA__</script>
<script src="player.js"></script></body></html>
"""

CSS = """*{box-sizing:border-box}body{margin:0;background:#151719;color:#eee;font:16px/1.5 system-ui}
main{max-width:1150px;margin:auto;padding:clamp(16px,3vw,32px)}h1{font-size:clamp(26px,4vw,36px);line-height:1.2}
h2{font-size:22px;line-height:1.3}h3{margin:0 0 8px;font-size:18px}p{overflow-wrap:anywhere}
a{color:#89cfff}code{color:#c6d8e8}.selectors{display:flex;flex-wrap:wrap;gap:16px;margin:24px 0}
label{display:flex;flex:1 1 240px;min-width:0;flex-direction:column;gap:6px}select{min-width:0;min-height:44px;
padding:8px;border:1px solid #8894a0;border-radius:5px;font:inherit;color:#eee;background:#24272b}
:focus-visible{outline:3px solid #89cfff;outline-offset:3px}.cards{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
article{min-width:0;padding:16px;background:#24272b;border-radius:8px}article p{font-size:14px;color:#c6cbd1;margin:0 0 12px}
audio{display:block;width:100%;min-width:0}dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px}
dt{overflow-wrap:anywhere}dd{margin:0;font-variant-numeric:tabular-nums;text-align:right}
@media(min-width:700px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
"""

JS = """'use strict';
const pack=JSON.parse(document.getElementById('balance-data').textContent);
const type=document.getElementById('type'),material=document.getElementById('material');
const materialNames=pack.playerConfiguration.materialNames;
const variants=pack.playerConfiguration.variants;
const cards=document.querySelector('.cards'),players={};
for(const [key,title] of variants){
 const card=document.createElement('article'),heading=document.createElement('h3'),note=document.createElement('p'),audio=document.createElement('audio');
 heading.id='title-'+key;heading.textContent=title;note.id='note-'+key;note.textContent='Native mixed output; Dry 70%. Output trim follows the selected voice.';
 audio.controls=true;audio.preload='metadata';audio.dataset.variant=key;audio.setAttribute('aria-labelledby',heading.id);audio.setAttribute('aria-describedby',note.id);
 card.append(heading,note,audio);cards.append(card);players[key]=audio;
}
const names=new Map(pack.cases.map(row=>[row.type,row.name]));
for(const [value,name] of [...names].sort((a,b)=>a[0]-b[0]))type.add(new Option(String(value+1).padStart(2,'0')+' '+name,String(value)));
for(const value of pack.materials)material.add(new Option(materialNames[value],value));
const measurements=[['dryRms','Dry 70% RMS',false],['originalWet100Rms','Original wet component RMS at 100%',false],['wet50Rms','Calibrated wet component RMS at 50%',false],['wet100Rms','Calibrated wet component RMS at 100%',false],['original100VsDryDb','Original wet 100% / dry 70%',true],['wet25VsDryDb','Calibrated wet 25% / dry 70%',true],['wet50VsDryDb','Calibrated wet 50% / dry 70%',true],['wet75VsDryDb','Calibrated wet 75% / dry 70%',true],['wet100VsDryDb','Calibrated wet 100% / dry 70%',true],['calibrationDb','Fixed return calibration trim',true]];
function show(){
 const row=pack.cases.find(item=>item.type===Number(type.value)&&item.material===material.value);
 for(const [key] of variants){const audio=players[key];audio.pause();audio.currentTime=0;audio.src=row.files[key];audio.load();}
 document.getElementById('selection').textContent=row.name+' — '+materialNames[row.material];
 document.getElementById('native-status').textContent=names.size+' reverb types × '+pack.materials.length+' materials; native check: '+pack.nativeStatus+'. Output '+row.outputTrimDb+' dB. Files are played at their native mixed levels.'+(pack.nativeSettings.processing?' Processing: '+pack.nativeSettings.processing+'.':'');
 const excitation=row.excitationSeconds??pack.nativeSettings.excitationSeconds;
 document.getElementById('measurement-window').textContent=excitation?'RMS window: the first '+excitation+' seconds of excitation; '+pack.nativeSettings.seconds+' seconds of audio including the tail.':'';
 const metrics=document.getElementById('metrics');metrics.replaceChildren();
 for(const [key,label,db] of measurements){if(!(key in row))continue;const term=document.createElement('dt'),value=document.createElement('dd');term.textContent=label;const n=row[key];value.textContent=db?(n>=0?'+':'')+n.toFixed(2)+' dB':n.toPrecision(6);metrics.append(term,value);}
 document.getElementById('peaks').textContent=row.peaks?'Reported native sample peaks: '+Object.entries(row.peaks).map(([key,value])=>key+' '+Number(value).toPrecision(5)).join('; '):'';
 if(row.samplesAboveUnityDiagnostic)document.getElementById('peaks').textContent+='; samples above 1.0: '+JSON.stringify(row.samplesAboveUnityDiagnostic)+'; samples at ±4 safety bound: '+JSON.stringify(row.samplesAtSafetyBoundDiagnostic);
}
document.addEventListener('play',event=>{if(event.target instanceof HTMLAudioElement)Object.values(players).forEach(audio=>{if(audio!==event.target)audio.pause();});},true);
type.addEventListener('change',show);material.addEventListener('change',show);show();
"""


def balance_result(report: dict, variants: tuple[str, ...] = VARIANTS) -> dict:
    """Accept the standard FreePluginRegression wrapper or one direct result."""
    if not isinstance(report, dict) or ("overallPass" in report and report["overallPass"] is not True):
        raise ValueError("Native report failed its engineering checks")
    candidates = [report, *report.get("checks", [])]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        rows = candidate.get("cases", candidate.get("rows"))
        if isinstance(rows, list) and rows and isinstance(rows[0], dict):
            files = rows[0].get("files", {})
            if isinstance(files, dict) and all(key in files for key in variants):
                if candidate.get("pass") is not True:
                    raise ValueError("Native balance result did not pass")
                return candidate
    raise ValueError("No native Reverb balance result with the requested audio variants was found")


def prepare(result_path: Path, output: Path, configuration: PlayerConfiguration = DEFAULT_CONFIGURATION,
            extra_manifest: dict | None = None) -> dict:
    report = load_json(result_path)
    variants = tuple(key for key, _ in configuration.variants)
    materials = tuple(key for key, _ in configuration.materials)
    native = balance_result(report, variants)
    rows = native.get("cases", native.get("rows"))
    output = output.resolve()
    source = result_directory(native, result_path)
    seen = set()
    prepared = []
    for row in rows:
        kind = row.get("type")
        if isinstance(kind, bool) or not isinstance(kind, int) or not 0 <= kind < 41:
            raise ValueError(f"Invalid reverb type: {kind}")
        material = row.get("material")
        key = (kind, material)
        if material not in materials or key in seen:
            raise ValueError(f"Invalid or duplicate type/material: {key}")
        seen.add(key)
        name = row.get("name", row.get("typeName"))
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"Missing reverb name: {key}")
        item = {"type": kind, "name": name, "material": material,
                "outputTrimDb": finite_number(row.get("outputTrimDb", 0), "outputTrimDb")}
        if not -60 <= item["outputTrimDb"] <= 12:
            raise ValueError(f"Output trim is outside the native control range: {key}")
        for metric in (*METRICS, *(key for key in configuration.optional_metrics if key in row)):
            number = row.get(metric)
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
                raise ValueError(f"Invalid {metric}: {key}")
            if metric.endswith("Rms") and number < 0:
                raise ValueError(f"Negative {metric}: {key}")
            item[metric] = number
        for flag in ("pass", "finite", "filesWritten"):
            if row.get(flag) is not True:
                raise ValueError(f"Missing or failed {flag}: {key}")
            item[flag] = True
        if "peaks" in row:
            peaks = row["peaks"]
            if not isinstance(peaks, dict) or any(isinstance(n, bool) or not isinstance(n, (int, float))
                                                  or not math.isfinite(n) or n < 0 for n in peaks.values()):
                raise ValueError(f"Invalid sample peaks: {key}")
            item["peaks"] = peaks
        item["files"] = {}
        item["wavMetadata"] = {}
        item["sourceFiles"] = {}
        if set(row.get("files", {})) != set(variants):
            raise ValueError(f"Expected exactly {len(variants)} audio variants: {key}")
        for counter in ("samplesAboveUnityDiagnostic", "samplesAtSafetyBoundDiagnostic"):
            if counter in row:
                counts = row[counter]
                if not isinstance(counts, dict) or set(counts) != set(variants) or any(
                    isinstance(n, bool) or not isinstance(n, int) or n < 0 for n in counts.values()
                ):
                    raise ValueError(f"Invalid {counter}: {key}")
                item[counter] = counts
        for variant in variants:
            filename = row.get("files", {}).get(variant)
            if not isinstance(filename, str) or not filename:
                raise ValueError(f"Missing {variant} WAV: {key}")
            path = Path(filename)
            path = (path if path.is_absolute() else source / path).resolve()
            item["wavMetadata"][variant] = wav_metadata(path)
            item["sourceFiles"][variant] = str(path)
        prepared.append(item)
    expected = {(kind, material) for kind in range(41) for material in materials}
    if seen != expected:
        raise ValueError(f"Expected {len(expected)} complete type/material rows; found {len(seen)}")
    names = {kind: {row["name"] for row in prepared if row["type"] == kind} for kind in range(41)}
    if any(len(values) != 1 for values in names.values()):
        raise ValueError("A reverb type has inconsistent names across materials")
    if "dry" in native and not math.isclose(float(native["dry"]), .7, abs_tol=1e-6):
        raise ValueError("This player expects native Dry 70%")
    authored = native.get("outputDb") == "authored_per_voice"
    if authored and not configuration.authored_output:
        raise ValueError("This player configuration does not accept authored Output trims")
    if not authored and finite_number(native.get("outputDb", 0), "outputDb") != 0:
        raise ValueError("Expected Output 0 dB or declared authored_per_voice trims")
    output.mkdir(parents=True, exist_ok=True)
    for row in prepared:
        for variant in variants:
            source_file = Path(row["sourceFiles"][variant])
            row["files"][variant] = publish_audio(source_file, output, f"type-{row['type']:02}-{row['material']}-{variant}.wav")
    manifest = {"pass": True, "count": len(prepared), "audioFileCount": len(prepared) * len(variants),
                "nativeStatus": "pass" if native.get("pass") is True else "fail" if native.get("pass") is False else "not_asserted",
                "normalization": "none", "dryLevel": .7, "outputTrimDb": "authored_per_voice" if authored else 0,
                "rmsMeasurements": "diagnostic_only", "audibility": "not_asserted",
                "dominance": "not_asserted", "perceivedLoudness": "not_asserted", "audioQuality": "not_asserted",
                "result": str(result_path.resolve()), "materials": list(materials), "cases": prepared,
                "playerConfiguration": {"materialNames": dict(configuration.materials), "variants": configuration.variants}}
    manifest["nativeSettings"] = {key: native[key] for key in ("sampleRate", "seconds", "excitationSeconds", "dry", "outputDb", "processing") if key in native}
    manifest.update(extra_manifest or {})
    page = HTML.replace("__TITLE__", html.escape(configuration.title)).replace("__INTRO__", configuration.introduction)
    page = page.replace("__OUTPUT__", "authored Output trims" if authored else "Output 0 dB")
    write_player(output, manifest, page, CSS, JS)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", type=Path, default=Path("output/reverb-final/reverb-balance-release.json"))
    parser.add_argument("--output", type=Path, default=Path("output/reverb-balance"))
    args = parser.parse_args()
    try:
        manifest = prepare(args.result, args.output)
    except (OSError, ValueError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps({key: manifest[key] for key in ("pass", "count", "audioFileCount", "nativeStatus", "normalization", "audioQuality")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
