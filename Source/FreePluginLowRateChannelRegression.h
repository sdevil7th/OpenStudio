#pragma once

inline juce::var checkLowRateChannelSafety()
{
    bool passed = true;
    juce::Array<juce::var> cases;
    constexpr int blockSize = 127;
    for (const double sampleRate : { 8000.0, 44100.0, 96000.0 })
        for (const int channels : { 1, 2 })
            for (const int quality : { 0, 1, 2 })
            {
                OpenStudioSaturator processor;
                auto layout = processor.getBusesLayout();
                const auto channelSet = channels == 1
                    ? juce::AudioChannelSet::mono()
                    : juce::AudioChannelSet::stereo();
                layout.inputBuses.set(0, channelSet);
                layout.outputBuses.set(0, channelSet);
                bool ok = processor.setBusesLayout(layout);
                processor.mix.store(0.0f);
                processor.setOversamplingMode(static_cast<float>(quality));
                processor.setRateAndBufferSizeDetails(sampleRate, blockSize);
                processor.prepareToPlay(sampleRate, blockSize);
                const int latency = processor.getLatencySamples();
                const int length = latency + blockSize * 2;
                juce::AudioBuffer<float> buffer(channels, blockSize);
                juce::MidiBuffer midi;
                double maximumError = 0.0;
                for (int offset = 0; offset < length; offset += blockSize)
                {
                    const int count = juce::jmin(blockSize, length - offset);
                    buffer.setSize(channels, count, false, false, true);
                    buffer.clear();
                    if (offset == 0)
                        for (int channel = 0; channel < channels; ++channel)
                            buffer.setSample(channel, 0, channel == 0 ? 0.25f : -0.125f);
                    processor.processBlock(buffer, midi);
                    for (int channel = 0; channel < channels; ++channel)
                        for (int sample = 0; sample < count; ++sample)
                        {
                            const float expected = offset + sample == latency
                                ? (channel == 0 ? 0.25f : -0.125f) : 0.0f;
                            const float actual = buffer.getSample(channel, sample);
                            ok = ok && std::isfinite(actual);
                            maximumError = juce::jmax(maximumError,
                                std::abs(static_cast<double>(actual - expected)));
                        }
                }
                ok = ok && maximumError < 1.0e-7;
                passed = passed && ok;
                auto* row = new juce::DynamicObject();
                row->setProperty("processor", "Saturator");
                row->setProperty("sampleRate", sampleRate);
                row->setProperty("channels", channels);
                row->setProperty("quality", quality);
                row->setProperty("latencySamples", latency);
                row->setProperty("dryImpulseError", maximumError);
                row->setProperty("pass", ok);
                cases.add(juce::var(row));
            }

    for (const double sampleRate : { 8000.0, 11025.0, 22050.0 })
        for (const int channels : { 1, 2 })
            for (const bool maximumCutoffs : { false, true })
            {
                OpenStudioGate processor(true);
                auto layout = processor.getBusesLayout();
                const auto channelSet = channels == 1
                    ? juce::AudioChannelSet::mono()
                    : juce::AudioChannelSet::stereo();
                layout.inputBuses.set(0, channelSet);
                layout.outputBuses.set(0, channelSet);
                bool ok = processor.setBusesLayout(layout);
                processor.sidechainHPF.store(maximumCutoffs ? 2000.0f : 20.0f);
                processor.sidechainLPF.store(maximumCutoffs ? 20000.0f : 200.0f);
                processor.setRateAndBufferSizeDetails(sampleRate, blockSize);
                processor.prepareToPlay(sampleRate, blockSize);
                juce::AudioBuffer<float> buffer(channels, blockSize);
                juce::MidiBuffer midi;
                for (int block = 0; block < 12; ++block)
                {
                    if (block == 6)
                    {
                        processor.sidechainHPF.store(maximumCutoffs ? 20.0f : 2000.0f);
                        processor.sidechainLPF.store(maximumCutoffs ? 200.0f : 20000.0f);
                    }
                    for (int channel = 0; channel < channels; ++channel)
                        for (int sample = 0; sample < blockSize; ++sample)
                            buffer.setSample(channel, sample, static_cast<float>(
                                0.2 * std::sin((block * blockSize + sample) * 0.071 + channel * 0.31)));
                    processor.processBlock(buffer, midi);
                    for (int channel = 0; channel < channels; ++channel)
                        for (int sample = 0; sample < blockSize; ++sample)
                            ok = ok && std::isfinite(buffer.getSample(channel, sample))
                                && std::abs(buffer.getSample(channel, sample)) < 1.0f;
                }
                processor.reset();
                processor.releaseResources();
                passed = passed && ok;
                auto* row = new juce::DynamicObject();
                row->setProperty("processor", "Gate");
                row->setProperty("sampleRate", sampleRate);
                row->setProperty("channels", channels);
                row->setProperty("startsAtMaximumCutoffs", maximumCutoffs);
                row->setProperty("pass", ok);
                cases.add(juce::var(row));
            }
    for (const int channels : { 1, 2 })
        for (const int factor : { 2, 4, 8 })
        {
            auto processor = std::make_unique<OpenStudioNAMRack>();
            auto layout = processor->getBusesLayout();
            const auto channelSet = channels == 1
                ? juce::AudioChannelSet::mono()
                : juce::AudioChannelSet::stereo();
            layout.inputBuses.set(0, channelSet);
            layout.outputBuses.set(0, channelSet);
            bool ok = processor->setBusesLayout(layout);
            processor->setEmbeddedDriveOversamplingFactor(factor);
            processor->precisionDriveEnabled.store(1.0f);
            processor->chaosEnabled.store(1.0f);
            processor->chaosMix.store(1.0f);
            processor->chaosMode.store(1.0f);
            processor->chaosDrive.store(0.75f);
            processor->chaosTone.store(0.55f);
            processor->chaosWeight.store(0.50f);
            processor->prepareToPlay(48000.0, blockSize);
            juce::AudioBuffer<float> buffer(channels, blockSize);
            juce::MidiBuffer midi;
            for (int block = 0; block < 24; ++block)
            {
                for (int channel = 0; channel < channels; ++channel)
                    for (int sample = 0; sample < blockSize; ++sample)
                        buffer.setSample(channel, sample, static_cast<float>(
                            (block < 12 ? 0.2 : 1.0e-7)
                                * std::sin((block * blockSize + sample) * 0.071 + channel * 0.31)));
                processor->processBlock(buffer, midi);
                for (int channel = 0; channel < channels; ++channel)
                    for (int sample = 0; sample < blockSize; ++sample)
                        ok = ok && std::isfinite(buffer.getSample(channel, sample))
                            && std::abs(buffer.getSample(channel, sample)) < 64.0f;
            }
            passed = passed && ok;
            auto* row = new juce::DynamicObject();
            row->setProperty("processor", "NAM Rack");
            row->setProperty("channels", channels);
            row->setProperty("driveOversamplingFactor", factor);
            row->setProperty("pass", ok);
            cases.add(juce::var(row));
        }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Low sample rate and negotiated channel safety");
    result->setProperty("pass", passed);
    result->setProperty("cases", cases);
    result->setProperty("scope", "Negotiated mono/stereo Saturator dry impulse follows reported latency in each oversampling mode; low-rate Gate prepares and changes detector cutoff extrema and negotiated mono/stereo NAM Rack processes its shared drive island with finite bounded output. JUCE diagnostics must also remain clear.");
    result->setProperty("audioQuality", "not_asserted");
    return juce::var(result);
}
