#!/usr/bin/env python3
"""Compare Studio13 formant renders against RePitch reference clips.

Usage:
  python tools/formant_reference_compare.py ^
    --original "d:\\test projects\\org.wav" ^
    --plus-target "d:\\test projects\\org+200.wav" ^
    --minus-target "d:\\test projects\\org-200.wav" ^
    [--candidate-plus "..."] [--candidate-minus "..."]

The script measures:
  - best-fit simple spectral-envelope warp in semitones
  - residual envelope distance after that best fit
  - coarse low/body/presence/air band drift
  - optional candidate-vs-target error if Studio13 renders are provided
"""

from __future__ import annotations

import argparse
import math
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class AudioData:
    sample_rate: int
    samples: np.ndarray


def load_wav(path: Path) -> AudioData:
    with wave.open(str(path), "rb") as wf:
        sample_rate = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        frames = wf.getnframes()
        raw = wf.readframes(frames)

    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {width}")

    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return AudioData(sample_rate=sample_rate, samples=data)


def stft_mag(samples: np.ndarray, fft_size: int = 2048, hop: int = 512) -> np.ndarray:
    if samples.size < fft_size:
        samples = np.pad(samples, (0, fft_size - samples.size))
    window = np.hanning(fft_size).astype(np.float32)
    frames = []
    for start in range(0, max(1, samples.size - fft_size + 1), hop):
        frame = samples[start:start + fft_size]
        if frame.size < fft_size:
            frame = np.pad(frame, (0, fft_size - frame.size))
        frames.append(np.abs(np.fft.rfft(frame * window)))
    return np.stack(frames, axis=0)


def smooth_envelope(mag: np.ndarray, smooth_bins: int = 24) -> np.ndarray:
    kernel = np.ones(smooth_bins, dtype=np.float32) / smooth_bins
    padded = np.pad(mag, ((0, 0), (smooth_bins, smooth_bins)), mode="edge")
    out = np.empty_like(mag)
    for i in range(mag.shape[0]):
        out[i] = np.convolve(padded[i], kernel, mode="same")[smooth_bins:-smooth_bins]
    return np.maximum(out, 1e-7)


def voiced_mask(samples: np.ndarray, fft_size: int = 2048, hop: int = 512) -> np.ndarray:
    frames = []
    for start in range(0, max(1, samples.size - fft_size + 1), hop):
        frame = samples[start:start + fft_size]
        if frame.size < fft_size:
            frame = np.pad(frame, (0, fft_size - frame.size))
        rms = math.sqrt(float(np.mean(frame * frame)) + 1e-12)
        zcr = float(np.mean(np.abs(np.diff(np.signbit(frame)).astype(np.float32))))
        frames.append(rms > 0.01 and zcr < 0.25)
    mask = np.array(frames, dtype=bool)
    if not np.any(mask):
        mask[:] = True
    return mask


def warp_env(env: np.ndarray, semitones: float) -> np.ndarray:
    ratio = 2.0 ** (semitones / 12.0)
    bins = np.arange(env.shape[1], dtype=np.float32)
    src = bins / ratio
    src = np.clip(src, 0, env.shape[1] - 1)
    lo = np.floor(src).astype(np.int32)
    hi = np.clip(lo + 1, 0, env.shape[1] - 1)
    frac = src - lo
    warped = env[:, lo] * (1.0 - frac) + env[:, hi] * frac
    return np.maximum(warped, 1e-7)


