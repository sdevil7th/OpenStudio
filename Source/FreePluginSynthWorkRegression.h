#pragma once

inline juce::var checkSynthCachedWorkTransitions()
{
    struct Capture
    {
        juce::AudioBuffer<float> audio { 2, 8192 };
        int maximumVoices = 0;
        bool finite = true;
    };
    const auto render = [](double rate, bool corrected, bool expressive, int partition)
    {
        auto synth = std::make_unique<OpenStudioBasicSynthInstrument>();
        synth->signalPath.store(corrected ? 1.0f : 0.0f);
        synth->mpeEnabled.store(expressive ? 1.0f : 0.0f);
        synth->mpeLowerMembers.store(4);
        synth->attackMs.store(7); synth->decayMs.store(90); synth->sustain.store(.6f); synth->releaseMs.store(50);
        synth->filterMode.store(1); synth->filterCutoff.store(2400); synth->filterEnvelopeSource.store(1);
        synth->macro1.store(.35f);
        synth->matrix1Source.store(9); synth->matrix1Target.store(10); synth->matrix1Amount.store(.5f);
        synth->matrix2Source.store(9); synth->matrix2Target.store(11); synth->matrix2Amount.store(-.4f);
        synth->matrix3Source.store(9); synth->matrix3Target.store(13); synth->matrix3Amount.store(.3f);
        synth->matrix4Source.store(9); synth->matrix4Target.store(12); synth->matrix4Amount.store(.2f);
        synth->outputGain.store(-30);
        synth->prepareToPlay(rate, partition);
        const int firstChannel = expressive ? 2 : 1;
        juce::MidiBuffer events, midi;
        for (int voice = 0; voice < 32; ++voice)
            events.addEvent(juce::MidiMessage::noteOn(firstChannel + voice / 16, 40 + voice % 16, .65f), 0);
        events.addEvent(juce::MidiMessage::pitchWheel(firstChannel, 12900), 117);
        events.addEvent(juce::MidiMessage::controllerEvent(firstChannel + 1, 10, 18), 983);
        events.addEvent(juce::MidiMessage::controllerEvent(firstChannel, 11, 83), 1703);
        events.addEvent(juce::MidiMessage::pitchWheel(firstChannel + 1, 3100), 2301);
        if (expressive)
        {
            events.addEvent(juce::MidiMessage::pitchWheel(1, 11900), 2507);
            events.addEvent(juce::MidiMessage::controllerEvent(1, 10, 97), 3109);
        }
        events.addEvent(juce::MidiMessage::controllerEvent(firstChannel, 121, 0), 3557);
        events.addEvent(juce::MidiMessage::controllerEvent(firstChannel + 1, 10, 64), 4501);
        for (int voice = 0; voice < 32; ++voice)
            events.addEvent(juce::MidiMessage::noteOff(firstChannel + voice / 16, 40 + voice % 16), 5701 + voice);
        Capture result;
        juce::AudioBuffer<float> block(2, partition);
        const std::array<int, 3> changes { 2048, 4096, 8192 };
        size_t change = 0;
        for (int position = 0; position < 8192;)
        {
            if (position == 2048) { synth->macro1.store(.82f); synth->decayMs.store(170); }
            if (position == 4096) { synth->macro1.store(0); synth->attackMs.store(12); synth->releaseMs.store(80); }
            while (position >= changes[change]) ++change;
            const int count = juce::jmin(partition, changes[change] - position);
            block.setSize(2, count, false, false, true);
            midi.clear(); midi.addEvents(events, position, count, -position);
            synth->processBlock(block, midi);
            result.maximumVoices = juce::jmax(result.maximumVoices, synth->getRenderingVoiceCountForRegression());
            for (int ch = 0; ch < 2; ++ch)
            {
                result.audio.copyFrom(ch, position, block, ch, 0, count);
                for (int i = 0; i < count; ++i) result.finite = result.finite && std::isfinite(block.getSample(ch, i));
            }
            position += count;
        }
        return result;
    };
    bool pass = true;
    juce::Array<juce::var> rows;
    for (double rate : { 48000.0, 96000.0 }) for (bool corrected : { false, true }) for (bool expressive : { false, true })
    {
        const auto reference = render(rate, corrected, expressive, 31);
        for (int partition : { 127, 511 })
        {
            const auto actual = render(rate, corrected, expressive, partition);
            double maximumError = 0;
            for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 8192; ++i)
                maximumError = juce::jmax(maximumError, std::abs(static_cast<double>(actual.audio.getSample(ch, i) - reference.audio.getSample(ch, i))));
            const bool okay = actual.finite && reference.finite && maximumError == 0 && actual.maximumVoices == 32 && reference.maximumVoices == 32;
            pass = pass && okay;
            auto* row = new juce::DynamicObject();
            row->setProperty("sampleRate", rate); row->setProperty("signalPath", corrected ? 1 : 0);
            row->setProperty("mpe", expressive); row->setProperty("partition", partition);
            row->setProperty("maximumRenderingVoices", actual.maximumVoices); row->setProperty("maximumError", maximumError);
            row->setProperty("pass", okay); rows.add(row);
        }
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Synth cached work, MIDI, MPE and automation partitions");
    result->setProperty("cases", rows); result->setProperty("pass", pass);
    result->setProperty("scope", "32 sounding voices; MIDI/MPE bend and pan smoothing, controller reset, modulated amp ADSR and parameter automation at identical sample positions.");
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
