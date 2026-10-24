#pragma once
#include "BuiltInReverbReturnLevels.h"
#include <limits>

// Actual standalone wrapper checks. The scalar references below test routing
// and gain placement, not perceived loudness, audibility or acoustic fidelity.
namespace ReverbReturnRegression
{
struct Options
{
    double rate = 48000;
    int channels = 2, type = 0, mode = 0, nextType = -1;
    float wet = 1, dry = 0, amplitude = .003f;
    bool irregular = true, live = false, legacy = false, spillover = false;
    bool customIR = false, embedded = false;
    bool maximumDecay = false, held = false;
    const juce::ValueTree* irState = nullptr;
};
struct Capture
{
    juce::AudioBuffer<float> audio;
    bool prepared = true, finite = true;
    double peak = 0;
};
inline double error(const juce::AudioBuffer<float>& first, const juce::AudioBuffer<float>& second,
                    double scale = 1, int begin = 0)
{
    if (first.getNumChannels() != second.getNumChannels() || first.getNumSamples() != second.getNumSamples())
        return std::numeric_limits<double>::infinity();
    double maximum = 0;
    for (int channel = 0; channel < first.getNumChannels(); ++channel)
        for (int sample = begin; sample < first.getNumSamples(); ++sample)
            maximum = juce::jmax(maximum, std::abs(static_cast<double>(first.getSample(channel, sample))
                - static_cast<double>(second.getSample(channel, sample)) * scale));
    return maximum;
}
inline juce::MemoryBlock bytes(const juce::ValueTree& tree)
{
    juce::MemoryBlock result;
    { juce::MemoryOutputStream stream(result, false); tree.writeToStream(stream); }
    return result;
}
}

