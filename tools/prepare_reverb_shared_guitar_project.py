#!/usr/bin/env python3
"""Publish unchanged native renders of the user's guitar project for local QA.

Levels, noise floor and residual wet RMS are diagnostics, never listening proof.
The project and recording are read-only inputs; no WAV is normalized or rewritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
from urllib.parse import unquote

import numpy as np

from reverb_qa_common import (finite_number, load_json, publish_audio, result_directory,
                              source_project_evidence, wav_metadata, write_player)

VARIANTS = ("dry", "wet25", "wet50", "wet75", "wet100")

HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shared guitar project — OpenStudio Reverb</title><link rel="stylesheet" href="player.css"></head>
<body><main><h1>Shared guitar project — OpenStudio Reverb</h1>
<p>The existing recording and saved NAM Rack sound are retained. Standalone Reverb follows NAM Rack.
The initial quiet lead-in is included; two bars at 120 BPM last four seconds.</p>
<p>All mixes use <strong>Dry 70%, __OUTPUT__ and Calibrated return</strong> with the authored voice settings.
The baseline is the existing project without standalone Reverb. <strong>No source scaling, normalization
or output level matching</strong> is applied. Keep the same playback volume while comparing.</p>
<p id="monitor"></p>
<p>Finite output and measurable change are engineering checks. Audibility, intended character and
musical quality remain <code>not_asserted</code> until listening. Full-scale counts below are diagnostics.</p>
<div class="controls"><label>Authored reverb voice<select id="voice" aria-label="Authored reverb voice"></select></label>
<label>Comparison start<select id="start" aria-label="Comparison start"><option value="0">Beginning — quiet lead-in retained</option>
<option id="onset" value="0">Guitar onset — measured from the native source timeline</option></select></label></div>
<h2 id="selection" role="status" aria-live="polite"></h2>
<section id="cards" aria-label="Project volume comparisons"></section>
<h2>Measured changes</h2><p id="metrics"></p><p id="drypath"></p><p id="clipping"></p>
<p><a href="manifest.json">Native files and diagnostics</a> · <a href="source-project-evidence.json">Source project evidence</a></p>
</main><script id="pack" type="application/json">__DATA__</script><script src="player.js"></script></body></html>
"""

CSS = """*{box-sizing:border-box}body{margin:0;background:#16191c;color:#eee;font:16px/1.5 system-ui}
main{max-width:1160px;margin:auto;padding:clamp(16px,3vw,32px)}h1{font-size:clamp(26px,4vw,36px);line-height:1.2}
h2{font-size:22px;line-height:1.3}h3{font-size:18px;margin:0 0 8px}p{overflow-wrap:anywhere}a{color:#9bd1ff}
.controls{display:flex;flex-wrap:wrap;gap:16px;margin:24px 0}label{display:flex;flex:1 1 280px;min-width:0;flex-direction:column;gap:6px}
select,button{font:inherit;min-height:44px;border:1px solid #92a2af;border-radius:5px;padding:8px;background:#252b30;color:#eee}
select{width:100%;min-width:0}:focus-visible{outline:3px solid #9bd1ff;outline-offset:3px}
#cards{display:flex;flex-wrap:wrap;gap:16px}article{flex:1 1 320px;min-width:0;border-radius:8px;padding:16px;background:#252b30}
article p{font-size:14px;color:#d2dae0;margin:0 0 12px}audio{display:block;width:100%;min-width:0}button{margin-top:12px;cursor:pointer}
"""

