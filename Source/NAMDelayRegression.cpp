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

void NAMDelayRegression::addCheck(
    juce::Array<juce::var>& targetChecks,
    const juce::String& id,
    const juce::String& status,
    const juce::String& detail,
    const juce::var& value)
{
    auto* object = new juce::DynamicObject();
    object->setProperty("id", id);
    object->setProperty("status", status);
    object->setProperty("detail", detail);
    if (! value.isVoid())
        object->setProperty("value", value);
    targetChecks.add(juce::var(object));
}

void NAMDelayRegression::configureNeutralRack(S13NAMRack& rack)
{
    rack.inputTrimDb.store(0.0f);
    rack.outputTrimDb.store(0.0f);
    rack.gateThresholdDb.store(-100.0f);
    rack.compressorEnabled.store(0.0f);
    rack.octaverEnabled.store(0.0f);
    rack.precisionDriveEnabled.store(0.0f);
    rack.chaosEnabled.store(0.0f);
    rack.pedalMix.store(0.0f);
    rack.ampEnabled.store(0.0f);
    rack.setCabRequestedEnabled(false);
    rack.eqEnabled.store(0.0f);
    rack.chorusMix.store(0.0f);
    rack.modulatorEnabled.store(0.0f);
    rack.delayEnabled.store(0.0f);
    rack.reverbEnabled.store(0.0f);
    rack.auditionSource.store(0.0f);
}

