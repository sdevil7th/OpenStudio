#pragma once

inline juce::var checkEQDraftProcessingModes()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "EQ draft audition across dynamic and prepared modes");
    bool guards = true, unchanged = true, finite = true; double maximumError = 0, stopError = 0;
    juce::Array<juce::var> cases;
    const auto proposal = [](float frequency, float gain)
    {
        auto* band = new juce::DynamicObject(); band->setProperty("frequency", frequency); band->setProperty("gain", gain);
        band->setProperty("q", 1.4); return juce::var(juce::Array<juce::var>{juce::var(band)});
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (int mode = 0; mode < 6; ++mode)
    {
        auto preview = std::make_unique<OpenStudioEQ>(true), committed = std::make_unique<OpenStudioEQ>(true);
        for (auto* eq : {preview.get(), committed.get()})
        {
            for (auto& band : eq->bands) band.enabled.store(0);
            auto& base = eq->bands[0]; base.enabled.store(1); base.type.store(0); base.freq.store(700); base.gain.store(3);
            base.dynamicEnabled.store(1); base.dynamicRange.store(-6); base.dynamicThreshold.store(-40);
            base.dynamicAttack.store(3); base.dynamicRelease.store(80);
            if (mode == 1 || mode == 5) eq->setPhaseConfiguration(1, 0);
            if (mode == 2 || mode == 3) { eq->setMinimumPhaseFIR(1); eq->setPhaseConfiguration(0, 0); }
            if (mode == 3) eq->setAnalogResponse(1);
            if (mode >= 4) { eq->setSpectralConfiguration(1); base.spectralEnabled.store(1); }
            else if (mode > 0) eq->setLinearDynamicsConfiguration(1);
        }
        auto& added = committed->bands[2]; added.enabled.store(1); added.type.store(0); added.freq.store(2000); added.gain.store(-6); added.q.store(1.4f);
        preview->prepareToPlay(rate, 257); committed->prepareToPlay(rate, 257);
        const int delay = preview->getLatencySamples(); juce::MemoryBlock before, after; preview->getStateInformation(before);
        guards = static_cast<bool>(preview->startDraftPreview("modes", proposal(2000, -6), before.toBase64Encoding())["success"]) && guards;
        juce::AudioBuffer<float> a(2, 257), b(2, 257); juce::MidiBuffer midi; bool updated = false, stopped = false;
        double error = 0, stoppedError = 0;
        for (int first = 0, turn = 0; first < rate * 1.1; first += 257, ++turn)
        {
            if (!updated && first > rate * .2)
            {
                added.freq.store(3000); added.gain.store(-9);
                guards = static_cast<bool>(preview->startDraftPreview("modes", proposal(3000, -9), before.toBase64Encoding(), true)["success"]) && guards;
                updated = true;
            }
            if (!stopped && first > rate * .75)
            { preview->draftPreview.command("modes", true, true); added.enabled.store(0); stopped = true; }
            for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 257; ++i)
            {
                const double time = (first + i) * juce::MathConstants<double>::twoPi / rate;
                const float sample = static_cast<float>(.01 * std::sin(time * (ch ? 900 : 400)) + .015 * std::sin(time * (ch ? 2600 : 2000)));
                a.setSample(ch, i, sample); b.setSample(ch, i, sample);
            }
            preview->processBlock(a, midi); committed->processBlock(b, midi);
            // Allow actual preparation workers wall time without changing the
            // processors to offline mode, which must cancel audition.
            if (mode > 0 && (turn < 16 || preview->isLinearPhaseUpdating() || committed->isLinearPhaseUpdating())) juce::Thread::sleep(1);
            for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 257; ++i)
            {
                finite = finite && std::isfinite(a.getSample(ch, i)) && std::abs(a.getSample(ch, i)) < .2f;
                const double difference = std::abs(static_cast<double>(a.getSample(ch, i) - b.getSample(ch, i)));
                if (first > rate * .5 && first < rate * .7) error = juce::jmax(error, difference);
                if (first > rate * .95) stoppedError = juce::jmax(stoppedError, difference);
            }
        }
        maximumError = juce::jmax(maximumError, error); stopError = juce::jmax(stopError, stoppedError);
        preview->getStateInformation(after); unchanged = unchanged && before == after && preview->getLatencySamples() == delay;
        guards = guards && !preview->draftPreview.requested();
        auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("mode", mode); row->setProperty("latency", delay);
        row->setProperty("settledCommittedError", error); row->setProperty("stoppedCommittedError", stoppedError); cases.add(row);
    }
    result->setProperty("pass", guards && unchanged && finite && maximumError < 3e-5 && stopError < 3e-5);
    result->setProperty("cases", cases); result->setProperty("settledCommittedError", maximumError); result->setProperty("stoppedCommittedError", stopError);
    result->setProperty("stateAndLatencyNeutral", unchanged); result->setProperty("startUpdateStop", guards); result->setProperty("finite", finite);
    result->setProperty("audioQuality", "not_asserted"); return result;
}