JS = """'use strict';
const pack=JSON.parse(document.getElementById('pack').textContent);
const voice=document.getElementById('voice'),start=document.getElementById('start');
const onset=pack.sourceEvidence.timelineOnsetDiagnostic.rms_db_-30;
document.getElementById('onset').value=String(onset);
document.getElementById('onset').textContent=(pack.sourceEvidence.timelineOnsetDiagnostic.thresholdReached?'Guitar onset - approximately ':'Clip start - no -30 dBFS window detected; ')+onset.toFixed(2)+' seconds';
const variants=[['baseline','Existing project — no standalone Reverb'],['dry','Wet 0% — Dry 70%'],['wet25','Wet 25% — Dry 70%'],['wet50','Wet 50% — Dry 70%'],['wet75','Wet 75% — Dry 70%'],['wet100','Wet 100% — Dry 70%']];
if(pack.beforePack)variants.push(['before50','Before corrections — Wet 50% / Output 0 dB'],['before100','Before corrections — Wet 100% / Output 0 dB']);
const players={};
for(const [key,title] of variants){
 const card=document.createElement('article'),h=document.createElement('h3'),note=document.createElement('p'),audio=document.createElement('audio'),button=document.createElement('button');
 h.id='title-'+key;h.textContent=title;note.textContent=key==='baseline'?'Saved guitar project and NAM Rack, without standalone Reverb.':key.startsWith('before')?'Previous native mix, Calibrated return and Output 0 dB. No output normalization.':'Native mix, Calibrated return. Output trim is shown with the selected voice. No output normalization.';
 audio.controls=true;audio.preload='metadata';audio.dataset.variant=key;audio.volume=pack.monitorGain;audio.setAttribute('aria-labelledby',h.id);
 button.type='button';button.textContent='Play from comparison start';button.setAttribute('aria-label','Play '+title+' from comparison start');
 button.addEventListener('click',()=>{for(const p of Object.values(players))p.pause();audio.currentTime=Number(start.value);audio.play().catch(()=>{});});
 audio.addEventListener('play',()=>{for(const p of Object.values(players))if(p!==audio)p.pause();});
 card.append(h,note,audio,button);document.getElementById('cards').append(card);players[key]=audio;
}
document.getElementById('monitor').textContent='Browser monitor trim: '+pack.monitorTrimDb+' dB, identical for every current and previous file. Native WAVs are unchanged. Keep this common playback level for comparisons.';
for(const row of pack.cases)voice.add(new Option(String(row.type+1).padStart(2,'0')+' '+row.name,String(row.type)));
function show(){
 const row=pack.cases.find(x=>x.type===Number(voice.value));
 for(const [key] of variants){const p=players[key];p.pause();p.src=key==='baseline'?pack.baselineFile:(row.beforeFiles?.[key]??row.files[key]);p.load();}
 document.getElementById('selection').textContent=row.name+' — Output '+row.outputTrimDb+' dB';
 document.getElementById('metrics').textContent='Guitar-window wet component / Dry 70% RMS: '+['wet25','wet50','wet75','wet100'].map(key=>key.replace('wet','Wet ')+'% '+row.diagnostics.activeWetVsDryDb[key].toFixed(2)+' dB').join('; ')+'. Diagnostic only; this is not perceived loudness or dominance.';
 document.getElementById('drypath').textContent='Wet 0% versus 70% of the saved NAM baseline with the same Output trim: maximum sample difference '+row.diagnostics.dryBaselineDifferenceMax.toExponential(3)+". Dry-path coloring or spatial routing can remain active in some voices even at Wet 0%. Wet-component diagnostics subtract each voice's own Wet 0% render.";
 document.getElementById('clipping').textContent='Native sample peaks: '+Object.entries(row.diagnostics.peaks).map(([key,value])=>key+' '+value.toFixed(4)).join('; ')+'. Samples above 1.0: '+JSON.stringify(row.diagnostics.samplesAboveUnity)+'. Samples at the ±4 safety bound: '+JSON.stringify(row.diagnostics.samplesAtSafetyBound)+'. Unity playback can clip above full scale; the common browser monitor trim provides headroom without changing the native files.';
}
voice.addEventListener('change',show);start.addEventListener('change',()=>{for(const p of Object.values(players)){p.pause();p.currentTime=Number(start.value);}});
window.addEventListener('pagehide',()=>{for(const p of Object.values(players))p.pause();});show();
"""


