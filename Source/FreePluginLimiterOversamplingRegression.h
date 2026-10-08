#pragma once

inline juce::var checkLimiterOversampling()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Limiter audio oversampling");
    bool finite = true, alignment = true, partition = true, ceiling = true, mono = true, state = true;
    juce::Array<juce::var> cases;
    const auto render = [](double rate, int quality, int blockSize, int channels, int stimulus, int& latency)
    {
        OpenStudioLimiter limiter(true); limiter.setQualityConfiguration(static_cast<float>(quality));
        limiter.threshold.store(stimulus == 0 ? 0.0f : -12.0f); limiter.ceiling.store(-1);
        limiter.continuousGain.store(stimulus == 0 ? 0.0f : 1.0f); limiter.truePeak.store(stimulus == 0 ? 0.0f : 1.0f);
        limiter.lookaheadMs.store(3); limiter.releaseMs.store(30);
        limiter.prepareToPlay(rate, blockSize); latency = limiter.getLatencySamples();
        const int length = latency + 4096 + 512;
        juce::AudioBuffer<float> output(channels, length), block(channels, blockSize); juce::MidiBuffer midi;
        for (int start = 0; start < length; start += blockSize)
        {
            const int count = juce::jmin(blockSize, length - start); block.setSize(channels, count, false, false, true);
            for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < count; ++i)
            {
                const int sample = start + i; float value = 0;
                if (stimulus == 0) value = sample == 100 ? .1f : 0;
                else if (sample < 4096)
                {
                    const double phase = juce::MathConstants<double>::twoPi * sample;
                    if (stimulus == 1) value = static_cast<float>(2 * std::sin(phase * .45 + .37));
                    if (stimulus == 2) value = sample % 137 == 0 ? 3.0f : 0;
                    if (stimulus == 3) value = static_cast<float>(std::sin(phase * .031) + std::sin(phase * .21) + .7 * std::sin(phase * .39));
                }
                block.setSample(ch, i, value * (ch == 0 ? 1.0f : -.73f));
            }
            limiter.processBlock(block, midi);
            for (int ch = 0; ch < channels; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
        }
        return output;
    };
    const auto difference = [](const auto& a, const auto& b)
    {
        double value = 0;
        for (int ch = 0; ch < a.getNumChannels(); ++ch)
            for (int i = 0; i < a.getNumSamples(); ++i)
                value = juce::jmax(value, std::abs(static_cast<double>(a.getSample(ch, i) - b.getSample(ch, i))));
        return value;
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (int quality = 0; quality <= 5; ++quality)
    {
        if (rate != 48000 && quality != 2) continue;
        int latency = 0, otherLatency = 0;
        const auto impulse = render(rate, quality, 127, 2, 0, latency);
        int peakIndex = 0; double sum = 0;
        for (int i = 0; i < impulse.getNumSamples(); ++i)
        {
            if (std::abs(impulse.getSample(0, i)) > std::abs(impulse.getSample(0, peakIndex))) peakIndex = i;
            sum += impulse.getSample(0, i);
        }
        alignment = alignment && peakIndex == latency + 100 && std::abs(sum - .1) < .0001
            && (quality == 0 ? latency == static_cast<int>(std::ceil(rate * .020)) : latency > static_cast<int>(std::ceil(rate * .020)) + 64);
        double worstDb = -100, partitionError = 0;
        for (int stimulus = 1; stimulus <= 3; ++stimulus)
        {
            const auto audio = render(rate, quality, 127, 2, stimulus, latency);
            const auto other = render(rate, quality, 512, 2, stimulus, otherLatency);
            partitionError = juce::jmax(partitionError, difference(audio, other));
            juce::dsp::Oversampling<float> measurement(2, 4, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, true);
            measurement.initProcessing(static_cast<size_t>(audio.getNumSamples()));
            const auto measured = measurement.processSamplesUp(juce::dsp::AudioBlock<const float>(audio));
            double peak = 0;
            for (size_t ch = 0; ch < measured.getNumChannels(); ++ch) for (size_t i = 0; i < measured.getNumSamples(); ++i)
            {
                const float sample = measured.getSample(static_cast<int>(ch), static_cast<int>(i));
                finite = finite && std::isfinite(sample); peak = juce::jmax(peak, std::abs(static_cast<double>(sample)));
            }
            worstDb = juce::jmax(worstDb, juce::Decibels::gainToDecibels(peak, -100.0));
            const auto single = render(rate, quality, 127, 1, stimulus, otherLatency);
            for (int i = 0; i < single.getNumSamples(); ++i) mono = mono && std::abs(single.getSample(0, i) - audio.getSample(0, i)) < 1e-6f;
        }
        partition = partition && partitionError < 1e-6; ceiling = ceiling && worstDb <= -.99;
        auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("factor", 1 << quality);
        row->setProperty("latency", latency); row->setProperty("impulsePeakIndex", peakIndex); row->setProperty("impulseSum", sum);
        row->setProperty("partitionError", partitionError); row->setProperty("measuredDbTP", worstDb); cases.add(row);
    }
    OpenStudioLimiter source(true), copy(true), embedded(false);
    source.prepareToPlay(48000, 127); source.setQualityConfiguration(3); const int highLatency = source.getLatencySamples();
    juce::MemoryBlock saved, again; source.getStateInformation(saved); copy.prepareToPlay(48000, 127);
    copy.setStateInformation(saved.getData(), static_cast<int>(saved.getSize())); copy.getStateInformation(again);
    state = state && saved == again && copy.oversampleQuality.load() == 3 && copy.getLatencySamples() == highLatency;
    auto tree = juce::ValueTree::readFromData(saved.getData(), saved.getSize()); tree.removeProperty("oversampleQuality", nullptr);
    juce::MemoryBlock legacy; juce::MemoryOutputStream stream(legacy, false); tree.writeToStream(stream);
    copy.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    state = state && copy.oversampleQuality.load() == 0 && copy.getLatencySamples() == 960 && !embedded.setQualityConfiguration(2)
        && !copy.setQualityConfiguration(std::numeric_limits<float>::quiet_NaN());
    const auto schema = describeFreePluginForRegression(source);
    const bool appended = schema["parameters"].size() >= 14 && schema["parameters"][13]["id"].toString() == "oversampleQuality"
        && !static_cast<bool>(schema["parameters"][13]["automatable"]);
    result->setProperty("pass", finite && alignment && partition && ceiling && mono && state && appended);
    result->setProperty("finite", finite); result->setProperty("reportedDelay", alignment); result->setProperty("partition", partition);
    result->setProperty("independent16xOutputCeiling", ceiling); result->setProperty("mono", mono); result->setProperty("stateAndLegacy", state);
    result->setProperty("appendedConfiguration", appended); result->setProperty("cases", cases); result->setProperty("schema", schema);
    result->setProperty("aliasingAndAudibleQuality", "not_asserted"); result->setProperty("arbitraryInputPeakProof", "not_asserted");
    return result;
}
