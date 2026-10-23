#pragma once

// Opt-in native mixed exports. No file normalization or loudness-based gate:
// these validate wet readout arithmetic; listeners qualify perceived balance.
inline juce::var renderReverbBalancePack()
{
    constexpr int rate = 48000, frames = 128, length = rate * 8;
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-balance/native");
    bool passed = directory.createDirectory().wasOk();
    const auto sources = makeReverbListeningSources();
    const std::array<const char*, 3> materials {"percussion", "synthetic-vowel", "sustained-chord"};
    const std::array<const char*, 4> labels {"dry", "original100", "calibrated50", "calibrated100"};
    const std::array<const char*, 27> names {
        "Room", "Hall", "Plate", "Chamber", "Spring", "Shimmer", "Nonlinear", "Convolution",
        "Church", "Ambience", "Vintage hall", "Vintage random", "Contour room", "Open hall", "Diffuse loop",
        "Magnetic heads", "Positioned room", "Rising space", "Bloom field", "Cloud field", "Vowel hall",
        "Drifting hall", "Drifting chamber", "Drifting diffuse", "Clear plate", "Clear room", "Clear random"
    };
    const auto render = [&] (int type, size_t material, int variant)
    {
        auto processor = std::make_unique<OpenStudioReverb>(true);
        processor->selectAlgorithm(type);
        processor->dryLevel.store(.7f);
        processor->wetLevel.store(variant == 0 ? 0.0f : variant == 2 ? .5f : 1.0f);
        processor->sendMode.store(0); processor->outputTrimDb.store(0);
        processor->reverbCharacterMode.store(0); processor->reverbReturnMode.store(variant >= 2 ? 1.0f : 0.0f);
        processor->prepareToPlay(rate, frames);
        juce::AudioBuffer<float> block(juce::jmax(2, processor->getTotalNumOutputChannels()), frames), output(2, length);
        juce::MidiBuffer midi;
        for (int start = 0; start < rate / 10; start += frames) { block.clear(); processor->processBlock(block, midi); }
        for (int start = 0; start < length; start += frames)
        {
            block.clear();
            for (int channel = 0; channel < 2; ++channel) block.copyFrom(channel, 0, sources[material], channel, start, frames);
            processor->processBlock(block, midi);
            for (int channel = 0; channel < 2; ++channel) output.copyFrom(channel, start, block, channel, 0, frames);
        }
        processor->releaseResources();
        return output;
    };
    juce::Array<juce::var> rows;
    double maximumHalfError = 0, maximumGainError = 0;
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
        for (size_t material = 0; material < materials.size(); ++material)
        {
            std::array<juce::AudioBuffer<float>, 4> outputs;
            for (int variant = 0; variant < 4; ++variant) outputs[static_cast<size_t>(variant)] = render(type, material, variant);
            auto* files = new juce::DynamicObject(); auto* peaks = new juce::DynamicObject();
            bool finite = true, written = true;
            double dryEnergy = 0, wet50Energy = 0, wet100Energy = 0, originalEnergy = 0;
            double halfError = 0, gainError = 0, tailEnergy = 0;
            const float gain = BuiltInReverbReturnLevels::linear[static_cast<size_t>(type)];
            for (int variant = 0; variant < 4; ++variant)
            {
                const auto filename = juce::String(type).paddedLeft('0', 2) + "-" + materials[material] + "-" + labels[static_cast<size_t>(variant)] + ".wav";
                files->setProperty(labels[static_cast<size_t>(variant)], filename);
                written = writeProbeWave(directory.getChildFile(filename), outputs[static_cast<size_t>(variant)], rate) && written;
                double peak = 0;
                for (int channel = 0; channel < 2; ++channel)
                    for (int sample = 0; sample < length; ++sample)
                    {
                        const double value = outputs[static_cast<size_t>(variant)].getSample(channel, sample);
                        finite = std::isfinite(value) && finite; peak = juce::jmax(peak, std::abs(value));
                    }
                peaks->setProperty(labels[static_cast<size_t>(variant)], peak);
            }
            for (int channel = 0; channel < 2; ++channel)
                for (int sample = 0; sample < length; ++sample)
                {
                    const double dry = outputs[0].getSample(channel, sample);
                    const double original = outputs[1].getSample(channel, sample) - dry;
                    const double half = outputs[2].getSample(channel, sample) - dry;
                    const double full = outputs[3].getSample(channel, sample) - dry;
                    halfError = juce::jmax(halfError, std::abs(half - .5 * full));
                    gainError = juce::jmax(gainError, std::abs(full - gain * original));
                    if (sample < rate * 3) { dryEnergy += dry * dry; originalEnergy += original * original; wet50Energy += half * half; wet100Energy += full * full; }
                    else tailEnergy += full * full;
                }
            maximumHalfError = juce::jmax(maximumHalfError, halfError); maximumGainError = juce::jmax(maximumGainError, gainError);
            const auto rms = [rate] (double energy) { return std::sqrt(energy / (2 * rate * 3)); };
            const auto ratio = [] (double wet, double dry) { return 10 * std::log10(juce::jmax(1e-30, wet) / juce::jmax(1e-30, dry)); };
            auto* row = new juce::DynamicObject(); row->setProperty("type", type);
            row->setProperty("name", type < 27 ? juce::String(names[static_cast<size_t>(type)]) : juce::String(BuiltInRetroReverb::names[static_cast<size_t>(type - 27)]));
            row->setProperty("material", materials[material]); row->setProperty("files", juce::var(files)); row->setProperty("peaks", juce::var(peaks));
            row->setProperty("dryRms", rms(dryEnergy)); row->setProperty("originalWet100Rms", rms(originalEnergy));
            row->setProperty("wet50Rms", rms(wet50Energy)); row->setProperty("wet100Rms", rms(wet100Energy));
            row->setProperty("original100VsDryDb", ratio(originalEnergy, dryEnergy));
            row->setProperty("wet50VsDryDb", ratio(wet50Energy, dryEnergy)); row->setProperty("wet100VsDryDb", ratio(wet100Energy, dryEnergy));
            row->setProperty("calibrationDb", BuiltInReverbReturnLevels::decibels[static_cast<size_t>(type)]);
            row->setProperty("wetHalfMaxError", halfError); row->setProperty("calibrationMaxError", gainError);
            row->setProperty("wetTailEnergy", tailEnergy); row->setProperty("finite", finite); row->setProperty("filesWritten", written);
            const bool rowPass = finite && written && dryEnergy > 0 && wet100Energy > 0 && halfError < 2e-5 && gainError < 2e-5;
            row->setProperty("pass", rowPass); passed = rowPass && passed; rows.add(juce::var(row));
        }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Standalone Reverb native Wet/Dry balance");
    result->setProperty("pass", passed); result->setProperty("cases", rows); result->setProperty("directory", directory.getFullPathName());
    result->setProperty("sampleRate", rate); result->setProperty("seconds", 8); result->setProperty("excitationSeconds", 3);
    result->setProperty("dry", .7); result->setProperty("outputDb", 0); result->setProperty("processing", "Original");
    result->setProperty("maximumHalfError", maximumHalfError); result->setProperty("maximumGainError", maximumGainError);
    result->setProperty("levels", "Native mixed output; residual wet = mixed minus separately rendered native dry; no normalization");
    result->setProperty("rmsBalance", "diagnostic_only"); result->setProperty("audibility", "not_asserted");
    result->setProperty("dominance", "not_asserted"); result->setProperty("audioQuality", "not_asserted");
    return juce::var(result);
}
