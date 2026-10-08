#pragma once

inline juce::var checkAnalogTargetEQ()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Original analog-target FIR EQ");
    bool finite = true, latency = true, recall = true; double magnitudeError = 0, phaseError = 0, graphError = 0;
    juce::Array<juce::var> cases;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int shape : {0, 1, 2, 3, 4, 5, 6, 7}) for (float cutoff : {2000.0f, 15000.0f}) for (float q : {.70710678f, 4.0f}) for (float gain : {-12.0f, 12.0f})
        {
            auto eq = std::make_unique<OpenStudioEQ>(true); eq->setNonRealtime(true);
            for (auto& band : eq->bands) band.enabled.store(0);
            auto& band = eq->bands[1]; band.enabled.store(1); band.type.store(static_cast<float>(shape == 7 ? 0 : shape)); band.allPass.store(shape == 7 ? 1.0f : 0.0f); band.slope.store(1); band.freq.store(cutoff); band.q.store(q); band.gain.store(gain);
            eq->setPhaseConfiguration(0, 2); eq->setMinimumPhaseFIR(1); eq->setAnalogResponse(1); eq->prepareToPlay(rate, 257);
            latency = latency && eq->getLatencySamples() == 512;
            constexpr int length = 17000; juce::AudioBuffer<float> audio(2, length), block(2, 257); juce::MidiBuffer midi;
            for (int first = 0; first < length; first += 257)
            {
                const int count = juce::jmin(257, length - first); block.setSize(2, count, false, false, true); block.clear();
                if (first == 0) { block.setSample(0, 0, .01f); block.setSample(1, 0, .01f); }
                eq->processBlock(block, midi); audio.copyFrom(0, first, block, 0, 0, count);
                for (int i = 0; i < count; ++i) finite = finite && std::isfinite(block.getSample(0, i));
            }
            std::vector<float> frequencies;
            for (float multiplier : {.25f, .5f, .8f, 1.0f, 1.2f, 2.0f})
                if (cutoff * multiplier < rate * .45) frequencies.push_back(cutoff * multiplier);
            const auto graph = eq->getMagnitudeResponse(frequencies); double rowMagnitude = 0, rowPhase = 0;
            for (size_t f = 0; f < frequencies.size(); ++f)
            {
                const double frequency = frequencies[f], omega = juce::MathConstants<double>::twoPi * frequency / rate;
                std::complex<double> measured{}, rotation{1, 0}; const auto step = std::polar(1.0, -omega);
                for (int i = 0; i < length; ++i) { measured += static_cast<double>(audio.getSample(0, i)) * rotation; rotation *= step; }
                measured *= std::polar(100.0, omega * 512);
                const std::complex<double> s{0, frequency / cutoff}; const double a = std::pow(10.0, gain / 40.0);
                std::complex<double> expected;
                if (shape == 0) expected = (s * s + s * (a / q) + 1.0) / (s * s + s / (a * q) + 1.0);
                else if (shape == 1) expected = a * (s * s + s * (std::sqrt(a) / q) + a) / (a * s * s + s * (std::sqrt(a) / q) + 1.0);
                else if (shape == 2) expected = a * (a * s * s + s * (std::sqrt(a) / q) + 1.0) / (s * s + s * (std::sqrt(a) / q) + a);
                else if (shape == 3) expected = s * s / (s * s + std::sqrt(2.0) * s + 1.0);
                else if (shape == 4) expected = 1.0 / (s * s + std::sqrt(2.0) * s + 1.0);
                else if (shape == 5) expected = (s * s + 1.0) / (s * s + s / static_cast<double>(q) + 1.0);
                else if (shape == 6) expected = (s / static_cast<double>(q)) / (s * s + s / static_cast<double>(q) + 1.0);
                else expected = (s * s - s / static_cast<double>(q) + 1.0) / (s * s + s / static_cast<double>(q) + 1.0);
                if (std::abs(expected) < .001 || std::abs(measured) < .001) continue;
                const double db = 20 * std::log10(std::abs(measured));
                rowMagnitude = juce::jmax(rowMagnitude, std::abs(db - 20 * std::log10(std::abs(expected))));
                rowPhase = juce::jmax(rowPhase, std::abs(std::arg(measured / expected)));
                graphError = juce::jmax(graphError, std::abs(db - graph[f]));
            }
            magnitudeError = juce::jmax(magnitudeError, rowMagnitude); phaseError = juce::jmax(phaseError, rowPhase);
            auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("shape", shape); row->setProperty("cutoff", cutoff);
            row->setProperty("q", q); row->setProperty("gain", gain); row->setProperty("magnitudeErrorDb", rowMagnitude); row->setProperty("phaseErrorRadians", rowPhase); cases.add(row);
        }
    auto source = std::make_unique<OpenStudioEQ>(true), restored = std::make_unique<OpenStudioEQ>(true);
    source->setMinimumPhaseFIR(1); source->setAnalogResponse(1); juce::MemoryBlock state, again;
    source->getStateInformation(state); restored->setStateInformation(state.getData(), static_cast<int>(state.getSize())); restored->getStateInformation(again);
    recall = state == again && restored->getLatencySamples() == 512 && restored->analogResponse.load() == 1;
    auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize()); tree.removeProperty("analogResponse", nullptr);
    juce::MemoryBlock old; juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream);
    restored->setStateInformation(old.getData(), static_cast<int>(old.getSize())); recall = recall && restored->analogResponse.load() == 0 && restored->getLatencySamples() == 256;
    result->setProperty("pass", finite && latency && recall && magnitudeError < .15 && phaseError < .02 && graphError < .05);
    result->setProperty("finite", finite); result->setProperty("latency512", latency); result->setProperty("stateAndDefaults", recall);
    result->setProperty("prototypeMagnitudeErrorDb", magnitudeError); result->setProperty("prototypePhaseErrorRadians", phaseError); result->setProperty("graphErrorDb", graphError);
    result->setProperty("cases", cases); result->setProperty("schema", describeFreePluginForRegression(*source));
    result->setProperty("scope", "Eight analog prototypes, interior frequency band below 0.45 sample rate; finite-kernel and Nyquist limits remain explicit.");
    result->setProperty("audioQuality", "not_asserted"); result->setProperty("proprietaryNaturalPhaseEquivalence", "not_asserted"); return result;
}
