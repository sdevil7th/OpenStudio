"""
Spectral quality analysis: original vs RePitch vs Studio13 SMS engine
"""

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.fft import rfft, rfftfreq
import warnings
warnings.filterwarnings('ignore')

# ─── File loading ────────────────────────────────────────────────────────────

FILE_ORIG   = r"D:\test projects\untitled3.wav"
FILE_REPITCH = r"D:\test projects\untitled3-001.wav"
FILE_S13    = r"D:\test projects\Untitled Project26.wav"

def load_mono(path):
    data, sr = sf.read(path, always_2d=True)
    mono = data.mean(axis=1)
    print(f"  {path.split(chr(92))[-1]}: {len(mono)/sr:.3f}s  sr={sr}  channels={data.shape[1]}")
    return mono, sr

print("=== Loading files ===")
orig,  sr_o  = load_mono(FILE_ORIG)
rep,   sr_r  = load_mono(FILE_REPITCH)
s13,   sr_s  = load_mono(FILE_S13)

# Normalise all to same sample rate (use original as reference)
assert sr_o == sr_r == sr_s, f"Sample rates differ: {sr_o} {sr_r} {sr_s}"
SR = sr_o
print(f"  Common SR: {SR} Hz\n")

# S13 amplitude correction (normalize was ON → 3.48× higher)
S13_AMP_SCALE = 1.0 / 3.48
s13_corrected = s13 * S13_AMP_SCALE

# ─── Helpers ─────────────────────────────────────────────────────────────────

def frame(sig, sr, t_start, t_end):
    return sig[int(t_start*sr):int(t_end*sr)]

