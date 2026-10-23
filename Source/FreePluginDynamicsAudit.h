#pragma once

// These processors are not clippers: at zero attenuation/reduction their wet
// path must preserve finite floating-point headroom, not only sub-0 dBFS audio.
// Deliberate nonlinear compressor models and processor/host bypass are excluded.
inline juce::var checkDynamicsUnityHeadroom()
{
    bool passed = true;
    juce::Array<juce::var> cases;
    for (const bool compressor : {false, true})
        for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0})
            for (const int channels : {1, 2})
                for (const float amplitude : {.125f, 1.0f, 3.0f, 8.0f})
                {
                    std::unique_ptr<juce::AudioProcessor> processor;
                    if (compressor)
                    {
                        auto clean = std::make_unique<OpenStudioCompressor>(true);
                        clean->selectModel(1);
                        clean->audioCharacter.store(0);
                        clean->threshold.store(-24); clean->ratio.store(1);
                        clean->makeupGain.store(0); clean->autoMakeup.store(0);
                        clean->mix.store(1);
                        processor = std::move(clean);
                    }
                    else
                    {
                        auto gate = std::make_unique<OpenStudioGate>(true);
                        gate->range.store(0); gate->mix.store(1);
                        gate->attackMs.store(.01f); gate->holdMs.store(0);
                        gate->releaseMs.store(5); gate->detectorListen.store(0);
                        processor = std::move(gate);
                    }
                    constexpr int blockSize = 127;
                    processor->prepareToPlay(rate, blockSize);
                    const int latency = processor->getLatencySamples();
                    const int settleSamples = juce::roundToInt(rate * .05);
                    const int sampleCount = latency + juce::roundToInt(rate * .15);
                    const auto input = [rate, amplitude] (int position, int channel)
                    {
                        if (position < 0) return 0.0f;
                        const float value = amplitude * static_cast<float>(std::sin(
                            juce::MathConstants<double>::twoPi * 997.0 * position / rate));
                        return channel == 0 ? value : -value;
                    };
                    juce::AudioBuffer<float> audio(channels, blockSize);
                    juce::MidiBuffer midi;
                    bool finite = true;
                    double maximumError = 0, maximumOutput = 0, maximumReference = 0;
                    int alteredSamples = 0;
                    for (int start = 0; start < sampleCount; start += blockSize)
                    {
                        const int count = juce::jmin(blockSize, sampleCount - start);
                        audio.setSize(channels, count, false, false, true);
                        for (int channel = 0; channel < channels; ++channel)
                            for (int sample = 0; sample < count; ++sample)
                                audio.setSample(channel, sample, input(start + sample, channel));
                        processor->processBlock(audio, midi);
                        for (int channel = 0; channel < channels; ++channel)
                            for (int sample = 0; sample < count; ++sample)
                            {
                                const float actual = audio.getSample(channel, sample);
                                finite = finite && std::isfinite(actual);
                                const int position = start + sample - latency;
                                if (position < settleSamples) continue;
                                const double expected = input(position, channel);
                                const double error = std::abs(static_cast<double>(actual) - expected);
                                maximumError = juce::jmax(maximumError, error);
                                maximumOutput = juce::jmax(maximumOutput, std::abs(static_cast<double>(actual)));
                                maximumReference = juce::jmax(maximumReference, std::abs(expected));
                                if (error > 1.0e-6) ++alteredSamples;
                            }
                    }
                    const bool okay = finite && maximumError <= 1.0e-6;
                    passed = passed && okay;
                    auto* row = new juce::DynamicObject();
                    row->setProperty("processor", compressor ? "Compressor Clean" : "Gate");
                    row->setProperty("sampleRate", rate); row->setProperty("channels", channels);
                    row->setProperty("inputAmplitude", amplitude); row->setProperty("reportedLatency", latency);
                    row->setProperty("maximumErrorAfterLatencyAndSettling", maximumError);
                    row->setProperty("maximumOutput", maximumOutput); row->setProperty("maximumReference", maximumReference);
                    row->setProperty("alteredSamples", alteredSamples); row->setProperty("finite", finite);
                    row->setProperty("pass", okay); cases.add(row);
                }
    auto* result = new juce::DynamicObject();
    result->setProperty("pass", passed); result->setProperty("cases", cases);
    result->setProperty("scope", "Active 100% wet Gate Range0 and Legacy-character Clean Compressor Ratio1/Makeup0/AutoMakeupOff must preserve the same finite physical input, including peaks above +8 dBFS, after reported latency and startup settling. Intentional colour, hardware headroom and audible quality are not asserted.");
    return result;
}