juce::var NAMDelayRegression::runDelayV10ContractProbe()
{
    constexpr std::array<float, 5> modulationBoundaries {
        0.0f, 0.4999f, 0.5f, 0.9999f, 1.0f
    };
    constexpr std::array<int, 5> expectedLeft {
        2, 2, 3, 3, 4
    };
    constexpr std::array<int, 5> expectedPingPongRight {
        3, 3, 4, 4, 4
    };
    bool syncResolverPassed = true;
    juce::Array<juce::var> syncCases;
    for (size_t index = 0;
         index < modulationBoundaries.size();
         ++index)
    {
        const auto mono =
            S13NAMRack::resolveDelaySyncSelection(
                modulationBoundaries[index], false);
        const auto pingPong =
            S13NAMRack::resolveDelaySyncSelection(
                modulationBoundaries[index], true);
        const bool casePassed =
            mono.leftNoteIndex == expectedLeft[index]
            && mono.rightNoteIndex == expectedLeft[index]
            && pingPong.leftNoteIndex == expectedLeft[index]
            && pingPong.rightNoteIndex
                == expectedPingPongRight[index];
        syncResolverPassed =
            syncResolverPassed && casePassed;

        auto* value = new juce::DynamicObject();
        value->setProperty(
            "modulation", modulationBoundaries[index]);
        value->setProperty(
            "leftNoteIndex", pingPong.leftNoteIndex);
        value->setProperty(
            "rightNoteIndex", pingPong.rightNoteIndex);
        value->setProperty("pass", casePassed);
        syncCases.add(juce::var(value));
    }
    const auto nonFiniteSync =
        S13NAMRack::resolveDelaySyncSelection(
            std::numeric_limits<float>::quiet_NaN(), true);
    syncResolverPassed =
        syncResolverPassed
        && nonFiniteSync.leftNoteIndex == 2
        && nonFiniteSync.rightNoteIndex == 3;

    const auto digital =
        S13NAMRack::resolveDelayMacroState(
            360.0f, 0.55f, 0.35f, 0.80f, 0.40f,
            0.0f, 1.0f, 1.0f,
            S13NAMRack::guitarInstrumentProfile);
    const auto tape =
        S13NAMRack::resolveDelayMacroState(
            360.0f, 0.55f, 0.35f, 0.80f, 0.40f,
            1.0f, 1.0f, 1.0f,
            S13NAMRack::guitarInstrumentProfile);
    const auto analog =
        S13NAMRack::resolveDelayMacroState(
            360.0f, 0.55f, 0.35f, 0.80f, 0.40f,
            2.0f, 1.0f, 1.0f,
            S13NAMRack::guitarInstrumentProfile);
    const auto bassTape =
        S13NAMRack::resolveDelayMacroState(
            360.0f, 0.55f, 0.35f, 0.80f, 0.40f,
            1.0f, 1.0f, 1.0f,
            S13NAMRack::bassInstrumentProfile);
    const auto multi =
        S13NAMRack::resolveDelayMacroState(
            360.0f, 0.55f, 0.35f, 0.80f, 0.40f,
            3.0f, 1.0f, 1.0f,
            S13NAMRack::guitarInstrumentProfile);
    const auto dual =
        S13NAMRack::resolveDelayMacroState(
            360.0f, 0.55f, 0.35f, 0.80f, 0.40f,
            4.0f, 1.0f, 1.0f,
            S13NAMRack::guitarInstrumentProfile);
    const auto malformed =
        S13NAMRack::resolveDelayMacroState(
            std::numeric_limits<float>::quiet_NaN(),
            std::numeric_limits<float>::infinity(),
            -4.0f,
            std::numeric_limits<float>::quiet_NaN(),
            9.0f,
            std::numeric_limits<float>::quiet_NaN(),
            -1.0f,
            8.0f,
            99);
    const auto macroFinite = [] (
        const S13NAMRack::DelayMacroState& state)
    {
        return std::isfinite(state.timeMsL)
            && std::isfinite(state.timeMsR)
            && std::isfinite(state.mix)
            && std::isfinite(state.dryGain)
            && std::isfinite(state.feedbackGain)
            && std::isfinite(state.crossFeed)
            && std::isfinite(state.lowPassHz)
            && std::isfinite(state.highPassHz)
            && std::isfinite(state.saturation)
            && std::isfinite(state.stereoWidth)
            && std::isfinite(state.wowDepthMs)
            && std::isfinite(state.wowRateHz)
            && std::isfinite(state.flutterDepthMs)
            && std::isfinite(state.flutterRateHz)
            && std::isfinite(state.duckAttackMs)
            && std::isfinite(state.duckReleaseMs)
            && std::isfinite(state.duckMaxReduction)
            && std::all_of(
                state.multiTapRatios.begin(),
                state.multiTapRatios.end(),
                [] (float value) { return std::isfinite(value); })
            && std::all_of(
                state.multiTapWeights.begin(),
                state.multiTapWeights.end(),
                [] (float value) { return std::isfinite(value); })
            && std::isfinite(state.multiFeedbackGain)
            && std::isfinite(state.dualTimeRatio)
            && std::isfinite(state.dualFeedbackGain)
            && std::isfinite(state.dualLowPassHz)
            && std::isfinite(state.dualHighPassHz)
            && std::isfinite(state.dualSaturation)
            && std::isfinite(state.dualModDepthMs)
            && std::isfinite(state.dualModRateHz)
            && std::isfinite(state.topologyControl);
    };
    const bool macroContractPassed =
        macroFinite(digital)
        && macroFinite(tape)
        && macroFinite(analog)
        && macroFinite(bassTape)
        && macroFinite(multi)
        && macroFinite(dual)
        && macroFinite(malformed)
        && digital.mode == S13NAMRack::digitalDelayMode
        && tape.mode == S13NAMRack::tapeDelayMode
        && analog.mode == S13NAMRack::analogDelayMode
        && multi.mode == S13NAMRack::multiDelayMode
        && dual.mode == S13NAMRack::dualDelayMode
        && digital.lowPassHz > tape.lowPassHz
        && tape.lowPassHz > analog.lowPassHz
        && digital.feedbackGain > tape.feedbackGain
        && tape.feedbackGain > analog.feedbackGain
        && tape.wowDepthMs > analog.wowDepthMs
        && analog.wowDepthMs > 0.0f
        && tape.flutterDepthMs > 0.0f
        && digital.flutterDepthMs == 0.0f
        && analog.flutterDepthMs == 0.0f
        // Bass retains the fundamental through its unity dry path while the
        // repeat path is filtered more aggressively to prevent low buildup.
        && bassTape.highPassHz > tape.highPassHz
        && bassTape.lowPassHz > tape.lowPassHz
        && std::abs(bassTape.dryGain - 1.0f) <= 1.0e-6f
        && std::abs(
               tape.dryGain
               - std::cos(
                   0.35f
                   * juce::MathConstants<float>::halfPi))
            <= 1.0e-6f
        && std::abs(
               tape.mix
               - std::sin(
                   0.35f
                   * juce::MathConstants<float>::halfPi))
            <= 1.0e-6f
        && std::abs(multi.multiTapRatios[0] - 1.0f) <= 1.0e-7f
        && std::abs(multi.multiTapRatios[1] - 0.726f) <= 1.0e-6f
        && std::abs(multi.multiTapRatios[2] - 0.546f) <= 1.0e-6f
        && std::abs(multi.multiTapRatios[3] - 0.374f) <= 1.0e-6f
        && std::abs(
               std::accumulate(
                   multi.multiTapWeights.begin(),
                   multi.multiTapWeights.end(),
                   0.0f)
               - 1.0f) <= 1.0e-7f
        && std::abs(multi.multiFeedbackGain - 0.528f) <= 1.0e-6f
        && std::abs(dual.dualTimeRatio - 0.90f) <= 1.0e-6f
        && std::abs(dual.dualFeedbackGain - 0.5038f) <= 1.0e-6f
        && std::abs(dual.dualLowPassHz - 6400.0f) <= 1.0e-5f
        && std::abs(dual.dualSaturation - 0.42f) <= 1.0e-6f
        && malformed.mode == S13NAMRack::tapeDelayMode
        && std::abs(malformed.timeMsL - 360.0f) <= 1.0e-6f
        && malformed.mix == 0.0f
        && malformed.duckAmount == 1.0f
        && ! malformed.pingPong
        && malformed.tempoSync;

    juce::ValueTree legacyState("S13NAMRack");
    legacyState.setProperty(
        "namEffectsDspVersion",
        S13NAMRack::reverbVoiceIntroducedNAMEffectsDspVersion,
        nullptr);
    legacyState.setProperty("reverbVoice", 3.0, nullptr);
    legacyState.setProperty("delayMix", 4.0, nullptr);
    legacyState.setProperty("delayTimeMs", -4.0, nullptr);
    legacyState.setProperty("delayFeedback", 7.0, nullptr);
    legacyState.setProperty("delayMod", -1.0, nullptr);
    legacyState.setProperty("delayDucker", 3.0, nullptr);
    legacyState.setProperty("delayMode", 99.0, nullptr);
    legacyState.setProperty("delayPingPong", 0.2, nullptr);
    legacyState.setProperty("delayTempoSync", 0.8, nullptr);
    legacyState.setProperty("delayEnabled", -2.0, nullptr);
    legacyState.setProperty("inputMode", 1.0, nullptr);
    legacyState.setProperty("auditionSource", 1.0, nullptr);
    juce::MemoryBlock migratedState;
    {
        juce::MemoryOutputStream stream(
            migratedState, false);
        legacyState.writeToStream(stream);
    }
    bool firstMigrationChanged = false;
    const bool firstMigrationSucceeded =
        S13NAMRack::migratePresetStateToCurrent(
            migratedState, firstMigrationChanged);
    const auto canonicalState =
        juce::ValueTree::readFromData(
            migratedState.getData(), migratedState.getSize());
    bool secondMigrationChanged = true;
    const bool secondMigrationSucceeded =
        S13NAMRack::migratePresetStateToCurrent(
            migratedState, secondMigrationChanged);
    const auto closeProperty = [&canonicalState] (
        const char* property,
        double expected)
    {
        return canonicalState.isValid()
            && std::abs(
                   static_cast<double>(
                       canonicalState.getProperty(property))
                   - expected) <= 1.0e-7;
    };
    const bool stateContractPassed =
        firstMigrationSucceeded
        && firstMigrationChanged
        && secondMigrationSucceeded
        && ! secondMigrationChanged
        && canonicalState.isValid()
        && static_cast<int>(canonicalState.getProperty(
               "namEffectsDspVersion", 0))
            == S13NAMRack::currentNAMEffectsDspVersion
        && closeProperty("delayMix", 1.0)
        && closeProperty("delayTimeMs", 1.0)
        && closeProperty("delayFeedback", 0.85)
        && closeProperty("delayMod", 0.0)
        && closeProperty("delayDucker", 1.0)
        && closeProperty("delayMode", 2.0)
        && closeProperty("delayPingPong", 0.0)
        && closeProperty("delayTempoSync", 1.0)
        && closeProperty("delayEnabled", 0.0)
        && ! canonicalState.hasProperty("inputMode")
        && ! canonicalState.hasProperty("auditionSource")
        && closeProperty("reverbVoice", 3.0);

    juce::ValueTree currentState("S13NAMRack");
    currentState.setProperty(
        "namEffectsDspVersion",
        S13NAMRack::currentNAMEffectsDspVersion,
        nullptr);
    currentState.setProperty("delayMode", 99.0, nullptr);
    currentState.setProperty("inputMode", 1.0, nullptr);
    currentState.setProperty("auditionSource", 1.0, nullptr);
    juce::MemoryBlock currentStateData;
    {
        juce::MemoryOutputStream stream(currentStateData, false);
        currentState.writeToStream(stream);
    }
    bool currentStateChanged = false;
    const bool currentStateSucceeded =
        S13NAMRack::migratePresetStateToCurrent(
            currentStateData,
            currentStateChanged);
    const auto canonicalCurrentState =
        juce::ValueTree::readFromData(
            currentStateData.getData(),
            currentStateData.getSize());
    const bool currentStateContractPassed =
        currentStateSucceeded
        && currentStateChanged
        && canonicalCurrentState.isValid()
        && std::abs(static_cast<double>(
               canonicalCurrentState.getProperty("delayMode")) - 4.0)
            <= 1.0e-7
        && ! canonicalCurrentState.hasProperty("inputMode")
        && ! canonicalCurrentState.hasProperty("auditionSource");

    const auto migrateModeFixture = [] (
        const juce::var& version,
        bool includeVersion)
    {
        juce::ValueTree tree("S13NAMRack");
        if (includeVersion)
        {
            tree.setProperty(
                "namEffectsDspVersion", version, nullptr);
        }
        tree.setProperty("delayMode", 4.0, nullptr);
        juce::MemoryBlock data;
        {
            juce::MemoryOutputStream stream(data, false);
            tree.writeToStream(stream);
        }
        bool changed = false;
        if (! S13NAMRack::migratePresetStateToCurrent(
                data, changed))
            return -1.0;
        const auto migrated = juce::ValueTree::readFromData(
            data.getData(), data.getSize());
        return migrated.isValid()
            ? static_cast<double>(
                  migrated.getProperty("delayMode", -1.0))
            : -1.0;
    };
    const double missingVersionMode = migrateModeFixture(
        {}, false);
    const double v10Mode = migrateModeFixture(
        S13NAMRack::delayV10IntroducedNAMEffectsDspVersion,
        true);
    const double developmentAliasMode = migrateModeFixture(
        S13NAMRack::developmentNAMEffectsDspVersionAlias, true);
    const double futureVersionMode = migrateModeFixture(
        S13NAMRack::currentNAMEffectsDspVersion + 1, true);
    const double fractionalVersionMode = migrateModeFixture(
        static_cast<double>(
            S13NAMRack::currentNAMEffectsDspVersion) + 0.7,
        true);

    const auto migrateNestedModeFixture = [] (
        int parentVersion)
    {
        auto* ui = new juce::DynamicObject();
        auto* baseline = new juce::DynamicObject();
        auto* values = new juce::DynamicObject();
        values->setProperty("delayMode", 4.0);
        baseline->setProperty("values", juce::var(values));
        ui->setProperty(
            "namPresetBaseline", juce::var(baseline));
        juce::ValueTree tree("S13NAMRack");
        tree.setProperty(
            "namEffectsDspVersion", parentVersion, nullptr);
        tree.setProperty(
            "uiStateJSON",
            juce::JSON::toString(juce::var(ui), false),
            nullptr);
        juce::MemoryBlock data;
        {
            juce::MemoryOutputStream stream(data, false);
            tree.writeToStream(stream);
        }
        bool changed = false;
        if (! S13NAMRack::migratePresetStateToCurrent(
                data, changed))
            return -1.0;
        const auto migrated = juce::ValueTree::readFromData(
            data.getData(), data.getSize());
        const auto migratedUi = juce::JSON::parse(
            migrated.getProperty("uiStateJSON", {}).toString());
        if (auto* migratedUiObject =
                migratedUi.getDynamicObject())
        {
            if (auto* migratedBaseline =
                    migratedUiObject->getProperty(
                        "namPresetBaseline").getDynamicObject())
            {
                if (auto* migratedValues =
                        migratedBaseline->getProperty(
                            "values").getDynamicObject())
                {
                    return static_cast<double>(
                        migratedValues->getProperty("delayMode"));
                }
            }
        }
        return -1.0;
    };
    const double nestedLegacyMode =
        migrateNestedModeFixture(7);
    const double nestedV10Mode =
        migrateNestedModeFixture(
            S13NAMRack::delayV10IntroducedNAMEffectsDspVersion);
    const double nestedCurrentMode =
        migrateNestedModeFixture(
            S13NAMRack::currentNAMEffectsDspVersion);
    const double nestedDevelopmentAliasMode =
        migrateNestedModeFixture(
            S13NAMRack::developmentNAMEffectsDspVersionAlias);
    const bool versionMigrationContractPassed =
        std::abs(missingVersionMode - 1.0) <= 1.0e-7
        && std::abs(v10Mode - 4.0) <= 1.0e-7
        && std::abs(developmentAliasMode - 4.0) <= 1.0e-7
        && std::abs(futureVersionMode - 1.0) <= 1.0e-7
        && std::abs(fractionalVersionMode - 1.0) <= 1.0e-7
        && std::abs(nestedLegacyMode - 2.0) <= 1.0e-7
        && std::abs(nestedV10Mode - 4.0) <= 1.0e-7
        && std::abs(nestedCurrentMode - 4.0) <= 1.0e-7
        && std::abs(nestedDevelopmentAliasMode - 4.0) <= 1.0e-7;

    S13NAMRack malformedSaveRack;
    const float nonFinite =
        std::numeric_limits<float>::quiet_NaN();
    malformedSaveRack.delayMix.store(nonFinite);
    malformedSaveRack.delayTimeMs.store(nonFinite);
    malformedSaveRack.delayFeedback.store(nonFinite);
    malformedSaveRack.delayMod.store(nonFinite);
    malformedSaveRack.delayDucker.store(nonFinite);
    malformedSaveRack.delayMode.store(nonFinite);
    malformedSaveRack.delayPingPong.store(nonFinite);
    malformedSaveRack.delayTempoSync.store(nonFinite);
    malformedSaveRack.delayEnabled.store(nonFinite);
    juce::MemoryBlock malformedSaveState;
    malformedSaveRack.getStateInformation(malformedSaveState);
    const auto canonicalSavedState =
        juce::ValueTree::readFromData(
            malformedSaveState.getData(),
            malformedSaveState.getSize());
    const bool saveBoundaryContractPassed =
        canonicalSavedState.isValid()
        && std::abs(static_cast<double>(
               canonicalSavedState.getProperty("delayMix")) - 0.22)
            <= 1.0e-7
        && std::abs(static_cast<double>(
               canonicalSavedState.getProperty("delayTimeMs")) - 360.0)
            <= 1.0e-7
        && std::abs(static_cast<double>(
               canonicalSavedState.getProperty("delayFeedback")) - 0.22)
            <= 1.0e-7
        && std::abs(static_cast<double>(
               canonicalSavedState.getProperty("delayMode")) - 1.0)
            <= 1.0e-7
        && std::abs(static_cast<double>(
               canonicalSavedState.getProperty("delayPingPong")) - 1.0)
            <= 1.0e-7
        && std::abs(static_cast<double>(
               canonicalSavedState.getProperty("delayTempoSync")))
            <= 1.0e-7
        && std::abs(static_cast<double>(
               canonicalSavedState.getProperty("delayEnabled")))
            <= 1.0e-7;

    auto* value = new juce::DynamicObject();
    value->setProperty("syncCases", syncCases);
    value->setProperty(
        "syncResolverPassed", syncResolverPassed);
    value->setProperty(
        "macroContractPassed", macroContractPassed);
    value->setProperty(
        "stateContractPassed", stateContractPassed);
    value->setProperty(
        "currentStateContractPassed",
        currentStateContractPassed);
    value->setProperty(
        "versionMigrationContractPassed",
        versionMigrationContractPassed);
    value->setProperty(
        "saveBoundaryContractPassed",
        saveBoundaryContractPassed);
    value->setProperty(
        "missingVersionMode", missingVersionMode);
    value->setProperty(
        "developmentAliasMode", developmentAliasMode);
    value->setProperty(
        "futureVersionMode", futureVersionMode);
    value->setProperty(
        "fractionalVersionMode", fractionalVersionMode);
    value->setProperty(
        "nestedLegacyMode", nestedLegacyMode);
    value->setProperty(
        "nestedCurrentMode", nestedCurrentMode);
    value->setProperty(
        "nestedDevelopmentAliasMode",
        nestedDevelopmentAliasMode);
    value->setProperty(
        "digitalLowPassHz", digital.lowPassHz);
    value->setProperty(
        "tapeLowPassHz", tape.lowPassHz);
    value->setProperty(
        "analogLowPassHz", analog.lowPassHz);
    value->setProperty(
        "bassTapeHighPassHz", bassTape.highPassHz);
    value->setProperty(
        "guitarTapeHighPassHz", tape.highPassHz);
    value->setProperty(
        "pass",
        syncResolverPassed
            && macroContractPassed
            && stateContractPassed
            && currentStateContractPassed
            && versionMigrationContractPassed
            && saveBoundaryContractPassed);
    return juce::var(value);
}

