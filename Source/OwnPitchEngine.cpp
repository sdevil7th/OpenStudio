#include "OwnPitchEngine.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <numeric>
#include <optional>

namespace
{
static bool shouldEnableOwnPitchEngineLogs()
{
#if JUCE_DEBUG
    return true;
#else
    return juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_DEBUG", {}).trim() == "1";
#endif
}

static void logOwnPitchEngine (const juce::String& message)
{
    if (shouldEnableOwnPitchEngineLogs())
        juce::Logger::writeToLog ("[pitchEditor.ownEngine] " + message);
}

static bool isHybridStructuralBranchRequested();

static float getEnvFloat (const char* name, float fallback)
{
    const auto value = juce::SystemStats::getEnvironmentVariable (name, {}).trim();
    if (value.isEmpty())
        return fallback;
    const float parsed = value.getFloatValue();
    return std::isfinite (parsed) ? parsed : fallback;
}

static juce::File getVsfLayerDumpDirectory()
{
    auto path = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_VSF_LAYER_DUMP_DIR", {}).trim();
    if (path.isEmpty())
        path = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_LAYER_DUMP_DIR", {}).trim();
    return path.isEmpty() ? juce::File() : juce::File (path);
}

static bool writeOwnPitchLayerDumpWav (
    const juce::File& directory,
    const juce::String& name,
    const std::vector<std::vector<float>>& channels,
    double sampleRate)
{
    if (directory == juce::File() || channels.empty() || sampleRate <= 0.0)
        return false;

    const int numChannels = static_cast<int> (channels.size());
    const int numSamples = static_cast<int> (channels.front().size());
    if (numChannels <= 0 || numSamples <= 0)
        return false;

    directory.createDirectory();
    const auto file = directory.getChildFile (name + ".wav");
    file.deleteFile();

    juce::AudioBuffer<float> buffer (numChannels, numSamples);
    buffer.clear();
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (channels[static_cast<size_t> (ch)].empty())
            continue;
        const int copyCount = std::min (numSamples, static_cast<int> (channels[static_cast<size_t> (ch)].size()));
        buffer.copyFrom (ch, 0, channels[static_cast<size_t> (ch)].data(), copyCount);
    }

    juce::WavAudioFormat format;
    std::unique_ptr<juce::FileOutputStream> stream (file.createOutputStream());
    if (stream == nullptr)
        return false;

    std::unique_ptr<juce::AudioFormatWriter> writer (
        format.createWriterFor (stream.get(), sampleRate, static_cast<unsigned int> (numChannels), 24, {}, 0));
    if (writer == nullptr)
        return false;

    stream.release();
    return writer->writeFromAudioSampleBuffer (buffer, 0, numSamples);
}

static float smoothstep01 (float x)
{
    x = juce::jlimit (0.0f, 1.0f, x);
    return x * x * (3.0f - 2.0f * x);
}

static float equalPowerFadeIn (float x)
{
    x = juce::jlimit (0.0f, 1.0f, x);
    return std::sin (0.5f * juce::MathConstants<float>::pi * x);
}

static float equalPowerFadeOut (float x)
{
    x = juce::jlimit (0.0f, 1.0f, x);
    return std::cos (0.5f * juce::MathConstants<float>::pi * x);
}

static void applyPeakingEqToRange (
    std::vector<float>& signal,
    int startSample,
    int endSample,
    double sampleRate,
    float centreHz,
    float q,
    float gainDb,
    int fadeSamples)
{
    if (signal.empty() || sampleRate <= 0.0 || centreHz <= 0.0f || q <= 0.0f)
        return;

    startSample = juce::jlimit (0, static_cast<int> (signal.size()), startSample);
    endSample = juce::jlimit (startSample, static_cast<int> (signal.size()), endSample);
    const int count = endSample - startSample;
    if (count <= 2)
        return;

    const double a = std::pow (10.0, static_cast<double> (gainDb) / 40.0);
    const double omega = juce::MathConstants<double>::twoPi * static_cast<double> (centreHz) / sampleRate;
    const double alpha = std::sin (omega) / (2.0 * static_cast<double> (q));
    const double cosine = std::cos (omega);

    double b0 = 1.0 + alpha * a;
    double b1 = -2.0 * cosine;
    double b2 = 1.0 - alpha * a;
    const double a0 = 1.0 + alpha / a;
    double a1 = -2.0 * cosine;
    double a2 = 1.0 - alpha / a;

    b0 /= a0;
    b1 /= a0;
    b2 /= a0;
    a1 /= a0;
    a2 /= a0;

    fadeSamples = juce::jlimit (1, std::max (1, count / 2), fadeSamples);
    double z1 = 0.0;
    double z2 = 0.0;
    for (int i = 0; i < count; ++i)
    {
        const int sampleIndex = startSample + i;
        const double inputSample = static_cast<double> (signal[static_cast<size_t> (sampleIndex)]);
        const double filtered = b0 * inputSample + z1;
        z1 = b1 * inputSample - a1 * filtered + z2;
        z2 = b2 * inputSample - a2 * filtered;

        float fade = 1.0f;
        if (i < fadeSamples)
            fade *= equalPowerFadeIn (static_cast<float> (i) / static_cast<float> (fadeSamples));
        if (i >= count - fadeSamples)
            fade *= equalPowerFadeOut (static_cast<float> (i - (count - fadeSamples)) / static_cast<float> (fadeSamples));

        const float original = signal[static_cast<size_t> (sampleIndex)];
        signal[static_cast<size_t> (sampleIndex)] = original * (1.0f - fade) + static_cast<float> (filtered) * fade;
    }
}

static float getEffectiveNoteStartTime (const PitchAnalyzer::PitchNote& note)
{
    return std::min (note.startTime, note.effectiveStartTime);
}

static float getEffectiveNoteEndTime (const PitchAnalyzer::PitchNote& note)
{
    return std::max (note.endTime, note.effectiveEndTime);
}

static bool hasPitchStyleEdit (const PitchAnalyzer::PitchNote& note)
{
    if (std::abs (note.correctedPitch - note.detectedPitch) > 0.01f)
        return true;
    if (note.driftCorrectionAmount > 0.01f)
        return true;
    if (std::abs (note.vibratoDepth - 1.0f) > 0.01f)
        return true;
    for (const auto drift : note.pitchDrift)
        if (std::abs (drift) > 0.01f)
            return true;
    return false;
}

static float computeRms (const std::vector<float>& signal, int startSample, int endSample)
{
    if (signal.empty())
        return 0.0f;

    startSample = juce::jlimit (0, static_cast<int> (signal.size()), startSample);
    endSample = juce::jlimit (startSample, static_cast<int> (signal.size()), endSample);
    if (endSample <= startSample)
        return 0.0f;

    double sum = 0.0;
    int count = 0;
    for (int i = startSample; i < endSample; ++i)
    {
        const float s = signal[static_cast<size_t> (i)];
        sum += static_cast<double> (s) * s;
        ++count;
    }

    return count > 0 ? std::sqrt (static_cast<float> (sum / static_cast<double> (count))) : 0.0f;
}

static std::vector<float> buildMonoSignal (
    const float* const* input,
    int numChannels,
    int startSample,
    int endSample)
{
    const int numSamples = std::max (0, endSample - startSample);
    std::vector<float> mono (static_cast<size_t> (numSamples), 0.0f);
    if (numChannels <= 0 || numSamples <= 0)
        return mono;

    const float channelScale = 1.0f / static_cast<float> (numChannels);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        const auto* src = input[ch] + startSample;
        for (int i = 0; i < numSamples; ++i)
            mono[static_cast<size_t> (i)] += src[i] * channelScale;
    }

    return mono;
}

static std::vector<float> buildF0TrackHz (
    int numSamples,
    int contextStartSample,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames)
{
    std::vector<float> f0 (static_cast<size_t> (numSamples), 0.0f);
    if (frames.empty())
        return f0;

    int hopSize = 256;
    if (frames.size() >= 2)
        hopSize = std::max (1, static_cast<int> (std::round ((frames[1].time - frames[0].time) * sampleRate)));

    for (const auto& frame : frames)
    {
        if (frame.frequency <= 0.0f)
            continue;

        const int sampleStart = juce::jlimit (0, std::max (0, numSamples - 1),
            static_cast<int> (std::floor (frame.time * sampleRate)) - contextStartSample);
        const int sampleEnd = juce::jlimit (0, numSamples, sampleStart + hopSize);
        for (int s = sampleStart; s < sampleEnd; ++s)
            f0[static_cast<size_t> (s)] = frame.frequency;
    }

    int lastVoiced = -1;
    for (int i = 0; i < numSamples; ++i)
    {
        if (f0[static_cast<size_t> (i)] > 0.0f)
        {
            if (lastVoiced >= 0 && i > lastVoiced + 1)
            {
                const float left = f0[static_cast<size_t> (lastVoiced)];
                const float right = f0[static_cast<size_t> (i)];
                const int gap = i - lastVoiced - 1;
                for (int g = 1; g <= gap; ++g)
                {
                    const float t = static_cast<float> (g) / static_cast<float> (gap + 1);
                    f0[static_cast<size_t> (lastVoiced + g)] = left + (right - left) * t;
                }
            }
            lastVoiced = i;
        }
    }

    return f0;
}

static std::vector<float> buildVoicedMask (
    int numSamples,
    int contextStartSample,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames)
{
    std::vector<float> mask (static_cast<size_t> (numSamples), 0.0f);
    if (frames.empty())
        return mask;

    int hopSize = 256;
    if (frames.size() >= 2)
        hopSize = std::max (1, static_cast<int> (std::round ((frames[1].time - frames[0].time) * sampleRate)));

    for (const auto& frame : frames)
    {
        const float voicedScore = frame.voiced && frame.frequency > 0.0f
            ? juce::jlimit (0.0f, 1.0f, frame.confidence)
            : 0.0f;
        if (voicedScore <= 0.0f)
            continue;

        const int sampleStart = juce::jlimit (0, std::max (0, numSamples - 1),
            static_cast<int> (std::floor (frame.time * sampleRate)) - contextStartSample);
        const int sampleEnd = juce::jlimit (0, numSamples, sampleStart + hopSize);
        for (int s = sampleStart; s < sampleEnd; ++s)
            mask[static_cast<size_t> (s)] = std::max (mask[static_cast<size_t> (s)], voicedScore);
    }

    std::vector<float> smoothed = mask;
    for (int i = 1; i < numSamples - 1; ++i)
        smoothed[static_cast<size_t> (i)] = (mask[static_cast<size_t> (i - 1)] + mask[static_cast<size_t> (i)] + mask[static_cast<size_t> (i + 1)]) / 3.0f;

    return smoothed;
}

static std::vector<float> buildAmplitudeEnvelope (
    const std::vector<float>& monoSignal,
    double sampleRate)
{
    std::vector<float> env (monoSignal.size(), 0.0f);
    if (monoSignal.empty())
        return env;

    const int radius = std::max (4, static_cast<int> (std::round (0.008 * sampleRate)));
    for (int i = 0; i < static_cast<int> (monoSignal.size()); ++i)
    {
        double sum = 0.0;
        int count = 0;
        for (int j = std::max (0, i - radius); j <= std::min (static_cast<int> (monoSignal.size()) - 1, i + radius); ++j)
        {
            const float sample = monoSignal[static_cast<size_t> (j)];
            sum += static_cast<double> (sample) * sample;
            ++count;
        }
        env[static_cast<size_t> (i)] = count > 0 ? std::sqrt (static_cast<float> (sum / static_cast<double> (count))) : 0.0f;
    }

    return env;
}

static std::vector<int> buildEpochs (
    const std::vector<float>& f0TrackHz,
    int coreStartSample,
    int coreEndSample,
    double sampleRate)
{
    std::vector<int> epochs;
    if (coreEndSample <= coreStartSample || f0TrackHz.empty())
        return epochs;

    int s = coreStartSample;
    while (s < coreEndSample)
    {
        const int idx = juce::jlimit (0, static_cast<int> (f0TrackHz.size()) - 1, s);
        const float f0 = juce::jlimit (55.0f, 1200.0f, std::max (f0TrackHz[static_cast<size_t> (idx)], 55.0f));
        const int period = std::max (1, static_cast<int> (std::round (sampleRate / f0)));
        epochs.push_back (s);
        s += period;
    }

    return epochs;
}

