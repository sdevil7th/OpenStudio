#pragma once
inline juce::var checkReverbReconstructedPeaks()
{
    auto* result = new juce::DynamicObject(); bool levels = true, parity = true, reset = true, state = true; double partitionError = 0; juce::Array<juce::var> cases;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (int channels : {1, 2})
    {
        auto processor = std::make_unique<OpenStudioReverb>(true); processor->wetLevel.store(0); processor->dryLevel.store(1); processor->reconstructedPeaks.store(1); processor->prepareToPlay(rate, 127);
        BuiltInReverbPeakMeter oracle; oracle.beginBlock(true); juce::MidiBuffer midi; juce::AudioBuffer<float> whole(channels, 4096);
        for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < whole.getNumSamples(); ++i)
        {
            const double fade = juce::jmin(1.0, i / 256.0);
            whole.setSample(ch, i, static_cast<float>((ch ? .3 : 1.2) * fade * std::sin(juce::MathConstants<double>::halfPi * i + juce::MathConstants<double>::pi / 4)));
        }
        oracle.process(whole, false);
        for (int start = 0; start < whole.getNumSamples(); start += 127)
        {
            const int length = juce::jmin(127, whole.getNumSamples() - start); juce::AudioBuffer<float> part(channels, length);
            for (int ch = 0; ch < channels; ++ch) part.copyFrom(ch, 0, whole, ch, start, length);
            processor->processBlock(part, midi);
            for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < length; ++i) parity = parity && part.getSample(ch, i) == whole.getSample(ch, start + i);
        }
        const auto& meter = processor->reconstructedPeakMeter; const double peak = meter.read(false, 0, true), sample = processor->peakHold.read(false, 0);
        const double right = meter.read(false, 1, true), expected = juce::Decibels::gainToDecibels(1.2);
        levels = levels && std::abs(peak - expected) < .04 && peak - sample > 2.95 && std::abs(right - juce::Decibels::gainToDecibels(channels == 1 ? 1.2 : .3)) < .04;
        for (size_t ch = 0; ch < 2; ++ch) { partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(meter.read(false, ch, true) - oracle.read(false, ch, true)))); levels = levels && meter.read(false, ch, true) == meter.read(true, ch, true); }
        juce::MemoryBlock saved, again; processor->getStateInformation(saved); auto copy = std::make_unique<OpenStudioReverb>(true); copy->setStateInformation(saved.getData(), static_cast<int>(saved.getSize())); copy->getStateInformation(again); state = state && saved == again && copy->reconstructedPeaks.load() == 1 && processor->getLatencySamples() == 0;
        juce::AudioBuffer<float> silence(channels, 127); silence.clear(); reset = setFreePluginParamForRegression(*processor, "peakHoldReset", 1) && meter.resetPending() && reset; processor->processBlock(silence, midi); reset = reset && !meter.resetPending() && meter.read(false, 0, true) == -100 && meter.read(true, 1, true) == -100;
        processor->reconstructedPeaks.store(0); processor->processBlock(silence, midi); reset = reset && meter.read(false, 0, false) == -100;
        auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("channels", channels); row->setProperty("sampleDbFS", sample); row->setProperty("estimatedDbTP", peak); row->setProperty("analyticDbTP", expected); cases.add(row);
    }
    auto source = std::make_unique<OpenStudioReverb>(true); source->reconstructedPeaks.store(1); juce::ValueTree old("OpenStudioReverb"); juce::MemoryBlock bytes; juce::MemoryOutputStream stream(bytes, false); old.writeToStream(stream); source->setStateInformation(bytes.getData(), static_cast<int>(bytes.getSize())); state = state && source->reconstructedPeaks.load() == 0;
    const auto schema = describeFreePluginForRegression(*source); const auto* parameters = schema["parameters"].getArray(); state = state && parameters && parameters->size() > 1083 && (*parameters)[1083]["id"].toString() == "reconstructedPeaks";
    result->setProperty("plugin", "Reverb optional reconstructed peak telemetry"); result->setProperty("cases", cases); result->setProperty("analyticToneAndChannelLevels", levels); result->setProperty("exactDryAudioParity", parity); result->setProperty("partitionError", partitionError); result->setProperty("resetAndDisable", reset); result->setProperty("stateDefaultsAndNoLatency", state); result->setProperty("schema", schema); result->setProperty("standardsCertification", "not_asserted"); result->setProperty("audioQuality", "not_asserted"); result->setProperty("pass", levels && parity && partitionError == 0 && reset && state); return result;
}
