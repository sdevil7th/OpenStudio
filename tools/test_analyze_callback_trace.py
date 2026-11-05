import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("callback_trace", Path(__file__).with_name("analyze-callback-trace.py"))
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


def event(counter, *, wall=.08, playing=True, recording=False, cycles=0):
    return {"kind": "callback", "traceSessionId": "test", "callbackCounter": counter,
            "startSamplePosition": counter * 8, "startWallTimeMs": counter / 6,
            "measuredWallMs": wall, "budgetMs": 8 / 48, "sampleRate": 48000,
            "blockSize": 8, "playing": playing, "recording": recording,
            "stageTimingsAvailable": True, "stageMs": [wall * .4, wall * .5, 0, 0, wall * .1],
            "threadCyclesValid": bool(cycles), "threadCyclesRequested": bool(cycles), "threadCycleDelta": cycles,
            "processorIdsAvailable": True, "processorGroupStart": 0, "processorNumberStart": 2,
            "processorGroupEnd": 0, "processorNumberEnd": 2}


class CallbackTraceTests(unittest.TestCase):
    def test_pairs_missed_stage_data_without_combining_idle_and_recording(self):
        values = [event(16, playing=False), event(32), event(48, recording=True),
                  event(64, wall=.3, recording=True)]
        result = trace.analyze(map(json.dumps, values))
        self.assertEqual(result["classification"], "diagnostic_only")
        self.assertEqual(set(result["phases"]), {"stopped", "playing", "recording"})
        recorded = result["phases"]["recording"]
        self.assertEqual(recorded["sampledCallbackCount"], 2)
        self.assertEqual(recorded["overBudgetSampleCount"], 1)
        missed = recorded["largestOverBudgetSamples"][0]
        self.assertEqual(missed["callbackCounter"], 64)
        self.assertEqual(missed["largestMeasuredStage"], "tracksFXRouting")
        self.assertEqual(missed["pairedStageMs"]["tracksFXRouting"], .15)

    def test_keeps_raw_cycles_and_migration_without_converting_to_cpu_time(self):
        values = [event(16, cycles=123), event(32, wall=.3, cycles=456)]
        values[1]["processorNumberEnd"] = 3
        result = trace.analyze(map(json.dumps, values))
        group = result["phases"]["playing"]
        self.assertEqual(group["rawThreadCycleDelta"]["max"], 456)
        self.assertEqual(group["processorIdentity"], {"sameStartEndCount": 1, "differentStartEndCount": 1})
        self.assertNotIn("cpuMs", json.dumps(result))

    def test_rejects_truncated_invalid_or_duplicated_records(self):
        for values in (["{"], ["null"], ["[]"], [json.dumps(event(16)), json.dumps(event(16))],
                       [json.dumps({**event(16), "budgetMs": 0})],
                       [json.dumps({**event(16), "stageMs": [1]})], []):
            with self.subTest(values=values), self.assertRaises(ValueError):
                trace.analyze(values)

    def test_retains_batch_drop_evidence_and_allows_distinct_sessions(self):
        batch = {"kind": "callback_trace_batch", "traceSessionId": "test", "droppedFull": 7}
        values = [{"kind": "callback_trace_header", "schemaVersion": 1}, event(16), batch,
                  {**event(16), "traceSessionId": "second"}]
        result = trace.analyze(map(json.dumps, values))
        self.assertEqual(result["sessions"], ["second", "test"])
        self.assertEqual(result["lastBatchPerSession"]["test"]["droppedFull"], 7)
        self.assertEqual(result["phasesPerSession"]["test"]["playing"]["sampledCallbackCount"], 1)

    def test_paused_record_latch_is_not_active_recording(self):
        result = trace.analyze([json.dumps(event(16, playing=False, recording=True))])
        self.assertEqual(set(result["phases"]), {"recordLatchedStopped"})

    def test_all_misses_do_not_bias_periodic_distributions(self):
        header = {"kind": "callback_trace_header", "schemaVersion": 1,
                  "traceSessionId": "test", "sampleIntervalCallbacks": 16,
                  "capturesAllDeadlineMisses": True}
        missed = {**event(17, wall=.3), "startQpcTicks": 1234, "endQpcTicks": 4234}
        result = trace.analyze(map(json.dumps, [header, event(16), missed, event(32)]))
        self.assertEqual(result["phases"]["playing"]["overBudgetSampleCount"], 1)
        self.assertEqual(result["periodicPhases"]["playing"]["sampledCallbackCount"], 2)
        self.assertEqual(result["periodicPhases"]["playing"]["overBudgetSampleCount"], 0)
        retained = result["phases"]["playing"]["largestOverBudgetSamples"][0]
        self.assertEqual((retained["startQpcTicks"], retained["endQpcTicks"]), (1234, 4234))


if __name__ == "__main__":
    unittest.main()
