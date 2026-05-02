#include "PitchResynthesizer.h"
#include "LpcEnvelopeTransfer.h"
#include "OwnPitchEngine.h"
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <cmath>
#include <algorithm>
#include <complex>
#include <cstring>
#include <limits>
#include <numeric>

static bool shouldEnablePitchEditorFormantDebugLogs()
{
#if JUCE_DEBUG
    return true;
#else
    return juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_DEBUG", {}).trim() == "1";
#endif
}

static void logPitchEditorFormant(const juce::String& message)
{
    if (shouldEnablePitchEditorFormantDebugLogs())
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

static float minimumJerk01 (float x)
{
    x = juce::jlimit (0.0f, 1.0f, x);
    return x * x * x * (10.0f + x * (-15.0f + 6.0f * x));
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

static float mapRequestedFormantRatio (float requestedRatio)
{
    requestedRatio = juce::jlimit (0.25f, 4.0f, requestedRatio);
    if (requestedRatio >= 1.0f)
        return std::pow (requestedRatio, 1.00f);
    return std::pow (requestedRatio, 1.18f);
}

static float sanitizeFiniteFloat (float value, float fallback = 0.0f)
{
    return std::isfinite (value) ? value : fallback;
}

static float getEnvFloat (const char* name, float fallback)
{
    const auto value = juce::SystemStats::getEnvironmentVariable (name, {}).trim();
    if (value.isEmpty())
        return fallback;
    return sanitizeFiniteFloat (value.getFloatValue(), fallback);
}

static int getEnvInt (const char* name, int fallback)
{
    const auto value = juce::SystemStats::getEnvironmentVariable (name, {}).trim();
    if (value.isEmpty())
        return fallback;
    return value.getIntValue();
}

static juce::File getPitchLayerDumpDirectory()
{
    auto path = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_VSF_LAYER_DUMP_DIR", {}).trim();
    if (path.isEmpty())
        path = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_LAYER_DUMP_DIR", {}).trim();
    return path.isEmpty() ? juce::File() : juce::File (path);
}

static bool writePitchLayerDumpWav (
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

static std::vector<std::vector<float>> copyInputChannels (const float* const* input,
                                                          int numChannels,
                                                          int numSamples)
{
    std::vector<std::vector<float>> result (static_cast<size_t> (std::max (0, numChannels)));
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (input == nullptr || input[ch] == nullptr || numSamples <= 0)
            result[static_cast<size_t> (ch)].assign (static_cast<size_t> (std::max (0, numSamples)), 0.0f);
        else
            result[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
    }
    return result;
}

struct PitchEditDirectionSummary
{
    juce::String name = "none";
    bool hasUpward = false;
    bool hasDownward = false;
    bool hasMixed = false;
    float averageShiftSemitones = 0.0f;
};

static PitchEditDirectionSummary getPitchEditDirectionSummary (const std::vector<PitchAnalyzer::PitchNote>& notes)
{
    PitchEditDirectionSummary summary;
    float sum = 0.0f;
    int count = 0;
    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;

        const float shift = note.correctedPitch - note.detectedPitch;
        if (shift > 0.01f)
            summary.hasUpward = true;
        else if (shift < -0.01f)
            summary.hasDownward = true;
        else
            continue;

        sum += shift;
        ++count;
    }

    if (count > 0)
        summary.averageShiftSemitones = sum / static_cast<float> (count);
    summary.hasMixed = summary.hasUpward && summary.hasDownward;
    if (summary.hasMixed)
        summary.name = "mixed";
    else if (summary.hasDownward)
        summary.name = "downward";
    else if (summary.hasUpward)
        summary.name = "upward";
    return summary;
}

static constexpr bool kEnablePitchOnlyStageB = true;

enum class PitchOnlyRendererBranch
{
    SimpleCe33,
    CurrentAdvanced,
    HybridReset,
    HybridStructural,
    AdaptiveSelector,
    EngineV2Program,
    IslandNative,
    IslandNativePsola,
    PsolaCore,
    ModelCore,
    VocalSourceFilterHq,
    OwnEnginePitchOnly,
    OwnEngineFormantOnly,
    OwnEnginePitchPlusFormant,
    EngineV3FullClip,
    EngineV3FullClipLpc,
    EngineV3FullClipLpcTransient
};

enum class PitchOnlyRecoveryPath
{
    LegacyNatural,
    NeutralFormantMinimal,
    CurrentExperimental
};

static PitchOnlyRecoveryPath getPitchOnlyRecoveryPath()
{
    return PitchOnlyRecoveryPath::CurrentExperimental;
}

static const char* getPitchOnlyRecoveryPathName (PitchOnlyRecoveryPath path)
{
    juce::ignoreUnused (path);
    return "native_vsf_only";
}

static PitchOnlyRendererBranch getPitchOnlyRendererBranch()
{
    const auto branch = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_RENDERER_BRANCH", {})
        .trim()
        .toLowerCase();

    if (branch == "pitch_only_vocal_source_filter_hq"
        || branch == "vocal_source_filter_hq"
        || branch == "vocal_source_filter"
        || branch == "source_filter_hq")
    {
        return PitchOnlyRendererBranch::VocalSourceFilterHq;
    }

    if (branch.isNotEmpty())
        logPitchEditorFormant ("ignoring retired pitch renderer branch override: " + branch);

    return PitchOnlyRendererBranch::VocalSourceFilterHq;
}

static const char* getPitchOnlyRendererBranchName (PitchOnlyRendererBranch branch)
{
    juce::ignoreUnused (branch);
    return "pitch_only_vocal_source_filter_hq";
}

static bool isEngineV3Branch (PitchOnlyRendererBranch branch)
{
    return branch == PitchOnlyRendererBranch::EngineV3FullClip
        || branch == PitchOnlyRendererBranch::EngineV3FullClipLpc
        || branch == PitchOnlyRendererBranch::EngineV3FullClipLpcTransient;
}

static bool shouldUseEngineV3LpcTransfer (PitchOnlyRendererBranch branch)
{
    juce::ignoreUnused (branch);
    return false;
}

static bool shouldUseEngineV3TransientBypass (PitchOnlyRendererBranch branch)
{
    return branch == PitchOnlyRendererBranch::EngineV3FullClipLpcTransient;
}

juce::String PitchResynthesizer::getRequestedPitchRendererBranchName()
{
    return juce::String (getPitchOnlyRendererBranchName (getPitchOnlyRendererBranch()));
}

static float getPitchOnlyStageBWetScale (PitchOnlyRendererBranch rendererBranch, bool downwardShift)
{
    const auto specificName = downwardShift
        ? "OPENSTUDIO_PITCH_STAGEB_SCALE_DOWN"
        : "OPENSTUDIO_PITCH_STAGEB_SCALE_UP";
    const auto specificValue = juce::SystemStats::getEnvironmentVariable (specificName, {}).trim();
    if (specificValue.isNotEmpty())
        return juce::jlimit (0.0f, 4.0f, specificValue.getFloatValue());

    const auto globalValue = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_STAGEB_SCALE", {}).trim();
    if (globalValue.isNotEmpty())
        return juce::jlimit (0.0f, 4.0f, globalValue.getFloatValue());

    if (rendererBranch == PitchOnlyRendererBranch::SimpleCe33)
        return 0.0f;

    if (rendererBranch == PitchOnlyRendererBranch::HybridReset
        || rendererBranch == PitchOnlyRendererBranch::HybridStructural)
        return downwardShift ? 0.45f : 0.20f;

    return downwardShift ? 1.5f : 1.25f;
}

static OwnPitchEngine::Quality toOwnEngineQuality (PitchResynthesizer::RenderQuality renderQuality)
{
    return renderQuality == PitchResynthesizer::RenderQuality::PreviewFast
        ? OwnPitchEngine::Quality::PreviewFast
        : OwnPitchEngine::Quality::FinalHQ;
}

static float getAverageEditedNoteDurationSec (const std::vector<PitchAnalyzer::PitchNote>& notes)
{
    float durationSum = 0.0f;
    int durationCount = 0;
    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;
        durationSum += std::max (0.0f, note.endTime - note.startTime);
        ++durationCount;
    }

    return durationCount > 0 ? durationSum / static_cast<float> (durationCount) : 0.0f;
}

struct HybridBridgeDiagnostics
{
    bool bridgeUsed = false;
    bool bridgeFallbackUsed = false;
    int bridgeStartSample = 0;
    int bridgeLengthSamples = 0;
    int bridgeAlignmentLagSamples = 0;
    float bridgeCorrelationScore = 0.0f;
    float bridgeGainDeltaDb = 0.0f;
};

struct HybridBodyReplacementDiagnostics
{
    bool bodyReplacementUsed = false;
    bool bodyReplacementFallbackUsed = false;
    int entryLockStartSample = 0;
    int entryLockLengthSamples = 0;
    int exitLockStartSample = 0;
    int renderedBodyStartSample = 0;
    int renderedBodyEndSample = 0;
};

struct HybridStructuralBlendResult
{
    std::vector<std::vector<float>> output;
    HybridBridgeDiagnostics diagnostics;
    HybridBodyReplacementDiagnostics bodyReplacementDiagnostics;
    struct IslandNativeDiagnostics
    {
        bool islandNativeUsed = false;
        bool islandNativeFallbackUsed = false;
        int islandRenderStartSample = 0;
        int islandRenderEndSample = 0;
        float transientMaskPeak = 0.0f;
        float voicedCoreMaskPeak = 0.0f;
    } islandNativeDiagnostics;
    struct HpssDiagnostics
    {
        bool hpssUsed = false;
        bool hpssFallbackUsed = false;
        int islandRenderStartSample = 0;
        int islandRenderEndSample = 0;
        float transientMaskPeak = 0.0f;
        float harmonicMaskPeak = 0.0f;
        float aperiodicMaskPeak = 0.0f;
        bool spectralEnvelopeCorrectionUsed = false;
    } hpssDiagnostics;
};

struct EngineV2ScaffoldDiagnostics
{
    bool engineV2Used = false;
    bool engineV2FallbackUsed = false;
    int transitionCount = 0;
    int firstTransitionStartSample = 0;
    int lastTransitionEndSample = 0;
    float harmonicSupportPeak = 0.0f;
    float residualSupportPeak = 0.0f;
    float envelopeSupportPeak = 0.0f;
};

static bool isUpwardEditedNote (const PitchAnalyzer::PitchNote& note)
{
    return hasPitchStyleEdit (note) && (note.correctedPitch - note.detectedPitch) > 0.01f;
}

static EngineV2ScaffoldDiagnostics buildEngineV2ScaffoldDiagnostics (
    const OwnPitchEngine::SharedAnalysis& analysis,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    double sampleRate)
{
    juce::ignoreUnused (notes);
    EngineV2ScaffoldDiagnostics diagnostics;

    if (analysis.islands.empty() || sampleRate <= 0.0)
    {
        diagnostics.engineV2FallbackUsed = true;
        return diagnostics;
    }

    for (const auto& island : analysis.islands)
    {
        bool islandHasEligibleNote = false;
        for (const auto& note : island.notes)
        {
            if (! isUpwardEditedNote (note))
                continue;
            islandHasEligibleNote = true;
            break;
        }

        if (! islandHasEligibleNote)
            continue;

        diagnostics.engineV2Used = true;
        diagnostics.transitionCount += 1;

        const int transitionLeadSamples = std::max (1, static_cast<int> (std::round (0.030 * sampleRate)));
        const int transitionTailSamples = std::max (1, static_cast<int> (std::round (0.060 * sampleRate)));
        const int absoluteBodyStartSample = island.contextStartSample + island.bodyStartSample;
        const int absoluteBodyEndSample = island.contextStartSample + island.bodyEndSample;
        const int transitionStart = std::max (island.renderStartSample, absoluteBodyStartSample - transitionLeadSamples);
        const int transitionEnd = std::min (island.renderEndSample, absoluteBodyEndSample + transitionTailSamples);

        if (diagnostics.transitionCount == 1)
        {
            diagnostics.firstTransitionStartSample = transitionStart;
            diagnostics.lastTransitionEndSample = transitionEnd;
        }
        else
        {
            diagnostics.firstTransitionStartSample = std::min (diagnostics.firstTransitionStartSample, transitionStart);
            diagnostics.lastTransitionEndSample = std::max (diagnostics.lastTransitionEndSample, transitionEnd);
        }

        const int localStart = std::max (0, transitionStart - island.contextStartSample);
        const int localEnd = std::min (static_cast<int> (island.voicedMask.size()), transitionEnd - island.contextStartSample);

        for (int i = localStart; i < localEnd; ++i)
        {
            const float voicedSupport = i < static_cast<int> (island.voicedMask.size())
                ? island.voicedMask[static_cast<size_t> (i)]
                : 0.0f;
            const float envelope = i < static_cast<int> (island.amplitudeEnvelope.size())
                ? island.amplitudeEnvelope[static_cast<size_t> (i)]
                : 0.0f;
            diagnostics.harmonicSupportPeak = std::max (diagnostics.harmonicSupportPeak, voicedSupport);
            diagnostics.envelopeSupportPeak = std::max (diagnostics.envelopeSupportPeak, envelope);
        }

        diagnostics.residualSupportPeak = std::max (
            diagnostics.residualSupportPeak,
            std::max (island.residualModel.suggestedMix,
                      std::max (island.residualModel.voicedMix, island.residualModel.highBandMix)));

        if (! island.spectralEnvelopeModel.averageMagnitude.empty())
        {
            const auto peakIt = std::max_element (island.spectralEnvelopeModel.averageMagnitude.begin(),
                                                  island.spectralEnvelopeModel.averageMagnitude.end());
            if (peakIt != island.spectralEnvelopeModel.averageMagnitude.end())
                diagnostics.envelopeSupportPeak = std::max (diagnostics.envelopeSupportPeak, *peakIt);
        }
    }

    if (! diagnostics.engineV2Used)
        diagnostics.engineV2FallbackUsed = true;

    return diagnostics;
}

struct EngineV2ProgramRenderResult
{
    std::vector<std::vector<float>> output;
    EngineV2ScaffoldDiagnostics diagnostics;
    bool spectralEnvelopeCorrectionUsed = false;
    bool transientBypassUsed = false;
    bool residualCarryUsed = false;
    int cepstralCutoffUsed = 0;
    int fftSizeUsed = 0;
    int hopSizeUsed = 0;
};

static const PitchAnalyzer::PitchNote* findEngineV2LeadUpwardNote (
    const OwnPitchEngine::NoteIslandAnalysis& island)
{
    const PitchAnalyzer::PitchNote* best = nullptr;
    float bestShift = 0.0f;
    for (const auto& note : island.notes)
    {
        const float shift = note.correctedPitch - note.detectedPitch;
        if (shift <= 0.01f)
            continue;
        if (best == nullptr || shift > bestShift)
        {
            best = &note;
            bestShift = shift;
        }
    }
    return best;
}

static std::vector<float> buildEngineV2SpectralFlatnessMask (
    const std::vector<float>& monoSignal,
    int startSample,
    int endSample,
    double sampleRate,
    float flatnessCenter = 0.38f,
    float flatnessWidth = 0.20f,
    float minRms = 0.003f,
    float rmsWidth = 0.020f)
{
    const int signalSamples = static_cast<int> (monoSignal.size());
    std::vector<float> mask (static_cast<size_t> (signalSamples), 0.0f);
    std::vector<float> weight (static_cast<size_t> (signalSamples), 0.0f);
    if (signalSamples <= 0 || endSample <= startSample || sampleRate <= 0.0)
        return mask;

    const int fftOrder = 9;
    const int fftSize = 1 << fftOrder;
    const int halfBins = fftSize / 2 + 1;
    const int hopSize = fftSize / 4;
    juce::dsp::FFT fft (fftOrder);
    std::vector<float> hann (static_cast<size_t> (fftSize), 0.0f);
    for (int i = 0; i < fftSize; ++i)
        hann[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            juce::MathConstants<float>::twoPi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));

    std::vector<juce::dsp::Complex<float>> fftIn (static_cast<size_t> (fftSize));
    std::vector<juce::dsp::Complex<float>> fftOut (static_cast<size_t> (fftSize));
    const int paddedStart = std::max (0, startSample - fftSize / 2);
    const int paddedEnd = std::min (signalSamples, endSample + fftSize / 2);

    for (int pos = paddedStart; pos < paddedEnd; pos += hopSize)
    {
        double logSum = 0.0;
        double magSum = 0.0;
        double rmsSum = 0.0;
        int rmsCount = 0;
        for (int i = 0; i < fftSize; ++i)
        {
            const int idx = pos + i;
            const float sample = (idx >= 0 && idx < signalSamples)
                ? monoSignal[static_cast<size_t> (idx)] * hann[static_cast<size_t> (i)]
                : 0.0f;
            fftIn[static_cast<size_t> (i)] = { sample, 0.0f };
            rmsSum += static_cast<double> (sample) * sample;
            ++rmsCount;
        }

        fft.perform (fftIn.data(), fftOut.data(), false);
        for (int bin = 1; bin < halfBins; ++bin)
        {
            const float mag = std::max (1.0e-8f, std::abs (fftOut[static_cast<size_t> (bin)]));
            logSum += std::log (mag);
            magSum += mag;
        }

        const float rms = rmsCount > 0 ? std::sqrt (static_cast<float> (rmsSum / static_cast<double> (rmsCount))) : 0.0f;
        const float geometricMean = std::exp (static_cast<float> (logSum / static_cast<double> (std::max (1, halfBins - 1))));
        const float arithmeticMean = static_cast<float> (magSum / static_cast<double> (std::max (1, halfBins - 1)));
        const float flatness = arithmeticMean > 1.0e-8f ? geometricMean / arithmeticMean : 0.0f;
        const float energyGate = smoothstep01 ((rms - minRms) / std::max (1.0e-5f, rmsWidth));
        const float bypass = smoothstep01 ((flatness - flatnessCenter) / std::max (0.02f, flatnessWidth)) * energyGate;
        const int frameStart = std::max (startSample, pos);
        const int frameEnd = std::min (endSample, pos + hopSize);
        for (int s = frameStart; s < frameEnd; ++s)
        {
            mask[static_cast<size_t> (s)] += bypass;
            weight[static_cast<size_t> (s)] += 1.0f;
        }
    }

    for (size_t i = 0; i < mask.size(); ++i)
    {
        if (weight[i] > 0.0f)
            mask[i] = juce::jlimit (0.0f, 1.0f, mask[i] / weight[i]);
    }
    return mask;
}

static bool applyEngineV2CepstralEnvelopeRestore (
    std::vector<float>& processed,
    const std::vector<float>& original,
    const std::vector<float>& voicedSupport,
    const std::vector<float>& detectedPitchHz,
    int coreStartSample,
    int coreEndSample,
    double sampleRate,
    int* usedLifterCutoffOut = nullptr,
    int* usedFftSizeOut = nullptr,
    int* usedHopSizeOut = nullptr,
    float lifterScale = 0.36f,
    float correctionStrengthBase = 0.54f,
    float correctionStrengthSlope = 0.18f,
    float maxCorrectionDb = 0.0f,
    int fixedLifterCutoff = 0);

struct AdaptiveBoundaryCorrectionResult
{
    std::vector<std::vector<float>> output;
    bool used = false;
    bool spectralEnvelopeCorrectionUsed = false;
    bool transientBypassUsed = false;
    bool residualCarryUsed = false;
    int cepstralCutoffUsed = 0;
    int fftSizeUsed = 0;
    int hopSizeUsed = 0;
    float transientMaskPeak = 0.0f;
    float voicedSupportPeak = 0.0f;
};

