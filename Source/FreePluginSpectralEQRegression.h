#pragma once

inline juce::var checkSpectralEQ()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "EQ prepared spectral dynamics");
    bool unity = true, latencyPass = true, selective = true, external = true, targetPass = true, finite = true;
    double partitionError = 0; juce::Array<juce::var> cases;
    const auto configure = [](OpenStudioEQ& eq, int quality, bool linear, int key, int target)
    {
        eq.setNonRealtime(true);
        for (auto& band : eq.bands) band.enabled.store(0);
        auto& band = eq.bands[1]; band.enabled.store(1);
        band.freq.store(2000); band.q.store(.1f); band.dynamicEnabled.store(1);
        band.spectralEnabled.store(1); band.spectralDensity.store(1); band.spectralTilt.store(0);
        band.dynamicRange.store(-18); band.dynamicThreshold.store(-35); band.dynamicAttack.store(1);
        band.dynamicRelease.store(30); band.detectorSource.store(static_cast<float>(key)); band.target.store(static_cast<float>(target));
        eq.setPhaseConfiguration(linear ? 1.0f : 0.0f, static_cast<float>(quality)); eq.setSpectralConfiguration(1);
    };
    const auto render = [](OpenStudioEQ& eq, double rate, int blockSize, int length, bool key, bool opposite = false)
    {
        juce::AudioBuffer<float> output(2, length), block(key ? 4 : 2, blockSize); juce::MidiBuffer midi;
        eq.prepareToPlay(rate, blockSize);
        for (int start = 0; start < length; start += blockSize)
        {
            const int count = juce::jmin(blockSize, length - start); block.setSize(key ? 4 : 2, count, false, false, true);
            for (int i = 0; i < count; ++i)
            {
                const double time = (start + i) / rate;
                const float sample = static_cast<float>(.2 * std::sin(juce::MathConstants<double>::twoPi * 1000 * time)
                    + .002 * std::sin(juce::MathConstants<double>::twoPi * 3000 * time));
                block.setSample(0, i, sample); block.setSample(1, i, opposite ? -sample : sample);
                if (key) { const float value = .2f * static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * 3000 * time)); block.setSample(2, i, value); block.setSample(3, i, opposite ? -value : value); }
            }
            eq.processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
        }
        return output;
    };
    const auto level = [](const juce::AudioBuffer<float>& audio, double rate, double hz, int channel)
    {
        std::complex<double> sum {}; const int count = juce::roundToInt(rate * .1), first = audio.getNumSamples() - count;
        for (int i = first; i < audio.getNumSamples(); ++i)
            sum += static_cast<double>(audio.getSample(channel, i)) * std::polar(1.0, -juce::MathConstants<double>::twoPi * hz * i / rate);
        return 2 * std::abs(sum) / count;
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (int quality = 0; quality < 3; ++quality)
        {
            if (rate != 48000 && quality != 1) continue;
            auto eq = std::make_unique<OpenStudioEQ>(true); configure(*eq, quality, false, 1, 0);
            const int length = juce::roundToInt(rate * .4) + BuiltInSpectralEQ::latency(quality);
            const auto wet = render(*eq, rate, 127, length, false);
            latencyPass = latencyPass && eq->getLatencySamples() == BuiltInSpectralEQ::latency(quality);
            const double loudDb = juce::Decibels::gainToDecibels(level(wet, rate, 1000, 0) / .2);
            const double quietDb = juce::Decibels::gainToDecibels(level(wet, rate, 3000, 0) / .002);
            selective = selective && loudDb < -9 && std::abs(quietDb) < 1;
            eq->bands[1].detectorSource.store(2);
            const auto keyed = render(*eq, rate, 127, length, true);
            const double keyedLoud = juce::Decibels::gainToDecibels(level(keyed, rate, 1000, 0) / .2);
            const double keyedQuiet = juce::Decibels::gainToDecibels(level(keyed, rate, 3000, 0) / .002);
            external = external && std::abs(keyedLoud) < 1 && keyedQuiet < -9;
            const auto missing = render(*eq, rate, 512, length, false);
            for (int i = 0; i < length; ++i)
            {
                const int source = i - eq->getLatencySamples();
                const float expected = source < 0 ? 0 : static_cast<float>(.2 * std::sin(juce::MathConstants<double>::twoPi * 1000 * source / rate)
                    + .002 * std::sin(juce::MathConstants<double>::twoPi * 3000 * source / rate));
                unity = unity && std::abs(missing.getSample(0, i) - expected) < 1e-7f;
                finite = finite && std::isfinite(wet.getSample(0, i)) && std::isfinite(keyed.getSample(0, i));
            }
            auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("quality", quality);
            row->setProperty("loudToneDb", loudDb); row->setProperty("quietToneDb", quietDb);
            row->setProperty("keyedLoudToneDb", keyedLoud); row->setProperty("keyedQuietToneDb", keyedQuiet); cases.add(row);
        }
    }
    for (bool linear : {false, true})
    {
        auto eq = std::make_unique<OpenStudioEQ>(true); configure(*eq, 0, linear, 1, 0);
        const auto first = render(*eq, 48000, 127, 20000, false), second = render(*eq, 48000, 512, 20000, false);
        for (int i = 0; i < first.getNumSamples(); ++i) partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(first.getSample(0, i) - second.getSample(0, i))));
        latencyPass = latencyPass && eq->getLatencySamples() == 1024 + (linear ? 768 : 0);
    }
    for (int target : {1, 2, 3, 4})
    {
        auto eq = std::make_unique<OpenStudioEQ>(true); configure(*eq, 0, false, 1, target);
        const bool opposite = target == 4;
        const auto audio = render(*eq, 48000, 127, 22000, false, opposite);
        const double l = level(audio, 48000, 1000, 0) / .2, r = level(audio, 48000, 1000, 1) / .2;
        targetPass = targetPass && (target == 1 ? l < .4 && std::abs(r - 1) < .001 : target == 2 ? r < .4 && std::abs(l - 1) < .001 : l < .4 && r < .4);
    }
    bool bypass = true;
    for (double rate : {48000.0, 192000.0})
    {
        auto processor = std::make_unique<OpenStudioEQ>(true); configure(*processor, 0, false, 1, 0);
        processor->editorBypass.store(1);
        const auto dry = render(*processor, rate, 127, 12000, false);
        for (int i = 0; i < dry.getNumSamples(); ++i)
        {
            const int source = i - processor->getLatencySamples();
            const float expected = source < 0 ? 0 : static_cast<float>(.2 * std::sin(juce::MathConstants<double>::twoPi * 1000 * source / rate)
                + .002 * std::sin(juce::MathConstants<double>::twoPi * 3000 * source / rate));
            bypass = bypass && std::abs(dry.getSample(0, i) - expected) < 1e-7f;
        }
    }
    auto eq = std::make_unique<OpenStudioEQ>(true), copy = std::make_unique<OpenStudioEQ>(true);
    const bool setters = setFreePluginParamForRegression(*eq, "spectralProcessing", 1)
        && setFreePluginParamForRegression(*eq, "band23.spectralEnabled", 1)
        && setFreePluginParamForRegression(*eq, "band23.spectralDensity", .25f)
        && setFreePluginParamForRegression(*eq, "band23.spectralTilt", 0);
    juce::MemoryBlock state, again; eq->getStateInformation(state); copy->setStateInformation(state.getData(), static_cast<int>(state.getSize())); copy->getStateInformation(again);
    bool recall = state == again && copy->spectralProcessing.load() == 1 && copy->bands[23].spectralDensity.load() == .25f;
    auto old = juce::ValueTree::readFromData(state.getData(), state.getSize()); old.removeProperty("spectralProcessing", nullptr);
    for (int b = 0; b < 24; ++b) for (const auto* field : {"spectralEnabled", "spectralDensity", "spectralTilt"}) old.removeProperty("band" + juce::String(b) + "_" + field, nullptr);
    juce::MemoryBlock legacy; juce::MemoryOutputStream stream(legacy, false); old.writeToStream(stream); copy->setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    recall = recall && copy->spectralProcessing.load() == 0 && copy->getLatencySamples() == 0;
    for (const auto& band : copy->bands) recall = recall && band.spectralEnabled.load() == 0 && band.spectralDensity.load() == .75f && band.spectralTilt.load() == 1;
    const auto schema = describeFreePluginForRegression(*eq);
    const bool appended = schema["parameters"].size() >= 643 && schema["parameters"][570]["id"].toString() == "spectralProcessing" && !static_cast<bool>(schema["parameters"][570]["automatable"]);
    result->setProperty("bypassFromPrepare", bypass);
    result->setProperty("pass", bypass && unity && latencyPass && selective && external && targetPass && finite && partitionError < 1e-7 && setters && recall && appended);
    result->setProperty("unityWithMissingKey", unity); result->setProperty("latency", latencyPass); result->setProperty("selectiveInternal", selective); result->setProperty("selectiveExternal", external);
    result->setProperty("targets", targetPass); result->setProperty("finite", finite); result->setProperty("partitionError", partitionError);
    result->setProperty("stateAndLegacy", recall); result->setProperty("setters", setters); result->setProperty("appended", appended);
    result->setProperty("cases", cases); result->setProperty("schema", schema); result->setProperty("audioQuality", "not_asserted");
    return result;
}