static float computeMedianPositive (const std::vector<float>& values, int startSample, int endSample)
{
    std::vector<float> positive;
    positive.reserve (static_cast<size_t> (std::max (0, endSample - startSample)));

    for (int i = startSample; i < endSample && i < static_cast<int> (values.size()); ++i)
    {
        const float value = values[static_cast<size_t> (i)];
        if (value > 0.0f)
            positive.push_back (value);
    }

    if (positive.empty())
        return 0.0f;

    const auto mid = positive.begin() + static_cast<ptrdiff_t> (positive.size() / 2);
    std::nth_element (positive.begin(), mid, positive.end());
    return *mid;
}

static std::vector<float> buildHannWindow (int fftSize)
{
    std::vector<float> window (static_cast<size_t> (fftSize), 0.0f);
    const float twoPi = juce::MathConstants<float>::twoPi;
    for (int i = 0; i < fftSize; ++i)
        window[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (twoPi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));
    return window;
}

static void smoothLogSpectrum (
    const std::vector<float>& logMagnitude,
    int smoothHalfW,
    std::vector<float>& smoothedMagnitude)
{
    const int halfBins = static_cast<int> (logMagnitude.size());
    smoothedMagnitude.assign (logMagnitude.size(), 0.0f);
    for (int i = 0; i < halfBins; ++i)
    {
        const int lo = std::max (0, i - smoothHalfW);
        const int hi = std::min (halfBins - 1, i + smoothHalfW);
        float sum = 0.0f;
        for (int j = lo; j <= hi; ++j)
            sum += logMagnitude[static_cast<size_t> (j)];
        smoothedMagnitude[static_cast<size_t> (i)] = std::exp (sum / static_cast<float> (hi - lo + 1));
    }
}

template <typename FrameType>
static int advanceFrameCursor (
    const std::vector<FrameType>& frames,
    int sampleIndex,
    int cursor)
{
    if (frames.empty())
        return 0;

    cursor = juce::jlimit (0, static_cast<int> (frames.size()) - 1, cursor);
    while (cursor + 1 < static_cast<int> (frames.size())
           && frames[static_cast<size_t> (cursor + 1)].sampleIndex <= sampleIndex)
    {
        ++cursor;
    }
    while (cursor > 0
           && frames[static_cast<size_t> (cursor)].sampleIndex > sampleIndex)
    {
        --cursor;
    }
    return cursor;
}

static float interpolateEnvelopeMagnitudeAt (
    const OwnPitchEngine::SpectralEnvelopeModel& model,
    int sampleIndex,
    int bin,
    int cursor)
{
    if (model.frames.empty())
    {
        if (model.averageMagnitude.empty())
            return 1.0e-8f;

        const int clampedBin = juce::jlimit (0, static_cast<int> (model.averageMagnitude.size()) - 1, bin);
        return model.averageMagnitude[static_cast<size_t> (clampedBin)] + 1.0e-8f;
    }

    const int clampedCursor = juce::jlimit (0, static_cast<int> (model.frames.size()) - 1, cursor);
    const auto& loFrame = model.frames[static_cast<size_t> (clampedCursor)];
    const int clampedBin = juce::jlimit (0, static_cast<int> (loFrame.smoothedMagnitude.size()) - 1, bin);

    if (clampedCursor + 1 >= static_cast<int> (model.frames.size()))
        return loFrame.smoothedMagnitude[static_cast<size_t> (clampedBin)] + 1.0e-8f;

    const auto& hiFrame = model.frames[static_cast<size_t> (clampedCursor + 1)];
    const int span = std::max (1, hiFrame.sampleIndex - loFrame.sampleIndex);
    const float frac = juce::jlimit (0.0f, 1.0f, static_cast<float> (sampleIndex - loFrame.sampleIndex) / static_cast<float> (span));
    const float lo = loFrame.smoothedMagnitude[static_cast<size_t> (clampedBin)];
    const float hi = hiFrame.smoothedMagnitude[static_cast<size_t> (juce::jlimit (0, static_cast<int> (hiFrame.smoothedMagnitude.size()) - 1, bin))];
    return lo + (hi - lo) * frac + 1.0e-8f;
}

static float interpolateEnvelopeMagnitudeAtHz (
    const OwnPitchEngine::SpectralEnvelopeModel& model,
    int sampleIndex,
    float frequencyHz,
    int cursor)
{
    if (model.binHz <= 0.0f)
        return 1.0e-8f;

    const float binPosition = frequencyHz / model.binHz;
    const int loBin = static_cast<int> (std::floor (binPosition));
    const int hiBin = loBin + 1;
    const float frac = juce::jlimit (0.0f, 1.0f, binPosition - static_cast<float> (loBin));
    const float lo = interpolateEnvelopeMagnitudeAt (model, sampleIndex, loBin, cursor);
    const float hi = interpolateEnvelopeMagnitudeAt (model, sampleIndex, hiBin, cursor);
    return lo + (hi - lo) * frac;
}

static OwnPitchEngine::SpectralEnvelopeModel buildSpectralEnvelope (
    const std::vector<float>& signal,
    const std::vector<float>& f0TrackHz,
    const std::vector<int>& epochs,
    int coreStartSample,
    int coreEndSample,
    double sampleRate)
{
    OwnPitchEngine::SpectralEnvelopeModel model;
    model.fftOrder = 10;
    model.fftSize = 1 << model.fftOrder;
    model.binHz = static_cast<float> (sampleRate / static_cast<double> (model.fftSize));

    const int halfBins = model.fftSize / 2 + 1;
    model.averageMagnitude.assign (static_cast<size_t> (halfBins), 0.0f);

    if (signal.empty() || coreEndSample <= coreStartSample)
        return model;

    juce::dsp::FFT fft (model.fftOrder);
    const auto hannWindow = buildHannWindow (model.fftSize);
    std::vector<float> fftBuffer (static_cast<size_t> (model.fftSize * 2), 0.0f);
    std::vector<float> logMagnitude (static_cast<size_t> (halfBins), 0.0f);
    std::vector<float> smoothedMagnitude (static_cast<size_t> (halfBins), 0.0f);

    std::vector<int> frameCenters;
    if (! epochs.empty())
    {
        for (const int epoch : epochs)
            if (epoch >= coreStartSample && epoch < coreEndSample)
                frameCenters.push_back (epoch);
    }
    else
    {
        const int hop = std::max (32, model.fftSize / 8);
        for (int pos = coreStartSample; pos < coreEndSample; pos += hop)
            frameCenters.push_back (pos);
    }

    if (frameCenters.empty())
        frameCenters.push_back ((coreStartSample + coreEndSample) / 2);

    for (const int center : frameCenters)
    {
        const int f0Index = juce::jlimit (0, static_cast<int> (f0TrackHz.size()) - 1, center);
        const float localF0 = (f0TrackHz.empty() ? 0.0f : f0TrackHz[static_cast<size_t> (f0Index)]);
        const float safeF0 = juce::jlimit (70.0f, 1200.0f, localF0 > 0.0f ? localF0 : computeMedianPositive (f0TrackHz, coreStartSample, coreEndSample));
        const int pitchWindowSamples = juce::jlimit (256, model.fftSize, static_cast<int> (std::round ((3.0 * sampleRate) / std::max (safeF0, 1.0f))));
        const int frameStart = center - pitchWindowSamples / 2;

        std::fill (fftBuffer.begin(), fftBuffer.end(), 0.0f);
        for (int i = 0; i < pitchWindowSamples; ++i)
        {
            const int srcIndex = frameStart + i;
            if (srcIndex < 0 || srcIndex >= static_cast<int> (signal.size()))
                continue;

            const float x = static_cast<float> (i) / static_cast<float> (std::max (1, pitchWindowSamples - 1));
            const float w = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::twoPi * x));
            const int dstIndex = juce::jlimit (0, model.fftSize - 1, i);
            fftBuffer[static_cast<size_t> (dstIndex)] = signal[static_cast<size_t> (srcIndex)] * w;
        }

        fft.performRealOnlyForwardTransform (fftBuffer.data(), true);
        for (int bin = 0; bin < halfBins; ++bin)
        {
            const float re = fftBuffer[static_cast<size_t> (bin * 2)];
            const float im = fftBuffer[static_cast<size_t> (bin * 2 + 1)];
            logMagnitude[static_cast<size_t> (bin)] = std::log (std::sqrt (re * re + im * im) + 1.0e-10f);
        }

        const int smoothHalfW = std::min (halfBins / 3, std::max (4, static_cast<int> (std::round ((1.6f * safeF0) / std::max (1.0f, model.binHz)))));
        smoothLogSpectrum (logMagnitude, smoothHalfW, smoothedMagnitude);

        OwnPitchEngine::SpectralEnvelopeFrame frame;
        frame.sampleIndex = center;
        frame.f0Hz = safeF0;
        frame.rawMagnitude.resize (static_cast<size_t> (halfBins), 0.0f);
        frame.smoothedMagnitude = smoothedMagnitude;
        for (int bin = 0; bin < halfBins; ++bin)
        {
            frame.rawMagnitude[static_cast<size_t> (bin)] = std::exp (logMagnitude[static_cast<size_t> (bin)]);
            model.averageMagnitude[static_cast<size_t> (bin)] += smoothedMagnitude[static_cast<size_t> (bin)];
        }
        model.frames.push_back (std::move (frame));
    }

    if (! model.frames.empty())
    {
        const float invCount = 1.0f / static_cast<float> (model.frames.size());
        for (auto& value : model.averageMagnitude)
            value *= invCount;
    }

    return model;
}

static OwnPitchEngine::HarmonicModel buildHarmonicModel (
    float meanF0Hz,
    float coreRms,
    const OwnPitchEngine::SpectralEnvelopeModel& spectralEnvelopeModel,
    double sampleRate)
{
    OwnPitchEngine::HarmonicModel model;
    model.fftSize = spectralEnvelopeModel.fftSize > 0 ? spectralEnvelopeModel.fftSize : 2048;
    model.binHz = spectralEnvelopeModel.binHz > 0.0f
        ? spectralEnvelopeModel.binHz
        : static_cast<float> (sampleRate / static_cast<double> (model.fftSize));

    const float clampedF0 = juce::jlimit (70.0f, 900.0f, meanF0Hz > 0.0f ? meanF0Hz : 180.0f);
    model.partialCount = juce::jlimit (6, 28, static_cast<int> ((sampleRate * 0.45) / clampedF0));
    model.averageMagnitude.resize (static_cast<size_t> (model.partialCount), 0.0f);

    const float base = std::max (coreRms, 0.01f);
    for (int p = 0; p < model.partialCount; ++p)
    {
        const float harmonicHz = clampedF0 * static_cast<float> (p + 1);
        const float envelope = spectralEnvelopeModel.averageMagnitude.empty()
            ? 1.0f / std::pow (static_cast<float> (p + 1), 0.88f)
            : spectralEnvelopeModel.averageMagnitude[static_cast<size_t> (juce::jlimit (
                0,
                static_cast<int> (spectralEnvelopeModel.averageMagnitude.size()) - 1,
                static_cast<int> (std::round (harmonicHz / std::max (1.0f, model.binHz)))) )];
        model.averageMagnitude[static_cast<size_t> (p)] = base * envelope;
    }

    return model;
}

