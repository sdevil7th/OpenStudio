#pragma once

#include <JuceHeader.h>
#include "PitchAnalyzer.h"
#include <vector>
#include <functional>

/**
 * PitchResynthesizer — Offline pitch correction from graphical edits.
 *
 * Takes original audio + edited notes, produces corrected audio.
 * Uses the Studio13 native VSF renderer for graphical offline pitch-only edits.
 *
 * Non-destructive: original audio is never modified.
 */
class PitchResynthesizer
{
public:
    struct RenderDiagnostics
    {
        juce::String requestedRendererBranch;
        juce::String actualRendererBranch;
        juce::String processingMode;
        juce::String pitchDirection;
        juce::String pitchOnlyRecoveryPath;
        bool formantCurveUsed = false;
        bool explicitFormantRequested = false;
        bool pitchOnlyFormantSuppressed = false;
        bool pitchOnlyNeutralFormantUsed = false;
        bool downshiftFormantGuardUsed = false;
        double downshiftFormantGuardAlpha = 0.0;
        juce::String dominantEntryBoundaryKind = "unknown";
        juce::String dominantExitBoundaryKind = "unknown";
        double dominantEntryBoundaryScore = 0.0;
        double dominantExitBoundaryScore = 0.0;
        bool usedFallback = false;
        juce::String fallbackReason;
        bool bridgeUsed = false;
        bool bridgeFallbackUsed = false;
        double bridgeStartSec = 0.0;
        double bridgeLengthMs = 0.0;
        int bridgeAlignmentLagSamples = 0;
        float bridgeCorrelationScore = 0.0f;
        float bridgeGainDeltaDb = 0.0f;
        bool bodyReplacementUsed = false;
        bool bodyReplacementFallbackUsed = false;
        double entryLockStartSec = 0.0;
        double entryLockLengthMs = 0.0;
        double exitLockStartSec = 0.0;
        double renderedBodyStartSec = 0.0;
        double renderedBodyEndSec = 0.0;
        bool islandNativeUsed = false;
        bool islandNativeFallbackUsed = false;
        double islandRenderStartSec = 0.0;
        double islandRenderEndSec = 0.0;
        float transientMaskPeak = 0.0f;
        float voicedCoreMaskPeak = 0.0f;
        bool hpssUsed = false;
        bool hpssFallbackUsed = false;
        float harmonicMaskPeak = 0.0f;
        float aperiodicMaskPeak = 0.0f;
        bool spectralEnvelopeCorrectionUsed = false;
        bool pitchOnlyCoreTimbreCorrectionUsed = false;
        double pitchOnlyCoreEnvelopeMix = 0.0;
        double pitchOnlyCoreRmsTrimDb = 0.0;
        int pitchOnlyCoreEnvelopeLifter = 0;
        bool pitchOnlyEntryHandoffUsed = false;
        bool pitchOnlyExitHandoffUsed = false;
        bool vocalSourceFilterUsed = false;
        double vocalSourceFilterVoicedCoverage = 0.0;
        double vocalSourceFilterResidualMix = 0.0;
        bool vocalSourceFilterFallbackUsed = false;
        juce::String vocalSourceFilterFallbackReason;
        double vocalSourceFilterEntryDryMs = 0.0;
        double vocalSourceFilterExitDryMs = 0.0;
        double vocalSourceFilterResidualMixScale = 1.0;
        bool vocalSourceFilterEpochInterpolationUsed = false;
        double vocalSourceFilterEpochInterpolationStrength = 0.0;
        double vocalSourceFilterGrainRadiusScale = 1.0;
        double vocalSourceFilterUpPresenceTrimDb = 0.0;
        double vocalSourceFilterUpPresenceHz = 0.0;
        double vocalSourceFilterDownNasalTrimDb = 0.0;
        double vocalSourceFilterDownNasalHz = 0.0;
        double vocalSourceFilterDownBodyCompDb = 0.0;
        double vocalSourceFilterDownBodyCompHz = 0.0;
        bool wsolaUsed = false;
        bool wsolaFallbackUsed = false;
        int wsolaEntryLagSamples = 0;
        int wsolaExitLagSamples = 0;
        float wsolaCorrelationScore = 0.0f;
        bool phaseLockUsed = false;
        bool phaseLockFallbackUsed = false;
        bool phaseAlignedEntry = false;
        bool phaseAlignedExit = false;
        int phasePeakCount = 0;
        bool transitionHqUsed = false;
        bool transitionHqFallbackUsed = false;
        double transitionStartSec = 0.0;
        double transitionEndSec = 0.0;
        float transitionTransientPeak = 0.0f;
        float transitionVoicedCorePeak = 0.0f;
        float transitionResidualPeak = 0.0f;
        bool transitionEnvelopeCorrectionUsed = false;
        bool engineV2Used = false;
        bool engineV2FallbackUsed = false;
        int engineV2TransitionCount = 0;
        double engineV2TransitionStartSec = 0.0;
        double engineV2TransitionEndSec = 0.0;
        float engineV2HarmonicSupportPeak = 0.0f;
        float engineV2ResidualSupportPeak = 0.0f;
        float engineV2EnvelopeSupportPeak = 0.0f;
        bool transientBypassUsed = false;
        bool residualCarryUsed = false;
        int cepstralCutoffUsed = 0;
        int engineV2FftSize = 0;
        int engineV2HopSize = 0;
        bool immediateLeftNeighborUsed = false;
        bool immediateRightNeighborUsed = false;
        int leftNeighborSamplesRendered = 0;
        int rightNeighborSamplesRendered = 0;
        double leftNeighborSmoothMs = 0.0;
        double rightNeighborSmoothMs = 0.0;
        bool nonImmediateNeighborTouched = false;
        double entryAlignmentOffsetMs = 0.0;
        double exitAlignmentOffsetMs = 0.0;
        bool firstVoicedCyclesEntryUsed = false;
        bool firstVoicedCyclesExitUsed = false;
        bool v3TransitionPairUsed = false;
        bool v3ContinuousRenderUsed = false;
        double v3EntryAnchorMs = 0.0;
        double v3ExitAnchorMs = 0.0;
        int v3FirstCyclesEntryCount = 0;
        int v3FirstCyclesExitCount = 0;
        double v3ShellDurationMs = 0.0;
        double v3BodyDurationMs = 0.0;
        double v3ResidualMix = 0.0;
        juce::String v3FormantMode;
        double v3NeighborLeftOverlapMs = 0.0;
        double v3NeighborRightOverlapMs = 0.0;
        bool noteHqEntryPitchHandoffUsed = false;
        double noteHqEntryPitchHandoffStartSec = 0.0;
        double noteHqEntryPitchHandoffEndSec = 0.0;
        double noteHqEntryPitchHandoffPreMs = 0.0;
        double noteHqEntryPitchHandoffBodyMs = 0.0;
        double noteHqEntryPitchSlopeJumpStPerSec = 0.0;
        bool noteHqEntryPitchAccelerationLimited = false;
    };

