#include "PitchResynthesizer.h"
#include "SignalsmithShifter.h"
#include <juce_core/juce_core.h>
#include <cmath>
#include <algorithm>
#include <cstring>
#include <numeric>

static float midiToHz(float midi)
{
    return 440.0f * std::pow(2.0f, (midi - 69.0f) / 12.0f);
}

// Formant post-correction (currently disabled — SMS engine handles formant preservation
// via LPC spectral envelope, and this STFT-based correction was adding subtle artifacts).
// Kept as dead code for future re-activation with improved algorithm.
#if 0
static void applyFormantPostCorrection(
    std::vector<std::vector<float>>& output,
    const float* originalMono,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios)
{
    // Only proceed if there are shifts large enough to benefit from extra correction.
    // Ratio of ~1.19 = +3 semitones, ~0.84 = -3 semitones.
    const float ratioThreshold = 0.15f;
    bool hasLargeShift = false;
    for (size_t i = 0; i < ratios.size() && !hasLargeShift; i += 256)
        if (std::abs(ratios[i] - 1.0f) > ratioThreshold) hasLargeShift = true;
    if (!hasLargeShift) return;

    const int fftOrder = 11; // 2^11 = 2048
    const int fftSize = 1 << fftOrder;
    const int hopLen = fftSize / 4; // 75% overlap for clean overlap-add
    const int halfBins = fftSize / 2 + 1;

    // Spectral envelope smoothing width: ~500 Hz (captures formant peaks without
    // following individual harmonics). At 44100 Hz with 2048 FFT, bin width = 21.5 Hz,
    // so ~23 bins = 500 Hz.
    const int envSmoothBins = std::max(3,
        static_cast<int>(500.0 * static_cast<double>(fftSize) / sampleRate));

    juce::dsp::FFT fft(fftOrder);

    // Hann window (precomputed)
    std::vector<float> hannWin(static_cast<size_t>(fftSize));
    for (int i = 0; i < fftSize; ++i)
        hannWin[static_cast<size_t>(i)] = 0.5f * (1.0f - std::cos(
            2.0f * juce::MathConstants<float>::pi * static_cast<float>(i)
            / static_cast<float>(fftSize - 1)));

    // Smooth a magnitude spectrum to get spectral envelope via moving average
    auto smoothEnvelope = [&](const std::vector<float>& mag, std::vector<float>& env) {
        for (int i = 0; i < halfBins; ++i)
        {
            float sum = 0.0f;
            int lo = std::max(0, i - envSmoothBins / 2);
            int hi = std::min(halfBins - 1, i + envSmoothBins / 2);
            for (int j = lo; j <= hi; ++j)
                sum += mag[static_cast<size_t>(j)];
            env[static_cast<size_t>(i)] = sum / static_cast<float>(hi - lo + 1) + 1e-10f;
        }
    };

    std::vector<float> origFFTBuf(static_cast<size_t>(fftSize * 2));
    std::vector<float> outFFTBuf(static_cast<size_t>(fftSize * 2));
    std::vector<float> origMag(static_cast<size_t>(halfBins));
    std::vector<float> outMag(static_cast<size_t>(halfBins));
    std::vector<float> origEnv(static_cast<size_t>(halfBins));
    std::vector<float> outEnv(static_cast<size_t>(halfBins));

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = output[static_cast<size_t>(ch)];
        std::vector<float> corrected(static_cast<size_t>(numSamples), 0.0f);
        std::vector<float> winSum(static_cast<size_t>(numSamples), 0.0f);

        for (int pos = 0; pos < numSamples; pos += hopLen)
        {
            // Average ratio in this frame
            float avgRatio = 0.0f;
            int cnt = 0;
            for (int i = pos; i < std::min(pos + fftSize, numSamples); ++i)
            {
                avgRatio += ratios[static_cast<size_t>(i)];
                ++cnt;
            }
            avgRatio = (cnt > 0) ? avgRatio / static_cast<float>(cnt) : 1.0f;

            bool needsCorrection = (std::abs(avgRatio - 1.0f) > ratioThreshold);

            if (!needsCorrection)
            {
                // Pass through unchanged (just overlap-add with window)
                for (int i = 0; i < fftSize; ++i)
                {
                    int idx = pos + i;
                    if (idx >= 0 && idx < numSamples)
                    {
                        float w = hannWin[static_cast<size_t>(i)];
                        corrected[static_cast<size_t>(idx)] += out[static_cast<size_t>(idx)] * w;
                        winSum[static_cast<size_t>(idx)] += w * w;
                    }
                }
                continue;
            }

            // Window original mono and output channel
            std::fill(origFFTBuf.begin(), origFFTBuf.end(), 0.0f);
            std::fill(outFFTBuf.begin(), outFFTBuf.end(), 0.0f);
            for (int i = 0; i < fftSize; ++i)
            {
                int idx = pos + i;
                float w = hannWin[static_cast<size_t>(i)];
                origFFTBuf[static_cast<size_t>(i)] =
                    (idx >= 0 && idx < numSamples) ? originalMono[idx] * w : 0.0f;
                outFFTBuf[static_cast<size_t>(i)] =
                    (idx >= 0 && idx < numSamples) ? out[static_cast<size_t>(idx)] * w : 0.0f;
            }

            // Forward FFT
            fft.performRealOnlyForwardTransform(origFFTBuf.data(), true);
            fft.performRealOnlyForwardTransform(outFFTBuf.data(), true);

            // Compute magnitudes
            for (int i = 0; i < halfBins; ++i)
            {
                float ore = origFFTBuf[static_cast<size_t>(i * 2)];
                float oim = origFFTBuf[static_cast<size_t>(i * 2 + 1)];
                origMag[static_cast<size_t>(i)] = std::sqrt(ore * ore + oim * oim);

                float ure = outFFTBuf[static_cast<size_t>(i * 2)];
                float uim = outFFTBuf[static_cast<size_t>(i * 2 + 1)];
                outMag[static_cast<size_t>(i)] = std::sqrt(ure * ure + uim * uim);
            }

            // Smooth to spectral envelopes
            smoothEnvelope(origMag, origEnv);
            smoothEnvelope(outMag, outEnv);

            // Correction strength scales with shift magnitude:
            //   <= 3 semitones (ratio threshold): 0%
            //   12 semitones (ratio ~2.0): 60%
            float shiftMagnitude = std::abs(avgRatio - 1.0f);
            float strength = juce::jlimit(0.0f, 0.6f, (shiftMagnitude - ratioThreshold) * 1.5f);

            // Apply spectral envelope correction to output FFT
            for (int i = 0; i < halfBins; ++i)
            {
                float gain = std::pow(origEnv[static_cast<size_t>(i)]
                                    / outEnv[static_cast<size_t>(i)], strength);
                gain = juce::jlimit(0.25f, 4.0f, gain); // prevent extreme corrections
                outFFTBuf[static_cast<size_t>(i * 2)] *= gain;
                outFFTBuf[static_cast<size_t>(i * 2 + 1)] *= gain;
            }

            // Inverse FFT
            fft.performRealOnlyInverseTransform(outFFTBuf.data());

            // Overlap-add
            for (int i = 0; i < fftSize; ++i)
            {
                int idx = pos + i;
                if (idx >= 0 && idx < numSamples)
                {
                    float w = hannWin[static_cast<size_t>(i)];
                    corrected[static_cast<size_t>(idx)] += outFFTBuf[static_cast<size_t>(i)] * w;
                    winSum[static_cast<size_t>(idx)] += w * w;
                }
            }
        }

        // Normalize by window sum (COLA condition)
        for (int s = 0; s < numSamples; ++s)
        {
            if (winSum[static_cast<size_t>(s)] > 0.001f)
                out[static_cast<size_t>(s)] = corrected[static_cast<size_t>(s)]
                                            / winSum[static_cast<size_t>(s)];
        }
    }
}
#endif // formant post-correction disabled

