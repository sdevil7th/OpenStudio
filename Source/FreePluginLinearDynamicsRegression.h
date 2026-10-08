#pragma once
inline juce::var checkLinearBandDynamics()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Linear phase whole-band dynamics and key audition");
    bool finite = true, response = true, phase = true, keys = true, targets = true, bypass = true, latency = true;
    double maxError = 0, maxPhase = 0, partition = 0; juce::Array<juce::var> cases;
    const auto configure = [](OpenStudioEQ& eq, int shape, int target = 0)
    {
        eq.setNonRealtime(true); for (auto& band : eq.bands) band.enabled.store(0);
        auto& band = eq.bands[1]; band.enabled.store(1); band.type.store(static_cast<float>(shape));
        band.freq.store(2000); band.q.store(.7f); band.slope.store(2); band.gain.store(6);
        band.dynamicEnabled.store(1); band.dynamicThreshold.store(-80); band.dynamicRange.store(-12);
        band.dynamicAttack.store(1); band.dynamicRelease.store(30); band.target.store(static_cast<float>(target));
        eq.setPhaseConfiguration(1, 1); eq.setLinearDynamicsConfiguration(1);
    };
    const auto render = [](OpenStudioEQ& eq, double rate, int blockSize, bool external, bool opposite = false)
    {
        eq.prepareToPlay(rate, blockSize); const int length = static_cast<int>(rate * .4) + eq.getLatencySamples();
        juce::AudioBuffer<float> output(2, length), block(external ? 4 : 2, blockSize); juce::MidiBuffer midi;
        for (int start = 0; start < length; start += blockSize)
        {
            const int count = juce::jmin(blockSize, length - start); block.setSize(external ? 4 : 2, count, false, false, true);
            for (int i = 0; i < count; ++i)
            {
                const double time = (start + i) / rate;
                const float sample = static_cast<float>(.05 * std::sin(juce::MathConstants<double>::twoPi * 2000 * time) + .05 * std::sin(juce::MathConstants<double>::twoPi * 7000 * time));
                block.setSample(0, i, sample); block.setSample(1, i, opposite ? -sample : sample);
                if (external) { const float key = static_cast<float>(.2 * std::sin(juce::MathConstants<double>::twoPi * 3300 * time)); block.setSample(2, i, key); block.setSample(3, i, opposite ? -key : key); }
            }
            eq.processBlock(block, midi); for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
        }
        return output;
    };
    const auto tone = [](const juce::AudioBuffer<float>& audio, double rate, double hz, int ch, int delay)
    {
        std::complex<double> sum {}; const int count = static_cast<int>(rate * .1), first = audio.getNumSamples() - count;
        for (int i = first; i < audio.getNumSamples(); ++i) sum += static_cast<double>(audio.getSample(ch, i)) * std::polar(1.0, -juce::MathConstants<double>::twoPi * hz * (i - delay) / rate);
        return sum * std::complex<double>(0, 2.0 / count);
    };
    for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (const int shape : {0, 1, 2})
    {
        auto eq = std::make_unique<OpenStudioEQ>(true), reference = std::make_unique<OpenStudioEQ>(true); configure(*eq, shape); configure(*reference, shape);
        const auto audio = render(*eq, rate, 127, false); const int delay = eq->getLatencySamples(); latency = latency && delay == 4352;
        reference->setPhaseConfiguration(0, 1); reference->bands[1].dynamicEnabled.store(0); reference->bands[1].gain.store(-6); reference->prepareToPlay(rate, 127);
        const auto expected = reference->getMagnitudeResponse({2000, 7000});
        auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", rate); row->setProperty("shape", shape); juce::Array<juce::var> errors;
        for (size_t i = 0; i < 2; ++i)
        {
            const auto measured = tone(audio, rate, i == 0 ? 2000 : 7000, 0, delay);
            const double error = std::abs(juce::Decibels::gainToDecibels(std::abs(measured) / .05) - expected[i]);
            const double angle = std::abs(std::arg(measured)); maxError = juce::jmax(maxError, error); maxPhase = juce::jmax(maxPhase, angle);
            response = response && error < .3; phase = phase && angle < .02; errors.add(error);
        }
        for (int i = 0; i < audio.getNumSamples(); ++i) finite = finite && std::isfinite(audio.getSample(0, i));
        row->setProperty("responseErrorDb", errors); row->setProperty("dynamicGainDb", eq->getBandDynamicGainDB(1)); cases.add(row);
        if (rate == 48000 && shape == 0)
        {
            const auto divided = render(*eq, rate, 511, false);
            for (int i = 0; i < audio.getNumSamples(); ++i) partition = juce::jmax(partition, std::abs(static_cast<double>(audio.getSample(0, i) - divided.getSample(0, i))));
        }
    }
    for (const int target : {1, 2, 3, 4})
    {
        auto eq = std::make_unique<OpenStudioEQ>(true); configure(*eq, 0, target); eq->bands[1].gain.store(0);
        const auto audio = render(*eq, 48000, 127, false, target == 4);
        const double left = std::abs(tone(audio, 48000, 2000, 0, eq->getLatencySamples())) / .05;
        const double right = std::abs(tone(audio, 48000, 2000, 1, eq->getLatencySamples())) / .05;
        targets = targets && (target == 1 ? left < .3 && std::abs(right - 1) < .001 : target == 2 ? right < .3 && std::abs(left - 1) < .001 : left < .3 && right < .3);
    }
    auto eq = std::make_unique<OpenStudioEQ>(true); configure(*eq, 0); eq->bands[1].gain.store(0); eq->bands[1].detectorSource.store(2);
    const auto missing = render(*eq, 48000, 127, false), keyed = render(*eq, 48000, 127, true);
    keys = std::abs(std::abs(tone(missing, 48000, 2000, 0, eq->getLatencySamples())) / .05 - 1) < .001
        && std::abs(tone(keyed, 48000, 2000, 0, eq->getLatencySamples())) / .05 < .3;
    eq->bands[1].detectorMode.store(1); eq->bands[1].detectorLowCut.store(2000); eq->bands[1].detectorHighCut.store(5000); eq->detectorListenBand.store(2);
    const auto listen = render(*eq, 48000, 127, true);
    const bool audition = std::abs(tone(listen, 48000, 2000, 0, eq->getLatencySamples())) < .0001
        && std::abs(tone(listen, 48000, 3300, 0, eq->getLatencySamples())) > .1;
    eq->detectorListenBand.store(0); eq->editorBypass.store(1); const auto dry = render(*eq, 48000, 127, true);
    for (int i = 0; i < dry.getNumSamples(); ++i)
    {
        const double time = (i - eq->getLatencySamples()) / 48000.0;
        const float expected = i < eq->getLatencySamples() ? 0 : static_cast<float>(.05 * std::sin(juce::MathConstants<double>::twoPi * 2000 * time) + .05 * std::sin(juce::MathConstants<double>::twoPi * 7000 * time));
        bypass = bypass && std::abs(dry.getSample(0, i) - expected) < 1e-7f;
    }
    juce::MemoryBlock saved, again; eq->getStateInformation(saved); auto copy = std::make_unique<OpenStudioEQ>(true); copy->setStateInformation(saved.getData(), static_cast<int>(saved.getSize())); copy->getStateInformation(again);
    bool recall = saved == again && copy->linearBandDynamics.load() == 1;
    auto tree = juce::ValueTree::readFromData(saved.getData(), saved.getSize()); tree.removeProperty("linearBandDynamics", nullptr);
    juce::MemoryBlock old; juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); copy->setStateInformation(old.getData(), static_cast<int>(old.getSize()));
    recall = recall && copy->linearBandDynamics.load() == 0 && copy->getLatencySamples() == 2304;
    const auto schema = describeFreePluginForRegression(*eq); const bool descriptors = schema["parameters"].size() >= 716 && schema["parameters"][715]["id"].toString() == "linearBandDynamics";
    bool editorTransitions = true; juce::Array<juce::var> transitionRows;
    auto transitionEQ = std::make_unique<OpenStudioEQ>(true);
    configure(*transitionEQ, 0); transitionEQ->bands[1].gain.store(0);
    transitionEQ->setPhaseConfiguration(0, 1); transitionEQ->setLinearDynamicsConfiguration(0);
    juce::MemoryBlock initialState; transitionEQ->getStateInformation(initialState);
    for (const auto& setting : {std::pair<float,float>{0.0f,0.0f}, {1.0f,0.0f}, {0.0f,1.0f}, {0.0f,0.0f}})
    {
        const bool changed = transitionEQ->setEditorPhaseConfiguration(setting.first, setting.second, true);
        editorTransitions = changed && editorTransitions;
        const auto rendered = render(*transitionEQ, 48000, 127, false);
        const double gain = std::abs(tone(rendered, 48000, 2000, 0, transitionEQ->getLatencySamples())) / .05;
        auto* transitionRow = new juce::DynamicObject();
        transitionRow->setProperty("mode", setting.first); transitionRow->setProperty("minimumFIR", setting.second);
        transitionRow->setProperty("changed", changed); transitionRow->setProperty("gain", gain);
        transitionRow->setProperty("reduction", transitionEQ->getBandDynamicGainDB(1));
        transitionRow->setProperty("latency", transitionEQ->getLatencySamples()); transitionRows.add(transitionRow);
        editorTransitions = editorTransitions && gain < .4 && transitionEQ->getBandDynamicGainDB(1) < -6;
        if (setting.first >= .5f || setting.second >= .5f)
            editorTransitions = editorTransitions && transitionEQ->linearBandDynamics.load() == 1 && transitionEQ->getLatencySamples() > 2048;
    }
    juce::MemoryBlock editedState; transitionEQ->getStateInformation(editedState);
    transitionEQ->setStateInformation(initialState.getData(), static_cast<int>(initialState.getSize()));
    editorTransitions = editorTransitions && transitionEQ->linearBandDynamics.load() == 0 && transitionEQ->phaseMode.load() == 0;
    transitionEQ->setStateInformation(editedState.getData(), static_cast<int>(editedState.getSize()));
    editorTransitions = editorTransitions && transitionEQ->linearBandDynamics.load() == 1;
    // A prepared program bank owns phase/latency: reject the whole operation.
    editorTransitions = transitionEQ->editMIDIProgram(juce::JSON::parse(R"({"action":"capture","bank":0,"program":0,"name":"Fixed"})")) && editorTransitions;
    // Different configurations are required to create a prepared bank; a
    // same-mode program remains on the ordinary IIR path by design.
    editorTransitions = transitionEQ->setPhaseConfiguration(1, 1) && editorTransitions;
    editorTransitions = transitionEQ->editMIDIProgram(juce::JSON::parse(R"({"action":"configure","enabled":true,"channel":0})")) && editorTransitions;
    juce::MemoryBlock lockedBefore, lockedAfter;
    transitionEQ->getStateInformation(lockedBefore);
    editorTransitions = !transitionEQ->setEditorPhaseConfiguration(1, 0, true) && editorTransitions;
    transitionEQ->getStateInformation(lockedAfter);
    editorTransitions = lockedBefore == lockedAfter && editorTransitions;
    result->setProperty("editorPhaseDynamicsContinuity", editorTransitions);
    result->setProperty("editorPhaseTransitionMeasurements", transitionRows);
    result->setProperty("editorPreparedBank", transitionEQ->hasPreparedMIDIPrograms());
    result->setProperty("editorPreparedBankUnchanged", lockedBefore == lockedAfter);
    result->setProperty("pass", editorTransitions && finite && response && phase && keys && targets && bypass && latency && partition == 0 && audition && recall && descriptors);
    result->setProperty("finite", finite); result->setProperty("settledResponse", response); result->setProperty("settledPhase", phase); result->setProperty("maxResponseErrorDb", maxError); result->setProperty("maxPhaseErrorRadians", maxPhase);
    result->setProperty("externalAndMissingKeys", keys); result->setProperty("targets", targets); result->setProperty("delayedBypass", bypass); result->setProperty("latency", latency); result->setProperty("partitionError", partition);
    result->setProperty("linearKeyAudition", audition); result->setProperty("stateLegacyDefaults", recall); result->setProperty("appendedDescriptors", descriptors); result->setProperty("cases", cases); result->setProperty("schema", schema);
    result->setProperty("audioQuality", "not_asserted"); result->setProperty("transientAndWindowEffects", "diagnostic_only"); return result;
}
