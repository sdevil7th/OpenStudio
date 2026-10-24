"""Small native-float fixtures for the actual NAM fuzz comparison CLI."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
TOOL = REPO / "tools" / "prepare_nam_fuzz_refinement.py"
SAMPLES = (0.0, 0.125, -0.25, 0.5, -0.125, 0.25, -0.5, 0.0)


def float_wave(path: Path, samples=SAMPLES, *, rate: int = 48000, channels: int = 2) -> None:
    payload = struct.pack(f"<{len(samples)}f", *samples)
    fmt = struct.pack("<HHIIHH", 3, channels, rate, rate * channels * 4, channels * 4, 32)
    body = b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(payload)) + payload
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


def pedal_row(filename: str, *, voice: int = 0, bass: bool = False) -> dict:
    return {
        "file": filename, "material": "bass" if bass else "guitar",
        "direct": 1.0, "down": 0.32, "up": 0.18, "bassProfile": bass,
        "seconds": len(SAMPLES) / 2 / 48000,
        "fuzz": {"enabled": True, "drive": 0.5, "tone": 0.5, "levelDb": -6.0,
                 "voice": voice, "cleanMix": 0.0},
        "source": {"sha256": "a" * 64, "renderedInputSha256": "b" * 64,
                   "kind": "fixture", "sampleRate": 48000},
    }


def full_chain_row(filename: str, *, voice: int = 0, bass: bool = False, mask: int = 31) -> dict:
    row = pedal_row(filename, voice=voice, bass=bass)
    del row["fuzz"]
    row.update({
        "stageMask": mask, "setting": "fixture-controls", "fuzzVoice": voice,
        "rackState": {"fuzzDrive": 0.5, "fuzzTone": 0.5, "fuzzLevelDb": -6,
                      "fuzzVoice": voice, "driveGain": 0.4, "distortionGain": 0.3},
        "resources": {"ampSha256": "c" * 64, "cabSha256": "d" * 64,
                      "ampIncludesCab": False},
    })
    return row


class FuzzRefinementCliTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.before_dir = self.root / "baseline"
        self.after_dir = self.root / "candidate"
        self.before_dir.mkdir()
        self.after_dir.mkdir()
        self.baseline = {
            "listening": [
                pedal_row("guitar-dry.wav"),
                pedal_row("guitar-octave-only.wav"),
                pedal_row("guitar-vintage-combined-wet.wav"),
                pedal_row("guitar-sustain-combined-wet.wav", voice=1),
                pedal_row("guitar-gated-combined-wet.wav", voice=2),
                pedal_row("bass-vintage-combined-wet.wav", bass=True),
            ],
            "fullChainListening": [
                full_chain_row("full-guitar-fuzz-off.wav", mask=30),
                full_chain_row("full-guitar-vintage.wav"),
                full_chain_row("full-guitar-sustain.wav", voice=1),
                full_chain_row("full-guitar-gated.wav", voice=2),
                full_chain_row("full-bass-vintage.wav", bass=True),
            ],
        }
        self.current = copy.deepcopy(self.baseline)
        for row in self.rows(self.baseline):
            float_wave(self.before_dir / row["file"])
            float_wave(self.after_dir / row["file"])
        self.before_audio = {path.name: path.read_bytes() for path in self.before_dir.glob("*.wav")}
        self.attempt = 0

    @staticmethod
    def rows(manifest: dict) -> list[dict]:
        return manifest["listening"] + manifest.get("fullChainListening", [])

    def run_cli(self, *, vintage_only: bool = False) -> tuple[subprocess.CompletedProcess, Path]:
        self.attempt += 1
        before_manifest = self.before_dir / "manifest.json"
        after_manifest = self.after_dir / "manifest.json"
        before_manifest.write_text(json.dumps(self.baseline), encoding="utf-8")
        after_manifest.write_text(json.dumps(self.current), encoding="utf-8")
        output = self.root / f"comparison-{self.attempt}"
        args = [sys.executable, "-B", str(TOOL), "--baseline", str(before_manifest),
                "--after", str(after_manifest), "--output", str(output)]
        if vintage_only:
            args.append("--expect-vintage-only")
        result = subprocess.run(args, cwd=REPO, text=True, capture_output=True, check=False, timeout=30)
        return result, output

    def assert_rejected(self, result: subprocess.CompletedProcess, output: Path) -> None:
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse((output / "comparison.json").exists(), result.stdout)

    def assert_before_unchanged(self) -> None:
        self.assertEqual(self.before_audio,
                         {path.name: path.read_bytes() for path in self.before_dir.glob("*.wav")})

    def test_matching_pedal_and_full_chain_pairs_keep_native_levels_and_provenance(self) -> None:
        result, output = self.run_cli(vintage_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
        self.assertEqual(len(report["comparisons"]), len(self.rows(self.baseline)))
        self.assertEqual(report["audioQuality"], "not_asserted")
        self.assertTrue(report["expectVintageOnly"])
        self.assertEqual(report["baselineManifestSha256"],
                         hashlib.sha256((self.before_dir / "manifest.json").read_bytes()).hexdigest())
        full_chain = [row for row in report["comparisons"] if row["fullChain"]]
        self.assertEqual(len(full_chain), len(self.baseline["fullChainListening"]))
        self.assertEqual(full_chain[0]["controls"], self.baseline["fullChainListening"][0]["rackState"])
        for row in report["comparisons"]:
            with self.subTest(file=row["file"]):
                self.assertEqual(row["before"]["sha256"], row["after"]["sha256"])
                self.assertEqual(row["after"]["samplePeak"], 0.5)
                self.assertEqual(row["after"]["frames"], 4)
                self.assertEqual((output / "before" / row["file"]).read_bytes(), self.before_audio[row["file"]])
                self.assertEqual((output / "after" / row["file"]).read_bytes(), self.before_audio[row["file"]])
        self.assert_before_unchanged()

    def test_changed_fuzz_off_full_chain_is_rejected_without_scope_flag(self) -> None:
        filename = "full-guitar-fuzz-off.wav"
        float_wave(self.after_dir / filename, tuple(value * 0.8 for value in SAMPLES))
        result, output = self.run_cli()
        self.assert_rejected(result, output)
        self.assertIn("fuzz-off", result.stderr)
        self.assert_before_unchanged()

    def test_changed_sustain_gated_or_bass_is_rejected_in_both_export_groups(self) -> None:
        filenames = [row["file"] for row in self.rows(self.baseline)
                     if row["bassProfile"] or row.get("fuzzVoice", row.get("fuzz", {}).get("voice")) in (1, 2)]
        self.assertEqual(len(filenames), 6)
        for filename in filenames:
            with self.subTest(file=filename):
                float_wave(self.after_dir / filename, tuple(value * 0.8 for value in SAMPLES))
                result, output = self.run_cli(vintage_only=True)
                self.assert_rejected(result, output)
                self.assertIn("outside Guitar/Vintage", result.stderr)
                (self.after_dir / filename).write_bytes(self.before_audio[filename])
        self.assert_before_unchanged()

    def test_changed_guitar_vintage_is_allowed_and_neither_side_is_normalized(self) -> None:
        changed = ("guitar-vintage-combined-wet.wav", "full-guitar-vintage.wav")
        for filename in changed:
            float_wave(self.after_dir / filename, tuple(value * 0.5 for value in SAMPLES))
        candidate_audio = {name: (self.after_dir / name).read_bytes() for name in changed}
        result, output = self.run_cli(vintage_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
        for row in report["comparisons"]:
            if row["file"] in changed:
                self.assertNotEqual(row["before"]["sha256"], row["after"]["sha256"])
                self.assertEqual(row["before"]["samplePeak"], 0.5)
                self.assertEqual(row["after"]["samplePeak"], 0.25)
                self.assertEqual((output / "after" / row["file"]).read_bytes(), candidate_audio[row["file"]])
        self.assert_before_unchanged()

    def test_mismatched_full_chain_resources_controls_or_source_are_rejected(self) -> None:
        baseline_current = copy.deepcopy(self.current)
        mismatches = (("resources", "ampSha256", "e" * 64),
                      ("resources", "cabSha256", "e" * 64),
                      ("resources", "ampIncludesCab", True),
                      ("rackState", "driveGain", 0.9),
                      ("source", "sha256", "e" * 64),
                      ("source", "renderedInputSha256", "e" * 64))
        for section, key, value in mismatches:
            with self.subTest(section=section, key=key):
                self.current = copy.deepcopy(baseline_current)
                self.current["fullChainListening"][1][section][key] = value
                result, output = self.run_cli()
                self.assert_rejected(result, output)
                self.assertIn("Different full-chain", result.stderr)
        for key, value in (("down", 0.8), ("stageMask", 1), ("fuzzVoice", 2)):
            with self.subTest(key=key):
                self.current = copy.deepcopy(baseline_current)
                self.current["fullChainListening"][1][key] = value
                result, output = self.run_cli()
                self.assert_rejected(result, output)
                self.assertIn("Different full-chain", result.stderr)

    def test_mismatched_pedal_controls_or_input_samples_are_rejected(self) -> None:
        baseline_current = copy.deepcopy(self.current)
        for section, key, value in (("fuzz", "drive", 0.9),
                                    ("source", "sha256", "e" * 64),
                                    ("source", "renderedInputSha256", "e" * 64)):
            with self.subTest(section=section, key=key):
                self.current = copy.deepcopy(baseline_current)
                self.current["listening"][2][section][key] = value
                result, output = self.run_cli()
                self.assert_rejected(result, output)
                self.assertIn("Different", result.stderr)

    def test_missing_baseline_rows_are_rejected_instead_of_omitted(self) -> None:
        baseline_current = copy.deepcopy(self.current)
        for group in ("listening", "fullChainListening"):
            for remove_all in (False, True):
                with self.subTest(group=group, remove_all=remove_all):
                    self.current = copy.deepcopy(baseline_current)
                    if remove_all:
                        self.current[group].clear()
                    else:
                        self.current[group].pop()
                    result, output = self.run_cli(vintage_only=True)
                    self.assert_rejected(result, output)
        self.assert_before_unchanged()

    def test_missing_audio_file_rejects_an_otherwise_matching_manifest(self) -> None:
        (self.after_dir / "full-guitar-vintage.wav").unlink()
        result, output = self.run_cli()
        self.assert_rejected(result, output)
        self.assert_before_unchanged()

    def test_added_legacy_clean50_pair_is_reconstructed_without_dropping_coverage(self) -> None:
        row = copy.deepcopy(self.current["listening"][2])
        row["file"] = "guitar-vintage-combined-clean50-wet.wav"
        row["fuzz"]["cleanMix"] = 0.5
        self.current["listening"].append(row)
        gain = 10 ** (row["fuzz"]["levelDb"] / 20)
        expected = tuple(0.5 * value + 0.5 * gain * value for value in SAMPLES)
        float_wave(self.after_dir / row["file"], expected)
        result, output = self.run_cli(vintage_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
        self.assertEqual(len(report["comparisons"]), len(self.rows(self.baseline)) + 1)
        comparison = next(item for item in report["comparisons"] if item["file"] == row["file"])
        self.assertIn("QA reconstruction", comparison["baselineProvenance"]["kind"])
        self.assertAlmostEqual(comparison["before"]["samplePeak"], max(map(abs, expected)), places=7)
        self.assertEqual(comparison["before"]["frames"], comparison["after"]["frames"])
        self.assertEqual(comparison["before"]["samplePeak"], comparison["after"]["samplePeak"])
        self.assertEqual(comparison["before"]["rms"], comparison["after"]["rms"])
        self.assert_before_unchanged()


if __name__ == "__main__":
    unittest.main()
