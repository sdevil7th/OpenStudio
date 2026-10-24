"""Small native-schema fixtures: no model downloads or long audio exports."""
from __future__ import annotations

import copy
import contextlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import unquote

import numpy as np

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import analyze_free_plugin_repairs as repairs
import analyze_free_plugin_audit as audit
import prepare_reverb_balance as balance
import prepare_reverb_shared_guitar_project as shared
import prepare_reverb_voiced_balance as voiced
from reverb_qa_common import sha256


def float_wave(path: Path, values, rate: int = 1000) -> None:
    values = np.asarray(values, dtype="<f4")
    if values.ndim == 1:
        values = np.column_stack((values, values))
    data = values.tobytes()
    channels = values.shape[1]
    fmt = struct.pack("<HHIIHH", 3, channels, rate, rate * channels * 4, channels * 4, 32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
                     + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data)


class PlayerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.native = self.root / "native"
        self.native.mkdir()
        self.report = self.root / "native.json"
        self.output = self.root / "published"

    def save(self, result: dict) -> None:
        self.report.write_text(json.dumps({"overallPass": True, "checks": [result]}), encoding="utf-8")

    def balance_fixture(self, configuration=balance.DEFAULT_CONFIGURATION, authored=False) -> dict:
        float_wave(self.native / "tiny.wav", [.1] * 8)
        variants = [key for key, _ in configuration.variants]
        rows = []
        for kind in range(41):
            for material, _ in configuration.materials:
                rows.append({"type": kind, "name": f"Voice {kind}", "material": material,
                             "files": dict.fromkeys(variants, "tiny.wav"),
                             **dict.fromkeys(balance.METRICS, .1), "outputTrimDb": -3 if authored else 0,
                             "excitationSeconds": .004, "pass": True, "finite": True, "filesWritten": True,
                             "samplesAboveUnityDiagnostic": dict.fromkeys(variants, 0),
                             "samplesAtSafetyBoundDiagnostic": dict.fromkeys(variants, 0)})
        result = {"directory": "native", "cases": rows, "pass": True, "dry": .7,
                  "outputDb": "authored_per_voice" if authored else 0,
                  "sampleRate": 1000, "seconds": .008,
                  "materials": [key for key, _ in configuration.materials]}
        return result

    def voiced_fixture(self) -> dict:
        result = self.balance_fixture(voiced.CONFIGURATION, authored=True)
        provenance = {"materials": [{"material": key} for key in list(voiced.MATERIAL_NAMES)[3:]]}
        (self.native / "recorded-source-manifest.json").write_text(json.dumps(provenance), encoding="utf-8")
        result.update({"recordedSourceManifest": "recorded-source-manifest.json", "sources": [],
                       "commonInputGain": .5, "realRecordedVoice": "not_asserted",
                       "tailCompleteness": "not_asserted", "maximumMixedPeak": .1,
                       "samplesAboveUnityDiagnostic": 0, "samplesAtSafetyBoundDiagnostic": 0})
        return result

    def test_six_variants_authored_trims_and_repeated_builds_do_not_mutate_base(self):
        result = self.voiced_fixture()
        self.save(result)
        # Reuse a single tiny source file in place: exercise the full 41x7x6
        # schema without generating 1,722 long WAVs.
        before = (self.native / "tiny.wav").read_bytes()
        for _ in range(2):
            manifest = voiced.prepare(self.report, self.native)
            self.assertEqual(manifest["count"], 287)
            self.assertEqual(manifest["audioFileCount"], 1722)
            self.assertEqual(manifest["outputTrimDb"], "authored_per_voice")
            self.assertEqual(set(manifest["cases"][0]["files"]), set(result["cases"][0]["files"]))
            self.assertEqual(manifest["cases"][0]["outputTrimDb"], -3)
            self.assertEqual(manifest["audioQuality"], "not_asserted")
        self.assertEqual((self.native / "tiny.wav").read_bytes(), before)
        self.assertEqual(len(balance.DEFAULT_CONFIGURATION.materials), 3)
        self.assertEqual(len(balance.DEFAULT_CONFIGURATION.variants), 4)
        self.save(self.balance_fixture())
        ordinary = balance.prepare(self.report, self.native)
        self.assertEqual(ordinary["audioFileCount"], 492)

    def test_failed_missing_or_duplicate_balance_rows_fail_before_publication(self):
        original = self.balance_fixture()
        for mutation in (lambda row: row.update({"finite": False}),
                         lambda row: row["files"].pop("calibrated50"),
                         lambda row: row.update({"type": True})):
            result = copy.deepcopy(original)
            mutation(result["cases"][0])
            self.save(result)
            with self.assertRaises(ValueError):
                balance.prepare(self.report, self.output)
            self.assertFalse(self.output.exists())
        duplicate = copy.deepcopy(original)
        duplicate["cases"][-1] = duplicate["cases"][0]
        self.save(duplicate)
        with self.assertRaises(ValueError):
            balance.prepare(self.report, self.output)

    def test_voiced_missing_provenance_and_bad_input_gain_fail_closed(self):
        result = self.voiced_fixture()
        self.save(result)
        (self.native / "recorded-source-manifest.json").unlink()
        with self.assertRaises(OSError):
            voiced.prepare(self.report, self.output)
        self.assertFalse(self.output.exists())
        result = self.voiced_fixture()
        result["commonInputGain"] = 1
        self.save(result)
        with self.assertRaises(ValueError):
            voiced.prepare(self.report, self.output)
        self.assertFalse(self.output.exists())

    def project_fixture(self) -> dict:
        project, source, model = self.root / "project.osproj", self.root / "recording.wav", self.root / "model.nam"
        project.write_text('{"test": true}', encoding="utf-8")
        model.write_bytes(b"existing model fixture")
        float_wave(source, [.1] * 200)
        float_wave(self.native / "source-timeline.wav", [0] * 50 + [.1] * 100 + [0] * 150)
        float_wave(self.native / "baseline.wav", [.1] * 300)
        (self.native / "saved-nam-project.state").write_bytes(b"saved native state")
        for variant, wet in zip(shared.VARIANTS, (0, .25, .5, .75, 1)):
            float_wave(self.native / f"{variant}.wav", [.07 + wet * .01] * 300)
        return {"directory": "native", "pass": True, "caseCount": 41, "sampleRate": 1000,
                "baselineFile": "baseline.wav", "sourceTimelineFile": "source-timeline.wav",
                "projectPath": str(project), "sourcePath": str(source), "sourceStartSeconds": .05,
                "sourceDurationSeconds": .1, "sourceOffsetSeconds": 0, "outputDb": "authored_per_voice",
                "metadata": {"projectSha256": sha256(project), "sourceSha256": sha256(source),
                             "modelPath": str(model), "modelSha256": sha256(model),
                             "savedNamStateSha256": sha256(self.native / "saved-nam-project.state")},
                "cases": [{"type": kind, "name": f"Voice {kind}", "outputTrimDb": 0,
                           "files": {key: f"{key}.wav" for key in shared.VARIANTS},
                           "pass": True, "finite": True, "filesWritten": True} for kind in range(41)]}

    def test_shared_project_rebuilds_evidence_and_copies_unchanged_files(self):
        native = self.project_fixture()
        self.save(native)
        before = {path: sha256(path) for path in self.native.glob("*.wav")}
        manifest = shared.prepare(self.report, self.output)
        evidence = json.loads((self.output / "source-project-evidence.json").read_text(encoding="utf-8"))
        self.assertEqual(evidence["projectSha256"], native["metadata"]["projectSha256"])
        self.assertEqual(evidence["nativeReportSha256"], sha256(self.report))
        self.assertTrue(evidence["timelineOnsetDiagnostic"]["thresholdReached"])
        self.assertTrue((self.output / unquote(manifest["baselineFile"])).is_file())
        self.assertEqual((self.output / unquote(manifest["cases"][0]["files"]["wet100"])).read_bytes(),
                         (self.native / "wet100.wav").read_bytes())
        self.assertEqual(before, {path: sha256(path) for path in self.native.glob("*.wav")})

    def test_shared_project_rejects_stale_or_missing_source_hash(self):
        native = self.project_fixture()
        self.save(native)
        Path(native["projectPath"]).write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "stale"):
            shared.prepare(self.report, self.output)
        self.assertFalse(self.output.exists())
        native = self.project_fixture()
        del native["metadata"]["sourceSha256"]
        self.save(native)
        with self.assertRaisesRegex(ValueError, "missing"):
            shared.prepare(self.report, self.output)

    def test_audit_accepts_explicit_native_evidence_and_requires_effect_matrix(self):
        native = self.project_fixture()
        self.save(native)
        captures = self.root / "captures"
        guitar = captures / "guitar"
        guitar.mkdir(parents=True)
        (guitar / "00-source-nam-only.wav").write_bytes((self.native / "baseline.wav").read_bytes())
        rows = [{"name": name.replace("-", " ").title(), "variant": variant,
                 "file": str(guitar / "00-source-nam-only.wav"), "latencyTrimmed": 0}
                for name in repairs.EFFECTS for variant in (0, 1)]
        document = {"overallPass": True, "checks": [{"pass": True, "cases": rows}]}
        capture_report = captures / "audit-shared-guitar.json"
        capture_report.write_text(json.dumps(document), encoding="utf-8")
        # Chorus diagnostics have their own rate; they need not use the guitar
        # source rate. These tiny captures still cover the complete window.
        for character in (0, 1):
            float_wave(captures / f"modulation/motion-character-{character}.wav", [.1] * 400, 2000)
        with contextlib.redirect_stdout(io.StringIO()):
            result = audit.analyze(captures, self.root, self.report)
        self.assertEqual(len(result["guitar"]), 22)
        self.assertTrue(result["provenance"]["copiedSourceSamplesExact"])
        document["checks"][0]["cases"].pop()
        capture_report.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "eleven effects"):
            audit.analyze(captures, self.root, self.report)


