"""Shared, byte-preserving publication and evidence checks for local audio QA."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
from urllib.parse import quote


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def result_directory(native: dict, report: Path) -> Path:
    value = native.get("directory", native.get("nativeDirectory"))
    if not isinstance(value, str) or not value:
        raise ValueError("Native report must declare its capture directory")
    path = Path(value)
    return (path if path.is_absolute() else report.resolve().parent / path).resolve()


def finite_number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Invalid {name}: {value!r}")
    return float(value)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_project_evidence(native: dict, report: Path, timeline, rate: int) -> dict:
    """Rebuild provenance from the native report and its source-timeline WAV."""
    import numpy as np

    metadata = native.get("metadata", {})
    if not isinstance(metadata, dict):
        raise ValueError("Native source metadata must be an object")
    evidence = {"nativeReport": str(report.resolve()), "nativeReportSha256": sha256(report)}
    for key, hash_key in (("projectPath", "projectSha256"), ("sourcePath", "sourceSha256")):
        value = native.get(key)
        expected = metadata.get(hash_key)
        if not isinstance(value, str) or not isinstance(expected, str) or len(expected) != 64:
            raise ValueError(f"Native report is missing {key}/{hash_key} evidence")
        path = Path(value)
        path = path if path.is_absolute() else report.resolve().parent / path
        if sha256(path) != expected:
            raise ValueError(f"Source evidence is stale: {key}")
        evidence.update({key: str(path.resolve()), hash_key: expected})
    for key, hash_key in (("modelPath", "modelSha256"),):
        if not isinstance(metadata.get(key), str) or not isinstance(metadata.get(hash_key), str):
            raise ValueError("Native report is missing model source evidence")
        path = Path(metadata[key])
        path = path if path.is_absolute() else report.resolve().parent / path
        if sha256(path) != metadata[hash_key]:
            raise ValueError(f"Source evidence is stale: {key}")
        evidence.update({key: str(path.resolve()), hash_key: metadata[hash_key]})
    state_path = result_directory(native, report) / "saved-nam-project.state"
    if sha256(state_path) != metadata.get("savedNamStateSha256"):
        raise ValueError("Saved NAM state does not match the native source report")
    start = finite_number(native.get("sourceStartSeconds"), "sourceStartSeconds")
    duration = finite_number(native.get("sourceDurationSeconds"), "sourceDurationSeconds")
    offset = finite_number(native.get("sourceOffsetSeconds"), "sourceOffsetSeconds")
    if start < 0 or duration <= 0 or offset < 0 or rate <= 0 or round((start + duration) * rate) > len(timeline):
        raise ValueError("Native source clip has an invalid timeline span")
    if not np.isfinite(timeline).all():
        raise ValueError("Nonfinite native source timeline")
    # First complete 10 ms window above -30 dBFS, measured on the unchanged
    # timeline before NAM. This is a reproducible diagnostic, not an edit/crop.
    window = max(1, round(rate * .01))
    power = np.mean(np.square(timeline, dtype=np.float64), axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(power)))
    rms_squared = (cumulative[window:] - cumulative[:-window]) / window
    crossings = np.flatnonzero(rms_squared >= 10 ** (-30 / 10))
    onset = int(crossings[0]) / rate if len(crossings) else start
    evidence.update({"clipStartSeconds": start, "sourceDurationSeconds": duration,
                     "sourceOffsetSeconds": offset, "savedNamStateSha256": metadata["savedNamStateSha256"],
                     "timelineOnsetDiagnostic": {"rms_db_-30": onset, "windowSeconds": window / rate,
                         "thresholdReached": bool(len(crossings)), "status": "diagnostic_only"}})
    return evidence


def publish_audio(path: Path, output: Path, filename: str) -> str:
    """Keep in-place files, otherwise publish an unchanged copy in audio/."""
    path, output = path.resolve(), output.resolve()
    try:
        relative = path.relative_to(output)
    except ValueError:
        relative = Path("audio") / filename
    target = output / relative
    if target != path:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    return quote(relative.as_posix(), safe="/")


def write_player(output: Path, manifest: dict, html: str, css: str, javascript: str) -> None:
    output.mkdir(parents=True, exist_ok=True)
    data = json.dumps(manifest, ensure_ascii=False, allow_nan=False)
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    (output / "index.html").write_text(html.replace("__DATA__", data.replace("<", "\\u003c")), encoding="utf-8")
    (output / "player.css").write_text(css, encoding="utf-8")
    (output / "player.js").write_text(javascript, encoding="utf-8")


def wav_metadata(path: Path) -> dict:
    """Read WAV metadata without decoding, rescaling or rewriting samples."""
    with path.open("rb") as stream:
        header = stream.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            raise ValueError(f"Not a RIFF WAV: {path}")
        declared_end = struct.unpack_from("<I", header, 4)[0] + 8
        if declared_end > path.stat().st_size:
            raise ValueError(f"Truncated WAV: {path}")
        fmt, data_size = None, 0
        while stream.tell() + 8 <= declared_end:
            chunk, size = struct.unpack("<4sI", stream.read(8))
            end = stream.tell() + size
            if end > declared_end:
                raise ValueError(f"Truncated WAV chunk: {path}")
            if chunk == b"fmt " and size >= 16:
                fmt = struct.unpack("<HHIIHH", stream.read(16))
            elif chunk == b"data":
                data_size += size
            stream.seek(end + size % 2)
        if fmt is None or fmt[0] not in (1, 3, 65534) or min(fmt[1], fmt[2], fmt[4]) < 1:
            raise ValueError(f"Unsupported WAV format: {path}")
        if data_size < 1 or data_size % fmt[4]:
            raise ValueError(f"Invalid WAV sample length: {path}")
        return {"channels": fmt[1], "sampleRate": fmt[2], "bits": fmt[5], "format": fmt[0],
                "frames": data_size // fmt[4], "seconds": data_size / fmt[4] / fmt[2]}
