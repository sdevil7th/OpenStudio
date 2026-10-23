#pragma once

// Offline evidence only; never invoked by the real-time plugin path.
inline juce::var auditChorusSignalContracts()
{
    const auto folder = juce::File::getCurrentWorkingDirectory().getChildFile(juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_OUTPUT", "output/free-plugin-audit")).getChildFile("modulation");
    juce::Array<juce::var> cases;
    bool finite = true;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int mode : {0, 1, 2}) for (float feedback : {0.0f, .9f})
        {
            OpenStudioChorus p;
            p.mode.store(static_cast<float>(mode)); p.fbAmount.store(feedback);
            p.mix.store(1); p.depth.store(0); p.voices.store(2);
            p.prepareToPlay(rate, 127);
            const double declared = p.getTailLengthSeconds();
            const int impulse = 1024, length = impulse + juce::roundToInt((declared + .5) * rate);
            juce::AudioBuffer<float> captured(2, length), block(2, 127);
            juce::MidiBuffer midi;
            double latePeak = 0, lateEnergy = 0;
            int lateCount = 0, lastAbove = 0;
            for (int start = 0; start < length; start += 127)
            {
                const int count = juce::jmin(127, length - start);
                block.setSize(2, count, false, false, true); block.clear();
                if (impulse >= start && impulse < start + count)
                    for (int ch = 0; ch < 2; ++ch) block.setSample(ch, impulse - start, .5f);
                p.processBlock(block, midi);
                for (int ch = 0; ch < 2; ++ch) captured.copyFrom(ch, start, block, ch, 0, count);
                for (int i = 0; i < count; ++i)
                {
                    const double value = block.getSample(0, i);
                    finite = finite && std::isfinite(value);
                    if (std::abs(value) > .0001) lastAbove = start + i;
                    if (start + i > impulse + juce::roundToInt(declared * rate))
                    { latePeak = juce::jmax(latePeak, std::abs(value)); lateEnergy += value * value; ++lateCount; }
                }
            }
            auto* row = new juce::DynamicObject();
            row->setProperty("rate", rate); row->setProperty("mode", mode); row->setProperty("feedback", feedback);
            row->setProperty("declaredTailSeconds", declared); row->setProperty("latePeak", latePeak);
            row->setProperty("lateRms", std::sqrt(lateEnergy / juce::jmax(1, lateCount)));
            row->setProperty("lastAboveMinus80DbSeconds", (lastAbove - impulse) / rate);
            row->setProperty("tailContract", latePeak < .0001 ? "pass" : "fail");
            cases.add(row);
            if (rate == 48000 && feedback > .5f)
                finite = writeProbeWave(folder.getChildFile("tail-mode-" + juce::String(mode) + ".wav"), captured, rate) && finite;
        }
    juce::Array<juce::var> motion;
    for (int character : {0, 1})
    {
        constexpr double rate = 48000;
        OpenStudioChorus p; p.characterMode.store(static_cast<float>(character));
        p.rate.store(4); p.depth.store(1); p.mix.store(1); p.voices.store(4); p.spread.store(0);
        p.prepareToPlay(rate, 127);
        juce::AudioBuffer<float> captured(2, 192000), block(2, 127); juce::MidiBuffer midi;
        double maxStep = 0; float previous = 0;
        for (int start = 0; start < captured.getNumSamples(); start += 127)
        {
            const int count = juce::jmin(127, captured.getNumSamples() - start);
            block.setSize(2, count, false, false, true);
            for (int i = 0; i < count; ++i) for (int ch = 0; ch < 2; ++ch)
                block.setSample(ch, i, .25f * static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * 220 * (start + i) / rate)));
            p.processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch) captured.copyFrom(ch, start, block, ch, 0, count);
            for (int i = 0; i < count; ++i)
            {
                const float value = block.getSample(0, i); finite = finite && std::isfinite(value);
                if (start + i > 4800) maxStep = juce::jmax(maxStep, std::abs(static_cast<double>(value - previous)));
                previous = value;
            }
        }
        const auto file = folder.getChildFile("motion-character-" + juce::String(character) + ".wav");
        finite = writeProbeWave(file, captured, rate) && finite;
        auto* row = new juce::DynamicObject(); row->setProperty("character", character);
        row->setProperty("maximumAdjacentStep", maxStep); row->setProperty("file", file.getFullPathName());
        row->setProperty("status", "diagnostic_only"); motion.add(row);
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Chorus audit evidence capture");
    result->setProperty("pass", finite); result->setProperty("tailCases", cases); result->setProperty("motion", motion);
    result->setProperty("scope", "Capture sanity only; inspect tailContract separately. Ensemble phase reset is source-backed; step size is diagnostic_only.");
    return result;
}