static AdaptiveBoundaryCorrectionResult applyAdaptiveBoundaryCorrections (
    const float* const* originalInput,
    const std::vector<std::vector<float>>& adaptiveOutput,
    const OwnPitchEngine::SharedAnalysis& analysis,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& pitchRatios,
    int numChannels,
    int numSamples,
    double sampleRate)
{
    juce::ignoreUnused (notes);

    AdaptiveBoundaryCorrectionResult result;
    result.output = adaptiveOutput;

    if (analysis.islands.empty() || numChannels <= 0 || numSamples <= 0 || sampleRate <= 0.0)
        return result;

    const float flatnessCenter = getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_FLATNESS_CENTER", 0.31f);
    const float flatnessWidth = getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_FLATNESS_WIDTH", 0.15f);
    const float minRms = getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_MIN_RMS", 0.0035f);
    const float rmsWidth = getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_RMS_WIDTH", 0.018f);
    const float entryCrossfadeMs = juce::jlimit (5.0f, 15.0f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_ENTRY_CROSSFADE_MS", 8.0f));
    const float exitCrossfadeMs = juce::jlimit (5.0f, 18.0f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_EXIT_CROSSFADE_MS", 15.0f));
    const float entryBiasMs = juce::jlimit (-8.0f, 8.0f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_ENTRY_BIAS_MS", -5.0f));
    const float entryCoreWet = juce::jlimit (0.04f, 0.28f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_ENTRY_CORE_WET", 0.065f));
    const float exitCoreWet = juce::jlimit (0.02f, 0.20f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_EXIT_CORE_WET", 0.035f));
    const float entryResidualWet = juce::jlimit (0.0f, 0.08f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_ENTRY_RESIDUAL_WET", 0.0f));
    const float exitResidualWet = juce::jlimit (0.0f, 0.06f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_EXIT_RESIDUAL_WET", 0.0f));
    const float entryLeadMs = juce::jlimit (6.0f, 28.0f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_ENTRY_PRE_MS", 8.0f));
    const float entryTailMs = juce::jlimit (18.0f, 80.0f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_ENTRY_POST_MS", 30.0f));
    const float exitLeadMs = juce::jlimit (14.0f, 70.0f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_EXIT_PRE_MS", 26.0f));
    const float exitTailMs = juce::jlimit (4.0f, 20.0f, getEnvFloat ("OPENSTUDIO_PITCH_ADAPTIVE_EXIT_POST_MS", 8.0f));
    const float cepstralLifterScale = juce::jlimit (0.24f, 0.60f, getEnvFloat ("OPENSTUDIO_PITCH_CEPSTRAL_LIFTER_SCALE", 0.36f));
    const float cepstralStrengthBase = juce::jlimit (0.30f, 0.80f, getEnvFloat ("OPENSTUDIO_PITCH_CEPSTRAL_STRENGTH_BASE", 0.54f));
    const float cepstralStrengthSlope = juce::jlimit (0.05f, 0.35f, getEnvFloat ("OPENSTUDIO_PITCH_CEPSTRAL_STRENGTH_SLOPE", 0.18f));
    const int entryLeadSamples = std::max (1, static_cast<int> (std::round (entryLeadMs * 0.001 * sampleRate)));
    const int entryTailSamples = std::max (1, static_cast<int> (std::round (entryTailMs * 0.001 * sampleRate)));
    const int exitLeadSamples = std::max (1, static_cast<int> (std::round (exitLeadMs * 0.001 * sampleRate)));
    const int exitTailSamples = std::max (1, static_cast<int> (std::round (exitTailMs * 0.001 * sampleRate)));

    auto applyWindow = [&] (
        const OwnPitchEngine::NoteIslandAnalysis& island,
        int windowStart,
        int windowEnd,
        int focusCenterSample,
        bool isEntryWindow)
    {
        const int transitionStart = juce::jlimit (0, numSamples, windowStart);
        const int transitionEnd = juce::jlimit (transitionStart, numSamples, windowEnd);
        const int transitionSamples = transitionEnd - transitionStart;
        if (transitionSamples <= 64)
            return;
        const float windowCrossfadeMs = isEntryWindow ? entryCrossfadeMs : exitCrossfadeMs;
        const float windowCoreWet = isEntryWindow ? entryCoreWet : exitCoreWet;
        const float windowResidualWet = isEntryWindow ? entryResidualWet : exitResidualWet;
        const int outerFadeSamples = std::max (1, static_cast<int> (std::round (windowCrossfadeMs * 0.001 * sampleRate)));

        const int localIslandStart = juce::jlimit (0, static_cast<int> (island.monoSignal.size()), transitionStart - island.contextStartSample);
        const int localIslandEnd = juce::jlimit (localIslandStart, static_cast<int> (island.monoSignal.size()), transitionEnd - island.contextStartSample);
        auto flatnessMask = buildEngineV2SpectralFlatnessMask (
            island.monoSignal,
            localIslandStart,
            localIslandEnd,
            sampleRate,
            flatnessCenter,
            flatnessWidth,
            minRms,
            rmsWidth);

        const float maxEnvelope = (localIslandEnd > localIslandStart && ! island.amplitudeEnvelope.empty())
            ? *std::max_element (island.amplitudeEnvelope.begin() + localIslandStart,
                                 island.amplitudeEnvelope.begin() + localIslandEnd)
            : 0.0f;
        const float envThreshold = std::max (0.007f, maxEnvelope * 0.16f);

        std::vector<std::vector<float>> localOriginal (static_cast<size_t> (numChannels), std::vector<float> (static_cast<size_t> (transitionSamples), 0.0f));
        std::vector<const float*> localInputPtrs (static_cast<size_t> (numChannels), nullptr);
        for (int ch = 0; ch < numChannels; ++ch)
        {
            for (int i = 0; i < transitionSamples; ++i)
                localOriginal[static_cast<size_t> (ch)][static_cast<size_t> (i)] = originalInput[ch][transitionStart + i];
            localInputPtrs[static_cast<size_t> (ch)] = localOriginal[static_cast<size_t> (ch)].data();
        }

        std::vector<float> localRatios (static_cast<size_t> (transitionSamples), 1.0f);
        std::vector<float> localDetectedPitchHz (static_cast<size_t> (transitionSamples), island.core.meanF0Hz);
        std::vector<float> localVoicedSupport (static_cast<size_t> (transitionSamples), 0.0f);
        std::vector<float> localTransientMask (static_cast<size_t> (transitionSamples), 0.0f);
        std::vector<float> localResidualWeight (static_cast<size_t> (transitionSamples), 0.0f);
        std::vector<float> localCoreFocus (static_cast<size_t> (transitionSamples), 0.0f);

        const float centerSampleF = static_cast<float> (focusCenterSample);
        for (int i = 0; i < transitionSamples; ++i)
        {
            const int absoluteSample = transitionStart + i;
            if (absoluteSample >= 0 && absoluteSample < static_cast<int> (pitchRatios.size()))
                localRatios[static_cast<size_t> (i)] = pitchRatios[static_cast<size_t> (absoluteSample)];

            const int islandIndex = localIslandStart + i;
            const float voiced = islandIndex >= 0 && islandIndex < static_cast<int> (island.voicedMask.size())
                ? island.voicedMask[static_cast<size_t> (islandIndex)]
                : 0.0f;
            const float consonant = islandIndex >= 0 && islandIndex < static_cast<int> (island.consonantMask.size())
                ? island.consonantMask[static_cast<size_t> (islandIndex)]
                : 0.0f;
            const float envelope = islandIndex >= 0 && islandIndex < static_cast<int> (island.amplitudeEnvelope.size())
                ? island.amplitudeEnvelope[static_cast<size_t> (islandIndex)]
                : 0.0f;
            const float f0 = islandIndex >= 0 && islandIndex < static_cast<int> (island.f0TrackHz.size())
                ? island.f0TrackHz[static_cast<size_t> (islandIndex)]
                : island.core.meanF0Hz;
            localDetectedPitchHz[static_cast<size_t> (i)] = f0 > 0.0f ? f0 : island.core.meanF0Hz;

            const float biasedOffsetSec = (static_cast<float> (absoluteSample) - centerSampleF) / static_cast<float> (sampleRate)
                + 0.001f * entryBiasMs * (isEntryWindow ? 1.0f : -0.5f);
            const float focusIn = smoothstep01 ((biasedOffsetSec + 0.012f) / 0.015f);
            const float focusOut = 1.0f - smoothstep01 ((biasedOffsetSec - 0.052f) / 0.026f);
            const float coreFocus = juce::jlimit (0.0f, 1.0f, focusIn * focusOut);
            const float boundaryBodyFocus = isEntryWindow
                ? smoothstep01 ((biasedOffsetSec + 0.004f) / 0.019f)
                : (1.0f - smoothstep01 ((biasedOffsetSec - 0.008f) / 0.026f));
            const float transientMask = juce::jlimit (0.0f, 1.0f,
                std::max (
                    std::max (islandIndex < static_cast<int> (flatnessMask.size()) ? flatnessMask[static_cast<size_t> (islandIndex)] : 0.0f,
                              consonant * 0.88f),
                    isEntryWindow
                        ? (1.0f - smoothstep01 ((biasedOffsetSec + 0.010f) / 0.020f))
                        : (1.0f - smoothstep01 (((-biasedOffsetSec) + 0.008f) / 0.020f))));
            const float envelopeGate = smoothstep01 ((envelope - envThreshold) / std::max (envThreshold * 1.8f, 1.0e-4f));
            const float voicedSupport = juce::jlimit (0.0f, 1.0f,
                voiced * envelopeGate * coreFocus * boundaryBodyFocus * (1.0f - 0.96f * transientMask));
            const float residualWeight = juce::jlimit (0.0f, windowResidualWet,
                voicedSupport * voicedSupport * boundaryBodyFocus * island.residualModel.highBandMix * 0.35f);

            localTransientMask[static_cast<size_t> (i)] = transientMask;
            localVoicedSupport[static_cast<size_t> (i)] = voicedSupport;
            localResidualWeight[static_cast<size_t> (i)] = residualWeight;
            localCoreFocus[static_cast<size_t> (i)] = coreFocus;
            result.transientMaskPeak = std::max (result.transientMaskPeak, transientMask);
            result.voicedSupportPeak = std::max (result.voicedSupportPeak, voicedSupport);
            result.transientBypassUsed = result.transientBypassUsed || transientMask > 0.20f;
        }

        auto voicedCore = copyInputChannels (localInputPtrs.data(), numChannels, transitionSamples);

        int cepstralCutoffUsed = 0;
        int fftSizeUsed = 0;
        int hopSizeUsed = 0;
        const int localCoreLeadSamples = isEntryWindow ? entryLeadSamples : exitLeadSamples;
        const int localCoreTailSamples = isEntryWindow ? entryTailSamples : exitTailSamples;
        const int localCoreStart = juce::jlimit (0, transitionSamples, focusCenterSample - transitionStart - localCoreLeadSamples);
        const int localCoreEnd = juce::jlimit (localCoreStart, transitionSamples, focusCenterSample - transitionStart + localCoreTailSamples);
        for (int ch = 0; ch < numChannels; ++ch)
        {
            result.spectralEnvelopeCorrectionUsed = applyEngineV2CepstralEnvelopeRestore (
                voicedCore[static_cast<size_t> (ch)],
                localOriginal[static_cast<size_t> (ch)],
                localVoicedSupport,
                localDetectedPitchHz,
                localCoreStart,
                localCoreEnd,
                sampleRate,
                &cepstralCutoffUsed,
                &fftSizeUsed,
                &hopSizeUsed,
                cepstralLifterScale,
                cepstralStrengthBase,
                cepstralStrengthSlope) || result.spectralEnvelopeCorrectionUsed;
        }
        result.cepstralCutoffUsed = std::max (result.cepstralCutoffUsed, cepstralCutoffUsed);
        result.fftSizeUsed = std::max (result.fftSizeUsed, fftSizeUsed);
        result.hopSizeUsed = std::max (result.hopSizeUsed, hopSizeUsed);

        if (! island.residualModel.voicedHighBandResidual.empty())
        {
            for (int ch = 0; ch < numChannels; ++ch)
            {
                for (int i = 0; i < transitionSamples; ++i)
                {
                    const int islandIndex = localIslandStart + i;
                    if (islandIndex < 0 || islandIndex >= static_cast<int> (island.residualModel.voicedHighBandResidual.size()))
                        continue;
                    voicedCore[static_cast<size_t> (ch)][static_cast<size_t> (i)] +=
                        island.residualModel.voicedHighBandResidual[static_cast<size_t> (islandIndex)]
                        * localResidualWeight[static_cast<size_t> (i)];
                }
            }
            result.residualCarryUsed = true;
        }

        for (int ch = 0; ch < numChannels; ++ch)
        {
            for (int i = 0; i < transitionSamples; ++i)
            {
                const int absoluteSample = transitionStart + i;
                const float baseSample = result.output[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)];
                const float originalSample = localOriginal[static_cast<size_t> (ch)][static_cast<size_t> (i)];
                const float renderedSample = voicedCore[static_cast<size_t> (ch)][static_cast<size_t> (i)];
                const float transientWeight = localTransientMask[static_cast<size_t> (i)];
                const float voicedSupport = localVoicedSupport[static_cast<size_t> (i)];
                const float correctionWeight = windowCoreWet * voicedSupport;
                const float transientKeep = juce::jlimit (0.0f, 1.0f,
                    std::max (transientWeight, 1.0f - smoothstep01 ((localCoreFocus[static_cast<size_t> (i)] - 0.18f) / 0.52f)));
                const float residualDelta = (renderedSample - baseSample) * localResidualWeight[static_cast<size_t> (i)];
                const float entryTimingBlend = isEntryWindow
                    ? smoothstep01 ((static_cast<float> (i) / static_cast<float> (std::max (1, transitionSamples - 1)) - 0.08f) / 0.18f)
                    : 1.0f;
                const float outerBlendIn = i < outerFadeSamples ? smoothstep01 (static_cast<float> (i) / static_cast<float> (outerFadeSamples)) : 1.0f;
                const int fromEnd = transitionSamples - 1 - i;
                const float outerBlendOut = fromEnd < outerFadeSamples
                    ? smoothstep01 (static_cast<float> (fromEnd) / static_cast<float> (outerFadeSamples))
                    : 1.0f;
                const float outerBlend = std::min (outerBlendIn, outerBlendOut) * entryTimingBlend;
                const float delta = (originalSample - baseSample) * transientKeep
                    + (renderedSample - baseSample) * correctionWeight
                    + residualDelta;
                result.output[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)] =
                    baseSample + delta * outerBlend;
            }
        }

        result.used = true;
    };

    for (const auto& island : analysis.islands)
    {
        for (const auto& note : island.notes)
        {
            if (! hasPitchStyleEdit (note))
                continue;

            const int absoluteEffectiveStart = island.contextStartSample
                + static_cast<int> (std::floor (getEffectiveNoteStartTime (note) * sampleRate));
            const int absoluteNoteStart = island.contextStartSample
                + static_cast<int> (std::floor (note.startTime * sampleRate));
            const int absoluteNoteEnd = island.contextStartSample
                + static_cast<int> (std::ceil (note.endTime * sampleRate));
            const int absoluteEffectiveEnd = island.contextStartSample
                + static_cast<int> (std::ceil (getEffectiveNoteEndTime (note) * sampleRate));

            applyWindow (
                island,
                std::max (island.renderStartSample, absoluteEffectiveStart - entryLeadSamples),
                std::min (island.renderEndSample, absoluteNoteStart + entryTailSamples),
                absoluteNoteStart,
                true);

            applyWindow (
                island,
                std::max (island.renderStartSample, absoluteNoteEnd - exitLeadSamples),
                std::min (island.renderEndSample, absoluteEffectiveEnd + exitTailSamples),
                absoluteNoteEnd,
                false);
        }
    }

    if (result.used)
    {
        logPitchEditorFormant ("adaptive boundary correction"
            + juce::String (" flatnessCenter=") + juce::String (flatnessCenter, 3)
            + " flatnessWidth=" + juce::String (flatnessWidth, 3)
            + " minRms=" + juce::String (minRms, 4)
            + " entryCrossfadeMs=" + juce::String (entryCrossfadeMs, 2)
            + " exitCrossfadeMs=" + juce::String (exitCrossfadeMs, 2)
            + " entryBiasMs=" + juce::String (entryBiasMs, 2)
            + " coreWet=" + juce::String (entryCoreWet, 3) + "/" + juce::String (exitCoreWet, 3)
            + " residualWet=" + juce::String (entryResidualWet, 3) + "/" + juce::String (exitResidualWet, 3)
            + " entryPrePostMs=" + juce::String (entryLeadMs, 2) + "/" + juce::String (entryTailMs, 2)
            + " exitPrePostMs=" + juce::String (exitLeadMs, 2) + "/" + juce::String (exitTailMs, 2)
            + " lifterScale=" + juce::String (cepstralLifterScale, 3)
            + " cepstralStrength=" + juce::String (cepstralStrengthBase, 3) + "+" + juce::String (cepstralStrengthSlope, 3) + "*voiced"
            + " transientPeak=" + juce::String (result.transientMaskPeak, 3)
            + " voicedPeak=" + juce::String (result.voicedSupportPeak, 3)
            + " lifter=" + juce::String (result.cepstralCutoffUsed)
            + " fft/hop=" + juce::String (result.fftSizeUsed) + "/" + juce::String (result.hopSizeUsed));
    }

    return result;
}

static std::vector<float> computeCepstralEnvelope (
    const std::vector<float>& magnitude,
    juce::dsp::FFT& fft,
    int fftSize,
    int lifterCutoff)
{
    const int halfBins = fftSize / 2 + 1;
    std::vector<juce::dsp::Complex<float>> logSpectrum (static_cast<size_t> (fftSize), { 0.0f, 0.0f });
    std::vector<juce::dsp::Complex<float>> cepstrum (static_cast<size_t> (fftSize), { 0.0f, 0.0f });
    std::vector<juce::dsp::Complex<float>> lifted (static_cast<size_t> (fftSize), { 0.0f, 0.0f });
    std::vector<juce::dsp::Complex<float>> smoothedSpectrum (static_cast<size_t> (fftSize), { 0.0f, 0.0f });

    for (int bin = 0; bin < halfBins; ++bin)
        logSpectrum[static_cast<size_t> (bin)] = { std::log (std::max (1.0e-7f, magnitude[static_cast<size_t> (bin)])), 0.0f };
    for (int bin = 1; bin < halfBins - 1; ++bin)
        logSpectrum[static_cast<size_t> (fftSize - bin)] = logSpectrum[static_cast<size_t> (bin)];

    fft.perform (logSpectrum.data(), cepstrum.data(), true);
    const float inverseScale = 1.0f / static_cast<float> (fftSize);
    for (int i = 0; i < fftSize; ++i)
    {
        const bool keep = i <= lifterCutoff || i >= fftSize - lifterCutoff;
        lifted[static_cast<size_t> (i)] = keep ? cepstrum[static_cast<size_t> (i)] * inverseScale
                                               : juce::dsp::Complex<float> { 0.0f, 0.0f };
    }

    fft.perform (lifted.data(), smoothedSpectrum.data(), false);
    std::vector<float> envelope (static_cast<size_t> (halfBins), 1.0f);
    for (int bin = 0; bin < halfBins; ++bin)
        envelope[static_cast<size_t> (bin)] = std::exp (smoothedSpectrum[static_cast<size_t> (bin)].real());
    return envelope;
}

static float estimateMedianPositiveF0Hz (
    const std::vector<float>& detectedPitchHz,
    const std::vector<float>& voicedSupport,
    int startSample,
    int endSample)
{
    std::vector<float> values;
    values.reserve (static_cast<size_t> (std::max (0, endSample - startSample)));
    const int boundedEnd = std::min (static_cast<int> (detectedPitchHz.size()), endSample);
    for (int i = std::max (0, startSample); i < boundedEnd; ++i)
    {
        const float f0 = detectedPitchHz[static_cast<size_t> (i)];
        const float support = static_cast<size_t> (i) < voicedSupport.size() ? voicedSupport[static_cast<size_t> (i)] : 0.0f;
        if (f0 > 40.0f && support > 0.08f)
            values.push_back (f0);
    }

    if (values.empty())
        return 0.0f;

    const auto middle = values.begin() + static_cast<std::ptrdiff_t> (values.size() / 2);
    std::nth_element (values.begin(), middle, values.end());
    return *middle;
}

static bool applyEngineV2CepstralEnvelopeRestore (
    std::vector<float>& processed,
    const std::vector<float>& original,
    const std::vector<float>& voicedSupport,
    const std::vector<float>& detectedPitchHz,
    int coreStartSample,
    int coreEndSample,
    double sampleRate,
    int* usedLifterCutoffOut,
    int* usedFftSizeOut,
    int* usedHopSizeOut,
    float lifterScale,
    float correctionStrengthBase,
    float correctionStrengthSlope,
    float maxCorrectionDb,
    int fixedLifterCutoff)
{
    if (processed.empty() || original.size() != processed.size() || coreEndSample <= coreStartSample || sampleRate <= 0.0)
        return false;

    const int defaultFftOrder = processed.size() < 2600 ? 10 : 11;
    const int fftOrder = juce::jlimit (10, 12, getEnvInt ("OPENSTUDIO_PITCH_CEPSTRAL_FFT_ORDER", defaultFftOrder));
    const int fftSize = 1 << fftOrder;
    const int halfBins = fftSize / 2 + 1;
    const int hopDivisor = juce::jlimit (4, 8, getEnvInt ("OPENSTUDIO_PITCH_CEPSTRAL_HOP_DIVISOR", 8));
    const int hopSize = std::max (1, fftSize / hopDivisor);
    const float medianF0Hz = estimateMedianPositiveF0Hz (detectedPitchHz, voicedSupport, coreStartSample, coreEndSample);
    const float periodSamples = medianF0Hz > 40.0f
        ? static_cast<float> (sampleRate / medianF0Hz)
        : static_cast<float> (sampleRate / 180.0);
    const int computedLifterCutoff = static_cast<int> (std::round (periodSamples * lifterScale));
    const int lifterCutoff = juce::jlimit (8, fftSize / 6, fixedLifterCutoff > 0 ? fixedLifterCutoff : computedLifterCutoff);
    const float maxCorrectionGain = maxCorrectionDb > 0.0f
        ? std::pow (10.0f, juce::jlimit (0.5f, 6.0f, maxCorrectionDb) / 20.0f)
        : 0.0f;
    const float minCorrectionGain = maxCorrectionGain > 0.0f ? 1.0f / maxCorrectionGain : 0.0f;
    juce::dsp::FFT fft (fftOrder);
    std::vector<float> hann (static_cast<size_t> (fftSize), 0.0f);
    for (int i = 0; i < fftSize; ++i)
        hann[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            juce::MathConstants<float>::twoPi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));

    std::vector<juce::dsp::Complex<float>> origIn (static_cast<size_t> (fftSize));
    std::vector<juce::dsp::Complex<float>> procIn (static_cast<size_t> (fftSize));
    std::vector<juce::dsp::Complex<float>> origFft (static_cast<size_t> (fftSize));
    std::vector<juce::dsp::Complex<float>> procFft (static_cast<size_t> (fftSize));
    std::vector<juce::dsp::Complex<float>> ifftOut (static_cast<size_t> (fftSize));
    std::vector<float> overlapAdd (processed.size(), 0.0f);
    std::vector<float> windowSum (processed.size(), 0.0f);
    bool used = false;
    if (usedLifterCutoffOut != nullptr)
        *usedLifterCutoffOut = lifterCutoff;
    if (usedFftSizeOut != nullptr)
        *usedFftSizeOut = fftSize;
    if (usedHopSizeOut != nullptr)
        *usedHopSizeOut = hopSize;

    for (int pos = std::max (0, coreStartSample - fftSize / 2);
         pos < std::min (static_cast<int> (processed.size()), coreEndSample + fftSize / 2);
         pos += hopSize)
    {
        float voicedAverage = 0.0f;
        int voicedCount = 0;
        for (int i = 0; i < fftSize; ++i)
        {
            const int idx = pos + i;
            const float origSample = (idx >= 0 && idx < static_cast<int> (original.size())) ? original[static_cast<size_t> (idx)] : 0.0f;
            const float procSample = (idx >= 0 && idx < static_cast<int> (processed.size())) ? processed[static_cast<size_t> (idx)] : 0.0f;
            origIn[static_cast<size_t> (i)] = { origSample * hann[static_cast<size_t> (i)], 0.0f };
            procIn[static_cast<size_t> (i)] = { procSample * hann[static_cast<size_t> (i)], 0.0f };
            if (idx >= coreStartSample && idx < coreEndSample && static_cast<size_t> (idx) < voicedSupport.size())
            {
                voicedAverage += voicedSupport[static_cast<size_t> (idx)];
                ++voicedCount;
            }
        }
        voicedAverage = voicedCount > 0 ? voicedAverage / static_cast<float> (voicedCount) : 0.0f;

        if (voicedAverage < 0.15f)
        {
            for (int i = 0; i < fftSize; ++i)
            {
                const int idx = pos + i;
                if (idx >= 0 && idx < static_cast<int> (processed.size()))
                {
                    const float w = hann[static_cast<size_t> (i)];
                    overlapAdd[static_cast<size_t> (idx)] += processed[static_cast<size_t> (idx)] * w;
                    windowSum[static_cast<size_t> (idx)] += w * w;
                }
            }
            continue;
        }

        fft.perform (origIn.data(), origFft.data(), false);
        fft.perform (procIn.data(), procFft.data(), false);
        std::vector<float> origMagnitude (static_cast<size_t> (halfBins), 1.0f);
        std::vector<float> procMagnitude (static_cast<size_t> (halfBins), 1.0f);
        float energyBefore = 0.0f;
        float energyAfter = 0.0f;

        for (int bin = 0; bin < halfBins; ++bin)
        {
            origMagnitude[static_cast<size_t> (bin)] = std::max (1.0e-7f, std::abs (origFft[static_cast<size_t> (bin)]));
            procMagnitude[static_cast<size_t> (bin)] = std::max (1.0e-7f, std::abs (procFft[static_cast<size_t> (bin)]));
            energyBefore += procMagnitude[static_cast<size_t> (bin)] * procMagnitude[static_cast<size_t> (bin)];
        }

        const auto origEnvelope = computeCepstralEnvelope (origMagnitude, fft, fftSize, lifterCutoff);
        const auto procEnvelope = computeCepstralEnvelope (procMagnitude, fft, fftSize, lifterCutoff);
        const float correctionStrength = juce::jlimit (0.24f, 0.92f, correctionStrengthBase + correctionStrengthSlope * voicedAverage);

        for (int bin = 0; bin < halfBins; ++bin)
        {
            const float envRatio = std::pow (
                (origEnvelope[static_cast<size_t> (bin)] + 1.0e-6f) / (procEnvelope[static_cast<size_t> (bin)] + 1.0e-6f),
                correctionStrength);
            const float freqNorm = static_cast<float> (bin) / static_cast<float> (std::max (1, halfBins - 1));
            const float cappedGain = maxCorrectionGain > 0.0f
                ? juce::jlimit (minCorrectionGain, maxCorrectionGain, envRatio)
                : (freqNorm > 0.68f
                    ? juce::jlimit (0.78f, 1.18f, envRatio)
                    : juce::jlimit (0.70f, 1.32f, envRatio));
            procFft[static_cast<size_t> (bin)] *= cappedGain;
            energyAfter += std::norm (procFft[static_cast<size_t> (bin)]);
            if (bin > 0 && bin < halfBins - 1)
                procFft[static_cast<size_t> (fftSize - bin)] = std::conj (procFft[static_cast<size_t> (bin)]);
        }

        if (energyAfter > 1.0e-8f)
        {
            const float energyScale = std::pow (energyBefore / energyAfter, 0.12f);
            for (int bin = 0; bin < halfBins; ++bin)
            {
                procFft[static_cast<size_t> (bin)] *= energyScale;
                if (bin > 0 && bin < halfBins - 1)
                    procFft[static_cast<size_t> (fftSize - bin)] = std::conj (procFft[static_cast<size_t> (bin)]);
            }
        }

        fft.perform (procFft.data(), ifftOut.data(), true);
        const float inverseScale = 1.0f / static_cast<float> (fftSize);
        for (int i = 0; i < fftSize; ++i)
        {
            const int idx = pos + i;
            if (idx >= 0 && idx < static_cast<int> (processed.size()))
            {
                const float w = hann[static_cast<size_t> (i)];
                overlapAdd[static_cast<size_t> (idx)] += ifftOut[static_cast<size_t> (i)].real() * inverseScale * w;
                windowSum[static_cast<size_t> (idx)] += w * w;
            }
        }
        used = true;
    }

    if (used)
    {
        for (int i = coreStartSample; i < coreEndSample && i < static_cast<int> (processed.size()); ++i)
        {
            if (windowSum[static_cast<size_t> (i)] > 1.0e-4f && voicedSupport[static_cast<size_t> (i)] > 0.08f)
                processed[static_cast<size_t> (i)] = overlapAdd[static_cast<size_t> (i)] / windowSum[static_cast<size_t> (i)];
        }
    }

    return used;
}

static bool applyVoicedCoreEnvelopeTransferForPitchOnly (
    std::vector<std::vector<float>>& output,
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz,
    float upwardEnvelopeMix,
    float downwardEnvelopeMix,
    float maxCorrectionDb,
    int fixedLifterCutoff,
    int* usedLifterCutoffOut,
    int* usedFftSizeOut,
    int* usedHopSizeOut,
    float* usedEnvelopeMixOut)
{
    if (output.empty() || input == nullptr || numChannels <= 0 || numSamples <= 0 || sampleRate <= 0.0)
        return false;

    std::vector<float> voicedSupport (static_cast<size_t> (numSamples), 0.0f);
    int hopSamples = 256;
    if (frames.size() >= 2)
        hopSamples = std::max (1, static_cast<int> (std::round ((frames[1].time - frames[0].time) * sampleRate)));

    for (const auto& frame : frames)
    {
        if (! frame.voiced || frame.midiNote <= 0.0f || frame.frequency <= 0.0f)
            continue;

        const float confidenceSupport = smoothstep01 ((frame.confidence - 0.18f) / 0.42f);
        const float energySupport = smoothstep01 ((frame.rmsDB + 54.0f) / 18.0f);
        const float support = juce::jlimit (0.0f, 1.0f, confidenceSupport * energySupport);
        const int start = juce::jlimit (0, numSamples, static_cast<int> (std::floor (frame.time * sampleRate)));
        const int end = juce::jlimit (start, numSamples, start + hopSamples);
        for (int i = start; i < end; ++i)
            voicedSupport[static_cast<size_t> (i)] = std::max (voicedSupport[static_cast<size_t> (i)], support);
    }

    bool used = false;
    std::vector<std::vector<float>> original (static_cast<size_t> (numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        original[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);

    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;

        const float notePitchDelta = note.correctedPitch - note.detectedPitch;
        const bool upward = notePitchDelta > 0.01f;
        const bool downward = notePitchDelta < -0.01f;
        if (! upward && ! downward)
            continue;

        const int noteStart = juce::jlimit (0, numSamples, static_cast<int> (std::round (note.startTime * sampleRate)));
        const int noteEnd = juce::jlimit (noteStart, numSamples, static_cast<int> (std::round (note.endTime * sampleRate)));
        const int duration = noteEnd - noteStart;
        if (duration <= static_cast<int> (std::round (0.055 * sampleRate)))
            continue;

        const int guard = juce::jlimit (
            static_cast<int> (std::round (0.010 * sampleRate)),
            static_cast<int> (std::round (0.030 * sampleRate)),
            duration / 5);
        const int coreStart = juce::jlimit (noteStart, noteEnd, noteStart + guard);
        const int coreEnd = juce::jlimit (coreStart, noteEnd, noteEnd - guard);
        if (coreEnd - coreStart <= static_cast<int> (std::round (0.035 * sampleRate)))
            continue;

        for (int ch = 0; ch < numChannels; ++ch)
        {
            std::vector<float> beforeCore;
            beforeCore.reserve (static_cast<size_t> (coreEnd - coreStart));
            for (int i = coreStart; i < coreEnd; ++i)
                beforeCore.push_back (output[static_cast<size_t> (ch)][static_cast<size_t> (i)]);

            int lifter = 0;
            int fftSize = 0;
            int hopSize = 0;
            const bool channelUsed = applyEngineV2CepstralEnvelopeRestore (
                output[static_cast<size_t> (ch)],
                original[static_cast<size_t> (ch)],
                voicedSupport,
                detectedPitchHz,
                coreStart,
                coreEnd,
                sampleRate,
                &lifter,
                &fftSize,
                &hopSize,
                juce::jlimit (0.28f, 0.55f, getEnvFloat ("OPENSTUDIO_PITCH_CORE_ENVELOPE_LIFTER_SCALE", 0.36f)),
                juce::jlimit (0.28f, 0.74f, getEnvFloat ("OPENSTUDIO_PITCH_CORE_ENVELOPE_STRENGTH_BASE", 0.48f)),
                juce::jlimit (0.03f, 0.26f, getEnvFloat ("OPENSTUDIO_PITCH_CORE_ENVELOPE_STRENGTH_SLOPE", 0.12f)),
                maxCorrectionDb,
                fixedLifterCutoff);
            if (channelUsed)
            {
                const char* mixEnvName = upward
                    ? "OPENSTUDIO_PITCH_CORE_UP_ENVELOPE_MIX"
                    : "OPENSTUDIO_PITCH_CORE_DOWN_ENVELOPE_MIX";
                const float defaultMix = upward ? upwardEnvelopeMix : downwardEnvelopeMix;
                const float mix = juce::jlimit (
                    0.0f, 0.55f, getEnvFloat (mixEnvName, getEnvFloat ("OPENSTUDIO_PITCH_CORE_ENVELOPE_MIX", defaultMix)));
                for (int i = coreStart; i < coreEnd; ++i)
                {
                    const size_t local = static_cast<size_t> (i - coreStart);
                    const float support = static_cast<size_t> (i) < voicedSupport.size()
                        ? smoothstep01 (voicedSupport[static_cast<size_t> (i)])
                        : 0.0f;
                    auto& sample = output[static_cast<size_t> (ch)][static_cast<size_t> (i)];
                    sample = beforeCore[local] + (sample - beforeCore[local]) * mix * support;
                }
                if (usedEnvelopeMixOut != nullptr)
                    *usedEnvelopeMixOut = std::max (*usedEnvelopeMixOut, mix);
            }
            used = channelUsed || used;
            if (usedLifterCutoffOut != nullptr)
                *usedLifterCutoffOut = std::max (*usedLifterCutoffOut, lifter);
            if (usedFftSizeOut != nullptr)
                *usedFftSizeOut = std::max (*usedFftSizeOut, fftSize);
            if (usedHopSizeOut != nullptr)
                *usedHopSizeOut = std::max (*usedHopSizeOut, hopSize);
        }
    }

    return used;
}

static EngineV2ProgramRenderResult renderEngineV2Program (
    const float* const* originalInput,
    const std::vector<std::vector<float>>& adaptiveOutput,
    const OwnPitchEngine::SharedAnalysis& analysis,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& pitchRatios,
    int numChannels,
    int numSamples,
    double sampleRate)
{
    juce::ignoreUnused (notes);
    EngineV2ProgramRenderResult result;
    result.output = adaptiveOutput;
    result.diagnostics = buildEngineV2ScaffoldDiagnostics (analysis, notes, sampleRate);

    if (analysis.islands.empty())
    {
        result.diagnostics.engineV2FallbackUsed = true;
        return result;
    }

    for (const auto& island : analysis.islands)
    {
        const auto* leadNote = findEngineV2LeadUpwardNote (island);
        if (leadNote == nullptr)
            continue;

        result.diagnostics.engineV2Used = true;
        const float entryLeadMs = juce::jlimit (10.0f, 40.0f, getEnvFloat ("OPENSTUDIO_ENGINEV2_ENTRY_LEAD_MS", 18.0f));
        const float entryTailMs = juce::jlimit (30.0f, 110.0f, getEnvFloat ("OPENSTUDIO_ENGINEV2_ENTRY_TAIL_MS", 68.0f));
        const float transitionOuterFadeMs = juce::jlimit (6.0f, 16.0f, getEnvFloat ("OPENSTUDIO_ENGINEV2_OUTER_FADE_MS", 8.0f));
        const float transientFlatnessCenter = getEnvFloat ("OPENSTUDIO_ENGINEV2_FLATNESS_CENTER", 0.33f);
        const float transientFlatnessWidth = getEnvFloat ("OPENSTUDIO_ENGINEV2_FLATNESS_WIDTH", 0.15f);
        const float transientMinRms = getEnvFloat ("OPENSTUDIO_ENGINEV2_MIN_RMS", 0.0032f);
        const float transientRmsWidth = getEnvFloat ("OPENSTUDIO_ENGINEV2_RMS_WIDTH", 0.018f);
        const float entryBiasMs = juce::jlimit (-8.0f, 4.0f, getEnvFloat ("OPENSTUDIO_ENGINEV2_ENTRY_BIAS_MS", -3.5f));
        const float coreWet = juce::jlimit (0.05f, 0.22f, getEnvFloat ("OPENSTUDIO_ENGINEV2_CORE_WET", 0.12f));
        const float residualWet = juce::jlimit (0.0f, 0.04f, getEnvFloat ("OPENSTUDIO_ENGINEV2_RESIDUAL_WET", 0.0f));
        const float cepstralLifterScale = juce::jlimit (0.24f, 0.60f, getEnvFloat ("OPENSTUDIO_ENGINEV2_CEPSTRAL_LIFTER_SCALE", 0.34f));
        const float cepstralStrengthBase = juce::jlimit (0.30f, 0.80f, getEnvFloat ("OPENSTUDIO_ENGINEV2_CEPSTRAL_STRENGTH_BASE", 0.52f));
        const float cepstralStrengthSlope = juce::jlimit (0.05f, 0.35f, getEnvFloat ("OPENSTUDIO_ENGINEV2_CEPSTRAL_STRENGTH_SLOPE", 0.16f));
        const int absoluteNoteStart = island.contextStartSample
            + static_cast<int> (std::floor (leadNote->startTime * sampleRate));
        const int absoluteEffectiveStart = island.contextStartSample
            + static_cast<int> (std::floor (getEffectiveNoteStartTime (*leadNote) * sampleRate));
        const int transitionLeadSamples = std::max (1, static_cast<int> (std::round (entryLeadMs * 0.001 * sampleRate)));
        const int transitionTailSamples = std::max (1, static_cast<int> (std::round (entryTailMs * 0.001 * sampleRate)));
        const int transitionStart = juce::jlimit (0, numSamples,
            std::max (island.renderStartSample, absoluteEffectiveStart - transitionLeadSamples));
        const int transitionEnd = juce::jlimit (transitionStart, numSamples,
            std::min (island.renderEndSample, absoluteNoteStart + transitionTailSamples));
        const int transitionSamples = transitionEnd - transitionStart;
        if (transitionSamples <= 64)
            continue;

        const int localIslandStart = juce::jlimit (0, static_cast<int> (island.monoSignal.size()), transitionStart - island.contextStartSample);
        const int localIslandEnd = juce::jlimit (localIslandStart, static_cast<int> (island.monoSignal.size()), transitionEnd - island.contextStartSample);
        const int localCoreStart = juce::jlimit (0, transitionSamples, absoluteNoteStart - transitionStart);
        const int localCoreEnd = juce::jlimit (localCoreStart, transitionSamples,
            absoluteNoteStart + std::min (transitionTailSamples,
                std::max (1, static_cast<int> (std::round (0.085 * sampleRate)))) - transitionStart);

        std::vector<std::vector<float>> localOriginal (static_cast<size_t> (numChannels), std::vector<float> (static_cast<size_t> (transitionSamples), 0.0f));
        std::vector<const float*> localInputPtrs (static_cast<size_t> (numChannels), nullptr);
        for (int ch = 0; ch < numChannels; ++ch)
        {
            for (int i = 0; i < transitionSamples; ++i)
                localOriginal[static_cast<size_t> (ch)][static_cast<size_t> (i)] = originalInput[ch][transitionStart + i];
            localInputPtrs[static_cast<size_t> (ch)] = localOriginal[static_cast<size_t> (ch)].data();
        }

        std::vector<float> localRatios (static_cast<size_t> (transitionSamples), 1.0f);
        std::vector<float> localDetectedPitchHz (static_cast<size_t> (transitionSamples), island.core.meanF0Hz);
        std::vector<float> localVoicedSupport (static_cast<size_t> (transitionSamples), 0.0f);
        std::vector<float> localTransientMask (static_cast<size_t> (transitionSamples), 0.0f);
        std::vector<float> localResidualWeight (static_cast<size_t> (transitionSamples), 0.0f);
        std::vector<float> localEntryFocus (static_cast<size_t> (transitionSamples), 0.0f);
        auto flatnessMask = buildEngineV2SpectralFlatnessMask (
            island.monoSignal,
            localIslandStart,
            localIslandEnd,
            sampleRate,
            transientFlatnessCenter,
            transientFlatnessWidth,
            transientMinRms,
            transientRmsWidth);
        const float maxEnvelope = island.amplitudeEnvelope.empty()
            ? 0.0f
            : *std::max_element (island.amplitudeEnvelope.begin() + localIslandStart,
                                 island.amplitudeEnvelope.begin() + localIslandEnd);
        const float envThreshold = std::max (0.008f, maxEnvelope * 0.18f);

        for (int i = 0; i < transitionSamples; ++i)
        {
            const int absoluteSample = transitionStart + i;
            if (absoluteSample >= 0 && absoluteSample < static_cast<int> (pitchRatios.size()))
                localRatios[static_cast<size_t> (i)] = pitchRatios[static_cast<size_t> (absoluteSample)];

            const int islandIndex = localIslandStart + i;
            const float voiced = islandIndex >= 0 && islandIndex < static_cast<int> (island.voicedMask.size())
                ? island.voicedMask[static_cast<size_t> (islandIndex)]
                : 0.0f;
            const float consonant = islandIndex >= 0 && islandIndex < static_cast<int> (island.consonantMask.size())
                ? island.consonantMask[static_cast<size_t> (islandIndex)]
                : 0.0f;
            const float envelope = islandIndex >= 0 && islandIndex < static_cast<int> (island.amplitudeEnvelope.size())
                ? island.amplitudeEnvelope[static_cast<size_t> (islandIndex)]
                : 0.0f;
            const float f0 = islandIndex >= 0 && islandIndex < static_cast<int> (island.f0TrackHz.size())
                ? island.f0TrackHz[static_cast<size_t> (islandIndex)]
                : island.core.meanF0Hz;
            localDetectedPitchHz[static_cast<size_t> (i)] = f0 > 0.0f ? f0 : island.core.meanF0Hz;

            const float relativeSec = static_cast<float> (absoluteSample - absoluteNoteStart) / static_cast<float> (sampleRate)
                + 0.001f * entryBiasMs;
            const float focusIn = smoothstep01 ((relativeSec + 0.004f) / 0.014f);
            const float focusHoldOut = 1.0f - smoothstep01 ((relativeSec - 0.044f) / 0.020f);
            const float entryFocus = juce::jlimit (0.0f, 1.0f, focusIn * focusHoldOut);
            const float transientMask = juce::jlimit (0.0f, 1.0f,
                std::max (std::max (islandIndex < static_cast<int> (flatnessMask.size()) ? flatnessMask[static_cast<size_t> (islandIndex)] : 0.0f,
                                    consonant * 0.82f),
                          1.0f - smoothstep01 ((relativeSec - 0.016f) / 0.018f)));
            const float envelopeGate = smoothstep01 ((envelope - envThreshold) / std::max (envThreshold * 2.0f, 1.0e-4f));
            const float voicedSupport = juce::jlimit (0.0f, 1.0f,
                voiced * envelopeGate * entryFocus * (1.0f - 0.97f * transientMask));
            const float residualWeight = juce::jlimit (0.0f, residualWet,
                voicedSupport * voicedSupport * entryFocus * island.residualModel.highBandMix * 0.22f);
            localTransientMask[static_cast<size_t> (i)] = transientMask;
            localVoicedSupport[static_cast<size_t> (i)] = voicedSupport;
            localResidualWeight[static_cast<size_t> (i)] = residualWeight;
            localEntryFocus[static_cast<size_t> (i)] = entryFocus;
            result.diagnostics.harmonicSupportPeak = std::max (result.diagnostics.harmonicSupportPeak, voicedSupport);
            result.diagnostics.residualSupportPeak = std::max (result.diagnostics.residualSupportPeak, residualWeight);
            result.diagnostics.envelopeSupportPeak = std::max (result.diagnostics.envelopeSupportPeak, envelopeGate);
            result.transientBypassUsed = result.transientBypassUsed || transientMask > 0.20f;
        }

        auto voicedCore = copyInputChannels (localInputPtrs.data(), numChannels, transitionSamples);

        int cepstralCutoffUsed = 0;
        int fftSizeUsed = 0;
        int hopSizeUsed = 0;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            result.spectralEnvelopeCorrectionUsed = applyEngineV2CepstralEnvelopeRestore (
                voicedCore[static_cast<size_t> (ch)],
                localOriginal[static_cast<size_t> (ch)],
                localVoicedSupport,
                localDetectedPitchHz,
                localCoreStart,
                localCoreEnd,
                sampleRate,
                &cepstralCutoffUsed,
                &fftSizeUsed,
                &hopSizeUsed,
                cepstralLifterScale,
                cepstralStrengthBase,
                cepstralStrengthSlope) || result.spectralEnvelopeCorrectionUsed;
        }
        result.cepstralCutoffUsed = std::max (result.cepstralCutoffUsed, cepstralCutoffUsed);
        result.fftSizeUsed = std::max (result.fftSizeUsed, fftSizeUsed);
        result.hopSizeUsed = std::max (result.hopSizeUsed, hopSizeUsed);

        if (! island.residualModel.voicedHighBandResidual.empty())
        {
            for (int ch = 0; ch < numChannels; ++ch)
            {
                for (int i = 0; i < transitionSamples; ++i)
                {
                    const int islandIndex = localIslandStart + i;
                    if (islandIndex < 0 || islandIndex >= static_cast<int> (island.residualModel.voicedHighBandResidual.size()))
                        continue;
                    voicedCore[static_cast<size_t> (ch)][static_cast<size_t> (i)] +=
                        island.residualModel.voicedHighBandResidual[static_cast<size_t> (islandIndex)]
                        * localResidualWeight[static_cast<size_t> (i)];
                }
            }
            result.residualCarryUsed = true;
        }

        const int outerFadeSamples = std::max (1, static_cast<int> (std::round (transitionOuterFadeMs * 0.001 * sampleRate)));
        for (int ch = 0; ch < numChannels; ++ch)
        {
            for (int i = 0; i < transitionSamples; ++i)
            {
                const int absoluteSample = transitionStart + i;
                const float baseSample = result.output[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)];
                const float originalSample = localOriginal[static_cast<size_t> (ch)][static_cast<size_t> (i)];
                const float renderedSample = voicedCore[static_cast<size_t> (ch)][static_cast<size_t> (i)];
                const float transientWeight = localTransientMask[static_cast<size_t> (i)];
                const float entryFocus = localEntryFocus[static_cast<size_t> (i)];
                const float stableVoiced = localVoicedSupport[static_cast<size_t> (i)] * smoothstep01 (localVoicedSupport[static_cast<size_t> (i)]);
                const float coreWeight = coreWet * stableVoiced * entryFocus;
                const float transientKeep = juce::jlimit (0.0f, 1.0f,
                    std::max (transientWeight, 1.0f - smoothstep01 ((entryFocus - 0.10f) / 0.60f)));
                const float residualDelta = (renderedSample - baseSample) * localResidualWeight[static_cast<size_t> (i)] * 0.06f;
                const float outerBlendIn = i < outerFadeSamples ? smoothstep01 (static_cast<float> (i) / static_cast<float> (outerFadeSamples)) : 1.0f;
                const int fromEnd = transitionSamples - 1 - i;
                const float outerBlendOut = fromEnd < outerFadeSamples
                    ? smoothstep01 (static_cast<float> (fromEnd) / static_cast<float> (outerFadeSamples))
                    : 1.0f;
                const float outerBlend = std::min (outerBlendIn, outerBlendOut);
                const float delta = (originalSample - baseSample) * transientKeep
                    + (renderedSample - baseSample) * coreWeight
                    + residualDelta;
                result.output[static_cast<size_t> (ch)][static_cast<size_t> (absoluteSample)] =
                    baseSample + delta * outerBlend;
            }
        }
    }

    if (! result.diagnostics.engineV2Used)
        result.diagnostics.engineV2FallbackUsed = true;

    return result;
}

static std::vector<float> buildHybridBridgeMono (
    const std::vector<std::vector<float>>& audio,
    int numChannels,
    int numSamples)
{
    std::vector<float> mono (static_cast<size_t> (numSamples), 0.0f);
    if (numChannels <= 0 || numSamples <= 0)
        return mono;

    const float scale = 1.0f / static_cast<float> (numChannels);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (static_cast<size_t> (ch) >= audio.size())
            continue;
        const auto& channel = audio[static_cast<size_t> (ch)];
        const int available = std::min (numSamples, static_cast<int> (channel.size()));
        for (int s = 0; s < available; ++s)
            mono[static_cast<size_t> (s)] += channel[static_cast<size_t> (s)] * scale;
    }

    return mono;
}
static float computeHybridBridgeRms (
    const std::vector<float>& signal,
    int startSample,
    int lengthSamples)
{
    if (signal.empty() || lengthSamples <= 0)
        return 0.0f;

    const int start = juce::jlimit (0, static_cast<int> (signal.size()), startSample);
    const int end = juce::jlimit (start, static_cast<int> (signal.size()), start + lengthSamples);
    if (end <= start)
        return 0.0f;

    double sum = 0.0;
    for (int s = start; s < end; ++s)
    {
        const float v = signal[static_cast<size_t> (s)];
        sum += static_cast<double> (v) * v;
    }

    return std::sqrt (static_cast<float> (sum / static_cast<double> (std::max (1, end - start))));
}

struct HybridBridgeAlignmentResult
{
    bool found = false;
    int lagSamples = 0;
    float score = 0.0f;
};

static HybridBridgeAlignmentResult findHybridBridgeAlignment (
    const std::vector<float>& legacyMono,
    const std::vector<float>& ownMono,
    int bridgeStartSample,
    int bridgeLengthSamples,
    int searchRadiusSamples)
{
    HybridBridgeAlignmentResult result;
    if (legacyMono.empty() || ownMono.empty() || bridgeLengthSamples < 8)
        return result;

    const int compareLength = std::max (8, bridgeLengthSamples);
    const int legacyStart = juce::jlimit (0, static_cast<int> (legacyMono.size()) - compareLength, bridgeStartSample);

    for (int lag = -searchRadiusSamples; lag <= searchRadiusSamples; ++lag)
    {
        const int ownStart = legacyStart + lag;
        if (ownStart < 0 || ownStart + compareLength >= static_cast<int> (ownMono.size()))
            continue;

        double dot = 0.0;
        double energyLegacy = 0.0;
        double energyOwn = 0.0;
        int slopeAgreeCount = 0;

        for (int i = 0; i < compareLength; ++i)
        {
            const float a = legacyMono[static_cast<size_t> (legacyStart + i)];
            const float b = ownMono[static_cast<size_t> (ownStart + i)];
            dot += static_cast<double> (a) * b;
            energyLegacy += static_cast<double> (a) * a;
            energyOwn += static_cast<double> (b) * b;

            if (i > 0)
            {
                const float da = a - legacyMono[static_cast<size_t> (legacyStart + i - 1)];
                const float db = b - ownMono[static_cast<size_t> (ownStart + i - 1)];
                if ((da >= 0.0f && db >= 0.0f) || (da <= 0.0f && db <= 0.0f))
                    ++slopeAgreeCount;
            }
        }

        if (energyLegacy <= 1.0e-8 || energyOwn <= 1.0e-8)
            continue;

        const float normCorr = juce::jlimit (-1.0f, 1.0f,
            static_cast<float> (dot / std::sqrt (energyLegacy * energyOwn)));
        const float corrScore = 0.5f * (normCorr + 1.0f);
        const float slopeScore = compareLength > 1
            ? static_cast<float> (slopeAgreeCount) / static_cast<float> (compareLength - 1)
            : 0.0f;
        const float rmsLegacy = std::sqrt (static_cast<float> (energyLegacy / compareLength));
        const float rmsOwn = std::sqrt (static_cast<float> (energyOwn / compareLength));
        const float rmsScore = (std::min (rmsLegacy, rmsOwn) + 1.0e-4f) / (std::max (rmsLegacy, rmsOwn) + 1.0e-4f);
        const float totalScore = 0.50f * corrScore + 0.30f * slopeScore + 0.20f * rmsScore;

        if (! result.found || totalScore > result.score)
        {
            result.found = true;
            result.lagSamples = lag;
            result.score = totalScore;
        }
    }

    const int maxSafeLagSamples = std::max (4, searchRadiusSamples);
    if (! result.found || result.score < 0.68f || std::abs (result.lagSamples) > maxSafeLagSamples)
        return {};

    return result;
}

static bool hasStableEntryWindow (
    const OwnPitchEngine::NoteIslandAnalysis& island,
    int startSample,
    int sustainSamples,
    float voicedThreshold,
    float envThreshold)
{
    if (island.voicedMask.empty() || island.amplitudeEnvelope.empty() || island.f0TrackHz.empty())
        return false;

    const int endSample = startSample + sustainSamples;
    if (startSample < 0
        || endSample > static_cast<int> (island.voicedMask.size())
        || endSample > static_cast<int> (island.amplitudeEnvelope.size())
        || endSample > static_cast<int> (island.f0TrackHz.size()))
    {
        return false;
    }

    float firstF0 = 0.0f;
    for (int s = startSample; s < endSample; ++s)
    {
        const float voiced = island.voicedMask[static_cast<size_t> (s)];
        const float env = island.amplitudeEnvelope[static_cast<size_t> (s)];
        const float f0 = island.f0TrackHz[static_cast<size_t> (s)];
        if (voiced < voicedThreshold || env < envThreshold || f0 <= 40.0f)
            return false;

        if (firstF0 <= 0.0f)
            firstF0 = f0;
        else if (std::abs (1200.0f * std::log2 (std::max (f0, 1.0f) / std::max (firstF0, 1.0f))) > 45.0f)
            return false;
    }

    return true;
}

static bool hasStableVoicedF0Window (
    const OwnPitchEngine::NoteIslandAnalysis& island,
    int startSample,
    int sustainSamples,
    float voicedThreshold,
    float envThreshold,
    float maxF0DriftCents)
{
    if (! hasStableEntryWindow (island, startSample, sustainSamples, voicedThreshold, envThreshold))
        return false;

    if (island.f0TrackHz.empty())
        return false;

    float minF0 = std::numeric_limits<float>::max();
    float maxF0 = 0.0f;
    for (int s = startSample; s < startSample + sustainSamples; ++s)
    {
        if (s < 0 || s >= static_cast<int> (island.f0TrackHz.size()))
            return false;
        const float f0 = island.f0TrackHz[static_cast<size_t> (s)];
        if (f0 < 40.0f)
            return false;
        minF0 = std::min (minF0, f0);
        maxF0 = std::max (maxF0, f0);
    }

    if (minF0 <= 0.0f || maxF0 <= 0.0f)
        return false;

    const float driftCents = std::abs (1200.0f * std::log2 (maxF0 / minF0));
    return driftCents <= maxF0DriftCents;
}

static const OwnPitchEngine::NoteIslandAnalysis* findHybridReplacementIsland (
    const OwnPitchEngine::SharedAnalysis& analysis,
    int noteBodyStartAbsolute,
    int noteBodyEndAbsolute)
{
    const OwnPitchEngine::NoteIslandAnalysis* best = nullptr;
    int bestOverlap = 0;

    for (const auto& island : analysis.islands)
    {
        const int islandBodyStart = island.contextStartSample + island.bodyStartSample;
        const int islandBodyEnd = island.contextStartSample + island.bodyEndSample;
        const int overlap = std::max (0, std::min (noteBodyEndAbsolute, islandBodyEnd) - std::max (noteBodyStartAbsolute, islandBodyStart));
        if (overlap > bestOverlap)
        {
            best = &island;
            bestOverlap = overlap;
        }
    }

    return best;
}

static HybridStructuralBlendResult blendHybridStructuralOutputs (
    const float* const* originalInput,
    const std::vector<std::vector<float>>& legacyOutput,
    const std::vector<std::vector<float>>& ownOutput,
    const OwnPitchEngine::SharedAnalysis& ownAnalysis,
    PitchOnlyRendererBranch rendererBranch,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes)
{
    HybridStructuralBlendResult result;
    auto& blended = result.output;
    blended = legacyOutput;
    if (legacyOutput.size() != ownOutput.size() || numChannels <= 0 || numSamples <= 0)
        return result;

    std::vector<float> ownWeight (static_cast<size_t> (numSamples), 0.0f);
    std::vector<float> replacementWeight (static_cast<size_t> (numSamples), 0.0f);
    std::vector<float> islandNativeWeight (static_cast<size_t> (numSamples), 0.0f);
    std::vector<std::vector<float>> replacementSignal (static_cast<size_t> (numChannels),
                                                       std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
    std::vector<std::vector<float>> islandNativeSignal (static_cast<size_t> (numChannels),
                                                        std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
    const auto legacyMono = buildHybridBridgeMono (legacyOutput, numChannels, numSamples);
    const auto ownMono = buildHybridBridgeMono (ownOutput, numChannels, numSamples);
    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;

        const float pitchRatio = std::pow (2.0f, (note.correctedPitch - note.detectedPitch) / 12.0f);
        const bool downwardShift = pitchRatio < 0.999f;
        const float bodyDurationSec = std::max (0.0f, note.endTime - note.startTime);
        const bool longBody = bodyDurationSec >= 0.90f;
        if (downwardShift || longBody)
            continue;

        const int renderStart = juce::jlimit (0, numSamples, static_cast<int> (std::floor (getEffectiveNoteStartTime (note) * sampleRate)));
        const int renderEnd = juce::jlimit (renderStart, numSamples, static_cast<int> (std::ceil (getEffectiveNoteEndTime (note) * sampleRate)));
        const int bodyStart = juce::jlimit (renderStart, renderEnd, static_cast<int> (std::floor (note.startTime * sampleRate)));
        const int bodyEnd = juce::jlimit (bodyStart, renderEnd, static_cast<int> (std::ceil (note.endTime * sampleRate)));
        const int coreEntryProtect = std::max (1, static_cast<int> (std::round (0.050 * sampleRate)));
        const int coreExitProtect = std::max (1, static_cast<int> (std::round (0.060 * sampleRate)));
        const int coreStart = juce::jlimit (bodyStart, bodyEnd, bodyStart + coreEntryProtect);
        const int coreEnd = juce::jlimit (coreStart, bodyEnd, bodyEnd - coreExitProtect);
        bool usedBodyReplacement = false;
        bool bodyReplacementFallbackUsed = false;
        const bool enableBodyReplacement = false;
        const auto* replacementIsland = findHybridReplacementIsland (ownAnalysis, bodyStart, bodyEnd);
        const bool enableIslandNative = rendererBranch == PitchOnlyRendererBranch::IslandNative
            || rendererBranch == PitchOnlyRendererBranch::IslandNativePsola;
        const bool useIslandNativePsolaCore = rendererBranch == PitchOnlyRendererBranch::IslandNativePsola;
        if (enableIslandNative)
        {
            if (replacementIsland == nullptr)
            {
                if (! result.islandNativeDiagnostics.islandNativeUsed)
                    result.islandNativeDiagnostics.islandNativeFallbackUsed = true;
            }
            else
            {
                const int islandRenderStart = juce::jlimit (renderStart, renderEnd, replacementIsland->contextStartSample);
                const int islandRenderEnd = juce::jlimit (islandRenderStart, renderEnd, replacementIsland->contextEndSample);
                const int localBodyStart = juce::jlimit (0, static_cast<int> (replacementIsland->monoSignal.size()), bodyStart - replacementIsland->contextStartSample);
                const int localBodyEnd = juce::jlimit (localBodyStart, static_cast<int> (replacementIsland->monoSignal.size()), bodyEnd - replacementIsland->contextStartSample);
                const int onsetHoldSamples = std::max (1, static_cast<int> (std::round (0.025 * sampleRate)));
                const int exitHoldSamples = std::max (1, static_cast<int> (std::round (0.020 * sampleRate)));
                const int outerEntryFadeSamples = std::max (1, static_cast<int> (std::round (0.012 * sampleRate)));
                const int outerExitFadeSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
                const int baseSustainSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
                float maxBodyEnv = 0.0f;
                if (! replacementIsland->amplitudeEnvelope.empty() && localBodyEnd > localBodyStart)
                {
                    maxBodyEnv = *std::max_element (replacementIsland->amplitudeEnvelope.begin() + localBodyStart,
                                                    replacementIsland->amplitudeEnvelope.begin() + localBodyEnd);
                }
                const float envThreshold = std::max (0.010f, maxBodyEnv * 0.18f);
                const float baseVoicedThreshold = 0.60f;
                const int minimumCoreSamples = std::max (8, static_cast<int> (std::round (0.025 * sampleRate)));
                const auto findStableCoreSpan = [&] (float voicedThreshold, int sustainSamples, int& stableStartLocal, int& stableEndLocal)
                {
                    stableStartLocal = -1;
                    stableEndLocal = -1;
                    const int coreSearchStart = juce::jlimit (localBodyStart, localBodyEnd, localBodyStart + onsetHoldSamples);
                    const int coreSearchEnd = juce::jlimit (coreSearchStart, localBodyEnd, localBodyEnd - exitHoldSamples);
                    if (coreSearchEnd - coreSearchStart < sustainSamples)
                        return false;

                    for (int sample = coreSearchStart; sample + sustainSamples <= coreSearchEnd; ++sample)
                    {
                        if (hasStableVoicedF0Window (*replacementIsland, sample, sustainSamples, voicedThreshold, envThreshold, 35.0f))
                        {
                            stableStartLocal = sample;
                            break;
                        }
                    }

                    for (int sample = coreSearchEnd; sample - sustainSamples >= coreSearchStart; --sample)
                    {
                        if (hasStableVoicedF0Window (*replacementIsland, sample - sustainSamples, sustainSamples, voicedThreshold, envThreshold, 35.0f))
                        {
                            stableEndLocal = sample;
                            break;
                        }
                    }

                    return stableStartLocal >= 0
                        && stableEndLocal > stableStartLocal
                        && (stableEndLocal - stableStartLocal) >= minimumCoreSamples;
                };

                int stableCoreStartLocal = -1;
                int stableCoreEndLocal = -1;
                bool hasStableCore = findStableCoreSpan (baseVoicedThreshold, baseSustainSamples, stableCoreStartLocal, stableCoreEndLocal);
                if (! hasStableCore && useIslandNativePsolaCore)
                    hasStableCore = findStableCoreSpan (0.55f,
                                                        std::max (1, static_cast<int> (std::round (0.008 * sampleRate))),
                                                        stableCoreStartLocal,
                                                        stableCoreEndLocal);

                if (hasStableCore)
                {
                    const int stableCoreStart = replacementIsland->contextStartSample + stableCoreStartLocal;
                    const int stableCoreEnd = replacementIsland->contextStartSample + stableCoreEndLocal;
                    std::vector<std::vector<float>> islandCoreSignal;
                    bool hasIslandCoreSignal = ! useIslandNativePsolaCore;

                    if (useIslandNativePsolaCore)
                    {
                        std::vector<int> sourceEpochs;
                        for (const int epoch : replacementIsland->epochs)
                        {
                            if (epoch >= stableCoreStartLocal && epoch <= stableCoreEndLocal)
                                sourceEpochs.push_back (replacementIsland->contextStartSample + epoch);
                        }

                        if (sourceEpochs.size() >= 5)
                        {
                            double sourcePeriodSum = 0.0;
                            for (size_t i = 1; i < sourceEpochs.size(); ++i)
                                sourcePeriodSum += static_cast<double> (sourceEpochs[i] - sourceEpochs[i - 1]);

                            const double averageSourcePeriod = sourcePeriodSum / static_cast<double> (std::max<size_t> (1, sourceEpochs.size() - 1));
                            const double targetPeriod = std::max (8.0, averageSourcePeriod / std::max (0.25f, pitchRatio));
                            std::vector<int> synthesisEpochs;
                            for (double pos = static_cast<double> (stableCoreStart); pos < static_cast<double> (stableCoreEnd); pos += targetPeriod)
                                synthesisEpochs.push_back (static_cast<int> (std::round (pos)));

                            if (synthesisEpochs.size() >= 5)
                            {
                                islandCoreSignal.assign (static_cast<size_t> (numChannels),
                                                         std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
                                std::vector<float> coreNorm (static_cast<size_t> (numSamples), 0.0f);

                                for (size_t i = 0; i < synthesisEpochs.size(); ++i)
                                {
                                    const int sourceIndex = synthesisEpochs.size() <= 1
                                        ? 0
                                        : juce::jlimit (0,
                                                        static_cast<int> (sourceEpochs.size()) - 1,
                                                        static_cast<int> (std::round (
                                                            static_cast<double> (i) * static_cast<double> (sourceEpochs.size() - 1)
                                                            / static_cast<double> (synthesisEpochs.size() - 1))));
                                    const int sourceEpoch = sourceEpochs[static_cast<size_t> (sourceIndex)];
                                    const int localSourceEpoch = juce::jlimit (0,
                                                                               static_cast<int> (replacementIsland->f0TrackHz.size()) - 1,
                                                                               sourceEpoch - replacementIsland->contextStartSample);
                                    const float sourceF0Hz = replacementIsland->f0TrackHz.empty()
                                        ? std::max (55.0f, midiToHz (note.detectedPitch))
                                        : std::max (55.0f, replacementIsland->f0TrackHz[static_cast<size_t> (localSourceEpoch)]);
                                    const int sourcePeriod = juce::jlimit (20, 960,
                                        static_cast<int> (std::round (sampleRate / sourceF0Hz)));
                                    const int halfWindow = juce::jlimit (20, 960,
                                        static_cast<int> (std::round (1.1 * static_cast<double> (sourcePeriod))));
                                    const int destEpoch = synthesisEpochs[static_cast<size_t> (i)];

                                    for (int n = -halfWindow; n <= halfWindow; ++n)
                                    {
                                        const int srcIndex = sourceEpoch + n;
                                        const int dstIndex = destEpoch + n;
                                        if (srcIndex < 0 || srcIndex >= numSamples || dstIndex < stableCoreStart || dstIndex >= stableCoreEnd)
                                            continue;

                                        const float phase = static_cast<float> (n + halfWindow) / static_cast<float> (2 * halfWindow + 1);
                                        const float window = 0.5f - 0.5f * std::cos (2.0f * juce::MathConstants<float>::pi * phase);
                                        coreNorm[static_cast<size_t> (dstIndex)] += window;
                                        for (int ch = 0; ch < numChannels; ++ch)
                                            islandCoreSignal[static_cast<size_t> (ch)][static_cast<size_t> (dstIndex)] += originalInput[ch][srcIndex] * window;
                                    }
                                }

                                hasIslandCoreSignal = false;
                                for (int s = stableCoreStart; s < stableCoreEnd; ++s)
                                {
                                    const float norm = coreNorm[static_cast<size_t> (s)];
                                    if (norm > 1.0e-4f)
                                    {
                                        hasIslandCoreSignal = true;
                                        for (int ch = 0; ch < numChannels; ++ch)
                                            islandCoreSignal[static_cast<size_t> (ch)][static_cast<size_t> (s)] /= norm;
                                    }
                                }

                                if (hasIslandCoreSignal)
                                {
                                    const int rmsWindowEnd = std::min (stableCoreEnd, stableCoreStart + static_cast<int> (std::round (0.020 * sampleRate)));
                                    float replacementRms = 0.0f;
                                    float originalRms = 0.0f;
                                    int rmsCount = 0;
                                    for (int s = stableCoreStart; s < rmsWindowEnd; ++s)
                                    {
                                        const float replacement = islandCoreSignal[0][static_cast<size_t> (s)];
                                        const float original = originalInput[0][s];
                                        replacementRms += replacement * replacement;
                                        originalRms += original * original;
                                        ++rmsCount;
                                    }

                                    if (rmsCount > 0)
                                    {
                                        replacementRms = std::sqrt (replacementRms / static_cast<float> (rmsCount));
                                        originalRms = std::sqrt (originalRms / static_cast<float> (rmsCount));
                                        const float gainDb = (replacementRms > 1.0e-5f && originalRms > 1.0e-5f)
                                            ? juce::jlimit (-1.0f, 1.0f, 20.0f * std::log10 (originalRms / replacementRms))
                                            : 0.0f;
                                        const float gain = std::pow (10.0f, gainDb / 20.0f);
                                        for (int ch = 0; ch < numChannels; ++ch)
                                            for (int s = stableCoreStart; s < stableCoreEnd; ++s)
                                                islandCoreSignal[static_cast<size_t> (ch)][static_cast<size_t> (s)] *= gain;
                                    }
                                }
                            }
                        }
                    }
                    if (hasIslandCoreSignal)
                    {
                    float transientMaskPeak = 0.0f;
                    float voicedCoreMaskPeak = 0.0f;
                    const int stabilityProbeSpan = std::max (1, static_cast<int> (std::round (0.008 * sampleRate)));

                    for (int s = islandRenderStart; s < islandRenderEnd; ++s)
                    {
                        const int localIndex = juce::jlimit (0, static_cast<int> (replacementIsland->monoSignal.size()) - 1,
                            s - replacementIsland->contextStartSample);
                        const float voiced = replacementIsland->voicedMask.empty()
                            ? 0.0f
                            : sanitizeFiniteFloat (replacementIsland->voicedMask[static_cast<size_t> (localIndex)]);
                        const float consonant = replacementIsland->consonantMask.empty()
                            ? 0.0f
                            : sanitizeFiniteFloat (replacementIsland->consonantMask[static_cast<size_t> (localIndex)]);
                        const float env = replacementIsland->amplitudeEnvelope.empty()
                            ? 0.0f
                            : sanitizeFiniteFloat (replacementIsland->amplitudeEnvelope[static_cast<size_t> (localIndex)]);
                        const float onsetTransient = s < stableCoreStart
                            ? 1.0f - juce::jlimit (0.0f, 1.0f,
                                static_cast<float> (s - bodyStart) / static_cast<float> (std::max (1, stableCoreStart - bodyStart)))
                            : 0.0f;
                        const float exitTransient = s >= stableCoreEnd
                            ? juce::jlimit (0.0f, 1.0f,
                                static_cast<float> (s - stableCoreEnd) / static_cast<float> (std::max (1, bodyEnd - stableCoreEnd)))
                            : 0.0f;
                        const int localProbeStart = juce::jlimit (localBodyStart, localBodyEnd,
                            localIndex - stabilityProbeSpan / 2);
                        const int localProbeSpan = std::max (1, std::min (stabilityProbeSpan, localBodyEnd - localProbeStart));
                        const bool stableLocalF0 = hasStableVoicedF0Window (*replacementIsland,
                                                                            localProbeStart,
                                                                            localProbeSpan,
                                                                            baseVoicedThreshold,
                                                                            envThreshold,
                                                                            35.0f);
                        const float f0UnstableMask = stableLocalF0 ? 0.0f : 0.75f;
                        const float exitTransientMask = std::max (exitTransient,
                            s >= bodyEnd - exitHoldSamples ? 1.0f - juce::jlimit (0.0f, 1.0f,
                                static_cast<float> ((bodyEnd - s)) / static_cast<float> (std::max (1, exitHoldSamples))) : 0.0f);
                        const float transientMask = juce::jlimit (0.0f, 1.0f,
                            std::max ({ consonant, 1.0f - voiced, onsetTransient, f0UnstableMask, exitTransientMask }));
                        float voicedCoreMask = 0.0f;
                        if (s >= stableCoreStart && s < stableCoreEnd && env >= envThreshold)
                            voicedCoreMask = juce::jlimit (0.0f, 1.0f, (voiced - baseVoicedThreshold) / std::max (0.05f, 1.0f - baseVoicedThreshold));

                        const float coreWeight = juce::jlimit (0.0f, 1.0f, voicedCoreMask * (1.0f - 0.85f * transientMask));
                        const float originalWeight = transientMask;
                        const float weightSum = std::max (0.001f, originalWeight + coreWeight);
                        transientMaskPeak = std::max (transientMaskPeak, transientMask);
                        voicedCoreMaskPeak = std::max (voicedCoreMaskPeak, coreWeight);
                        const float outerWeight = s < islandRenderStart + outerEntryFadeSamples
                            ? equalPowerFadeIn (static_cast<float> (s - islandRenderStart) / static_cast<float> (std::max (1, outerEntryFadeSamples)))
                            : (s >= islandRenderEnd - outerExitFadeSamples
                                ? equalPowerFadeOut (static_cast<float> (s - (islandRenderEnd - outerExitFadeSamples)) / static_cast<float> (std::max (1, outerExitFadeSamples)))
                                : 1.0f);
                        islandNativeWeight[static_cast<size_t> (s)] = std::max (islandNativeWeight[static_cast<size_t> (s)], outerWeight);

                        for (int ch = 0; ch < numChannels; ++ch)
                        {
                            const float original = originalInput[ch][s];
                            const float rendered = useIslandNativePsolaCore
                                ? islandCoreSignal[static_cast<size_t> (ch)][static_cast<size_t> (s)]
                                : ownOutput[static_cast<size_t> (ch)][static_cast<size_t> (s)];
                            islandNativeSignal[static_cast<size_t> (ch)][static_cast<size_t> (s)] =
                                (original * originalWeight + rendered * coreWeight) / weightSum;
                        }
                    }

                    if (! result.islandNativeDiagnostics.islandNativeUsed)
                    {
                        result.islandNativeDiagnostics.islandNativeUsed = true;
                        result.islandNativeDiagnostics.islandRenderStartSample = islandRenderStart;
                        result.islandNativeDiagnostics.islandRenderEndSample = islandRenderEnd;
                        result.islandNativeDiagnostics.transientMaskPeak = transientMaskPeak;
                        result.islandNativeDiagnostics.voicedCoreMaskPeak = voicedCoreMaskPeak;
                    }

                    continue;
                }
                    if (! result.islandNativeDiagnostics.islandNativeUsed)
                        result.islandNativeDiagnostics.islandNativeFallbackUsed = true;
                }

                if (! result.islandNativeDiagnostics.islandNativeUsed)
                    result.islandNativeDiagnostics.islandNativeFallbackUsed = true;
            }
        }
        if (enableBodyReplacement && replacementIsland != nullptr)
        {
            const int localBodyStart = juce::jlimit (0, static_cast<int> (replacementIsland->monoSignal.size()), bodyStart - replacementIsland->contextStartSample);
            const int localBodyEnd = juce::jlimit (localBodyStart, static_cast<int> (replacementIsland->monoSignal.size()), bodyEnd - replacementIsland->contextStartSample);
            const int entrySearchOffset = std::max (1, static_cast<int> (std::round (0.008 * sampleRate)));
            const int entrySustainSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
            const int exitSustainSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
            const int entrySearchStart = juce::jlimit (localBodyStart, localBodyEnd, localBodyStart + entrySearchOffset);
            const int entrySearchEnd = juce::jlimit (entrySearchStart, localBodyEnd, localBodyStart + static_cast<int> (std::round (0.090 * sampleRate)));
            const int exitSearchStart = juce::jlimit (localBodyStart, localBodyEnd, localBodyEnd - static_cast<int> (std::round (0.090 * sampleRate)));
            const int dryExitSamples = std::max (1, static_cast<int> (std::round (0.024 * sampleRate)));
            const int exitSearchEnd = juce::jlimit (exitSearchStart, localBodyEnd, localBodyEnd - dryExitSamples);
            float maxBodyEnv = 0.0f;
            if (! replacementIsland->amplitudeEnvelope.empty() && localBodyEnd > localBodyStart)
            {
                maxBodyEnv = *std::max_element (replacementIsland->amplitudeEnvelope.begin() + localBodyStart,
                                                replacementIsland->amplitudeEnvelope.begin() + localBodyEnd);
            }

            const float envThreshold = std::max (0.010f, maxBodyEnv * 0.18f);
            const float voicedThreshold = 0.60f;
            int stableEntryLocal = -1;
            for (int sample = entrySearchStart; sample + entrySustainSamples <= entrySearchEnd; ++sample)
            {
                if (hasStableVoicedF0Window (*replacementIsland, sample, entrySustainSamples, voicedThreshold, envThreshold, 35.0f))
                {
                    stableEntryLocal = sample;
                    break;
                }
            }

            int stableExitLocal = -1;
            for (int sample = exitSearchEnd; sample - exitSustainSamples >= exitSearchStart; --sample)
            {
                if (hasStableVoicedF0Window (*replacementIsland, sample - exitSustainSamples, exitSustainSamples, voicedThreshold, envThreshold, 35.0f))
                {
                    stableExitLocal = sample;
                    break;
                }
            }

            if (stableEntryLocal >= 0 && stableExitLocal >= 0)
            {
                const int entryCrossfadeSamples = std::max (1, static_cast<int> (std::round (0.012 * sampleRate)));
                const int exitCrossfadeSamples = std::max (1, static_cast<int> (std::round (0.008 * sampleRate)));
                const int absoluteStableEntry = replacementIsland->contextStartSample + stableEntryLocal;
                const int absoluteStableExit = replacementIsland->contextStartSample + stableExitLocal;
                const int entryLockStart = juce::jlimit (bodyStart, bodyEnd, absoluteStableEntry - entryCrossfadeSamples);
                const int renderedBodyStart = juce::jlimit (entryLockStart + 1, bodyEnd, absoluteStableEntry + entryCrossfadeSamples);
                const int exitLockStart = juce::jlimit (renderedBodyStart + 1, bodyEnd, absoluteStableExit - exitCrossfadeSamples);
                const int renderedBodyEnd = juce::jlimit (renderedBodyStart + 1, bodyEnd, exitLockStart);
                const int earlyContinuationSamples = std::max (1, static_cast<int> (std::round (0.045 * sampleRate)));
                const int continuationBodyEnd = juce::jlimit (renderedBodyStart + 1, renderedBodyEnd, renderedBodyStart + earlyContinuationSamples);
                const int continuationFadeEnd = juce::jlimit (continuationBodyEnd + 1, bodyEnd,
                    std::min (bodyEnd, continuationBodyEnd + static_cast<int> (std::round (0.012 * sampleRate))));

                if (continuationBodyEnd - renderedBodyStart >= std::max (4, static_cast<int> (std::round (0.018 * sampleRate))))
                {
                    const float entryF0Hz = replacementIsland->f0TrackHz.empty()
                        ? std::max (55.0f, midiToHz (note.detectedPitch))
                        : std::max (55.0f, replacementIsland->f0TrackHz[static_cast<size_t> (stableEntryLocal)]);
                    const int entryPeriodSamples = juce::jlimit (20, 960,
                        static_cast<int> (std::round (sampleRate / entryF0Hz)));
                    const int anchorWindowStartLocal = std::max (localBodyStart, stableEntryLocal - 5 * entryPeriodSamples);
                    const int anchorWindowEndLocal = std::min (localBodyEnd, stableEntryLocal + 2 * entryPeriodSamples);

                    std::vector<int> sourceEpochs;
                    sourceEpochs.reserve (8);
                    for (const int epoch : replacementIsland->epochs)
                    {
                        if (epoch >= anchorWindowStartLocal && epoch <= anchorWindowEndLocal)
                            sourceEpochs.push_back (replacementIsland->contextStartSample + epoch);
                    }

                    if (sourceEpochs.size() > 4)
                        sourceEpochs.erase (sourceEpochs.begin(), sourceEpochs.end() - 4);

                    if (sourceEpochs.size() >= 3)
                    {
                        double sourcePeriodSum = 0.0;
                        for (size_t i = 1; i < sourceEpochs.size(); ++i)
                            sourcePeriodSum += static_cast<double> (sourceEpochs[i] - sourceEpochs[i - 1]);
                        const double averageSourcePeriod = sourcePeriodSum / static_cast<double> (std::max<size_t> (1, sourceEpochs.size() - 1));
                        const double targetPeriod = std::max (8.0, averageSourcePeriod / std::max (0.25f, pitchRatio));

                        std::vector<int> synthesisEpochs;
                        for (double pos = static_cast<double> (renderedBodyStart); pos < static_cast<double> (continuationBodyEnd); pos += targetPeriod)
                            synthesisEpochs.push_back (static_cast<int> (std::round (pos)));

                        if (synthesisEpochs.size() >= 5)
                        {
                            std::vector<std::vector<float>> localReplacement (static_cast<size_t> (numChannels),
                                                                              std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
                            std::vector<float> localNorm (static_cast<size_t> (numSamples), 0.0f);

                            for (size_t i = 0; i < synthesisEpochs.size(); ++i)
                            {
                                const int sourceIndex = static_cast<int> (i % sourceEpochs.size());
                                const int sourceEpoch = sourceEpochs[static_cast<size_t> (sourceIndex)];
                                const int localSourceEpoch = juce::jlimit (0, static_cast<int> (replacementIsland->f0TrackHz.size()) - 1,
                                    sourceEpoch - replacementIsland->contextStartSample);
                                const float sourceF0Hz = replacementIsland->f0TrackHz.empty()
                                    ? std::max (55.0f, midiToHz (note.detectedPitch))
                                    : std::max (55.0f, replacementIsland->f0TrackHz[static_cast<size_t> (localSourceEpoch)]);
                                const int sourcePeriod = juce::jlimit (20, 960,
                                    static_cast<int> (std::round (sampleRate / sourceF0Hz)));
                                const int halfWindow = juce::jlimit (20, 960,
                                    static_cast<int> (std::round (1.1 * static_cast<double> (sourcePeriod))));
                                const int destEpoch = synthesisEpochs[static_cast<size_t> (i)];

                                for (int n = -halfWindow; n <= halfWindow; ++n)
                                {
                                    const int srcIndex = sourceEpoch + n;
                                    const int dstIndex = destEpoch + n;
                                    if (srcIndex < 0 || srcIndex >= numSamples || dstIndex < entryLockStart || dstIndex >= continuationFadeEnd)
                                        continue;

                                    const float phase = static_cast<float> (n + halfWindow) / static_cast<float> (2 * halfWindow + 1);
                                    const float window = 0.5f - 0.5f * std::cos (2.0f * juce::MathConstants<float>::pi * phase);
                                    localNorm[static_cast<size_t> (dstIndex)] += window;
                                    for (int ch = 0; ch < numChannels; ++ch)
                                        localReplacement[static_cast<size_t> (ch)][static_cast<size_t> (dstIndex)] += originalInput[ch][srcIndex] * window;
                                }
                            }

                            bool hasReplacementSignal = false;
                            for (int s = entryLockStart; s < continuationFadeEnd; ++s)
                            {
                                const float norm = localNorm[static_cast<size_t> (s)];
                                if (norm > 1.0e-4f)
                                {
                                    hasReplacementSignal = true;
                                    for (int ch = 0; ch < numChannels; ++ch)
                                        localReplacement[static_cast<size_t> (ch)][static_cast<size_t> (s)] /= norm;
                                }
                            }

                            if (hasReplacementSignal)
                            {
                                const int rmsWindowEnd = std::min (continuationBodyEnd, renderedBodyStart + static_cast<int> (std::round (0.020 * sampleRate)));
                                float replacementRms = 0.0f;
                                float legacyRms = 0.0f;
                                int rmsCount = 0;
                                for (int s = renderedBodyStart; s < rmsWindowEnd; ++s)
                                {
                                    const float replacement = localReplacement[0][static_cast<size_t> (s)];
                                    const float legacy = legacyOutput[0][static_cast<size_t> (s)];
                                    replacementRms += replacement * replacement;
                                    legacyRms += legacy * legacy;
                                    ++rmsCount;
                                }

                                if (rmsCount > 0)
                                {
                                    replacementRms = std::sqrt (replacementRms / static_cast<float> (rmsCount));
                                    legacyRms = std::sqrt (legacyRms / static_cast<float> (rmsCount));
                                    const float gainDb = (replacementRms > 1.0e-5f && legacyRms > 1.0e-5f)
                                        ? juce::jlimit (-1.0f, 1.0f, 20.0f * std::log10 (legacyRms / replacementRms))
                                        : 0.0f;
                                    const float gain = std::pow (10.0f, gainDb / 20.0f);
                                    for (int ch = 0; ch < numChannels; ++ch)
                                        for (int s = entryLockStart; s < continuationFadeEnd; ++s)
                                            localReplacement[static_cast<size_t> (ch)][static_cast<size_t> (s)] *= gain;
                                }

                                usedBodyReplacement = true;
                                for (int s = bodyStart; s < bodyEnd; ++s)
                                {
                                    float weight = 0.0f;
                                    if (s < entryLockStart || s >= continuationFadeEnd)
                                    {
                                        weight = 0.0f;
                                    }
                                    else if (s >= renderedBodyStart && s < continuationBodyEnd)
                                    {
                                        weight = 1.0f;
                                    }
                                    else if (s >= entryLockStart && s < renderedBodyStart)
                                    {
                                        const float t = static_cast<float> (s - entryLockStart)
                                            / static_cast<float> (std::max (1, renderedBodyStart - entryLockStart));
                                        weight = equalPowerFadeIn (t);
                                    }
                                    else if (s >= continuationBodyEnd && s < continuationFadeEnd)
                                    {
                                        const float t = static_cast<float> (s - continuationBodyEnd)
                                            / static_cast<float> (std::max (1, continuationFadeEnd - continuationBodyEnd));
                                        weight = equalPowerFadeOut (t);
                                    }

                                    replacementWeight[static_cast<size_t> (s)] = std::max (replacementWeight[static_cast<size_t> (s)], weight);
                                    for (int ch = 0; ch < numChannels; ++ch)
                                        replacementSignal[static_cast<size_t> (ch)][static_cast<size_t> (s)] = localReplacement[static_cast<size_t> (ch)][static_cast<size_t> (s)];
                                }

                                if (! result.bodyReplacementDiagnostics.bodyReplacementUsed)
                                {
                                    result.bodyReplacementDiagnostics.bodyReplacementUsed = true;
                                    result.bodyReplacementDiagnostics.entryLockStartSample = entryLockStart;
                                    result.bodyReplacementDiagnostics.entryLockLengthSamples = renderedBodyStart - entryLockStart;
                                    result.bodyReplacementDiagnostics.exitLockStartSample = continuationBodyEnd;
                                    result.bodyReplacementDiagnostics.renderedBodyStartSample = renderedBodyStart;
                                    result.bodyReplacementDiagnostics.renderedBodyEndSample = continuationBodyEnd;
                                }
                            }
                            else
                            {
                                bodyReplacementFallbackUsed = true;
                            }
                        }
                        else
                        {
                            bodyReplacementFallbackUsed = true;
                        }
                    }
                    else
                    {
                        bodyReplacementFallbackUsed = true;
                    }

                }
                else
                {
                    bodyReplacementFallbackUsed = true;
                }
            }
            else
            {
                bodyReplacementFallbackUsed = true;
            }
        }
        else
        {
            bodyReplacementFallbackUsed = true;
        }

        if (bodyReplacementFallbackUsed && ! result.bodyReplacementDiagnostics.bodyReplacementUsed)
            result.bodyReplacementDiagnostics.bodyReplacementFallbackUsed = true;

        if (usedBodyReplacement)
            continue;

        const float localTargetHz = std::max (midiToHz (note.correctedPitch), 55.0f);
        const int localPeriodSamples = std::max (1, static_cast<int> (std::round (sampleRate / localTargetHz)));
        const int bridgeLengthSamples = std::max (
            static_cast<int> (std::round (0.008 * sampleRate)),
            std::min (static_cast<int> (std::round (0.018 * sampleRate)),
                      static_cast<int> (std::round (1.5 * static_cast<double> (localPeriodSamples)))));
        const int searchRadiusSamples = std::max (
            1,
            std::min (static_cast<int> (std::round (0.0015 * sampleRate)),
                      static_cast<int> (std::round (0.35 * static_cast<double> (localPeriodSamples)))));
        const int bridgeStart = coreStart;
        const int bridgeEnd = juce::jlimit (bridgeStart, coreEnd, bridgeStart + bridgeLengthSamples);
        const bool enableExperimentalOnsetBridge = false;
        const bool canUseBridge = enableExperimentalOnsetBridge && (bridgeEnd - bridgeStart >= 8);
        const float coreOwnWeightCap = 0.82f;
        const int fallbackAttackSettle = std::max (1, static_cast<int> (std::round (0.020 * sampleRate)));
        const int fallbackFullCoreStart = juce::jlimit (coreStart, coreEnd, coreStart + fallbackAttackSettle);
        const float fallbackAttackOwnWeightCap = 0.62f;
        HybridBridgeAlignmentResult alignment;
        float bridgeGainDb = 0.0f;
        bool bridgeUsed = false;
        bool bridgeFallbackUsed = false;

        if (canUseBridge)
        {
            alignment = findHybridBridgeAlignment (
                legacyMono,
                ownMono,
                bridgeStart,
                bridgeEnd - bridgeStart,
                searchRadiusSamples);

            if (alignment.found)
            {
                const int rmsWindowSamples = std::max (
                    static_cast<int> (std::round (0.004 * sampleRate)),
                    std::min (static_cast<int> (std::round (0.006 * sampleRate)), bridgeEnd - bridgeStart));
                const float legacyRms = computeHybridBridgeRms (legacyMono, bridgeStart, rmsWindowSamples);
                const float ownRms = computeHybridBridgeRms (ownMono, bridgeStart + alignment.lagSamples, rmsWindowSamples);
                if (legacyRms > 1.0e-5f && ownRms > 1.0e-5f)
                    bridgeGainDb = juce::jlimit (-1.5f, 1.5f, 20.0f * std::log10 (legacyRms / ownRms));
                bridgeUsed = true;
            }
            else
            {
                bridgeFallbackUsed = true;
            }
        }

        if ((bridgeUsed || bridgeFallbackUsed) && ! result.diagnostics.bridgeUsed && ! result.diagnostics.bridgeFallbackUsed)
        {
            result.diagnostics.bridgeUsed = bridgeUsed;
            result.diagnostics.bridgeFallbackUsed = bridgeFallbackUsed;
            result.diagnostics.bridgeStartSample = bridgeStart;
            result.diagnostics.bridgeLengthSamples = bridgeEnd - bridgeStart;
            result.diagnostics.bridgeAlignmentLagSamples = alignment.lagSamples;
            result.diagnostics.bridgeCorrelationScore = alignment.score;
            result.diagnostics.bridgeGainDeltaDb = bridgeGainDb;
        }

        for (int s = renderStart; s < renderEnd; ++s)
        {
            float weight = 0.0f;
            if (bridgeUsed && s >= bodyStart && s < bridgeStart)
            {
                const float t = static_cast<float> (s - bodyStart) / static_cast<float> (std::max (1, bridgeStart - bodyStart));
                weight = fallbackAttackOwnWeightCap * smoothstep01 (t);
            }
            else if (bridgeUsed && s >= bridgeStart && s < bridgeEnd)
            {
                weight = 0.0f;
            }
            else if (s >= (bridgeUsed ? bridgeEnd : fallbackFullCoreStart) && s < coreEnd)
            {
                weight = coreOwnWeightCap;
            }
            else if (! bridgeUsed && s >= coreStart && s < fallbackFullCoreStart)
            {
                const float t = static_cast<float> (s - coreStart) / static_cast<float> (std::max (1, fallbackFullCoreStart - coreStart));
                weight = fallbackAttackOwnWeightCap + (coreOwnWeightCap - fallbackAttackOwnWeightCap) * smoothstep01 (t);
            }
            else if (! bridgeUsed && s >= bodyStart && s < coreStart)
            {
                const float t = static_cast<float> (s - bodyStart) / static_cast<float> (std::max (1, coreStart - bodyStart));
                weight = fallbackAttackOwnWeightCap * smoothstep01 (t);
            }
            else if (s >= coreEnd && s < bodyEnd)
            {
                const float t = static_cast<float> (bodyEnd - s) / static_cast<float> (std::max (1, bodyEnd - coreEnd));
                weight = coreOwnWeightCap * smoothstep01 (t);
            }
            ownWeight[static_cast<size_t> (s)] = std::max (ownWeight[static_cast<size_t> (s)], weight);
        }
    }

    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (ownOutput[static_cast<size_t> (ch)].size() != blended[static_cast<size_t> (ch)].size())
            continue;

        for (int s = 0; s < numSamples; ++s)
        {
            const float legacy = legacyOutput[static_cast<size_t> (ch)][static_cast<size_t> (s)];
            float sample = legacy;
            const float islandBlend = islandNativeWeight[static_cast<size_t> (s)];
            if (islandBlend > 0.0f)
            {
                const float islandSample = islandNativeSignal[static_cast<size_t> (ch)][static_cast<size_t> (s)];
                sample = legacy * (1.0f - islandBlend) + islandSample * islandBlend;
            }
            const float ownBlend = ownWeight[static_cast<size_t> (s)];
            if (islandBlend <= 0.0f && ownBlend > 0.0f)
            {
                const float own = ownOutput[static_cast<size_t> (ch)][static_cast<size_t> (s)];
                sample = legacy * (1.0f - ownBlend) + own * ownBlend;
            }
            const float replacementBlend = replacementWeight[static_cast<size_t> (s)];
            if (replacementBlend > 0.0f)
            {
                const float replacement = replacementSignal[static_cast<size_t> (ch)][static_cast<size_t> (s)];
                sample = sample * (1.0f - replacementBlend) + replacement * replacementBlend;
            }
            blended[static_cast<size_t> (ch)][static_cast<size_t> (s)] = sample;
        }
    }

    if (result.diagnostics.bridgeUsed)
    {
        const int bridgeStart = result.diagnostics.bridgeStartSample;
        const int bridgeEnd = juce::jlimit (bridgeStart, numSamples, bridgeStart + result.diagnostics.bridgeLengthSamples);
        const float ownGain = std::pow (10.0f, result.diagnostics.bridgeGainDeltaDb / 20.0f);
        const float coreOwnWeightCap = 0.82f;

        for (int ch = 0; ch < numChannels; ++ch)
        {
            if (static_cast<size_t> (ch) >= legacyOutput.size() || static_cast<size_t> (ch) >= ownOutput.size())
                continue;

            const auto& legacyChannel = legacyOutput[static_cast<size_t> (ch)];
            const auto& ownChannel = ownOutput[static_cast<size_t> (ch)];
            auto& outChannel = blended[static_cast<size_t> (ch)];
            for (int s = bridgeStart; s < bridgeEnd; ++s)
            {
                const int ownIndex = juce::jlimit (
                    0,
                    static_cast<int> (ownChannel.size()) - 1,
                    s + result.diagnostics.bridgeAlignmentLagSamples);
                const float t = static_cast<float> (s - bridgeStart) / static_cast<float> (std::max (1, bridgeEnd - bridgeStart));
                const float legacy = legacyChannel[static_cast<size_t> (s)];
                const float ownCurrent = ownChannel[static_cast<size_t> (s)];
                const float ownAligned = ownChannel[static_cast<size_t> (ownIndex)] * ownGain;
                const float ownBridge =
                    ownCurrent * equalPowerFadeOut (t) + ownAligned * equalPowerFadeIn (t);
                const float bridgeWeight = 0.62f + (coreOwnWeightCap - 0.62f) * smoothstep01 (t);
                outChannel[static_cast<size_t> (s)] =
                    legacy * (1.0f - bridgeWeight) + ownBridge * bridgeWeight;
            }
        }
    }

    return result;
}

static std::vector<std::vector<float>> composeAdaptiveSelectorOutput (
    const std::vector<std::vector<float>>& hybridOutput,
    const std::vector<std::vector<float>>& simpleOutput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes)
{
    auto output = hybridOutput;
    if (output.size() != simpleOutput.size() || numChannels <= 0 || numSamples <= 0 || sampleRate <= 0.0)
        return output;

    const int entryFadeSamples = std::max (1, static_cast<int> (std::round (0.012 * sampleRate)));
    const int exitFadeSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
    std::vector<float> simpleWeight (static_cast<size_t> (numSamples), 0.0f);

    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;

        const float pitchRatio = std::pow (2.0f, (note.correctedPitch - note.detectedPitch) / 12.0f);
        const bool upwardShift = pitchRatio > 1.001f;
        const float bodyDurationSec = std::max (0.0f, note.endTime - note.startTime);
        const bool longBody = bodyDurationSec >= 0.90f;
        if (! upwardShift || ! longBody)
            continue;

        const int noteStart = juce::jlimit (0, numSamples, static_cast<int> (std::floor (getEffectiveNoteStartTime (note) * sampleRate)));
        const int noteEnd = juce::jlimit (noteStart, numSamples, static_cast<int> (std::ceil (getEffectiveNoteEndTime (note) * sampleRate)));
        if (noteEnd <= noteStart)
            continue;

        for (int s = noteStart; s < noteEnd; ++s)
        {
            float weight = 1.0f;
            if (s < noteStart + entryFadeSamples)
            {
                const float t = static_cast<float> (s - noteStart) / static_cast<float> (std::max (1, entryFadeSamples));
                weight = equalPowerFadeIn (t);
            }
            if (s >= noteEnd - exitFadeSamples)
            {
                const float t = static_cast<float> (s - (noteEnd - exitFadeSamples)) / static_cast<float> (std::max (1, exitFadeSamples));
                weight = std::min (weight, equalPowerFadeOut (t));
            }
            simpleWeight[static_cast<size_t> (s)] = std::max (simpleWeight[static_cast<size_t> (s)], weight);
        }
    }

    for (int ch = 0; ch < numChannels; ++ch)
    {
        for (int s = 0; s < numSamples; ++s)
        {
            const float w = simpleWeight[static_cast<size_t> (s)];
            if (w <= 1.0e-4f)
                continue;
            output[static_cast<size_t> (ch)][static_cast<size_t> (s)] =
                hybridOutput[static_cast<size_t> (ch)][static_cast<size_t> (s)] * (1.0f - w)
                + simpleOutput[static_cast<size_t> (ch)][static_cast<size_t> (s)] * w;
        }
    }

    return output;
}

static void applyAdaptiveDownwardOwnBlend (
    std::vector<std::vector<float>>& output,
    const std::vector<std::vector<float>>& ownOutput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    float maxOwnWeight)
{
    if (output.size() != ownOutput.size() || numChannels <= 0 || numSamples <= 0 || sampleRate <= 0.0)
        return;

    const int entryProtectSamples = std::max (1, static_cast<int> (std::round (0.040 * sampleRate)));
    const int exitProtectSamples = std::max (1, static_cast<int> (std::round (0.050 * sampleRate)));

    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;

        const float pitchRatio = std::pow (2.0f, (note.correctedPitch - note.detectedPitch) / 12.0f);
        const bool downwardShift = pitchRatio < 0.999f;
        const float bodyDurationSec = std::max (0.0f, note.endTime - note.startTime);
        const bool shortBody = bodyDurationSec > 0.0f && bodyDurationSec < 0.80f;
        if (! downwardShift || ! shortBody)
            continue;

        const int bodyStart = juce::jlimit (0, numSamples, static_cast<int> (std::floor (note.startTime * sampleRate)));
        const int bodyEnd = juce::jlimit (bodyStart, numSamples, static_cast<int> (std::ceil (note.endTime * sampleRate)));
        const int coreStart = juce::jlimit (bodyStart, bodyEnd, bodyStart + entryProtectSamples);
        const int coreEnd = juce::jlimit (coreStart, bodyEnd, bodyEnd - exitProtectSamples);
        if (coreEnd <= coreStart)
            continue;

        for (int s = bodyStart; s < bodyEnd; ++s)
        {
            float ownWeight = 0.0f;
            if (s >= coreStart && s < coreEnd)
            {
                ownWeight = maxOwnWeight;
            }
            else if (s >= bodyStart && s < coreStart)
            {
                const float t = static_cast<float> (s - bodyStart) / static_cast<float> (std::max (1, coreStart - bodyStart));
                ownWeight = maxOwnWeight * equalPowerFadeIn (t);
            }
            else if (s >= coreEnd && s < bodyEnd)
            {
                const float t = static_cast<float> (s - coreEnd) / static_cast<float> (std::max (1, bodyEnd - coreEnd));
                ownWeight = maxOwnWeight * equalPowerFadeOut (t);
            }

            if (ownWeight <= 1.0e-4f)
                continue;

            for (int ch = 0; ch < numChannels; ++ch)
            {
                output[static_cast<size_t> (ch)][static_cast<size_t> (s)] =
                    output[static_cast<size_t> (ch)][static_cast<size_t> (s)] * (1.0f - ownWeight)
                    + ownOutput[static_cast<size_t> (ch)][static_cast<size_t> (s)] * ownWeight;
            }
        }
    }
}

struct PitchRenderIsland
{
    int renderStartSample = 0;
    int renderEndSample = 0;
    int contextStartSample = 0;
    int contextEndSample = 0;
    std::vector<PitchAnalyzer::PitchNote> notes;
};

struct PitchOnlyCoreRegion
{
    int bodyStartSample = 0;
    int bodyEndSample = 0;
    int coreStartSample = -1;
    int coreEndSample = -1;
    float pitchRatio = 1.0f;
    bool upwardShift = true;
};

struct PitchOnlyStageBStats
{
    bool ran = false;
    bool failedClosed = false;
    int regionCount = 0;
    int longestCoreSamples = 0;
    float wetCap = 0.0f;
    int pitchMarkCount = 0;
    juce::String branchName;
};

static PitchOnlyStageBStats applyPitchOnlyCoreSerialCorrection (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz,
    PitchResynthesizer::RenderQuality renderQuality,
    PitchOnlyRendererBranch rendererBranch,
    std::function<bool()> shouldCancel);

static std::vector<float> buildPitchOnlyCoreMask (
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz);

static int determineHopSize (const std::vector<PitchAnalyzer::PitchFrame>& frames, double sampleRate)
{
    if (frames.size() >= 2)
    {
        const float dt = frames[1].time - frames[0].time;
        return std::max (1, static_cast<int> (dt * sampleRate));
    }
    return 256;
}

static std::vector<PitchAnalyzer::PitchFrame> sliceFramesForWindow (
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    double windowStartSec,
    double windowEndSec)
{
    std::vector<PitchAnalyzer::PitchFrame> windowFrames;
    windowFrames.reserve (frames.size());
    for (const auto& f : frames)
    {
        const double ft = static_cast<double> (f.time);
        if (ft >= windowStartSec - 0.5 && ft <= windowEndSec + 0.5)
        {
            auto wf = f;
            wf.time = static_cast<float> (ft - windowStartSec);
            windowFrames.push_back (wf);
        }
    }
    return windowFrames;
}

static std::vector<float> buildDetectedPitchCurveHz (
    int numSamples,
    double sampleRate,
    int hopSize,
    const std::vector<PitchAnalyzer::PitchFrame>& frames)
{
    std::vector<float> detectedPitchHz (static_cast<size_t> (numSamples), 0.0f);
    for (size_t fi = 0; fi < frames.size(); ++fi)
    {
        const auto& f = frames[fi];
        if (f.frequency <= 0.0f)
            continue;

        const int sampleStart = static_cast<int> (f.time * sampleRate);
        const int sampleEnd = std::min (numSamples, sampleStart + hopSize);
        for (int s = std::max (0, sampleStart); s < sampleEnd; ++s)
            detectedPitchHz[static_cast<size_t> (s)] = f.frequency;
    }
    return detectedPitchHz;
}

static std::vector<float> stabilizePitchOnlyFormantBaseHz (
    const std::vector<float>& detectedPitchHz,
    double sampleRate)
{
    std::vector<float> stabilized = detectedPitchHz;
    if (stabilized.empty())
        return stabilized;

    std::vector<int> voicedIndices;
    voicedIndices.reserve (stabilized.size() / 64 + 1);
    for (int i = 0; i < static_cast<int> (stabilized.size()); ++i)
    {
        if (stabilized[static_cast<size_t> (i)] > 0.0f)
            voicedIndices.push_back (i);
    }

    if (voicedIndices.empty())
        return stabilized;

    const int firstVoiced = voicedIndices.front();
    const int lastVoiced = voicedIndices.back();
    for (int i = 0; i < firstVoiced; ++i)
        stabilized[static_cast<size_t> (i)] = stabilized[static_cast<size_t> (firstVoiced)];
    for (int i = lastVoiced + 1; i < static_cast<int> (stabilized.size()); ++i)
        stabilized[static_cast<size_t> (i)] = stabilized[static_cast<size_t> (lastVoiced)];

    for (size_t vi = 1; vi < voicedIndices.size(); ++vi)
    {
        const int left = voicedIndices[vi - 1];
        const int right = voicedIndices[vi];
        if (right <= left + 1)
            continue;

        const float leftHz = stabilized[static_cast<size_t> (left)];
        const float rightHz = stabilized[static_cast<size_t> (right)];
        const int gapLen = right - left - 1;
        for (int g = 1; g <= gapLen; ++g)
        {
            const float t = static_cast<float> (g) / static_cast<float> (gapLen + 1);
            stabilized[static_cast<size_t> (left + g)] = leftHz + (rightHz - leftHz) * t;
        }
    }

    const int smoothRadius = std::max (1, static_cast<int> (std::round (0.006 * sampleRate)));
    std::vector<float> smoothed = stabilized;
    for (int i = 0; i < static_cast<int> (stabilized.size()); ++i)
    {
        int count = 0;
        double weightedSum = 0.0;
        double weightTotal = 0.0;
        for (int j = std::max (0, i - smoothRadius); j <= std::min (static_cast<int> (stabilized.size()) - 1, i + smoothRadius); ++j)
        {
            const float hz = stabilized[static_cast<size_t> (j)];
            if (hz <= 0.0f)
                continue;
            const double dist = static_cast<double> (j - i);
            const double weight = std::exp (-0.5 * (dist * dist) / std::max (1.0, static_cast<double> (smoothRadius * smoothRadius) * 0.35));
            weightedSum += static_cast<double> (hz) * weight;
            weightTotal += weight;
            ++count;
        }
        if (count > 0 && weightTotal > 0.0)
            smoothed[static_cast<size_t> (i)] = static_cast<float> (weightedSum / weightTotal);
    }

    return smoothed;
}

static std::vector<PitchRenderIsland> buildPitchRenderIslands (
    int numSamples,
    double sampleRate,
    PitchResynthesizer::RenderQuality renderQuality,
    const std::vector<PitchAnalyzer::PitchNote>& notes)
{
    struct CandidateNote
    {
        float renderStartSec = 0.0f;
        float renderEndSec = 0.0f;
        PitchAnalyzer::PitchNote note;
    };

    std::vector<CandidateNote> candidates;
    candidates.reserve (notes.size());
    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;

        const float renderStartSec = getEffectiveNoteStartTime (note);
        const float renderEndSec = getEffectiveNoteEndTime (note);
        if (renderEndSec <= renderStartSec)
            continue;

        candidates.push_back ({ renderStartSec, renderEndSec, note });
    }

    std::sort (candidates.begin(), candidates.end(), [] (const auto& a, const auto& b)
    {
        return a.renderStartSec < b.renderStartSec;
    });

    const float contextPadSec = renderQuality == PitchResynthesizer::RenderQuality::PreviewFast ? 0.14f : 0.20f;
    const float mergeGapSec = 0.02f;

    std::vector<PitchRenderIsland> islands;
    for (const auto& candidate : candidates)
    {
        const int renderStartSample = juce::jlimit (0, numSamples - 1,
            static_cast<int> (std::floor (candidate.renderStartSec * sampleRate)));
        const int renderEndSample = juce::jlimit (0, numSamples,
            static_cast<int> (std::ceil (candidate.renderEndSec * sampleRate)));
        if (renderEndSample <= renderStartSample)
            continue;

        if (! islands.empty())
        {
            auto& island = islands.back();
            const double islandRenderEndSec = static_cast<double> (island.renderEndSample) / sampleRate;
            if (candidate.renderStartSec <= islandRenderEndSec + mergeGapSec)
            {
                island.renderStartSample = std::min (island.renderStartSample, renderStartSample);
                island.renderEndSample = std::max (island.renderEndSample, renderEndSample);
                island.notes.push_back (candidate.note);
                continue;
            }
        }

        PitchRenderIsland island;
        island.renderStartSample = renderStartSample;
        island.renderEndSample = renderEndSample;
        island.notes.push_back (candidate.note);
        islands.push_back (std::move (island));
    }

    for (auto& island : islands)
    {
        island.contextStartSample = juce::jlimit (0, numSamples,
            island.renderStartSample - static_cast<int> (std::round (contextPadSec * sampleRate)));
        island.contextEndSample = juce::jlimit (0, numSamples,
            island.renderEndSample + static_cast<int> (std::round (contextPadSec * sampleRate)));
    }

    return islands;
}

static void splicePitchIsland (
    std::vector<std::vector<float>>& output,
    const std::vector<std::vector<float>>& correctedIsland,
    const float* const* originalInput,
    int numChannels,
    int renderStartSample,
    int renderEndSample,
    int contextStartSample,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& islandNotes,
    PitchOnlyRendererBranch rendererBranch)
{
    const int renderSamples = std::max (0, renderEndSample - renderStartSample);
    if (renderSamples <= 0)
        return;

    const bool hybridReset = rendererBranch == PitchOnlyRendererBranch::HybridReset
        || rendererBranch == PitchOnlyRendererBranch::HybridStructural;
    const int localRenderStart = renderStartSample - contextStartSample;
    const int entryXfadeLen = std::min (hybridReset ? 576 : 384, renderSamples / 5);
    const int exitXfadeLen = std::min (384, renderSamples / 6);
    std::vector<float> noteWetMask (static_cast<size_t> (renderSamples), 0.0f);

    for (const auto& note : islandNotes)
    {
        const bool upwardShift = note.correctedPitch >= note.detectedPitch;
        const int effectiveStart = juce::jlimit (renderStartSample, renderEndSample,
            static_cast<int> (std::floor (getEffectiveNoteStartTime (note) * sampleRate)));
        const int bodyStart = juce::jlimit (renderStartSample, renderEndSample,
            static_cast<int> (std::floor (note.startTime * sampleRate)));
        const int bodyEnd = juce::jlimit (renderStartSample, renderEndSample,
            static_cast<int> (std::ceil (note.endTime * sampleRate)));
        const int effectiveEnd = juce::jlimit (renderStartSample, renderEndSample,
            static_cast<int> (std::ceil (getEffectiveNoteEndTime (note) * sampleRate)));

        if (effectiveEnd <= effectiveStart)
            continue;

        const int bodyLen = std::max (1, bodyEnd - bodyStart);
        const double entryShoulderSec = hybridReset
            ? (upwardShift ? 0.024 : 0.030)
            : 0.038;
        const double exitShoulderSec = hybridReset
            ? (upwardShift ? 0.034 : 0.042)
            : 0.050;
        const int maxAudibleEntryShoulder = std::max (1, std::min (
            static_cast<int> (std::round (entryShoulderSec * sampleRate)), bodyLen / 3));
        const int maxAudibleExitShoulder = std::max (1, std::min (
            static_cast<int> (std::round (exitShoulderSec * sampleRate)), bodyLen / 3));
        const int shoulderStart = std::max (effectiveStart, bodyStart - maxAudibleEntryShoulder);
        const int shoulderEnd = std::min (effectiveEnd, bodyEnd + maxAudibleExitShoulder);
        const int riseLen = std::max (1, bodyStart - shoulderStart);
        const int fallLen = std::max (1, shoulderEnd - bodyEnd);
        const double entryProtectSec = hybridReset
            ? (upwardShift ? 0.040 : 0.034)
            : 0.028;
        const double exitProtectSec = hybridReset
            ? (upwardShift ? 0.046 : 0.040)
            : 0.034;
        const int entryProtect = std::max (1, std::min (
            static_cast<int> (std::round (entryProtectSec * sampleRate)), bodyLen / 4));
        const int exitProtect = std::max (1, std::min (
            static_cast<int> (std::round (exitProtectSec * sampleRate)), bodyLen / 4));
        const float entryProtectFloor = hybridReset
            ? (upwardShift ? 0.54f : 0.68f)
            : 0.78f;
        const float exitProtectFloor = hybridReset
            ? (upwardShift ? 0.60f : 0.74f)
            : 0.80f;

        for (int destIndex = shoulderStart; destIndex < shoulderEnd; ++destIndex)
        {
            float noteBlend = 1.0f;
            if (destIndex < bodyStart)
            {
                const float t = static_cast<float> (destIndex - shoulderStart) / static_cast<float> (riseLen);
                noteBlend = smoothstep01 (t);
            }
            else if (destIndex < bodyStart + entryProtect)
            {
                const float t = static_cast<float> (destIndex - bodyStart) / static_cast<float> (entryProtect);
                noteBlend = juce::jmap (smoothstep01 (t), entryProtectFloor, 1.0f);
            }

            if (destIndex >= bodyEnd)
            {
                const float t = static_cast<float> (shoulderEnd - 1 - destIndex) / static_cast<float> (fallLen);
                noteBlend = std::min (noteBlend, smoothstep01 (t));
            }
            else if (destIndex >= bodyEnd - exitProtect)
            {
                const float t = static_cast<float> (bodyEnd - 1 - destIndex) / static_cast<float> (exitProtect);
                noteBlend = std::min (noteBlend, juce::jmap (smoothstep01 (t), exitProtectFloor, 1.0f));
            }

            const int localIndex = destIndex - renderStartSample;
            if (localIndex >= 0 && localIndex < renderSamples)
                noteWetMask[static_cast<size_t> (localIndex)] = std::max (noteWetMask[static_cast<size_t> (localIndex)], noteBlend);
        }
    }

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = output[static_cast<size_t> (ch)];
        const auto& corrected = correctedIsland[static_cast<size_t> (ch)];
        const float* orig = originalInput[ch];

        for (int i = 0; i < renderSamples; ++i)
        {
            const int destIndex = renderStartSample + i;
            const int sourceIndex = localRenderStart + i;
            if (destIndex < 0 || destIndex >= static_cast<int> (out.size()))
                continue;
            if (sourceIndex < 0 || sourceIndex >= static_cast<int> (corrected.size()))
                continue;

            float blend = noteWetMask[static_cast<size_t> (i)];
            if (entryXfadeLen > 0 && i < entryXfadeLen)
            {
                const float edgeBlend = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                    * static_cast<float> (i) / static_cast<float> (entryXfadeLen)));
                blend = std::min (blend, edgeBlend);
            }
            const int distFromEnd = renderSamples - 1 - i;
            if (exitXfadeLen > 0 && distFromEnd < exitXfadeLen)
            {
                const float edgeBlend = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                    * static_cast<float> (distFromEnd) / static_cast<float> (exitXfadeLen)));
                blend = std::min (blend, edgeBlend);
            }

            const float dry = orig[destIndex];
            const float wet = corrected[static_cast<size_t> (sourceIndex)];
            out[static_cast<size_t> (destIndex)] = dry * (1.0f - blend) + wet * blend;
        }
    }
}

