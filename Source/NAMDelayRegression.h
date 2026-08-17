#pragma once

#include <JuceHeader.h>

class S13NAMRack;

// Kept in dedicated translation units so the deterministic Delay/Tape/host-
// tail objective matrix never inflates AudioEngine::runNAMRackRegression or
// one diagnostic helper beyond MSVC's compiler-heap limits.
class NAMDelayRegression final
{
public:
    static juce::Array<juce::var> run();

private:
    inline static constexpr double fixtureSampleRate = 44100.0;
    inline static constexpr int fixtureBlockSize = 512;

    static void addCheck(
        juce::Array<juce::var>& targetChecks,
        const juce::String& id,
        const juce::String& status,
        const juce::String& detail,
        const juce::var& value = juce::var());
    static void configureNeutralRack(S13NAMRack& rack);

    static juce::Array<juce::var> runCoreChecks();
    static juce::Array<juce::var> runLifecycleChecks();
    static juce::Array<juce::var> runRackTailChecks();

    static juce::var runDelayV10ContractProbe();
    static juce::var runDelayV10AudioProbe();
    static juce::var runDelayV10Stage3TopologyProbe();
    static juce::var runDelayPlayHeadLifecycleProbe();
    static juce::var runDelayTailLifecycleProbe();
    static juce::var runDelayHighFeedbackDecayProbe();
    static juce::var runDelayFractionalResetProbe();
    static juce::var runStandaloneDelayMalformedAndLegacyModeProbe();
    static juce::var runRackDelaySpilloverProbe();
    static juce::var runRackDelayV10FrozenTailAndBudgetProbe();
    static juce::var runRackMinimumDelayBypassProbe();
    static juce::var runRackTapeEchoSpilloverProbe();
    static juce::var runRackTapeEchoFrozenTailContractProbe();
    static juce::var runTrackProcessorSparseTailServiceProbe();
};
