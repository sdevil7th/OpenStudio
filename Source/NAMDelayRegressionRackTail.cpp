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

juce::var NAMDelayRegression::runRackDelaySpilloverProbe()
{
    S13NAMRack spillRack;
    S13NAMRack referenceRack;
    spillRack.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    referenceRack.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    configureNeutralRack(spillRack);
    configureNeutralRack(referenceRack);

    spillRack.delayEnabled.store(1.0f);
    spillRack.delayMix.store(0.8f);
    spillRack.delayTimeMs.store(20.0f);
    spillRack.delayFeedback.store(0.0f);
    spillRack.delayMod.store(0.0f);
    spillRack.delayDucker.store(0.0f);
    spillRack.delayMode.store(0.0f);
    spillRack.delayPingPong.store(0.0f);
    spillRack.delayTempoSync.store(0.0f);

    juce::MidiBuffer midi;
    for (int warmup = 0; warmup < 64; ++warmup)
    {
        juce::AudioBuffer<float> spillBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> referenceBlock(
            2, fixtureBlockSize);
        spillBlock.clear();
        referenceBlock.clear();
        spillRack.processBlock(spillBlock, midi);
        referenceRack.processBlock(referenceBlock, midi);
    }

    juce::AudioBuffer<float> spillImpulse(
        2, fixtureBlockSize);
    juce::AudioBuffer<float> referenceImpulse(
        2, fixtureBlockSize);
    spillImpulse.clear();
    referenceImpulse.clear();
    spillImpulse.setSample(0, 0, 0.65f);
    spillImpulse.setSample(1, 0, -0.45f);
    referenceImpulse.makeCopyOf(spillImpulse, true);
    spillRack.processBlock(spillImpulse, midi);
    referenceRack.processBlock(referenceImpulse, midi);
    spillRack.delayEnabled.store(0.0f);

    float spillPeak = 0.0f;
    float lateDifferencePeak = 0.0f;
    constexpr int bypassBlocks = 6;
    for (int blockIndex = 0;
         blockIndex < bypassBlocks;
         ++blockIndex)
    {
        juce::AudioBuffer<float> spillBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> referenceBlock(
            2, fixtureBlockSize);
        for (int sample = 0;
             sample < fixtureBlockSize;
             ++sample)
        {
            const int absoluteSample =
                blockIndex * fixtureBlockSize + sample;
            const float marker =
                0.03f * std::sin(
                    juce::MathConstants<float>::twoPi
                    * 617.0f
                    * static_cast<float>(absoluteSample)
                    / static_cast<float>(fixtureSampleRate));
            spillBlock.setSample(0, sample, marker);
            spillBlock.setSample(1, sample, -marker * 0.7f);
            referenceBlock.setSample(0, sample, marker);
            referenceBlock.setSample(1, sample, -marker * 0.7f);
        }

        spillRack.processBlock(spillBlock, midi);
        referenceRack.processBlock(referenceBlock, midi);
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int sample = 0;
                 sample < fixtureBlockSize;
                 ++sample)
            {
                const float difference = std::abs(
                    spillBlock.getSample(channel, sample)
                    - referenceBlock.getSample(channel, sample));
                if (blockIndex < 2)
                    spillPeak = juce::jmax(
                        spillPeak, difference);
                if (blockIndex >= 3)
                    lateDifferencePeak = juce::jmax(
                        lateDifferencePeak, difference);
            }
        }
    }

    auto* value = new juce::DynamicObject();
    value->setProperty("spillPeak", spillPeak);
    value->setProperty(
        "lateDifferencePeak", lateDifferencePeak);
    value->setProperty("bypassBlocks", bypassBlocks);
    value->setProperty(
        "pass",
        spillPeak > 1.0e-4f
            && lateDifferencePeak <= 1.0e-6f);
    return juce::var(value);
}

