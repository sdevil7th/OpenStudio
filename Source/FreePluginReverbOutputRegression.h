#pragma once

inline juce::var checkReverbOutputGain()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Standalone reverb final output gain");
    auto original = std::make_unique<OpenStudioReverb>(true);
    auto restored = std::make_unique<OpenStudioReverb>(true);
    bool statePass = setFreePluginParamForRegression(*original, "outputTrimDb", 6);
    original->selectAlgorithm(40);
    juce::MemoryBlock saved, again;
    original->getStateInformation(saved);
    restored->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    restored->getStateInformation(again);
    statePass = statePass && saved == again && restored->outputTrimDb.load() == 6;
    restored->selectAlgorithm(0);
    statePass = statePass && restored->outputTrimDb.load() == 6;
    restored->selectSendMode(true);
    statePass = statePass && setFreePluginParamForRegression(*restored, "outputTrimDb", -3)
        && restored->wetLevel.load() == 1 && restored->dryLevel.load() == 0;
    restored->selectSendMode(false);
    statePass = statePass && restored->outputTrimDb.load() == -3;
    auto oldTree = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
    oldTree.removeProperty("outputTrimDb", nullptr);
    juce::MemoryBlock oldState;
    { juce::MemoryOutputStream stream(oldState, false); oldTree.writeToStream(stream); }
    restored->setStateInformation(oldState.getData(), static_cast<int>(oldState.getSize()));
    const bool legacyDefault = restored->outputTrimDb.load() == 0;
    bool rangePass = true;
    for (const float normalized : {0.0f, .25f, .5f, 1.0f})
        rangePass = setFreePluginNormalizedForRegression(*original, "outputTrimDb", normalized)
            && std::abs(original->outputTrimDb.load() - (-60 + 72 * normalized)) < 1e-5f && rangePass;
    rangePass = setFreePluginParamForRegression(*original, "outputTrimDb", 80)
        && original->outputTrimDb.load() == 12 && rangePass;
    rangePass = setFreePluginParamForRegression(*original, "outputTrimDb", -100)
        && original->outputTrimDb.load() == -60 && rangePass;
    auto embedded = std::make_unique<OpenStudioReverb>();
    const bool embeddedUnchanged = !setFreePluginParamForRegression(*embedded, "outputTrimDb", 6)
        && !setFreePluginNormalizedForRegression(*embedded, "outputTrimDb", 1);
    const auto schema = describeFreePluginForRegression(*original);
    const auto parameters = schema["parameters"];
    const bool appended = parameters.size() == 1090 && parameters[1083]["id"].toString() == "reconstructedPeaks"
        && parameters[1084]["id"].toString() == "outputTrimDb" && static_cast<bool>(parameters[1084]["automatable"])
        && static_cast<float>(parameters[1084]["defaultValue"]) == 0;

    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-output-tests");
    juce::AudioBuffer<float> ir(4,2048); ir.clear();
    for (int ch = 0; ch < 4; ++ch) ir.setSample(ch, 30 + ch * 71, .3f - .04f * ch);
    const auto file = directory.getChildFile("four-paths.wav");
    bool fixturePass = writeProbeWave(file, ir, 48000);
    double gainError = 0, meterError = 0, partitionError = 0;
    bool unityPass = true, finite = true, nonzero = true;
    const auto render = [&] (int type, float trim, int blockSize, bool change, bool old)
    {
        auto processor = std::make_unique<OpenStudioReverb>(true);
        if (old) processor->setStateInformation(oldState.getData(), static_cast<int>(oldState.getSize()));
        processor->selectAlgorithm(type);
        processor->outputTrimDb.store(trim);
        processor->wetLevel.store(change ? 0.0f : .6f);
        processor->dryLevel.store(change ? 1.0f : .4f);
        if (type == 7)
        {
            auto* shape = new juce::DynamicObject();
            shape->setProperty("normalise", false); shape->setProperty("outputLayout", 1);
            fixturePass = processor->convolutionSpace.loadFile(file) && processor->convolutionSpace.edit(shape) && fixturePass;
            juce::MemoryBlock state; processor->getStateInformation(state);
            processor->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
        }
        constexpr int length = 14400, event = 4800;
        processor->prepareToPlay(48000, blockSize);
        const int channels = juce::jmax(2, processor->getTotalNumOutputChannels());
        juce::AudioBuffer<float> output(channels, length), block(channels, blockSize);
        juce::MidiBuffer midi;
        for (int start = 0; start < length;)
        {
            if (change && start == event) processor->outputTrimDb.store(12);
            int count = juce::jmin(blockSize, length - start);
            if (start < event) count = juce::jmin(count, event - start);
            block.setSize(channels, count, false, false, true); block.clear();
            for (int i = 0; i < count; ++i)
            {
                const float signal = change ? .01f : .02f * std::sin(.071f * static_cast<float>(start + i));
                block.setSample(0, i, signal); block.setSample(1, i, signal * -.7f);
            }
            processor->processBlock(block, midi);
            for (int ch = 0; ch < channels; ++ch)
            {
                output.copyFrom(ch, start, block, ch, 0, count);
                for (int i = 0; i < count; ++i) finite = std::isfinite(block.getSample(ch, i)) && finite;
            }
            for (int ch = 0; ch < 2; ++ch)
                meterError = juce::jmax(meterError, std::abs(static_cast<double>(processor->outputPeaksDb[static_cast<size_t>(ch)].load())
                    - juce::Decibels::gainToDecibels(block.getMagnitude(ch, 0, count), -100.0f)));
            start += count;
        }
        return output;
    };
    for (int type : {0,2,4,7,10,21,24,40})
    {
        const auto unity = render(type, 0, 127, false, false), old = render(type, 0, 127, false, true);
        for (float db : {-60.0f,-6.0f,12.0f})
        {
            const auto trimmed = render(type, db, 127, false, false);
            const float gain = juce::Decibels::decibelsToGain(db);
            for (int ch = 0; ch < unity.getNumChannels(); ++ch)
                for (int i = 0; i < unity.getNumSamples(); ++i)
                {
                    gainError = juce::jmax(gainError, std::abs(static_cast<double>(trimmed.getSample(ch,i)) - unity.getSample(ch,i) * gain));
                    unityPass = unity.getSample(ch,i) == old.getSample(ch,i) && unityPass;
                }
        }
        for (int ch = 0; ch < (type == 7 ? unity.getNumChannels() : 2); ++ch)
            nonzero = unity.getMagnitude(ch, 0, unity.getNumSamples()) > 1e-6f && nonzero;
    }
    const auto narrowCapture = render(0, 0, 17, true, false), wideCapture = render(0, 0, 511, true, false);
    for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < narrowCapture.getNumSamples(); ++i)
        partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(narrowCapture.getSample(ch,i) - wideCapture.getSample(ch,i))));
    const float initial = narrowCapture.getSample(0,4799), first = narrowCapture.getSample(0,4800), final = narrowCapture.getSample(0,5759);
    bool rampPass = initial == .01f && first > initial && first < .011f
        && std::abs(final - .01f * juce::Decibels::decibelsToGain(12.0f)) < 1e-7f;
    for (int i = 4801; i < 5760; ++i) rampPass = narrowCapture.getSample(0,i) >= narrowCapture.getSample(0,i-1) && rampPass;

    auto track = std::make_unique<TrackProcessor>(); track->prepareToPlay(48000,64);
    auto automated = std::make_unique<OpenStudioReverb>(true); auto* reverb = automated.get();
    bool automationPass = track->addTrackFX(std::move(automated),48000,64);
    track->setForceAutomationReadForProcessing(true);
    auto target = track->resolveAutomationTarget("builtin_track_0_outputTrimDb",true);
    automationPass = target.has_value() && automationPass;
    if (target)
    {
        target->list->setMode(AutomationMode::Read); target->list->setPoints({{0,.25f},{1,.25f}});
        track->setCurrentBlockPosition(.2); juce::AudioBuffer<float> audio(2,64); audio.clear(); juce::MidiBuffer midi;
        track->processBlock(audio,midi); automationPass = automationPass && reverb->outputTrimDb.load() == -42;
    }
    result->setProperty("pass", statePass && legacyDefault && rangePass && embeddedUnchanged && appended && fixturePass
        && gainError < 1e-7 && meterError < 1e-5 && unityPass && finite && nonzero && partitionError < 1e-7 && rampPass && automationPass);
    result->setProperty("stateAndSendRecall",statePass); result->setProperty("legacyDefault",legacyDefault);
    result->setProperty("rangeAndNormalizedAutomation",rangePass); result->setProperty("embeddedUnchanged",embeddedUnchanged);
    result->setProperty("appendedDescriptor",appended); result->setProperty("gainError",gainError);
    result->setProperty("postGainMeterError",meterError); result->setProperty("oldStateUnityParity",unityPass);
    result->setProperty("fourOutputFixture",fixturePass); result->setProperty("nonzeroAllOutputs",nonzero);
    result->setProperty("finite",finite); result->setProperty("partitionError",partitionError);
    result->setProperty("twentyMillisecondRamp",rampPass); result->setProperty("trackEnvelopeRead",automationPass);
    result->setProperty("audioQuality","not_asserted"); return result;
}