def hnr_autocorr(sig, sr, frame_ms=30, hop_ms=10):
    """
    HNR via autocorrelation (Praat-style).
    Returns median HNR in dB over all voiced frames.
    """
    frame_len = int(sr * frame_ms / 1000)
    hop_len   = int(sr * hop_ms  / 1000)
    hnrs = []
    for start in range(0, len(sig) - frame_len, hop_len):
        frm = sig[start:start+frame_len]
        frm = frm * np.hanning(len(frm))
        ac = np.correlate(frm, frm, mode='full')
        ac = ac[len(ac)//2:]          # keep positive lags
        ac /= (ac[0] + 1e-12)         # normalise to 1 at lag=0

        # search for peak in lag range corresponding to 50–600 Hz
        lag_min = int(SR / 600)
        lag_max = int(SR / 50)
        lag_min = max(lag_min, 1)
        lag_max = min(lag_max, len(ac)-1)

        peak_val = ac[lag_min:lag_max].max()
        peak_val = min(peak_val, 0.9999)   # clamp for log
        if peak_val > 0.1:                 # voiced frame only
            hnr = 10 * np.log10(peak_val / (1 - peak_val))
            hnrs.append(hnr)
    return np.median(hnrs) if hnrs else float('nan'), np.std(hnrs) if hnrs else float('nan')

def lpc_formants(sig, sr, order=12):
    """
    Estimate formants via LPC (autocorrelation method).
    Returns sorted list of formant frequencies.
    """
    # Pre-emphasis
    pre = np.append(sig[0], sig[1:] - 0.97*sig[:-1])
    pre = pre * np.hanning(len(pre))

    # Autocorrelation LPC
    from scipy.signal import lfilter
    # Build autocorrelation matrix
    r = np.array([np.dot(pre[i:], pre[:len(pre)-i]) for i in range(order+1)])
    # Levinson-Durbin
    a = np.zeros(order+1)
    e = r[0]
    a[0] = 1.0
    for i in range(1, order+1):
        lam = -sum(a[j]*r[i-j] for j in range(i)) / (e + 1e-12)
        a_new = a.copy()
        for j in range(1, i):
            a_new[j] = a[j] + lam * a[i-j]
        a_new[i] = lam
        e *= (1 - lam**2)
        a = a_new

    # Roots of LPC polynomial
    roots = np.roots(a)
    roots = roots[np.imag(roots) > 0]   # upper half plane only
    angles = np.angle(roots)
    freqs = angles * sr / (2 * np.pi)
    freqs = np.sort(freqs)
    bw = -np.log(np.abs(roots[np.argsort(angles)])) * sr / np.pi
    # Keep only formants with bandwidth < 500 Hz and freq 90–5000 Hz
    formants = [(f, b) for f, b in zip(freqs, bw) if 90 < f < 5000 and b < 500]
    return formants[:4]  # F1..F4

def estimate_f0_harmonics(sig, sr, expected_f0=None):
    """
    Estimate F0 using autocorrelation and extract first 4 harmonic amplitudes
    from the magnitude spectrum.
    """
    win = sig * np.hanning(len(sig))
    ac = np.correlate(win, win, mode='full')
    ac = ac[len(ac)//2:]
    ac /= (ac[0] + 1e-12)

    lag_min = int(sr / 600)
    lag_max = int(sr / 50)
    peak_lag = lag_min + np.argmax(ac[lag_min:lag_max])
    f0 = sr / peak_lag

    # Magnitude spectrum for harmonic amplitudes
    N = len(sig)
    spec = np.abs(rfft(sig * np.hanning(N))) * 2 / N
    freqs = rfftfreq(N, 1/sr)

    def peak_at(target_hz, tol_hz=15):
        mask = np.abs(freqs - target_hz) < tol_hz
        if mask.any():
            return spec[mask].max()
        return 0.0

    harmonics = [peak_at(f0 * k) for k in range(1, 5)]
    return f0, harmonics

def snr_dB(ref, deg):
    """
    SNR between reference and degraded signal (same length trimmed).
    SNR = 10*log10( power(ref) / power(ref-deg) )
    """
    n = min(len(ref), len(deg))
    r = ref[:n]
    d = deg[:n]
    noise = r - d
    p_sig  = np.mean(r**2)
    p_noise = np.mean(noise**2)
    if p_noise < 1e-20:
        return float('inf')
    return 10 * np.log10(p_sig / p_noise)

def spectral_distortion_dB(ref, deg, sr, n_fft=2048):
    """
    Log-spectral distance (LSD) averaged over frames in dB.
    """
    n = min(len(ref), len(deg))
    r = ref[:n]; d = deg[:n]
    hop = n_fft // 2
    lsds = []
    for start in range(0, n - n_fft, hop):
        fr = np.abs(rfft(r[start:start+n_fft] * np.hanning(n_fft))) + 1e-10
        fd = np.abs(rfft(d[start:start+n_fft] * np.hanning(n_fft))) + 1e-10
        lsd = np.sqrt(np.mean((20*np.log10(fr/fd))**2))
        lsds.append(lsd)
    return np.mean(lsds), np.std(lsds)

# ─── 1. HNR at t=2.0–2.8s ────────────────────────────────────────────────────

print("=" * 60)
print("1. HNR (Harmonics-to-Noise Ratio) at t=2.0–2.8s")
print("=" * 60)

T_HNR_S, T_HNR_E = 2.0, 2.8

seg_orig_hnr = frame(orig,          SR, T_HNR_S, T_HNR_E)
seg_rep_hnr  = frame(rep,           SR, T_HNR_S, T_HNR_E)
seg_s13_hnr  = frame(s13_corrected, SR, T_HNR_S, T_HNR_E)

hnr_o, hnr_o_std = hnr_autocorr(seg_orig_hnr, SR)
hnr_r, hnr_r_std = hnr_autocorr(seg_rep_hnr,  SR)
hnr_s, hnr_s_std = hnr_autocorr(seg_s13_hnr,  SR)

print(f"  Original : {hnr_o:+.2f} dB  (std={hnr_o_std:.2f})")
print(f"  RePitch  : {hnr_r:+.2f} dB  (std={hnr_r_std:.2f})")
print(f"  Studio13 : {hnr_s:+.2f} dB  (std={hnr_s_std:.2f})")
delta_s = hnr_s - hnr_o
delta_r = hnr_r - hnr_o
print(f"  Δ Studio13 vs original : {delta_s:+.2f} dB")
print(f"  Δ RePitch  vs original : {delta_r:+.2f} dB")

# ─── 2. Formant analysis at t=2.3–2.5s ──────────────────────────────────────

print()
print("=" * 60)
print("2. Formant analysis (LPC) at t=2.3–2.5s  (pitch-shifted region)")
print("=" * 60)

T_FORM_S, T_FORM_E = 2.3, 2.5

seg_orig_f  = frame(orig,          SR, T_FORM_S, T_FORM_E)
seg_rep_f   = frame(rep,           SR, T_FORM_S, T_FORM_E)
seg_s13_f   = frame(s13_corrected, SR, T_FORM_S, T_FORM_E)

fm_o = lpc_formants(seg_orig_f, SR, order=14)
fm_r = lpc_formants(seg_rep_f,  SR, order=14)
fm_s = lpc_formants(seg_s13_f,  SR, order=14)

def fmt_formants(flist):
    parts = []
    for i, (f, b) in enumerate(flist[:3]):
        parts.append(f"F{i+1}={f:.0f}Hz(BW={b:.0f})")
    return "  ".join(parts)

print(f"  Original : {fmt_formants(fm_o)}")
print(f"  RePitch  : {fmt_formants(fm_r)}")
print(f"  Studio13 : {fmt_formants(fm_s)}")

# Compare F1/F2/F3 shifts relative to original
print()
print("  Formant shift vs original (+ = higher):")
for label, fms in [("RePitch", fm_r), ("Studio13", fm_s)]:
    shifts = []
    for i in range(min(3, len(fm_o), len(fms))):
        diff = fms[i][0] - fm_o[i][0]
        shifts.append(f"ΔF{i+1}={diff:+.0f}Hz")
    print(f"    {label}: {', '.join(shifts)}")

note = "  Note: ideal formant-preserving pitch shift = formants stay near original position"
print(note)

# ─── 3. Harmonic structure at t=2.3s ─────────────────────────────────────────

print()
print("=" * 60)
print("3. Harmonic structure at t=2.3–2.5s (F0 and first 4 harmonics)")
print("=" * 60)

ANALYSIS_DURATION = 0.2   # 200ms window

seg_orig_h  = frame(orig,          SR, 2.3, 2.3 + ANALYSIS_DURATION)
seg_rep_h   = frame(rep,           SR, 2.3, 2.3 + ANALYSIS_DURATION)
seg_s13_h   = frame(s13_corrected, SR, 2.3, 2.3 + ANALYSIS_DURATION)

f0_o, harm_o = estimate_f0_harmonics(seg_orig_h, SR)
f0_r, harm_r = estimate_f0_harmonics(seg_rep_h,  SR)
f0_s, harm_s = estimate_f0_harmonics(seg_s13_h,  SR)

print(f"  Original : F0={f0_o:.1f}Hz  harmonics (rel) = {[f'{h/harm_o[0]*100:.1f}%' for h in harm_o]}")
print(f"  RePitch  : F0={f0_r:.1f}Hz  harmonics (rel) = {[f'{h/harm_r[0]*100:.1f}%' for h in harm_r]}")
print(f"  Studio13 : F0={f0_s:.1f}Hz  harmonics (rel) = {[f'{h/harm_s[0]*100:.1f}%' for h in harm_s]}")

# Convert to semitones from D4 (293.66 Hz)
D4 = 293.66
def to_semitones(f, ref=D4):
    return 12 * np.log2(f / ref) if f > 0 else float('nan')

print(f"\n  Pitch relative to D4 (293.66 Hz):")
print(f"    Original : {to_semitones(f0_o):+.2f} semitones  ({f0_o:.1f} Hz)")
print(f"    RePitch  : {to_semitones(f0_r):+.2f} semitones  ({f0_r:.1f} Hz)")
print(f"    Studio13 : {to_semitones(f0_s):+.2f} semitones  ({f0_s:.1f} Hz)")

# Harmonic amplitude drop-off (indicator of tonal clarity — exponential decay = clean)
print(f"\n  Harmonic amplitude absolute values (normalized to orig H1=1.0):")
h_ref = harm_o[0] + 1e-12
for label, harms in [("Original", harm_o), ("RePitch", harm_r), ("Studio13", harm_s)]:
    norm = [h/h_ref for h in harms]
    print(f"    {label:10s}: {['H'+str(i+1)+'='+f'{n:.3f}' for i,n in enumerate(norm)]}")

# ─── 4. Identity region SNR: t=0–2.0s ────────────────────────────────────────

print()
print("=" * 60)
print("4. Identity region SNR (t=0.0–2.0s) — unmodified region")
print("=" * 60)

T_ID_S, T_ID_E = 0.0, 2.0

seg_orig_id = frame(orig,          SR, T_ID_S, T_ID_E)
seg_rep_id  = frame(rep,           SR, T_ID_S, T_ID_E)
seg_s13_id  = frame(s13_corrected, SR, T_ID_S, T_ID_E)

snr_rep = snr_dB(seg_orig_id, seg_rep_id)
snr_s13 = snr_dB(seg_orig_id, seg_s13_id)

lsd_rep, lsd_rep_std = spectral_distortion_dB(seg_orig_id, seg_rep_id, SR)
lsd_s13, lsd_s13_std = spectral_distortion_dB(seg_orig_id, seg_s13_id, SR)

print(f"  Time-domain SNR vs original:")
print(f"    RePitch  : {snr_rep:+.1f} dB")
print(f"    Studio13 : {snr_s13:+.1f} dB")
print(f"  Log-Spectral Distance (LSD, lower = better):")
print(f"    RePitch  : {lsd_rep:.2f} dB  (σ={lsd_rep_std:.2f})")
print(f"    Studio13 : {lsd_s13:.2f} dB  (σ={lsd_s13_std:.2f})")

# ─── 5. Bonus: Spectral flatness (noise proxy) in shifted region ──────────────

print()
print("=" * 60)
print("5. Bonus: Spectral flatness at t=2.0–2.8s (noise proxy)")
print("   Lower = more tonal/harmonic; higher = noisier/more noise-like")
print("=" * 60)

def spectral_flatness(sig, n_fft=2048):
    """Geometric mean / arithmetic mean of power spectrum (averaged over frames)."""
    hop = n_fft // 2
    sfs = []
    for start in range(0, len(sig) - n_fft, hop):
        chunk = sig[start:start+n_fft]
        win = chunk * np.hanning(n_fft)
        spec = np.abs(rfft(win))**2 + 1e-10
        geo = np.exp(np.mean(np.log(spec)))
        ari = np.mean(spec)
        sfs.append(geo / ari)
    return float(np.mean(sfs)) if sfs else 0.0

sf_o = spectral_flatness(seg_orig_hnr)
sf_r = spectral_flatness(seg_rep_hnr)
sf_s = spectral_flatness(seg_s13_hnr)

print(f"  Original : {sf_o:.6f}")
print(f"  RePitch  : {sf_r:.6f}")
print(f"  Studio13 : {sf_s:.6f}")
print(f"  (ratio S13/orig: {sf_s/sf_o:.3f}x,  ratio RePitch/orig: {sf_r/sf_o:.3f}x)")

# ─── 6. Spectral continuity across edit boundary ─────────────────────────────

print()
print("=" * 60)
print("6. Spectral continuity across edit boundary (t=2.0–2.4s vs t=2.4–2.8s)")
print("   LSD between adjacent halves — high = discontinuity/artifact")
print("=" * 60)

def spectral_centroid_and_rolloff(sig, sr, n_fft=2048):
    chunk = sig[:n_fft]
    win = chunk * np.hanning(len(chunk))
    spec = np.abs(rfft(win))**2
    freqs = rfftfreq(n_fft, 1/sr)
    centroid = np.sum(freqs * spec) / (np.sum(spec) + 1e-12)
    cum = np.cumsum(spec)
    rolloff_idx = np.searchsorted(cum, 0.85 * cum[-1])
    rolloff = freqs[min(rolloff_idx, len(freqs)-1)]
    return centroid, rolloff

for label, sig_arr in [("Original", orig), ("RePitch", rep), ("Studio13", s13_corrected)]:
    seg_pre  = frame(sig_arr, SR, 2.0, 2.4)
    seg_post = frame(sig_arr, SR, 2.4, 2.8)
    lsd, _ = spectral_distortion_dB(seg_pre, seg_post, SR)
    c_pre,  r_pre  = spectral_centroid_and_rolloff(seg_pre, SR)
    c_post, r_post = spectral_centroid_and_rolloff(seg_post, SR)
    print(f"  {label:10s}: LSD(pre vs post) = {lsd:.2f} dB  "
          f"centroid: {c_pre:.0f}→{c_post:.0f}Hz  rolloff: {r_pre:.0f}→{r_post:.0f}Hz")

# ─── Summary ─────────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("SUMMARY")
print("=" * 60)
print(f"""
Quality metric          Original    RePitch     Studio13
───────────────────────────────────────────────────────────
HNR (dB, t=2.0-2.8s)   {hnr_o:+6.2f}     {hnr_r:+6.2f}      {hnr_s:+6.2f}
HNR Δ vs original       --          {delta_r:+6.2f}      {delta_s:+6.2f}
Spectral flatness       {sf_o:.6f}  {sf_r:.6f}   {sf_s:.6f}
  (noise proxy)
Identity SNR (0-2s)     --          {snr_rep:+6.1f}      {snr_s13:+6.1f}  dB
Identity LSD (0-2s)     --          {lsd_rep:6.2f}       {lsd_s13:6.2f}   dB

F0 at t=2.3s            {f0_o:.1f}Hz     {f0_r:.1f}Hz      {f0_s:.1f}Hz
  semitones vs D4       {to_semitones(f0_o):+.2f}st      {to_semitones(f0_r):+.2f}st       {to_semitones(f0_s):+.2f}st

Formants (F1/F2/F3) at t=2.3–2.5s:
  F1   {fm_o[0][0] if fm_o else 0:.0f}Hz      {fm_r[0][0] if fm_r else 0:.0f}Hz       {fm_s[0][0] if fm_s else 0:.0f}Hz
  F2   {fm_o[1][0] if len(fm_o)>1 else 0:.0f}Hz      {fm_r[1][0] if len(fm_r)>1 else 0:.0f}Hz      {fm_s[1][0] if len(fm_s)>1 else 0:.0f}Hz
  F3   {fm_o[2][0] if len(fm_o)>2 else 0:.0f}Hz      {fm_r[2][0] if len(fm_r)>2 else 0:.0f}Hz      {fm_s[2][0] if len(fm_s)>2 else 0:.0f}Hz
""")
print("Analysis complete.")
