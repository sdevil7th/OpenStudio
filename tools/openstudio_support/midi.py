from __future__ import annotations

from collections import Counter
import json
import math
import os
from pathlib import Path
import struct
import subprocess

from .common import check, regular_file, report, sha256

MAX_EVENTS = 250000
KINDS = {0x80: "noteOff", 0x90: "noteOn", 0xA0: "polyPressure", 0xB0: "cc",
         0xC0: "programChange", 0xD0: "channelPressure", 0xE0: "pitchBend"}


class Reader:
    def __init__(self, data):
        self.data, self.position = data, 0

    def take(self, count):
        if count < 0 or self.position + count > len(self.data):
            raise ValueError("Truncated MIDI chunk/event")
        value = self.data[self.position:self.position + count]
        self.position += count
        return value

    def vlq(self):
        value = 0
        for _ in range(4):
            byte = self.take(1)[0]
            value = (value << 7) | (byte & 127)
            if byte < 128:
                return value
        raise ValueError("Invalid MIDI variable-length quantity")


def parse_midi(data: bytes):
    reader = Reader(data)
    if reader.take(4) != b"MThd":
        raise ValueError("Missing standard MIDI header")
    header = reader.take(struct.unpack(">I", reader.take(4))[0])
    if len(header) < 6:
        raise ValueError("Short MIDI header")
    format_id, track_count, division = struct.unpack(">HHH", header[:6])
    if format_id not in (0, 1) or division & 0x8000:
        raise NotImplementedError("This inspector supports synchronous SMF type 0/1 with quarter-note timing; type 2/SMPTE timing is not asserted.")
    if division == 0 or track_count == 0 or track_count > 1024 or (format_id == 0 and track_count != 1):
        raise ValueError("Invalid MIDI track count or time division")
    tracks, count = [], 0
    for _ in range(track_count):
        if reader.take(4) != b"MTrk":
            raise ValueError("Missing MIDI track chunk")
        track = Reader(reader.take(struct.unpack(">I", reader.take(4))[0]))
        events, tempos, meters = [], [], []
        running, tick, ended, name = None, 0, False, ""
        extra = Counter()
        while track.position < len(track.data):
            tick += track.vlq()
            first = track.take(1)[0]
            if first < 128:
                if running is None:
                    raise ValueError("MIDI running status without a preceding channel status")
                status, prefix = running, bytes([first])
            else:
                status, prefix = first, b""
            count += 1
            if count > MAX_EVENTS:
                raise ValueError("MIDI exceeds the 250,000-event inspection limit")
            if 0x80 <= status <= 0xEF:
                running = status
                high = status & 0xF0
                values = prefix + track.take((1 if high in (0xC0, 0xD0) else 2) - len(prefix))
                if any(value > 127 for value in values):
                    raise ValueError("MIDI channel data byte has its status bit set")
                kind, channel = KINDS[high], (status & 15) + 1
                if high == 0x90 and values[1] == 0:
                    kind = "noteOff"
                address = values[0] if high in (0x80, 0x90, 0xA0, 0xB0) else 0
                value = values[0] | (values[1] << 7) if high == 0xE0 else values[-1]
                events.append({"tick": tick, "kind": kind, "channel": channel, "address": address, "value": value})
            elif status == 0xFF:
                running = None
                meta = track.take(1)[0]
                payload = track.take(track.vlq())
                if meta == 0x2F:
                    if payload or track.position != len(track.data):
                        raise ValueError("Invalid end-of-track event or data after it")
                    ended = True
                    break
                if meta == 0x51:
                    if len(payload) != 3 or int.from_bytes(payload, "big") == 0:
                        raise ValueError("Invalid tempo event")
                    tempos.append((tick, int.from_bytes(payload, "big")))
                elif meta == 0x58:
                    if len(payload) != 4 or payload[0] == 0 or payload[1] > 6:
                        raise ValueError("Invalid time signature event")
                    meters.append((tick, tuple(payload)))
                elif meta == 0x03:
                    name = payload.decode("utf-8", errors="replace")
                else:
                    extra[f"meta_{meta:02x}"] += 1
            elif status in (0xF0, 0xF7):
                running = None
                track.take(track.vlq())
                extra["sysex"] += 1
            else:
                raise ValueError("Unsupported status in standard MIDI file")
        if not ended:
            raise ValueError("MIDI track has no end-of-track marker")
        tracks.append({"name": name, "events": events, "tempos": tempos, "meters": meters,
                       "endTick": tick, "otherEvents": dict(extra)})
    if reader.position != len(data):
        raise ValueError("Extra data after declared MIDI tracks")
    return {"format": format_id, "ticksPerQuarterNote": division, "tracks": tracks}


