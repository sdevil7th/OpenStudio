"""Check objective guitar automation consequences; sound quality is not asserted."""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.io import wavfile

parser = argparse.ArgumentParser()
parser.add_argument("report", type=Path)
args = parser.parse_args()
result = json.loads(args.report.read_text(encoding="utf-8-sig"))
if not result.get("success"):
    raise SystemExit("Native export fixture failed")
files = result["automationAudioArtifacts"]
audio = {}
for name, path in files.items():
    rate, data = wavfile.read(path)
    if data.dtype.kind == "i":
        data = data.astype(np.float64) / np.iinfo(data.dtype).max
    audio[name] = data.astype(np.float64)
    if rate != 44100 or data.shape != (352800, 2) or not np.isfinite(data).all():
        raise SystemExit(f"Invalid audio output: {name}")

checks = []
def check(name, passed, detail):
    checks.append(dict(name=name, passed=bool(passed), detail=detail))
def rms(data):
    return float(np.sqrt(np.mean(data ** 2)))
def gain_db(reference, actual):
    return float(20 * np.log10(rms(actual) / rms(reference)))
def peak_error(a, b):
    return float(np.max(np.abs(a - b)))

for name, data in audio.items():
    check(f"non_silent_{name}", rms(data) > .001, {"rms": rms(data)})
check("dry_repeat_exact", peak_error(audio["dry-base"], audio["dry-repeat"]) == 0,
      peak_error(audio["dry-base"], audio["dry-repeat"]))
comparisons = [(chain, "dry-base", f"dry-gain-{chain}") for chain in ["track", "input"]]
if "wet-nam-output" in audio:
    comparisons.append(("nam_output", "wet-base", "wet-nam-output"))
for chain, baseline_name, automated_name in comparisons:
    for section, start, end, expected in [("before", 5.5, 6.5, 0), ("held", 8, 9, -12), ("after", 11, 12.5, 0)]:
        window = slice(round((start-5)*44100), round((end-5)*44100))
        source_rms = rms(audio[baseline_name][window])
        check(f"{chain}_gain_{section}_source_is_audible", source_rms > .001,
              {"timelineStart": start, "timelineEnd": end, "sourceRMS": source_rms})
        measured = gain_db(audio[baseline_name][window], audio[automated_name][window])
        check(f"{chain}_gain_{section}", abs(measured-expected) < .01,
              {"timelineStart": start, "timelineEnd": end, "expectedDB": expected, "measuredDB": measured})
for prefix in ["dry", "wet"]:
    measured = gain_db(audio[f"{prefix}-base"], audio[f"{prefix}-minus6"])
    check(f"{prefix}_trim_minus6", abs(measured+6) < .01, {"expectedDB": -6, "measuredDB": measured})
for name in ["frozen", "undo"]:
    error = peak_error(audio["dry-minus6"], audio[f"dry-{name}"])
    check(f"dry_trim_{name}_parity", error < 1e-7, error)
for artifact, evidence, expected in [
        ("dry-punch", "native_punch_records_audible_pass", -12),
        ("dry-auto-join", "native_auto_join_holds_after_boundary", -12),
        ("dry-auto-trim", "native_trim_coalesces_after_pass", -6),
        ("dry-auto-trim-undo", "native_trim_coalesces_after_pass", 0)]:
    if artifact not in audio:
        continue
    detail = next(item["detail"] for item in result["automationEditorChecks"] if item["name"] == evidence)
    start, end = detail["timelineStart"], detail["timelineEnd"]
    if start < 4 or end <= start:
        raise SystemExit("Advanced writing window did not cover the played guitar")
    window = slice(round((start-5)*44100), round((end-5)*44100))
    source_rms = rms(audio["dry-base"][window])
    check(artifact+"_source_is_audible", source_rms > .001, dict(timelineStart=start, timelineEnd=end, sourceRMS=source_rms))
    measured = gain_db(audio["dry-base"][window], audio[artifact][window])
    check(artifact+"_gain", abs(measured-expected) < .01, dict(expectedDB=expected, measuredDB=measured))
wet_diagnostics = {
    "status": "diagnostic_only",
    "baselineRepeatMaxAbsoluteError": peak_error(audio["wet-base"], audio["wet-repeat"]),
    "trimRepeatMaxAbsoluteError": peak_error(audio["wet-minus6"], audio["wet-minus6-repeat"]),
    "freezeMaxAbsoluteError": peak_error(audio["wet-minus6"], audio["wet-frozen"]),
    "undoMaxAbsoluteError": peak_error(audio["wet-minus6"], audio["wet-undo"]),
}
summary = {"status": "pass" if all(item["passed"] for item in checks) else "fail",
           "timelineStart": 5, "timelineEnd": 13, "checks": checks,
           "wetRepeatability": wet_diagnostics, "soundQuality": "not_asserted"}
output = args.report.with_name("audio-comparison.json")
output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps(summary, indent=2))
raise SystemExit(0 if summary["status"] == "pass" else 1)
