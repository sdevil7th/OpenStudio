#pragma once
inline juce::var checkDelayTimingTelemetry()
{
    struct Clock final : juce::AudioPlayHead
    {
        double bpm = 90.0;
        juce::Optional<PositionInfo> getPosition() const override
        { PositionInfo position; position.setBpm(bpm); return position; }
    } clock;
    bool pass = true;
    for (const auto rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        OpenStudioDelay delay;
        delay.prepareToPlay(rate, 127);
        delay.tempoSync.store(1); delay.syncNoteL.store(2); delay.syncNoteR.store(8);
        delay.delayTimeL.store(321); delay.delayTimeR.store(654);
        juce::AudioBuffer<float> audio(2,127); audio.clear(); juce::MidiBuffer midi;
        pass = delay.editorTempoBpm.load() == 0 && pass;
        delay.processBlock(audio,midi);
        pass = delay.editorTempoSource.load() == 0 && delay.editorTempoBpm.load() == 120
            && std::abs(delay.effectiveDelayMsL.load()-500) < .002f
            && std::abs(delay.effectiveDelayMsR.load()-375) < .002f && pass;
        delay.setPlayHead(&clock); delay.processBlock(audio,midi);
        pass = delay.editorTempoSource.load() == 1 && delay.editorTempoBpm.load() == 90
            && std::abs(delay.effectiveDelayMsL.load()-666.6667f) < .002f
            && std::abs(delay.effectiveDelayMsR.load()-500) < .002f && pass;
        delay.setPlayHead(nullptr); delay.processBlock(audio,midi);
        pass = delay.editorTempoSource.load() == 2 && delay.editorTempoBpm.load() == 90 && pass;
        delay.tempoSync.store(0); delay.processBlock(audio,midi);
        pass = std::abs(delay.effectiveDelayMsL.load()-321) < .002f
            && std::abs(delay.effectiveDelayMsR.load()-654) < .002f && pass;
        delay.reset(); pass = delay.editorTempoBpm.load() == 0 && pass;
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Delay timing telemetry"); result->setProperty("pass", pass);
    result->setProperty("scope", "Four rates: nominal effective free/synced times, explicit fallback/current/retained host tempo, free-value preservation and reset unavailable state. Modulated read-head timing is not asserted.");
    return result;
}
