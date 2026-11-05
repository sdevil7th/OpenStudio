from __future__ import annotations

import math
from pathlib import Path
import struct

from .common import check, read_json, regular_file, report, sha256


def container_check(path: Path, result: dict):
    """Detect declared RIFF/AIFF lengths beyond EOF even if a decoder repairs them."""
    size = path.stat().st_size
    with path.open("rb") as stream:
        head = stream.read(12)
        if len(head) < 12:
            check(result, "container_length", "fail", "File is too short for an audio container header.")
            return
        if head[:4] not in {b"RIFF", b"RIFX", b"FORM"}:
            check(result, "container_length", "not_asserted", "No independent container-length check for this format; decoder checks still run.")
            return
        order = "<" if head[:4] == b"RIFF" else ">"
        declared = struct.unpack(order + "I", head[4:8])[0] + 8
        valid = 12 <= declared <= size
        position = 12
        while valid and position < declared:
            stream.seek(position)
            chunk = stream.read(8)
            if len(chunk) != 8:
                valid = False
                break
            length = struct.unpack(order + "I", chunk[4:])[0]
            position += 8 + length + (length % 2)
            valid = position <= declared
        check(result, "container_length", "pass" if valid and position == declared else "fail",
              "Checked declared container and chunk boundaries against the file size.",
              declaredBytes=declared, actualBytes=size)


def inspect_audio(path: Path, route_path: Path | None = None, project_path: Path | None = None,
                  reference=False, start=0.0, pan_law="linear"):
    result = report("audio_export")
    regular_file(path)
    initial = path.stat()
    result["input"] = {"path": str(path.absolute()), "bytes": initial.st_size, "sha256": sha256(path)}
    result["limitations"] += ["Decodable audio and correct duration do not prove every intended track is audible.",
                              "Silence and full-scale samples are diagnostic only, not proof of dropouts or audible distortion."]
    container_check(path, result)
    if path.suffix.lower() in {".raw", ".pcm"}:
        check(result, "decode", "not_asserted", "Raw PCM has no self-describing format; supply a container export for inspection.")
        return result
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        check(result, "decode", "not_asserted", "Install tools/support-requirements.txt in a separate Python environment to inspect audio.")
        return result
    result["decoder"] = {"soundfile": sf.__version__, "libsndfile": sf.__libsndfile_version__}
    try:
        with sf.SoundFile(path) as audio:
            if audio.channels > 64:
                check(result, "decode", "not_asserted", "Channel count exceeds the inspector's 64-channel memory bound.")
                return result
            rate, channels, declared_frames = audio.samplerate, audio.channels, audio.frames
            result["audio"] = {"sampleRate": rate, "channels": channels, "format": audio.format,
                               "subtype": audio.subtype, "declaredFrames": declared_frames}
            visited = nonfinite = fullscale = trailing_zeros = longest_zeros = 0
            peak = energy = 0.0
            for block in audio.blocks(blocksize=16384, dtype="float64", always_2d=True):
                visited += len(block)
                finite = np.isfinite(block)
                nonfinite += int(np.count_nonzero(~finite))
                values = np.where(finite, block, 0.0)
                peak = max(peak, float(np.max(np.abs(values))))
                # Avoid overflow for malformed float files; retain finite report JSON.
                bounded = np.clip(values, -1e100, 1e100)
                energy += float(np.sum(bounded * bounded))
                fullscale += int(np.count_nonzero(np.abs(values) >= 1.0))
                zeros = np.all(block == 0, axis=1)
                edges = np.flatnonzero(np.diff(np.concatenate(([False], zeros, [False]))))
                if len(edges):
                    lengths = edges[1::2] - edges[::2]
                    if edges[0] == 0:
                        lengths[0] += trailing_zeros
                    longest_zeros = max(longest_zeros, int(np.max(lengths)))
                    trailing_zeros = int(lengths[-1]) if edges[-1] == len(block) else 0
                else:
                    trailing_zeros = 0
            result["audio"].update(framesRead=visited, durationSeconds=visited / rate,
                                    nonFiniteSamples=nonfinite)
            result["signalDiagnostics"] = {"classification": "diagnostic_only", "samplePeak": peak,
                "rmsWithExtremeValuesClamped": math.sqrt(energy / max(1, visited * channels)),
                "fullScaleSampleCount": fullscale, "longestExactSilenceSeconds": longest_zeros / rate}
            check(result, "decode", "pass" if visited == declared_frames and visited > 0 else "fail",
                  "Read the entire decoder-reported audio stream.", framesRead=visited, declaredFrames=declared_frames)
            check(result, "finite_samples", "pass" if nonfinite == 0 else "fail",
                  "Checked for NaN and infinite samples.", count=nonfinite)
    except (RuntimeError, ValueError, OSError) as exc:
        check(result, "decode", "fail", str(exc))
    if route_path:
        compare_route(result, read_json(route_path), route_path)
    if project_path:
        compare_project(result, path, project_path, reference, start, pan_law)
    final = path.stat()
    check(result, "input_stable", "pass" if (initial.st_size, initial.st_mtime_ns) == (final.st_size, final.st_mtime_ns) else "fail",
          "Input size and modification time remained stable during inspection.")
    return result