juce::var NAMDelayRegression::runRackDelayV10FrozenTailAndBudgetProbe()
{
    const auto configureFrozenDualRack = [&] (
        S13NAMRack& rack)
    {
        configureNeutralRack(rack);
        rack.instrumentProfile.store(
            static_cast<float>(
                S13NAMRack::guitarInstrumentProfile));
        rack.delayEnabled.store(1.0f);
        rack.delayTimeMs.store(40.0f);
        rack.delayFeedback.store(0.55f);
        rack.delayMix.store(0.80f);
        rack.delayMod.store(0.72f);
        rack.delayDucker.store(0.30f);
        rack.delayMode.store(static_cast<float>(
            S13NAMRack::dualDelayMode));
        rack.delayPingPong.store(1.0f);
        rack.delayTempoSync.store(0.0f);
        rack.prepareToPlay(
            fixtureSampleRate, fixtureBlockSize);
    };

    S13NAMRack frozenReferenceRack;
    S13NAMRack frozenEditedRack;
    configureFrozenDualRack(frozenReferenceRack);
    configureFrozenDualRack(frozenEditedRack);
    juce::MidiBuffer frozenMidi;
    juce::AudioBuffer<float> referenceImpulse(
        2, fixtureBlockSize);
    juce::AudioBuffer<float> editedImpulse(
        2, fixtureBlockSize);
    referenceImpulse.clear();
    editedImpulse.clear();
    referenceImpulse.setSample(0, 0, 0.72f);
    referenceImpulse.setSample(1, 9, -0.53f);
    editedImpulse.makeCopyOf(referenceImpulse, true);
    frozenReferenceRack.processDelayStage(
        referenceImpulse, frozenMidi);
    frozenEditedRack.processDelayStage(
        editedImpulse, frozenMidi);
    frozenReferenceRack.delayEnabled.store(0.0f);
    frozenEditedRack.delayEnabled.store(0.0f);

    // Every visible source feeding DelayMacroState is deliberately changed
    // after bypass. A partial freeze would now retarget at least one delay
    // history, feedback/filter law, topology, sync route, or dry/wet law.
    frozenEditedRack.instrumentProfile.store(
        static_cast<float>(S13NAMRack::bassInstrumentProfile));
    frozenEditedRack.delayTimeMs.store(777.0f);
    frozenEditedRack.delayFeedback.store(0.05f);
    frozenEditedRack.delayMix.store(0.20f);
    frozenEditedRack.delayMod.store(0.02f);
    frozenEditedRack.delayDucker.store(0.90f);
    frozenEditedRack.delayMode.store(static_cast<float>(
        S13NAMRack::multiDelayMode));
    frozenEditedRack.delayPingPong.store(0.0f);
    frozenEditedRack.delayTempoSync.store(1.0f);

    const auto frozenInitialTailBudget = std::max(
        frozenReferenceRack.delayTailSamplesRemaining,
        frozenEditedRack.delayTailSamplesRemaining);
    const int drainBlocks = juce::jmax(
        1,
        static_cast<int>(
            (frozenInitialTailBudget
             + static_cast<std::int64_t>(fixtureBlockSize) - 1)
            / static_cast<std::int64_t>(fixtureBlockSize))
            + 1);
    double frozenTailEnergy = 0.0;
    float frozenTailMaximumDifference = 0.0f;
    int frozenTailNonFiniteCount = 0;
    for (int blockIndex = 0;
         blockIndex < drainBlocks;
         ++blockIndex)
    {
        juce::AudioBuffer<float> referenceBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> editedBlock(
            2, fixtureBlockSize);
        referenceBlock.clear();
        editedBlock.clear();
        frozenReferenceRack.processDelayStage(
            referenceBlock, frozenMidi);
        frozenEditedRack.processDelayStage(
            editedBlock, frozenMidi);
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int sample = 0;
                 sample < fixtureBlockSize;
                 ++sample)
            {
                const float reference =
                    referenceBlock.getSample(channel, sample);
                const float edited =
                    editedBlock.getSample(channel, sample);
                if (! std::isfinite(reference)
                    || ! std::isfinite(edited))
                {
                    ++frozenTailNonFiniteCount;
                    continue;
                }
                frozenTailEnergy +=
                    static_cast<double>(reference)
                    * static_cast<double>(reference);
                frozenTailMaximumDifference = juce::jmax(
                    frozenTailMaximumDifference,
                    std::abs(reference - edited));
            }
        }
    }
    const bool frozenTailPassed =
        frozenTailNonFiniteCount == 0
        && frozenTailEnergy > 1.0e-5
        && frozenTailMaximumDifference <= 2.0e-6f
        && frozenReferenceRack.delayTailSamplesRemaining == 0
        && frozenEditedRack.delayTailSamplesRemaining == 0
        && frozenReferenceRack.getTailLengthSeconds() <= 1.0e-9
        && frozenEditedRack.getTailLengthSeconds() <= 1.0e-9
        && ! frozenReferenceRack.delayTailMacroValid
        && ! frozenEditedRack.delayTailMacroValid;

    struct DownwardBudgetResult
    {
        std::int64_t initialBudget = 0;
        std::int64_t initialReportedBudget = 0;
        std::int64_t initialPublicBudget = 0;
        std::int64_t elapsedPriorBudget = 0;
        std::int64_t elapsedPriorReportedBudget = 0;
        std::int64_t loweredBudget = 0;
        std::int64_t lowerReportedBudget = 0;
        std::int64_t lowerPublicBudget = 0;
        std::int64_t bypassBudget = 0;
        std::int64_t bypassPublicBudget = 0;
        std::int64_t expectedBypassBudget = 0;
        bool cachedLowerMacro = false;
        bool pass = false;
    };
    const auto runDownwardBudgetCase = [&] (
        float initialTimeMs,
        float loweredTimeMs,
        float initialFeedback,
        float loweredFeedback,
        float initialMix,
        float loweredMix)
    {
        S13NAMRack rack;
        configureNeutralRack(rack);
        rack.instrumentProfile.store(static_cast<float>(
            S13NAMRack::guitarInstrumentProfile));
        rack.delayEnabled.store(1.0f);
        rack.delayMix.store(initialMix);
        rack.delayMod.store(0.0f);
        rack.delayDucker.store(0.0f);
        rack.delayMode.store(static_cast<float>(
            S13NAMRack::digitalDelayMode));
        rack.delayPingPong.store(0.0f);
        rack.delayTempoSync.store(0.0f);
        rack.delayTimeMs.store(initialTimeMs);
        rack.delayFeedback.store(initialFeedback);
        rack.prepareToPlay(
            fixtureSampleRate, fixtureBlockSize);

        juce::MidiBuffer midi;
        juce::AudioBuffer<float> activeBlock(
            2, fixtureBlockSize);
        activeBlock.clear();
        activeBlock.setSample(0, 0, 0.61f);
        activeBlock.setSample(1, 5, -0.44f);
        rack.processDelayStage(activeBlock, midi);
        DownwardBudgetResult result;
        result.initialBudget =
            rack.delayTailSamplesRemaining;
        result.initialReportedBudget =
            static_cast<std::int64_t>(std::ceil(
                rack.rackDelay.getTailLengthSeconds()
                * fixtureSampleRate));
        result.initialPublicBudget =
            static_cast<std::int64_t>(std::ceil(
                rack.getTailLengthSeconds()
                * fixtureSampleRate));

        rack.delayTimeMs.store(loweredTimeMs);
        rack.delayFeedback.store(loweredFeedback);
        rack.delayMix.store(loweredMix);
        activeBlock.clear();
        rack.processDelayStage(activeBlock, midi);
        result.loweredBudget =
            rack.delayTailSamplesRemaining;
        result.lowerReportedBudget =
            static_cast<std::int64_t>(std::ceil(
                rack.rackDelay.getTailLengthSeconds()
                * fixtureSampleRate));
        result.lowerPublicBudget =
            static_cast<std::int64_t>(std::ceil(
                rack.getTailLengthSeconds()
                * fixtureSampleRate));
        const auto loweredMacro =
            S13NAMRack::resolveDelayMacroState(
                loweredTimeMs,
                loweredFeedback,
                loweredMix,
                0.0f,
                0.0f,
                static_cast<float>(
                    S13NAMRack::digitalDelayMode),
                0.0f,
                0.0f,
                S13NAMRack::guitarInstrumentProfile);
        result.cachedLowerMacro =
            rack.delayTailMacroValid
            && std::abs(
                   rack.delayTailMacro.timeMsL
                   - loweredMacro.timeMsL) <= 1.0e-6f
            && std::abs(
                   rack.delayTailMacro.feedbackGain
                   - loweredMacro.feedbackGain) <= 1.0e-6f
            && std::abs(
                   rack.delayTailMacro.mix
                   - loweredMacro.mix) <= 1.0e-6f;

        rack.delayEnabled.store(0.0f);
        juce::AudioBuffer<float> bypassBlock(
            2, fixtureBlockSize);
        bypassBlock.clear();
        rack.processDelayStage(bypassBlock, midi);
        result.bypassBudget =
            rack.delayTailSamplesRemaining;
        result.bypassPublicBudget =
            static_cast<std::int64_t>(std::ceil(
                rack.getTailLengthSeconds()
                * fixtureSampleRate));
        result.elapsedPriorBudget =
            juce::jmax<std::int64_t>(
                0,
                result.initialBudget
                    - static_cast<std::int64_t>(
                        fixtureBlockSize));
        result.elapsedPriorReportedBudget =
            juce::jmax<std::int64_t>(
                0,
                result.initialReportedBudget
                    - static_cast<std::int64_t>(
                        fixtureBlockSize));
        result.expectedBypassBudget =
            juce::jmax<std::int64_t>(
                0,
                result.loweredBudget
                    - static_cast<std::int64_t>(
                        fixtureBlockSize));
        result.pass =
            result.initialBudget
                > static_cast<std::int64_t>(fixtureBlockSize)
            && result.initialReportedBudget
                > static_cast<std::int64_t>(fixtureBlockSize)
            && result.lowerReportedBudget + 2
                >= result.elapsedPriorReportedBudget
            && result.loweredBudget
                >= result.elapsedPriorBudget
            && result.initialPublicBudget + 2
                >= result.initialBudget
            && result.lowerPublicBudget + 2
                >= result.loweredBudget
            && result.bypassBudget
                == result.expectedBypassBudget
            && result.bypassPublicBudget + 2
                >= result.bypassBudget
            && result.cachedLowerMacro;
        return result;
    };
    const auto downwardFeedbackBudget =
        runDownwardBudgetCase(
            40.0f, 40.0f,
            0.85f, 0.0f,
            0.75f, 0.75f);
    const auto downwardTimeBudget =
        runDownwardBudgetCase(
            2000.0f, 1.0f,
            0.0f, 0.0f,
            0.75f, 0.75f);
    const auto downwardMixBudget =
        runDownwardBudgetCase(
            180.0f, 180.0f,
            0.65f, 0.65f,
            0.90f, 0.05f);
    const bool downwardAutomationBudgetPassed =
        downwardFeedbackBudget.pass
        && downwardTimeBudget.pass
        && downwardMixBudget.pass;

    S13NAMRack sendReleaseHorizonRack;
    configureNeutralRack(sendReleaseHorizonRack);
    sendReleaseHorizonRack.delayEnabled.store(1.0f);
    sendReleaseHorizonRack.delayMix.store(1.0f);
    sendReleaseHorizonRack.delayTimeMs.store(2000.0f);
    sendReleaseHorizonRack.delayFeedback.store(0.0f);
    sendReleaseHorizonRack.delayMod.store(0.0f);
    sendReleaseHorizonRack.delayDucker.store(0.0f);
    sendReleaseHorizonRack.delayMode.store(static_cast<float>(
        S13NAMRack::digitalDelayMode));
    sendReleaseHorizonRack.delayPingPong.store(0.0f);
    sendReleaseHorizonRack.delayTempoSync.store(0.0f);
    sendReleaseHorizonRack.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    juce::AudioBuffer<float> horizonActiveBlock(
        2, fixtureBlockSize);
    for (int channel = 0; channel < 2; ++channel)
        horizonActiveBlock.clear(channel, 0, fixtureBlockSize);
    for (int sample = 0;
         sample < fixtureBlockSize;
         ++sample)
    {
        horizonActiveBlock.setSample(0, sample, 0.50f);
        horizonActiveBlock.setSample(1, sample, -0.35f);
    }
    sendReleaseHorizonRack.processDelayStage(
        horizonActiveBlock, frozenMidi);
    const auto sendReleaseInitialBudget =
        sendReleaseHorizonRack.delayTailSamplesRemaining;
    const auto minimumSendReleaseBudget =
        static_cast<std::int64_t>(std::ceil(
            fixtureSampleRate * 2.020));
    sendReleaseHorizonRack.delayEnabled.store(0.0f);
    const int releaseObservationStart =
        static_cast<int>(std::ceil(
            fixtureSampleRate * 2.008));
    const int releaseObservationEnd =
        static_cast<int>(std::ceil(
            fixtureSampleRate * 2.012));
    float sendReleaseLateEchoPeak = 0.0f;
    int releaseCursor = 0;
    while (releaseCursor < releaseObservationEnd)
    {
        juce::AudioBuffer<float> horizonBlock(
            2, fixtureBlockSize);
        horizonBlock.clear();
        sendReleaseHorizonRack.processDelayStage(
            horizonBlock, frozenMidi);
        for (int sample = 0;
             sample < fixtureBlockSize;
             ++sample)
        {
            const int absoluteSample = releaseCursor + sample;
            if (absoluteSample < releaseObservationStart
                || absoluteSample >= releaseObservationEnd)
            {
                continue;
            }
            sendReleaseLateEchoPeak = juce::jmax(
                sendReleaseLateEchoPeak,
                juce::jmax(
                    std::abs(horizonBlock.getSample(0, sample)),
                    std::abs(horizonBlock.getSample(1, sample))));
        }
        releaseCursor += fixtureBlockSize;
    }
    const auto sendReleaseRemainingBudget =
        sendReleaseHorizonRack.delayTailSamplesRemaining;
    const auto expectedSendReleaseRemainingBudget =
        juce::jmax<std::int64_t>(
            0,
            sendReleaseInitialBudget
                - static_cast<std::int64_t>(releaseCursor));
    const bool sendReleaseHorizonPassed =
        sendReleaseInitialBudget >= minimumSendReleaseBudget
        && sendReleaseRemainingBudget
            == expectedSendReleaseRemainingBudget
        && sendReleaseLateEchoPeak > 1.0e-4f;

    S13NAMRack rapidRetargetRack;
    configureNeutralRack(rapidRetargetRack);
    rapidRetargetRack.delayEnabled.store(1.0f);
    rapidRetargetRack.delayMix.store(1.0f);
    rapidRetargetRack.delayTimeMs.store(100.0f);
    rapidRetargetRack.delayFeedback.store(0.0f);
    rapidRetargetRack.delayMod.store(0.0f);
    rapidRetargetRack.delayDucker.store(0.0f);
    rapidRetargetRack.delayMode.store(static_cast<float>(
        S13NAMRack::digitalDelayMode));
    rapidRetargetRack.delayPingPong.store(0.0f);
    rapidRetargetRack.delayTempoSync.store(0.0f);
    rapidRetargetRack.prepareToPlay(
        fixtureSampleRate, fixtureBlockSize);
    juce::AudioBuffer<float> retargetBlock(
        2, fixtureBlockSize);
    retargetBlock.clear();
    retargetBlock.setSample(0, 0, 0.5f);
    rapidRetargetRack.processDelayStage(
        retargetBlock, frozenMidi);
    rapidRetargetRack.delayTimeMs.store(1000.0f);
    retargetBlock.clear();
    rapidRetargetRack.processDelayStage(
        retargetBlock, frozenMidi);
    rapidRetargetRack.delayTimeMs.store(1500.0f);
    retargetBlock.clear();
    rapidRetargetRack.processDelayStage(
        retargetBlock, frozenMidi);
    const bool rapidRetargetStatesArmed =
        rapidRetargetRack.rackDelay.delayTimeMorphActive
        && rapidRetargetRack.rackDelay.delayTimeChangePending;
    const auto rapidRetargetBudget =
        rapidRetargetRack.delayTailSamplesRemaining;
    const auto minimumRapidRetargetBudget =
        static_cast<std::int64_t>(std::ceil(
            fixtureSampleRate * (1.5 + 0.03 + 0.03 + 0.02)));
    rapidRetargetRack.delayEnabled.store(0.0f);
    retargetBlock.clear();
    rapidRetargetRack.processDelayStage(
        retargetBlock, frozenMidi);
    const auto rapidRetargetBypassBudget =
        rapidRetargetRack.delayTailSamplesRemaining;
    const bool rapidRetargetTailPassed =
        rapidRetargetStatesArmed
        && rapidRetargetBudget >= minimumRapidRetargetBudget
        && rapidRetargetBypassBudget
            == rapidRetargetBudget
                - static_cast<std::int64_t>(fixtureBlockSize);

    const auto budgetToVar = [] (
        const DownwardBudgetResult& result)
    {
        auto* value = new juce::DynamicObject();
        value->setProperty(
            "initialBudgetSamples",
            static_cast<juce::int64>(result.initialBudget));
        value->setProperty(
            "initialReportedBudgetSamples",
            static_cast<juce::int64>(
                result.initialReportedBudget));
        value->setProperty(
            "initialPublicBudgetSamples",
            static_cast<juce::int64>(
                result.initialPublicBudget));
        value->setProperty(
            "elapsedPriorBudgetSamples",
            static_cast<juce::int64>(
                result.elapsedPriorBudget));
        value->setProperty(
            "elapsedPriorReportedBudgetSamples",
            static_cast<juce::int64>(
                result.elapsedPriorReportedBudget));
        value->setProperty(
            "loweredBudgetSamples",
            static_cast<juce::int64>(result.loweredBudget));
        value->setProperty(
            "lowerReportedBudgetSamples",
            static_cast<juce::int64>(result.lowerReportedBudget));
        value->setProperty(
            "lowerPublicBudgetSamples",
            static_cast<juce::int64>(result.lowerPublicBudget));
        value->setProperty(
            "firstBypassBudgetSamples",
            static_cast<juce::int64>(result.bypassBudget));
        value->setProperty(
            "firstBypassPublicBudgetSamples",
            static_cast<juce::int64>(
                result.bypassPublicBudget));
        value->setProperty(
            "expectedFirstBypassBudgetSamples",
            static_cast<juce::int64>(
                result.expectedBypassBudget));
        value->setProperty(
            "cachedLowerMacro", result.cachedLowerMacro);
        value->setProperty("pass", result.pass);
        return juce::var(value);
    };

    auto* value = new juce::DynamicObject();
    value->setProperty(
        "frozenTailEnergy", frozenTailEnergy);
    value->setProperty(
        "frozenInitialTailBudgetSamples",
        static_cast<juce::int64>(frozenInitialTailBudget));
    value->setProperty(
        "frozenTailMaximumDifference",
        frozenTailMaximumDifference);
    value->setProperty(
        "frozenTailNonFiniteCount",
        frozenTailNonFiniteCount);
    value->setProperty(
        "frozenTailPassed", frozenTailPassed);
    value->setProperty(
        "downwardFeedback", budgetToVar(
            downwardFeedbackBudget));
    value->setProperty(
        "downwardTime", budgetToVar(
            downwardTimeBudget));
    value->setProperty(
        "downwardMix", budgetToVar(
            downwardMixBudget));
    value->setProperty(
        "downwardAutomationBudgetPassed",
        downwardAutomationBudgetPassed);
    value->setProperty(
        "sendReleaseInitialBudgetSamples",
        static_cast<juce::int64>(sendReleaseInitialBudget));
    value->setProperty(
        "minimumSendReleaseBudgetSamples",
        static_cast<juce::int64>(minimumSendReleaseBudget));
    value->setProperty(
        "sendReleaseRemainingBudgetSamples",
        static_cast<juce::int64>(sendReleaseRemainingBudget));
    value->setProperty(
        "expectedSendReleaseRemainingBudgetSamples",
        static_cast<juce::int64>(expectedSendReleaseRemainingBudget));
    value->setProperty(
        "sendReleaseLateEchoPeak", sendReleaseLateEchoPeak);
    value->setProperty(
        "sendReleaseHorizonPassed", sendReleaseHorizonPassed);
    value->setProperty(
        "rapidRetargetBudgetSamples",
        static_cast<juce::int64>(rapidRetargetBudget));
    value->setProperty(
        "minimumRapidRetargetBudgetSamples",
        static_cast<juce::int64>(minimumRapidRetargetBudget));
    value->setProperty(
        "rapidRetargetFirstBypassBudgetSamples",
        static_cast<juce::int64>(rapidRetargetBypassBudget));
    value->setProperty(
        "rapidRetargetStatesArmed", rapidRetargetStatesArmed);
    value->setProperty(
        "rapidRetargetTailPassed", rapidRetargetTailPassed);
    value->setProperty(
        "pass",
        frozenTailPassed
            && downwardAutomationBudgetPassed
            && sendReleaseHorizonPassed
            && rapidRetargetTailPassed);
    return juce::var(value);
}

