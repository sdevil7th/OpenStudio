#include "PitchDetector.h"
#include <cmath>
#include <algorithm>

PitchDetector::PitchDetector()
{

}

void PitchDetector::prepare(double sr, int /*maxBlockSize*/)
{
    decimation = rateNormalized ? juce::jmax(1, static_cast<int>(std::ceil(sr / 32000.0))) : 1;
    sampleRate = sr / decimation;
    // Windowed-sinc decimator. Compute a convolution only for retained samples;
    // storage and coefficients are prepared off the callback. At 192 kHz this
    // keeps the same 64 ms YIN window and substantially reduces YIN work.
    const int length = decimation > 1 ? 64 * decimation + 1 : 1;
    antiAliasCoefficients.assign(static_cast<size_t>(length), 0);
    // Mirrored history makes the complete newest-to-oldest FIR window
    // contiguous. The convolution keeps its original tap/accumulation order,
    // but no longer branches to wrap the ring for every tap.
    antiAliasHistory.assign(static_cast<size_t>(2 * length), 0);
    const double cutoff = juce::jmin(6000.0, sampleRate * .4) / sr;
    double sum = 0;
    for (int i = 0; i < length; ++i)
    {
        const int offset = i - length / 2;
        const double x = 2 * juce::MathConstants<double>::pi * cutoff * offset;
        const double sinc = offset == 0 ? 2 * cutoff : std::sin(x) / (juce::MathConstants<double>::pi * offset);
        const double window = length == 1 ? 1.0 : .42 - .5 * std::cos(2 * juce::MathConstants<double>::pi * i / (length - 1)) + .08 * std::cos(4 * juce::MathConstants<double>::pi * i / (length - 1));
        antiAliasCoefficients[static_cast<size_t>(i)] = static_cast<float>(sinc * window);
        sum += sinc * window;
    }
    for (auto& coefficient : antiAliasCoefficients) coefficient = static_cast<float>(coefficient / sum);
    decimationPosition = antiAliasPosition = 0;
    inputBuffer.resize(frameSize * 2, 0.0f);
    yinBuffer.resize(frameSize / 2, 0.0f);
    writePos = 0;
    samplesAccumulated = 0;
    pendingTau = 0;
    detectedFreq.store(0.0f, std::memory_order_relaxed);
    confidence.store(0.0f, std::memory_order_relaxed);
    clearHistory();
}

void PitchDetector::reset()
{
    std::fill(antiAliasHistory.begin(), antiAliasHistory.end(), 0.0f);
    decimationPosition = antiAliasPosition = 0;
    std::fill(inputBuffer.begin(), inputBuffer.end(), 0.0f);
    writePos = 0;
    samplesAccumulated = 0;
    pendingTau = 0;
    detectedFreq.store(0.0f, std::memory_order_relaxed);
    confidence.store(0.0f, std::memory_order_relaxed);
    clearHistory();
}