// Audit evidence, not a production DSP change. A successful capture does not
// imply that the behavioral contracts below passed or that audio was auditioned.
inline juce::var auditFreePluginDynamics()
{
    const auto folder = juce::File::getCurrentWorkingDirectory()
        .getChildFile(juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_SIGNAL_AUDIT_OUTPUT", "output/free-plugin-audit")).getChildFile("dynamics/native");
    bool evidenceValid = true, signalContracts = true;
    juce::Array<juce::var> foldbackCases, bypassCases, compressorCases;
    bool compressorLawPass = true;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (int type : {3, 7}) for (int oversampling : {0, 1, 2})
        {
            OpenStudioSaturator effect;
            effect.satType.store(static_cast<float>(type));
            effect.drive.store(0); effect.mix.store(1); effect.outputGain.store(0);
            effect.asymmetry.store(0); effect.colourEngine.store(0);
            effect.setOversamplingMode(static_cast<float>(oversampling));
            effect.prepareToPlay(rate, 127);
            const int count = juce::roundToInt(rate * .5);
            juce::AudioBuffer<float> captured(2, count), audio(2, 127);
            juce::MidiBuffer midi;
            double sumEnergy = 0, referenceEnergy = 0, maximumSum = 0;
            for (int start = 0; start < count; start += 127)
            {
                const int block = juce::jmin(127, count - start);
                audio.setSize(2, block, false, false, true);
                for (int i = 0; i < block; ++i)
                {
                    const float sample = static_cast<float>(std::sin(
                        juce::MathConstants<double>::twoPi * 997 * (start + i) / rate));
                    audio.setSample(0, i, sample); audio.setSample(1, i, -sample);
                }
                effect.processBlock(audio, midi);
                for (int ch = 0; ch < 2; ++ch) captured.copyFrom(ch, start, audio, ch, 0, block);
                for (int i = 0; i < block; ++i)
                {
                    const double left = audio.getSample(0, i), right = audio.getSample(1, i);
                    evidenceValid = evidenceValid && std::isfinite(left) && std::isfinite(right);
                    if (start + i < rate * .1) continue;
                    const double sum = left + right;
                    maximumSum = juce::jmax(maximumSum, std::abs(sum));
                    sumEnergy += sum * sum; referenceEnergy += left * left;
                }
            }
            auto* row = new juce::DynamicObject();
            row->setProperty("sampleRate", rate); row->setProperty("type", type);
            row->setProperty("oversamplingFactor", 1 << oversampling);
            row->setProperty("maximumAntiphaseSum", maximumSum);
            row->setProperty("antiphaseResidualDbRelativeToLeft", 10 * std::log10(
                juce::jmax(1.0e-30, sumEnergy / juce::jmax(1.0e-30, referenceEnergy))));
            row->setProperty("oddSymmetryStatus", maximumSum < 1.0e-6 ? "pass" : "fail");
            row->setProperty("settings", "Corrected signal path, Legacy colour engine, Drive 0 dB, Output 0 dB, Asymmetry 0, Mix 100%, 997 Hz 1.0-peak antiphase stereo");
            if (rate == 48000)
            {
                const auto file = folder.getChildFile("saturator-type" + juce::String(type)
                    + "-os" + juce::String(1 << oversampling) + "-antiphase.wav");
                evidenceValid = writeProbeWave(file, captured, rate) && evidenceValid;
                row->setProperty("render", file.getFullPathName());
            }
            signalContracts = signalContracts && maximumSum < 1e-6;
            foldbackCases.add(row);
        }
        for (int character : {0, 1}) for (double frequency : {997.0, 10000.0})
        {
            OpenStudioUtilityEffect effect(OpenStudioUtilityEffect::Kind::Preamp);
            effect.setControl("audioCharacter", static_cast<float>(character));
            effect.setControl("bypass", 1); effect.prepareToPlay(rate, 127);
            const int count = juce::roundToInt(rate * .35), latency = effect.getLatencySamples();
            juce::AudioBuffer<float> audio(2, 127);
            juce::MidiBuffer midi;
            double errorEnergy = 0, referenceEnergy = 0, maximumError = 0, outputEnergy = 0;
            const auto signal = [rate, frequency](int position)
            {
                return position < 0 ? 0.0f : static_cast<float>(.1 * std::sin(
                    juce::MathConstants<double>::twoPi * frequency * position / rate));
            };
            for (int start = 0; start < count; start += 127)
            {
                const int block = juce::jmin(127, count - start);
                audio.setSize(2, block, false, false, true);
                for (int i = 0; i < block; ++i)
                    for (int ch = 0; ch < 2; ++ch) audio.setSample(ch, i, signal(start + i));
                effect.processBlock(audio, midi);
                for (int i = 0; i < block; ++i)
                {
                    const double output = audio.getSample(0, i);
                    evidenceValid = evidenceValid && std::isfinite(output);
                    if (start + i < rate * .1) continue;
                    const double reference = signal(start + i - latency), error = output - reference;
                    maximumError = juce::jmax(maximumError, std::abs(error));
                    errorEnergy += error * error; referenceEnergy += reference * reference;
                    outputEnergy += output * output;
                }
            }
            auto* row = new juce::DynamicObject();
            row->setProperty("sampleRate", rate); row->setProperty("character", character);
            row->setProperty("frequencyHz", frequency); row->setProperty("latencySamples", latency);
            row->setProperty("maximumErrorAfterReportedLatency", maximumError);
            row->setProperty("nullResidualDbRelativeToDry", 10 * std::log10(
                juce::jmax(1.0e-30, errorEnergy / referenceEnergy)));
            row->setProperty("bypassedGainDb", 10 * std::log10(outputEnergy / referenceEnergy));
            row->setProperty("status", maximumError < 1e-7 ? "pass" : "fail");
            signalContracts = signalContracts && maximumError < 1e-7;
            row->setProperty("contract", "A bypassed processor should preserve the waveform after its reported latency; Corrected uses the native-rate dry path.");
            bypassCases.add(row);
        }
        for (float ratio : {1.0f, 2.0f, 4.0f, 20.0f})
            for (float peakDb : {-36.0f, -24.0f, -12.0f, -3.0f})
        {
            OpenStudioCompressor effect(true);
            effect.selectModel(1); effect.audioCharacter.store(0);
            effect.threshold.store(-24); effect.ratio.store(ratio); effect.knee.store(0);
            effect.attack.store(5); effect.release.store(100); effect.autoRelease.store(0);
            effect.makeupGain.store(0); effect.autoMakeup.store(0); effect.mix.store(1);
            effect.detectorMode.store(1); effect.stereoLink.store(1); effect.sidechainHPF.store(20);
            effect.prepareToPlay(rate, 127);
            const int count = juce::roundToInt(rate), latency = effect.getLatencySamples();
            const float level = juce::Decibels::decibelsToGain(peakDb);
            juce::AudioBuffer<float> audio(2, 127);
            juce::MidiBuffer midi;
            double inputEnergy = 0, outputEnergy = 0, symmetryError = 0;
            const auto signal = [rate, level](int position)
            {
                return position < 0 ? 0.0f : static_cast<float>(level * std::sin(
                    juce::MathConstants<double>::twoPi * 997 * position / rate));
            };
            for (int start = 0; start < count; start += 127)
            {
                const int block = juce::jmin(127, count - start);
                audio.setSize(2, block, false, false, true);
                for (int i = 0; i < block; ++i)
                {
                    const float sample = signal(start + i);
                    audio.setSample(0, i, sample); audio.setSample(1, i, -sample);
                }
                effect.processBlock(audio, midi);
                for (int i = 0; i < block; ++i)
                {
                    evidenceValid = evidenceValid && std::isfinite(audio.getSample(0, i));
                    if (start + i < rate * .6) continue;
                    const double input = signal(start + i - latency), output = audio.getSample(0, i);
                    inputEnergy += input * input; outputEnergy += output * output;
                    symmetryError = juce::jmax(symmetryError,
                        std::abs(output + audio.getSample(1, i)));
                }
            }
            const double expected = -juce::jmax(0.0, static_cast<double>(peakDb) - 3.01029995664 + 24)
                * (1.0 - 1.0 / ratio);
            const double measured = 10 * std::log10(outputEnergy / inputEnergy);
            const bool law = std::abs(measured - expected) < .05 && symmetryError < 1.0e-6;
            compressorLawPass = compressorLawPass && law;
            auto* row = new juce::DynamicObject();
            row->setProperty("sampleRate", rate); row->setProperty("ratio", ratio);
            row->setProperty("inputPeakDbFS", peakDb); row->setProperty("expectedGainDb", expected);
            row->setProperty("measuredGainDb", measured); row->setProperty("errorDb", measured - expected);
            row->setProperty("antiphaseError", symmetryError); row->setProperty("status", law ? "pass" : "fail");
            row->setProperty("settings", "Clean, RMS, Threshold -24 dB, Knee 0, Attack 5 ms, Release 100 ms, no Auto/Makeup, 997 Hz antiphase sine, Mix 100%");
            compressorCases.add(row);
        }
    }
    const auto renderTransition = [](int blockSize, bool changing)
    {
        constexpr int length = 14400, event = 4800;
        OpenStudioSaturator effect;
        effect.satType.store(0); effect.drive.store(18); effect.mix.store(1);
        effect.setOversamplingMode(0); effect.prepareToPlay(48000, blockSize);
        std::vector<float> output(static_cast<size_t>(length));
        juce::AudioBuffer<float> audio(2, blockSize); juce::MidiBuffer midi;
        for (int start = 0; start < length;)
        {
            int count = juce::jmin(blockSize, length - start);
            if (start < event) count = juce::jmin(count, event - start);
            if (changing && start == event) effect.satType.store(3);
            audio.setSize(2, count, false, false, true);
            for (int i = 0; i < count; ++i)
            {
                const float sample = .25f * std::sin(juce::MathConstants<float>::twoPi
                    * 997.0f * static_cast<float>(start + i) / 48000.0f);
                audio.setSample(0, i, sample); audio.setSample(1, i, -sample);
            }
            effect.processBlock(audio, midi);
            for (int i = 0; i < count; ++i) output[static_cast<size_t>(start + i)] = audio.getSample(0, i);
            start += count;
        }
        return output;
    };
    juce::Array<juce::var> transitionCases;
    const auto reference = renderTransition(64, true), staticReference = renderTransition(64, false);
    for (int blockSize : {1, 32, 127, 512, 1024})
    {
        const auto candidate = renderTransition(blockSize, true), staticCandidate = renderTransition(blockSize, false);
        double maximumError = 0, staticError = 0; int drySamples = 0;
        for (size_t i = 0; i < candidate.size(); ++i)
        {
            evidenceValid = evidenceValid && std::isfinite(candidate[i]);
            maximumError = juce::jmax(maximumError, std::abs(static_cast<double>(candidate[i] - reference[i])));
            staticError = juce::jmax(staticError, std::abs(static_cast<double>(staticCandidate[i] - staticReference[i])));
            if (i >= 5280 && i < 6800)
            {
                const float input = .25f * std::sin(juce::MathConstants<float>::twoPi
                    * 997.0f * static_cast<float>(i) / 48000.0f);
                if (std::abs(candidate[i] - input) < 1.0e-7) ++drySamples;
            }
        }
        auto* row = new juce::DynamicObject(); row->setProperty("blockSize", blockSize);
        row->setProperty("maximumErrorAgainst64SampleBlocks", maximumError);
        row->setProperty("staticPartitionError", staticError);
        row->setProperty("drySamplesAfterTenMsFade", drySamples);
        row->setProperty("status", maximumError < 1e-6 && staticError < 1e-6 && drySamples == 0 ? "pass" : "fail");
        signalContracts = signalContracts && maximumError < 1e-6 && staticError < 1e-6 && drySamples == 0;
        row->setProperty("settings", "48 kHz, Corrected signal path, Legacy colour engine Tape to Clip exactly at sample4800, OversamplingOff, Drive18, Mix100, 997Hz/0.25peak; both partitions split at event");
        transitionCases.add(row);
    }
    auto* result = new juce::DynamicObject();
    const auto unityHeadroom = checkDynamicsUnityHeadroom();
    result->setProperty("plugin", "Dynamics and colour independent audit");
    result->setProperty("pass", evidenceValid && signalContracts && compressorLawPass
        && static_cast<bool>(unityHeadroom.getProperty("pass", false)));
    result->setProperty("passMeaning", "Deterministic symmetry, bypass null, transfer law, active unity headroom and transition timing; audio quality not asserted.");
    result->setProperty("activeUnityHeadroom", unityHeadroom);
    result->setProperty("saturatorAntiphase", foldbackCases);
    result->setProperty("preampInternalBypass", bypassCases);
    result->setProperty("compressorCleanRmsCurve", compressorCases);
    result->setProperty("compressorCleanRmsCurveStatus", compressorLawPass ? "pass" : "fail");
    result->setProperty("saturatorTypeTransitionPartitions", transitionCases);
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
