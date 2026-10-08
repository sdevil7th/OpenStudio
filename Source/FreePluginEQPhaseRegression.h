#pragma once

inline juce::var checkLinearPhaseEQ()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "EQ symmetric FIR phase modes and latency");
    bool finite = true, latencyPass = true, bypassPass = true, recall = true, routing = true;
    double symmetryError = 0, partitionError = 0, responseError = 0;
    juce::Array<juce::var> cases;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (int quality = 0; quality < 3; ++quality)
        {
            // All resolutions at 48 kHz; medium also at the other supported rates.
            if (rate != 48000 && quality != 1) continue;
            auto eq = std::make_unique<OpenStudioEQ>(true); eq->setNonRealtime(true);
            for (auto& band : eq->bands) band.enabled.store(0);
            eq->bands[1].enabled.store(1); eq->bands[1].freq.store(1000); eq->bands[1].gain.store(9); eq->bands[1].q.store(2);
            eq->setPhaseConfiguration(1, static_cast<float>(quality)); eq->prepareToPlay(rate, 512);
            const int delay = BuiltInLinearPhaseEQ::latency(quality), taps = BuiltInLinearPhaseEQ::tapCount(quality), length = taps + 768;
            latencyPass = latencyPass && eq->getLatencySamples() == delay && eq->getTailLengthSeconds() >= static_cast<double>(taps) / rate;
            const auto render = [&](int blockSize, float impulse)
            {
                eq->reset(); juce::AudioBuffer<float> output(2, length), block(2, blockSize); juce::MidiBuffer midi;
                for (int start = 0; start < length; start += blockSize)
                {
                    const int count = juce::jmin(blockSize, length - start); block.setSize(2, count, false, false, true); block.clear();
                    if (start == 0) { block.setSample(0, 0, impulse); block.setSample(1, 0, impulse); }
                    eq->processBlock(block, midi); for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
                }
                return output;
            };
            const auto a = render(127, .01f), b = render(512, .01f);
            for (int i = 0; i < length; ++i)
            {
                finite = finite && std::isfinite(a.getSample(0, i));
                partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(a.getSample(0, i) - b.getSample(0, i))));
            }
            for (int offset = 0; offset <= (taps - 1) / 2; ++offset)
                symmetryError = juce::jmax(symmetryError, std::abs(static_cast<double>(a.getSample(0, delay - offset) - a.getSample(0, delay + offset))));
            const std::vector<float> frequencies {80, 300, 1000, 3100, 12000}; const auto graph = eq->getMagnitudeResponse(frequencies);
            for (size_t i = 0; i < frequencies.size(); ++i)
            {
                const auto z = std::polar(1.0, -juce::MathConstants<double>::twoPi * frequencies[i] / rate);
                std::complex<double> phase = 1, response = 0;
                for (int sample = 0; sample < length; ++sample) { response += phase * static_cast<double>(a.getSample(0, sample)); phase *= z; }
                const double measured = juce::Decibels::gainToDecibels(std::abs(response) / .01, -100.0);
                responseError = juce::jmax(responseError, std::abs(measured - graph[i]));
            }
            eq->editorBypass.store(1); eq->prepareToPlay(rate, 512);
            const auto dry = render(127, 4.0f);
            for (int i = 0; i < length; ++i) bypassPass = bypassPass && dry.getSample(0, i) == (i == delay ? 4.0f : 0.0f);
            auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", rate); row->setProperty("quality", quality);
            row->setProperty("latencySamples", delay); row->setProperty("taps", taps); cases.add(row);
        }
    }
    // Per-band L/R/M/S are actual FIR matrix paths, including output gain on the
    // selected global component and the unchanged opposite component.
    for (int target : {1, 2, 3, 4})
    {
        auto eq = std::make_unique<OpenStudioEQ>(true); eq->setNonRealtime(true);
        for (auto& band : eq->bands) band.enabled.store(0);
        eq->bands[1].enabled.store(1); eq->bands[1].freq.store(1000); eq->bands[1].gain.store(9); eq->bands[1].target.store(static_cast<float>(target));
        eq->setPhaseConfiguration(1, 0); eq->prepareToPlay(48000, 512);
        juce::AudioBuffer<float> leftInput(2, 2048), rightInput(2, 2048), block(2, 512); juce::MidiBuffer midi;
        for (int input = 0; input < 2; ++input)
        {
            eq->reset();
            for (int start = 0; start < 2048; start += 512)
            {
                block.clear(); if (start == 0) block.setSample(input, 0, .01f); eq->processBlock(block, midi);
                for (int channel = 0; channel < 2; ++channel) (input == 0 ? leftInput : rightInput).copyFrom(channel, start, block, channel, 0, 512);
            }
        }
        for (int i = 0; i < 2048; ++i)
        {
            const float dry = i == 768 ? .01f : 0.0f;
            if (target == 1) routing = routing && std::abs(rightInput.getSample(1, i) - dry) < 1e-8f && leftInput.getSample(1, i) == 0;
            if (target == 2) routing = routing && std::abs(leftInput.getSample(0, i) - dry) < 1e-8f && rightInput.getSample(0, i) == 0;
            if (target >= 3) routing = routing && std::abs(leftInput.getSample(1, i) - rightInput.getSample(0, i)) < 1e-8f
                && std::abs(leftInput.getSample(0, i) - rightInput.getSample(1, i)) < 1e-8f;
            if (target == 3) routing = routing && std::abs(leftInput.getSample(0, i) - leftInput.getSample(1, i) - dry) < 1e-8f;
            if (target == 4) routing = routing && std::abs(leftInput.getSample(0, i) + leftInput.getSample(1, i) - dry) < 1e-8f;
        }
    }
    auto original = std::make_unique<OpenStudioEQ>(true), restored = std::make_unique<OpenStudioEQ>(true);
    original->setPhaseConfiguration(1, 2); original->bands[1].dynamicEnabled.store(1); original->bands[1].dynamicRange.store(-6);
    juce::MemoryBlock state, again; original->getStateInformation(state); restored->setStateInformation(state.getData(), static_cast<int>(state.getSize())); restored->getStateInformation(again);
    recall = recall && state == again && restored->getLatencySamples() == 8448 && restored->bands[1].dynamicRange.load() == -6;
    auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize()); tree.removeProperty("phaseMode", nullptr); tree.removeProperty("phaseQuality", nullptr);
    juce::MemoryBlock old; juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); restored->setStateInformation(old.getData(), static_cast<int>(old.getSize()));
    recall = recall && restored->phaseMode.load() == 0 && restored->phaseQuality.load() == 1 && restored->getLatencySamples() == 0;
    OpenStudioEQ embedded; recall = recall && !embedded.setPhaseConfiguration(1, 1) && embedded.getLatencySamples() == 0;
    // A live worker update must reuse the already sounding input history.
    // Constant gain isolates history continuity from intentional filter ringing.
    BuiltInLinearPhaseEQ live; BuiltInLinearPhaseEQ::Snapshot liveSnapshot;
    liveSnapshot.quality = 0; liveSnapshot.bands = 1;
    live.prepare(48000, liveSnapshot, false);
    for (int sample = 0; sample < 4096; ++sample) live.process(.1f, .1f);
    liveSnapshot.stages[0] = 1; liveSnapshot.coefficients[0][0] = {2,0,0,0,0}; live.request(liveSnapshot);
    bool livePass = true; float liveLast = 0;
    const auto liveDeadline = juce::Time::getMillisecondCounterHiRes() + 5000;
    int settledBlocks = 0;
    while (juce::Time::getMillisecondCounterHiRes() < liveDeadline && settledBlocks < 8)
    {
        for (int sample = 0; sample < 256; ++sample)
        {
            liveLast = live.process(.1f, .1f)[0];
            livePass = livePass && std::isfinite(liveLast) && liveLast >= .09999f && liveLast <= .20001f;
        }
        if (!live.updating()) ++settledBlocks;
        juce::Thread::sleep(1);
    }
    livePass = livePass && settledBlocks == 8 && std::abs(liveLast - .2f) < 1e-6f;
    live.release();
    const auto schema = describeFreePluginForRegression(*original); const auto* parameters = schema["parameters"].getArray();
    const bool appended = parameters && parameters->size() >= 296 && (*parameters)[293]["id"].toString() == "externalDetector"
        && (*parameters)[294]["id"].toString() == "phaseMode" && (*parameters)[295]["id"].toString() == "phaseQuality";
    result->setProperty("pass", finite && latencyPass && bypassPass && recall && routing && appended && livePass && symmetryError < 1e-7 && partitionError == 0 && responseError < .08);
    result->setProperty("liveWorkerSharedHistory", livePass);
    result->setProperty("finite", finite); result->setProperty("latencyAndTail", latencyPass); result->setProperty("delayedBypassParity", bypassPass);
    result->setProperty("stateAndLegacyMigration", recall); result->setProperty("matrixRouting", routing); result->setProperty("appendedDescriptors", appended);
    result->setProperty("symmetryError", symmetryError); result->setProperty("partitionError", partitionError); result->setProperty("responseErrorDb", responseError);
    result->setProperty("cases", cases); result->setProperty("schema", schema); result->setProperty("audioQuality", "not_asserted"); return result;
}
