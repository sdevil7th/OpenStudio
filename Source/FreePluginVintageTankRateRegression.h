#pragma once
inline juce::var checkVintageTankRate()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Prepared Vintage internal tank rates");
    bool clock = true, finite = true, audible = true, reset = true, changed = true, dry = true;
    double partition = 0; juce::Array<juce::var> cases;
    for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (const int mode : {0, 1})
    {
        const auto render = [&](int bank, int blockSize)
        {
            BuiltInVintageReverb engine; engine.prepare(rate, mode); BuiltInVintageReverb::Settings settings;
            settings.colour = 2; settings.modulation = .2f; settings.tankRate = static_cast<float>(bank);
            const int count = static_cast<int>(rate * .4); juce::AudioBuffer<float> output(2, count);
            for (int i = 0; i < count; ++i)
            {
                if (i % blockSize == 0) engine.configure(mode, settings);
                const auto sample = engine.process(i == 0 ? .2f : 0, i == 0 ? -.1f : 0);
                for (int ch = 0; ch < 2; ++ch) output.setSample(ch, i, sample[static_cast<size_t>(ch)]);
            }
            const double effective = bank == 0 ? rate : juce::jmin(rate, bank == 1 ? 24000.0 : 48000.0);
            clock = clock && engine.processingRate(static_cast<size_t>(mode), static_cast<size_t>(bank)) == effective
                && std::abs(static_cast<double>(engine.processingFrames(static_cast<size_t>(mode), static_cast<size_t>(bank))) - count * effective / rate) <= 1;
            for (size_t b = 0; b < 3; ++b) if (static_cast<int>(b) != bank)
                clock = clock && engine.processingFrames(static_cast<size_t>(mode), b) == 0;
            engine.reset(); engine.configure(mode, settings);
            for (int i = 0; i < 1000; ++i) { const auto sample = engine.process(0, 0); reset = reset && sample[0] == 0 && sample[1] == 0; }
            return output;
        };
        const auto host = render(0, 127);
        for (const int bank : {1, 2})
        {
            const auto output = render(bank, 127), divided = render(bank, 511);
            double energy = 0, difference = 0;
            for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < output.getNumSamples(); ++i)
            {
                const float sample = output.getSample(ch, i); finite = finite && std::isfinite(sample) && std::abs(sample) < 2;
                energy += sample * sample; difference += std::abs(sample - host.getSample(ch, i));
                partition = juce::jmax(partition, std::abs(static_cast<double>(sample - divided.getSample(ch, i))));
            }
            audible = audible && energy > 1e-8;
            changed = changed && (rate > (bank == 1 ? 24000 : 48000) ? difference > .01 : difference == 0);
            auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", rate); row->setProperty("mode", mode);
            row->setProperty("rateBank", bank); row->setProperty("energyDiagnostic", energy); row->setProperty("differenceFromHost", difference); cases.add(row);
        }
    }
    bool transition = true;
    for (const bool retain : {false, true})
    {
        BuiltInVintageReverb engine; engine.prepare(48000, 0); BuiltInVintageReverb::Settings settings;
        settings.colour = 2; settings.tankRate = 1; engine.configure(0, settings, retain);
        for (int i = 0; i < 16000; ++i) engine.process(i == 0 ? .5f : 0, 0);
        const auto previous = engine.processingFrames(0, 1); settings.tankRate = 2; engine.configure(0, settings, retain);
        double tail = 0;
        for (int i = 0; i < 6000; ++i) { const auto sample = engine.process(0, 0); tail += std::abs(sample[0]) + std::abs(sample[1]); }
        transition = transition && engine.processingFrames(0, 1) > previous && engine.processingFrames(0, 2) == 6000 && tail > 1e-8;
    }
    auto source = std::make_unique<OpenStudioReverb>(true), copy = std::make_unique<OpenStudioReverb>(true);
    source->selectAlgorithm(10); const bool setters = setFreePluginParamForRegression(*source, "vintageTankRate", 1)
        && setFreePluginParamForRegression(*source, "vintage1.tankRate", 2);
    source->wetLevel.store(0); source->dryLevel.store(1); source->prepareToPlay(48000, 127);
    juce::AudioBuffer<float> block(2, 127); juce::MidiBuffer midi;
    for (int i = 0; i < 127; ++i) { block.setSample(0, i, .125f); block.setSample(1, i, -.25f); }
    source->processBlock(block, midi);
    for (int i = 0; i < 127; ++i) dry = dry && block.getSample(0, i) == .125f && block.getSample(1, i) == -.25f;
    juce::MemoryBlock saved, again; source->getStateInformation(saved); copy->setStateInformation(saved.getData(), static_cast<int>(saved.getSize())); copy->getStateInformation(again);
    bool recall = saved == again && copy->vintageTankRate[0].load() == 1 && copy->vintageTankRate[1].load() == 2;
    auto tree = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
    tree.removeProperty("vintage0TankRate", nullptr); tree.removeProperty("vintage1TankRate", nullptr);
    juce::MemoryBlock old; juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); copy->setStateInformation(old.getData(), static_cast<int>(old.getSize()));
    recall = recall && copy->vintageTankRate[0].load() == 0 && copy->vintageTankRate[1].load() == 0;
    const auto schema = describeFreePluginForRegression(*source);
    const bool descriptors = schema["parameters"].size() >= 615 && schema["parameters"][612]["id"].toString() == "vintageTankRate";
    result->setProperty("pass", clock && finite && audible && reset && changed && dry && partition == 0 && transition && setters && recall && descriptors);
    result->setProperty("internalClockAndInactiveBanks", clock); result->setProperty("finite", finite); result->setProperty("nonzeroWet", audible);
    result->setProperty("resetSilence", reset); result->setProperty("hostRateDistinctOrExactWhenCapped", changed); result->setProperty("dryParity", dry);
    result->setProperty("partitionError", partition); result->setProperty("preparedRateTransitions", transition); result->setProperty("stateLegacyDefaults", recall);
    result->setProperty("setters", setters); result->setProperty("appendedDescriptors", descriptors); result->setProperty("cases", cases); result->setProperty("schema", schema);
    result->setProperty("audioQuality", "not_asserted"); result->setProperty("decayAndAliasMeasurements", "diagnostic_only"); return result;
}
