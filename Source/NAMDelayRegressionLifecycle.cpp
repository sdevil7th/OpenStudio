#include "NAMDelayRegression.h"
#include "BuiltInEffects2.h"
#include "TrackProcessor.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <numeric>
#include <utility>
#include <vector>

juce::var NAMDelayRegression::runDelayPlayHeadLifecycleProbe()
{
    struct CountingPlayHead final : juce::AudioPlayHead
    {
        explicit CountingPlayHead(double tempo) : bpm(tempo) {}

        juce::Optional<PositionInfo> getPosition() const override
        {
            ++positionCalls;
            PositionInfo info;
            info.setBpm(bpm);
            info.setIsPlaying(true);
            return info;
        }

        double bpm = 60.0;
        mutable int positionCalls = 0;
    };

    CountingPlayHead standaloneHead(60.0);
    S13Delay standaloneDelay(10.0f);
    standaloneDelay.delayTimeL.store(250.0f);
    standaloneDelay.delayTimeR.store(250.0f);
    standaloneDelay.feedback.store(0.0f);
    standaloneDelay.mix.store(1.0f);
    standaloneDelay.tempoSync.store(1.0f);
    standaloneDelay.syncNoteL.store(2.0f);
    standaloneDelay.syncNoteR.store(2.0f);
    standaloneDelay.setPlayHead(&standaloneHead);
    standaloneDelay.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    const int callsAfterPrepare =
        standaloneHead.positionCalls;
    const double conservativeUnknownTail =
        standaloneDelay.getTailLengthSeconds();
    const int callsAfterInitialTail =
        standaloneHead.positionCalls;
    standaloneDelay.resetTailState();
    const int callsAfterReset =
        standaloneHead.positionCalls;

    juce::AudioBuffer<float> standaloneBlock(
        2, fixtureBlockSize);
    standaloneBlock.clear();
    standaloneBlock.setSample(0, 0, 0.5f);
    juce::MidiBuffer midi;
    standaloneDelay.processBlock(standaloneBlock, midi);
    const int callsAfterProcess =
        standaloneHead.positionCalls;
    const double publishedTempoTail =
        standaloneDelay.getTailLengthSeconds();
    const int callsAfterPublishedTail =
        standaloneHead.positionCalls;
    const float standaloneSnappedSamplesAt60 =
        standaloneDelay.requestedDelaySamplesL;
    const bool standaloneSnappedWithoutMorphAt60 =
        ! standaloneDelay.delayTimeMorphActive
        && ! standaloneDelay.delayTimeChangePending;
    standaloneDelay.resetTailState();
    const int callsAfterPublishedReset =
        standaloneHead.positionCalls;
    const float tempoRetainedAcrossLogicalReset =
        standaloneDelay.publishedTempoBpm.load(
            std::memory_order_relaxed);
    standaloneHead.bpm = 10.0;
    standaloneDelay.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    const int callsAfterStaleTempoPrepare =
        standaloneHead.positionCalls;
    const double staleTempoPreCallbackTail =
        standaloneDelay.getTailLengthSeconds();
    standaloneBlock.clear();
    standaloneBlock.setSample(0, 0, 0.5f);
    standaloneDelay.processBlock(standaloneBlock, midi);
    const int callsAfterTenBpmProcess =
        standaloneHead.positionCalls;
    const float standaloneSnappedSamplesAt10 =
        standaloneDelay.requestedDelaySamplesL;
    const bool standaloneSnappedWithoutMorphAt10 =
        ! standaloneDelay.delayTimeMorphActive
        && ! standaloneDelay.delayTimeChangePending;
    const double tenBpmPublishedTail =
        standaloneDelay.getTailLengthSeconds();
    standaloneDelay.reset();
    const int callsAfterHostReset =
        standaloneHead.positionCalls;
    const float tempoAfterHostReset =
        standaloneDelay.publishedTempoBpm.load(
            std::memory_order_relaxed);
    const double hostResetPreCallbackTail =
        standaloneDelay.getTailLengthSeconds();
    const float expectedQuarterNoteSamples =
        static_cast<float>(fixtureSampleRate);
    const float expectedTenBpmQuarterSamples =
        static_cast<float>(fixtureSampleRate * 6.0);
    const bool standaloneLifecyclePassed =
        callsAfterPrepare == 0
        && callsAfterInitialTail == 0
        && callsAfterReset == 0
        && callsAfterProcess == 1
        && callsAfterPublishedTail == 1
        && callsAfterPublishedReset == 1
        && callsAfterStaleTempoPrepare == 1
        && callsAfterTenBpmProcess == 2
        && callsAfterHostReset == 2
        && conservativeUnknownTail
            >= publishedTempoTail * 5.9
        && std::abs(
               standaloneSnappedSamplesAt60
               - expectedQuarterNoteSamples) <= 1.0f
        && std::abs(
               tempoRetainedAcrossLogicalReset - 60.0f) <= 1.0e-6f
        && standaloneSnappedWithoutMorphAt60
        && staleTempoPreCallbackTail + 1.0e-5
            >= tenBpmPublishedTail
        && hostResetPreCallbackTail + 1.0e-5
            >= tenBpmPublishedTail
        && std::abs(
               standaloneSnappedSamplesAt10
               - expectedTenBpmQuarterSamples) <= 1.0f
        && standaloneSnappedWithoutMorphAt10
        && std::abs(tempoAfterHostReset) <= 1.0e-6f;

    CountingPlayHead rackHead(60.0);
    S13NAMRack rack;
    configureNeutralRack(rack);
    rack.delayEnabled.store(1.0f);
    rack.delayMix.store(0.75f);
    rack.delayFeedback.store(0.0f);
    rack.delayMod.store(0.0f);
    rack.delayDucker.store(0.0f);
    rack.delayMode.store(static_cast<float>(
        S13NAMRack::digitalDelayMode));
    rack.delayTempoSync.store(1.0f);
    rack.setPlayHead(&rackHead);
    rack.prepareToPlay(fixtureSampleRate, fixtureBlockSize);
    const int rackCallsAfterPrepare =
        rackHead.positionCalls;
    const double rackUnknownTail =
        rack.getTailLengthSeconds();
    const int rackCallsAfterInitialTail =
        rackHead.positionCalls;
    juce::AudioBuffer<float> rackBlock(
        2, fixtureBlockSize);
    rackBlock.clear();
    rackBlock.setSample(0, 0, 0.5f);
    rack.processBlock(rackBlock, midi);
    const int rackCallsAfterProcess =
        rackHead.positionCalls;
    const double rackPublishedTail =
        rack.getTailLengthSeconds();
    const int rackCallsAfterPublishedTail =
        rackHead.positionCalls;
    const float rackSnappedSamplesAt60 =
        rack.rackDelay.requestedDelaySamplesL;
    rackHead.bpm = 10.0;
    rack.reset();
    const int rackCallsAfterHostReset =
        rackHead.positionCalls;
    const double rackStaleTempoPreCallbackTail =
        rack.getTailLengthSeconds();
    const double maximumAutomatedDelayTail =
        rack.getAutomatedTailLengthSeconds(
            S13NAMRack::tailAutomationDelay);
    const double actualQuarterWidth = 1.08;
    const double actualQuarterTailAtTenBpm =
        (6.0 + 1.0 / fixtureSampleRate)
        * (std::log(0.001 / actualQuarterWidth)
               / std::log(0.85)
           + 1.0);
    rackBlock.clear();
    rackBlock.setSample(0, 0, 0.5f);
    rack.processBlock(rackBlock, midi);
    const int rackCallsAfterTenBpmProcess =
        rackHead.positionCalls;
    const float rackSnappedSamplesAt10 =
        rack.rackDelay.requestedDelaySamplesL;
    const bool rackSnappedWithoutMorphAt10 =
        ! rack.rackDelay.delayTimeMorphActive
        && ! rack.rackDelay.delayTimeChangePending;
    const double rackTenBpmPublishedTail =
        rack.getTailLengthSeconds();
    const bool rackLifecyclePassed =
        rackCallsAfterPrepare == 0
        && rackCallsAfterInitialTail == 0
        && rackCallsAfterProcess == 1
        && rackCallsAfterPublishedTail == 1
        && rackCallsAfterHostReset == 1
        && rackCallsAfterTenBpmProcess == 2
        && rackUnknownTail >= rackPublishedTail
        && rackStaleTempoPreCallbackTail
                + 0.020
                + 2.0 / fixtureSampleRate
            >= rackTenBpmPublishedTail
        && maximumAutomatedDelayTail
            >= actualQuarterTailAtTenBpm
        && std::abs(
               rackSnappedSamplesAt60
               - expectedQuarterNoteSamples) <= 1.0f
        && std::abs(
               rackSnappedSamplesAt10
               - expectedTenBpmQuarterSamples) <= 1.0f
        && rackSnappedWithoutMorphAt10
        && std::abs(
               rack.publishedTempoBpm.load(
                   std::memory_order_relaxed)
               - 10.0f) <= 1.0e-6f
        && std::abs(
               rack.rackDelay.publishedTempoBpm.load(
                   std::memory_order_relaxed)
               - 10.0f) <= 1.0e-6f;

    CountingPlayHead maximumTailHead(10.0);
    S13Delay maximumTailDelay;
    maximumTailDelay.delayTimeL.store(1.0f);
    maximumTailDelay.delayTimeR.store(1.0f);
    maximumTailDelay.feedback.store(0.95f);
    maximumTailDelay.crossFeed.store(0.0f);
    maximumTailDelay.mix.store(1.0f);
    maximumTailDelay.tempoSync.store(1.0f);
    maximumTailDelay.syncNoteL.store(0.0f);
    maximumTailDelay.syncNoteR.store(0.0f);
    maximumTailDelay.lpfFreq.store(20000.0f);
    maximumTailDelay.hpfFreq.store(20.0f);
    maximumTailDelay.fbSaturation.store(0.0f);
    maximumTailDelay.stereoWidth.store(2.0f);
    maximumTailDelay.delayMode.store(0.0f);
    maximumTailDelay.ducking.store(0.0f);
    maximumTailDelay.setPlayHead(&maximumTailHead);
    maximumTailDelay.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    juce::AudioBuffer<float> maximumTailBlock(
        2, fixtureBlockSize);
    maximumTailBlock.clear();
    maximumTailBlock.setSample(0, 0, 1.0f);
    maximumTailBlock.setSample(1, 0, -1.0f);
    maximumTailDelay.processBlock(maximumTailBlock, midi);
    const double maximumTailIntervals =
        std::log(0.001 / 2.0) / std::log(0.95) + 1.0;
    const double maximumTailExpectedBound =
        (24.0 + 1.0 / fixtureSampleRate)
        * maximumTailIntervals;
    const double maximumTailPublishedBound =
        static_cast<double>(
            maximumTailDelay.publishedLiveTailSeconds.load(
                std::memory_order_relaxed));
    maximumTailDelay.tempoSync.store(0.0f);
    maximumTailDelay.delayTimeL.store(1.0f);
    maximumTailDelay.delayTimeR.store(1.0f);
    maximumTailDelay.feedback.store(0.0f);
    maximumTailDelay.mix.store(0.0f);
    maximumTailDelay.stereoWidth.store(1.0f);
    const double maximumTailPreservedAfterDownwardEdit =
        maximumTailDelay.getTailLengthSeconds();
    const bool maximumCapacityTailPassed =
        maximumTailPublishedBound > 300.0
        && maximumTailPublishedBound + 0.01
            >= maximumTailExpectedBound
        && maximumTailPreservedAfterDownwardEdit + 0.01
            >= maximumTailExpectedBound;

    auto* value = new juce::DynamicObject();
    value->setProperty(
        "standalonePlayHeadCallsAfterPrepare",
        callsAfterPrepare);
    value->setProperty(
        "standalonePlayHeadCallsAfterProcess",
        callsAfterProcess);
    value->setProperty(
        "standaloneUnknownTempoTailSeconds",
        conservativeUnknownTail);
    value->setProperty(
        "standalonePublishedTempoTailSeconds",
        publishedTempoTail);
    value->setProperty(
        "standaloneTenBpmPublishedTailSeconds",
        tenBpmPublishedTail);
    value->setProperty(
        "standaloneStaleTempoPreCallbackTailSeconds",
        staleTempoPreCallbackTail);
    value->setProperty(
        "standaloneHostResetPreCallbackTailSeconds",
        hostResetPreCallbackTail);
    value->setProperty(
        "standaloneSnappedSamplesAt60",
        standaloneSnappedSamplesAt60);
    value->setProperty(
        "standaloneSnappedSamplesAt10",
        standaloneSnappedSamplesAt10);
    value->setProperty(
        "standaloneLifecyclePassed",
        standaloneLifecyclePassed);
    value->setProperty(
        "rackPlayHeadCallsAfterPrepare",
        rackCallsAfterPrepare);
    value->setProperty(
        "rackPlayHeadCallsAfterProcess",
        rackCallsAfterProcess);
    value->setProperty(
        "rackUnknownTempoTailSeconds", rackUnknownTail);
    value->setProperty(
        "rackPublishedTempoTailSeconds", rackPublishedTail);
    value->setProperty(
        "rackTenBpmPublishedTailSeconds",
        rackTenBpmPublishedTail);
    value->setProperty(
        "rackStaleTempoPreCallbackTailSeconds",
        rackStaleTempoPreCallbackTail);
    value->setProperty(
        "rackSnappedSamplesAt60",
        rackSnappedSamplesAt60);
    value->setProperty(
        "rackSnappedSamplesAt10",
        rackSnappedSamplesAt10);
    value->setProperty(
        "maximumAutomatedDelayTailSeconds",
        maximumAutomatedDelayTail);
    value->setProperty(
        "actualQuarterTailAtTenBpmSeconds",
        actualQuarterTailAtTenBpm);
    value->setProperty(
        "rackLifecyclePassed", rackLifecyclePassed);
    value->setProperty(
        "maximumTailExpectedBoundSeconds",
        maximumTailExpectedBound);
    value->setProperty(
        "maximumTailPublishedBoundSeconds",
        maximumTailPublishedBound);
    value->setProperty(
        "maximumTailPreservedAfterDownwardEditSeconds",
        maximumTailPreservedAfterDownwardEdit);
    value->setProperty(
        "maximumCapacityTailPassed",
        maximumCapacityTailPassed);
    value->setProperty(
        "pass",
        standaloneLifecyclePassed
            && rackLifecyclePassed
            && maximumCapacityTailPassed);
    return juce::var(value);
}