juce::var NAMDelayRegression::runRackMinimumDelayBypassProbe()
{
    constexpr float minimumDelayMs = 1.0f;
    constexpr float delayWetMix = 0.80f;
    constexpr float constantInput = 0.50f;
    constexpr int warmupBlocks = 64;
    constexpr int observationBlocks = 4;

    auto configureMinimumDelay =
        [&] (S13NAMRack& rack)
    {
        configureNeutralRack(rack);
        rack.delayEnabled.store(1.0f);
        rack.delayMix.store(delayWetMix);
        rack.delayTimeMs.store(minimumDelayMs);
        rack.delayFeedback.store(0.0f);
        rack.delayMod.store(0.0f);
        rack.delayDucker.store(0.0f);
        rack.delayMode.store(0.0f);
        rack.delayPingPong.store(0.0f);
        rack.delayTempoSync.store(0.0f);
    };
    auto prepareRack = [&] (
        S13NAMRack& rack,
        bool withDelay)
    {
        if (withDelay)
            configureMinimumDelay(rack);
        else
            configureNeutralRack(rack);
        rack.prepareToPlay(
            fixtureSampleRate, fixtureBlockSize);
    };
    auto warmSilence = [&] (
        S13NAMRack& rack,
        juce::MidiBuffer& midi)
    {
        for (int blockIndex = 0;
             blockIndex < warmupBlocks;
             ++blockIndex)
        {
            juce::AudioBuffer<float> block(
                2, fixtureBlockSize);
            block.clear();
            rack.processBlock(block, midi);
        }
    };

    S13NAMRack fadeRack;
    S13NAMRack fadeReferenceRack;
    prepareRack(fadeRack, true);
    prepareRack(fadeReferenceRack, false);
    juce::MidiBuffer midi;
    warmSilence(fadeRack, midi);
    warmSilence(fadeReferenceRack, midi);
    fadeRack.delayEnabled.store(0.0f);

    const int observationSamples =
        observationBlocks * fixtureBlockSize;
    juce::AudioBuffer<float> fadeCapture(
        2, observationSamples);
    juce::AudioBuffer<float> fadeReferenceCapture(
        2, observationSamples);
    fadeCapture.clear();
    fadeReferenceCapture.clear();
    for (int blockIndex = 0;
         blockIndex < observationBlocks;
         ++blockIndex)
    {
        juce::AudioBuffer<float> block(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> referenceBlock(
            2, fixtureBlockSize);
        for (int sample = 0;
             sample < fixtureBlockSize;
             ++sample)
        {
            block.setSample(0, sample, constantInput);
            block.setSample(1, sample, -constantInput * 0.70f);
            referenceBlock.setSample(
                0, sample, constantInput);
            referenceBlock.setSample(
                1, sample, -constantInput * 0.70f);
        }
        fadeRack.processBlock(block, midi);
        fadeReferenceRack.processBlock(
            referenceBlock, midi);
        fadeCapture.copyFrom(
            0,
            blockIndex * fixtureBlockSize,
            block,
            0,
            0,
            fixtureBlockSize);
        fadeCapture.copyFrom(
            1,
            blockIndex * fixtureBlockSize,
            block,
            1,
            0,
            fixtureBlockSize);
        fadeReferenceCapture.copyFrom(
            0,
            blockIndex * fixtureBlockSize,
            referenceBlock,
            0,
            0,
            fixtureBlockSize);
        fadeReferenceCapture.copyFrom(
            1,
            blockIndex * fixtureBlockSize,
            referenceBlock,
            1,
            0,
            fixtureBlockSize);
    }

    float maximumRatioStep = 0.0f;
    float firstRatio = 0.0f;
    float tenMillisecondRatio = 0.0f;
    float thirtyMillisecondError = 1.0f;
    int firstMeasuredSample = -1;
    int firstUnitySample = -1;
    float previousRatio = 0.0f;
    bool havePreviousRatio = false;
    const int tenMillisecondSample =
        juce::roundToInt(
            static_cast<float>(fixtureSampleRate) * 0.010f);
    const int thirtyMillisecondSample =
        juce::roundToInt(
            static_cast<float>(fixtureSampleRate) * 0.030f);
    for (int sample = 0;
         sample < observationSamples;
         ++sample)
    {
        const float reference =
            fadeReferenceCapture.getSample(0, sample);
        if (std::abs(reference) <= 0.10f)
            continue;

        const float ratio =
            fadeCapture.getSample(0, sample) / reference;
        if (firstMeasuredSample < 0)
        {
            firstMeasuredSample = sample;
            firstRatio = ratio;
        }
        if (havePreviousRatio)
        {
            maximumRatioStep = juce::jmax(
                maximumRatioStep,
                std::abs(ratio - previousRatio));
        }
        previousRatio = ratio;
        havePreviousRatio = true;
        if (sample == tenMillisecondSample)
            tenMillisecondRatio = ratio;
        if (sample == thirtyMillisecondSample)
        {
            thirtyMillisecondError =
                std::abs(ratio - 1.0f);
        }
        if (firstUnitySample < 0
            && ratio >= 0.9999f)
        {
            firstUnitySample = sample;
        }
    }

    S13NAMRack bypassMarkerRack;
    S13NAMRack bypassSilenceRack;
    prepareRack(bypassMarkerRack, true);
    prepareRack(bypassSilenceRack, true);
    warmSilence(bypassMarkerRack, midi);
    warmSilence(bypassSilenceRack, midi);
    bypassMarkerRack.delayEnabled.store(0.0f);
    bypassSilenceRack.delayEnabled.store(0.0f);

    juce::AudioBuffer<float> markerCapture(
        2, observationSamples);
    juce::AudioBuffer<float> silenceCapture(
        2, observationSamples);
    markerCapture.clear();
    silenceCapture.clear();
    for (int blockIndex = 0;
         blockIndex < observationBlocks;
         ++blockIndex)
    {
        juce::AudioBuffer<float> markerBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> silenceBlock(
            2, fixtureBlockSize);
        markerBlock.clear();
        silenceBlock.clear();
        if (blockIndex == 0)
        {
            markerBlock.setSample(0, 0, 0.64f);
            markerBlock.setSample(1, 0, -0.41f);
        }
        bypassMarkerRack.processBlock(markerBlock, midi);
        bypassSilenceRack.processBlock(
            silenceBlock, midi);
        markerCapture.copyFrom(
            0,
            blockIndex * fixtureBlockSize,
            markerBlock,
            0,
            0,
            fixtureBlockSize);
        markerCapture.copyFrom(
            1,
            blockIndex * fixtureBlockSize,
            markerBlock,
            1,
            0,
            fixtureBlockSize);
        silenceCapture.copyFrom(
            0,
            blockIndex * fixtureBlockSize,
            silenceBlock,
            0,
            0,
            fixtureBlockSize);
        silenceCapture.copyFrom(
            1,
            blockIndex * fixtureBlockSize,
            silenceBlock,
            1,
            0,
            fixtureBlockSize);
    }

    int directImpulseSample = -1;
    float directImpulsePeak = 0.0f;
    for (int sample = 0;
         sample < observationSamples;
         ++sample)
    {
        const float difference = std::abs(
            markerCapture.getSample(0, sample)
            - silenceCapture.getSample(0, sample));
        if (difference > directImpulsePeak)
        {
            directImpulsePeak = difference;
            directImpulseSample = sample;
        }
    }

    float rejectedInputEchoPeak = 0.0f;
    for (int channel = 0; channel < 2; ++channel)
    {
        for (int sample = 0;
             sample < observationSamples;
             ++sample)
        {
            if (std::abs(sample - directImpulseSample) <= 2)
                continue;
            rejectedInputEchoPeak = juce::jmax(
                rejectedInputEchoPeak,
                std::abs(
                    markerCapture.getSample(
                        channel, sample)
                    - silenceCapture.getSample(
                        channel, sample)));
        }
    }

    const int minimumFadeSamples = juce::roundToInt(
        static_cast<float>(fixtureSampleRate) * 0.019f);
    const bool pass =
        firstMeasuredSample >= 0
        && firstRatio > 0.15f
        && firstRatio < 0.35f
        && tenMillisecondRatio > 0.48f
        && tenMillisecondRatio < 0.72f
        && firstUnitySample >= minimumFadeSamples
        && maximumRatioStep < 0.005f
        && thirtyMillisecondError <= 1.0e-6f
        && directImpulsePeak > 0.05f
        && rejectedInputEchoPeak <= 1.0e-7f;

    auto* value = new juce::DynamicObject();
    value->setProperty(
        "minimumDelayMs", minimumDelayMs);
    value->setProperty(
        "feedback", 0.0);
    value->setProperty(
        "reportedRackLatencySamples",
        fadeRack.getLatencySamples());
    value->setProperty(
        "firstMeasuredSample", firstMeasuredSample);
    value->setProperty(
        "firstDryRatio", firstRatio);
    value->setProperty(
        "tenMillisecondDryRatio",
        tenMillisecondRatio);
    value->setProperty(
        "firstUnityDrySample", firstUnitySample);
    value->setProperty(
        "minimumAcceptedFadeSamples",
        minimumFadeSamples);
    value->setProperty(
        "maximumAdjacentDryRatioStep",
        maximumRatioStep);
    value->setProperty(
        "thirtyMillisecondDryError",
        thirtyMillisecondError);
    value->setProperty(
        "bypassDirectImpulseSample",
        directImpulseSample);
    value->setProperty(
        "bypassDirectImpulsePeak",
        directImpulsePeak);
    value->setProperty(
        "rejectedBypassInputEchoPeak",
        rejectedInputEchoPeak);
    value->setProperty("pass", pass);
    return juce::var(value);
}

juce::var NAMDelayRegression::runRackTapeEchoSpilloverProbe()
{
    S13NAMRack markerRack;
    S13NAMRack silenceRack;
    S13NAMRack markerReferenceRack;
    S13NAMRack silenceReferenceRack;
    auto prepareNeutral = [&] (S13NAMRack& rack)
    {
        rack.prepareToPlay(
            fixtureSampleRate, fixtureBlockSize);
        configureNeutralRack(rack);
    };
    prepareNeutral(markerRack);
    prepareNeutral(silenceRack);
    prepareNeutral(markerReferenceRack);
    prepareNeutral(silenceReferenceRack);

    constexpr float tapeEchoDelayMs = 24.0f;
    auto configureTapeEcho =
        [tapeEchoDelayMs] (S13NAMRack& rack)
    {
        rack.tapeEchoEnabled.store(1.0f);
        rack.tapeEchoMix.store(0.72f);
        rack.tapeEchoTimeMs.store(tapeEchoDelayMs);
        rack.tapeEchoFeedback.store(0.35f);
        rack.tapeEchoMod.store(0.0f);
        rack.tapeEchoTone.store(0.65f);
    };
    configureTapeEcho(markerRack);
    configureTapeEcho(silenceRack);

    juce::MidiBuffer midi;
    constexpr int warmupBlocks = 32;
    for (int warmup = 0; warmup < warmupBlocks; ++warmup)
    {
        juce::AudioBuffer<float> markerBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> silenceBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> markerReferenceBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> silenceReferenceBlock(
            2, fixtureBlockSize);
        markerBlock.clear();
        silenceBlock.clear();
        markerReferenceBlock.clear();
        silenceReferenceBlock.clear();
        markerRack.processBlock(markerBlock, midi);
        silenceRack.processBlock(silenceBlock, midi);
        markerReferenceRack.processBlock(
            markerReferenceBlock, midi);
        silenceReferenceRack.processBlock(
            silenceReferenceBlock, midi);
    }

    juce::AudioBuffer<float> markerImpulse(
        2, fixtureBlockSize);
    markerImpulse.clear();
    markerImpulse.setSample(
        0, fixtureBlockSize - 1, 0.72f);
    markerImpulse.setSample(
        1, fixtureBlockSize - 1, -0.48f);
    juce::AudioBuffer<float> silenceImpulse;
    juce::AudioBuffer<float> markerReferenceImpulse;
    juce::AudioBuffer<float> silenceReferenceImpulse;
    silenceImpulse.makeCopyOf(markerImpulse, true);
    markerReferenceImpulse.makeCopyOf(markerImpulse, true);
    silenceReferenceImpulse.makeCopyOf(
        markerImpulse, true);
    markerRack.processBlock(markerImpulse, midi);
    silenceRack.processBlock(silenceImpulse, midi);
    markerReferenceRack.processBlock(
        markerReferenceImpulse, midi);
    silenceReferenceRack.processBlock(
        silenceReferenceImpulse, midi);

    const double declaredTailSeconds =
        markerRack.getTailLengthSeconds();
    const auto declaredTailSamples =
        static_cast<std::int64_t>(std::ceil(
            declaredTailSeconds * fixtureSampleRate));
    const int rackLatencySamples = markerRack.getLatencySamples();
    const auto observationSamples =
        declaredTailSamples
        + static_cast<std::int64_t>(rackLatencySamples)
        + fixtureBlockSize * 3LL;
    const int bypassBlocks = juce::jmax(
        4,
        static_cast<int>(
            (observationSamples + fixtureBlockSize - 1)
            / fixtureBlockSize));
    const int spillWindowStartSamples =
        rackLatencySamples
        + juce::roundToInt(
            tapeEchoDelayMs * 0.0005f
            * static_cast<float>(fixtureSampleRate));
    const int bypassInputCheckStartSamples =
        juce::roundToInt(
            static_cast<float>(fixtureSampleRate)
            * 0.025f);

    markerRack.tapeEchoEnabled.store(0.0f);
    silenceRack.tapeEchoEnabled.store(0.0f);

    float spillPeak = 0.0f;
    float bypassInputResidualPeak = 0.0f;
    float lateDifferencePeak = 0.0f;
    for (int blockIndex = 0;
         blockIndex < bypassBlocks;
         ++blockIndex)
    {
        juce::AudioBuffer<float> markerBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> silenceBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> markerReferenceBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> silenceReferenceBlock(
            2, fixtureBlockSize);
        silenceBlock.clear();
        silenceReferenceBlock.clear();
        for (int sample = 0;
             sample < fixtureBlockSize;
             ++sample)
        {
            const int absoluteSample =
                blockIndex * fixtureBlockSize + sample;
            const float time = static_cast<float>(
                absoluteSample)
                / static_cast<float>(fixtureSampleRate);
            const float marker =
                0.023f * std::sin(
                    juce::MathConstants<float>::twoPi
                    * 613.0f * time)
                + 0.009f * std::sin(
                    juce::MathConstants<float>::twoPi
                    * 947.0f * time);
            markerBlock.setSample(0, sample, marker);
            markerBlock.setSample(
                1, sample, marker * -0.63f);
            markerReferenceBlock.setSample(
                0, sample, marker);
            markerReferenceBlock.setSample(
                1, sample, marker * -0.63f);
        }

        markerRack.processBlock(markerBlock, midi);
        silenceRack.processBlock(silenceBlock, midi);
        markerReferenceRack.processBlock(
            markerReferenceBlock, midi);
        silenceReferenceRack.processBlock(
            silenceReferenceBlock, midi);

        const bool afterBoundedDrain =
            blockIndex >= bypassBlocks - 2;
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int sample = 0;
                 sample < fixtureBlockSize;
                 ++sample)
            {
                const float tailDifference =
                    silenceBlock.getSample(channel, sample)
                    - silenceReferenceBlock.getSample(
                        channel, sample);
                const int absoluteBypassSample =
                    blockIndex * fixtureBlockSize + sample;
                if (absoluteBypassSample
                    >= spillWindowStartSamples)
                {
                    spillPeak = juce::jmax(
                        spillPeak,
                        std::abs(tailDifference));
                }

                const float processedMarkerContribution =
                    markerBlock.getSample(channel, sample)
                    - silenceBlock.getSample(
                        channel, sample);
                const float referenceMarkerContribution =
                    markerReferenceBlock.getSample(
                        channel, sample)
                    - silenceReferenceBlock.getSample(
                        channel, sample);
                if (absoluteBypassSample
                    >= bypassInputCheckStartSamples)
                {
                    bypassInputResidualPeak = juce::jmax(
                        bypassInputResidualPeak,
                        std::abs(
                            processedMarkerContribution
                            - referenceMarkerContribution));
                }

                if (afterBoundedDrain)
                {
                    lateDifferencePeak = juce::jmax(
                        lateDifferencePeak,
                        std::abs(
                            markerBlock.getSample(
                                channel, sample)
                            - markerReferenceBlock.getSample(
                                channel, sample)));
                }
            }
        }
    }

    auto* value = new juce::DynamicObject();
    value->setProperty(
        "declaredTailSeconds", declaredTailSeconds);
    value->setProperty(
        "declaredTailSamples",
        static_cast<juce::int64>(declaredTailSamples));
    value->setProperty(
        "reportedRackLatencySamples", rackLatencySamples);
    value->setProperty(
        "spillWindowStartSamples",
        spillWindowStartSamples);
    value->setProperty(
        "bypassInputCheckStartSamples",
        bypassInputCheckStartSamples);
    value->setProperty("bypassBlocks", bypassBlocks);
    value->setProperty("spillPeak", spillPeak);
    value->setProperty(
        "bypassInputResidualPeak",
        bypassInputResidualPeak);
    value->setProperty(
        "lateDifferencePeak", lateDifferencePeak);
    value->setProperty(
        "pass",
        spillPeak > 1.0e-4f
            && bypassInputResidualPeak <= 1.0e-6f
            && lateDifferencePeak <= 1.0e-6f);
    return juce::var(value);
}