def compare_project(result, audio_path, project_path, reference, start, pan_law):
    project = read_json(project_path)
    if (not isinstance(project, dict) or not isinstance(project.get("tracks"), list)
            or any(not isinstance(track, dict) or not isinstance(track.get("clips", []), list)
                   or any(not isinstance(clip, dict) for clip in track.get("clips", [])) for track in project["tracks"])):
        check(result, "project_snapshot", "fail", "Invalid project snapshot")
        return
    fingerprint = sha256(project_path)
    result["projectSnapshot"] = {"path": str(project_path.absolute()), "sha256": fingerprint,
                                  "associationWithOriginalExport": "not_asserted"}
    route = result.get("routeReport")
    if route:
        expected = {track.get("id") for track in project["tracks"] if isinstance(track, dict)}
        observed = {track.get("id") for track in route["tracks"] if isinstance(track, dict)}
        check(result, "snapshot_track_ids", "pass" if expected == observed and None not in expected else "fail",
              "Compared saved-project track IDs with the supplied backend snapshot; this does not prove an export-time match.",
              missingInRoute=sorted(str(item) for item in expected - observed),
              extraInRoute=sorted(str(item) for item in observed - expected))
    sources = []
    for track in project["tracks"]:
        for clip in track.get("clips", []):
            source = clip.get("filePath")
            if isinstance(source, str):
                file = Path(source)
                sources.append({"clipId": clip.get("id"), "path": source,
                                "availableAtCollectionTime": file.is_file() if file.is_absolute() else None})
    result["projectSourcesAtCollectionTime"] = sources
    if not reference:
        check(result, "source_reference", "not_asserted", "Full source comparison was not requested. Use --reference for supported neutral audio projects.")
        return
    # The existing QA reference models only a subset of the engine. Tighten its
    # admission here; a decoder/reference success must not hide unmodelled DSP.
    unsupported = []
    if not route:
        unsupported.append("render route report is required to establish scope and normalization settings")
    if route and route.get("startTimeSec") != start:
        unsupported.append("reference start differs from the supplied render plan")
    if result["status"] == "fail":
        unsupported.append("file/metadata checks already failed")
    if route and route.get("source") != "master":
        unsupported.append("only full master scope is supported by this inspector's reference mode")
    if route and route.get("normalize"):
        unsupported.append("normalization")
    if result.get("audio", {}).get("format") not in {"WAV", "WAVEX", "RF64", "AIFF", "FLAC"}:
        unsupported.append("reference requires lossless container audio")
    for track in project["tracks"]:
        if track.get("type", "audio") != "audio":
            unsupported.append("non-audio track")
        for key in ("channelStripEQEnabled", "channelStripEQState", "eqEnabled", "isFolder", "frozen", "midiClips", "unavailableFX", "trackFXSidechains"):
            if track.get(key):
                unsupported.append(key)
        for clip in track.get("clips", []):
            for key in ("crossfadeLayers", "crossfadeGainLayers", "sourceStart", "loopOffset", "loopEnabled", "reversed", "reverse", "pitchShift", "gainEnvelope", "pan"):
                if clip.get(key):
                    unsupported.append(key)
            if not Path(clip.get("filePath", "")).is_absolute():
                unsupported.append("relative or absent source path")
    if unsupported:
        check(result, "source_reference", "not_asserted", "Reference cannot represent this saved processing state.", unsupported=sorted(set(unsupported)))
        return
    try:
        import importlib.util
        script = Path(__file__).resolve().parents[1] / "check-project-render-reference.py"
        spec = importlib.util.spec_from_file_location("support_audio_reference", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        comparison = module.reference_check(project_path, audio_path, start=start, law=pan_law)
        # Raw sample values and paths remain local unless the reviewed report is shared.
        result["sourceReference"] = comparison
        check(result, "source_reference", comparison["status"],
              "Compared output samples with the supplied snapshot's supported neutral mix. This is not a subjective quality assessment or proof of original export-time state.")
    except (OSError, ValueError, KeyError, ImportError, RuntimeError) as exc:
        check(result, "source_reference", "not_asserted", str(exc))
    check(result, "project_stable", "pass" if sha256(project_path) == fingerprint else "fail", "Saved project bytes remained unchanged during source comparison.")


def compare_route(result: dict, route: dict, route_path: Path):
    if not isinstance(route, dict) or route.get("purpose") != "manual_render_route_report":
        check(result, "route_report", "fail", "The supplied JSON is not an OpenStudio render route report.")
        return
    result["routeReport"] = {"path": str(route_path.absolute()), "sha256": sha256(route_path),
                             "associationWithOriginalExport": "not_asserted",
                             "source": route.get("source"), "writtenAt": route.get("writtenAt"),
                             "normalize": route.get("normalize", False),
                             "startTimeSec": route.get("startTimeSec"),
                             "tracks": route.get("tracks", []), "clips": route.get("clips", [])}
    check(result, "route_provenance", "not_asserted",
          "Existing route reports have no output hash or final completion record. Comparisons below are against the supplied report only.")
    audio = result.get("audio", {})
    for field, route_field in (("sampleRate", "requestedOutputSampleRate"), ("channels", "channels")):
        expected, actual = route.get(route_field), audio.get(field)
        if isinstance(expected, (int, float)) and math.isfinite(expected) and actual is not None:
            check(result, "route_" + field, "pass" if actual == expected else "fail",
                  "Compared output metadata with the supplied render plan.", expected=expected, actual=actual)
    samples, source_rate, output_rate = route.get("outputSamples"), route.get("actualSampleRate"), route.get("requestedOutputSampleRate")
    if all(isinstance(n, (int, float)) and math.isfinite(n) and n > 0 for n in (samples, source_rate, output_rate)) and "framesRead" in audio:
        expected = round(samples * output_rate / source_rate)
        lossy = str(route.get("format", "")).lower() in {"mp3", "ogg"}
        check(result, "route_duration", "not_asserted" if lossy else "pass" if abs(audio["framesRead"] - expected) <= 1 else "fail",
              "Lossy codec padding needs format-specific interpretation." if lossy else "Compared frame count including the planned tail and rate conversion (one-frame rounding tolerance).",
              expectedFrames=expected, actualFrames=audio["framesRead"])
    sources = []
    for clip in route.get("clips", []):
        if not isinstance(clip, dict):
            continue
        source = clip.get("audioFile")
        if not isinstance(source, str) or not source:
            continue
        file = Path(source)
        sources.append({"clipId": clip.get("clipId"), "path": source,
                        "availableAtCollectionTime": file.is_file() if file.is_absolute() else None})
    result["sourcesAtCollectionTime"] = sources
    check(result, "track_completeness", "not_asserted",
          "The pre-render snapshot describes intended routing, not per-track contribution to the completed mix.")
