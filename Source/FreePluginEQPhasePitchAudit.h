#pragma once

// Audit evidence, deliberately separate from the passing regression baseline.
// Pitch frequency estimates remain diagnostic; this does not assert listening quality.
inline juce::var auditEQPhasePitchContracts()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "EQ, Gain Phase and realtime Pitch Correct audit");
    result->setProperty("audioQuality", "not_asserted");
    juce::Array<juce::var> noteCases, detectorCases, tailCases, eqCases, filterTailCases;
    bool absoluteNoteContract = true, tailContract = true, eqLinearity = true, filterTailContract = true;

    // A static linear EQ should obey amplitude homogeneity even when an
    // intermediate floating-point bus exceeds 0 dBFS. These are within the
    // exposed +30 dB band range, with dynamics and auto gain disabled.
    for (int phase = 0; phase < 2; ++phase)
    {
        const auto render = [phase](float amplitude)
        {
            auto eq = std::make_unique<OpenStudioEQ>(true);
            eq->setNonRealtime(true);
            for (auto& band : eq->bands) band.enabled.store(0);
            eq->bands[1].enabled.store(1); eq->bands[1].freq.store(1000);
            eq->bands[1].gain.store(18); eq->bands[1].q.store(1);
            eq->setPhaseConfiguration(static_cast<float>(phase), 1);
            eq->prepareToPlay(48000, 127);
            juce::AudioBuffer<float> rendered(2, 24000), block(2, 127);
            juce::MidiBuffer midi;
            for (int start = 0; start < rendered.getNumSamples(); start += 127)
            {
                const int count = juce::jmin(127, rendered.getNumSamples() - start);
                block.setSize(2, count, false, false, true);
                for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < count; ++i)
                    block.setSample(ch, i, amplitude * static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * (start + i) / 48.0)));
                eq->processBlock(block, midi);
                for (int ch = 0; ch < 2; ++ch) rendered.copyFrom(ch, start, block, ch, 0, count);
            }
            return rendered;
        };
        const auto quiet = render(.01f), loud = render(.5f);
        double error = 0, referencePeak = 0, actualPeak = 0;
        int guardedSamples = 0;
        for (int i = 12000; i < loud.getNumSamples(); ++i)
        {
            const double reference = quiet.getSample(0, i) * 50.0, actual = loud.getSample(0, i);
            error = juce::jmax(error, std::abs(reference - actual));
            referencePeak = juce::jmax(referencePeak, std::abs(reference)); actualPeak = juce::jmax(actualPeak, std::abs(actual));
            if (std::abs(actual) == 2.5) ++guardedSamples;
        }
        const bool pass = error < 1e-4;
        eqLinearity = eqLinearity && pass;
        auto* row = new juce::DynamicObject();
        row->setProperty("phase", phase == 0 ? "IIR" : "Linear FIR");
        row->setProperty("inputPeak", .5); row->setProperty("bandBoostDb", 18);
        row->setProperty("expectedLinearPeak", referencePeak); row->setProperty("actualPeak", actualPeak);
        row->setProperty("amplitudeHomogeneityError", error); row->setProperty("guardedSamplesOf12000", guardedSamples);
        row->setProperty("pass", pass); eqCases.add(row);
    }

    // Public descriptors name noteEnable_0 C, etc.; verify those named targets
    // remain the same absolute pitch classes when the root changes.
    for (int root = 0; root < 12; ++root)
    {
        PitchMapper mapper;
        mapper.setCorrectedNoteMask(true);
        mapper.prepare(48000);
        mapper.setKey(root);
        mapper.setScale(PitchMapper::Scale::Custom);
        for (int note = 0; note < 12; ++note) mapper.setNoteEnabled(note, note == 0);
        const float requestedHz = 261.625565f;
        const float targetHz = mapper.getSnapTarget(requestedHz);
        const int targetMidi = juce::roundToInt(69.0f + 12.0f * std::log2(targetHz / 440.0f));
        const int targetClass = ((targetMidi % 12) + 12) % 12;
        const bool pass = targetClass == 0;
        absoluteNoteContract = absoluteNoteContract && pass;
        auto* row = new juce::DynamicObject();
        row->setProperty("root", root); row->setProperty("enabledDescriptor", "C only");
        row->setProperty("inputMidi", 60); row->setProperty("mappedMidi", targetMidi);
        row->setProperty("targetHz", targetHz); row->setProperty("pass", pass);
        noteCases.add(row);
    }

    // The suite only exposes individual note toggles in Custom. Their retained
    // value must not silently remove targets after selecting a named scale.
    PitchMapper maskedMapper;
    maskedMapper.setCorrectedNoteMask(true);
    maskedMapper.prepare(48000); maskedMapper.setKey(0);
    maskedMapper.setScale(PitchMapper::Scale::Custom);
    for (int note = 0; note < 12; ++note) maskedMapper.setNoteEnabled(note, note == 0);
    maskedMapper.setScale(PitchMapper::Scale::Major);
    const float majorTarget = maskedMapper.getSnapTarget(329.627557f);
    const int majorTargetMidi = juce::roundToInt(69.0f + 12.0f * std::log2(majorTarget / 440.0f));
    const bool hiddenMaskContract = majorTargetMidi == 64;
    auto* hiddenMask = new juce::DynamicObject();
    hiddenMask->setProperty("steps", "Custom, enable only C, switch Major, request E4");
    hiddenMask->setProperty("expectedMidi", 64); hiddenMask->setProperty("actualMidi", majorTargetMidi);
    hiddenMask->setProperty("pass", hiddenMaskContract);
    result->setProperty("hiddenCustomMask", hiddenMask);

    // The exact frame/lag bound is the structural issue. Estimates demonstrate
    // its practical consequences on deterministic monophonic inputs.
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (double hz : {55.0, 82.406889, 110.0, 164.813778, 220.0, 440.0})
        {
            PitchDetector detector;
            detector.setRateNormalized(true);
            detector.prepare(rate, 512); detector.setMinFrequency(40); detector.setMaxFrequency(1000);
            std::array<float, 512> input {};
            const int total = juce::roundToInt(rate * .2);
            for (int start = 0; start < total; start += 512)
            {
                const int count = juce::jmin(512, total - start);
                for (int i = 0; i < count; ++i)
                    input[static_cast<size_t>(i)] = static_cast<float>(.2 * std::sin(juce::MathConstants<double>::twoPi * hz * (start + i) / rate));
                detector.processSamples(input.data(), count);
            }
            auto* row = new juce::DynamicObject();
            const double detected = detector.getDetectedFrequency();
            row->setProperty("sampleRate", rate); row->setProperty("inputHz", hz);
            row->setProperty("configuredMinimumHz", 40); row->setProperty("maximumLag", 1023);
            row->setProperty("minimumFrequencyFromLagHz", (rate / std::ceil(rate / 32000.0)) / 1023);
            row->setProperty("onePeriodFitsSearch", (rate / std::ceil(rate / 32000.0)) / hz <= 1023);
            row->setProperty("detectedHz", detected); row->setProperty("confidence", detector.getConfidence());
            row->setProperty("centsError", detected > 0 ? juce::var(1200 * std::log2(detected / hz)) : juce::var());
            row->setProperty("status", "diagnostic_only"); detectorCases.add(row);
        }

    using Utility = OpenStudioUtilityEffect;
    for (double rate : {44100.0, 48000.0, 192000.0})
        for (int mode = 0; mode < 3; ++mode)
        {
            Utility processor(Utility::Kind::GainPhase);
            processor.setNonRealtime(true);
            if (mode == 0) { processor.setControl("delayL", 2048); processor.setControl("delayR", 2048); }
            if (mode == 1) { processor.setControl("phaseEnabledL", 1); processor.setControl("phaseFrequencyL", 20); processor.setControl("phaseStagesL", 3); }
            if (mode == 2) { processor.setControl("spectralPhaseEnabled", 1); processor.setControl("spectralPhaseL12", 90); }
            processor.prepareToPlay(rate, 127);
            const int latency = processor.getLatencySamples();
            const double declaredTail = processor.getTailLengthSeconds();
            const int declaredEnd = latency + juce::roundToInt(declaredTail * rate);
            juce::AudioBuffer<float> block(2, 127); juce::MidiBuffer midi;
            int lastNonzero = -1; double energyAfterDeclaredEnd = 0, maximum = 0;
            bool finite = true;
            for (int start = 0; start < declaredEnd + juce::roundToInt(rate * .5); start += 127)
            {
                const int count = juce::jmin(127, declaredEnd + juce::roundToInt(rate * .5) - start);
                block.setSize(2, count, false, false, true); block.clear();
                if (start == 0) { block.setSample(0, 0, .25f); block.setSample(1, 0, .25f); }
                processor.processBlock(block, midi);
                for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < count; ++i)
                {
                    const double value = block.getSample(ch, i);
                    finite = finite && std::isfinite(value); maximum = juce::jmax(maximum, std::abs(value));
                    if (std::abs(value) > 1e-6) lastNonzero = juce::jmax(lastNonzero, start + i);
                    if (start + i > declaredEnd) energyAfterDeclaredEnd += value * value;
                }
            }
            const bool pass = finite && energyAfterDeclaredEnd < 1e-12;
            tailContract = tailContract && pass;
            auto* row = new juce::DynamicObject();
            row->setProperty("sampleRate", rate); row->setProperty("mode", mode == 0 ? "2048 sample delay" : mode == 1 ? "20 Hz four-stage allpass" : "spectral phase FIR");
            row->setProperty("declaredTailSeconds", declaredTail); row->setProperty("latencySamples", latency);
            row->setProperty("lastSampleAboveMinus120dBFS", lastNonzero); row->setProperty("energyAfterDeclaredTail", energyAfterDeclaredEnd);
            row->setProperty("peak", maximum); row->setProperty("finite", finite); row->setProperty("pass", pass); tailCases.add(row);
        }

    for (double rate : {44100.0, 48000.0, 192000.0})
        for (int kind = 0; kind < 2; ++kind)
        {
            std::unique_ptr<juce::AudioProcessor> processor;
            if (kind == 0)
            {
                auto eq = std::make_unique<OpenStudioEQ>(true);
                for (auto& band : eq->bands) band.enabled.store(0);
                eq->bands[1].enabled.store(1); eq->bands[1].freq.store(40);
                eq->bands[1].gain.store(12); eq->bands[1].q.store(30);
                processor = std::move(eq);
            }
            else
            {
                auto eq = std::make_unique<Utility>(Utility::Kind::GraphicEQ);
                eq->setControl("graphicMode", 1); eq->setControl("third0", 12);
                processor = std::move(eq);
            }
            processor->setNonRealtime(true); processor->prepareToPlay(rate, 127);
            const int latency = processor->getLatencySamples();
            const double declared = processor->getTailLengthSeconds();
            const int declaredEnd = latency + juce::roundToInt(declared * rate);
            juce::AudioBuffer<float> block(2, 127); juce::MidiBuffer midi;
            double energyAfter = 0; int last = -1; bool finite = true;
            for (int start = 0; start < declaredEnd + juce::roundToInt(rate * .5); start += 127)
            {
                const int count = juce::jmin(127, declaredEnd + juce::roundToInt(rate * .5) - start);
                block.setSize(2, count, false, false, true); block.clear();
                if (start == 0) { block.setSample(0, 0, .25f); block.setSample(1, 0, .25f); }
                processor->processBlock(block, midi);
                for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < count; ++i)
                {
                    const double value = block.getSample(ch, i);
                    finite = finite && std::isfinite(value);
                    if (std::abs(value) > 1e-6) last = juce::jmax(last, start + i);
                    if (start + i > declaredEnd) energyAfter += value * value;
                }
            }
            const bool pass = finite && energyAfter < 1e-12;
            filterTailContract = filterTailContract && pass;
            auto* row = new juce::DynamicObject();
            row->setProperty("processor", kind == 0 ? "Parametric EQ IIR 40 Hz Q30 +12 dB" : "Graphic EQ 31-band 20 Hz +12 dB");
            row->setProperty("sampleRate", rate); row->setProperty("declaredTailSeconds", declared);
            row->setProperty("latencySamples", latency); row->setProperty("energyAfterDeclaredTail", energyAfter);
            row->setProperty("lastSampleAboveMinus120dBFS", last); row->setProperty("captureSamples", declaredEnd + juce::roundToInt(rate * .5));
            row->setProperty("finite", finite); row->setProperty("pass", pass); filterTailCases.add(row);
        }
    result->setProperty("absoluteNoteLabels", noteCases);
    result->setProperty("eqAmplitudeHomogeneity", eqCases);
    result->setProperty("eqLinearityContract", eqLinearity);
    result->setProperty("absoluteNoteContract", absoluteNoteContract);
    result->setProperty("pitchDetectorRange", detectorCases);
    result->setProperty("gainPhaseTail", tailCases);
    result->setProperty("gainPhaseTailContract", tailContract);
    result->setProperty("iirFilterTail", filterTailCases);
    result->setProperty("iirFilterTailContract", filterTailContract);
    result->setProperty("pass", absoluteNoteContract && tailContract && eqLinearity && filterTailContract && hiddenMaskContract);
    return result;
}
