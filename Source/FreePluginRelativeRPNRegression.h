juce::var checkRelativeRPN()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Relative registered parameters and MPE sensitivity");
    bool pass = true; juce::Array<juce::var> cases;
    for (const double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        BuiltInSynthMPE mpe; mpe.prepare(rate, {1, 7, 7, 48, 2, 24, 12});
        const auto cc = [&](int ch, int number, int value) { mpe.handle(juce::MidiMessage::controllerEvent(ch, number, value)); };
        const auto select = [&](int ch, int parameter, bool nrpn = false)
        { cc(ch, nrpn ? 99 : 101, parameter / 128); cc(ch, nrpn ? 98 : 100, parameter % 128); };
        mpe.handle(juce::MidiMessage::pitchWheel(2, 16383)); mpe.startVoice(1, 0);
        select(2, 0); cc(2, 6, 3); cc(2, 38, 99); cc(2, 96, 127);
        bool correct = std::abs(mpe.currentTarget(1, 0).bend - 4.0f) < 1e-5f;
        cc(2, 38, 25); cc(2, 97, 0);
        correct = correct && std::abs(mpe.currentTarget(1, 0).bend - 4.24f) < 1e-5f;
        select(2, 16383); cc(2, 96, 1); select(2, 0, true); cc(2, 96, 1);
        correct = correct && std::abs(mpe.currentTarget(1, 0).bend - 4.24f) < 1e-5f;
        select(2, 0); cc(2, 6, 96); cc(2, 96, 0);
        correct = correct && mpe.currentTarget(1, 0).bend == 96;
        cc(2, 6, 0); cc(2, 97, 127);
        correct = correct && mpe.currentTarget(1, 0).bend == 0;
        // A live receiver knows its saved initial range even without Data Entry.
        select(16, 0); cc(16, 96, 55);
        mpe.handle(juce::MidiMessage::pitchWheel(16, 16383)); mpe.startVoice(14, 0);
        correct = correct && std::abs(mpe.currentTarget(14, 0).bend - 12.01f) < 1e-5f;
        cc(16, 121, 0); cc(16, 96, 55); mpe.handle(juce::MidiMessage::pitchWheel(16, 16383));
        correct = correct && std::abs(mpe.currentTarget(14, 0).bend - 12.01f) < 1e-5f;

        TrackProcessor track; TrackProcessor::ScheduledMIDIClip a, b; a.duration = b.duration = 2;
        const auto event = [](auto& clip, double time, int number, int value)
        { clip.events.push_back({time, juce::MidiMessage::controllerEvent(2, number, value)}); };
        event(a, .1, 101, 0); event(a, .1, 100, 0); event(a, .1, 6, 3); event(a, .1, 38, 99);
        event(b, .2, 96, 99); event(a, .3, 38, 25); event(b, .4, 97, 33);
        a.events.push_back({.5, juce::MidiMessage::pitchWheel(2, 16383)});
        a.events.push_back({.5, juce::MidiMessage::noteOn(2, 60, .7f)});
        a.events.push_back({1.5, juce::MidiMessage::noteOff(2, 60)});
        track.setScheduledMIDIClips({b, a}); juce::MidiBuffer seek, live; seek.ensureSize(8192); live.ensureSize(8192);
        track.buildMidiBuffer(seek, .75, 127, rate, true); track.buildMidiBuffer(live, 0, static_cast<int>(rate * .75), rate, true);
        const auto bend = [rate](const auto& midi)
        {
            BuiltInSynthMPE state; state.prepare(rate, {1, 15, 0, 48, 2, 48, 2});
            for (const auto metadata : midi) { const auto message = metadata.getMessage(); state.handle(message); if (message.isNoteOn()) state.startVoice(1, 0); }
            return state.currentTarget(1, 0).bend;
        };
        const bool seekMatches = std::abs(bend(seek) - 4.24f) < 1e-5f && std::abs(bend(live) - bend(seek)) < 1e-5f;
        pass = pass && correct && seekMatches;
        auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("sensitivityCarryBoundsReset", correct);
        row->setProperty("overlappingLiveSeekEqual", seekMatches); cases.add(row);
    }
    bool generic = true;
    for (int parameter = 0; parameter <= 4; ++parameter)
    {
        MIDIParameterChase chase; double time = 0;
        const auto add = [&](int number, int value) { chase.add(juce::MidiMessage::controllerEvent(3, number, value), time += .01); };
        add(101, 0); add(100, parameter); add(6, 7); add(38, parameter == 0 ? 99 : 127); add(96, 127);
        juce::MidiBuffer midi; midi.ensureSize(8192); chase.append(midi); juce::MidiRPNDetector parser;
        int last = -1;
        for (const auto metadata : midi) { const auto message = metadata.getMessage(); if (auto value = parser.tryParse(message.getChannel(), message.getControllerNumber(), message.getControllerValue())) last = value->value; }
        const int expected = parameter <= 1 ? 8 * 128 : 8 * 128 + 127;
        generic = generic && last == expected;
    }
    MIDIParameterChase unknown; unknown.add(juce::MidiMessage::controllerEvent(1, 101, 0), 0);
    unknown.add(juce::MidiMessage::controllerEvent(1, 100, 0), .1); unknown.add(juce::MidiMessage::controllerEvent(1, 96, 127), .2);
    juce::MidiBuffer skipped; skipped.ensureSize(8192); unknown.append(skipped);
    bool noInventedValue = true; for (const auto metadata : skipped) noInventedValue = noInventedValue && metadata.getMessage().getControllerNumber() != 6;
    MIDIParameterChase zoneReset; double eventTime = 0;
    const auto zoneCC = [&](int channel, int number, int value) { zoneReset.add(juce::MidiMessage::controllerEvent(channel,number,value),eventTime += .01); };
    zoneCC(2,101,0);zoneCC(2,100,0);zoneCC(2,6,3);zoneCC(2,38,99);
    zoneCC(1,101,0);zoneCC(1,100,6);zoneCC(1,6,7);
    zoneCC(2,101,0);zoneCC(2,100,0);zoneCC(2,96,0);
    juce::MidiBuffer resetChase;resetChase.ensureSize(8192);zoneReset.append(resetChase);
    BuiltInSynthMPE resetState;resetState.prepare(48000,{1,15,0,48,2,48,2});
    for(const auto metadata:resetChase)resetState.handle(metadata.getMessage());
    resetState.handle(juce::MidiMessage::pitchWheel(2,16383));resetState.startVoice(1,0);
    const bool zoneBaselineInvalidated=resetState.currentTarget(1,0).bend==48;
    result->setProperty("pass", pass && generic && noInventedValue && zoneBaselineInvalidated); result->setProperty("cases", cases);
    result->setProperty("registeredParameterUnits", generic); result->setProperty("unknownBaselineNotInvented", noInventedValue);
    result->setProperty("zoneChangeRequiresFreshBaseline",zoneBaselineInvalidated);
    result->setProperty("unknownBaselineNRPNAndOtherRPN", "not_asserted"); result->setProperty("hardwareMPE", "not_asserted");
    return result;
}
