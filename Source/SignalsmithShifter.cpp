#include "SignalsmithShifter.h"

// Signalsmith Stretch - MIT license, header-only
// https://github.com/Signalsmith-Audio/signalsmith-stretch
#if defined (_MSC_VER)
 #pragma warning (push)
 #pragma warning (disable: 4244 4267 4305 4456)
#endif
#include "signalsmith-stretch.h"
#if defined (_MSC_VER)
 #pragma warning (pop)
#endif

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

static float getPitchOnlyTonalityLimitHz (bool downwardShift)
{
    const auto specificName = downwardShift
        ? "OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ_DOWN"
        : "OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ_UP";
    const auto specificValue = juce::SystemStats::getEnvironmentVariable (specificName, {}).trim();
    if (specificValue.isNotEmpty())
        return juce::jlimit (0.0f, 20000.0f, specificValue.getFloatValue());

    const auto value = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ", {}).trim();
    if (value.isEmpty())
        return 2600.0f;

    return juce::jlimit (0.0f, 20000.0f, value.getFloatValue());
}

static int getSignalsmithExtraLatencyCompSamples (int defaultValue)
{
    const auto value = juce::SystemStats::getEnvironmentVariable (
        "OPENSTUDIO_SIGNALSMITH_EXTRA_LATENCY_COMP_SAMPLES", {}).trim();
    if (value.isEmpty())
        return defaultValue;

    return juce::jlimit (-96000, 96000, value.getIntValue());
}

static double getSignalsmithPitchOnlyExtraLatencyMaxActiveMs()
{
    const auto value = juce::SystemStats::getEnvironmentVariable (
        "OPENSTUDIO_SIGNALSMITH_PITCH_ONLY_EXTRA_LATENCY_MAX_ACTIVE_MS", {}).trim();
    if (value.isEmpty())
        return 850.0;

    return juce::jlimit (0.0, 10000.0, static_cast<double> (value.getDoubleValue()));
}

static int getPitchOnlyActiveShiftSamples (const std::vector<float>& ratios, int numSamples)
{
    int firstActive = numSamples;
    int lastActive = -1;

    for (int s = 0; s < numSamples; ++s)
    {
        const float ratio = static_cast<size_t> (s) < ratios.size()
            ? ratios[static_cast<size_t> (s)]
            : 1.0f;

        if (std::abs (ratio - 1.0f) > 1.0e-4f)
        {
            firstActive = std::min (firstActive, s);
            lastActive = std::max (lastActive, s);
        }
    }

    return lastActive >= firstActive ? (lastActive - firstActive + 1) : 0;
}

std::vector<std::vector<float>> SignalsmithShifter::processPitchOnlyCe33Base (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios,
    PitchOnlyFormantMode formantMode)
{
    return process (input, numChannels, numSamples, sampleRate, ratios, {}, {}, formantMode);
}

std::vector<std::vector<float>> SignalsmithShifter::processPitchOnlyBase (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios,
    const std::vector<float>& detectedPitchHz)
{
    return process (input, numChannels, numSamples, sampleRate, ratios, {}, detectedPitchHz);
}