static OwnPitchEngine::ResidualModel buildResidualModel (
    const std::vector<float>& monoSignal,
    const std::vector<float>& voicedMask,
    const OwnPitchEngine::SpectralEnvelopeModel& spectralEnvelopeModel,
    double sampleRate)
{
    OwnPitchEngine::ResidualModel model;
    model.monoResidual.resize (monoSignal.size(), 0.0f);
    model.voicedHighBandResidual.resize (monoSignal.size(), 0.0f);
    model.bandAperiodicity.assign (6, 0.0f);

    float residualEnergy = 0.0f;
    const float cutoffHz = 1800.0f;
    const float alpha = juce::jlimit (0.02f, 0.45f,
        static_cast<float> ((2.0 * juce::MathConstants<double>::pi * cutoffHz) / (sampleRate + 2.0 * juce::MathConstants<double>::pi * cutoffHz)));
    float lowpass = monoSignal.empty() ? 0.0f : monoSignal.front();
    for (size_t i = 0; i < monoSignal.size(); ++i)
    {
        lowpass += alpha * (monoSignal[i] - lowpass);
        const float highBand = monoSignal[i] - lowpass;
        const float unvoiced = 1.0f - juce::jlimit (0.0f, 1.0f, voicedMask.empty() ? 0.0f : voicedMask[i]);
        model.monoResidual[i] = monoSignal[i] * unvoiced;
        model.voicedHighBandResidual[i] = highBand * (voicedMask.empty() ? 0.0f : voicedMask[i]);
        residualEnergy += std::abs (model.monoResidual[i]);
    }

    if (! spectralEnvelopeModel.frames.empty())
    {
        const int halfBins = spectralEnvelopeModel.fftSize / 2 + 1;
        const int numBands = static_cast<int> (model.bandAperiodicity.size());
        std::vector<float> bandSum (static_cast<size_t> (numBands), 0.0f);
        std::vector<int> bandCount (static_cast<size_t> (numBands), 0);
        for (const auto& frame : spectralEnvelopeModel.frames)
        {
            for (int band = 0; band < numBands; ++band)
            {
                const int lo = (band * halfBins) / numBands;
                const int hi = ((band + 1) * halfBins) / numBands;
                float rawSum = 0.0f;
                float envSum = 0.0f;
                for (int bin = lo; bin < hi; ++bin)
                {
                    rawSum += frame.rawMagnitude[static_cast<size_t> (bin)];
                    envSum += frame.smoothedMagnitude[static_cast<size_t> (bin)];
                }
                if (rawSum > 1.0e-6f)
                {
                    const float aperiodicity = juce::jlimit (0.0f, 1.0f, std::max (0.0f, rawSum - envSum) / rawSum);
                    bandSum[static_cast<size_t> (band)] += aperiodicity;
                    ++bandCount[static_cast<size_t> (band)];
                }
            }
        }

        for (int band = 0; band < numBands; ++band)
        {
            model.bandAperiodicity[static_cast<size_t> (band)] = bandCount[static_cast<size_t> (band)] > 0
                ? bandSum[static_cast<size_t> (band)] / static_cast<float> (bandCount[static_cast<size_t> (band)])
                : 0.0f;
        }
    }

    const float avgResidual = monoSignal.empty() ? 0.0f : residualEnergy / static_cast<float> (monoSignal.size());
    const float avgAperiodicity = model.bandAperiodicity.empty()
        ? 0.0f
        : std::accumulate (model.bandAperiodicity.begin(), model.bandAperiodicity.end(), 0.0f)
            / static_cast<float> (model.bandAperiodicity.size());
    model.suggestedMix = juce::jlimit (0.02f, 0.16f, 0.04f + avgResidual * 0.5f + avgAperiodicity * 0.10f);
    model.voicedMix = juce::jlimit (0.02f, 0.14f, 0.03f + avgAperiodicity * 0.16f);
    model.highBandMix = juce::jlimit (0.02f, 0.18f,
        0.03f + (model.bandAperiodicity.size() >= 2
            ? 0.5f * (model.bandAperiodicity[model.bandAperiodicity.size() - 1]
                      + model.bandAperiodicity[model.bandAperiodicity.size() - 2])
            : avgAperiodicity) * 0.22f);
    return model;
}

static void applySourceFilterCorrection (
    std::vector<float>& synthSignal,
    const std::vector<float>& f0TrackHz,
    const std::vector<int>& epochs,
    int coreStartSample,
    int coreEndSample,
    const OwnPitchEngine::SpectralEnvelopeModel& sourceEnvelopeModel,
    const OwnPitchEngine::ResidualModel& residualModel,
    double sampleRate,
    bool downwardShift,
    bool longBody)
{
    if (synthSignal.empty()
        || coreEndSample <= coreStartSample
        || sourceEnvelopeModel.averageMagnitude.empty())
        return;

    const auto synthEnvelopeModel = buildSpectralEnvelope (
        synthSignal,
        f0TrackHz,
        epochs,
        coreStartSample,
        coreEndSample,
        sampleRate);

    if (synthEnvelopeModel.averageMagnitude.empty())
        return;

    const int fftOrder = sourceEnvelopeModel.fftOrder > 0 ? sourceEnvelopeModel.fftOrder : 10;
    const int fftSize = 1 << fftOrder;
    const int halfBins = fftSize / 2 + 1;
    const int hopLen = fftSize / 4;
    const auto hannWindow = buildHannWindow (fftSize);
    juce::dsp::FFT fft (fftOrder);
    std::vector<float> fftBuffer (static_cast<size_t> (fftSize * 2), 0.0f);
    std::vector<float> corrected (synthSignal.size(), 0.0f);
    std::vector<float> windowSum (synthSignal.size(), 0.0f);
    int sourceFrameCursor = 0;
    int synthFrameCursor = 0;
    const bool hybridStructural = isHybridStructuralBranchRequested();

    const float correctionStrength = downwardShift
        ? (hybridStructural ? (longBody ? 0.76f : 0.68f) : 0.58f)
        : (longBody ? 0.74f : 0.68f);
    const float minGain = downwardShift
        ? (hybridStructural ? 0.60f : 0.72f)
        : (longBody ? 0.72f : 0.68f);
    const float maxGain = downwardShift
        ? (hybridStructural ? (longBody ? 1.52f : 1.44f) : 1.36f)
        : (longBody ? 1.34f : 1.44f);
    const float highBandLimit = downwardShift
        ? (hybridStructural ? 1.08f : 1.18f)
        : (longBody ? 1.16f : 1.28f);
    const float localEnvelopeBlend = downwardShift
        ? (hybridStructural ? (longBody ? 0.70f : 0.60f) : 0.48f)
        : (longBody ? 0.72f : 0.52f);

    for (int pos = std::max (0, coreStartSample - fftSize / 2);
         pos < std::min (static_cast<int> (synthSignal.size()), coreEndSample + fftSize / 2);
         pos += hopLen)
    {
        const int frameSample = juce::jlimit (coreStartSample, std::max (coreStartSample, coreEndSample - 1), pos + fftSize / 2);
        sourceFrameCursor = advanceFrameCursor (sourceEnvelopeModel.frames, frameSample, sourceFrameCursor);
        synthFrameCursor = advanceFrameCursor (synthEnvelopeModel.frames, frameSample, synthFrameCursor);

        std::fill (fftBuffer.begin(), fftBuffer.end(), 0.0f);
        for (int i = 0; i < fftSize; ++i)
        {
            const int idx = pos + i;
            if (idx >= 0 && idx < static_cast<int> (synthSignal.size()))
                fftBuffer[static_cast<size_t> (i)] = synthSignal[static_cast<size_t> (idx)] * hannWindow[static_cast<size_t> (i)];
        }

        fft.performRealOnlyForwardTransform (fftBuffer.data(), true);
        float energyBefore = 0.0f;
        float energyAfter = 0.0f;
        for (int bin = 0; bin < halfBins; ++bin)
        {
            const float re = fftBuffer[static_cast<size_t> (bin * 2)];
            const float im = fftBuffer[static_cast<size_t> (bin * 2 + 1)];
            energyBefore += re * re + im * im;

            const int srcAvgBin = juce::jlimit (0, static_cast<int> (sourceEnvelopeModel.averageMagnitude.size()) - 1, bin);
            const int synthAvgBin = juce::jlimit (0, static_cast<int> (synthEnvelopeModel.averageMagnitude.size()) - 1, bin);
            const float srcLocal = interpolateEnvelopeMagnitudeAt (sourceEnvelopeModel, frameSample, bin, sourceFrameCursor);
            const float synthLocal = interpolateEnvelopeMagnitudeAt (synthEnvelopeModel, frameSample, bin, synthFrameCursor);
            const float srcAverage = sourceEnvelopeModel.averageMagnitude[static_cast<size_t> (srcAvgBin)] + 1.0e-8f;
            const float synthAverage = synthEnvelopeModel.averageMagnitude[static_cast<size_t> (synthAvgBin)] + 1.0e-8f;
            const float srcEnv = srcAverage + (srcLocal - srcAverage) * localEnvelopeBlend;
            const float synthEnv = synthAverage + (synthLocal - synthAverage) * localEnvelopeBlend;
            const float rawGain = std::pow (srcEnv / synthEnv, correctionStrength);
            const float freqNorm = static_cast<float> (bin) / static_cast<float> (std::max (1, halfBins - 1));
            const float bandWeight = downwardShift
                ? (hybridStructural
                    ? (0.92f + 0.08f * smoothstep01 ((freqNorm - 0.05f) / 0.42f))
                    : (0.78f + 0.22f * smoothstep01 ((freqNorm - 0.08f) / 0.55f)))
                : (0.70f + 0.30f * smoothstep01 ((freqNorm - 0.06f) / 0.48f));
            float gain = juce::jlimit (minGain, maxGain, 1.0f + (rawGain - 1.0f) * bandWeight);
            if (freqNorm > 0.60f)
                gain = std::min (gain, highBandLimit);

            fftBuffer[static_cast<size_t> (bin * 2)] *= gain;
            fftBuffer[static_cast<size_t> (bin * 2 + 1)] *= gain;
        }

        for (int bin = 0; bin < halfBins; ++bin)
        {
            const float re = fftBuffer[static_cast<size_t> (bin * 2)];
            const float im = fftBuffer[static_cast<size_t> (bin * 2 + 1)];
            energyAfter += re * re + im * im;
        }

        if (energyAfter > 1.0e-10f)
        {
            const float scale = std::pow (energyBefore / energyAfter, 0.18f);
            for (int bin = 0; bin < halfBins; ++bin)
            {
                fftBuffer[static_cast<size_t> (bin * 2)] *= scale;
                fftBuffer[static_cast<size_t> (bin * 2 + 1)] *= scale;
            }
        }

        fft.performRealOnlyInverseTransform (fftBuffer.data());
        for (int i = 0; i < fftSize; ++i)
        {
            const int idx = pos + i;
            if (idx >= 0 && idx < static_cast<int> (synthSignal.size()))
            {
                const float w = hannWindow[static_cast<size_t> (i)];
                corrected[static_cast<size_t> (idx)] += fftBuffer[static_cast<size_t> (i)] * w;
                windowSum[static_cast<size_t> (idx)] += w * w;
            }
        }
    }

    for (int i = coreStartSample; i < coreEndSample && i < static_cast<int> (synthSignal.size()); ++i)
    {
        if (windowSum[static_cast<size_t> (i)] > 1.0e-4f)
            synthSignal[static_cast<size_t> (i)] = corrected[static_cast<size_t> (i)] / windowSum[static_cast<size_t> (i)];
    }

    const float residualMix = downwardShift
        ? residualModel.voicedMix * (hybridStructural ? (longBody ? 0.28f : 0.36f) : 0.55f)
        : residualModel.highBandMix * (longBody ? 0.75f : 0.70f);
    if (! residualModel.voicedHighBandResidual.empty() && residualMix > 0.0f)
    {
        for (int i = coreStartSample; i < coreEndSample && i < static_cast<int> (synthSignal.size()); ++i)
            synthSignal[static_cast<size_t> (i)] += residualModel.voicedHighBandResidual[static_cast<size_t> (i)] * residualMix;
    }
}

struct AnalysisCacheKey
{
    int mode = 0;
    int quality = 0;
    int numChannels = 0;
    int numSamples = 0;
    int sampleRateRounded = 0;
    std::uint64_t noteSignature = 0;
    std::uint64_t frameSignature = 0;
    std::uint64_t audioSignature = 0;

    bool operator== (const AnalysisCacheKey& other) const noexcept
    {
        return mode == other.mode
            && quality == other.quality
            && numChannels == other.numChannels
            && numSamples == other.numSamples
            && sampleRateRounded == other.sampleRateRounded
            && noteSignature == other.noteSignature
            && frameSignature == other.frameSignature
            && audioSignature == other.audioSignature;
    }
};

static void hashCombine (std::uint64_t& seed, std::uint64_t value)
{
    seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6U) + (seed >> 2U);
}

static std::uint64_t buildNoteSignature (const std::vector<PitchAnalyzer::PitchNote>& notes)
{
    std::uint64_t seed = 1469598103934665603ULL;
    for (const auto& note : notes)
    {
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (note.startTime * 1000.0f)));
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (note.endTime * 1000.0f)));
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (note.detectedPitch * 100.0f)));
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (note.correctedPitch * 100.0f)));
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (note.formantShift * 100.0f)));
    }
    return seed;
}

static std::uint64_t buildFrameSignature (const std::vector<PitchAnalyzer::PitchFrame>& frames)
{
    std::uint64_t seed = 1099511628211ULL;
    if (frames.empty())
        return seed;

    const int stride = std::max (1, static_cast<int> (frames.size() / 32));
    for (size_t i = 0; i < frames.size(); i += static_cast<size_t> (stride))
    {
        const auto& frame = frames[i];
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (frame.time * 1000.0f)));
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (frame.frequency * 10.0f)));
        hashCombine (seed, static_cast<std::uint64_t> (std::llround (frame.confidence * 1000.0f)));
        hashCombine (seed, static_cast<std::uint64_t> (frame.voiced ? 1 : 0));
    }
    return seed;
}