juce::var NAMDelayRegression::runRackTapeEchoFrozenTailContractProbe()
{
    auto prepareTapeEcho = [&] (
        S13NAMRack& rack,
        float timeMs,
        float feedback,
        float mix,
        float modulation,
        float tone)
    {
        configureNeutralRack(rack);
        rack.tapeEchoEnabled.store(1.0f);
        rack.tapeEchoTimeMs.store(timeMs);
        rack.tapeEchoFeedback.store(feedback);
        rack.tapeEchoMix.store(mix);
        rack.tapeEchoMod.store(modulation);
        rack.tapeEchoTone.store(tone);
        rack.prepareToPlay(
            fixtureSampleRate, fixtureBlockSize);
    };
    const auto processTape = [] (
        S13NAMRack& rack,
        juce::AudioBuffer<float>& block,
        juce::MidiBuffer& midi)
    {
        rack.processTapeEchoStage(block, midi);
    };

    juce::MidiBuffer midi;
    S13NAMRack frozenReference;
    S13NAMRack frozenEdited;
    prepareTapeEcho(
        frozenReference, 72.0f, 0.48f, 0.76f, 0.42f, 0.67f);
    prepareTapeEcho(
        frozenEdited, 72.0f, 0.48f, 0.76f, 0.42f, 0.67f);

    juce::AudioBuffer<float> excitation(
        2, fixtureBlockSize);
    excitation.clear();
    excitation.setSample(0, fixtureBlockSize - 1, 0.72f);
    excitation.setSample(1, fixtureBlockSize - 1, -0.43f);
    juce::AudioBuffer<float> excitationCopy;
    excitationCopy.makeCopyOf(excitation, true);
    processTape(frozenReference, excitation, midi);
    processTape(frozenEdited, excitationCopy, midi);
    const auto frozenInitialBudget =
        frozenReference.tapeEchoTailSamplesRemaining;

    frozenReference.tapeEchoEnabled.store(0.0f);
    frozenEdited.tapeEchoEnabled.store(0.0f);
    // Every visible source of the derived Tape macro changes after bypass.
    // The already-recorded tail must remain sample-identical.
    frozenEdited.tapeEchoTimeMs.store(1200.0f);
    frozenEdited.tapeEchoFeedback.store(0.0f);
    frozenEdited.tapeEchoMix.store(0.08f);
    frozenEdited.tapeEchoMod.store(1.0f);
    frozenEdited.tapeEchoTone.store(0.0f);

    const int frozenDrainBlocks = juce::jmax(
        2,
        static_cast<int>((frozenInitialBudget
                          + fixtureBlockSize * 2LL
                          + fixtureBlockSize - 1)
                         / fixtureBlockSize));
    float frozenMaximumDifference = 0.0f;
    double frozenTailEnergy = 0.0;
    int frozenNonFiniteCount = 0;
    bool frozenPublicTailCovered = false;
    for (int blockIndex = 0;
         blockIndex < frozenDrainBlocks;
         ++blockIndex)
    {
        juce::AudioBuffer<float> referenceBlock(
            2, fixtureBlockSize);
        juce::AudioBuffer<float> editedBlock(
            2, fixtureBlockSize);
        referenceBlock.clear();
        editedBlock.clear();
        processTape(frozenReference, referenceBlock, midi);
        processTape(frozenEdited, editedBlock, midi);
        if (blockIndex == 0)
        {
            const auto publicTailSamples =
                static_cast<std::int64_t>(std::ceil(
                    frozenEdited.getTailLengthSeconds()
                    * fixtureSampleRate));
            frozenPublicTailCovered = publicTailSamples + 1
                >= frozenEdited.tapeEchoTailSamplesRemaining;
        }
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int sample = 0;
                 sample < fixtureBlockSize;
                 ++sample)
            {
                const float referenceSample =
                    referenceBlock.getSample(channel, sample);
                const float editedSample =
                    editedBlock.getSample(channel, sample);
                if (! std::isfinite(referenceSample)
                    || ! std::isfinite(editedSample))
                {
                    ++frozenNonFiniteCount;
                }
                frozenTailEnergy += std::abs(referenceSample);
                frozenMaximumDifference = juce::jmax(
                    frozenMaximumDifference,
                    std::abs(referenceSample - editedSample));
            }
        }
    }
    const bool frozenTailPassed =
        frozenInitialBudget > fixtureBlockSize
        && frozenTailEnergy > 1.0e-4
        && frozenNonFiniteCount == 0
        && frozenMaximumDifference <= 2.0e-6f
        && frozenPublicTailCovered
        && frozenReference.tapeEchoTailSamplesRemaining == 0
        && frozenEdited.tapeEchoTailSamplesRemaining == 0
        && frozenEdited.publishedTapeEchoTailSeconds.load(
               std::memory_order_relaxed) == 0.0f;

    S13NAMRack releaseRack;
    prepareTapeEcho(
        releaseRack, 1200.0f, 0.0f, 1.0f, 0.0f, 0.5f);
    juce::AudioBuffer<float> releaseInput(
        2, fixtureBlockSize);
    releaseInput.clear();
    releaseInput.applyGain(0.0f);
    for (int sample = 0; sample < fixtureBlockSize; ++sample)
    {
        releaseInput.setSample(0, sample, 0.28f);
        releaseInput.setSample(1, sample, -0.17f);
    }
    processTape(releaseRack, releaseInput, midi);
    const auto releaseInitialBudget =
        releaseRack.tapeEchoTailSamplesRemaining;
    const auto minimumReleaseBudget =
        static_cast<std::int64_t>(std::ceil(
            1.220 * fixtureSampleRate));
    releaseRack.tapeEchoEnabled.store(0.0f);
    const int releaseObservationSamples =
        juce::roundToInt(1.225 * fixtureSampleRate);
    float releaseFedLateEchoPeak = 0.0f;
    bool releasePublicTailCovered = false;
    for (int absoluteStart = 0;
         absoluteStart < releaseObservationSamples;
         absoluteStart += fixtureBlockSize)
    {
        juce::AudioBuffer<float> block(
            2, fixtureBlockSize);
        block.clear();
        processTape(releaseRack, block, midi);
        if (absoluteStart == 0)
        {
            const auto publicTailSamples =
                static_cast<std::int64_t>(std::ceil(
                    releaseRack.getTailLengthSeconds()
                    * fixtureSampleRate));
            releasePublicTailCovered = publicTailSamples + 1
                >= releaseRack.tapeEchoTailSamplesRemaining;
        }
        for (int sample = 0;
             sample < fixtureBlockSize;
             ++sample)
        {
            const int absoluteSample = absoluteStart + sample;
            if (absoluteSample
                    >= juce::roundToInt(1.205 * fixtureSampleRate)
                && absoluteSample
                    <= juce::roundToInt(1.219 * fixtureSampleRate))
            {
                releaseFedLateEchoPeak = juce::jmax(
                    releaseFedLateEchoPeak,
                    std::abs(block.getSample(0, sample)));
            }
        }
    }
    const bool releaseHorizonPassed =
        releaseInitialBudget >= minimumReleaseBudget
        && releasePublicTailCovered
        && releaseFedLateEchoPeak > 1.0e-5f
        && releaseRack.tapeEchoTailSamplesRemaining
            == juce::jmax<std::int64_t>(
                0,
                releaseInitialBudget
                    - static_cast<std::int64_t>(
                        ((releaseObservationSamples
                          + fixtureBlockSize - 1)
                         / fixtureBlockSize)
                        * fixtureBlockSize));

    S13NAMRack retargetRack;
    prepareTapeEcho(
        retargetRack, 40.0f, 0.0f, 1.0f, 0.20f, 0.5f);
    juce::AudioBuffer<float> retargetBlock(
        2, fixtureBlockSize);
    retargetBlock.clear();
    retargetBlock.setSample(0, 0, 0.45f);
    processTape(retargetRack, retargetBlock, midi);
    retargetRack.tapeEchoTimeMs.store(400.0f);
    retargetBlock.clear();
    processTape(retargetRack, retargetBlock, midi);
    retargetRack.tapeEchoTimeMs.store(900.0f);
    retargetBlock.clear();
    processTape(retargetRack, retargetBlock, midi);
    const bool retargetStatesArmed =
        retargetRack.rackTapeEcho.delayTimeMorphActive
        && retargetRack.rackTapeEcho.delayTimeChangePending;
    const auto retargetActiveBudget =
        retargetRack.tapeEchoTailSamplesRemaining;
    const float retargetMod = 0.20f;
    const double longestRetargetHeadSeconds =
        0.900 * (1.01 + retargetMod * 0.035);
    const auto minimumRetargetBudget =
        static_cast<std::int64_t>(std::ceil(
            (longestRetargetHeadSeconds
             + 0.040 + 0.040 + 0.020)
            * fixtureSampleRate));
    retargetRack.tapeEchoEnabled.store(0.0f);
    retargetBlock.clear();
    processTape(retargetRack, retargetBlock, midi);
    const auto retargetPublicTailSamples =
        static_cast<std::int64_t>(std::ceil(
            retargetRack.getTailLengthSeconds()
            * fixtureSampleRate));
    const bool retargetHorizonPassed =
        retargetStatesArmed
        && retargetActiveBudget >= minimumRetargetBudget
        && retargetPublicTailSamples + 1
            >= retargetRack.tapeEchoTailSamplesRemaining;

    auto* value = new juce::DynamicObject();
    value->setProperty(
        "frozenInitialBudgetSamples",
        static_cast<juce::int64>(frozenInitialBudget));
    value->setProperty(
        "frozenTailMaximumDifference",
        frozenMaximumDifference);
    value->setProperty(
        "frozenTailEnergy", frozenTailEnergy);
    value->setProperty(
        "frozenPublicTailCovered", frozenPublicTailCovered);
    value->setProperty("frozenTailPassed", frozenTailPassed);
    value->setProperty(
        "releaseInitialBudgetSamples",
        static_cast<juce::int64>(releaseInitialBudget));
    value->setProperty(
        "minimumReleaseBudgetSamples",
        static_cast<juce::int64>(minimumReleaseBudget));
    value->setProperty(
        "releaseFedLateEchoPeak", releaseFedLateEchoPeak);
    value->setProperty(
        "releaseRemainingBudgetSamples",
        static_cast<juce::int64>(
            releaseRack.tapeEchoTailSamplesRemaining));
    value->setProperty(
        "releaseHorizonPassed", releaseHorizonPassed);
    value->setProperty(
        "retargetStatesArmed", retargetStatesArmed);
    value->setProperty(
        "retargetActiveBudgetSamples",
        static_cast<juce::int64>(retargetActiveBudget));
    value->setProperty(
        "minimumRetargetBudgetSamples",
        static_cast<juce::int64>(minimumRetargetBudget));
    value->setProperty(
        "retargetHorizonPassed", retargetHorizonPassed);
    value->setProperty(
        "pass",
        frozenTailPassed
            && releaseHorizonPassed
            && retargetHorizonPassed);
    return juce::var(value);
}

