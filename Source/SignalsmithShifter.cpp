#include "SignalsmithShifter.h"

// Signalsmith Stretch — MIT license, header-only
// https://github.com/Signalsmith-Audio/signalsmith-stretch
#include "signalsmith-stretch.h"

#include <juce_core/juce_core.h>
#include <cmath>
#include <algorithm>
#include <numeric>
#include <limits>

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

std::vector<std::vector<float>> SignalsmithShifter::process (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios,
    const std::vector<float>& formantRatios,
    const std::vector<float>& detectedPitchHz)
{
    // Passthrough guard
    if (numSamples <= 0 || numChannels <= 0)
    {
        std::vector<std::vector<float>> result (static_cast<size_t> (numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            result[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
        return result;
    }

    // Check if anything actually needs shifting (pitch OR formant)
    bool hasShift = false;
    for (int s = 0; s < numSamples && ! hasShift; s += 512)
    {
        if (static_cast<size_t> (s) < ratios.size()
            && std::abs (ratios[static_cast<size_t> (s)] - 1.0f) > 1e-4f)
            hasShift = true;
    }

    // Also check formant ratios — formant-only edits must still be processed
    bool hasFormant = false;
    if (! formantRatios.empty())
    {
        for (int s = 0; s < numSamples && ! hasFormant; s += 512)
        {
            if (static_cast<size_t> (s) < formantRatios.size()
                && std::abs (formantRatios[static_cast<size_t> (s)] - 1.0f) > 1e-4f)
                hasFormant = true;
        }
    }

    if (! hasShift && ! hasFormant)
    {
        // No pitch or formant edits — return input unchanged
        std::vector<std::vector<float>> result (static_cast<size_t> (numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            result[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
        return result;
    }

    const bool useLegacyPitchOnlyPath = ! hasFormant;

    // -------------------------------------------------------------------------
    // Configure Signalsmith Stretch
    // Pitch-only uses the old stable presetDefault() path from 609c5cb.
    // Explicit formant work keeps the newer custom path and pitch-base guidance.
    // -------------------------------------------------------------------------
    signalsmith::stretch::SignalsmithStretch<float> stretcher;

    if (useLegacyPitchOnlyPath)
    {
        stretcher.presetDefault (numChannels, static_cast<float> (sampleRate));
    }
    else
    {
        // Offline quality preset: 120ms analysis window (same as presetDefault), 10ms hop.
        // This newer path is kept only for explicit formant rendering.
        int blockSamples    = static_cast<int> (sampleRate * 0.12);
        int intervalSamples = static_cast<int> (sampleRate * 0.01);
        stretcher.configure (numChannels, blockSamples, intervalSamples);
    }

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
    float minAvgRatio = std::numeric_limits<float>::max();
    float maxAvgRatio = 0.0f;
    float minAvgFormant = std::numeric_limits<float>::max();
    float maxAvgFormant = 0.0f;
    float minTargetFormant = std::numeric_limits<float>::max();
    float maxTargetFormant = 0.0f;
    float minLibraryFormant = std::numeric_limits<float>::max();
    float maxLibraryFormant = 0.0f;
    int blocksWithPitchBase = 0;

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
        minAvgRatio = std::min (minAvgRatio, avgRatio);
        maxAvgRatio = std::max (maxAvgRatio, avgRatio);

        stretcher.setTransposeFactor (avgRatio);

        // Provide detected fundamental frequency so the library's formant
        // envelope estimation uses the correct smoothing width.
        // Without this, it uses a "VERY rough" auto-detection that often
        // fails, especially on downward-shifted audio with denser harmonics.
        if (! useLegacyPitchOnlyPath && ! detectedPitchHz.empty())
        {
            float sumPitch = 0.0f;
            int   cntPitch = 0;
            for (int s = pos; s < pos + thisBlock; ++s)
            {
                if (static_cast<size_t> (s) < detectedPitchHz.size()
                    && detectedPitchHz[static_cast<size_t> (s)] > 0.0f)
                {
                    sumPitch += detectedPitchHz[static_cast<size_t> (s)];
                    ++cntPitch;
                }
            }
            if (cntPitch > 0)
            {
                stretcher.setFormantBase (sumPitch / static_cast<float> (cntPitch));
                ++blocksWithPitchBase;
            }
            else
                stretcher.setFormantBase (0); // fall back to auto-detect
        }

        // Formant handling — two-pass approach:
        //   Pass 1 (here): Signalsmith's built-in compensatePitch=true does
        //   coarse formant preservation using its spectral envelope estimator.
        //   Pass 2 (PitchResynthesizer post-correction): log-domain envelope
        //   matching catches residual formant drift the library missed.
        if (! useLegacyPitchOnlyPath)
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
            const float targetFormant = juce::jlimit (0.25f, 4.0f, avgFormant / avgRatio);
            const float libraryFormant = juce::jlimit (0.35f, 3.5f, targetFormant);
            minAvgFormant = std::min (minAvgFormant, avgFormant);
            maxAvgFormant = std::max (maxAvgFormant, avgFormant);
            minTargetFormant = std::min (minTargetFormant, targetFormant);
            maxTargetFormant = std::max (maxTargetFormant, targetFormant);
            minLibraryFormant = std::min (minLibraryFormant, libraryFormant);
            maxLibraryFormant = std::max (maxLibraryFormant, libraryFormant);
            stretcher.setFormantFactor (libraryFormant, true);
        }
        else
        {
            const float preservedFormant = juce::jlimit (0.25f, 4.0f, 1.0f / avgRatio);
            minTargetFormant = std::min (minTargetFormant, preservedFormant);
            maxTargetFormant = std::max (maxTargetFormant, preservedFormant);
            minLibraryFormant = std::min (minLibraryFormant, preservedFormant);
            maxLibraryFormant = std::max (maxLibraryFormant, preservedFormant);
            stretcher.setFormantFactor (preservedFormant);
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

    {
        float minFormant = 1.0f, maxFormant = 1.0f;
        for (const auto& f : formantRatios) { minFormant = std::min (minFormant, f); maxFormant = std::max (maxFormant, f); }
        juce::Logger::writeToLog ("SignalsmithShifter: processed " + juce::String (numSamples)
                                   + " samples, " + juce::String (numChannels) + " ch, "
                                   + "latency=" + juce::String (outputLatency)
                                   + " formantRange=[" + juce::String (minFormant, 3) + "," + juce::String (maxFormant, 3) + "]"
                                   + " mode=" + juce::String (useLegacyPitchOnlyPath ? "pitch_only_legacy" : "explicit_formant"));
        if (! useLegacyPitchOnlyPath)
        {
            logPitchEditorFormant ("Signalsmith blocks=" + juce::String ((numSamples + blockSize - 1) / blockSize)
                + " avgPitchRange=[" + juce::String (minAvgRatio, 3) + "," + juce::String (maxAvgRatio, 3) + "]"
                + " avgFormantRange=[" + juce::String (minAvgFormant == std::numeric_limits<float>::max() ? 1.0f : minAvgFormant, 3)
                + "," + juce::String (maxAvgFormant, 3) + "]"
                + " targetFormantRange=[" + juce::String (minTargetFormant == std::numeric_limits<float>::max() ? 1.0f : minTargetFormant, 3)
                + "," + juce::String (maxTargetFormant, 3) + "]"
                + " libraryFormantRange=[" + juce::String (minLibraryFormant == std::numeric_limits<float>::max() ? 1.0f : minLibraryFormant, 3)
                + "," + juce::String (maxLibraryFormant, 3) + "]"
                + " pitchBaseBlocks=" + juce::String (blocksWithPitchBase)
                + " latency=" + juce::String (outputLatency)
                + " copiedSamples=" + juce::String (numSamples));
        }
        else
        {
            logPitchEditorFormant ("Signalsmith pitch-only legacy blocks=" + juce::String ((numSamples + blockSize - 1) / blockSize)
                + " avgPitchRange=[" + juce::String (minAvgRatio, 3) + "," + juce::String (maxAvgRatio, 3) + "]"
                + " preservedFormantRange=[" + juce::String (minTargetFormant == std::numeric_limits<float>::max() ? 1.0f : minTargetFormant, 3)
                + "," + juce::String (maxTargetFormant, 3) + "]"
                + " pitchBaseBlocks=" + juce::String (blocksWithPitchBase)
                + " latency=" + juce::String (outputLatency)
                + " copiedSamples=" + juce::String (numSamples));
        }
    }

    return result;
}