juce::var NAMDelayRegression::runDelayTailLifecycleProbe()
{
    const int delaySamples =
        juce::roundToInt(fixtureSampleRate * 0.25);
    const int renderedSamples = delaySamples + 2048;

    auto configureDelay = [] (S13Delay& delay)
    {
        delay.delayTimeL.store(250.0f);
        delay.delayTimeR.store(250.0f);
        delay.feedback.store(0.0f);
        delay.crossFeed.store(0.0f);
        delay.mix.store(1.0f);
        delay.pingPong.store(0.0f);
        delay.tempoSync.store(0.0f);
        delay.lpfFreq.store(20000.0f);
        delay.hpfFreq.store(20.0f);
        delay.fbSaturation.store(0.0f);
        delay.stereoWidth.store(1.0f);
        delay.delayMode.store(0.0f);
        delay.ducking.store(0.0f);
    };

    auto renderSilenceAfterImpulse = [&] (
        S13Delay& delay,
        bool resetAfterWriting,
        bool preserveUnityDry)
    {
        juce::AudioBuffer<float> capture(2, renderedSamples);
        capture.clear();
        juce::MidiBuffer midi;
        int cursor = 0;

        juce::AudioBuffer<float> firstBlock(2, fixtureBlockSize);
        firstBlock.clear();
        firstBlock.setSample(0, 0, 0.75f);
        firstBlock.setSample(1, 0, -0.50f);
        delay.processBlock(firstBlock, midi);
        capture.copyFrom(
            0, 0, firstBlock, 0, 0, fixtureBlockSize);
        capture.copyFrom(
            1, 0, firstBlock, 1, 0, fixtureBlockSize);
        cursor += fixtureBlockSize;

        if (resetAfterWriting)
            delay.resetTailState();
        delay.inputSend.store(0.0f);
        delay.unityDry.store(preserveUnityDry ? 1.0f : 0.0f);

        while (cursor < renderedSamples)
        {
            const int blockSize = juce::jmin(
                fixtureBlockSize, renderedSamples - cursor);
            juce::AudioBuffer<float> block(2, blockSize);
            block.clear();
            delay.processBlock(block, midi);
            capture.copyFrom(0, cursor, block, 0, 0, blockSize);
            capture.copyFrom(1, cursor, block, 1, 0, blockSize);
            cursor += blockSize;
        }
        return capture;
    };

    S13Delay noSendDelay(1.0f);
    configureDelay(noSendDelay);
    noSendDelay.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    noSendDelay.inputSend.store(0.0f);
    noSendDelay.unityDry.store(1.0f);
    const auto noSendCapture =
        renderSilenceAfterImpulse(noSendDelay, false, true);
    float noSendEchoPeak = 0.0f;
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = delaySamples - 8;
             sample <= delaySamples + 8;
             ++sample)
            noSendEchoPeak = juce::jmax(
                noSendEchoPeak,
                std::abs(noSendCapture.getSample(channel, sample)));

    S13Delay resetDelay(1.0f);
    configureDelay(resetDelay);
    resetDelay.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    resetDelay.inputSend.store(1.0f);
    resetDelay.unityDry.store(0.0f);
    const auto resetCapture =
        renderSilenceAfterImpulse(resetDelay, true, false);
    float resetLeakPeak = 0.0f;
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = fixtureBlockSize;
             sample < resetCapture.getNumSamples();
             ++sample)
            resetLeakPeak = juce::jmax(
                resetLeakPeak,
                std::abs(resetCapture.getSample(channel, sample)));

    auto* value = new juce::DynamicObject();
    value->setProperty("delaySamples", delaySamples);
    value->setProperty("inputSendZeroEchoPeak", noSendEchoPeak);
    value->setProperty("resetStaleHistoryPeak", resetLeakPeak);
    value->setProperty(
        "pass",
        noSendEchoPeak <= 1.0e-7f
            && resetLeakPeak <= 1.0e-7f);
    return juce::var(value);
}

