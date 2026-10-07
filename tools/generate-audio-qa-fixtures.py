#!/usr/bin/env python3
"""Create deterministic, low-level audio QA clips; no device or network access.

Channel IDs, silent gaps and exact lengths are measurement oracles, not subjective
quality tests. Production audio processing must never depend on these files.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import wave


def envelope(t, start, end, ramp=0.01):
    return max(0.0, min(1.0, (t - start) / ramp, (end - t) / ramp))


def stereo_sample(t):
    left = 0.125 * math.sin(math.tau * 440 * t) * envelope(t, 1, 3)
    right = 0.125 * math.sin(math.tau * 660 * t) * envelope(t, 3, 5)
    left += 0.10 * math.sin(math.tau * 880 * t) * envelope(t, 5, 8)
    right += 0.08 * math.sin(math.tau * 1100 * t) * envelope(t, 5, 8)
    if 9 <= t < 15:
        step = int((t - 9) * 2)
        note = (60, 64, 67, 72, 67, 64, 62, 65, 69, 74, 69, 65)[step]
        frequency = 440 * 2 ** ((note - 69) / 12)
        local = (t - 9) - step / 2
        amp = envelope(local, 0, 0.45, 0.02)
        tone = amp * (0.08 * math.sin(math.tau * frequency * local)
                      + 0.02 * math.sin(math.tau * frequency * 2 * local))
        left += tone
        right += tone * 0.7
    return left, right


def write_wave(path, rate, channels, duration, sample):
    peak = [0.0] * channels
    with wave.open(str(path), 'wb') as writer:
        writer.setparams((channels, 3, rate, 0, 'NONE', 'not compressed'))
        block = bytearray()
        for frame in range(round(rate * duration)):
            values = sample(frame / rate)
            for channel, value in enumerate(values):
                peak[channel] = max(peak[channel], abs(value))
                block.extend(round(value * (2 ** 23 - 1)).to_bytes(3, 'little', signed=True))
            if len(block) >= 65536:
                writer.writeframesraw(block)
                block.clear()
        writer.writeframesraw(block)
    return {'file': path.name, 'sampleRate': rate, 'channels': channels,
            'frames': round(rate * duration), 'bitDepth': 24, 'peak': peak,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if any(args.output.iterdir()):
        parser.error('Use an empty directory; previous fixtures are retained')
    files = [write_wave(args.output / 'stereo-channel-check-48k.wav', 48000, 2, 16, stereo_sample),
             write_wave(args.output / 'mono-pitch-check-44k1.wav', 44100, 1, 8,
                        lambda t: (0.1 * math.sin(math.tau * 330 * t) * envelope(t, 1, 7),))]
    report = {'purpose': 'Deterministic QA only; subjective audio quality not asserted',
              'files': files,
              'stereoSegmentsSeconds': {'0-1': 'silence', '1-3': 'left 440 Hz only',
                  '3-5': 'right 660 Hz only', '5-8': 'left 880 Hz / right 1100 Hz',
                  '8-9': 'silence', '9-15': 'synthesized melody', '15-16': 'silence'}}
    (args.output / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
