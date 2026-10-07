#include "PitchDetector.h"
#include <cmath>
#include <algorithm>

PitchDetector::PitchDetector()
{

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
    clearHistory();
}

void PitchDetector::reset()
{
    std::fill(inputBuffer.begin(), inputBuffer.end(), 0.0f);
    writePos = 0;
    samplesAccumulated = 0;
    detectedFreq.store(0.0f, std::memory_order_relaxed);
    confidence.store(0.0f, std::memory_order_relaxed);
    clearHistory();
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
            auto& frame = analysisFrame;
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

                publishFrame(0.0f, 0.0f, rmsDB);
                continue;
            }

            // Run YIN
            float freq = runYIN(frame.data(), frameSize);

            // Store result
            float conf = confidence.load(std::memory_order_relaxed); // set by runYIN

            publishFrame(freq, conf, rmsDB);
        }
    }
}

/**
 * YIN algorithm implementation.
 *
 * 1. Compute difference function d(tau)
 * 2. Compute cumulative mean normalized difference d'(tau)
 * 3. Find first minimum below threshold (classic YIN first-dip heuristic)
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

    // Search only reaches tauMax; interpolation needs one further neighbour.
    // Larger lags cannot affect any normalized value already computed.
    const int computedMaximum = std::min(halfSize - 1, tauMax + 1);
    for (int tau = 1; tau <= computedMaximum; ++tau)
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
            break; // Take first minimum below threshold (YIN first-dip heuristic)
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

void PitchDetector::publishFrame(float frequency, float frameConfidence, float rmsDB) noexcept
{
    const int position = historyWritePos.load(std::memory_order_relaxed);
    auto& slot = history[static_cast<size_t>(position)];
    slot.generation.fetch_add(1);
    slot.frequency.store(frequency); slot.confidence.store(frameConfidence); slot.rmsDB.store(rmsDB);
    slot.generation.fetch_add(1);
    historyWritePos.store((position + 1) % maxHistory, std::memory_order_release);
}

void PitchDetector::clearHistory() noexcept
{
    for (auto& slot : history)
    {
        slot.generation.fetch_add(1); slot.frequency.store(0); slot.confidence.store(0); slot.rmsDB.store(-100); slot.generation.fetch_add(1);
    }
    historyWritePos.store(0, std::memory_order_release);
}

std::vector<PitchDetector::PitchFrame> PitchDetector::getRecentFrames(int maxFrames) const
{
    const int position = historyWritePos.load(std::memory_order_acquire);
    const int count = juce::jlimit(0, maxHistory, maxFrames);
    std::vector<PitchFrame> result; result.reserve(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i)
    {
        const auto& slot = history[static_cast<size_t>((position - count + i + maxHistory) % maxHistory)];
        const auto generation = slot.generation.load();
        const PitchFrame frame {slot.frequency.load(), slot.confidence.load(), slot.rmsDB.load()};
        if ((generation & 1u) == 0u && generation == slot.generation.load()) result.push_back(frame);
    }
    return result;
}