juce::var NAMDelayRegression::runTrackProcessorSparseTailServiceProbe()
{
    struct SparseDelayPlayHead final : juce::AudioPlayHead
    {
        juce::Optional<PositionInfo> getPosition() const override
        {
            PositionInfo info;
            info.setBpm(10.0);
            info.setIsPlaying(true);
            return info;
        }
    } playHead;

    auto rack = std::make_unique<S13NAMRack>();
    auto* const rackPointer = rack.get();
    configureNeutralRack(*rackPointer);
    rackPointer->delayEnabled.store(1.0f);
    rackPointer->delayTimeMs.store(250.0f);
    rackPointer->delayFeedback.store(0.85f);
    rackPointer->delayMix.store(1.0f);
    rackPointer->delayMod.store(0.0f);
    rackPointer->delayDucker.store(0.0f);
    rackPointer->delayMode.store(0.0f);
    rackPointer->delayPingPong.store(0.0f);
    rackPointer->delayTempoSync.store(1.0f);
    rackPointer->setPlayHead(&playHead);

    TrackProcessor track;
    track.stopTimer();
    track.setTrackType(TrackType::Audio);
    const bool addPassed = track.addTrackFX(
        std::move(rack), fixtureSampleRate, fixtureBlockSize);
    track.prepareToPlay(fixtureSampleRate, fixtureBlockSize);
    const int initialBudgetSamples =
        track.realtimeFXTailBudgetSamples.load(
            std::memory_order_acquire);
    const int initialMinimumSamples =
        track.realtimeFXTailMinimumDrainSamples.load(
            std::memory_order_acquire);
    const bool representsMoreThan120Seconds =
        initialBudgetSamples
            > juce::roundToInt(120.0 * fixtureSampleRate)
        && initialMinimumSamples
            > juce::roundToInt(120.0 * fixtureSampleRate);

    constexpr double renderSeconds = 12.20;
    const int renderSamples = juce::roundToInt(
        renderSeconds * fixtureSampleRate);
    const int timerPeriodSamples = juce::jmax(
        fixtureBlockSize,
        juce::roundToInt(0.250 * fixtureSampleRate));
    int samplesUntilTimer = timerPeriodSamples;
    int timerMaintenanceCalls = 0;
    float firstRepeatPeak = 0.0f;
    float secondRepeatPeak = 0.0f;
    juce::MidiBuffer midi;
    for (int absoluteStart = 0;
         absoluteStart < renderSamples;
         absoluteStart += fixtureBlockSize)
    {
        juce::AudioBuffer<float> block(
            2, fixtureBlockSize);
        block.clear();
        if (absoluteStart == 0)
        {
            block.setSample(0, 0, 0.55f);
            block.setSample(1, 0, -0.31f);
        }
        track.processBlock(block, midi);
        for (int sample = 0;
             sample < fixtureBlockSize;
             ++sample)
        {
            const double timeSeconds =
                static_cast<double>(absoluteStart + sample)
                / fixtureSampleRate;
            const float peak = juce::jmax(
                std::abs(block.getSample(0, sample)),
                std::abs(block.getSample(1, sample)));
            if (timeSeconds >= 5.95 && timeSeconds <= 6.05)
                firstRepeatPeak = juce::jmax(firstRepeatPeak, peak);
            if (timeSeconds >= 11.95 && timeSeconds <= 12.05)
                secondRepeatPeak = juce::jmax(secondRepeatPeak, peak);
        }

        samplesUntilTimer -= fixtureBlockSize;
        while (samplesUntilTimer <= 0)
        {
            track.timerCallback();
            ++timerMaintenanceCalls;
            samplesUntilTimer += timerPeriodSamples;
        }
    }

    const bool sparseRepeatsSurvived =
        firstRepeatPeak > 1.0e-5f
        && secondRepeatPeak > 1.0e-5f
        && track.realtimeFXTailActive.load(
               std::memory_order_acquire)
        && ! track.realtimeFXTailResetPending.load(
               std::memory_order_acquire)
        && track.realtimeFXTailMinimumSamplesRemaining > 0;

    const int previousPublishedBudget =
        track.realtimeFXTailLastPublishedBudgetSamples;
    const int increasedPublishedBudget = juce::jmin(
        std::numeric_limits<int>::max() - fixtureBlockSize * 4,
        juce::jmax(
            previousPublishedBudget,
            track.realtimeFXTailHardSamplesRemaining)
            + juce::roundToInt(2.0 * fixtureSampleRate));
    track.realtimeFXTailBudgetSamples.store(
        increasedPublishedBudget, std::memory_order_release);
    track.realtimeFXTailMinimumDrainSamples.store(
        increasedPublishedBudget - fixtureBlockSize,
        std::memory_order_release);
    juce::AudioBuffer<float> adoptionBlock(
        2, fixtureBlockSize);
    adoptionBlock.clear();
    track.processBlock(adoptionBlock, midi);
    const int afterIncreaseSamples =
        track.realtimeFXTailHardSamplesRemaining;
    adoptionBlock.clear();
    track.processBlock(adoptionBlock, midi);
    const int afterUnchangedSamples =
        track.realtimeFXTailHardSamplesRemaining;
    const bool upwardBudgetAdoptedOnce =
        afterIncreaseSamples
            == increasedPublishedBudget - fixtureBlockSize
        && afterUnchangedSamples
            == afterIncreaseSamples - fixtureBlockSize;

    auto* value = new juce::DynamicObject();
    value->setProperty("trackFXAdded", addPassed);
    value->setProperty(
        "initialBudgetSamples", initialBudgetSamples);
    value->setProperty(
        "initialMinimumDrainSamples", initialMinimumSamples);
    value->setProperty(
        "representsMoreThan120Seconds",
        representsMoreThan120Seconds);
    value->setProperty(
        "timerMaintenanceCalls", timerMaintenanceCalls);
    value->setProperty("firstRepeatPeak", firstRepeatPeak);
    value->setProperty("secondRepeatPeak", secondRepeatPeak);
    value->setProperty(
        "sparseRepeatsSurvived", sparseRepeatsSurvived);
    value->setProperty(
        "increasedPublishedBudget", increasedPublishedBudget);
    value->setProperty(
        "afterIncreaseSamples", afterIncreaseSamples);
    value->setProperty(
        "afterUnchangedSamples", afterUnchangedSamples);
    value->setProperty(
        "upwardBudgetAdoptedOnce", upwardBudgetAdoptedOnce);
    value->setProperty(
        "pass",
        addPassed
            && representsMoreThan120Seconds
            && timerMaintenanceCalls >= 40
            && sparseRepeatsSurvived
            && upwardBudgetAdoptedOnce);
    return juce::var(value);
}

