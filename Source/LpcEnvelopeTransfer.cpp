#include "LpcEnvelopeTransfer.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <complex>

namespace
{
static bool computeLpc (const std::vector<float>& frame,
                        int order,
                        std::vector<float>& lpcOut,
                        float& errorOut)
{
    const int frameSize = static_cast<int> (frame.size());
    if (frameSize <= order + 1 || order <= 0)
        return false;

    std::vector<float> autocorrelation (static_cast<size_t> (order + 1), 0.0f);
    for (int lag = 0; lag <= order; ++lag)
    {
        double sum = 0.0;
        for (int i = 0; i < frameSize - lag; ++i)
            sum += static_cast<double> (frame[static_cast<size_t> (i)])
                * static_cast<double> (frame[static_cast<size_t> (i + lag)]);
        autocorrelation[static_cast<size_t> (lag)] = static_cast<float> (sum);
    }

    if (autocorrelation[0] <= 1.0e-8f)
        return false;

    std::vector<float> a (static_cast<size_t> (order + 1), 0.0f);
    std::vector<float> nextA (static_cast<size_t> (order + 1), 0.0f);
    a[0] = 1.0f;
    float error = autocorrelation[0];

    for (int i = 1; i <= order; ++i)
    {
        double reflectionNumerator = autocorrelation[static_cast<size_t> (i)];
        for (int j = 1; j < i; ++j)
            reflectionNumerator += static_cast<double> (a[static_cast<size_t> (j)])
                * autocorrelation[static_cast<size_t> (i - j)];

        const float reflection = juce::jlimit (
            -0.995f,
            0.995f,
            static_cast<float> (-reflectionNumerator / std::max (1.0e-8, static_cast<double> (error))));
        if (! std::isfinite (reflection))
            return false;
        nextA = a;
        nextA[static_cast<size_t> (i)] = reflection;

        for (int j = 1; j < i; ++j)
        {
            nextA[static_cast<size_t> (j)] = a[static_cast<size_t> (j)] + reflection * a[static_cast<size_t> (i - j)];
            if (! std::isfinite (nextA[static_cast<size_t> (j)]))
                return false;
        }

        error *= std::max (1.0e-5f, 1.0f - reflection * reflection);
        if (! std::isfinite (error) || error <= 0.0f)
            return false;
        a.swap (nextA);
    }

    lpcOut.assign (a.begin() + 1, a.end());
    for (const auto coeff : lpcOut)
    {
        if (! std::isfinite (coeff))
            return false;
    }
    errorOut = std::max (error, 1.0e-8f);
    return true;
}

static void lpcToEnvelope (const std::vector<float>& lpc,
                           float errorPower,
                           int fftSize,
                           std::vector<float>& envelope)
{
    const int halfBins = fftSize / 2 + 1;
    envelope.assign (static_cast<size_t> (halfBins), 1.0f);
    const float gain = std::sqrt (std::max (errorPower, 1.0e-8f));

    for (int bin = 0; bin < halfBins; ++bin)
    {
        const float omega = juce::MathConstants<float>::twoPi
            * static_cast<float> (bin) / static_cast<float> (fftSize);
        std::complex<float> denominator (1.0f, 0.0f);

        for (size_t k = 0; k < lpc.size(); ++k)
        {
            const float phase = -omega * static_cast<float> (k + 1);
            denominator += std::complex<float> (std::cos (phase), std::sin (phase)) * lpc[k];
        }

        const float denomAbs = std::max (std::abs (denominator), 1.0e-5f);
        const float value = gain / denomAbs;
        envelope[static_cast<size_t> (bin)] = std::isfinite (value) ? value : 1.0f;
    }
}
}

