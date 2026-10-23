#pragma once

#include "BuiltInEffects2.h"
#include "NAMNonlinearAliasAnalysis.h"
#include <array>
#include <memory>

// Optional, offline production-Rack measurements. Neither a circuit reference
// nor an audible-quality oracle: rate-dependent filters, ADAA and envelopes
// also contribute to high-rate complex residuals.
class NAMFuzzAliasRegression final
{
public:
    static juce::Array<juce::var> run()
    {
        juce::Array<juce::var> checks;
        if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_FUZZ_ALIAS", {}) != "1")
            return checks;

        const NAMNonlinearAliasAnalysis reference4(4), reference2(2);
        juce::Array<juce::var> cases, factors, convergence, controls;
        bool integrityPassed = true, controlsPassed = true, inactiveFactorPassed = true;
        int inactiveFactorComparisons = 0;
        float maximumInactiveFactorDifference = 0.0f;
        const auto started = juce::Time::getMillisecondCounterHiRes();
        for (double rate : { 44100.0, 48000.0, 96000.0 })
        {
            const auto sourceHigh = makeSource(rate, 4);
            const auto sourceBase = reference4.decimate(sourceHigh);
            const auto sourceIntermediate = makeSource(rate, 2);
            controls.add(measurementControls(rate, sourceHigh, sourceBase,
                                            reference4, controlsPassed));
            for (bool bass : { false, true })
            for (int voice = 0; voice < 3; ++voice)
            for (int topology = 0; topology < 8; ++topology)
            {
                const auto high = render(rate * 4.0, 8, sourceHigh, bass, voice, topology);
                const auto reference = reference4.decimate(high.audio);
                const auto device = render(rate, 4, sourceBase, bass, voice, topology);
                const double advance = device.latencySamples - high.latencySamples / 4.0;
                const auto residual = NAMNonlinearAliasAnalysis::measureAlignedResidual(
                    device.audio, reference, rate, advance, occupiedStride);
                const bool valid = high.integrityPassed && device.integrityPassed && residual.finite;
                integrityPassed = integrityPassed && valid;
                auto row = describe(rate, bass, voice, topology, 4, residual);
                addPeriodDiagnostics(row, device.audio, reference, rate, residual);
                row.getDynamicObject()->setProperty("deviceIntegrity", device.diagnostics);
                row.getDynamicObject()->setProperty("referenceIntegrity", high.diagnostics);
                row.getDynamicObject()->setProperty("measurementIntegrityPassed", valid);
                cases.add(row);

                // All three voices/profiles/rates get a reference convergence
                // witness and Drive factor comparison in the complete cascade.
                if (topology == 7)
                {
                    const auto intermediate = render(rate * 2.0, 8, sourceIntermediate,
                                                     bass, voice, topology);
                    const auto intermediateBase = reference2.decimate(intermediate.audio);
                    const auto residual2 = NAMNonlinearAliasAnalysis::measureAlignedResidual(
                        intermediateBase, reference, rate,
                        intermediate.latencySamples / 2.0 - high.latencySamples / 4.0,
                        occupiedStride);
                    auto converged = describe(rate, bass, voice, topology, 8, residual2);
                    addPeriodDiagnostics(converged, intermediateBase, reference, rate, residual2);
                    converged.getDynamicObject()->setProperty("comparison", "2x-host versus 4x-host reference, both with 8x downstream Drive oversampling");
                    converged.getDynamicObject()->setProperty("lowerReferenceIntegrity", intermediate.diagnostics);
                    convergence.add(converged);
                    integrityPassed = integrityPassed && intermediate.integrityPassed && residual2.finite;
                }
                if (topology == 0 || topology == 7)
                    for (int factor : { 2, 8 })
                    {
                        const auto changed = render(rate, factor, sourceBase, bass, voice, topology);
                        integrityPassed = integrityPassed && changed.integrityPassed;
                        if (topology == 0)
                        {
                            float maximumDifference = 0.0f;
                            const int size = static_cast<int>(device.audio.size());
                            const int deviceOffset = juce::jlimit(0, size, device.latencySamples);
                            const int changedOffset = juce::jlimit(0, size, changed.latencySamples);
                            const int commonSamples = size - juce::jmax(deviceOffset, changedOffset);
                            for (int sample = 0; sample < commonSamples; ++sample)
                                maximumDifference = juce::jmax(maximumDifference,
                                    std::abs(device.audio[static_cast<size_t>(sample + deviceOffset)]
                                        - changed.audio[static_cast<size_t>(sample + changedOffset)]));
                            maximumInactiveFactorDifference = juce::jmax(
                                maximumInactiveFactorDifference, maximumDifference);
                            inactiveFactorPassed = inactiveFactorPassed && maximumDifference == 0.0f
                                && commonSamples > 0 && deviceOffset == device.latencySamples
                                && changedOffset == changed.latencySamples;
                            ++inactiveFactorComparisons;
                        }
                        else
                        {
                            const auto changedResidual = NAMNonlinearAliasAnalysis::measureAlignedResidual(
                                changed.audio, reference, rate,
                                changed.latencySamples - high.latencySamples / 4.0, occupiedStride);
                            auto changedRow = describe(rate, bass, voice, topology, factor, changedResidual);
                            addPeriodDiagnostics(changedRow, changed.audio, reference, rate, changedResidual);
                            changedRow.getDynamicObject()->setProperty("deviceIntegrity", changed.diagnostics);
                            factors.add(changedRow);
                            integrityPassed = integrityPassed && changedResidual.finite;
                        }
                    }
            }
        }
        const bool coveragePassed = cases.size() == 144 && factors.size() == 36
            && convergence.size() == 18 && inactiveFactorComparisons == 36;
        integrityPassed = integrityPassed && coveragePassed;
        auto* report = new juce::DynamicObject();
        const juce::var reportValue(report);
        report->setProperty("coverage", "Guitar/Bass x Vintage/Sustain/Gated x44.1/48/96kHz x Drive off/on x Distortion off/Crunch/Heavy/Extreme:144 primary cases at4x Drive. Complete cascades add36 factor2x/8x cases and18 reference-convergence comparisons. Fuzz-only adds36 exact inactive-Drive-factor comparisons after each render's reported integer PDC.");
        report->setProperty("route", "Actual NAM Rack Fuzz -> optional Drive -> optional Distortion -> fixed-18dB final Rack output trim -> unchanged production safety guard. Octave, PRE/post EQ, compressor, Global/Drive/Distortion gates, captures, amp, cabinet and time effects bypassed; Clean0, calibration+12dBu. Fuzz Gated retains its intrinsic gate. Input and interstage levels remain unchanged.");
        report->setProperty("measurementOutputTrimDb", measurementOutputTrimDb);
        report->setProperty("measurementOutputTrimInterpretation", "A fixed post-chain attenuation is installed before prepare for every DUT/reference. It keeps the final safety guard inactive while retaining all clipping-stage excitation. The original0dB measurement engaged that guard and could not isolate the requested stages. No adaptive gain matching, normalization, or production DSP change is applied; zero guard hits remain required.");
        report->setProperty("controls", "Fuzz drive0.82, tone0.75, level0dB; Drive drive0.82, bright1, attack0.18, volume0dB; Distortion drive0.82, tone0.58, weight0.5, mix1, level0dB. Single high-excitation control set; continuous controls are covered separately by interaction/lifecycle tests.");
        report->setProperty("reference", "4x host rate (at most384kHz), 8x downstream oversampling;513-tap Blackman-Harris decimator at0.45 of base rate, common physical source origin. Reported PDC plus bounded +/-0.5-sample alignment at1/256 resolution; no gain/phase-EQ fitting.");
        report->setProperty("stimulus", "Steady5500/9900/13200/18700Hz multisine, amplitudes0.040/0.035/0.030/0.025, phases0.17/1.13/2.41/-0.71;0.28s plus FIR margins, final10ms period, analytically occupied bin stride11. This high-frequency probe is not a guitar/bass recording.");
        report->setProperty("interpretation", "diagnostic_only: unoccupied residual includes aliasing, rate-dependent filtering/ADAA and envelope settling. Occupied residual includes desired transfer differences. Consecutive10ms-period relative differences quantify nonstationarity in the actual analysis windows. Reference convergence is reported, not assumed. No residual threshold or subjective quality pass is assigned to Fuzz/cascades.");
        report->setProperty("subjectiveQuality", "not_asserted");
        report->setProperty("measurementControlsPassed", controlsPassed);
        report->setProperty("renderIntegrityPassed", integrityPassed);
        report->setProperty("coveragePassed", coveragePassed);
        report->setProperty("inactiveDriveFactorPassed", inactiveFactorPassed);
        report->setProperty("measurementControls", juce::var(controls));
        report->setProperty("cases", juce::var(cases));
        report->setProperty("factorDiagnostics", juce::var(factors));
        report->setProperty("referenceConvergenceDiagnostics", juce::var(convergence));
        report->setProperty("inactiveDriveFactorComparisons", inactiveFactorComparisons);
        report->setProperty("maximumInactiveDriveFactorDifference", maximumInactiveFactorDifference);
        report->setProperty("elapsedMilliseconds", juce::Time::getMillisecondCounterHiRes() - started);
        add(checks, "nam_fuzz_alias_measurement_contracts",
            integrityPassed && controlsPassed && inactiveFactorPassed ? "pass" : "fail",
            "Only measurement controls, finite nonzero processing without safety fallback, exact coverage, and independence of Fuzz-only from inactive Drive oversampling after reported integer PDC are asserted. Fuzz alias audibility and high-rate residual size are not quality gates.", reportValue);
        add(checks, "nam_fuzz_alias_and_cascade_residuals", "diagnostic_only",
            "Inspect the per-case occupied/unoccupied complex residuals, factor comparisons and reference convergence in nam_fuzz_alias_measurement_contracts. Audibility and preferred tone require exact-artifact audition.");
        return checks;
    }

private:
    static constexpr int occupiedStride = 11;
    static constexpr float measurementOutputTrimDb = -18.0f;
    static constexpr std::array<double, 4> frequencies { 5500.0, 9900.0, 13200.0, 18700.0 };
    static constexpr std::array<double, 4> amplitudes { 0.040, 0.035, 0.030, 0.025 };
    static constexpr std::array<double, 4> phases { 0.17, 1.13, 2.41, -0.71 };
    static int distortionModeFor(int topology)
    {
        // Topology order is Off/Crunch/Heavy/Extreme. Persisted Rack values
        // retain the established Heavy0/Extreme1/Crunch2 contract.
        constexpr std::array<int, 4> modes { -1, 2, 0, 1 };
        return modes[static_cast<size_t>(topology & 3)];
    }
    struct Rendered
    {
        std::vector<float> audio;
        int latencySamples = 0;
        bool integrityPassed = false;
        juce::var diagnostics;
    };

