#pragma once

juce::var checkFETDetectorTilt()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "FET detector tilt");
    bool finite = true, bypass = true, response = true, influence = true, isolated = true;
    double slopeError = 0, unityError = 0, partitionError = 0, dryError = 0;
    juce::Array<juce::var> cases;
    const auto render = [](double rate, int blockSize, float tilt, int ratioMode, float mix, double hz, bool external = false)
    {
        auto processor = std::make_unique<OpenStudioCompressor>(true); processor->selectModel(2);
        processor->fetTilt.store(tilt); processor->fetRatio.store(static_cast<float>(ratioMode)); processor->mix.store(mix);
        processor->externalDetector.store(external ? 1.0f : 0.0f); processor->prepareToPlay(rate, blockSize);
        juce::AudioBuffer<float> audio(2, static_cast<int>(rate * .3)); juce::MidiBuffer midi;
        for (int start = 0; start < audio.getNumSamples(); start += blockSize)
        {
            const int count = juce::jmin(blockSize, audio.getNumSamples() - start); juce::AudioBuffer<float> block(2, count);
            for (int i = 0; i < count; ++i) { const float x = static_cast<float>(.3 * std::sin(juce::MathConstants<double>::twoPi * hz * (start + i) / rate)); block.setSample(0, i, x); block.setSample(1, i, -.5f * x); }
            processor->processBlock(block, midi); for (int ch = 0; ch < 2; ++ch) audio.copyFrom(ch, start, block, ch, 0, count);
        }
        return audio;
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        double previous = 0; juce::Array<juce::var> measured;
        for (double hz : {100.0, 200.0, 400.0, 800.0, 1600.0, 3200.0, 6400.0, 1000.0})
        {
            BuiltInDetectorTilt filter; filter.prepare(rate, true); double sumIn = 0, sumOut = 0;
            for (int i = 0; i < static_cast<int>(rate * .5); ++i)
            {
                const float x = static_cast<float>(.1 * std::sin(juce::MathConstants<double>::twoPi * hz * i / rate));
                const auto y = filter.process(x, 0); finite = finite && std::isfinite(y[0]) && y[1] == 0;
                if (i >= static_cast<int>(rate * .25)) { sumIn += x * x; sumOut += y[0] * y[0]; }
            }
            const double db = 10 * std::log10(sumOut / sumIn); measured.add(db);
            if (hz > 100 && hz != 1000) slopeError = juce::jmax(slopeError, std::abs(db - previous - 3.01029995664));
            if (hz == 1000) unityError = juce::jmax(unityError, std::abs(db));
            previous = db;
        }
        BuiltInDetectorTilt off; off.prepare(rate, false);
        for (int i = 0; i < 800; ++i) { const float x = static_cast<float>(std::sin(.1 * i)); const auto y = off.process(x, -x); bypass = bypass && y[0] == x && y[1] == -x; }
        const auto a = render(rate, 127, 1, 0, 1, 200), b = render(rate, 512, 1, 0, 1, 200);
        const auto normalLow = render(rate, 512, 0, 0, 1, 100), tiltedLow = render(rate, 512, 1, 0, 1, 100);
        const auto normalHigh = render(rate, 512, 0, 0, 1, 4000), tiltedHigh = render(rate, 512, 1, 0, 1, 4000);
        const int begin = static_cast<int>(rate * .15), length = a.getNumSamples() - begin;
        const double lowRatio = tiltedLow.getRMSLevel(0, begin, length) / normalLow.getRMSLevel(0, begin, length);
        const double highRatio = tiltedHigh.getRMSLevel(0, begin, length) / normalHigh.getRMSLevel(0, begin, length);
        influence = influence && lowRatio > 1.4 && highRatio < .8;
        for (float mix : {0.0f, 1.0f})
        {
            const auto original = render(rate, 512, 0, 5, mix, 200), changed = render(rate, 512, 1, 5, mix, 200);
            for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < a.getNumSamples(); ++i)
                dryError = juce::jmax<double>(dryError, std::abs(original.getSample(ch, i) - changed.getSample(ch, i)));
        }
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < a.getNumSamples(); ++i)
            partitionError = juce::jmax<double>(partitionError, std::abs(a.getSample(ch, i) - b.getSample(ch, i)));
        const auto missingKey = render(rate, 512, 1, 0, 1, 200, true), uncompressed = render(rate, 512, 1, 5, 1, 200);
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < a.getNumSamples(); ++i) isolated = isolated && missingKey.getSample(ch, i) == uncompressed.getSample(ch, i);
        auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", rate); row->setProperty("measuredDb100To6400Then1000Hz", measured); row->setProperty("lowOutputRatio", lowRatio); row->setProperty("highOutputRatio", highRatio); cases.add(row);
    }
    auto source = std::make_unique<OpenStudioCompressor>(true), copy = std::make_unique<OpenStudioCompressor>(true);
    bool state = setFreePluginParamForRegression(*source, "fetTilt", 1); source->selectModel(2); source->selectModel(3); source->selectModel(2);
    juce::MemoryBlock bytes, after; source->getStateInformation(bytes); copy->setStateInformation(bytes.getData(), static_cast<int>(bytes.getSize())); copy->getStateInformation(after);
    state = state && bytes == after && copy->fetTilt.load() == 1;
    auto tree = juce::ValueTree::readFromData(bytes.getData(), bytes.getSize()); tree.removeProperty("fetTilt", nullptr); juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
    copy->setStateInformation(old.getData(), static_cast<int>(old.getSize())); state = state && copy->fetTilt.load() == 0;
    const auto schema = describeFreePluginForRegression(*source); const auto& parameters = *schema["parameters"].getArray();
    state = state && parameters[70]["id"].toString() == "fetTilt";
    response = slopeError < .2 && unityError < .015;
    result->setProperty("cases", cases); result->setProperty("octaveSlopeErrorDb", slopeError); result->setProperty("unityErrorDb", unityError);
    result->setProperty("partitionError", partitionError); result->setProperty("dryAndRatioOffError", dryError); result->setProperty("finiteStereoIsolation", finite);
    result->setProperty("exactOff", bypass); result->setProperty("audioInfluence", influence); result->setProperty("missingExternalKey", isolated); result->setProperty("stateMigrationAndAppend", state);
    result->setProperty("schema", schema); result->setProperty("referenceFidelity", "not_asserted");
    result->setProperty("pass", finite && bypass && response && influence && isolated && state && partitionError == 0 && dryError == 0); return result;
}