juce::var NAMDelayRegression::runDelayV10AudioProbe()
{
    const auto configureDelay = [] (
        S13Delay& delay,
        const S13NAMRack::DelayMacroState& state)
    {
        delay.setExtendedModesEnabled(true);
        delay.delayTimeL.store(state.timeMsL);
        delay.delayTimeR.store(state.timeMsR);
        delay.feedback.store(state.feedbackGain);
        delay.crossFeed.store(state.crossFeed);
        delay.mix.store(state.mix);
        delay.pingPong.store(state.pingPong ? 1.0f : 0.0f);
        delay.tempoSync.store(state.tempoSync ? 1.0f : 0.0f);
        delay.syncNoteL.store(
            static_cast<float>(state.sync.leftNoteIndex));
        delay.syncNoteR.store(
            static_cast<float>(state.sync.rightNoteIndex));
        delay.lpfFreq.store(state.lowPassHz);
        delay.hpfFreq.store(state.highPassHz);
        delay.fbSaturation.store(state.saturation);
        delay.stereoWidth.store(state.stereoWidth);
        delay.delayMode.store(static_cast<float>(state.mode));
        delay.ducking.store(state.duckAmount);
        delay.wowDepthMs.store(state.wowDepthMs);
        delay.wowRateHz.store(state.wowRateHz);
        delay.flutterDepthMs.store(state.flutterDepthMs);
        delay.flutterRateHz.store(state.flutterRateHz);
        delay.duckAttackMs.store(state.duckAttackMs);
        delay.duckReleaseMs.store(state.duckReleaseMs);
        delay.duckMaxReduction.store(state.duckMaxReduction);
        delay.topologyControl.store(state.topologyControl);
        delay.multiFeedback.store(state.multiFeedbackGain);
        delay.dualTimeRatio.store(state.dualTimeRatio);
        delay.dualFeedback.store(state.dualFeedbackGain);
        delay.dualLowPassHz.store(state.dualLowPassHz);
        delay.dualHighPassHz.store(state.dualHighPassHz);
        delay.dualSaturation.store(state.dualSaturation);
        delay.dualModDepthMs.store(state.dualModDepthMs);
        delay.dualModRateHz.store(state.dualModRateHz);
        delay.inputSend.store(1.0f);
        delay.unityDry.store(
            state.dryGain >= 0.9999f ? 1.0f : 0.0f);
    };

    juce::Array<juce::var> timingCases;
    bool timingPassed = true;
    for (const double sampleRate :
         { 44100.0, 48000.0, 96000.0 })
    {
        constexpr float requestedDelayMs = 125.0f;
        const int totalSamples = juce::roundToInt(
            sampleRate * 0.16);
        const int expectedSample = juce::roundToInt(
            sampleRate
            * static_cast<double>(requestedDelayMs)
            * 0.001);
        S13Delay delay(0.25f);
        const auto state =
            S13NAMRack::resolveDelayMacroState(
                requestedDelayMs, 0.0f, 1.0f,
                0.0f, 0.0f, 0.0f,
                0.0f, 0.0f,
                S13NAMRack::guitarInstrumentProfile);
        configureDelay(delay, state);
        delay.prepareToPlay(sampleRate, 64);

        constexpr std::array<int, 6> pattern {
            7, 31, 5, 64, 13, 47
        };
        int cursor = 0;
        int patternIndex = 0;
        int peakSample = -1;
        float peak = 0.0f;
        double absoluteWetSum = 0.0;
        bool finite = true;
        juce::MidiBuffer midi;
        while (cursor < totalSamples)
        {
            const int blockSize = juce::jmin(
                pattern[static_cast<size_t>(
                    patternIndex % pattern.size())],
                totalSamples - cursor);
            juce::AudioBuffer<float> block(2, blockSize);
            block.clear();
            if (cursor == 0)
            {
                block.setSample(0, 0, 1.0f);
                block.setSample(1, 0, 1.0f);
            }
            delay.processBlock(block, midi);
            for (int sample = 0; sample < blockSize; ++sample)
            {
                const float output =
                    block.getSample(0, sample);
                finite = finite && std::isfinite(output);
                absoluteWetSum += std::abs(
                    static_cast<double>(output));
                if (std::abs(output) > peak)
                {
                    peak = std::abs(output);
                    peakSample = cursor + sample;
                }
            }
            cursor += blockSize;
            ++patternIndex;
        }
        const int timingErrorSamples =
            peakSample >= 0
                ? std::abs(peakSample - expectedSample)
                : totalSamples;
        const bool casePassed =
            finite
            // A fractional linear-interpolation tap can split a unity
            // impulse evenly across its two neighbouring samples. Directly
            // after reset, the complete-history guard intentionally rejects
            // the earlier half until both interpolation samples are valid;
            // the surviving half is the correct first-repeat oracle here.
            && absoluteWetSum > 0.49
            && peak > 0.45f
            && timingErrorSamples <= 2;
        timingPassed = timingPassed && casePassed;

        auto* value = new juce::DynamicObject();
        value->setProperty("sampleRate", sampleRate);
        value->setProperty(
            "expectedSample", expectedSample);
        value->setProperty("peakSample", peakSample);
        value->setProperty(
            "timingErrorSamples", timingErrorSamples);
        value->setProperty("peak", peak);
        value->setProperty(
            "absoluteWetSum", absoluteWetSum);
        value->setProperty("pass", casePassed);
        timingCases.add(juce::var(value));
    }

    constexpr double renderSampleRate = 48000.0;
    constexpr int maximumBlockSize = 64;
    constexpr int renderSamples = 24000;
    const auto renderMode = [
        &configureDelay,
        renderSampleRate,
        maximumBlockSize,
        renderSamples] (
        int mode,
        const std::array<int, 6>& blockPattern)
    {
        S13Delay delay(1.0f);
        const auto state =
            S13NAMRack::resolveDelayMacroState(
                37.0f, 0.62f, 1.0f,
                0.80f, 0.0f,
                static_cast<float>(mode),
                1.0f, 0.0f,
                S13NAMRack::guitarInstrumentProfile);
        configureDelay(delay, state);
        delay.prepareToPlay(
            renderSampleRate, maximumBlockSize);

        juce::AudioBuffer<float> capture(
            2, renderSamples);
        capture.clear();
        juce::MidiBuffer midi;
        int cursor = 0;
        int patternIndex = 0;
        while (cursor < renderSamples)
        {
            const int blockSize = juce::jmin(
                blockPattern[static_cast<size_t>(
                    patternIndex % blockPattern.size())],
                renderSamples - cursor);
            juce::AudioBuffer<float> block(2, blockSize);
            for (int sample = 0; sample < blockSize; ++sample)
            {
                const int absoluteSample = cursor + sample;
                const double time =
                    static_cast<double>(absoluteSample)
                    / renderSampleRate;
                const float transient =
                    absoluteSample % 1601 == 0
                        ? 0.32f
                        : 0.0f;
                const float left = transient
                    + 0.12f * static_cast<float>(std::sin(
                        juce::MathConstants<double>::twoPi
                        * 173.0 * time))
                    + 0.07f * static_cast<float>(std::sin(
                        juce::MathConstants<double>::twoPi
                        * 3191.0 * time + 0.23));
                const float right = -0.70f * transient
                    + 0.10f * static_cast<float>(std::sin(
                        juce::MathConstants<double>::twoPi
                        * 241.0 * time + 0.47))
                    + 0.06f * static_cast<float>(std::sin(
                        juce::MathConstants<double>::twoPi
                        * 5117.0 * time + 0.91));
                block.setSample(0, sample, left);
                block.setSample(1, sample, right);
            }
            delay.processBlock(block, midi);
            capture.copyFrom(
                0, cursor, block, 0, 0, blockSize);
            capture.copyFrom(
                1, cursor, block, 1, 0, blockSize);
            cursor += blockSize;
            ++patternIndex;
        }
        return capture;
    };
    constexpr std::array<int, 6> uniformPattern {
        64, 64, 64, 64, 64, 64
    };
    constexpr std::array<int, 6> irregularPattern {
        7, 31, 5, 64, 13, 47
    };
    const auto tapeUniform = renderMode(
        S13NAMRack::tapeDelayMode, uniformPattern);
    const auto tapeIrregular = renderMode(
        S13NAMRack::tapeDelayMode, irregularPattern);
    const auto digital = renderMode(
        S13NAMRack::digitalDelayMode, irregularPattern);
    const auto analog = renderMode(
        S13NAMRack::analogDelayMode, irregularPattern);
    const auto multiUniform = renderMode(
        S13NAMRack::multiDelayMode, uniformPattern);
    const auto multiIrregular = renderMode(
        S13NAMRack::multiDelayMode, irregularPattern);
    const auto dualUniform = renderMode(
        S13NAMRack::dualDelayMode, uniformPattern);
    const auto dualIrregular = renderMode(
        S13NAMRack::dualDelayMode, irregularPattern);
    const auto maximumDifference = [] (
        const juce::AudioBuffer<float>& first,
        const juce::AudioBuffer<float>& second)
    {
        float maximum = 0.0f;
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0;
                 sample < first.getNumSamples();
                 ++sample)
                maximum = juce::jmax(
                    maximum,
                    std::abs(
                        first.getSample(channel, sample)
                        - second.getSample(channel, sample)));
        return maximum;
    };
    const auto differenceRms = [] (
        const juce::AudioBuffer<float>& first,
        const juce::AudioBuffer<float>& second)
    {
        double energy = 0.0;
        int count = 0;
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int sample = 0;
                 sample < first.getNumSamples();
                 ++sample)
            {
                const double difference =
                    static_cast<double>(
                        first.getSample(channel, sample))
                    - static_cast<double>(
                        second.getSample(channel, sample));
                energy += difference * difference;
                ++count;
            }
        }
        return count > 0
            ? std::sqrt(energy / static_cast<double>(count))
            : 0.0;
    };
    const auto bufferIsFinite = [] (
        const juce::AudioBuffer<float>& capture)
    {
        for (int channel = 0;
             channel < capture.getNumChannels();
             ++channel)
            for (int sample = 0;
                 sample < capture.getNumSamples();
                 ++sample)
                if (! std::isfinite(
                        capture.getSample(channel, sample)))
                    return false;
        return true;
    };
    const float partitionMaximumDifference =
        maximumDifference(tapeUniform, tapeIrregular);
    const float multiPartitionMaximumDifference =
        maximumDifference(multiUniform, multiIrregular);
    const float dualPartitionMaximumDifference =
        maximumDifference(dualUniform, dualIrregular);
    const double digitalTapeDifference =
        differenceRms(digital, tapeIrregular);
    const double tapeAnalogDifference =
        differenceRms(tapeIrregular, analog);
    const double digitalAnalogDifference =
        differenceRms(digital, analog);
    const double multiDualDifference =
        differenceRms(multiIrregular, dualIrregular);
    const double tapeMultiDifference =
        differenceRms(tapeIrregular, multiIrregular);
    const bool partitionAndDistinctnessPassed =
        bufferIsFinite(tapeUniform)
        && bufferIsFinite(tapeIrregular)
        && bufferIsFinite(digital)
        && bufferIsFinite(analog)
        && bufferIsFinite(multiUniform)
        && bufferIsFinite(multiIrregular)
        && bufferIsFinite(dualUniform)
        && bufferIsFinite(dualIrregular)
        && partitionMaximumDifference <= 2.0e-6f
        && multiPartitionMaximumDifference <= 2.0e-6f
        && dualPartitionMaximumDifference <= 2.0e-6f
        && digitalTapeDifference > 1.0e-4
        && tapeAnalogDifference > 1.0e-4
        && digitalAnalogDifference > 1.0e-4
        && multiDualDifference > 1.0e-4
        && tapeMultiDifference > 1.0e-4;

    juce::Array<juce::var> tailCases;
    bool tailContractPassed = true;
    for (int mode = S13NAMRack::digitalDelayMode;
         mode <= S13NAMRack::dualDelayMode;
         ++mode)
    {
        S13Delay delay(3.0f);
        const auto state =
            S13NAMRack::resolveDelayMacroState(
                360.0f, 0.55f, 0.35f,
                0.80f, 0.0f,
                static_cast<float>(mode),
                1.0f, 0.0f,
                S13NAMRack::guitarInstrumentProfile);
        configureDelay(delay, state);
        delay.prepareToPlay(44100.0, 64);
        double maximumFeedback = static_cast<double>(state.feedbackGain);
        if (mode == S13NAMRack::multiDelayMode)
        {
            maximumFeedback = juce::jmax(
                maximumFeedback,
                static_cast<double>(state.multiFeedbackGain));
        }
        else if (mode == S13NAMRack::dualDelayMode)
        {
            maximumFeedback = juce::jmax(
                maximumFeedback,
                static_cast<double>(state.dualFeedbackGain));
        }
        const double repeatsToMinus60 =
            std::log(
                0.001
                / juce::jmax(
                    1.0,
                    static_cast<double>(state.stereoWidth)))
            / std::log(maximumFeedback);
        double maximumModulationMs = static_cast<double>(
            state.wowDepthMs + state.flutterDepthMs);
        if (mode == S13NAMRack::dualDelayMode)
        {
            maximumModulationMs = juce::jmax(
                maximumModulationMs,
                static_cast<double>(state.dualModDepthMs));
        }
        const double expectedTailSeconds =
            ((static_cast<double>(juce::jmax(
                  state.timeMsL, state.timeMsR))
              + maximumModulationMs)
                 * 0.001
             + 1.0 / 44100.0)
            * juce::jmax(1.0, repeatsToMinus60 + 1.0);
        const double reportedTailSeconds =
            delay.getTailLengthSeconds();
        const bool casePassed =
            std::isfinite(reportedTailSeconds)
            && reportedTailSeconds > 0.0
            && std::abs(
                   reportedTailSeconds
                   - expectedTailSeconds) <= 1.0e-5;
        tailContractPassed =
            tailContractPassed && casePassed;

        auto* value = new juce::DynamicObject();
        value->setProperty("mode", mode);
        value->setProperty(
            "reportedTailSeconds", reportedTailSeconds);
        value->setProperty(
            "expectedTailSeconds", expectedTailSeconds);
        value->setProperty("pass", casePassed);
        tailCases.add(juce::var(value));
    }

    // Use an integral one-millisecond tap. At 44.1 kHz the separate complete-
    // interpolation-history guard intentionally rejects the first fractional
    // lobe, which makes its excitation peak unsuitable as a width oracle.
    constexpr double widthTailSampleRate = 48000.0;
    constexpr int widthTailBlockSize = 64;
    constexpr float widthTailFeedback = 0.80f;
    constexpr float widthTailDelayMs = 1.0f;
    S13Delay widthTailDelay(3.0f);
    auto widthTailState = S13NAMRack::resolveDelayMacroState(
        widthTailDelayMs,
        widthTailFeedback,
        1.0f,
        0.0f,
        0.0f,
        static_cast<float>(S13NAMRack::digitalDelayMode),
        0.0f,
        0.0f,
        S13NAMRack::guitarInstrumentProfile);
    widthTailState.stereoWidth = 2.0f;
    widthTailState.lowPassHz = 20000.0f;
    widthTailState.highPassHz = 20.0f;
    widthTailState.saturation = 0.0f;
    configureDelay(widthTailDelay, widthTailState);
    widthTailDelay.prepareToPlay(
        widthTailSampleRate, widthTailBlockSize);
    const double widthAwareExpectedTailSeconds =
        (static_cast<double>(widthTailDelayMs) * 0.001
             + 1.0 / widthTailSampleRate)
        * (std::log(0.001 / 2.0)
               / std::log(static_cast<double>(widthTailFeedback))
           + 1.0);
    const double widthAwareReportedTailSeconds =
        widthTailDelay.getTailLengthSeconds();
    const int widthTailDeclaredSamples = static_cast<int>(std::ceil(
        widthAwareReportedTailSeconds * widthTailSampleRate));
    const int widthTailRenderSamples =
        widthTailDeclaredSamples
        + juce::roundToInt(
            widthTailSampleRate
            * static_cast<double>(widthTailDelayMs) * 0.002);
    float widthTailPeak = 0.0f;
    float widthTailPostDeclarationPeak = 0.0f;
    juce::MidiBuffer widthTailMidi;
    for (int cursor = 0;
         cursor < widthTailRenderSamples;
         cursor += widthTailBlockSize)
    {
        const int blockSamples = juce::jmin(
            widthTailBlockSize,
            widthTailRenderSamples - cursor);
        juce::AudioBuffer<float> block(2, blockSamples);
        block.clear();
        if (cursor == 0)
        {
            block.setSample(0, 0, 1.0f);
            block.setSample(1, 0, -1.0f);
        }
        widthTailDelay.processBlock(block, widthTailMidi);
        for (int sample = 0; sample < blockSamples; ++sample)
        {
            const float samplePeak = juce::jmax(
                std::abs(block.getSample(0, sample)),
                std::abs(block.getSample(1, sample)));
            widthTailPeak = juce::jmax(widthTailPeak, samplePeak);
            if (cursor + sample >= widthTailDeclaredSamples)
            {
                widthTailPostDeclarationPeak = juce::jmax(
                    widthTailPostDeclarationPeak, samplePeak);
            }
        }
    }
    const bool widthAwareTailPassed =
        std::abs(
            widthAwareReportedTailSeconds
            - widthAwareExpectedTailSeconds) <= 1.0e-5
        && widthTailPeak >= 0.25f
        && widthTailPostDeclarationPeak <= 0.00105f;

    auto* value = new juce::DynamicObject();
    value->setProperty("timingCases", timingCases);
    value->setProperty(
        "partitionMaximumDifference",
        partitionMaximumDifference);
    value->setProperty(
        "multiPartitionMaximumDifference",
        multiPartitionMaximumDifference);
    value->setProperty(
        "dualPartitionMaximumDifference",
        dualPartitionMaximumDifference);
    value->setProperty(
        "digitalTapeDifferenceRms",
        digitalTapeDifference);
    value->setProperty(
        "tapeAnalogDifferenceRms",
        tapeAnalogDifference);
    value->setProperty(
        "digitalAnalogDifferenceRms",
        digitalAnalogDifference);
    value->setProperty(
        "multiDualDifferenceRms",
        multiDualDifference);
    value->setProperty(
        "tapeMultiDifferenceRms",
        tapeMultiDifference);
    value->setProperty("tailCases", tailCases);
    value->setProperty(
        "widthAwareExpectedTailSeconds",
        widthAwareExpectedTailSeconds);
    value->setProperty(
        "widthAwareReportedTailSeconds",
        widthAwareReportedTailSeconds);
    value->setProperty(
        "widthTailPostDeclarationPeak",
        widthTailPostDeclarationPeak);
    value->setProperty("widthTailPeak", widthTailPeak);
    value->setProperty(
        "widthAwareTailPassed", widthAwareTailPassed);
    value->setProperty(
        "pass",
        timingPassed
            && partitionAndDistinctnessPassed
            && tailContractPassed
            && widthAwareTailPassed);
    return juce::var(value);
}