static std::uint64_t buildAudioSignature (
    const float* const* input,
    int numChannels,
    int numSamples)
{
    std::uint64_t seed = 0xcbf29ce484222325ULL;
    if (numChannels <= 0 || numSamples <= 0)
        return seed;

    const int probeCount = std::min (numSamples, 256);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        const auto* src = input[ch];
        for (int i = 0; i < probeCount; ++i)
            hashCombine (seed, static_cast<std::uint64_t> (std::llround (src[i] * 100000.0f)));
        for (int i = std::max (0, numSamples - probeCount); i < numSamples; ++i)
            hashCombine (seed, static_cast<std::uint64_t> (std::llround (src[i] * 100000.0f)));
    }

    return seed;
}

static std::optional<std::pair<AnalysisCacheKey, OwnPitchEngine::SharedAnalysis>> gLastSharedAnalysisCache;

static float getTargetPitchRatioAtSample (
    int absoluteSample,
    const std::vector<float>& pitchRatios)
{
    if (pitchRatios.empty())
        return 1.0f;
    const int clamped = juce::jlimit (0, static_cast<int> (pitchRatios.size()) - 1, absoluteSample);
    return juce::jlimit (0.25f, 4.0f, pitchRatios[static_cast<size_t> (clamped)]);
}

static bool isHybridStructuralBranchRequested()
{
    const auto branch = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_RENDERER_BRANCH", {})
        .trim()
        .toLowerCase();
    return branch == "pitch_only_hybrid_structural"
        || branch == "hybrid_structural"
        || branch == "hybrid_struct";
}

static int findSustainedVoicedSample (
    const std::vector<float>& voicedMask,
    const std::vector<float>& amplitudeEnvelope,
    int searchStartSample,
    int searchEndSample,
    int sustainSamples,
    float voicedThreshold,
    float envThreshold)
{
    if (voicedMask.empty() || amplitudeEnvelope.empty() || searchEndSample <= searchStartSample)
        return searchStartSample;

    const int endLimit = std::max (searchStartSample, searchEndSample - sustainSamples);
    for (int sample = searchStartSample; sample <= endLimit; ++sample)
    {
        bool sustained = true;
        for (int offset = 0; offset < sustainSamples; ++offset)
        {
            const int idx = sample + offset;
            if (idx < 0
                || idx >= static_cast<int> (voicedMask.size())
                || idx >= static_cast<int> (amplitudeEnvelope.size())
                || voicedMask[static_cast<size_t> (idx)] < voicedThreshold
                || amplitudeEnvelope[static_cast<size_t> (idx)] < envThreshold)
            {
                sustained = false;
                break;
            }
        }

        if (sustained)
            return sample;
    }

    return searchStartSample;
}

static int findLastSustainedVoicedSample (
    const std::vector<float>& voicedMask,
    const std::vector<float>& amplitudeEnvelope,
    int searchStartSample,
    int searchEndSample,
    int sustainSamples,
    float voicedThreshold,
    float envThreshold)
{
    if (voicedMask.empty() || amplitudeEnvelope.empty() || searchEndSample <= searchStartSample)
        return searchEndSample;

    const int startLimit = std::min (searchEndSample - 1, std::max (searchStartSample, searchStartSample + sustainSamples - 1));
    for (int sample = searchEndSample - 1; sample >= startLimit; --sample)
    {
        bool sustained = true;
        for (int offset = 0; offset < sustainSamples; ++offset)
        {
            const int idx = sample - offset;
            if (idx < 0
                || idx >= static_cast<int> (voicedMask.size())
                || idx >= static_cast<int> (amplitudeEnvelope.size())
                || voicedMask[static_cast<size_t> (idx)] < voicedThreshold
                || amplitudeEnvelope[static_cast<size_t> (idx)] < envThreshold)
            {
                sustained = false;
                break;
            }
        }

        if (sustained)
            return sample;
    }

    return searchEndSample;
}

static float computeIslandWet (
    int absoluteSample,
    int renderStartSample,
    int renderEndSample,
    int bodyStartSample,
    int bodyEndSample,
    int coreStartSample,
    int coreEndSample,
    int voicedEntrySample,
    int voicedExitSample,
    double sampleRate,
    float voiced,
    bool downwardShift,
    bool longBody,
    float coreMaxWet,
    float bodyEntryWet,
    float bodyExitWet,
    float outsideCoreScale)
{
    const bool hybridStructural = isHybridStructuralBranchRequested();
    const int entryProtect = std::max (1, static_cast<int> (std::round (0.034 * sampleRate)));
    const int exitProtect = std::max (1, static_cast<int> (std::round (0.040 * sampleRate)));
    const int entryPreRoll = hybridStructural
        ? std::max (1, static_cast<int> (std::round ((downwardShift ? 0.008 : 0.010) * sampleRate)))
        : 0;
    const int exitPostRoll = hybridStructural
        ? std::max (1, static_cast<int> (std::round ((downwardShift ? 0.010 : 0.012) * sampleRate)))
        : 0;
    const int maxEntryAnchorShift = hybridStructural
        ? std::max (1, static_cast<int> (std::round ((downwardShift ? 0.016 : (longBody ? 0.024 : 0.018)) * sampleRate)))
        : 0;
    const int maxExitAnchorShift = hybridStructural
        ? std::max (1, static_cast<int> (std::round ((downwardShift ? 0.018 : (longBody ? 0.028 : 0.020)) * sampleRate)))
        : 0;
    const int desiredEntryStart = hybridStructural
        ? std::max (bodyStartSample, voicedEntrySample - entryPreRoll)
        : bodyStartSample;
    const int desiredExitEnd = hybridStructural
        ? std::min (bodyEndSample, voicedExitSample + exitPostRoll)
        : bodyEndSample;
    const int anchoredBodyStart = juce::jlimit (
        bodyStartSample,
        std::max (bodyStartSample, bodyEndSample - 1),
        bodyStartSample + std::min (maxEntryAnchorShift, std::max (0, desiredEntryStart - bodyStartSample)));
    const int anchoredBodyEnd = juce::jlimit (
        anchoredBodyStart + 1,
        bodyEndSample,
        bodyEndSample - std::min (maxExitAnchorShift, std::max (0, bodyEndSample - desiredExitEnd)));

    if (absoluteSample < renderStartSample || absoluteSample >= renderEndSample)
        return 0.0f;

    float wet = 0.0f;
    if (absoluteSample < anchoredBodyStart)
    {
        const float t = static_cast<float> (absoluteSample - renderStartSample) / static_cast<float> (std::max (1, anchoredBodyStart - renderStartSample));
        wet = hybridStructural
            ? (downwardShift ? 0.66f * smoothstep01 (t) : 0.58f * smoothstep01 (t))
            : 0.68f * smoothstep01 (t);
    }
    else if (absoluteSample > anchoredBodyEnd)
    {
        const float t = static_cast<float> (renderEndSample - absoluteSample) / static_cast<float> (std::max (1, renderEndSample - anchoredBodyEnd));
        wet = hybridStructural
            ? (downwardShift ? 0.70f * smoothstep01 (t) : 0.60f * smoothstep01 (t))
            : 0.74f * smoothstep01 (t);
    }
    else
    {
        wet = coreMaxWet;

        const int effectiveEntryProtect = hybridStructural
            ? (downwardShift
                ? std::max (entryProtect, longBody ? static_cast<int> (std::round (0.050 * sampleRate))
                                                   : static_cast<int> (std::round (0.042 * sampleRate)))
                : std::max (entryProtect, longBody ? static_cast<int> (std::round (0.056 * sampleRate))
                                                   : static_cast<int> (std::round (0.046 * sampleRate))))
            : (downwardShift
                ? entryProtect
                : std::max (entryProtect, longBody ? static_cast<int> (std::round (0.060 * sampleRate))
                                                   : static_cast<int> (std::round (0.052 * sampleRate))));
        const int effectiveExitProtect = hybridStructural
            ? (downwardShift
                ? std::max (exitProtect, longBody ? static_cast<int> (std::round (0.058 * sampleRate))
                                                  : static_cast<int> (std::round (0.050 * sampleRate)))
                : std::max (exitProtect, longBody ? static_cast<int> (std::round (0.062 * sampleRate))
                                                  : static_cast<int> (std::round (0.048 * sampleRate))))
            : (downwardShift
                ? exitProtect
                : std::max (exitProtect, longBody ? static_cast<int> (std::round (0.068 * sampleRate))
                                                  : exitProtect));

        if (! downwardShift)
        {
            const int upwardDryHold = std::max (1, static_cast<int> (std::round ((hybridStructural ? (longBody ? 0.024 : 0.018)
                                                                                                     : (longBody ? 0.024 : 0.018)) * sampleRate)));
            if (absoluteSample < anchoredBodyStart + upwardDryHold)
            {
                const float t = static_cast<float> (absoluteSample - anchoredBodyStart) / static_cast<float> (upwardDryHold);
                wet = std::min (wet, juce::jmap (
                    smoothstep01 (t),
                    hybridStructural ? 0.16f : 0.10f,
                    hybridStructural ? (longBody ? 0.36f : 0.40f) : 0.32f));
            }
        }
        else if (hybridStructural)
        {
            const int downwardDryHold = std::max (1, static_cast<int> (std::round ((longBody ? 0.020 : 0.014) * sampleRate)));
            if (absoluteSample < anchoredBodyStart + downwardDryHold)
            {
                const float t = static_cast<float> (absoluteSample - anchoredBodyStart) / static_cast<float> (downwardDryHold);
                wet = std::min (wet, juce::jmap (smoothstep01 (t), 0.24f, longBody ? 0.46f : 0.52f));
            }
        }

        const float effectiveBodyEntryWet = downwardShift
            ? std::min (bodyEntryWet, hybridStructural ? (longBody ? 0.54f : 0.60f) : bodyEntryWet)
            : std::min (bodyEntryWet, hybridStructural ? (longBody ? 0.42f : 0.50f) : (longBody ? 0.34f : 0.42f));
        const float effectiveBodyExitWet = downwardShift
            ? std::min (bodyExitWet, hybridStructural ? (longBody ? 0.56f : 0.62f) : bodyExitWet)
            : std::min (bodyExitWet, hybridStructural ? (longBody ? 0.46f : 0.56f) : (longBody ? 0.44f : 0.56f));

        if (absoluteSample < anchoredBodyStart + effectiveEntryProtect)
        {
            const float t = static_cast<float> (absoluteSample - anchoredBodyStart) / static_cast<float> (effectiveEntryProtect);
            wet = std::min (wet, effectiveBodyEntryWet + (coreMaxWet - effectiveBodyEntryWet) * smoothstep01 (t));
        }

        if (absoluteSample > anchoredBodyEnd - effectiveExitProtect)
        {
            const float t = static_cast<float> (anchoredBodyEnd - absoluteSample) / static_cast<float> (effectiveExitProtect);
            wet = std::min (wet, effectiveBodyExitWet + (coreMaxWet - effectiveBodyExitWet) * smoothstep01 (t));
        }
    }

    if (absoluteSample < coreStartSample || absoluteSample >= coreEndSample)
    {
        if (hybridStructural)
            wet *= (!downwardShift && longBody) ? outsideCoreScale * 0.88f : outsideCoreScale * (downwardShift ? 0.92f : 0.90f);
        else
            wet *= (!downwardShift && longBody) ? outsideCoreScale * 0.82f : outsideCoreScale;
    }

    wet *= juce::jlimit (0.0f, 1.0f, 0.20f + 0.80f * voiced);
    return juce::jlimit (0.0f, 1.0f, wet);
}
}

