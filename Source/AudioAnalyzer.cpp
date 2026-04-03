/*
  ==============================================================================

    AudioAnalyzer.cpp
    Audio analysis utilities: reverse, transient detection, LUFS measurement

  ==============================================================================
*/

#include "AudioAnalyzer.h"
#include <cmath>
#include <algorithm>

AudioAnalyzer::AudioAnalyzer()
{
    formatManager.registerBasicFormats();
}

AudioAnalyzer::~AudioAnalyzer() {}

// =============================================================================
// Phase 9A: Reverse Audio File
// =============================================================================

juce::String AudioAnalyzer::reverseAudioFile(const juce::String& filePath)
{
    juce::File inputFile(filePath);
    if (!inputFile.existsAsFile())
        return {};

    std::unique_ptr<juce::AudioFormatReader> reader(
        formatManager.createReaderFor(inputFile));
    if (!reader)
        return {};

    auto numSamples = reader->lengthInSamples;
    auto numChannels = (int)reader->numChannels;
    auto sr = reader->sampleRate;

    if (numSamples <= 0)
        return {};

    // Output file: "filename_reversed.wav" in the same directory
    juce::String baseName = inputFile.getFileNameWithoutExtension();
    juce::File outputFile = inputFile.getParentDirectory()
                                .getChildFile(baseName + "_reversed.wav");

    // Read entire source into memory
    juce::AudioBuffer<float> sourceBuffer(numChannels, (int)numSamples);
    reader->read(&sourceBuffer, 0, (int)numSamples, 0, true, true);

    // Create reversed buffer
    juce::AudioBuffer<float> reversedBuffer(numChannels, (int)numSamples);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        const float* src = sourceBuffer.getReadPointer(ch);
        float* dst = reversedBuffer.getWritePointer(ch);
        for (juce::int64 i = 0; i < numSamples; ++i)
        {
            dst[i] = src[numSamples - 1 - i];
        }
    }

    // Write reversed file
    if (outputFile.existsAsFile())
        outputFile.deleteFile();

    juce::WavAudioFormat wavFormat;
    auto outputStream = std::make_unique<juce::FileOutputStream>(outputFile);
    if (outputStream->failedToOpen())
        return {};

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(
            outputStream.get(), sr, numChannels,
            24, {}, 0));

    if (!writer)
        return {};

    outputStream.release(); // Writer takes ownership

    writer->writeFromAudioSampleBuffer(reversedBuffer, 0, (int)numSamples);
    writer.reset(); // Flush and close

    return outputFile.getFullPathName();
}

// =============================================================================
// Phase 9B: Transient Detection (Energy-Based Onset Detection)
// =============================================================================