def prepare_project(path: Path, clip_ids=()):
    import sys
    if getattr(sys, 'frozen', False):
        from .packaged import prepare_project as prepare_packaged
        return prepare_packaged(path, clip_ids)
    regular_file(path)
    script = Path(__file__).resolve().parents[1] / "prepare-support-midi.mjs"
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    result = subprocess.run(["node", str(script), str(path.resolve()), json.dumps(list(clip_ids))],
                            capture_output=True, text=True, encoding="utf-8", errors="replace",
                            timeout=60, **flags)
    if result.returncode:
        raise ValueError("Could not prepare this project with the checkout's MIDI serializer. " + result.stderr[-2000:])
    if len(result.stdout) > 32 * 1024 * 1024:
        raise ValueError("Prepared MIDI exceeds 32 MiB limit")
    return json.loads(result.stdout)


def expected_tracks(payload, ppq):
    timing = payload["timing"]
    markers = [(0.0, timing["tempo"])] + [(item["time"], item["bpm"]) for item in timing["tempoMarkers"]]
    markers.sort(key=lambda marker: marker[0])
    if any(not math.isfinite(float(t)) or not math.isfinite(float(bpm)) or t < 0 or bpm <= 0 for t, bpm in markers):
        raise ValueError("Invalid expected tempo map")
    markers = [(time, math.floor(60000000 / bpm + .5)) for time, bpm in markers]

    def ticks(seconds):
        total, previous, tempo = 0.0, 0.0, markers[0][1]
        for time, next_tempo in markers:
            if time > seconds:
                break
            total += (time - previous) * 1000000 / tempo * ppq
            previous, tempo = time, next_tempo
        return max(0, total + (seconds - previous) * 1000000 / tempo * ppq)

    def integer(event, field, default, low=0, high=127):
        value = event.get(field, default)
        if value is None:
            value = default
        if field in {"velocity", "releaseVelocity"} and 0 < value <= 1:
            value *= 127
        return min(high, max(low, math.floor(value + .5)))

    expected = []
    unsupported = list(payload.get("unsupported", []))
    for track in payload["tracks"]:
        events = []
        for clip in track["clips"]:
            for item in clip["events"]:
                kind = item["type"]
                if kind not in KINDS.values():
                    unsupported.append("Unsupported source event: " + kind)
                    continue
                address = integer(item, "note", 60) if kind in {"noteOn", "noteOff", "polyPressure"} else integer(item, "controller", 0) if kind == "cc" else 0
                if kind == "noteOn":
                    value = integer(item, "velocity", 100, 1)
                elif kind == "noteOff":
                    value = integer(item, "releaseVelocity" if "releaseVelocity" in item else "velocity", 0)
                else:
                    value = integer(item, "value", 8192 if kind == "pitchBend" else 0, 0, 16383 if kind == "pitchBend" else 127)
                events.append({"tick": ticks(clip["startTime"] + item["timestamp"]), "kind": kind,
                               "channel": integer(item, "channel", 1, 1, 16), "address": address, "value": value})
        events.sort(key=lambda event: event["tick"])
        if events:
            expected.append({"name": track["name"], "events": events})
    signature = timing["timeSignature"]
    denominator = signature["denominator"]
    if denominator < 1 or denominator > 64 or denominator & (denominator - 1):
        raise ValueError("Unsupported expected time signature")
    return expected, [(ticks(t), tempo) for t, tempo in markers], (signature["numerator"], int(math.log2(denominator)), 24, 8), unsupported