juce::var NAMDelayRegression::runDelayV10Stage3TopologyProbe()
{
    constexpr int topologyBlockSize = 64;
    constexpr std::array<int, 4> multiRatioNumerators {
        43, 61, 79, 100
    };
    constexpr std::array<float, 4> multiWeights {
        0.13f, 0.20f, 0.25f, 0.42f
    };
    constexpr std::array<int, 4> multiStereoChannels {
        1, 0, 1, 0
    };

    const auto configureExactDelay = [] (
        S13Delay& delay,
        double sampleRate,
        int baseDelaySamples,
        int mode,
        float secondaryFeedback)
    {
        const float delayMs = static_cast<float>(
            static_cast<double>(baseDelaySamples)
            * 1000.0 / sampleRate);
        delay.setExtendedModesEnabled(true);
        delay.delayTimeL.store(delayMs);
        delay.delayTimeR.store(delayMs);
        delay.feedback.store(0.0f);
        delay.crossFeed.store(0.0f);
        delay.mix.store(1.0f);
        delay.pingPong.store(0.0f);
        delay.tempoSync.store(0.0f);
        delay.syncNoteL.store(2.0f);
        delay.syncNoteR.store(2.0f);
        delay.lpfFreq.store(20000.0f);
        delay.hpfFreq.store(20.0f);
        delay.fbSaturation.store(0.0f);
        delay.stereoWidth.store(1.0f);
        delay.delayMode.store(static_cast<float>(mode));
        delay.ducking.store(0.0f);
        delay.wowDepthMs.store(0.0f);
        delay.wowRateHz.store(0.25f);
        delay.flutterDepthMs.store(0.0f);
        delay.flutterRateHz.store(6.4f);
        delay.duckAttackMs.store(8.0f);
        delay.duckReleaseMs.store(180.0f);
        delay.duckMaxReduction.store(0.82f);
        delay.topologyControl.store(0.0f);
        delay.multiFeedback.store(0.0f);
        delay.dualTimeRatio.store(0.5f);
        delay.dualFeedback.store(secondaryFeedback);
        delay.dualLowPassHz.store(20000.0f);
        delay.dualHighPassHz.store(20.0f);
        delay.dualSaturation.store(0.0f);
        delay.dualModDepthMs.store(0.0f);
        delay.dualModRateHz.store(0.25f);
        delay.inputSend.store(1.0f);
        delay.unityDry.store(0.0f);
    };

    const auto renderImpulse = [&configureExactDelay] (
        double sampleRate,
        int baseDelaySamples,
        int mode,
        int numChannels,
        int rightImpulseSample,
        float secondaryFeedback,
        int totalSamples)
    {
        constexpr int blockSize = 64;
        S13Delay delay(0.5f);
        configureExactDelay(
            delay,
            sampleRate,
            baseDelaySamples,
            mode,
            secondaryFeedback);
        delay.prepareToPlay(sampleRate, blockSize);

        juce::AudioBuffer<float> capture(
            numChannels, totalSamples);
        capture.clear();
        juce::MidiBuffer midi;
        int cursor = 0;
        while (cursor < totalSamples)
        {
            const int blockSamples = juce::jmin(
                blockSize, totalSamples - cursor);
            juce::AudioBuffer<float> block(
                numChannels, blockSamples);
            block.clear();
            if (cursor == 0)
                block.setSample(0, 0, 1.0f);
            if (numChannels > 1
                && rightImpulseSample >= cursor
                && rightImpulseSample < cursor + blockSamples)
            {
                block.setSample(
                    1,
                    rightImpulseSample - cursor,
                    1.0f);
            }
            delay.processBlock(block, midi);
            for (int channel = 0;
                 channel < numChannels;
                 ++channel)
            {
                capture.copyFrom(
                    channel,
                    cursor,
                    block,
                    channel,
                    0,
                    blockSamples);
            }
            cursor += blockSamples;
        }
        return capture;
    };

    const auto windowPeak = [] (
        const juce::AudioBuffer<float>& capture,
        int channel,
        int centreSample,
        int radius)
    {
        float peak = 0.0f;
        for (int sample = juce::jmax(0, centreSample - radius);
             sample <= juce::jmin(
                 capture.getNumSamples() - 1,
                 centreSample + radius);
             ++sample)
        {
            peak = juce::jmax(
                peak,
                std::abs(capture.getSample(channel, sample)));
        }
        return peak;
    };

    const auto captureIsFinite = [] (
        const juce::AudioBuffer<float>& capture)
    {
        for (int channel = 0;
             channel < capture.getNumChannels();
             ++channel)
        {
            for (int sample = 0;
                 sample < capture.getNumSamples();
                 ++sample)
            {
                if (! std::isfinite(
                        capture.getSample(channel, sample)))
                {
                    return false;
                }
            }
        }
        return true;
    };

    bool exactTopologyPassed = true;
    juce::Array<juce::var> exactRateCases;
    constexpr std::array<double, 3> topologySampleRates {
        44100.0, 48000.0, 96000.0
    };
    constexpr std::array<int, 3> exactBaseDelaySamples {
        4400, 4800, 9600
    };
    for (size_t rateIndex = 0;
         rateIndex < topologySampleRates.size();
         ++rateIndex)
    {
        const double sampleRate = topologySampleRates[rateIndex];
        const int baseDelaySamples =
            exactBaseDelaySamples[rateIndex];
        const int rightImpulseOffset = baseDelaySamples / 20;
        const int totalSamples =
            baseDelaySamples + rightImpulseOffset + 16;
        const auto multiStereo = renderImpulse(
            sampleRate,
            baseDelaySamples,
            S13NAMRack::multiDelayMode,
            2,
            -1,
            0.0f,
            totalSamples);
        const auto multiMono = renderImpulse(
            sampleRate,
            baseDelaySamples,
            S13NAMRack::multiDelayMode,
            1,
            -1,
            0.0f,
            totalSamples);
        const auto dualStereo = renderImpulse(
            sampleRate,
            baseDelaySamples,
            S13NAMRack::dualDelayMode,
            2,
            rightImpulseOffset,
            0.0f,
            totalSamples);

        bool multiStereoPassed =
            captureIsFinite(multiStereo);
        bool multiMonoPassed = captureIsFinite(multiMono);
        float multiMonoAbsoluteSum = 0.0f;
        float multiStereoAbsoluteSum = 0.0f;
        float maximumMultiWeightError = 0.0f;
        float maximumMultiWrongChannelPeak = 0.0f;
        for (size_t tap = 0;
             tap < multiRatioNumerators.size();
             ++tap)
        {
            const int tapSample =
                baseDelaySamples
                * multiRatioNumerators[tap] / 100;
            const int stereoChannel =
                multiStereoChannels[tap];
            const float stereoPeak = windowPeak(
                multiStereo, stereoChannel, tapSample, 2);
            const float wrongChannelPeak = windowPeak(
                multiStereo,
                1 - stereoChannel,
                tapSample,
                2);
            const float monoPeak = windowPeak(
                multiMono, 0, tapSample, 2);
            maximumMultiWeightError = juce::jmax(
                maximumMultiWeightError,
                juce::jmax(
                    std::abs(stereoPeak - multiWeights[tap]),
                    std::abs(monoPeak - multiWeights[tap])));
            maximumMultiWrongChannelPeak = juce::jmax(
                maximumMultiWrongChannelPeak,
                wrongChannelPeak);
            multiStereoPassed = multiStereoPassed
                && std::abs(stereoPeak - multiWeights[tap])
                    <= 1.0e-4f
                && wrongChannelPeak <= 1.0e-6f;
            multiMonoPassed = multiMonoPassed
                && std::abs(monoPeak - multiWeights[tap])
                    <= 1.0e-4f;
        }
        for (int sample = 0;
             sample < multiMono.getNumSamples();
             ++sample)
        {
            multiMonoAbsoluteSum += std::abs(
                multiMono.getSample(0, sample));
            multiStereoAbsoluteSum += std::abs(
                multiStereo.getSample(0, sample));
            multiStereoAbsoluteSum += std::abs(
                multiStereo.getSample(1, sample));
        }
        multiMonoPassed = multiMonoPassed
            && std::abs(multiMonoAbsoluteSum - 1.0f)
                <= 5.0e-4f;
        multiStereoPassed = multiStereoPassed
            && std::abs(multiStereoAbsoluteSum - 1.0f)
                <= 5.0e-4f;

        const int secondaryLeftSample = baseDelaySamples / 2;
        const int secondaryRightSample =
            secondaryLeftSample + rightImpulseOffset;
        const int primaryLeftSample = baseDelaySamples;
        const int primaryRightSample =
            primaryLeftSample + rightImpulseOffset;
        const float secondaryLeftPeak = windowPeak(
            dualStereo, 0, secondaryLeftSample, 2);
        const float secondaryLeftWrongChannel = windowPeak(
            dualStereo, 1, secondaryLeftSample, 2);
        const float secondaryRightPeak = windowPeak(
            dualStereo, 1, secondaryRightSample, 2);
        const float secondaryRightWrongChannel = windowPeak(
            dualStereo, 0, secondaryRightSample, 2);
        const float primaryLeftPeak = windowPeak(
            dualStereo, 0, primaryLeftSample, 2);
        const float primaryLeftWrongChannel = windowPeak(
            dualStereo, 1, primaryLeftSample, 2);
        const float primaryRightPeak = windowPeak(
            dualStereo, 1, primaryRightSample, 2);
        const float primaryRightWrongChannel = windowPeak(
            dualStereo, 0, primaryRightSample, 2);
        float dualAbsoluteSum = 0.0f;
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int sample = 0;
                 sample < dualStereo.getNumSamples();
                 ++sample)
            {
                dualAbsoluteSum += std::abs(
                    dualStereo.getSample(channel, sample));
            }
        }
        const bool dualIndependentPassed =
            captureIsFinite(dualStereo)
            && std::abs(secondaryLeftPeak - 0.35f)
                <= 1.0e-4f
            && std::abs(secondaryRightPeak - 0.35f)
                <= 1.0e-4f
            && std::abs(primaryLeftPeak - 0.65f)
                <= 1.0e-4f
            && std::abs(primaryRightPeak - 0.65f)
                <= 1.0e-4f
            && secondaryLeftWrongChannel <= 1.0e-6f
            && secondaryRightWrongChannel <= 1.0e-6f
            && primaryLeftWrongChannel <= 1.0e-6f
            && primaryRightWrongChannel <= 1.0e-6f
            && std::abs(dualAbsoluteSum - 2.0f)
                <= 1.0e-3f;
        const bool casePassed =
            multiStereoPassed
            && multiMonoPassed
            && dualIndependentPassed;
        exactTopologyPassed =
            exactTopologyPassed && casePassed;

        auto* value = new juce::DynamicObject();
        value->setProperty("sampleRate", sampleRate);
        value->setProperty(
            "baseDelaySamples", baseDelaySamples);
        value->setProperty(
            "maximumMultiWeightError",
            maximumMultiWeightError);
        value->setProperty(
            "maximumMultiWrongChannelPeak",
            maximumMultiWrongChannelPeak);
        value->setProperty(
            "multiMonoAbsoluteSum",
            multiMonoAbsoluteSum);
        value->setProperty(
            "multiStereoAbsoluteSum",
            multiStereoAbsoluteSum);
        value->setProperty(
            "dualSecondaryLeftPeak",
            secondaryLeftPeak);
        value->setProperty(
            "dualSecondaryRightPeak",
            secondaryRightPeak);
        value->setProperty(
            "dualPrimaryLeftPeak",
            primaryLeftPeak);
        value->setProperty(
            "dualPrimaryRightPeak",
            primaryRightPeak);
        value->setProperty(
            "dualAbsoluteSum", dualAbsoluteSum);
        value->setProperty(
            "multiStereoPassed", multiStereoPassed);
        value->setProperty(
            "multiMonoPassed", multiMonoPassed);
        value->setProperty(
            "dualIndependentPassed", dualIndependentPassed);
        value->setProperty("pass", casePassed);
        exactRateCases.add(juce::var(value));
    }

    constexpr double primeSampleRate = 48000.0;
    constexpr int primeBaseDelaySamples = 4800;
    constexpr int primeTotalSamples = 7240;
    S13Delay recursiveDual(0.5f);
    configureExactDelay(
        recursiveDual,
        primeSampleRate,
        primeBaseDelaySamples,
        S13NAMRack::dualDelayMode,
        0.70f);
    recursiveDual.prepareToPlay(
        primeSampleRate, topologyBlockSize);
    juce::AudioBuffer<float> recursiveCapture(
        2, primeTotalSamples);
    recursiveCapture.clear();
    juce::MidiBuffer recursiveMidi;
    int recursiveCursor = 0;
    while (recursiveCursor < primeTotalSamples)
    {
        const int blockSamples = juce::jmin(
            topologyBlockSize,
            primeTotalSamples - recursiveCursor);
        juce::AudioBuffer<float> block(2, blockSamples);
        block.clear();
        if (recursiveCursor == 0)
            block.setSample(0, 0, 1.0f);
        recursiveDual.processBlock(block, recursiveMidi);
        recursiveCapture.copyFrom(
            0, recursiveCursor, block, 0, 0, blockSamples);
        recursiveCapture.copyFrom(
            1, recursiveCursor, block, 1, 0, blockSamples);
        recursiveCursor += blockSamples;
    }
    const float independentSecondaryRecursionPeak = windowPeak(
        recursiveCapture,
        0,
        3 * primeBaseDelaySamples / 2,
        8);
    const bool independentRecursionPassed =
        captureIsFinite(recursiveCapture)
        && independentSecondaryRecursionPeak > 0.02f;

    S13Delay continuouslyPrimedDual(0.5f);
    configureExactDelay(
        continuouslyPrimedDual,
        primeSampleRate,
        primeBaseDelaySamples,
        S13NAMRack::digitalDelayMode,
        0.0f);
    continuouslyPrimedDual.prepareToPlay(
        primeSampleRate, topologyBlockSize);
    juce::AudioBuffer<float> primedCapture(
        2, primeBaseDelaySamples / 2 + 16);
    primedCapture.clear();
    juce::MidiBuffer primedMidi;
    int primedCursor = 0;
    while (primedCursor < primedCapture.getNumSamples())
    {
        const int blockSamples = juce::jmin(
            topologyBlockSize,
            primedCapture.getNumSamples() - primedCursor);
        juce::AudioBuffer<float> block(2, blockSamples);
        block.clear();
        if (primedCursor == 0)
            block.setSample(0, 0, 1.0f);
        if (primedCursor == topologyBlockSize)
        {
            continuouslyPrimedDual.delayMode.store(
                static_cast<float>(S13NAMRack::dualDelayMode));
        }
        continuouslyPrimedDual.processBlock(block, primedMidi);
        primedCapture.copyFrom(
            0, primedCursor, block, 0, 0, blockSamples);
        primedCapture.copyFrom(
            1, primedCursor, block, 1, 0, blockSamples);
        primedCursor += blockSamples;
    }
    const float continuouslyPrimedSecondaryPeak = windowPeak(
        primedCapture,
        0,
        primeBaseDelaySamples / 2,
        2);
    const bool continuousPrimePassed =
        captureIsFinite(primedCapture)
        && continuouslyPrimedSecondaryPeak > 0.05f;

    const auto renderTopologyAutomation = [] (
        const std::array<int, 6>& partitions)
    {
        constexpr double sampleRate = 48000.0;
        constexpr int blockSize = 64;
        constexpr int totalSamples = 22000;
        constexpr std::array<int, 3> eventSamples {
            4096, 11264, 19456
        };
        constexpr std::array<int, 3> eventModes {
            S13NAMRack::multiDelayMode,
            S13NAMRack::dualDelayMode,
            S13NAMRack::tapeDelayMode
        };
        S13Delay delay(1.0f);
        delay.setExtendedModesEnabled(true);
        delay.delayTimeL.store(37.0f);
        delay.delayTimeR.store(43.66f);
        delay.feedback.store(0.35f);
        delay.crossFeed.store(0.12f);
        delay.mix.store(1.0f);
        delay.pingPong.store(1.0f);
        delay.tempoSync.store(0.0f);
        delay.lpfFreq.store(9200.0f);
        delay.hpfFreq.store(105.0f);
        delay.fbSaturation.store(0.22f);
        delay.stereoWidth.store(1.08f);
        delay.delayMode.store(
            static_cast<float>(S13NAMRack::digitalDelayMode));
        delay.ducking.store(0.0f);
        delay.wowDepthMs.store(0.32f);
        delay.wowRateHz.store(0.37f);
        delay.flutterDepthMs.store(0.08f);
        delay.flutterRateHz.store(6.2f);
        delay.topologyControl.store(0.60f);
        delay.multiFeedback.store(0.336f);
        delay.dualTimeRatio.store(0.80f);
        delay.dualFeedback.store(0.3122f);
        delay.dualLowPassHz.store(7000.0f);
        delay.dualHighPassHz.store(134.0f);
        delay.dualSaturation.store(0.36f);
        delay.dualModDepthMs.store(0.57f);
        delay.dualModRateHz.store(0.34f);
        delay.prepareToPlay(sampleRate, blockSize);

        juce::AudioBuffer<float> capture(2, totalSamples);
        capture.clear();
        juce::MidiBuffer midi;
        int cursor = 0;
        size_t partitionIndex = 0;
        size_t eventIndex = 0;
        while (cursor < totalSamples)
        {
            if (eventIndex < eventSamples.size()
                && cursor == eventSamples[eventIndex])
            {
                delay.delayMode.store(static_cast<float>(
                    eventModes[eventIndex]));
                ++eventIndex;
            }
            int blockSamples = juce::jmin(
                partitions[partitionIndex % partitions.size()],
                totalSamples - cursor);
            if (eventIndex < eventSamples.size()
                && cursor < eventSamples[eventIndex])
            {
                blockSamples = juce::jmin(
                    blockSamples,
                    eventSamples[eventIndex] - cursor);
            }
            juce::AudioBuffer<float> block(2, blockSamples);
            for (int sample = 0;
                 sample < blockSamples;
                 ++sample)
            {
                const int absoluteSample = cursor + sample;
                const double time =
                    static_cast<double>(absoluteSample)
                    / sampleRate;
                const float marker =
                    absoluteSample % 1291 == 0
                        ? 0.24f
                        : 0.0f;
                block.setSample(
                    0,
                    sample,
                    marker
                        + 0.08f * static_cast<float>(std::sin(
                            juce::MathConstants<double>::twoPi
                            * 181.0 * time)));
                block.setSample(
                    1,
                    sample,
                    -marker * 0.63f
                        + 0.07f * static_cast<float>(std::sin(
                            juce::MathConstants<double>::twoPi
                            * 263.0 * time + 0.41)));
            }
            delay.processBlock(block, midi);
            capture.copyFrom(
                0, cursor, block, 0, 0, blockSamples);
            capture.copyFrom(
                1, cursor, block, 1, 0, blockSamples);
            cursor += blockSamples;
            ++partitionIndex;
        }
        return capture;
    };
    constexpr std::array<int, 6> fixedPartitions {
        64, 64, 64, 64, 64, 64
    };
    constexpr std::array<int, 6> unevenPartitions {
        7, 31, 5, 64, 13, 47
    };
    const auto fixedAutomation = renderTopologyAutomation(
        fixedPartitions);
    const auto unevenAutomation = renderTopologyAutomation(
        unevenPartitions);
    float topologyPartitionDifference = 0.0f;
    float topologyAutomationPeak = 0.0f;
    for (int channel = 0; channel < 2; ++channel)
    {
        for (int sample = 0;
             sample < fixedAutomation.getNumSamples();
             ++sample)
        {
            topologyPartitionDifference = juce::jmax(
                topologyPartitionDifference,
                std::abs(
                    fixedAutomation.getSample(channel, sample)
                    - unevenAutomation.getSample(channel, sample)));
            topologyAutomationPeak = juce::jmax(
                topologyAutomationPeak,
                std::abs(fixedAutomation.getSample(channel, sample)));
        }
    }
    const bool topologyAutomationPassed =
        captureIsFinite(fixedAutomation)
        && captureIsFinite(unevenAutomation)
        && topologyPartitionDifference <= 2.0e-6f
        && topologyAutomationPeak <= 2.0f;

    S13Delay resetDual(0.5f);
    configureExactDelay(
        resetDual,
        primeSampleRate,
        primeBaseDelaySamples,
        S13NAMRack::dualDelayMode,
        0.65f);
    resetDual.prepareToPlay(
        primeSampleRate, topologyBlockSize);
    juce::MidiBuffer resetMidi;
    for (int cursor = 0;
         cursor < primeBaseDelaySamples + topologyBlockSize;
         cursor += topologyBlockSize)
    {
        juce::AudioBuffer<float> block(2, topologyBlockSize);
        block.clear();
        if (cursor == 0)
        {
            block.setSample(0, 0, 0.8f);
            block.setSample(1, 7, -0.6f);
        }
        resetDual.processBlock(block, resetMidi);
    }
    resetDual.resetTailState();
    resetDual.resetRackRuntimeMixState(0.0f, false);
    float resetStalePeak = 0.0f;
    for (int cursor = 0;
         cursor < primeBaseDelaySamples + topologyBlockSize;
         cursor += topologyBlockSize)
    {
        juce::AudioBuffer<float> block(2, topologyBlockSize);
        block.clear();
        resetDual.processBlock(block, resetMidi);
        for (int channel = 0; channel < 2; ++channel)
            resetStalePeak = juce::jmax(
                resetStalePeak,
                block.getMagnitude(channel, 0, topologyBlockSize));
    }
    resetDual.prepareToPlay(
        primeSampleRate, topologyBlockSize);
    float reprepareStalePeak = 0.0f;
    for (int cursor = 0;
         cursor < primeBaseDelaySamples + topologyBlockSize;
         cursor += topologyBlockSize)
    {
        juce::AudioBuffer<float> block(2, topologyBlockSize);
        block.clear();
        resetDual.processBlock(block, resetMidi);
        for (int channel = 0; channel < 2; ++channel)
            reprepareStalePeak = juce::jmax(
                reprepareStalePeak,
                block.getMagnitude(channel, 0, topologyBlockSize));
    }
    const bool resetAndRepreparePassed =
        resetStalePeak <= 1.0e-7f
        && reprepareStalePeak <= 1.0e-7f;

    const bool pass =
        exactTopologyPassed
        && independentRecursionPassed
        && continuousPrimePassed
        && topologyAutomationPassed
        && resetAndRepreparePassed;
    auto* value = new juce::DynamicObject();
    value->setProperty("exactRateCases", exactRateCases);
    value->setProperty(
        "independentSecondaryRecursionPeak",
        independentSecondaryRecursionPeak);
    value->setProperty(
        "continuouslyPrimedSecondaryPeak",
        continuouslyPrimedSecondaryPeak);
    value->setProperty(
        "topologyPartitionMaximumDifference",
        topologyPartitionDifference);
    value->setProperty(
        "topologyAutomationPeak",
        topologyAutomationPeak);
    value->setProperty(
        "resetStaleHistoryPeak", resetStalePeak);
    value->setProperty(
        "reprepareStaleHistoryPeak", reprepareStalePeak);
    value->setProperty(
        "exactTopologyPassed", exactTopologyPassed);
    value->setProperty(
        "independentRecursionPassed",
        independentRecursionPassed);
    value->setProperty(
        "continuousPrimePassed", continuousPrimePassed);
    value->setProperty(
        "topologyAutomationPassed",
        topologyAutomationPassed);
    value->setProperty(
        "resetAndRepreparePassed",
        resetAndRepreparePassed);
    value->setProperty("pass", pass);
    return juce::var(value);
}

