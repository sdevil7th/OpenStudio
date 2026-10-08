"""Generate original audio, MIDI and an OpenStudio project for README recordings.

Requires NumPy. No downloaded samples, models or third-party plug-ins are used.
Run: python tools/generate-readme-demo.py
"""

import argparse
import json
from pathlib import Path
import struct
import wave

import numpy as np


RATE = 44100
TEMPO = 120
BEAT = 60 / TEMPO
PHRASE = 8.0
ROOTS = [40, 43, 38, 36]  # E minor, G, D, C: one chord per bar.
COLORS = ["#60a5fa", "#fbbf24", "#34d399", "#a78bfa", "#f472b6", "#22d3ee"]


def frequency(note):
    return 440 * 2 ** ((note - 69) / 12)


def place(buffer, sound, time, gain=1):
    start = round(time * RATE)
    count = min(len(sound), len(buffer) - start)
    if count > 0:
        buffer[start:start + count] += sound[:count] * gain


def wav(path, samples):
    peak = np.max(np.abs(samples))
    samples = samples * (0.65 / max(1, peak))
    pcm = np.round(np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(RATE)
        writer.writeframes(pcm.tobytes())


def audio_samples(media):
    rng = np.random.default_rng(20261005)
    samples = {name: np.zeros(round(PHRASE * RATE)) for name in ["Drums", "Percussion", "Bass", "Atmosphere"]}
    t = np.arange(round(0.4 * RATE)) / RATE
    kick = np.sin(2 * np.pi * (48 * t + 100 * 0.025 * (1 - np.exp(-t / 0.025)))) * np.exp(-t * 13)
    snare = (rng.normal(0, 0.22, len(t)) + 0.18 * np.sin(2 * np.pi * 180 * t)) * np.exp(-t * 22)
    ht = np.arange(round(0.12 * RATE)) / RATE
    noise = rng.normal(0, 0.13, len(ht))
    hat = (noise - np.roll(noise, 1)) * np.exp(-ht * 65)
    for beat in range(16):
        if beat % 4 in [0, 2]:
            place(samples["Drums"], kick, beat * BEAT, 0.8)
        if beat % 4 in [1, 3]:
            place(samples["Drums"], snare, beat * BEAT, 0.75)
        for off in [0, 0.5]:
            place(samples["Percussion"], hat, (beat + off) * BEAT, 0.55 if off == 0 else 0.8)
    for bar, root in enumerate(ROOTS):
        for step, note in enumerate([root, root, root + 7, root + 12]):
            t = np.arange(round(0.42 * RATE)) / RATE
            f = frequency(note)
            tone = (np.sin(2 * np.pi * f * t) + 0.28 * np.sin(4 * np.pi * f * t))
            tone *= (1 - np.exp(-t * 350)) * np.exp(-t * 4) * np.minimum(1, (0.42 - t) * 50)
            place(samples["Bass"], tone, (bar * 4 + step) * BEAT, 0.45)
        t = np.arange(2 * RATE) / RATE
        thirds = 3 if bar == 0 else 4
        chord = sum(np.sin(2 * np.pi * frequency(root + 24 + offset) * t) for offset in [0, thirds, 7]) / 3
        envelope = np.minimum(t / 0.25, 1) * np.minimum((2 - t) / 0.35, 1)
        place(samples["Atmosphere"], chord * envelope, bar * 2, 0.2)
    for name, data in samples.items():
        wav(media / f"{name.lower()}.wav", data)


def note_events(notes):
    events = []
    for time, duration, note, velocity in notes:
        events.extend([
            {"timestamp": time, "type": "noteOn", "note": note, "velocity": velocity, "channel": 1},
            {"timestamp": time + duration, "type": "noteOff", "note": note, "velocity": 0, "channel": 1},
        ])
    return sorted(events, key=lambda event: (event["timestamp"], event["type"] == "noteOn"))


def vlq(value):
    output = [value & 127]
    while value > 127:
        value >>= 7
        output.insert(0, (value & 127) | 128)
    return bytes(output)


def midi(path, events):
    body = bytearray(b"\x00\xff\x51\x03\x07\xa1\x20\x00\xff\x58\x04\x04\x02\x18\x08")
    previous = 0
    for event in events:
        tick = round(event["timestamp"] / BEAT * 480)
        body += vlq(tick - previous)
        body += bytes([0x90 if event["type"] == "noteOn" else 0x80, event["note"], event["velocity"]])
        previous = tick
    body += vlq(round(PHRASE / BEAT * 480) - previous) + b"\xff\x2f\x00"
    path.write_bytes(b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480) + b"MTrk" + struct.pack(">I", len(body)) + body)