static std::vector<std::vector<float>> renderPitchOnlyIslands (
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchFrame>& frames,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    PitchOnlyRendererBranch rendererBranch,
    PitchResynthesizer::RenderQuality renderQuality,
    std::function<bool()> shouldCancel)
{
    std::vector<std::vector<float>> output (static_cast<size_t> (numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        output[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);

    const auto islands = buildPitchRenderIslands (numSamples, sampleRate, renderQuality, notes);
    if (islands.empty())
        return output;

    int processedIslands = 0;
    int processedNotes = 0;
    int stageBRanIslands = 0;
    int stageBFailedClosedIslands = 0;
    PitchResynthesizer islandResynth;

    for (const auto& island : islands)
    {
        if (shouldCancel && shouldCancel())
            return {};

        const int contextSamples = island.contextEndSample - island.contextStartSample;
        if (contextSamples <= 0)
            continue;

        const double contextStartSec = static_cast<double> (island.contextStartSample) / sampleRate;
        const double contextEndSec = static_cast<double> (island.contextEndSample) / sampleRate;
        auto islandFrames = sliceFramesForWindow (frames, contextStartSec, contextEndSec);
        if (islandFrames.empty())
            continue;

        auto islandNotes = island.notes;
        for (auto& note : islandNotes)
        {
            note.startTime -= static_cast<float> (contextStartSec);
            note.endTime -= static_cast<float> (contextStartSec);
            note.effectiveStartTime -= static_cast<float> (contextStartSec);
            note.effectiveEndTime -= static_cast<float> (contextStartSec);
        }

        const int islandHopSize = determineHopSize (islandFrames, sampleRate);
        auto islandRatios = islandResynth.buildCorrectionCurve (
            contextSamples, sampleRate, islandFrames, islandNotes, islandHopSize);
        bool islandHasPitchShift = false;
        for (size_t i = 0; i < islandRatios.size() && ! islandHasPitchShift; i += 128)
            islandHasPitchShift = std::abs (islandRatios[i] - 1.0f) > 0.001f;
        if (! islandHasPitchShift)
            continue;

        auto islandDetectedPitchHz = buildDetectedPitchCurveHz (
            contextSamples, sampleRate, islandHopSize, islandFrames);
        islandDetectedPitchHz = stabilizePitchOnlyFormantBaseHz (islandDetectedPitchHz, sampleRate);

        std::vector<const float*> islandInput (static_cast<size_t> (numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            islandInput[static_cast<size_t> (ch)] = input[ch] + island.contextStartSample;

        auto correctedIsland = copyInputChannels (islandInput.data(), numChannels, contextSamples);
        if (rendererBranch == PitchOnlyRendererBranch::HybridReset
            || rendererBranch == PitchOnlyRendererBranch::HybridStructural)
        {
            logPitchEditorFormant ("using hybrid reset guided pitch-only carrier + minimal note-core stageB");
        }
        if (shouldCancel && shouldCancel())
            return {};
        if (correctedIsland.empty())
            continue;

        if (kEnablePitchOnlyStageB)
        {
            const auto stageBStats = applyPitchOnlyCoreSerialCorrection (correctedIsland,
                                                                         islandInput.data(),
                                                                         numChannels,
                                                                         contextSamples,
                                                                         sampleRate,
                                                                         islandNotes,
                                                                         islandDetectedPitchHz,
                                                                         renderQuality,
                                                                         rendererBranch,
                                                                         shouldCancel);
            if (stageBStats.ran)
                ++stageBRanIslands;
            if (stageBStats.failedClosed)
                ++stageBFailedClosedIslands;
            logPitchEditorFormant ("pitch-only island stageB branch=" + stageBStats.branchName
                + " ran=" + juce::String (stageBStats.ran ? "true" : "false")
                + " failedClosed=" + juce::String (stageBStats.failedClosed ? "true" : "false")
                + " regions=" + juce::String (stageBStats.regionCount)
                + " pitchMarks=" + juce::String (stageBStats.pitchMarkCount)
                + " longestCoreMs=" + juce::String (sampleRate > 0.0
                    ? 1000.0 * static_cast<double> (stageBStats.longestCoreSamples) / sampleRate : 0.0, 1)
                + " wetCap=" + juce::String (stageBStats.wetCap, 3));
            if (shouldCancel && shouldCancel())
                return {};
        }

        splicePitchIsland (output, correctedIsland, input, numChannels,
                           island.renderStartSample, island.renderEndSample,
                           island.contextStartSample, sampleRate, island.notes, rendererBranch);
        ++processedIslands;
        processedNotes += static_cast<int> (island.notes.size());
    }

    logPitchEditorFormant ("rendered pitch-only note islands=" + juce::String (processedIslands)
        + " notes=" + juce::String (processedNotes)
        + " branch=" + juce::String (getPitchOnlyRendererBranchName (rendererBranch))
        + " stageB=" + juce::String (kEnablePitchOnlyStageB ? "enabled" : "disabled")
        + " stageBRanIslands=" + juce::String (stageBRanIslands)
        + " stageBFailedClosedIslands=" + juce::String (stageBFailedClosedIslands)
        + " renderQuality=" + juce::String (renderQuality == PitchResynthesizer::RenderQuality::PreviewFast
            ? "preview_fast" : "final_hq"));

    return output;
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

            const bool lowerFormant = avgFormantRatio < 1.0f;
            const bool upperFormant = avgFormantRatio > 1.0f;
            const float effectiveShiftSemitones = std::abs (12.0f * std::log2 (std::max (avgFormantRatio, 1.0e-4f)));
            const float bassFocus = formantOnly && avgPitch > 0.0f
                ? smoothstep01 (((lowerFormant ? 210.0f : 185.0f) - avgPitch) / (lowerFormant ? 105.0f : 115.0f))
                : 0.0f;
            const float lowRegisterBoost = formantOnly && avgPitch > 0.0f
                ? (1.0f + (lowerFormant ? (previewFast ? 0.32f : 0.44f) : (previewFast ? 0.20f : 0.30f)) * bassFocus)
                : 1.0f;
            const float voicedStrengthBias = formantOnly
                ? (0.48f + 0.52f * voicedBlend)
                : (0.28f + 0.72f * voicedBlend);
            const float rawStrength = juce::jlimit (0.0f,
                                                    formantOnly
                                                        ? (lowerFormant
                                                            ? (previewFast ? 1.52f : 1.74f)
                                                            : (previewFast ? 1.26f : 1.46f))
                                                        : (lowerFormant
                                                            ? (previewFast ? 1.22f : 1.48f)
                                                            : (previewFast ? 1.08f : 1.34f)),
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
                const float airProtection = 1.0f - (formantOnly
                    ? (lowerFormant ? 0.26f : 0.10f)
                    : (lowerFormant ? 0.34f : 0.20f))
                    * smoothstep01 ((freqHz - (lowerFormant ? 4600.0f : 5600.0f)) / (lowerFormant ? 2400.0f : 3000.0f));
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
                    detailProtect > 0.25f ? (lowerFormant ? 0.64f : 0.72f) : (lowerFormant ? (previewFast ? 0.50f : 0.40f) : (previewFast ? 0.60f : 0.52f)));
                float maxGain = juce::jmap (voicedBlend, 0.0f, 1.0f,
                    detailProtect > 0.25f ? (upperFormant ? 1.28f : 1.16f) : (upperFormant ? 1.64f : 1.48f),
                    detailProtect > 0.25f ? (upperFormant ? 1.62f : 1.48f) : (upperFormant ? (previewFast ? 2.18f : 2.58f) : (previewFast ? 1.92f : 2.26f)));
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
                        + 0.18f * smoothstep01 ((0.028f - frameRms) / 0.018f))
                    * (lowerFormant ? 0.82f : 1.04f));
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
                                    + (1.0f - voicedBlend) * (lowerFormant ? 0.28f : 0.20f)
                                    + smoothstep01 ((0.032f - frameRms) / 0.020f) * (lowerFormant ? 0.16f : 0.10f))
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

static void applyPitchEnvelopeAnchorMatch (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz,
    PitchOnlyRendererBranch rendererBranch,
    PitchResynthesizer::RenderQuality renderQuality,
    std::function<bool()> shouldCancel)
{
    if (detectedPitchHz.empty())
        return;

    const bool previewFast = renderQuality == PitchResynthesizer::RenderQuality::PreviewFast;
    const bool hybridReset = rendererBranch == PitchOnlyRendererBranch::HybridReset
        || rendererBranch == PitchOnlyRendererBranch::HybridStructural;
    const int fftOrder = previewFast ? 10 : 12;
    const int fftSize = 1 << fftOrder;
    const int hopLen = fftSize / 4;
    const int halfBins = fftSize / 2 + 1;
    const float pi = juce::MathConstants<float>::pi;
    const float binHz = static_cast<float> (sampleRate) / static_cast<float> (fftSize);
    const float blockDurSec = static_cast<float> (fftSize) / static_cast<float> (sampleRate);

    juce::dsp::FFT fft (fftOrder);
    std::vector<float> hannWin (static_cast<size_t> (fftSize));
    for (int i = 0; i < fftSize; ++i)
        hannWin[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            2.0f * pi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));

    auto gaussian = [] (float x, float centre, float width)
    {
        const float safeWidth = std::max (1.0f, width);
        const float d = (x - centre) / safeWidth;
        return std::exp (-0.5f * d * d);
    };

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

    int processedBlocks = 0;
    float avgAppliedStrength = 0.0f;
    float avgVoicedBlend = 0.0f;
    int invalidStrengthBlocks = 0;
    bool loggedInvalidStrength = false;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = output[static_cast<size_t> (ch)];
        const float* orig = originalInput[ch];
        std::vector<float> corrected (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> winSum (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> origFFTBuf (static_cast<size_t> (fftSize * 2), 0.0f);
        std::vector<float> outFFTBuf (static_cast<size_t> (fftSize * 2), 0.0f);
        std::vector<float> outPreMatchFFTBuf (static_cast<size_t> (fftSize * 2), 0.0f);
        std::vector<float> origLogMag (static_cast<size_t> (halfBins), 0.0f);
        std::vector<float> outLogMag (static_cast<size_t> (halfBins), 0.0f);
        std::vector<float> origEnv (static_cast<size_t> (halfBins), 1.0f);
        std::vector<float> outEnv (static_cast<size_t> (halfBins), 1.0f);

        for (int pos = 0; pos < numSamples; pos += hopLen)
        {
            if (shouldCancel && shouldCancel())
                return;

            const float blockStartSec = static_cast<float> (pos) / static_cast<float> (sampleRate);
            const float blockEndSec = static_cast<float> (std::min (numSamples, pos + fftSize)) / static_cast<float> (sampleRate);
            const float blockCenterSec = 0.5f * (blockStartSec + blockEndSec);
            const int blockSampleCount = std::max (1, std::min (fftSize, numSamples - pos));

            float localPitchWeight = 0.0f;
            float avgPitchShiftSt = 0.0f;
            const PitchAnalyzer::PitchNote* dominantNote = nullptr;
            float dominantOverlap = 0.0f;
            for (const auto& note : notes)
            {
                if (! hasPitchStyleEdit (note))
                    continue;

                const float noteStart = getEffectiveNoteStartTime (note);
                const float noteEnd = getEffectiveNoteEndTime (note);
                const float overlap = std::max (0.0f, std::min (blockEndSec, noteEnd) - std::max (blockStartSec, noteStart));
                if (overlap <= 0.0f)
                    continue;

                const float overlapWeight = overlap / std::max (0.001f, blockDurSec);
                localPitchWeight += overlapWeight;
                avgPitchShiftSt += (note.correctedPitch - note.detectedPitch) * overlapWeight;
                if (overlapWeight > dominantOverlap)
                {
                    dominantOverlap = overlapWeight;
                    dominantNote = &note;
                }
            }

            if (localPitchWeight <= 0.001f)
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

            ++processedBlocks;
            avgPitchShiftSt /= std::max (0.001f, localPitchWeight);
            avgPitchShiftSt = sanitizeFiniteFloat (avgPitchShiftSt, 0.0f);
            const float pitchStrength = sanitizeFiniteFloat (std::min (1.0f, std::abs (avgPitchShiftSt) / 4.0f), 0.0f);

            float avgPitchHz = 0.0f;
            int pitchCount = 0;
            for (int i = pos; i < std::min (pos + fftSize, numSamples); ++i)
            {
                if (static_cast<size_t> (i) < detectedPitchHz.size() && detectedPitchHz[static_cast<size_t> (i)] > 0.0f)
                {
                    avgPitchHz += detectedPitchHz[static_cast<size_t> (i)];
                    ++pitchCount;
                }
            }
            if (pitchCount > 0)
                avgPitchHz /= static_cast<float> (pitchCount);
            avgPitchHz = sanitizeFiniteFloat (avgPitchHz, 0.0f);
            const float voicedBlend = sanitizeFiniteFloat (
                smoothstep01 (static_cast<float> (pitchCount) / static_cast<float> (blockSampleCount) * 1.35f), 0.0f);
            avgVoicedBlend += voicedBlend;

            if (voicedBlend < 0.36f || avgPitchHz < 70.0f)
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

            const float noteProgress = dominantNote != nullptr
                ? juce::jlimit (0.0f, 1.0f,
                                (blockCenterSec - dominantNote->startTime)
                                    / std::max (0.025f, dominantNote->endTime - dominantNote->startTime))
                : 0.5f;
            const float dominantNoteDurationSec = dominantNote != nullptr
                ? std::max (0.025f, dominantNote->endTime - dominantNote->startTime)
                : 0.0f;
            const float safeNoteProgress = sanitizeFiniteFloat (noteProgress, 0.5f);
            const float noteMidFocus = sanitizeFiniteFloat (
                std::pow (std::sin (pi * juce::jlimit (0.0f, 1.0f, safeNoteProgress)), 1.12f), 0.0f);
            const float noteShoulderEase = sanitizeFiniteFloat (0.72f + 0.20f * noteMidFocus, 0.72f);
            const bool upwardShift = avgPitchShiftSt >= 0.0f;
            const float shortUpwardNoteBoost = upwardShift
                ? sanitizeFiniteFloat (1.0f + 0.12f * smoothstep01 ((0.90f - dominantNoteDurationSec) / 0.35f), 1.0f)
                : 1.0f;
            const float hqBoost = upwardShift
                ? (previewFast ? 0.86f : 0.94f)
                : (previewFast ? 0.96f : 1.14f);

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
            std::copy (outFFTBuf.begin(), outFFTBuf.end(), outPreMatchFFTBuf.begin());

            for (int i = 0; i < halfBins; ++i)
            {
                const float ore = origFFTBuf[static_cast<size_t> (i * 2)];
                const float oim = origFFTBuf[static_cast<size_t> (i * 2 + 1)];
                origLogMag[static_cast<size_t> (i)] = std::log (std::sqrt (ore * ore + oim * oim) + 1.0e-10f);

                const float sre = outFFTBuf[static_cast<size_t> (i * 2)];
                const float sim = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                outLogMag[static_cast<size_t> (i)] = std::log (std::sqrt (sre * sre + sim * sim) + 1.0e-10f);
            }

            int smoothHalfW;
            if (avgPitchHz > 50.0f)
                smoothHalfW = std::max (previewFast ? 10 : 14,
                                        static_cast<int> ((previewFast ? 1.8f : 2.4f) * avgPitchHz / std::max (1.0f, binHz)));
            else
                smoothHalfW = previewFast ? 24 : 36;
            smoothHalfW = std::min (smoothHalfW, halfBins / 3);

            computeEnvelope (origLogMag, smoothHalfW, origEnv);
            computeEnvelope (outLogMag, smoothHalfW, outEnv);

            float energyBefore = 0.0f;
            float energyAfter = 0.0f;
            for (int i = 0; i < halfBins; ++i)
            {
                const float re = outFFTBuf[static_cast<size_t> (i * 2)];
                const float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyBefore += re * re + im * im;
            }

            const float blockBlend = juce::jlimit (0.0f, 1.0f, localPitchWeight);
            const float downshiftGuardBoost = upwardShift ? 1.0f : 1.22f;
            const float rawStrength = ((0.34f + 0.20f * pitchStrength)
                * (0.32f + 0.78f * voicedBlend)
                * noteShoulderEase
                * hqBoost
                * shortUpwardNoteBoost
                * downshiftGuardBoost) * (hybridReset ? 0.82f : 1.0f);
            if (! std::isfinite (rawStrength))
            {
                ++invalidStrengthBlocks;
                if (! loggedInvalidStrength)
                {
                    loggedInvalidStrength = true;
                    logPitchEditorFormant ("pitch envelope anchor invalid rawStrength="
                        + juce::String (rawStrength)
                        + " avgPitchShiftSt=" + juce::String (avgPitchShiftSt)
                        + " pitchStrength=" + juce::String (pitchStrength)
                        + " voicedBlend=" + juce::String (voicedBlend)
                        + " noteProgress=" + juce::String (safeNoteProgress)
                        + " noteShoulderEase=" + juce::String (noteShoulderEase)
                        + " localPitchWeight=" + juce::String (localPitchWeight)
                        + " dominantStart=" + juce::String (dominantNote != nullptr ? dominantNote->startTime : -1.0f)
                        + " dominantEnd=" + juce::String (dominantNote != nullptr ? dominantNote->endTime : -1.0f));
                }
            }
            const float strength = juce::jlimit (0.0f,
                upwardShift ? (previewFast ? 0.32f : 0.42f)
                            : (previewFast ? 0.40f : 0.62f),
                sanitizeFiniteFloat (rawStrength, 0.0f));
            avgAppliedStrength += strength;

            for (int i = 1; i < halfBins; ++i)
            {
                const float freqHz = static_cast<float> (i) * binHz;
                float harmonicMask = 0.0f;
                if (avgPitchHz > 55.0f && freqHz > avgPitchHz)
                {
                    const float harmonicIndex = freqHz / avgPitchHz;
                    const float nearestHarmonic = std::max (1.0f, std::round (harmonicIndex));
                    const float dist = std::abs (harmonicIndex - nearestHarmonic);
                    const float sigma = upwardShift && hybridReset
                        ? (previewFast ? 0.14f : 0.10f)
                        : (previewFast ? 0.18f : 0.13f);
                    harmonicMask = std::exp (-0.5f * (dist / sigma) * (dist / sigma));
                    harmonicMask *= smoothstep01 ((freqHz - 160.0f) / 220.0f);
                }
                harmonicMask = sanitizeFiniteFloat (harmonicMask, 0.0f);

                const float midLift = upwardShift
                    ? ((hybridReset ? 1.08f : 1.02f) * gaussian (freqHz, 1080.0f, 480.0f)
                        + (hybridReset ? 0.74f : 0.66f) * gaussian (freqHz, 1850.0f, 620.0f)
                        + (hybridReset ? 0.10f : 0.06f) * gaussian (freqHz, 2850.0f, 720.0f))
                    : (1.20f * gaussian (freqHz, 950.0f, 520.0f)
                        + 1.05f * gaussian (freqHz, 1700.0f, 680.0f)
                        + 0.46f * gaussian (freqHz, 2850.0f, 780.0f));
                const float lowTrim = upwardShift
                    ? ((hybridReset ? 0.22f : 0.28f) * gaussian (freqHz, 360.0f, 180.0f)
                        + (hybridReset ? 0.16f : 0.20f) * gaussian (freqHz, 760.0f, 260.0f))
                    : (0.12f * gaussian (freqHz, 260.0f, 150.0f)
                        + 0.08f * gaussian (freqHz, 620.0f, 230.0f));
                const float airProtect = upwardShift
                    ? (hybridReset
                        ? (1.0f - 0.48f * smoothstep01 ((freqHz - 3400.0f) / 1400.0f))
                        : (1.0f - 0.60f * smoothstep01 ((freqHz - 3200.0f) / 1200.0f)))
                    : (1.0f - 0.76f * smoothstep01 ((freqHz - 3500.0f) / 1200.0f));
                const float downshiftBandGuard = upwardShift
                    ? 1.0f
                    : (smoothstep01 ((freqHz - 180.0f) / 160.0f)
                        * (1.0f - 0.70f * smoothstep01 ((freqHz - 3500.0f) / 1200.0f)));
                const float envelopeError = sanitizeFiniteFloat (std::log ((origEnv[static_cast<size_t> (i)] + 1.0e-10f)
                    / (outEnv[static_cast<size_t> (i)] + 1.0e-10f)), 0.0f);
                const float envelopeWeight = sanitizeFiniteFloat ((0.38f + 0.62f * harmonicMask)
                    * (0.35f + 0.65f * voicedBlend)
                    * (0.82f + midLift - lowTrim)
                    * airProtect
                    * downshiftBandGuard, 0.0f);
                const float gain = sanitizeFiniteFloat (juce::jlimit (
                    upwardShift
                        ? (previewFast ? 0.88f : 0.86f)
                        : (previewFast ? 0.86f : 0.82f),
                    upwardShift
                        ? (previewFast ? 1.12f : 1.14f)
                        : (previewFast ? 1.14f : 1.18f),
                    std::pow (10.0f, (envelopeError * strength * envelopeWeight * blockBlend) / 2.302585093f)), 1.0f);

                outFFTBuf[static_cast<size_t> (i * 2)] *= gain;
                outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= gain;
            }

            for (int i = 0; i < halfBins; ++i)
            {
                const float re = outFFTBuf[static_cast<size_t> (i * 2)];
                const float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyAfter += re * re + im * im;
            }
            if (energyAfter > 1.0e-10f)
            {
                const float scale = sanitizeFiniteFloat (std::pow (energyBefore / energyAfter, 0.08f), 1.0f);
                for (int i = 0; i < halfBins; ++i)
                {
                    outFFTBuf[static_cast<size_t> (i * 2)] *= scale;
                    outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= scale;
                }
            }

            // Keep a little of the pre-match fine detail so the anchor pass
            // preserves the source-filter "move excitation, keep colour" feel
            // without over-smoothing the note.
            for (int i = 0; i < halfBins; ++i)
            {
                const float freqHz = static_cast<float> (i) * binHz;
                const float detailKeepBase = (0.05f + 0.07f * smoothstep01 ((freqHz - 3000.0f) / 1800.0f))
                    * (1.0f - 0.70f * voicedBlend);
                const float detailKeep = juce::jlimit (0.0f, hybridReset ? (upwardShift ? 0.14f : 0.06f) : 0.12f,
                    detailKeepBase);
                if (detailKeep <= 0.001f)
                    continue;
                outFFTBuf[static_cast<size_t> (i * 2)] =
                    outFFTBuf[static_cast<size_t> (i * 2)] * (1.0f - detailKeep)
                    + outPreMatchFFTBuf[static_cast<size_t> (i * 2)] * detailKeep;
                outFFTBuf[static_cast<size_t> (i * 2 + 1)] =
                    outFFTBuf[static_cast<size_t> (i * 2 + 1)] * (1.0f - detailKeep)
                    + outPreMatchFFTBuf[static_cast<size_t> (i * 2 + 1)] * detailKeep;
            }

            fft.performRealOnlyInverseTransform (outFFTBuf.data());
            for (int i = 0; i < fftSize; ++i)
            {
                const int idx = pos + i;
                if (idx >= 0 && idx < numSamples)
                {
                    const float w = hannWin[static_cast<size_t> (i)];
                    corrected[static_cast<size_t> (idx)] += outFFTBuf[static_cast<size_t> (i)] * w;
                    winSum[static_cast<size_t> (idx)] += w * w;
                }
            }
        }

        for (int s = 0; s < numSamples; ++s)
        {
            if (winSum[static_cast<size_t> (s)] > 0.001f)
                out[static_cast<size_t> (s)] = corrected[static_cast<size_t> (s)] / winSum[static_cast<size_t> (s)];
        }
    }

    logPitchEditorFormant ("pitch envelope anchor blocks=" + juce::String (processedBlocks)
        + " avgStrength=" + juce::String (processedBlocks > 0 ? avgAppliedStrength / static_cast<float> (processedBlocks) : 0.0f, 3)
        + " avgVoicedBlend=" + juce::String (processedBlocks > 0 ? avgVoicedBlend / static_cast<float> (processedBlocks) : 0.0f, 3)
        + " invalidStrengthBlocks=" + juce::String (invalidStrengthBlocks)
        + " renderQuality=" + juce::String (previewFast ? "preview_fast" : "final_hq"));
}

static void applyReferenceResidualMatch (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& formantRatios,
    const std::vector<float>& detectedPitchHz,
    bool hasPitchShift,
    bool hasExplicitFormant,
    PitchResynthesizer::RenderQuality renderQuality,
    std::function<bool()> shouldCancel,
    float intensityScale = 1.0f)
{
    if (! hasPitchShift && ! hasExplicitFormant)
        return;

    const bool previewFast = renderQuality == PitchResynthesizer::RenderQuality::PreviewFast;
    const int fftOrder = previewFast ? 10 : 12;
    const int fftSize = 1 << fftOrder;
    const int hopLen = fftSize / 4;
    const int halfBins = fftSize / 2 + 1;
    const float pi = juce::MathConstants<float>::pi;
    const float binHz = static_cast<float> (sampleRate) / static_cast<float> (fftSize);
    const float blockDurSec = static_cast<float> (fftSize) / static_cast<float> (sampleRate);

    juce::dsp::FFT fft (fftOrder);
    std::vector<float> hannWin (static_cast<size_t> (fftSize));
    for (int i = 0; i < fftSize; ++i)
        hannWin[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            2.0f * pi * static_cast<float> (i) / static_cast<float> (fftSize - 1)));

    auto gaussian = [] (float x, float centre, float width)
    {
        const float safeWidth = std::max (1.0f, width);
        const float d = (x - centre) / safeWidth;
        return std::exp (-0.5f * d * d);
    };

    int processedBlocks = 0;
    int harmonicDrivenBlocks = 0;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = output[static_cast<size_t> (ch)];
        const float* orig = originalInput[ch];
        std::vector<float> corrected (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> winSum (static_cast<size_t> (numSamples), 0.0f);
        std::vector<float> origFFTBuf (static_cast<size_t> (fftSize * 2), 0.0f);
        std::vector<float> outFFTBuf (static_cast<size_t> (fftSize * 2), 0.0f);

        for (int pos = 0; pos < numSamples; pos += hopLen)
        {
            if (shouldCancel && shouldCancel())
                return;

            const float blockStartSec = static_cast<float> (pos) / static_cast<float> (sampleRate);
            const float blockEndSec = static_cast<float> (std::min (numSamples, pos + fftSize)) / static_cast<float> (sampleRate);
            const float blockCenterSec = 0.5f * (blockStartSec + blockEndSec);
            const int blockSampleCount = std::max (1, std::min (fftSize, numSamples - pos));

            float dominantOverlap = 0.0f;
            const PitchAnalyzer::PitchNote* dominantNote = nullptr;
            float avgPitchShiftSt = 0.0f;
            float pitchWeight = 0.0f;
            float localEditWeight = 0.0f;

            for (const auto& note : notes)
            {
                const float noteStart = getEffectiveNoteStartTime (note);
                const float noteEnd = getEffectiveNoteEndTime (note);
                const float overlap = std::max (0.0f, std::min (blockEndSec, noteEnd) - std::max (blockStartSec, noteStart));
                if (overlap <= 0.0f)
                    continue;

                const float overlapWeight = overlap / std::max (0.001f, blockDurSec);
                const bool pitchEdited = hasPitchStyleEdit (note);
                const bool formantEdited = std::abs (note.formantShift) > 0.01f || hasExplicitFormant;
                if (! pitchEdited && ! formantEdited)
                    continue;

                localEditWeight += overlapWeight;
                if (pitchEdited)
                {
                    pitchWeight += overlapWeight;
                    avgPitchShiftSt += (note.correctedPitch - note.detectedPitch) * overlapWeight;
                }
                if (overlapWeight > dominantOverlap)
                {
                    dominantOverlap = overlapWeight;
                    dominantNote = &note;
                }
            }

            if (localEditWeight <= 0.001f)
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

            ++processedBlocks;
            avgPitchShiftSt = pitchWeight > 0.0f ? avgPitchShiftSt / pitchWeight : 0.0f;

            float avgPitchHz = 0.0f;
            int pitchCount = 0;
            for (int i = pos; i < std::min (pos + fftSize, numSamples); ++i)
            {
                if (static_cast<size_t> (i) < detectedPitchHz.size() && detectedPitchHz[static_cast<size_t> (i)] > 0.0f)
                {
                    avgPitchHz += detectedPitchHz[static_cast<size_t> (i)];
                    ++pitchCount;
                }
            }
            if (pitchCount > 0)
                avgPitchHz /= static_cast<float> (pitchCount);
            const float voicedFraction = static_cast<float> (pitchCount) / static_cast<float> (blockSampleCount);

            float avgFormantRatio = 1.0f;
            if (! formantRatios.empty())
            {
                float sumRatio = 0.0f;
                int ratioCount = 0;
                for (int i = pos; i < std::min (pos + fftSize, numSamples); ++i)
                {
                    if (static_cast<size_t> (i) < formantRatios.size())
                    {
                        sumRatio += formantRatios[static_cast<size_t> (i)];
                        ++ratioCount;
                    }
                }
                if (ratioCount > 0)
                    avgFormantRatio = sumRatio / static_cast<float> (ratioCount);
            }

            // Global formant references behave like a voiced timbre field, not only
            // a note-local transform. If no edited note overlaps this block but the
            // block is voiced and a formant shift is active, still apply the sign-
            // specific residual match so off-note voiced audio follows the sample.
            if (hasExplicitFormant && voicedFraction > 0.12f)
                localEditWeight = std::max (localEditWeight, voicedFraction * 0.78f);

            const bool lowerFormant = avgFormantRatio < 0.995f;
            const bool upperFormant = avgFormantRatio > 1.005f;
            const float formantStrength = std::min (1.4f, std::abs (12.0f * std::log2 (std::max (avgFormantRatio, 1.0e-4f))) / 1.8f);
            const float pitchStrength = std::min (1.0f, std::abs (avgPitchShiftSt) / 4.0f);
            const float noteProgress = dominantNote != nullptr
                ? juce::jlimit (0.0f, 1.0f, (blockCenterSec - dominantNote->startTime)
                    / std::max (0.025f, dominantNote->endTime - dominantNote->startTime))
                : 0.5f;
            const float noteMidFocus = std::pow (std::sin (pi * juce::jlimit (0.0f, 1.0f, noteProgress)), 0.9f);
            const float noteEarlyFocus = std::pow (1.0f - juce::jlimit (0.0f, 1.0f, noteProgress), 0.8f);
            const float noteLateFocus = std::pow (juce::jlimit (0.0f, 1.0f, noteProgress), 0.8f);
            const float blockBlend = juce::jlimit (0.0f, 1.0f, localEditWeight);
            const float hqBoost = previewFast ? 0.88f : 1.12f;

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

            float energyBefore = 0.0f;
            float energyAfter = 0.0f;
            for (int i = 0; i < halfBins; ++i)
            {
                const float re = outFFTBuf[static_cast<size_t> (i * 2)];
                const float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyBefore += re * re + im * im;
            }

            bool harmonicDriven = false;
            const float harmonicSigma = previewFast ? 0.18f : 0.14f;
            for (int i = 1; i < halfBins; ++i)
            {
                const float freqHz = static_cast<float> (i) * binHz;
                float harmonicMask = 0.0f;
                if (avgPitchHz > 55.0f && freqHz > avgPitchHz)
                {
                    const float harmonicIndex = freqHz / avgPitchHz;
                    const float nearestHarmonic = std::max (1.0f, std::round (harmonicIndex));
                    const float dist = std::abs (harmonicIndex - nearestHarmonic);
                    harmonicMask = std::exp (-0.5f * (dist / harmonicSigma) * (dist / harmonicSigma));
                    harmonicMask *= smoothstep01 ((freqHz - 180.0f) / 220.0f);
                }

                float dbDelta = 0.0f;
                if (pitchStrength > 0.001f)
                {
                    const float harmonicTilt = 0.24f
                        + 0.38f * gaussian (freqHz, 1800.0f, 900.0f)
                        + 0.70f * gaussian (freqHz, 3600.0f, 1400.0f)
                        + 0.42f * gaussian (freqHz, 6200.0f, 1500.0f);
                    const float lowMidTrim = 0.18f * gaussian (freqHz, 520.0f, 260.0f);
                    dbDelta += pitchStrength * noteMidFocus * hqBoost
                        * harmonicMask * (harmonicTilt - lowMidTrim);
                }

                if (upperFormant)
                {
                    const float formantBand = 0.64f * gaussian (freqHz, 1500.0f, 560.0f)
                        + 0.72f * gaussian (freqHz, 2050.0f, 620.0f)
                        + 1.14f * gaussian (freqHz, 5950.0f, 1080.0f)
                        - 0.92f * gaussian (freqHz, 7900.0f, 760.0f)
                        - 0.18f * gaussian (freqHz, 340.0f, 180.0f);
                    const float broadband = -0.12f * smoothstep01 ((freqHz - 7600.0f) / 2600.0f);
                    const float timeLaw = 0.70f + 0.30f * noteMidFocus + 0.62f * noteLateFocus;
                    dbDelta += formantStrength * hqBoost * timeLaw * (formantBand + broadband) * (0.28f + 0.72f * harmonicMask);
                }
                else if (lowerFormant)
                {
                    const float formantBand = 0.86f * gaussian (freqHz, 1180.0f, 820.0f)
                        + 0.56f * gaussian (freqHz, 1850.0f, 520.0f)
                        + 1.10f * gaussian (freqHz, 5450.0f, 1320.0f)
                        + 0.66f * gaussian (freqHz, 6750.0f, 1180.0f)
                        - 0.98f * gaussian (freqHz, 10800.0f, 980.0f);
                    const float broadband = -0.16f * smoothstep01 ((freqHz - 6800.0f) / 2000.0f)
                        - 0.08f * smoothstep01 ((freqHz - 3200.0f) / 1800.0f);
                    const float timeLaw = 0.74f + 0.68f * noteEarlyFocus + 0.20f * noteMidFocus;
                    dbDelta += formantStrength * hqBoost * timeLaw * (formantBand + broadband) * (0.34f + 0.66f * harmonicMask);
                }

                dbDelta *= intensityScale;
                if (std::abs (dbDelta) > 0.001f)
                {
                    harmonicDriven = harmonicDriven || harmonicMask > 0.15f;
                    const float gain = juce::jlimit (0.55f, 1.85f, std::pow (10.0f, (dbDelta * blockBlend) / 20.0f));
                    outFFTBuf[static_cast<size_t> (i * 2)] *= gain;
                    outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= gain;
                }
            }

            for (int i = 0; i < halfBins; ++i)
            {
                const float re = outFFTBuf[static_cast<size_t> (i * 2)];
                const float im = outFFTBuf[static_cast<size_t> (i * 2 + 1)];
                energyAfter += re * re + im * im;
            }
            if (energyAfter > 1.0e-10f)
            {
                const float scale = std::pow (energyBefore / energyAfter, hasExplicitFormant ? 0.22f : 0.18f);
                for (int i = 0; i < halfBins; ++i)
                {
                    outFFTBuf[static_cast<size_t> (i * 2)] *= scale;
                    outFFTBuf[static_cast<size_t> (i * 2 + 1)] *= scale;
                }
            }

            if (harmonicDriven)
                ++harmonicDrivenBlocks;

            fft.performRealOnlyInverseTransform (outFFTBuf.data());
            for (int i = 0; i < fftSize; ++i)
            {
                const int idx = pos + i;
                if (idx >= 0 && idx < numSamples)
                {
                    const float w = hannWin[static_cast<size_t> (i)];
                    corrected[static_cast<size_t> (idx)] += outFFTBuf[static_cast<size_t> (i)] * w;
                    winSum[static_cast<size_t> (idx)] += w * w;
                }
            }
        }

        for (int s = 0; s < numSamples; ++s)
        {
            if (winSum[static_cast<size_t> (s)] > 0.001f)
                out[static_cast<size_t> (s)] = corrected[static_cast<size_t> (s)] / winSum[static_cast<size_t> (s)];
        }
    }

    logPitchEditorFormant ("reference residual match blocks=" + juce::String (processedBlocks)
        + " harmonicDrivenBlocks=" + juce::String (harmonicDrivenBlocks)
        + " hasPitch=" + juce::String (hasPitchShift ? "true" : "false")
        + " hasFormant=" + juce::String (hasExplicitFormant ? "true" : "false")
        + " intensityScale=" + juce::String (intensityScale, 3)
        + " renderQuality=" + juce::String (previewFast ? "preview_fast" : "final_hq"));
}

static std::vector<PitchOnlyCoreRegion> derivePitchOnlyCoreRegions (
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz)
{
    std::vector<PitchOnlyCoreRegion> regions;
    if (detectedPitchHz.empty())
        return regions;

    const auto hasStableVoicedSupport = [&] (int sampleIndex, int radiusSamples)
    {
        int supported = 0;
        int checked = 0;
        for (int s = std::max (0, sampleIndex - radiusSamples);
             s <= std::min (numSamples - 1, sampleIndex + radiusSamples); ++s)
        {
            ++checked;
            if (static_cast<size_t> (s) < detectedPitchHz.size()
                && detectedPitchHz[static_cast<size_t> (s)] > 0.0f)
            {
                ++supported;
            }
        }

        return checked > 0 && supported * 10 >= checked * 7;
    };

    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;

        PitchOnlyCoreRegion region;
        const int startSample = juce::jlimit (0, numSamples, static_cast<int> (std::floor (note.startTime * sampleRate)));
        const int endSample = juce::jlimit (0, numSamples, static_cast<int> (std::ceil (note.endTime * sampleRate)));
        if (endSample <= startSample)
            continue;
        region.bodyStartSample = startSample;
        region.bodyEndSample = endSample;
        const float detectedHz = midiToHz (note.detectedPitch);
        const float correctedHz = midiToHz (note.correctedPitch);
        region.pitchRatio = detectedHz > 0.0f
            ? juce::jlimit (0.25f, 4.0f, correctedHz / detectedHz)
            : 1.0f;
        region.upwardShift = region.pitchRatio >= 1.0f;

        const int bodyLen = std::max (1, endSample - startSample);
        const int edgeProtectIn = std::max (1, std::min (static_cast<int> (std::round (0.032 * sampleRate)), bodyLen / 3));
        const int edgeProtectOut = std::max (1, std::min (static_cast<int> (std::round (0.038 * sampleRate)), bodyLen / 3));
        const int coreSearchStart = startSample + edgeProtectIn;
        const int coreSearchEnd = endSample - edgeProtectOut;
        if (coreSearchEnd <= coreSearchStart)
            continue;

        const int voicedRadius = std::max (1, static_cast<int> (std::round (0.008 * sampleRate)));
        int coreStart = -1;
        int coreEnd = -1;
        for (int s = coreSearchStart; s < coreSearchEnd; ++s)
        {
            if (static_cast<size_t> (s) < detectedPitchHz.size()
                && detectedPitchHz[static_cast<size_t> (s)] > 0.0f
                && hasStableVoicedSupport (s, voicedRadius))
            {
                coreStart = s;
                break;
            }
        }
        for (int s = coreSearchEnd - 1; s >= coreSearchStart; --s)
        {
            if (static_cast<size_t> (s) < detectedPitchHz.size()
                && detectedPitchHz[static_cast<size_t> (s)] > 0.0f
                && hasStableVoicedSupport (s, voicedRadius))
            {
                coreEnd = s + 1;
                break;
            }
        }

        if (coreStart < 0 || coreEnd <= coreStart)
            continue;

        const int coreLen = coreEnd - coreStart;
        const int minimumCoreLen = std::max (1, static_cast<int> (std::round (0.055 * sampleRate)));
        if (coreLen < minimumCoreLen)
            continue;

        double energySum = 0.0;
        int energyCount = 0;
        for (int s = coreStart; s < coreEnd; ++s)
        {
            float sampleAbs = 0.0f;
            for (int ch = 0; ch < numChannels; ++ch)
                sampleAbs = std::max (sampleAbs, std::abs (originalInput[ch][s]));
            energySum += sampleAbs * sampleAbs;
            ++energyCount;
        }
        const float noteRms = energyCount > 0 ? std::sqrt (static_cast<float> (energySum / static_cast<double> (energyCount))) : 0.0f;
        if (noteRms <= 0.0025f)
            continue;

        region.coreStartSample = coreStart;
        region.coreEndSample = coreEnd;
        regions.push_back (region);
    }

    return regions;
}

