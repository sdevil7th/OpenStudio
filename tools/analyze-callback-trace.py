"""Summarize paired, sampled callback intervals; never infer audible quality or CPU time."""
import argparse
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path

STAGES = ("playback", "tracksFXRouting", "masterMonitoring", "meteringSync", "callbackOverhead")


def distribution(values):
    values = sorted(values)
    if not values:
        return {"count": 0}
    def percentile(fraction):
        return values[int((len(values) - 1) * fraction)]
    return {"count": len(values), "min": values[0], "p50": percentile(.5),
            "p95": percentile(.95), "p99": percentile(.99), "max": values[-1]}


def phase(event):
    if not event["playing"]:
        return "recordLatchedStopped" if event["recording"] else "stopped"
    return "recording" if event["recording"] else "playing"


def validate_event(event, line):
    for name in ("measuredWallMs", "budgetMs", "sampleRate", "startWallTimeMs"):
        value = event.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"Line {line}: invalid {name}")
    if event["measuredWallMs"] < 0 or event["budgetMs"] <= 0 or event["sampleRate"] <= 0:
        raise ValueError(f"Line {line}: invalid duration, budget or sample rate")
    for name in ("callbackCounter", "blockSize", "startSamplePosition"):
        if isinstance(event.get(name), bool) or not isinstance(event.get(name), int):
            raise ValueError(f"Line {line}: invalid {name}")
    if event["blockSize"] <= 0:
        raise ValueError(f"Line {line}: blockSize must be positive")
    for name in ("playing", "recording"):
        if not isinstance(event.get(name), bool):
            raise ValueError(f"Line {line}: invalid {name}")
    if event.get("stageTimingsAvailable"):
        values = event.get("stageMs")
        if not isinstance(values, list) or len(values) != len(STAGES) or any(
                isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or value < 0 for value in values):
            raise ValueError(f"Line {line}: invalid paired stage timings")
    if event.get("threadCyclesValid"):
        cycles = event.get("threadCycleDelta")
        if isinstance(cycles, bool) or not isinstance(cycles, int) or cycles < 0:
            raise ValueError(f"Line {line}: invalid raw cycle count")


def summarize_phase(events):
    misses = [event for event in events if event["measuredWallMs"] > event["budgetMs"]]
    paired = [event for event in events if event.get("stageTimingsAvailable")]
    cycles = [event for event in events if event.get("threadCyclesValid")]
    result = {
        "sampledCallbackCount": len(events),
        "overBudgetSampleCount": len(misses),
        "overBudgetSamplePercent": 100 * len(misses) / len(events),
        "blockSizes": sorted({event["blockSize"] for event in events}),
        "sampleRates": sorted({event["sampleRate"] for event in events}),
        "measuredWallMs": distribution(event["measuredWallMs"] for event in events),
        "pairedStageMs": {name: distribution(event["stageMs"][index] for event in paired)
                          for index, name in enumerate(STAGES)},
        "overBudgetPairedStageMs": {
            name: distribution(event["stageMs"][index] for event in misses
                               if event.get("stageTimingsAvailable"))
            for index, name in enumerate(STAGES)},
        "rawThreadCycleDelta": distribution(event["threadCycleDelta"] for event in cycles),
    }
    same_processor, migrated = [], []
    for event in cycles:
        if not event.get("processorIdsAvailable"):
            continue
        start = (event.get("processorGroupStart"), event.get("processorNumberStart"))
        end = (event.get("processorGroupEnd"), event.get("processorNumberEnd"))
        (same_processor if start == end else migrated).append(event)
    result["processorIdentity"] = {"sameStartEndCount": len(same_processor),
                                   "differentStartEndCount": len(migrated)}
    result["largestOverBudgetSamples"] = []
    for event in sorted(misses, key=lambda item: item["measuredWallMs"], reverse=True)[:20]:
        item = {key: event.get(key) for key in (
            "callbackCounter", "startSamplePosition", "startWallTimeMs", "startQpcTicks", "endQpcTicks", "measuredWallMs",
            "budgetMs", "blockSize", "sampleRate", "threadId", "threadCyclesRequested",
            "threadCyclesValid", "threadCycleDelta", "processorIdsAvailable",
            "processorGroupStart", "processorNumberStart", "processorGroupEnd", "processorNumberEnd")}
        if event.get("stageTimingsAvailable"):
            item["pairedStageMs"] = dict(zip(STAGES, event["stageMs"]))
            item["largestMeasuredStage"] = max(item["pairedStageMs"], key=item["pairedStageMs"].get)
        result["largestOverBudgetSamples"].append(item)
    return result


