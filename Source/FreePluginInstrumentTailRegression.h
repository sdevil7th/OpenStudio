#pragma once

#include "BuiltInInstrumentTail.h"

inline juce::var checkInstrumentReleaseTails()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Instrument finite release tail contracts");
    juce::Array<juce::var> rows;
    bool passed = true, floatBoundPassed = true;

    // Independent sample-by-sample exhaustion of the unchanged float envelope.
    // In particular 5 s * 16 is not exactly 80 s after millions of subtractions.
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (float release : {5.0f, 80.0f, 180.0f, 950.0f, 2000.0f, 5000.0f})
            for (float speed : {1.0f, .25f, .0625f})
            {
                const double bound = BuiltInInstrumentTail::linearRelease(rate, release, speed);
                const float step = (1.0f / juce::jmax(1.0f, static_cast<float>(rate) * release * .001f)) * speed;
                float envelope = 1;
                const auto limit = static_cast<juce::int64>(std::ceil(bound * rate));
                juce::int64 samples = 0;
                while (envelope > 0 && samples <= limit)
                {
                    envelope = juce::jmax(0.0f, envelope - step);
                    ++samples;
                }
                floatBoundPassed = floatBoundPassed && envelope == 0 && samples <= limit;
            }

    // Tail silence is defined independently of the declared duration: all
    // channels below -120 dBFS for 500 ms following note-off / pedal release.
    // This is an output-decay contract, not an acoustic quality assessment.
    const auto render = [&] (int kind, double rate, int blockSize, int scenario)
    {
        std::unique_ptr<juce::AudioProcessor> processor;
        const bool maximumRelease = scenario != 0;
        const bool matrix = scenario == 2 || scenario == 3;
        const bool body = scenario == 4;
        const bool automated = scenario == 5;
        const bool pedals = scenario == 6;
        const auto setup = [&] (auto& instrument, float maximum)
        {
            if (maximumRelease && !automated) instrument.releaseMs.store(maximum);
        };
        if (kind == 0)
        {
            auto synth = std::make_unique<OpenStudioBasicSynthInstrument>();
            setup(*synth, 5000);
            synth->sustain.store(1);
            synth->noiseLevel.store(0);
            if (matrix)
            {
                synth->releaseMs.store(scenario == 2 ? 80.0f : 5000.0f);
                synth->matrix8Source.store(1); // Unit-velocity note -> constant +1.
                synth->matrix8Target.store(13);
                synth->matrix8Amount.store(1);
            }
            processor = std::move(synth);
        }
        else if (kind == 1)
        {
            auto piano = std::make_unique<OpenStudioPianoInstrument>();
            setup(*piano, 5000);
            piano->performanceMode.store(1);
            piano->releaseVelocity.store(1); // Zero note-off velocity -> slowest .25.
            piano->body.store(1);
            if (body) { piano->coupledBody.store(1); piano->bodyDecay.store(8); }
            processor = std::move(piano);
        }
        else
        {
            auto guitar = std::make_unique<OpenStudioCleanGuitarInstrument>();
            setup(*guitar, 2000);
            guitar->stringMode.store(0);
            guitar->chorusMix.store(1);
            guitar->chorusDepth.store(6);
            if (body)
            {
                guitar->stringEngine.store(1);
                guitar->coupledBody.store(1);
                guitar->bodyDecay.store(8);
            }
            processor = std::move(guitar);
        }
        processor->prepareToPlay(rate, blockSize);
        const auto maximumTail = [&]
        {
            if (auto* synth = dynamic_cast<OpenStudioBasicSynthInstrument*>(processor.get())) return synth->getMaximumTailLengthSeconds();
            if (auto* piano = dynamic_cast<OpenStudioPianoInstrument*>(processor.get())) return piano->getMaximumTailLengthSeconds();
            return dynamic_cast<OpenStudioCleanGuitarInstrument*>(processor.get())->getMaximumTailLengthSeconds();
        };
        juce::MemoryBlock beforeQuery, afterQuery;
        processor->getStateInformation(beforeQuery);
        const double declared = automated ? maximumTail() : processor->getTailLengthSeconds();
        processor->getStateInformation(afterQuery);
        const bool queryPreservesState = beforeQuery == afterQuery;
        const int boundary = juce::roundToInt(rate * .125);
        const int automationAt = juce::roundToInt(rate * .05);
        const int declaredEnd = boundary + static_cast<int>(std::ceil(declared * rate));
        const int end = declaredEnd + juce::roundToInt(rate * .6);
        const int silenceWindow = juce::roundToInt(rate * .5);
        juce::AudioBuffer<float> block(2, blockSize);
        juce::MidiBuffer events, midi;
        events.addEvent(juce::MidiMessage::noteOn(1, kind == 2 ? 52 : 60, 1.0f), 0);
        if (pedals)
        {
            events.addEvent(juce::MidiMessage::controllerEvent(1, 64, 127), 1);
            events.addEvent(juce::MidiMessage::controllerEvent(1, 66, 127), 2);
            events.addEvent(juce::MidiMessage::noteOff(1, kind == 2 ? 52 : 60), boundary / 2);
        }
        events.addEvent(juce::MidiMessage::controllerEvent(1, 64, 0), boundary);
        events.addEvent(juce::MidiMessage::controllerEvent(1, 66, 0), boundary);
        if (!pedals) events.addEvent(juce::MidiMessage::noteOff(1, kind == 2 ? 52 : 60), boundary);
        int lastAudible = -1, consecutiveSilent = 0, rendered = 0;
        float latePeak = 0, afterDeclaredPeak = 0, totalPeak = 0;
        bool finite = true;
        const double formerTail = kind == 0 ? 2.0 : kind == 1 ? 4.0 : 1.5;
        for (int start = 0; start < end;)
        {
            int count = juce::jmin(blockSize, end - start);
            if (automated && start < automationAt) count = juce::jmin(count, automationAt - start);
            if (automated && start == automationAt)
            {
                if (auto* synth = dynamic_cast<OpenStudioBasicSynthInstrument*>(processor.get()))
                {
                    synth->releaseMs.store(5000);
                    synth->matrix8Source.store(1);
                    synth->matrix8Target.store(13);
                    synth->matrix8Amount.store(1);
                }
                else if (auto* piano = dynamic_cast<OpenStudioPianoInstrument*>(processor.get())) piano->releaseMs.store(5000);
                else dynamic_cast<OpenStudioCleanGuitarInstrument*>(processor.get())->releaseMs.store(2000);
            }
            block.setSize(2, count, false, false, true);
            midi.clear();
            midi.addEvents(events, start, count, -start);
            processor->processBlock(block, midi);
            for (int sample = 0; sample < count; ++sample)
            {
                const int position = start + sample;
                float peak = 0;
                for (int channel = 0; channel < 2; ++channel)
                {
                    const float value = block.getSample(channel, sample);
                    finite = finite && std::isfinite(value);
                    peak = juce::jmax(peak, std::abs(value));
                }
                totalPeak = juce::jmax(totalPeak, peak);
                if (position >= boundary + formerTail * rate) latePeak = juce::jmax(latePeak, peak);
                if (position >= declaredEnd) afterDeclaredPeak = juce::jmax(afterDeclaredPeak, peak);
                if (position >= boundary)
                {
                    if (peak > 1e-6f) { lastAudible = position; consecutiveSilent = 0; }
                    else ++consecutiveSilent;
                }
            }
            start += count;
            rendered = start;
            if (consecutiveSilent >= silenceWindow) break;
        }
        const bool silence = consecutiveSilent >= silenceWindow && afterDeclaredPeak <= 1e-6f
            && lastAudible < declaredEnd;
        const bool fixtureExposesOldTruncation = scenario != 1 || latePeak > 1e-6f;
        const bool rowPass = finite && totalPeak > .001f && silence && queryPreservesState
            && fixtureExposesOldTruncation;
        passed = passed && rowPass;
        auto* row = new juce::DynamicObject();
        row->setProperty("instrument", kind == 0 ? "synth" : kind == 1 ? "piano" : "guitar");
        row->setProperty("scenario", scenario);
        row->setProperty("sampleRate", rate);
        row->setProperty("blockSize", blockSize);
        row->setProperty("declaredTailSeconds", declared);
        row->setProperty("lastAudibleSecondsAfterRelease", (lastAudible - boundary) / rate);
        row->setProperty("observedSilenceSeconds", consecutiveSilent / rate);
        row->setProperty("renderedSeconds", rendered / rate);
        row->setProperty("peakAfterFormerFixedTail", latePeak);
        row->setProperty("peakAfterDeclaredTail", afterDeclaredPeak);
        row->setProperty("queryPreservesSavedState", queryPreservesState);
        row->setProperty("pass", rowPass);
        rows.add(row);
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (int kind = 0; kind < 3; ++kind)
        {
            render(kind, rate, 127, 0);
            render(kind, rate, 512, 1);
        }
        render(0, rate, 127, 2);
    }
    render(0, 48000, 512, 3);
    for (int kind = 0; kind < 3; ++kind)
    {
        if (kind > 0) render(kind, 48000, 512, 4);
        render(kind, 48000, 512, 5);
        render(kind, 48000, 127, 6);
    }
    result->setProperty("cases", rows);
    result->setProperty("floatEnvelopeBound72Cases", floatBoundPassed);
    result->setProperty("pass", passed && floatBoundPassed);
    result->setProperty("silenceThresholdDbFS", -120);
    result->setProperty("silenceWindowSeconds", .5);
    result->setProperty("scope", "Processor release, modulation, pedal-off, parameter automation bound and additive body tails; actual host export is a separate regression");
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