std::vector<std::vector<float>> SignalsmithShifter::process (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios,
    const std::vector<float>& formantRatios,
    const std::vector<float>& detectedPitchHz,
    PitchOnlyFormantMode pitchOnlyFormantMode)
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

    const bool hasPitchBaseGuidance = ! detectedPitchHz.empty();
    const bool pitchOnlyRender = ! hasFormant;
    const bool useLegacyPitchOnlyPath = pitchOnlyRender && ! hasPitchBaseGuidance;

    // -------------------------------------------------------------------------
    // Configure Signalsmith Stretch
    // Pitch-only without F0 guidance keeps the old stable presetDefault() path.
    // Guided pitch-only and explicit formant work use the custom path so the
    // formant estimator can receive per-block F0 base hints.
    // -------------------------------------------------------------------------
    signalsmith::stretch::SignalsmithStretch<float> stretcher;

    if (useLegacyPitchOnlyPath)
    {
        stretcher.presetDefault (numChannels, static_cast<float> (sampleRate));
    }
    else
    {
        // Offline quality preset: 120ms analysis window (same as presetDefault), 10ms hop.
        int blockSamples    = static_cast<int> (sampleRate * 0.12);
        int intervalSamples = static_cast<int> (sampleRate * 0.01);
        stretcher.configure (numChannels, blockSamples, intervalSamples);
    }

    const int blockSize    = stretcher.intervalSamples(); // process this many samples per block
    const int outputLatency = stretcher.outputLatency();

    // We need numSamples of corrected output.
    // Short pitch-only edits trail the intended note by roughly one additional
    // output-latency window after the stretch reset. Longer sustained edits are
    // already closer with the library's base latency compensation, so keep the
    // extra skip scoped to short active edit spans unless explicitly overridden.
    const int pitchOnlyActiveShiftSamples = pitchOnlyRender ? getPitchOnlyActiveShiftSamples (ratios, numSamples) : 0;
    const double pitchOnlyActiveShiftMs = sampleRate > 0.0
        ? 1000.0 * static_cast<double> (pitchOnlyActiveShiftSamples) / sampleRate
        : 0.0;
    const double extraLatencyMaxActiveMs = getSignalsmithPitchOnlyExtraLatencyMaxActiveMs();
    const bool useDefaultPitchOnlyExtraLatency = pitchOnlyRender
        && pitchOnlyActiveShiftSamples > 0
        && pitchOnlyActiveShiftMs <= extraLatencyMaxActiveMs;
    const int defaultExtraLatencyCompSamples = useDefaultPitchOnlyExtraLatency ? outputLatency : 0;
    const int extraLatencyCompSamples = getSignalsmithExtraLatencyCompSamples (defaultExtraLatencyCompSamples);
    const int latencySkipSamples = juce::jlimit (0, numSamples + outputLatency,
                                                 outputLatency + extraLatencyCompSamples);
    const int totalOutSamples = numSamples + latencySkipSamples;

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
    float minTonalityLimitHz = std::numeric_limits<float>::max();
    float maxTonalityLimitHz = 0.0f;
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

        const bool pitchOnly = ! hasFormant;
        const float tonalityLimitHz = pitchOnly && sampleRate > 0.0
            ? getPitchOnlyTonalityLimitHz (avgRatio < 1.0f)
            : 0.0f;
        if (pitchOnly)
        {
            minTonalityLimitHz = std::min (minTonalityLimitHz, tonalityLimitHz);
            maxTonalityLimitHz = std::max (maxTonalityLimitHz, tonalityLimitHz);
            stretcher.setTransposeFactor (avgRatio, static_cast<float> (tonalityLimitHz / sampleRate));
        }
        else
        {
            stretcher.setTransposeFactor (avgRatio);
        }

        // Provide detected fundamental frequency so the library's formant
        // envelope estimation uses the correct smoothing width.
        // Without this, it uses a "VERY rough" auto-detection that often
        // fails, especially on downward-shifted audio with denser harmonics.
        if (hasPitchBaseGuidance)
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

        // Pitch-only edits keep the original vocal envelope anchored. Explicit
        // formant edits move that preserved envelope by the requested ratio.
        if (hasFormant)
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
            const float targetFormant = avgFormant;
            const float libraryFormant = targetFormant;
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
            const bool legacyNatural = pitchOnlyFormantMode == PitchOnlyFormantMode::LegacyNatural;
            const float targetFormant = legacyNatural ? (1.0f / avgRatio) : 1.0f;
            const float libraryFormant = juce::jlimit (0.25f, 4.0f, targetFormant);
            minTargetFormant = std::min (minTargetFormant, libraryFormant);
            maxTargetFormant = std::max (maxTargetFormant, libraryFormant);
            minLibraryFormant = std::min (minLibraryFormant, libraryFormant);
            maxLibraryFormant = std::max (maxLibraryFormant, libraryFormant);
            if (legacyNatural)
                stretcher.setFormantFactor (libraryFormant);
            else
                stretcher.setFormantFactor (libraryFormant, true);
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

        stretcher.flush (outPtrs, latencySkipSamples);
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

        int   srcStart = std::min (latencySkipSamples, totalOutSamples);
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
                                   + " latencySkip=" + juce::String (latencySkipSamples)
                                   + " formantRange=[" + juce::String (minFormant, 3) + "," + juce::String (maxFormant, 3) + "]"
                                   + " mode=" + juce::String (hasFormant ? "explicit_formant"
                                                                          : (hasPitchBaseGuidance ? "pitch_only_guided"
                                                                                                  : (pitchOnlyFormantMode == PitchOnlyFormantMode::LegacyNatural
                                                                                                      ? "pitch_only_legacy_natural"
                                                                                                      : "pitch_only_neutral_minimal"))));
        if (hasFormant)
        {
            logPitchEditorFormant ("Signalsmith blocks=" + juce::String ((numSamples + blockSize - 1) / blockSize)
                + " avgPitchRange=[" + juce::String (minAvgRatio, 3) + "," + juce::String (maxAvgRatio, 3) + "]"
                + " avgFormantRange=[" + juce::String (minAvgFormant == std::numeric_limits<float>::max() ? 1.0f : minAvgFormant, 3)
                + "," + juce::String (maxAvgFormant, 3) + "]"
                + " requestedFormantRange=[" + juce::String (minTargetFormant == std::numeric_limits<float>::max() ? 1.0f : minTargetFormant, 3)
                + "," + juce::String (maxTargetFormant, 3) + "]"
                + " appliedFormantRange=[" + juce::String (minLibraryFormant == std::numeric_limits<float>::max() ? 1.0f : minLibraryFormant, 3)
                + "," + juce::String (maxLibraryFormant, 3) + "]"
                + " compensatePitch=true"
                + " pitchBaseBlocks=" + juce::String (blocksWithPitchBase)
                + " latency=" + juce::String (outputLatency)
                + " latencySkip=" + juce::String (latencySkipSamples)
                + " copiedSamples=" + juce::String (numSamples));
        }
        else
        {
            logPitchEditorFormant ("Signalsmith pitch-only "
                + juce::String (hasPitchBaseGuidance ? "guided"
                                                      : (pitchOnlyFormantMode == PitchOnlyFormantMode::LegacyNatural
                                                          ? "legacy_natural"
                                                          : "neutral_minimal"))
                + " blocks=" + juce::String ((numSamples + blockSize - 1) / blockSize)
                + " avgPitchRange=[" + juce::String (minAvgRatio, 3) + "," + juce::String (maxAvgRatio, 3) + "]"
                + " appliedFormantRange=[" + juce::String (minTargetFormant == std::numeric_limits<float>::max() ? 1.0f : minTargetFormant, 3)
                + "," + juce::String (maxTargetFormant, 3) + "]"
                + " compensatePitch=" + juce::String (pitchOnlyFormantMode == PitchOnlyFormantMode::LegacyNatural ? "false" : "true")
                + " tonalityLimitHz=[" + juce::String (minTonalityLimitHz == std::numeric_limits<float>::max() ? 0.0f : minTonalityLimitHz, 1)
                + "," + juce::String (maxTonalityLimitHz, 1) + "]"
                + " pitchBaseBlocks=" + juce::String (blocksWithPitchBase)
                + " latency=" + juce::String (outputLatency)
                + " latencySkip=" + juce::String (latencySkipSamples)
                + " activeShiftMs=" + juce::String (pitchOnlyActiveShiftMs, 2)
                + " extraLatencyActiveLimitMs=" + juce::String (extraLatencyMaxActiveMs, 2)
                + " copiedSamples=" + juce::String (numSamples));
        }
    }

    return result;
}