def env_error(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    la = np.log(a[mask])
    lb = np.log(b[mask])
    return float(np.sqrt(np.mean((la - lb) ** 2)))


def best_simple_warp(reference_env: np.ndarray, target_env: np.ndarray, mask: np.ndarray) -> tuple[float, float]:
    best_st = 0.0
    best_err = float("inf")
    for semitones in np.linspace(-3.0, 3.0, 241):
        warped = warp_env(reference_env, float(semitones))
        err = env_error(warped, target_env, mask)
        if err < best_err:
            best_err = err
            best_st = float(semitones)
    return best_st, best_err


def band_energy_delta(env_a: np.ndarray, env_b: np.ndarray, sr: int) -> dict[str, float]:
    freqs = np.linspace(0, sr / 2, env_a.shape[1], dtype=np.float32)
    bands = {
        "sub_body": (80, 350),
        "body": (350, 1200),
        "presence": (1200, 4000),
        "air": (4000, 9000),
    }
    out: dict[str, float] = {}
    for name, (lo, hi) in bands.items():
        idx = np.where((freqs >= lo) & (freqs < hi))[0]
        if idx.size == 0:
            out[name] = 0.0
            continue
        ea = float(np.mean(np.log(env_a[:, idx] + 1e-7)))
        eb = float(np.mean(np.log(env_b[:, idx] + 1e-7)))
        out[name] = eb - ea
    return out


def analyze_pair(original: AudioData, target: AudioData, label: str) -> dict[str, float]:
    if original.sample_rate != target.sample_rate:
        raise ValueError(f"{label}: sample rate mismatch")
    min_len = min(original.samples.size, target.samples.size)
    src = original.samples[:min_len]
    dst = target.samples[:min_len]
    src_mag = stft_mag(src)
    dst_mag = stft_mag(dst)
    src_env = smooth_envelope(src_mag)
    dst_env = smooth_envelope(dst_mag)
    mask = voiced_mask(src)
    best_st, best_err = best_simple_warp(src_env, dst_env, mask)
    warped = warp_env(src_env, best_st)
    src_err = env_error(src_env, dst_env, mask)
    residual_ratio = best_err / max(src_err, 1e-9)
    bands = band_energy_delta(src_env[mask], dst_env[mask], original.sample_rate)
    return {
        "best_st": best_st,
        "best_cents": best_st * 100.0,
        "best_err": best_err,
        "src_err": src_err,
        "residual_ratio": residual_ratio,
        **{f"band_{k}": v for k, v in bands.items()},
    }


def compare_candidate(original: AudioData, candidate: AudioData, target: AudioData, label: str) -> dict[str, float]:
    min_len = min(original.samples.size, candidate.samples.size, target.samples.size)
    src_env = smooth_envelope(stft_mag(original.samples[:min_len]))
    cand_env = smooth_envelope(stft_mag(candidate.samples[:min_len]))
    target_env = smooth_envelope(stft_mag(target.samples[:min_len]))
    mask = voiced_mask(original.samples[:min_len])
    return {
        f"{label}_candidate_to_target_err": env_error(cand_env, target_env, mask),
        f"{label}_candidate_vs_original_err": env_error(cand_env, src_env, mask),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--original", required=True)
    parser.add_argument("--plus-target", required=True)
    parser.add_argument("--minus-target", required=True)
    parser.add_argument("--candidate-plus")
    parser.add_argument("--candidate-minus")
    args = parser.parse_args()

    original = load_wav(Path(args.original))
    plus_target = load_wav(Path(args.plus_target))
    minus_target = load_wav(Path(args.minus_target))

    plus = analyze_pair(original, plus_target, "+200")
    minus = analyze_pair(original, minus_target, "-200")

    print("RePitch reference fit")
    for name, metrics in (("+200", plus), ("-200", minus)):
        print(name)
        for key, value in metrics.items():
            print(f"  {key}: {value:.6f}")

    if args.candidate_plus:
        candidate_plus = load_wav(Path(args.candidate_plus))
        for key, value in compare_candidate(original, candidate_plus, plus_target, "plus").items():
            print(f"{key}: {value:.6f}")

    if args.candidate_minus:
        candidate_minus = load_wav(Path(args.candidate_minus))
        for key, value in compare_candidate(original, candidate_minus, minus_target, "minus").items():
            print(f"{key}: {value:.6f}")


if __name__ == "__main__":
    main()