juce::var NAMDelayRegression::runDelayHighFeedbackDecayProbe()
{
    constexpr double delaySampleRate = 44100.0;
    constexpr int delayBlockSize = 16;
    constexpr int stimulusBlocks = 1378;
    constexpr int tailWindowBlocks = 1378;
    constexpr int tailWindowCount = 8;
    constexpr int stimulusSamples =
        stimulusBlocks * delayBlockSize;
    constexpr int tailWindowSamples =
        tailWindowBlocks * delayBlockSize;
    constexpr int totalBlocks =
        stimulusBlocks
        + tailWindowBlocks * tailWindowCount;
    constexpr float feedbackAmount = 0.85f;
    constexpr float characterAmount = 1.0f;
    constexpr float maximumAcceptedPeak = 2.0f;
    constexpr double maximumWindowGrowth = 1.15;
    constexpr double maximumFinalToFirstRms = 0.10;
    const int strumIntervalSamples =
        juce::roundToInt(delaySampleRate * 0.075);

    auto runMode = [&] (int mode)
    {
        S13Delay delay(1.0f);
        delay.setExtendedModesEnabled(true);
        const auto state =
            S13NAMRack::resolveDelayMacroState(
                37.0f,
                feedbackAmount,
                1.0f,
                characterAmount,
                0.0f,
                static_cast<float>(mode),
                1.0f,
                0.0f,
                S13NAMRack::guitarInstrumentProfile);
        delay.delayTimeL.store(
            state.timeMsL, std::memory_order_relaxed);
        delay.delayTimeR.store(
            state.timeMsR,
            std::memory_order_relaxed);
        delay.feedback.store(
            state.feedbackGain,
            std::memory_order_relaxed);
        delay.crossFeed.store(
            state.crossFeed, std::memory_order_relaxed);
        delay.mix.store(
            1.0f, std::memory_order_relaxed);
        delay.pingPong.store(
            1.0f, std::memory_order_relaxed);
        delay.tempoSync.store(
            0.0f, std::memory_order_relaxed);
        delay.lpfFreq.store(
            state.lowPassHz,
            std::memory_order_relaxed);
        delay.hpfFreq.store(
            state.highPassHz, std::memory_order_relaxed);
        delay.fbSaturation.store(
            state.saturation,
            std::memory_order_relaxed);
        delay.stereoWidth.store(
            state.stereoWidth, std::memory_order_relaxed);
        delay.delayMode.store(
            static_cast<float>(mode),
            std::memory_order_relaxed);
        delay.ducking.store(
            0.0f, std::memory_order_relaxed);
        delay.wowDepthMs.store(
            state.wowDepthMs, std::memory_order_relaxed);
        delay.wowRateHz.store(
            state.wowRateHz, std::memory_order_relaxed);
        delay.flutterDepthMs.store(
            state.flutterDepthMs, std::memory_order_relaxed);
        delay.flutterRateHz.store(
            state.flutterRateHz, std::memory_order_relaxed);
        delay.duckAttackMs.store(
            state.duckAttackMs, std::memory_order_relaxed);
        delay.duckReleaseMs.store(
            state.duckReleaseMs, std::memory_order_relaxed);
        delay.duckMaxReduction.store(
            state.duckMaxReduction, std::memory_order_relaxed);
        delay.topologyControl.store(
            state.topologyControl, std::memory_order_relaxed);
        delay.multiFeedback.store(
            state.multiFeedbackGain, std::memory_order_relaxed);
        delay.dualTimeRatio.store(
            state.dualTimeRatio, std::memory_order_relaxed);
        delay.dualFeedback.store(
            state.dualFeedbackGain, std::memory_order_relaxed);
        delay.dualLowPassHz.store(
            state.dualLowPassHz, std::memory_order_relaxed);
        delay.dualHighPassHz.store(
            state.dualHighPassHz, std::memory_order_relaxed);
        delay.dualSaturation.store(
            state.dualSaturation, std::memory_order_relaxed);
        delay.dualModDepthMs.store(
            state.dualModDepthMs, std::memory_order_relaxed);
        delay.dualModRateHz.store(
            state.dualModRateHz, std::memory_order_relaxed);
        delay.prepareToPlay(
            delaySampleRate, delayBlockSize);
        delay.inputSend.store(
            1.0f, std::memory_order_relaxed);
        delay.unityDry.store(
            0.0f, std::memory_order_relaxed);

        std::array<double, 8>
            tailEnergy {};
        std::array<int, 8>
            tailValueCounts {};
        float inputPeak = 0.0f;
        float outputPeak = 0.0f;
        int nonFiniteCount = 0;
        juce::AudioBuffer<float> block(
            2, delayBlockSize);
        juce::MidiBuffer midi;

        for (int blockIndex = 0;
             blockIndex < totalBlocks;
             ++blockIndex)
        {
            block.clear();
            for (int sample = 0;
                 sample < delayBlockSize;
                 ++sample)
            {
                const int absoluteSample =
                    blockIndex * delayBlockSize
                    + sample;
                if (absoluteSample >= stimulusSamples)
                    continue;

                const int strumSample =
                    absoluteSample
                    % strumIntervalSamples;
                const int strumIndex =
                    absoluteSample
                    / strumIntervalSamples;
                const double localTime =
                    static_cast<double>(strumSample)
                    / delaySampleRate;
                const float envelope =
                    static_cast<float>(
                        std::exp(-localTime / 0.018));
                const double phase =
                    juce::MathConstants<double>::twoPi
                    * localTime;
                const float polarity =
                    (strumIndex & 1) == 0
                        ? 1.0f
                        : -1.0f;
                const float attack =
                    strumSample == 0
                        ? 0.34f * polarity
                        : 0.0f;
                const float left =
                    attack
                    + envelope
                        * static_cast<float>(
                            0.16
                                * std::sin(
                                    phase * 110.0)
                            + 0.10
                                * std::sin(
                                    phase * 329.63
                                    + 0.31)
                            + 0.06
                                * std::sin(
                                    phase * 987.77
                                    + 1.12));
                const float right =
                    -attack * 0.72f
                    + envelope
                        * static_cast<float>(
                            0.13
                                * std::sin(
                                    phase * 146.83
                                    + 0.73)
                            + 0.09
                                * std::sin(
                                    phase * 440.0
                                    + 1.41)
                            + 0.05
                                * std::sin(
                                    phase * 1318.51
                                    + 2.07));
                block.setSample(0, sample, left);
                block.setSample(1, sample, right);
                inputPeak = juce::jmax(
                    inputPeak,
                    juce::jmax(
                        std::abs(left),
                        std::abs(right)));
            }

            delay.processBlock(block, midi);
            for (int channel = 0;
                 channel < 2;
                 ++channel)
            {
                const auto* samples =
                    block.getReadPointer(channel);
                for (int sample = 0;
                     sample < delayBlockSize;
                     ++sample)
                {
                    const float value = samples[sample];
                    if (! std::isfinite(value))
                    {
                        ++nonFiniteCount;
                        continue;
                    }

                    outputPeak = juce::jmax(
                        outputPeak,
                        std::abs(value));
                    const int absoluteSample =
                        blockIndex * delayBlockSize
                        + sample;
                    if (absoluteSample
                        < stimulusSamples)
                    {
                        continue;
                    }

                    const int windowIndex =
                        (absoluteSample
                         - stimulusSamples)
                        / tailWindowSamples;
                    if (windowIndex
                        < tailWindowCount)
                    {
                        tailEnergy[
                            static_cast<size_t>(
                                windowIndex)]
                            += static_cast<double>(
                                   value)
                                * static_cast<double>(
                                    value);
                        ++tailValueCounts[
                            static_cast<size_t>(
                                windowIndex)];
                    }
                }
            }
        }

        std::array<double, 8>
            tailRms {};
        juce::Array<juce::var> tailWindowRms;
        for (size_t windowIndex = 0;
             windowIndex < tailRms.size();
             ++windowIndex)
        {
            const int valueCount =
                tailValueCounts[windowIndex];
            tailRms[windowIndex] =
                valueCount > 0
                    ? std::sqrt(
                        tailEnergy[windowIndex]
                        / static_cast<double>(
                            valueCount))
                    : 0.0;
            tailWindowRms.add(
                tailRms[windowIndex]);
        }

        bool nonGrowingDecay = true;
        for (size_t windowIndex = 1;
             windowIndex < tailRms.size();
             ++windowIndex)
        {
            const double allowedRms =
                tailRms[windowIndex - 1]
                    * maximumWindowGrowth
                + 1.0e-8;
            if (tailRms[windowIndex]
                > allowedRms)
            {
                nonGrowingDecay = false;
            }
        }

        const double firstTailRms =
            tailRms.front();
        const double finalTailRms =
            tailRms.back();
        const double finalToFirstRms =
            firstTailRms > 0.0
                ? finalTailRms
                    / firstTailRms
                : std::numeric_limits<
                      double>::infinity();
        const bool pass =
            nonFiniteCount == 0
            && inputPeak > 0.1f
            && outputPeak <= maximumAcceptedPeak
            && firstTailRms > 1.0e-5
            && nonGrowingDecay
            && finalToFirstRms
                <= maximumFinalToFirstRms
            && finalTailRms <= 1.0e-4;

        auto* value =
            new juce::DynamicObject();
        value->setProperty(
            "mode",
            mode == S13NAMRack::digitalDelayMode
                ? "Digital"
                : mode == S13NAMRack::tapeDelayMode
                    ? "Tape"
                    : mode == S13NAMRack::analogDelayMode
                        ? "Analog"
                        : mode == S13NAMRack::multiDelayMode
                            ? "Multi"
                            : "Dual");
        value->setProperty(
            "feedback", feedbackAmount);
        value->setProperty(
            "characterControl",
            characterAmount);
        value->setProperty(
            "inputPeak", inputPeak);
        value->setProperty(
            "outputPeak", outputPeak);
        value->setProperty(
            "maximumAcceptedPeak",
            maximumAcceptedPeak);
        value->setProperty(
            "tailWindowRms", tailWindowRms);
        value->setProperty(
            "finalToFirstTailRms",
            finalToFirstRms);
        value->setProperty(
            "nonGrowingDecay",
            nonGrowingDecay);
        value->setProperty(
            "nonFiniteCount",
            nonFiniteCount);
        value->setProperty("pass", pass);
        return juce::var(value);
    };

    juce::Array<juce::var> cases;
    bool allPass = true;
    for (int mode = S13NAMRack::digitalDelayMode;
         mode <= S13NAMRack::dualDelayMode;
         ++mode)
    {
        const auto result = runMode(mode);
        allPass =
            allPass
            && static_cast<bool>(
                result.getProperty(
                    "pass", false));
        cases.add(result);
    }

    auto* value = new juce::DynamicObject();
    value->setProperty(
        "sampleRate", delaySampleRate);
    value->setProperty(
        "blockSize", delayBlockSize);
    value->setProperty(
        "stimulusSeconds",
        static_cast<double>(stimulusSamples)
            / delaySampleRate);
    value->setProperty(
        "silenceSeconds",
        static_cast<double>(
            tailWindowSamples
            * tailWindowCount)
            / delaySampleRate);
    value->setProperty(
        "cases", cases);
    value->setProperty("pass", allPass);
    return juce::var(value);
}

