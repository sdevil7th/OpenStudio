"""Build local audition previews from the explicit ten-hour native render case.

Run the headless --case ten-hour-listening first. Raw WAV/state files are retained;
this tool writes constant-gain previews, a manifest and a local HTML player.
"""
from __future__ import annotations

import argparse
import array
import hashlib
import html
import json
import math
from pathlib import Path
import struct
import sys


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wave_preview(path: Path, gain: float, expected_peak: float) -> bytes:
    data = bytearray(path.read_bytes())
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"Not a RIFF WAV: {path}")
    position, floating = 12, False
    while position + 8 <= len(data):
        tag, size = bytes(data[position:position + 4]), struct.unpack_from("<I", data, position + 4)[0]
        start, end = position + 8, position + 8 + size
        if end > len(data):
            raise ValueError(f"Truncated WAV chunk: {path}")
        if tag == b"fmt ":
            if size < 16:
                raise ValueError(f"Short WAV format: {path}")
            code, channels, rate = struct.unpack_from("<HHI", data, start)
            bits = struct.unpack_from("<H", data, start + 14)[0]
            floating = bits == 32 and channels == 2 and rate == 48000 and (
                code == 3 or (code == 65534 and size >= 40 and struct.unpack_from("<H", data, start + 24)[0] == 3)
            )
        if tag == b"data":
            if not floating or size % 8:
                raise ValueError(f"Expected stereo 48 kHz float32 data: {path}")
            samples = array.array("f")
            samples.frombytes(data[start:end])
            if sys.byteorder != "little":
                samples.byteswap()
            if not samples or not all(math.isfinite(value) for value in samples):
                raise ValueError(f"Empty/nonfinite audio: {path}")
            actual_peak = max(abs(value) for value in samples)
            if abs(actual_peak - expected_peak) > max(1e-7, expected_peak * 1e-5):
                raise ValueError(f"Manifest peak does not match raw audio: {path}")
            scaled = array.array("f", (value * gain for value in samples))
            if sys.byteorder != "little":
                scaled.byteswap()
            data[start:end] = scaled.tobytes()
            return bytes(data)
        position = end + (size & 1)
    raise ValueError(f"No audio data: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / "output/free-suite-ten-hour-listening")
    arguments = parser.parse_args()
    root = arguments.directory.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8-sig"))
    if manifest.get("claimLevel") != "file_sanity_only" or not manifest.get("pass"):
        raise ValueError("Run the successful explicit native listening case first")
    groups: dict[str, list[dict]] = {}
    for row in manifest["files"]:
        name = row["file"]
        if Path(name).name != name or not name.endswith(".wav"):
            raise ValueError("Expected a local WAV filename")
        group = next((key for key in ("spring", "nonlinear", "magnetic", "positioned") if name.startswith(key + "-")), None)
        if group is None:
            group = "piano-body" if name.startswith("piano-") else "guitar-body" if name in ("guitar-coupled.wav", "guitar-uncoupled.wav") else name
        groups.setdefault(group, []).append(row)
    for group, rows in groups.items():
        peak = max(row["peakLinear"] for row in rows)
        if not math.isfinite(peak) or peak <= 0:
            raise ValueError("Invalid diagnostic peak")
        gain = 10 ** (-9 / 20) / peak
        for row in rows:
            preview = "preview-" + row["file"]
            (root / preview).write_bytes(wave_preview(root / row["file"], gain, row["peakLinear"]))
            row.update(preview=preview, previewGainDb=20 * math.log10(gain), previewGroup=group,
                       sha256=sha256(root / row["file"]), previewSha256=sha256(root / preview))
    policy = "One common gain per Freeze/Infinite or coupled/uncoupled pair; group maximum peak is -9 dBFS. Relative levels inside each pair remain unchanged. Individual articulation sequences use one constant gain for the whole file. Raw WAVs and initial states are retained."
    manifest["previewPolicy"] = policy
    manifest["sourceSha256"] = sha256(root / "source-two-plucks.wav")
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    styles = "body{margin:0;background:#141719;color:#edf0f0;font:16px/1.5 system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:32px 24px}h1{font-size:30px;line-height:1.2}h2{font-size:23px;margin-top:38px}h3{font-size:17px;margin:0 0 8px}.intro{max-width:80ch;color:#c7cccc}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}.card{background:#202729;border:1px solid #3c474b;border-radius:10px;padding:18px;min-width:0}audio{display:block;width:100%;margin:14px 0}a{color:#8bd9ff}a:focus-visible{outline:3px solid #e9cc71;outline-offset:3px}.detail{font-size:13px;color:#bac5ca}.status{color:#e9cc71}.files{display:flex;flex-wrap:wrap;gap:16px}footer{margin-top:40px;border-top:1px solid #495358;padding-top:16px}"
    (root / "listen.css").write_text(styles, encoding="utf-8")
    page = ["<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>OpenStudio ten-hour listening pack</title><link rel=\"stylesheet\" href=\"listen.css\"><main><h1>OpenStudio listening pack</h1><p class=\"intro\">New Hold and instrument behaviors from the October 2 development work. These are original synthetic diagnostics, not commercial reference recordings. Each file is eight seconds at 48 kHz.</p><p class=\"status\">File sanity: pass. Sound quality and reference fidelity: not_asserted. Your audition determines whether these results are useful.</p><p class=\"intro\">" + html.escape(policy) + "</p><p><a href=\"manifest.json\">Exact settings, MIDI events, gain factors and hashes</a></p><section><h2>Input for the Hold comparisons</h2><p>Two short plucks, at 0 and 3 seconds. Hold starts at 0.12 s and releases at 6 s. The effect files contain only the wet return.</p><audio controls preload=\"none\" aria-label=\"Original two-pluck input\" src=\"source-two-plucks.wav\"></audio></section>"]
    for group, rows in groups.items():
        page.append("<section><h2>" + html.escape(group.replace("-", " ").title()) + "</h2><div class=\"grid\">")
        for row in rows:
            label = row["file"].removesuffix(".wav").replace("-", " ").title()
            page.append(f'<article class="card"><h3>{html.escape(label)}</h3><p class="detail">{html.escape(row["description"])}</p><audio controls preload="none" aria-label="{html.escape(label)}" src="{html.escape(row["preview"])}"></audio><p class="detail">Preview gain: {row["previewGainDb"]:+.2f} dB. Raw peak: {20 * math.log10(row["peakLinear"]):.2f} dBFS.</p><div class="files"><a href="{html.escape(row["file"])}">Raw WAV</a><a href="{html.escape(row["initialState"])}">Initial native state</a></div></article>')
        page.append("</div></section>")
    page.append('<footer><p>The existing <a href="../free-suite-05-listening/manifest.json">broader suite pack</a> includes all 41 reverb types and other effects. Neither pack is a listening acceptance result.</p></footer></main></html>')
    (root / "listen.html").write_text("\n".join(page), encoding="utf-8")
    print(f'Created {len(manifest["files"])} previews and {root / "listen.html"}; audio quality not_asserted')


if __name__ == "__main__":
    main()
