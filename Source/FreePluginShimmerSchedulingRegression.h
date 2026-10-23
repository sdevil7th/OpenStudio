#pragma once
#include "BuiltInShimmerScheduling.h"

namespace ShimmerSchedulingRegression
{
inline double error(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    if (a.getNumChannels() != b.getNumChannels() || a.getNumSamples() != b.getNumSamples())
        return std::numeric_limits<double>::infinity();
    double maximum = 0;
    for (int channel = 0; channel < a.getNumChannels(); ++channel)
        for (int sample = 0; sample < a.getNumSamples(); ++sample)
            maximum = juce::jmax(maximum, std::abs(static_cast<double>(a.getSample(channel, sample))
                - static_cast<double>(b.getSample(channel, sample))));
    return maximum;
}
struct Capture
{
    juce::AudioBuffer<float> audio;
    bool ready = true, finite = true, midFadePhaseProof = true;
    int midFadeReversals = 0;
    double peak = 0;
};
struct RenderOptions
{
    double rate = 48000;
    int channels = 2, mode = 0, route = 0, preparedBlock = 128;
    bool irregular = false, live = false, reprepare = false, dryOnly = false, explicitReset = false;
    bool routeAutomation = false;
    const juce::MemoryBlock* state = nullptr;
};
inline juce::MemoryBlock bytes(const juce::ValueTree& tree)
{
    juce::MemoryBlock result;
    { juce::MemoryOutputStream stream(result, false); tree.writeToStream(stream); }
    return result;
}
inline std::int64_t privateBytes()
{
#if JUCE_WINDOWS
    PROCESS_MEMORY_COUNTERS_EX counters{}; counters.cb = static_cast<DWORD>(sizeof(counters));
    if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), static_cast<DWORD>(sizeof(counters))))
        return static_cast<std::int64_t>(counters.PrivateUsage);
#endif
    return -1;
}
}