inline juce::var renderOtherPluginsSharedGuitar()
{
    const auto root = juce::File::getCurrentWorkingDirectory();
    const auto source = root.getChildFile("output/reverb-shimmer-performance/shared-guitar/native/baseline-nam-only.wav");
    const auto directory = root.getChildFile(juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_OUTPUT", "output/free-plugin-audit")).getChildFile("guitar");
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Other free effects on saved guitar project baseline");
    result->setProperty("source", source.getFullPathName());
    juce::WavAudioFormat format;
    std::unique_ptr<juce::AudioFormatReader> reader(format.createReaderFor(source.createInputStream().release(), true));
    if (!reader) { result->setProperty("pass", false); result->setProperty("error", "Missing previously audited NAM-only guitar source"); return result; }
    const double rate = reader->sampleRate;
    const int length = static_cast<int>(reader->lengthInSamples);
    juce::AudioBuffer<float> input(2, length);
    bool valid = reader->read(&input, 0, length, 0, true, true);
    valid = writeProbeWave(directory.getChildFile("00-source-nam-only.wav"), input, rate) && valid;
    juce::Array<juce::var> cases;
    for (const auto& entry : freeSuiteFactories())
    {
        const juce::String name = entry.first;
        if (name == "Reverb" || name == "Synth" || name == "Piano" || name == "Guitar" || name == "Drums") continue;
        for (int variant : {0, 1})
        {
            auto p = entry.second();
            if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_LEGACY", "") == "1")
            {
                const auto schema = describeFreePluginForRegression(*p);
                if (const auto* params = schema["parameters"].getArray()) for (const auto& param : *params)
                    if (param["id"].toString() == "signalPath") valid = setFreePluginParamForRegression(*p,"signalPath",0) && valid;
            }
            const auto set = [&] (const char* id, float value) { valid = setFreePluginParamForRegression(*p, id, value) && valid; };
            if (variant == 1)
            {
                if (name == "EQ") { set("band0.enabled", 1); set("band0.type", 0); set("band0.freq", 1000); set("band0.gain", 6); set("band0.q", 1); }
                else if (name == "Graphic EQ") { set("geq5", 6); }
                else if (name == "Compressor") { set("threshold", -24); set("ratio", 4); set("attack", 5); set("release", 100); set("autoMakeup", 0); }
                else if (name == "Gate") { set("threshold", -24); set("range", -60); }
                else if (name == "Limiter") { set("threshold", -12); set("ceiling", -1); }
                else if (name == "Preamp") { set("drive", 12); set("outputGain", -6); }
                else if (name == "Saturator") { set("drive", 12); set("mix", .5f); }
                else if (name == "Delay") { set("delayTimeL", 250); set("delayTimeR", 375); set("feedback", .45f); set("mix", .5f); }
                else if (name == "Chorus") { set("characterMode", 1); set("rate", 1.5f); set("depth", .8f); set("mix", .5f); }
                else if (name == "Gain Phase") { set("delayR", 24); set("gain", -3); }
                else if (name == "Pitch Correct") { set("transpose", 12); set("mix", 1); }
            }
            constexpr int blockSize = 512;
            p->setRateAndBufferSizeDetails(rate, blockSize); p->prepareToPlay(rate, blockSize);
            const int latency = p->getLatencySamples();
            juce::AudioBuffer<float> output(2, length), block(2, blockSize);
            juce::MidiBuffer midi;
            double peak = 0, energy = 0, difference = 0; int overUnity = 0;
            for (int start = 0; start < length + latency; start += blockSize)
            {
                const int count = juce::jmin(blockSize, length + latency - start);
                block.setSize(2, count, false, false, true); block.clear();
                if (start < length) for (int ch = 0; ch < 2; ++ch)
                    block.copyFrom(ch, 0, input, ch, start, juce::jmin(count, length - start));
                p->processBlock(block, midi);
                for (int i = 0; i < count; ++i)
                {
                    const int position = start + i - latency;
                    if (position < 0 || position >= length) continue;
                    for (int ch = 0; ch < 2; ++ch)
                    {
                        const double value = block.getSample(ch, i); valid = valid && std::isfinite(value);
                        output.setSample(ch, position, static_cast<float>(value));
                        peak = juce::jmax(peak, std::abs(value)); if (std::abs(value) > 1) ++overUnity;
                        energy += value * value; const double delta = value - input.getSample(ch, position); difference += delta * delta;
                    }
                }
            }
            const juce::String stem = name.toLowerCase().replace(" ", "-") + (variant == 0 ? "-default" : "-probe");
            const auto file = directory.getChildFile(stem + ".wav");
            valid = writeProbeWave(file, output, rate) && valid;
            juce::MemoryBlock state; p->getStateInformation(state);
            valid = directory.getChildFile(stem + ".state").replaceWithData(state.getData(), state.getSize()) && valid;
            auto* row = new juce::DynamicObject(); row->setProperty("name", entry.first); row->setProperty("variant", variant);
            row->setProperty("file", file.getFullPathName()); row->setProperty("rate", rate); row->setProperty("samples", length);
            row->setProperty("latencyTrimmed", latency); row->setProperty("peak", peak); row->setProperty("samplesAboveUnity", overUnity);
            row->setProperty("rms", std::sqrt(energy / (2.0 * length))); row->setProperty("differenceRms", std::sqrt(difference / (2.0 * length)));
            row->setProperty("settings", describeFreePluginForRegression(*p)); row->setProperty("status", "diagnostic_only"); cases.add(row);
        }
    }
    result->setProperty("cases", cases); result->setProperty("pass", valid && cases.size() == 22);
    result->setProperty("scope", "Raw unnormalised processor captures; source contains saved NAM processing and two quiet bars. Instruments excluded. Pitch on distorted guitar is a stress diagnostic, not a supported-source quality judgment.");
    return result;
}
