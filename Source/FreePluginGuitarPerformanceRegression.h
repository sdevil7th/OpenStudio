#pragma once

inline juce::var checkGuitarPerformanceTelemetry()
{
    auto* result = new juce::DynamicObject();
    juce::Array<juce::var> checks;
    bool pass = true;
    const auto require = [&](const char* name, bool condition)
    {
        auto* row = new juce::DynamicObject(); row->setProperty("name", name); row->setProperty("pass", condition);
        checks.add(row); pass = pass && condition;
    };
    OpenStudioCleanGuitarInstrument guitar;
    guitar.stringEngine.store(1); guitar.articulationKeys.store(1); guitar.stringMode.store(1); guitar.releaseMs.store(20);
    guitar.prepareToPlay(48000, 127);
    const auto render = [&](std::initializer_list<std::pair<juce::MidiMessage, int>> events, int samples = 127)
    {
        juce::AudioBuffer<float> audio(2, samples); juce::MidiBuffer midi;
        for (const auto& event : events) midi.addEvent(event.first, event.second);
        guitar.processBlock(audio, midi);
        return guitar.guitarPerformance.visualization();
    };
    const auto voice = [](const juce::var& snapshot, int channel, int note)
    {
        if (const auto* rows = snapshot["voices"].getArray()) for (const auto& item : *rows)
            if (static_cast<int>(item["channel"]) == channel && static_cast<int>(item["note"]) == note) return item;
        return juce::var();
    };
    juce::MemoryBlock before, after; guitar.getStateInformation(before);
    auto snapshot = render({
        {juce::MidiMessage::noteOn(2, 25, .8f), 1}, {juce::MidiMessage::noteOff(2, 25), 2},
        {juce::MidiMessage::noteOn(2, 57, .8f), 11}, {juce::MidiMessage::noteOn(3, 62, .8f), 33},
        {juce::MidiMessage::noteOn(1, 40, .8f), 65}});
    require("channel-key-switch-and-explicit-string", static_cast<bool>(snapshot["available"])
        && snapshot["voices"].size() == 3 && static_cast<int>(voice(snapshot, 2, 57)["articulation"]) == 1
        && static_cast<int>(voice(snapshot, 2, 57)["stringIndex"]) == 1
        && static_cast<int>(voice(snapshot, 3, 62)["articulation"]) == 0
        && static_cast<int>(voice(snapshot, 3, 62)["stringIndex"]) == 2
        && snapshot["nextArticulations"][1]["source"].toString() == "keyswitch"
        && static_cast<int>(snapshot["nextArticulations"][1]["articulation"]) == 1);
    snapshot = render({{juce::MidiMessage::noteOn(2, 26, .8f), 0}, {juce::MidiMessage::noteOff(2, 26), 1},
                       {juce::MidiMessage::noteOn(2, 62, .8f), 32}});
    require("replaced-string-retains-releasing-voice-articulation", snapshot["voices"].size() == 4
        && static_cast<int>(voice(snapshot, 2, 57)["articulation"]) == 1
        && static_cast<bool>(voice(snapshot, 2, 57)["releasing"]) && !static_cast<bool>(voice(snapshot, 2, 57)["assigned"])
        && static_cast<int>(voice(snapshot, 2, 62)["articulation"]) == 2 && static_cast<bool>(voice(snapshot, 2, 62)["assigned"]));
    snapshot = render({{juce::MidiMessage::controllerEvent(2, 121, 0), 0}, {juce::MidiMessage::noteOn(2, 64, .8f), 20},
                       {juce::MidiMessage::noteOn(3, 30, .8f), 25}, {juce::MidiMessage::noteOff(3, 30), 26}});
    require("reset-controller-clears-channel-override-only", snapshot["nextArticulations"][1]["source"].toString() == "panel"
        && static_cast<int>(voice(snapshot, 2, 64)["articulation"]) == 0
        && static_cast<int>(voice(snapshot, 3, 62)["articulation"]) == 6
        && snapshot["nextArticulations"][2]["source"].toString() == "keyswitch");
    snapshot = render({{juce::MidiMessage::allSoundOff(2), 0}, {juce::MidiMessage::controllerEvent(1, 64, 127), 1},
                       {juce::MidiMessage::noteOff(1, 40), 2}});
    require("channel-stop-and-pedal-held-allocation", voice(snapshot, 2, 64).isVoid()
        && !voice(snapshot, 3, 62).isVoid() && !static_cast<bool>(voice(snapshot, 1, 40)["held"])
        && static_cast<bool>(voice(snapshot, 1, 40)["sustained"]) && !static_cast<bool>(voice(snapshot, 1, 40)["releasing"]));
    snapshot = render({{juce::MidiMessage::controllerEvent(1, 64, 0), 0}});
    require("pedal-release-visible-until-envelope-finishes", static_cast<bool>(voice(snapshot, 1, 40)["releasing"]));
    snapshot = render({}, 2048);
    require("completed-release-removed", voice(snapshot, 1, 40).isVoid());
    guitar.getStateInformation(after);
    require("performance-is-not-persistent-state", before == after);
    guitar.reset(); snapshot = guitar.guitarPerformance.visualization();
    require("reset-clears-voices-and-overrides", snapshot["voices"].size() == 0
        && snapshot["nextArticulations"][2]["source"].toString() == "panel");
    guitar.stringMode.store(0);
    snapshot = render({{juce::MidiMessage::noteOn(8, 40, .8f), 0}, {juce::MidiMessage::noteOn(8, 45, .8f), 1},
        {juce::MidiMessage::noteOn(8, 50, .8f), 2}, {juce::MidiMessage::noteOn(8, 55, .8f), 3},
        {juce::MidiMessage::noteOn(8, 59, .8f), 4}, {juce::MidiMessage::noteOn(8, 64, .8f), 5}});
    bool stringsCorrect = snapshot["voices"].size() == 6;
    const std::array<int, 6> openStrings {40, 45, 50, 55, 59, 64};
    for (size_t string = 0; string < openStrings.size(); ++string)
        stringsCorrect = stringsCorrect && static_cast<int>(voice(snapshot, 8, openStrings[string])["stringIndex"]) == static_cast<int>(string);
    require("automatic-six-string-allocation", stringsCorrect);
    guitar.reset(); guitar.stringMode.store(2);
    snapshot = render({{juce::MidiMessage::noteOn(7, 76, .8f), 0}, {juce::MidiMessage::noteOn(2, 52, .8f), 5}});
    require("channels-two-through-seven-string-offset", static_cast<int>(voice(snapshot, 7, 76)["stringIndex"]) == 5
        && static_cast<int>(voice(snapshot, 2, 52)["stringIndex"]) == 0);
    guitar.reset(); guitar.stringMode.store(0); guitar.articulation.store(3);
    render({{juce::MidiMessage::noteOn(4, 57, .8f), 0}});
    snapshot = render({{juce::MidiMessage::noteOn(4, 59, .8f), 7}});
    require("legato-transfer-retires-source-allocation", snapshot["voices"].size() == 1
        && voice(snapshot, 4, 57).isVoid() && static_cast<int>(voice(snapshot, 4, 59)["stringIndex"]) == 3
        && static_cast<int>(voice(snapshot, 4, 59)["articulation"]) == 3);
    guitar.reset(); guitar.stringEngine.store(0); guitar.stringMode.store(1);
    snapshot = render({{juce::MidiMessage::noteOn(3, 60, .8f), 0}, {juce::MidiMessage::noteOn(3, 60, .8f), 30}});
    int assigned = 0;
    for (const auto& item : *snapshot["voices"].getArray()) assigned += static_cast<bool>(item["assigned"]) ? 1 : 0;
    require("repeated-notes-have-distinct-voice-slots", snapshot["voices"].size() == 2 && assigned == 1
        && !static_cast<bool>(snapshot["voices"][0]["plucked"])
        && static_cast<int>(snapshot["voices"][0]["slot"]) != static_cast<int>(snapshot["voices"][1]["slot"])
        && snapshot["nextArticulations"][2]["source"].toString() == "legacy");
    guitar.reset(); guitar.releaseMs.store(2000);
    // Let each attack rise before replacing its string. One-sample spacing
    // creates near-zero releases that finish before the voice pool fills.
    for (int note = 48; note < 64; ++note)
    {
        render({{juce::MidiMessage::noteOn(1, note, .8f), 0}});
        for (int block = 0; block < 3; ++block) render({});
    }
    const auto beforeSteal = guitar.guitarPerformance.visualization();
    snapshot = render({{juce::MidiMessage::noteOn(1, 64, .8f), 0}});
    result->setProperty("beforeSteal", beforeSteal);
    result->setProperty("afterSteal", snapshot);
    // Verify oldest-held replacement without a stale telemetry row.
    int removed = 0;
    for (int note = 48; note < 64; ++note) removed += voice(snapshot, 1, note).isVoid() ? 1 : 0;
    require("stolen-slot-replaces-old-note-without-ghost", snapshot["voices"].size() == 16
        && beforeSteal["voices"].size() == 16 && removed == 1
        && voice(snapshot, 1, 48).isVoid() && !voice(snapshot, 1, 64).isVoid());
    guitar.guitarPerformance.begin();
    require("reader-is-bounded-during-publication", !static_cast<bool>(guitar.guitarPerformance.visualization()["available"]));
    guitar.guitarPerformance.end();
    result->setProperty("plugin", "Guitar effective articulation and string allocation");
    result->setProperty("pass", pass); result->setProperty("checks", checks);
    result->setProperty("scope", "Native block-end voice state: keyswitch channels, three string modes, replaced/repeated voices, pedal release, legato transfer, reset and persistence exclusion. MIDI note names exclude continuous pitch bends/slides; body/chorus tails are not voices. Audio quality not asserted.");
    return result;
}