std::vector<double> AudioAnalyzer::detectTransients(const juce::String& filePath,
                                                     double sensitivity,
                                                     double minGapMs)
{
    std::vector<double> transients;

    juce::File inputFile(filePath);
    if (!inputFile.existsAsFile())
        return transients;

    std::unique_ptr<juce::AudioFormatReader> reader(
        formatManager.createReaderFor(inputFile));
    if (!reader)
        return transients;

    auto numSamples = reader->lengthInSamples;
    auto sr = reader->sampleRate;
    int numChannels = (int)reader->numChannels;

    if (numSamples <= 0 || sr <= 0)
        return transients;

    // Clamp sensitivity: lower sensitivity = more transients
    sensitivity = juce::jlimit(0.1, 1.0, sensitivity);

    // Frame-based energy analysis
    const int frameSize = 512;
    const int hopSize = 256; // 50% overlap
    int minGapSamples = (int)(minGapMs * sr / 1000.0);
    int minGapFrames = std::max(1, minGapSamples / hopSize);

    // Read audio into memory (for files up to ~10 min at 48kHz this is fine)
    int samplesToRead = (int)std::min(numSamples, (juce::int64)(sr * 600)); // Cap at 10 minutes
    juce::AudioBuffer<float> buffer(numChannels, samplesToRead);
    reader->read(&buffer, 0, samplesToRead, 0, true, true);

    // Mix to mono for analysis
    std::vector<float> mono(samplesToRead, 0.0f);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        const float* chData = buffer.getReadPointer(ch);
        for (int i = 0; i < samplesToRead; ++i)
            mono[i] += chData[i];
    }
    float scale = 1.0f / numChannels;
    for (int i = 0; i < samplesToRead; ++i)
        mono[i] *= scale;

    // Compute frame energies
    int numFrames = (samplesToRead - frameSize) / hopSize + 1;
    if (numFrames <= 0)
        return transients;

    std::vector<double> energies(numFrames, 0.0);
    for (int f = 0; f < numFrames; ++f)
    {
        int start = f * hopSize;
        double energy = 0.0;
        for (int i = 0; i < frameSize && (start + i) < samplesToRead; ++i)
        {
            double s = mono[start + i];
            energy += s * s;
        }
        energies[f] = energy / frameSize;
    }

    // Compute spectral flux (energy difference between consecutive frames)
    std::vector<double> flux(numFrames, 0.0);
    for (int f = 1; f < numFrames; ++f)
    {
        double diff = energies[f] - energies[f - 1];
        flux[f] = std::max(0.0, diff); // Only positive (onset) flux
    }

    // Adaptive threshold: running average * sensitivity factor
    // Higher sensitivity = higher threshold = fewer transients
    double thresholdMultiplier = 1.0 + sensitivity * 9.0; // Range: 1.9 to 10.0
    int windowSize = std::max(10, numFrames / 20); // ~5% of total frames

    int lastTransientFrame = -minGapFrames - 1; // Allow first transient

    for (int f = 1; f < numFrames; ++f)
    {
        // Compute local average for adaptive threshold
        int windowStart = std::max(0, f - windowSize);
        int windowEnd = std::min(numFrames, f + windowSize);
        double localAvg = 0.0;
        for (int w = windowStart; w < windowEnd; ++w)
            localAvg += flux[w];
        localAvg /= (windowEnd - windowStart);

        double threshold = localAvg * thresholdMultiplier;

        // Also require a minimum absolute energy to avoid detecting silence
        double minEnergy = 1e-6;

        if (flux[f] > threshold && energies[f] > minEnergy &&
            (f - lastTransientFrame) >= minGapFrames)
        {
            double timeSec = (double)(f * hopSize) / sr;
            transients.push_back(timeSec);
            lastTransientFrame = f;
        }
    }

    return transients;
}

// =============================================================================
// Phase 3.12: Strip Silence — Detect Silent Regions
// =============================================================================

std::vector<AudioAnalyzer::SoundRegion> AudioAnalyzer::detectSilentRegions(
    const juce::String& filePath,
    double thresholdDb,
    double minSilenceMs,
    double minSoundMs,
    double preAttackMs,
    double postReleaseMs)
{
    std::vector<SoundRegion> regions;

    juce::File inputFile(filePath);
    if (!inputFile.existsAsFile())
        return regions;

    std::unique_ptr<juce::AudioFormatReader> reader(
        formatManager.createReaderFor(inputFile));
    if (!reader)
        return regions;

    auto totalSamples = reader->lengthInSamples;
    auto sr = reader->sampleRate;
    int numChannels = (int)reader->numChannels;

    if (totalSamples <= 0 || sr <= 0)
        return regions;

    // Convert parameters from time to samples
    float thresholdLinear = juce::Decibels::decibelsToGain((float)thresholdDb);
    juce::int64 minSilenceSamples = (juce::int64)(minSilenceMs * sr / 1000.0);
    juce::int64 minSoundSamples = (juce::int64)(minSoundMs * sr / 1000.0);
    juce::int64 preAttackSamples = (juce::int64)(preAttackMs * sr / 1000.0);
    juce::int64 postReleaseSamples = (juce::int64)(postReleaseMs * sr / 1000.0);

    // Process in chunks to handle large files
    const int chunkSize = 65536;
    juce::AudioBuffer<float> buffer(numChannels, chunkSize);

    bool inSound = false;
    juce::int64 soundStart = 0;
    juce::int64 silenceStart = 0;

    for (juce::int64 pos = 0; pos < totalSamples; pos += chunkSize)
    {
        int samplesToRead = (int)std::min((juce::int64)chunkSize, totalSamples - pos);
        reader->read(&buffer, 0, samplesToRead, pos, true, true);

        for (int i = 0; i < samplesToRead; ++i)
        {
            // Get peak across all channels
            float peak = 0.0f;
            for (int ch = 0; ch < numChannels; ++ch)
                peak = std::max(peak, std::abs(buffer.getSample(ch, i)));

            bool isAboveThreshold = peak >= thresholdLinear;
            juce::int64 samplePos = pos + i;

            if (!inSound)
            {
                if (isAboveThreshold)
                {
                    // Transition to sound
                    inSound = true;
                    soundStart = samplePos;
                    silenceStart = 0;
                }
            }
            else
            {
                if (!isAboveThreshold)
                {
                    if (silenceStart == 0)
                        silenceStart = samplePos;

                    // Check if silence duration exceeds minimum
                    if ((samplePos - silenceStart) >= minSilenceSamples)
                    {
                        // End of sound region at silence start
                        juce::int64 regionStart = std::max((juce::int64)0, soundStart - preAttackSamples);
                        juce::int64 regionEnd = std::min(totalSamples, silenceStart + postReleaseSamples);

                        if ((regionEnd - regionStart) >= minSoundSamples)
                            regions.push_back({ regionStart, regionEnd });

                        inSound = false;
                        silenceStart = 0;
                    }
                }
                else
                {
                    // Still in sound — reset silence counter
                    silenceStart = 0;
                }
            }
        }
    }

    // Handle trailing sound region
    if (inSound)
    {
        juce::int64 regionStart = std::max((juce::int64)0, soundStart - preAttackSamples);
        juce::int64 regionEnd = totalSamples;

        if ((regionEnd - regionStart) >= minSoundSamples)
            regions.push_back({ regionStart, regionEnd });
    }

    return regions;
}