def track(index, name, kind):
    return {
        "id": f"readme-track-{index + 1}", "name": name, "color": COLORS[index], "type": kind,
        "inputType": "mono" if kind == "audio" else "midi", "volume": 0.63, "volumeDB": -4,
        "pan": [0, -0.2, 0, 0.25, -0.15, 0.2][index], "muted": False, "soloed": False,
        "armed": False, "monitorEnabled": False, "recordSafe": False,
        "inputChannel": "In 1", "inputStartChannel": 0, "inputChannelCount": 1,
        "meterLevel": 0, "peakLevel": 0, "clipping": False, "inputFxCount": 0,
        "trackFxCount": 0, "fxBypassed": False, "clips": [], "midiClips": [], "midiEffects": [],
        "automationLanes": [], "showAutomation": False, "automationReadEnabled": False,
        "automationWriteEnabled": False, "automationEnabled": False, "frozen": False,
        "takes": [], "activeTakeIndex": 0, "sends": [], "masterSendEnabled": True,
        "phaseInverted": False, "stereoWidth": 100, "outputStartChannel": 0,
        "outputChannelCount": 2, "trackChannelCount": 2, "playbackOffsetMs": 0,
        "midiOutputDevice": "", "midiInputDevice": "", "midiChannel": 1,
        "inputFXPaths": [], "inputFXStates": [], "trackFXPaths": [], "trackFXStates": [],
    }


def generate(directory):
    directory = directory.resolve()
    media = directory / "Media"
    media.mkdir(parents=True, exist_ok=True)
    audio_samples(media)
    chords, melody = [], []
    for bar, root in enumerate(ROOTS):
        third = 3 if bar == 0 else 4
        for beat in [0, 1.5, 3]:
            for offset in [0, third, 7, 12]:
                chords.append((bar * 2 + beat * BEAT, 0.38, root + 24 + offset, 58 + bar * 4))
        for step, offset in enumerate([12, 7, third + 12, 7, 12, 19, 15 if bar == 0 else 16, 7]):
            melody.append((bar * 2 + step * BEAT / 2, 0.18, root + 24 + offset, 50 + (step % 3) * 8))
    sequences = {"Piano": note_events(chords), "Arpeggio": note_events(melody)}
    for name, events in sequences.items():
        midi(media / f"{name.lower()}.mid", events)
    tracks = []
    for index, name in enumerate(["Drums", "Percussion", "Bass", "Atmosphere", "Piano", "Arpeggio"]):
        current = track(index, name, "audio" if index < 4 else "instrument")
        current["icon"] = ["drums", "drums", "bass-guitar", "keys", "piano", "midi"][index]
        if index >= 4:
            current["trackFXPaths"] = ["OpenStudio Piano" if name == "Piano" else "OpenStudio Basic Synth"]
            current["builtInInstrument"] = "piano" if name == "Piano" else "synth"
            current["trackFxCount"] = 1
        for phrase, label in enumerate(["Intro", "Verse", "Chorus", "Outro"]):
            clip = {"id": f"readme-clip-{index}-{phrase}", "name": f"{name} / {label}",
                    "startTime": phrase * PHRASE, "duration": PHRASE, "offset": 0, "color": COLORS[index],
                    "muted": False, "locked": False}
            if index < 4:
                clip.update(filePath=(media / f"{name.lower()}.wav").as_posix(), sampleRate=RATE,
                            channels=1, volumeDB=0, fadeIn=0.005, fadeOut=0.015,
                            playbackRate=1, reversed=False, pan=0)
                current["clips"].append(clip)
            else:
                clip.update(events=sequences[name], ccEvents=[], sourceLength=PHRASE, loopEnabled=False)
                current["midiClips"].append(clip)
        tracks.append(current)
    project = {
        "version": "1.2.0", "automationCurveVersion": 2, "projectName": "Neon Morning — OpenStudio Demo",
        "projectPersistentId": "openstudio-readme-demo-v1", "projectNotes": "Original procedurally generated E-minor demo. 120 BPM, 16 bars. Four audio tracks and two built-in MIDI instruments.",
        "projectSampleRate": RATE, "projectBitDepth": 16, "processingPrecision": "float32",
        "tempo": TEMPO, "timeSignature": {"numerator": 4, "denominator": 4}, "metronomeEnabled": False,
        "masterVolume": 0.63, "masterPan": 0, "tracks": tracks, "masterFXPaths": [], "masterFXStates": [],
        "markers": [{"id": f"readme-marker-{i}", "name": name, "time": i * PHRASE, "color": COLORS[i]}
                    for i, name in enumerate(["Intro", "Verse", "Chorus", "Outro"])],
        "regions": [], "tempoMarkers": [], "snapEnabled": True, "snapType": "grid", "gridSize": "1/16",
        "projectRange": {"start": 0, "end": 32},
    }
    path = directory / "Neon Morning.osproj"
    path.write_text(json.dumps(project, indent=2, ensure_ascii=False), encoding="utf-8")
    print(path)
    print("Created 4 mono WAV samples, 2 standard MIDI files, and a 6-track / 24-clip project.")
    print("Project audio paths point to this output directory; rerun the generator after relocating it.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, default=Path("output/readme-demo"))
    generate(parser.parse_args().output_directory)
