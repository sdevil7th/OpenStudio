#!/usr/bin/env python3
"""Prepare QA-only reverb inputs from existing guitar and JUCE singing assets.

No download and no production DSP dependency. These are arrangements of direct
electric-guitar note recordings, not recorded speech or a continuous live take.
The manifest records every source hash and the explicit preprocessing gains.
The short JUCE singing asset has unverified binary recording credits and is used
only for local diagnostics; the example code licence is not assigned to it.
"""
from __future__ import annotations

import argparse
import array
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave


RATE = 48000
BANK = Path("resources/test_fixtures/guitar_di/EGuitarFSBS-direct SFZ+FLAC-20220911")
ARCHIVE_HASH = "7ab2a4551bb8847342d6fd10cc56e0642fcaf43f3be8d665269c4dc9bfbbd599"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode(ffmpeg: Path, path: Path, rate: int = RATE, channels: int = 1) -> array.array:
    result = subprocess.run(
        [str(ffmpeg), "-v", "error", "-i", str(path), "-map", "0:a:0",
         "-ar", str(rate), "-ac", str(channels), "-f", "f32le", "pipe:1"],
        check=True, capture_output=True,
    )
    samples = array.array("f")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        raise ValueError(f"Empty decoded note: {path}")
    return samples


def segment(source: array.array, seconds: float) -> list[float]:
    count = round(RATE * seconds)
    values = [float(source[i]) if i < len(source) else 0.0 for i in range(count)]
    fade_in, fade_out = round(RATE * .005), round(RATE * .08)
    for i in range(fade_in):
        values[i] *= i / fade_in
    for i in range(fade_out):
        values[count - 1 - i] *= i / fade_out
    return values