juce::Array<juce::var> NAMDelayRegression::runRackTailChecks()
{
    juce::Array<juce::var> checks;

    const auto rackDelaySpilloverProbe =
        runRackDelaySpilloverProbe();
    addCheck(
        checks,
        "rack_delay_bypass_spills_then_becomes_dry",
        rackDelaySpilloverProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Disabling the rack delay must preserve its already-recorded echo over unity dry, reject new bypass input from the delay line, and return to the fixed-latency dry reference after the bounded tail.",
        rackDelaySpilloverProbe);
    const auto rackDelayV10FrozenTailAndBudgetProbe =
        runRackDelayV10FrozenTailAndBudgetProbe();
    addCheck(
        checks,
        "rack_delay_v10_frozen_tail_macro_and_downward_budget",
        rackDelayV10FrozenTailAndBudgetProbe.getProperty(
            "pass", false)
            ? "pass"
            : "fail",
        "After Delay bypass, edits to every visible macro source must not alter the already-generated Dual tail. While active, downward Feedback, Time, or Mix automation may update the frozen macro for the eventual bypass, but both the processor's published live-tail bound and the rack's armed budget must retain the elapsed conservative bound. The budget must also include the additive input-send release horizon and both current plus queued time-morph horizons, so late release-fed or rapidly retargeted echoes cannot be truncated.",
        rackDelayV10FrozenTailAndBudgetProbe);
    const auto rackMinimumDelayBypassProbe =
        runRackMinimumDelayBypassProbe();
    addCheck(
        checks,
        "rack_delay_minimum_time_bypass_is_smooth_and_input_isolated",
        rackMinimumDelayBypassProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "At the 1 ms minimum time and zero feedback, rack Delay bypass must reject new input from the delay line, ramp its dry gain without a block-edge jump, retain the bounded drain for at least the 20 ms transition, and then become exactly dry.",
        rackMinimumDelayBypassProbe);
    const auto rackTapeEchoSpilloverProbe =
        runRackTapeEchoSpilloverProbe();
    addCheck(
        checks,
        "rack_tape_echo_bypass_spills_then_becomes_dry",
        rackTapeEchoSpilloverProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Disabling the rack Tape Echo must spill only its already-recorded repeats over unity dry, reject distinct bypass-period input from the echo line, and return exactly to the fixed-latency dry reference after its bounded tail.",
        rackTapeEchoSpilloverProbe);
    const auto rackTapeEchoFrozenTailContractProbe =
        runRackTapeEchoFrozenTailContractProbe();
    addCheck(
        checks,
        "rack_tape_echo_frozen_tail_publication_and_release_contract",
        rackTapeEchoFrozenTailContractProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Tape Echo bypass must freeze its complete audible macro, publish the frozen remaining tail even after controls are edited, retain a separate 20 ms input-send release horizon, and count both configured 40 ms time-head morphs when a rapid retarget queues a second transition.",
        rackTapeEchoFrozenTailContractProbe);
    const auto trackProcessorSparseTailServiceProbe =
        runTrackProcessorSparseTailServiceProbe();
    addCheck(
        checks,
        "track_processor_sparse_delay_tail_service_contract",
        trackProcessorSparseTailServiceProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "TrackProcessor must represent the Rack's greater-than-120-second 10-BPM delay tail, run actual control-thread timer maintenance without treating the silence between 6-second repeats as completion, preserve the second repeat at 12 seconds, and adopt a newly published longer live budget exactly once.",
        trackProcessorSparseTailServiceProbe);

    return checks;
}