juce::var NAMDelayRegression::runDelayFractionalResetProbe()
{
    constexpr double delaySampleRate = 44100.0;
    constexpr int delayBlockSize = 16;
    constexpr float requestedDelaySamples = 44.5f;
    constexpr float historyMarker = 0.75f;
    constexpr int prefillBlocks = 8;
    constexpr int observationBlocks = 8;
    const float delayMs =
        requestedDelaySamples
        * 1000.0f
        / static_cast<float>(
            delaySampleRate);
    const int floorHistorySamples =
        static_cast<int>(
            std::floor(requestedDelaySamples));
    const int requiredHistorySamples =
        static_cast<int>(
            std::ceil(requestedDelaySamples));

    S13Delay delay(0.1f);
    delay.delayTimeL.store(
        delayMs, std::memory_order_relaxed);
    delay.delayTimeR.store(
        delayMs, std::memory_order_relaxed);
    delay.feedback.store(
        0.0f, std::memory_order_relaxed);
    delay.crossFeed.store(
        0.0f, std::memory_order_relaxed);
    delay.mix.store(
        1.0f, std::memory_order_relaxed);
    delay.pingPong.store(
        0.0f, std::memory_order_relaxed);
    delay.tempoSync.store(
        0.0f, std::memory_order_relaxed);
    delay.lpfFreq.store(
        20000.0f, std::memory_order_relaxed);
    delay.hpfFreq.store(
        20.0f, std::memory_order_relaxed);
    delay.fbSaturation.store(
        0.0f, std::memory_order_relaxed);
    delay.stereoWidth.store(
        1.0f, std::memory_order_relaxed);
    delay.delayMode.store(
        0.0f, std::memory_order_relaxed);
    delay.ducking.store(
        0.0f, std::memory_order_relaxed);
    delay.prepareToPlay(
        delaySampleRate, delayBlockSize);
    delay.inputSend.store(
        1.0f, std::memory_order_relaxed);
    delay.unityDry.store(
        0.0f, std::memory_order_relaxed);

    juce::AudioBuffer<float> block(
        2, delayBlockSize);
    juce::MidiBuffer midi;
    for (int blockIndex = 0;
         blockIndex < prefillBlocks;
         ++blockIndex)
    {
        for (int sample = 0;
             sample < delayBlockSize;
             ++sample)
        {
            block.setSample(
                0, sample, historyMarker);
            block.setSample(
                1, sample,
                -historyMarker * 0.8f);
        }
        delay.processBlock(block, midi);
    }

    delay.inputSend.store(
        0.0f, std::memory_order_relaxed);
    delay.unityDry.store(
        0.0f, std::memory_order_relaxed);
    delay.resetTailState();

    float staleHistoryPeak = 0.0f;
    int peakSample = -1;
    int nonFiniteCount = 0;
    for (int blockIndex = 0;
         blockIndex < observationBlocks;
         ++blockIndex)
    {
        block.clear();
        delay.processBlock(block, midi);
        for (int channel = 0;
             channel < 2;
             ++channel)
        {
            const auto* samples =
                block.getReadPointer(channel);
            for (int sample = 0;
                 sample < delayBlockSize;
                 ++sample)
            {
                const float value = samples[sample];
                if (! std::isfinite(value))
                {
                    ++nonFiniteCount;
                    continue;
                }

                const float magnitude =
                    std::abs(value);
                if (magnitude
                    > staleHistoryPeak)
                {
                    staleHistoryPeak =
                        magnitude;
                    peakSample =
                        blockIndex
                            * delayBlockSize
                        + sample;
                }
            }
        }
    }

    const bool pass =
        floorHistorySamples
                < requiredHistorySamples
        && nonFiniteCount == 0
        && staleHistoryPeak <= 1.0e-7f;
    auto* value = new juce::DynamicObject();
    value->setProperty(
        "sampleRate", delaySampleRate);
    value->setProperty(
        "blockSize", delayBlockSize);
    value->setProperty(
        "requestedDelaySamples",
        requestedDelaySamples);
    value->setProperty(
        "floorHistorySamples",
        floorHistorySamples);
    value->setProperty(
        "requiredHistorySamples",
        requiredHistorySamples);
    value->setProperty(
        "prefillSamples",
        prefillBlocks * delayBlockSize);
    value->setProperty(
        "observationSamples",
        observationBlocks
            * delayBlockSize);
    value->setProperty(
        "staleHistoryPeak",
        staleHistoryPeak);
    value->setProperty(
        "peakSample", peakSample);
    value->setProperty(
        "nonFiniteCount",
        nonFiniteCount);
    value->setProperty("pass", pass);
    return juce::var(value);
}

