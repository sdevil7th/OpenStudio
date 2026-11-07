"""Bounded worker measurements; no device synchronization in the sampler."""
from contextlib import contextmanager
import threading
import time


class WorkerTelemetry:
    def __init__(self, memory_reader=None, clock=time.perf_counter):
        self.clock = clock
        self.started = clock()
        self.measurements = {}
        self.memory_reader = memory_reader or self._process_memory
        self.peak_rss = None
        self.peak_private = None
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = threading.Lock()

    @staticmethod
    def _process_memory():
        from ai_system_memory import process_memory
        return process_memory()

    def sample(self):
        try:
            rss, private = self.memory_reader()
            with self.lock:
                self.peak_rss = max(self.peak_rss or 0, rss)
                if private is not None:
                    self.peak_private = max(self.peak_private or 0, private)
        except (ImportError, OSError, AttributeError):
            pass

    def start(self):
        self.sample()
        def sample_loop():
            while not self.stop_event.wait(0.2):
                self.sample()
        self.thread = threading.Thread(target=sample_loop, name="AI memory sampler", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=1)
        self.sample()

    @contextmanager
    def measure(self, name):
        started = self.clock()
        try:
            yield
        finally:
            elapsed = max(0, self.clock() - started)
            with self.lock:
                entry = self.measurements.setdefault(name, {"seconds": 0.0, "calls": 0})
                entry["seconds"] += elapsed
                entry["calls"] += 1

    def wrap(self, owner, name, stage):
        original = getattr(owner, name, None)
        if not callable(original):
            return
        def measured(*args, **kwargs):
            with self.measure(stage):
                return original(*args, **kwargs)
        setattr(owner, name, measured)

    def snapshot(self):
        self.sample()
        with self.lock:
            return {"elapsedSeconds": round(self.clock() - self.started, 6),
                    "stages": {name: {"seconds": round(value["seconds"], 6), "calls": value["calls"]}
                               for name, value in self.measurements.items()},
                    "peakRssBytes": self.peak_rss, "peakPrivateBytes": self.peak_private,
                    "memorySamplingIntervalMs": 200,
                    "timingScope": "wall clock; demix includes inference and reconstruction",
                    "subjectiveAudioQuality": "not_asserted"}