bool LpcEnvelopeTransfer::applyToBuffer (std::vector<std::vector<float>>& processed,
                                         const float* const* original,
                                         int numChannels,
                                         int numSamples,
                                         const Settings& settings)
{
    if (numChannels <= 0 || numSamples <= 0 || original == nullptr || processed.size() != static_cast<size_t> (numChannels))
        return false;

    const int fftOrder = juce::jlimit (8, 11, settings.fftOrder);
    const int fftSize = 1 << fftOrder;
    const int hopSize = juce::jlimit (std::max (1, fftSize / 8), fftSize, settings.hopSize);
    const int lpcOrder = juce::jlimit (8, 24, settings.lpcOrder);
    const float epsilonFloor = std::max (1.0e-5f, settings.epsilonFloor);
    const float maxCorrectionGain = std::max (1.0f, settings.maxCorrectionGain);

    juce::dsp::FFT fft (fftOrder);
    std::vector<float> window (static_cast<size_t> (fftSize), 0.0f);
    for (int i = 0; i < fftSize; ++i)
        window[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            juce::MathConstants<float>::twoPi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));

    bool used = false;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& channel = processed[static_cast<size_t> (ch)];
        if (static_cast<int> (channel.size()) != numSamples)
            continue;

        std::vector<float> overlapAdd (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> windowSum (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> inputFrame (static_cast<size_t> (fftSize), 0.0f);
        std::vector<float> outputFrame (static_cast<size_t> (fftSize), 0.0f);
        std::vector<float> inputLpc;
        std::vector<float> outputLpc;
        std::vector<float> inputEnvelope;
        std::vector<float> outputEnvelope;
        std::vector<juce::dsp::Complex<float>> outputTime (static_cast<size_t> (fftSize));
        std::vector<juce::dsp::Complex<float>> outputFreq (static_cast<size_t> (fftSize));
        std::vector<juce::dsp::Complex<float>> correctedTime (static_cast<size_t> (fftSize));

        for (int pos = 0; pos < numSamples; pos += hopSize)
        {
            for (int i = 0; i < fftSize; ++i)
            {
                const int index = pos + i - fftSize / 2;
                const float source = (index >= 0 && index < numSamples) ? original[ch][index] : 0.0f;
                const float target = (index >= 0 && index < numSamples) ? channel[static_cast<size_t> (index)] : 0.0f;
                inputFrame[static_cast<size_t> (i)] = source * window[static_cast<size_t> (i)];
                outputFrame[static_cast<size_t> (i)] = target * window[static_cast<size_t> (i)];
            }

            float inputEnergy = 0.0f;
            float outputEnergy = 0.0f;
            for (int i = 0; i < fftSize; ++i)
            {
                inputEnergy += inputFrame[static_cast<size_t> (i)] * inputFrame[static_cast<size_t> (i)];
                outputEnergy += outputFrame[static_cast<size_t> (i)] * outputFrame[static_cast<size_t> (i)];
            }

            if (inputEnergy < 1.0e-6f || outputEnergy < 1.0e-6f)
            {
                for (int i = 0; i < fftSize; ++i)
                {
                    const int index = pos + i - fftSize / 2;
                    if (index >= 0 && index < numSamples)
                    {
                        const float w = window[static_cast<size_t> (i)];
                        overlapAdd[static_cast<size_t> (index)] += channel[static_cast<size_t> (index)] * w;
                        windowSum[static_cast<size_t> (index)] += w * w;
                    }
                }
                continue;
            }

            float inputError = 0.0f;
            float outputError = 0.0f;
            if (! computeLpc (inputFrame, lpcOrder, inputLpc, inputError)
                || ! computeLpc (outputFrame, lpcOrder, outputLpc, outputError))
            {
                for (int i = 0; i < fftSize; ++i)
                {
                    const int index = pos + i - fftSize / 2;
                    if (index >= 0 && index < numSamples)
                    {
                        const float w = window[static_cast<size_t> (i)];
                        overlapAdd[static_cast<size_t> (index)] += channel[static_cast<size_t> (index)] * w;
                        windowSum[static_cast<size_t> (index)] += w * w;
                    }
                }
                continue;
            }

            lpcToEnvelope (inputLpc, inputError, fftSize, inputEnvelope);
            lpcToEnvelope (outputLpc, outputError, fftSize, outputEnvelope);
            bool validEnvelope = true;
            for (int bin = 0; bin < fftSize / 2 + 1; ++bin)
            {
                if (! std::isfinite (inputEnvelope[static_cast<size_t> (bin)])
                    || ! std::isfinite (outputEnvelope[static_cast<size_t> (bin)]))
                {
                    validEnvelope = false;
                    break;
                }
            }
            if (! validEnvelope)
            {
                for (int i = 0; i < fftSize; ++i)
                {
                    const int index = pos + i - fftSize / 2;
                    if (index >= 0 && index < numSamples)
                    {
                        const float w = window[static_cast<size_t> (i)];
                        overlapAdd[static_cast<size_t> (index)] += channel[static_cast<size_t> (index)] * w;
                        windowSum[static_cast<size_t> (index)] += w * w;
                    }
                }
                continue;
            }

            for (int i = 0; i < fftSize; ++i)
                outputTime[static_cast<size_t> (i)] = { outputFrame[static_cast<size_t> (i)], 0.0f };
            fft.perform (outputTime.data(), outputFreq.data(), false);

            const int halfBins = fftSize / 2 + 1;
            for (int bin = 0; bin < halfBins; ++bin)
            {
                const float correction = juce::jlimit (
                    1.0f / maxCorrectionGain,
                    maxCorrectionGain,
                    (inputEnvelope[static_cast<size_t> (bin)] + epsilonFloor)
                        / (outputEnvelope[static_cast<size_t> (bin)] + epsilonFloor));
                if (! std::isfinite (correction))
                    continue;
                outputFreq[static_cast<size_t> (bin)] *= correction;
                if (bin > 0 && bin < halfBins - 1)
                    outputFreq[static_cast<size_t> (fftSize - bin)] = std::conj (outputFreq[static_cast<size_t> (bin)]);
            }

            fft.perform (outputFreq.data(), correctedTime.data(), true);
            const float inverseScale = 1.0f / static_cast<float> (fftSize);
            for (int i = 0; i < fftSize; ++i)
            {
                const int index = pos + i - fftSize / 2;
                if (index >= 0 && index < numSamples)
                {
                    const float w = window[static_cast<size_t> (i)];
                    const float correctedSample = correctedTime[static_cast<size_t> (i)].real() * inverseScale;
                    if (! std::isfinite (correctedSample))
                        continue;
                    overlapAdd[static_cast<size_t> (index)] += correctedSample * w;
                    windowSum[static_cast<size_t> (index)] += w * w;
                }
            }
            used = true;
        }

        if (used)
        {
            for (int i = 0; i < numSamples; ++i)
            {
                const float normalizer = windowSum[static_cast<size_t> (i)];
                if (normalizer > 1.0e-5f)
                    channel[static_cast<size_t> (i)] = overlapAdd[static_cast<size_t> (i)] / normalizer;
            }
        }
    }

    return used;
}
