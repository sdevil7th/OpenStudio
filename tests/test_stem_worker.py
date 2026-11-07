"""Device policy and worker protocol checks; these do not qualify real hardware."""
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import stem_separator as worker


class InstalledRuntimeFeatureTests(unittest.TestCase):
    def test_native_maintenance_can_preserve_generation_dependencies_despite_broken_torch(self):
        import ai_runtime_probe as probe
        with patch.object(probe, "_get_dist_version", side_effect=lambda name: "installed" if name in {"audio-separator", "diffusers"} else None), \
                patch.dict(sys.modules, {"torch": None}):
            report = probe.probe_runtime_capabilities(include_installed_features=True)
        self.assertFalse(report["runtimeReady"])
        self.assertEqual(report["installedRuntimeFeatures"], ["stemSeparation", "audioGeneration"])

    def test_ordinary_worker_probe_does_not_run_the_maintenance_inventory(self):
        import ai_runtime_probe as probe
        with patch.object(probe, "_get_dist_version") as distribution, patch.dict(sys.modules, {"torch": None}):
            report = probe.probe_runtime_capabilities()
        self.assertNotIn("installedRuntimeFeatures", report)
        distribution.assert_not_called()


class StemWorkerTests(unittest.TestCase):
    def test_only_qualification_starts_profiling_even_if_separation_fails(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "input.wav"
            source.touch()
            args = ["stem_separator.py", "--input", str(source), "--output-dir", root]
            for qualified in (False, True):
                flags = ["--qualification-telemetry"] if qualified else []
                output = io.StringIO()
                with self.subTest(qualified=qualified), patch.object(sys, "argv", args + flags), \
                        patch.dict(sys.modules, {"audio_separator.separator": SimpleNamespace(Separator=object)}), \
                        patch.object(worker, "configure_process"), patch.object(worker, "install_tqdm_hook"), \
                        patch.object(worker, "runtime_versions", return_value={"python": "test"}) as versions, \
                        patch.object(worker, "probe_runtime_capabilities", side_effect=RuntimeError("test fault")), \
                        patch("ai_telemetry.WorkerTelemetry") as profiler, contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    profiler.return_value.snapshot.return_value = {"peakRssBytes": 123}
                    worker.main()
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                error = events[-1]
                self.assertIn("test fault", error["error"])
                self.assertEqual("versions" in events[0], qualified)
                if qualified:
                    versions.assert_called_once()
                    profiler.return_value.start.assert_called_once()
                    profiler.return_value.stop.assert_called_once()
                    self.assertEqual(error["telemetry"]["peakRssBytes"], 123)
                else:
                    versions.assert_not_called()
                    profiler.assert_not_called()
                    self.assertNotIn("telemetry", error)

    def test_dependency_exit_retains_the_logged_oom_and_other_errors_do_not_retry(self):
        message, kind = worker.describe_worker_failure(SystemExit(1), "Failed model load: CUDA out of memory. Tried to allocate 2 MiB")
        self.assertIn("CUDA out of memory", message)
        self.assertEqual(kind, "device_oom")
        self.assertEqual(worker.describe_worker_failure(RuntimeError("Invalid checkpoint"))[1], "worker_error")
        self.assertEqual(worker.describe_worker_failure(SystemExit(1))[1], "worker_error")
        capture = worker.WorkerFailureCapture()
        for detail in ["Failed to load: CUDA out of memory", "Please delete and redownload the checkpoint", "x" * 10000]:
            capture.emit(logging.LogRecord("test", logging.ERROR, "test", 1, detail, (), None))
        self.assertLessEqual(len(capture.message), 4096)
        self.assertEqual(worker.describe_worker_failure(SystemExit(1), capture.message)[1], "device_oom")

    def test_device_and_memory_plan_survive_allocator_telemetry(self):
        output = io.StringIO()
        try:
            worker.set_emit_context(backend="cuda", memoryPlan={"chunk_duration": 30})
            worker.EMIT_CONTEXT["gpuResidentBaselineBytes"] = 700
            with contextlib.redirect_stdout(output):
                worker.emit("done", 1.0)
            result = json.loads(output.getvalue())
            self.assertEqual(result["backend"], "cuda")
            self.assertEqual(result["memoryPlan"]["chunk_duration"], 30)
            self.assertEqual(result["gpuResidentBaselineBytes"], 700)
        finally:
            worker.set_emit_context()

    def test_digital_silence_retains_duration_and_non_silence_runs_the_model(self):
        import numpy as np
        import soundfile as sf
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            source = Path(directory) / "source.wav"
            sf.write(source, np.zeros((48000, 1)), 48000)
            separator = SimpleNamespace(separate=Mock(return_value=["model-output"]))
            files = worker.separate_audio(separator, str(source), directory, ["Vocals", "Other"], 44100)
            self.assertEqual(len(files), 2)
            for filename in files:
                audio, rate = sf.read(filename, always_2d=True)
                self.assertEqual(audio.shape, (44100, 2))
                self.assertEqual(rate, 44100)
                self.assertFalse(audio.any())
            separator.separate.assert_not_called()
            sf.write(source, np.ones((48000, 1)) * 0.1, 48000)
            self.assertEqual(worker.separate_audio(separator, str(source), directory, ["Vocals"], 44100), ["model-output"])
            separator.separate.assert_called_once_with(str(source))

    def test_silent_section_is_written_and_writer_failures_are_not_hidden(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            engine = SimpleNamespace(output_dir=directory, sample_rate=44100,
                write_audio=lambda *args: calls.append(args))
            worker.configure_roformer_output(engine)
            engine.write_audio("silent.wav", np.zeros((100, 2)))
            audio, rate = sf.read(Path(directory) / "silent.wav", always_2d=True)
            self.assertEqual(audio.shape, (100, 2))
            self.assertEqual(rate, 44100)
            self.assertEqual(calls, [])
            with self.assertRaises(OSError):
                engine.write_audio("missing.wav", np.ones((100, 2)))
            with self.assertRaises(ValueError):
                engine.write_audio("invalid.wav", np.full((100, 2), np.nan))

    def test_partial_model_window_is_padded_and_trimmed_without_changing_full_windows(self):
        import numpy as np
        for dictionary in (False, True):
            calls = []
            def demix(mix):
                calls.append(mix)
                output = mix * 2
                return {"Vocals": output} if dictionary else output
            engine = SimpleNamespace(is_roformer=True, demix=demix, segment_size=5,
                override_model_segment_size=False, model_data_cfgdict=SimpleNamespace(
                    inference=SimpleNamespace(dim_t=5), model=SimpleNamespace(stft_hop_length=4)))
            worker.configure_short_roformer_input(engine)
            short = np.ones((2, 3))
            result = engine.demix(short)
            self.assertEqual(calls[-1].shape, (2, 16))
            np.testing.assert_array_equal(result["Vocals"] if dictionary else result, short * 2)
            full = np.ones((2, 20))
            engine.demix(full)
            self.assertIs(calls[-1], full)
            engine.override_model_segment_size = True
            engine.segment_size = 3
            engine.demix(short)
            self.assertEqual(calls[-1].shape, (2, 8))

    def test_torch_device_takes_precedence_over_onnx_provider_for_roformer(self):
        for device in ("cpu", "mps", "privateuseone"):
            separator = SimpleNamespace(torch_device=SimpleNamespace(type=device),
                onnx_execution_provider=["CUDAExecutionProvider", "CoreMLExecutionProvider"])
            self.assertEqual(worker.detect_separator_backend(separator), "directml" if device == "privateuseone" else device)

    def test_cpu_policy_overrides_each_dependency_accelerator_before_model_load(self):
        torch = SimpleNamespace(device=lambda name: SimpleNamespace(type=name))
        for device in ("cuda", "privateuseone", "mps", "cpu"):
            class Dependency:
                def __init__(self, **kwargs):
                    self.setup_torch_device(None)
                    self.loaded_on = self.torch_device.type

                def setup_torch_device(self, system_info):
                    self.torch_device = torch.device(device)

            with self.subTest(device=device), patch.dict(sys.modules, torch=torch):
                separator = worker.create_separator(Dependency, "cpu")
                self.assertEqual(separator.loaded_on, "cpu")
                self.assertEqual(separator.onnx_execution_provider, ["CPUExecutionProvider"])
                self.assertEqual(worker.detect_separator_backend(separator), "cpu")

    def test_accelerated_modes_preserve_dependency_device_setup_and_memory_options(self):
        class Dependency:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
        for backend in ("cuda", "rocm", "directml", "mps", "coreml"):
            for chunk in (None, 30):
                result = worker.create_separator(Dependency, backend, chunk_duration=chunk)
                self.assertIs(type(result), Dependency)
                self.assertEqual(result.kwargs["chunk_duration"], chunk)

    def test_cpu_visibility_policy_is_child_local_and_does_not_allow_duplicates(self):
        with patch.dict(os.environ, {"CUDA_VISIBLE_DEVICES": "0"}, clear=True), patch.object(worker.faulthandler, "enable"):
            worker.configure_process("cpu-only")
            for name in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
                self.assertEqual(os.environ[name], "-1")
            self.assertNotIn("KMP_DUPLICATE_LIB_OK", os.environ)
            self.assertGreater(int(os.environ["OMP_NUM_THREADS"]), 0)

    def test_auto_preserves_existing_visibility_and_phase_survives_progress_updates(self):
        with patch.dict(os.environ, {"CUDA_VISIBLE_DEVICES": "2"}), patch.object(worker.faulthandler, "enable"):
            worker.configure_process("auto")
            self.assertEqual(os.environ["CUDA_VISIBLE_DEVICES"], "2")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            worker.emit("analyzing", phase="separate")
            worker.set_emit_context(backend="cpu")
            worker.emit("error", error="native call failed")
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1])["phase"], "separate")
        worker.set_emit_context()


if __name__ == "__main__":
    unittest.main()
