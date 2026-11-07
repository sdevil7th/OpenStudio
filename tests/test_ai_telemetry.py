import sys
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ai_telemetry import WorkerTelemetry


class TelemetryTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform in {"win32", "linux"}, "native no-psutil probes are Windows/Linux")
    def test_fresh_runtime_has_real_memory_metrics_without_psutil(self):
        from ai_system_memory import available_memory, process_memory
        with patch.dict(sys.modules, {"psutil": None}):
            self.assertGreater(available_memory(), 0)
            self.assertGreater(process_memory()[0], 0)

    def test_wrapped_stage_preserves_result_and_records_failure(self):
        ticks = iter([0, 1, 3, 4, 7, 8])
        telemetry = WorkerTelemetry(memory_reader=lambda: (100, 200), clock=lambda: next(ticks))
        owner = SimpleNamespace(run=lambda value: value + 1)
        telemetry.wrap(owner, "run", "forward")
        self.assertEqual(owner.run(2), 3)
        with self.assertRaises(ValueError), telemetry.measure("forward"):
            raise ValueError("retained")
        report = telemetry.snapshot()
        self.assertEqual(report["stages"]["forward"], {"seconds": 5, "calls": 2})
        self.assertEqual(report["peakRssBytes"], 100)
        self.assertEqual(report["peakPrivateBytes"], 200)

    def test_missing_memory_metrics_are_unknown_and_sampler_stops(self):
        def unavailable():
            raise ImportError("no psutil")
        telemetry = WorkerTelemetry(memory_reader=unavailable)
        telemetry.start()
        telemetry.stop()
        self.assertFalse(telemetry.thread.is_alive())
        self.assertIsNone(telemetry.snapshot()["peakRssBytes"])
