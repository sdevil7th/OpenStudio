#include "PitchResynthesizer.h"
#include "SignalsmithShifter.h"
#include <juce_core/juce_core.h>
#include <cmath>
#include <algorithm>
#include <cstring>
#include <limits>
#include <numeric>

#if JUCE_DEBUG
static constexpr bool kPitchEditorFormantDebugLogs = true;
#else
static constexpr bool kPitchEditorFormantDebugLogs = false;
#endif

static void logPitchEditorFormant(const juce::String& message)
{
    if (kPitchEditorFormantDebugLogs)
        juce::Logger::writeToLog ("[pitchEditor.formant] " + message);
}

static float midiToHz(float midi)
{
    return 440.0f * std::pow(2.0f, (midi - 69.0f) / 12.0f);
}

static float interpolateEnvelopeBin (const std::vector<float>& env, float sourceIndex)
{
    if (env.empty())
        return 1.0f;

    if (sourceIndex <= 0.0f)
        return env.front();

    const float lastIndex = static_cast<float> (env.size() - 1);
    if (sourceIndex >= lastIndex)
        return env.back();

    const auto lo = static_cast<size_t> (sourceIndex);
    const auto hi = std::min (env.size() - 1, lo + 1);
    const float frac = sourceIndex - static_cast<float> (lo);
    return env[lo] + (env[hi] - env[lo]) * frac;
}

static float smoothstep01 (float x)
{
    x = juce::jlimit (0.0f, 1.0f, x);
    return x * x * (3.0f - 2.0f * x);
}

static float mapRequestedFormantRatio (float requestedRatio)
{
    requestedRatio = juce::jlimit (0.25f, 4.0f, requestedRatio);
    if (requestedRatio >= 1.0f)
        return std::pow (requestedRatio, 1.10f);
    return std::pow (requestedRatio, 1.08f);
}

