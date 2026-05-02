#pragma once

#include <JuceHeader.h>
#include "PitchAnalyzer.h"
#include <functional>
#include <vector>

class OwnPitchEngine
{
public:
    enum class Mode
    {
        PitchOnly,
        FormantOnly,
        PitchPlusFormant
    };

    enum class Quality
    {
        PreviewFast,
        FinalHQ
    };

    struct VoicedCoreAnalysis
    {
        int startSample = 0;
        int endSample = 0;
        float voicedRatio = 0.0f;
        float meanF0Hz = 0.0f;
        float rms = 0.0f;
        int epochCount = 0;
    };

    struct HarmonicFrame
    {
        int sampleIndex = 0;
        float f0Hz = 0.0f;
        std::vector<float> amplitudes;
    };

    struct SpectralEnvelopeFrame
    {
        int sampleIndex = 0;
        float f0Hz = 0.0f;
        std::vector<float> rawMagnitude;
        std::vector<float> smoothedMagnitude;
    };

    struct HarmonicModel
    {
        int fftSize = 0;
        float binHz = 0.0f;
        int partialCount = 0;
        std::vector<float> averageMagnitude;
        std::vector<HarmonicFrame> frames;
    };

    struct ResidualModel
    {
        std::vector<float> monoResidual;
        std::vector<float> voicedHighBandResidual;
        std::vector<float> bandAperiodicity;
        float suggestedMix = 0.0f;
        float voicedMix = 0.0f;
        float highBandMix = 0.0f;
    };

    struct SpectralEnvelopeModel
    {
        int fftOrder = 0;
        int fftSize = 0;
        float binHz = 0.0f;
        std::vector<float> averageMagnitude;
        std::vector<SpectralEnvelopeFrame> frames;
    };

    struct NoteIslandAnalysis
    {
        int renderStartSample = 0;
        int renderEndSample = 0;
        int contextStartSample = 0;
        int contextEndSample = 0;
        int bodyStartSample = 0;
        int bodyEndSample = 0;
        std::vector<PitchAnalyzer::PitchNote> notes;

        std::vector<float> monoSignal;
        std::vector<float> voicedMask;
        std::vector<float> consonantMask;
        std::vector<float> f0TrackHz;
        std::vector<float> amplitudeEnvelope;
        std::vector<int> epochs;

        VoicedCoreAnalysis core;
        HarmonicModel harmonicModel;
        ResidualModel residualModel;
        SpectralEnvelopeModel spectralEnvelopeModel;
    };

    struct SharedAnalysis
    {
        Mode mode = Mode::PitchOnly;
        Quality quality = Quality::FinalHQ;
        double sampleRate = 0.0;
        int numChannels = 0;
        int numSamples = 0;
        bool cacheHit = false;
        std::vector<NoteIslandAnalysis> islands;
        int totalEpochCount = 0;
        int maxPartialCount = 0;
    };

    struct RenderResult
    {
        std::vector<std::vector<float>> output;
        SharedAnalysis analysis;
        bool usedFallback = false;
        juce::String fallbackReason;
        double analysisMs = 0.0;
        double renderMs = 0.0;
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
    };

    OwnPitchEngine() = default;

    SharedAnalysis analyze (
        const float* const* input,
        int numChannels,
        int numSamples,
        double sampleRate,
        const std::vector<PitchAnalyzer::PitchFrame>& frames,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        Mode mode,
        Quality quality);

    RenderResult renderPitchOnly (
        const float* const* input,
        int numChannels,
        int numSamples,
        double sampleRate,
        const std::vector<PitchAnalyzer::PitchFrame>& frames,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        const std::vector<float>& pitchRatios,
        Quality quality,
        std::function<bool()> shouldCancel = {});

    RenderResult renderVocalSourceFilterHq (
        const float* const* input,
        int numChannels,
        int numSamples,
        double sampleRate,
        const std::vector<PitchAnalyzer::PitchFrame>& frames,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        const std::vector<float>& pitchRatios,
        Quality quality,
        std::function<bool()> shouldCancel = {});
};