// Gaussian-smooth the per-frame pitch contour to remove YIN detection jitter.
// This operates in MIDI (semitone) domain — the correct domain for pitch smoothing
// since human pitch perception is logarithmic.
// Only smooths voiced frames (midiNote > 0); unvoiced gaps are interpolated through
// if short (<gapThreshold frames), otherwise left as 0.
static std::vector<float> smoothPitchContour(
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    double sampleRate,
    float windowMs)
{
    juce::ignoreUnused(sampleRate);
    int n = static_cast<int>(frames.size());
    if (n < 2) return {};

    // Extract raw pitch values
    std::vector<float> raw(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
        raw[static_cast<size_t>(i)] = frames[static_cast<size_t>(i)].midiNote;

    // Determine hop time from frames
    float hopTimeSec = (frames.size() >= 2) ? (frames[1].time - frames[0].time) : 0.005f;
    float hopMs = hopTimeSec * 1000.0f;

    int halfWindow = std::max(1, static_cast<int>(windowMs / hopMs * 0.5f));
    float sigma = static_cast<float>(halfWindow) / 2.5f;
    float invTwoSigmaSq = 1.0f / (2.0f * sigma * sigma);

    // Bridge short unvoiced gaps (< 6 frames ~30ms) by interpolating pitch
    // This prevents consonants within a word from creating ratio discontinuities
    const int maxGapFrames = 6;
    std::vector<float> bridged = raw;
    int gapStart = -1;
    for (int i = 0; i < n; ++i)
    {
        if (bridged[static_cast<size_t>(i)] <= 0.0f)
        {
            if (gapStart < 0) gapStart = i;
        }
        else
        {
            if (gapStart >= 0)
            {
                int gapLen = i - gapStart;
                if (gapLen <= maxGapFrames && gapStart > 0)
                {
                    // Interpolate from the last voiced frame to the current one
                    float startPitch = bridged[static_cast<size_t>(gapStart - 1)];
                    float endPitch = bridged[static_cast<size_t>(i)];
                    for (int g = 0; g < gapLen; ++g)
                    {
                        float t = static_cast<float>(g + 1) / static_cast<float>(gapLen + 1);
                        bridged[static_cast<size_t>(gapStart + g)] = startPitch + (endPitch - startPitch) * t;
                    }
                }
                gapStart = -1;
            }
        }
    }

    // Gaussian smooth
    std::vector<float> smoothed(static_cast<size_t>(n), 0.0f);
    for (int i = 0; i < n; ++i)
    {
        if (bridged[static_cast<size_t>(i)] <= 0.0f)
        {
            smoothed[static_cast<size_t>(i)] = 0.0f;
            continue;
        }

        float weightedSum = 0.0f;
        float weightTotal = 0.0f;
        int lo = std::max(0, i - halfWindow);
        int hi = std::min(n - 1, i + halfWindow);

        for (int j = lo; j <= hi; ++j)
        {
            if (bridged[static_cast<size_t>(j)] <= 0.0f) continue; // skip unvoiced
            float d = static_cast<float>(j - i);
            float w = std::exp(-d * d * invTwoSigmaSq);
            weightedSum += bridged[static_cast<size_t>(j)] * w;
            weightTotal += w;
        }

        smoothed[static_cast<size_t>(i)] = (weightTotal > 0.0f)
            ? weightedSum / weightTotal
            : bridged[static_cast<size_t>(i)];
    }

    return smoothed;
}

// Check if a frame at frameIdx is in a short unvoiced gap surrounded by voiced frames.
// Used to bridge brief consonants that shouldn't break the correction curve.
static bool isShortUnvoicedGap(int frameIdx, const std::vector<PitchAnalyzer::PitchFrame>& frames, int maxGapFrames)
{
    int n = static_cast<int>(frames.size());

    // Look backward for a voiced frame
    int backVoiced = -1;
    for (int i = frameIdx - 1; i >= std::max(0, frameIdx - maxGapFrames); --i)
    {
        if (frames[static_cast<size_t>(i)].voiced && frames[static_cast<size_t>(i)].midiNote > 0.0f)
        {
            backVoiced = i;
            break;
        }
    }
    if (backVoiced < 0) return false;

    // Look forward for a voiced frame
    for (int i = frameIdx + 1; i <= std::min(n - 1, frameIdx + maxGapFrames); ++i)
    {
        if (frames[static_cast<size_t>(i)].voiced && frames[static_cast<size_t>(i)].midiNote > 0.0f)
            return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Three-Component Pitch Decomposition (8.1)
//
// Decomposes a per-frame pitch contour within a note into:
//   center:    mean pitch of the note (what the user drags)
//   drift(t):  slow wandering < 2Hz (intonation error)
//   vibrato(t): periodic oscillation 3-8Hz (musical expression)
//   noise(t):  random detection jitter (discarded)
//
// Uses 2nd-order Butterworth IIR filters in the MIDI (semitone) domain.
// ---------------------------------------------------------------------------

struct PitchDecomposition
{
    float center = 0.0f;                // mean MIDI pitch
    std::vector<float> drift;           // per-frame slow deviation (<2Hz)
    std::vector<float> vibrato;         // per-frame periodic component (3-8Hz)
};

// 2nd-order Butterworth lowpass filter coefficients for given cutoff
static void butterworth2LP (float cutoffHz, float sampleRateHz,
                             float& b0, float& b1, float& b2,
                             float& a1, float& a2)
{
    const float pi = juce::MathConstants<float>::pi;
    float wc = std::tan (pi * cutoffHz / sampleRateHz);
    float wc2 = wc * wc;
    float sqrt2 = std::sqrt (2.0f);
    float k = 1.0f / (1.0f + sqrt2 * wc + wc2);

    b0 = wc2 * k;
    b1 = 2.0f * b0;
    b2 = b0;
    a1 = 2.0f * (wc2 - 1.0f) * k;
    a2 = (1.0f - sqrt2 * wc + wc2) * k;
}

// Apply 2nd-order IIR forward+backward (zero-phase, Butterworth)
static std::vector<float> filtfilt2 (const std::vector<float>& input,
                                      float b0, float b1, float b2,
                                      float a1, float a2)
{
    int n = static_cast<int> (input.size());
    if (n < 3) return input;

    // Forward pass
    std::vector<float> fwd (static_cast<size_t> (n));
    float x1 = input[0], x2 = input[0];
    float y1 = input[0], y2 = input[0];
    for (int i = 0; i < n; ++i)
    {
        float x0 = input[static_cast<size_t> (i)];
        float y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        fwd[static_cast<size_t> (i)] = y0;
        x2 = x1; x1 = x0;
        y2 = y1; y1 = y0;
    }

    // Backward pass (zero-phase)
    std::vector<float> result (static_cast<size_t> (n));
    x1 = fwd[static_cast<size_t> (n - 1)]; x2 = x1;
    y1 = x1; y2 = x1;
    for (int i = n - 1; i >= 0; --i)
    {
        float x0 = fwd[static_cast<size_t> (i)];
        float y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        result[static_cast<size_t> (i)] = y0;
        x2 = x1; x1 = x0;
        y2 = y1; y1 = y0;
    }

    return result;
}

static PitchDecomposition decomposePitch (const std::vector<float>& framePitches,
                                           float hopRateHz)
{
    PitchDecomposition result;
    int n = static_cast<int> (framePitches.size());
    if (n < 4)
    {
        result.center = 0.0f;
        result.drift.assign (static_cast<size_t> (n), 0.0f);
        result.vibrato.assign (static_cast<size_t> (n), 0.0f);
        return result;
    }

    // Compute center (mean pitch)
    float sum = 0.0f;
    int count = 0;
    for (int i = 0; i < n; ++i)
    {
        if (framePitches[static_cast<size_t> (i)] > 0.0f)
        {
            sum += framePitches[static_cast<size_t> (i)];
            ++count;
        }
    }
    result.center = (count > 0) ? sum / static_cast<float> (count) : 0.0f;

    // Deviation from center
    std::vector<float> deviation (static_cast<size_t> (n));
    for (int i = 0; i < n; ++i)
        deviation[static_cast<size_t> (i)] = (framePitches[static_cast<size_t> (i)] > 0.0f)
            ? framePitches[static_cast<size_t> (i)] - result.center : 0.0f;

    // Lowpass at 2Hz → center + drift
    float b0lp, b1lp, b2lp, a1lp, a2lp;
    butterworth2LP (2.0f, hopRateHz, b0lp, b1lp, b2lp, a1lp, a2lp);
    auto driftPlusDC = filtfilt2 (deviation, b0lp, b1lp, b2lp, a1lp, a2lp);

    // drift = lowpass output (DC component of deviation is ~0 since we subtracted center)
    result.drift = driftPlusDC;

    // Bandpass 3-8Hz → vibrato
    // Implement as lowpass(8Hz) - lowpass(3Hz)
    float b0lp8, b1lp8, b2lp8, a1lp8, a2lp8;
    float b0lp3, b1lp3, b2lp3, a1lp3, a2lp3;
    butterworth2LP (8.0f, hopRateHz, b0lp8, b1lp8, b2lp8, a1lp8, a2lp8);
    butterworth2LP (3.0f, hopRateHz, b0lp3, b1lp3, b2lp3, a1lp3, a2lp3);

    auto lp8 = filtfilt2 (deviation, b0lp8, b1lp8, b2lp8, a1lp8, a2lp8);
    auto lp3 = filtfilt2 (deviation, b0lp3, b1lp3, b2lp3, a1lp3, a2lp3);

    result.vibrato.resize (static_cast<size_t> (n));
    for (int i = 0; i < n; ++i)
        result.vibrato[static_cast<size_t> (i)] = lp8[static_cast<size_t> (i)] - lp3[static_cast<size_t> (i)];

    return result;
}

PitchResynthesizer::PitchResynthesizer() = default;

std::vector<float> PitchResynthesizer::buildCorrectionCurve(
    int numSamples, double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    int hopSize)
{
    // Build per-sample pitch ratio: corrected / detected
    std::vector<float> ratios(static_cast<size_t>(numSamples), 1.0f);

    if (frames.empty() || notes.empty()) return ratios;

    // Accumulators for smooth overlap blending between adjacent notes' pre/post-roll regions.
    // Each note contributes: shiftContrib = (correctedMidi - framePitch) * blend
    // Final: ratio = midiToHz(framePitch + shiftAccum/blendAccum) / midiToHz(framePitch)
    std::vector<float> shiftAccum(static_cast<size_t>(numSamples), 0.0f);
    std::vector<float> blendAccum(static_cast<size_t>(numSamples), 0.0f);
    // Per-sample detected pitch (needed for final ratio computation)
    // Pre-fill from smoothed contour after it's computed below.

    // Pre-compute a smoothed pitch contour from the analysis frames.
    // This removes YIN per-frame jitter BEFORE ratio computation (not after).
    // The smoothed contour preserves the singer's natural pitch movement
    // (vibrato, expression, drift) while eliminating detection noise.
    auto smoothedContour = smoothPitchContour(frames, sampleRate, 10.0f);

    // Sort notes by start time for efficient adjacent-note lookup (portamento).
    std::vector<size_t> noteOrder(notes.size());
    std::iota(noteOrder.begin(), noteOrder.end(), 0);
    std::sort(noteOrder.begin(), noteOrder.end(), [&](size_t a, size_t b) {
        return notes[a].startTime < notes[b].startTime;
    });

    for (size_t ni = 0; ni < noteOrder.size(); ++ni)
    {
        const auto& note = notes[noteOrder[ni]];

        // Skip unedited notes entirely
        bool isEdited = std::abs(note.correctedPitch - note.detectedPitch) > 0.01f
                     || std::abs(note.gain) > 0.01f
                     || std::abs(note.formantShift) > 0.01f
                     || note.driftCorrectionAmount > 0.01f
                     || std::abs(note.vibratoDepth - 1.0f) > 0.01f;
        if (!isEdited) continue;

        int startSample = static_cast<int>(note.startTime * sampleRate);
        int endSample = static_cast<int>(note.endTime * sampleRate);
        startSample = juce::jlimit(0, numSamples - 1, startSample);
        endSample = juce::jlimit(0, numSamples - 1, endSample);

        // How far the user moved the note center
        float shiftAmount = note.correctedPitch - note.detectedPitch;
        float driftCorrection = note.driftCorrectionAmount;
        float noteCenter = note.detectedPitch; // the note's average detected pitch

        // Anticipation + release: ramp runs BEFORE note start and AFTER note end (RePitch-style).
        // Default 40ms pre-roll: correction arrives at the note boundary fully applied.
        // Default 60ms post-roll: correction eases back naturally after the note ends.
        float effectiveTransIn  = (note.transitionIn  > 0.0f) ? note.transitionIn  : 40.0f;
        float effectiveTransOut = (note.transitionOut > 0.0f) ? note.transitionOut : 60.0f;

        // --- Inter-note portamento ---
        // Find adjacent edited notes for smooth pitch glides at boundaries.
        // Instead of blending toward ratio=1.0 (original pitch) at edges, blend toward
        // the adjacent note's corrected pitch. This creates natural portamento.
        float prevNoteShift = 0.0f; // shift amount of the preceding note (0 = no adjacent)
        float nextNoteShift = 0.0f; // shift amount of the following note (0 = no adjacent)
        bool hasPrevNote = false;
        bool hasNextNote = false;

        // Look backward for adjacent edited note (gap < 100ms)
        if (ni > 0)
        {
            const auto& prev = notes[noteOrder[ni - 1]];
            float gap = note.startTime - prev.endTime;
            bool prevEdited = std::abs(prev.correctedPitch - prev.detectedPitch) > 0.01f;
            if (prevEdited && gap < 0.1f)
            {
                prevNoteShift = prev.correctedPitch - prev.detectedPitch;
                hasPrevNote = true;
            }
        }
        // Look forward for adjacent edited note (gap < 100ms)
        if (ni + 1 < noteOrder.size())
        {
            const auto& next = notes[noteOrder[ni + 1]];
            float gap = next.startTime - note.endTime;
            bool nextEdited = std::abs(next.correctedPitch - next.detectedPitch) > 0.01f;
            if (nextEdited && gap < 0.1f)
            {
                nextNoteShift = next.correctedPitch - next.detectedPitch;
                hasNextNote = true;
            }
        }

        // Anticipation + release: loop extends BEFORE note start (pre-roll) and AFTER note end
        // (post-roll). The ramp runs in these extended regions so the note body is always fully
        // corrected — no sudden onset or sudden cut at the note boundaries (RePitch-style).
        int transInSamplesInt  = static_cast<int>(effectiveTransIn  * 0.001f * static_cast<float>(sampleRate));
        int transOutSamplesInt = static_cast<int>(effectiveTransOut * 0.001f * static_cast<float>(sampleRate));
        int loopStart = std::max(0, startSample - transInSamplesInt);
        int loopEnd   = std::min(numSamples - 1, endSample + transOutSamplesInt);

        // Pre-compute drift/vibrato decomposition over note body (unchanged from before)
        // IIR filters only make sense over the note's voiced region, not the pre/post roll.
        std::vector<float> driftVec, vibratoVec;
        bool hasDecomp = false;
        if (driftCorrection > 0.01f || std::abs(note.vibratoDepth - 1.0f) > 0.01f)
        {
            int noteStartFrame = startSample / hopSize;
            int noteEndFrame   = endSample   / hopSize;
            noteStartFrame = juce::jlimit(0, static_cast<int>(frames.size()) - 1, noteStartFrame);
            noteEndFrame   = juce::jlimit(0, static_cast<int>(frames.size()) - 1, noteEndFrame);
            int noteFrameCount = noteEndFrame - noteStartFrame + 1;

            if (noteFrameCount >= 4)
            {
                std::vector<float> notePitches(static_cast<size_t>(noteFrameCount));
                for (int fi = 0; fi < noteFrameCount; ++fi)
                {
                    int globalFi = noteStartFrame + fi;
                    notePitches[static_cast<size_t>(fi)] =
                        (globalFi < static_cast<int>(smoothedContour.size()))
                            ? smoothedContour[static_cast<size_t>(globalFi)] : noteCenter;
                }
                float hopRateHz = static_cast<float>(sampleRate) / static_cast<float>(hopSize);
                auto decomp = decomposePitch(notePitches, hopRateHz);
                driftVec   = std::move(decomp.drift);
                vibratoVec = std::move(decomp.vibrato);
                hasDecomp  = true;
            }
        }
        // noteBodyStartFrame/End computed below for per-sample indexing
        int noteBodyStartFrame = startSample / hopSize;
        noteBodyStartFrame = juce::jlimit(0, static_cast<int>(frames.size()) - 1, noteBodyStartFrame);
        int noteBodyEndFrame = endSample / hopSize;
        noteBodyEndFrame = juce::jlimit(0, static_cast<int>(frames.size()) - 1, noteBodyEndFrame);
        int noteFrameCount = noteBodyEndFrame - noteBodyStartFrame + 1;

        for (int s = loopStart; s <= loopEnd; ++s)
        {
            int frameIdx = s / hopSize;
            if (frameIdx < 0 || frameIdx >= static_cast<int>(frames.size())) continue;

            const auto& frame = frames[static_cast<size_t>(frameIdx)];

            // Skip silent frames
            // Post-roll frames (after note end) bypass the silent/unvoiced guards:
            // the smoothstep there fades *toward* ratio=1.0, so writing transitioning
            // ratios to consonants/silence is harmless and prevents a hard jump back
            // to uncorrected pitch the moment the voiced region ends.
            bool inPostRoll = (s > endSample);

            if (!inPostRoll && frame.rmsDB < -60.0f) continue;

            // --- Voiced/unvoiced classification ---
            // Unvoiced content (consonants, sibilants, breaths) passes through unmodified
            // within the note body and pre-roll only.
            if (!inPostRoll)
            {
                bool isUnvoiced = !frame.voiced || frame.midiNote <= 0.0f;
                // Exception: short unvoiced gap within a voiced note = brief consonant ("t","d","k")
                if (isUnvoiced && isShortUnvoicedGap(frameIdx, frames, 6))
                    isUnvoiced = false;
                if (isUnvoiced)
                    continue; // ratio stays 1.0 — complete passthrough
            }

            // --- CONTOUR-PRESERVING PITCH CORRECTION ---
            float framePitch = (frameIdx < static_cast<int>(smoothedContour.size()))
                ? smoothedContour[static_cast<size_t>(frameIdx)]
                : 0.0f;

            if (framePitch <= 0.0f)
                framePitch = noteCenter;

            float correctedMidi = framePitch + shiftAmount;

            // Apply drift/vibrato correction (only within note body, not pre/post roll)
            if (hasDecomp && s >= startSample && s <= endSample && noteFrameCount >= 4)
            {
                int localFrame = juce::jlimit(0, noteFrameCount - 1, frameIdx - noteBodyStartFrame);
                float driftVal   = driftVec[static_cast<size_t>(localFrame)];
                float vibratoVal = vibratoVec[static_cast<size_t>(localFrame)];
                correctedMidi -= driftVal * driftCorrection;
                correctedMidi += vibratoVal * (note.vibratoDepth - 1.0f);
            }
            else if (!hasDecomp && (driftCorrection > 0.01f || std::abs(note.vibratoDepth - 1.0f) > 0.01f)
                     && s >= startSample && s <= endSample)
            {
                // Fallback for very short notes: simple deviation-based correction
                float deviation = framePitch - noteCenter;
                correctedMidi -= deviation * driftCorrection;
                correctedMidi += deviation * (note.vibratoDepth - 1.0f);
            }

            // --- Anticipation + release blend ---
            // distFromStart < 0 → pre-roll (before note start)
            // distFromStart >= 0 and distFromEnd <= 0 → note body (full correction)
            // distFromEnd > 0 → post-roll (after note end)
            float distFromStart   = static_cast<float>(s - startSample);
            float distFromEnd     = static_cast<float>(s - endSample);
            float transitionBlend = 1.0f; // used by write guard below

            if (distFromStart < 0.0f)
            {
                // --- Pre-roll ---
                // Blend from 0 → 1 as we approach note start.
                // Source anchor: previous note's corrected pitch (or original if none).
                // Target: this note's full correction.
                float t = 1.0f + distFromStart / static_cast<float>(transInSamplesInt);
                t = juce::jlimit(0.0f, 1.0f, t);
                transitionBlend = t * t * (3.0f - 2.0f * t); // smoothstep 0→1

                float sourceAnchor = hasPrevNote ? (framePitch + prevNoteShift) : framePitch;
                correctedMidi = sourceAnchor + (correctedMidi - sourceAnchor) * transitionBlend;
            }
            else if (distFromEnd > 0.0f)
            {
                // --- Post-roll ---
                // Blend from 1 → 0 as we move away from note end.
                //
                // KEY: anchor the release at noteCenter+shiftAmount (the note's stable
                // corrected pitch), NOT at framePitch+shiftAmount.  If the original audio
                // pitch falls steeply after the note (common before a breath or rest), using
                // framePitch would cause a "double drop": falling detected pitch AND fading
                // correction — producing an unnatural sharp exit (visible in image 3 graphs).
                // Using noteCenter as the anchor ensures the pitch releases from a steady
                // value and blends smoothly toward wherever the original audio goes.
                float t = 1.0f - distFromEnd / static_cast<float>(transOutSamplesInt);
                t = juce::jlimit(0.0f, 1.0f, t);
                transitionBlend = t * t * (3.0f - 2.0f * t); // smoothstep 1→0

                float noteEndCorrected = noteCenter + shiftAmount; // stable anchor
                float postTarget       = hasNextNote ? (framePitch + nextNoteShift) : framePitch;
                correctedMidi = postTarget + (noteEndCorrected - postTarget) * transitionBlend;
            }

            // Accumulate weighted shift (in semitones) so overlapping pre/post-roll regions
            // from adjacent notes blend smoothly instead of hard-switching at blend=0.5.
            //
            // Each note contributes: shiftContrib = (correctedMidi - framePitch) * blend
            // Final: correctedMidi_final = framePitch + shiftAccum[s] / blendAccum[s]
            // This handles the overlap zone naturally — no hard crossing artifact.
            float shiftContrib = (correctedMidi - framePitch) * transitionBlend;
            size_t idx = static_cast<size_t>(s);
            shiftAccum[idx] += shiftContrib;
            blendAccum[idx] += transitionBlend;
        }
    }

    // -------------------------------------------------------------------------
    // Final pass: convert accumulated weighted shifts → per-sample ratios.
    // Samples touched by no note keep ratios[s] = 1.0 (passthrough).
    // -------------------------------------------------------------------------
    for (int s = 0; s < numSamples; ++s)
    {
        float totalBlend = blendAccum[static_cast<size_t>(s)];
        if (totalBlend <= 0.0f)
            continue; // no correction applied here

        int frameIdx = s / hopSize;
        if (frameIdx < 0 || frameIdx >= static_cast<int>(frames.size()))
            continue;

        float framePitch = (frameIdx < static_cast<int>(smoothedContour.size()))
            ? smoothedContour[static_cast<size_t>(frameIdx)]
            : 0.0f;
        if (framePitch <= 0.0f)
            continue;

        float avgShift      = shiftAccum[static_cast<size_t>(s)] / totalBlend;
        float correctedMidi = framePitch + avgShift;
        float detectedHz    = midiToHz(framePitch);
        float correctedHz   = midiToHz(correctedMidi);
        if (detectedHz > 0.0f)
            ratios[static_cast<size_t>(s)] = juce::jlimit(0.25f, 4.0f, correctedHz / detectedHz);
    }

    return ratios;
}

std::vector<float> PitchResynthesizer::buildFormantCurve(
    int numSamples, double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes)
{
    // Check if any note has formant shift
    bool hasFormantShift = false;
    for (const auto& note : notes)
    {
        if (std::abs (note.formantShift) > 0.01f)
        {
            hasFormantShift = true;
            break;
        }
    }

    if (! hasFormantShift)
        return {}; // empty = no formant shifting needed

    std::vector<float> ratios (static_cast<size_t> (numSamples), 1.0f);

    for (const auto& note : notes)
    {
        if (std::abs (note.formantShift) < 0.01f)
            continue;

        int startSample = juce::jlimit (0, numSamples - 1, static_cast<int> (note.startTime * sampleRate));
        int endSample = juce::jlimit (0, numSamples - 1, static_cast<int> (note.endTime * sampleRate));

        float formantRatio = std::pow (2.0f, note.formantShift / 12.0f);

        // Smoothstep transition at note boundaries (15ms) to prevent clicks
        float transMs = 15.0f;
        float transSamples = transMs * 0.001f * static_cast<float> (sampleRate);

        for (int s = startSample; s <= endSample; ++s)
        {
            float blend = 1.0f;
            float distFromStart = static_cast<float> (s - startSample);
            float distFromEnd = static_cast<float> (endSample - s);

            if (distFromStart < transSamples)
            {
                float t = distFromStart / transSamples;
                blend = t * t * (3.0f - 2.0f * t);
            }
            if (distFromEnd < transSamples)
            {
                float t = distFromEnd / transSamples;
                blend = std::min (blend, t * t * (3.0f - 2.0f * t));
            }

            ratios[static_cast<size_t> (s)] = 1.0f + (formantRatio - 1.0f) * blend;
        }
    }

    return ratios;
}

std::vector<std::vector<float>> PitchResynthesizer::processMultiChannel(
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    PitchEngine engine)
{
    juce::ignoreUnused (engine); // Signalsmith is always used; engine param kept for API compat

    if (numSamples == 0 || numChannels == 0 || frames.empty())
    {
        std::vector<std::vector<float>> result (static_cast<size_t> (numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            result[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
        return result;
    }

    // Determine hop size from frame spacing
    int hopSize = 256;
    if (frames.size() >= 2)
    {
        float dt = frames[1].time - frames[0].time;
        hopSize = std::max (1, static_cast<int> (dt * sampleRate));
    }

    // Build per-sample pitch ratio curve and formant ratio curve
    auto ratios       = buildCorrectionCurve (numSamples, sampleRate, frames, notes, hopSize);
    auto formantRatios = buildFormantCurve (numSamples, sampleRate, notes);

    // Shift audio with Signalsmith Stretch (native stereo, formant-preserving)
    auto output = SignalsmithShifter::process (input, numChannels, numSamples, sampleRate,
                                               ratios, formantRatios);

    // Apply per-note gain adjustments (all channels)
    for (const auto& note : notes)
    {
        if (std::abs (note.gain) < 0.01f) continue;

        float gainLin   = std::pow (10.0f, note.gain / 20.0f);
        int startSample = juce::jlimit (0, numSamples - 1, static_cast<int> (note.startTime * sampleRate));
        int endSample   = juce::jlimit (0, numSamples - 1, static_cast<int> (note.endTime   * sampleRate));

        for (int ch = 0; ch < numChannels; ++ch)
            for (int s = startSample; s <= endSample; ++s)
                output[static_cast<size_t> (ch)][static_cast<size_t> (s)] *= gainLin;
    }

    return output;
}
