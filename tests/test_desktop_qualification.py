import importlib.util
from pathlib import Path
import tempfile
import unittest
import wave


def load_tool(name):
    path = Path(__file__).resolve().parents[1] / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


desktop = load_tool("smoke-linux-appimage")
recording = load_tool("evaluate-recording-qualification")


class DesktopQualification(unittest.TestCase):
    def test_boot_alone_does_not_qualify_detached_windows(self):
        with self.assertRaises(ValueError):
            desktop.validate_report({"harnessMode": "window_lifecycle", "success": True,
                                     "checks": [{"id": "main_frontend_ready", "status": "pass"}]})

    def test_complete_lifecycle_required(self):
        report = {"harnessMode": "window_lifecycle", "success": True,
                  "checks": [{"id": key, "status": "pass"} for key in desktop.REQUIRED_CHECKS]}
        desktop.validate_report(report)
        report["checks"].append({"id": "other", "status": "fail"})
        with self.assertRaises(ValueError):
            desktop.validate_report(report)

    def test_missing_or_reset_audio_telemetry_never_becomes_zero_failures(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.wav"
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(48000)
                output.writeframes(b"\0\0" * 48000)
            known = {key: 0 for key in recording.COUNTERS} | {"sampleRate": 48000}
            self.assertEqual(recording.evaluate(known, known, path, 1)["status"], "pass")
            unsupported = known | {"audioDeviceXRunCount": -1}
            report = recording.evaluate(unsupported, unsupported, path, 1)
            self.assertEqual(report["status"], "not_asserted")
            self.assertEqual(report["audibleQuality"], "not_asserted")
            self.assertEqual(recording.evaluate(known | {"audioDeviceXRunCount": 2}, known, path, 1)["status"], "fail")
            self.assertEqual(recording.evaluate(known, known | {"audioDeviceStopCount": 1}, path, 1)["status"], "fail")
            self.assertEqual(recording.evaluate({}, {}, path, 1)["status"], "not_asserted")
            self.assertEqual(recording.evaluate(known, known, path, 60)["status"], "fail")


if __name__ == "__main__":
    unittest.main()