class ArchiveTests(unittest.TestCase):
    def test_expected_archive_contract_is_83_and_missing_one_does_not_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(len(repairs.expected_archives()), 83)
            with self.assertRaises(ValueError):
                repairs.validate_archive(root)
            for relative in repairs.expected_archives():
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).touch()
            self.assertEqual(len(repairs.validate_archive(root)), 83)
            (root / next(iter(repairs.expected_archives()))).unlink()
            with self.assertRaises(ValueError):
                repairs.validate_archive(root)

    def test_invariant_matrix_requires_exact_identities_and_finite_metrics(self):
        rows = [{"kind": kind, "partitionMaximumError": 0, "stateAudioRoundTripMaximumError": 0,
                 "incomingAudioDiscardedMaximumError": 0, "velocity25Rms": .1,
                 "velocity50Rms": .2, "velocity100Rms": .3} for kind in repairs.INSTRUMENTS]
        report = {"overallPass": True, "checks": [{"pass": True, "invariants": rows}]}
        self.assertEqual(len(repairs.instrument_invariants(report, "legacy")), 8)
        for invalid in ([], rows[:-1], [rows[0]] * 8):
            broken = copy.deepcopy(report)
            broken["checks"][0]["invariants"] = invalid
            with self.assertRaises(ValueError):
                repairs.instrument_invariants(broken, "legacy")
        rows[0]["partitionMaximumError"] = float("nan")
        with self.assertRaises(ValueError):
            repairs.instrument_invariants(report, "legacy")

    def test_missing_archive_cli_fails_without_writing_success_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = subprocess.run([sys.executable, str(TOOLS / "analyze_free_plugin_repairs.py"),
                                     "--root", str(root)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Incomplete archived capture matrix", result.stderr)
            self.assertFalse((root / "waveform-qualification.json").exists())


if __name__ == "__main__":
    unittest.main()
