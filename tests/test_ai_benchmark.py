"""The qualification harness must stop instead of exhausting the user's RAM."""
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("ai_benchmark", TOOLS / "run-ai-benchmark.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class BenchmarkBudgetTests(unittest.TestCase):
    def test_low_host_memory_stops_after_two_seconds(self):
        now = [0]
        def wait(**kwargs):
            now[0] += 1
            raise subprocess.TimeoutExpired("worker", kwargs["timeout"])
        with patch.object(benchmark.time, "monotonic", side_effect=lambda: now[0]), patch(
                "ai_execution_policy.host_available", return_value=1024**3):
            with self.assertRaises(MemoryError):
                benchmark.wait_bounded(SimpleNamespace(wait=wait),
                    SimpleNamespace(timeout=30, min_available_ram_mb=2048))
        self.assertEqual(now[0], 3)

    def test_completed_child_does_not_trigger_resource_retry(self):
        self.assertEqual(benchmark.wait_bounded(SimpleNamespace(wait=lambda **_: 0),
            SimpleNamespace(timeout=30, min_available_ram_mb=2048)), 0)


class CandidateStagingTests(unittest.TestCase):
    def exercise(self, failure):
        spec = importlib.util.spec_from_file_location("stage_candidate", TOOLS / "stage-ai-candidate.py")
        candidate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "base-python"
            runtime.touch()
            output = root / "candidates"
            output.mkdir()
            published = output / "int8.json"
            published.write_text("previous working candidate")
            site = root / "candidate-site"
            site.mkdir()
            packages = {name: "pinned" for name in ("torch", "diffusers", "transformers", "accelerate")}
            wheel = b"fixture wheel bytes"
            calls = []
            def run(command, **_):
                command = list(map(str, command))
                calls.append(command)
                if "download" in command:
                    Path(command[command.index("--dest") + 1], "candidate.whl").write_bytes(wheel)
                elif "-c" in command:
                    if "'python':" in command[-1]:
                        return json.dumps({"python": "3.12", "site": str(root / "base-site"), "packages": packages})
                    if "importlib.metadata" in command[-1]:
                        return json.dumps({**packages, **({"torch": "unexpected"} if failure == "stack" else {})})
                    return str(site)
                return ""
            digest = "incorrect" if failure == "hash" else hashlib.sha256(wheel).hexdigest()
            response = json.dumps({"urls": [{"filename": "candidate.whl", "digests": {"sha256": digest}}]}).encode()
            with patch.object(sys, "argv", ["stage", "--runtime-python", str(runtime),
                    "--output-dir", str(output), "--candidate", "int8"]), patch.object(
                    candidate, "run", side_effect=run), patch.object(candidate.urllib.request,
                    "urlopen", return_value=io.BytesIO(response)), patch("builtins.print"):
                if failure:
                    with self.assertRaisesRegex(RuntimeError, "hash check|pinned base stack"):
                        candidate.main()
                    self.assertEqual(published.read_text(), "previous working candidate")
                    record = json.loads(next(output.glob("int8-*/candidate.json")).read_text())
                    self.assertEqual(record["state"], "failed")
                else:
                    self.assertEqual(candidate.main(), 0)
                    record = json.loads(published.read_text())
                    self.assertEqual(record["state"], "import_only")
                    self.assertEqual(record["sha256"], digest)
            for command in calls:
                if "pip" in command:
                    self.assertNotEqual(command[0], str(runtime))
                    self.assertIn("--no-deps", command)
            if failure == "hash":
                self.assertFalse(any("install" in command for command in calls))

    def test_validated_candidate_publishes_without_mutating_base(self):
        self.exercise(None)

    def test_hash_failure_preserves_previous_candidate(self):
        self.exercise("hash")

    def test_changed_stack_preserves_previous_candidate(self):
        self.exercise("stack")


class CandidateQualificationTests(unittest.TestCase):
    def exercise(self, failure, capacity=False):
        spec = importlib.util.spec_from_file_location("qualify_candidate", TOOLS / "qualify-ai-candidate.py")
        candidate_tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate_tool)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = root / "int8-fixture"
            (environment / "Scripts").mkdir(parents=True)
            (environment / "wheels").mkdir()
            python = environment / "Scripts/python.exe"
            python.touch()
            wheel = environment / "wheels/candidate.whl"
            wheel.write_bytes(b"fixture")
            model = root / "model"
            (model / "language_model").mkdir(parents=True)
            (model / "language_model/config.json").write_text(json.dumps({
                "num_hidden_layers": 36, "num_key_value_heads": 8, "head_dim": 128}))
            artifact = root / "accepted.wav"
            artifact.write_bytes(b"user-accepted fixture bytes")
            packages = {"torch": "pinned", "diffusers": "pinned", "transformers": "pinned",
                        "accelerate": "pinned", "bitsandbytes": "0.50.2"}
            manifest = root / "int8.json"
            manifest.write_text(json.dumps({"recipe": {"package": "bitsandbytes", "version": "0.50.2"},
                "state": "import_only", "python": str(python), "baseline": {"packages": packages},
                "wheel": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()}))
            report = {"status": "pass", "workerVersion": "old" if failure == "version" else "current",
                "allocatorConfig": candidate_tool.MINIMAX_ALLOCATOR, "allocatorBackend": "native",
                "modelStorageIdentity": "model-identity", "runs": [
                    {"status": "pass", "generatedSeconds": 5, "index": index,
                     "warm": index > 0 and failure != "cold-only"}
                    for index in range(1 if failure == "warm" else 2)],
                "policy": {"attention": "native", "placement": "model-offload", "quantization": "int8", "compile": False},
                "hardware": {"os": "Windows", "torch": "pinned", "packages": packages},
                "selectedDevice": {"family": "cuda", "name": "GPU"},
                "request": {"workflow": "lyrics-style", "params": {"duration": 5, "prompt": "A song", "lyrics": "[verse]\nA verse"}},
                "linkBeforeLoad": {"devices": [{"name": "GPU", "uuid": "gpu", "driver_version": "driver"}]},
                "initialExecution": {"requiredDeviceBytes": 14*1024**3, "weightsBytes": 16*1024**3,
                                     "promptTokens": 30, "promptMeasurement": "upstream-tokenize-step-v1"}}
            report_path = root / "report.json"
            functional_path = root / "functional.json"
            if capacity:
                functional = json.loads(json.dumps(report))
                if failure == "functional-failed":
                    functional["runs"][1]["status"] = "fail"
                if failure == "functional-version":
                    functional["workerVersion"] = "different"
                if failure == "functional-synthetic":
                    functional["generationMode"] = "eos-suppressed-capacity-only"
                functional_path.write_text(json.dumps(functional))
                report["generationMode"] = "eos-suppressed-capacity-only"
                for run in report["runs"]:
                    run["capacityEvidence"] = {"mode": report["generationMode"], "semanticCalls": 126}
                    run["generatedSeconds"] = 5.245  # Upstream chunk stitching need not end sample-exactly.
                    run["outputLifetime"] = {"device": "cuda:0", "outputBytes": 100, "allocatedBeforeRelease": 200, "allocatedAfterRelease": 100}
                if failure == "early-eos":
                    report["runs"][1]["generatedSeconds"] = 4
                if failure == "retained-output":
                    report["runs"][0]["outputLifetime"]["allocatedAfterRelease"] = 200
            report_path.write_text(json.dumps(report))
            published = root / "minimax-int8-qualified.json"
            published.write_text("previous qualification")
            with patch.object(sys, "executable", str(python)), patch.object(sys, "argv", ["qualify",
                    "--candidate-manifest", str(manifest), "--report", str(report_path),
                    "--model-root", str(model), "--audition-artifact", str(artifact), "--audition-accepted"]
                    + (["--functional-report", str(functional_path)] if capacity and failure != "missing-functional" else [])), patch.object(
                    candidate_tool.metadata, "version", side_effect=packages.__getitem__), patch.object(
                    candidate_tool, "model_storage_identity", return_value="model-identity"), patch.object(
                    candidate_tool, "worker_version", return_value="current"), patch.object(
                    candidate_tool, "minimax_prompt_tokens", return_value=30), patch("builtins.print"):
                if failure:
                    with self.assertRaisesRegex(ValueError, "first/warm|functional|Capacity|capacity"):
                        candidate_tool.main()
                    self.assertEqual(published.read_text(), "previous qualification")
                else:
                    candidate_tool.main()
                    profile = json.loads(published.read_text())
                    self.assertEqual(profile["maxDuration"], 5)
                    self.assertEqual(profile["state"], "qualified-local")
                    self.assertEqual(profile["audition"]["sha256"], hashlib.sha256(artifact.read_bytes()).hexdigest())

    def test_qualification_publishes_only_the_tested_range(self):
        self.exercise(None)

    def test_changed_worker_preserves_previous_qualification(self):
        self.exercise("version")

    def test_missing_warm_run_preserves_previous_qualification(self):
        self.exercise("warm")

    def test_repeated_cold_runs_do_not_qualify_warm_reuse(self):
        self.exercise("cold-only")

    def test_capacity_requires_matching_normal_generations(self):
        self.exercise(None, capacity=True)
        for failure in ("missing-functional", "functional-failed", "functional-version",
                        "functional-synthetic", "early-eos", "retained-output"):
            with self.subTest(failure=failure):
                self.exercise(failure, capacity=True)


if __name__ == "__main__":
    unittest.main()