OwnPitchEngine::SharedAnalysis OwnPitchEngine::analyze (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    Mode mode,
    Quality quality)
{
    SharedAnalysis analysis;
    analysis.mode = mode;
    analysis.quality = quality;
    analysis.sampleRate = sampleRate;
    analysis.numChannels = numChannels;
    analysis.numSamples = numSamples;

    AnalysisCacheKey key;
    key.mode = static_cast<int> (mode);
    key.quality = static_cast<int> (quality);
    key.numChannels = numChannels;
    key.numSamples = numSamples;
    key.sampleRateRounded = static_cast<int> (std::round (sampleRate));
    key.noteSignature = buildNoteSignature (notes);
    key.frameSignature = buildFrameSignature (frames);
    key.audioSignature = buildAudioSignature (input, numChannels, numSamples);

    if (gLastSharedAnalysisCache.has_value() && gLastSharedAnalysisCache->first == key)
    {
        analysis = gLastSharedAnalysisCache->second;
        analysis.cacheHit = true;
        return analysis;
    }

    std::vector<PitchAnalyzer::PitchNote> editedNotes;
    editedNotes.reserve (notes.size());
    for (const auto& note : notes)
    {
        const bool includeForMode = mode == Mode::PitchOnly
            ? hasPitchStyleEdit (note)
            : (std::abs (note.formantShift) > 0.01f || hasPitchStyleEdit (note));
        if (includeForMode)
            editedNotes.push_back (note);
    }

    std::sort (editedNotes.begin(), editedNotes.end(), [] (const auto& a, const auto& b)
    {
        return getEffectiveNoteStartTime (a) < getEffectiveNoteStartTime (b);
    });

    const float mergeGapSec = 0.020f;
    const float contextPadSec = quality == Quality::PreviewFast ? 0.120f : 0.180f;

    std::vector<NoteIslandAnalysis> islands;
    for (const auto& note : editedNotes)
    {
        if (islands.empty()
            || getEffectiveNoteStartTime (note) > (static_cast<float> (islands.back().contextEndSample / sampleRate) + mergeGapSec))
        {
            NoteIslandAnalysis island;
            island.notes.push_back (note);
            islands.push_back (std::move (island));
        }
        else
        {
            islands.back().notes.push_back (note);
        }
    }

    for (auto& island : islands)
    {
        float islandRenderStartSec = std::numeric_limits<float>::max();
        float islandRenderEndSec = 0.0f;
        float islandBodyStartSec = std::numeric_limits<float>::max();
        float islandBodyEndSec = 0.0f;
        double islandRatioSum = 0.0;
        int islandRatioCount = 0;

        for (const auto& note : island.notes)
        {
            islandRenderStartSec = std::min (islandRenderStartSec, getEffectiveNoteStartTime (note));
            islandRenderEndSec = std::max (islandRenderEndSec, getEffectiveNoteEndTime (note));
            islandBodyStartSec = std::min (islandBodyStartSec, note.startTime);
            islandBodyEndSec = std::max (islandBodyEndSec, note.endTime);
            islandRatioSum += std::pow (2.0, static_cast<double> (note.correctedPitch - note.detectedPitch) / 12.0);
            ++islandRatioCount;
        }

        island.renderStartSample = juce::jlimit (0, numSamples, static_cast<int> (std::floor (islandRenderStartSec * sampleRate)));
        island.renderEndSample = juce::jlimit (island.renderStartSample, numSamples, static_cast<int> (std::ceil (islandRenderEndSec * sampleRate)));
        island.contextStartSample = juce::jlimit (0, numSamples, island.renderStartSample - static_cast<int> (std::round (contextPadSec * sampleRate)));
        island.contextEndSample = juce::jlimit (island.renderEndSample, numSamples, island.renderEndSample + static_cast<int> (std::round (contextPadSec * sampleRate)));

        island.monoSignal = buildMonoSignal (input, numChannels, island.contextStartSample, island.contextEndSample);
        island.f0TrackHz = buildF0TrackHz (static_cast<int> (island.monoSignal.size()), island.contextStartSample, sampleRate, frames);
        island.voicedMask = buildVoicedMask (static_cast<int> (island.monoSignal.size()), island.contextStartSample, sampleRate, frames);
        island.consonantMask.resize (island.voicedMask.size(), 0.0f);
        for (size_t i = 0; i < island.voicedMask.size(); ++i)
            island.consonantMask[i] = 1.0f - juce::jlimit (0.0f, 1.0f, island.voicedMask[i]);
        island.amplitudeEnvelope = buildAmplitudeEnvelope (island.monoSignal, sampleRate);

        const int bodyStartSample = juce::jlimit (0, static_cast<int> (island.monoSignal.size()),
            static_cast<int> (std::floor (islandBodyStartSec * sampleRate)) - island.contextStartSample);
        const int bodyEndSample = juce::jlimit (bodyStartSample, static_cast<int> (island.monoSignal.size()),
            static_cast<int> (std::ceil (islandBodyEndSec * sampleRate)) - island.contextStartSample);
        island.bodyStartSample = bodyStartSample;
        island.bodyEndSample = bodyEndSample;

        const float averagePitchRatio = islandRatioCount > 0
            ? static_cast<float> (islandRatioSum / static_cast<double> (islandRatioCount))
            : 1.0f;
        const bool downwardShift = averagePitchRatio < 0.999f;
        const float bodyDurationSec = static_cast<float> (std::max (0, bodyEndSample - bodyStartSample)) / static_cast<float> (sampleRate);
        const bool longBody = bodyDurationSec >= 0.90f;

        const int entryProtect = std::max (1, static_cast<int> (std::round (
            (!downwardShift && longBody ? 0.052 : 0.032) * sampleRate)));
        const int exitProtect = std::max (1, static_cast<int> (std::round (
            (!downwardShift && longBody ? 0.070 : 0.038) * sampleRate)));
        const int minCoreLen = std::max (1, static_cast<int> (std::round (0.055 * sampleRate)));

        island.core.startSample = juce::jlimit (bodyStartSample, bodyEndSample, bodyStartSample + entryProtect);
        island.core.endSample = juce::jlimit (island.core.startSample, bodyEndSample, bodyEndSample - exitProtect);
        if (island.core.endSample - island.core.startSample < minCoreLen)
        {
            island.core.startSample = bodyStartSample;
            island.core.endSample = bodyEndSample;
        }

        float voicedSum = 0.0f;
        int voicedCount = 0;
        for (int i = island.core.startSample; i < island.core.endSample && i < static_cast<int> (island.voicedMask.size()); ++i)
        {
            voicedSum += island.voicedMask[static_cast<size_t> (i)];
            ++voicedCount;
        }
        island.core.voicedRatio = voicedCount > 0 ? voicedSum / static_cast<float> (voicedCount) : 0.0f;
        island.core.meanF0Hz = computeMedianPositive (island.f0TrackHz, island.core.startSample, island.core.endSample);
        island.core.rms = computeRms (island.monoSignal, island.core.startSample, island.core.endSample);
        island.epochs = buildEpochs (island.f0TrackHz, island.core.startSample, island.core.endSample, sampleRate);
        island.core.epochCount = static_cast<int> (island.epochs.size());

        island.spectralEnvelopeModel = buildSpectralEnvelope (
            island.monoSignal,
            island.f0TrackHz,
            island.epochs,
            island.core.startSample,
            island.core.endSample,
            sampleRate);
        island.harmonicModel = buildHarmonicModel (
            island.core.meanF0Hz,
            island.core.rms,
            island.spectralEnvelopeModel,
            sampleRate);
        island.residualModel = buildResidualModel (
            island.monoSignal,
            island.voicedMask,
            island.spectralEnvelopeModel,
            sampleRate);

        analysis.totalEpochCount += island.core.epochCount;
        analysis.maxPartialCount = std::max (analysis.maxPartialCount, island.harmonicModel.partialCount);
    }

    analysis.islands = std::move (islands);
    gLastSharedAnalysisCache = std::make_pair (key, analysis);
    return analysis;
}

