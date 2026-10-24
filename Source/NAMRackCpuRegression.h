#pragma once

#include "BuiltInEffects2.h"
#include "RegressionMessagePump.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <numeric>
#include <random>
#include <vector>
#if JUCE_WINDOWS && JUCE_DEBUG
#include <crtdbg.h>
#endif

// Opt-in offline timing. Independent complete processors run serially as tracks
// do, but this excludes device scheduling, the host graph and WebView overhead.
// Deadline misses and levels are diagnostics, never sound-quality assertions.
namespace NAMRackCpuRegression
{
#if JUCE_WINDOWS && JUCE_DEBUG
namespace CallbackHeapProbe
{
inline thread_local bool active = false;
inline thread_local int allocations = 0, frees = 0;
inline _CRT_ALLOC_HOOK previous = nullptr;
inline int hook(int kind, void* data, size_t size, int blockType, long request, const unsigned char* file, int line)
{
    if (active)
    {
        if (kind == _HOOK_ALLOC || kind == _HOOK_REALLOC) ++allocations;
        if (kind == _HOOK_FREE) ++frees;
    }
    return previous != nullptr ? previous(kind, data, size, blockType, request, file, line) : 1;
}
}
#endif
// Frozen pre-optimization oracle. Keep its per-tap bounds/index lookup and
// scheduler independent of the production contiguous-span implementation.
template <typename Kernel, typename State>
int referenceResample(State& state, const float* input, int inputCount,
                      float* output, int capacity, const Kernel& kernel)
{
    if (input == nullptr || output == nullptr || inputCount < 0 || capacity < 0)
        return -1;
    constexpr int taps = 48, phases = 512, historySize = 128;
    const auto sampleAt = [&] (std::int64_t absoluteIndex)
    {
        if (absoluteIndex < 0 || absoluteIndex >= state.totalInputSamples) return 0.0f;
        const auto age = state.totalInputSamples - 1 - absoluteIndex;
        if (age < 0 || age >= historySize) return 0.0f;
        int index = state.writeIndex - 1 - static_cast<int>(age);
        while (index < 0) index += historySize;
        return state.history[static_cast<size_t>(index)];
    };
    int produced = 0;
    for (int sample = 0; sample < inputCount; ++sample)
    {
        state.history[static_cast<size_t>(state.writeIndex)] = std::isfinite(input[sample]) ? input[sample] : 0.0f;
        state.writeIndex = (state.writeIndex + 1) % historySize;
        ++state.totalInputSamples;
        for (;;)
        {
            if (kernel.usesExactIntegerRatePhase ? state.nextSourceWhole >= state.totalInputSamples
                : static_cast<double>(state.totalOutputSamples) * kernel.sourceStep >= static_cast<double>(state.totalInputSamples)) break;
            if (produced >= capacity) return -1;
            const double source = kernel.usesExactIntegerRatePhase
                ? static_cast<double>(state.nextSourceWhole) + static_cast<double>(state.nextSourceRemainder) * kernel.inverseSourceStepDenominator
                : static_cast<double>(state.totalOutputSamples) * kernel.sourceStep;
            const double delayed = source - taps / 2;
            const auto base = static_cast<std::int64_t>(std::floor(delayed));
            const double fraction = delayed - static_cast<double>(base);
            const int phase = juce::jlimit(0, phases - 1, static_cast<int>(fraction * phases));
            double sum = 0.0;
            for (int tap = 0; tap < taps; ++tap)
                sum += static_cast<double>(sampleAt(base + tap - (taps / 2 - 1)))
                    * static_cast<double>(kernel.coefficients[static_cast<size_t>(phase * taps + tap)]);
            output[produced++] = static_cast<float>(sum);
            ++state.totalOutputSamples;
            if (kernel.usesExactIntegerRatePhase)
            {
                state.nextSourceWhole += static_cast<std::int64_t>(kernel.sourceStepWhole);
                state.nextSourceRemainder += kernel.sourceStepRemainder;
                if (state.nextSourceRemainder >= kernel.sourceStepDenominator)
                {
                    state.nextSourceRemainder -= kernel.sourceStepDenominator;
                    ++state.nextSourceWhole;
                }
            }
        }
    }
    return produced;
}

template <typename State>
bool sameResamplerState(const State& first, const State& second)
{
    return std::memcmp(first.history.data(), second.history.data(), first.history.size() * sizeof(float)) == 0
        && first.writeIndex == second.writeIndex && first.totalInputSamples == second.totalInputSamples
        && first.totalOutputSamples == second.totalOutputSamples && first.nextSourceWhole == second.nextSourceWhole
        && first.nextSourceRemainder == second.nextSourceRemainder;
}

template <typename Kernel, typename State>
juce::var runResamplerParity()
{
    constexpr std::array<std::array<double, 2>, 8> rates {{
        {{44100, 48000}}, {{48000, 44100}}, {{48000, 48000}}, {{44100, 96000}},
        {{96000, 44100}}, {{44100.25, 48000.5}}, {{32000, 192000}}, {{192000, 8000}}
    }};
    const std::array<std::vector<int>, 4> partitions {{ {1}, {8}, {16, 31, 127, 64, 3}, {512} }};
    std::vector<float> input(4097);
    std::uint32_t random = 0x29b6c7d5u;
    for (size_t index = 0; index < input.size(); ++index)
    {
        random = random * 1664525u + 1013904223u;
        input[index] = static_cast<float>(0.18 * std::sin(static_cast<double>(index) * 0.073)
            + 0.03 * (static_cast<double>(random & 0xffffu) / 32767.5 - 1.0));
    }
    input[0] = 0.7f;
    input[17] = std::numeric_limits<float>::quiet_NaN();
    input[1999] = std::numeric_limits<float>::infinity();
    input[3000] = -std::numeric_limits<float>::infinity();
    input[4000] = -0.0f;
    bool passed = true;
    int comparedCalls = 0, comparedSamples = 0;
    juce::Array<juce::var> rows;
    for (const auto& rate : rates)
    {
        auto kernel = std::make_unique<Kernel>();
        kernel->prepare(rate[0], rate[1]);
        bool ratePassed = kernel->coefficients.size() == 48u * 512u;
        std::vector<float> canonical;
        for (size_t pattern = 0; pattern < partitions.size(); ++pattern)
        {
            State production, reference;
            ratePassed = ratePassed && production.history.size() == 128;
            for (int resetPass = 0; resetPass < 2; ++resetPass)
            {
                production.reset(); reference.reset();
                std::vector<float> captured;
                size_t cursor = 0, partition = 0;
                while (cursor < input.size())
                {
                    const int count = juce::jmin(partitions[pattern][partition++ % partitions[pattern].size()], static_cast<int>(input.size() - cursor));
                    const int capacity = static_cast<int>(std::ceil(count * rate[1] / rate[0])) + 8;
                    std::vector<float> actual(static_cast<size_t>(capacity + 4), -0.8125f), expected(actual);
                    const int got = production.process(input.data() + cursor, count, actual.data(), capacity, *kernel);
                    const int wanted = referenceResample(reference, input.data() + cursor, count, expected.data(), capacity, *kernel);
                    ratePassed = ratePassed && got == wanted && got >= 0
                        && std::memcmp(actual.data(), expected.data(), actual.size() * sizeof(float)) == 0
                        && sameResamplerState(production, reference);
                    if (got >= 0)
                    {
                        captured.insert(captured.end(), actual.begin(), actual.begin() + got);
                        comparedSamples += got;
                    }
                    ++comparedCalls;
                    cursor += static_cast<size_t>(count);
                }
                if (canonical.empty()) canonical = captured;
                ratePassed = ratePassed && canonical.size() == captured.size()
                    && std::memcmp(canonical.data(), captured.data(), captured.size() * sizeof(float)) == 0;
            }
        }
        // Capacity failures can leave a consumed input sample and a pending
        // output. Compare that exact state, canaries and subsequent recovery.
        for (int capacity : {0, 1})
        {
            State production, reference;
            std::array<float, 128> actual {}, expected {};
            actual.fill(-0.6875f); expected = actual;
            const int got = production.process(input.data(), 257, actual.data(), capacity, *kernel);
            const int wanted = referenceResample(reference, input.data(), 257, expected.data(), capacity, *kernel);
            ratePassed = ratePassed && got == -1 && wanted == -1 && actual == expected && sameResamplerState(production, reference);
            const int resumed = production.process(input.data() + 257, 7, actual.data(), 128, *kernel);
            const int expectedResumed = referenceResample(reference, input.data() + 257, 7, expected.data(), 128, *kernel);
            ratePassed = ratePassed && resumed == expectedResumed && actual == expected && sameResamplerState(production, reference);
        }
        {
            State production, reference;
            std::array<float, 8> actual {}, expected {};
            ratePassed = ratePassed && production.process(nullptr, 8, actual.data(), 8, *kernel) == -1
                && referenceResample(reference, nullptr, 8, expected.data(), 8, *kernel) == -1
                && production.process(input.data(), 8, nullptr, 8, *kernel) == -1
                && production.process(input.data(), -1, actual.data(), 8, *kernel) == -1
                && production.process(input.data(), 8, actual.data(), -1, *kernel) == -1
                && sameResamplerState(production, reference);
        }
        passed = passed && ratePassed;
        auto* row = new juce::DynamicObject();
        row->setProperty("inputRate", rate[0]); row->setProperty("outputRate", rate[1]);
        row->setProperty("usesExactIntegerRatePhase", kernel->usesExactIntegerRatePhase);
        row->setProperty("pass", ratePassed); rows.add(row);
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("pass", passed); result->setProperty("rates", rows);
    result->setProperty("comparedCalls", comparedCalls); result->setProperty("comparedSamples", comparedSamples);
    result->setProperty("comparison", "Bit-exact pre-optimization reference output, full output canaries, ring history/cursors and phase; four partitions and two reset passes per rate, including nonfinite input, startup, wrap and capacity-failure recovery.");
    return result;
}

inline void addCheck(juce::Array<juce::var>& checks, const char* id,
                     const char* status, const juce::String& detail,
                     const juce::var& value = {})
{
    auto* check = new juce::DynamicObject();
    check->setProperty("id", id);
    check->setProperty("status", status);
    check->setProperty("detail", detail);
    if (!value.isVoid()) check->setProperty("value", value);
    checks.add(check);
}

template <typename ProcessStage, typename ReadState>
juce::var runInactiveDelayParity(ProcessStage processStage, ReadState readState)
{
    bool passed = true;
    juce::Array<juce::var> rows;
    const auto configure = [] (OpenStudioNAMRack& rack, int profile)
    {
        rack.instrumentProfile.store(static_cast<float>(profile));
        rack.delayTimeMs.store(7.0f); rack.delayFeedback.store(0.15f);
        rack.delayMix.store(0.4f); rack.delayMod.store(0.3f);
        rack.delayDucker.store(0.0f); rack.delayMode.store(0.0f);
        rack.delayPingPong.store(0.0f); rack.delayTempoSync.store(0.0f);
    };
    const auto sameAudio = [] (const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
    {
        if (a.getNumSamples() != b.getNumSamples()) return false;
        for (int channel = 0; channel < 2; ++channel)
            if (std::memcmp(a.getReadPointer(channel), b.getReadPointer(channel), static_cast<size_t>(a.getNumSamples()) * sizeof(float)) != 0) return false;
        return true;
    };
    for (double rate : {44100.0, 48000.0, 96000.0}) for (int profile : {0, 1})
    {
        auto dormant = std::make_unique<OpenStudioNAMRack>();
        dormant->delayEnabled.store(0.0f);
        dormant->prepareToPlay(rate, 128);
        juce::AudioBuffer<float> block(2, 128), expected(2, 128);
        juce::MidiBuffer midi;
        bool dryExact = true;
        for (int count : {1, 8, 31, 64, 127})
        {
            block.setSize(2, count, false, false, true);
            expected.setSize(2, count, false, false, true);
            dormant->delayTimeMs.store(std::numeric_limits<float>::quiet_NaN());
            dormant->delayMix.store(0.9f); dormant->delayMode.store(3.0f);
            for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < count; ++sample)
                block.setSample(channel, sample, (channel == 0 ? 0.17f : -0.13f) * std::sin(0.1f * sample));
            expected.makeCopyOf(block, true);
            processStage(*dormant, block, midi);
            const auto state = readState(*dormant);
            dryExact = dryExact && sameAudio(block, expected) && state[0] == 0 && state[1] == 0 && state[2] == 0;
        }
        configure(*dormant, profile);
        dormant->delayEnabled.store(1.0f);
        auto fresh = std::make_unique<OpenStudioNAMRack>();
        configure(*fresh, profile); fresh->delayEnabled.store(1.0f);
        fresh->prepareToPlay(rate, 128);
        block.setSize(2, 128, false, false, true);
        expected.setSize(2, 128, false, false, true);
        bool activationExact = true, drainExact = true, tailObserved = false;
        for (int index = 0; index < 8; ++index)
        {
            for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < 128; ++sample)
                block.setSample(channel, sample, 0.15f * std::sin(0.09f * static_cast<float>(index * 128 + sample)));
            expected.makeCopyOf(block, true);
            processStage(*dormant, block, midi); processStage(*fresh, expected, midi);
            activationExact = activationExact && sameAudio(block, expected);
        }
        const bool tailWasScheduled = readState(*dormant)[0] > 0;
        dormant->delayEnabled.store(0.0f); fresh->delayEnabled.store(0.0f);
        for (int sample = 0; sample < static_cast<int>(rate * 0.5); sample += 128)
        {
            block.clear(); expected.clear();
            processStage(*dormant, block, midi); processStage(*fresh, expected, midi);
            drainExact = drainExact && sameAudio(block, expected) && readState(*dormant) == readState(*fresh);
            tailObserved = tailObserved || block.getMagnitude(0, 128) > 1.0e-8f;
        }
        const bool tailCompleted = readState(*dormant)[0] == 0 && readState(*dormant)[1] == 0;
        const bool okay = dryExact && activationExact && drainExact && tailWasScheduled && tailObserved && tailCompleted;
        passed = passed && okay;
        auto* row = new juce::DynamicObject();
        row->setProperty("sampleRate", rate); row->setProperty("instrumentProfile", profile);
        row->setProperty("disabledDryExact", dryExact); row->setProperty("offEditsActivateLikeFresh", activationExact);
        row->setProperty("tailDrainExact", drainExact); row->setProperty("tailObserved", tailObserved);
        row->setProperty("tailCompleted", tailCompleted); row->setProperty("pass", okay); rows.add(row);
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("pass", passed); result->setProperty("cases", rows);
    result->setProperty("comparison", "Exact disabled dry output and zero-tail bookkeeping, followed by off-edited engagement and retained-tail drain matching a fresh processor with the selected settings. No subjective audio assertion.");
    return result;
}

template <typename Invalidate>
juce::var runDriveCacheParity(Invalidate invalidate)
{
    bool passed = true;
    juce::Array<juce::var> rows;
    for (int factor : {2, 4, 8}) for (int profile : {0, 1}) for (int channels : {1, 2})
    {
        auto cached = std::make_unique<OpenStudioNAMRack>();
        auto reference = std::make_unique<OpenStudioNAMRack>();
        for (double rate : {44100.0, 48000.0, 96000.0, 44100.0})
        {
            for (auto* rack : {cached.get(), reference.get()})
            {
                rack->instrumentProfile.store(static_cast<float>(profile));
                rack->setEmbeddedDriveOversamplingFactor(factor);
                rack->setRoutedInputChannelCount(channels);
                rack->ampEnabled.store(0); rack->pedalMix.store(0); rack->setCabRequestedEnabled(false);
                rack->compressorEnabled.store(0); rack->octaverEnabled.store(0); rack->fuzzEnabled.store(0);
                rack->preEqEnabled.store(0); rack->eqEnabled.store(0); rack->modulatorEnabled.store(0);
                rack->delayEnabled.store(0); rack->reverbEnabled.store(0); rack->gateThresholdDb.store(-100);
                rack->precisionDriveEnabled.store(1); rack->chaosEnabled.store(1);
                rack->precisionDriveVoice.store(0); rack->precisionDriveDrive.store(0.3f);
                rack->precisionDriveVolumeDb.store(0); rack->precisionDriveGate.store(0);
                rack->chaosDrive.store(0.4f); rack->chaosMode.store(0); rack->chaosGate.store(0);
                rack->calibrationReferenceDbu.store(12);
                rack->setPlayConfigDetails(channels, channels, rate, 512);
                rack->prepareToPlay(rate, 512); rack->reset();
            }
            juce::AudioBuffer<float> actual(channels, 512), expected(channels, 512);
            juce::MidiBuffer midi;
            constexpr std::array<int, 5> partitions {1, 7, 31, 128, 512};
            struct SingleControlEdit
            {
                const char* id;
                std::atomic<float> OpenStudioNAMRack::* control;
                float value;
            };
            // Follow the original simultaneous-control/lifecycle sequence with
            // isolated changes. A missing cache-key dependency must fail even
            // when every other key is held constant.
            const std::array<SingleControlEdit, 19> isolatedEdits {{
                {"precisionDriveDrive", &OpenStudioNAMRack::precisionDriveDrive, 0.47f},
                {"precisionDriveAttack", &OpenStudioNAMRack::precisionDriveAttack, 0.19f},
                {"precisionDriveBright", &OpenStudioNAMRack::precisionDriveBright, 0.37f},
                {"precisionDriveVolumeDb", &OpenStudioNAMRack::precisionDriveVolumeDb, -7.0f},
                {"chaosMode", &OpenStudioNAMRack::chaosMode, 0.0f},
                {"chaosDrive", &OpenStudioNAMRack::chaosDrive, 0.29f},
                {"chaosTone", &OpenStudioNAMRack::chaosTone, 0.21f},
                {"chaosWeight", &OpenStudioNAMRack::chaosWeight, 0.28f},
                {"chaosLevelDb", &OpenStudioNAMRack::chaosLevelDb, 4.0f},
                {"calibrationReferenceDbu", &OpenStudioNAMRack::calibrationReferenceDbu, 6.0f},
                {"instrumentProfile", &OpenStudioNAMRack::instrumentProfile, static_cast<float>(profile)},
                {"legacyVoiceOn", &OpenStudioNAMRack::precisionDriveVoice, 1.0f},
                {"legacyVoiceOff", &OpenStudioNAMRack::precisionDriveVoice, 0.0f},
                {"precisionPowerOff", &OpenStudioNAMRack::precisionDriveEnabled, 0.0f},
                {"precisionOffStateDrive", &OpenStudioNAMRack::precisionDriveDrive, 0.61f},
                {"precisionPowerOn", &OpenStudioNAMRack::precisionDriveEnabled, 1.0f},
                {"distortionPowerOff", &OpenStudioNAMRack::chaosEnabled, 0.0f},
                {"distortionOffStateDrive", &OpenStudioNAMRack::chaosDrive, 0.63f},
                {"distortionPowerOn", &OpenStudioNAMRack::chaosEnabled, 1.0f},
            }};
            constexpr int eventSpacing = 2048;
            constexpr int combinedEvents = 12;
            const int length = (combinedEvents + static_cast<int>(isolatedEdits.size())) * eventSpacing;
            int cursor = 0, block = 0;
            bool exact = true, finite = true;
            while (cursor < length)
            {
                if (cursor % eventSpacing == 0)
                {
                    const int event = cursor / eventSpacing;
                    for (auto* rack : {cached.get(), reference.get()})
                    {
                        if (event >= combinedEvents)
                        {
                            const auto& edit = isolatedEdits[static_cast<size_t>(event - combinedEvents)];
                            (rack->*edit.control).store(edit.value);
                            continue;
                        }
                        rack->precisionDriveDrive.store(event % 2 ? 0.83f : 0.13f);
                        rack->precisionDriveAttack.store(static_cast<float>(event % 3) * 0.4f);
                        rack->precisionDriveBright.store(static_cast<float>(event % 4) * 0.3f);
                        rack->precisionDriveVolumeDb.store(event % 2 ? 5.0f : -3.0f);
                        rack->precisionDriveVoice.store(event == 8 || event == 9 ? 1.0f : 0.0f);
                        rack->precisionDriveEnabled.store(event == 4 || event == 5 || event == 7 ? 0.0f : 1.0f);
                        rack->chaosEnabled.store(event == 7 ? 0.0f : 1.0f);
                        rack->chaosMode.store(static_cast<float>(event % 3));
                        rack->chaosDrive.store(event % 2 ? 0.7f : 0.2f);
                        rack->chaosTone.store(static_cast<float>(event % 3) * 0.4f);
                        rack->chaosWeight.store(static_cast<float>(event % 3) * 0.45f);
                        rack->chaosLevelDb.store(event % 2 ? -5.0f : 2.0f);
                        rack->calibrationReferenceDbu.store(event >= 3 ? 18.0f : 12.0f);
                        rack->instrumentProfile.store(static_cast<float>(event >= 2 ? 1 - profile : profile));
                        if (event == 10) rack->reset();
                    }
                }
                const int count = juce::jmin(partitions[static_cast<size_t>(block++ % 5)], eventSpacing - cursor % eventSpacing);
                actual.setSize(channels, count, false, false, true);
                expected.setSize(channels, count, false, false, true);
                for (int channel = 0; channel < channels; ++channel) for (int sample = 0; sample < count; ++sample)
                {
                    const float value = static_cast<float>(0.11 * std::sin((cursor + sample) * (channel == 0 ? 0.019 : 0.031)));
                    actual.setSample(channel, sample, value); expected.setSample(channel, sample, value);
                }
                invalidate(*reference);
                cached->processBlock(actual, midi); reference->processBlock(expected, midi);
                for (int channel = 0; channel < channels; ++channel)
                {
                    exact = exact && std::memcmp(actual.getReadPointer(channel), expected.getReadPointer(channel), static_cast<size_t>(count) * sizeof(float)) == 0;
                    for (int sample = 0; sample < count; ++sample) finite = finite && std::isfinite(actual.getSample(channel, sample));
                }
                cursor += count;
            }
            const auto cachedState = cached->getDiagnosticState(), referenceState = reference->getDiagnosticState();
            const auto designs = [] (const juce::var& state)
            { return static_cast<juce::int64>(state.getProperty("precisionDriveCoefficientDesignCount", 0))
                + static_cast<juce::int64>(state.getProperty("distortionCoefficientDesignCount", 0)); };
            const bool reduced = designs(cachedState) > 0 && designs(cachedState) < designs(referenceState);
            const bool layoutMatches = cached->getTotalNumInputChannels() == channels
                && cached->getTotalNumOutputChannels() == channels
                && reference->getTotalNumInputChannels() == channels
                && reference->getTotalNumOutputChannels() == channels;
            const bool valid = exact && finite && reduced && layoutMatches;
            passed = passed && valid;
            auto* row = new juce::DynamicObject();
            row->setProperty("sampleRate", rate); row->setProperty("oversamplingFactor", factor);
            row->setProperty("initialProfile", profile); row->setProperty("channels", channels);
            row->setProperty("preparedInputChannels", cached->getTotalNumInputChannels());
            row->setProperty("preparedOutputChannels", cached->getTotalNumOutputChannels());
            row->setProperty("layoutMatchesBuffer", layoutMatches);
            row->setProperty("combinedLifecycleEvents", combinedEvents);
            juce::StringArray isolatedIds;
            for (const auto& edit : isolatedEdits) isolatedIds.add(edit.id);
            row->setProperty("isolatedControlEdits", isolatedIds.joinIntoString(","));
            row->setProperty("audioExact", exact); row->setProperty("finite", finite);
            row->setProperty("cachedDesigns", designs(cachedState)); row->setProperty("uncachedDesigns", designs(referenceState));
            row->setProperty("pass", valid); rows.add(row);
        }
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("pass", passed); result->setProperty("cases", rows);
    result->setProperty("comparison", "48 rows:2x/4x/8x, Guitar/Bass and negotiated mono/stereo buses with matching buffers, each re-prepared at44.1/48/96/44.1k. Every row retains12 combined control/lifecycle events, then19 one-control-at-a-time edits covering each control/profile cache dependency, gain/calibration, historical voice and individual-pedal bypass/off-edit/re-entry. Effective-rate coverage uses each prepared factor and repeated host-rate transitions. Cached and forced-redesign audio must remain exact while design calls decrease.");
    return result;
}

inline juce::var withOptimizationContracts(juce::var result, const juce::var& resampler, const juce::var& delay, const juce::var& drive)
{
    auto* object = result.getDynamicObject();
    if (object == nullptr) return result;
    auto checks = object->getProperty("checks");
    if (!checks.isArray()) checks = juce::Array<juce::var>();
    addCheck(*checks.getArray(), "nam_resampler_contiguous_history_reference_parity", resampler.getProperty("pass", false) ? "pass" : "fail",
        "Optimized resampling must exactly match the frozen pre-optimization tap/scheduling reference through startup, ring wrap, reset, integer/fractional rates, callback partitions and capacity failures.", resampler);
    addCheck(*checks.getArray(), "nam_inactive_delay_macro_bypass_contract", delay.getProperty("pass", false) ? "pass" : "fail",
        "Disabled Delay with no tail must retain exact dry output and bookkeeping; off-state edits must engage like a fresh processor and existing tails must continue draining.", delay);
    addCheck(*checks.getArray(), "nam_drive_coefficient_cache_parity", drive.getProperty("pass", false) ? "pass" : "fail",
        "Cached Drive/Distortion must exactly match forced coefficient redesign through control and lifecycle changes while reducing design calls.", drive);
    object->setProperty("checks", checks);
    const bool passed = object->getProperty("objectiveGateStatus").toString() == "pass"
        && static_cast<bool>(resampler.getProperty("pass", false)) && static_cast<bool>(delay.getProperty("pass", false))
        && static_cast<bool>(drive.getProperty("pass", false));
    object->setProperty("objectiveGateStatus", passed ? "pass" : "fail");
    object->setProperty("success", passed); object->setProperty("done", passed);
    return result;
}

inline void fillInput(juce::AudioBuffer<float>& audio, int start,
                      double sampleRate, int routedChannels)
{
    for (int sample = 0; sample < audio.getNumSamples(); ++sample)
    {
        const double time = static_cast<double>(start + sample) / sampleRate;
        const float left = static_cast<float>(0.22 * std::sin(juce::MathConstants<double>::twoPi * 173.0 * time)
            + 0.05 * std::sin(juce::MathConstants<double>::twoPi * 3417.0 * time));
        const float right = routedChannels == 1 ? left
            : static_cast<float>(0.19 * std::sin(juce::MathConstants<double>::twoPi * 229.0 * time)
                + 0.04 * std::cos(juce::MathConstants<double>::twoPi * 5171.0 * time));
        audio.setSample(0, sample, left);
        audio.setSample(1, sample, right);
    }
}

// Explicit local scenario manifests keep user-preset qualification separate
// from the bundled-model stress fixture. All file access, model publication,
// allocation and report construction happen outside the timed callback.
inline juce::var runScenarios(const juce::File& manifestFile)
{
    auto* report = new juce::DynamicObject();
    const juce::var result(report);
    juce::Array<juce::var> checks, rows;
    bool passed = true;
    int capacityFailures = 0;
    report->setProperty("schemaVersion", 1);
    report->setProperty("summary", "Explicit preset scenarios, serial independent Racks, fixed audio duration and shuffled repeats. Driver, host graph and UI scheduling excluded.");
    report->setProperty("timingStatus", "diagnostic_only");
    report->setProperty("subjectiveQuality", "not_asserted");
    report->setProperty("manifestPath", manifestFile.getFullPathName());
   #if JUCE_DEBUG
    report->setProperty("buildConfiguration", "Debug");
   #else
    report->setProperty("buildConfiguration", "Release");
   #endif
    const auto finish = [&]
    {
        report->setProperty("checks", checks);
        report->setProperty("cases", rows);
        report->setProperty("casesWithDeadlineMisses", capacityFailures);
        report->setProperty("capacityStatus", !passed || rows.isEmpty() ? "not_asserted" : capacityFailures == 0 ? "pass" : "fail");
        report->setProperty("capacityScope", "Zero measured offline deadline misses, not physical-device qualification or a universal realtime guarantee.");
        report->setProperty("objectiveGateStatus", passed ? "pass" : "fail");
        report->setProperty("success", passed);
        report->setProperty("done", passed);
        return result;
    };
    const auto config = juce::JSON::parse(manifestFile);
    const auto cases = config.getProperty("cases", {});
    const auto number = [] (const juce::var& value)
    {
        return (value.isInt() || value.isInt64() || value.isDouble())
            && std::isfinite(static_cast<double>(value));
    };
    const auto integer = [&] (const juce::var& value)
    {
        if (!number(value)) return false;
        const double numericValue = static_cast<double>(value);
        return numericValue == std::floor(numericValue) && numericValue >= -2147483647.0 && numericValue <= 2147483647.0;
    };
    const auto repeatsValue = config.getProperty("repeats", 3);
    const auto warmupValue = config.getProperty("warmupSeconds", 0.5);
    const auto durationValue = config.getProperty("measurementSeconds", 1.0);
    const int repeats = integer(repeatsValue) ? static_cast<int>(repeatsValue) : 0;
    const double warmup = number(warmupValue) ? static_cast<double>(warmupValue) : 0.0;
    const double duration = number(durationValue) ? static_cast<double>(durationValue) : 0.0;
    const bool requestHeapProbe = static_cast<bool>(config.getProperty("probeCallbackHeap", false));
    bool heapMeasured = false;
   #if JUCE_WINDOWS && JUCE_DEBUG
    heapMeasured = requestHeapProbe;
    if (heapMeasured) CallbackHeapProbe::previous = _CrtSetAllocHook(CallbackHeapProbe::hook);
    const juce::ScopeGuard restoreHeapHook {[&]
    {
        CallbackHeapProbe::active = false;
        if (heapMeasured) _CrtSetAllocHook(CallbackHeapProbe::previous);
    }};
   #else
    juce::ignoreUnused(requestHeapProbe);
   #endif
    report->setProperty("callbackHeapProbe", heapMeasured ? "MSVC Debug CRT allocations/frees on processing thread, including warmup" : "not_asserted");
    if (!manifestFile.existsAsFile() || config.getDynamicObject() == nullptr
        || !integer(config.getProperty("schemaVersion", {}))
        || static_cast<int>(config.getProperty("schemaVersion", 0)) != 1
        || !config.getProperty("probeCallbackHeap", false).isBool()
        || !config.getProperty("exportDirectory", "").isString()
        || !cases.isArray() || cases.size() < 1 || cases.size() > 512
        || repeats < 1 || repeats > 10 || !std::isfinite(warmup) || warmup < 0.1 || warmup > 10.0
        || !std::isfinite(duration) || duration < 0.1 || duration > 30.0)
    {
        passed = false;
        addCheck(checks, "nam_cpu_scenario_configuration", "fail", "Manifest needs schemaVersion 1, 1-512 cases, integer repeats 1-10, numeric warmupSeconds 0.1-10 and measurementSeconds 0.1-30, optional boolean probeCallbackHeap and string exportDirectory.");
        return finish();
    }
    report->setProperty("manifestSha256", juce::SHA256(manifestFile).toHexString());
    report->setProperty("warmupSeconds", warmup);
    report->setProperty("measurementSeconds", duration);
    report->setProperty("repeats", repeats);
    juce::StringArray caseIds;
    for (const auto& scenario : *cases.getArray())
    {
        const auto id = scenario.getProperty("id", {}).toString();
        if (scenario.getDynamicObject() == nullptr || !scenario.getProperty("id", {}).isString()
            || id.isEmpty() || id.length() > 128 || id != id.retainCharacters("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
            || caseIds.contains(id, true))
        {
            passed = false;
            addCheck(checks, "nam_cpu_scenario_ids", "fail", "Case IDs must be unique portable filename components (letters, digits, hyphen, underscore).");
            return finish();
        }
        caseIds.add(id);
    }
    const auto prototype = std::make_unique<OpenStudioNAMRack>();
    juce::MemoryBlock defaultState;
    prototype->getStateInformation(defaultState);
    const auto supportedState = juce::ValueTree::readFromData(defaultState.getData(), defaultState.getSize());
    std::vector<int> order(static_cast<size_t>(cases.size()));
    std::iota(order.begin(), order.end(), 0);
    std::mt19937 random(0x4e414d32u);
    for (int repeat = 0; repeat < repeats; ++repeat)
    {
        std::shuffle(order.begin(), order.end(), random);
        for (int caseIndex : order)
        {
            const auto& scenario = cases[caseIndex];
            const auto id = scenario.getProperty("id", {}).toString();
            const auto rackConfigs = scenario.getProperty("racks", {});
            const auto pattern = scenario.getProperty("bufferPattern", {});
            const auto rateValue = scenario.getProperty("sampleRate", {});
            const auto channelsValue = scenario.getProperty("routedInputChannels", 1);
            const auto factorValue = scenario.getProperty("oversamplingFactor", 4);
            const double rate = number(rateValue) ? static_cast<double>(rateValue) : 0.0;
            const int channels = integer(channelsValue) ? static_cast<int>(channelsValue) : 0;
            const int factor = integer(factorValue) ? static_cast<int>(factorValue) : 0;
            int maximumBlock = 0;
            int minimumBlock = 2048;
            bool valid = id.isNotEmpty() && rackConfigs.isArray() && rackConfigs.size() >= 1 && rackConfigs.size() <= 4
                && pattern.isArray() && pattern.size() > 0 && pattern.size() <= 32
                && std::isfinite(rate) && rate >= 8000.0 && rate <= 192000.0
                && (channels == 1 || channels == 2) && (factor == 2 || factor == 4 || factor == 8);
            for (int index = 0; index < pattern.size(); ++index)
            {
                const int size = integer(pattern[index]) ? static_cast<int>(pattern[index]) : 0;
                valid = valid && size >= 1 && size <= 2048;
                maximumBlock = juce::jmax(maximumBlock, size);
                minimumBlock = juce::jmin(minimumBlock, size);
            }
            if (const auto* rackArray = rackConfigs.getArray())
                for (const auto& rackConfig : *rackArray)
                {
                    const auto input = rackConfig.getProperty("input", "guitar");
                    const auto presetPath = rackConfig.getProperty("presetPath", {});
                    valid = valid && rackConfig.getDynamicObject() != nullptr && presetPath.isString()
                        && presetPath.toString().trim().isNotEmpty() && input.isString()
                        && (input.toString() == "guitar" || input.toString() == "bass" || input.toString() == "silence")
                        && (!rackConfig.hasProperty("overrides")
                            || rackConfig.getProperty("overrides", {}).getDynamicObject() != nullptr);
                }
            if (!valid)
            {
                passed = false;
                addCheck(checks, "nam_cpu_scenario_configuration", "fail", "Invalid case: " + id);
                continue;
            }
            std::vector<std::unique_ptr<OpenStudioNAMRack>> racks;
            std::vector<juce::AudioBuffer<float>> audio;
            juce::Array<juce::var> evidence;
            const int warmupFrames = static_cast<int>(std::ceil(rate * warmup));
            const int requestedMeasuredFrames = static_cast<int>(std::ceil(rate * duration));
            std::vector<int> callbackSizes;
            int warmupCursor = 0;
            while (warmupCursor < warmupFrames)
            {
                const int count = juce::jmin(static_cast<int>(pattern[static_cast<int>(callbackSizes.size() % static_cast<size_t>(pattern.size()))]), warmupFrames - warmupCursor);
                callbackSizes.push_back(count); warmupCursor += count;
            }
            int measuredFrames = 0;
            while (measuredFrames < requestedMeasuredFrames)
            {
                const int count = static_cast<int>(pattern[static_cast<int>(callbackSizes.size() % static_cast<size_t>(pattern.size()))]);
                callbackSizes.push_back(count); measuredFrames += count;
            }
            const int totalFrames = warmupFrames + measuredFrames;
            const auto exportRoot = config.getProperty("exportDirectory", {}).toString();
            const bool exportAudio = exportRoot.isNotEmpty() && repeat == 0;
            for (const auto& rackConfig : *rackConfigs.getArray())
            {
                const auto preset = manifestFile.getParentDirectory().getChildFile(rackConfig.getProperty("presetPath", {}).toString());
                juce::MemoryBlock payload;
                bool migrated = false;
                bool loaded = preset.existsAsFile() && preset.loadFileAsData(payload)
                    && OpenStudioNAMRack::migratePresetStateToCurrent(payload, migrated);
                auto tree = juce::ValueTree::readFromData(payload.getData(), payload.getSize());
                loaded = loaded && tree.hasType("OpenStudioNAMRack");
                const auto overrides = rackConfig.getProperty("overrides", {});
                loaded = loaded && (overrides.isVoid() || overrides.getDynamicObject() != nullptr);
                if (const auto* properties = overrides.getDynamicObject())
                {
                    for (const auto& property : properties->getProperties())
                    {
                        const auto supported = supportedState.getProperty(property.name);
                        const bool numeric = (number(property.value) || property.value.isBool())
                            && (number(supported) || supported.isBool())
                            && std::abs(static_cast<double>(property.value)) <= std::numeric_limits<float>::max();
                        loaded = loaded && numeric;
                        if (numeric && tree.isValid()) tree.setProperty(property.name, property.value, nullptr);
                    }
                }
                juce::MemoryBlock requested;
                {
                    juce::MemoryOutputStream stateStream(requested, false);
                    tree.writeToStream(stateStream);
                }
                auto rack = std::make_unique<OpenStudioNAMRack>();
                rack->setEmbeddedDriveOversamplingFactor(factor);
                rack->prepareToPlay(rate, maximumBlock);
                loaded = loaded && rack->restoreTonePresetStateInformation(requested.getData(), static_cast<int>(requested.getSize()));
                rack->setRoutedInputChannelCount(channels);
                rack->reset();
                rack->resetModelSnapshotLockMissCount();
                const auto ampPath = tree.getProperty("ampModelPath").toString();
                const auto pedalPath = tree.getProperty("pedalModelPath").toString();
                const auto cabPath = tree.getProperty("cabIRPath").toString();
                loaded = loaded && rack->hasAmpModel() && rack->getAmpModelPath() == ampPath
                    && (pedalPath.isEmpty() || (rack->hasPedalModel() && rack->getPedalModelPath() == pedalPath))
                    && (cabPath.isEmpty() || (rack->hasCabIR() && rack->getCabIRPath() == cabPath));
                auto* resource = new juce::DynamicObject();
                resource->setProperty("presetPath", preset.getFullPathName());
                resource->setProperty("presetSha256", preset.existsAsFile() ? juce::SHA256(preset).toHexString() : juce::String());
                resource->setProperty("migrated", migrated);
                resource->setProperty("requestedOverrides", overrides);
                resource->setProperty("ampExpected", static_cast<float>(tree.getProperty("ampEnabled", 1.0f)) >= 0.5f);
                resource->setProperty("pedalExpected", tree.getProperty("pedalModelPath").toString().isNotEmpty()
                    && static_cast<float>(tree.getProperty("pedalMix", 1.0f)) > 0.0f);
                resource->setProperty("ampExecuted", false);
                resource->setProperty("pedalExecuted", false);
                resource->setProperty("firstAmpExecutionBlock", -1);
                resource->setProperty("firstPedalExecutionBlock", -1);
                const auto requestedXML = tree.createXml();
                resource->setProperty("requestedState", requestedXML != nullptr ? requestedXML->toString() : juce::String());
                juce::MemoryBlock actualState;
                rack->getStateInformation(actualState);
                const auto actualTree = juce::ValueTree::readFromData(actualState.getData(), actualState.getSize());
                bool overridesMatch = true;
                if (const auto* properties = overrides.getDynamicObject())
                    for (const auto& property : properties->getProperties())
                        overridesMatch = overridesMatch && actualTree.hasProperty(property.name)
                            && static_cast<float>(actualTree.getProperty(property.name)) == static_cast<float>(property.value);
                loaded = loaded && overridesMatch;
                resource->setProperty("overridesReadbackMatched", overridesMatch);
                const auto actualXML = actualTree.createXml();
                resource->setProperty("actualState", actualXML != nullptr ? actualXML->toString() : juce::String());
                for (const auto* key : {"ampModelPath", "pedalModelPath", "cabIRPath"})
                {
                    const auto path = tree.getProperty(key).toString();
                    if (path.isEmpty()) continue;
                    const auto file = juce::File(path);
                    resource->setProperty(juce::String(key) + "Sha256", file.existsAsFile() ? juce::SHA256(file).toHexString() : juce::String());
                    loaded = loaded && file.existsAsFile();
                }
                resource->setProperty("resourcesLoaded", loaded);
                valid = valid && loaded;
                evidence.add(resource);
                racks.push_back(std::move(rack));
                audio.emplace_back(2, totalFrames);
                const auto input = rackConfig.getProperty("input", "guitar").toString();
                const bool bass = input == "bass";
                valid = valid && (bass || input == "guitar" || input == "silence");
                resource->setProperty("input", input + " synthetic diagnostic, not a recorded performance");
                for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < totalFrames; ++sample)
                {
                    const double time = sample / rate;
                    const double fundamental = bass ? 30.8677063 : 82.4068892;
                    const double stereo = channels == 2 && channel == 1 ? 1.334839854 : 1.0;
                    const float value = input == "silence" ? 0.0f : static_cast<float>(0.15 * std::sin(juce::MathConstants<double>::twoPi * fundamental * stereo * time)
                        + 0.035 * std::sin(juce::MathConstants<double>::twoPi * fundamental * 7.0 * stereo * time));
                    audio.back().setSample(channel, sample, value);
                }
                juce::Array<juce::var> inputHashes;
                for (int channel = 0; channel < 2; ++channel)
                    inputHashes.add(juce::SHA256(audio.back().getReadPointer(channel), static_cast<size_t>(totalFrames) * sizeof(float)).toHexString());
                resource->setProperty("inputChannelSha256", inputHashes);
            }
            if (!valid)
            {
                passed = false;
                addCheck(checks, "nam_cpu_scenario_resources", "fail", "Preset restore, resource identity or override validation failed: " + id, evidence);
                continue;
            }
            std::vector<double> times, loads;
            times.reserve(static_cast<size_t>(measuredFrames / minimumBlock + 1));
            loads.reserve(static_cast<size_t>(measuredFrames / minimumBlock + 1));
            int allocations = 0, frees = 0;
            int cursor = 0, blockIndex = 0, misses = 0, nonFinite = 0;
            float individualPeak = 0.0f, summedPeak = 0.0f;
            juce::MidiBuffer midi;
            while (cursor < totalFrames)
            {
                const int count = callbackSizes[static_cast<size_t>(blockIndex++)];
                // Buffer views use JUCE's fixed internal pointer capacity for two
                // lanes; their construction is outside the measured DSP region.
                std::array<std::array<float*, 2>, 4> pointers {};
                std::array<juce::AudioBuffer<float>, 4> blocks;
                for (size_t index = 0; index < racks.size(); ++index)
                {
                    pointers[index] = { audio[index].getWritePointer(0, cursor), audio[index].getWritePointer(1, cursor) };
                    blocks[index].setDataToReferTo(pointers[index].data(), 2, count);
                }
               #if JUCE_WINDOWS && JUCE_DEBUG
                CallbackHeapProbe::allocations = CallbackHeapProbe::frees = 0;
                CallbackHeapProbe::active = heapMeasured;
               #endif
                const auto started = juce::Time::getHighResolutionTicks();
                for (size_t index = 0; index < racks.size(); ++index) racks[index]->processBlock(blocks[index], midi);
                const double microseconds = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - started) * 1.0e6;
               #if JUCE_WINDOWS && JUCE_DEBUG
                CallbackHeapProbe::active = false;
                allocations += CallbackHeapProbe::allocations; frees += CallbackHeapProbe::frees;
               #endif
                // A one-sample callback can legitimately produce zero model-rate
                // frames. Observe warmup until every expected model first executes,
                // instead of relying on the first/last callback's phase alignment.
                // All diagnostic reads remain outside the timed region.
                if (cursor < warmupFrames)
                    for (size_t index = 0; index < racks.size(); ++index)
                    {
                        auto* witness = evidence.getReference(static_cast<int>(index)).getDynamicObject();
                        const bool needAmp = static_cast<bool>(witness->getProperty("ampExpected"))
                            && !static_cast<bool>(witness->getProperty("ampExecuted"));
                        const bool needPedal = static_cast<bool>(witness->getProperty("pedalExpected"))
                            && !static_cast<bool>(witness->getProperty("pedalExecuted"));
                        if (!needAmp && !needPedal) continue;
                        const auto state = racks[index]->getDiagnosticState();
                        if (needAmp && static_cast<juce::int64>(state.getProperty("lastAmpDspFrames", 0)) > 0)
                        {
                            witness->setProperty("ampExecuted", true);
                            witness->setProperty("firstAmpExecutionBlock", blockIndex - 1);
                        }
                        if (needPedal && static_cast<juce::int64>(state.getProperty("lastPedalDspFrames", 0)) > 0)
                        {
                            witness->setProperty("pedalExecuted", true);
                            witness->setProperty("firstPedalExecutionBlock", blockIndex - 1);
                        }
                    }
                if (cursor >= warmupFrames)
                {
                    const double budget = count / rate * 1.0e6;
                    times.push_back(microseconds);
                    loads.push_back(microseconds / budget);
                    if (microseconds > budget) ++misses;
                    for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < count; ++sample)
                    {
                        float sum = 0.0f;
                        for (size_t index = 0; index < racks.size(); ++index)
                        {
                            const float value = blocks[index].getSample(channel, sample);
                            if (!std::isfinite(value)) ++nonFinite;
                            else { individualPeak = juce::jmax(individualPeak, std::abs(value)); sum += value; }
                        }
                        summedPeak = juce::jmax(summedPeak, std::abs(sum));
                    }
                }
                cursor += count;
                pumpRegressionMessages();
            }
            for (size_t index = 0; index < racks.size(); ++index)
            {
                auto* resource = evidence.getReference(static_cast<int>(index)).getDynamicObject();
                const auto diagnostics = racks[index]->getDiagnosticState();
                resource->setProperty("diagnostics", diagnostics);
                valid = valid && (!static_cast<bool>(resource->getProperty("ampExpected")) || static_cast<bool>(resource->getProperty("ampExecuted")))
                    && (!static_cast<bool>(resource->getProperty("pedalExpected")) || static_cast<bool>(resource->getProperty("pedalExecuted")));
                valid = valid && !static_cast<bool>(diagnostics.getProperty("realtimeDSPBlocked", true))
                    && static_cast<int>(diagnostics.getProperty("embeddedDriveActiveOversamplingFactor", 0)) == factor;
                for (const auto* key : {"modelProcessFailCount", "audioThreadResizeAvoidedCount", "oversizeBypassCount", "modelSnapshotLockMissCount", "realtimeSafetyBypassCount", "rackOutputEmergencyMuteTripCount", "inputNonFiniteSampleCount"})
                    valid = valid && static_cast<juce::int64>(diagnostics.getProperty(key, -1)) == 0;
                juce::Array<juce::var> hashes;
                for (int channel = 0; channel < 2; ++channel)
                    hashes.add(juce::SHA256(audio[index].getReadPointer(channel), static_cast<size_t>(totalFrames) * sizeof(float)).toHexString());
                resource->setProperty("outputChannelSha256", hashes);
                if (exportAudio)
                {
                    const auto folder = manifestFile.getParentDirectory().getChildFile(exportRoot);
                    const auto file = folder.getChildFile(id.retainCharacters("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") + "-rack-" + juce::String(static_cast<int>(index) + 1) + ".wav");
                    juce::WavAudioFormat format;
                    // Export only to a newly created review directory; never
                    // overwrite a prior fixture or the user's source recording.
                    bool written = folder.createDirectory().wasOk() && !file.exists();
                    std::unique_ptr<juce::OutputStream> stream(written ? file.createOutputStream().release() : nullptr);
                    std::unique_ptr<juce::AudioFormatWriter> writer;
                    if (stream != nullptr) writer = format.createWriterFor(stream,
                        juce::AudioFormatWriterOptions().withSampleRate(rate).withNumChannels(2).withBitsPerSample(32)
                            .withSampleFormat(juce::AudioFormatWriterOptions::SampleFormat::floatingPoint));
                    if (writer != nullptr) written = writer->writeFromAudioSampleBuffer(audio[index], 0, totalFrames);
                    else written = false;
                    valid = valid && written;
                    resource->setProperty("exportPath", file.getFullPathName());
                }
            }
            valid = valid && nonFinite == 0 && !times.empty() && allocations == 0 && frees == 0;
            passed = passed && valid;
            if (misses > 0) ++capacityFailures;
            const double mean = std::accumulate(times.begin(), times.end(), 0.0) / static_cast<double>(times.size());
            std::sort(times.begin(), times.end());
            std::sort(loads.begin(), loads.end());
            const auto percentile = [] (const std::vector<double>& values, double p)
            { return values[juce::jmin(values.size() - 1, static_cast<size_t>(std::ceil(p * static_cast<double>(values.size()))) - 1)]; };
            auto* row = new juce::DynamicObject();
            row->setProperty("id", id); row->setProperty("repeat", repeat); row->setProperty("configuration", scenario);
            row->setProperty("racks", evidence); row->setProperty("processingValid", valid);
            row->setProperty("measuredBlocks", static_cast<int>(times.size()));
            row->setProperty("measuredFrames", measuredFrames); row->setProperty("warmupFrames", warmupFrames);
            row->setProperty("averageMicroseconds", mean); row->setProperty("p99Microseconds", percentile(times, 0.99));
            row->setProperty("p999Microseconds", percentile(times, 0.999)); row->setProperty("maximumMicroseconds", times.back());
            row->setProperty("p99DeadlineLoad", percentile(loads, 0.99)); row->setProperty("maximumDeadlineLoad", loads.back());
            row->setProperty("deadlineMisses", misses); row->setProperty("capacityStatus", !valid ? "not_asserted" : misses == 0 ? "pass" : "fail");
            row->setProperty("measuredSeconds", measuredFrames / rate);
            row->setProperty("individualOutputPeak", individualPeak); row->setProperty("summedOutputPeak", summedPeak);
            row->setProperty("nonFiniteCount", nonFinite); rows.add(row);
            row->setProperty("callbackHeapMeasured", heapMeasured);
            row->setProperty("callbackAllocations", allocations); row->setProperty("callbackFrees", frees);
        }
    }
    passed = passed && rows.size() == cases.size() * repeats;
    addCheck(checks, "nam_cpu_scenario_processing_integrity", passed ? "pass" : "fail", "Exact preset/resource restore, independent input streams, finite output and no processing fallback; deadline capacity is reported separately.");
    return finish();
}

template <typename FindModel, typename ConfigureRack, typename WriteIR>
juce::var run(FindModel findModel, ConfigureRack configureRack, WriteIR writeIR)
{
    const double started = juce::Time::getMillisecondCounterHiRes();
    const auto blockCountText = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_TWO_RACK_CPU_BLOCKS", {});
    const int measuredBlocks = blockCountText.isEmpty() ? 1024 : blockCountText.getIntValue();
    const bool countValid = measuredBlocks >= 128 && measuredBlocks <= 16384
        && (blockCountText.isEmpty() || blockCountText == juce::String(measuredBlocks));
    auto* report = new juce::DynamicObject();
    const juce::var result(report);
    report->setProperty("schemaVersion", 1);
    report->setProperty("subjectiveQuality", "not_asserted");
    report->setProperty("timingStatus", "diagnostic_only");
    report->setProperty("audioDeviceOpened", false);
    report->setProperty("summary", "Two independent complete NAM racks processed serially; offline warmed CPU diagnostics, excluding driver scheduling and host/UI overhead.");
    report->setProperty("oversamplingScope", "4x applies to the embedded Precision/Chaos drive island; NAM models retain their own sample-rate policy.");
    report->setProperty("input", "Deterministic continuous two-tone input, duplicated to stereo for mono routes; both racks receive the same source. No additional normalization or master limiter; production rack safety guards remain active.");
    report->setProperty("measuredBlocksPerCase", measuredBlocks);
    report->setProperty("preparedMaximumBlockSize", 128);
   #if JUCE_DEBUG
    report->setProperty("buildConfiguration", "Debug");
   #else
    report->setProperty("buildConfiguration", "Release");
   #endif
    juce::Array<juce::var> checks, rows, modelEvidence;
    bool integrityPassed = countValid;
    const auto finish = [&]
    {
        report->setProperty("checks", checks);
        report->setProperty("cases", rows);
        report->setProperty("models", modelEvidence);
        int casesWithMisses = 0;
        for (const auto& row : rows)
            if (static_cast<int>(row.getProperty("deadlineMisses", 0)) > 0) ++casesWithMisses;
        report->setProperty("casesWithDeadlineMisses", casesWithMisses);
        report->setProperty("capacityStatus", !integrityPassed || rows.isEmpty() ? "not_asserted" : casesWithMisses == 0 ? "pass" : "fail");
        report->setProperty("capacityScope", "Zero measured offline callback deadline misses; separate from signal integrity and physical-device stability.");
        report->setProperty("expectedCaseCount", 60);
        report->setProperty("objectiveGateStatus", integrityPassed ? "pass" : "fail");
        report->setProperty("success", integrityPassed);
        report->setProperty("done", integrityPassed);
        report->setProperty("elapsedMilliseconds", juce::Time::getMillisecondCounterHiRes() - started);
        return result;
    };
    if (!countValid)
    {
        addCheck(checks, "two_rack_cpu_configuration", "fail", "OPENSTUDIO_NAM_TWO_RACK_CPU_BLOCKS must be an integer from 128 to 16384.");
        return finish();
    }

    const auto resolveModel = [&] (const char* variable, const juce::File& fallback)
    {
        const auto requested = juce::SystemStats::getEnvironmentVariable(variable, {}).trim().unquoted();
        return requested.isEmpty() ? fallback : juce::File::getCurrentWorkingDirectory().getChildFile(requested);
    };
    const auto amp = resolveModel("OPENSTUDIO_NAM_BENCHMARK_AMP_MODEL", findModel("wavenet_a2_max.nam"));
    const auto pedal = resolveModel("OPENSTUDIO_NAM_BENCHMARK_PEDAL_MODEL", findModel("wavenet_a1_standard.nam"));
    const std::array<juce::File, 2> ampFiles {amp, resolveModel("OPENSTUDIO_NAM_BENCHMARK_AMP_MODEL_2", amp)};
    const std::array<juce::File, 2> pedalFiles {pedal, resolveModel("OPENSTUDIO_NAM_BENCHMARK_PEDAL_MODEL_2", pedal)};
    for (size_t index = 0; index < ampFiles.size(); ++index)
    {
        const bool available = ampFiles[index].existsAsFile() && pedalFiles[index].existsAsFile();
        integrityPassed = integrityPassed && available;
        auto* model = new juce::DynamicObject();
        model->setProperty("rack", static_cast<int>(index) + 1);
        model->setProperty("ampPath", ampFiles[index].getFullPathName());
        model->setProperty("pedalPath", pedalFiles[index].getFullPathName());
        model->setProperty("ampSha256", ampFiles[index].existsAsFile() ? juce::SHA256(ampFiles[index]).toHexString() : juce::String());
        model->setProperty("pedalSha256", pedalFiles[index].existsAsFile() ? juce::SHA256(pedalFiles[index]).toHexString() : juce::String());
        modelEvidence.add(model);
    }
    const auto irFile = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile("openstudio_two_rack_cpu_" + juce::Uuid().toString() + ".wav");
    const juce::ScopeGuard removeIR {[&] { irFile.deleteFile(); }};
    const bool irWritten = writeIR(irFile, false);
    report->setProperty("cabIR", "Generated deterministic 2048-sample stereo impulse, authored at 44100 Hz by the existing NAM regression fixture helper.");
    integrityPassed = integrityPassed && irWritten;
    if (!integrityPassed)
    {
        addCheck(checks, "two_rack_cpu_fixtures", "fail", "Both model paths must exist and the generated cabinet IR must be writable.");
        return finish();
    }

    struct StageSet { const char* name; bool complete; bool fuzz; };
    constexpr std::array<StageSet, 3> stageSets {{
        {"amp_cab", false, false},
        {"complete", true, false},
        {"complete_with_fuzz", true, true}
    }};
    for (const auto& stage : stageSets)
    {
        std::array<std::unique_ptr<OpenStudioNAMRack>, 2> racks;
        bool loaded = true;
        for (size_t index = 0; index < racks.size(); ++index)
        {
            racks[index] = std::make_unique<OpenStudioNAMRack>();
            auto& rack = *racks[index];
            rack.setEmbeddedDriveOversamplingFactor(4);
            configureRack(rack);
            rack.auditionSource.store(0.0f);
            rack.compressorEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.octaverEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.fuzzEnabled.store(stage.fuzz ? 1.0f : 0.0f);
            rack.fuzzDrive.store(0.5f);
            rack.fuzzVoice.store(0.0f);
            rack.fuzzLevelDb.store(-4.0f);
            rack.precisionDriveEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.chaosEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.eqEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.cabRoomEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.cabRoomAmount.store(0.42f);
            rack.cabDoublerEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.cabDoublerMix.store(0.24f);
            rack.modulatorEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.delayEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.reverbEnabled.store(stage.complete ? 1.0f : 0.0f);
            rack.setCabRequestedEnabled(true);
            rack.ampEnabled.store(1.0f);
            rack.ampMix.store(1.0f);
            rack.prepareToPlay(44100.0, 128);
            const bool ampLoaded = rack.loadAmpModel(ampFiles[index].getFullPathName());
            const bool pedalLoaded = !stage.complete || rack.loadPedalModel(pedalFiles[index].getFullPathName());
            const bool cabLoaded = rack.loadCabIR(irFile.getFullPathName());
            loaded = loaded && ampLoaded && pedalLoaded && cabLoaded;
            if (!ampLoaded || !pedalLoaded || !cabLoaded)
                addCheck(checks, "two_rack_cpu_model_load", "fail", juce::String(stage.name) + ": " + rack.getLastLoadError());
        }
        if (!loaded)
        {
            integrityPassed = false;
            continue;
        }

        for (double rate : {44100.0, 48000.0})
        {
            for (auto& rack : racks) rack->prepareToPlay(rate, 128);
            for (int channels : {1, 2}) for (int blockSize : {8, 16, 32, 64, 128})
            {
                juce::Logger::writeToLog("[twoRackCpu] " + juce::String(stage.name) + " rate="
                    + juce::String(rate, 0) + " channels=" + juce::String(channels) + " block=" + juce::String(blockSize));
                for (auto& rack : racks)
                {
                    rack->setRoutedInputChannelCount(channels);
                    rack->reset();
                }
                std::array<juce::AudioBuffer<float>, 2> audio;
                for (auto& block : audio) block.setSize(2, blockSize);
                juce::MidiBuffer midi;
                const int warmupBlocks = static_cast<int>(std::ceil(rate * 0.12 / blockSize));
                int cursor = 0;
                std::vector<double> times;
                times.reserve(static_cast<size_t>(measuredBlocks));
                int nonFinite = 0, deadlineMisses = 0;
                float outputPeak = 0.0f, summedPeak = 0.0f;
                const double deadline = blockSize / rate * 1.0e6;
                const double dispatchStarted = juce::Time::getMillisecondCounterHiRes();
                for (int blockIndex = -warmupBlocks; blockIndex < measuredBlocks; ++blockIndex)
                {
                    for (auto& block : audio) fillInput(block, cursor, rate, channels);
                    cursor += blockSize;
                    const auto ticks = juce::Time::getHighResolutionTicks();
                    for (size_t index = 0; index < racks.size(); ++index) racks[index]->processBlock(audio[index], midi);
                    const double elapsed = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - ticks) * 1.0e6;
                    if (blockIndex >= 0)
                    {
                        times.push_back(elapsed);
                        if (elapsed > deadline) ++deadlineMisses;
                        for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < blockSize; ++sample)
                        {
                            const float left = audio[0].getSample(channel, sample), right = audio[1].getSample(channel, sample);
                            if (!std::isfinite(left) || !std::isfinite(right)) ++nonFinite;
                            else
                            {
                                outputPeak = juce::jmax(outputPeak, std::abs(left), std::abs(right));
                                summedPeak = juce::jmax(summedPeak, std::abs(left + right));
                            }
                        }
                    }
                    pumpRegressionMessages(); // Never included in the timed region.
                }
                const double totalWallMs = juce::Time::getMillisecondCounterHiRes() - dispatchStarted;
                std::sort(times.begin(), times.end());
                const auto percentile = [&] (double p)
                {
                    const size_t index = static_cast<size_t>(std::ceil(p * static_cast<double>(times.size()))) - 1;
                    return times[juce::jmin(index, times.size() - 1)];
                };
                const double average = std::accumulate(times.begin(), times.end(), 0.0) / measuredBlocks;
                bool valid = nonFinite == 0 && outputPeak > 1.0e-7f;
                juce::Array<juce::var> rackEvidence;
                for (const auto& rack : racks)
                {
                    const auto state = rack->getDiagnosticState();
                    auto* evidence = new juce::DynamicObject();
                    for (const auto* key : {"activeInputRoutingMode", "trueStereoDualNAMActive", "ampModelSampleRate", "pedalModelSampleRate", "lastAmpDspFrames", "lastPedalDspFrames", "modelProcessFailCount", "realtimeSafetyBypassCount", "audioThreadResizeAvoidedCount", "oversizeBypassCount", "modelSnapshotLockMissCount", "realtimeDSPBlocked", "embeddedDriveActiveOversamplingFactor", "rackOutputEmergencyMuteTripCount", "rackOutputSafetyGuardHitCount", "rackMaximumRawOutputPeakLinear"})
                        evidence->setProperty(key, state.getProperty(key, {}));
                    const bool routed = static_cast<int>(state.getProperty("activeInputRoutingMode", -1)) == (channels == 2 ? 2 : 0);
                    const bool rackValid = routed && static_cast<int>(state.getProperty("lastAmpDspFrames", 0)) > 0
                        && (!stage.complete || static_cast<int>(state.getProperty("lastPedalDspFrames", 0)) > 0)
                        && static_cast<int>(state.getProperty("embeddedDriveActiveOversamplingFactor", 0)) == 4
                        && !static_cast<bool>(state.getProperty("realtimeDSPBlocked", true))
                        && static_cast<int>(state.getProperty("modelProcessFailCount", -1)) == 0
                        && static_cast<int>(state.getProperty("realtimeSafetyBypassCount", -1)) == 0
                        && static_cast<int>(state.getProperty("audioThreadResizeAvoidedCount", -1)) == 0
                        && static_cast<int>(state.getProperty("oversizeBypassCount", -1)) == 0
                        && static_cast<int>(state.getProperty("modelSnapshotLockMissCount", -1)) == 0
                        && static_cast<int>(state.getProperty("rackOutputEmergencyMuteTripCount", -1)) == 0;
                    valid = valid && rackValid;
                    evidence->setProperty("processingValid", rackValid);
                    rackEvidence.add(evidence);
                }
                integrityPassed = integrityPassed && valid;
                auto* row = new juce::DynamicObject();
                row->setProperty("stageSet", stage.name);
                row->setProperty("sampleRate", rate);
                row->setProperty("bufferSize", blockSize);
                row->setProperty("routedInputChannels", channels);
                row->setProperty("rackCount", 2);
                row->setProperty("embeddedDriveOversamplingFactor", 4);
                row->setProperty("warmupBlocks", warmupBlocks);
                row->setProperty("averageMicroseconds", average);
                row->setProperty("medianMicroseconds", percentile(0.5));
                row->setProperty("p99Microseconds", percentile(0.99));
                row->setProperty("p999Microseconds", percentile(0.999));
                row->setProperty("maximumMicroseconds", times.back());
                row->setProperty("callbackDeadlineMicroseconds", deadline);
                row->setProperty("deadlineMisses", deadlineMisses);
                row->setProperty("capacityStatus", !valid ? "not_asserted" : deadlineMisses == 0 ? "pass" : "fail");
                row->setProperty("singleCoreAverageLoadPercent", average / deadline * 100.0);
                row->setProperty("wallMillisecondsIncludingWarmupAndDispatch", totalWallMs);
                row->setProperty("nonFiniteCount", nonFinite);
                row->setProperty("individualOutputPeak", outputPeak);
                row->setProperty("summedOutputPeak", summedPeak);
                row->setProperty("processingValid", valid);
                row->setProperty("timingStatus", "diagnostic_only");
                row->setProperty("racks", rackEvidence);
                rows.add(row);
            }
        }
    }
    integrityPassed = integrityPassed && rows.size() == 60;
    addCheck(checks, "two_rack_cpu_processing_integrity", integrityPassed ? "pass" : "fail",
        "All 60 cases must load independent model instances, process the requested mono/stereo route at 4x drive oversampling, remain finite and non-silent, and avoid NAM failure, resize, oversize, snapshot or safety fallbacks.");
    addCheck(checks, "two_rack_cpu_callback_matrix", "diagnostic_only",
        "44.1/48 kHz x 8/16/32/64/128 samples x mono/stereo x amp+cab/full/full+fuzz; timings and summed peaks exclude hardware/host/UI scheduling and do not establish audible crackle or tone quality.");
    return finish();
}
}
