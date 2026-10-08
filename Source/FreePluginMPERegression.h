#pragma once

inline juce::var checkSynthMPE()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Synth fixed-storage MPE zones and expression");
    bool zones = true, ownership = true, rpnPass = true, finite = true, recall = true, ordering = true;
    double partitionError = 0, transposeError = 0, slideDifference = 0;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        BuiltInSynthMPE mpe; mpe.prepare(rate, {1, 7, 7, 48, 2, 24, 12});
        zones = zones && mpe.manager(1) == 0 && mpe.manager(7) == 0 && mpe.manager(8) == 15 && mpe.manager(14) == 15;
        mpe.handle(juce::MidiMessage::pitchWheel(2, 6144)); mpe.handle(juce::MidiMessage::pitchWheel(1, 16383));
        mpe.handle(juce::MidiMessage::channelPressureChange(2, 64)); mpe.handle(juce::MidiMessage::channelPressureChange(1, 63));
        mpe.handle(juce::MidiMessage::controllerEvent(2, 74, 0)); mpe.handle(juce::MidiMessage::controllerEvent(1, 74, 127));
        mpe.startVoice(1, 0); mpe.startVoice(8, 0);
        auto value = mpe.currentTarget(1, 0);
        zones = zones && value.bend == -10 && value.pressure == 1 && value.slide == 0 && mpe.currentTarget(8, 0).bend == 0;
        mpe.handle(juce::MidiMessage::controllerEvent(1, 64, 127));
        zones = zones && mpe.pedal(1) && mpe.pedal(7) && !mpe.pedal(8);
        mpe.stopVoice(1, 0); mpe.startVoice(1, 1);
        ownership = ownership && mpe.currentTarget(1, 0).bend == -10 && mpe.currentTarget(1, 1).bend == 2;
        mpe.handle(juce::MidiMessage::pitchWheel(2, 0));
        ownership = ownership && mpe.currentTarget(1, 0).bend == -10 && mpe.currentTarget(1, 1).bend == -46;
        mpe.handle(juce::MidiMessage::pitchWheel(1, 0));
        ownership = ownership && mpe.currentTarget(1, 0).bend == -14 && mpe.currentTarget(1, 1).bend == -50;
        mpe.handle(juce::MidiMessage::controllerEvent(1, 121, 0));
        ownership = ownership && mpe.currentTarget(1, 0).bend == 0 && mpe.currentTarget(1, 1).pressure == 0 && !mpe.pedal(1);
        const auto rpn = [&](int channel, int parameter, int msb, int lsb = -1, bool nrpn = false)
        {
            mpe.handle(juce::MidiMessage::controllerEvent(channel, nrpn ? 99 : 101, parameter / 128));
            mpe.handle(juce::MidiMessage::controllerEvent(channel, nrpn ? 98 : 100, parameter % 128));
            mpe.handle(juce::MidiMessage::controllerEvent(channel, 6, msb));
            if (lsb >= 0) mpe.handle(juce::MidiMessage::controllerEvent(channel, 38, lsb));
        };
        rpn(16, 6, 12); rpnPass = rpnPass && mpe.members(true) == 12 && mpe.members(false) == 2;
        rpn(1, 6, 15, -1, true); rpnPass = rpnPass && mpe.members(false) == 2;
        rpn(16, 16383, 0); rpnPass = rpnPass && mpe.members(true) == 12;
        rpn(15, 0, 12, 50); mpe.handle(juce::MidiMessage::pitchWheel(15, 16383)); mpe.startVoice(14, 0);
        rpnPass = rpnPass && mpe.currentTarget(14, 0).bend == 12.5f;
        rpn(16, 0, 96); mpe.handle(juce::MidiMessage::pitchWheel(16, 16383));
        rpnPass = rpnPass && mpe.currentTarget(14, 0).bend == 108.5f;
        rpn(16, 6, 0); rpnPass = rpnPass && mpe.members(true) == 0 && mpe.members(false) == 2;

        const auto render = [rate](int blockSize, bool expressive, bool slide, bool changing)
        {
            auto synth = std::make_unique<OpenStudioBasicSynthInstrument>();
            synth->noiseLevel.store(0); synth->mpeEnabled.store(expressive ? 1.0f : 0.0f);
            synth->matrix1Source.store(slide ? 8.0f : 0.0f); synth->matrix1Target.store(3); synth->matrix1Amount.store(.8f);
            synth->prepareToPlay(rate, blockSize);
            const int length = juce::roundToInt(rate * .2);
            juce::AudioBuffer<float> output(2, length), block(2, blockSize); juce::MidiBuffer midi;
            for (int start = 0; start < length; start += blockSize)
            {
                const int count = juce::jmin(blockSize, length - start); block.setSize(2, count, false, false, true); midi.clear();
                const auto event = [&](int at, const juce::MidiMessage& message) { if (at >= start && at < start + count) midi.addEvent(message, at - start); };
                if (expressive)
                {
                    event(0, juce::MidiMessage::pitchWheel(2, 6144)); event(0, juce::MidiMessage::pitchWheel(1, 16383));
                    event(0, juce::MidiMessage::controllerEvent(2, 74, 127));
                }
                event(0, juce::MidiMessage::noteOn(expressive ? 2 : 1, expressive ? 60 : 50, .7f));
                if (changing)
                {
                    event(137, juce::MidiMessage::pitchWheel(2, 8192)); event(311, juce::MidiMessage::channelPressureChange(2, 96));
                    event(593, juce::MidiMessage::controllerEvent(1, 64, 127));
                    event(997, juce::MidiMessage::noteOff(2, 60)); event(1231, juce::MidiMessage::noteOn(2, 67, .5f));
                    event(2003, juce::MidiMessage::controllerEvent(2, 74, 0)); event(2333, juce::MidiMessage::controllerEvent(1, 64, 0));
                    event(3001, juce::MidiMessage::noteOff(2, 67));
                }
                synth->processBlock(block, midi); for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
            }
            return output;
        };
        const auto a = render(127, true, true, true), b = render(512, true, true, true);
        const auto bent = render(127, true, false, false), transposed = render(127, false, false, false), slide = render(127, true, true, false);
        for (int i = 0; i < a.getNumSamples(); ++i)
        {
            finite = finite && std::isfinite(a.getSample(0, i)) && std::abs(a.getSample(0, i)) < 2.5f;
            partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(a.getSample(0, i) - b.getSample(0, i))));
            transposeError = juce::jmax(transposeError, std::abs(static_cast<double>(bent.getSample(0, i) - transposed.getSample(0, i))));
            slideDifference += std::abs(bent.getSample(0, i) - slide.getSample(0, i));
        }
        if (rate == 48000) writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/synth-mpe-listening/member-expression.wav"), a, rate);
    }
    auto original = std::make_unique<OpenStudioBasicSynthInstrument>(), restored = std::make_unique<OpenStudioBasicSynthInstrument>();
    for (const auto& control : original->modulationControls) recall = recall && setFreePluginParamForRegression(*original, control.id, control.maximum);
    juce::MemoryBlock bytes; original->getStateInformation(bytes); restored->setStateInformation(bytes.getData(), static_cast<int>(bytes.getSize()));
    recall = recall && original->mpeValues() == restored->mpeValues() && original->matrixValues() == restored->matrixValues();
    auto tree = juce::ValueTree::readFromData(bytes.getData(), bytes.getSize());
    for (const auto& control : original->modulationControls) if (juce::String(control.id).startsWith("mpe")) tree.removeProperty(control.id, nullptr);
    juce::MemoryBlock old; juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); restored->setStateInformation(old.getData(), static_cast<int>(old.getSize()));
    recall = recall && restored->mpeValues() == BuiltInSynthMPE::Configuration {0, 15, 0, 48, 2, 48, 2};
    MIDIClip clip;
    for (int i = 0; i < 40; ++i) clip.addEvent(MIDIEvent(.1, juce::MidiMessage::controllerEvent(1, 74, i)));
    clip.quantize(.25); for (size_t i = 0; i < clip.getAllEvents().size(); ++i) ordering = ordering && clip.getAllEvents()[i].message.getControllerValue() == static_cast<int>(i);
    bool chase = true, previewPass = true;
    {
        TrackProcessor track; TrackProcessor::ScheduledMIDIClip scheduled;
        scheduled.startTime = 0; scheduled.duration = 2;
        const auto cc = [&](int channel, int controller, int value)
        { scheduled.events.push_back({.1, juce::MidiMessage::controllerEvent(channel, controller, value)}); };
        cc(1, 101, 0); cc(1, 100, 6); cc(1, 6, 7);
        cc(16, 101, 0); cc(16, 100, 6); cc(16, 6, 7);
        cc(2, 101, 0); cc(2, 100, 0); cc(2, 6, 12); cc(2, 38, 50);
        cc(1, 101, 0); cc(1, 100, 0); cc(1, 6, 3);
        cc(2, 101, 127); cc(2, 100, 127);
        scheduled.events.push_back({.2, juce::MidiMessage::pitchWheel(2, 16383)});
        scheduled.events.push_back({.2, juce::MidiMessage::pitchWheel(1, 16383)});
        scheduled.events.push_back({.2, juce::MidiMessage::channelPressureChange(2, 96)});
        scheduled.events.push_back({.2, juce::MidiMessage::controllerEvent(2, 74, 127)});
        scheduled.events.push_back({.2, juce::MidiMessage::noteOn(2, 60, .7f)});
        scheduled.events.push_back({1.5, juce::MidiMessage::noteOff(2, 60)});
        track.setScheduledMIDIClips({scheduled});
        juce::MidiBuffer midi; midi.ensureSize(8192); track.buildMidiBuffer(midi, .75, 512, 48000, true);
        BuiltInSynthMPE chased; chased.prepare(48000, {1,15,0,48,2,48,2});
        int noteCount = 0;
        for (const auto metadata : midi)
        {
            const auto message = metadata.getMessage(); chased.handle(message);
            if (message.isNoteOn())
            {
                ++noteCount; chased.startVoice(1, 0); const auto expression = chased.currentTarget(1, 0);
                chase = chase && expression.bend == 15.5f && expression.slide == 1 && expression.pressure > .75f;
            }
        }
        chase = chase && noteCount == 1 && chased.members(false) == 7 && chased.members(true) == 7;
    }
    for (bool upper : {false, true})
    {
        auto source = std::make_shared<OpenStudioBasicSynthInstrument>(); source->mpeEnabled.store(1);
        source->mpeLowerMembers.store(upper ? 0.0f : 15.0f); source->mpeUpperMembers.store(upper ? 15.0f : 0.0f);
        source->prepareToPlay(48000, 256); BuiltInInstrumentPreview preview;
        previewPass = previewPass && preview.send("mpe", source, 60, true, 48000, [] { return std::make_unique<OpenStudioBasicSynthInstrument>(); });
        juce::AudioBuffer<float> audio(2, 256); double energy = 0;
        for (int i = 0; i < 5; ++i) { audio.clear(); preview.render(audio.getArrayOfWritePointers(), 2, 256, 48000); energy += audio.getMagnitude(0, 256); }
        previewPass = previewPass && energy > .01;
    }
    const auto schema = describeFreePluginForRegression(*original); const auto* descriptors = schema["parameters"].getArray();
    const bool appended = descriptors && descriptors->size() >= 43 && (*descriptors)[35]["id"].toString() == "matrix3Amount" && (*descriptors)[36]["id"].toString() == "mpeEnabled";
    result->setProperty("pass", zones && ownership && rpnPass && finite && recall && ordering && chase && previewPass && appended && partitionError == 0 && transposeError < 2e-5 && slideDifference > 1);
    result->setProperty("chasedConfigurationBeforeExpressionAndNotes", chase); result->setProperty("isolatedLowerUpperPreview", previewPass);
    result->setProperty("zonesAndMasterExpression", zones); result->setProperty("memberReuseAndReset", ownership); result->setProperty("rpnRangesZonesNullNRPN", rpnPass);
    result->setProperty("finite", finite); result->setProperty("stateAndLegacyMigration", recall); result->setProperty("equalTimeOrder", ordering); result->setProperty("appendedDescriptors", appended);
    result->setProperty("partitionError", partitionError); result->setProperty("transposeError", transposeError); result->setProperty("slideDifference", slideDifference);
    result->setProperty("schema", schema); result->setProperty("audioQuality", "not_asserted"); result->setProperty("hardwareMPE", "not_asserted"); return result;
}