def write_wave(path: Path, values: list[float]) -> None:
    encoded = array.array("h", (round(max(-1.0, min(1.0, value)) * 32767) for value in values))
    if sys.byteorder != "little":
        encoded.byteswap()
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(RATE)
        stream.writeframes(encoded.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("output/reverb-recorded/sources"))
    parser.add_argument("--ffmpeg", type=Path, default=Path("tools/ffmpeg-runtime/ffmpeg.exe"))
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    bank = repository / BANK
    ffmpeg = args.ffmpeg.resolve()
    directory = args.output_dir.resolve()
    if not bank.is_dir() or not ffmpeg.is_file():
        raise FileNotFoundError("The existing recorded guitar fixture bank and FFmpeg runtime are required; this tool never downloads them.")
    archive = bank.parent / "EGuitarFSBS-direct-SFZ+FLAC-20220911.7z"
    if archive.is_file() and sha256(archive) != ARCHIVE_HASH:
        raise ValueError("Existing fixture archive does not match its source-owned checksum.")
    groups = {
        "recorded-guitar-low-notes": ["E2_s1_01.flac", "A2_s2_01.flac", "D3_s3_01.flac", "G3_s4_01.flac"],
        "recorded-guitar-high-notes": ["B3_s5_01.flac", "E4_s6_01.flac", "C#4_s5_01.flac", "B4_s6_01.flac"],
        "recorded-guitar-layered-chord": ["E3_s3_01.flac", "G3_s4_01.flac", "B3_s5_01.flac"],
    }
    directory.mkdir(parents=True, exist_ok=True)
    decoded: dict[str, array.array] = {}
    source_rows = {}
    for name in sorted({note for notes in groups.values() for note in notes}):
        matches = sorted(bank.glob(f"samples/bridge/{name}"))
        if len(matches) != 1:
            raise FileNotFoundError(f"Expected one existing bridge pickup note: {name}")
        path = matches[0]
        decoded[name] = decode(ffmpeg, path)
        source_rows[name] = {"path": path.relative_to(repository).as_posix(), "sha256": sha256(path),
                             "decodedSecondsAt48000": len(decoded[name]) / RATE}
    rows = []
    for label, notes in groups.items():
        if label.endswith("layered-chord"):
            layers = [segment(decoded[note], 4.8) for note in notes]
            values = [sum(layer[i] for layer in layers) / len(layers) for i in range(len(layers[0]))]
            arrangement = "Three actual recorded notes layered simultaneously, equal 1/3 gains; 4.8s with zero padding when a note is shorter."
        else:
            values = [value for note in notes for value in segment(decoded[note], 1.2)]
            arrangement = "Four actual recorded notes concatenated, 1.2s each; zero padding when a note is shorter."
        peak = max(abs(value) for value in values)
        if peak <= 0:
            raise ValueError(f"Silent fixture: {label}")
        gain = .18 / peak
        values = [value * gain for value in values]
        path = directory / f"{label}.wav"
        write_wave(path, values)
        rows.append({"material": label, "file": path.name, "sha256": sha256(path),
                     "sampleRate": RATE, "channels": 1, "seconds": len(values) / RATE,
                     "sourceNotes": notes, "arrangement": arrangement,
                     "staticSourceGain": gain, "sourcePeakBeforeGain": peak, "sourceTargetPeak": .18,
                     "fadeInSeconds": .005, "fadeOutSeconds": .08,
                     "inputProcessing": "FFmpeg decode/resample to48k mono, explicit trims/fades/arrangement, one fixed peak-safe source gain and PCM16 encoding. No reverb/output loudness matching."})
    singing = repository / "build/_deps/juce-src/examples/Assets/singing.ogg"
    if not singing.is_file():
        raise FileNotFoundError("Existing JUCE singing example asset is required; this tool does not download it.")
    # The existing FFmpeg inventory identifies Ogg Vorbis,44.1k,stereo. Decode
    # at that exact format too, to retain an exact frame-count duration in the
    # provenance instead of the rounded banner duration.
    original = decode(ffmpeg, singing, 44100, 2)
    singing_mono = decode(ffmpeg, singing)
    values = segment(singing_mono, len(singing_mono) / RATE)
    peak = max(abs(value) for value in values)
    if peak <= 0:
        raise ValueError("Silent JUCE singing sample")
    gain = .18 / peak
    values = [value * gain for value in values]
    path = directory / "juce-singing-sample.wav"
    write_wave(path, values)
    source_rows["singing.ogg"] = {
        "path": singing.relative_to(repository).as_posix(), "sha256": sha256(singing),
        "container": "Ogg", "codec": "Vorbis", "sampleRate": 44100, "channels": 2,
        "decodedFramesAtOriginalFormat": len(original) // 2, "decodedSecondsAtOriginalFormat": len(original) / (2 * 44100),
        "decodedSecondsAt48000Mono": len(singing_mono) / RATE,
        "provenance": "Bundled JUCE singing audio asset; example sampler code loads this file. Performer, recording chain and binary recording credits are not supplied by the local checkout.",
        "licence": "Binary recording credits unverified. The JUCE LICENSE.md examples ISC statement is recorded as code-licence evidence only, not asserted to license this recording. Local diagnostic QA only; no production or release distribution.",
    }
    rows.append({"material": "juce-singing-sample", "file": path.name, "sha256": sha256(path),
                 "sampleRate": RATE, "channels": 1, "seconds": len(values) / RATE,
                 "sourceNotes": ["singing.ogg"], "arrangement": "Whole existing short singing asset, stereo downmixed to mono; no looping or pitch alteration.",
                 "staticSourceGain": gain, "sourcePeakBeforeGain": peak, "sourceTargetPeak": .18,
                 "fadeInSeconds": .005, "fadeOutSeconds": .08,
                 "inputProcessing": "FFmpeg stereo-to-mono decode/resample to48k;5ms entrance/80ms exit fades; one fixed peak-safe source gain and PCM16 encoding. No output loudness matching.",
                 "recordingQualification": "This short bundled sample only; broader human-vocal/recording-chain qualification is not asserted."})
    manifest = {
        "scope": "QA inputs only; production never reads these fixtures or their manifest.",
        "provenance": "Existing FreePats Electric Guitar FSBS direct recordings, version2022-09-11; README identifies direct sampling of a Fender electric guitar through instrument inputs.",
        "license": "Guitar notes only: CC0 1.0 Universal; existing bank LICENSE.txt and README.txt. JUCE singing binary credits are unverified; local diagnostic use only.",
        "provenanceReadme": (BANK / "README.txt").as_posix(),
        "licenseFile": (BANK / "LICENSE.txt").as_posix(),
        "archiveSha256": ARCHIVE_HASH,
        "archiveVerified": archive.is_file(),
        "recordedSpeechOrSinging": "Short bundled JUCE singing sample; performer/capture-chain provenance and broad vocal qualification are not asserted.",
        "continuousLivePerformance": "not_asserted; arranged note recordings",
        "audioQuality": "not_asserted",
        "sources": source_rows,
        "materials": rows,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"directory": str(directory), "materials": len(rows), "voiceScope": "short_JUCE_singing_asset_only", "archiveVerified": archive.is_file()}))


if __name__ == "__main__":
    main()