    static double signal(double time)
    {
        double value = 0.0;
        for (size_t tone = 0; tone < frequencies.size(); ++tone)
            value += amplitudes[tone] * std::sin(
                juce::MathConstants<double>::twoPi * frequencies[tone] * time + phases[tone]);
        return value;
    }
    static std::vector<float> makeSource(double rate, int factor)
    {
        const int count = static_cast<int>(std::round(rate * 0.28)) * factor
            + NAMNonlinearAliasAnalysis::decimatorTapCount - 1;
        std::vector<float> result(static_cast<size_t>(count));
        for (int sample = 0; sample < count; ++sample)
            result[static_cast<size_t>(sample)] = static_cast<float>(signal(
                (sample - NAMNonlinearAliasAnalysis::decimatorHalfLength) / (rate * factor)));
        return result;
    }
    static Rendered render(double rate, int factor, const std::vector<float>& source,
                           bool bass, int voice, int topology)
    {
        const auto rack = std::make_unique<OpenStudioNAMRack>();
        rack->setRoutedInputChannelCount(1);
        rack->instrumentProfile.store(bass ? 1.0f : 0.0f);
        rack->calibrationReferenceDbu.store(12.0f);
        rack->inputTrimDb.store(0.0f); rack->outputTrimDb.store(measurementOutputTrimDb);
        rack->gateThresholdDb.store(-100.0f); rack->compressorEnabled.store(0.0f);
        rack->octaverEnabled.store(0.0f); rack->fuzzEnabled.store(1.0f);
        rack->fuzzVoice.store(static_cast<float>(voice)); rack->fuzzDrive.store(0.82f);
        rack->fuzzTone.store(0.75f); rack->fuzzLevelDb.store(0.0f); rack->fuzzCleanMix.store(0.0f);
        rack->preEqEnabled.store(0.0f); rack->setEmbeddedDriveOversamplingFactor(factor);
        rack->precisionDriveEnabled.store((topology & 4) != 0 ? 1.0f : 0.0f);
        rack->precisionDriveDrive.store(0.82f); rack->precisionDriveBright.store(1.0f);
        rack->precisionDriveAttack.store(0.18f); rack->precisionDriveGate.store(0.0f);
        rack->precisionDriveVolumeDb.store(0.0f);
        const int distortion = distortionModeFor(topology);
        rack->chaosEnabled.store(distortion >= 0 ? 1.0f : 0.0f);
        rack->chaosMode.store(static_cast<float>(juce::jmax(0, distortion)));
        rack->chaosDrive.store(0.82f); rack->chaosTone.store(0.58f); rack->chaosWeight.store(0.5f);
        rack->chaosGate.store(0.0f); rack->chaosMix.store(1.0f); rack->chaosLevelDb.store(0.0f);
        rack->pedalMix.store(0.0f); rack->ampEnabled.store(0.0f);
        rack->setCabRequestedEnabled(false); rack->eqEnabled.store(0.0f);
        rack->chorusMix.store(0.0f); rack->modulatorEnabled.store(0.0f);
        rack->delayEnabled.store(0.0f); rack->reverbEnabled.store(0.0f); rack->auditionSource.store(0.0f);
        rack->setPlayConfigDetails(1, 1, rate, 128); rack->prepareToPlay(rate, 128);
        Rendered result;
        result.latencySamples = rack->getLatencySamples();
        result.audio = source;
        juce::MidiBuffer midi;
        int nonFinite = 0;
        float peak = 0.0f;
        for (int start = 0; start < static_cast<int>(result.audio.size()); start += 128)
        {
            const int count = juce::jmin(128, static_cast<int>(result.audio.size()) - start);
            float* pointer = result.audio.data() + start;
            juce::AudioBuffer<float> block(&pointer, 1, count);
            rack->processBlock(block, midi);
            for (int sample = 0; sample < count; ++sample)
                if (!std::isfinite(pointer[sample]))
                {
                    ++nonFinite;
                    pointer[sample] = 0.0f;
                }
                else
                    peak = juce::jmax(peak, std::abs(pointer[sample]));
        }
        const auto native = rack->getDiagnosticState();
        auto* diagnostic = new juce::DynamicObject();
        result.diagnostics = juce::var(diagnostic);
        diagnostic->setProperty("sampleRate", rate);
        diagnostic->setProperty("measurementOutputTrimDb", measurementOutputTrimDb);
        diagnostic->setProperty("latencySamples", result.latencySamples);
        diagnostic->setProperty("nonFiniteSamples", nonFinite);
        diagnostic->setProperty("samplePeak", peak);
        diagnostic->setProperty("rackMaximumRawOutputPeakLinear",
            native.getProperty("rackMaximumRawOutputPeakLinear", -1.0));
        result.integrityPassed = nonFinite == 0 && peak > 0.0f;
        for (const char* name : { "rackOutputSafetyGuardHitCount", "audioThreadResizeAvoidedCount",
             "oversizeBypassCount", "realtimeSafetyBypassCount", "modelProcessFailCount",
             "rackOutputEmergencyMuteTripCount", "inputNonFiniteSampleCount" })
        {
            const auto count = static_cast<juce::int64>(native.getProperty(
                juce::Identifier(name), static_cast<juce::int64>(-1)));
            diagnostic->setProperty(name, count);
            // Any guard changes the nonlinear transfer under measurement.
            result.integrityPassed = result.integrityPassed && count == 0;
        }
        diagnostic->setProperty("passed", result.integrityPassed);
        rack->releaseResources();
        return result;
    }