static std::vector<float> buildPitchOnlyCoreMask (
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz)
{
    std::vector<float> coreMask (static_cast<size_t> (numSamples), 0.0f);
    if (detectedPitchHz.empty())
        return coreMask;

    const auto regions = derivePitchOnlyCoreRegions (originalInput, numChannels, numSamples, sampleRate, notes, detectedPitchHz);
    if (regions.empty())
        return coreMask;

    const auto hasStableVoicedSupport = [&] (int sampleIndex, int radiusSamples)
    {
        int supported = 0;
        int checked = 0;
        for (int s = std::max (0, sampleIndex - radiusSamples);
             s <= std::min (numSamples - 1, sampleIndex + radiusSamples); ++s)
        {
            ++checked;
            if (static_cast<size_t> (s) < detectedPitchHz.size()
                && detectedPitchHz[static_cast<size_t> (s)] > 0.0f)
            {
                ++supported;
            }
        }
        return checked > 0 && supported * 10 >= checked * 7;
    };

    for (const auto& region : regions)
    {
        const int coreStart = region.coreStartSample;
        const int coreEnd = region.coreEndSample;
        const int coreLen = coreEnd - coreStart;
        const int voicedRadius = std::max (1, static_cast<int> (std::round (0.008 * sampleRate)));

        double energySum = 0.0;
        int energyCount = 0;
        for (int s = coreStart; s < coreEnd; ++s)
        {
            float sampleAbs = 0.0f;
            for (int ch = 0; ch < numChannels; ++ch)
                sampleAbs = std::max (sampleAbs, std::abs (originalInput[ch][s]));
            energySum += sampleAbs * sampleAbs;
            ++energyCount;
        }
        const float noteRms = energyCount > 0 ? std::sqrt (static_cast<float> (energySum / static_cast<double> (energyCount))) : 0.0f;
        if (noteRms <= 1.0e-4f)
            continue;

        for (int s = coreStart; s < coreEnd; ++s)
        {
            if (static_cast<size_t> (s) >= detectedPitchHz.size()
                || detectedPitchHz[static_cast<size_t> (s)] <= 0.0f
                || ! hasStableVoicedSupport (s, voicedRadius))
            {
                continue;
            }

            float sampleAbs = 0.0f;
            for (int ch = 0; ch < numChannels; ++ch)
                sampleAbs = std::max (sampleAbs, std::abs (originalInput[ch][s]));

            const float coreProgress = juce::jlimit (0.0f, 1.0f,
                static_cast<float> (s - coreStart) / static_cast<float> (std::max (1, coreLen - 1)));
            const float coreFocus = std::pow (std::sin (juce::MathConstants<float>::pi * coreProgress), 1.16f);
            const float energyGate = smoothstep01 ((sampleAbs - noteRms * 0.30f) / std::max (noteRms * 0.44f, 1.0e-4f));
            const float regionMask = juce::jlimit (0.0f, 0.72f, coreFocus * energyGate);
            if (regionMask <= 0.0001f)
                continue;

            coreMask[static_cast<size_t> (s)] = std::max (coreMask[static_cast<size_t> (s)], regionMask);
        }
    }

    return coreMask;
}

