#pragma once

// Diagnostic captures for the October 2026 free-plugin audit. This does not
// change production processing and does not assert subjective audio quality.
inline juce::var auditFreeInstrumentSignals()
{
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile(juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_OUTPUT", "output/free-plugin-audit")).getChildFile("instruments/native");
    directory.createDirectory();
    using InstrumentFactory = std::function<std::unique_ptr<juce::AudioProcessor>()>;
    const std::array<const char*, 8> names {"synth-default", "synth-sine", "piano-legacy", "piano-expressive", "guitar-legacy", "guitar-loop", "drums-legacy", "drums-articulated"};
    const auto factory = [] (int kind, int variant = 0) -> std::unique_ptr<juce::AudioProcessor>
    {
        if (kind < 2)
        {
            auto p = std::make_unique<OpenStudioBasicSynthInstrument>();
            if (kind == 1) { p->oscillatorAShape.store(3); p->oscillatorBlend.store(0); p->subLevel.store(0); p->noiseLevel.store(0); p->detuneCents.store(0); }
            if (variant == 1) p->brightness.store(0);
            if (variant == 2) p->brightness.store(1);
            if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_LEGACY", "") == "1") p->signalPath.store(0);
            return p;
        }
        if (kind < 4)
        {
            auto p = std::make_unique<OpenStudioPianoInstrument>(); p->performanceMode.store(kind == 3 ? 1.0f : 0.0f);
            if (variant > 0) p->model.store(static_cast<float>(variant - 1));
            if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_LEGACY", "") == "1") p->signalPath.store(0);
            return p;
        }
        if (kind < 6)
        {
            auto p = std::make_unique<OpenStudioCleanGuitarInstrument>(); p->stringEngine.store(kind == 5 ? 1.0f : 0.0f); p->stringMode.store(0);
            if (variant > 0) p->model.store(static_cast<float>(variant - 1));
            if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_LEGACY", "") == "1") p->signalPath.store(0);
            return p;
        }
        auto p = std::make_unique<OpenStudioDrumInstrument>(); p->articulationEngine.store(kind == 7 ? 1.0f : 0.0f);
        if (variant >= 1 && variant <= 3) p->kit.store(static_cast<float>(variant - 1));
        if (variant == 4) p->hihatTightness.store(0);
        if (variant == 5) p->hihatTightness.store(1);
        if (variant == 6) p->ambience.store(0);
        if (variant == 7) p->ambience.store(1);
        if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_LEGACY", "") == "1") p->signalPath.store(0);
        return p;
    };
    const auto midiFor = [] (int kind, double rate, float velocity, int note = 69)
    {
        juce::MidiBuffer midi;
        if (kind >= 6)
        {
            const std::array<int, 8> notes {36, 38, 42, 46, 41, 48, 49, 51};
            for (size_t i = 0; i < notes.size(); ++i) midi.addEvent(juce::MidiMessage::noteOn(10, notes[i], velocity), 37 + juce::roundToInt(static_cast<double>(i) * rate * .25));
        }
        else
        {
            midi.addEvent(juce::MidiMessage::noteOn(1, note, velocity), 37);
            midi.addEvent(juce::MidiMessage::noteOff(1, note), juce::roundToInt(rate * 1.5));
        }
        return midi;
    };
    const auto render = [] (const InstrumentFactory& make, double rate, const juce::MidiBuffer& events, bool fillInput = false, int partition = 257)
    {
        auto processor = make(); processor->prepareToPlay(rate, partition);
        const int length = juce::roundToInt(rate * 3);
        juce::AudioBuffer<float> output(2, length), block(2, partition); juce::MidiBuffer midi;
        for (int start = 0; start < length; start += partition)
        {
            const int count = juce::jmin(partition, length - start); block.setSize(2, count, false, false, true); block.clear();
            if (fillInput) for (int ch = 0; ch < 2; ++ch) juce::FloatVectorOperations::fill(block.getWritePointer(ch), .2f, count);
            midi.clear(); midi.addEvents(events, start, count, -start); processor->processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
        }
        return output;
    };
    const auto difference = [] (const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
    {
        double result = 0;
        for (int ch = 0; ch < a.getNumChannels(); ++ch) for (int i = 0; i < a.getNumSamples(); ++i)
            result = juce::jmax(result, std::abs(static_cast<double>(a.getSample(ch, i)) - b.getSample(ch, i)));
        return result;
    };
    juce::Array<juce::var> captures, controls, invariants;
    bool capturePass = true;
    for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (int kind = 0; kind < 8; ++kind)
    {
        const auto midi = midiFor(kind, rate, 1.0f);
        const auto audio = render([&] { return factory(kind); }, rate, midi);
        bool finite = true; double mean = 0, square = 0, peak = 0; int overs = 0;
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            const double value = audio.getSample(ch, i); finite = finite && std::isfinite(value); mean += value; square += value * value; peak = juce::jmax(peak, std::abs(value)); if (std::abs(value) > 1) ++overs;
        }
        const auto file = directory.getChildFile(juce::String(names[static_cast<size_t>(kind)]) + "-" + juce::String(static_cast<int>(rate)) + ".wav");
        const bool written = writeProbeWave(file, audio, rate); capturePass = capturePass && finite && written && peak > 0;
        auto* row = new juce::DynamicObject(); row->setProperty("kind", names[static_cast<size_t>(kind)]); row->setProperty("rate", rate); row->setProperty("path", file.getFullPathName()); row->setProperty("finite", finite); row->setProperty("written", written); row->setProperty("peak", peak); row->setProperty("overFullScaleSamples", overs); row->setProperty("mean", mean / (2 * audio.getNumSamples())); row->setProperty("rms", std::sqrt(square / (2 * audio.getNumSamples()))); captures.add(row);
        if (rate != 48000) continue;
        auto* check = new juce::DynamicObject(); check->setProperty("kind", names[static_cast<size_t>(kind)]);
        const auto alternate = render([&] { return factory(kind); }, rate, midi, false, 511);
        check->setProperty("partitionMaximumError", difference(audio, alternate));
        const auto withInput = render([&] { return factory(kind); }, rate, midi, true);
        check->setProperty("incomingAudioDiscardedMaximumError", difference(audio, withInput));
        auto source = factory(kind); juce::MemoryBlock saved; source->getStateInformation(saved);
        const auto restored = render([&] { auto copy = factory(kind); copy->setStateInformation(saved.getData(), static_cast<int>(saved.getSize())); return copy; }, rate, midi);
        check->setProperty("stateAudioRoundTripMaximumError", difference(audio, restored));
        const auto low = render([&] { return factory(kind); }, rate, midiFor(kind, rate, .25f));
        const auto mid = render([&] { return factory(kind); }, rate, midiFor(kind, rate, .5f));
        check->setProperty("velocity25Rms", low.getRMSLevel(0, 0, low.getNumSamples())); check->setProperty("velocity50Rms", mid.getRMSLevel(0, 0, mid.getNumSamples())); check->setProperty("velocity100Rms", audio.getRMSLevel(0, 0, audio.getNumSamples()));
        invariants.add(check);
        if (kind >= 6)
        {
            const auto studio = render([&] { return factory(kind, 1); }, rate, midi);
            const auto rock = render([&] { return factory(kind, 2); }, rate, midi);
            const auto electronic = render([&] { return factory(kind, 3); }, rate, midi);
            const auto loose = render([&] { return factory(kind, 4); }, rate, midi);
            const auto tight = render([&] { return factory(kind, 5); }, rate, midi);
            auto* comparison = new juce::DynamicObject(); comparison->setProperty("kind", names[static_cast<size_t>(kind)]); comparison->setProperty("studioRockMaximumError", difference(studio, rock)); comparison->setProperty("studioElectronicMaximumError", difference(studio, electronic)); comparison->setProperty("hiHatTightnessMaximumError", difference(loose, tight)); controls.add(comparison);
            for (const int variant : {2, 3, 4, 5, 6, 7})
            {
                const auto changed = render([&] { return factory(kind, variant); }, rate, midi);
                capturePass = writeProbeWave(directory.getChildFile(juce::String(names[static_cast<size_t>(kind)]) + "-control-" + juce::String(variant) + ".wav"), changed, rate) && capturePass;
            }
        }
        if (kind < 6) for (const int note : {40, 100})
        {
            const auto changed = render([&] { return factory(kind); }, rate, midiFor(kind, rate, 1.0f, note));
            capturePass = writeProbeWave(directory.getChildFile(juce::String(names[static_cast<size_t>(kind)]) + "-note-" + juce::String(note) + ".wav"), changed, rate) && capturePass;
        }
    }
    juce::Array<juce::var> tailChecks;
    for (const int kind : {6, 7})
    {
        juce::MidiBuffer crash; crash.addEvent(juce::MidiMessage::noteOn(10, 49, 1.0f), 0);
        const auto audio = render([&] { return factory(kind); }, 48000, crash);
        const auto processor = factory(kind); const double reportedTail = processor->getTailLengthSeconds();
        auto* row = new juce::DynamicObject(); row->setProperty("kind", names[static_cast<size_t>(kind)]); row->setProperty("declaredTailSeconds", reportedTail);
        row->setProperty("rms2to3Seconds", audio.getRMSLevel(0, 96000, 48000)); row->setProperty("peak2to3Seconds", audio.getMagnitude(0, 96000, 48000));
        auto ordinaryOff = crash; ordinaryOff.addEvent(juce::MidiMessage::noteOff(10, 49), 48000);
        auto allOff = crash; allOff.addEvent(juce::MidiMessage::allNotesOff(10), 48000);
        const auto released = render([&] { return factory(kind); }, 48000, ordinaryOff);
        const auto stopped = render([&] { return factory(kind); }, 48000, allOff);
        row->setProperty("ordinaryNoteOffTailRms1to2Seconds", released.getRMSLevel(0, 48000, 48000));
        row->setProperty("allNotesOffTailRms1to2Seconds", stopped.getRMSLevel(0, 48000, 48000));
        row->setProperty("lastSampleBeforeAllNotesOff", stopped.getSample(0, 47999));
        row->setProperty("firstSampleAfterAllNotesOff", stopped.getSample(0, 48000)); tailChecks.add(row);
        capturePass = writeProbeWave(directory.getChildFile(juce::String(names[static_cast<size_t>(kind)]) + "-all-notes-off.wav"), stopped, 48000) && capturePass;
        capturePass = writeProbeWave(directory.getChildFile(juce::String(names[static_cast<size_t>(kind)]) + "-single-crash.wav"), audio, 48000) && capturePass;
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Four free instruments: diagnostic render audit"); result->setProperty("pass", capturePass); result->setProperty("captures", captures); result->setProperty("controlComparisons", controls); result->setProperty("invariants", invariants); result->setProperty("tailChecks", tailChecks); result->setProperty("audioQuality", "not_asserted"); result->setProperty("status", "diagnostic_only; pass means capture sanity, not all implementation expectations"); return result;
}