inline juce::var checkShimmerScheduling()
{
    using namespace ShimmerSchedulingRegression;
    bool passed = true, heapMeasured = false;
    int allocations = 0, frees = 0;
    juce::Array<juce::var> cases;
    const auto add = [&] (juce::DynamicObject* row, bool pass) {
        row->setProperty("pass", pass); cases.add(juce::var(row)); passed = pass && passed;
    };
    const auto processChecked = [&] (OpenStudioReverb& processor, juce::AudioBuffer<float>& block, juce::MidiBuffer& midi) {
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::allocations = ReverbCompatibilityHeapProbe::frees = 0;
        ReverbCompatibilityHeapProbe::previous = _CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
        ReverbCompatibilityHeapProbe::active = true;
#endif
        processor.processBlock(block, midi);
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::active = false;
        _CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
        allocations += ReverbCompatibilityHeapProbe::allocations;
        frees += ReverbCompatibilityHeapProbe::frees;
        heapMeasured = true;
#endif
    };
    const auto render = [&] (const RenderOptions& options) {
        auto processor = std::make_unique<OpenStudioReverb>(true);
        if (options.state) processor->setStateInformation(options.state->getData(), static_cast<int>(options.state->getSize()));
        processor->selectAlgorithm(5); processor->shimmerScheduling.store(static_cast<float>(options.mode));
        processor->creativeControls[0].store(static_cast<float>(options.route));
        processor->shimmerVoiceMix.store(.5f); processor->shimmerAmount.store(1);
        processor->wetLevel.store(options.dryOnly ? 0.0f : 1.0f); processor->dryLevel.store(options.dryOnly ? .7f : 0.0f);
        processor->reverbReturnMode.store(0); processor->outputTrimDb.store(0);
        auto layout = processor->getBusesLayout();
        layout.inputBuses.set(0, options.channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
        layout.outputBuses.set(0, options.channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
        Capture capture; capture.ready = processor->setBusesLayout(layout);
        processor->prepareToPlay(options.rate, options.preparedBlock);
        juce::AudioBuffer<float> block(processor->getTotalNumOutputChannels(), 1021); juce::MidiBuffer midi;
        if (options.reprepare)
        {
            for (int iteration = 0; iteration < 17; ++iteration)
            {
                block.setSize(block.getNumChannels(), 127, false, false, true); block.clear();
                block.setSample(0, 0, .1f); processChecked(*processor, block, midi);
            }
            processor->prepareToPlay(options.rate, options.preparedBlock);
        }
        if (options.explicitReset) processor->reset();
        const int length = juce::roundToInt(options.rate * ((options.live || options.routeAutomation) ? 1.65 : .65));
        capture.audio.setSize(options.channels, length);
        const std::array<double, 10> eventSeconds{.25, .31, .55, .740, .745, .83, .90, .995, 1.06, 1.20};
        std::array<int, 10> events{};
        for (size_t index = 0; index < events.size(); ++index) events[index] = juce::roundToInt(options.rate * eventSeconds[index]);
        BuiltInSpreadReverbPitchVoice latencyProbe;
        BuiltInShimmerScheduling phaseOracle;
        if (options.live)
        {
            latencyProbe.prepare(options.rate, 0);
            phaseOracle.prepare(options.rate, latencyProbe.latencySamples(), latencyProbe.extraLatencySamples() * 3 / 4,latencyProbe.resetSamples());
            phaseOracle.configure(options.mode != 0);
            // Preserve the intended interior-fade reversals when bounded
            // history clearing adds its deterministic preparation interval.
            for(const size_t index:{size_t{3},size_t{4},size_t{7}})events[index]+=latencyProbe.resetSamples();
        }
        const std::array<int, 5> partitions{1, 17, 63, 257, 1021};
        for (int start = 0, part = 0; start < length; ++part)
        {
            if (options.routeAutomation)
            {
                if (start == events[0]) processor->creativeControls[0].store(2);
                if (start == events[1]) processor->creativeControls[0].store(1);
                if (start == events[2]) processor->creativeControls[0].store(0);
                if (start == events[3]) { processor->shimmerPitchA.store(-12); processor->shimmerPitchB.store(19); }
                if (start == events[4]) processor->shimmerVoiceEngine.store(0);
                if (start == events[5]) processor->shimmerVoiceEngine.store(1);
                if (start == events[6]) { processor->shimmerHold.store(1); processor->holdInputModes[5].store(0); }
                if (start == events[7]) processor->shimmerScheduling.store(0);
                if (start == events[8]) processor->shimmerScheduling.store(1);
                if (start == events[9]) { processor->shimmerHold.store(0); processor->creativeControls[0].store(2); }
            }
            if (options.live)
            {
                // This case selects Shimmer throughout, so Additional advances
                // this same policy once per sample. Check an interior blend
                // before each intended reversal instead of assuming a fixed
                // fade start from approximate millisecond latency.
                if (start == events[3] || start == events[4] || start == events[7])
                {
                    const float phase = phaseOracle.mix({0, 0}, {1, 1})[0];
                    capture.midFadePhaseProof = phase > 0 && phase < 1 && !phaseOracle.isSettled()
                        && phaseOracle.processOriginal() && phaseOracle.processSpread() && capture.midFadePhaseProof;
                    ++capture.midFadeReversals;
                }
                if (start == events[0] || start == events[2] || start == events[4] || start == events[7] || start == events[8]) processor->shimmerScheduling.store(1);
                if (start == events[1] || start == events[3] || start == events[5]) processor->shimmerScheduling.store(0);
                if (start == events[6]) { processor->shimmerHold.store(1); processor->holdInputModes[5].store(0); }
                if (start == events[9]) processor->shimmerHold.store(0);
                phaseOracle.configure(processor->shimmerScheduling.load() >= .5f);
            }
            int count = juce::jmin(options.irregular ? partitions[static_cast<size_t>(part % 5)] : 128, length - start);
            if (options.live || options.routeAutomation) for (int event : events) if (start < event) count = juce::jmin(count, event - start);
            block.setSize(block.getNumChannels(), count, false, false, true); block.clear();
            for (int sample = 0; sample < count; ++sample)
            {
                const double time = static_cast<double>(start + sample) / options.rate;
                const float signal = .06f * static_cast<float>(
                    std::sin(juce::MathConstants<double>::twoPi * 223 * time)
                    + .37 * std::sin(juce::MathConstants<double>::twoPi * 997 * time));
                for (int channel = 0; channel < options.channels; ++channel)
                    block.setSample(channel, sample, signal * (channel == 0 ? 1.0f : -.73f));
            }
            processChecked(*processor, block, midi);
            if (options.live) for (int sample = 0; sample < count; ++sample) phaseOracle.advance();
            for (int channel = 0; channel < options.channels; ++channel)
            {
                capture.audio.copyFrom(channel, start, block, channel, 0, count);
                for (int sample = 0; sample < count; ++sample)
                {
                    const float value = block.getSample(channel, sample);
                    capture.finite = std::isfinite(value) && capture.finite;
                    capture.peak = juce::jmax(capture.peak, std::abs(static_cast<double>(value)));
                }
            }
            start += count;
        }
        return capture;
    };

    auto source = std::make_unique<OpenStudioReverb>(true), restored = std::make_unique<OpenStudioReverb>(true);
    auto embedded = std::make_unique<OpenStudioReverb>(false);
    bool state = source->shimmerScheduling.load() == 0 && embedded->shimmerScheduling.load() == 0;
    state = setFreePluginParamForRegression(*source, "shimmerScheduling", 1) && state;
    juce::MemoryBlock saved, repeated; source->getStateInformation(saved);
    restored->setStateInformation(saved.getData(), static_cast<int>(saved.getSize())); restored->getStateInformation(repeated);
    state = saved == repeated && restored->shimmerScheduling.load() == 1 && state;
    restored->selectAlgorithm(5); restored->selectSendMode(true); state = restored->shimmerScheduling.load() == 1 && state;
    const auto parameters = describeFreePluginForRegression(*source)["parameters"];
    state = parameters.size() >= 1088 && parameters[1087]["id"].toString() == "shimmerScheduling"
        && static_cast<float>(parameters[1087]["defaultValue"]) == 0 && state;
    auto old = juce::ValueTree::readFromData(saved.getData(), saved.getSize()); old.removeProperty("shimmerScheduling", nullptr);
    const auto oldBytes = bytes(old); restored->setStateInformation(oldBytes.getData(), static_cast<int>(oldBytes.getSize()));
    state = restored->shimmerScheduling.load() == 0 && state;
    old.setProperty("shimmerScheduling", std::numeric_limits<double>::quiet_NaN(), nullptr);
    const auto invalidBytes = bytes(old); restored->setStateInformation(invalidBytes.getData(), static_cast<int>(invalidBytes.getSize()));
    state = restored->shimmerScheduling.load() == 0 && state;
    state = !setFreePluginParamForRegression(*embedded, "shimmerScheduling", 1)
        && !setFreePluginNormalizedForRegression(*embedded, "shimmerScheduling", 1) && state;
    auto* stateRow = new juce::DynamicObject(); stateRow->setProperty("kind", "state_migration_and_appended_descriptor"); add(stateRow, state);

    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        BuiltInSpreadReverbPitchVoice voice; voice.prepare(rate, 0);
        const int extra = voice.extraLatencySamples(), warmup = voice.latencySamples();
        BuiltInShimmerScheduling policy; policy.prepare(rate, warmup); policy.configure(false);
        bool policyPass = extra == static_cast<int>(rate * .03);
        const std::array<float, 2> original{.23f, -.37f}, spread{-.41f, .17f};
        for (int sample = 0; sample < 257; ++sample)
            policyPass = policy.advance() == -1 && policy.processOriginal() && !policy.processSpread()
                && policy.mix(original, spread) == original && policyPass;
        for (bool target : {true, false})
        {
            policy.configure(target);
            int resets = 0, previousReset = -64;
            for (int sample = 0; sample < warmup + static_cast<int>(rate * .02) + 320; ++sample)
            {
                const int resetVoice = policy.advance();
                if (resetVoice >= 0)
                {
                    policyPass = resetVoice == resets && sample - previousReset >= 64
                        && policy.resetSpreadBank() == target && policyPass;
                    ++resets; previousReset = sample;
                }
                const auto mixed = policy.mix(original, spread);
                policyPass = std::isfinite(mixed[0]) && std::isfinite(mixed[1]) && policyPass;
            }
            policyPass = resets == 4 && policy.isSettled() && policy.isSpread() == target
                && policy.processSpread() == target && policy.processOriginal() != target && policyPass;
        }
        auto* policyRow = new juce::DynamicObject(); policyRow->setProperty("kind", "deterministic_policy_and_latency");
        policyRow->setProperty("sampleRate", rate); policyRow->setProperty("extraPitchSamples", extra);
        policyRow->setProperty("warmupSamples", warmup); add(policyRow, policyPass);

        // Reverse twice while the actual helper mix is strictly inside the
        // fade. No inactive-bank clear may interrupt either reversal; every
        // step remains bounded by a full-scale 20 ms fade step.
        const int fadeSamples = juce::jmax(1, static_cast<int>(rate * .02));
        const double maximumStep = 1.0 / fadeSamples + 1e-6;
        policy.configure(true);
        float mix = 0; bool enteredFade = false, reversalPass = true;
        for (int sample = 0; sample < warmup + fadeSamples + 320; ++sample)
        {
            policy.advance(); mix = policy.mix({0, 0}, {1, 1})[0];
            if (mix >= .25f && mix < .9f) { enteredFade = true; break; }
        }
        reversalPass = enteredFade && !policy.isSettled() && policy.processOriginal() && policy.processSpread();
        policy.configure(false);
        for (int sample = 0; sample < juce::jmax(1, juce::roundToInt(rate * .004)); ++sample)
        {
            const float previous = mix; const int resetVoice = policy.advance(); mix = policy.mix({0, 0}, {1, 1})[0];
            reversalPass = resetVoice == -1 && mix > 0 && mix < 1 && mix <= previous
                && static_cast<double>(previous - mix) <= maximumStep
                && policy.processOriginal() && policy.processSpread() && reversalPass;
        }
        policy.configure(true);
        for (int sample = 0; sample < fadeSamples + 2; ++sample)
        {
            const float previous = mix; const int resetVoice = policy.advance(); mix = policy.mix({0, 0}, {1, 1})[0];
            reversalPass = resetVoice == -1 && std::isfinite(mix) && mix >= previous
                && static_cast<double>(mix - previous) <= maximumStep && reversalPass;
        }
        reversalPass = policy.isSettled() && policy.isSpread() && !policy.processOriginal()
            && policy.processSpread() && mix == 1 && reversalPass;
        auto* reversalRow = new juce::DynamicObject(); reversalRow->setProperty("kind", "actual_mid_fade_double_reversal_policy");
        reversalRow->setProperty("sampleRate", rate); reversalRow->setProperty("enteredInteriorFade", enteredFade);
        reversalRow->setProperty("maximumAllowedStep", maximumStep); add(reversalRow, reversalPass);
    }
    // These setup-only checkpoints count live Debug CRT normal-block requested
    // bytes, including the bank objects. Heap reservation reuse does not hide
    // these allocations. JSON construction follows the measured interval.
    juce::Array<juce::var> preparedMemoryDiagnostics;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
#if JUCE_WINDOWS && JUCE_DEBUG
        const bool hookInactiveBefore = !ReverbCompatibilityHeapProbe::active;
        const bool trackingEnabled = (_CrtSetDbgFlag(_CRTDBG_REPORT_FLAG) & _CRTDBG_ALLOC_MEM_DF) != 0;
        _CrtMemState beforeOriginal{}, withOriginal{}, withBoth{};
        _CrtMemCheckpoint(&beforeOriginal);
        auto originalBank = std::make_unique<std::array<BuiltInReverbPitchVoice, 4>>();
        for (auto& voice : *originalBank) voice.prepare(rate);
        _CrtMemCheckpoint(&withOriginal);
        auto spreadBank = std::make_unique<std::array<BuiltInSpreadReverbPitchVoice, 4>>();
        constexpr std::array<int, 4> rolePhases{0, 2, 1, 3};
        for (size_t role = 0; role < spreadBank->size(); ++role) (*spreadBank)[role].prepare(rate, rolePhases[role]);
        _CrtMemCheckpoint(&withBoth);
        const bool hookInactiveAfter = !ReverbCompatibilityHeapProbe::active;
        const auto oldRequestedBytes = static_cast<juce::int64>(withOriginal.lSizes[_NORMAL_BLOCK])
            - static_cast<juce::int64>(beforeOriginal.lSizes[_NORMAL_BLOCK]);
        const auto extraRequestedBytes = static_cast<juce::int64>(withBoth.lSizes[_NORMAL_BLOCK])
            - static_cast<juce::int64>(withOriginal.lSizes[_NORMAL_BLOCK]);
        const auto extraNormalBlocks = static_cast<juce::int64>(withBoth.lCounts[_NORMAL_BLOCK])
            - static_cast<juce::int64>(withOriginal.lCounts[_NORMAL_BLOCK]);
        const auto oldObjectBytes = static_cast<juce::int64>(sizeof(*originalBank));
        const auto extraObjectBytes = static_cast<juce::int64>(sizeof(*spreadBank));
        const bool validMeasurement = trackingEnabled && hookInactiveBefore && hookInactiveAfter
            && oldRequestedBytes >= oldObjectBytes && extraRequestedBytes > extraObjectBytes && extraNormalBlocks > 0;
#endif
        auto* memoryRow = new juce::DynamicObject();
        memoryRow->setProperty("kind", "off_callback_debug_crt_prepared_voice_storage");
        memoryRow->setProperty("sampleRate", rate); memoryRow->setProperty("voiceCountPerBank", 4);
        memoryRow->setProperty("channelsPerVoice", 2); memoryRow->setProperty("status", "diagnostic_only");
        memoryRow->setProperty("originalVoiceObjectBytes", static_cast<juce::int64>(sizeof(BuiltInReverbPitchVoice)));
        memoryRow->setProperty("spreadVoiceObjectBytes", static_cast<juce::int64>(sizeof(BuiltInSpreadReverbPitchVoice)));
        memoryRow->setProperty("scope", "Off-callback live Debug CRT normal-block requested-byte deltas with four prepared Original voices retained while four Spread voices are prepared. Includes bank objects and their normal-block storage; excludes CRT metadata, allocator reservation/fragmentation, non-normal allocations and total process RSS. Debug STL/layout and other-thread allocations can affect the result; exact Release footprint is not asserted.");
#if JUCE_WINDOWS && JUCE_DEBUG
        memoryRow->setProperty("measurement", "measured"); memoryRow->setProperty("trackingEnabled", trackingEnabled);
        memoryRow->setProperty("callbackHeapHookInactive", hookInactiveBefore && hookInactiveAfter);
        memoryRow->setProperty("normalBlockBytesBeforeOriginal", static_cast<juce::int64>(beforeOriginal.lSizes[_NORMAL_BLOCK]));
        memoryRow->setProperty("normalBlockBytesWithOriginal", static_cast<juce::int64>(withOriginal.lSizes[_NORMAL_BLOCK]));
        memoryRow->setProperty("normalBlockBytesWithBoth", static_cast<juce::int64>(withBoth.lSizes[_NORMAL_BLOCK]));
        memoryRow->setProperty("normalBlockCountWithOriginal", static_cast<juce::int64>(withOriginal.lCounts[_NORMAL_BLOCK]));
        memoryRow->setProperty("normalBlockCountWithBoth", static_cast<juce::int64>(withBoth.lCounts[_NORMAL_BLOCK]));
        memoryRow->setProperty("originalBankRequestedBytesDelta", oldRequestedBytes);
        memoryRow->setProperty("extraSpreadBankRequestedBytesDelta", extraRequestedBytes);
        memoryRow->setProperty("extraSpreadBankObjectBytes", extraObjectBytes);
        memoryRow->setProperty("extraSpreadDynamicStorageBytesDiagnostic", extraRequestedBytes - extraObjectBytes);
        memoryRow->setProperty("extraSpreadNormalBlocks", extraNormalBlocks);
        add(memoryRow, validMeasurement); // Validity only, never an RSS/quality threshold.
#else
        memoryRow->setProperty("measurement", "not_measured");
        memoryRow->setProperty("assertion", "not_asserted");
#endif
        preparedMemoryDiagnostics.add(juce::var(memoryRow));
    }
    // The app's render setup calls prepare followed by explicit reset. Test
    // the scheduling history independently of the wrapper's existing wet
    // fade-in reset semantics, using the actual Additional engine.
    double maximumSchedulingResetError = 0;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int route : {0, 1, 2})
        {
            auto prepared = std::make_unique<BuiltInAdditionalReverbs>();
            auto reset = std::make_unique<BuiltInAdditionalReverbs>();
            prepared->prepare(rate, 5); reset->prepare(rate, 5);
            BuiltInAdditionalReverbs::Settings settings{2, .5f, .5f, .5f, 0, 20, 20000, 1, 1};
            settings.voiceMix = .5f; settings.shimmerRoute = static_cast<float>(route); settings.spreadShimmer = true;
            reset->configure(5, settings);
            for (int sample = 0; sample < 4097; ++sample) reset->process(.013f, -.007f);
            reset->reset(); reset->resetShimmerSchedulingHistory();
            prepared->configure(5, settings); reset->configure(5, settings);
            double maximum = 0, peak = 0; bool finite = true;
            for (int sample = 0; sample < juce::roundToInt(rate * .45); ++sample)
            {
                const float input = .04f * static_cast<float>(std::sin(.047 * sample));
                const auto a = prepared->process(input, input * -.73f), b = reset->process(input, input * -.73f);
                for (size_t channel = 0; channel < a.size(); ++channel)
                {
                    maximum = juce::jmax(maximum, std::abs(static_cast<double>(a[channel]) - b[channel]));
                    peak = juce::jmax(peak, std::abs(static_cast<double>(b[channel])));
                    finite = std::isfinite(a[channel]) && std::isfinite(b[channel]) && finite;
                }
            }
            maximumSchedulingResetError = juce::jmax(maximumSchedulingResetError, maximum);
            auto* row = new juce::DynamicObject(); row->setProperty("kind", "additional_prepare_only_vs_dirtied_explicit_reset");
            row->setProperty("sampleRate", rate); row->setProperty("route", route); row->setProperty("maxError", maximum);
            add(row, finite && peak > 1e-8 && maximum == 0 && reset->shimmerSchedulingSettled() && reset->shimmerSchedulingSpread());
        }
    double maximumPartitionError = 0, maximumReprepareError = 0, maximumCopyError = 0, maximumDryError = 0;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int channels : {1, 2})
            for (int route : {0, 1, 2})
                for (int mode : {0, 1})
                {
                    RenderOptions options; options.rate = rate; options.channels = channels; options.route = route; options.mode = mode;
                    const auto regular = render(options); options.irregular = true; options.preparedBlock = 512;
                    const auto irregular = render(options); const double partitionError = error(regular.audio, irregular.audio);
                    maximumPartitionError = juce::jmax(maximumPartitionError, partitionError);
                    auto* row = new juce::DynamicObject(); row->setProperty("kind", "mono_stereo_routes_partition_and_offline_size");
                    row->setProperty("sampleRate", rate); row->setProperty("channels", channels); row->setProperty("route", route);
                    row->setProperty("mode", mode); row->setProperty("maxError", partitionError);
                    add(row, regular.ready && irregular.ready && regular.finite && irregular.finite
                        && regular.peak > 1e-8 && irregular.peak <= 4 && partitionError < 1e-7);
                }
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int channels : {1, 2})
            for (int initial : {0, 1})
            {
                RenderOptions options; options.rate = rate; options.channels = channels; options.mode = initial; options.route = 2; options.live = true;
                const auto regular = render(options); options.irregular = true; options.preparedBlock = 512;
                const auto irregular = render(options); const double partitionError = error(regular.audio, irregular.audio);
                maximumPartitionError = juce::jmax(maximumPartitionError, partitionError);
                auto* row = new juce::DynamicObject(); row->setProperty("kind", "live_cancel_reverse_hold_and_partition");
                row->setProperty("sampleRate", rate); row->setProperty("channels", channels); row->setProperty("initialMode", initial);
                row->setProperty("maxError", partitionError);
                row->setProperty("midFadePhaseOracle", regular.midFadePhaseProof && irregular.midFadePhaseProof);
                row->setProperty("regularMidFadeReversals", regular.midFadeReversals);
                row->setProperty("irregularMidFadeReversals", irregular.midFadeReversals);
                add(row, regular.ready && irregular.ready && regular.finite && irregular.finite && regular.peak > 1e-8
                    && irregular.peak <= 4 && partitionError < 1e-7 && regular.midFadePhaseProof && irregular.midFadePhaseProof
                    && regular.midFadeReversals == 3 && irregular.midFadeReversals == 3);
            }
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (int channels : {1, 2})
    {
        RenderOptions options; options.rate = rate; options.channels = channels; options.mode = 1;
        options.route = 1; options.routeAutomation = true;
        const auto regular = render(options); options.irregular = true; options.preparedBlock = 512;
        const auto irregular = render(options); const double partitionError = error(regular.audio, irregular.audio);
        maximumPartitionError = juce::jmax(maximumPartitionError, partitionError);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "sleep_wake_route_pitch_engine_hold_scheduling_automation_partition");
        row->setProperty("sampleRate", rate); row->setProperty("channels", channels); row->setProperty("maxError", partitionError);
        add(row, regular.ready && irregular.ready && regular.finite && irregular.finite && regular.peak > 1e-8
            && irregular.peak <= 4 && partitionError < 1e-7);
    }
    for (int mode : {0, 1})
    {
        RenderOptions options; options.mode = mode; options.route = 2;
        const auto original = render(options); options.reprepare = true;
        const auto reprepared = render(options); const double reprepareError = error(original.audio, reprepared.audio);
        maximumReprepareError = juce::jmax(maximumReprepareError, reprepareError);
        options.reprepare = false; options.state = &saved;
        const auto copied = render(options); const double copyError = error(original.audio, copied.audio);
        maximumCopyError = juce::jmax(maximumCopyError, copyError);
        options.state = nullptr; options.dryOnly = true;
        const auto dryA = render(options); options.mode = 1 - mode;
        const auto dryB = render(options); const double dryError = error(dryA.audio, dryB.audio);
        maximumDryError = juce::jmax(maximumDryError, dryError);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "reprepare_copied_full_state_and_dry_unity");
        row->setProperty("mode", mode); row->setProperty("reprepareError", reprepareError); row->setProperty("copyError", copyError);
        row->setProperty("dryError", dryError); add(row, original.finite && reprepared.finite && copied.finite
            && reprepareError == 0 && copyError == 0 && dryError == 0);
    }
    double maximumHostResetError = 0;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int mode : {0, 1})
        {
            RenderOptions options; options.rate = rate; options.route = 2; options.mode = mode; options.explicitReset = true;
            const auto freshReset = render(options); options.reprepare = true;
            const auto dirtiedRepreparedReset = render(options); const double resetError = error(freshReset.audio, dirtiedRepreparedReset.audio);
            maximumHostResetError = juce::jmax(maximumHostResetError, resetError);
            auto* row = new juce::DynamicObject(); row->setProperty("kind", "native_explicit_reset_fresh_vs_dirtied_reprepare");
            row->setProperty("sampleRate", rate); row->setProperty("mode", mode); row->setProperty("maxError", resetError);
            add(row, freshReset.ready && dirtiedRepreparedReset.ready && freshReset.finite && dirtiedRepreparedReset.finite
                && freshReset.peak > 1e-8 && resetError == 0);
        }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Opt-in deterministic Shimmer scheduling");
    result->setProperty("pass", passed && allocations == 0 && frees == 0); result->setProperty("cases", cases);
    result->setProperty("maxPartitionError", maximumPartitionError); result->setProperty("maxReprepareError", maximumReprepareError);
    result->setProperty("maxCopyError", maximumCopyError); result->setProperty("maxDryError", maximumDryError);
    result->setProperty("maxSchedulingResetError", maximumSchedulingResetError); result->setProperty("maxHostResetError", maximumHostResetError);
    result->setProperty("preparedMemoryDiagnostics", preparedMemoryDiagnostics);
    result->setProperty("callbackHeapMeasured", heapMeasured); result->setProperty("callbackAllocations", allocations);
    result->setProperty("callbackFrees", frees); result->setProperty("audioQuality", "not_asserted");
    result->setProperty("scope", "State, deterministic role phases, staged resets, warmup/fade, active-bank suspension, four-rate mono/stereo routing, prepare/copy/host-size parity and dry unity. Release callback heap measurement not asserted.");
    return juce::var(result);
}

