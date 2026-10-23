#pragma once

inline std::array<juce::AudioBuffer<float>, 3> makeReverbListeningSources()
{
    constexpr int rate = 48000, length = rate * 8;
    std::array<juce::AudioBuffer<float>, 3> sources;
    for (auto& source : sources) { source.setSize(2, length); source.clear(); }
    uint32_t random = 0x97abc012u;
    for (int sample = 0; sample < rate * 3; ++sample)
    {
        const double time = static_cast<double>(sample) / rate;
        const int hitSample = sample % (rate / 2);
        random = random * 1664525u + 1013904223u;
        const float noise = static_cast<float>(random >> 8) / 8388608.0f - 1;
        const float percussion = .16f * noise * std::exp(-static_cast<float>(hitSample) / 500)
            + .16f * static_cast<float>(std::sin(6.283185307179586 * 90 * time)) * std::exp(-static_cast<float>(hitSample) / 1800);
        const double gate = std::sin(juce::MathConstants<double>::pi * juce::jlimit(0.0, 1.0, time / 3));
        float vowel = 0;
        for (int harmonic = 1; harmonic <= 20; ++harmonic)
        {
            const double frequency = harmonic * 145.0;
            const double envelope = .15 + std::exp(-std::pow((frequency - 700) / 200, 2.0))
                + .7 * std::exp(-std::pow((frequency - 1200) / 240, 2.0));
            vowel += static_cast<float>(.07 * envelope / harmonic * gate
                * std::sin(6.283185307179586 * frequency * time + .018 * harmonic * std::sin(6.283185307179586 * 5 * time)));
        }
        for (int channel = 0; channel < 2; ++channel)
        {
            sources[0].setSample(channel, sample, percussion * (channel == 0 ? 1.0f : .83f));
            sources[1].setSample(channel, sample, vowel);
            const double phase = channel * .19;
            const float chord = static_cast<float>(.07 * gate * (std::sin(6.283185307179586 * 220 * time + phase)
                + .6 * std::sin(6.283185307179586 * 277.1826 * time - phase)
                + .4 * std::sin(6.283185307179586 * 329.6276 * time + phase)));
            sources[2].setSample(channel, sample, chord);
        }
    }
    return sources;
}

inline juce::var renderReverbListeningPack()
{
    constexpr int rate = 48000, frames = 128, length = rate * 8;
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-listening/raw");
    bool sane = directory.createDirectory().wasOk();
    juce::Array<juce::var> rows;
    const std::array<const char*, 3> materials {"percussion", "synthetic-vowel", "sustained-chord"};
    const auto sources = makeReverbListeningSources();
    for (size_t material = 0; material < sources.size(); ++material)
        sane = writeProbeWave(directory.getChildFile(juce::String("source-") + materials[material] + ".wav"), sources[material], rate) && sane;

    const auto render = [&] (int type, const juce::String& voiceName, int refined, bool stationary)
    {
        for (size_t material = 0; material < materials.size(); ++material)
        {
            auto processor = std::make_unique<OpenStudioReverb>(true);
            if (voiceName.isNotEmpty())
            {
                juce::MemoryBlock state;
                sane = OpenStudioReverbFactoryPresets::buildState(voiceName, state) && sane;
                processor->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            }
            else { processor->selectAlgorithm(type); processor->reverbCharacterMode.store(static_cast<float>(refined)); processor->reverbReturnMode.store(0); }
            if (stationary)
            {
                if (type == 2) processor->plateModulation.store(0);
                if (type == 19) processor->ambientControls[2][4].store(0);
                if (type >= 21 && type <= 23) { processor->driftingControls[static_cast<size_t>(type - 21)][1].store(0); processor->driftingControls[static_cast<size_t>(type - 21)][2].store(0); }
                if (type >= 24 && type <= 26) processor->clearControls[static_cast<size_t>(type - 24)][2].store(0);
                if (type >= 27) processor->retroControls[static_cast<size_t>(type - 27)][3].store(0);
            }
            processor->wetLevel.store(1); processor->dryLevel.store(0); processor->sendMode.store(1);
            processor->outputTrimDb.store(0);
            processor->prepareToPlay(rate, frames);
            const int channels = juce::jmax(2, processor->getTotalNumOutputChannels());
            juce::AudioBuffer<float> block(channels, frames), output(2, length);
            juce::MidiBuffer midi;
            for (int start = 0; start < rate / 10; start += frames) { block.clear(); processor->processBlock(block, midi); }
            double energy = 0, peak = 0; bool finite = true;
            for (int start = 0; start < length; start += frames)
            {
                block.clear();
                for (int channel = 0; channel < 2; ++channel) block.copyFrom(channel, 0, sources[material], channel, start, frames);
                processor->processBlock(block, midi);
                for (int channel = 0; channel < 2; ++channel)
                {
                    output.copyFrom(channel, start, block, channel, 0, frames);
                    for (int sample = 0; sample < frames; ++sample)
                    {
                        const double value = block.getSample(channel, sample);
                        finite = std::isfinite(value) && finite; energy += value * value; peak = juce::jmax(peak, std::abs(value));
                    }
                }
            }
            const juce::String label = voiceName.isNotEmpty() ? voiceName.replace("Factory - ", "Factory-").replaceCharacter(' ', '-')
                : juce::String("type-") + juce::String(type).paddedLeft('0', 2) + (stationary ? "-Motion-off" : "") + (refined ? "-Refined" : "-Original");
            const auto file = label + "-" + materials[material] + ".wav";
            const bool written = writeProbeWave(directory.getChildFile(file), output, rate);
            juce::MemoryBlock state; processor->getStateInformation(state);
            const bool stateWritten = directory.getChildFile(label + ".state").replaceWithData(state.getData(), state.getSize());
            auto* row = new juce::DynamicObject(); row->setProperty("label", label); row->setProperty("type", type);
            row->setProperty("material", materials[material]); row->setProperty("file", file);
            row->setProperty("characterMode", processor->reverbCharacterMode.load()); row->setProperty("fileWritten", written);
            row->setProperty("returnMode", processor->reverbReturnMode.load());
            row->setProperty("finiteNonzero", finite && energy > 0); row->setProperty("rms", std::sqrt(energy / (2 * length)));
            row->setProperty("peak", peak); rows.add(row);
            sane = written && stateWritten && finite && energy > 0 && sane;
        }
    };
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type) render(type, {}, 0, false);
    for (const int type : {2, 19, 21, 24, 28, 38})
        for (const int refined : {0, 1}) render(type, {}, refined, true);
    for (const auto& voice : OpenStudioReverbFactoryPresets::voices) render(voice.type, voice.name, 0, false);
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Standalone Reverb listening pack");
    result->setProperty("pass", sane); result->setProperty("cases", rows); result->setProperty("directory", directory.getFullPathName());
    result->setProperty("sampleRate", rate); result->setProperty("seconds", 8); result->setProperty("excitationSeconds", 3);
    result->setProperty("input", "Deterministic generated percussion, harmonic synthetic vowel and sustained chord; no recorded voice");
    result->setProperty("mix", "wet=1, dry=0, output=0; factory wet/output overrides disabled for comparison");
    result->setProperty("audioQuality", "not_asserted"); result->setProperty("tailCompleteness", "not_asserted");
    result->setProperty("levelMatching", "Run tools/prepare_reverb_listening.py; whole-file stereo RMS is diagnostic, not perceived loudness");
    return result;
}