juce::Array<juce::var> NAMDelayRegression::runCoreChecks()
{
    juce::Array<juce::var> checks;

    const auto delayV10ContractProbe =
        runDelayV10ContractProbe();
    addCheck(
        checks,
        "delay_v10_sync_macro_and_state_contract",
        delayV10ContractProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Delay V10 must use one monotonic three-step sync resolver, derive all Digital/Tape/Analog/Multi/Dual character and Guitar/Bass support values only from the six faceplate controls plus Instrument, canonicalize all nine saved delay fields across legacy/current/unknown and nested snapshots, preserve V9 Reverb Voice, and make migration idempotent.",
        delayV10ContractProbe);
    const auto delayV10AudioProbe =
        runDelayV10AudioProbe();
    addCheck(
        checks,
        "delay_v10_timing_partition_modes_and_tail",
        delayV10AudioProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Delay V10 must place a 125 ms manual echo within two samples at 44.1/48/96 kHz, render sample-identically across regular and irregular callback partitions, make all five modes objectively distinct, and declare each mode's exact derived -60 dB tail without hidden saved controls.",
        delayV10AudioProbe);
    const auto delayV10Stage3TopologyProbe =
        runDelayV10Stage3TopologyProbe();
    addCheck(
        checks,
        "delay_v10_multi_dual_topology_objective_matrix",
        delayV10Stage3TopologyProbe.getProperty("pass", false)
            ? "pass"
            : "fail",
        "Delay V10 Multi must render the exact four normalized alternating taps in stereo and mono at 44.1/48/96 kHz; Dual must use isolated continuously primed L/R secondary histories with independent recursion; 0-to-Multi-to-Dual-to-Tape automation must remain callback-partition invariant; and logical reset/reprepare must invalidate both histories.",
        delayV10Stage3TopologyProbe);

    return checks;
}

juce::Array<juce::var> NAMDelayRegression::run()
{
    auto checks = runCoreChecks();
    checks.addArray(runLifecycleChecks());
    checks.addArray(runRackTailChecks());
    return checks;
}
