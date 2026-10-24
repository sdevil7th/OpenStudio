#pragma once

// QA-only actual mixed renders of the authored canonical states. Original and
// Calibrated here refer to Return level; each voice retains its authored
// Processing, motion and character settings. Output audio is never normalized.
inline juce::var renderReverbVoicedBalancePack()
{
    constexpr int rate = 48000, frames = 128, length = rate * 10;
    constexpr float commonInputGain = .5f;
    const auto root = juce::File::getCurrentWorkingDirectory();
    const auto directory = root.getChildFile(juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_REVERB_QA_OUTPUT","output/reverb-voiced-balance")).getChildFile("native");
    const bool profileOutput=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_REVERB_QA_PROFILE_OUTPUT","0")=="1";
    const auto fixtureDirectory = root.getChildFile("output/reverb-recorded/sources");
    bool passed = directory.createDirectory().wasOk();
    const std::array<const char*, 7> materials {
        "percussion", "synthetic-vowel", "sustained-chord",
        "recorded-guitar-low-notes", "recorded-guitar-high-notes", "recorded-guitar-layered-chord", "juce-singing-sample"
    };
    const std::array<const char*, 6> labels {"dry", "original100", "calibrated25", "calibrated50", "calibrated75", "calibrated100"};
    std::array<juce::AudioBuffer<float>, 7> sources;
    std::array<int, 7> excitationFrames {rate * 3, rate * 3, rate * 3, 0, 0, 0, 0};
    const auto generated = makeReverbListeningSources();
    for (auto& source : sources) { source.setSize(2, length); source.clear(); }
    for (size_t material = 0; material < generated.size(); ++material)
        for (int channel = 0; channel < 2; ++channel)
            sources[material].copyFrom(channel, 0, generated[material], channel, 0, generated[material].getNumSamples());
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    juce::Array<juce::var> inputRows;
    for (size_t material = 3; material < sources.size(); ++material)
    {
        const auto file = fixtureDirectory.getChildFile(juce::String(materials[material]) + ".wav");
        std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
        const bool valid = reader && reader->sampleRate == rate && reader->numChannels == 1
            && reader->lengthInSamples > 0 && reader->lengthInSamples < length;
        passed = valid && passed;
        if (valid)
        {
            excitationFrames[material] = static_cast<int>(reader->lengthInSamples);
            const bool read = reader->read(&sources[material], 0, excitationFrames[material], 0, true, false);
            sources[material].copyFrom(1, 0, sources[material], 0, 0, excitationFrames[material]);
            passed = read && passed;
        }
    }
    for (size_t material = 0; material < sources.size(); ++material)
    {
        const double beforePeak = sources[material].getMagnitude(0, length);
        sources[material].applyGain(commonInputGain);
        const auto filename = juce::String("source-") + materials[material] + ".wav";
        passed = writeProbeWave(directory.getChildFile(filename), sources[material], rate) && passed;
        auto* row = new juce::DynamicObject(); row->setProperty("material", materials[material]);
        row->setProperty("sourceFile", filename); row->setProperty("commonInputGain", commonInputGain);
        row->setProperty("peakBeforeCommonInputGain", beforePeak); row->setProperty("peakAfterCommonInputGain", sources[material].getMagnitude(0, length));
        row->setProperty("excitationSeconds", static_cast<double>(excitationFrames[material]) / rate);
        row->setProperty("provenance", material < 3 ? "Deterministic generated fixture; synthetic vowel is not human voice"
            : material < 6 ? "Existing CC0 FreePats recorded electric-guitar DI notes, arranged by prepare_reverb_recorded_fixtures.py; mono duplicated to stereo input, not a stereo recording or continuous live take"
            : "Existing short JUCE singing audio asset; mono downmix duplicated to stereo input; recording chain/performer/binary licence credits unverified, local diagnostic QA only; not broad vocal qualification");
        inputRows.add(juce::var(row));
    }
    const auto sourceManifest = fixtureDirectory.getChildFile("manifest.json");
    const bool copiedManifest = sourceManifest.existsAsFile()
        && sourceManifest.copyFileTo(directory.getChildFile("recorded-source-manifest.json"));
    passed = copiedManifest && passed;

    const auto render = [&] (const juce::MemoryBlock& authoredState, size_t material, int variant)
    {
        auto processor = std::make_unique<OpenStudioReverb>(true);
        processor->setStateInformation(authoredState.getData(), static_cast<int>(authoredState.getSize()));
        processor->dryLevel.store(.7f);
        processor->wetLevel.store(variant == 0 ? 0.0f : variant == 1 ? 1.0f : static_cast<float>(variant-1)*.25f);
        processor->sendMode.store(0); if(!profileOutput)processor->outputTrimDb.store(0);
        processor->reverbReturnMode.store(variant >= 2 ? 1.0f : 0.0f);
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
    double maximumHalfError = 0, maximumGainError = 0, maximumPeak = 0;
    juce::int64 aboveUnity = 0, atSafetyBound = 0;
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
    {
        const auto& voice = OpenStudioReverbFactoryPresets::profiles[static_cast<size_t>(type)];
        juce::MemoryBlock authoredState;
        const bool built = OpenStudioReverbFactoryPresets::buildState(voice.name, authoredState);
        passed = built && passed;
        const auto stateFile = juce::String("canonical-type-") + juce::String(type).paddedLeft('0', 2) + ".state";
        passed = directory.getChildFile(stateFile).replaceWithData(authoredState.getData(), authoredState.getSize()) && passed;
        for (size_t material = 0; material < materials.size(); ++material)
        {
            std::array<juce::AudioBuffer<float>, 6> outputs;
            for (int variant = 0; variant < 6; ++variant) outputs[static_cast<size_t>(variant)] = render(authoredState, material, variant);
            auto* files = new juce::DynamicObject(); auto* peaks = new juce::DynamicObject();
            auto* unityCounts = new juce::DynamicObject(); auto* boundCounts = new juce::DynamicObject();
            bool finite = true, written = true;
            double dryEnergy = 0, wet50Energy = 0, wet100Energy = 0, originalEnergy = 0;
            double halfError = 0, gainError = 0, tailEnergy = 0;
            const float gain = BuiltInReverbReturnLevels::linear[static_cast<size_t>(type)];
            for (int variant = 0; variant < 6; ++variant)
            {
                const auto filename = juce::String(type).paddedLeft('0', 2) + "-" + materials[material] + "-" + labels[static_cast<size_t>(variant)] + ".wav";
                files->setProperty(labels[static_cast<size_t>(variant)], filename);
                written = writeProbeWave(directory.getChildFile(filename), outputs[static_cast<size_t>(variant)], rate) && written;
                double peak = 0; juce::int64 unity = 0, bound = 0;
                for (int channel = 0; channel < 2; ++channel)
                    for (int sample = 0; sample < length; ++sample)
                    {
                        const double value = outputs[static_cast<size_t>(variant)].getSample(channel, sample);
                        finite = std::isfinite(value) && finite; peak = juce::jmax(peak, std::abs(value));
                        if (std::abs(value) > 1) ++unity;
                        if (std::abs(value) >= 4) ++bound;
                    }
                peaks->setProperty(labels[static_cast<size_t>(variant)], peak);
                unityCounts->setProperty(labels[static_cast<size_t>(variant)], unity); boundCounts->setProperty(labels[static_cast<size_t>(variant)], bound);
                aboveUnity += unity; atSafetyBound += bound; maximumPeak = juce::jmax(maximumPeak, peak);
            }
            for (int channel = 0; channel < 2; ++channel)
                for (int sample = 0; sample < length; ++sample)
                {
                    const double dry = outputs[0].getSample(channel, sample);
                    const double original = outputs[1].getSample(channel, sample) - dry;
                    const double half = outputs[3].getSample(channel, sample) - dry;
                    const double full = outputs[5].getSample(channel, sample) - dry;
                    for(int level=2;level<6;++level)halfError=juce::jmax(halfError,std::abs(outputs[static_cast<size_t>(level)].getSample(channel,sample)-dry-(level-1)*.25*full));
                    gainError = juce::jmax(gainError, std::abs(full - gain * original));
                    if (sample < excitationFrames[material]) { dryEnergy += dry * dry; originalEnergy += original * original; wet50Energy += half * half; wet100Energy += full * full; }
                    else tailEnergy += full * full;
                }
            maximumHalfError = juce::jmax(maximumHalfError, halfError); maximumGainError = juce::jmax(maximumGainError, gainError);
            const auto rms = [material, &excitationFrames] (double energy) { return std::sqrt(energy / (2 * juce::jmax(1, excitationFrames[material]))); };
            const auto ratio = [] (double wet, double dry) { return 10 * std::log10(juce::jmax(1e-30, wet) / juce::jmax(1e-30, dry)); };
            auto* row = new juce::DynamicObject(); row->setProperty("type", type); row->setProperty("name", voice.name);
            row->setProperty("outputTrimDb",profileOutput?voice.outputTrimDb:0);row->setProperty("material", materials[material]); row->setProperty("files", juce::var(files)); row->setProperty("peaks", juce::var(peaks));
            row->setProperty("samplesAboveUnityDiagnostic", juce::var(unityCounts)); row->setProperty("samplesAtSafetyBoundDiagnostic", juce::var(boundCounts));
            row->setProperty("excitationSeconds", static_cast<double>(excitationFrames[material]) / rate);
            row->setProperty("dryRms", rms(dryEnergy)); row->setProperty("originalWet100Rms", rms(originalEnergy));
            row->setProperty("wet50Rms", rms(wet50Energy)); row->setProperty("wet100Rms", rms(wet100Energy));
            row->setProperty("original100VsDryDb", ratio(originalEnergy, dryEnergy));
            row->setProperty("wet25VsDryDb",ratio(wet100Energy*.0625,dryEnergy));row->setProperty("wet75VsDryDb",ratio(wet100Energy*.5625,dryEnergy));row->setProperty("wet50VsDryDb", ratio(wet50Energy, dryEnergy)); row->setProperty("wet100VsDryDb", ratio(wet100Energy, dryEnergy));
            row->setProperty("calibrationDb", BuiltInReverbReturnLevels::decibels[static_cast<size_t>(type)]);
            row->setProperty("wetHalfMaxError", halfError); row->setProperty("calibrationMaxError", gainError);
            row->setProperty("wetTailEnergy", tailEnergy); row->setProperty("finite", finite); row->setProperty("filesWritten", written);
            const bool rowPass = built && finite && written && dryEnergy > 0 && wet100Energy > 0 && halfError < 2e-5 && gainError < 2e-5;
            row->setProperty("pass", rowPass); passed = rowPass && passed; rows.add(juce::var(row));
        }
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Standalone canonical Reverb native mixed generated/recorded-DI qualification");
    result->setProperty("pass", passed); result->setProperty("cases", rows); result->setProperty("directory", directory.getFullPathName());
    result->setProperty("sampleRate", rate); result->setProperty("seconds", 10); result->setProperty("sources", inputRows);
    juce::Array<juce::var> materialNames; for (const auto* material : materials) materialNames.add(material);
    result->setProperty("materials", materialNames); result->setProperty("caseCount", rows.size());
    result->setProperty("dry", .7); result->setProperty("outputDb",profileOutput?juce::var("authored_per_voice"):juce::var(0)); result->setProperty("processing", "Each canonical voice retains its authored Processing and character state");
    result->setProperty("commonInputGain", commonInputGain); result->setProperty("maximumHalfError", maximumHalfError); result->setProperty("maximumGainError", maximumGainError);
    result->setProperty("maximumMixedPeak", maximumPeak); result->setProperty("samplesAboveUnityDiagnostic", aboveUnity); result->setProperty("samplesAtSafetyBoundDiagnostic", atSafetyBound);
    result->setProperty("levels", "Native mixed output without output normalization. Every source has the same fixed0.5 input gain; recorded-source preparation gains are separately recorded. Residual wet = mixed minus separately rendered native dry.");
    result->setProperty("recordedSourceManifest", "recorded-source-manifest.json");
    result->setProperty("rmsBalance", "diagnostic_only"); result->setProperty("audibility", "not_asserted");
    result->setProperty("dominance", "not_asserted"); result->setProperty("audioQuality", "not_asserted");
    result->setProperty("realRecordedVoice", "Short JUCE singing sample only; performer/recording-chain provenance, binary licence credits and broad vocal qualification remain unasserted");
    result->setProperty("tailCompleteness", "not_asserted_in_ten_second_audition_pack; separate extended qualification observes finite declared tails");
    return juce::var(result);
}
