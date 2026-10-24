#pragma once
#include "BuiltInSettledReverbTap.h"
#include <type_traits>

// Every measured decay below is diagnostic: finite windows, output filters,
// nonlinear colour and nonuniform/modal envelopes prevent an acoustic RT60
// assertion. The deterministic checks concern read policy and state continuity.
inline juce::var settledReverbBandDecay(const juce::AudioBuffer<float>& audio, double rate)
{
    juce::Array<juce::var> bands;
    for (double frequency : {125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0})
    {
        std::array<juce::dsp::IIR::Filter<float>, 2> filters;
        for (auto& filter : filters)
            filter.coefficients = juce::dsp::IIR::Coefficients<float>::makeBandPass(rate, static_cast<float>(frequency), .70710678f);
        std::vector<double> energy(static_cast<size_t>(audio.getNumSamples()));
        for (int sample = 0; sample < audio.getNumSamples(); ++sample)
            for (int channel = 0; channel < 2; ++channel)
            {
                const double value = filters[static_cast<size_t>(channel)].processSample(audio.getSample(channel, sample));
                energy[static_cast<size_t>(sample)] += value * value;
            }
        double cumulative = 0;
        for (int sample = audio.getNumSamples(); --sample >= 0;)
        { cumulative += energy[static_cast<size_t>(sample)]; energy[static_cast<size_t>(sample)] = cumulative; }
        double x = 0, y = 0, xx = 0, xy = 0;
        int count = 0;
        if (cumulative > 0)
            for (int sample = 0; sample < audio.getNumSamples(); ++sample)
            {
                const double db = 10 * std::log10(juce::jmax(1e-300, energy[static_cast<size_t>(sample)] / cumulative));
                if (db < -5 && db > -25)
                { const double time = sample / rate; x += time; y += db; xx += time * time; xy += time * db; ++count; }
            }
        const double denominator = count * xx - x * x;
        const double slope = count > 8 && denominator > 0 ? (count * xy - x * y) / denominator : 0;
        auto* band = new juce::DynamicObject();
        band->setProperty("centerHz", frequency); band->setProperty("capturedEnergy", cumulative);
        band->setProperty("fitSamples", count); band->setProperty("diagnostic_only", true);
        if (slope < 0) band->setProperty("t20ExtrapolatedSeconds", -60 / slope);
        bands.add(band);
    }
    return bands;
}

template <typename Engine, typename Settings, typename SetMotion>
juce::AudioBuffer<float> renderSettledReverbCase(double rate, int mode, Settings settings,
    const std::vector<int>& blocks, bool changes, double seconds, SetMotion&& setMotion, float rightRatio = -.31f)
{
    auto engine = std::make_unique<Engine>();
    engine->prepare(rate, mode);
    engine->configure(mode, settings, false);
    const int length = juce::roundToInt(rate * seconds), warm = juce::roundToInt(rate * .12);
    for (int sample = 0; sample < warm; ++sample) engine->process(0, 0);
    juce::AudioBuffer<float> output(2, length);
    const std::array<int, 6> events {
        juce::roundToInt(rate * .15), juce::roundToInt(rate * .25), juce::roundToInt(rate * .30),
        juce::roundToInt(rate * .40), juce::roundToInt(rate * .55), juce::roundToInt(rate * .65)
    };
    size_t pattern = 0, event = 0;
    for (int start = 0; start < length;)
    {
        if (changes && event < events.size() && start == events[event])
        {
            switch (event)
            {
                case 0: settings.refined = !settings.refined; break;
                case 1: settings.refined = true; settings.size = .81f; break;
                case 2: setMotion(settings, true); break;
                case 3: settings.hold = true; settings.holdInput = false; break;
                case 4: settings.hold = false; settings.size = .23f; setMotion(settings, false); break;
                case 5: settings.refined = false; break;
                default: break;
            }
            ++event;
        }
        int count = juce::jmin(blocks[pattern++ % blocks.size()], length - start);
        if (changes && event < events.size()) count = juce::jmin(count, events[event] - start);
        engine->configure(mode, settings, false);
        for (int sample = 0; sample < count; ++sample)
        {
            const int position = start + sample;
            const float input = changes ? .035f * std::sin(static_cast<float>(position) * .073f)
                : position == 0 ? .25f : 0;
            const auto value = engine->process(input, input * rightRatio);
            output.setSample(0, position, value[0]); output.setSample(1, position, value[1]);
        }
        start += count;
    }
    return output;
}