    enum class PitchEngine
    {
        NativeVsf
    };

    enum class RenderQuality
    {
        PreviewFast,
        FinalHQ
    };

    PitchResynthesizer();

    /**
     * Apply pitch corrections to multi-channel audio.
     * All engines handle stereo natively (no mono mix fallback).
     */
    std::vector<std::vector<float>> processMultiChannel (
        const float* const* input,
        int numChannels,
        int numSamples,
        double sampleRate,
        const std::vector<PitchAnalyzer::PitchFrame>& frames,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        PitchEngine engine = PitchEngine::NativeVsf,
        float globalFormantSemitones = 0.0f,
        RenderQuality renderQuality = RenderQuality::FinalHQ,
        std::function<bool()> shouldCancel = {});

    /**
     * Build a per-sample pitch shift ratio curve from the note edits.
     * Public so AudioEngine can inspect it for debugging.
     */
    std::vector<float> buildCorrectionCurve (
        int numSamples, double sampleRate,
        const std::vector<PitchAnalyzer::PitchFrame>& frames,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        int hopSize);

    /**
     * Build a per-sample formant shift ratio curve from the note edits.
     * Returns empty vector if no notes have formant shifts (skip formant processing).
     */
    static std::vector<float> buildFormantCurve (
        int numSamples, double sampleRate,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        float globalFormantSemitones = 0.0f);

    static juce::String getRequestedPitchRendererBranchName();
    const RenderDiagnostics& getLastRenderDiagnostics() const noexcept { return lastRenderDiagnostics; }

    /** No-op — kept for API compatibility with AudioEngine. */
    void clearCache() {}

private:
    RenderDiagnostics lastRenderDiagnostics;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PitchResynthesizer)
};