void PitchDetector::processSamples(const float* samples, int numSamples)
{
    for (int i = 0; i < numSamples; ++i)
    {
        float sample = samples[i];
        if (decimation > 1)
        {
            const int length = static_cast<int>(antiAliasCoefficients.size());
            antiAliasHistory[static_cast<size_t>(antiAliasPosition)] = sample;
            antiAliasHistory[static_cast<size_t>(antiAliasPosition + length)] = sample;
            if (++antiAliasPosition == length) antiAliasPosition = 0;
            if (++decimationPosition < decimation) continue;
            decimationPosition = 0;
            sample = 0;
            const float* newest = antiAliasHistory.data() + antiAliasPosition + length - 1;
            for (int tap = 0; tap < length; ++tap)
                sample += antiAliasCoefficients[static_cast<size_t>(tap)] * newest[-tap];
        }
        if (rateNormalized) advanceYIN();
        inputBuffer[static_cast<size_t>(writePos)] = sample;
        writePos = (writePos + 1) % static_cast<int>(inputBuffer.size());
        ++samplesAccumulated;

        if (samplesAccumulated >= hopSize)
        {
            samplesAccumulated = 0;

            // Extract frame from ring buffer
            auto& frame = analysisFrame;
            const int readPos = (writePos - frameSize + static_cast<int>(inputBuffer.size())) % static_cast<int>(inputBuffer.size());
            const int first = juce::jmin(frameSize, static_cast<int>(inputBuffer.size()) - readPos);
            std::copy_n(inputBuffer.data() + readPos, first, frame.data());
            std::copy_n(inputBuffer.data(), frameSize - first, frame.data() + first);

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

            if (rateNormalized)
            {
                // Spread at most two lag dot-products per retained input sample.
                // Every legal search completes before the next 512-sample frame;
                // this adds <= one hop of analysis scheduling, without changing
                // the YIN arithmetic or allocating callback storage.
                pendingMinimum = minFreq; pendingMaximum = maxFreq; pendingRmsDB = rmsDB;
                pendingTauMin = juce::jmax(1, static_cast<int>(sampleRate / maxFreq));
                pendingTauMax = juce::jmin(frameSize / 2 - 1, static_cast<int>(sampleRate / minFreq));
                pendingSum = 0; yinBuffer[0] = 1;
                if (pendingTauMax > pendingTauMin) pendingTau = 1;
                else { detectedFreq.store(0); confidence.store(0); publishFrame(0, 0, rmsDB); }
            }
            else
            {
                const float freq = runYIN(frame.data(), frameSize);
                publishFrame(freq, confidence.load(std::memory_order_relaxed), rmsDB);
            }
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

    return finishYIN(tauMin, tauMax, minFreq, maxFreq);
}

void PitchDetector::advanceYIN() noexcept
{
    if (pendingTau == 0) return;
    const int maximum = juce::jmin(frameSize / 2 - 1, pendingTauMax + 1);
    // Compute adjacent lags together, retaining each sum's original order.
    // This exposes independent accumulators and reuses the first input load;
    // publication still occurs on exactly the same retained input sample.
    if (pendingTau < maximum)
    {
        float first = 0, second = 0;
        const float* frame = analysisFrame.data();
        const float* shifted = frame + pendingTau;
        for (int j = 0; j < frameSize / 2; ++j)
        {
            const float a = frame[j] - shifted[j];
            const float b = frame[j] - shifted[j + 1];
            first += a * a;
            second += b * b;
        }
        pendingSum += first;
        yinBuffer[static_cast<size_t>(pendingTau)] = pendingSum > 0 ? first * static_cast<float>(pendingTau) / pendingSum : 0;
        ++pendingTau;
        pendingSum += second;
        yinBuffer[static_cast<size_t>(pendingTau)] = pendingSum > 0 ? second * static_cast<float>(pendingTau) / pendingSum : 0;
        ++pendingTau;
    }
    else if (pendingTau == maximum)
    {
        float sum = 0;
        for (int j = 0; j < frameSize / 2; ++j)
        {
            const float delta = analysisFrame[static_cast<size_t>(j)] - analysisFrame[static_cast<size_t>(j + pendingTau)];
            sum += delta * delta;
        }
        pendingSum += sum;
        yinBuffer[static_cast<size_t>(pendingTau)] = pendingSum > 0 ? sum * static_cast<float>(pendingTau) / pendingSum : 0;
        ++pendingTau;
    }
    if (pendingTau > maximum)
    {
        pendingTau = 0;
        const float frequency = finishYIN(pendingTauMin, pendingTauMax, pendingMinimum, pendingMaximum);
        publishFrame(frequency, confidence.load(std::memory_order_relaxed), pendingRmsDB);
    }
}

float PitchDetector::finishYIN(int tauMin, int tauMax, float minimum, float maximum)
{
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
    if (freq < minimum || freq > maximum)
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
