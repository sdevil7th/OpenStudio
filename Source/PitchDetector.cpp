#include "PitchDetector.h"
#include <cmath>
#include <algorithm>

PitchDetector::PitchDetector()
{
    history.resize(maxHistory);
}

void PitchDetector::prepare(double sr, int /*maxBlockSize*/)
{
    sampleRate = sr;
    inputBuffer.resize(frameSize * 2, 0.0f);
    yinBuffer.resize(frameSize / 2, 0.0f);
    writePos = 0;
    samplesAccumulated = 0;
    detectedFreq.store(0.0f, std::memory_order_relaxed);
    confidence.store(0.0f, std::memory_order_relaxed);
}

void PitchDetector::reset()
{
    std::fill(inputBuffer.begin(), inputBuffer.end(), 0.0f);
    writePos = 0;
    samplesAccumulated = 0;
    detectedFreq.store(0.0f, std::memory_order_relaxed);
    confidence.store(0.0f, std::memory_order_relaxed);
}

void PitchDetector::processSamples(const float* samples, int numSamples)
{
    for (int i = 0; i < numSamples; ++i)
    {
        inputBuffer[static_cast<size_t>(writePos)] = samples[i];
        writePos = (writePos + 1) % static_cast<int>(inputBuffer.size());
        ++samplesAccumulated;

        if (samplesAccumulated >= hopSize)
        {
            samplesAccumulated = 0;

            // Extract frame from ring buffer
            std::vector<float> frame(static_cast<size_t>(frameSize));
            int readPos = (writePos - frameSize + static_cast<int>(inputBuffer.size())) % static_cast<int>(inputBuffer.size());
            for (int j = 0; j < frameSize; ++j)
            {
                frame[static_cast<size_t>(j)] = inputBuffer[static_cast<size_t>((readPos + j) % static_cast<int>(inputBuffer.size()))];
            }

            // Compute RMS
            float sumSq = 0.0f;
            for (int j = 0; j < frameSize; ++j)
                sumSq += frame[static_cast<size_t>(j)] * frame[static_cast<size_t>(j)];
            float rms = std::sqrt(sumSq / static_cast<float>(frameSize));
            float rmsDB = rms > 0.0f ? 20.0f * std::log10(rms) : -100.0f;

            // Skip silent frames
            if (rmsDB < -60.0f)
            {
                detectedFreq.store(0.0f, std::memory_order_relaxed);
                confidence.store(0.0f, std::memory_order_relaxed);

                const std::lock_guard<std::mutex> lock(historyMutex);
                history[static_cast<size_t>(historyWritePos)] = { 0.0f, 0.0f, rmsDB };
                historyWritePos = (historyWritePos + 1) % maxHistory;
                continue;
            }

            // Run YIN
            float freq = runYIN(frame.data(), frameSize);

            // Store result
            float conf = confidence.load(std::memory_order_relaxed); // set by runYIN

            const std::lock_guard<std::mutex> lock(historyMutex);
            history[static_cast<size_t>(historyWritePos)] = { freq, conf, rmsDB };
            historyWritePos = (historyWritePos + 1) % maxHistory;
        }
    }
}

/**
 * YIN algorithm implementation.
 *
 * 1. Compute difference function d(tau)
 * 2. Compute cumulative mean normalized difference d'(tau)
 * 3. Find first minimum below threshold (pYIN approach)
 * 4. Parabolic interpolation for sub-sample accuracy
 */
float PitchDetector::runYIN(const float* frame, int size)
{
    const int halfSize = size / 2;
    const int tauMin = static_cast<int>(sampleRate / maxFreq);
    const int tauMax = std::min(halfSize - 1, static_cast<int>(sampleRate / minFreq));

    if (tauMax <= tauMin || tauMax >= halfSize)
    {
        detectedFreq.store(0.0f, std::memory_order_relaxed);
        confidence.store(0.0f, std::memory_order_relaxed);
        return 0.0f;
    }

    // Step 1 & 2: Difference function + cumulative mean normalization
    yinBuffer[0] = 1.0f;
    float runningSum = 0.0f;

    for (int tau = 1; tau < halfSize; ++tau)
    {
        float sum = 0.0f;
        for (int j = 0; j < halfSize; ++j)
        {
            float delta = frame[j] - frame[j + tau];
            sum += delta * delta;
        }

        runningSum += sum;
        yinBuffer[static_cast<size_t>(tau)] = (runningSum > 0.0f)
            ? sum * static_cast<float>(tau) / runningSum
            : 0.0f;
    }

    // Step 3: Absolute threshold — find first dip below threshold
    int bestTau = -1;
    float bestVal = sensitivityThreshold;

    for (int tau = tauMin; tau <= tauMax; ++tau)
    {
        if (yinBuffer[static_cast<size_t>(tau)] < bestVal)
        {
            // Check if this is a local minimum
            while (tau + 1 <= tauMax && yinBuffer[static_cast<size_t>(tau + 1)] < yinBuffer[static_cast<size_t>(tau)])
                ++tau;

            bestTau = tau;
            bestVal = yinBuffer[static_cast<size_t>(tau)];
            break; // Take first minimum below threshold (pYIN heuristic)
        }
    }

    // If no dip found below threshold, find global minimum in range
    if (bestTau < 0)
    {
        bestVal = yinBuffer[static_cast<size_t>(tauMin)];
        bestTau = tauMin;
        for (int tau = tauMin + 1; tau <= tauMax; ++tau)
        {
            if (yinBuffer[static_cast<size_t>(tau)] < bestVal)
            {
                bestVal = yinBuffer[static_cast<size_t>(tau)];
                bestTau = tau;
            }
        }
    }

    // Step 4: Parabolic interpolation
    float refinedTau = parabolicInterpolation(bestTau);

    // Compute confidence (1 - d'(tau))
    float conf = 1.0f - bestVal;
    conf = juce::jlimit(0.0f, 1.0f, conf);

    float freq = (refinedTau > 0.0f) ? static_cast<float>(sampleRate) / refinedTau : 0.0f;

    // Clamp to valid range
    if (freq < minFreq || freq > maxFreq)
    {
        freq = 0.0f;
        conf = 0.0f;
    }

    detectedFreq.store(freq, std::memory_order_relaxed);
    confidence.store(conf, std::memory_order_relaxed);

    return freq;
}

float PitchDetector::parabolicInterpolation(int tauEstimate) const
{
    if (tauEstimate <= 0 || tauEstimate >= static_cast<int>(yinBuffer.size()) - 1)
        return static_cast<float>(tauEstimate);

    float s0 = yinBuffer[static_cast<size_t>(tauEstimate - 1)];
    float s1 = yinBuffer[static_cast<size_t>(tauEstimate)];
    float s2 = yinBuffer[static_cast<size_t>(tauEstimate + 1)];

    float denom = 2.0f * (2.0f * s1 - s2 - s0);
    if (std::abs(denom) < 1e-10f)
        return static_cast<float>(tauEstimate);

    float adjustment = (s2 - s0) / denom;
    return static_cast<float>(tauEstimate) + adjustment;
}

std::vector<PitchDetector::PitchFrame> PitchDetector::getRecentFrames(int maxFrames) const
{
    const std::lock_guard<std::mutex> lock(historyMutex);

    int count = std::min(maxFrames, maxHistory);
    std::vector<PitchFrame> result;
    result.reserve(static_cast<size_t>(count));

    for (int i = 0; i < count; ++i)
    {
        int idx = (historyWritePos - count + i + maxHistory) % maxHistory;
        result.push_back(history[static_cast<size_t>(idx)]);
    }
    return result;
}