def samples(path: Path) -> np.ndarray:
    """Read the native 32-bit IEEE float WAV without changing its data."""
    metadata = wav_metadata(path)
    if metadata["channels"] != 2 or metadata["bits"] != 32 or metadata["format"] != 3:
        raise ValueError(f"Expected native stereo 32-bit WAV: {path}")
    with path.open("rb") as stream:
        header = stream.read(12)
        end = struct.unpack_from("<I", header, 4)[0] + 8
        chunks = []
        while stream.tell() + 8 <= end:
            kind, size = struct.unpack("<4sI", stream.read(8))
            data = stream.read(size)
            if kind == b"data":
                chunks.append(data)
            if size % 2:
                stream.read(1)
    values = np.frombuffer(b"".join(chunks), dtype="<f4").reshape(-1, 2)
    if not np.isfinite(values).all():
        raise ValueError(f"Nonfinite native audio: {path}")
    return values


def rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values, dtype=np.float64))))


def prepare(report_path: Path, output: Path, before_pack: Path | None = None) -> dict:
    report = load_json(report_path)
    candidates = [check for check in report.get("checks", []) if check.get("caseCount") == 41 and "baselineFile" in check]
    if len(candidates) != 1:
        raise ValueError("Expected exactly one complete native shared-project result")
    native = candidates[0]
    if report.get("overallPass") is not True or native.get("pass") is not True:
        raise ValueError("Native project rendering did not pass its engineering checks")
    directory = result_directory(native, report_path)
    rate = native["sampleRate"]
    timeline_path = directory / native["sourceTimelineFile"]
    if wav_metadata(timeline_path)["sampleRate"] != rate:
        raise ValueError("Source timeline sample rate differs from the native report")
    evidence = source_project_evidence(native, report_path, samples(timeline_path), rate)
    start_frame = round(evidence["timelineOnsetDiagnostic"]["rms_db_-30"] * rate)
    end_frame = round((evidence["clipStartSeconds"] + evidence["sourceDurationSeconds"]) * rate)
    baseline = directory / native["baselineFile"]
    if wav_metadata(baseline)["sampleRate"] != rate:
        raise ValueError("Baseline sample rate differs from the native report")
    baseline_samples = samples(baseline)
    if not 0 <= start_frame < end_frame <= len(baseline_samples):
        raise ValueError("Invalid diagnostic guitar measurement window")
    cases = []
    seen = set()
    for row in native["cases"]:
        if (isinstance(row.get("type"), bool) or not isinstance(row.get("type"), int)
                or row["type"] not in range(41) or row["type"] in seen
                or set(row["files"]) != set(VARIANTS)
                or any(row.get(flag) is not True for flag in ("pass", "finite", "filesWritten"))):
            raise ValueError("Expected one complete five-volume row per type")
        seen.add(row["type"])
        if any(wav_metadata(directory / filename)["sampleRate"] != rate for filename in row["files"].values()):
            raise ValueError("Mixed capture sample rate differs from the native report")
        rendered = {key: samples(directory / row["files"][key]) for key in VARIANTS}
        if any(value.shape != baseline_samples.shape for value in rendered.values()):
            raise ValueError("Mismatched project time spans")
        trim = finite_number(row.get("outputTrimDb", 0), "outputTrimDb")
        if not -60 <= trim <= 12:
            raise ValueError("Output trim is outside the native control range")
        dry_error = float(np.max(np.abs(rendered["dry"] - .7 * 10**(trim/20) * baseline_samples)))
        dry = rendered["dry"][start_frame:end_frame]
        dry_rms = rms(dry)
        wet_rms = {key: rms(value[start_frame:end_frame] - dry) for key, value in rendered.items() if key != "dry"}
        diagnostic = {
            "status": "diagnostic_only", "activeWindowSeconds": [start_frame / rate, end_frame / rate],
            "dryRms": dry_rms, "activeWetRms": wet_rms,
            "dryBaselineDifferenceMax": dry_error,
            "activeWetVsDryDb": {key: 20 * math.log10(max(value, 1e-30) / max(dry_rms, 1e-30)) for key, value in wet_rms.items()},
            "peaks": {key: float(np.max(np.abs(value))) for key, value in rendered.items()},
            "samplesAboveUnity": {key: int(np.count_nonzero(np.abs(value) > 1)) for key, value in rendered.items()},
            "samplesAtSafetyBound": {key: int(np.count_nonzero(np.abs(value) >= 4)) for key, value in rendered.items()},
            "initialFourSecondsMixedRms": {key: rms(value[:round(4 * rate)]) for key, value in rendered.items()},
            "wet100PcmSha256": hashlib.sha256(rendered["wet100"].tobytes()).hexdigest(),
            "quarterScaleMaxError": {key: float(np.max(np.abs((rendered[key] - rendered['dry']) - amount * (rendered['wet100'] - rendered['dry'])))) for key, amount in [('wet25', .25), ('wet50', .5), ('wet75', .75)]},
        }
        phrase_end = min(end_frame, start_frame + round(8 * rate))
        phrase_dry = rendered["dry"][start_frame:phrase_end]
        phrase_dry_rms = rms(phrase_dry)
        diagnostic["firstEightGuitarSecondsWetVsDryDb"] = {
            key: 20 * math.log10(max(rms(value[start_frame:phrase_end] - phrase_dry), 1e-30) / max(phrase_dry_rms, 1e-30))
            for key, value in rendered.items() if key != "dry"
        }
        cases.append({"type": row["type"], "name": row.get("presetName", row.get("typeName", row.get("name"))),
                      "sourceFiles": {key: str(directory / filename) for key, filename in row["files"].items()},
                      "outputTrimDb": trim, "diagnostics": diagnostic})
    if seen != set(range(41)):
        raise ValueError("Missing reverb voices")
    manifest = {"nativeReport": str(report_path), "nativeStatus": "pass", "audioQuality": "not_asserted",
                "audibility": "not_asserted", "intendedCharacter": "not_asserted", "dominance": "not_asserted",
                "sourceEvidence": evidence, "sampleRate": rate, "cases": cases, "caseCount": 41,
                "fileCount": 206, "nativeMetadata": native.get("metadata"), "upstreamLatencySamples": native.get("upstreamLatencySamples"),
                "nativeRenderSeconds": native.get("renderSeconds"), "outputLevelMatching": False, "inputScaling": 1,
                "baselineFile": ""}
    manifest["uniqueWet100PcmFiles"] = len({row["diagnostics"]["wet100PcmSha256"] for row in cases})
    manifest["maximumDryBaselineDifferenceDiagnostic"] = max(row["diagnostics"]["dryBaselineDifferenceMax"] for row in cases)
    manifest["dryBaselineDifferenceStatus"] = "diagnostic_only; colored and spatial direct paths may intentionally differ."
    maximum_peak = max(float(np.max(np.abs(baseline_samples))),
                       max(max(row["diagnostics"]["peaks"].values()) for row in cases))
    mixed_peak = max(max(row["diagnostics"]["peaks"].values()) for row in cases)
    if native.get("outputDb") == "authored_per_voice":
        headroom_pass = mixed_peak <= 10 ** (-3 / 20) + 1e-6
        manifest["referenceHeadroom"] = {
            "status": "pass" if headroom_pass else "fail", "targetDb": 3,
            "maximumMixedPeak": mixed_peak, "observedDb": -20 * math.log10(mixed_peak),
            "scope": "Authored trims on the unchanged source fixture, Dry70/Wet0..100; not arbitrary-source or Hold headroom."
        }
        if not headroom_pass:
            raise ValueError("Authored reference mixes missed the 3 dB sample-peak headroom target")
    monitor_trim_db = min(0, math.floor(20 * math.log10(.89 / max(maximum_peak, 1e-30))))
    if before_pack:
        previous = load_json(before_pack / "manifest.json")
        previous_rows = previous.get("cases", [])
        if previous.get("nativeStatus") != "pass" or len(previous_rows) != 41 or {r.get("type") for r in previous_rows} != set(range(41)):
            raise ValueError("Previous comparison pack must contain 41 qualified voices")
        previous_trim = finite_number(previous.get("monitorTrimDb"), "previous monitorTrimDb")
        if previous_trim > 0:
            raise ValueError("Previous monitor trim must not amplify playback")
        monitor_trim_db=min(monitor_trim_db,previous_trim)
        manifest["beforePack"]=str(before_pack)
        manifest["fileCount"]+=82
        for row in cases:
            old=next(x for x in previous["cases"] if x["type"]==row["type"])
            row["beforeSources"] = {"before" + level: str(before_pack / unquote(old["files"]["wet" + level])) for level in ("50", "100")}
            for path in row["beforeSources"].values():
                wav_metadata(Path(path))
    manifest["outputDb"] = native.get("outputDb",0)
    manifest["maximumNativePeak"] = maximum_peak
    manifest["monitorTrimDb"] = monitor_trim_db
    manifest["monitorGain"] = 10 ** (monitor_trim_db / 20)
    manifest["monitorTrimScope"] = "Identical browser playback gain for all files; native WAV data is unchanged."
    manifest["volumeSummaryDiagnostic"] = {}
    for key in VARIANTS[1:]:
        ratios = [row["diagnostics"]["activeWetVsDryDb"][key] for row in cases]
        phrase_ratios = [row["diagnostics"]["firstEightGuitarSecondsWetVsDryDb"][key] for row in cases]
        manifest["volumeSummaryDiagnostic"][key] = {
            "status": "diagnostic_only", "minimumWetVsDryDb": min(ratios),
            "medianWetVsDryDb": float(np.median(ratios)), "maximumWetVsDryDb": max(ratios),
            "wetAtLeastDryRmsVoiceCount": sum(value >= 0 for value in ratios),
            "minimumFirstEightSecondsWetVsDryDb": min(phrase_ratios),
            "medianFirstEightSecondsWetVsDryDb": float(np.median(phrase_ratios)),
            "maximumFirstEightSecondsWetVsDryDb": max(phrase_ratios),
            "voicesAboveFullScale": sum(row["diagnostics"]["samplesAboveUnity"][key] > 0 for row in cases),
            "samplesAboveFullScale": sum(row["diagnostics"]["samplesAboveUnity"][key] for row in cases),
            "voicesAtSafetyBound": sum(row["diagnostics"]["samplesAtSafetyBound"][key] > 0 for row in cases),
        }
    output.mkdir(parents=True, exist_ok=True)
    manifest["baselineFile"] = publish_audio(baseline, output, "baseline-nam-only.wav")
    for row in cases:
        row["files"] = {key: publish_audio(Path(path), output, f"{row['type']:02}-{key}.wav")
                        for key, path in row.pop("sourceFiles").items()}
        if "beforeSources" in row:
            row["beforeFiles"] = {key: publish_audio(Path(path), output, f"{row['type']:02}-{key}.wav")
                                  for key, path in row.pop("beforeSources").items()}
    (output / "source-project-evidence.json").write_text(json.dumps(evidence, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    page = HTML.replace("__OUTPUT__", "authored Output trims" if native.get("outputDb")=="authored_per_voice" else "Output 0 dB")
    write_player(output, manifest, page, CSS, JS)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=Path("output/reverb-shared-guitar-project/native-release.json"))
    parser.add_argument("--output", type=Path, default=Path("output/reverb-shared-guitar-project"))
    parser.add_argument("--before-pack", type=Path)
    args = parser.parse_args()
    manifest = prepare(args.report.resolve(), args.output.resolve(), args.before_pack.resolve() if args.before_pack else None)
    print(f"PASS: {manifest['caseCount']} voices; {manifest['fileCount']} unchanged native WAVs. Listening: not_asserted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