juce::var NAMDelayRegression::runStandaloneDelayMalformedAndLegacyModeProbe()
{
    const double quietNaN =
        std::numeric_limits<double>::quiet_NaN();
    const double positiveInfinity =
        std::numeric_limits<double>::infinity();
    const double negativeInfinity =
        -std::numeric_limits<double>::infinity();
    juce::ValueTree malformedTree("S13Delay");
    malformedTree.setProperty("delayTimeL", quietNaN, nullptr);
    malformedTree.setProperty("delayTimeR", positiveInfinity, nullptr);
    malformedTree.setProperty("feedback", negativeInfinity, nullptr);
    malformedTree.setProperty("crossFeed", quietNaN, nullptr);
    malformedTree.setProperty("mix", positiveInfinity, nullptr);
    malformedTree.setProperty("pingPong", quietNaN, nullptr);
    malformedTree.setProperty("tempoSync", 1.0, nullptr);
    malformedTree.setProperty("syncNoteL", quietNaN, nullptr);
    malformedTree.setProperty("syncNoteR", positiveInfinity, nullptr);
    malformedTree.setProperty("lpfFreq", quietNaN, nullptr);
    malformedTree.setProperty("hpfFreq", negativeInfinity, nullptr);
    malformedTree.setProperty("fbSaturation", positiveInfinity, nullptr);
    malformedTree.setProperty("stereoWidth", quietNaN, nullptr);
    malformedTree.setProperty("delayMode", quietNaN, nullptr);
    malformedTree.setProperty("ducking", positiveInfinity, nullptr);
    juce::MemoryBlock malformedState;
    {
        juce::MemoryOutputStream stream(malformedState, false);
        malformedTree.writeToStream(stream);
    }

    S13Delay malformedDelay(3.0f);
    malformedDelay.setStateInformation(
        malformedState.getData(),
        static_cast<int>(malformedState.getSize()));
    const auto finiteAtomic = [] (
        const std::atomic<float>& value)
    {
        return std::isfinite(
            value.load(std::memory_order_relaxed));
    };
    const bool restoredStateSanitized =
        finiteAtomic(malformedDelay.delayTimeL)
        && finiteAtomic(malformedDelay.delayTimeR)
        && finiteAtomic(malformedDelay.feedback)
        && finiteAtomic(malformedDelay.crossFeed)
        && finiteAtomic(malformedDelay.mix)
        && finiteAtomic(malformedDelay.pingPong)
        && finiteAtomic(malformedDelay.tempoSync)
        && finiteAtomic(malformedDelay.syncNoteL)
        && finiteAtomic(malformedDelay.syncNoteR)
        && finiteAtomic(malformedDelay.lpfFreq)
        && finiteAtomic(malformedDelay.hpfFreq)
        && finiteAtomic(malformedDelay.fbSaturation)
        && finiteAtomic(malformedDelay.stereoWidth)
        && finiteAtomic(malformedDelay.delayMode)
        && finiteAtomic(malformedDelay.ducking)
        && std::abs(malformedDelay.delayMode.load()) <= 1.0e-7f
        && std::abs(malformedDelay.syncNoteL.load()) <= 1.0e-7f
        && std::abs(malformedDelay.syncNoteR.load()) <= 1.0e-7f
        && malformedDelay.tempoSync.load() >= 0.5f;

    const float floatNaN =
        std::numeric_limits<float>::quiet_NaN();
    const float floatInfinity =
        std::numeric_limits<float>::infinity();
    malformedDelay.wowDepthMs.store(floatNaN);
    malformedDelay.wowRateHz.store(floatInfinity);
    malformedDelay.flutterDepthMs.store(floatNaN);
    malformedDelay.flutterRateHz.store(floatInfinity);
    malformedDelay.duckAttackMs.store(floatNaN);
    malformedDelay.duckReleaseMs.store(floatInfinity);
    malformedDelay.duckMaxReduction.store(floatNaN);
    malformedDelay.topologyControl.store(floatInfinity);
    malformedDelay.multiFeedback.store(floatNaN);
    malformedDelay.dualTimeRatio.store(floatInfinity);
    malformedDelay.dualFeedback.store(floatNaN);
    malformedDelay.dualLowPassHz.store(floatInfinity);
    malformedDelay.dualHighPassHz.store(floatNaN);
    malformedDelay.dualSaturation.store(floatInfinity);
    malformedDelay.dualModDepthMs.store(floatNaN);
    malformedDelay.dualModRateHz.store(floatInfinity);
    constexpr double malformedSampleRate = 48000.0;
    constexpr int malformedBlockSize = 64;
    malformedDelay.prepareToPlay(
        malformedSampleRate, malformedBlockSize);

    // Re-poison every callback-visible group after prepare so processBlock,
    // tail reporting, and state export each prove their own sanitization.
    malformedDelay.delayTimeL.store(floatNaN);
    malformedDelay.delayTimeR.store(floatInfinity);
    malformedDelay.feedback.store(floatNaN);
    malformedDelay.crossFeed.store(floatInfinity);
    malformedDelay.mix.store(floatNaN);
    malformedDelay.pingPong.store(floatInfinity);
    malformedDelay.tempoSync.store(1.0f);
    malformedDelay.syncNoteL.store(floatNaN);
    malformedDelay.syncNoteR.store(floatInfinity);
    malformedDelay.lpfFreq.store(floatNaN);
    malformedDelay.hpfFreq.store(floatInfinity);
    malformedDelay.fbSaturation.store(floatNaN);
    malformedDelay.stereoWidth.store(floatInfinity);
    malformedDelay.delayMode.store(floatNaN);
    malformedDelay.ducking.store(floatInfinity);
    malformedDelay.wowDepthMs.store(floatNaN);
    malformedDelay.wowRateHz.store(floatInfinity);
    malformedDelay.flutterDepthMs.store(floatNaN);
    malformedDelay.flutterRateHz.store(floatInfinity);
    malformedDelay.duckAttackMs.store(floatNaN);
    malformedDelay.duckReleaseMs.store(floatInfinity);
    malformedDelay.duckMaxReduction.store(floatNaN);
    malformedDelay.topologyControl.store(floatInfinity);
    malformedDelay.multiFeedback.store(floatNaN);
    malformedDelay.dualTimeRatio.store(floatInfinity);
    malformedDelay.dualFeedback.store(floatNaN);
    malformedDelay.dualLowPassHz.store(floatInfinity);
    malformedDelay.dualHighPassHz.store(floatNaN);
    malformedDelay.dualSaturation.store(floatInfinity);
    malformedDelay.dualModDepthMs.store(floatNaN);
    malformedDelay.dualModRateHz.store(floatInfinity);
    malformedDelay.inputSend.store(floatNaN);
    malformedDelay.unityDry.store(floatInfinity);

    constexpr int malformedRenderSamples = 101376;
    int malformedNonFiniteCount = 0;
    float malformedOutputPeak = 0.0f;
    juce::MidiBuffer malformedMidi;
    int malformedCursor = 0;
    while (malformedCursor < malformedRenderSamples)
    {
        const int blockSamples = juce::jmin(
            malformedBlockSize,
            malformedRenderSamples - malformedCursor);
        juce::AudioBuffer<float> block(2, blockSamples);
        for (int sample = 0; sample < blockSamples; ++sample)
        {
            const int absoluteSample = malformedCursor + sample;
            const float input =
                (absoluteSample == 0 ? 0.40f : 0.0f)
                + 0.03f * static_cast<float>(std::sin(
                    juce::MathConstants<double>::twoPi
                    * 173.0
                    * static_cast<double>(absoluteSample)
                    / malformedSampleRate));
            block.setSample(0, sample, input);
            block.setSample(1, sample, -input * 0.71f);
        }
        malformedDelay.processBlock(block, malformedMidi);
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int sample = 0; sample < blockSamples; ++sample)
            {
                const float output = block.getSample(channel, sample);
                if (! std::isfinite(output))
                    ++malformedNonFiniteCount;
                else
                    malformedOutputPeak = juce::jmax(
                        malformedOutputPeak,
                        std::abs(output));
            }
        }
        malformedCursor += blockSamples;
    }
    const double malformedTailSeconds =
        malformedDelay.getTailLengthSeconds();
    juce::MemoryBlock sanitizedState;
    malformedDelay.getStateInformation(sanitizedState);
    const auto sanitizedTree = juce::ValueTree::readFromData(
        sanitizedState.getData(), sanitizedState.getSize());
    bool exportedStateFinite = sanitizedTree.isValid();
    if (sanitizedTree.isValid())
    {
        for (int propertyIndex = 0;
             propertyIndex < sanitizedTree.getNumProperties();
             ++propertyIndex)
        {
            exportedStateFinite = exportedStateFinite
                && std::isfinite(static_cast<double>(
                    sanitizedTree.getProperty(
                        sanitizedTree.getPropertyName(propertyIndex))));
        }
    }
    const bool malformedRuntimePassed =
        restoredStateSanitized
        && malformedNonFiniteCount == 0
        && malformedOutputPeak <= 2.0f
        && std::isfinite(malformedTailSeconds)
        && malformedTailSeconds > 0.0
        && malformedTailSeconds <= 60.0
        && exportedStateFinite
        && std::abs(static_cast<double>(
               sanitizedTree.getProperty("delayMode", -1.0)))
            <= 1.0e-7;

    const auto makeLegacyModeState = [] (float mode)
    {
        juce::ValueTree tree("S13Delay");
        tree.setProperty("delayTimeL", 37.0, nullptr);
        tree.setProperty("delayTimeR", 37.0, nullptr);
        tree.setProperty("feedback", 0.55, nullptr);
        tree.setProperty("crossFeed", 0.0, nullptr);
        tree.setProperty("mix", 1.0, nullptr);
        tree.setProperty("pingPong", 0.0, nullptr);
        tree.setProperty("tempoSync", 0.0, nullptr);
        tree.setProperty("syncNoteL", 2.0, nullptr);
        tree.setProperty("syncNoteR", 2.0, nullptr);
        tree.setProperty("lpfFreq", 9200.0, nullptr);
        tree.setProperty("hpfFreq", 75.0, nullptr);
        tree.setProperty("fbSaturation", 0.40, nullptr);
        tree.setProperty("stereoWidth", 1.0, nullptr);
        tree.setProperty("delayMode", mode, nullptr);
        tree.setProperty("ducking", 0.0, nullptr);
        juce::MemoryBlock state;
        {
            juce::MemoryOutputStream stream(state, false);
            tree.writeToStream(stream);
        }
        return state;
    };
    const auto renderLegacyMode = [&makeLegacyModeState] (float mode)
    {
        constexpr double sampleRate = 48000.0;
        constexpr int blockSize = 64;
        constexpr int totalSamples = 48000;
        S13Delay delay(1.0f);
        const auto state = makeLegacyModeState(mode);
        delay.setStateInformation(
            state.getData(), static_cast<int>(state.getSize()));
        delay.prepareToPlay(sampleRate, blockSize);
        juce::AudioBuffer<float> capture(2, totalSamples);
        capture.clear();
        juce::MidiBuffer midi;
        int cursor = 0;
        while (cursor < totalSamples)
        {
            const int blockSamples = juce::jmin(
                blockSize, totalSamples - cursor);
            juce::AudioBuffer<float> block(2, blockSamples);
            for (int sample = 0; sample < blockSamples; ++sample)
            {
                const int absoluteSample = cursor + sample;
                const float marker = absoluteSample % 997 == 0
                    ? 0.30f
                    : 0.0f;
                const double time =
                    static_cast<double>(absoluteSample) / sampleRate;
                block.setSample(
                    0,
                    sample,
                    marker
                        + 0.07f * static_cast<float>(std::sin(
                            juce::MathConstants<double>::twoPi
                            * 211.0 * time)));
                block.setSample(
                    1,
                    sample,
                    -marker * 0.61f
                        + 0.06f * static_cast<float>(std::sin(
                            juce::MathConstants<double>::twoPi
                            * 337.0 * time + 0.37)));
            }
            delay.processBlock(block, midi);
            capture.copyFrom(
                0, cursor, block, 0, 0, blockSamples);
            capture.copyFrom(
                1, cursor, block, 1, 0, blockSamples);
            cursor += blockSamples;
        }
        return capture;
    };

    S13Delay legacyFractionalStateDelay(1.0f);
    const auto legacyFractionalState =
        makeLegacyModeState(1.9f);
    legacyFractionalStateDelay.setStateInformation(
        legacyFractionalState.getData(),
        static_cast<int>(legacyFractionalState.getSize()));
    juce::MemoryBlock legacyFractionalSavedState;
    legacyFractionalStateDelay.getStateInformation(
        legacyFractionalSavedState);
    const auto legacyFractionalSavedTree =
        juce::ValueTree::readFromData(
            legacyFractionalSavedState.getData(),
            legacyFractionalSavedState.getSize());
    const auto fractionalCapture = renderLegacyMode(1.9f);
    const auto tapeCapture = renderLegacyMode(1.0f);
    const auto analogCapture = renderLegacyMode(2.0f);
    float fractionalTapeMaximumDifference = 0.0f;
    double fractionalAnalogDifferenceEnergy = 0.0;
    int fractionalAnalogValueCount = 0;
    for (int channel = 0; channel < 2; ++channel)
    {
        for (int sample = 0;
             sample < fractionalCapture.getNumSamples();
             ++sample)
        {
            fractionalTapeMaximumDifference = juce::jmax(
                fractionalTapeMaximumDifference,
                std::abs(
                    fractionalCapture.getSample(channel, sample)
                    - tapeCapture.getSample(channel, sample)));
            const double difference = static_cast<double>(
                fractionalCapture.getSample(channel, sample))
                - static_cast<double>(
                    analogCapture.getSample(channel, sample));
            fractionalAnalogDifferenceEnergy +=
                difference * difference;
            ++fractionalAnalogValueCount;
        }
    }
    const double fractionalAnalogDifferenceRms =
        fractionalAnalogValueCount > 0
            ? std::sqrt(
                fractionalAnalogDifferenceEnergy
                / static_cast<double>(fractionalAnalogValueCount))
            : 0.0;
    const bool legacyFractionalModePassed =
        std::abs(
            legacyFractionalStateDelay.delayMode.load() - 1.9f)
            <= 1.0e-6f
        && legacyFractionalSavedTree.isValid()
        && std::abs(static_cast<double>(
               legacyFractionalSavedTree.getProperty("delayMode"))
               - 1.9)
            <= 1.0e-6
        && fractionalTapeMaximumDifference <= 1.0e-7f
        && fractionalAnalogDifferenceRms > 1.0e-5;

    auto* value = new juce::DynamicObject();
    value->setProperty(
        "restoredMalformedStateSanitized",
        restoredStateSanitized);
    value->setProperty(
        "malformedNonFiniteCount",
        malformedNonFiniteCount);
    value->setProperty(
        "malformedOutputPeak", malformedOutputPeak);
    value->setProperty(
        "malformedTailSeconds", malformedTailSeconds);
    value->setProperty(
        "exportedMalformedStateFinite",
        exportedStateFinite);
    value->setProperty(
        "legacyFractionalSavedMode",
        legacyFractionalSavedTree.getProperty(
            "delayMode", -1.0));
    value->setProperty(
        "fractionalTapeMaximumDifference",
        fractionalTapeMaximumDifference);
    value->setProperty(
        "fractionalAnalogDifferenceRms",
        fractionalAnalogDifferenceRms);
    value->setProperty(
        "malformedRuntimePassed", malformedRuntimePassed);
    value->setProperty(
        "legacyFractionalModePassed",
        legacyFractionalModePassed);
    value->setProperty(
        "pass",
        malformedRuntimePassed && legacyFractionalModePassed);
    return juce::var(value);
}

