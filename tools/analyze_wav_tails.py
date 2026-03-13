"""
Analyze WAV files: duration, sample rate, channels, bit depth, peak/RMS,
and pitch (F0) in the last 2 seconds using YIN-style autocorrelation.
"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np
import soundfile as sf
from scipy.signal import correlate

FILES = {
    "original":  "D:/test projects/untitled3.wav",
    "repitch":   "D:/test projects/untitled3-001.wav",
    "studio13":  "D:/test projects/Untitled Project26.wav",
}

# ──────────────────────────────────────────────────────────────────────────────
# YIN-style autocorrelation F0 estimator (no librosa needed)
# ──────────────────────────────────────────────────────────────────────────────
def yin_frame(frame, sr, fmin=60, fmax=800):
    """
    Compute F0 of a single mono frame using YIN difference function.
    Returns F0 in Hz, or 0 if unvoiced/unreliable.
    """
    N = len(frame)
    tau_min = int(sr / fmax)
    tau_max = min(int(sr / fmin), N // 2)
    if tau_max <= tau_min:
        return 0.0

    # Squared difference function
    def sdf(tau):
        diff = frame[:N - tau] - frame[tau:]
        return np.dot(diff, diff)

    # Cumulative mean normalised difference (CMND)
    d = np.array([sdf(tau) for tau in range(tau_max + 1)], dtype=np.float64)
    d[0] = 1.0
    cmnd = np.empty_like(d)
    cmnd[0] = 1.0
    running = 0.0
    for tau in range(1, tau_max + 1):
        running += d[tau]
        cmnd[tau] = d[tau] * tau / running if running > 0 else 1.0

    # Find first dip below threshold 0.10
    threshold = 0.10
    tau_est = 0
    for tau in range(tau_min, tau_max):
        if cmnd[tau] < threshold:
            # Parabolic interpolation
            if 0 < tau < len(cmnd) - 1:
                denom = cmnd[tau-1] - 2*cmnd[tau] + cmnd[tau+1]
                if denom != 0:
                    tau_interp = tau + 0.5 * (cmnd[tau-1] - cmnd[tau+1]) / denom
                    return sr / tau_interp
            return sr / tau
    # Fallback: global minimum in range
    idx = np.argmin(cmnd[tau_min:tau_max]) + tau_min
    if cmnd[idx] < 0.3:
        return sr / idx if idx > 0 else 0.0
    return 0.0


def midi_note(f0_hz):
    if f0_hz <= 0:
        return "—"
    midi = 69 + 12 * np.log2(f0_hz / 440.0)
    note_names = ["A","A#","B","C","C#","D","D#","E","F","F#","G","G#"]
    n = int(round(midi)) % 12
    octave = (int(round(midi)) // 12) - 1
    cents = (midi - round(midi)) * 100
    sign = "+" if cents >= 0 else ""
    return f"{note_names[n]}{octave} ({sign}{cents:.1f}¢)  [{f0_hz:.2f} Hz]"


def analyze_file(label, path):
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"  {path}")
    print(f"{'='*60}")

    try:
        info = sf.info(path)
    except Exception as e:
        print(f"  ERROR reading info: {e}")
        return

    duration = info.frames / info.samplerate
    print(f"  Duration     : {duration:.4f} s  ({info.frames} frames)")
    print(f"  Sample rate  : {info.samplerate} Hz")
    print(f"  Channels     : {info.channels}")
    print(f"  Subtype      : {info.subtype}  (bit depth)")

    # Load full file for peak/RMS
    data, sr = sf.read(path, dtype='float32', always_2d=True)
    mono = data.mean(axis=1)

    peak = float(np.max(np.abs(data)))
    peak_db = 20 * np.log10(peak + 1e-12)
    rms = float(np.sqrt(np.mean(mono**2)))
    rms_db = 20 * np.log10(rms + 1e-12)
    print(f"  Peak amp     : {peak:.6f}  ({peak_db:.2f} dBFS)")
    print(f"  RMS (mono)   : {rms:.6f}  ({rms_db:.2f} dBFS)")

    # ── TAIL ANALYSIS ──────────────────────────────────────────────────────
    tail_sec = 2.0
    tail_samples = int(tail_sec * sr)
    tail = mono[-tail_samples:] if len(mono) >= tail_samples else mono
    tail_dur = len(tail) / sr

    tail_peak = float(np.max(np.abs(tail)))
    tail_rms  = float(np.sqrt(np.mean(tail**2)))
    tail_peak_db = 20 * np.log10(tail_peak + 1e-12)
    tail_rms_db  = 20 * np.log10(tail_rms  + 1e-12)
    print(f"\n  -- Last {tail_dur:.2f}s tail --")
    print(f"  Tail peak    : {tail_peak:.6f}  ({tail_peak_db:.2f} dBFS)")
    print(f"  Tail RMS     : {tail_rms:.6f}  ({tail_rms_db:.2f} dBFS)")

    # ── PITCH TRACKING IN TAIL ────────────────────────────────────────────
    frame_len = int(0.04 * sr)   # 40 ms frames
    hop_len   = int(0.01 * sr)   # 10 ms hop
    f0_values = []
    positions = []
    start = 0
    while start + frame_len <= len(tail):
        frame = tail[start : start + frame_len].copy().astype(np.float64)
        # Window
        frame *= np.hanning(len(frame))
        f0 = yin_frame(frame, sr)
        t_offset = (start + frame_len // 2) / sr        # time from tail start
        t_abs = duration - tail_dur + t_offset          # absolute time in file
        if f0 > 0:
            f0_values.append(f0)
            positions.append(t_abs)
        start += hop_len

    print(f"\n  Pitch track ({len(f0_values)} voiced frames out of "
          f"{(len(tail) - frame_len) // hop_len + 1} total):")
    if f0_values:
        f0_arr = np.array(f0_values)
        print(f"  F0 median    : {midi_note(float(np.median(f0_arr)))}")
        print(f"  F0 mean      : {np.mean(f0_arr):.2f} Hz")
        print(f"  F0 std       : {np.std(f0_arr):.2f} Hz")
        print(f"  F0 min/max   : {np.min(f0_arr):.2f} / {np.max(f0_arr):.2f} Hz")

        # Print per-second summary for the tail
        print(f"\n  Per-0.5s F0 summary:")
        seg_size = int(0.5 * sr / hop_len)
        for seg_i in range(0, len(f0_values), max(1, seg_size)):
            seg = f0_arr[seg_i : seg_i + seg_size]
            t_start_abs = duration - tail_dur + (seg_i * hop_len) / sr
            if len(seg) > 0:
                print(f"    t={t_start_abs:.2f}s  median={np.median(seg):.2f} Hz  "
                      f"({midi_note(float(np.median(seg)))})")
    else:
        print("  No voiced frames detected in tail (silence or below threshold)")

    return {"duration": duration, "sr": sr, "channels": info.channels,
            "peak_db": peak_db, "rms_db": rms_db,
            "tail_peak_db": tail_peak_db, "tail_rms_db": tail_rms_db,
            "f0_values": f0_values}


results = {}
for label, path in FILES.items():
    results[label] = analyze_file(label, path)


# ── COMPARISON SUMMARY ────────────────────────────────────────────────────────
print(f"\n\n{'='*60}")
print("  COMPARISON SUMMARY")
print(f"{'='*60}")

# Duration diff
labels = list(FILES.keys())
for l in labels:
    r = results.get(l)
    if r:
        print(f"  {l:12s}: {r['duration']:.4f}s  peak={r['peak_db']:.1f}dBFS  "
              f"tail_peak={r['tail_peak_db']:.1f}dBFS  tail_rms={r['tail_rms_db']:.1f}dBFS")

# F0 comparison
print("\n  Median tail F0 comparison:")
medians = {}
for l in labels:
    r = results.get(l)
    if r and r.get("f0_values"):
        m = float(np.median(r["f0_values"]))
        medians[l] = m
        print(f"  {l:12s}: {midi_note(m)}")
    else:
        print(f"  {l:12s}: no voiced frames")

if len(medians) >= 2:
    print("\n  Pitch differences (cents) relative to original:")
    orig_m = medians.get("original", 0)
    for l in ["repitch", "studio13"]:
        if l in medians and orig_m > 0:
            cents_diff = 1200 * np.log2(medians[l] / orig_m)
            print(f"  {l:12s} vs original: {cents_diff:+.1f} cents")
    if "repitch" in medians and "studio13" in medians:
        cents_diff = 1200 * np.log2(medians["studio13"] / medians["repitch"])
        print(f"  studio13 vs repitch:    {cents_diff:+.1f} cents")
