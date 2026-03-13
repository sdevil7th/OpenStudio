#include "SignalsmithShifter.h"

// Signalsmith Stretch — MIT license, header-only
// https://github.com/Signalsmith-Audio/signalsmith-stretch
#include "signalsmith-stretch.h"

#include <juce_core/juce_core.h>
#include <cmath>
#include <algorithm>
#include <numeric>

std::vector<std::vector<float>> SignalsmithShifter::process (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios,
    const std::vector<float>& formantRatios)
{
    // Passthrough guard
    if (numSamples <= 0 || numChannels <= 0)
    {
        std::vector<std::vector<float>> result (static_cast<size_t> (numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            result[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
        return result;
    }

    // Check if anything actually needs shifting
    bool hasShift = false;
    for (int s = 0; s < numSamples && ! hasShift; s += 512)
    {
        if (static_cast<size_t> (s) < ratios.size()
            && std::abs (ratios[static_cast<size_t> (s)] - 1.0f) > 1e-4f)
            hasShift = true;
    }

    if (! hasShift)
    {
        // No edits — return input unchanged
        std::vector<std::vector<float>> result (static_cast<size_t> (numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            result[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
        return result;
    }

    // -------------------------------------------------------------------------
    // Configure Signalsmith Stretch
    // presetDefault: blockSamples = sampleRate * 0.12, intervalSamples = sampleRate * 0.03
    // At 44100 Hz: blockSamples ≈ 5292, intervalSamples ≈ 1323 (~30ms per block)
    // -------------------------------------------------------------------------
    signalsmith::stretch::SignalsmithStretch<float> stretcher;
    stretcher.presetDefault (numChannels, static_cast<float> (sampleRate));

    const int blockSize    = stretcher.intervalSamples(); // process this many samples per block
    const int outputLatency = stretcher.outputLatency();

    // We need numSamples of corrected output.
    // Allocate: numSamples + outputLatency (to hold both the main pass and the flush).
    const int totalOutSamples = numSamples + outputLatency;

    std::vector<std::vector<float>> outputBuf (
        static_cast<size_t> (numChannels),
        std::vector<float> (static_cast<size_t> (totalOutSamples), 0.0f));

    // Per-channel pointer vectors reused across blocks
    std::vector<const float*> inPtrs  (static_cast<size_t> (numChannels));
    std::vector<float*>       outPtrs (static_cast<size_t> (numChannels));

    // -------------------------------------------------------------------------
    // Process input in blocks of blockSize, updating pitch ratio per block
    // -------------------------------------------------------------------------
    int pos = 0;
    while (pos < numSamples)
    {
        int thisBlock = std::min (blockSize, numSamples - pos);

        // Average ratio for this block (ratios[] is per-sample)
        float sumRatio = 0.0f;
        int   counted  = 0;
        for (int s = pos; s < pos + thisBlock; ++s)
        {
            if (static_cast<size_t> (s) < ratios.size())
            {
                sumRatio += ratios[static_cast<size_t> (s)];
                ++counted;
            }
        }
        float avgRatio = (counted > 0) ? sumRatio / static_cast<float> (counted) : 1.0f;
        avgRatio = juce::jlimit (0.25f, 4.0f, avgRatio);

        stretcher.setTransposeFactor (avgRatio);

        // Formant compensation:
        //   If the user has explicit per-note formant ratios, use those.
        //   Otherwise, compensate automatically so formants stay at original position.
        //   setFormantFactor(1/pitchRatio) cancels the pitch-induced formant shift.
        if (! formantRatios.empty())
        {
            float sumFormant = 0.0f;
            int   cntFormant = 0;
            for (int s = pos; s < pos + thisBlock; ++s)
            {
                if (static_cast<size_t> (s) < formantRatios.size())
                {
                    sumFormant += formantRatios[static_cast<size_t> (s)];
                    ++cntFormant;
                }
            }
            float avgFormant = (cntFormant > 0) ? sumFormant / static_cast<float> (cntFormant) : 1.0f;
            avgFormant = juce::jlimit (0.25f, 4.0f, avgFormant);
            stretcher.setFormantFactor (avgFormant);
        }
        else
        {
            // Auto-preserve: cancel the pitch shift's effect on formants
            stretcher.setFormantFactor (1.0f / avgRatio);
        }

        // Set input and output pointers for this block
        for (int ch = 0; ch < numChannels; ++ch)
        {
            inPtrs[static_cast<size_t> (ch)]  = input[ch] + pos;
            outPtrs[static_cast<size_t> (ch)] = outputBuf[static_cast<size_t> (ch)].data() + pos;
        }

        stretcher.process (inPtrs, thisBlock, outPtrs, thisBlock);
        pos += thisBlock;
    }

    // -------------------------------------------------------------------------
    // Flush the remaining buffered samples (latency compensation).
    // After processing all numSamples of input, the stretcher still holds
    // outputLatency worth of unread processed samples. Flushing with silence
    // pushes them out.
    // -------------------------------------------------------------------------
    {
        for (int ch = 0; ch < numChannels; ++ch)
            outPtrs[static_cast<size_t> (ch)] = outputBuf[static_cast<size_t> (ch)].data() + numSamples;

        stretcher.flush (outPtrs, outputLatency);
    }

    // -------------------------------------------------------------------------
    // Assemble final output: skip the first outputLatency samples (latency fill),
    // take samples [outputLatency .. outputLatency + numSamples - 1].
    // -------------------------------------------------------------------------
    std::vector<std::vector<float>> result (static_cast<size_t> (numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = outputBuf[static_cast<size_t> (ch)];
        auto& res = result[static_cast<size_t> (ch)];
        res.resize (static_cast<size_t> (numSamples));

        int   srcStart = std::min (outputLatency, numSamples);
        int   srcAvail = totalOutSamples - srcStart; // how many valid samples follow
        int   toCopy   = std::min (numSamples, srcAvail);

        if (toCopy > 0)
            std::copy (out.begin() + srcStart,
                       out.begin() + srcStart + toCopy,
                       res.begin());

        // If latency > numSamples (extremely short clips), the rest stays zero.
    }

    juce::Logger::writeToLog ("SignalsmithShifter: processed " + juce::String (numSamples)
                               + " samples, " + juce::String (numChannels) + " ch, "
                               + "latency=" + juce::String (outputLatency));

    return result;
}