juce::Array<juce::var> NAMDelayRegression::runLifecycleChecks()
{
    juce::Array<juce::var> checks;

    const auto delayPlayHeadLifecycleProbe =
        runDelayPlayHeadLifecycleProbe();
    addCheck(
        checks,
        "delay_playhead_access_is_callback_only_and_sync_head_snaps",
        delayPlayHeadLifecycleProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Delay and NAM Rack lifecycle/tail APIs must never query the host playhead. A valid BPM is published only by processBlock, unknown-tempo tail reporting is conservative, and the first empty-history callback must snap sync heads to the actual tempo before accepting its transient.",
        delayPlayHeadLifecycleProbe);
    const auto delayTailLifecycleProbe =
        runDelayTailLifecycleProbe();
    addCheck(
        checks,
        "delay_tail_input_send_and_reset_are_isolated",
        delayTailLifecycleProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Delay inputSend=0 must pass current dry input without recording a new echo, and resetTailState must prevent pre-reset ring contents from resurfacing.",
        delayTailLifecycleProbe);
    const auto delayHighFeedbackDecayProbe =
        runDelayHighFeedbackDecayProbe();
    addCheck(
        checks,
        "delay_high_feedback_character_decay_is_bounded",
        delayHighFeedbackDecayProbe.getProperty(
            "pass", false)
            ? "pass"
            : "fail",
        "At exact 44.1 kHz/16-sample callbacks, deterministic strums followed by silence must remain finite and bounded and decay without window-to-window growth in all five derived Digital, Tape, Analog, Multi, and Dual modes at maximum visible Feedback and Modulation.",
        delayHighFeedbackDecayProbe);
    const auto delayFractionalResetProbe =
        runDelayFractionalResetProbe();
    addCheck(
        checks,
        "delay_fractional_reset_requires_complete_interpolation_history",
        delayFractionalResetProbe.getProperty(
            "pass", false)
            ? "pass"
            : "fail",
        "After a logical reset, a 44.5-sample linear-interpolation tap must stay muted until both source samples are post-reset; using floor(delay) for the history gate would expose one stale pre-reset marker sample.",
        delayFractionalResetProbe);
    const auto standaloneDelayMalformedAndLegacyModeProbe =
        runStandaloneDelayMalformedAndLegacyModeProbe();
    addCheck(
        checks,
        "standalone_delay_malformed_state_and_legacy_fractional_mode",
        standaloneDelayMalformedAndLegacyModeProbe.getProperty(
            "pass", false)
            ? "pass"
            : "fail",
        "Standalone Delay must sanitize malformed persisted and live NaN/Inf parameters across prepare, tempo-sync processing, tail reporting and state export, while retaining the historical fractional-mode contract in which 1.9 remains serialized as 1.9 but processes exactly as truncated Tape rather than rounded Analog.",
        standaloneDelayMalformedAndLegacyModeProbe);

    return checks;
}