static bool applyPitchOnlyCoreRmsTrim (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz,
    float maxTrimDb,
    bool lowMidOnly,
    float* appliedTrimDbOut)
{
    if (output.empty() || originalInput == nullptr || numChannels <= 0 || numSamples <= 0 || sampleRate <= 0.0)
        return false;

    const auto regions = derivePitchOnlyCoreRegions (originalInput, numChannels, numSamples, sampleRate, notes, detectedPitchHz);
    if (regions.empty())
        return false;

    const auto coreMask = buildPitchOnlyCoreMask (originalInput, numChannels, numSamples, sampleRate, notes, detectedPitchHz);
    if (coreMask.empty())
        return false;

    std::vector<float> trimMask (static_cast<size_t> (numSamples), 0.0f);
    const int requestedFadeSamples = std::max (1, static_cast<int> (std::round (0.025 * sampleRate)));
    for (const auto& region : regions)
    {
        const int coreStart = juce::jlimit (0, numSamples, region.coreStartSample);
        const int coreEnd = juce::jlimit (coreStart, numSamples, region.coreEndSample);
        const int coreLen = coreEnd - coreStart;
        if (coreLen <= 1)
            continue;

        const int fadeSamples = std::max (1, std::min (requestedFadeSamples, coreLen / 2));
        for (int s = coreStart; s < coreEnd; ++s)
        {
            const float fromStart = static_cast<float> (s - coreStart) / static_cast<float> (fadeSamples);
            const float fromEnd = static_cast<float> (coreEnd - 1 - s) / static_cast<float> (fadeSamples);
            const float edge = smoothstep01 (std::min (fromStart, fromEnd));
            const float core = static_cast<size_t> (s) < coreMask.size()
                ? smoothstep01 (coreMask[static_cast<size_t> (s)] / 0.72f)
                : 0.0f;
            trimMask[static_cast<size_t> (s)] = std::max (trimMask[static_cast<size_t> (s)], edge * core);
        }
    }

    double sourceEnergy = 0.0;
    double outputEnergy = 0.0;
    double weightSum = 0.0;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (static_cast<size_t> (ch) >= output.size())
            continue;

        for (int s = 0; s < numSamples; ++s)
        {
            const float weight = trimMask[static_cast<size_t> (s)];
            if (weight <= 0.0001f)
                continue;

            const float sourceSample = originalInput[ch][s];
            const float renderedSample = static_cast<size_t> (s) < output[static_cast<size_t> (ch)].size()
                ? output[static_cast<size_t> (ch)][static_cast<size_t> (s)]
                : 0.0f;
            sourceEnergy += static_cast<double> (sourceSample) * static_cast<double> (sourceSample) * weight;
            outputEnergy += static_cast<double> (renderedSample) * static_cast<double> (renderedSample) * weight;
            weightSum += weight;
        }
    }

    if (weightSum <= 1.0 || sourceEnergy <= 1.0e-10 || outputEnergy <= 1.0e-10)
        return false;

    const double sourceRms = std::sqrt (sourceEnergy / weightSum);
    const double outputRms = std::sqrt (outputEnergy / weightSum);
    const float requestedTrimDb = static_cast<float> (20.0 * std::log10 (sourceRms / outputRms));
    const float trimDb = juce::jlimit (-std::abs (maxTrimDb), std::abs (maxTrimDb), requestedTrimDb);
    if (std::abs (trimDb) < 0.02f)
    {
        if (appliedTrimDbOut != nullptr)
            *appliedTrimDbOut = 0.0f;
        return false;
    }

    const float gain = std::pow (10.0f, trimDb / 20.0f);
    const float lowpassCutoffHz = juce::jlimit (900.0f, 3200.0f, getEnvFloat ("OPENSTUDIO_PITCH_CORE_RMS_LOWMID_CUTOFF_HZ", 2200.0f));
    const float highCompensation = lowMidOnly
        ? juce::jlimit (0.0f, 1.4f, getEnvFloat ("OPENSTUDIO_PITCH_CORE_RMS_HIGH_COMP", 1.4f))
        : 0.0f;
    const float lowpassCoeff = static_cast<float> (std::exp (
        -juce::MathConstants<double>::twoPi * static_cast<double> (lowpassCutoffHz) / sampleRate));
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (static_cast<size_t> (ch) >= output.size())
            continue;

        std::vector<float> lowMid;
        if (lowMidOnly)
        {
            lowMid = output[static_cast<size_t> (ch)];
            float state = 0.0f;
            for (auto& sample : lowMid)
            {
                state = (1.0f - lowpassCoeff) * sample + lowpassCoeff * state;
                sample = state;
            }
            state = 0.0f;
            for (auto it = lowMid.rbegin(); it != lowMid.rend(); ++it)
            {
                state = (1.0f - lowpassCoeff) * *it + lowpassCoeff * state;
                *it = state;
            }
        }

        for (int s = 0; s < numSamples && static_cast<size_t> (s) < output[static_cast<size_t> (ch)].size(); ++s)
        {
            const float weight = trimMask[static_cast<size_t> (s)];
            if (weight <= 0.0001f)
                continue;

            if (lowMidOnly)
            {
                const float current = output[static_cast<size_t> (ch)][static_cast<size_t> (s)];
                const float lowMidSample = lowMid[static_cast<size_t> (s)];
                const float highSample = current - lowMidSample;
                output[static_cast<size_t> (ch)][static_cast<size_t> (s)] += (gain - 1.0f)
                    * (lowMidSample - highCompensation * highSample)
                    * weight;
            }
            else
            {
                const float localGain = 1.0f + (gain - 1.0f) * weight;
                output[static_cast<size_t> (ch)][static_cast<size_t> (s)] *= localGain;
            }
        }
    }

    if (appliedTrimDbOut != nullptr)
        *appliedTrimDbOut = trimDb;
    return true;
}