    static juce::var describe(double rate, bool bass, int voice, int topology, int factor,
                             const NAMNonlinearAliasAnalysis::AlignedResidual& residual)
    {
        auto* value = new juce::DynamicObject();
        value->setProperty("sampleRate", rate); value->setProperty("bassProfile", bass);
        value->setProperty("fuzzVoice", voice); value->setProperty("topology", topology);
        value->setProperty("driveEnabled", (topology & 4) != 0);
        value->setProperty("distortionMode", distortionModeFor(topology));
        value->setProperty("driveOversamplingFactor", factor);
        value->setProperty("unoccupiedResidualRatio", residual.unoccupiedRatio);
        value->setProperty("occupiedResidualRatio", residual.occupiedRatio);
        value->setProperty("integerAdvanceSamples", residual.integerAdvance);
        value->setProperty("fractionalAdvanceSamples", residual.fractionalAdvance);
        value->setProperty("occupiedBins", residual.occupiedBins);
        value->setProperty("unoccupiedBins", residual.unoccupiedBins);
        value->setProperty("finiteResidual", residual.finite);
        value->setProperty("interpretation", "diagnostic_only");
        return juce::var(value);
    }

    static void addPeriodDiagnostics(juce::var& row, const std::vector<float>& device,
                                     const std::vector<float>& reference, double rate,
                                     const NAMNonlinearAliasAnalysis::AlignedResidual& residual)
    {
        const int period = juce::jmax(32, static_cast<int>(std::round(
            rate * NAMNonlinearAliasAnalysis::analysisPeriodSeconds)));
        const int available = static_cast<int>(juce::jmin(device.size(), reference.size()));
        const int referenceStart = available - std::abs(residual.integerAdvance) - 8 - period;
        const auto mismatch = [period] (const std::vector<float>& audio, int start)
        {
            if (start < period || start + period > static_cast<int>(audio.size()))
                return -1.0;
            double power = 0.0, error = 0.0;
            for (int sample = 0; sample < period; ++sample)
            {
                const double current = audio[static_cast<size_t>(start + sample)];
                const double previous = audio[static_cast<size_t>(start + sample - period)];
                power += current * current;
                error += (current - previous) * (current - previous);
            }
            return std::sqrt(error / juce::jmax(1.0e-30, power));
        };
        row.getDynamicObject()->setProperty("deviceConsecutivePeriodRelativeDifference",
            mismatch(device, referenceStart + residual.integerAdvance));
        row.getDynamicObject()->setProperty("referenceConsecutivePeriodRelativeDifference",
            mismatch(reference, referenceStart));
    }