inline juce::var checkSettledReverbInterpolation()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Opt-in settled integer reverb taps");
    bool policy = true, finite = true, partition = true, monoPartition = true, movingParity = true;
    bool hold = true, influence = true, files = true;
    double maximumPartitionError = 0, maximumPeak = 0;
    juce::Array<juce::var> cases, policyCases, theoretical;
    const std::vector<int> regular {512}, irregular {1, 17, 113, 7, 251};
    const auto difference = [](const auto& a, const auto& b)
    {
        double error = 0;
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < a.getNumSamples(); ++sample)
                error = juce::jmax(error, std::abs(static_cast<double>(a.getSample(channel, sample) - b.getSample(channel, sample))));
        return error;
    };
    const auto sane = [&finite, &maximumPeak](const auto& audio)
    {
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < audio.getNumSamples(); ++sample)
            {
                const double value = audio.getSample(channel, sample);
                finite = std::isfinite(value) && finite;
                maximumPeak = juce::jmax(maximumPeak, std::abs(value));
            }
    };
    policy = !BuiltInClearReverb::Settings{}.refined && !BuiltInDriftingReverb::Settings{}.refined
        && !BuiltInRetroReverb::Settings{}.refined;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        BuiltInSettledReverbTap tap; tap.prepare(rate);
        int integerReads = 0;
        const auto integerRead = [&integerReads](float anchor) { ++integerReads; return anchor * .01f; };
        bool exactOriginalBypass = true;
        for (float original : {0.0f, -0.0f, .23f, -.81f, 1.23f})
        {
            const float value = tap.process(original, 10.37f, false, true, integerRead);
            exactOriginalBypass = value == original && std::signbit(value) == std::signbit(original) && exactOriginalBypass;
        }
        exactOriginalBypass = integerReads == 0 && exactOriginalBypass;
        // First stationary refined sample can initialize at integer; all later
        // policy/anchor changes are ramps with no changing integer read head.
        tap.reset(); const float initial = tap.process(.23f, 10.37f, true, true, integerRead);
        const bool initialIntegerSelection = initial == 10 * .01f && tap.integerBlend() == 1 && tap.integerAnchor() == 10;
        const int ramp = static_cast<int>(std::floor(rate * .02));
        BuiltInSettledReverbTap bypassTap; bypassTap.prepare(rate);
        const bool originalFastBypass = !bypassTap.needsProcessing(false);
        bypassTap.process(.23f, 10.37f, true, true, integerRead);
        const bool liveEnableFades = bypassTap.integerBlend() > 0 && bypassTap.integerBlend() < 1
            && bypassTap.integerAnchor() == 10;
        bool bypassWaitsForFade = bypassTap.needsProcessing(false);
        for (int sample = 0; sample < ramp + 1; ++sample)
        {
            if (bypassTap.integerBlend() > 0)
                bypassWaitsForFade = bypassTap.needsProcessing(false) && bypassWaitsForFade;
            bypassTap.process(.23f, 10.37f, false, true, integerRead);
        }
        const bool originalBypassResumes = bypassTap.integerBlend() == 0 && !bypassTap.needsProcessing(false);
        float previous = initial;
        double maximumStep = 0;
        bool movingFixedAnchor = true, movingMonotonic = true;
        for (int sample = 0; sample < ramp + 1; ++sample)
        {
            const float value = tap.process(.23f, 20 + static_cast<float>(sample), true, false, integerRead);
            maximumStep = juce::jmax(maximumStep, std::abs(static_cast<double>(value - previous)));
            movingFixedAnchor = tap.integerAnchor() == 10 && movingFixedAnchor;
            movingMonotonic = value >= previous && movingMonotonic; previous = value;
        }
        const bool movingFadeSettles = tap.integerBlend() == 0 && previous == .23f;
        const double stepBound = .13 / ramp + 1e-6;
        const bool boundedFadeStep = maximumStep < stepBound;
        tap.process(.23f, 27.63f, true, true, integerRead);
        const bool stationaryFadeStarts = tap.integerAnchor() == 28 && tap.integerBlend() > 0 && tap.integerBlend() < 1;
        for (int sample = 0; sample < ramp; ++sample) tap.process(.23f, 27.63f, true, true, integerRead);
        const bool stationaryFadeSettles = tap.integerAnchor() == 28 && tap.integerBlend() == 1;
        tap.process(.23f, 37.12f, true, true, integerRead);
        bool anchorChangesOnlyAtZero = tap.integerAnchor() == 28 && tap.integerBlend() < 1;
        for (int sample = 0; sample < ramp + 1; ++sample)
        {
            const float oldAnchor = tap.integerAnchor(), oldBlend = tap.integerBlend();
            tap.process(.23f, 37.12f, true, true, integerRead);
            anchorChangesOnlyAtZero = (tap.integerAnchor() == oldAnchor || oldBlend == 0) && anchorChangesOnlyAtZero;
        }
        const bool finalAnchorSelected = tap.integerAnchor() == 37;
        policy = exactOriginalBypass && initialIntegerSelection && movingFixedAnchor && movingMonotonic
            && movingFadeSettles && boundedFadeStep && stationaryFadeStarts && stationaryFadeSettles
            && anchorChangesOnlyAtZero && finalAnchorSelected && originalFastBypass && liveEnableFades
            && bypassWaitsForFade && originalBypassResumes && policy;
        auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", rate);
        row->setProperty("maximumPolicyStep", maximumStep); row->setProperty("policyStepBound", stepBound);
        row->setProperty("exactOriginalBypass", exactOriginalBypass);
        row->setProperty("initialIntegerSelection", initialIntegerSelection);
        row->setProperty("originalFastBypass", originalFastBypass); row->setProperty("liveEnableFades", liveEnableFades);
        row->setProperty("bypassWaitsForFade", bypassWaitsForFade); row->setProperty("originalBypassResumes", originalBypassResumes);
        row->setProperty("movingFixedAnchor", movingFixedAnchor); row->setProperty("movingMonotonic", movingMonotonic);
        row->setProperty("movingFadeSettles", movingFadeSettles); row->setProperty("boundedFadeStep", boundedFadeStep);
        row->setProperty("stationaryFadeStarts", stationaryFadeStarts); row->setProperty("stationaryFadeSettles", stationaryFadeSettles);
        row->setProperty("anchorChangesOnlyAtZero", anchorChangesOnlyAtZero); row->setProperty("finalAnchorSelected", finalAnchorSelected);
        policyCases.add(row);

        const auto exercise = [&](auto* engineTag, const char* family, int mode, auto settings, auto setMotion)
        {
            using Engine = std::remove_pointer_t<decltype(engineTag)>;
            settings.refined = true;
            const auto a = renderSettledReverbCase<Engine>(rate, mode, settings, irregular, true, .75, setMotion);
            const auto b = renderSettledReverbCase<Engine>(rate, mode, settings, regular, true, .75, setMotion);
            const double error = difference(a, b); maximumPartitionError = juce::jmax(maximumPartitionError, error);
            partition = error == 0 && partition; sane(a); sane(b);
            const auto monoA = renderSettledReverbCase<Engine>(rate, mode, settings, irregular, true, .75, setMotion, 1);
            const auto monoB = renderSettledReverbCase<Engine>(rate, mode, settings, regular, true, .75, setMotion, 1);
            const double monoError = difference(monoA, monoB);
            maximumPartitionError = juce::jmax(maximumPartitionError, monoError);
            monoPartition = monoError == 0 && monoPartition; sane(monoA); sane(monoB);
            auto moving = settings; moving.refined = false; setMotion(moving, true);
            const auto movingOriginal = renderSettledReverbCase<Engine>(rate, mode, moving, regular, false, .25, setMotion);
            moving.refined = true;
            const auto movingRefined = renderSettledReverbCase<Engine>(rate, mode, moving, regular, false, .25, setMotion);
            sane(movingOriginal); sane(movingRefined);
            const double movingError = difference(movingOriginal, movingRefined);
            movingParity = movingError == 0 && movingParity;
            settings.hold = true; settings.holdInput = false;
            const auto silent = renderSettledReverbCase<Engine>(rate, mode, settings, irregular, false, .18, setMotion);
            sane(silent);
            hold = silent.getMagnitude(0, silent.getNumSamples()) == 0 && hold;
            settings.holdInput = true;
            const auto accepted = renderSettledReverbCase<Engine>(rate, mode, settings, irregular, false, .30, setMotion);
            hold = accepted.getMagnitude(0, accepted.getNumSamples()) > 0 && hold; sane(accepted);
            auto* item = new juce::DynamicObject(); item->setProperty("family", family); item->setProperty("mode", mode);
            item->setProperty("sampleRate", rate); item->setProperty("partitionError", error);
            item->setProperty("monoExcitationPartitionError", monoError);
            item->setProperty("movingOriginalParityError", movingError); cases.add(item);
        };
        BuiltInClearReverb::Settings clear; clear.size = .413f; clear.depth = 0; clear.decay = .6f; clear.damping = 0;
        const auto clearMotion = [](auto& settings, bool enabled) { settings.depth = enabled ? .55f : 0; };
        BuiltInDriftingReverb::Settings drift; drift.size = .413f; drift.wow = drift.flutter = 0; drift.drive = 0; drift.decay = .6f; drift.damping = 0;
        const auto driftMotion = [](auto& settings, bool enabled) { settings.wow = enabled ? .55f : 0; settings.flutter = enabled ? .2f : 0; };
        BuiltInRetroReverb::Settings retro; retro.size = .413f; retro.depth = 0; retro.decay = .6f; retro.damping = 0; retro.attack = .25f;
        const auto retroMotion = [](auto& settings, bool enabled) { settings.depth = enabled ? .55f : 0; };
        for (int mode : {0, 1, 2}) exercise(static_cast<BuiltInClearReverb*>(nullptr), "Clear", mode, clear, clearMotion);
        for (int mode : {0, 1, 2}) exercise(static_cast<BuiltInDriftingReverb*>(nullptr), "Drifting", mode, drift, driftMotion);
        // Core2 is intentionally inert and has no Hold. Test it separately below.
        for (int mode : {0, 3, 12}) exercise(static_cast<BuiltInRetroReverb*>(nullptr), "Retro", mode, retro, retroMotion);
    }
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-refinement/responses");
    files = directory.createDirectory().wasOk();
    juce::Array<juce::var> decayCases;
    const auto diagnose = [&](auto* engineTag, const char* family, int mode, auto settings, auto setMotion, bool affected)
    {
        using Engine = std::remove_pointer_t<decltype(engineTag)>;
        const auto original = renderSettledReverbCase<Engine>(48000, mode, settings, regular, false, 3, setMotion);
        settings.refined = true;
        const auto refined = renderSettledReverbCase<Engine>(48000, mode, settings, regular, false, 3, setMotion);
        sane(original); sane(refined);
        const double error = difference(original, refined);
        influence = (affected ? error > 0 : error == 0) && influence;
        const auto stem = juce::String(family) + "-" + juce::String(mode);
        const auto originalName = stem + "-Original.wav", refinedName = stem + "-Refined.wav";
        files = writeProbeWave(directory.getChildFile(originalName), original, 48000)
            && writeProbeWave(directory.getChildFile(refinedName), refined, 48000) && files;
        auto* row = new juce::DynamicObject(); row->setProperty("family", family); row->setProperty("mode", mode);
        row->setProperty("originalFile", originalName); row->setProperty("refinedFile", refinedName);
        row->setProperty("maximumDifferenceDiagnostic", error); row->setProperty("declaredDecaySeconds", settings.decay);
        row->setProperty("originalBandsDiagnostic", settledReverbBandDecay(original, 48000));
        row->setProperty("refinedBandsDiagnostic", settledReverbBandDecay(refined, 48000)); decayCases.add(row);
    };
    BuiltInClearReverb::Settings clear; clear.size = .413f; clear.depth = 0; clear.decay = .6f; clear.damping = 0; clear.inputDiffusion = 0;
    BuiltInDriftingReverb::Settings drift; drift.size = .413f; drift.wow = drift.flutter = 0; drift.drive = 0; drift.decay = .6f; drift.damping = 0;
    BuiltInRetroReverb::Settings retro; retro.size = .413f; retro.depth = 0; retro.decay = .6f; retro.damping = 0; retro.inputDiffusion = 0;
    const auto noMotion = [](auto&, bool) {};
    for (int mode : {0, 1, 2}) diagnose(static_cast<BuiltInClearReverb*>(nullptr), "Clear", mode, clear, noMotion, true);
    for (int mode : {0, 1, 2}) diagnose(static_cast<BuiltInDriftingReverb*>(nullptr), "Drifting", mode, drift, noMotion, true);
    for (int mode : {0, 3, 5, 9, 11, 12}) diagnose(static_cast<BuiltInRetroReverb*>(nullptr), "Retro", mode, retro, noMotion, mode != 9);
    // Analytic one-loop screen separates interpolation loss from a model's
    // intentional damping. It is not a calibration of any complete reverb.
    constexpr double loopLength = 997.37, nominalDecay = 1.5, rate = 48000, fraction = .37;
    const double gain = std::pow(.001, loopLength / (rate * nominalDecay));
    for (double frequency : {125.0, 1000.0, 4000.0, 8000.0})
    {
        const double magnitude = std::sqrt(1 - 2 * fraction * (1 - fraction)
            * (1 - std::cos(juce::MathConstants<double>::twoPi * frequency / rate)));
        auto* band = new juce::DynamicObject(); band->setProperty("centerHz", frequency);
        band->setProperty("linearInterpolationMagnitude", magnitude);
        band->setProperty("originalEquivalentLoopDecaySeconds", std::log(.001) * loopLength / rate / std::log(gain * magnitude));
        band->setProperty("integerEquivalentLoopDecaySeconds", std::log(.001) * std::round(loopLength) / rate / std::log(gain));
        theoretical.add(band);
    }
    result->setProperty("cases", cases); result->setProperty("policyCases", policyCases);
    result->setProperty("readPolicy", policy); result->setProperty("exactIrregularPartitioning", partition);
    result->setProperty("exactMonoExcitationPartitioning", monoPartition);
    result->setProperty("movingOriginalParity", movingParity);
    result->setProperty("maximumPartitionError", maximumPartitionError); result->setProperty("finiteLiveTransitions", finite);
    result->setProperty("maximumPeakDiagnostic", maximumPeak); result->setProperty("holdInputPolicies", hold);
    result->setProperty("staticInfluenceAndFiniteReflectionBypass", influence); result->setProperty("responseFiles", files);
    result->setProperty("bandDecayDiagnostics", decayCases); result->setProperty("singleLoopTheoryDiagnostics", theoretical);
    result->setProperty("directory", directory.getFullPathName());
    result->setProperty("audioQuality", "not_asserted"); result->setProperty("decayCalibration", "diagnostic_only");
    result->setProperty("limitations", "Three-second band-decay fits include output/damping filters; nested-loop mean-decay heuristic remains unchanged; static rounded delays differ from nominal gain lengths by at most half a sample. Moving interpolation is unchanged, with a 20ms fade of a fixed old integer anchor.");
    result->setProperty("pass", policy && finite && partition && monoPartition && movingParity && hold && influence && files);
    return result;
}