static bool applyPitchOnlyCoreAperiodicTexture (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz,
    bool downwardOnly,
    float* mixUsedOut)
{
    if (output.empty() || originalInput == nullptr || numChannels <= 0 || numSamples <= 0 || sampleRate <= 0.0)
        return false;

    const float defaultMix = downwardOnly ? 0.20f : 0.30f;
    const float mix = juce::jlimit (0.0f, 0.30f, getEnvFloat (
        downwardOnly ? "OPENSTUDIO_PITCH_CORE_TEXTURE_MIX_DOWN" : "OPENSTUDIO_PITCH_CORE_TEXTURE_MIX_UP",
        defaultMix));
    if (mix <= 0.001f)
        return false;

    const float cutoffHz = juce::jlimit (2600.0f, 9000.0f, getEnvFloat (
        downwardOnly ? "OPENSTUDIO_PITCH_CORE_TEXTURE_CUTOFF_HZ_DOWN" : "OPENSTUDIO_PITCH_CORE_TEXTURE_CUTOFF_HZ_UP",
        downwardOnly ? 5200.0f : 4200.0f));

    auto coreMask = buildPitchOnlyCoreMask (originalInput, numChannels, numSamples, sampleRate, notes, detectedPitchHz);
    if (coreMask.empty())
        return false;

    float maskPeak = 0.0f;
    for (auto& mask : coreMask)
    {
        mask = smoothstep01 (mask / 0.72f);
        maskPeak = std::max (maskPeak, mask);
    }
    if (maskPeak <= 0.001f)
        return false;

    const float coeff = static_cast<float> (std::exp (
        -juce::MathConstants<double>::twoPi * static_cast<double> (cutoffHz) / sampleRate));

    auto makeZeroPhaseLowpass = [coeff] (const std::vector<float>& source)
    {
        std::vector<float> low = source;
        float state = 0.0f;
        for (auto& sample : low)
        {
            state = (1.0f - coeff) * sample + coeff * state;
            sample = state;
        }

        state = 0.0f;
        for (auto it = low.rbegin(); it != low.rend(); ++it)
        {
            state = (1.0f - coeff) * *it + coeff * state;
            *it = state;
        }
        return low;
    };

    bool changed = false;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (static_cast<size_t> (ch) >= output.size()
            || output[static_cast<size_t> (ch)].size() < static_cast<size_t> (numSamples))
            continue;

        std::vector<float> source (static_cast<size_t> (numSamples), 0.0f);
        for (int s = 0; s < numSamples; ++s)
            source[static_cast<size_t> (s)] = originalInput[ch][s];

        const auto sourceLow = makeZeroPhaseLowpass (source);
        const auto outputLow = makeZeroPhaseLowpass (output[static_cast<size_t> (ch)]);
        auto& dst = output[static_cast<size_t> (ch)];
        for (int s = 0; s < numSamples; ++s)
        {
            const float mask = coreMask[static_cast<size_t> (s)];
            if (mask <= 0.001f)
                continue;

            const float sourceHigh = source[static_cast<size_t> (s)] - sourceLow[static_cast<size_t> (s)];
            const float renderedHigh = dst[static_cast<size_t> (s)] - outputLow[static_cast<size_t> (s)];
            dst[static_cast<size_t> (s)] += (sourceHigh - renderedHigh) * (mix * mask);
            changed = true;
        }
    }

    if (changed && mixUsedOut != nullptr)
        *mixUsedOut = mix;
    return changed;
}

static bool applyPitchOnlyCoreDirectionalLevel (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz,
    bool downwardOnly,
    float* appliedDbOut)
{
    if (output.empty() || originalInput == nullptr || numChannels <= 0 || numSamples <= 0 || sampleRate <= 0.0)
        return false;

    const float defaultDb = downwardOnly ? -0.90f : 1.05f;
    const float gainDb = juce::jlimit (-1.5f, 1.5f, getEnvFloat (
        downwardOnly ? "OPENSTUDIO_PITCH_CORE_LEVEL_DB_DOWN" : "OPENSTUDIO_PITCH_CORE_LEVEL_DB_UP",
        defaultDb));
    if (std::abs (gainDb) <= 0.01f)
        return false;

    auto coreMask = buildPitchOnlyCoreMask (originalInput, numChannels, numSamples, sampleRate, notes, detectedPitchHz);
    if (coreMask.empty())
        return false;

    float maskPeak = 0.0f;
    for (auto& mask : coreMask)
    {
        mask = smoothstep01 (mask / 0.72f);
        maskPeak = std::max (maskPeak, mask);
    }
    if (maskPeak <= 0.001f)
        return false;

    const float gain = std::pow (10.0f, gainDb / 20.0f);
    bool changed = false;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (static_cast<size_t> (ch) >= output.size())
            continue;

        auto& dst = output[static_cast<size_t> (ch)];
        for (int s = 0; s < numSamples && static_cast<size_t> (s) < dst.size(); ++s)
        {
            const float mask = coreMask[static_cast<size_t> (s)];
            if (mask <= 0.001f)
                continue;

            dst[static_cast<size_t> (s)] *= 1.0f + (gain - 1.0f) * mask;
            changed = true;
        }
    }

    if (changed && appliedDbOut != nullptr)
        *appliedDbOut = gainDb;
    return changed;
}

static std::vector<float> buildPitchOnlyMonoReference (
    const float* const* originalInput,
    int numChannels,
    int numSamples)
{
    std::vector<float> mono (static_cast<size_t> (numSamples), 0.0f);
    if (numChannels <= 0 || numSamples <= 0)
        return mono;

    const float channelScale = 1.0f / static_cast<float> (numChannels);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        const auto* src = originalInput[ch];
        for (int s = 0; s < numSamples; ++s)
            mono[static_cast<size_t> (s)] += src[s] * channelScale;
    }

    return mono;
}

static int estimateLocalPitchPeriodSamples (
    const std::vector<float>& detectedPitchHz,
    int sampleIndex,
    double sampleRate,
    int numSamples)
{
    if (detectedPitchHz.empty() || numSamples <= 0 || sampleRate <= 0.0)
        return static_cast<int> (std::round (sampleRate / 220.0));

    const int safeIndex = juce::jlimit (0, numSamples - 1, sampleIndex);
    float pitchHz = detectedPitchHz[static_cast<size_t> (safeIndex)];
    if (pitchHz <= 0.0f)
    {
        const int searchRadius = std::max (1, static_cast<int> (std::round (0.012 * sampleRate)));
        for (int delta = 1; delta <= searchRadius; ++delta)
        {
            const int left = safeIndex - delta;
            if (left >= 0 && detectedPitchHz[static_cast<size_t> (left)] > 0.0f)
            {
                pitchHz = detectedPitchHz[static_cast<size_t> (left)];
                break;
            }

            const int right = safeIndex + delta;
            if (right < numSamples && detectedPitchHz[static_cast<size_t> (right)] > 0.0f)
            {
                pitchHz = detectedPitchHz[static_cast<size_t> (right)];
                break;
            }
        }
    }

    if (pitchHz <= 0.0f)
        pitchHz = 220.0f;

    return juce::jlimit (24, 2048, static_cast<int> (std::round (sampleRate / pitchHz)));
}

static int findStrongestAbsolutePeak (
    const std::vector<float>& mono,
    int expectedSample,
    int radiusSamples,
    int searchStart,
    int searchEnd)
{
    if (mono.empty())
        return -1;

    const int lo = std::max (searchStart, expectedSample - radiusSamples);
    const int hi = std::min (searchEnd, expectedSample + radiusSamples);
    if (hi <= lo)
        return -1;

    float bestValue = -1.0f;
    int bestIndex = -1;
    for (int s = lo; s <= hi; ++s)
    {
        const float value = std::abs (mono[static_cast<size_t> (s)]);
        if (value > bestValue)
        {
            bestValue = value;
            bestIndex = s;
        }
    }

    return bestIndex;
}

static std::vector<int> buildPitchOnlyAnalysisMarks (
    const std::vector<float>& mono,
    const std::vector<float>& detectedPitchHz,
    const PitchOnlyCoreRegion& region,
    double sampleRate,
    int numSamples)
{
    std::vector<int> marks;
    if (region.coreEndSample <= region.coreStartSample || mono.empty())
        return marks;

    const int seedPeriod = estimateLocalPitchPeriodSamples (detectedPitchHz,
                                                            (region.coreStartSample + region.coreEndSample) / 2,
                                                            sampleRate,
                                                            numSamples);
    const int seedExpected = region.coreStartSample + seedPeriod / 2;
    const int seed = findStrongestAbsolutePeak (mono,
                                                seedExpected,
                                                std::max (8, seedPeriod / 2),
                                                region.coreStartSample,
                                                region.coreEndSample - 1);
    if (seed < 0)
        return marks;

    marks.push_back (seed);

    int cursor = seed;
    while (true)
    {
        const int localPeriod = estimateLocalPitchPeriodSamples (detectedPitchHz, cursor, sampleRate, numSamples);
        const int expected = cursor + localPeriod;
        if (expected >= region.coreEndSample)
            break;

        const int next = findStrongestAbsolutePeak (mono,
                                                    expected,
                                                    std::max (8, static_cast<int> (std::round (localPeriod * 0.40f))),
                                                    std::max (region.coreStartSample, cursor + std::max (4, localPeriod / 3)),
                                                    region.coreEndSample - 1);
        if (next <= cursor)
            break;

        marks.push_back (next);
        cursor = next;
        if (static_cast<int> (marks.size()) > 4096)
            break;
    }

    cursor = seed;
    while (true)
    {
        const int localPeriod = estimateLocalPitchPeriodSamples (detectedPitchHz, cursor, sampleRate, numSamples);
        const int expected = cursor - localPeriod;
        if (expected <= region.coreStartSample)
            break;

        const int prev = findStrongestAbsolutePeak (mono,
                                                    expected,
                                                    std::max (8, static_cast<int> (std::round (localPeriod * 0.40f))),
                                                    region.coreStartSample,
                                                    std::min (region.coreEndSample - 1, cursor - std::max (4, localPeriod / 3)));
        if (prev < region.coreStartSample || prev >= cursor)
            break;

        marks.insert (marks.begin(), prev);
        cursor = prev;
        if (static_cast<int> (marks.size()) > 4096)
            break;
    }

    return marks;
}

static int findNearestAnalysisMarkIndex (const std::vector<int>& marks, float targetSample)
{
    if (marks.empty())
        return -1;

    const auto it = std::lower_bound (marks.begin(), marks.end(), static_cast<int> (std::round (targetSample)));
    if (it == marks.begin())
        return 0;
    if (it == marks.end())
        return static_cast<int> (marks.size()) - 1;

    const int hi = static_cast<int> (std::distance (marks.begin(), it));
    const int lo = hi - 1;
    return std::abs (marks[static_cast<size_t> (hi)] - targetSample)
        < std::abs (marks[static_cast<size_t> (lo)] - targetSample)
        ? hi
        : lo;
}

static bool applyPitchOnlyCorePsolaCorrection (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<PitchOnlyCoreRegion>& regions,
    const std::vector<float>& detectedPitchHz,
    const std::vector<float>& coreMask,
    PitchResynthesizer::RenderQuality renderQuality,
    bool addEnvelopeTrim,
    PitchOnlyStageBStats& stats,
    std::function<bool()> shouldCancel)
{
    const float wetCap = addEnvelopeTrim
        ? (renderQuality == PitchResynthesizer::RenderQuality::PreviewFast ? 0.96f : 1.00f)
        : (renderQuality == PitchResynthesizer::RenderQuality::PreviewFast ? 0.90f : 0.96f);
    stats.wetCap = wetCap;

    auto mono = buildPitchOnlyMonoReference (originalInput, numChannels, numSamples);
    if (mono.empty())
        return false;

    std::vector<std::vector<float>> psolaOutput (static_cast<size_t> (numChannels),
                                                 std::vector<float> (static_cast<size_t> (numSamples), 0.0f));
    std::vector<float> psolaWeight (static_cast<size_t> (numSamples), 0.0f);

    int totalPitchMarks = 0;
    int appliedRegions = 0;

    for (const auto& region : regions)
    {
        if (shouldCancel && shouldCancel())
            return false;

        if (region.coreStartSample < 0
            || region.coreEndSample <= region.coreStartSample
            || std::abs (region.pitchRatio - 1.0f) < 1.0e-3f)
        {
            continue;
        }

        const auto marks = buildPitchOnlyAnalysisMarks (mono, detectedPitchHz, region, sampleRate, numSamples);
        if (static_cast<int> (marks.size()) < 4)
            continue;

        totalPitchMarks += static_cast<int> (marks.size());
        ++appliedRegions;

        const float targetPeriod = std::max (12.0f,
            static_cast<float> (estimateLocalPitchPeriodSamples (detectedPitchHz,
                                                                 (region.coreStartSample + region.coreEndSample) / 2,
                                                                 sampleRate,
                                                                 numSamples)))
            / std::max (0.25f, region.pitchRatio);

        std::vector<float> synthesisMarks;
        synthesisMarks.reserve (marks.size() * 2);
        float synthesisCursor = static_cast<float> (marks.front());
        while (synthesisCursor < static_cast<float> (region.coreEndSample))
        {
            if (synthesisCursor >= static_cast<float> (region.coreStartSample))
                synthesisMarks.push_back (synthesisCursor);
            synthesisCursor += targetPeriod;
            if (synthesisMarks.size() > 8192)
                break;
        }

        if (synthesisMarks.size() < 3)
            continue;

        for (const float synthMark : synthesisMarks)
        {
            const int markIndex = findNearestAnalysisMarkIndex (marks, synthMark);
            if (markIndex < 0)
                continue;

            const int analysisMark = marks[static_cast<size_t> (markIndex)];
            const int localPeriod = estimateLocalPitchPeriodSamples (detectedPitchHz, analysisMark, sampleRate, numSamples);
            const int halfWindow = juce::jlimit (24, 1024, static_cast<int> (std::round (localPeriod * 1.35f)));
            const int destCenter = static_cast<int> (std::round (synthMark));

            for (int n = -halfWindow; n <= halfWindow; ++n)
            {
                const int srcIndex = analysisMark + n;
                const int dstIndex = destCenter + n;
                if (srcIndex < region.coreStartSample || srcIndex >= region.coreEndSample
                    || dstIndex < region.coreStartSample || dstIndex >= region.coreEndSample)
                {
                    continue;
                }

                const float phase = static_cast<float> (n + halfWindow) / static_cast<float> (2 * halfWindow + 1);
                const float window = 0.5f - 0.5f * std::cos (2.0f * juce::MathConstants<float>::pi * phase);
                psolaWeight[static_cast<size_t> (dstIndex)] += window;
                for (int ch = 0; ch < numChannels; ++ch)
                    psolaOutput[static_cast<size_t> (ch)][static_cast<size_t> (dstIndex)] += originalInput[ch][srcIndex] * window;
            }
        }
    }

    if (appliedRegions == 0)
        return false;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = output[static_cast<size_t> (ch)];
        auto psola = psolaOutput[static_cast<size_t> (ch)];

        for (int s = 0; s < numSamples; ++s)
        {
            const float weight = psolaWeight[static_cast<size_t> (s)];
            if (weight > 1.0e-4f)
                psola[static_cast<size_t> (s)] /= weight;
            else
                psola[static_cast<size_t> (s)] = out[static_cast<size_t> (s)];
        }

        if (addEnvelopeTrim)
        {
            std::vector<std::vector<float>> trimBuffer (1, psola);
            const float* trimInput[1] = { originalInput[ch] };
            applyPitchEnvelopeAnchorMatch (trimBuffer,
                                           trimInput,
                                           1,
                                           numSamples,
                                           sampleRate,
                                           notes,
                                           detectedPitchHz,
                                           PitchOnlyRendererBranch::ModelCore,
                                           renderQuality,
                                           shouldCancel);
            psola = std::move (trimBuffer.front());
        }

        for (int s = 0; s < numSamples; ++s)
        {
            const float mask = std::min (coreMask[static_cast<size_t> (s)], wetCap);
            if (mask <= 0.0001f)
                continue;

            out[static_cast<size_t> (s)] = out[static_cast<size_t> (s)] * (1.0f - mask)
                + psola[static_cast<size_t> (s)] * mask;
        }
    }

    stats.pitchMarkCount = totalPitchMarks;
    stats.ran = true;
    return true;
}

