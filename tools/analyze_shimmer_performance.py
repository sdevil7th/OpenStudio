"""Summarize recorded Shimmer callbacks; never infer device/audio quality."""
import argparse
import json
from pathlib import Path


def check(path):
    report = json.loads(path.read_text(encoding="utf-8-sig"))
    if not report["overallPass"] or len(report["checks"]) != 1:
        raise ValueError(f"Failed or ambiguous native report: {path}")
    return report["checks"][0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("output/reverb-shimmer-performance"))
    parser.add_argument("--before", type=Path, default=Path("output/reverb-correction/shimmer-instances-final.json"))
    args = parser.parse_args()
    baseline = check(args.before)
    current = check(args.directory / "instances-release-v1.json")
    keys = ("route", "instances", "scheduling", "identicalInput")
    previous_rows = {tuple(row[k] for k in keys): row for row in baseline["cases"]}
    comparisons = []
    for row in current["cases"]:
        before = previous_rows[tuple(row[k] for k in keys)]
        comparisons.append({
            **{key: row[key] for key in keys},
            "before": {k: before[k] for k in ("averageUs", "p99Us", "maxUs", "deadlineOverruns")},
            "after": {k: row[k] for k in ("averageUs", "p99Us", "maxUs", "deadlineOverruns")},
            "averageReductionPercent": 100 * (1 - row["averageUs"] / before["averageUs"]),
            "p99ReductionPercent": 100 * (1 - row["p99Us"] / before["p99Us"]),
        })
    matrix, workloads = [], []
    paths = [args.directory / "instances-release-v1.json", *sorted(args.directory.glob("timing-[0-9]*-[0-9]*.json"))]
    for path in paths:
        report = check(path)
        rows = [row for row in report["cases"] if row["scheduling"] == "Spread"]
        if len(rows) != 18:
            raise ValueError(f"Expected all 18 Spread cases: {path}")
        for row in rows:
            matrix.append({"sampleRate": report["sampleRate"], "blockSize": report["blockSize"],
                           "observations": report["observations"], **row})
        for count in (1, 4, 8):
            subset = [row for row in rows if row["instances"] == count]
            workloads.append({
                "sampleRate": report["sampleRate"], "blockSize": report["blockSize"], "instances": count,
                "budgetUs": subset[0]["budgetUs"],
                "worstAverageUs": max(row["averageUs"] for row in subset),
                "worstP99Us": max(row["p99Us"] for row in subset),
                "worstMaxUs": max(row["maxUs"] for row in subset),
                "deadlineOverruns": sum(row["deadlineOverruns"] for row in subset),
                "observations": report["observations"] * len(subset),
                "measuredDeadlineResult": "fail" if any(row["deadlineOverruns"] for row in subset) else "pass",
            })
    expected = {(rate, size) for rate in (44100, 48000, 96000, 192000) for size in (64, 128)}
    if {(row["sampleRate"], row["blockSize"]) for row in matrix} != expected:
        raise ValueError("The four-rate/two-buffer matrix is incomplete")
    result = {"timing": "diagnostic_only", "deviceDropouts": "not_asserted", "audioQuality": "not_asserted",
              "cpu": current["cpu"], "comparisons48k128": comparisons, "spreadMatrix": matrix,
              "workloadSummary": sorted(workloads, key=lambda r: (r["sampleRate"], r["blockSize"], r["instances"])),
              "liveTransitions": current["liveTransitions"],
              "scope": "Serial whole-plugin callbacks; observed deadline counts include outliers. No arbitrary-instance or hardware guarantee."}
    destination = args.directory / "timing-summary.json"
    destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Recorded {len(matrix)} Spread cases; {sum(row['deadlineOverruns'] > 0 for row in matrix)} contain deadline misses.")
    for row in result["workloadSummary"]:
        print(f"{row['sampleRate']:6.0f} Hz/{row['blockSize']:3} frames x{row['instances']}: "
              f"{row['deadlineOverruns']}/{row['observations']} misses, "
              f"p99 {row['worstP99Us']:.1f} us, budget {row['budgetUs']:.1f} us")


if __name__ == "__main__":
    main()