// =============================================================================
// Phase 9D: LUFS Measurement (ITU-R BS.1770-4)
// =============================================================================

// K-weighting high-shelf filter (Stage 1)
// Coefficients derived from ITU-R BS.1770-4 for 48kHz, adapted for other rates
AudioAnalyzer::KWeightFilter AudioAnalyzer::createHighShelf(double sampleRate)
{
    KWeightFilter f;
    // Pre-computed coefficients for BS.1770-4 high shelf at 48kHz
    // For other sample rates, we use a bilinear transform approximation
    if (std::abs(sampleRate - 48000.0) < 1.0)
    {
        f.b0 = 1.53512485958697;
        f.b1 = -2.69169618940638;
        f.b2 = 1.19839281085285;
        f.a1 = -1.69065929318241;
        f.a2 = 0.73248077421585;
    }
    else
    {
        // Approximate by frequency warping from 48kHz coefficients
        double ratio = 48000.0 / sampleRate;
        double warpedFreq = 2.0 * sampleRate * std::tan(juce::MathConstants<double>::pi * 1681.974450955533 / sampleRate);
        juce::ignoreUnused(warpedFreq);

        // Use a simple high-shelf design: +4dB at high frequencies
        double gain = std::pow(10.0, 4.0 / 40.0); // ~+4dB
        double w0 = 2.0 * juce::MathConstants<double>::pi * 1500.0 / sampleRate;
        double cosW0 = std::cos(w0);
        double sinW0 = std::sin(w0);
        double A = std::sqrt(gain);
        double alpha = sinW0 / 2.0 * std::sqrt((A + 1.0 / A) * (1.0 / 0.7 - 1.0) + 2.0);

        double a0 = (A + 1.0) - (A - 1.0) * cosW0 + 2.0 * std::sqrt(A) * alpha;
        f.b0 = (A * ((A + 1.0) + (A - 1.0) * cosW0 + 2.0 * std::sqrt(A) * alpha)) / a0;
        f.b1 = (-2.0 * A * ((A - 1.0) + (A + 1.0) * cosW0)) / a0;
        f.b2 = (A * ((A + 1.0) + (A - 1.0) * cosW0 - 2.0 * std::sqrt(A) * alpha)) / a0;
        f.a1 = (2.0 * ((A - 1.0) - (A + 1.0) * cosW0)) / a0;
        f.a2 = ((A + 1.0) - (A - 1.0) * cosW0 - 2.0 * std::sqrt(A) * alpha) / a0;

        juce::ignoreUnused(ratio);
    }
    return f;
}

