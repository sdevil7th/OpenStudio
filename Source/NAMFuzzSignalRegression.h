#pragma once

#include "BuiltInEffects2.h"
#include "NAMFuzz.h"
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>

// Native-level transfer diagnostics. Deliberately has no reference-pedal or
// subjective quality threshold, and never reads live input or opens a device.
class NAMFuzzSignalRegression final
{
public:
    static juce::var runPartitionSmoke()
    {
        // A bounded default-suite witness for the actual downstream defect.
        // The full profile/voice/mask/gate/oversampling grid remains opt-in.
        const auto source = makeSource(true, -72.0f);
        bool passed = true;
        juce::Array<juce::var> rows;
        for (const int factor : { 2, 4, 8 })
        {
            auto regularRack = makeRack(true, 0, 0.5f, 5, -100.0f, 80.0f, factor);
            auto irregularRack = makeRack(true, 0, 0.5f, 5, -100.0f, 80.0f, factor);
            const auto regular = renderRack(source, *regularRack);
            const auto irregular = renderRack(source, *irregularRack, true);
            auto comparison = partitionDiagnostics(regular, irregular);
            const bool readbackPassed = static_cast<int>(regularRack->getDiagnosticState()["embeddedDriveActiveOversamplingFactor"]) == factor
                && static_cast<int>(irregularRack->getDiagnosticState()["embeddedDriveActiveOversamplingFactor"]) == factor;
            comparison.getDynamicObject()->setProperty("oversamplingFactor", factor);
            comparison.getDynamicObject()->setProperty("activeOversamplingReadbackPassed", readbackPassed);
            passed = readbackPassed && static_cast<bool>(comparison["passed"]) && passed;
            rows.add(comparison);
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("id", "nam_fuzz_gain_stack_partition_smoke");
        result->setProperty("status", passed ? "pass" : "fail");
        result->setProperty("detail", "Bass Vintage Fuzz into Distortion at 2x/4x/8x must remain finite and preserve the seeded noise/played-note output within 1e-5 across fixed 128 and irregular 1/7/16/31/64/127/128 callbacks. These are measured numerical-precision witnesses, not tone-quality assertions.");
        result->setProperty("value", rows);
        return result;
    }
    static juce::Array<juce::var> run()
    {
        juce::Array<juce::var> checks;
        if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_FUZZ_SIGNAL_AUDIT", {}) != "1")
            return checks;
        bool contracts = true;
        juce::Array<juce::var> standalone, lowLevel, cascades;
        for (const bool bass : { false, true })
        for (int voice = 0; voice < 3; ++voice)
        for (const float drive : { 0.0f, 0.25f, 0.5f, 0.75f, 1.0f })
        {
            for (const float tone : { 0.0f, 0.5f, 1.0f })
            for (const float noiseDb : { -90.0f, -72.0f, -54.0f })
            {
                NAMFuzz::Parameters parameters;
                parameters.enabled = true; parameters.bass = bass; parameters.voice = voice;
                parameters.drive = drive; parameters.tone = tone;
                auto source = makeSource(bass, noiseDb);
                auto output = renderFuzz(source, parameters);
                auto row = describe(bass, voice, drive, tone);
                row.getDynamicObject()->setProperty("inputNoiseTargetRmsDbFS", noiseDb);
                row.getDynamicObject()->setProperty("measurements", measure(source, output, contracts));
                standalone.add(row);
            }
            for (const float inputDb : { -72.0f, -48.0f, -24.0f })
            {
                NAMFuzz::Parameters parameters;
                parameters.enabled = true; parameters.bass = bass; parameters.voice = voice;
                parameters.drive = drive; parameters.tone = 0.5f;
                juce::AudioBuffer<float> source(1, static_cast<int>(rate / 2));
                const double frequency = bass ? 55.0 : 220.0;
                const float peak = juce::Decibels::decibelsToGain(inputDb);
                for (int sample = 0; sample < source.getNumSamples(); ++sample)
                    source.setSample(0, sample, peak * static_cast<float>(std::sin(
                        juce::MathConstants<double>::twoPi * frequency * sample / rate)));
                auto output = renderFuzz(source, parameters);
                auto row = describe(bass, voice, drive, 0.5f);
                row.getDynamicObject()->setProperty("frequencyHz", frequency);
                row.getDynamicObject()->setProperty("inputPeakDbFS", inputDb);
                const double inputRms = rms(source, 0.25, 0.5), outputRms = rms(output, 0.25, 0.5);
                row.getDynamicObject()->setProperty("inputRmsDbFS", db(inputRms));
                row.getDynamicObject()->setProperty("outputRmsDbFS", db(outputRms));
                row.getDynamicObject()->setProperty("rmsGainDb", db(outputRms / juce::jmax(1.0e-30, inputRms)));
                row.getDynamicObject()->setProperty("harmonics", harmonics(output, frequency));
                contracts = finite(output) && contracts;
                lowLevel.add(row);
            }
        }
        for (const bool bass : { false, true })
        for (const float drive : { 0.5f, 1.0f })
        for (int mask = 0; mask < 8; ++mask)
        for (int voice = 0; voice < ((mask & 1) != 0 ? 3 : 1); ++voice)
        {
            auto source = makeSource(bass, -72.0f);
            auto rack = makeRack(bass, voice, drive, mask);
            juce::AudioBuffer<float> output; output.makeCopyOf(source);
            juce::MidiBuffer midi;
            for (int start = 0; start < output.getNumSamples(); start += 128)
            {
                float* pointer = output.getWritePointer(0, start);
                juce::AudioBuffer<float> block(&pointer, 1, juce::jmin(128, output.getNumSamples() - start));
                rack->processBlock(block, midi);
            }
            auto row = describe(bass, voice, drive, 0.5f);
            row.getDynamicObject()->setProperty("enabledMaskFuzzDriveDistortion", mask);
            row.getDynamicObject()->setProperty("measurements", measure(source, output, contracts));
            row.getDynamicObject()->setProperty("rackDiagnostics", rack->getDiagnosticState());
            cascades.add(row);
        }
        auto* report = new juce::DynamicObject();
        report->setProperty("sampleRate", rate);
        report->setProperty("standalone", standalone);
        report->setProperty("lowLevelSine", lowLevel);
        report->setProperty("cascades", cascades);
        report->setProperty("calibrationReferenceDbu", 12.0);
        report->setProperty("levelDb", 0.0);
        report->setProperty("cleanMix", 0.0);
        report->setProperty("measurement", "Unweighted native-level RMS/peaks; no normalization, adaptive matching or extra output trim. Manufacturer A-weighted analog dBV noise specifications are not directly comparable.");
        report->setProperty("signal", "250ms digital silence, 500ms seeded uniform noise, 500ms decaying harmonic note plus that noise, 500ms noise, 750ms digital silence. Noise targets are RMS; a shared seed makes before/after reproducible.");
        report->setProperty("scope", "Original three voices, both profiles, Drive at0/.25/.5/.75/1, Tone endpoints/midpoint, three input noise levels, low-level sine transfer with harmonics2..15 and all eight pedal masks. Cascades use 4x Drive/Distortion oversampling, Heavy Distortion mode, gates disabled, no amp/cab/octaves/time effects. This is not a complete amplified guitar rig or every knob combination.");
        auto* contract = new juce::DynamicObject();
        contract->setProperty("id", "nam_fuzz_signal_contracts");
        contract->setProperty("status", contracts ? "pass" : "fail");
        contract->setProperty("detail", "Finite output and exact fresh digital silence are asserted; all noise gain, note envelope, silence decay and cascade measurements remain diagnostic_only.");
        contract->setProperty("value", report);
        checks.add(contract);
        auto* diagnostic = new juce::DynamicObject();
        diagnostic->setProperty("id", "nam_fuzz_noise_and_transfer_measurements");
        diagnostic->setProperty("status", "diagnostic_only");
        diagnostic->setProperty("detail", "Input-noise amplification, compression, bright harmonics and downstream saturation require interpretation and exact-artifact audition. No noise threshold or pedal resemblance is certified.");
        checks.add(diagnostic);
        checks.addArray(globalGateContracts());
        return checks;
    }

private:
    static constexpr double rate = 48000.0;
    static juce::var describe(bool bass, int voice, float drive, float tone)
    {
        auto* result = new juce::DynamicObject();
        result->setProperty("bass", bass); result->setProperty("voice", voice);
        result->setProperty("drive", drive); result->setProperty("tone", tone);
        return result;
    }
    static bool finite(const juce::AudioBuffer<float>& buffer)
    {
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            if (!std::isfinite(buffer.getSample(0, sample))) return false;
        return true;
    }
    static double rms(const juce::AudioBuffer<float>& buffer, double from, double to)
    {
        const int begin = static_cast<int>(from * rate), end = juce::jmin(buffer.getNumSamples(), static_cast<int>(to * rate));
        double sum = 0.0;
        for (int sample = begin; sample < end; ++sample)
        { const double value = buffer.getSample(0, sample); sum += value * value; }
        return std::sqrt(sum / juce::jmax(1, end - begin));
    }
    static double db(double value) { return 20.0 * std::log10(juce::jmax(1.0e-15, value)); }
    static juce::var harmonics(const juce::AudioBuffer<float>& buffer, double frequency)
    {
        // The final 200ms contain exactly 11/44 periods at55/220Hz. No taper,
        // gain fitting or phase alignment is needed for harmonic magnitudes.
        constexpr int begin = 14400, count = 9600;
        double fundamentalPower = 0.0, harmonicPower = 0.0;
        juce::Array<juce::var> amplitudes;
        for (int harmonic = 1; harmonic <= 15; ++harmonic)
        {
            double real = 0.0, imaginary = 0.0;
            for (int sample = 0; sample < count; ++sample)
            {
                const double phase = juce::MathConstants<double>::twoPi * frequency * harmonic * sample / rate;
                const double value = buffer.getSample(0, begin + sample);
                real += value * std::cos(phase); imaginary += value * std::sin(phase);
            }
            const double amplitude = 2.0 * std::sqrt(real * real + imaginary * imaginary) / count;
            amplitudes.add(db(amplitude));
            if (harmonic == 1) fundamentalPower = amplitude * amplitude;
            else harmonicPower += amplitude * amplitude;
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("peakDbFSByHarmonic1Through15", amplitudes);
        result->setProperty("fundamentalPresent", fundamentalPower > 1.0e-24);
        if (fundamentalPower > 1.0e-24)
            result->setProperty("harmonics2Through15OverFundamentalDb", db(std::sqrt(harmonicPower / fundamentalPower)));
        result->setProperty("interpretation", "diagnostic_only: spectral transfer character, not an aliasing measurement or a fuzz-quality score.");
        return result;
    }
    static juce::AudioBuffer<float> makeSource(bool bass, float noiseDb)
    {
        juce::AudioBuffer<float> result(1, static_cast<int>(2.5 * rate)); result.clear();
        std::uint32_t seed = 0x8a5cd789u;
        const double noiseScale = std::sqrt(3.0) * juce::Decibels::decibelsToGain(noiseDb);
        for (int sample = 12000; sample < 84000; ++sample)
        {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
            double value = (static_cast<double>(seed) / 2147483648.0 - 1.0) * noiseScale;
            if (sample >= 36000 && sample < 60000)
            {
                const double time = (sample - 36000) / rate;
                const double phase = juce::MathConstants<double>::twoPi * (bass ? 55.0 : 220.0) * time;
                value += juce::Decibels::decibelsToGain(-18.0) * (1.0 - std::exp(-time / 0.002))
                    * std::exp(-time / 0.18) * (std::sin(phase) + 0.25 * std::sin(2.0 * phase)
                        + 0.12 * std::sin(3.0 * phase));
            }
            result.setSample(0, sample, static_cast<float>(value));
        }
        return result;
    }
    static juce::AudioBuffer<float> renderFuzz(const juce::AudioBuffer<float>& source,
        const NAMFuzz::Parameters& parameters, bool irregular = false)
    {
        juce::AudioBuffer<float> result; result.makeCopyOf(source);
        NAMFuzz fuzz; fuzz.prepare(rate, parameters);
        constexpr std::array<int, 7> partition { 1, 7, 16, 31, 64, 127, 128 };
        size_t partitionIndex = 0;
        for (int start = 0; start < result.getNumSamples();)
        {
            const int count = juce::jmin(result.getNumSamples() - start,
                irregular ? partition[partitionIndex++ % partition.size()] : 128);
            float* pointer = result.getWritePointer(0, start);
            juce::AudioBuffer<float> block(&pointer, 1, count);
            fuzz.processBlock(block);
            start += count;
        }
        return result;
    }
    static juce::var measure(const juce::AudioBuffer<float>& input, const juce::AudioBuffer<float>& output, bool& contracts)
    {
        const bool valid = finite(output);
        const float initialSilencePeak = output.getMagnitude(0, 12000);
        contracts = valid && initialSilencePeak == 0.0f && contracts;
        auto* result = new juce::DynamicObject();
        result->setProperty("finite", valid); result->setProperty("initialSilencePeak", initialSilencePeak);
        result->setProperty("peakDbFS", db(output.getMagnitude(0, output.getNumSamples())));
        for (const auto& window : std::array<std::array<double, 2>, 5> {{{0.5, 0.75}, {0.76, 0.85}, {1.1, 1.25}, {1.5, 1.75}, {2.3, 2.5}}})
        {
            const auto label = "window" + juce::String(window[0], 2) + "To" + juce::String(window[1], 2);
            const double inputRms = rms(input, window[0], window[1]);
            const double outputRms = rms(output, window[0], window[1]);
            auto* reading = new juce::DynamicObject();
            reading->setProperty("inputRmsDbFS", db(inputRms)); reading->setProperty("outputRmsDbFS", db(outputRms));
            if (inputRms > 0.0) reading->setProperty("rmsGainDb", db(outputRms / inputRms));
            result->setProperty(label, reading);
        }
        return result;
    }
    static juce::AudioBuffer<float> renderRack(const juce::AudioBuffer<float>& source,
        OpenStudioNAMRack& rack, bool irregular = false)
    {
        juce::AudioBuffer<float> result; result.makeCopyOf(source);
        juce::MidiBuffer midi;
        constexpr std::array<int, 7> partition { 1, 7, 16, 31, 64, 127, 128 };
        int position = 0;
        size_t partitionIndex = 0;
        while (position < result.getNumSamples())
        {
            const int count = juce::jmin(result.getNumSamples() - position,
                irregular ? partition[partitionIndex++ % partition.size()] : 128);
            float* pointer = result.getWritePointer(0, position);
            juce::AudioBuffer<float> block(&pointer, 1, count);
            rack.processBlock(block, midi);
            position += count;
        }
        return result;
    }
    static juce::var partitionDiagnostics(const juce::AudioBuffer<float>& regular,
        const juce::AudioBuffer<float>& irregular)
    {
        double maximum = 0.0;
        int maximumSample = -1, firstAboveTolerance = -1, lastAboveTolerance = -1, countAboveTolerance = 0;
        std::array<double, 4> windowMaxima {};
        for (int sample = 0; sample < regular.getNumSamples(); ++sample)
        {
            const double difference = std::abs(static_cast<double>(regular.getSample(0, sample))
                - irregular.getSample(0, sample));
            if (difference > maximum) { maximum = difference; maximumSample = sample; }
            const size_t window = sample < 12000 ? 0 : sample < 36000 ? 1 : sample < 60000 ? 2 : 3;
            windowMaxima[window] = juce::jmax(windowMaxima[window], difference);
            if (difference > 1.0e-5)
            {
                if (firstAboveTolerance < 0) firstAboveTolerance = sample;
                lastAboveTolerance = sample; ++countAboveTolerance;
            }
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("maximumDifference", maximum);
        result->setProperty("maximumDifferenceSample", maximumSample);
        result->setProperty("maximumDifferenceSeconds", maximumSample / rate);
        result->setProperty("firstSampleAbove1eMinus5", firstAboveTolerance);
        result->setProperty("lastSampleAbove1eMinus5", lastAboveTolerance);
        result->setProperty("samplesAbove1eMinus5", countAboveTolerance);
        result->setProperty("digitalSilenceMaximumDifference", windowMaxima[0]);
        result->setProperty("preNoteNoiseMaximumDifference", windowMaxima[1]);
        result->setProperty("playedNoteMaximumDifference", windowMaxima[2]);
        result->setProperty("postNoteNoiseMaximumDifference", windowMaxima[3]);
        result->setProperty("finite", finite(regular) && finite(irregular));
        result->setProperty("passed", finite(regular) && finite(irregular) && maximum < 1.0e-5);
        return result;
    }
    static juce::Array<juce::var> globalGateContracts()
    {
        juce::Array<juce::var> checks, rows, partitionRows, localization;
        bool passed = true, partitionPassed = true;
        for (const bool bass : { false, true })
        {
            // Retain the same note and noise seed as the transfer fixture,
            // then continue noise long enough to observe the slow release.
            const auto original = makeSource(bass, -72.0f);
            juce::AudioBuffer<float> source(1, static_cast<int>(3.0 * rate));
            source.copyFrom(0, 0, original, 0, 0, original.getNumSamples());
            for (int sample = 84000; sample < source.getNumSamples(); ++sample)
                source.setSample(0, sample, original.getSample(0, 12000 + (sample - 84000) % 24000));
            for (int mask = 0; mask < 8; ++mask)
            for (int voice = 0; voice < ((mask & 1) != 0 ? 3 : 1); ++voice)
            {
                auto ungatedRack = makeRack(bass, voice, 0.5f, mask);
                const auto ungated = renderRack(source, *ungatedRack);
                auto irregularUngatedRack = makeRack(bass, voice, 0.5f, mask);
                const auto irregularUngated = renderRack(source, *irregularUngatedRack, true);
                auto partitionRow = describe(bass, voice, 0.5f, 0.5f);
                partitionRow.getDynamicObject()->setProperty("enabledMaskFuzzDriveDistortion", mask);
                const auto partitionEvidence = partitionDiagnostics(ungated, irregularUngated);
                partitionRow.getDynamicObject()->setProperty("comparison", partitionEvidence);
                partitionPassed = static_cast<bool>(partitionEvidence["passed"]) && partitionPassed;
                partitionRows.add(partitionRow);
                auto openRack = makeRack(bass, voice, 0.5f, mask, -80.0f, 80.0f);
                const auto open = renderRack(source, *openRack);
                for (const float releaseMs : { 20.0f, 180.0f })
                {
                    auto closedRack = makeRack(bass, voice, 0.5f, mask, -60.0f, releaseMs);
                    const auto closed = renderRack(source, *closedRack);
                    auto partitionedRack = makeRack(bass, voice, 0.5f, mask, -60.0f, releaseMs);
                    const auto partitioned = renderRack(source, *partitionedRack, true);
                    const double referenceNoise = rms(ungated, 2.75, 3.0);
                    const double closedNoise = rms(closed, 2.75, 3.0);
                    const double openNoise = rms(open, 2.75, 3.0);
                    const double referenceNote = rms(ungated, 1.1, 1.2);
                    const double closedNote = rms(closed, 1.1, 1.2);
                    double maximumPartitionDifference = 0.0, maximumUngatedPartitionDifference = 0.0;
                    double maximumGateEnvelopePartitionDifference = 0.0, maximumReleaseStep = 0.0;
                    double previousRatio = 1.0;
                    int previousSample = 60000, releaseSamples = 0, envelopeComparisonSamples = 0;
                    int crossed90 = -1, crossed10 = -1;
                    bool ratiosBounded = true;
                    for (int sample = 0; sample < source.getNumSamples(); ++sample)
                    {
                        maximumPartitionDifference = juce::jmax(maximumPartitionDifference,
                            std::abs(static_cast<double>(closed.getSample(0, sample)) - partitioned.getSample(0, sample)));
                        const double reference = ungated.getSample(0, sample);
                        const double irregularReference = irregularUngated.getSample(0, sample);
                        maximumUngatedPartitionDifference = juce::jmax(maximumUngatedPartitionDifference,
                            std::abs(reference - irregularReference));
                        if (std::abs(reference) >= 1.0e-5 && std::abs(irregularReference) >= 1.0e-5)
                        {
                            // Reconstruct each gate envelope against the same
                            // callback layout. The nonlinear stack's own raw
                            // partition differences are reported separately;
                            // they must not be mistaken for a gate discontinuity.
                            maximumGateEnvelopePartitionDifference = juce::jmax(maximumGateEnvelopePartitionDifference,
                                std::abs(closed.getSample(0, sample) / reference
                                    - partitioned.getSample(0, sample) / irregularReference));
                            ++envelopeComparisonSamples;
                        }
                        if (sample < 60000 || std::abs(reference) < 1.0e-5) continue;
                        const double ratio = closed.getSample(0, sample) / reference;
                        ratiosBounded = ratiosBounded && ratio >= -1.0e-4 && ratio <= 1.0001;
                        if (previousSample < sample)
                            maximumReleaseStep = juce::jmax(maximumReleaseStep,
                                std::abs(ratio - previousRatio) / (sample - previousSample));
                        if (crossed90 < 0 && ratio < 0.9) crossed90 = sample;
                        if (crossed90 >= 0 && crossed10 < 0 && ratio < 0.1) crossed10 = sample;
                        previousRatio = ratio; previousSample = sample; ++releaseSamples;
                    }
                    const double fadeMilliseconds = crossed90 >= 0 && crossed10 >= crossed90
                        ? 1000.0 * (crossed10 - crossed90) / rate : -1.0;
                    // Gated Fuzz can itself silence the fixture. Its internal
                    // gate is a legitimate zero reference, not evidence that
                    // the global gate attenuated an audible downstream stack.
                    const bool observableIdle = referenceNoise > 1.0e-12;
                    const bool idleControlled = !observableIdle || closedNoise < referenceNoise * 0.01;
                    const bool belowNoiseThresholdOpen = !observableIdle
                        || std::abs(openNoise / referenceNoise - 1.0) < 1.0e-4;
                    const bool noteOpened = referenceNote > 1.0e-6
                        && std::abs(closedNote / referenceNote - 1.0) < 1.0e-4;
                    const bool observableRelease = releaseSamples > 1000 && crossed90 >= 0 && crossed10 >= 0;
                    const bool releaseContinuous = !observableIdle || (observableRelease && ratiosBounded
                        && maximumReleaseStep < 2.0 / (rate * releaseMs * 0.001) + 2.0e-4
                        && fadeMilliseconds > 1.5 * releaseMs && fadeMilliseconds < 3.0 * releaseMs);
                    const bool rowPassed = finite(ungated) && finite(irregularUngated)
                        && finite(closed) && finite(open) && finite(partitioned)
                        && idleControlled && belowNoiseThresholdOpen && noteOpened && releaseContinuous
                        && envelopeComparisonSamples > 1000 && maximumGateEnvelopePartitionDifference < 1.0e-5;
                    passed = rowPassed && passed;
                    auto row = describe(bass, voice, 0.5f, 0.5f);
                    auto* value = row.getDynamicObject();
                    value->setProperty("enabledMaskFuzzDriveDistortion", mask);
                    value->setProperty("releaseMs", releaseMs); value->setProperty("passed", rowPassed);
                    value->setProperty("ungatedIdleRmsDbFS", db(referenceNoise));
                    value->setProperty("thresholdMinus80IdleRmsDbFS", db(openNoise));
                    value->setProperty("thresholdMinus60IdleRmsDbFS", db(closedNoise));
                    value->setProperty("idleAttenuationObservable", observableIdle);
                    value->setProperty("idleControlled", idleControlled);
                    value->setProperty("belowNoiseThresholdOpen", belowNoiseThresholdOpen);
                    value->setProperty("noteOpened", noteOpened);
                    value->setProperty("ungatedLateNoteRmsDbFS", db(referenceNote));
                    value->setProperty("gatedLateNoteRmsDbFS", db(closedNote));
                    value->setProperty("releaseObservable", observableRelease);
                    value->setProperty("releaseContinuous", releaseContinuous);
                    value->setProperty("release90To10Milliseconds", fadeMilliseconds);
                    value->setProperty("maximumReleaseGainStepPerSample", maximumReleaseStep);
                    value->setProperty("maximumPartitionDifference", maximumPartitionDifference);
                    value->setProperty("maximumUngatedPartitionDifference", maximumUngatedPartitionDifference);
                    value->setProperty("gateEnvelopeComparisonSamples", envelopeComparisonSamples);
                    value->setProperty("maximumGateEnvelopePartitionDifference", maximumGateEnvelopePartitionDifference);
                    value->setProperty("rawPartitionDifferenceInterpretation", "diagnostic_only: raw whole-rack partition differences include nonlinear gain-pedal processing. Gate-envelope parity is independently checked against each matching ungated callback layout.");
                    rows.add(row);
                }
            }
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("id", "nam_fuzz_explicit_global_gate_contracts");
        result->setProperty("status", passed ? "pass" : "fail");
        result->setProperty("detail", "All eight gain-pedal masks, active Fuzz voices and both profiles use seeded -72 dBFS RMS noise. Explicit threshold -60 is above its peak; threshold -80 remains open. Both Release20/180ms must preserve an above-threshold late note, attenuate observable steady idle by at least40dB, close continuously and preserve the gate envelope across irregular callbacks. Already-silent Gated voice cases do not prove idle attenuation or release. Raw whole-rack partition differences remain diagnostic_only. This verifies existing gate behavior, not subjective sustain or tone quality.");
        result->setProperty("value", rows);
        checks.add(result);

        // Keep the independently discovered whole-rack partition requirement
        // visible. Localize its worst fixture without altering the production
        // path: fixed prepared Fuzz audio distinguishes its state from the
        // downstream island. Exercise every supported shared oversampling rate.
        const auto source = makeSource(true, -72.0f);
        NAMFuzz::Parameters parameters; parameters.enabled = true; parameters.bass = true;
        const auto fuzzAudio = renderFuzz(source, parameters);
        const auto irregularFuzzAudio = renderFuzz(source, parameters, true);
        auto fuzzComparison = partitionDiagnostics(fuzzAudio, irregularFuzzAudio);
        fuzzComparison.getDynamicObject()->setProperty("route", "standalone_bass_vintage_fuzz");
        localization.add(fuzzComparison);
        partitionPassed = static_cast<bool>(fuzzComparison["passed"]) && partitionPassed;
        for (const int oversampling : { 2, 4, 8 })
        for (const bool prerenderedFuzz : { false, true })
        {
            const auto& input = prerenderedFuzz ? fuzzAudio : source;
            const int mask = prerenderedFuzz ? 4 : 5;
            auto regularRack = makeRack(true, 0, 0.5f, mask, -100.0f, 80.0f, oversampling);
            auto irregularRack = makeRack(true, 0, 0.5f, mask, -100.0f, 80.0f, oversampling);
            const auto regular = renderRack(input, *regularRack);
            const auto irregular = renderRack(input, *irregularRack, true);
            auto comparison = partitionDiagnostics(regular, irregular);
            comparison.getDynamicObject()->setProperty("route", prerenderedFuzz
                ? "identical_prerendered_fuzz_into_distortion_only" : "rack_fuzz_into_distortion");
            const int regularActive = static_cast<int>(regularRack->getDiagnosticState()["embeddedDriveActiveOversamplingFactor"]);
            const int irregularActive = static_cast<int>(irregularRack->getDiagnosticState()["embeddedDriveActiveOversamplingFactor"]);
            const bool readbackPassed = regularRack->getEmbeddedDriveOversamplingFactor() == oversampling
                && irregularRack->getEmbeddedDriveOversamplingFactor() == oversampling
                && regularActive == oversampling && irregularActive == oversampling;
            comparison.getDynamicObject()->setProperty("requestedEmbeddedOversamplingFactor", oversampling);
            comparison.getDynamicObject()->setProperty("regularActiveOversamplingFactor", regularActive);
            comparison.getDynamicObject()->setProperty("irregularActiveOversamplingFactor", irregularActive);
            comparison.getDynamicObject()->setProperty("oversamplingReadbackPassed", readbackPassed);
            localization.add(comparison);
            partitionPassed = readbackPassed && static_cast<bool>(comparison["passed"]) && partitionPassed;
        }
        auto* partitionResult = new juce::DynamicObject();
        partitionResult->setProperty("id", "nam_fuzz_gain_stack_partition_contracts");
        partitionResult->setProperty("status", partitionPassed ? "pass" : "fail");
        partitionResult->setProperty("detail", "Fixed128 versus irregular1/7/16/31/64/127/128 callbacks must preserve native gain-stack output within1e-5. This requirement is separate from the clean-keyed global gate. Maxima and exact frame windows identify whether differences occur during silence, played notes or idle noise; localization keeps one identical prepared Fuzz input for downstream isolation. No preferred tone or alias audibility is asserted.");
        auto* partitionValue = new juce::DynamicObject();
        partitionValue->setProperty("allGainMasks", partitionRows);
        partitionValue->setProperty("bassVintageDistortionLocalization", localization);
        partitionResult->setProperty("value", partitionValue);
        checks.add(partitionResult);
        return checks;
    }
    static std::unique_ptr<OpenStudioNAMRack> makeRack(bool bass, int voice, float drive, int mask,
        float gateThresholdDb = -100.0f, float gateReleaseMs = 80.0f, int oversamplingFactor = 4)
    {
        auto rack = std::make_unique<OpenStudioNAMRack>();
        rack->setRoutedInputChannelCount(1); rack->instrumentProfile.store(bass ? 1.0f : 0.0f);
        rack->calibrationReferenceDbu.store(12.0f); rack->inputTrimDb.store(0.0f); rack->outputTrimDb.store(0.0f);
        rack->gateThresholdDb.store(gateThresholdDb); rack->gateReleaseMs.store(gateReleaseMs);
        rack->compressorEnabled.store(0.0f); rack->octaverEnabled.store(0.0f);
        rack->fuzzEnabled.store((mask & 1) != 0 ? 1.0f : 0.0f); rack->fuzzVoice.store(static_cast<float>(voice));
        rack->fuzzDrive.store(drive); rack->fuzzTone.store(0.5f); rack->fuzzLevelDb.store(0.0f); rack->fuzzCleanMix.store(0.0f);
        rack->preEqEnabled.store(0.0f); rack->setEmbeddedDriveOversamplingFactor(oversamplingFactor);
        rack->precisionDriveEnabled.store((mask & 2) != 0 ? 1.0f : 0.0f);
        rack->precisionDriveDrive.store(drive); rack->precisionDriveGate.store(0.0f); rack->precisionDriveVolumeDb.store(0.0f);
        rack->chaosEnabled.store((mask & 4) != 0 ? 1.0f : 0.0f); rack->chaosMode.store(0.0f);
        rack->chaosDrive.store(drive); rack->chaosTone.store(0.5f); rack->chaosGate.store(0.0f);
        rack->chaosMix.store(1.0f); rack->chaosLevelDb.store(0.0f); rack->pedalMix.store(0.0f);
        rack->ampEnabled.store(0.0f); rack->setCabRequestedEnabled(false); rack->eqEnabled.store(0.0f);
        rack->chorusMix.store(0.0f); rack->modulatorEnabled.store(0.0f); rack->delayEnabled.store(0.0f);
        rack->reverbEnabled.store(0.0f); rack->auditionSource.store(0.0f);
        rack->setPlayConfigDetails(1, 1, rate, 128); rack->prepareToPlay(rate, 128);
        return rack;
    }
};