// ---------------------------------------------------------------------------
// Formant post-correction — second pass after Signalsmith Stretch.
//
// Uses log-domain moving average for spectral envelope estimation.
// No IFFT/FFT round-trip = no normalization ambiguity, guaranteed correct.
// Smoothing width adapts to detected pitch (3× fundamental spacing in bins).
//
// This is a RESIDUAL corrector: Signalsmith's built-in compensatePitch=true
// does first-pass correction; this catches what the library missed.
// ---------------------------------------------------------------------------
static void applyFormantPostCorrection (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios,
    const std::vector<float>& detectedPitchHz)
{
    const float ratioThreshold = 0.06f;
    bool hasShift = false;
    for (size_t i = 0; i < ratios.size() && ! hasShift; i += 256)
        if (std::abs (ratios[i] - 1.0f) > ratioThreshold) hasShift = true;
    if (! hasShift) return;

    const int fftOrder = 12;
    const int fftSize  = 1 << fftOrder;
    const int hopLen   = fftSize / 4;
    const int halfBins = fftSize / 2 + 1;
    const float pi     = juce::MathConstants<float>::pi;
    const float binHz  = static_cast<float> (sampleRate) / static_cast<float> (fftSize);

    juce::dsp::FFT fft (fftOrder);

    std::vector<float> hannWin (static_cast<size_t> (fftSize));
    for (int i = 0; i < fftSize; ++i)
        hannWin[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            2.0f * pi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));

    std::vector<float> origFFTBuf (static_cast<size_t> (fftSize * 2));
    std::vector<float> outFFTBuf  (static_cast<size_t> (fftSize * 2));
    std::vector<float> origLogMag (static_cast<size_t> (halfBins));
    std::vector<float> outLogMag  (static_cast<size_t> (halfBins));
    std::vector<float> origEnv    (static_cast<size_t> (halfBins));
    std::vector<float> outEnv     (static_cast<size_t> (halfBins));

    // Log-domain moving average spectral envelope estimation.
    // Smooths log magnitudes with a window of ~3× the fundamental frequency
    // spacing in bins. This averages over ~3 harmonics, yielding a smooth
    // formant envelope. Log domain = geometric mean, which follows formant
    // peaks without being pulled by individual harmonics.
    auto computeEnvelope = [&] (const float* fftBufData, int smoothHalfW,
                                 const std::vector<float>& logMag,
                                 std::vector<float>& env)
    {
        juce::ignoreUnused (fftBufData);
        for (int i = 0; i < halfBins; ++i)
        {
            int lo = std::max (0, i - smoothHalfW);
            int hi = std::min (halfBins - 1, i + smoothHalfW);
            float sum = 0.0f;
            for (int j = lo; j <= hi; ++j)
                sum += logMag[static_cast<size_t> (j)];
            env[static_cast<size_t> (i)] = std::exp (sum / static_cast<float> (hi - lo + 1));
        }
    };

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out         = output[static_cast<size_t> (ch)];
        const float* orig = originalInput[ch];

        std::vector<float> corrected (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> winSum    (static_cast<size_t> (numSamples), 0.0f);

        for (int pos = 0; pos < numSamples; pos += hopLen)
        {
            float avgRatio = 0.0f;
            int   cnt = 0;
            for (int i = pos; i < std::min (pos + fftSize, numSamples); ++i)
            {
                if (static_cast<size_t> (i) < ratios.size())
                {
                    avgRatio += ratios[static_cast<size_t> (i)];
                    ++cnt;
                }
            }
            avgRatio = (cnt > 0) ? avgRatio / static_cast<float> (cnt) : 1.0f;

            if (std::abs (avgRatio - 1.0f) <= ratioThreshold)
            {
                for (int i = 0; i < fftSize; ++i)
                {
                    int idx = pos + i;
                    if (idx >= 0 && idx < numSamples)
                    {
                        float w = hannWin[static_cast<size_t> (i)];
                        corrected[static_cast<size_t> (idx)] += out[static_cast<size_t> (idx)] * w;
                        winSum[static_cast<size_t> (idx)]    += w * w;
                    }
                }
                continue;
            }

            // Window and FFT both signals
            std::fill (origFFTBuf.begin(), origFFTBuf.end(), 0.0f);
            std::fill (outFFTBuf.begin(),  outFFTBuf.end(),  0.0f);
            for (int i = 0; i < fftSize; ++i)
            {
                int idx = pos + i;
                if (idx >= 0 && idx < numSamples)
                {
                    float w = hannWin[static_cast<size_t> (i)];
                    origFFTBuf[static_cast<size_t> (i)] = orig[idx] * w;
                    outFFTBuf[static_cast<size_t> (i)]  = out[static_cast<size_t> (idx)] * w;
                }
            }
            fft.performRealOnlyForwardTransform (origFFTBuf.data(), true);
            fft.performRealOnlyForwardTransform (outFFTBuf.data(), true);

            // Compute log magnitudes
            for (int i = 0; i < halfBins; ++i)
            {
                float ore = origFFTBuf[static_cast<size_t> (i * 2)];
                float oim = origFFTBuf[static_cast<size_t> (i * 2 + 1)];
                origLogMag[static_cast<size_t> (i)] = std::log (std::sqrt (ore * ore + oim * oim) + 1e-10f);

                float sre = outFFTBuf[static_cast<size_t> (i * 2)];
                float sim = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                outLogMag[static_cast<size_t> (i)] = std::log (std::sqrt (sre * sre + sim * sim) + 1e-10f);
            }

            // Adaptive smoothing width: ~3× fundamental spacing in bins.
            // For 200Hz voice at 44.1kHz/4096: 200/10.77 ≈ 18.6 bins, 3× = 56 bins half-width ~28
            float avgPitch = 0.0f;
            int pitchCnt = 0;
            if (! detectedPitchHz.empty())
            {
                for (int i = pos; i < std::min (pos + fftSize, numSamples); ++i)
                    if (static_cast<size_t> (i) < detectedPitchHz.size()
                        && detectedPitchHz[static_cast<size_t> (i)] > 0.0f)
                    {
                        avgPitch += detectedPitchHz[static_cast<size_t> (i)];
                        ++pitchCnt;
                    }
                if (pitchCnt > 0) avgPitch /= static_cast<float> (pitchCnt);
            }
            // Smoothing width: 5× fundamental spacing in bins.
            // Wide enough to average over ~5 harmonics → captures only the
            // broad formant shape, never follows individual harmonic peaks.
            // This is critical: if the envelope tracks harmonics, the correction
            // cuts/boosts harmonics individually → artificial sound.
            int smoothHalfW;
            if (avgPitch > 50.0f)
                smoothHalfW = std::max (15, static_cast<int> (2.5f * avgPitch / binHz));
            else
                smoothHalfW = 50; // fallback: ~540Hz at 44.1kHz/4096
            smoothHalfW = std::min (smoothHalfW, halfBins / 3);

            computeEnvelope (origFFTBuf.data(), smoothHalfW, origLogMag, origEnv);
            computeEnvelope (outFFTBuf.data(),  smoothHalfW, outLogMag,  outEnv);

            // Correction strength — gentle residual on top of library's first pass.
            // Kept moderate to avoid destroying harmonics.
            float shiftMag    = std::abs (avgRatio - 1.0f);
            float maxStrength = (avgRatio < 1.0f) ? 0.75f : 0.55f;
            float strength    = juce::jlimit (0.0f, maxStrength,
                                              (shiftMag - ratioThreshold) * 2.5f);

            // Measure energy before correction
            float energyBefore = 0.0f;
            for (int i = 0; i < halfBins; ++i)
            {
                float re = outFFTBuf[static_cast<size_t> (i * 2)];
                float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyBefore += re * re + im * im;
            }

            // Apply spectral envelope correction
            for (int i = 0; i < halfBins; ++i)
            {
                float gain = std::pow (origEnv[static_cast<size_t> (i)]
                                     / (outEnv[static_cast<size_t> (i)] + 1e-10f), strength);
                gain = juce::jlimit (0.5f, 2.0f, gain); // ±6dB max — reshape, never remove harmonics
                outFFTBuf[static_cast<size_t> (i * 2)]     *= gain;
                outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= gain;
            }

            // Preserve total spectral energy
            float energyAfter = 0.0f;
            for (int i = 0; i < halfBins; ++i)
            {
                float re = outFFTBuf[static_cast<size_t> (i * 2)];
                float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyAfter += re * re + im * im;
            }
            if (energyAfter > 1e-10f)
            {
                float scale = std::sqrt (energyBefore / energyAfter);
                for (int i = 0; i < halfBins; ++i)
                {
                    outFFTBuf[static_cast<size_t> (i * 2)]     *= scale;
                    outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= scale;
                }
            }

            fft.performRealOnlyInverseTransform (outFFTBuf.data());

            for (int i = 0; i < fftSize; ++i)
            {
                int idx = pos + i;
                if (idx >= 0 && idx < numSamples)
                {
                    float w = hannWin[static_cast<size_t> (i)];
                    corrected[static_cast<size_t> (idx)] += outFFTBuf[static_cast<size_t> (i)] * w;
                    winSum[static_cast<size_t> (idx)]    += w * w;
                }
            }
        }

        for (int s = 0; s < numSamples; ++s)
        {
            if (winSum[static_cast<size_t> (s)] > 0.001f)
                out[static_cast<size_t> (s)] = corrected[static_cast<size_t> (s)]
                                             / winSum[static_cast<size_t> (s)];
        }
    }
}

