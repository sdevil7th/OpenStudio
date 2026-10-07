#pragma once

inline juce::var checkDriftingReverb()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Drifting hall, chamber and diffuse networks");
    bool finite = true, distinct = true, partition = true, controls = true, spillover = true, hold = true;
    juce::Array<juce::var> cases;
    const auto render = [](double rate, int mode, BuiltInDriftingReverb::Settings settings, int block, bool retire, bool retain, float impulse)
    {
        auto engine = std::make_unique<BuiltInDriftingReverb>(); engine->prepare(rate, mode);
        const int length = juce::roundToInt(rate * .8), switchAt = juce::roundToInt(rate * .2);
        juce::AudioBuffer<float> output(2, length);
        for (int start = 0; start < length;)
        {
            const int count = juce::jmin(block, length - start, start < switchAt ? switchAt - start : length - start);
            engine->configure(retire && start >= switchAt ? -1 : mode, settings, retain);
            for (int i = 0; i < count; ++i)
            {
                const auto sample = engine->process(start + i == 0 ? impulse : 0, start + i == 0 ? impulse * .3f : 0);
                output.setSample(0, start + i, sample[0]); output.setSample(1, start + i, sample[1]);
            }
            start += count;
        }
        return output;
    };
    const auto energy = [](const juce::AudioBuffer<float>& audio, int first)
    {
        double value = 0; for (int ch = 0; ch < 2; ++ch) for (int i = first; i < audio.getNumSamples(); ++i) value += static_cast<double>(audio.getSample(ch, i)) * audio.getSample(ch, i); return value;
    };
    const auto difference = [](const auto& a, const auto& b)
    {
        double value = 0; for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < a.getNumSamples(); ++i) value = juce::jmax(value, std::abs(static_cast<double>(a.getSample(ch, i) - b.getSample(ch, i)))); return value;
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        std::array<juce::AudioBuffer<float>, 3> modes;
        for (int mode = 0; mode < 3; ++mode)
        {
            BuiltInDriftingReverb::Settings settings; settings.decay = 1; settings.damping = .2f;
            modes[static_cast<size_t>(mode)] = render(rate, mode, settings, 127, false, false, .8f);
            const auto& baseline = modes[static_cast<size_t>(mode)]; const auto otherPartition = render(rate, mode, settings, 512, false, false, .8f);
            partition = partition && difference(baseline, otherPartition) == 0;
            const double total = energy(baseline, 0); finite = finite && total > 1e-7 && std::isfinite(total) && baseline.getMagnitude(0, baseline.getNumSamples()) < 4;
            settings.drive = 24; settings.emphasis = 1;
            const auto driven = render(rate, mode, settings, 127, false, false, .8f);
            controls = controls && difference(baseline, driven) > 1e-6;
            settings.drive = 6; settings.emphasis = .5f; settings.wow = settings.flutter = 0;
            const auto stationary = render(rate, mode, settings, 127, false, false, .8f);
            controls = controls && difference(baseline, stationary) > 1e-5;
            settings.wow = .2f; settings.flutter = .1f;
            const auto kept = render(rate, mode, settings, 127, true, true, .8f), faded = render(rate, mode, settings, 127, true, false, .8f);
            spillover = spillover && difference(baseline, kept) < 1e-7 && energy(kept, juce::roundToInt(rate * .4)) > 1e-8 && energy(faded, juce::roundToInt(rate * .4)) == 0;
            auto engine = std::make_unique<BuiltInDriftingReverb>(); engine->prepare(rate, mode); settings.hold = true; settings.holdInput = false; engine->configure(mode, settings, false);
            double frozen = 0; for (int i = 0; i < static_cast<int>(rate * .25); ++i) { const auto out = engine->process(i == 0 ? 1.0f : 0.0f, 0); frozen += std::abs(out[0]) + std::abs(out[1]); }
            engine->reset(); settings.holdInput = true; engine->configure(mode, settings, false);
            double infinite = 0; for (int i = 0; i < static_cast<int>(rate * .25); ++i) { const auto out = engine->process(i == 0 ? .2f : 0.0f, 0); infinite += std::abs(out[0]) + std::abs(out[1]); }
            hold = hold && frozen == 0 && infinite > .001;
            auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("mode", mode); row->setProperty("impulseEnergyDiagnostic", total); row->setProperty("controlDifference", difference(baseline, driven)); cases.add(row);
        }
        distinct = distinct && difference(modes[0], modes[1]) > .001 && difference(modes[0], modes[2]) > .001 && difference(modes[1], modes[2]) > .001;
    }
    auto source = std::make_unique<OpenStudioReverb>(true), copy = std::make_unique<OpenStudioReverb>(true);
    bool setters = true;
    for (int mode = 21; mode <= 23; ++mode)
    {
        setters = setters && setFreePluginParamForRegression(*source, "reverbTypeExpanded", static_cast<float>(mode))
            && setFreePluginParamForRegression(*source, "driftDrive", static_cast<float>(mode - 20) * 3)
            && setFreePluginParamForRegression(*source, "driftWow", static_cast<float>(mode - 20) * .2f)
            && setFreePluginParamForRegression(*source, "decayTime", static_cast<float>(mode - 20));
    }
    juce::MemoryBlock state, again; source->getStateInformation(state); copy->setStateInformation(state.getData(), static_cast<int>(state.getSize())); copy->getStateInformation(again);
    bool recall = state == again && copy->algorithm.load() == 23;
    for (int mode = 21; mode <= 23; ++mode) { copy->selectAlgorithm(mode); recall = recall && copy->decayTime.load() == static_cast<float>(mode - 20) && copy->driftingControls[static_cast<size_t>(mode - 21)][0].load() == static_cast<float>(mode - 20) * 3; }
    auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize());
    for (int bank = 0; bank < 3; ++bank) for (int field = 0; field < 7; ++field) tree.removeProperty("drifting"+juce::String(bank)+"_"+juce::String(field), nullptr);
    juce::MemoryBlock legacy; juce::MemoryOutputStream stream(legacy, false); tree.writeToStream(stream); copy->setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    for (const auto& bank : copy->driftingControls) for (size_t field = 0; field < bank.size(); ++field) recall = recall && bank[field].load() == OpenStudioReverb::driftingDefaults[field];
    const auto schema = describeFreePluginForRegression(*source);
    const bool appended = schema["parameters"].size() >= 612 && schema["parameters"][538]["id"].toString() == "reverbTypeExpanded" && static_cast<int>(schema["parameters"][515]["max"]) == 20;
    result->setProperty("pass", finite && distinct && partition && controls && spillover && hold && setters && recall && appended);
    result->setProperty("finiteImpulse", finite); result->setProperty("distinctNetworks", distinct); result->setProperty("exactPartitioning", partition);
    result->setProperty("controlInfluence", controls); result->setProperty("spillover", spillover); result->setProperty("freezeInfinite", hold);
    result->setProperty("setters", setters); result->setProperty("stateAndDefaults", recall); result->setProperty("appendedAndOldRange", appended);
    result->setProperty("cases", cases); result->setProperty("schema", schema); result->setProperty("decayCalibration", "diagnostic_only"); result->setProperty("audioQuality", "not_asserted");
    return result;
}