OwnPitchEngine::RenderResult OwnPitchEngine::renderPitchOnly (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& pitchRatios,
    Quality quality,
    std::function<bool()> shouldCancel)
{
    RenderResult result;
    result.output.resize (static_cast<size_t> (numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        result.output[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);

    const double analysisStart = juce::Time::getMillisecondCounterHiRes();
    result.analysis = analyze (input, numChannels, numSamples, sampleRate, frames, notes, Mode::PitchOnly, quality);
    result.analysisMs = juce::Time::getMillisecondCounterHiRes() - analysisStart;

    const double renderStart = juce::Time::getMillisecondCounterHiRes();
    const double twoPi = juce::MathConstants<double>::twoPi;

    for (const auto& island : result.analysis.islands)
    {
        if (shouldCancel && shouldCancel())
        {
            result.usedFallback = true;
            result.fallbackReason = "cancelled";
            break;
        }

        const int localRenderStart = juce::jlimit (0, static_cast<int> (island.monoSignal.size()), island.renderStartSample - island.contextStartSample);
        const int localRenderEnd = juce::jlimit (localRenderStart, static_cast<int> (island.monoSignal.size()), island.renderEndSample - island.contextStartSample);
        const int renderSamples = localRenderEnd - localRenderStart;
        if (renderSamples <= 0)
            continue;

        float averagePitchRatio = 1.0f;
        if (! island.notes.empty())
        {
            double ratioSum = 0.0;
            for (const auto& note : island.notes)
                ratioSum += std::pow (2.0, static_cast<double> (note.correctedPitch - note.detectedPitch) / 12.0);
            averagePitchRatio = static_cast<float> (ratioSum / static_cast<double> (island.notes.size()));
        }
        const bool downwardShift = averagePitchRatio < 0.999f;
        const float bodyDurationSec = static_cast<float> (std::max (0, island.bodyEndSample - island.bodyStartSample)) / static_cast<float> (sampleRate);
        const bool longBody = bodyDurationSec >= 0.90f;

        float coreMaxWet = 0.88f;
        float bodyEntryWet = 0.66f;
        float bodyExitWet = 0.70f;
        float outsideCoreScale = 0.64f;
        float cutoffHz = quality == Quality::PreviewFast ? 2600.0f : 3200.0f;
        float filteredMix = 0.34f;
        if (downwardShift)
        {
            coreMaxWet = 0.96f;
            bodyEntryWet = 0.76f;
            bodyExitWet = 0.80f;
            outsideCoreScale = 0.78f;
            cutoffHz = quality == Quality::PreviewFast ? 3400.0f : 4200.0f;
            filteredMix = 0.26f;
            if (! longBody)
            {
                coreMaxWet = 1.0f;
                outsideCoreScale = 0.84f;
            }
        }
        else if (longBody)
        {
            coreMaxWet = 0.92f;
            bodyEntryWet = 0.78f;
            bodyExitWet = 0.82f;
            outsideCoreScale = 0.82f;
            cutoffHz = quality == Quality::PreviewFast ? 3200.0f : 3800.0f;
            filteredMix = 0.24f;
        }

        const float maxBodyEnv = island.amplitudeEnvelope.empty() || island.bodyEndSample <= island.bodyStartSample
            ? 0.0f
            : *std::max_element (island.amplitudeEnvelope.begin() + island.bodyStartSample,
                                 island.amplitudeEnvelope.begin() + island.bodyEndSample);
        const float entryEnvThreshold = maxBodyEnv * (downwardShift ? 0.12f : (longBody ? 0.18f : 0.15f));
        const float exitEnvThreshold = maxBodyEnv * (downwardShift ? 0.10f : (longBody ? 0.14f : 0.12f));
        const int entrySearchEnd = std::min (island.bodyEndSample,
            island.bodyStartSample + static_cast<int> (std::round ((longBody ? 0.120 : 0.080) * sampleRate)));
        const int exitSearchStart = std::max (island.bodyStartSample,
            island.bodyEndSample - static_cast<int> (std::round ((longBody ? 0.140 : 0.095) * sampleRate)));
        const int sustainSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
        const int voicedEntrySample = findSustainedVoicedSample (
            island.voicedMask,
            island.amplitudeEnvelope,
            island.bodyStartSample,
            entrySearchEnd,
            sustainSamples,
            downwardShift ? 0.42f : 0.48f,
            entryEnvThreshold);
        const int voicedExitSample = findLastSustainedVoicedSample (
            island.voicedMask,
            island.amplitudeEnvelope,
            exitSearchStart,
            island.bodyEndSample,
            sustainSamples,
            downwardShift ? 0.34f : 0.40f,
            exitEnvThreshold);

        std::vector<float> synthMono (static_cast<size_t> (renderSamples), 0.0f);
        const bool useLongUpwardHarmonicCarrier = ! downwardShift && longBody;
        const bool canUseEpochCarrier = island.epochs.size() >= 4 && ! island.monoSignal.empty() && ! useLongUpwardHarmonicCarrier;
        if (canUseEpochCarrier)
        {
            std::vector<int> targetEpochs;
            int targetSample = island.core.startSample;
            while (targetSample < island.core.endSample)
            {
                targetEpochs.push_back (targetSample);
                const int absoluteSample = island.contextStartSample + targetSample;
                const float pitchRatio = getTargetPitchRatioAtSample (absoluteSample, pitchRatios);
                const float sourceHz = island.f0TrackHz.empty()
                    ? island.core.meanF0Hz
                    : std::max (island.f0TrackHz[static_cast<size_t> (juce::jlimit (0, static_cast<int> (island.f0TrackHz.size()) - 1, targetSample))],
                                island.core.meanF0Hz * 0.75f);
                const float targetHz = juce::jlimit (55.0f, 1400.0f, std::max (55.0f, sourceHz) * pitchRatio);
                const int targetPeriod = std::max (16, static_cast<int> (std::round (sampleRate / targetHz)));
                targetSample += targetPeriod;
            }

            const int sourceEpochCount = static_cast<int> (island.epochs.size());
            const int targetEpochCount = static_cast<int> (targetEpochs.size());
            const bool interpolateEpochSources = ! downwardShift && longBody && sourceEpochCount >= 6;
            for (int k = 0; k < targetEpochCount; ++k)
            {
                const float norm = targetEpochCount > 1
                    ? static_cast<float> (k) / static_cast<float> (targetEpochCount - 1)
                    : 0.0f;
                const float sourceEpochPos = norm * static_cast<float> (std::max (0, sourceEpochCount - 1));
                const int sourceEpochIndexLo = juce::jlimit (0, sourceEpochCount - 1,
                    static_cast<int> (std::floor (sourceEpochPos)));
                const int sourceEpochIndexHi = juce::jlimit (0, sourceEpochCount - 1, sourceEpochIndexLo + 1);
                const float sourceEpochFrac = interpolateEpochSources
                    ? juce::jlimit (0.0f, 1.0f, sourceEpochPos - static_cast<float> (sourceEpochIndexLo))
                    : 0.0f;
                const int sourceEpochIndex = interpolateEpochSources
                    ? sourceEpochIndexLo
                    : juce::jlimit (0, sourceEpochCount - 1, static_cast<int> (std::round (sourceEpochPos)));
                const int sourceEpoch = island.epochs[static_cast<size_t> (sourceEpochIndex)];
                const int targetEpoch = targetEpochs[static_cast<size_t> (k)];

                const int prevSource = sourceEpochIndex > 0 ? island.epochs[static_cast<size_t> (sourceEpochIndex - 1)] : sourceEpoch;
                const int nextSource = sourceEpochIndex + 1 < sourceEpochCount ? island.epochs[static_cast<size_t> (sourceEpochIndex + 1)] : sourceEpoch;
                const int sourcePeriod = std::max (16, std::max (nextSource - sourceEpoch, sourceEpoch - prevSource));
                const int sourceEpochHi = island.epochs[static_cast<size_t> (sourceEpochIndexHi)];
                const int prevSourceHi = sourceEpochIndexHi > 0 ? island.epochs[static_cast<size_t> (sourceEpochIndexHi - 1)] : sourceEpochHi;
                const int nextSourceHi = sourceEpochIndexHi + 1 < sourceEpochCount ? island.epochs[static_cast<size_t> (sourceEpochIndexHi + 1)] : sourceEpochHi;
                const int sourcePeriodHi = std::max (16, std::max (nextSourceHi - sourceEpochHi, sourceEpochHi - prevSourceHi));

                const int prevTarget = k > 0 ? targetEpochs[static_cast<size_t> (k - 1)] : targetEpoch;
                const int nextTarget = k + 1 < targetEpochCount ? targetEpochs[static_cast<size_t> (k + 1)] : targetEpoch;
                const int targetPeriod = std::max (16, std::max (nextTarget - targetEpoch, targetEpoch - prevTarget));

                const int blendedSourcePeriod = interpolateEpochSources
                    ? std::max (16, static_cast<int> (std::round (
                        sourcePeriod + (sourcePeriodHi - sourcePeriod) * sourceEpochFrac)))
                    : sourcePeriod;
                const int grainRadius = std::max (16, std::min (blendedSourcePeriod, targetPeriod));
                for (int offset = -grainRadius; offset <= grainRadius; ++offset)
                {
                    const int sourcePos = sourceEpoch + offset;
                    const int targetPos = targetEpoch + offset;
                    if (sourcePos < 0 || sourcePos >= static_cast<int> (island.monoSignal.size()))
                        continue;
                    if (targetPos < localRenderStart || targetPos >= localRenderEnd)
                        continue;

                    float sourceSample = island.monoSignal[static_cast<size_t> (sourcePos)];
                    if (interpolateEpochSources)
                    {
                        const int sourcePosHi = sourceEpochHi + offset;
                        if (sourcePosHi >= 0 && sourcePosHi < static_cast<int> (island.monoSignal.size()))
                        {
                            sourceSample += (island.monoSignal[static_cast<size_t> (sourcePosHi)] - sourceSample) * sourceEpochFrac;
                        }
                    }

                    const float x = static_cast<float> (offset + grainRadius) / static_cast<float> (std::max (1, grainRadius * 2));
                    const float window = 0.5f - 0.5f * std::cos (static_cast<float> (twoPi) * x);
                    const int destIndex = targetPos - localRenderStart;
                    synthMono[static_cast<size_t> (destIndex)] += sourceSample * window;
                }
            }
        }
        else
        {
            std::vector<double> phases (static_cast<size_t> (std::max (1, island.harmonicModel.partialCount)), 0.0);
            for (int i = 0; i < renderSamples; ++i)
            {
                const int localSample = localRenderStart + i;
                const int absoluteSample = island.contextStartSample + localSample;
                const float voiced = island.voicedMask.empty() ? 0.0f : island.voicedMask[static_cast<size_t> (localSample)];
                const float envelope = island.amplitudeEnvelope.empty() ? 0.0f : island.amplitudeEnvelope[static_cast<size_t> (localSample)];

                float sampleValue = 0.0f;
                if (localSample >= island.core.startSample
                    && localSample < island.core.endSample
                    && voiced > 0.05f
                    && island.core.meanF0Hz > 0.0f
                    && island.harmonicModel.partialCount > 0)
                {
                    const float pitchRatio = getTargetPitchRatioAtSample (absoluteSample, pitchRatios);
                    const float sourceHz = island.f0TrackHz.empty()
                        ? island.core.meanF0Hz
                        : std::max (island.f0TrackHz[static_cast<size_t> (localSample)], island.core.meanF0Hz * 0.75f);
                    const float targetHz = juce::jlimit (55.0f, 1400.0f, sourceHz * pitchRatio);
                    const float voicedScale = 0.55f + 0.45f * voiced;

                    for (int p = 0; p < island.harmonicModel.partialCount; ++p)
                    {
                        const double omega = twoPi * static_cast<double> (targetHz * static_cast<float> (p + 1)) / sampleRate;
                        phases[static_cast<size_t> (p)] += omega;
                        if (phases[static_cast<size_t> (p)] > twoPi)
                            phases[static_cast<size_t> (p)] -= twoPi;

                        const float amp = island.harmonicModel.averageMagnitude[static_cast<size_t> (p)];
                        sampleValue += amp * static_cast<float> (std::sin (phases[static_cast<size_t> (p)]));
                    }

                    sampleValue *= envelope * voicedScale;
                }
                else if (! island.monoSignal.empty())
                {
                    sampleValue = island.monoSignal[static_cast<size_t> (localSample)];
                }

                synthMono[static_cast<size_t> (i)] = sampleValue;
            }
        }

        const float synthCoreRms = computeRms (
            synthMono,
            std::max (0, island.core.startSample - localRenderStart),
            std::min (renderSamples, island.core.endSample - localRenderStart));
        const float gain = synthCoreRms > 1.0e-5f ? island.core.rms / synthCoreRms : 1.0f;
        if (std::isfinite (gain))
        {
            for (auto& sample : synthMono)
                sample *= gain;
        }

        std::vector<float> localF0Track (static_cast<size_t> (renderSamples), 0.0f);
        for (int i = 0; i < renderSamples; ++i)
        {
            const int localSample = localRenderStart + i;
            if (localSample >= 0 && localSample < static_cast<int> (island.f0TrackHz.size()))
                localF0Track[static_cast<size_t> (i)] = island.f0TrackHz[static_cast<size_t> (localSample)];
        }

        std::vector<int> localEpochs;
        localEpochs.reserve (island.epochs.size());
        for (const int epoch : island.epochs)
        {
            if (epoch >= localRenderStart && epoch < localRenderEnd)
                localEpochs.push_back (epoch - localRenderStart);
        }

        applySourceFilterCorrection (
            synthMono,
            localF0Track,
            localEpochs,
            std::max (0, island.core.startSample - localRenderStart),
            std::min (renderSamples, island.core.endSample - localRenderStart),
            island.spectralEnvelopeModel,
            island.residualModel,
            sampleRate,
            downwardShift,
            longBody);

        // Keep a light protection low-pass after envelope correction so the
        // preview path stays stable while the source-filter model matures.
        const float alpha = juce::jlimit (0.02f, 0.45f,
            static_cast<float> ((2.0 * juce::MathConstants<double>::pi * cutoffHz) / (sampleRate + 2.0 * juce::MathConstants<double>::pi * cutoffHz)));
        float lp = synthMono.empty() ? 0.0f : synthMono.front();
        for (auto& sample : synthMono)
        {
            lp += alpha * (sample - lp);
            sample = filteredMix * lp + (1.0f - filteredMix) * sample;
        }

        for (int ch = 0; ch < numChannels; ++ch)
        {
            for (int i = 0; i < renderSamples; ++i)
            {
                const int absoluteSample = island.renderStartSample + i;
                if (absoluteSample < 0 || absoluteSample >= numSamples)
                    continue;

                const int localSample = localRenderStart + i;
                const float dry = input[ch][absoluteSample];
                const float voiced = island.voicedMask.empty() ? 0.0f : island.voicedMask[static_cast<size_t> (localSample)];
                const float wet = computeIslandWet (
                    absoluteSample,
                    island.renderStartSample,
                    island.renderEndSample,
                    island.contextStartSample + island.bodyStartSample,
                    island.contextStartSample + island.bodyEndSample,
                    island.contextStartSample + island.core.startSample,
                    island.contextStartSample + island.core.endSample,
                    island.contextStartSample + voicedEntrySample,
                    island.contextStartSample + voicedExitSample,
                    sampleRate,
                    voiced,
                    downwardShift,
                    longBody,
                    coreMaxWet,
                    bodyEntryWet,
                    bodyExitWet,
                    outsideCoreScale);

                result.output[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)]
                    = dry * (1.0f - wet) + synthMono[static_cast<size_t> (i)] * wet;
            }
        }
    }

    result.renderMs = juce::Time::getMillisecondCounterHiRes() - renderStart;

    logOwnPitchEngine ("pitchOnly islands=" + juce::String (static_cast<int> (result.analysis.islands.size()))
        + " cacheHit=" + juce::String (result.analysis.cacheHit ? "true" : "false")
        + " epochs=" + juce::String (result.analysis.totalEpochCount)
        + " maxPartials=" + juce::String (result.analysis.maxPartialCount)
        + " analysisMs=" + juce::String (result.analysisMs, 2)
        + " renderMs=" + juce::String (result.renderMs, 2));

    return result;
}

OwnPitchEngine::RenderResult OwnPitchEngine::renderVocalSourceFilterHq (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& pitchRatios,
    Quality quality,
    std::function<bool()> shouldCancel)
{
    RenderResult result;
    result.vocalSourceFilterUsed = true;
    result.output.resize (static_cast<size_t> (numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        result.output[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);

    const auto layerDumpDir = getVsfLayerDumpDirectory();
    const bool dumpLayers = layerDumpDir != juce::File();
    std::vector<std::vector<float>> dryLayer;
    std::vector<std::vector<float>> coreLayer;
    std::vector<std::vector<float>> residualLayer;
    std::vector<std::vector<float>> wetEnvelopeLayer;
    if (dumpLayers)
    {
        dryLayer = result.output;
        coreLayer.assign (static_cast<size_t> (numChannels), std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
        residualLayer.assign (static_cast<size_t> (numChannels), std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
        wetEnvelopeLayer.assign (static_cast<size_t> (numChannels), std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
    }

    const double analysisStart = juce::Time::getMillisecondCounterHiRes();
    result.analysis = analyze (input, numChannels, numSamples, sampleRate, frames, notes, Mode::PitchOnly, quality);
    result.analysisMs = juce::Time::getMillisecondCounterHiRes() - analysisStart;

    const double renderStart = juce::Time::getMillisecondCounterHiRes();
    const double twoPi = juce::MathConstants<double>::twoPi;
    const float nyquistLimit = static_cast<float> (sampleRate * 0.46);

    int renderedIslandCount = 0;
    int fallbackIslandCount = 0;
    int totalBodySamples = 0;
    int totalVoicedSamples = 0;
    double residualMixSum = 0.0;
    int residualMixCount = 0;
    int maxEntryDrySamples = 0;
    int maxExitDrySamples = 0;

    for (const auto& island : result.analysis.islands)
    {
        if (shouldCancel && shouldCancel())
        {
            result.usedFallback = true;
            result.fallbackReason = "cancelled";
            result.vocalSourceFilterFallbackUsed = true;
            result.vocalSourceFilterFallbackReason = "cancelled";
            break;
        }

        const int localRenderStart = juce::jlimit (0, static_cast<int> (island.monoSignal.size()), island.renderStartSample - island.contextStartSample);
        const int localRenderEnd = juce::jlimit (localRenderStart, static_cast<int> (island.monoSignal.size()), island.renderEndSample - island.contextStartSample);
        const int renderSamples = localRenderEnd - localRenderStart;
        if (renderSamples <= 0)
        {
            ++fallbackIslandCount;
            continue;
        }

        const int bodyStart = juce::jlimit (localRenderStart, localRenderEnd, island.bodyStartSample);
        const int bodyEnd = juce::jlimit (bodyStart, localRenderEnd, island.bodyEndSample);
        int coreStart = juce::jlimit (bodyStart, bodyEnd, island.core.startSample);
        int coreEnd = juce::jlimit (coreStart, bodyEnd, island.core.endSample);
        if (coreEnd - coreStart < static_cast<int> (std::round (0.045 * sampleRate)))
        {
            coreStart = bodyStart;
            coreEnd = bodyEnd;
        }

        if (coreEnd <= coreStart
            || island.core.meanF0Hz <= 0.0f
            || island.harmonicModel.partialCount < 3
            || island.spectralEnvelopeModel.averageMagnitude.empty())
        {
            ++fallbackIslandCount;
            continue;
        }

        float averagePitchRatio = 1.0f;
        if (! island.notes.empty())
        {
            double ratioSum = 0.0;
            for (const auto& note : island.notes)
                ratioSum += std::pow (2.0, static_cast<double> (note.correctedPitch - note.detectedPitch) / 12.0);
            averagePitchRatio = static_cast<float> (ratioSum / static_cast<double> (island.notes.size()));
        }
        const bool downwardShift = averagePitchRatio < 0.999f;
        const float bodyDurationSec = static_cast<float> (std::max (0, bodyEnd - bodyStart)) / static_cast<float> (sampleRate);
        const bool longBody = bodyDurationSec >= 0.90f;
        const float envelopeLookupRatio = downwardShift
            ? juce::jlimit (0.82f, 1.0f, 1.0f + (averagePitchRatio - 1.0f) * 0.55f)
            : 1.0f;

        const float maxBodyEnv = island.amplitudeEnvelope.empty() || bodyEnd <= bodyStart
            ? 0.0f
            : *std::max_element (island.amplitudeEnvelope.begin() + bodyStart,
                                 island.amplitudeEnvelope.begin() + bodyEnd);
        const int sustainSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
        const int entrySearchEnd = std::min (bodyEnd, bodyStart + static_cast<int> (std::round ((longBody ? 0.135 : 0.095) * sampleRate)));
        const int voicedEntrySample = findSustainedVoicedSample (
            island.voicedMask,
            island.amplitudeEnvelope,
            bodyStart,
            entrySearchEnd,
            sustainSamples,
            downwardShift ? 0.36f : 0.42f,
            maxBodyEnv * (downwardShift ? 0.09f : 0.12f));

        const int maxEntryDryByBody = std::max (1, (bodyEnd - bodyStart) / 4);
        const double requestedEntryDrySec = (! longBody && ! downwardShift) ? 0.024 : 0.032;
        const int requestedEntryDrySamples = std::max (1, static_cast<int> (std::round (requestedEntryDrySec * sampleRate)));
        const int baseEntryDrySamples = std::min (requestedEntryDrySamples, maxEntryDryByBody);
        const int maxEntryDryAllowed = std::max (
            baseEntryDrySamples,
            std::min (
                maxEntryDryByBody,
                static_cast<int> (std::round ((longBody ? 0.044 : 0.034) * sampleRate))));
        const int entryDrySamples = juce::jlimit (
            baseEntryDrySamples,
            maxEntryDryAllowed,
            std::max (baseEntryDrySamples, voicedEntrySample - bodyStart));
        const int exitDrySamples = std::max (1, static_cast<int> (std::round ((downwardShift ? 0.012 : 0.014) * sampleRate)));
        const int wetStart = juce::jlimit (bodyStart, bodyEnd, bodyStart + entryDrySamples);
        const int wetEnd = juce::jlimit (wetStart, bodyEnd, bodyEnd - exitDrySamples);
        if (wetEnd <= wetStart)
        {
            ++fallbackIslandCount;
            continue;
        }

        maxEntryDrySamples = std::max (maxEntryDrySamples, wetStart - bodyStart);
        maxExitDrySamples = std::max (maxExitDrySamples, bodyEnd - wetEnd);

        std::vector<float> synthMono (static_cast<size_t> (renderSamples), 0.0f);
        for (int i = 0; i < renderSamples; ++i)
        {
            const int localSample = localRenderStart + i;
            if (localSample >= 0 && localSample < static_cast<int> (island.monoSignal.size()))
                synthMono[static_cast<size_t> (i)] = island.monoSignal[static_cast<size_t> (localSample)];
        }

        const bool useEpochCarrier = island.epochs.size() >= 4;
        if (useEpochCarrier)
        {
            std::vector<float> olaWeight (static_cast<size_t> (renderSamples), 0.0f);
            for (int localSample = wetStart; localSample < wetEnd; ++localSample)
            {
                const int dest = localSample - localRenderStart;
                if (dest >= 0 && dest < renderSamples)
                    synthMono[static_cast<size_t> (dest)] = 0.0f;
            }

            std::vector<int> targetEpochs;
            int targetSample = wetStart;
            while (targetSample < wetEnd)
            {
                targetEpochs.push_back (targetSample);
                const int absoluteSample = island.contextStartSample + targetSample;
                const float pitchRatio = getTargetPitchRatioAtSample (absoluteSample, pitchRatios);
                const float sourceHz = island.f0TrackHz.empty()
                    ? island.core.meanF0Hz
                    : std::max (island.f0TrackHz[static_cast<size_t> (juce::jlimit (0, static_cast<int> (island.f0TrackHz.size()) - 1, targetSample))],
                                island.core.meanF0Hz * 0.70f);
                const float targetHz = juce::jlimit (55.0f, 1400.0f, std::max (55.0f, sourceHz) * pitchRatio);
                const int targetPeriod = std::max (16, static_cast<int> (std::round (sampleRate / targetHz)));
                targetSample += targetPeriod;
            }

            const int sourceEpochCount = static_cast<int> (island.epochs.size());
            const int targetEpochCount = static_cast<int> (targetEpochs.size());
            for (int k = 0; k < targetEpochCount; ++k)
            {
                const float norm = targetEpochCount > 1
                    ? static_cast<float> (k) / static_cast<float> (targetEpochCount - 1)
                    : 0.0f;
                const int sourceEpochIndex = juce::jlimit (0, sourceEpochCount - 1,
                    static_cast<int> (std::round (norm * static_cast<float> (std::max (0, sourceEpochCount - 1)))));
                const int sourceEpoch = island.epochs[static_cast<size_t> (sourceEpochIndex)];
                const int targetEpoch = targetEpochs[static_cast<size_t> (k)];

                const int prevSource = sourceEpochIndex > 0 ? island.epochs[static_cast<size_t> (sourceEpochIndex - 1)] : sourceEpoch;
                const int nextSource = sourceEpochIndex + 1 < sourceEpochCount ? island.epochs[static_cast<size_t> (sourceEpochIndex + 1)] : sourceEpoch;
                const int sourcePeriod = std::max (16, std::max (nextSource - sourceEpoch, sourceEpoch - prevSource));
                const int prevTarget = k > 0 ? targetEpochs[static_cast<size_t> (k - 1)] : targetEpoch;
                const int nextTarget = k + 1 < targetEpochCount ? targetEpochs[static_cast<size_t> (k + 1)] : targetEpoch;
                const int targetPeriod = std::max (16, std::max (nextTarget - targetEpoch, targetEpoch - prevTarget));
                const int maxGrainRadius = std::max (16, static_cast<int> (std::round (0.032 * sampleRate)));
                const int grainRadius = juce::jlimit (16, maxGrainRadius, std::max (sourcePeriod, targetPeriod));

                for (int offset = -grainRadius; offset <= grainRadius; ++offset)
                {
                    const int sourcePos = sourceEpoch + offset;
                    const int targetPos = targetEpoch + offset;
                    if (sourcePos < 0 || sourcePos >= static_cast<int> (island.monoSignal.size()))
                        continue;
                    if (targetPos < wetStart || targetPos >= wetEnd)
                        continue;
                    const int destIndex = targetPos - localRenderStart;
                    if (destIndex < 0 || destIndex >= renderSamples)
                        continue;

                    const float x = static_cast<float> (offset + grainRadius) / static_cast<float> (std::max (1, grainRadius * 2));
                    const float window = 0.5f - 0.5f * std::cos (static_cast<float> (twoPi) * x);
                    synthMono[static_cast<size_t> (destIndex)] += island.monoSignal[static_cast<size_t> (sourcePos)] * window;
                    olaWeight[static_cast<size_t> (destIndex)] += window;
                }
            }

            for (int localSample = wetStart; localSample < wetEnd; ++localSample)
            {
                const int dest = localSample - localRenderStart;
                if (dest < 0 || dest >= renderSamples)
                    continue;

                const float weight = olaWeight[static_cast<size_t> (dest)];
                if (weight > 1.0e-4f)
                    synthMono[static_cast<size_t> (dest)] /= weight;
            }
        }
        else
        {
            std::vector<double> phases (static_cast<size_t> (96), 0.0);
            int envelopeFrameCursor = 0;

            for (int i = 0; i < renderSamples; ++i)
            {
                const int localSample = localRenderStart + i;
                if (localSample < wetStart || localSample >= wetEnd)
                    continue;

                const float voiced = island.voicedMask.empty() ? 0.0f : island.voicedMask[static_cast<size_t> (localSample)];
                const float envelope = island.amplitudeEnvelope.empty() ? 0.0f : island.amplitudeEnvelope[static_cast<size_t> (localSample)];
                if (voiced <= 0.04f || envelope <= 1.0e-6f)
                    continue;

                envelopeFrameCursor = advanceFrameCursor (island.spectralEnvelopeModel.frames, localSample, envelopeFrameCursor);
                const int absoluteSample = island.contextStartSample + localSample;
                const float pitchRatio = getTargetPitchRatioAtSample (absoluteSample, pitchRatios);
                const float sourceHz = island.f0TrackHz.empty()
                    ? island.core.meanF0Hz
                    : std::max (island.f0TrackHz[static_cast<size_t> (juce::jlimit (0, static_cast<int> (island.f0TrackHz.size()) - 1, localSample))],
                                island.core.meanF0Hz * 0.70f);
                const float targetHz = juce::jlimit (55.0f, 1400.0f, std::max (55.0f, sourceHz) * pitchRatio);
                const int partialCount = juce::jlimit (
                    3,
                    static_cast<int> (phases.size()),
                    std::min (36, static_cast<int> (nyquistLimit / std::max (targetHz, 1.0f))));

                float sampleValue = 0.0f;
                float envelopeReference = interpolateEnvelopeMagnitudeAtHz (
                    island.spectralEnvelopeModel,
                    localSample,
                    targetHz / envelopeLookupRatio,
                    envelopeFrameCursor);
                envelopeReference = std::max (envelopeReference, 1.0e-6f);

                for (int p = 0; p < partialCount; ++p)
                {
                    const float harmonicHz = targetHz * static_cast<float> (p + 1);
                    if (harmonicHz >= nyquistLimit)
                        break;

                    const double omega = twoPi * static_cast<double> (harmonicHz) / sampleRate;
                    phases[static_cast<size_t> (p)] += omega;
                    if (phases[static_cast<size_t> (p)] > twoPi)
                        phases[static_cast<size_t> (p)] = std::fmod (phases[static_cast<size_t> (p)], twoPi);

                    const float sourceEnvelope = interpolateEnvelopeMagnitudeAtHz (
                        island.spectralEnvelopeModel,
                        localSample,
                        harmonicHz / envelopeLookupRatio,
                        envelopeFrameCursor);
                    const float harmonicTilt = 1.0f / std::pow (static_cast<float> (p + 1), 0.68f);
                    const float highBandTame = 1.0f - smoothstep01 ((harmonicHz - 2200.0f) / 6200.0f)
                        * (downwardShift ? 0.84f : 0.68f);
                    const float downshiftMidLift = downwardShift
                        ? 1.0f + 0.18f
                            * smoothstep01 ((harmonicHz - 520.0f) / 560.0f)
                            * (1.0f - smoothstep01 ((harmonicHz - 1850.0f) / 1100.0f))
                        : 1.0f;
                    const float amp = std::pow (std::max (sourceEnvelope, 1.0e-8f) / envelopeReference, 0.58f)
                        * harmonicTilt
                        * highBandTame
                        * downshiftMidLift;
                    sampleValue += amp * static_cast<float> (std::sin (phases[static_cast<size_t> (p)]));
                }

                const float voicedScale = 0.42f + 0.58f * juce::jlimit (0.0f, 1.0f, voiced);
                synthMono[static_cast<size_t> (i)] = sampleValue * envelope * voicedScale;
            }
        }

        const int localCoreStart = wetStart - localRenderStart;
        const int localCoreEnd = wetEnd - localRenderStart;
        const float synthCoreRms = computeRms (synthMono, localCoreStart, localCoreEnd);
        const float sourceCoreRms = computeRms (island.monoSignal, wetStart, wetEnd);
        if (synthCoreRms > 1.0e-6f && sourceCoreRms > 1.0e-6f)
        {
            const float targetRmsScale = longBody
                ? (downwardShift ? 0.96f : 0.78f)
                : (downwardShift ? 0.86f : 0.92f);
            const float gain = juce::jlimit (0.20f, 3.5f, (sourceCoreRms * targetRmsScale) / synthCoreRms);
            for (int i = localCoreStart; i < localCoreEnd && i < static_cast<int> (synthMono.size()); ++i)
                synthMono[static_cast<size_t> (i)] *= gain;
        }

        std::vector<float> coreBeforeResidual;
        if (dumpLayers)
            coreBeforeResidual = synthMono;

        const float residualMix = downwardShift
            ? juce::jlimit (0.08f, 0.20f, 0.12f + island.residualModel.voicedMix * 0.35f)
            : juce::jlimit (0.03f, 0.085f, 0.04f + island.residualModel.highBandMix * 0.20f);
        for (int i = 0; i < renderSamples; ++i)
        {
            const int localSample = localRenderStart + i;
            if (localSample < wetStart || localSample >= wetEnd)
                continue;
            const float voiced = juce::jlimit (0.0f, 1.0f, island.voicedMask.empty() ? 0.0f : island.voicedMask[static_cast<size_t> (localSample)]);
            if (! island.residualModel.voicedHighBandResidual.empty())
            {
                const float stableVoiced = smoothstep01 ((voiced - 0.46f) / 0.32f);
                const float voicedResidualGate = (1.0f - stableVoiced) * (downwardShift ? 0.42f : 0.28f);
                synthMono[static_cast<size_t> (i)] += island.residualModel.voicedHighBandResidual[static_cast<size_t> (localSample)]
                    * residualMix
                    * voicedResidualGate;
            }
            if (! island.residualModel.monoResidual.empty())
            {
                const float unvoiced = 1.0f - voiced;
                synthMono[static_cast<size_t> (i)] += island.residualModel.monoResidual[static_cast<size_t> (localSample)] * residualMix * 0.35f * unvoiced;
            }
        }

        std::vector<float> channelGain (static_cast<size_t> (numChannels), 1.0f);
        const float monoRms = std::max (1.0e-6f, computeRms (island.monoSignal, wetStart, wetEnd));
        for (int ch = 0; ch < numChannels; ++ch)
        {
            double sum = 0.0;
            int count = 0;
            for (int localSample = wetStart; localSample < wetEnd; ++localSample)
            {
                const int absoluteSample = island.contextStartSample + localSample;
                if (absoluteSample < 0 || absoluteSample >= numSamples)
                    continue;
                const float value = input[ch][absoluteSample];
                sum += static_cast<double> (value) * value;
                ++count;
            }
            const float channelRms = count > 0 ? std::sqrt (static_cast<float> (sum / static_cast<double> (count))) : monoRms;
            channelGain[static_cast<size_t> (ch)] = juce::jlimit (0.35f, 2.30f, channelRms / monoRms);
        }

        const float coreMaxWet = downwardShift ? 0.96f : 1.0f;
        const int fadeInSamples = std::max (1, static_cast<int> (std::round (0.016 * sampleRate)));
        const int fadeOutSamples = std::max (1, static_cast<int> (std::round ((downwardShift ? 0.030 : 0.036) * sampleRate)));

        std::vector<float> wetEnvelope (static_cast<size_t> (renderSamples), 0.0f);
        const float attackCoeff = static_cast<float> (std::exp (-1.0 / std::max (1.0, 0.010 * sampleRate)));
        const float releaseCoeff = static_cast<float> (std::exp (-1.0 / std::max (1.0, 0.050 * sampleRate)));
        float smoothedVoicedGate = 0.0f;
        for (int i = 0; i < renderSamples; ++i)
        {
            const int localSample = localRenderStart + i;
            if (localSample < wetStart || localSample >= wetEnd)
                continue;

            float wet = coreMaxWet;
            if (localSample < wetStart + fadeInSamples)
            {
                const float t = static_cast<float> (localSample - wetStart) / static_cast<float> (fadeInSamples);
                wet *= equalPowerFadeIn (t);
            }
            if (localSample >= wetEnd - fadeOutSamples)
            {
                const float t = static_cast<float> (wetEnd - localSample) / static_cast<float> (fadeOutSamples);
                wet *= equalPowerFadeOut (1.0f - t);
            }

            const float voiced = island.voicedMask.empty() ? 0.0f : island.voicedMask[static_cast<size_t> (localSample)];
            const float targetGate = smoothstep01 ((voiced - 0.12f) / 0.52f);
            const float coeff = targetGate > smoothedVoicedGate ? attackCoeff : releaseCoeff;
            smoothedVoicedGate = targetGate + (smoothedVoicedGate - targetGate) * coeff;
            const float voicedFloor = downwardShift ? 0.46f : 0.40f;
            wet *= voicedFloor + (1.0f - voicedFloor) * juce::jlimit (0.0f, 1.0f, smoothedVoicedGate);
            wetEnvelope[static_cast<size_t> (i)] = juce::jlimit (0.0f, coreMaxWet, wet);
        }

        for (int ch = 0; ch < numChannels; ++ch)
        {
            for (int i = 0; i < renderSamples; ++i)
            {
                const int localSample = localRenderStart + i;
                const int absoluteSample = island.contextStartSample + localSample;
                if (absoluteSample < 0 || absoluteSample >= numSamples || localSample < wetStart || localSample >= wetEnd)
                    continue;

                const float wet = wetEnvelope[static_cast<size_t> (i)];
                if (wet <= 1.0e-4f)
                    continue;

                const float dry = input[ch][absoluteSample];
                const float wetSample = synthMono[static_cast<size_t> (i)] * channelGain[static_cast<size_t> (ch)];
                if (dumpLayers)
                {
                    const float coreSample = coreBeforeResidual.empty()
                        ? 0.0f
                        : coreBeforeResidual[static_cast<size_t> (i)] * channelGain[static_cast<size_t> (ch)];
                    const float residualSample = wetSample - coreSample;
                    coreLayer[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)] += coreSample * wet;
                    residualLayer[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)] += residualSample * wet;
                    wetEnvelopeLayer[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)] =
                        std::max (wetEnvelopeLayer[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)], wet);
                }
                result.output[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)] =
                    dry * (1.0f - wet) + wetSample * wet;
            }
        }

        const int entryShapeStart = juce::jlimit (
            bodyStart,
            bodyEnd,
            bodyStart + static_cast<int> (std::round (0.012 * sampleRate)));
        const int entryShapeEnd = std::min (bodyEnd, bodyStart + static_cast<int> (std::round (0.140 * sampleRate)));
        if (entryShapeEnd > entryShapeStart)
        {
            const float entryGainDb = -1.5f;
            const float entryGain = std::pow (10.0f, entryGainDb / 20.0f);
            const int gainAttackSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
            const int gainHoldSamples = std::max (1, static_cast<int> (std::round (0.080 * sampleRate)));
            const int gainReleaseSamples = std::max (1, static_cast<int> (std::round (0.060 * sampleRate)));
            const float entryMidCutDb = downwardShift
                ? -12.0f
                : (longBody ? -18.0f : getEnvFloat ("OPENSTUDIO_VSF_SHORT_UP_ENTRY_MID_CUT_DB", -3.0f));
            const float entryMidHz = downwardShift ? 1000.0f : 1300.0f;
            const int eqFadeSamples = std::max (1, static_cast<int> (std::round (0.006 * sampleRate)));
            const int absoluteEntryStart = juce::jlimit (0, numSamples, island.contextStartSample + entryShapeStart);
            const int absoluteEntryEnd = juce::jlimit (absoluteEntryStart, numSamples, island.contextStartSample + entryShapeEnd);

            for (int ch = 0; ch < numChannels; ++ch)
            {
                auto& channel = result.output[static_cast<size_t> (ch)];
                for (int sampleIndex = absoluteEntryStart; sampleIndex < absoluteEntryEnd; ++sampleIndex)
                {
                    const int age = sampleIndex - absoluteEntryStart;
                    const float attackT = juce::jlimit (
                        0.0f,
                        1.0f,
                        static_cast<float> (age) / static_cast<float> (gainAttackSamples));
                    const float releaseT = juce::jlimit (
                        0.0f,
                        1.0f,
                        static_cast<float> (age - gainHoldSamples) / static_cast<float> (gainReleaseSamples));
                    const float trimAmount = attackT * (1.0f - releaseT);
                    const float gain = 1.0f + (entryGain - 1.0f) * trimAmount;
                    channel[static_cast<size_t> (sampleIndex)] *= gain;
                }

                applyPeakingEqToRange (
                    channel,
                    absoluteEntryStart,
                    absoluteEntryEnd,
                    sampleRate,
                    entryMidHz,
                    0.75f,
                    entryMidCutDb,
                    eqFadeSamples);
            }
        }

        for (int localSample = bodyStart; localSample < bodyEnd; ++localSample)
        {
            ++totalBodySamples;
            const float voiced = island.voicedMask.empty() ? 0.0f : island.voicedMask[static_cast<size_t> (localSample)];
            if (voiced > 0.35f)
                ++totalVoicedSamples;
        }
        residualMixSum += residualMix;
        ++residualMixCount;
        ++renderedIslandCount;
    }

    if (renderedIslandCount == 0)
    {
        result.usedFallback = true;
        result.fallbackReason = result.fallbackReason.isEmpty() ? "no_usable_voiced_island" : result.fallbackReason;
        result.vocalSourceFilterFallbackUsed = true;
        result.vocalSourceFilterFallbackReason = result.fallbackReason;
    }
    else if (fallbackIslandCount > 0)
    {
        result.vocalSourceFilterFallbackUsed = true;
        result.vocalSourceFilterFallbackReason = "partial_island_fallback";
    }

    result.vocalSourceFilterVoicedCoverage = totalBodySamples > 0
        ? static_cast<double> (totalVoicedSamples) / static_cast<double> (totalBodySamples)
        : 0.0;
    result.vocalSourceFilterResidualMix = residualMixCount > 0
        ? residualMixSum / static_cast<double> (residualMixCount)
        : 0.0;
    result.vocalSourceFilterEntryDryMs = sampleRate > 0.0
        ? 1000.0 * static_cast<double> (maxEntryDrySamples) / sampleRate
        : 0.0;
    result.vocalSourceFilterExitDryMs = sampleRate > 0.0
        ? 1000.0 * static_cast<double> (maxExitDrySamples) / sampleRate
        : 0.0;
    result.renderMs = juce::Time::getMillisecondCounterHiRes() - renderStart;

    logOwnPitchEngine ("vocalSourceFilter islands=" + juce::String (renderedIslandCount)
        + " fallbackIslands=" + juce::String (fallbackIslandCount)
        + " cacheHit=" + juce::String (result.analysis.cacheHit ? "true" : "false")
        + " voicedCoverage=" + juce::String (result.vocalSourceFilterVoicedCoverage, 3)
        + " residualMix=" + juce::String (result.vocalSourceFilterResidualMix, 3)
        + " entryDryMs=" + juce::String (result.vocalSourceFilterEntryDryMs, 1)
        + " exitDryMs=" + juce::String (result.vocalSourceFilterExitDryMs, 1)
        + " analysisMs=" + juce::String (result.analysisMs, 2)
        + " renderMs=" + juce::String (result.renderMs, 2));

    if (dumpLayers)
    {
        writeOwnPitchLayerDumpWav (layerDumpDir, "vsf_dry_input", dryLayer, sampleRate);
        writeOwnPitchLayerDumpWav (layerDumpDir, "vsf_core_pre_mix", coreLayer, sampleRate);
        writeOwnPitchLayerDumpWav (layerDumpDir, "vsf_residual_noise_layer", residualLayer, sampleRate);
        writeOwnPitchLayerDumpWav (layerDumpDir, "vsf_wet_envelope", wetEnvelopeLayer, sampleRate);
        writeOwnPitchLayerDumpWav (layerDumpDir, "vsf_final_output", result.output, sampleRate);
    }

    return result;
}
