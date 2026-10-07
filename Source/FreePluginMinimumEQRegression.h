#pragma once

inline juce::var checkMinimumPhaseEQ()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Prepared minimum-phase fractional EQ");
    bool finite = true, latency = true, statePass = true, descriptors = true, causal = true;
    double targetError = 0, graphError = 0, partitionError = 0, bypassError = 0;
    juce::Array<juce::var> cases;
    const auto render = [](OpenStudioEQ& eq, int length, bool irregular)
    {
        juce::AudioBuffer<float> output(2, length), block(2, 257); juce::MidiBuffer midi;
        int turn = 0;
        for (int first = 0; first < length;)
        {
            const int schedule[]{1, 7, 127, 32, 257, 63};
            const int count = juce::jmin(irregular ? schedule[turn++ % 6] : 257, length - first);
            block.setSize(2, count, false, false, true); block.clear();
            if (first == 0) { block.setSample(0, 0, .01f); block.setSample(1, 0, .01f); }
            eq.processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, first, block, ch, 0, count);
            first += count;
        }
        return output;
    };
    const auto measured = [](const juce::AudioBuffer<float>& audio, double rate, double frequency)
    {
        const auto z = std::polar(1.0, -juce::MathConstants<double>::twoPi * frequency / rate);
        std::complex<double> phase{1, 0}, sum{};
        for (int i = 0; i < audio.getNumSamples(); ++i) { sum += phase * static_cast<double>(audio.getSample(0, i)); phase *= z; }
        return std::abs(sum / .01);
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (int shape : {3, 4}) for (float slope : {3.0f, 15.0f, 37.5f, 96.0f})
        {
            auto eq = std::make_unique<OpenStudioEQ>(true); eq->setNonRealtime(true);
            for (auto& band : eq->bands) band.enabled.store(0);
            auto& band = eq->bands[0]; band.enabled.store(1); band.type.store(static_cast<float>(shape));
            band.freq.store(2000); band.cutMode.store(1); band.continuousSlope.store(slope);
            statePass = eq->setMinimumPhaseFIR(1) && statePass;
            eq->prepareToPlay(rate, 257); latency = latency && eq->getLatencySamples() == 256;
            const auto audio = render(*eq, 5000, false);
            eq->reset(); const auto partitioned = render(*eq, 5000, true);
            for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < audio.getNumSamples(); ++i)
            {
                finite = finite && std::isfinite(audio.getSample(ch, i));
                partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(audio.getSample(ch, i) - partitioned.getSample(ch, i))));
                if (i < 256) causal = causal && audio.getSample(ch, i) == 0;
            }
            const std::vector<float> frequencies{500, 1000, 2000, 4000, 8000};
            const auto graph = eq->getMagnitudeResponse(frequencies); double caseError = 0;
            for (size_t i = 0; i < frequencies.size(); ++i)
            {
                const double ratio = std::tan(juce::MathConstants<double>::pi * frequencies[i] / rate)
                    / std::tan(juce::MathConstants<double>::pi * 2000 / rate);
                const double ideal = -10 * std::log10(1 + std::pow(shape == 3 ? 1 / ratio : ratio, slope / 3));
                const double db = juce::Decibels::gainToDecibels(measured(audio, rate, frequencies[i]), -120.0);
                if (ideal > -60) caseError = juce::jmax(caseError, std::abs(db - ideal));
                if (db > -60) graphError = juce::jmax(graphError, std::abs(db - graph[i]));
            }
            targetError = juce::jmax(targetError, caseError);
            auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("shape", shape);
            row->setProperty("slope", slope); row->setProperty("targetErrorDbAboveMinus60", caseError); cases.add(row);
            eq->setPowerEnabled(false); eq->prepareToPlay(rate, 257);
            const auto bypass = render(*eq, 5000, true);
            for (int i = 0; i < bypass.getNumSamples(); ++i)
                bypassError = juce::jmax(bypassError, std::abs(static_cast<double>(bypass.getSample(0, i) - (i == 256 ? .01f : 0))));
        }
    }
    auto original = std::make_unique<OpenStudioEQ>(true), restored = std::make_unique<OpenStudioEQ>(true);
    original->setMinimumPhaseFIR(1); original->bands[23].cutMode.store(1); original->bands[23].continuousSlope.store(19.5f);
    juce::MemoryBlock state, again; original->getStateInformation(state);
    restored->setStateInformation(state.getData(), static_cast<int>(state.getSize())); restored->getStateInformation(again);
    statePass = statePass && state == again && restored->getLatencySamples() == 256;
    auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize()); tree.removeProperty("minimumPhaseFIR", nullptr);
    juce::MemoryBlock legacy; juce::MemoryOutputStream stream(legacy, false); tree.writeToStream(stream);
    restored->setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    statePass = statePass && restored->minimumPhaseFIR.load() == 0 && restored->getLatencySamples() == 0;
    const auto schema = describeFreePluginForRegression(*original);
    const auto* parameters = schema["parameters"].getArray();
    descriptors = parameters && parameters->size() >= 2 && (*parameters)[parameters->size()-2]["id"].toString() == "minimumPhaseFIR" && !static_cast<bool>((*parameters)[parameters->size()-2]["automatable"]);
    result->setProperty("pass", finite && latency && causal && statePass && descriptors && targetError < .5 && graphError < .08 && partitionError < 1e-8 && bypassError == 0);
    result->setProperty("finite", finite); result->setProperty("latency256", latency); result->setProperty("causal", causal);
    result->setProperty("targetErrorDbAboveMinus60", targetError); result->setProperty("graphErrorDbAboveMinus60", graphError);
    result->setProperty("blockPartitionError", partitionError); result->setProperty("alignedBypassError", bypassError);
    result->setProperty("stateAndLegacy", statePass); result->setProperty("appendedConfiguration", descriptors);
    result->setProperty("cases", cases); result->setProperty("schema", schema);
    result->setProperty("audioQuality", "not_asserted"); return result;
}