static PitchOnlyStageBStats applyPitchOnlyCoreSerialCorrection (
    std::vector<std::vector<float>>& output,
    const float* const* originalInput,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const std::vector<float>& detectedPitchHz,
    PitchResynthesizer::RenderQuality renderQuality,
    PitchOnlyRendererBranch rendererBranch,
    std::function<bool()> shouldCancel)
{
    PitchOnlyStageBStats stats;
    stats.branchName = getPitchOnlyRendererBranchName (rendererBranch);
    float signedShiftSum = 0.0f;
    int signedShiftCount = 0;
    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;
        signedShiftSum += (note.correctedPitch - note.detectedPitch);
        ++signedShiftCount;
    }
    const bool downwardShift = signedShiftCount > 0 && (signedShiftSum / static_cast<float> (signedShiftCount)) < 0.0f;
    stats.wetCap = renderQuality == PitchResynthesizer::RenderQuality::PreviewFast
        ? (downwardShift ? 0.40f : 0.34f)
        : (downwardShift ? 0.62f : 0.52f);
    float stageBWetScale = getPitchOnlyStageBWetScale (rendererBranch, downwardShift);
    const float avgEditedNoteDurationSec = getAverageEditedNoteDurationSec (notes);
    if ((rendererBranch == PitchOnlyRendererBranch::HybridReset
         || rendererBranch == PitchOnlyRendererBranch::HybridStructural)
        && ! downwardShift
        && avgEditedNoteDurationSec > 0.0f
        && avgEditedNoteDurationSec < 0.80f)
    {
        stageBWetScale *= 1.25f;
    }
    stats.wetCap = juce::jlimit (0.0f, 1.0f, stats.wetCap * stageBWetScale);

    if (detectedPitchHz.empty())
    {
        stats.failedClosed = true;
        return stats;
    }

    const auto regions = derivePitchOnlyCoreRegions (originalInput, numChannels, numSamples, sampleRate, notes, detectedPitchHz);
    stats.regionCount = static_cast<int> (regions.size());
    for (const auto& region : regions)
        stats.longestCoreSamples = std::max (stats.longestCoreSamples, region.coreEndSample - region.coreStartSample);

    if (regions.empty())
    {
        stats.failedClosed = true;
        return stats;
    }

    auto coreMask = buildPitchOnlyCoreMask (originalInput, numChannels, numSamples, sampleRate, notes, detectedPitchHz);
    bool hasCore = false;
    for (const auto mask : coreMask)
    {
        if (mask > 0.0001f)
        {
            hasCore = true;
            break;
        }
    }
    if (! hasCore)
    {
        stats.failedClosed = true;
        return stats;
    }

    if (stats.wetCap <= 0.0001f)
    {
        stats.failedClosed = true;
        logPitchEditorFormant ("pitch-only core serial correction bypassed branch=" + stats.branchName
            + " wetScale=" + juce::String (stageBWetScale, 3)
            + " downward=" + juce::String (downwardShift ? "true" : "false"));
        return stats;
    }

    if (rendererBranch == PitchOnlyRendererBranch::PsolaCore
        || rendererBranch == PitchOnlyRendererBranch::ModelCore)
    {
        const bool addEnvelopeTrim = rendererBranch == PitchOnlyRendererBranch::ModelCore;
        if (applyPitchOnlyCorePsolaCorrection (output,
                                               originalInput,
                                               numChannels,
                                               numSamples,
                                               sampleRate,
                                               notes,
                                               regions,
                                               detectedPitchHz,
                                               coreMask,
                                               renderQuality,
                                               addEnvelopeTrim,
                                               stats,
                                               shouldCancel))
        {
            logPitchEditorFormant ("pitch-only core serial correction active branch=" + stats.branchName
                + " wetCap=" + juce::String (stats.wetCap, 3)
                + " regions=" + juce::String (stats.regionCount)
                + " pitchMarks=" + juce::String (stats.pitchMarkCount)
                + " longestCoreMs=" + juce::String (sampleRate > 0.0
                    ? 1000.0 * static_cast<double> (stats.longestCoreSamples) / sampleRate : 0.0, 1));
            return stats;
        }
    }

    std::vector<std::vector<float>> corrected = output;
    applyPitchEnvelopeAnchorMatch (corrected, originalInput, numChannels, numSamples,
                                   sampleRate, notes, detectedPitchHz,
                                   rendererBranch,
                                   renderQuality, shouldCancel);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& out = output[static_cast<size_t> (ch)];
        const auto& serialCorrected = corrected[static_cast<size_t> (ch)];
        for (int s = 0; s < numSamples; ++s)
        {
            const float mask = std::min (coreMask[static_cast<size_t> (s)], stats.wetCap);
            if (mask <= 0.0001f)
                continue;
            out[static_cast<size_t> (s)] = out[static_cast<size_t> (s)] * (1.0f - mask)
                + serialCorrected[static_cast<size_t> (s)] * mask;
        }
    }

    stats.ran = true;
    logPitchEditorFormant ("pitch-only core serial correction active branch=" + stats.branchName
        + " mode=envelope-anchor_only wetCap="
        + juce::String (stats.wetCap, 3)
        + " regions=" + juce::String (stats.regionCount)
        + " longestCoreMs=" + juce::String (sampleRate > 0.0
            ? 1000.0 * static_cast<double> (stats.longestCoreSamples) / sampleRate : 0.0, 1));
    return stats;
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

    auto frameIndexForTime = [&] (float timeSec) -> int
    {
        const int sample = static_cast<int> (std::round (static_cast<double> (timeSec) * sampleRate));
        return juce::jlimit (0, static_cast<int> (frames.size()) - 1,
                             (sample - firstFrameSample) / std::max (1, hopSize));
    };

    auto averageFrameValue = [&] (int startFrame, int endFrame, bool confidence) -> float
    {
        if (frames.empty())
            return confidence ? 0.0f : -100.0f;

        startFrame = juce::jlimit (0, static_cast<int> (frames.size()) - 1, startFrame);
        endFrame = juce::jlimit (startFrame, static_cast<int> (frames.size()) - 1, endFrame);
        double sum = 0.0;
        int count = 0;
        for (int i = startFrame; i <= endFrame; ++i)
        {
            const auto& frame = frames[static_cast<size_t> (i)];
            sum += confidence ? static_cast<double> (frame.confidence) : static_cast<double> (frame.rmsDB);
            ++count;
        }
        if (count <= 0)
            return confidence ? 0.0f : -100.0f;
        return static_cast<float> (sum / static_cast<double> (count));
    };

    auto hasContinuousVoicedEntry = [&] (const PitchAnalyzer::PitchNote& note) -> bool
    {
        const auto entryKind = note.entryBoundaryKind.trim().toLowerCase();
        if (entryKind == "hard_word_like")
            return false;
        if (entryKind == "soft_legato" || entryKind == "internal_bend" || entryKind == "internal_vibrato")
            return true;

        if (frames.empty())
            return false;

        const int startFrame = frameIndexForTime (note.startTime - 0.040f);
        const int endFrame = frameIndexForTime (note.startTime + 0.020f);
        if (endFrame <= startFrame)
            return false;

        int voicedCount = 0;
        int totalCount = 0;
        int unvoicedNearEntry = 0;
        float minRms = 100.0f;
        float minConfidence = 1.0f;
        for (int i = startFrame; i <= endFrame; ++i)
        {
            const auto& frame = frames[static_cast<size_t> (i)];
            const bool voiced = frame.voiced && frame.midiNote > 0.0f && frame.confidence >= 0.25f && frame.rmsDB > -60.0f;
            voicedCount += voiced ? 1 : 0;
            totalCount += 1;
            minRms = std::min (minRms, frame.rmsDB);
            minConfidence = std::min (minConfidence, frame.confidence);

            const float frameTime = frame.time;
            if (std::abs (frameTime - note.startTime) <= 0.018f && ! voiced)
                ++unvoicedNearEntry;
        }

        const float voicedCoverage = totalCount > 0 ? static_cast<float> (voicedCount) / static_cast<float> (totalCount) : 0.0f;
        const int leftStart = frameIndexForTime (note.startTime - 0.060f);
        const int leftEnd = frameIndexForTime (note.startTime - 0.018f);
        const int rightStart = frameIndexForTime (note.startTime + 0.010f);
        const int rightEnd = frameIndexForTime (note.startTime + 0.045f);
        const float leftRms = averageFrameValue (leftStart, leftEnd, false);
        const float rightRms = averageFrameValue (rightStart, rightEnd, false);
        const float leftConfidence = averageFrameValue (leftStart, leftEnd, true);
        const float rightConfidence = averageFrameValue (rightStart, rightEnd, true);
        const float referenceRms = std::max (leftRms, rightRms);
        const float referenceConfidence = std::max (leftConfidence, rightConfidence);
        const bool strongRmsDip = referenceRms - minRms >= 8.0f;
        const bool strongConfidenceDip = referenceConfidence - minConfidence >= 0.22f;
        const bool unvoicedBreak = unvoicedNearEntry >= 2;

        return voicedCoverage >= 0.65f && ! strongRmsDip && ! strongConfidenceDip && ! unvoicedBreak;
    };

    for (size_t ni = 0; ni < noteOrder.size(); ++ni)
    {
        const auto& note = notes[noteOrder[ni]];

        // Skip unedited notes entirely
        bool isEdited = hasPitchStyleEdit (note);
        if (!isEdited) continue;

        int startSample = static_cast<int>(note.startTime * sampleRate);
        int endSample = static_cast<int>(note.endTime * sampleRate);
        startSample = juce::jlimit(0, numSamples - 1, startSample);
        endSample = juce::jlimit(0, numSamples - 1, endSample);

        // How far the user moved the note center
        float shiftAmount = note.correctedPitch - note.detectedPitch;
        float driftCorrection = note.driftCorrectionAmount;
        float noteCenter = note.detectedPitch; // the note's average detected pitch

        // Boundary ownership is intentionally narrow now: only the immediate
        // left tail and immediate right head may be smoothed, and only with a
        // tiny span. We no longer let default pitch-note spill chain across
        // wider neighbor groups.
        constexpr float kImmediateNeighborGapSec = 0.18f;
        constexpr float kBoundarySmoothDefaultMs = 50.0f;
        constexpr float kBoundarySmoothMaxMs = 80.0f;

        [[maybe_unused]] bool hasImmediatePrevNeighbor = false;
        [[maybe_unused]] bool hasImmediateNextNeighbor = false;
        if (ni > 0)
        {
            const auto& prevAny = notes[noteOrder[ni - 1]];
            const float gap = note.startTime - prevAny.endTime;
            hasImmediatePrevNeighbor = gap <= kImmediateNeighborGapSec;
        }
        if (ni + 1 < noteOrder.size())
        {
            const auto& nextAny = notes[noteOrder[ni + 1]];
            const float gap = nextAny.startTime - note.endTime;
            hasImmediateNextNeighbor = gap <= kImmediateNeighborGapSec;
        }

        const float requestedTransIn = (note.transitionIn > 0.0f)
            ? juce::jlimit (0.0f, kBoundarySmoothMaxMs, note.transitionIn)
            : 0.0f;
        const float requestedTransOut = (note.transitionOut > 0.0f)
            ? juce::jlimit (0.0f, kBoundarySmoothMaxMs, note.transitionOut)
            : 0.0f;
        const float effectiveTransIn  = (requestedTransIn > 0.0f)  ? requestedTransIn  : kBoundarySmoothDefaultMs;
        const float effectiveTransOut = (requestedTransOut > 0.0f) ? requestedTransOut : kBoundarySmoothDefaultMs;

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
        const bool upwardShift = shiftAmount >= 0.0f;
        const float defaultLargeEntryHandoffMs = upwardShift
            ? getEnvFloat ("OPENSTUDIO_PITCH_ENTRY_HANDOFF_UP_BODY_MS", 0.0f)
            : getEnvFloat ("OPENSTUDIO_PITCH_ENTRY_HANDOFF_DOWN_BODY_MS", 40.0f);
        const float largeEntryHandoffMs = juce::jlimit (
            0.0f, 60.0f, getEnvFloat ("OPENSTUDIO_PITCH_ENTRY_HANDOFF_BODY_MS", defaultLargeEntryHandoffMs));
        const bool largeEntryPitchEdit = std::abs (shiftAmount) > 2.0f && largeEntryHandoffMs > 0.0f;
        const auto entryKindForHandoff = note.entryBoundaryKind.trim().toLowerCase();
        const bool explicitContinuousEntry = entryKindForHandoff == "soft_legato"
            || entryKindForHandoff == "internal_bend"
            || entryKindForHandoff == "internal_vibrato";
        const bool continuousEntry = hasPrevNote || explicitContinuousEntry;
        const bool entryPitchHandoff = continuousEntry || largeEntryPitchEdit;
        const float entryDryPreserveMs = 0.0f;
        const float entryPreMs = continuousEntry
            ? (upwardShift ? 16.0f : 24.0f)
            : 0.0f;
        const float entryBodyMs = continuousEntry
            ? (upwardShift ? 40.0f : 55.0f)
            : (largeEntryPitchEdit ? largeEntryHandoffMs : 0.0f);
        juce::ignoreUnused (hasContinuousVoicedEntry);

        const int standardTransInSamples = upwardShift
            ? 0
            : static_cast<int> (std::round (effectiveTransIn * 0.001f * static_cast<float> (sampleRate)));
        const int entryPreSamples = entryPitchHandoff
            ? static_cast<int> (std::round (entryPreMs * 0.001f * static_cast<float> (sampleRate)))
            : standardTransInSamples;
        const int entryDryPreserveSamples = static_cast<int> (std::round (entryDryPreserveMs * 0.001f * static_cast<float> (sampleRate)));
        const int entryBodySamples = entryPitchHandoff
            ? std::max (1, static_cast<int> (std::round (entryBodyMs * 0.001f * static_cast<float> (sampleRate))))
            : 0;
        const int entryHandoffStartSample = std::max (0, startSample - entryPreSamples);
        const int entryHandoffEndSample = std::min (numSamples - 1, startSample + entryBodySamples);

        int transInSamplesInt  = std::max (0, startSample - entryHandoffStartSample);
        int transOutSamplesInt = static_cast<int>(effectiveTransOut * 0.001f * static_cast<float>(sampleRate));
        int loopStart = entryHandoffStartSample;
        int loopEnd   = std::min(numSamples - 1, endSample + transOutSamplesInt);

        if (transInSamplesInt > 0)
        {
            lastRenderDiagnostics.immediateLeftNeighborUsed = true;
            lastRenderDiagnostics.leftNeighborSamplesRendered += transInSamplesInt;
            lastRenderDiagnostics.leftNeighborSmoothMs = std::max(lastRenderDiagnostics.leftNeighborSmoothMs,
                                                                  static_cast<double>(effectiveTransIn));
        }
        if (transOutSamplesInt > 0)
        {
            lastRenderDiagnostics.immediateRightNeighborUsed = true;
            lastRenderDiagnostics.rightNeighborSamplesRendered += transOutSamplesInt;
            lastRenderDiagnostics.rightNeighborSmoothMs = std::max(lastRenderDiagnostics.rightNeighborSmoothMs,
                                                                   static_cast<double>(effectiveTransOut));
        }

        if (entryPitchHandoff)
        {
            lastRenderDiagnostics.noteHqEntryPitchHandoffUsed = true;
            lastRenderDiagnostics.pitchOnlyEntryHandoffUsed = true;
            if (lastRenderDiagnostics.noteHqEntryPitchHandoffStartSec <= 0.0)
                lastRenderDiagnostics.noteHqEntryPitchHandoffStartSec = static_cast<double> (entryHandoffStartSample) / sampleRate;
            else
                lastRenderDiagnostics.noteHqEntryPitchHandoffStartSec = std::min (
                    lastRenderDiagnostics.noteHqEntryPitchHandoffStartSec,
                    static_cast<double> (entryHandoffStartSample) / sampleRate);
            lastRenderDiagnostics.noteHqEntryPitchHandoffEndSec = std::max (
                lastRenderDiagnostics.noteHqEntryPitchHandoffEndSec,
                static_cast<double> (entryHandoffEndSample) / sampleRate);
            lastRenderDiagnostics.noteHqEntryPitchHandoffPreMs = std::max (
                lastRenderDiagnostics.noteHqEntryPitchHandoffPreMs,
                1000.0 * static_cast<double> (std::max (0, startSample - entryHandoffStartSample)) / sampleRate);
            lastRenderDiagnostics.noteHqEntryPitchHandoffBodyMs = std::max (
                lastRenderDiagnostics.noteHqEntryPitchHandoffBodyMs,
                std::max (0.0, 1000.0 * static_cast<double> (std::max (0, entryHandoffEndSample - startSample - entryDryPreserveSamples)) / sampleRate));
        }

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
            // In the pre-roll region (before note start): skip unvoiced frames so the
            // ramp only engages where there is actual voiced signal, keeping the
            // pre-roll baseline at ratio=1.0 for non-vocal content.
            // In the note body: always apply correction — skipping unvoiced frames here
            // causes no-correction when the pitch detector is noisy or the voice is breathy.
            if (!inPostRoll && s < startSample)
            {
                bool isUnvoiced = !frame.voiced || frame.midiNote <= 0.0f;
                if (isUnvoiced && isShortUnvoicedGap(frameIdx, frames, 6))
                    isUnvoiced = false;
                if (isUnvoiced)
                    continue;
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

            if (transInSamplesInt > 0 && distFromStart < 0.0f)
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
            else if (s < entryHandoffEndSample)
            {
                const float sourceAnchor = hasPrevNote ? (framePitch + prevNoteShift) : framePitch;
                const int entryRampStartSample = largeEntryPitchEdit
                    ? std::min (entryHandoffEndSample, startSample + entryDryPreserveSamples)
                    : entryHandoffStartSample;
                if (largeEntryPitchEdit && s < entryRampStartSample)
                    transitionBlend = 0.0f;
                else
                {
                    const float t = static_cast<float> (s - entryRampStartSample)
                        / static_cast<float> (std::max (1, entryHandoffEndSample - entryRampStartSample));
                    transitionBlend = minimumJerk01 (t);
                }
                correctedMidi = sourceAnchor + (correctedMidi - sourceAnchor) * transitionBlend;
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
    //
    // Note: for equal-temperament MIDI, midiToHz(m+s)/midiToHz(m) = 2^(s/12)
    // — independent of framePitch. So the ratio depends only on the averaged
    // semitone shift. This also means samples in the note body still get the
    // correct ratio even when pitch detection produced no voiced frame there
    // (previously those samples stayed at ratio 1.0, silently dropping the edit).
    // -------------------------------------------------------------------------
    for (int s = 0; s < numSamples; ++s)
    {
        float totalBlend = blendAccum[static_cast<size_t>(s)];
        if (totalBlend <= 0.0f)
            continue; // no correction applied here

        float avgShift = shiftAccum[static_cast<size_t>(s)] / totalBlend;
        ratios[static_cast<size_t>(s)] = juce::jlimit(0.25f, 4.0f,
            std::pow(2.0f, avgShift / 12.0f));
    }

    if (shouldUseEngineV3TransientBypass (getPitchOnlyRendererBranch()))
    {
        const float maxBypassMs = juce::jlimit (6.0f, 30.0f, getEnvFloat ("OPENSTUDIO_ENGINE_V3_TRANSIENT_BYPASS_MS", 18.0f));
        const float fadeMs = juce::jlimit (3.0f, 12.0f, getEnvFloat ("OPENSTUDIO_ENGINE_V3_TRANSIENT_FADE_MS", 6.0f));
        const int maxBypassSamples = static_cast<int> (std::round (sampleRate * maxBypassMs * 0.001f));
        const int fadeSamples = std::max (1, static_cast<int> (std::round (sampleRate * fadeMs * 0.001f)));

        for (const auto& note : notes)
        {
            if (! hasPitchStyleEdit (note))
                continue;

            const int startSample = juce::jlimit (0, numSamples - 1, static_cast<int> (std::round (note.startTime * sampleRate)));
            const int endSample = juce::jlimit (0, numSamples - 1, static_cast<int> (std::round (note.endTime * sampleRate)));
            if (endSample <= startSample)
                continue;

            int bypassEndSample = std::min (endSample, startSample + maxBypassSamples);
            for (const auto& frame : frames)
            {
                const int frameSample = static_cast<int> (std::round (frame.time * sampleRate));
                if (frameSample < startSample)
                    continue;
                if (frameSample > bypassEndSample)
                    break;
                if (frame.voiced && frame.confidence >= 0.70f && frame.frequency > 40.0f)
                {
                    bypassEndSample = std::max (startSample, std::min (bypassEndSample, frameSample));
                    break;
                }
            }

            const int fadeEndSample = std::min (endSample, bypassEndSample + fadeSamples);
            for (int s = startSample; s < bypassEndSample && s < numSamples; ++s)
                ratios[static_cast<size_t> (s)] = 1.0f;

            for (int s = bypassEndSample; s < fadeEndSample && s < numSamples; ++s)
            {
                const float dryToWet = smoothstep01 (static_cast<float> (s - bypassEndSample)
                    / static_cast<float> (std::max (1, fadeEndSample - bypassEndSample)));
                ratios[static_cast<size_t> (s)] = 1.0f + (ratios[static_cast<size_t> (s)] - 1.0f) * dryToWet;
            }
        }
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

        int startSample = juce::jlimit (0, numSamples - 1, static_cast<int> (getEffectiveNoteStartTime (note) * sampleRate));
        int endSample = juce::jlimit (0, numSamples - 1, static_cast<int> (getEffectiveNoteEndTime (note) * sampleRate));

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

    if (shouldEnablePitchEditorFormantDebugLogs())
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

static const OwnPitchEngine::NoteIslandAnalysis* findEngineV3IslandForNote (
    const OwnPitchEngine::SharedAnalysis& analysis,
    const PitchAnalyzer::PitchNote& note)
{
    for (const auto& island : analysis.islands)
    {
        for (const auto& islandNote : island.notes)
        {
            if (islandNote.id == note.id)
                return &island;
        }
    }

    const int noteStartSample = static_cast<int> (std::round (note.startTime * analysis.sampleRate));
    const int noteEndSample = static_cast<int> (std::round (note.endTime * analysis.sampleRate));
    for (const auto& island : analysis.islands)
    {
        if (noteEndSample <= island.contextStartSample || noteStartSample >= island.contextEndSample)
            continue;
        return &island;
    }

    return nullptr;
}

[[maybe_unused]] static void applyEngineV3BoundaryZoneBlend (
    std::vector<std::vector<float>>& carrierOutput,
    const std::vector<std::vector<float>>& boundaryOutput,
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<PitchAnalyzer::PitchNote>& notes,
    const OwnPitchEngine::SharedAnalysis& analysis,
    PitchResynthesizer::RenderDiagnostics& diagnostics)
{
    if (carrierOutput.size() != static_cast<size_t> (numChannels)
        || boundaryOutput.size() != static_cast<size_t> (numChannels)
        || input == nullptr
        || sampleRate <= 0.0)
    {
        return;
    }

    constexpr float kImmediateNeighborGapSec = 0.18f;
    constexpr float kDefaultSmoothMs = 10.0f;
    constexpr float kMaxSmoothMs = 15.0f;
    const int shellSamplesDefault = static_cast<int> (std::round (
        sampleRate * juce::jlimit (5.0f, 12.0f, getEnvFloat ("OPENSTUDIO_ENGINE_V3_SHELL_MS", 8.0f)) * 0.001f));

    std::vector<size_t> noteOrder (notes.size());
    std::iota (noteOrder.begin(), noteOrder.end(), 0);
    std::sort (noteOrder.begin(), noteOrder.end(), [&] (size_t a, size_t b) {
        return notes[a].startTime < notes[b].startTime;
    });

    for (size_t orderedIndex = 0; orderedIndex < noteOrder.size(); ++orderedIndex)
    {
        const auto& note = notes[noteOrder[orderedIndex]];
        if (! hasPitchStyleEdit (note))
            continue;

        const bool hasImmediatePrev = orderedIndex > 0
            && (note.startTime - notes[noteOrder[orderedIndex - 1]].endTime) <= kImmediateNeighborGapSec;
        const bool hasImmediateNext = orderedIndex + 1 < noteOrder.size()
            && (notes[noteOrder[orderedIndex + 1]].startTime - note.endTime) <= kImmediateNeighborGapSec;

        const float leftSmoothMs = hasImmediatePrev
            ? juce::jlimit (5.0f, kMaxSmoothMs, note.transitionIn > 0.0f ? note.transitionIn : kDefaultSmoothMs)
            : 0.0f;
        const float rightSmoothMs = hasImmediateNext
            ? juce::jlimit (5.0f, kMaxSmoothMs, note.transitionOut > 0.0f ? note.transitionOut : kDefaultSmoothMs)
            : 0.0f;

        const int startSample = juce::jlimit (0, numSamples - 1, static_cast<int> (std::round (note.startTime * sampleRate)));
        const int endSample = juce::jlimit (0, numSamples - 1, static_cast<int> (std::round (note.endTime * sampleRate)));
        if (endSample <= startSample)
            continue;

        const auto* island = findEngineV3IslandForNote (analysis, note);
        const float detectedHz = island != nullptr && island->core.meanF0Hz > 40.0f
            ? island->core.meanF0Hz
            : std::max (55.0f, midiToHz (note.detectedPitch));
        const int periodSamples = juce::jlimit (16, static_cast<int> (0.03 * sampleRate),
            static_cast<int> (std::round (sampleRate / std::max (55.0f, detectedHz))));

        int entryCycleCount = 4;
        int exitCycleCount = 4;
        int entryAnchorSample = startSample;
        int exitAnchorSample = endSample;

        if (island != nullptr && ! island->epochs.empty())
        {
            const int noteStartLocal = juce::jlimit (0, static_cast<int> (island->monoSignal.size()) - 1, startSample - island->contextStartSample);
            const int noteEndLocal = juce::jlimit (0, static_cast<int> (island->monoSignal.size()) - 1, endSample - island->contextStartSample);
            const int searchRadius = juce::jlimit (periodSamples, static_cast<int> (0.03 * sampleRate), periodSamples * 6);

            for (size_t i = 0; i < island->epochs.size(); ++i)
            {
                const int epoch = island->epochs[i];
                if (epoch >= noteStartLocal && epoch <= noteStartLocal + searchRadius)
                {
                    entryAnchorSample = island->contextStartSample + epoch;
                    if (i + 1 < island->epochs.size())
                    {
                        const int nextEpoch = island->epochs[i + 1];
                        entryCycleCount = juce::jlimit (2, 6,
                            static_cast<int> (std::round ((searchRadius * 0.35f) / std::max (16, nextEpoch - epoch))));
                    }
                    break;
                }
            }

            for (int i = static_cast<int> (island->epochs.size()) - 1; i >= 0; --i)
            {
                const int epoch = island->epochs[static_cast<size_t> (i)];
                if (epoch <= noteEndLocal && epoch >= noteEndLocal - searchRadius)
                {
                    exitAnchorSample = island->contextStartSample + epoch;
                    if (i > 0)
                    {
                        const int prevEpoch = island->epochs[static_cast<size_t> (i - 1)];
                        exitCycleCount = juce::jlimit (2, 6,
                            static_cast<int> (std::round ((searchRadius * 0.35f) / std::max (16, epoch - prevEpoch))));
                    }
                    break;
                }
            }
        }

        const int entryCyclesSamples = juce::jlimit (
            static_cast<int> (std::round (0.008 * sampleRate)),
            static_cast<int> (std::round (0.024 * sampleRate)),
            periodSamples * juce::jlimit (2, 6, entryCycleCount));
        const int exitCyclesSamples = juce::jlimit (
            static_cast<int> (std::round (0.008 * sampleRate)),
            static_cast<int> (std::round (0.024 * sampleRate)),
            periodSamples * juce::jlimit (2, 6, exitCycleCount));

        const int leftSmoothSamples = static_cast<int> (std::round (sampleRate * leftSmoothMs * 0.001f));
        const int rightSmoothSamples = static_cast<int> (std::round (sampleRate * rightSmoothMs * 0.001f));
        const int entryNeighborStart = std::max (0, startSample - leftSmoothSamples);
        const int exitNeighborEnd = std::min (numSamples, endSample + rightSmoothSamples);

        const int entryShellEnd = juce::jlimit (startSample, endSample,
            std::min (startSample + shellSamplesDefault,
                      std::max (startSample, entryAnchorSample - periodSamples / 2)));
        const int entryBoundaryEnd = juce::jlimit (entryShellEnd, endSample,
            std::max (entryShellEnd + entryCyclesSamples,
                      std::min (endSample, entryAnchorSample + (entryCycleCount * periodSamples) / 2)));

        const int exitShellStart = juce::jlimit (startSample, endSample,
            std::max (endSample - shellSamplesDefault,
                      std::min (endSample, exitAnchorSample + periodSamples / 2)));
        const int exitBoundaryStart = juce::jlimit (startSample, exitShellStart,
            std::min (exitShellStart - exitCyclesSamples,
                      std::max (startSample, exitAnchorSample - (exitCycleCount * periodSamples) / 2)));
        const bool upwardShift = (note.correctedPitch - note.detectedPitch) >= 0.0f;
        const float bodyHarvestWet = juce::jlimit (
            0.0f,
            0.35f,
            getEnvFloat (upwardShift
                    ? "OPENSTUDIO_ENGINE_V3_BODY_HARVEST_WET_UP"
                    : "OPENSTUDIO_ENGINE_V3_BODY_HARVEST_WET_DOWN",
                upwardShift ? 0.16f : 0.10f));
        const int bodyRampSamples = std::max (
            1,
            static_cast<int> (std::round (sampleRate
                * juce::jlimit (0.008f, 0.040f, getEnvFloat ("OPENSTUDIO_ENGINE_V3_BODY_HARVEST_RAMP_SEC", 0.018f)))));

        diagnostics.v3TransitionPairUsed = diagnostics.v3TransitionPairUsed || hasImmediatePrev || hasImmediateNext;
        diagnostics.firstVoicedCyclesEntryUsed = diagnostics.firstVoicedCyclesEntryUsed || (entryBoundaryEnd > entryShellEnd);
        diagnostics.firstVoicedCyclesExitUsed = diagnostics.firstVoicedCyclesExitUsed || (exitShellStart > exitBoundaryStart);
        diagnostics.v3FirstCyclesEntryCount = std::max (diagnostics.v3FirstCyclesEntryCount, entryCycleCount);
        diagnostics.v3FirstCyclesExitCount = std::max (diagnostics.v3FirstCyclesExitCount, exitCycleCount);
        diagnostics.v3EntryAnchorMs = std::max (diagnostics.v3EntryAnchorMs,
            1000.0 * static_cast<double> (std::max (0, entryBoundaryEnd - startSample)) / sampleRate);
        diagnostics.v3ExitAnchorMs = std::max (diagnostics.v3ExitAnchorMs,
            1000.0 * static_cast<double> (std::max (0, endSample - exitBoundaryStart)) / sampleRate);
        diagnostics.v3ShellDurationMs = std::max (diagnostics.v3ShellDurationMs,
            1000.0 * static_cast<double> (shellSamplesDefault) / sampleRate);
        diagnostics.v3BodyDurationMs = std::max (diagnostics.v3BodyDurationMs,
            1000.0 * static_cast<double> (std::max (0, exitBoundaryStart - entryBoundaryEnd)) / sampleRate);
        diagnostics.v3NeighborLeftOverlapMs = std::max (diagnostics.v3NeighborLeftOverlapMs, static_cast<double> (leftSmoothMs));
        diagnostics.v3NeighborRightOverlapMs = std::max (diagnostics.v3NeighborRightOverlapMs, static_cast<double> (rightSmoothMs));
        diagnostics.v3ResidualMix = std::max (diagnostics.v3ResidualMix, static_cast<double> (bodyHarvestWet));

        for (int ch = 0; ch < numChannels; ++ch)
        {
            auto& carrier = carrierOutput[static_cast<size_t> (ch)];
            const auto& boundary = boundaryOutput[static_cast<size_t> (ch)];
            for (int s = entryNeighborStart; s < exitNeighborEnd; ++s)
            {
                float wCarrier = 1.0f;
                float wOriginal = 0.0f;
                float wBoundary = 0.0f;

                if (s < startSample)
                {
                    const float t = static_cast<float> (s - entryNeighborStart)
                        / static_cast<float> (std::max (1, startSample - entryNeighborStart));
                    wOriginal = smoothstep01 (t);
                    wCarrier = 1.0f - wOriginal;
                }
                else if (s < entryShellEnd)
                {
                    wOriginal = 1.0f;
                    wCarrier = 0.0f;
                }
                else if (s < entryBoundaryEnd)
                {
                    const int mid = entryShellEnd + std::max (1, (entryBoundaryEnd - entryShellEnd) / 2);
                    if (s < mid)
                    {
                        const float t = static_cast<float> (s - entryShellEnd)
                            / static_cast<float> (std::max (1, mid - entryShellEnd));
                        wOriginal = 1.0f - smoothstep01 (t);
                        wBoundary = smoothstep01 (t);
                        wCarrier = 0.0f;
                    }
                    else
                    {
                        const float t = static_cast<float> (s - mid)
                            / static_cast<float> (std::max (1, entryBoundaryEnd - mid));
                        wBoundary = 1.0f - smoothstep01 (t);
                        wCarrier = smoothstep01 (t);
                        wOriginal = 0.0f;
                    }
                }
                else if (s < exitBoundaryStart)
                {
                    const float bodyIn = smoothstep01 (
                        static_cast<float> (s - entryBoundaryEnd)
                        / static_cast<float> (std::max (1, bodyRampSamples)));
                    const float bodyOut = 1.0f - smoothstep01 (
                        static_cast<float> (s - std::max (entryBoundaryEnd, exitBoundaryStart - bodyRampSamples))
                        / static_cast<float> (std::max (1, bodyRampSamples)));
                    const float shapedWet = bodyHarvestWet * juce::jlimit (0.0f, 1.0f, std::min (bodyIn, bodyOut));
                    if (shapedWet > 0.0f)
                    {
                        carrier[static_cast<size_t> (s)] =
                            carrier[static_cast<size_t> (s)] * (1.0f - shapedWet)
                            + boundary[static_cast<size_t> (s)] * shapedWet;
                    }
                    continue;
                }
                else if (s < exitShellStart)
                {
                    const int mid = exitBoundaryStart + std::max (1, (exitShellStart - exitBoundaryStart) / 2);
                    if (s < mid)
                    {
                        const float t = static_cast<float> (s - exitBoundaryStart)
                            / static_cast<float> (std::max (1, mid - exitBoundaryStart));
                        wCarrier = 1.0f - smoothstep01 (t);
                        wBoundary = smoothstep01 (t);
                        wOriginal = 0.0f;
                    }
                    else
                    {
                        const float t = static_cast<float> (s - mid)
                            / static_cast<float> (std::max (1, exitShellStart - mid));
                        wBoundary = 1.0f - smoothstep01 (t);
                        wOriginal = smoothstep01 (t);
                        wCarrier = 0.0f;
                    }
                }
                else
                {
                    const float t = static_cast<float> (s - exitShellStart)
                        / static_cast<float> (std::max (1, exitNeighborEnd - exitShellStart));
                    wOriginal = 1.0f - smoothstep01 (t);
                    wCarrier = smoothstep01 (t);
                    wBoundary = 0.0f;
                }

                const float sum = std::max (1.0e-5f, wCarrier + wOriginal + wBoundary);
                carrier[static_cast<size_t> (s)] =
                    (carrier[static_cast<size_t> (s)] * wCarrier
                    + input[ch][s] * wOriginal
                    + boundary[static_cast<size_t> (s)] * wBoundary) / sum;
            }
        }
    }
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
    juce::ignoreUnused (engine);
    lastRenderDiagnostics = {};
    lastRenderDiagnostics.requestedRendererBranch = getRequestedPitchRendererBranchName();
    const auto pitchDirection = getPitchEditDirectionSummary (notes);
    lastRenderDiagnostics.pitchDirection = pitchDirection.name;
    lastRenderDiagnostics.downshiftFormantGuardAlpha = 0.0;
    for (const auto& note : notes)
    {
        if (! hasPitchStyleEdit (note))
            continue;
        if (note.entryBoundaryScore >= lastRenderDiagnostics.dominantEntryBoundaryScore)
        {
            lastRenderDiagnostics.dominantEntryBoundaryKind = note.entryBoundaryKind.isEmpty() ? "unknown" : note.entryBoundaryKind;
            lastRenderDiagnostics.dominantEntryBoundaryScore = note.entryBoundaryScore;
        }
        if (note.exitBoundaryScore >= lastRenderDiagnostics.dominantExitBoundaryScore)
        {
            lastRenderDiagnostics.dominantExitBoundaryKind = note.exitBoundaryKind.isEmpty() ? "unknown" : note.exitBoundaryKind;
            lastRenderDiagnostics.dominantExitBoundaryScore = note.exitBoundaryScore;
        }
    }

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
    lastRenderDiagnostics.explicitFormantRequested = hasExplicitFormant;
    lastRenderDiagnostics.formantCurveUsed = ! formantRatios.empty();
    lastRenderDiagnostics.pitchOnlyFormantSuppressed = false;
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

    lastRenderDiagnostics.processingMode = processingModeName();
    if (processingMode == ProcessingMode::PitchOnly && pitchDirection.hasDownward)
        lastRenderDiagnostics.downshiftFormantGuardUsed = true;

    logPitchEditorFormant ("processMultiChannel samples=" + juce::String (numSamples)
        + " channels=" + juce::String (numChannels)
        + " globalFormantSt=" + juce::String (globalFormantSemitones, 3)
        + " formantCurve=" + juce::String (formantRatios.empty() ? "disabled" : "enabled")
        + " pitchShift=" + juce::String (hasPitchShift ? "true" : "false")
        + " mode=" + juce::String (processingModeName())
        + " direction=" + pitchDirection.name
        + " pitchBranch=" + juce::String (getPitchOnlyRendererBranchName (getPitchOnlyRendererBranch()))
        + " recoveryPath=" + juce::String (processingMode == ProcessingMode::PitchOnly
            ? getPitchOnlyRecoveryPathName (getPitchOnlyRecoveryPath())
            : "not_applicable")
        + " renderQuality=" + juce::String (renderQuality == RenderQuality::PreviewFast ? "preview_fast" : "final_hq"));

    const auto pitchRendererBranch = getPitchOnlyRendererBranch();
    const auto pitchOnlyRecoveryPath = getPitchOnlyRecoveryPath();
    lastRenderDiagnostics.pitchOnlyRecoveryPath = processingMode == ProcessingMode::PitchOnly
        ? juce::String (getPitchOnlyRecoveryPathName (pitchOnlyRecoveryPath))
        : juce::String();
    lastRenderDiagnostics.pitchOnlyNeutralFormantUsed = processingMode == ProcessingMode::PitchOnly
        && pitchOnlyRecoveryPath != PitchOnlyRecoveryPath::LegacyNatural;
    const bool engineV3Branch = isEngineV3Branch (pitchRendererBranch);
    const bool engineV3LpcTransfer = shouldUseEngineV3LpcTransfer (pitchRendererBranch);
    const bool engineV3TransientBypass = shouldUseEngineV3TransientBypass (pitchRendererBranch);

    // Build per-sample detected pitch in Hz only for explicit-formant processing.
    std::vector<float> detectedPitchHz;
    if (processingMode != ProcessingMode::PitchOnly || hasPitchShift)
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
    struct AdaptiveSelectorBuildResult
    {
        std::vector<std::vector<float>> output;
        OwnPitchEngine::RenderResult ownResult;
        HybridStructuralBlendResult hybridBlend;
        AdaptiveBoundaryCorrectionResult boundaryCorrection;
    };

    auto buildAdaptiveSelectorOutput = [&]() -> AdaptiveSelectorBuildResult
    {
        AdaptiveSelectorBuildResult result;
        const bool adaptiveBoundaryCorrectionEnabled = false;
        OwnPitchEngine ownEngine;
        result.ownResult = ownEngine.renderPitchOnly (
            input,
            numChannels,
            numSamples,
            sampleRate,
            frames,
            notes,
            ratios,
            toOwnEngineQuality (renderQuality),
            shouldCancel);
        auto legacyOutput = renderPitchOnlyIslands (
            input, numChannels, numSamples, sampleRate,
            frames, notes, PitchOnlyRendererBranch::HybridReset, renderQuality, shouldCancel);
        auto simpleOutput = copyInputChannels (input, numChannels, numSamples);
        result.hybridBlend = blendHybridStructuralOutputs (
            input,
            legacyOutput,
            result.ownResult.output,
            result.ownResult.analysis,
            PitchOnlyRendererBranch::HybridStructural,
            numChannels,
            numSamples,
            sampleRate,
            notes);
        result.output = composeAdaptiveSelectorOutput (result.hybridBlend.output,
                                                       simpleOutput,
                                                       numChannels,
                                                       numSamples,
                                                       sampleRate,
                                                       notes);
        const float downBlendWeight = pitchDirection.hasDownward
            ? juce::jlimit (0.0f, 0.42f, getEnvFloat ("OPENSTUDIO_PITCH_DOWNSHIFT_OWN_BLEND", 0.42f))
            : 0.24f;
        applyAdaptiveDownwardOwnBlend (result.output, result.ownResult.output, numChannels, numSamples, sampleRate, notes, downBlendWeight);
        if (pitchDirection.hasDownward)
            lastRenderDiagnostics.downshiftFormantGuardUsed = true;
        if (adaptiveBoundaryCorrectionEnabled)
        {
            result.boundaryCorrection = applyAdaptiveBoundaryCorrections (
                input,
                result.output,
                result.ownResult.analysis,
                notes,
                ratios,
                numChannels,
                numSamples,
                sampleRate);
            if (result.boundaryCorrection.used)
                result.output = result.boundaryCorrection.output;
        }
        return result;
    };

    auto populateEngineV3BoundaryDiagnostics = [&]()
    {
        if (! engineV3Branch)
            return;

        lastRenderDiagnostics.v3ContinuousRenderUsed = true;
        lastRenderDiagnostics.v3FormantMode = engineV3LpcTransfer ? "lpc_transfer" : "native_preserve";
        lastRenderDiagnostics.v3ResidualMix = 0.0;

        constexpr float kImmediateNeighborGapSec = 0.18f;
        const double defaultNeighborSmoothMs = 10.0;
        std::vector<size_t> noteOrder (notes.size());
        std::iota (noteOrder.begin(), noteOrder.end(), 0);
        std::sort (noteOrder.begin(), noteOrder.end(), [&] (size_t a, size_t b) {
            return notes[a].startTime < notes[b].startTime;
        });

        for (size_t orderIndex = 0; orderIndex < noteOrder.size(); ++orderIndex)
        {
            const auto& note = notes[noteOrder[orderIndex]];
            if (! hasPitchStyleEdit (note))
                continue;

            const double noteDurationMs = std::max (0.0, 1000.0 * static_cast<double> (note.endTime - note.startTime));
            lastRenderDiagnostics.v3BodyDurationMs = std::max (lastRenderDiagnostics.v3BodyDurationMs, noteDurationMs);

            if (engineV3TransientBypass)
            {
                const double shellMs = juce::jlimit (6.0, 30.0,
                    static_cast<double> (getEnvFloat ("OPENSTUDIO_ENGINE_V3_TRANSIENT_BYPASS_MS", 18.0f)));
                lastRenderDiagnostics.v3ShellDurationMs = std::max (lastRenderDiagnostics.v3ShellDurationMs, shellMs);
                lastRenderDiagnostics.v3EntryAnchorMs = std::max (lastRenderDiagnostics.v3EntryAnchorMs, shellMs);
                lastRenderDiagnostics.v3ExitAnchorMs = std::max (lastRenderDiagnostics.v3ExitAnchorMs, shellMs * 0.5);
                const double periods = std::max (2.0, std::min (6.0, shellMs * std::max (1.0f, midiToHz (note.detectedPitch)) / 1000.0));
                lastRenderDiagnostics.v3FirstCyclesEntryCount = std::max (lastRenderDiagnostics.v3FirstCyclesEntryCount, static_cast<int> (std::round (periods)));
                lastRenderDiagnostics.v3FirstCyclesExitCount = std::max (lastRenderDiagnostics.v3FirstCyclesExitCount, std::max (1, static_cast<int> (std::round (periods * 0.5))));
            }

            if (orderIndex > 0)
            {
                const auto& prev = notes[noteOrder[orderIndex - 1]];
                if ((note.startTime - prev.endTime) <= kImmediateNeighborGapSec)
                {
                    lastRenderDiagnostics.v3TransitionPairUsed = true;
                    lastRenderDiagnostics.v3NeighborLeftOverlapMs = std::max (
                        lastRenderDiagnostics.v3NeighborLeftOverlapMs,
                        note.transitionIn > 0.0f ? static_cast<double> (note.transitionIn) : defaultNeighborSmoothMs);
                }
            }
            if (orderIndex + 1 < noteOrder.size())
            {
                const auto& next = notes[noteOrder[orderIndex + 1]];
                if ((next.startTime - note.endTime) <= kImmediateNeighborGapSec)
                {
                    lastRenderDiagnostics.v3TransitionPairUsed = true;
                    lastRenderDiagnostics.v3NeighborRightOverlapMs = std::max (
                        lastRenderDiagnostics.v3NeighborRightOverlapMs,
                        note.transitionOut > 0.0f ? static_cast<double> (note.transitionOut) : defaultNeighborSmoothMs);
                }
            }
        }
    };

    switch (processingMode)
    {
        case ProcessingMode::PitchOnly:
        {
            if (shouldCancel && shouldCancel())
                return output;
            if (pitchRendererBranch == PitchOnlyRendererBranch::VocalSourceFilterHq)
            {
                OwnPitchEngine ownEngine;
                auto ownResult = ownEngine.renderVocalSourceFilterHq (
                    input,
                    numChannels,
                    numSamples,
                    sampleRate,
                    frames,
                    notes,
                    ratios,
                    toOwnEngineQuality (renderQuality),
                    shouldCancel);
                output = std::move (ownResult.output);
                constexpr bool entryHybridEnabled = false;
                constexpr bool coreHybridEnabled = false;
                constexpr bool exitHybridEnabled = false;
                const auto layerDumpDir = getPitchLayerDumpDirectory();
                if (layerDumpDir != juce::File())
                    writePitchLayerDumpWav (layerDumpDir, "vsf_after_own_source_filter", output, sampleRate);
                const bool hasLongEditedHybridNote = std::any_of (
                    notes.begin(),
                    notes.end(),
                    [] (const PitchAnalyzer::PitchNote& note)
                    {
                        return hasPitchStyleEdit (note)
                            && static_cast<double> (note.endTime - note.startTime) >= 0.90;
                    });
                bool entryHybridUsed = false;
                bool coreHybridUsed = false;
                bool exitHybridUsed = false;
                float maxCoreHybridAlpha = 0.0f;
                if ((entryHybridEnabled || coreHybridEnabled || exitHybridEnabled) && hasLongEditedHybridNote)
                {
                    auto adaptiveHybridBuild = buildAdaptiveSelectorOutput();
                    if (layerDumpDir != juce::File())
                        writePitchLayerDumpWav (layerDumpDir, "adaptive_hybrid_output", adaptiveHybridBuild.output, sampleRate);
                    const int entryFadeInSamples = std::max (1, static_cast<int> (std::round (0.006 * sampleRate)));
                    const int entryFadeOutSamples = std::max (1, static_cast<int> (std::round (0.030 * sampleRate)));
                    const int maxEntrySamples = std::max (1, static_cast<int> (std::round (0.095 * sampleRate)));
                    const int coreFadeSamples = std::max (1, static_cast<int> (std::round (0.040 * sampleRate)));
                    const int coreEntryProtectSamples = std::max (1, static_cast<int> (std::round (0.115 * sampleRate)));
                    const int coreExitProtectSamples = std::max (1, static_cast<int> (std::round (0.095 * sampleRate)));
                    const int exitFadeInSamples = std::max (1, static_cast<int> (std::round (0.030 * sampleRate)));
                    const int exitFadeOutSamples = std::max (1, static_cast<int> (std::round (0.010 * sampleRate)));
                    const int maxExitSamples = std::max (1, static_cast<int> (std::round (0.095 * sampleRate)));
                    for (const auto& note : notes)
                    {
                        if (! hasPitchStyleEdit (note))
                            continue;

                        const double noteDurationSec = static_cast<double> (note.endTime - note.startTime);
                        if (noteDurationSec < 0.90)
                            continue;

                        const int noteStart = juce::jlimit (0, numSamples, static_cast<int> (std::round (note.startTime * sampleRate)));
                        const int noteEnd = juce::jlimit (noteStart, numSamples, static_cast<int> (std::round (note.endTime * sampleRate)));
                        if (noteEnd <= noteStart)
                            continue;

                        if (entryHybridEnabled)
                        {
                            const int entryStart = noteStart;
                            const int entryEnd = juce::jlimit (entryStart, numSamples, std::min (noteEnd, entryStart + maxEntrySamples));
                            if (entryEnd > entryStart)
                            {
                                for (int ch = 0; ch < numChannels; ++ch)
                                {
                                    if (adaptiveHybridBuild.output.size() <= static_cast<size_t> (ch)
                                        || output.size() <= static_cast<size_t> (ch))
                                        continue;

                                    auto& dst = output[static_cast<size_t> (ch)];
                                    const auto& adaptive = adaptiveHybridBuild.output[static_cast<size_t> (ch)];
                                    for (int s = entryStart; s < entryEnd; ++s)
                                    {
                                        if (s >= static_cast<int> (dst.size()) || s >= static_cast<int> (adaptive.size()))
                                            continue;

                                        float wet = 1.0f;
                                        if (s < entryStart + entryFadeInSamples)
                                        {
                                            const float t = static_cast<float> (s - entryStart) / static_cast<float> (entryFadeInSamples);
                                            wet *= 0.5f - 0.5f * std::cos (juce::MathConstants<float>::pi * juce::jlimit (0.0f, 1.0f, t));
                                        }
                                        if (s >= entryEnd - entryFadeOutSamples)
                                        {
                                            const float t = static_cast<float> (entryEnd - s) / static_cast<float> (entryFadeOutSamples);
                                            wet *= 0.5f - 0.5f * std::cos (juce::MathConstants<float>::pi * juce::jlimit (0.0f, 1.0f, t));
                                        }

                                        dst[static_cast<size_t> (s)] = dst[static_cast<size_t> (s)] * (1.0f - wet)
                                            + adaptive[static_cast<size_t> (s)] * wet;
                                    }
                                }
                                entryHybridUsed = true;
                            }
                        }

                        if (coreHybridEnabled)
                        {
                            const int coreStart = juce::jlimit (noteStart, noteEnd, noteStart + coreEntryProtectSamples);
                            const int coreEnd = juce::jlimit (coreStart, noteEnd, noteEnd - coreExitProtectSamples);
                            if (coreEnd > coreStart)
                            {
                                const bool downwardNote = note.correctedPitch < note.detectedPitch;
                                const float coreHybridAlpha = juce::jlimit (
                                    0.0f,
                                    0.90f,
                                    getEnvFloat (
                                        downwardNote ? "OPENSTUDIO_VSF_CORE_HYBRID_ALPHA_DOWN" : "OPENSTUDIO_VSF_CORE_HYBRID_ALPHA_UP",
                                        downwardNote ? 0.65f : 0.55f));
                                if (coreHybridAlpha > 1.0e-4f)
                                {
                                    for (int ch = 0; ch < numChannels; ++ch)
                                    {
                                        if (adaptiveHybridBuild.output.size() <= static_cast<size_t> (ch)
                                            || output.size() <= static_cast<size_t> (ch))
                                            continue;

                                        auto& dst = output[static_cast<size_t> (ch)];
                                        const auto& adaptive = adaptiveHybridBuild.output[static_cast<size_t> (ch)];
                                        for (int s = coreStart; s < coreEnd; ++s)
                                        {
                                            if (s >= static_cast<int> (dst.size()) || s >= static_cast<int> (adaptive.size()))
                                                continue;

                                            float wet = coreHybridAlpha;
                                            if (s < coreStart + coreFadeSamples)
                                            {
                                                const float t = static_cast<float> (s - coreStart) / static_cast<float> (coreFadeSamples);
                                                wet *= 0.5f - 0.5f * std::cos (juce::MathConstants<float>::pi * juce::jlimit (0.0f, 1.0f, t));
                                            }
                                            if (s >= coreEnd - coreFadeSamples)
                                            {
                                                const float t = static_cast<float> (coreEnd - s) / static_cast<float> (coreFadeSamples);
                                                wet *= 0.5f - 0.5f * std::cos (juce::MathConstants<float>::pi * juce::jlimit (0.0f, 1.0f, t));
                                            }

                                            dst[static_cast<size_t> (s)] = dst[static_cast<size_t> (s)] * (1.0f - wet)
                                                + adaptive[static_cast<size_t> (s)] * wet;
                                        }
                                    }
                                    coreHybridUsed = true;
                                    maxCoreHybridAlpha = std::max (maxCoreHybridAlpha, coreHybridAlpha);
                                }
                            }
                        }

                        if (exitHybridEnabled)
                        {
                            const int exitEnd = noteEnd;
                            const int exitStart = juce::jlimit (noteStart, exitEnd, exitEnd - maxExitSamples);
                            if (exitEnd > exitStart)
                            {
                                for (int ch = 0; ch < numChannels; ++ch)
                                {
                                    if (adaptiveHybridBuild.output.size() <= static_cast<size_t> (ch)
                                        || output.size() <= static_cast<size_t> (ch))
                                        continue;

                                    auto& dst = output[static_cast<size_t> (ch)];
                                    const auto& adaptive = adaptiveHybridBuild.output[static_cast<size_t> (ch)];
                                    for (int s = exitStart; s < exitEnd; ++s)
                                    {
                                        if (s >= static_cast<int> (dst.size()) || s >= static_cast<int> (adaptive.size()))
                                            continue;

                                        float wet = 1.0f;
                                        if (s < exitStart + exitFadeInSamples)
                                        {
                                            const float t = static_cast<float> (s - exitStart) / static_cast<float> (exitFadeInSamples);
                                            wet *= 0.5f - 0.5f * std::cos (juce::MathConstants<float>::pi * juce::jlimit (0.0f, 1.0f, t));
                                        }
                                        if (s >= exitEnd - exitFadeOutSamples)
                                        {
                                            const float t = static_cast<float> (exitEnd - s) / static_cast<float> (exitFadeOutSamples);
                                            wet *= 0.5f - 0.5f * std::cos (juce::MathConstants<float>::pi * juce::jlimit (0.0f, 1.0f, t));
                                        }

                                        dst[static_cast<size_t> (s)] = dst[static_cast<size_t> (s)] * (1.0f - wet)
                                            + adaptive[static_cast<size_t> (s)] * wet;
                                    }
                                }
                                exitHybridUsed = true;
                            }
                        }
                    }
                }
                lastRenderDiagnostics.pitchOnlyCoreTimbreCorrectionUsed = coreHybridUsed;
                lastRenderDiagnostics.pitchOnlyCoreEnvelopeMix = maxCoreHybridAlpha;
                lastRenderDiagnostics.pitchOnlyEntryHandoffUsed = entryHybridUsed;
                lastRenderDiagnostics.pitchOnlyExitHandoffUsed = exitHybridUsed;
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.usedFallback = ownResult.usedFallback;
                lastRenderDiagnostics.fallbackReason = ownResult.fallbackReason;
                lastRenderDiagnostics.vocalSourceFilterUsed = ownResult.vocalSourceFilterUsed;
                lastRenderDiagnostics.vocalSourceFilterVoicedCoverage = ownResult.vocalSourceFilterVoicedCoverage;
                lastRenderDiagnostics.vocalSourceFilterResidualMix = ownResult.vocalSourceFilterResidualMix;
                lastRenderDiagnostics.vocalSourceFilterFallbackUsed = ownResult.vocalSourceFilterFallbackUsed;
                lastRenderDiagnostics.vocalSourceFilterFallbackReason = ownResult.vocalSourceFilterFallbackReason;
                lastRenderDiagnostics.vocalSourceFilterEntryDryMs = ownResult.vocalSourceFilterEntryDryMs;
                lastRenderDiagnostics.vocalSourceFilterExitDryMs = ownResult.vocalSourceFilterExitDryMs;
                lastRenderDiagnostics.vocalSourceFilterResidualMixScale = ownResult.vocalSourceFilterResidualMixScale;
                lastRenderDiagnostics.vocalSourceFilterEpochInterpolationUsed = ownResult.vocalSourceFilterEpochInterpolationUsed;
                lastRenderDiagnostics.vocalSourceFilterEpochInterpolationStrength = ownResult.vocalSourceFilterEpochInterpolationStrength;
                lastRenderDiagnostics.vocalSourceFilterGrainRadiusScale = ownResult.vocalSourceFilterGrainRadiusScale;
                lastRenderDiagnostics.vocalSourceFilterUpPresenceTrimDb = ownResult.vocalSourceFilterUpPresenceTrimDb;
                lastRenderDiagnostics.vocalSourceFilterUpPresenceHz = ownResult.vocalSourceFilterUpPresenceHz;
                lastRenderDiagnostics.vocalSourceFilterDownNasalTrimDb = ownResult.vocalSourceFilterDownNasalTrimDb;
                lastRenderDiagnostics.vocalSourceFilterDownNasalHz = ownResult.vocalSourceFilterDownNasalHz;
                lastRenderDiagnostics.vocalSourceFilterDownBodyCompDb = ownResult.vocalSourceFilterDownBodyCompDb;
                lastRenderDiagnostics.vocalSourceFilterDownBodyCompHz = ownResult.vocalSourceFilterDownBodyCompHz;
                lastRenderDiagnostics.spectralEnvelopeCorrectionUsed = true;
                if (layerDumpDir != juce::File())
                    writePitchLayerDumpWav (layerDumpDir, "vsf_final_after_hybrid_blends", output, sampleRate);
                logPitchEditorFormant ("using vocal source/filter pitch-only renderer"
                    + juce::String (" analysisMs=") + juce::String (ownResult.analysisMs, 2)
                    + " renderMs=" + juce::String (ownResult.renderMs, 2)
                    + " islands=" + juce::String (static_cast<int> (ownResult.analysis.islands.size()))
                    + " voicedCoverage=" + juce::String (ownResult.vocalSourceFilterVoicedCoverage, 3)
                    + " residualMix=" + juce::String (ownResult.vocalSourceFilterResidualMix, 3)
                    + " residualScale=" + juce::String (ownResult.vocalSourceFilterResidualMixScale, 3)
                    + " epochInterp=" + juce::String (ownResult.vocalSourceFilterEpochInterpolationUsed ? "true" : "false")
                    + " epochInterpStrength=" + juce::String (ownResult.vocalSourceFilterEpochInterpolationStrength, 3)
                    + " grainScale=" + juce::String (ownResult.vocalSourceFilterGrainRadiusScale, 3)
                    + " upPresenceTrimDb=" + juce::String (ownResult.vocalSourceFilterUpPresenceTrimDb, 2)
                    + " downNasalTrimDb=" + juce::String (ownResult.vocalSourceFilterDownNasalTrimDb, 2)
                    + " downBodyCompDb=" + juce::String (ownResult.vocalSourceFilterDownBodyCompDb, 2)
                    + " fallback=" + juce::String (ownResult.vocalSourceFilterFallbackUsed ? "true" : "false"));
            }
            else if (pitchOnlyRecoveryPath != PitchOnlyRecoveryPath::CurrentExperimental)
            {
                output = copyInputChannels (input, numChannels, numSamples);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.usedFallback = false;
                lastRenderDiagnostics.fallbackReason = {};
                lastRenderDiagnostics.spectralEnvelopeCorrectionUsed = false;
                lastRenderDiagnostics.pitchOnlyCoreTimbreCorrectionUsed = false;
                lastRenderDiagnostics.pitchOnlyCoreEnvelopeMix = 0.0;
                lastRenderDiagnostics.pitchOnlyCoreRmsTrimDb = 0.0;
                lastRenderDiagnostics.pitchOnlyCoreEnvelopeLifter = 0;
                lastRenderDiagnostics.pitchOnlyEntryHandoffUsed = false;
                lastRenderDiagnostics.pitchOnlyExitHandoffUsed = false;
                logPitchEditorFormant ("using pitch-only recovery path="
                    + juce::String (getPitchOnlyRecoveryPathName (pitchOnlyRecoveryPath))
                    + " requestedBranch=" + juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch)));
            }
            else if (engineV3Branch)
            {
                // Transient bypass: keep note attack region dry so the consonant
                // onset passes through unshifted.
                if (engineV3TransientBypass)
                {
                    const float bypassMs = juce::jlimit (6.0f, 30.0f,
                        getEnvFloat ("OPENSTUDIO_ENGINE_V3_TRANSIENT_BYPASS_MS", 18.0f));
                    const int bypassSamples = static_cast<int> (sampleRate * bypassMs * 0.001);
                    for (const auto& note : notes)
                    {
                        if (! hasPitchStyleEdit (note))
                            continue;
                        const int noteStart = juce::jlimit (0, numSamples,
                            static_cast<int> (getEffectiveNoteStartTime (note) * sampleRate));
                        const int bypassEnd = std::min (numSamples, noteStart + bypassSamples);
                        for (int s = noteStart; s < bypassEnd; ++s)
                            ratios[static_cast<size_t> (s)] = 1.0f;
                    }
                }

                // Retired full-clip experimental branch; kept dry if an old
                // diagnostic override reaches this block.
                // The OwnPitchEngine boundary blend is intentionally skipped: the
                // V3-1 probe showed it regressed note-body quality on hard clips.
                // Formant residual is handled by the LPC post-pass below when
                // engineV3LpcTransfer is true.
                output = copyInputChannels (input, numChannels, numSamples);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.transientBypassUsed = engineV3TransientBypass;
                lastRenderDiagnostics.usedFallback = false;
                lastRenderDiagnostics.fallbackReason = {};
                populateEngineV3BoundaryDiagnostics();
                logPitchEditorFormant ("engine-v3 full-clip processPitchOnlyBase"
                    + juce::String (" lpc=") + juce::String (engineV3LpcTransfer ? "true" : "false")
                    + " transient=" + juce::String (engineV3TransientBypass ? "true" : "false")
                    + " samples=" + juce::String (numSamples));
            }
            else if (pitchRendererBranch == PitchOnlyRendererBranch::AdaptiveSelector)
            {
                auto adaptiveBuild = buildAdaptiveSelectorOutput();
                output = std::move (adaptiveBuild.output);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.usedFallback = adaptiveBuild.ownResult.usedFallback;
                lastRenderDiagnostics.fallbackReason = adaptiveBuild.ownResult.fallbackReason;
                lastRenderDiagnostics.bridgeUsed = adaptiveBuild.hybridBlend.diagnostics.bridgeUsed;
                lastRenderDiagnostics.bridgeFallbackUsed = adaptiveBuild.hybridBlend.diagnostics.bridgeFallbackUsed;
                lastRenderDiagnostics.bridgeStartSec = static_cast<double> (adaptiveBuild.hybridBlend.diagnostics.bridgeStartSample) / sampleRate;
                lastRenderDiagnostics.bridgeLengthMs = 1000.0 * static_cast<double> (adaptiveBuild.hybridBlend.diagnostics.bridgeLengthSamples) / sampleRate;
                lastRenderDiagnostics.bridgeAlignmentLagSamples = adaptiveBuild.hybridBlend.diagnostics.bridgeAlignmentLagSamples;
                lastRenderDiagnostics.bridgeCorrelationScore = adaptiveBuild.hybridBlend.diagnostics.bridgeCorrelationScore;
                lastRenderDiagnostics.bridgeGainDeltaDb = adaptiveBuild.hybridBlend.diagnostics.bridgeGainDeltaDb;
                lastRenderDiagnostics.bodyReplacementUsed = adaptiveBuild.hybridBlend.bodyReplacementDiagnostics.bodyReplacementUsed;
                lastRenderDiagnostics.bodyReplacementFallbackUsed = adaptiveBuild.hybridBlend.bodyReplacementDiagnostics.bodyReplacementFallbackUsed;
                lastRenderDiagnostics.entryLockStartSec = static_cast<double> (adaptiveBuild.hybridBlend.bodyReplacementDiagnostics.entryLockStartSample) / sampleRate;
                lastRenderDiagnostics.entryLockLengthMs = 1000.0 * static_cast<double> (adaptiveBuild.hybridBlend.bodyReplacementDiagnostics.entryLockLengthSamples) / sampleRate;
                lastRenderDiagnostics.exitLockStartSec = static_cast<double> (adaptiveBuild.hybridBlend.bodyReplacementDiagnostics.exitLockStartSample) / sampleRate;
                lastRenderDiagnostics.renderedBodyStartSec = static_cast<double> (adaptiveBuild.hybridBlend.bodyReplacementDiagnostics.renderedBodyStartSample) / sampleRate;
                lastRenderDiagnostics.renderedBodyEndSec = static_cast<double> (adaptiveBuild.hybridBlend.bodyReplacementDiagnostics.renderedBodyEndSample) / sampleRate;
                lastRenderDiagnostics.islandNativeUsed = adaptiveBuild.hybridBlend.islandNativeDiagnostics.islandNativeUsed;
                lastRenderDiagnostics.islandNativeFallbackUsed = adaptiveBuild.hybridBlend.islandNativeDiagnostics.islandNativeFallbackUsed;
                lastRenderDiagnostics.islandRenderStartSec = static_cast<double> (adaptiveBuild.hybridBlend.islandNativeDiagnostics.islandRenderStartSample) / sampleRate;
                lastRenderDiagnostics.islandRenderEndSec = static_cast<double> (adaptiveBuild.hybridBlend.islandNativeDiagnostics.islandRenderEndSample) / sampleRate;
                lastRenderDiagnostics.transientMaskPeak = adaptiveBuild.hybridBlend.islandNativeDiagnostics.transientMaskPeak;
                lastRenderDiagnostics.voicedCoreMaskPeak = adaptiveBuild.hybridBlend.islandNativeDiagnostics.voicedCoreMaskPeak;
                lastRenderDiagnostics.spectralEnvelopeCorrectionUsed = adaptiveBuild.boundaryCorrection.spectralEnvelopeCorrectionUsed;
                lastRenderDiagnostics.transientBypassUsed = adaptiveBuild.boundaryCorrection.transientBypassUsed;
                lastRenderDiagnostics.residualCarryUsed = adaptiveBuild.boundaryCorrection.residualCarryUsed;
                lastRenderDiagnostics.cepstralCutoffUsed = adaptiveBuild.boundaryCorrection.cepstralCutoffUsed;
                lastRenderDiagnostics.engineV2FftSize = adaptiveBuild.boundaryCorrection.fftSizeUsed;
                lastRenderDiagnostics.engineV2HopSize = adaptiveBuild.boundaryCorrection.hopSizeUsed;
                logPitchEditorFormant ("using adaptive harvested selector"
                    + juce::String (" analysisMs=") + juce::String (adaptiveBuild.ownResult.analysisMs, 2)
                    + " renderMs=" + juce::String (adaptiveBuild.ownResult.renderMs, 2)
                    + " islands=" + juce::String (static_cast<int> (adaptiveBuild.ownResult.analysis.islands.size()))
                    + " epochs=" + juce::String (adaptiveBuild.ownResult.analysis.totalEpochCount)
                    + " boundaryCorrection=" + juce::String (adaptiveBuild.boundaryCorrection.used ? "true" : "false")
                    + " transientBypass=" + juce::String (adaptiveBuild.boundaryCorrection.transientBypassUsed ? "true" : "false")
                    + " residualCarry=" + juce::String (adaptiveBuild.boundaryCorrection.residualCarryUsed ? "true" : "false")
                    + " lifter=" + juce::String (adaptiveBuild.boundaryCorrection.cepstralCutoffUsed)
                    + " fft/hop=" + juce::String (adaptiveBuild.boundaryCorrection.fftSizeUsed) + "/" + juce::String (adaptiveBuild.boundaryCorrection.hopSizeUsed));
            }
            else if (pitchRendererBranch == PitchOnlyRendererBranch::EngineV2Program)
            {
                auto adaptiveBuild = buildAdaptiveSelectorOutput();
                auto engineV2Render = renderEngineV2Program (
                    input,
                    adaptiveBuild.output,
                    adaptiveBuild.ownResult.analysis,
                    notes,
                    ratios,
                    numChannels,
                    numSamples,
                    sampleRate);
                output = std::move (engineV2Render.output);
                const auto& engineV2Diagnostics = engineV2Render.diagnostics;

                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.usedFallback = adaptiveBuild.ownResult.usedFallback || engineV2Diagnostics.engineV2FallbackUsed;
                lastRenderDiagnostics.fallbackReason = adaptiveBuild.ownResult.fallbackReason;
                lastRenderDiagnostics.engineV2Used = engineV2Diagnostics.engineV2Used;
                lastRenderDiagnostics.engineV2FallbackUsed = engineV2Diagnostics.engineV2FallbackUsed;
                lastRenderDiagnostics.engineV2TransitionCount = engineV2Diagnostics.transitionCount;
                lastRenderDiagnostics.engineV2TransitionStartSec = static_cast<double> (engineV2Diagnostics.firstTransitionStartSample) / sampleRate;
                lastRenderDiagnostics.engineV2TransitionEndSec = static_cast<double> (engineV2Diagnostics.lastTransitionEndSample) / sampleRate;
                lastRenderDiagnostics.engineV2HarmonicSupportPeak = engineV2Diagnostics.harmonicSupportPeak;
                lastRenderDiagnostics.engineV2ResidualSupportPeak = engineV2Diagnostics.residualSupportPeak;
                lastRenderDiagnostics.engineV2EnvelopeSupportPeak = engineV2Diagnostics.envelopeSupportPeak;
                lastRenderDiagnostics.spectralEnvelopeCorrectionUsed = engineV2Render.spectralEnvelopeCorrectionUsed;
                lastRenderDiagnostics.transientBypassUsed = engineV2Render.transientBypassUsed;
                lastRenderDiagnostics.residualCarryUsed = engineV2Render.residualCarryUsed;
                lastRenderDiagnostics.cepstralCutoffUsed = engineV2Render.cepstralCutoffUsed;
                lastRenderDiagnostics.engineV2FftSize = engineV2Render.fftSizeUsed;
                lastRenderDiagnostics.engineV2HopSize = engineV2Render.hopSizeUsed;
                logPitchEditorFormant ("using engine-v2 scaffold"
                    + juce::String (" transitions=") + juce::String (engineV2Diagnostics.transitionCount)
                    + " harmonicPeak=" + juce::String (engineV2Diagnostics.harmonicSupportPeak, 3)
                    + " residualPeak=" + juce::String (engineV2Diagnostics.residualSupportPeak, 3)
                    + " envelopePeak=" + juce::String (engineV2Diagnostics.envelopeSupportPeak, 3)
                    + " transientBypass=" + juce::String (engineV2Render.transientBypassUsed ? "true" : "false")
                    + " residualCarry=" + juce::String (engineV2Render.residualCarryUsed ? "true" : "false")
                    + " lifter=" + juce::String (engineV2Render.cepstralCutoffUsed)
                    + " fft/hop=" + juce::String (engineV2Render.fftSizeUsed) + "/" + juce::String (engineV2Render.hopSizeUsed)
                    + " fallback=" + juce::String (engineV2Diagnostics.engineV2FallbackUsed ? "true" : "false")
                    + " analysisMs=" + juce::String (adaptiveBuild.ownResult.analysisMs, 2)
                    + " renderMs=" + juce::String (adaptiveBuild.ownResult.renderMs, 2));
            }
            else if (pitchRendererBranch == PitchOnlyRendererBranch::HybridStructural
                || pitchRendererBranch == PitchOnlyRendererBranch::IslandNative
                || pitchRendererBranch == PitchOnlyRendererBranch::IslandNativePsola)
            {
                OwnPitchEngine ownEngine;
                auto ownResult = ownEngine.renderPitchOnly (
                    input,
                    numChannels,
                    numSamples,
                    sampleRate,
                    frames,
                    notes,
                    ratios,
                    toOwnEngineQuality (renderQuality),
                    shouldCancel);
                auto legacyOutput = renderPitchOnlyIslands (
                    input, numChannels, numSamples, sampleRate,
                    frames, notes, PitchOnlyRendererBranch::HybridReset, renderQuality, shouldCancel);
                auto hybridBlend = blendHybridStructuralOutputs (
                    input,
                    legacyOutput,
                    ownResult.output,
                    ownResult.analysis,
                    pitchRendererBranch,
                    numChannels,
                    numSamples,
                    sampleRate,
                    notes);
                output = std::move (hybridBlend.output);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.usedFallback = ownResult.usedFallback;
                lastRenderDiagnostics.fallbackReason = ownResult.fallbackReason;
                lastRenderDiagnostics.bridgeUsed = hybridBlend.diagnostics.bridgeUsed;
                lastRenderDiagnostics.bridgeFallbackUsed = hybridBlend.diagnostics.bridgeFallbackUsed;
                lastRenderDiagnostics.bridgeStartSec = static_cast<double> (hybridBlend.diagnostics.bridgeStartSample) / sampleRate;
                lastRenderDiagnostics.bridgeLengthMs = 1000.0 * static_cast<double> (hybridBlend.diagnostics.bridgeLengthSamples) / sampleRate;
                lastRenderDiagnostics.bridgeAlignmentLagSamples = hybridBlend.diagnostics.bridgeAlignmentLagSamples;
                lastRenderDiagnostics.bridgeCorrelationScore = hybridBlend.diagnostics.bridgeCorrelationScore;
                lastRenderDiagnostics.bridgeGainDeltaDb = hybridBlend.diagnostics.bridgeGainDeltaDb;
                lastRenderDiagnostics.bodyReplacementUsed = hybridBlend.bodyReplacementDiagnostics.bodyReplacementUsed;
                lastRenderDiagnostics.bodyReplacementFallbackUsed = hybridBlend.bodyReplacementDiagnostics.bodyReplacementFallbackUsed;
                lastRenderDiagnostics.entryLockStartSec = static_cast<double> (hybridBlend.bodyReplacementDiagnostics.entryLockStartSample) / sampleRate;
                lastRenderDiagnostics.entryLockLengthMs = 1000.0 * static_cast<double> (hybridBlend.bodyReplacementDiagnostics.entryLockLengthSamples) / sampleRate;
                lastRenderDiagnostics.exitLockStartSec = static_cast<double> (hybridBlend.bodyReplacementDiagnostics.exitLockStartSample) / sampleRate;
                lastRenderDiagnostics.renderedBodyStartSec = static_cast<double> (hybridBlend.bodyReplacementDiagnostics.renderedBodyStartSample) / sampleRate;
                lastRenderDiagnostics.renderedBodyEndSec = static_cast<double> (hybridBlend.bodyReplacementDiagnostics.renderedBodyEndSample) / sampleRate;
                lastRenderDiagnostics.islandNativeUsed = hybridBlend.islandNativeDiagnostics.islandNativeUsed;
                lastRenderDiagnostics.islandNativeFallbackUsed = hybridBlend.islandNativeDiagnostics.islandNativeFallbackUsed;
                lastRenderDiagnostics.islandRenderStartSec = static_cast<double> (hybridBlend.islandNativeDiagnostics.islandRenderStartSample) / sampleRate;
                lastRenderDiagnostics.islandRenderEndSec = static_cast<double> (hybridBlend.islandNativeDiagnostics.islandRenderEndSample) / sampleRate;
                lastRenderDiagnostics.transientMaskPeak = hybridBlend.islandNativeDiagnostics.transientMaskPeak;
                lastRenderDiagnostics.voicedCoreMaskPeak = hybridBlend.islandNativeDiagnostics.voicedCoreMaskPeak;
                logPitchEditorFormant ("using island-aware pitch-only renderer"
                    + juce::String (" analysisMs=") + juce::String (ownResult.analysisMs, 2)
                    + " renderMs=" + juce::String (ownResult.renderMs, 2)
                    + " islands=" + juce::String (static_cast<int> (ownResult.analysis.islands.size()))
                    + " epochs=" + juce::String (ownResult.analysis.totalEpochCount)
                    + " maxPartials=" + juce::String (ownResult.analysis.maxPartialCount)
                    + " bodyReplacement=" + juce::String (hybridBlend.bodyReplacementDiagnostics.bodyReplacementUsed ? "true" : "false")
                    + " bodyReplacementFallback=" + juce::String (hybridBlend.bodyReplacementDiagnostics.bodyReplacementFallbackUsed ? "true" : "false")
                    + " islandNative=" + juce::String (hybridBlend.islandNativeDiagnostics.islandNativeUsed ? "true" : "false")
                    + " islandNativeFallback=" + juce::String (hybridBlend.islandNativeDiagnostics.islandNativeFallbackUsed ? "true" : "false")
                    + " bridgeUsed=" + juce::String (hybridBlend.diagnostics.bridgeUsed ? "true" : "false")
                    + " bridgeFallback=" + juce::String (hybridBlend.diagnostics.bridgeFallbackUsed ? "true" : "false")
                    + " bridgeLag=" + juce::String (hybridBlend.diagnostics.bridgeAlignmentLagSamples)
                    + " bridgeScore=" + juce::String (hybridBlend.diagnostics.bridgeCorrelationScore, 3));
            }
            else if (pitchRendererBranch == PitchOnlyRendererBranch::OwnEnginePitchOnly)
            {
                OwnPitchEngine ownEngine;
                auto ownResult = ownEngine.renderPitchOnly (
                    input,
                    numChannels,
                    numSamples,
                    sampleRate,
                    frames,
                    notes,
                    ratios,
                    toOwnEngineQuality (renderQuality),
                    shouldCancel);
                output = std::move (ownResult.output);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.usedFallback = ownResult.usedFallback;
                lastRenderDiagnostics.fallbackReason = ownResult.fallbackReason;
                logPitchEditorFormant ("using own-engine pitch-only renderer"
                    + juce::String (" analysisMs=") + juce::String (ownResult.analysisMs, 2)
                    + " renderMs=" + juce::String (ownResult.renderMs, 2)
                    + " islands=" + juce::String (static_cast<int> (ownResult.analysis.islands.size()))
                    + " epochs=" + juce::String (ownResult.analysis.totalEpochCount)
                    + " maxPartials=" + juce::String (ownResult.analysis.maxPartialCount));
            }
            else if (pitchRendererBranch == PitchOnlyRendererBranch::SimpleCe33)
            {
                output = copyInputChannels (input, numChannels, numSamples);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                logPitchEditorFormant ("using simple ce33-style pitch-only baseline path");
            }
            else
            {
                output = renderPitchOnlyIslands (input, numChannels, numSamples, sampleRate,
                                                 frames, notes, pitchRendererBranch, renderQuality, shouldCancel);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                logPitchEditorFormant ("using note-local pitch-only shifter path");
            }
            break;
        }
        case ProcessingMode::FormantOnly:
        {
            if (pitchRendererBranch == PitchOnlyRendererBranch::OwnEngineFormantOnly)
            {
                OwnPitchEngine ownEngine;
                const auto analysis = ownEngine.analyze (
                    input,
                    numChannels,
                    numSamples,
                    sampleRate,
                    frames,
                    notes,
                    OwnPitchEngine::Mode::FormantOnly,
                    toOwnEngineQuality (renderQuality));
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                logPitchEditorFormant ("own-engine shared analysis ready for formant-only render"
                    + juce::String (" islands=") + juce::String (static_cast<int> (analysis.islands.size()))
                    + " epochs=" + juce::String (analysis.totalEpochCount)
                    + " maxPartials=" + juce::String (analysis.maxPartialCount)
                    + " cacheHit=" + juce::String (analysis.cacheHit ? "true" : "false"));
            }
            else
            {
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
            }
            if (engineV3Branch)
                populateEngineV3BoundaryDiagnostics();
            for (int ch = 0; ch < numChannels; ++ch)
                output[static_cast<size_t> (ch)].assign (input[ch], input[ch] + numSamples);
            logPitchEditorFormant ("formant-only render unsupported; returning dry audio");
            break;
        }
        case ProcessingMode::PitchPlusFormant:
        {
            if (shouldCancel && shouldCancel())
                return output;
            if (pitchRendererBranch == PitchOnlyRendererBranch::OwnEnginePitchPlusFormant)
            {
                OwnPitchEngine ownEngine;
                auto ownResult = ownEngine.renderPitchOnly (
                    input,
                    numChannels,
                    numSamples,
                    sampleRate,
                    frames,
                    notes,
                    ratios,
                    toOwnEngineQuality (renderQuality),
                    shouldCancel);
                output = std::move (ownResult.output);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                lastRenderDiagnostics.usedFallback = ownResult.usedFallback;
                lastRenderDiagnostics.fallbackReason = ownResult.fallbackReason;
                logPitchEditorFormant ("using own-engine pitch base with explicit formant overlay"
                    + juce::String (" analysisMs=") + juce::String (ownResult.analysisMs, 2)
                    + " renderMs=" + juce::String (ownResult.renderMs, 2)
                    + " islands=" + juce::String (static_cast<int> (ownResult.analysis.islands.size())));
            }
            else
            {
                output = copyInputChannels (input, numChannels, numSamples);
                lastRenderDiagnostics.actualRendererBranch = juce::String (getPitchOnlyRendererBranchName (pitchRendererBranch));
                if (engineV3Branch)
                    populateEngineV3BoundaryDiagnostics();
                logPitchEditorFormant ("using preserved-timbre pitch base with explicit formant overlay");
            }
            break;
        }
    }

    if (lastRenderDiagnostics.actualRendererBranch.isEmpty())
        lastRenderDiagnostics.actualRendererBranch = lastRenderDiagnostics.requestedRendererBranch;

    if (processingMode == ProcessingMode::PitchOnly
        && pitchOnlyRecoveryPath == PitchOnlyRecoveryPath::CurrentExperimental
        && pitchRendererBranch != PitchOnlyRendererBranch::VocalSourceFilterHq
        && (pitchDirection.hasUpward || pitchDirection.hasDownward)
        && ! output.empty())
    {
        int lifter = 0;
        int fftSize = 0;
        int hop = 0;
        float envelopeMixUsed = 0.0f;
        float rmsTrimDb = 0.0f;
        const float rmsTrimCapDb = pitchDirection.hasDownward && ! pitchDirection.hasUpward
            ? juce::jlimit (0.0f, 1.5f, getEnvFloat ("OPENSTUDIO_PITCH_CORE_DOWN_RMS_TRIM_DB", 1.3f))
            : juce::jlimit (0.0f, 1.5f, getEnvFloat ("OPENSTUDIO_PITCH_CORE_UP_RMS_TRIM_DB", 1.5f));
        const bool rmsTrimUsed = applyPitchOnlyCoreRmsTrim (
            output,
            input,
            numChannels,
            numSamples,
            sampleRate,
            notes,
            detectedPitchHz,
            rmsTrimCapDb,
            pitchDirection.hasDownward && ! pitchDirection.hasUpward,
            &rmsTrimDb);
        const bool envelopeUsed = applyVoicedCoreEnvelopeTransferForPitchOnly (
            output,
            input,
            numChannels,
            numSamples,
            sampleRate,
            frames,
            notes,
            detectedPitchHz,
            0.0f,
            0.05f,
            2.5f,
            38,
            &lifter,
            &fftSize,
            &hop,
            &envelopeMixUsed);
        if (envelopeUsed || rmsTrimUsed)
        {
            if (envelopeUsed)
                lastRenderDiagnostics.spectralEnvelopeCorrectionUsed = true;
            lastRenderDiagnostics.pitchOnlyCoreTimbreCorrectionUsed = true;
            lastRenderDiagnostics.pitchOnlyCoreEnvelopeMix = envelopeMixUsed;
            lastRenderDiagnostics.pitchOnlyCoreRmsTrimDb = rmsTrimDb;
            lastRenderDiagnostics.pitchOnlyCoreEnvelopeLifter = lifter;
            lastRenderDiagnostics.cepstralCutoffUsed = std::max (lastRenderDiagnostics.cepstralCutoffUsed, lifter);
            lastRenderDiagnostics.engineV2FftSize = std::max (lastRenderDiagnostics.engineV2FftSize, fftSize);
            lastRenderDiagnostics.engineV2HopSize = std::max (lastRenderDiagnostics.engineV2HopSize, hop);
            logPitchEditorFormant ("pitch-only core timbre correction"
                + juce::String (" direction=") + pitchDirection.name
                + " envelope=" + juce::String (envelopeUsed ? "true" : "false")
                + " mix=" + juce::String (envelopeMixUsed, 3)
                + " rmsTrimDb=" + juce::String (rmsTrimDb, 3)
                + " lifter=" + juce::String (lifter)
                + " fft/hop=" + juce::String (fftSize) + "/" + juce::String (hop));
        }
    }

    const bool pitchOnlyCoreTextureEnabled = processingMode == ProcessingMode::PitchOnly
        && pitchOnlyRecoveryPath == PitchOnlyRecoveryPath::NeutralFormantMinimal
        && pitchRendererBranch != PitchOnlyRendererBranch::VocalSourceFilterHq
        && (pitchDirection.hasUpward || pitchDirection.hasDownward)
        && getEnvInt ("OPENSTUDIO_PITCH_CORE_TEXTURE_ENABLE", 1) != 0;
    if (pitchOnlyCoreTextureEnabled && ! output.empty())
    {
        float textureMixUsed = 0.0f;
        const bool textureUsed = applyPitchOnlyCoreAperiodicTexture (
            output,
            input,
            numChannels,
            numSamples,
            sampleRate,
            notes,
            detectedPitchHz,
            pitchDirection.hasDownward && ! pitchDirection.hasUpward,
            &textureMixUsed);

        if (textureUsed)
        {
            lastRenderDiagnostics.pitchOnlyCoreTimbreCorrectionUsed = true;
            lastRenderDiagnostics.residualCarryUsed = true;
            logPitchEditorFormant ("pitch-only core aperiodic texture"
                + juce::String (" direction=") + pitchDirection.name
                + " mix=" + juce::String (textureMixUsed, 3));
        }
    }

    const bool pitchOnlyCoreLevelEnabled = processingMode == ProcessingMode::PitchOnly
        && pitchOnlyRecoveryPath == PitchOnlyRecoveryPath::NeutralFormantMinimal
        && pitchRendererBranch != PitchOnlyRendererBranch::VocalSourceFilterHq
        && (pitchDirection.hasUpward || pitchDirection.hasDownward)
        && getEnvInt ("OPENSTUDIO_PITCH_CORE_LEVEL_ENABLE", 0) != 0;
    if (pitchOnlyCoreLevelEnabled && ! output.empty())
    {
        float coreLevelDb = 0.0f;
        const bool coreLevelUsed = applyPitchOnlyCoreDirectionalLevel (
            output,
            input,
            numChannels,
            numSamples,
            sampleRate,
            notes,
            detectedPitchHz,
            pitchDirection.hasDownward && ! pitchDirection.hasUpward,
            &coreLevelDb);

        if (coreLevelUsed)
        {
            lastRenderDiagnostics.pitchOnlyCoreTimbreCorrectionUsed = true;
            lastRenderDiagnostics.pitchOnlyCoreRmsTrimDb = coreLevelDb;
            logPitchEditorFormant ("pitch-only core directional level"
                + juce::String (" direction=") + pitchDirection.name
                + " trimDb=" + juce::String (coreLevelDb, 3));
        }
    }

    const bool formantOnlyRender = processingMode == ProcessingMode::FormantOnly;

    // Pitch-only now uses the stable note-local base render plus a strictly
    // note-core serial correction inside renderPitchOnlyIslands(). Broad
    // post-correction remains disabled here because it was the path that
    // previously reintroduced crackle and shoulder damage.
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
    if (processingMode != ProcessingMode::PitchOnly)
    {
        applyReferenceResidualMatch (output, input, numChannels, numSamples,
                                     sampleRate, notes, formantRatios, detectedPitchHz,
                                     hasPitchShift, ! formantRatios.empty(),
                                     renderQuality, shouldCancel);
    }

    if (engineV3LpcTransfer && processingMode != ProcessingMode::FormantOnly && ! output.empty())
    {
        LpcEnvelopeTransfer::Settings lpcSettings;
        lpcSettings.lpcOrder = juce::jlimit (12, 20, getEnvInt ("OPENSTUDIO_ENGINE_V3_LPC_ORDER", 16));
        lpcSettings.fftOrder = juce::jlimit (8, 10, getEnvInt ("OPENSTUDIO_ENGINE_V3_LPC_FFT_ORDER", 9));
        lpcSettings.hopSize = std::max (1, (1 << lpcSettings.fftOrder) / 2);
        lpcSettings.epsilonFloor = juce::jlimit (1.0e-5f, 1.0e-2f, getEnvFloat ("OPENSTUDIO_ENGINE_V3_LPC_EPSILON", 1.0e-3f));
        lpcSettings.maxCorrectionGain = juce::jlimit (1.2f, 3.0f, getEnvFloat ("OPENSTUDIO_ENGINE_V3_LPC_MAX_GAIN", 2.2f));
        if (LpcEnvelopeTransfer::applyToBuffer (output, input, numChannels, numSamples, lpcSettings))
        {
            lastRenderDiagnostics.spectralEnvelopeCorrectionUsed = true;
            lastRenderDiagnostics.v3FormantMode = "lpc_transfer";
        }
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