    static juce::var measurementControls(double rate, const std::vector<float>& high,
                                        const std::vector<float>& base,
                                        const NAMNonlinearAliasAnalysis& analysis, bool& passed)
    {
        std::vector<float> linear(high.size()), nonlinear(high.size()), broken(base.size());
        for (size_t sample = 0; sample < high.size(); ++sample)
        {
            linear[sample] = high[sample] * 0.731f;
            nonlinear[sample] = std::tanh(64.0f * high[sample]);
        }
        for (size_t sample = 0; sample < base.size(); ++sample)
            broken[sample] = std::tanh(64.0f * base[sample]);
        const auto linearReference = analysis.decimate(linear);
        double energy = 0.0, errorEnergy = 0.0;
        for (size_t sample = 0; sample < base.size(); ++sample)
        {
            const double expected = static_cast<double>(base[sample]) * 0.731;
            const double difference = linearReference[sample] - expected;
            energy += expected * expected; errorEnergy += difference * difference;
        }
        const double linearError = std::sqrt(errorEnergy / juce::jmax(1.0e-30, energy));
        const auto brokenResidual = NAMNonlinearAliasAnalysis::measureAlignedResidual(
            broken, analysis.decimate(nonlinear), rate, 0.0, occupiedStride);

        // An independent analytic source checks the alignment sign, bounded
        // search and absence of gain fitting. The known fractional delay is on
        // the search grid; a deliberate10% level error must remain measurable.
        std::vector<float> reference(base.size()), delayed(base.size()), wrongGain(base.size());
        for (size_t sample = 0; sample < base.size(); ++sample)
        {
            const auto position = static_cast<double>(sample);
            reference[sample] = static_cast<float>(0.731 * signal(position / rate));
            delayed[sample] = static_cast<float>(0.731 * signal((position - 5.25) / rate));
            wrongGain[sample] = delayed[sample] * 1.1f;
        }
        const auto aligned = NAMNonlinearAliasAnalysis::measureAlignedResidual(
            delayed, reference, rate, 5.25, occupiedStride);
        const auto gainError = NAMNonlinearAliasAnalysis::measureAlignedResidual(
            wrongGain, reference, rate, 5.25, occupiedStride);
        const bool valid = linearError <= 2.0e-6 && brokenResidual.finite
            && brokenResidual.unoccupiedRatio >= 0.0001
            && brokenResidual.unoccupiedRatio >= linearError * 1000.0
            && aligned.finite && aligned.integerAdvance == 5 && aligned.fractionalAdvance == 0.25
            && aligned.occupiedRatio <= 1.0e-5 && aligned.unoccupiedRatio <= 1.0e-5
            && gainError.finite && gainError.occupiedRatio > 0.099 && gainError.occupiedRatio < 0.101;
        passed = passed && valid;
        auto* value = new juce::DynamicObject();
        value->setProperty("sampleRate", rate); value->setProperty("passed", valid);
        value->setProperty("linearCommutationRelativeError", linearError);
        value->setProperty("brokenBaseRateTanhUnoccupiedResidual", brokenResidual.unoccupiedRatio);
        value->setProperty("knownDelaySamples", 5.25);
        value->setProperty("recoveredIntegerAdvance", aligned.integerAdvance);
        value->setProperty("recoveredFractionalAdvance", aligned.fractionalAdvance);
        value->setProperty("knownGainDelayOccupiedResidual", aligned.occupiedRatio);
        value->setProperty("knownGainDelayUnoccupiedResidual", aligned.unoccupiedRatio);
        value->setProperty("deliberateTenPercentGainErrorOccupiedResidual", gainError.occupiedRatio);
        return juce::var(value);
    }

    static void add(juce::Array<juce::var>& checks, const char* id, const char* status,
                    const char* detail, const juce::var& value = {})
    {
        auto* result = new juce::DynamicObject();
        result->setProperty("id", id); result->setProperty("status", status);
        result->setProperty("detail", detail);
        if (!value.isVoid()) result->setProperty("value", value);
        checks.add(juce::var(result));
    }
};