def analyze(lines):
    events, headers, batches = [], [], []
    previous = {}
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Line {line_number}: invalid/truncated JSON") from error
        if not isinstance(record, dict):
            raise ValueError(f"Line {line_number}: trace record must be an object")
        kind = record.get("kind")
        if kind == "callback":
            validate_event(record, line_number)
            session = record.get("traceSessionId", "unspecified")
            if record["callbackCounter"] <= previous.get(session, -1):
                raise ValueError(f"Line {line_number}: repeated or out-of-order callback in session {session}")
            previous[session] = record["callbackCounter"]
            events.append(record)
        elif kind == "callback_trace_header":
            if record.get("schemaVersion") != 1:
                raise ValueError(f"Line {line_number}: unsupported trace schema")
            if tuple(record.get("stageNames", STAGES)) != STAGES:
                raise ValueError(f"Line {line_number}: unsupported stage ordering")
            headers.append(record)
        elif kind == "callback_trace_batch":
            batches.append(record)
        else:
            raise ValueError(f"Line {line_number}: unknown trace record kind {kind!r}")
    if not events:
        raise ValueError("Trace contains no sampled callback records")
    groups = defaultdict(list)
    for event in events:
        groups[phase(event)].append(event)
    periodic = []
    header_by_session = {header.get("traceSessionId", "unspecified"): header for header in headers}
    for event in events:
        header = header_by_session.get(event.get("traceSessionId", "unspecified"), {})
        interval = header.get("sampleIntervalCallbacks", 16)
        if not isinstance(interval, int) or interval < 1:
            raise ValueError("Invalid periodic callback sampling interval")
        if event["callbackCounter"] % interval == 0:
            periodic.append(event)
    return {
        "classification": "diagnostic_only",
        "scope": "Sampled same-callback wall/stage intervals. These include execution and preemption; they do not identify a hot function or prove audible continuity.",
        "cycleScope": "Raw QueryThreadCycleTime counts only; never converted to CPU milliseconds or proof of descheduling. Frequency/core migration and measurement overhead remain relevant.",
        "acceptanceScope": "Opt-in tracing changes the measured workload; required eight-sample acceptance must also be measured with tracing disabled.",
        "sampledCallbackCount": len(events),
        "selectionScope": "When capturesAllDeadlineMisses is true, the full event set intentionally oversamples deadline misses. Its percentiles and miss fraction are not estimates for all callbacks. Use periodicPhases for regular-sampling distributions; queue loss remains a separate limitation.",
        "periodicPhases": {name: summarize_phase([event for event in periodic if phase(event) == name])
                           for name in groups if any(phase(event) == name for event in periodic)},
        "sessions": sorted(previous),
        "headers": headers,
        "lastBatchPerSession": {batch.get("traceSessionId", "unspecified"): batch for batch in batches},
        "phasesPerSession": {
            session: {name: summarize_phase([event for event in group
                                             if event.get("traceSessionId", "unspecified") == session])
                      for name, group in groups.items()
                      if any(event.get("traceSessionId", "unspecified") == session for event in group)}
            for session in previous},
        "phases": {name: summarize_phase(group) for name, group in groups.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        source_bytes = arguments.trace.read_bytes()
        report = analyze(source_bytes.decode("utf-8-sig").splitlines())
    except (OSError, ValueError) as error:
        parser.exit(2, f"Cannot analyze trace: {error}\n")
    report["source"] = str(arguments.trace.resolve())
    report["sourceSha256"] = hashlib.sha256(source_bytes).hexdigest()
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"classification": report["classification"], "sampledCallbacks": report["sampledCallbackCount"],
                      "phases": {name: {"samples": value["sampledCallbackCount"], "overBudgetSamples": value["overBudgetSampleCount"]}
                                 for name, value in report["phases"].items()}, "report": str(arguments.output)}))


if __name__ == "__main__":
    main()
