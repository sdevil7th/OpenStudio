#pragma once

// Explicit research export. Measurements describe the current standalone
// processor; neither perceptual distinction nor acoustic fidelity is asserted.
inline juce::var auditStandaloneReverb(bool calibrated=false)
{
    constexpr double rate = 48000;
    constexpr int blockSize = 128, seconds = 5, length = seconds * 48000;
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile(calibrated?"output/reverb-calibrated-audit/responses":"output/reverb-audit/responses");
    bool sane = directory.createDirectory().wasOk();
    const std::array<const char*, 27> originalNames {
        "Room", "Hall", "Plate", "Chamber", "Spring", "Shimmer", "Nonlinear", "Convolution",
        "Church", "Ambience", "Vintage hall", "Vintage random", "Contour room", "Open hall", "Diffuse loop",
        "Magnetic heads", "Positioned room", "Rising space", "Bloom field", "Cloud field", "Vowel hall",
        "Drifting hall", "Drifting chamber", "Drifting diffuse", "Clear plate", "Clear room", "Clear random"
    };
    juce::Array<juce::var> cases;
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
    {
        auto processor = std::make_unique<OpenStudioReverb>(true);
        processor->reverbReturnMode.store(calibrated?1.0f:0.0f);
        processor->reverbControlMode.store(0); // Archived audit contract predates corrected control behavior.
        const bool selected = setFreePluginParamForRegression(*processor, "reverbTypeAll", static_cast<float>(type))
            && processor->algorithm.load() == static_cast<float>(type);
        const juce::String name = type < 27 ? originalNames[static_cast<size_t>(type)]
            : BuiltInRetroReverb::names[static_cast<size_t>(type - 27)];
        const auto schema = describeFreePluginForRegression(*processor);
        processor->wetLevel.store(1); processor->dryLevel.store(0); processor->sendMode.store(1);
        processor->setRateAndBufferSizeDetails(rate, blockSize);
        const auto prepareStart = juce::Time::getHighResolutionTicks();
        processor->prepareToPlay(rate, blockSize);
        const double prepareMs = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - prepareStart) * 1000;
        const int channels = juce::jmax(2, processor->getTotalNumOutputChannels());
        juce::AudioBuffer<float> block(channels, blockSize), output(2, length);
        juce::MidiBuffer midi;
        // Settle selection/mix ramps before the diagnostic excitation.
        for (int i = 0; i < 4800; i += blockSize) { block.clear(); processor->processBlock(block, midi); }
        double energy = 0, peak = 0;
        bool finite = true;
        for (int position = 0; position < length; position += blockSize)
        {
            const int count = juce::jmin(blockSize, length - position);
            block.setSize(channels, count, false, false, true); block.clear();
            if (position == 0) { block.setSample(0, 0, .25f); block.setSample(1, 0, .25f); }
            processor->processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch)
            {
                output.copyFrom(ch, position, block, ch, 0, count);
                for (int i = 0; i < count; ++i)
                {
                    const double value = block.getSample(ch, i);
                    finite = finite && std::isfinite(value); energy += value * value; peak = juce::jmax(peak, std::abs(value));
                }
            }
        }
        const auto filename = juce::String(type).paddedLeft('0', 2) + "-" + name.replaceCharacter(' ', '-') + ".wav";
        const bool written = writeProbeWave(directory.getChildFile(filename), output, rate);
        // CPU screen: warmed, active, editor closed. Timing includes the entire
        // standalone wrapper, not only an isolated engine. No deadline assertion.
        block.setSize(channels, blockSize, false, false, true);
        std::vector<double> times; times.reserve(512);
        int overruns = 0;
        for (int frame = -64; frame < 512; ++frame)
        {
            block.clear();
            for (int i = 0; i < blockSize; ++i)
            {
                const float value = .08f * std::sin(.0575959f * static_cast<float>((frame + 64) * blockSize + i));
                block.setSample(0, i, value); block.setSample(1, i, value * .8f);
            }
            const auto start = juce::Time::getHighResolutionTicks(); processor->processBlock(block, midi);
            const double micros = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - start) * 1e6;
            if (frame >= 0) { times.push_back(micros); if (micros > blockSize / rate * 1e6) ++overruns; }
        }
        std::sort(times.begin(), times.end());
        auto* row = new juce::DynamicObject();
        row->setProperty("type", type); row->setProperty("name", name); row->setProperty("selectorReadback", selected);
        row->setProperty("file", filename); row->setProperty("settingsBeforeWetOnlyOverride", schema);
        row->setProperty("finite", finite); row->setProperty("nonzero", energy > 0); row->setProperty("fileWritten", written);
        row->setProperty("impulseEnergy", energy); row->setProperty("peak", peak);
        row->setProperty("nominalTailSeconds", processor->getTailLengthSeconds()); row->setProperty("prepareMs", prepareMs);
        row->setProperty("medianUs", times[times.size() / 2]); row->setProperty("p95Us", times[times.size() * 95 / 100]);
        row->setProperty("p99Us", times[times.size() * 99 / 100]); row->setProperty("maxUs", times.back());
        row->setProperty("deadlineOverruns", overruns);
        cases.add(row); sane = selected && finite && energy > 0 && written && sane;
        processor->releaseResources();
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Standalone OpenStudio Reverb all-mode research audit");
    result->setProperty("pass", sane); result->setProperty("cases", cases); result->setProperty("sampleRate", rate);
    result->setProperty("blockSize", blockSize); result->setProperty("responseSeconds", seconds);
    result->setProperty("returnLevel", calibrated?"Calibrated":"Original");
    result->setProperty("input", "Centered stereo single-sample impulse, 0.25 per channel; factory bank defaults, wet=1 dry=0, fresh processor per mode");
    result->setProperty("directory", directory.getFullPathName()); result->setProperty("cpu", juce::SystemStats::getCpuModel());
   #if JUCE_DEBUG
    result->setProperty("build", "Debug: diagnostic_only");
   #else
    result->setProperty("build", "Release optimized");
   #endif
    result->setProperty("audioQuality", "not_asserted"); result->setProperty("acousticFidelity", "not_asserted");
    result->setProperty("responseMetrics", "diagnostic_only"); result->setProperty("timings", "diagnostic_only");
    result->setProperty("scope", "Pass asserts selector readback, finite nonzero response and WAV export only. Five-second responses can truncate long tails; synthetic impulse and CPU screen are not listening or device-dropout qualification.");
    return result;
}
