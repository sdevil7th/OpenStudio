"""Offline support tests use synthetic media/projects only; never open an audio device."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parent))
from openstudio_support.common import Redactor, require_closed, save_report
from openstudio_support.collection import collect, bundle, LOG_LIMIT
from openstudio_support.audio import inspect_audio
from openstudio_support.midi import inspect_midi, parse_midi, compare_expected, prepare_project
from openstudio_support.cli import parser, run
from openstudio_support.common import report


def vlq(value):
    result = [value & 127]
    value >>= 7
    while value:
        result.insert(0, (value & 127) | 128)
        value >>= 7
    return bytes(result)


def midi_bytes(events=None, *, ppq=9600, name=b"Piano", end=True):
    events = events if events is not None else [(4800, b"\x90\x3c\x64"), (9600, b"\x80\x3c\x00")]
    body = b"\x00\xff\x51\x03\x07\xa1\x20\x00\xff\x58\x04\x04\x02\x18\x08"
    body += b"\x00\xff\x03" + vlq(len(name)) + name
    for delta, event in events:
        body += vlq(delta) + event
    if end:
        body += b"\x00\xff\x2f\x00"
    return b"MThd\x00\x00\x00\x06" + struct.pack(">HHH", 1, 1, ppq) + b"MTrk" + struct.pack(">I", len(body)) + body


def project():
    return {"version": "1.2.0", "tempo": 120, "timeSignature": {"numerator": 4, "denominator": 4},
            "tempoMarkers": [], "tracks": [{"id": "track-a", "name": "Piano", "type": "midi", "clips": [],
                "midiClips": [{"id": "clip-a", "startTime": 0, "duration": 1, "loopEnabled": False,
                    "events": [{"type": "noteOn", "timestamp": .25, "note": 60, "velocity": 100, "channel": 1},
                               {"type": "noteOff", "timestamp": .75, "note": 60, "velocity": 0, "channel": 1}]}]}]}


def payload():
    data = project()
    return {"scope": "project", "sourceProjectSha256": "fixture", "rangeStart": 0, "unsupported": [],
            "timing": {"tempo": 120, "tempoMarkers": [], "timeSignature": data["timeSignature"]},
            "tracks": [{"name": "Piano", "clips": data["tracks"][0]["midiClips"]}]}


def status(result, name):
    return next(item["status"] for item in result["checks"] if item["id"] == name)


class TemporaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()


class CollectionTests(TemporaryTest):
    def test_collection_allowlist_redaction_and_no_original_media(self):
        (self.root / "debug_log.txt").write_text('load failed "C:\\Users\\Alice\\Secret Song.wav"\napi_key=abcd\nBearer xyz\nhttps://example.test/?token=secret\n', encoding="utf-8")
        (self.root / "take.wav").write_bytes(b"private audio")
        (self.root / "song.osproj").write_text("private project")
        (self.root / "last_crash.dmp").write_bytes(b"private memory")
        before = (self.root / "debug_log.txt").read_bytes()
        result, files, redactor = collect([self.root], description="Cannot export")
        self.assertEqual(len(files), 1)
        text = next(iter(files.values())).decode()
        for private in ("Alice", "Secret Song", "abcd", "xyz", "example.test"):
            self.assertNotIn(private, text)
        self.assertEqual((self.root / "debug_log.txt").read_bytes(), before)
        save_report(self.root / "review", result, files, redactor)
        with self.assertRaises(ValueError):
            bundle(self.root / "review", self.root / "bundle.zip", False)
        bundle(self.root / "review", self.root / "bundle.zip", True)
        with zipfile.ZipFile(self.root / "bundle.zip") as archive:
            self.assertEqual(set(archive.namelist()), {"summary.txt", "report.json", "manifest.json", "evidence-01.txt"})
            self.assertNotIn(b"private", b"".join(archive.read(name) for name in archive.namelist()))

    def test_dump_is_explicit_and_identified_as_unredacted(self):
        (self.root / "last_crash.dmp").write_bytes(b"raw memory")
        result, files, _ = collect([self.root], include_dumps=True)
        self.assertEqual(files["evidence-01.dmp"], b"raw memory")
        self.assertTrue(result["artifacts"][0]["unredactedDump"])

    def test_long_logs_are_bounded_tail_with_disclosure(self):
        (self.root / "debug_log.txt").write_bytes(b"old\n" * LOG_LIMIT + b"new failure\n")
        result, files, _ = collect([self.root])
        self.assertTrue(result["artifacts"][0]["tailOnly"])
        self.assertLessEqual(len(files["evidence-01.txt"]), LOG_LIMIT)
        self.assertTrue(files["evidence-01.txt"].endswith(b"new failure\n"))

    def test_route_report_does_not_follow_sources(self):
        route = self.root / "route.json"
        route.write_text(json.dumps({"purpose": "manual_render_route_report", "clips": [{"audioFile": "C:/private/take.wav"}], "pluginState": "SECRET"}))
        result, files, _ = collect([], [route])
        self.assertEqual(len(files), 1)
        self.assertNotIn(b"SECRET", files["evidence-01.json"])

    def test_modified_evidence_is_not_bundled(self):
        save_report(self.root / "review", report("test"))
        (self.root / "review/summary.txt").write_text("modified")
        with self.assertRaises(ValueError):
            bundle(self.root / "review", self.root / "bundle.zip", True)
        self.assertFalse((self.root / "bundle.zip").exists())

    def test_path_traversal_manifest_rejected(self):
        save_report(self.root / "review", report("test"))
        path = self.root / "review/manifest.json"
        value = json.loads(path.read_text())
        value["files"][0]["file"] = "../secret.json"
        path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            bundle(path.parent, self.root / "bundle.zip", True)

    def test_existing_outputs_preserved(self):
        save_report(self.root / "review", report("test"))
        original = (self.root / "review/report.json").read_bytes()
        with self.assertRaises(FileExistsError):
            save_report(self.root / "review", report("other"))
        self.assertEqual((self.root / "review/report.json").read_bytes(), original)

    def test_absent_evidence_is_not_a_pass(self):
        result, files, _ = collect([self.root])
        self.assertEqual(status(result, "existing_evidence"), "not_asserted")
        self.assertEqual(files, {})

    def test_redaction_consistent_for_paths_and_names(self):
        redactor = Redactor()
        self.assertEqual(redactor.clean("C:/private/take.wav"), redactor.clean("C:\\private\\take.wav"))
        value = redactor.clean({"name": "Private title", "token": "secret", "error": "/home/alice/song.wav"})
        self.assertNotIn("Private", json.dumps(value))
        self.assertNotIn("alice", json.dumps(value))
        self.assertEqual(value["token"], "<redacted>")


class GuardTests(TemporaryTest):
    def test_guard_rejects_running_app_and_workers(self):
        for name in ("OpenStudio.exe", "OpenStudioCrashReporter.exe", "openstudio"):
            output = f'"{name}","123","Console","1","20 K"\n' if sys.platform == "win32" else '123 ' + name + "\n"
            with patch("openstudio_support.common.subprocess.run", return_value=subprocess.CompletedProcess([], 0, output, "")):
                with self.assertRaises(ValueError):
                    require_closed()

    def test_guard_excludes_only_its_own_pid(self):
        import os
        own = f'"OpenStudioSupport.exe","{os.getpid()}","Console","1","20 K"\n'
        other = '"explorer.exe","999","Console","1","20 K"\n'
        if sys.platform != 'win32':
            own = f'{os.getpid()} OpenStudioSupport\n'
            other = '999 desktop\n'
        with patch('openstudio_support.common.subprocess.run', return_value=subprocess.CompletedProcess([], 0, own + other, '')):
            require_closed()
        another = '"OpenStudioSupport.exe","123","Console","1","20 K"\n' if sys.platform == 'win32' else '123 OpenStudioSupport\n'
        with patch('openstudio_support.common.subprocess.run', return_value=subprocess.CompletedProcess([], 0, own + other + another, '')):
            with self.assertRaises(ValueError):
                require_closed()

    def test_guard_fails_closed_on_enumeration_error(self):
        with patch("openstudio_support.common.subprocess.run", side_effect=subprocess.CalledProcessError(1, "ps")):
            with self.assertRaises(subprocess.SubprocessError):
                require_closed()

    def test_refusal_precedes_any_file_writes(self):
        args = parser().parse_args(["collect", "--output", str(self.root / "out")])
        with patch("openstudio_support.cli.require_closed", side_effect=ValueError("app running")):
            with self.assertRaises(ValueError):
                run(args)
        self.assertFalse(args.output.exists())

    def test_cli_collect_and_bundle(self):
        (self.root / "debug_log.txt").write_text("render failed\n")
        with patch("openstudio_support.cli.require_closed"):
            code, message = run(parser().parse_args(["collect", "--log-dir", str(self.root), "--output", str(self.root / "review")]))
            self.assertEqual(code, 0)
            self.assertIn("not_asserted", message)
            code, _ = run(parser().parse_args(["bundle", str(self.root / "review"), "--reviewed", "--output", str(self.root / "support.zip")]))
            self.assertEqual(code, 0)


class AudioTests(TemporaryTest):
    def audio(self, frames=4800, subtype="PCM_16", values=None):
        import numpy as np
        import soundfile as sf
        path = self.root / "render.wav"
        sf.write(path, np.zeros((frames, 2)) if values is None else values, 48000, subtype=subtype)
        return path

    def test_silent_audio_valid_not_dropout_proof(self):
        path = self.audio()
        before = path.read_bytes()
        result = inspect_audio(path)
        self.assertEqual(status(result, "decode"), "pass")
        self.assertEqual(result["status"], "diagnostic_only")
        self.assertEqual(result["contentCompleteness"], "not_asserted")
        self.assertAlmostEqual(result["signalDiagnostics"]["longestExactSilenceSeconds"], .1)
        self.assertEqual(path.read_bytes(), before)

    def test_truncated_wave_is_not_silently_repaired_to_pass(self):
        path = self.audio()
        path.write_bytes(path.read_bytes()[:-40])
        result = inspect_audio(path)
        self.assertEqual(status(result, "container_length"), "fail")
        self.assertEqual(result["status"], "fail")

    def test_nonfinite_float_samples_fail(self):
        import numpy as np
        data = np.zeros((100, 2)); data[2, 0] = float("nan"); data[3, 1] = float("inf")
        result = inspect_audio(self.audio(subtype="FLOAT", values=data))
        self.assertEqual(status(result, "finite_samples"), "fail")
        json.dumps(result, allow_nan=False)

    def test_route_mismatch_and_unproven_association(self):
        route = self.root / "route.json"
        route.write_text(json.dumps({"purpose": "manual_render_route_report", "requestedOutputSampleRate": 48000,
            "actualSampleRate": 48000, "outputSamples": 9600, "channels": 1, "format": "wav", "clips": [], "tracks": []}))
        result = inspect_audio(self.audio(), route)
        self.assertEqual(status(result, "route_duration"), "fail")
        self.assertEqual(status(result, "route_channels"), "fail")
        self.assertEqual(status(result, "route_provenance"), "not_asserted")

    def test_lossy_duration_is_not_exactly_asserted(self):
        route = self.root / "route.json"
        route.write_text(json.dumps({"purpose": "manual_render_route_report", "requestedOutputSampleRate": 48000,
            "actualSampleRate": 48000, "outputSamples": 4800, "channels": 2, "format": "mp3"}))
        result = inspect_audio(self.audio(), route)
        self.assertEqual(status(result, "route_duration"), "not_asserted")

    def test_silence_spans_streaming_block_boundary(self):
        result = inspect_audio(self.audio(frames=40000))
        self.assertAlmostEqual(result["signalDiagnostics"]["longestExactSilenceSeconds"], 40000 / 48000)

    def neutral_reference(self):
        import numpy as np
        import soundfile as sf
        values = np.column_stack((np.linspace(-.2, .2, 4800), np.linspace(.2, -.2, 4800)))
        source = self.root / "source.wav"; sf.write(source, values, 48000, subtype="FLOAT")
        output = self.root / "mix.wav"; sf.write(output, values, 48000, subtype="FLOAT")
        project_file = self.root / "song.osproj"
        project_file.write_text(json.dumps({"tracks": [{"id": "track", "type": "audio", "clips": [
            {"id": "clip", "filePath": str(source), "startTime": 0, "duration": .1}]}]}))
        route = self.root / "route.json"
        route.write_text(json.dumps({"purpose": "manual_render_route_report", "source": "master", "startTimeSec": 0,
            "normalize": False, "channels": 2, "requestedOutputSampleRate": 48000, "actualSampleRate": 48000,
            "outputSamples": 4800, "format": "wav", "tracks": [{"id": "track"}]}))
        return output, project_file, route

    def test_independent_neutral_source_reference(self):
        output, source, route = self.neutral_reference()
        result = inspect_audio(output, route, source, reference=True)
        self.assertEqual(status(result, "source_reference"), "pass", result)
        self.assertEqual(status(result, "snapshot_track_ids"), "pass")
        self.assertEqual(result["contentCompleteness"], "not_asserted")

    def test_reference_rejects_unknown_processing_and_normalization(self):
        output, source, route = self.neutral_reference()
        data = json.loads(source.read_text()); data["tracks"][0]["channelStripEQEnabled"] = True
        source.write_text(json.dumps(data))
        result = inspect_audio(output, route, source, reference=True)
        self.assertEqual(status(result, "source_reference"), "not_asserted")
        data["tracks"][0]["channelStripEQEnabled"] = False; source.write_text(json.dumps(data))
        data = json.loads(route.read_text()); data["normalize"] = True; route.write_text(json.dumps(data))
        self.assertEqual(status(inspect_audio(output, route, source, reference=True), "source_reference"), "not_asserted")

    def test_reference_requires_plan_and_correct_start(self):
        output, source, route = self.neutral_reference()
        self.assertEqual(status(inspect_audio(output, None, source, reference=True), "source_reference"), "not_asserted")
        self.assertEqual(status(inspect_audio(output, route, source, reference=True, start=1), "source_reference"), "not_asserted")


class MIDITests(TemporaryTest):
    def test_structure_running_status_and_zero_velocity_off(self):
        parsed = parse_midi(midi_bytes([(0, b"\x90\x3c\x64"), (9600, b"\x3c\x00")]))
        self.assertEqual([e["kind"] for e in parsed["tracks"][0]["events"]], ["noteOn", "noteOff"])

    def test_bad_files_do_not_pass(self):
        for data in (b"", midi_bytes()[:-1], midi_bytes(end=False), midi_bytes() + b"extra",
                     midi_bytes([(0, b"\x3c\x64")]), midi_bytes([(0, b"\x90\x80\x64")])):
            with self.subTest(data=data[:8]), self.assertRaises(ValueError):
                parse_midi(data)

    def test_smpte_is_explicitly_unsupported(self):
        with self.assertRaises(NotImplementedError):
            parse_midi(midi_bytes(ppq=0xE728))

    def test_comparison_detects_missing_and_changed_notes(self):
        for events in ([(4800, b"\x90\x3d\x64"), (9600, b"\x80\x3d\x00")], [(4800, b"\x90\x3c\x64")]):
            result = report("midi_export")
            compare_expected(parse_midi(midi_bytes(events)), payload(), result)
            self.assertEqual(status(result, "track_1_events"), "fail")

    def test_correct_snapshot_comparison_is_scoped(self):
        result = report("midi_export")
        compare_expected(parse_midi(midi_bytes()), payload(), result)
        self.assertTrue(all(c["status"] == "pass" for c in result["checks"]))
        self.assertEqual(result["contentCompleteness"], "not_asserted")

    def test_timing_and_event_order_are_checked(self):
        result = report("midi_export")
        compare_expected(parse_midi(midi_bytes([(4804, b"\x90\x3c\x64"), (9600, b"\x80\x3c\x00")])), payload(), result)
        self.assertEqual(status(result, "track_1_events"), "fail")

    def test_no_project_only_asserts_structure(self):
        path = self.root / "export.mid"; path.write_bytes(midi_bytes())
        result = inspect_midi(path)
        self.assertEqual(status(result, "midi_structure"), "pass")
        self.assertEqual(status(result, "project_comparison"), "not_asserted")

    def test_real_frontend_serializer_and_full_comparison(self):
        source = self.root / "project.osproj"; source.write_text(json.dumps(project()))
        midi = self.root / "export.mid"; midi.write_bytes(midi_bytes())
        before = source.read_bytes()
        prepared = prepare_project(source)
        self.assertEqual(prepared["sourceProjectSha256"], hashlib.sha256(before).hexdigest())
        result = inspect_midi(midi, source)
        self.assertEqual(status(result, "track_1_events"), "pass", result)
        self.assertEqual(source.read_bytes(), before)

    def test_real_selected_clip_serializer_rebases_tempo(self):
        data = project(); data["tracks"][0]["midiClips"][0]["startTime"] = 4
        data["tempoMarkers"] = [{"id": "tempo-a", "time": 2, "tempo": 60}]
        source = self.root / "project.osproj"; source.write_text(json.dumps(data))
        prepared = prepare_project(source, ["clip-a"])
        self.assertEqual(prepared["rangeStart"], 4)
        self.assertEqual(prepared["timing"]["tempo"], 60)
        self.assertEqual(prepared["tracks"][0]["clips"][0]["startTime"], 0)

    def test_missing_selected_clip_is_rejected(self):
        source = self.root / "project.osproj"; source.write_text(json.dumps(project()))
        with self.assertRaises(ValueError):
            prepare_project(source, ["missing"])

    def test_tempo_change_tick_integration(self):
        expected = payload()
        expected["timing"]["tempoMarkers"] = [{"time": 1, "bpm": 60}]
        expected["tracks"][0]["clips"][0]["events"][0]["timestamp"] = 2
        expected["tracks"][0]["clips"][0]["events"][1]["timestamp"] = 2.5
        events = [(19200, b"\xff\x51\x03\x0f\x42\x40"), (9600, b"\x90\x3c\x64"), (4800, b"\x80\x3c\x00")]
        result = report("midi_export")
        compare_expected(parse_midi(midi_bytes(events)), expected, result)
        self.assertEqual(result["comparison"]["status"], "pass", result)

    def test_same_tick_controller_order_is_not_lost_in_counts(self):
        expected = payload()
        expected["tracks"][0]["clips"][0]["events"] = [
            {"type": "cc", "timestamp": 0, "controller": 0, "value": 1, "channel": 2},
            {"type": "programChange", "timestamp": 0, "value": 5, "channel": 2}]
        result = report("midi_export")
        compare_expected(parse_midi(midi_bytes([(0, b"\xc1\x05"), (0, b"\xb1\x00\x01")])), expected, result)
        self.assertEqual(status(result, "track_1_events"), "fail")


class WindowTests(unittest.TestCase):
    def test_standalone_window_builds_without_starting_work(self):
        import tkinter as tk
        from openstudio_support.gui import create_window
        root = tk.Tk(); root.withdraw()
        close = create_window(root)
        try:
            root.update_idletasks()
            self.assertIn("Offline support", root.title())
            self.assertLessEqual(root.winfo_reqwidth(), 820)
            self.assertLessEqual(root.winfo_reqheight(), 720)
        finally:
            close()


class PackagedSerializerTests(TemporaryTest):
    def test_embedded_serializer_matches_source_for_loops_and_selection(self):
        import importlib.util
        if importlib.util.find_spec('quickjs') is None:
            self.skipTest('Run in .venv-support for embedded serializer parity')
        from openstudio_support.packaged import prepare_project as prepare_embedded
        subprocess.run(['node', str(Path(__file__).parent / 'build-support-midi.mjs'), str(self.root)], check=True)
        data = project()
        clip = data['tracks'][0]['midiClips'][0]
        clip.update(startTime=4, duration=6, loopEnabled=True, sourceDuration=1)
        data['tempoMarkers'] = [{'id': 'tempo-a', 'time': 2, 'tempo': 60}]
        clip['ccEvents'] = [{'time': .1, 'cc': 1, 'value': 90, 'channel': 1}]
        source = self.root / 'project.osproj'
        source.write_text(json.dumps(data), encoding='utf-8')
        for selection in ([], ['clip-a']):
            expected = prepare_project(source, selection)
            actual = prepare_embedded(source, selection, resources=self.root)
            expected.pop('preparationSources'); actual.pop('preparationSources')
            self.assertEqual(actual, expected)


class PackageInventoryTests(TemporaryTest):
    def test_missing_runtime_and_wrong_version_are_rejected(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('support_validator', Path(__file__).parent / 'validate-support-tool.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        files = ['OpenStudioSupport.exe', 'support-runtime/support-midi.js',
                 'support-runtime/support-midi-sources.json', 'support-runtime/support-build.json',
                 'support-runtime/support-licenses/README.txt'] + [f'support-runtime/library-{i}.dll' for i in range(20)]
        for name in files:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')
        (self.root / 'support-runtime/support-build.json').write_text(json.dumps({'version': '0.0.0', 'launch': 'manual_only'}))
        (self.root / 'support-runtime/support-package.json').write_text(json.dumps({'version': '0.0.0', 'files': files}))
        self.assertEqual(module.validate(self.root, '0.0.0', platform='win32'), len(files))
        with self.assertRaises(ValueError):
            module.validate(self.root, '0.0.1', platform='win32')
        (self.root / 'support-runtime/library-1.dll').unlink()
        with self.assertRaises(ValueError):
            module.validate(self.root, '0.0.0', platform='win32')


if __name__ == "__main__":
    unittest.main()
