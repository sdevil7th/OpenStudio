#pragma once

#include <JuceHeader.h>
#include "PitchAnalyzer.h"

#include <memory>
#include <vector>

namespace PitchRendering
{

class PitchRenderBackend
{
public:
    enum class ProductPath
    {
        Preview,
        OfflineHq,
        AraPlugin
    };

    struct Capabilities
    {
        bool preview = false;
        bool offlineHq = false;
        bool araPlugin = false;
        bool phraseOrClipContext = false;
        bool variablePitchMap = false;
        bool formantPreservation = false;
        bool explicitFormantControl = false;
        bool requiresExternalExecutable = false;
        bool nativeInProcess = false;
        bool benchmarkCandidate = false;
        bool promotionGatePassed = false;
        bool fallbackBaseline = false;

        juce::var toVar() const;
    };

    struct Status
    {
        juce::String backendId;
        juce::String displayName;
        ProductPath productPath = ProductPath::OfflineHq;
        Capabilities capabilities;
        bool available = false;
        juce::String executablePath;
        juce::String version;
        juce::String integrationKind;
        juce::String promotionStatus;
        juce::String selectedReason;
        juce::String failureCode;
        juce::String failureMessage;
        juce::String overridePath;
        bool overridePathExists = false;
        bool versionProbeSucceeded = false;
        int versionProbeExitCode = -1;
        juce::String versionProbeOutput;
        juce::var diagnostics;

        juce::var toVar() const;
    };

    struct RenderRequest
    {
        const juce::AudioBuffer<float>* input = nullptr;
        int numSamples = 0;
        double sampleRate = 0.0;
        std::vector<PitchAnalyzer::PitchNote> notes;
        juce::String renderMode;
        juce::String scope;
        double contextStartSec = 0.0;
        double contextEndSec = 0.0;
        double jobStartDelayMs = 0.0;

        struct CommitRange
        {
            double startSec = 0.0;
            double endSec = 0.0;
            double bodyStartSec = 0.0;
            double bodyEndSec = 0.0;
            double pitchRatio = 1.0;
            int pitchDirection = 0;
            juce::String wordGroupId;
            int editedNoteCount = 1;
            bool variablePitchRatio = false;
            juce::String entryBoundaryKind = "unknown";
            juce::String exitBoundaryKind = "unknown";
            double entryBoundaryScore = 0.0;
            double exitBoundaryScore = 0.0;
        };

        std::vector<CommitRange> commitRanges;
    };

    struct RenderResult
    {
        bool success = false;
        juce::AudioBuffer<float> output;
        Status status;
        juce::String failureCode;
        juce::String failureMessage;
        juce::String diagnosticsText;
        bool usedFallback = false;
        juce::String fallbackReason;
        juce::String commitPolicy;
        int dryProtectedSamples = 0;
        double contextDurationSec = 0.0;
        double commitDurationSec = 0.0;
        bool backendProbeCached = false;
        double jobStartDelayMs = 0.0;
    };

    virtual ~PitchRenderBackend() = default;

    virtual juce::String backendId() const = 0;
    virtual ProductPath productPath() const = 0;
    virtual Capabilities capabilities() const = 0;
    virtual Status probe() const = 0;
    virtual RenderResult render (const RenderRequest& request) const = 0;

    static juce::String productPathName (ProductPath path);
};

std::unique_ptr<PitchRenderBackend> createPitchRenderBackend (PitchRenderBackend::ProductPath path);
std::unique_ptr<PitchRenderBackend> createPitchRenderBackend (const juce::String& backendId);
juce::Array<juce::var> probeOfflineHqPitchRenderBackends();
juce::String getDefaultOfflineHqBackendId();

} // namespace PitchRendering