def compare_expected(parsed, payload, result):
    check_start = len(result["checks"])
    expected, tempos, meter, unsupported = expected_tracks(payload, parsed["ticksPerQuarterNote"])
    actual = [track for track in parsed["tracks"] if track["events"]]
    result["comparison"] = {"scope": payload["scope"], "sourceProjectSha256": payload["sourceProjectSha256"],
                            "rangeStart": payload["rangeStart"], "unsupported": unsupported,
                            "preparationSources": payload.get("preparationSources", {}),
                            "claim": "Matches the supplied saved snapshot and bundled/source serializer only; original export-time state is not established."}
    check(result, "source_representation", "not_asserted" if unsupported else "pass",
          "Unsupported source properties prevent a complete comparison." if unsupported else "All prepared channel event types are supported.")
    check(result, "musical_track_count", "pass" if len(expected) == len(actual) else "fail",
          "Compared tracks containing channel events; conductor-only tracks are counted separately.", expected=len(expected), actual=len(actual))
    failures = []
    total_mismatches = 0
    for track_index, (wanted, found) in enumerate(zip(expected, actual)):
        # Preserve order, including controllers at the same tick; counts alone are insufficient.
        mismatch = abs(len(wanted["events"]) - len(found["events"]))
        for index, (a, b) in enumerate(zip(wanted["events"], found["events"])):
            if any(a[key] != b[key] for key in ("kind", "channel", "address", "value")) or abs(a["tick"] - b["tick"]) > 1.000001:
                mismatch += 1
                if len(failures) < 20:
                    failures.append({"track": track_index + 1, "event": index, "expected": a, "actual": b})
        total_mismatches += mismatch
        check(result, f"track_{track_index + 1}_events", "fail" if mismatch else "pass",
              "Compared ordered channel events, values, and ticks (one-tick tolerance).", mismatches=mismatch,
              expectedEvents=len(wanted["events"]), actualEvents=len(found["events"]))
        check(result, f"track_{track_index + 1}_name", "pass" if wanted["name"] == found["name"] else "fail", "Compared track name with the selected project snapshot.")
    actual_tempos = sorted(set(item for track in parsed["tracks"] for item in track["tempos"]))
    tempo_ok = len(actual_tempos) == len(tempos) and all(abs(a[0] - b[0]) <= 1.000001 and a[1] == b[1] for a, b in zip(tempos, actual_tempos))
    check(result, "tempo_map", "pass" if tempo_ok else "fail", "Compared encoded tempos and their tick positions.")
    actual_meters = sorted(set(item for track in parsed["tracks"] for item in track["meters"]))
    check(result, "meter", "pass" if actual_meters == [(0, meter)] else "fail", "Compared time signature metadata, including click and notation fields.")
    result["comparison"].update(mismatches=total_mismatches, examples=failures)
    statuses = {item["status"] for item in result["checks"][check_start:]}
    result["comparison"]["status"] = "fail" if "fail" in statuses else "not_asserted" if "not_asserted" in statuses else "pass"


def inspect_midi(path: Path, project_path: Path | None = None, clip_ids=()):
    result = report("midi_export")
    if regular_file(path).st_size > 32 * 1024 * 1024:
        raise ValueError("MIDI input exceeds 32 MiB limit")
    data = path.read_bytes()
    import hashlib
    result["input"] = {"path": str(path.absolute()), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    result["limitations"] += ["A MIDI file contains musical instructions, not the instrument's audio or plugin state.",
                              "Unmatched note messages are diagnostic only: sustain, all-notes-off, or external state can affect interpretation."]
    try:
        parsed = parse_midi(data)
    except NotImplementedError as exc:
        check(result, "midi_structure", "not_asserted", str(exc))
        return result
    except ValueError as exc:
        check(result, "midi_structure", "fail", str(exc))
        return result
    check(result, "midi_structure", "pass", "Parsed all declared chunks, channel/meta events, and end-of-track markers.")
    result["midi"] = {"format": parsed["format"], "ticksPerQuarterNote": parsed["ticksPerQuarterNote"], "tracks": []}
    for track in parsed["tracks"]:
        active = Counter()
        unmatched = 0
        for event in track["events"]:
            key = (event["channel"], event["address"])
            if event["kind"] == "noteOn":
                active[key] += 1
            elif event["kind"] == "noteOff":
                if active[key]:
                    active[key] -= 1
                else:
                    unmatched += 1
        result["midi"]["tracks"].append({"name": track["name"], "eventCounts": dict(Counter(e["kind"] for e in track["events"])),
            "endTick": track["endTick"], "tempos": track["tempos"], "timeSignatures": track["meters"],
            "otherEvents": track["otherEvents"], "notePairing": {"classification": "diagnostic_only",
                "unmatchedNoteOffs": unmatched, "notesWithoutExplicitOff": sum(active.values())}})
    if project_path:
        try:
            payload = prepare_project(project_path, clip_ids)
            if payload["sourceProjectSha256"] != sha256(project_path):
                raise ValueError("Project changed during comparison")
            compare_expected(parsed, payload, result)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            check(result, "project_comparison", "not_asserted", str(exc))
    else:
        check(result, "project_comparison", "not_asserted", "No saved project supplied; structural validity does not establish event completeness.")
    return result