static void applyExplicitFormantWarp (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& formantRatios,
    const std::vector<float>& detectedPitchHz,
    float warpIntensity,
    bool formantOnly,
    PitchResynthesizer::RenderQuality renderQuality,
    std::function<bool()> shouldCancel)
{
    const bool previewFast = renderQuality == PitchResynthesizer::RenderQuality::PreviewFast;
    const float ratioThreshold = 0.03f;
    bool hasShift = false;
    float requestedMinRatio = 1.0f;
    float requestedMaxRatio = 1.0f;

    for (size_t i = 0; i < formantRatios.size(); i += 256)
    {
        const float ratio = formantRatios[i];
        requestedMinRatio = std::min (requestedMinRatio, ratio);
        requestedMaxRatio = std::max (requestedMaxRatio, ratio);
        if (std::abs (ratio - 1.0f) > ratioThreshold)
            hasShift = true;
    }

    if (! hasShift)
        return;

    const int fftOrder = formantOnly
        ? (previewFast ? 10 : 11)
        : (previewFast ? 11 : 12);
    const int fftSize  = 1 << fftOrder;
    const int hopLen   = previewFast ? (fftSize / 2) : (fftSize / 4);
    const int halfBins = fftSize / 2 + 1;
    const float pi     = juce::MathConstants<float>::pi;
    const float binHz  = static_cast<float> (sampleRate) / static_cast<float> (fftSize);

    juce::dsp::FFT fft (fftOrder);

    std::vector<float> hannWin (static_cast<size_t> (fftSize));
    for (int i = 0; i < fftSize; ++i)
        hannWin[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            2.0f * pi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));

    std::vector<float> origFFTBuf (static_cast<size_t> (fftSize * 2));
    std::vector<float> outFFTBuf  (static_cast<size_t> (fftSize * 2));
    std::vector<float> preWarpFFTBuf (static_cast<size_t> (fftSize * 2));
    std::vector<float> origLogMag (static_cast<size_t> (halfBins));
    std::vector<float> outLogMag  (static_cast<size_t> (halfBins));
    std::vector<float> origEnv    (static_cast<size_t> (halfBins));
    std::vector<float> outEnv     (static_cast<size_t> (halfBins));
    std::vector<float> targetEnv  (static_cast<size_t> (halfBins));

    auto computeEnvelope = [&] (const std::vector<float>& logMag,
                                int smoothHalfW,
                                std::vector<float>& env)
    {
        for (int i = 0; i < halfBins; ++i)
        {
            const int lo = std::max (0, i - smoothHalfW);
            const int hi = std::min (halfBins - 1, i + smoothHalfW);
            float sum = 0.0f;
            for (int j = lo; j <= hi; ++j)
                sum += logMag[static_cast<size_t> (j)];
            env[static_cast<size_t> (i)] = std::exp (sum / static_cast<float> (hi - lo + 1));
        }
    };

    int shiftedBlocks = 0;
    float appliedMinRatio = std::numeric_limits<float>::max();
    float appliedMaxRatio = 0.0f;
    float avgVoicedBlendApplied = 0.0f;
    float minSmoothedVoicedBlend = std::numeric_limits<float>::max();
    float maxSmoothedVoicedBlend = 0.0f;
    float minEffectiveStrength = std::numeric_limits<float>::max();
    float maxEffectiveStrength = 0.0f;
    float totalEnvelopeDeltaBefore = 0.0f;
    float totalEnvelopeDeltaAfter = 0.0f;
    int totalEnvelopeDeltaBins = 0;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = output[static_cast<size_t> (ch)];
        const float* orig = originalInput[ch];

        std::vector<float> corrected (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> winSum    (static_cast<size_t> (numSamples), 0.0f);
        float prevVoicedBlend = 0.0f;
        float prevStrength = 0.0f;
        float prevOriginalBlend = 0.0f;

        for (int pos = 0; pos < numSamples; pos += hopLen)
        {
            if (shouldCancel && shouldCancel())
                return;
            float avgFormantRatio = 0.0f;
            int ratioCount = 0;
            float frameEnergy = 0.0f;
            int frameSamples = 0;
            for (int i = pos; i < std::min (pos + fftSize, numSamples); ++i)
            {
                if (static_cast<size_t> (i) < formantRatios.size())
                {
                    avgFormantRatio += formantRatios[static_cast<size_t> (i)];
                    ++ratioCount;
                }
                const float sample = orig[i];
                frameEnergy += sample * sample;
                ++frameSamples;
            }
            avgFormantRatio = ratioCount > 0 ? avgFormantRatio / static_cast<float> (ratioCount) : 1.0f;
            const float frameRms = frameSamples > 0 ? std::sqrt (frameEnergy / static_cast<float> (frameSamples)) : 0.0f;

            if (std::abs (avgFormantRatio - 1.0f) <= ratioThreshold)
            {
                for (int i = 0; i < fftSize; ++i)
                {
                    const int idx = pos + i;
                    if (idx >= 0 && idx < numSamples)
                    {
                        const float w = hannWin[static_cast<size_t> (i)];
                        corrected[static_cast<size_t> (idx)] += out[static_cast<size_t> (idx)] * w;
                        winSum[static_cast<size_t> (idx)] += w * w;
                    }
                }
                continue;
            }

            ++shiftedBlocks;

            std::fill (origFFTBuf.begin(), origFFTBuf.end(), 0.0f);
            std::fill (outFFTBuf.begin(), outFFTBuf.end(), 0.0f);
            for (int i = 0; i < fftSize; ++i)
            {
                const int idx = pos + i;
                if (idx >= 0 && idx < numSamples)
                {
                    const float w = hannWin[static_cast<size_t> (i)];
                    origFFTBuf[static_cast<size_t> (i)] = orig[idx] * w;
                    outFFTBuf[static_cast<size_t> (i)] = out[static_cast<size_t> (idx)] * w;
                }
            }

            fft.performRealOnlyForwardTransform (origFFTBuf.data(), true);
            fft.performRealOnlyForwardTransform (outFFTBuf.data(), true);
            std::copy (outFFTBuf.begin(), outFFTBuf.end(), preWarpFFTBuf.begin());

            for (int i = 0; i < halfBins; ++i)
            {
                const float ore = origFFTBuf[static_cast<size_t> (i * 2)];
                const float oim = origFFTBuf[static_cast<size_t> (i * 2 + 1)];
                origLogMag[static_cast<size_t> (i)] = std::log (std::sqrt (ore * ore + oim * oim) + 1e-10f);

                const float sre = outFFTBuf[static_cast<size_t> (i * 2)];
                const float sim = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                outLogMag[static_cast<size_t> (i)] = std::log (std::sqrt (sre * sre + sim * sim) + 1e-10f);
            }

            float avgPitch = 0.0f;
            int pitchCount = 0;
            int voicedSamples = 0;
            if (! detectedPitchHz.empty())
            {
                for (int i = pos; i < std::min (pos + fftSize, numSamples); ++i)
                {
                    if (static_cast<size_t> (i) < detectedPitchHz.size()
                        && detectedPitchHz[static_cast<size_t> (i)] > 0.0f)
                    {
                        avgPitch += detectedPitchHz[static_cast<size_t> (i)];
                        ++pitchCount;
                        ++voicedSamples;
                    }
                }
                if (pitchCount > 0)
                    avgPitch /= static_cast<float> (pitchCount);
            }

            const float rawVoicedBlend = smoothstep01 (static_cast<float> (voicedSamples)
                                                      / static_cast<float> (std::max (1, std::min (fftSize, numSamples - pos)))
                                                      * (formantOnly ? 1.48f : 1.36f));
            const float voicedBlend = (pos == 0)
                ? rawVoicedBlend
                : ((formantOnly ? 0.82f : 0.76f) * prevVoicedBlend
                    + (formantOnly ? 0.18f : 0.24f) * rawVoicedBlend);
            prevVoicedBlend = voicedBlend;
            avgVoicedBlendApplied += voicedBlend;
            minSmoothedVoicedBlend = std::min (minSmoothedVoicedBlend, voicedBlend);
            maxSmoothedVoicedBlend = std::max (maxSmoothedVoicedBlend, voicedBlend);

            int smoothHalfW;
            if (avgPitch > 50.0f)
                smoothHalfW = std::max (previewFast ? (formantOnly ? 10 : 12) : (formantOnly ? 14 : 16),
                                        static_cast<int> ((formantOnly ? (previewFast ? 1.35f : 1.75f) : (previewFast ? 1.85f : 2.45f)) * avgPitch / binHz));
            else
                smoothHalfW = previewFast ? (formantOnly ? 24 : 30) : (formantOnly ? 36 : 50);
            smoothHalfW = std::min (smoothHalfW, halfBins / 3);

            computeEnvelope (origLogMag, smoothHalfW, origEnv);
            computeEnvelope (outLogMag, smoothHalfW, outEnv);

            const float effectiveShiftSemitones = std::abs (12.0f * std::log2 (std::max (avgFormantRatio, 1.0e-4f)));
            const float bassFocus = formantOnly && avgPitch > 0.0f
                ? smoothstep01 ((195.0f - avgPitch) / 110.0f)
                : 0.0f;
            const float lowRegisterBoost = formantOnly && avgPitch > 0.0f
                ? (1.0f + (previewFast ? 0.24f : 0.34f) * bassFocus)
                : 1.0f;
            const float voicedStrengthBias = formantOnly
                ? (0.48f + 0.52f * voicedBlend)
                : (0.28f + 0.72f * voicedBlend);
            const float rawStrength = juce::jlimit (0.0f, formantOnly ? (previewFast ? 1.38f : 1.58f) : (previewFast ? 1.15f : 1.42f),
                                                    (0.76f + effectiveShiftSemitones * 0.20f)
                                                        * voicedStrengthBias * warpIntensity * lowRegisterBoost);
            const float strength = (pos == 0)
                ? rawStrength
                : ((formantOnly ? 0.78f : 0.72f) * prevStrength
                    + (formantOnly ? 0.22f : 0.28f) * rawStrength);
            prevStrength = strength;
            minEffectiveStrength = std::min (minEffectiveStrength, strength);
            maxEffectiveStrength = std::max (maxEffectiveStrength, strength);
            appliedMinRatio = std::min (appliedMinRatio, avgFormantRatio);
            appliedMaxRatio = std::max (appliedMaxRatio, avgFormantRatio);

            float energyBefore = 0.0f;
            for (int i = 0; i < halfBins; ++i)
            {
                const float re = outFFTBuf[static_cast<size_t> (i * 2)];
                const float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyBefore += re * re + im * im;
            }

            for (int i = 0; i < halfBins; ++i)
            {
                const float freqHz = static_cast<float> (i) * binHz;
                const float lowAnchor = std::max (formantOnly ? 65.0f : 90.0f, avgPitch > 0.0f ? avgPitch * (formantOnly ? 0.78f : 0.95f) : (formantOnly ? 90.0f : 120.0f));
                const float lowFull = std::max (formantOnly ? 220.0f : 320.0f, avgPitch > 0.0f ? avgPitch * (formantOnly ? 1.65f : 2.15f) : (formantOnly ? 300.0f : 430.0f));
                const float lowBandBase = formantOnly
                    ? (0.58f + 0.12f * bassFocus)
                    : 0.30f;
                const float lowBandLift = formantOnly
                    ? (0.42f - 0.10f * bassFocus)
                    : 0.70f;
                const float lowBandWeight = lowBandBase + lowBandLift
                    * smoothstep01 ((freqHz - lowAnchor) / std::max (45.0f, lowFull - lowAnchor));
                const float detailProtect = smoothstep01 ((freqHz - 3400.0f) / 2200.0f);
                const float airProtection = 1.0f - (formantOnly ? 0.16f : 0.28f)
                    * smoothstep01 ((freqHz - 5200.0f) / 2600.0f);
                const float perBinWeight = juce::jlimit (0.0f, 1.0f, voicedStrengthBias * lowBandWeight * airProtection);

                targetEnv[static_cast<size_t> (i)] = interpolateEnvelopeBin (
                    origEnv, static_cast<float> (i) / avgFormantRatio);

                const float targetBlend = juce::jlimit (0.0f, 1.10f,
                    perBinWeight * (formantOnly ? (previewFast ? 1.06f : 1.10f) : 1.02f));
                const float blendedTargetEnv = outEnv[static_cast<size_t> (i)]
                    + (targetEnv[static_cast<size_t> (i)] - outEnv[static_cast<size_t> (i)])
                        * targetBlend;
                const float sourceEnv = outEnv[static_cast<size_t> (i)] + 1.0e-10f;
                const float targetValue = blendedTargetEnv + 1.0e-10f;
                totalEnvelopeDeltaBefore += std::abs (std::log (targetValue / sourceEnv));

                float gain = std::pow (targetValue / sourceEnv,
                                       strength);
                float minGain = juce::jmap (voicedBlend, 0.0f, 1.0f,
                    detailProtect > 0.25f ? 0.84f : 0.72f,
                    detailProtect > 0.25f ? 0.68f : (previewFast ? 0.56f : 0.46f));
                float maxGain = juce::jmap (voicedBlend, 0.0f, 1.0f,
                    detailProtect > 0.25f ? 1.20f : 1.55f,
                    detailProtect > 0.25f ? 1.54f : (previewFast ? 2.05f : 2.45f));
                if (formantOnly && bassFocus > 0.0f && freqHz < std::max (420.0f, avgPitch > 0.0f ? avgPitch * 3.1f : 420.0f))
                    maxGain *= (1.0f + 0.16f * bassFocus);
                gain = juce::jlimit (minGain, maxGain, gain);
                totalEnvelopeDeltaAfter += std::abs (std::log (targetValue / (sourceEnv * gain)));
                ++totalEnvelopeDeltaBins;
                outFFTBuf[static_cast<size_t> (i * 2)] *= gain;
                outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= gain;
            }

            float energyAfter = 0.0f;
            for (int i = 0; i < halfBins; ++i)
            {
                const float re = outFFTBuf[static_cast<size_t> (i * 2)];
                const float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyAfter += re * re + im * im;
            }
            if (energyAfter > 1.0e-10f)
            {
                const float energyRatio = energyBefore / energyAfter;
                const float scale = std::pow (energyRatio, formantOnly ? 0.24f : 0.24f);
                for (int i = 0; i < halfBins; ++i)
                {
                    outFFTBuf[static_cast<size_t> (i * 2)] *= scale;
                    outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= scale;
                }
            }

            for (int i = 0; i < halfBins; ++i)
            {
                const float freqHz = static_cast<float> (i) * binHz;
                const float detailProtect = smoothstep01 ((freqHz - 3200.0f) / 2000.0f);
                const float detailKeep = juce::jlimit (0.0f, 0.72f,
                    detailProtect * (0.20f
                        + 0.46f * (1.0f - voicedBlend)
                        + 0.18f * smoothstep01 ((0.028f - frameRms) / 0.018f)));
                if (detailKeep <= 0.001f)
                    continue;
                outFFTBuf[static_cast<size_t> (i * 2)] =
                    outFFTBuf[static_cast<size_t> (i * 2)] * (1.0f - detailKeep)
                    + preWarpFFTBuf[static_cast<size_t> (i * 2)] * detailKeep;
                outFFTBuf[static_cast<size_t> (i * 2 + 1)] =
                    outFFTBuf[static_cast<size_t> (i * 2 + 1)] * (1.0f - detailKeep)
                    + preWarpFFTBuf[static_cast<size_t> (i * 2 + 1)] * detailKeep;
            }

            fft.performRealOnlyInverseTransform (outFFTBuf.data());

            const float rawOriginalBlend = formantOnly
                ? juce::jlimit (0.10f, 0.50f,
                                0.10f
                                    + (1.0f - voicedBlend) * 0.24f
                                    + smoothstep01 ((0.032f - frameRms) / 0.020f) * 0.14f)
                : 0.0f;
            const float originalBlend = (pos == 0)
                ? rawOriginalBlend
                : (0.82f * prevOriginalBlend + 0.18f * rawOriginalBlend);
            prevOriginalBlend = originalBlend;

            for (int i = 0; i < fftSize; ++i)
            {
                const int idx = pos + i;
                if (idx >= 0 && idx < numSamples)
                {
                    const float w = hannWin[static_cast<size_t> (i)];
                    const float processedSample = outFFTBuf[static_cast<size_t> (i)] * (1.0f - originalBlend)
                        + orig[idx] * originalBlend;
                    corrected[static_cast<size_t> (idx)] += processedSample * w;
                    winSum[static_cast<size_t> (idx)] += w * w;
                }
            }
        }

        for (int s = 0; s < numSamples; ++s)
        {
            if (winSum[static_cast<size_t> (s)] > 0.001f)
                out[static_cast<size_t> (s)] = corrected[static_cast<size_t> (s)]
                                             / winSum[static_cast<size_t> (s)];
        }
    }

    logPitchEditorFormant ("explicit formant warp blocks=" + juce::String (shiftedBlocks)
        + " requestedRatio=[" + juce::String (requestedMinRatio, 3) + "," + juce::String (requestedMaxRatio, 3) + "]"
        + " appliedRatio=[" + juce::String (appliedMinRatio == std::numeric_limits<float>::max() ? 1.0f : appliedMinRatio, 3)
        + "," + juce::String (appliedMaxRatio, 3) + "]"
        + " avgVoicedBlend=" + juce::String (shiftedBlocks > 0 ? avgVoicedBlendApplied / static_cast<float> (shiftedBlocks) : 0.0f, 3)
        + " voicedBlendRange=[" + juce::String (minSmoothedVoicedBlend == std::numeric_limits<float>::max() ? 0.0f : minSmoothedVoicedBlend, 3)
        + "," + juce::String (maxSmoothedVoicedBlend, 3) + "]"
        + " strengthRange=[" + juce::String (minEffectiveStrength == std::numeric_limits<float>::max() ? 0.0f : minEffectiveStrength, 3)
        + "," + juce::String (maxEffectiveStrength, 3) + "]"
        + " warpIntensity=" + juce::String (warpIntensity, 3)
        + " renderQuality=" + juce::String (previewFast ? "preview_fast" : "final_hq")
        + " mode=" + juce::String (formantOnly ? "formant-only" : "mixed")
        + " envDeltaBefore=" + juce::String (totalEnvelopeDeltaBins > 0 ? totalEnvelopeDeltaBefore / static_cast<float> (totalEnvelopeDeltaBins) : 0.0f, 4)
        + " envDeltaAfter=" + juce::String (totalEnvelopeDeltaBins > 0 ? totalEnvelopeDeltaAfter / static_cast<float> (totalEnvelopeDeltaBins) : 0.0f, 4));
}

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

    // frames[0] may start before sample 0 (window-relative time < 0) because
    // AudioEngine includes up to 0.5s of pre-window frames for context.
    // All frameIdx computations must account for this offset, otherwise every
    // lookup is shifted ~0.5s earlier — landing in unvoiced/silent territory
    // and causing all pitch corrections to be silently skipped (ratio = 1.0).
    const int firstFrameSample = static_cast<int>(
        std::round(static_cast<double>(frames[0].time) * sampleRate));

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
            int noteStartFrame = juce::jlimit(0, static_cast<int>(frames.size()) - 1,
                                              (startSample - firstFrameSample) / hopSize);
            int noteEndFrame   = juce::jlimit(0, static_cast<int>(frames.size()) - 1,
                                              (endSample   - firstFrameSample) / hopSize);
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
        int noteBodyStartFrame = juce::jlimit(0, static_cast<int>(frames.size()) - 1,
                                              (startSample - firstFrameSample) / hopSize);
        int noteBodyEndFrame   = juce::jlimit(0, static_cast<int>(frames.size()) - 1,
                                              (endSample   - firstFrameSample) / hopSize);
        int noteFrameCount = noteBodyEndFrame - noteBodyStartFrame + 1;

        for (int s = loopStart; s <= loopEnd; ++s)
        {
            int frameIdx = (s - firstFrameSample) / hopSize;
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

        int frameIdx = (s - firstFrameSample) / hopSize;
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
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    float globalFormantSemitones)
{
    // Check if any note has formant shift
    bool hasFormantShift = std::abs (globalFormantSemitones) > 0.01f;
    int noteLocalSampleCount = 0;
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

    const float globalRatio = mapRequestedFormantRatio (std::pow (2.0f, globalFormantSemitones / 12.0f));
    std::vector<float> ratios (static_cast<size_t> (numSamples), globalRatio);

    for (const auto& note : notes)
    {
        if (std::abs (note.formantShift) < 0.01f)
            continue;

        int startSample = juce::jlimit (0, numSamples - 1, static_cast<int> (note.startTime * sampleRate));
        int endSample = juce::jlimit (0, numSamples - 1, static_cast<int> (note.endTime * sampleRate));

        float formantRatio = mapRequestedFormantRatio (std::pow (2.0f, note.formantShift / 12.0f));

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

            ratios[static_cast<size_t> (s)] = globalRatio * (1.0f + (formantRatio - 1.0f) * blend);
            ++noteLocalSampleCount;
        }
    }

    if (kPitchEditorFormantDebugLogs)
    {
        float minRatio = ratios.front();
        float maxRatio = ratios.front();
        for (const auto ratio : ratios)
        {
            minRatio = std::min (minRatio, ratio);
            maxRatio = std::max (maxRatio, ratio);
        }
        logPitchEditorFormant ("buildFormantCurve globalSt=" + juce::String (globalFormantSemitones, 3)
            + " globalRatio=" + juce::String (globalRatio, 3)
            + " minRatio=" + juce::String (minRatio, 3)
            + " maxRatio=" + juce::String (maxRatio, 3)
            + " noteLocalSamples=" + juce::String (noteLocalSampleCount)
            + " totalSamples=" + juce::String (numSamples));
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
    PitchEngine engine,
    float globalFormantSemitones,
    RenderQuality renderQuality,
    std::function<bool()> shouldCancel)
{
    juce::ignoreUnused (engine); // Signalsmith is always used; engine param kept for API compat

    enum class ProcessingMode
    {
        PitchOnly,
        FormantOnly,
        PitchPlusFormant
    };

    const bool hasExplicitFormant = std::abs (globalFormantSemitones) > 0.01f
        || std::any_of (notes.begin(), notes.end(), [] (const auto& note) { return std::abs (note.formantShift) > 0.01f; });

    if (numSamples == 0 || numChannels == 0 || (frames.empty() && ! hasExplicitFormant))
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
    auto formantRatios = buildFormantCurve (numSamples, sampleRate, notes, globalFormantSemitones);
    bool hasPitchShift = false;
    for (size_t i = 0; i < ratios.size() && ! hasPitchShift; i += 256)
        hasPitchShift = std::abs (ratios[i] - 1.0f) > 0.001f;

    ProcessingMode processingMode = ProcessingMode::PitchOnly;
    if (! formantRatios.empty())
        processingMode = hasPitchShift ? ProcessingMode::PitchPlusFormant : ProcessingMode::FormantOnly;

    const auto processingModeName = [&]() -> const char*
    {
        switch (processingMode)
        {
            case ProcessingMode::PitchOnly:      return "pitch_only";
            case ProcessingMode::FormantOnly:    return "formant_only";
            case ProcessingMode::PitchPlusFormant:return "pitch_plus_formant";
        }
        return "unknown";
    };

    logPitchEditorFormant ("processMultiChannel samples=" + juce::String (numSamples)
        + " channels=" + juce::String (numChannels)
        + " globalFormantSt=" + juce::String (globalFormantSemitones, 3)
        + " formantCurve=" + juce::String (formantRatios.empty() ? "disabled" : "enabled")
        + " pitchShift=" + juce::String (hasPitchShift ? "true" : "false")
        + " mode=" + juce::String (processingModeName())
        + " renderQuality=" + juce::String (renderQuality == RenderQuality::PreviewFast ? "preview_fast" : "final_hq"));

    // Build per-sample detected pitch in Hz only for explicit-formant processing.
    std::vector<float> detectedPitchHz;
    if (processingMode != ProcessingMode::PitchOnly)
    {
        detectedPitchHz.assign (static_cast<size_t> (numSamples), 0.0f);
        for (size_t fi = 0; fi < frames.size(); ++fi)
        {
            const auto& f = frames[fi];
            if (f.frequency <= 0.0f) continue;
            int sampleStart = static_cast<int> (f.time * sampleRate);
            int sampleEnd   = std::min (numSamples, sampleStart + hopSize);
            for (int s = std::max (0, sampleStart); s < sampleEnd; ++s)
                detectedPitchHz[static_cast<size_t> (s)] = f.frequency;
        }
    }

    std::vector<std::vector<float>> output (static_cast<size_t> (numChannels));
    switch (processingMode)
    {
        case ProcessingMode::PitchOnly:
        {
            if (shouldCancel && shouldCancel())
                return output;
            output = SignalsmithShifter::process (input, numChannels, numSamples, sampleRate, ratios);
            logPitchEditorFormant ("using legacy pitch-only shifter path");
            break;
        }
        case ProcessingMode::FormantOnly:
        {
            for (int ch = 0; ch < numChannels; ++ch)
                output[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
            logPitchEditorFormant ("skipping Signalsmith pitch shifter for formant-only render");
            break;
        }
        case ProcessingMode::PitchPlusFormant:
        {
            if (shouldCancel && shouldCancel())
                return output;
            output = SignalsmithShifter::process (input, numChannels, numSamples, sampleRate,
                                                  ratios, formantRatios, detectedPitchHz);
            logPitchEditorFormant ("using preserved-timbre pitch base with explicit formant overlay");
            break;
        }
    }

    const bool formantOnlyRender = processingMode == ProcessingMode::FormantOnly;

    // Keep pitch-only edits on the old stable base path.
    // The residual post-correction pass was previously disabled because it
    // introduced artifacts; bringing it back is a likely source of the
    // crackle/dropouts heard on plain note shifts. Let Signalsmith's base
    // formant preservation handle pitch-only edits, and reserve the explicit
    // warp stage for actual user-requested formant changes.
    if (processingMode != ProcessingMode::PitchOnly)
    {
        logPitchEditorFormant ("applying explicit formant warp stage");
        applyExplicitFormantWarp (output, input, numChannels, numSamples,
                                  sampleRate, formantRatios, detectedPitchHz,
                                  formantOnlyRender
                                      ? (renderQuality == RenderQuality::PreviewFast ? 0.92f : 1.32f)
                                      : (renderQuality == RenderQuality::PreviewFast ? 0.98f : 1.10f),
                                  formantOnlyRender,
                                  renderQuality,
                                  shouldCancel);
    }
    else if (hasPitchShift)
    {
        logPitchEditorFormant ("pitch-only render kept on preserved-timbre base path");
    }

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