inline juce::var checkReverbReturnCalibration()
{
    using namespace ReverbReturnRegression;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Standalone bounded wet-return calibration");
    result->setProperty("audioQuality", "not_asserted");
    result->setProperty("audibility", "not_asserted");
    result->setProperty("dominance", "not_asserted");
    juce::Array<juce::var> cases;
    bool overall = true, heapMeasured = false;
    int allocations = 0, frees = 0;
    double maximumGainError = 0, maximumPartitionError = 0, maximumDryError = 0;
    const auto add = [&] (juce::DynamicObject* row, bool pass) {
        row->setProperty("pass", pass); cases.add(juce::var(row)); overall = overall && pass;
    };
    const auto processChecked = [&] (OpenStudioReverb& processor, juce::AudioBuffer<float>& audio, juce::MidiBuffer& midi) {
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::allocations = ReverbCompatibilityHeapProbe::frees = 0;
        ReverbCompatibilityHeapProbe::previous = _CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
        ReverbCompatibilityHeapProbe::active = true;
#endif
        processor.processBlock(audio, midi);
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::active = false;
        _CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
        allocations += ReverbCompatibilityHeapProbe::allocations;
        frees += ReverbCompatibilityHeapProbe::frees;
        heapMeasured = true;
#endif
    };

    auto source = std::make_unique<OpenStudioReverb>(true);
    auto restored = std::make_unique<OpenStudioReverb>(true);
    auto embedded = std::make_unique<OpenStudioReverb>(false);
    bool statePass = source->reverbReturnMode.load() == 1 && embedded->reverbReturnMode.load() == 0;
    statePass = setFreePluginParamForRegression(*source, "reverbReturnMode", 0)
        && source->reverbReturnMode.load() == 0 && statePass;
    juce::MemoryBlock saved, repeated;
    source->getStateInformation(saved);
    restored->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    restored->getStateInformation(repeated);
    statePass = saved == repeated && restored->reverbReturnMode.load() == 0 && statePass;
    statePass = setFreePluginNormalizedForRegression(*restored, "reverbReturnMode", 1)
        && restored->reverbReturnMode.load() == 1 && statePass;
    restored->selectAlgorithm(40); restored->selectSendMode(true);
    statePass = restored->reverbReturnMode.load() == 1 && statePass;
    auto oldTree = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
    oldTree.removeProperty("reverbReturnMode", nullptr);
    const auto oldBytes = bytes(oldTree);
    restored->setStateInformation(oldBytes.getData(), static_cast<int>(oldBytes.getSize()));
    statePass = restored->reverbReturnMode.load() == 0 && statePass;
    oldTree.setProperty("reverbReturnMode", std::numeric_limits<double>::quiet_NaN(), nullptr);
    const auto invalidBytes = bytes(oldTree);
    restored->setStateInformation(invalidBytes.getData(), static_cast<int>(invalidBytes.getSize()));
    statePass = restored->reverbReturnMode.load() == 0 && statePass;
    statePass = !setFreePluginParamForRegression(*embedded, "reverbReturnMode", 1)
        && !setFreePluginNormalizedForRegression(*embedded, "reverbReturnMode", 1) && statePass;
    const auto parameters = describeFreePluginForRegression(*source)["parameters"];
    statePass = parameters.size() == 1090 && parameters[1084]["id"].toString() == "outputTrimDb"
        && parameters[1085]["id"].toString() == "reverbCharacterMode"
        && parameters[1086]["id"].toString() == "reverbReturnMode"
        && static_cast<bool>(parameters[1086]["automatable"])
        && static_cast<float>(parameters[1086]["defaultValue"]) == 1 && statePass;
    auto* stateRow = new juce::DynamicObject(); stateRow->setProperty("kind", "state_and_append_only_migration");
    add(stateRow, statePass);

    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-return-tests");
    juce::AudioBuffer<float> ir(4, 2048); ir.clear();
    for (int channel = 0; channel < 4; ++channel) ir.setSample(channel, 31 + channel * 73, .25f - .035f * channel);
    const auto customFile = directory.getChildFile("Studio room (generated).wav");
    bool fixturePass = writeProbeWave(customFile, ir, 48000);
    const auto render = [&] (const Options& options) {
        auto processor = std::make_unique<OpenStudioReverb>(!options.embedded);
        auto layout = processor->getBusesLayout();
        layout.inputBuses.set(0, options.channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
        layout.outputBuses.set(0, options.channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
        Capture capture;
        capture.prepared = processor->setBusesLayout(layout);
        processor->selectAlgorithm(options.type);
        processor->reverbReturnMode.store(static_cast<float>(options.mode));
        processor->wetLevel.store(options.wet); processor->dryLevel.store(options.dry);
        processor->tailSpillover.store(options.spillover ? 1.0f : 0.0f);
        if (options.maximumDecay)
        {
            processor->decayTime.store(options.type == 6 ? 2.0f : 20.0f);
            if (options.type == 4) processor->springControls[0].store(1); // Dispersive, internally capped at 10 s.
            if (options.type == 6)
            {
                processor->creativeControls[1].store(.95f); // Maximum envelope feedback.
                processor->creativeControls[2].store(20); processor->creativeControls[3].store(1);
            }
            if (options.type == 19) processor->ambientControls[2][8].store(50);
            if (options.type >= 27) processor->retroControls[static_cast<size_t>(options.type - 27)][0].store(70);
        }
        if (options.held)
        {
            processor->holdInputModes[static_cast<size_t>(options.type)].store(1); // Accumulate nonzero input in Infinite.
            if (options.type == 4) processor->springHold.store(1);
            else if (options.type == 5) processor->shimmerHold.store(1);
            else if (options.type == 6) processor->nonlinearHold.store(1);
            else if (options.type == 19 || options.type == 20)
                processor->ambientControls[static_cast<size_t>(options.type - 17)][9].store(1);
            else processor->freezeMode.store(1);
        }
        if (options.legacy)
        {
            processor->studioEngines[0].store(0); processor->plateEngine.store(0);
        }
        if (options.customIR)
        {
            auto* shape = new juce::DynamicObject(); shape->setProperty("normalise", false); shape->setProperty("outputLayout", 1);
            const juce::var settings(shape);
            capture.prepared = processor->convolutionSpace.loadFile(customFile)
                && capture.prepared;
            if (options.irState) capture.prepared = processor->convolutionSpace.restore(*options.irState) && capture.prepared;
            capture.prepared = processor->convolutionSpace.edit(settings) && capture.prepared;
        }
        else if (options.irState) capture.prepared = processor->convolutionSpace.restore(*options.irState) && capture.prepared;
        constexpr int preparedBlock = 256, maximumBlock = 1021;
        processor->prepareToPlay(options.rate, preparedBlock);
        const int length = juce::roundToInt(options.rate * .40), event = juce::roundToInt(options.rate * .16);
        const int outputs = processor->getTotalNumOutputChannels();
        capture.audio.setSize(outputs, length);
        juce::AudioBuffer<float> block(outputs, maximumBlock); juce::MidiBuffer midi;
        const std::array<int,5> partitions {1,17,63,257,1021};
        for (int start = 0, part = 0; start < length; ++part)
        {
            if (start == event)
            {
                if (options.live) processor->reverbReturnMode.store(options.mode == 0 ? 1.0f : 0.0f);
                if (options.nextType >= 0) processor->selectAlgorithm(options.nextType);
            }
            int count = juce::jmin(options.irregular ? partitions[static_cast<size_t>(part % 5)] : preparedBlock, length - start);
            if (start < event) count = juce::jmin(count, event - start);
            block.setSize(outputs, count, false, false, true); block.clear();
            for (int sample = 0; sample < count; ++sample)
            {
                const int position = start + sample;
                const bool feed = options.nextType < 0 || position < event;
                const double time = static_cast<double>(position) / options.rate;
                const float signal = feed ? options.amplitude * static_cast<float>(
                    std::sin(juce::MathConstants<double>::twoPi * 223 * time)
                    + .47 * std::sin(juce::MathConstants<double>::twoPi * 977 * time)
                    + .21 * std::sin(juce::MathConstants<double>::twoPi * 3001 * time)) : 0.0f;
                for (int channel = 0; channel < options.channels; ++channel)
                    block.setSample(channel, sample, signal * (channel == 0 ? 1.0f : -.73f));
            }
            processChecked(*processor, block, midi);
            for (int channel = 0; channel < outputs; ++channel)
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

    // Fixed-mode gain placement for every current default voice, plus exact
    // dry-only parity. No fitted calibration or perceptual threshold is tested.
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
    {
        Options options; options.type = type;
        const auto original = render(options); options.mode = 1;
        const auto calibrated = render(options);
        const double gainError = error(calibrated.audio, original.audio, BuiltInReverbReturnLevels::linear[static_cast<size_t>(type)]);
        options.wet = 0; options.dry = .7f;
        const auto calibratedDry = render(options); options.mode = 0;
        const auto originalDry = render(options);
        const double dryError = error(calibratedDry.audio, originalDry.audio);
        maximumGainError = juce::jmax(maximumGainError, gainError);
        maximumDryError = juce::jmax(maximumDryError, dryError);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "all_default_voice_wet_gain_and_dry_parity");
        row->setProperty("type", type); row->setProperty("maxGainError", gainError); row->setProperty("maxDryError", dryError);
        row->setProperty("gainDb", BuiltInReverbReturnLevels::decibels[static_cast<size_t>(type)]);
        add(row, original.prepared && calibrated.prepared && original.finite && calibrated.finite
            && original.peak > 0 && calibrated.peak > 0 && gainError < 2e-6 && dryError == 0);
    }

    // Shared live fade is measured through nonzero wet audio, at four rates,
    // in both main layouts and with callbacks larger than the prepared size.
    for (const double rate : {44100.0,48000.0,96000.0,192000.0})
        for (const int channels : {1,2})
            for (const int initialMode : {0,1})
            {
                Options options; options.type = 1; options.rate = rate; options.channels = channels;
                options.mode = initialMode; options.live = true;
                const auto live = render(options); options.irregular = false;
                const auto regular = render(options); options.live = false; options.mode = 0;
                const auto original = render(options); options.mode = 1;
                const auto calibrated = render(options);
                const double partitionError = error(live.audio, regular.audio);
                const int event = juce::roundToInt(rate * .16), ramp = static_cast<int>(rate * .02);
                double rampError = 0;
                for (int channel = 0; channel < live.audio.getNumChannels(); ++channel)
                    for (int sample = 0; sample < live.audio.getNumSamples(); ++sample)
                    {
                        const double position = sample < event ? 0.0 : juce::jlimit(0.0, 1.0,
                            static_cast<double>(sample - event + 1) / ramp);
                        const double blend = initialMode == 0 ? position : 1 - position;
                        const double a = original.audio.getSample(channel, sample), b = calibrated.audio.getSample(channel, sample);
                        rampError = juce::jmax(rampError, std::abs(static_cast<double>(live.audio.getSample(channel, sample)) - (a + blend * (b - a))));
                    }
                maximumPartitionError = juce::jmax(maximumPartitionError, partitionError);
                auto* row = new juce::DynamicObject(); row->setProperty("kind", "twenty_ms_live_mode_fade_and_partition");
                row->setProperty("sampleRate", rate); row->setProperty("channels", channels); row->setProperty("initialMode", initialMode);
                row->setProperty("maxRampError", rampError); row->setProperty("maxPartitionError", partitionError);
                add(row, live.prepared && live.finite && partitionError < 2e-6 && rampError < 2e-6);
            }

    for (const double rate : {44100.0,48000.0,96000.0,192000.0})
        for (const int channels : {1,2})
            for (const int type : {0,2})
    {
        Options options; options.type = type; options.legacy = true; options.rate = rate; options.channels = channels;
        const auto original = render(options); options.mode = 1;
        const auto calibrated = render(options);
        const double unchanged = error(calibrated.audio, original.audio);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "legacy_engine_unity");
        row->setProperty("type", type); row->setProperty("sampleRate", rate); row->setProperty("channels", channels);
        row->setProperty("maxOutputError", unchanged);
        add(row, original.finite && calibrated.finite && unchanged == 0);
    }
    {
        Options options; options.embedded = true;
        const auto original = render(options); options.mode = 1;
        const auto unchanged = render(options);
        const double difference = error(unchanged.audio, original.audio);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "embedded_processor_ignores_standalone_return_mode");
        row->setProperty("maxOutputError", difference);
        add(row, original.prepared && unchanged.prepared && original.finite && unchanged.finite && difference == 0);
    }
    for (const std::array<int,2> transition : {std::array<int,2>{0,1},{10,11},{12,13},{15,16},{17,18},{21,22},{24,25},{27,28},{4,6}})
    {
        Options options; options.type = transition[0]; options.nextType = transition[1]; options.spillover = true;
        const auto original = render(options); options.mode = 1;
        const auto calibrated = render(options);
        const int begin = juce::roundToInt(options.rate * .22);
        const double tailError = error(calibrated.audio, original.audio,
            BuiltInReverbReturnLevels::linear[static_cast<size_t>(options.type)], begin);
        const double tailPeak = original.audio.getMagnitude(0, begin, original.audio.getNumSamples() - begin);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "retiring_type_keeps_its_own_gain");
        row->setProperty("outgoingType", transition[0]); row->setProperty("incomingType", transition[1]);
        row->setProperty("maxTailGainError", tailError); row->setProperty("originalTailPeak", tailPeak);
        add(row, original.finite && calibrated.finite && tailPeak > 1e-10 && tailError < 2e-6);
    }
    for (const int type : {6,15,19,20,24,33})
    {
        Options options; options.type = type; options.mode = 1; options.amplitude = 3;
        const auto capture = render(options);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "high_input_finite_safety_bound");
        row->setProperty("type", type); row->setProperty("peak", capture.peak);
        add(row, capture.prepared && capture.finite && capture.peak <= 4.0);
    }
    for (const int type : {2,4,5,6,19,20,24,38})
        for (const bool held : {false,true})
    {
        Options options; options.type = type; options.mode = 1; options.amplitude = .25f;
        options.maximumDecay = true; options.held = held;
        const auto capture = render(options);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "maximum_decay_and_infinite_hold_finite_bound");
        row->setProperty("type", type); row->setProperty("holdAcceptsInput", held); row->setProperty("seconds", .40);
        row->setProperty("peak", capture.peak);
        row->setProperty("long_duration_hold_stability", "not_asserted");
        add(row, capture.prepared && capture.finite && capture.peak <= 4.0);
    }

    bool markerPass = fixturePass;
    juce::ValueTree defaultTree("IR"), customTree("IR");
    BuiltInConvolution defaultIR, customIR;
    markerPass = defaultIR.selectDefault() && customIR.loadFile(customFile) && markerPass;
    defaultIR.save(defaultTree); customIR.save(customTree);
    markerPass = static_cast<bool>(defaultTree["irGeneratedDefault"])
        && !static_cast<bool>(customTree["irGeneratedDefault"]) && markerPass;
    customTree.setProperty("irName", "Studio room (generated)", nullptr);
    BuiltInConvolution collision;
    markerPass = collision.restore(customTree) && markerPass;
    juce::ValueTree collisionTree("IR"); collision.save(collisionTree);
    markerPass = !static_cast<bool>(collisionTree["irGeneratedDefault"]) && markerPass;
    defaultTree.removeProperty("irGeneratedDefault", nullptr);
    BuiltInConvolution migratedDefault;
    markerPass = migratedDefault.restore(defaultTree) && markerPass;
    juce::ValueTree migratedTree("IR"); migratedDefault.save(migratedTree);
    markerPass = static_cast<bool>(migratedTree["irGeneratedDefault"]) && markerPass;
    customTree.setProperty("irName", "custom matrix.wav", nullptr); customTree.removeProperty("irGeneratedDefault", nullptr);
    BuiltInConvolution migratedCustom;
    markerPass = migratedCustom.restore(customTree) && markerPass;
    juce::ValueTree migratedCustomTree("IR"); migratedCustom.save(migratedCustomTree);
    markerPass = !static_cast<bool>(migratedCustomTree["irGeneratedDefault"]) && markerPass;
    auto* markerRow = new juce::DynamicObject(); markerRow->setProperty("kind", "generated_and_custom_ir_marker_migration");
    add(markerRow, markerPass);
    {
        Options options; options.type = 7; options.irState = &defaultTree;
        const auto original = render(options); options.mode = 1;
        const auto calibrated = render(options);
        const double difference = error(calibrated.audio, original.audio, BuiltInReverbReturnLevels::linear[7]);
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "old_generated_ir_marker_uses_generated_gain");
        row->setProperty("maxGainError", difference);
        add(row, original.prepared && calibrated.prepared && original.finite && calibrated.finite && difference < 2e-6);
    }
    for (const double rate : {44100.0,48000.0,96000.0,192000.0})
        for (const int channels : {1,2})
    {
    Options matrix; matrix.type = 7; matrix.customIR = true; matrix.irState = &collisionTree;
    matrix.rate = rate; matrix.channels = channels;
    const auto originalMatrix = render(matrix); matrix.mode = 1;
    const auto calibratedMatrix = render(matrix);
    const double matrixError = error(calibratedMatrix.audio, originalMatrix.audio);
    bool allFourNonzero = originalMatrix.audio.getNumChannels() == channels + 2;
    for (int channel = 0; channel < originalMatrix.audio.getNumChannels(); ++channel)
        allFourNonzero = originalMatrix.audio.getMagnitude(channel, 0, originalMatrix.audio.getNumSamples()) > 1e-10 && allFourNonzero;
    matrix.wet = 0; matrix.dry = .7f;
    const auto calibratedMatrixDry = render(matrix); matrix.mode = 0;
    const auto originalMatrixDry = render(matrix);
    const double matrixDryError = error(calibratedMatrixDry.audio, originalMatrixDry.audio);
    auto* matrixRow = new juce::DynamicObject(); matrixRow->setProperty("kind", "custom_matrix_ir_main_and_cross_unity_and_dry");
    matrixRow->setProperty("sampleRate", rate); matrixRow->setProperty("mainChannels", channels);
    matrixRow->setProperty("maxOutputError", matrixError); matrixRow->setProperty("maxDryError", matrixDryError);
    matrixRow->setProperty("fourOutputsNonzero", allFourNonzero);
    add(matrixRow, originalMatrix.prepared && calibratedMatrix.prepared && originalMatrix.finite
        && calibratedMatrix.finite && allFourNonzero && matrixError == 0 && matrixDryError == 0);
    }
    auto* heapRow = new juce::DynamicObject(); heapRow->setProperty("kind", "callback_heap_probe");
    heapRow->setProperty("measured", heapMeasured); heapRow->setProperty("allocations", allocations); heapRow->setProperty("frees", frees);
    add(heapRow, allocations == 0 && frees == 0);
    result->setProperty("pass", overall); result->setProperty("cases", cases); result->setProperty("caseCount", cases.size());
    result->setProperty("maxGainError", maximumGainError); result->setProperty("maxDryError", maximumDryError);
    result->setProperty("maxPartitionError", maximumPartitionError); result->setProperty("callbackHeapMeasured", heapMeasured);
    result->setProperty("callbackAllocations", allocations); result->setProperty("callbackFrees", frees);
    result->setProperty("scope", "Routing, fixed gains, preserved dry/legacy/custom IR, state, bounded output and fade partitioning. No audibility or dominance claim; Release heap probe is not asserted.");
    return result;
}
