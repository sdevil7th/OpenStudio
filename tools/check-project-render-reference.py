"""Compare a neutral saved-project render with an independent source-file mix.

QA only: reads originals, never writes project/media or serves production audio.
Requires numpy and soundfile. Unsupported signal processing fails closed rather
than claiming a partial reference validates the complete project.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf


def pan_gains(pan: float, law: str) -> np.ndarray:
    pan = max(-1.0, min(1.0, pan))
    if law == "linear":
        return np.array([min(1.0, 1.0 - pan), min(1.0, 1.0 + pan)])
    angle = (pan + 1.0) * math.pi / 4.0
    return np.array([math.cos(angle), math.sin(angle)])


def reference_check(project_path: Path, render_path: Path, start: float = 0.0,
                    law: str = "linear", tolerance: float = 5e-5,
                    track_id: str | None = None) -> dict:
    raw = project_path.read_bytes()
    project = json.loads(raw.decode("utf-8"))
    unsupported: list[str] = []
    for key in ("masterFXPaths", "masterAutomationLanes"):
        if project.get(key):
            unsupported.append(key)
    tracks = project["tracks"]
    if track_id:
        tracks = [track for track in tracks if track["id"] == track_id]
        if not tracks:
            raise ValueError(f"Missing reference track: {track_id}")
        # Native stem:<id> exports bypass the master stage.
        project.update(masterVolume=1, masterPan=0, masterTrimVolumeDB=0,
                       masterMono=False, isMasterMuted=False)
    solo = any(track.get("soloed") for track in tracks)
    active = []
    for track in tracks:
        if track.get("muted") or (solo and not track.get("soloed") and not track.get("soloSafe")):
            continue
        if not track.get("masterSendEnabled", True):
            continue
        name = track.get("name", track["id"])
        for key in ("fxChainPaths", "trackFXPaths", "inputFXPaths", "fxPaths", "sends"):
            if track.get(key):
                unsupported.append(f"{name}: {key}")
        if any(lane.get("points") for lane in track.get("automationLanes", [])):
            unsupported.append(f"{name}: automation")
        if track.get("stereoWidth", 100) != 100 or track.get("phaseInverted"):
            unsupported.append(f"{name}: width/polarity")
        if track.get("type") == "instrument" or track.get("instrumentPath") or track.get("instrumentState"):
            unsupported.append(f"{name}: instrument")
        if track.get("type") not in ("audio", None):
            # A MIDI-only track without an instrument has no internal audio.
            continue
        for clip in track.get("clips", []):
            if clip.get("muted"):
                continue
            if clip.get("gainEnvelope") or clip.get("playbackRate", 1) != 1:
                unsupported.append(f"{name}: clip envelope/rate")
        active.append(track)
    report = {
        "classification": "deterministic_source_reference",
        "project": str(project_path.resolve()), "projectSha256": hashlib.sha256(raw).hexdigest(),
        "render": str(render_path.resolve()), "panLaw": law, "tolerance": tolerance,
        "trackId": track_id,
        "unsupported": unsupported, "audioQuality": "not_asserted",
    }
    if unsupported:
        return {**report, "status": "not_asserted", "reason": "Reference cannot represent active processing."}
    handles: dict[str, sf.SoundFile] = {}
    clips: list[tuple[dict, dict, sf.SoundFile]] = []
    try:
        for track in active:
            for clip in track.get("clips", []):
                if clip.get("muted"):
                    continue
                source = str(Path(clip["filePath"]).resolve())
                if source not in handles:
                    handles[source] = sf.SoundFile(source)
                clips.append((track, clip, handles[source]))
        with sf.SoundFile(render_path) as rendered:
            if rendered.channels != 2:
                return {**report, "status": "not_asserted", "reason": "Stereo reference required."}
            rate = rendered.samplerate
            maximum = square_error = square_expected = square_actual = 0.0
            windows = compared = 0
            dropouts = []
            outliers: list[dict] = []
            outlier_count = 0
            for block in rendered.blocks(blocksize=65536, dtype="float64", always_2d=True):
                time = start + (compared + np.arange(len(block))) / rate
                expected = np.zeros_like(block)
                for track, clip, source in clips:
                    local = time - float(clip["startTime"]) - float(track.get("playbackOffsetMs", 0)) / 1000
                    mask = (local >= 0) & (local < float(clip["duration"]))
                    if not np.any(mask):
                        continue
                    position = (float(clip.get("offset", 0)) + local[mask]) * source.samplerate
                    first = max(0, int(np.floor(position.min())) - 1)
                    last = min(source.frames, int(np.floor(position.max())) + 3)
                    source.seek(first)
                    data = source.read(last - first, dtype="float64", always_2d=True)
                    if not len(data):
                        continue
                    coordinate = position - first
                    base = np.floor(coordinate).astype(np.int64)
                    fraction = (coordinate - base)[:, None]
                    # Catmull-Rom interpolation evaluated independently in float64.
                    a, b, c, d = (data[np.clip(base + shift, 0, len(data) - 1)] for shift in (-1, 0, 1, 2))
                    values = b + 0.5 * fraction * (c - a + fraction *
                        (2 * a - 5 * b + 4 * c - d + fraction * (3 * b - a - 3 * c + d)))
                    values = values[:, :2]
                    if values.shape[1] == 1:
                        values = np.repeat(values, 2, axis=1)
                    elif track.get("trackChannelCount", 2) == 1:
                        values = np.repeat(values.mean(axis=1, keepdims=True), 2, axis=1)
                    local = local[mask]
                    gain = np.ones(len(values)) * 10 ** (float(clip.get("volumeDB", 0)) / 20)
                    for fade, entering in (("fadeIn", True), ("fadeOut", False)):
                        duration = float(clip.get(fade, 0))
                        if duration <= 0:
                            continue
                        x = np.clip((local if entering else float(clip["duration"]) - local) / duration, 0, 1)
                        shape = clip.get(fade + "Shape", 0)
                        if shape == 1:
                            x = np.sqrt(x)
                        elif shape == 2:
                            x = x * x * (3 - 2 * x)
                        elif shape == 3:
                            x = np.log10(1 + 9 * x)
                        elif shape == 4:
                            x = (10 ** x - 1) / 9
                        gain *= x
                    track_gain = 10 ** ((float(track.get("volumeDB", 0)) + float(track.get("trimVolumeDB", 0))) / 20)
                    expected[mask] += values * gain[:, None] * track_gain * pan_gains(float(track.get("pan", 0)), law)
                if project.get("isMasterMuted"):
                    expected.fill(0)
                else:
                    expected *= float(project.get("masterVolume", 1)) * 10 ** (float(project.get("masterTrimVolumeDB", 0)) / 20)
                    expected *= pan_gains(float(project.get("masterPan", 0)), law)
                    if project.get("masterMono"):
                        expected[:] = expected.mean(axis=1, keepdims=True)
                error = block - expected
                positions = np.argwhere(np.abs(error) > tolerance)
                outlier_count += len(positions)
                for frame, channel in positions[:20]:
                    outliers.append({"time": start + (compared + int(frame)) / rate,
                        "frame": compared + int(frame), "channel": int(channel),
                        "actual": float(block[frame, channel]), "expected": float(expected[frame, channel]),
                        "error": float(error[frame, channel])})
                outliers = sorted(outliers, key=lambda item: abs(item["error"]), reverse=True)[:20]
                maximum = max(maximum, float(np.max(np.abs(error))))
                square_error += float(np.sum(error * error))
                square_expected += float(np.sum(expected * expected))
                square_actual += float(np.sum(block * block))
                for offset in range(0, len(block), 4800):
                    target = expected[offset:offset + 4800]
                    actual = block[offset:offset + 4800]
                    target_rms = float(np.sqrt(np.mean(target * target)))
                    actual_rms = float(np.sqrt(np.mean(actual * actual)))
                    if target_rms > 1e-4 and actual_rms < target_rms * 0.01:
                        dropouts.append({"time": start + (compared + offset) / rate,
                                         "expectedRms": target_rms, "actualRms": actual_rms})
                    windows += 1
                compared += len(block)
            report.update({"sampleRate": rate, "frames": compared, "activeAudioTracks": len(active),
                "audioClips": len(clips), "sourceFiles": len(handles), "windows": windows,
                "maxAbsoluteError": maximum, "rmsError": math.sqrt(square_error / max(1, compared * 2)),
                "expectedRms": math.sqrt(square_expected / max(1, compared * 2)),
                "actualRms": math.sqrt(square_actual / max(1, compared * 2)),
                "missingAudioWindows": dropouts,
                "samplesAboveTolerance": outlier_count, "largestErrors": outliers,
                "status": "pass" if maximum <= tolerance and not dropouts else "fail"})
            return report
    finally:
        for source in handles.values():
            source.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--render", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--pan-law", choices=["linear", "constant-power"], default="linear")
    parser.add_argument("--tolerance", type=float, default=5e-5)
    parser.add_argument("--track", help="Compare a native stem export of this saved track.")
    args = parser.parse_args()
    result = reference_check(args.project, args.render, args.start, args.pan_law, args.tolerance, args.track)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["status"] == "pass" else 2)
