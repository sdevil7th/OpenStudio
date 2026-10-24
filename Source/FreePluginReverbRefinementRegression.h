#pragma once

inline juce::var checkReverbRefinementState()
{
    auto source = std::make_unique<OpenStudioReverb>(true);
    auto restored = std::make_unique<OpenStudioReverb>(true);
    const bool defaultOriginal = source->reverbCharacterMode.load() == 0;
    bool roundTrip = setFreePluginParamForRegression(*source, "reverbCharacterMode", 1);
    juce::MemoryBlock saved, repeated;
    source->getStateInformation(saved);
    restored->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    restored->getStateInformation(repeated);
    roundTrip = roundTrip && saved == repeated && restored->reverbCharacterMode.load() == 1;
    restored->selectAlgorithm(19); restored->selectSendMode(true);
    const bool global = restored->reverbCharacterMode.load() == 1;
    auto old = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
    old.removeProperty("reverbCharacterMode", nullptr);
    juce::MemoryBlock oldBytes;
    { juce::MemoryOutputStream stream(oldBytes, false); old.writeToStream(stream); }
    restored->setStateInformation(oldBytes.getData(), static_cast<int>(oldBytes.getSize()));
    const bool migration = restored->reverbCharacterMode.load() == 0;
    bool range = setFreePluginParamForRegression(*source, "reverbCharacterMode", 20)
        && source->reverbCharacterMode.load() == 1
        && setFreePluginNormalizedForRegression(*source, "reverbCharacterMode", 0)
        && source->reverbCharacterMode.load() == 0;
    auto embedded = std::make_unique<OpenStudioReverb>();
    const bool embeddedUnchanged = !setFreePluginParamForRegression(*embedded, "reverbCharacterMode", 1)
        && !setFreePluginNormalizedForRegression(*embedded, "reverbCharacterMode", 1);
    const auto schema = describeFreePluginForRegression(*source);
    const auto params = schema["parameters"];
    const bool appended = params.size() == 1090 && params[1084]["id"].toString() == "outputTrimDb"
        && params[1085]["id"].toString() == "reverbCharacterMode" && static_cast<bool>(params[1085]["automatable"])
        && static_cast<float>(params[1085]["defaultValue"]) == 0;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Standalone Refined processing state and migration");
    result->setProperty("defaultOriginal", defaultOriginal); result->setProperty("portableRoundTrip", roundTrip);
    result->setProperty("globalAcrossTypeAndSend", global); result->setProperty("missingPropertyOriginal", migration);
    result->setProperty("rangeAndNormalized", range); result->setProperty("appendOnlyIndex1085", appended);
    result->setProperty("embeddedUnchanged", embeddedUnchanged);
    result->setProperty("pass", defaultOriginal && roundTrip && global && migration && range && appended && embeddedUnchanged);
    result->setProperty("audioQuality", "not_asserted");
    return result;
}

// Timings cover warmed whole wrappers with independent active stereo inputs.
// Scheduling, the host graph and hardware-device callbacks are not simulated.
inline juce::var profileReverbInstances()
{
    juce::Array<juce::var> rows;
    bool sane = true;
    for (const int type : {2, 5, 19, 24, 38})
        for (const int instances : {1, 4, 8})
            for (const int refined : {0, 1})
            {
                constexpr double rate = 48000;
                constexpr int frames = 128, observations = 256;
                std::vector<std::unique_ptr<OpenStudioReverb>> processors;
                std::vector<juce::AudioBuffer<float>> buffers;
                processors.reserve(static_cast<size_t>(instances)); buffers.reserve(static_cast<size_t>(instances));
                for (int index = 0; index < instances; ++index)
                {
                    auto processor = std::make_unique<OpenStudioReverb>(true);
                    processor->selectAlgorithm(type); processor->reverbCharacterMode.store(static_cast<float>(refined));
                    processor->wetLevel.store(1); processor->dryLevel.store(0);
                    processor->prepareToPlay(rate, frames);
                    buffers.emplace_back(2, frames); processors.push_back(std::move(processor));
                }
                juce::MidiBuffer midi;
                std::vector<double> times; times.reserve(observations);
                int overruns = 0;
                for (int iteration = -128; iteration < observations; ++iteration)
                {
                    for (int index = 0; index < instances; ++index)
                        for (int sample = 0; sample < frames; ++sample)
                        {
                            const float value = .04f * std::sin(.047f * static_cast<float>((iteration + 128) * frames + sample + index));
                            buffers[static_cast<size_t>(index)].setSample(0, sample, value);
                            buffers[static_cast<size_t>(index)].setSample(1, sample, value * .8f);
                        }
                    const auto start = juce::Time::getHighResolutionTicks();
                    for (int index = 0; index < instances; ++index)
                        processors[static_cast<size_t>(index)]->processBlock(buffers[static_cast<size_t>(index)], midi);
                    const double micros = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - start) * 1e6;
                    if (iteration >= 0) { times.push_back(micros); overruns += micros > frames / rate * 1e6 ? 1 : 0; }
                    for (const auto& buffer : buffers)
                        for (int channel = 0; channel < 2; ++channel)
                            for (int sample = 0; sample < frames; ++sample)
                                sane = std::isfinite(buffer.getSample(channel, sample)) && sane;
                }
                std::sort(times.begin(), times.end());
                auto* row = new juce::DynamicObject(); row->setProperty("type", type); row->setProperty("instances", instances);
                row->setProperty("refined", refined); row->setProperty("medianUs", times[times.size() / 2]);
                row->setProperty("returnLevel", "Calibrated");
                row->setProperty("p95Us", times[times.size() * 95 / 100]); row->setProperty("p99Us", times[times.size() * 99 / 100]);
                row->setProperty("maxUs", times.back()); row->setProperty("budgetUs", frames / rate * 1e6);
                row->setProperty("deadlineOverruns", overruns); rows.add(row);
            }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Standalone Reverb instance cost screen");
    result->setProperty("pass", sane); result->setProperty("finiteOutput", sane); result->setProperty("cases", rows);
    result->setProperty("sampleRate", 48000); result->setProperty("blockSize", 128);
    result->setProperty("cpu", juce::SystemStats::getCpuModel()); result->setProperty("timing", "diagnostic_only");
    result->setProperty("deviceDropouts", "not_asserted"); result->setProperty("audioQuality", "not_asserted");
    return result;
}
