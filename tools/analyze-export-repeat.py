"""Diagnostic comparison of two exports of the same QA fixture, not an audio-quality verdict."""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.io import wavfile

parser = argparse.ArgumentParser()
parser.add_argument("report", type=Path)
args = parser.parse_args()
report = json.loads(args.report.read_text(encoding="utf-8-sig"))
artifacts = report["automationAudioArtifacts"]
rate, first = wavfile.read(artifacts["wet-base"])
repeat_rate, repeat = wavfile.read(artifacts["wet-repeat"])
assert rate == repeat_rate and first.shape == repeat.shape
first, repeat = first.astype(np.float64), repeat.astype(np.float64)
assert np.isfinite(first).all() and np.isfinite(repeat).all()
start = next(check["detail"]["timelineStart"] for check in report["automationEditorChecks"] if check["name"] == "render_wet-base")
windows = []
for left, right in [(5.5, 6.5), (8, 9), (11, 12.5)]:
    a, b = first[round((left-start)*rate):round((right-start)*rate)], repeat[round((left-start)*rate):round((right-start)*rate)]
    rms_a, rms_b = np.sqrt(np.mean(a*a)), np.sqrt(np.mean(b*b))
    windows.append(dict(timelineStart=left, timelineEnd=right, firstRMS=float(rms_a), repeatRMS=float(rms_b),
                        repeatMinusFirstDB=float(20*np.log10(max(rms_b, 1e-20)/max(rms_a, 1e-20))),
                        maxDifference=float(np.max(np.abs(a-b)))))
result = dict(classification="diagnostic_only", sampleRate=rate, maxDifference=float(np.max(np.abs(first-repeat))), windows=windows,
              subjectiveQuality="not_asserted")
target = args.report.parent / "wet-repeat-diagnostic.json"
target.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result, indent=2))