// K-weighting high-pass filter (Stage 2)
AudioAnalyzer::KWeightFilter AudioAnalyzer::createHighPass(double sampleRate)
{
    KWeightFilter f;
    if (std::abs(sampleRate - 48000.0) < 1.0)
    {
        f.b0 = 1.0;
        f.b1 = -2.0;
        f.b2 = 1.0;
        f.a1 = -1.99004745483398;
        f.a2 = 0.99007225036621;
    }
    else
    {
        // High-pass at ~38 Hz
        double w0 = 2.0 * juce::MathConstants<double>::pi * 38.13547087602444 / sampleRate;
        double cosW0 = std::cos(w0);
        double sinW0 = std::sin(w0);
        double alpha = sinW0 / 2.0 * 0.5; // Q = 0.5

        double a0 = 1.0 + alpha;
        f.b0 = ((1.0 + cosW0) / 2.0) / a0;
        f.b1 = (-(1.0 + cosW0)) / a0;
        f.b2 = ((1.0 + cosW0) / 2.0) / a0;
        f.a1 = (-2.0 * cosW0) / a0;
        f.a2 = (1.0 - alpha) / a0;
    }
    return f;
}

AudioAnalyzer::LUFSResult AudioAnalyzer::measureLUFS(const juce::String& filePath,
                                                      double startTime,
                                                      double endTime)
{
    LUFSResult result = { -70.0, -70.0, -70.0, -100.0, 0.0 };

    juce::File inputFile(filePath);
    if (!inputFile.existsAsFile())
        return result;

    std::unique_ptr<juce::AudioFormatReader> reader(
        formatManager.createReaderFor(inputFile));
    if (!reader)
        return result;

    auto sr = reader->sampleRate;
    auto totalSamples = reader->lengthInSamples;
    int numChannels = (int)reader->numChannels;

    if (totalSamples <= 0 || sr <= 0)
        return result;

    // Determine range
    juce::int64 startSample = 0;
    juce::int64 endSample = totalSamples;
    if (endTime > startTime)
    {
        startSample = (juce::int64)(startTime * sr);
        endSample = (juce::int64)(endTime * sr);
        startSample = juce::jlimit((juce::int64)0, totalSamples, startSample);
        endSample = juce::jlimit((juce::int64)0, totalSamples, endSample);
    }

    auto numSamples = endSample - startSample;
    if (numSamples <= 0)
        return result;

    // Read audio into memory
    int samplesToRead = (int)std::min(numSamples, (juce::int64)(sr * 600)); // Cap at 10 min
    juce::AudioBuffer<float> buffer(numChannels, samplesToRead);
    reader->read(&buffer, 0, samplesToRead, startSample, true, true);

    // Apply K-weighting per channel
    std::vector<std::vector<double>> kWeighted(numChannels);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        kWeighted[ch].resize(samplesToRead);
        auto shelf = createHighShelf(sr);
        auto hp = createHighPass(sr);

        const float* chData = buffer.getReadPointer(ch);
        for (int i = 0; i < samplesToRead; ++i)
        {
            double s = shelf.process(chData[i]);
            kWeighted[ch][i] = hp.process(s);
        }
    }

    // True peak detection (4x oversampled peak)
    double maxTruePeak = 0.0;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        const float* chData = buffer.getReadPointer(ch);
        for (int i = 0; i < samplesToRead; ++i)
        {
            double absSample = std::abs(chData[i]);
            if (absSample > maxTruePeak)
                maxTruePeak = absSample;

            // Simple 4x oversampling using linear interpolation for true peak
            if (i > 0)
            {
                for (int os = 1; os < 4; ++os)
                {
                    double interp = chData[i - 1] + (chData[i] - chData[i - 1]) * (os / 4.0);
                    double absInterp = std::abs(interp);
                    if (absInterp > maxTruePeak)
                        maxTruePeak = absInterp;
                }
            }
        }
    }
    result.truePeak = maxTruePeak > 0.0 ? 20.0 * std::log10(maxTruePeak) : -100.0;

    // Gated loudness measurement (BS.1770-4)
    // Block size: 400ms with 75% overlap (100ms hop)
    int blockSize = (int)(0.4 * sr);
    int hopSize = (int)(0.1 * sr);
    if (blockSize <= 0 || hopSize <= 0)
        return result;

    int numBlocks = (samplesToRead - blockSize) / hopSize + 1;
    if (numBlocks <= 0)
        return result;

    // Channel weighting: L=1.0, R=1.0, C=1.0, Ls=1.41, Rs=1.41
    // For stereo, both channels have weight 1.0
    std::vector<double> channelWeight(numChannels, 1.0);

    // Compute per-block loudness
    std::vector<double> blockLoudness(numBlocks);
    for (int b = 0; b < numBlocks; ++b)
    {
        int start = b * hopSize;
        double sumMeanSquare = 0.0;

        for (int ch = 0; ch < numChannels; ++ch)
        {
            double meanSquare = 0.0;
            for (int i = 0; i < blockSize && (start + i) < samplesToRead; ++i)
            {
                double s = kWeighted[ch][start + i];
                meanSquare += s * s;
            }
            meanSquare /= blockSize;
            sumMeanSquare += channelWeight[ch] * meanSquare;
        }

        blockLoudness[b] = -0.691 + 10.0 * std::log10(std::max(sumMeanSquare, 1e-20));
    }

    // Step 1: Absolute gate at -70 LUFS
    double absGate = -70.0;
    double sumAbove = 0.0;
    int countAbove = 0;
    for (int b = 0; b < numBlocks; ++b)
    {
        if (blockLoudness[b] > absGate)
        {
            // Convert back to linear for averaging
            double linear = std::pow(10.0, (blockLoudness[b] + 0.691) / 10.0);
            sumAbove += linear;
            countAbove++;
        }
    }

    if (countAbove == 0)
        return result; // All silence

    double avgAbove = sumAbove / countAbove;
    double relGate = -0.691 + 10.0 * std::log10(std::max(avgAbove, 1e-20)) - 10.0;

    // Step 2: Relative gate
    double sumFinal = 0.0;
    int countFinal = 0;
    for (int b = 0; b < numBlocks; ++b)
    {
        if (blockLoudness[b] > relGate)
        {
            double linear = std::pow(10.0, (blockLoudness[b] + 0.691) / 10.0);
            sumFinal += linear;
            countFinal++;
        }
    }

    if (countFinal > 0)
    {
        double avgFinal = sumFinal / countFinal;
        result.integrated = -0.691 + 10.0 * std::log10(std::max(avgFinal, 1e-20));
    }

    // Short-term LUFS (3-second window, last window)
    int shortTermBlocks = (int)(3.0 * sr / hopSize);
    if (numBlocks >= shortTermBlocks && shortTermBlocks > 0)
    {
        double stSum = 0.0;
        int stCount = 0;
        for (int b = numBlocks - shortTermBlocks; b < numBlocks; ++b)
        {
            double linear = std::pow(10.0, (blockLoudness[b] + 0.691) / 10.0);
            stSum += linear;
            stCount++;
        }
        if (stCount > 0)
        {
            double stAvg = stSum / stCount;
            result.shortTerm = -0.691 + 10.0 * std::log10(std::max(stAvg, 1e-20));
        }
    }

    // Momentary LUFS (400ms window, last window)
    if (numBlocks > 0)
        result.momentary = blockLoudness[numBlocks - 1];

    // Loudness range (simplified: 95th - 10th percentile of short-term loudness)
    if (numBlocks >= 2)
    {
        std::vector<double> sorted = blockLoudness;
        // Filter out silence
        sorted.erase(std::remove_if(sorted.begin(), sorted.end(),
                     [&absGate](double v) { return v <= absGate; }), sorted.end());
        if (sorted.size() >= 2)
        {
            std::sort(sorted.begin(), sorted.end());
            int idx10 = (int)(sorted.size() * 0.10);
            int idx95 = (int)(sorted.size() * 0.95);
            idx95 = std::min(idx95, (int)sorted.size() - 1);
            result.range = sorted[idx95] - sorted[idx10];
        }
    }

    return result;
}