inline juce::var profileShimmerSchedulingInstances()
{
    using namespace ShimmerSchedulingRegression;
    const auto environment = [](const char* name, const char* fallback) {
        return juce::SystemStats::getEnvironmentVariable(name, fallback);
    };
    const double rate = juce::jlimit(44100.0, 192000.0, environment("OPENSTUDIO_SHIMMER_BENCH_RATE", "48000").getDoubleValue());
    const int frames = juce::jlimit(32, 512, environment("OPENSTUDIO_SHIMMER_BENCH_BLOCK", "128").getIntValue());
    const bool spreadOnly = environment("OPENSTUDIO_SHIMMER_BENCH_SPREAD_ONLY", "0") == "1";
#if JUCE_DEBUG
    constexpr int observations = 128;
#else
    constexpr int observations = 2048;
#endif
    const int warmup = juce::jmax(256, static_cast<int>(rate * .65 / frames));
    bool finite = true, stateCopies = true, transitionsSettled = true;
    juce::Array<juce::var> cases;
    for (int route : {0, 1, 2}) for (int instances : {1, 4, 8})
        for (int mode : {0, 1}) for (bool identical : {false, true})
        {
            if (spreadOnly && mode == 0) continue;
            auto preset = std::make_unique<OpenStudioReverb>(true); preset->selectAlgorithm(5);
            preset->shimmerScheduling.store(static_cast<float>(mode)); preset->creativeControls[0].store(static_cast<float>(route));
            preset->shimmerAmount.store(1); preset->shimmerVoiceMix.store(.5f); preset->wetLevel.store(1); preset->dryLevel.store(0);
            juce::MemoryBlock state; preset->getStateInformation(state);
            std::vector<std::unique_ptr<OpenStudioReverb>> processors;
            std::vector<juce::AudioBuffer<float>> blocks;
            processors.reserve(static_cast<size_t>(instances)); blocks.reserve(static_cast<size_t>(instances));
            double prepareMs = 0;
            for (int index = 0; index < instances; ++index)
            {
                auto processor = std::make_unique<OpenStudioReverb>(true);
                processor->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
                juce::MemoryBlock repeated; processor->getStateInformation(repeated); stateCopies = state == repeated && stateCopies;
                const auto begin = juce::Time::getHighResolutionTicks(); processor->prepareToPlay(rate, frames);
                prepareMs += juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - begin) * 1000;
                blocks.emplace_back(processor->getTotalNumOutputChannels(), frames); processors.push_back(std::move(processor));
            }
            juce::MidiBuffer midi;
            std::vector<double> timings; timings.reserve(observations);
            double totalUs = 0; int overruns = 0;
            for (int iteration = -warmup; iteration < observations; ++iteration)
            {
                for (int index = 0; index < instances; ++index)
                {
                    auto& block = blocks[static_cast<size_t>(index)]; block.clear();
                    for (int sample = 0; sample < frames; ++sample)
                    {
                        const double phase = .047 * ((iteration + warmup) * frames + sample + (identical ? 0 : index * 137));
                        const float value = .04f * static_cast<float>(std::sin(phase) + .27 * std::sin(phase * 2.37));
                        block.setSample(0, sample, value); block.setSample(1, sample, value * .8f);
                    }
                }
                const auto begin = juce::Time::getHighResolutionTicks();
                for (int index = 0; index < instances; ++index)
                    processors[static_cast<size_t>(index)]->processBlock(blocks[static_cast<size_t>(index)], midi);
                const double elapsed = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - begin) * 1e6;
                if (iteration >= 0) { timings.push_back(elapsed); totalUs += elapsed; overruns += elapsed > frames / rate * 1e6 ? 1 : 0; }
                for (const auto& block : blocks) for (int channel = 0; channel < block.getNumChannels(); ++channel)
                    for (int sample = 0; sample < frames; ++sample) finite = std::isfinite(block.getSample(channel, sample)) && finite;
            }
            std::sort(timings.begin(), timings.end());
            auto* row = new juce::DynamicObject(); row->setProperty("route", route); row->setProperty("instances", instances);
            row->setProperty("scheduling", mode == 0 ? "Original" : "Spread");
            row->setProperty("copiedFullState", true); row->setProperty("identicalInput", identical);
            row->setProperty("prepareMsTotal", prepareMs); row->setProperty("averageUs", totalUs / observations);
            row->setProperty("medianUs", timings[timings.size() / 2]); row->setProperty("p95Us", timings[timings.size() * 95 / 100]);
            row->setProperty("p99Us", timings[timings.size() * 99 / 100]); row->setProperty("maxUs", timings.back());
            row->setProperty("budgetUs", frames / rate * 1e6); row->setProperty("deadlineOverruns", overruns); cases.add(juce::var(row));
        }
    // Live switches include the staged clear, dual-bank warmup and fade. These
    // timing rows deliberately do not assert a deadline while Original is live.
    juce::Array<juce::var> transitions;
    for (double sampleRate : {48000.0, 192000.0}) for (int instances : {1, 8}) for (int initialMode : {0, 1})
    {
        if (spreadOnly) continue;
        std::vector<std::unique_ptr<OpenStudioReverb>> processors;
        std::vector<juce::AudioBuffer<float>> blocks;
        for (int index = 0; index < instances; ++index)
        {
            auto processor = std::make_unique<OpenStudioReverb>(true); processor->selectAlgorithm(5);
            processor->shimmerScheduling.store(static_cast<float>(initialMode)); processor->creativeControls[0].store(2);
            processor->shimmerAmount.store(1); processor->shimmerVoiceMix.store(.5f); processor->wetLevel.store(1); processor->dryLevel.store(0);
            processor->prepareToPlay(sampleRate, frames);
            blocks.emplace_back(processor->getTotalNumOutputChannels(), frames); processors.push_back(std::move(processor));
        }
        const int settleBlocks = static_cast<int>(sampleRate * .35) / frames + 1;
        BuiltInSpreadReverbPitchVoice timingProbe;
        timingProbe.prepare(sampleRate, 3);
        // Observe every reset, prime, warmup and fade phase plus a settled
        // margin. A fixed 230 ms window ended before some bounded clears did.
        const int liveSamples = 192 + timingProbe.resetSamples() + timingProbe.latencySamples()
            + (initialMode == 0 ? timingProbe.primingSamples() : 0)
            + juce::roundToInt(sampleRate * .07);
        const int liveBlocks = (liveSamples + frames - 1) / frames;
        juce::MidiBuffer midi; std::vector<double> timings; timings.reserve(static_cast<size_t>(liveBlocks));
        double totalUs = 0; int overruns = 0;
        for (int iteration = -settleBlocks; iteration < liveBlocks; ++iteration)
        {
            if (iteration == 0) for (auto& processor : processors) processor->shimmerScheduling.store(initialMode == 0 ? 1.0f : 0.0f);
            for (auto& block : blocks)
            {
                block.clear();
                for (int sample = 0; sample < frames; ++sample)
                {
                    const float value = .04f * static_cast<float>(std::sin(.047 * ((iteration + settleBlocks) * frames + sample)));
                    block.setSample(0, sample, value); block.setSample(1, sample, value * .8f);
                }
            }
            const auto begin = juce::Time::getHighResolutionTicks();
            for (int index = 0; index < instances; ++index) processors[static_cast<size_t>(index)]->processBlock(blocks[static_cast<size_t>(index)], midi);
            const double elapsed = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - begin) * 1e6;
            if (iteration >= 0) { timings.push_back(elapsed); totalUs += elapsed; overruns += elapsed > frames / sampleRate * 1e6 ? 1 : 0; }
            for (const auto& block : blocks) for (int channel = 0; channel < block.getNumChannels(); ++channel)
                for (int sample = 0; sample < frames; ++sample) finite = std::isfinite(block.getSample(channel, sample)) && finite;
        }
        bool settled = true;
        for (const auto& processor : processors)
            settled = OpenStudioReverbCompatibilityRegressionAccess::shimmerSettled(*processor)
                && OpenStudioReverbCompatibilityRegressionAccess::shimmerSpread(*processor) == (initialMode == 0) && settled;
        transitionsSettled = transitionsSettled && settled;
        std::sort(timings.begin(), timings.end());
        auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", sampleRate); row->setProperty("instances", instances);
        row->setProperty("route", 2); row->setProperty("identicalInput", true); row->setProperty("initialMode", initialMode);
        row->setProperty("observedSamples", liveBlocks * frames); row->setProperty("settledAtEnd", settled);
        row->setProperty("averageUs", totalUs / liveBlocks); row->setProperty("p95Us", timings[timings.size() * 95 / 100]);
        row->setProperty("p99Us", timings[timings.size() * 99 / 100]); row->setProperty("maxUs", timings.back());
        row->setProperty("budgetUs", frames / sampleRate * 1e6); row->setProperty("deadlineOverruns", overruns); transitions.add(juce::var(row));
    }
    // Extra bank preparation/memory and reset work are separate from warmed
    // callback timings. Private-byte deltas are approximate allocator readings.
    juce::Array<juce::var> preparation;
    for (double sampleRate : {48000.0, 192000.0})
    {
        if (spreadOnly) continue;
        auto original = std::make_unique<std::array<BuiltInReverbPitchVoice, 4>>();
        const auto oldBegin = juce::Time::getHighResolutionTicks();
        for (auto& voice : *original) voice.prepare(sampleRate);
        const double originalMs = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - oldBegin) * 1000;
        const auto before = privateBytes();
        auto spread = std::make_unique<std::array<BuiltInSpreadReverbPitchVoice, 4>>();
        const auto newBegin = juce::Time::getHighResolutionTicks();
        constexpr std::array<int, 4> rolePhases{0, 2, 1, 3};
        for (size_t role = 0; role < spread->size(); ++role) (*spread)[role].prepare(sampleRate, rolePhases[role]);
        const double extraMs = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - newBegin) * 1000;
        const auto after = privateBytes();
        double worstResetUs = 0;
        for (auto& voice : *spread) for (int iteration = 0; iteration < 32; ++iteration)
        {
            const auto begin = juce::Time::getHighResolutionTicks(); voice.reset();
            worstResetUs = juce::jmax(worstResetUs,
                juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - begin) * 1e6);
        }
        double worstFourVoiceResetUs = 0;
        for (int iteration = 0; iteration < 32; ++iteration)
        {
            const auto begin = juce::Time::getHighResolutionTicks();
            for (auto& voice : *spread) voice.reset();
            worstFourVoiceResetUs = juce::jmax(worstFourVoiceResetUs,
                juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - begin) * 1e6);
        }
        auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", sampleRate);
        row->setProperty("fourOriginalVoicesPrepareMs", originalMs); row->setProperty("fourExtraSpreadVoicesPrepareMs", extraMs);
        row->setProperty("extraSpreadPrivateBytesDeltaApprox",
                         static_cast<juce::int64>(before >= 0 && after >= before ? after - before : -1));
        row->setProperty("worstSingleSpreadVoiceResetUs", worstResetUs);
        row->setProperty("worstFourSpreadVoiceHistoryResetUs", worstFourVoiceResetUs); preparation.add(juce::var(row));
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Whole-wrapper synchronized Shimmer scheduling cost");
    result->setProperty("pass", finite && stateCopies && transitionsSettled); result->setProperty("finiteOutput", finite); result->setProperty("fullStateCopiesExact", stateCopies);
    result->setProperty("allLiveTransitionsSettled", transitionsSettled);
    result->setProperty("cases", cases); result->setProperty("liveTransitions", transitions);
    result->setProperty("preparation", preparation); result->setProperty("observations", observations);
    result->setProperty("warmupBlocks", warmup); result->setProperty("spreadOnly", spreadOnly);
    result->setProperty("sampleRate", rate); result->setProperty("blockSize", frames); result->setProperty("cpu", juce::SystemStats::getCpuModel());
    result->setProperty("timing", "diagnostic_only"); result->setProperty("deviceDropouts", "not_asserted"); result->setProperty("audioQuality", "not_asserted");
    result->setProperty("scope", "Serial whole-plugin callbacks, 1/4/8 synchronized full-state copies, Tank/Input/Both, identical and varied inputs, warm steady state. Timing and approximate memory are diagnostics; host graph/device scheduling and live-switch deadline guarantees are not asserted.");
    return juce::var(result);
}
