#pragma once

inline juce::var checkMIDIControllerHistory()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "MIDI controller history across ended clips");
    bool pass = true; juce::Array<juce::var> cases;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        TrackProcessor::ScheduledMIDIClip setup, reset, playing, later;
        setup.duration = .4; reset.startTime = .5; reset.duration = .1; playing.startTime = 1; playing.duration = 2;
        const auto cc = [](auto& clip, double time, int ch, int number, int value) { clip.events.push_back({time, juce::MidiMessage::controllerEvent(ch, number, value)}); };
        cc(setup, .01, 2, 0, 3); cc(setup, .02, 2, 32, 4);
        setup.events.push_back({.03, juce::MidiMessage::programChange(2, 5)});
        cc(setup, .04, 2, 0, 6); cc(setup, .05, 2, 7, 90); cc(setup, .06, 2, 10, 20);
        cc(setup, .07, 2, 1, 55); cc(setup, .08, 2, 11, 40);
        cc(setup, .1, 2, 101, 0); cc(setup, .1, 2, 100, 0); cc(setup, .1, 2, 6, 7); cc(setup, .1, 2, 38, 3);
        cc(setup, .2, 2, 96, 0); setup.events.push_back({.21, juce::MidiMessage::pitchWheel(2, 10000)});
        setup.events.push_back({.22, juce::MidiMessage::channelPressureChange(2, 77)});
        setup.events.push_back({.1, juce::MidiMessage::noteOn(2, 48, .6f)}); setup.events.push_back({.3, juce::MidiMessage::noteOff(2, 48)});
        // Out-of-clip channel events must never affect playback or chase.
        cc(setup, -.1, 2, 70, 123); cc(setup, .4, 2, 71, 123); cc(setup, .5, 2, 72, 123);
        cc(reset, .01, 2, 121, 0); cc(reset, .02, 2, 1, 66);
        reset.events.push_back({.03, juce::MidiMessage::pitchWheel(2, 12000)});
        reset.events.push_back({.04, juce::MidiMessage::channelPressureChange(2, 22)});
        playing.events.push_back({.1, juce::MidiMessage::noteOn(2, 60, .7f)});
        playing.events.push_back({1.5, juce::MidiMessage::noteOff(2, 60)});
        TrackProcessor track; track.setScheduledMIDIClips({playing, reset, setup});
        juce::MidiBuffer seek; seek.ensureSize(131072); const auto* storage = seek.data.begin();
        track.buildMidiBuffer(seek, 1.5, 127, rate, true);
        int msb = -1, lsb = -1, programMsb = -1, programLsb = -1, program = -1, volume = -1, pan = -1;
        int wheel = 0, pressure = 0, modulation = 0, expression = 127, rpn = -1, notes = 0, key = -1;
        bool outside = false; juce::MidiRPNDetector parser;
        for (const auto metadata : seek)
        {
            const auto message = metadata.getMessage();
            if (message.isController())
            {
                const int number = message.getControllerNumber(), value = message.getControllerValue();
                if (number == 0) msb = value; else if (number == 32) lsb = value;
                else if (number == 7) volume = value; else if (number == 10) pan = value;
                else if (number == 1) modulation = value; else if (number == 11) expression = value;
                if (number >= 70 && number <= 72) outside = true;
                if (auto parsed = parser.tryParse(message.getChannel(), number, value))
                    if (parsed->channel == 2 && parsed->parameterNumber == 0) rpn = parsed->value;
            }
            else if (message.isProgramChange()) { program = message.getProgramChangeNumber(); programMsb = msb; programLsb = lsb; }
            else if (message.isPitchWheel()) wheel = message.getPitchWheelValue();
            else if (message.isChannelPressure()) pressure = message.getChannelPressureValue();
            else if (message.isNoteOn()) { ++notes; key = message.getNoteNumber(); }
        }
        bool correct = storage == seek.data.begin() && msb == 6 && lsb == 4 && program == 5 && programMsb == 3 && programLsb == 4
            && volume == 90 && pan == 20 && modulation == 66 && expression == 127 && wheel == 12000 && pressure == 22
            && rpn == 7 * 128 + 4 && notes == 1 && key == 60 && !outside;
        // Pedal settings survive ended clips; old notes do not. A later ended
        // controller clip can release a held note in the containing note clip.
        setup.events.clear(); playing.events.clear(); reset.events.clear();
        cc(setup, .01, 2, 64, 127);
        setup.events.push_back({.1, juce::MidiMessage::noteOn(2, 48, .6f)}); setup.events.push_back({.2, juce::MidiMessage::noteOff(2, 48)});
        playing.events.push_back({.1, juce::MidiMessage::noteOn(2, 60, .7f)}); playing.events.push_back({.3, juce::MidiMessage::noteOff(2, 60)});
        track.setScheduledMIDIClips({setup, playing}); track.buildMidiBuffer(seek, 1.5, 127, rate, true);
        int on = 0, off = 0; bool oldNote = false;
        for (const auto metadata : seek) { const auto message = metadata.getMessage(); if (message.isNoteOn()) { ++on; oldNote = oldNote || message.getNoteNumber() == 48; } if (message.isNoteOff() && message.getNoteNumber() == 60) ++off; }
        correct = correct && on == 1 && off == 1 && !oldNote;
        later.startTime = 1.4; later.duration = .05; cc(later, .01, 2, 64, 0);
        track.setScheduledMIDIClips({later, setup, playing}); track.buildMidiBuffer(seek, 1.5, 127, rate, true);
        for (const auto metadata : seek) correct = correct && !metadata.getMessage().isNoteOn();
        // Right-edge releases play at the exact block boundary, including an
        // imported paired release beyond the crop which is clamped to that edge.
        playing.events.clear(); playing.events.push_back({.1, juce::MidiMessage::noteOn(2, 60, .7f)});
        playing.events.push_back({3, juce::MidiMessage::noteOff(2, 60)});
        track.setScheduledMIDIClips({playing}); track.buildMidiBuffer(seek, 3, 1, rate, true);
        int edgeOffs = 0; for (const auto metadata : seek) if (metadata.getMessage().isNoteOff() && metadata.getMessage().getNoteNumber() == 60) ++edgeOffs;
        correct = correct && edgeOffs == 1;
        auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("pass", correct); row->setProperty("registeredRange", rpn); row->setProperty("boundaryReleases", edgeOffs); cases.add(row); pass = pass && correct;
    }
    result->setProperty("pass", pass); result->setProperty("cases", cases);
    result->setProperty("scope", "Ended-clip channel history, reset/bank/RPN ordering, pedal note lifetime, clipped events and exact-boundary note-off; hardware and repeated-key multiplicity not asserted");
    return result;
}
