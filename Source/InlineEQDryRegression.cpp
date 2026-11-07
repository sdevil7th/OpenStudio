#include "InlineEQDryRegression.h"
#include "BuiltInEffects.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <memory>
#include <vector>

namespace
{
juce::var timingSummary(std::vector<double> samples)
{
    std::sort(samples.begin(), samples.end());
    const auto percentile = [&](double fraction)
    {
        return samples[static_cast<size_t>(fraction * static_cast<double>(samples.size() - 1))];
    };
    auto* result = new juce::DynamicObject();
    result->setProperty("p50Microseconds", percentile(0.50));
    result->setProperty("p95Microseconds", percentile(0.95));
    result->setProperty("p99Microseconds", percentile(0.99));
    return juce::var(result);
}
}

juce::var OpenStudioEQ::runEmbeddedDryRegression()
{
    juce::Array<juce::var> checks;
    bool passed = true;
    const auto check = [&](const char* id, bool pass, const char* detail)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", id); item->setProperty("pass", pass); item->setProperty("detail", detail);
        checks.add(juce::var(item)); passed = passed && pass;
    };
    constexpr int tracks = 31, blockSize = 8, batches = 6000;
    constexpr double rate = 48000.0;
    std::array<std::unique_ptr<OpenStudioEQ>, tracks> full, fast, peakOnly;
    juce::AudioBuffer<float> input(2, blockSize);
    for (int sample = 0; sample < blockSize; ++sample)
    {
        input.setSample(0, sample, sample % 2 == 0 ? 0.17f : -0.13f);
        input.setSample(1, sample, sample % 3 == 0 ? -0.07f : 0.03f);
    }
    for (size_t track = 0; track < full.size(); ++track)
    {
        full[track] = std::make_unique<OpenStudioEQ>();
        fast[track] = std::make_unique<OpenStudioEQ>();
        peakOnly[track] = std::make_unique<OpenStudioEQ>();
        for (auto* processor : { full[track].get(), fast[track].get(), peakOnly[track].get() })
        {
            processor->setPowerEnabled(false);
            processor->setRateAndBufferSizeDetails(rate, blockSize);
            processor->prepareToPlay(rate, blockSize);
        }
    }
    std::vector<double> fullTimes, fastTimes, peakTimes;
    fullTimes.reserve(batches); fastTimes.reserve(batches); peakTimes.reserve(batches);
    const double toMicroseconds = 1000000.0 / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
    bool exactAudio = true;
    juce::MidiBuffer midi;
    for (int batch = 0; batch < batches; ++batch)
    {
        const auto measureFull = [&]
        {
            const auto start = juce::Time::getHighResolutionTicks();
            for (const auto& processor : full) processor->processEQAudioBlockGeneral(input);
            fullTimes.push_back(static_cast<double>(juce::Time::getHighResolutionTicks() - start) * toMicroseconds);
        };
        const auto measureFast = [&]
        {
            const auto start = juce::Time::getHighResolutionTicks();
            for (const auto& processor : fast) processor->processBlock(input, midi);
            fastTimes.push_back(static_cast<double>(juce::Time::getHighResolutionTicks() - start) * toMicroseconds);
        };
        const auto measurePeak = [&]
        {
            const auto start = juce::Time::getHighResolutionTicks();
            for (const auto& processor : peakOnly) processor->publishOutputPeaks(input);
            peakTimes.push_back(static_cast<double>(juce::Time::getHighResolutionTicks() - start) * toMicroseconds);
        };
        if (batch % 3 == 0) { measureFull(); measureFast(); measurePeak(); }
        else if (batch % 3 == 1) { measureFast(); measurePeak(); measureFull(); }
        else { measurePeak(); measureFull(); measureFast(); }
        for (int sample = 0; sample < blockSize; ++sample)
            exactAudio = exactAudio && input.getSample(0, sample) == (sample % 2 == 0 ? 0.17f : -0.13f)
                && input.getSample(1, sample) == (sample % 3 == 0 ? -0.07f : 0.03f);
    }
    bool exactMeters = true;
    juce::uint64 benchmarkFastBlocks = 0;
    for (size_t track = 0; track < full.size(); ++track)
    {
        for (size_t channel = 0; channel < 2; ++channel)
            exactMeters = exactMeters && full[track]->outputPeaks[channel].load() == peakOnly[track]->outputPeaks[channel].load()
                && full[track]->outputPeaks[channel].load() == fast[track]->outputPeaks[channel].load();
        benchmarkFastBlocks += fast[track]->embeddedDryFastBlocks;
        full[track]->releaseResources(); fast[track]->releaseResources(); peakOnly[track]->releaseResources();
    }
    check("inline_eq_disabled_benchmark_preserves_audio", exactAudio,
        "Prepared embedded EQ, power fully dry, nonzero stereo eight-frame blocks: exact unchanged sample values.");
    check("inline_eq_disabled_benchmark_peak_lower_bound_exact", exactMeters,
        "Peak-only lower-bound loop preserves both output dB meters; this is a cost diagnostic, not an enabled processing substitute.");
    check("inline_eq_disabled_benchmark_uses_actual_fast_entry",
        benchmarkFastBlocks == static_cast<juce::uint64>(tracks) * batches,
        "Every timed candidate block uses the guarded production entry; the reference calls the unchanged general DSP helper.");

    const auto sameAudio = [](const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
    {
        if (a.getNumChannels() != b.getNumChannels() || a.getNumSamples() != b.getNumSamples()) return false;
        for (int channel = 0; channel < a.getNumChannels(); ++channel)
            if (std::memcmp(a.getReadPointer(channel), b.getReadPointer(channel),
                            static_cast<size_t>(a.getNumSamples()) * sizeof(float)) != 0) return false;
        return true;
    };
    const auto sameState = [](const OpenStudioEQ& a, const OpenStudioEQ& b)
    {
        bool exact = a.activeProcessingMode == b.activeProcessingMode
            && a.pendingProcessingMode == b.pendingProcessingMode && a.modeTransitionPending == b.modeTransitionPending
            && a.wetPathHasState == b.wetPathHasState
            && a.smoothedPowerMix.getCurrentValue() == b.smoothedPowerMix.getCurrentValue()
            && a.smoothedPowerMix.getTargetValue() == b.smoothedPowerMix.getTargetValue()
            && a.smoothedPowerMix.isSmoothing() == b.smoothedPowerMix.isSmoothing()
            && a.smoothedModeMix.getCurrentValue() == b.smoothedModeMix.getCurrentValue()
            && a.smoothedModeMix.getTargetValue() == b.smoothedModeMix.getTargetValue()
            && a.spectrumDemandSamplesRemaining.load() == b.spectrumDemandSamplesRemaining.load()
            && a.spectrumCaptureSlot == b.spectrumCaptureSlot && a.spectrumCaptureWritePos == b.spectrumCaptureWritePos
            && a.spectrumCaptureGeneration == b.spectrumCaptureGeneration
            && a.draftPreview.requested() == b.draftPreview.requested();
        for (size_t channel = 0; channel < 2; ++channel)
            exact = exact && a.outputPeaks[channel].load() == b.outputPeaks[channel].load();
        for (int band = 0; band < a.bandCount; ++band)
            exact = exact && a.dynamicGainDB[static_cast<size_t>(band)].load() == b.dynamicGainDB[static_cast<size_t>(band)].load();
        return exact;
    };
    const auto fill = [](juce::AudioBuffer<float>& block, juce::int64 frame)
    {
        for (int channel = 0; channel < block.getNumChannels(); ++channel)
            for (int sample = 0; sample < block.getNumSamples(); ++sample)
            {
                const auto phase = (frame + sample + channel * 37) % 127;
                const float value = static_cast<float>(phase - 63) / 256.0f;
                block.setSample(channel, sample, channel % 2 == 0 ? value : value * -0.37f);
            }
    };
    bool dryParity = true, rampParity = true, modeParity = true, dispatchParity = true, resetStateParity = true;
    juce::int64 parityBlocks = 0;
    for (const double testRate : { 44100.0, 48000.0, 96000.0 })
        for (const int length : { 1, 8, 16, 512 })
            for (const int channels : { 1, 2 })
            {
                auto reference = std::make_unique<OpenStudioEQ>();
                auto candidate = std::make_unique<OpenStudioEQ>();
                for (auto* processor : { reference.get(), candidate.get() })
                {
                    processor->setPowerEnabled(false);
                    processor->setRateAndBufferSizeDetails(testRate, 512);
                    processor->prepareToPlay(testRate, 512);
                    auto& band = processor->bands[3];
                    band.gain.store(6.0f); band.freq.store(1200.0f); band.dynamicEnabled.store(1.0f);
                    band.dynamicRange.store(-9.0f); band.dynamicThreshold.store(-24.0f);
                    band.dynamicAttack.store(3.0f); band.dynamicRelease.store(45.0f);
                }
                juce::AudioBuffer<float> a(channels, length), b(channels, length);
                juce::int64 cursor = 0;
                const auto step = [&]
                {
                    fill(a, cursor); b.makeCopyOf(a, true); cursor += length;
                    reference->processEQAudioBlockGeneral(a); candidate->processBlock(b, midi); ++parityBlocks;
                    return sameAudio(a, b) && sameState(*reference, *candidate);
                };
                for (int block = 0; block < 128; ++block) dryParity = step() && dryParity;
                dispatchParity = dispatchParity && (candidate->embeddedDryFastBlocks > 0) == (channels == 2);
                const auto beforeMode = candidate->embeddedDryFastBlocks;
                reference->stereoMode.store(1.0f); candidate->stereoMode.store(1.0f);
                modeParity = step() && candidate->embeddedDryFastBlocks == beforeMode && modeParity;
                modeParity = step() && modeParity;
                reference->stereoMode.store(0.0f); candidate->stereoMode.store(0.0f);
                modeParity = step() && modeParity;
                const int transitionBlocks = static_cast<int>(std::ceil(testRate * 0.025 / length)) + 2;
                for (int phase = 0; phase < 3; ++phase)
                {
                    const bool enabled = phase != 1;
                    reference->setPowerEnabled(enabled); candidate->setPowerEnabled(enabled);
                    for (int block = 0; block < transitionBlocks; ++block) rampParity = step() && rampParity;
                }
                reference->setPowerEnabled(false); candidate->setPowerEnabled(false);
                reference->reset(); candidate->reset();
                resetStateParity = step() && resetStateParity;
                for (auto* processor : { reference.get(), candidate.get() }) processor->prepareToPlay(testRate, 512);
                resetStateParity = step() && resetStateParity;
                juce::MemoryBlock referenceState, candidateState;
                reference->getStateInformation(referenceState); candidate->getStateInformation(candidateState);
                resetStateParity = juce::ValueTree::readFromData(referenceState.getData(), referenceState.getSize()).isEquivalentTo(
                    juce::ValueTree::readFromData(candidateState.getData(), candidateState.getSize())) && resetStateParity;
                reference->releaseResources(); candidate->releaseResources();
            }
    check("inline_eq_dry_shortcut_exact_rate_shape_matrix", dryParity && dispatchParity,
        "Exact asymmetric mono/stereo PCM, both dB meters and runtime state at 44.1/48/96kHz with 1/8/16/512-frame blocks; mono retains the general path.");
    check("inline_eq_dry_shortcut_enable_ramp_and_reenable_exact", rampParity,
        "After long dry input, active dynamic EQ enables, ramps off and re-enables with exact general-path audio, meters, power/mode state and dynamic gain.");
    check("inline_eq_dry_shortcut_mode_change_falls_back", modeParity,
        "A dry mode request uses the general path before subsequent steady blocks can qualify.");
    check("inline_eq_dry_shortcut_reset_reprepare_state_exact", resetStateParity,
        "Reset, re-preparation, first subsequent input and serialized parameter state preserve general-path parity.");

    auto spectrumReference = std::make_unique<OpenStudioEQ>();
    auto spectrumCandidate = std::make_unique<OpenStudioEQ>();
    for (auto* processor : { spectrumReference.get(), spectrumCandidate.get() })
    {
        processor->setPowerEnabled(false); processor->setRateAndBufferSizeDetails(rate, blockSize);
        processor->prepareToPlay(rate, blockSize); processor->getSpectrumData();
    }
    juce::AudioBuffer<float> spectrumA(2, blockSize), spectrumB(2, blockSize);
    bool spectrumParity = true, spectrumReady = false;
    for (int block = 0; block < 7600; ++block)
    {
        fill(spectrumA, block * blockSize); spectrumB.makeCopyOf(spectrumA, true);
        spectrumReference->processEQAudioBlockGeneral(spectrumA); spectrumCandidate->processBlock(spectrumB, midi);
        spectrumParity = sameAudio(spectrumA, spectrumB) && sameState(*spectrumReference, *spectrumCandidate) && spectrumParity;
        if (block == 300)
        {
            const auto a = spectrumReference->getSpectrumData(), b = spectrumCandidate->getSpectrumData();
            spectrumReady = a.ready && b.ready && a.fftLength == b.fftLength && a.source == b.source
                && a.preEQ == b.preEQ && a.postEQ == b.postEQ && a.externalKey == b.externalKey;
        }
    }
    check("inline_eq_dry_shortcut_spectrum_demand_and_expiry_exact",
        spectrumParity && spectrumReady && spectrumCandidate->embeddedDryFastBlocks > 0,
        "Dry spectrum polling captures identical FFT data, expires/cleans the same capture state, then resumes the shortcut.");
    bool draftParity = true;
    for (auto* processor : { spectrumReference.get(), spectrumCandidate.get() })
    {
        BuiltInEQDraftPreview::Plan plan; plan.rate = rate; plan.stages = 1;
        plan.coefficients[0] = { 1.0f, 0.0f, 0.0f, 0.0f, 0.0f }; plan.fingerprint = processor->draftFingerprint();
        draftParity = static_cast<bool>(processor->draftPreview.start("inline-dry-qa", plan)["success"]) && draftParity;
    }
    const auto beforeDraft = spectrumCandidate->embeddedDryFastBlocks;
    spectrumA.clear(); spectrumB.clear();
    spectrumReference->processEQAudioBlockGeneral(spectrumA); spectrumCandidate->processBlock(spectrumB, midi);
    draftParity = sameAudio(spectrumA, spectrumB) && sameState(*spectrumReference, *spectrumCandidate)
        && spectrumCandidate->embeddedDryFastBlocks == beforeDraft
        && !spectrumReference->draftPreview.requested() && !spectrumCandidate->draftPreview.requested() && draftParity;
    spectrumReference->processEQAudioBlockGeneral(spectrumA); spectrumCandidate->processBlock(spectrumB, midi);
    draftParity = sameAudio(spectrumA, spectrumB) && sameState(*spectrumReference, *spectrumCandidate)
        && spectrumCandidate->embeddedDryFastBlocks == beforeDraft + 1 && draftParity;
    check("inline_eq_dry_shortcut_pending_draft_uses_general_path", draftParity,
        "A pending draft request is handled by the existing general path and rejects/resets the ineligible embedded audition identically.");
    spectrumReference->releaseResources(); spectrumCandidate->releaseResources();

    auto wideReference = std::make_unique<OpenStudioEQ>();
    auto wideCandidate = std::make_unique<OpenStudioEQ>();
    for (auto* processor : { wideReference.get(), wideCandidate.get() })
    {
        processor->setPowerEnabled(false); processor->setRateAndBufferSizeDetails(rate, blockSize);
        processor->prepareToPlay(rate, blockSize);
    }
    juce::AudioBuffer<float> wideA(4, blockSize), wideB(4, blockSize);
    fill(wideA, 17); wideB.makeCopyOf(wideA);
    wideReference->processEQAudioBlockGeneral(wideA); wideCandidate->processBlock(wideB, midi);
    check("inline_eq_dry_shortcut_wide_buffer_keeps_general_path",
        sameAudio(wideA, wideB) && sameState(*wideReference, *wideCandidate) && wideCandidate->embeddedDryFastBlocks == 0,
        "An embedded wider buffer retains the general main-pair view and untouched extra channels.");
    wideReference->releaseResources(); wideCandidate->releaseResources();

    auto standaloneReference = std::make_unique<OpenStudioEQ>(true);
    auto standaloneCandidate = std::make_unique<OpenStudioEQ>(true);
    for (auto* processor : { standaloneReference.get(), standaloneCandidate.get() })
    {
        processor->setPowerEnabled(false); processor->setRateAndBufferSizeDetails(rate, blockSize);
        processor->prepareToPlay(rate, blockSize); processor->externalDetector.store(1.0f);
        processor->bands[3].gain.store(6.0f); processor->bands[3].dynamicEnabled.store(1.0f);
        processor->bands[3].dynamicRange.store(-6.0f); processor->bands[3].detectorSource.store(2.0f);
    }
    juce::AudioBuffer<float> standaloneA(4, blockSize), standaloneB(4, blockSize);
    bool standaloneParity = true;
    for (int block = 0; block < 600; ++block)
    {
        if (block == 100) { standaloneReference->setPowerEnabled(true); standaloneCandidate->setPowerEnabled(true); }
        fill(standaloneA, block * blockSize); standaloneB.makeCopyOf(standaloneA, true);
        standaloneReference->processEQAudioBlockGeneral(standaloneA); standaloneCandidate->processBlock(standaloneB, midi);
        standaloneParity = sameAudio(standaloneA, standaloneB) && sameState(*standaloneReference, *standaloneCandidate) && standaloneParity;
    }
    check("inline_eq_dry_shortcut_standalone_key_keeps_general_path",
        standaloneParity && standaloneCandidate->embeddedDryFastBlocks == 0,
        "Standalone EQ with external-key input and dynamic processing never takes the embedded shortcut and remains exact.");
    standaloneReference->releaseResources(); standaloneCandidate->releaseResources();
    auto* benchmark = new juce::DynamicObject();
    benchmark->setProperty("classification", "diagnostic_only");
    benchmark->setProperty("tracks", tracks); benchmark->setProperty("blockSize", blockSize);
    benchmark->setProperty("sampleRate", rate); benchmark->setProperty("batches", batches);
    benchmark->setProperty("fullDisabledBatch", timingSummary(std::move(fullTimes)));
    benchmark->setProperty("guardedFastBatch", timingSummary(std::move(fastTimes)));
    benchmark->setProperty("peakOnlyLowerBoundBatch", timingSummary(std::move(peakTimes)));
    benchmark->setProperty("actualFastBlocks", static_cast<juce::int64>(benchmarkFastBlocks));
    auto* result = new juce::DynamicObject(); result->setProperty("pass", passed);
    result->setProperty("checks", checks); result->setProperty("benchmark", juce::var(benchmark));
    result->setProperty("parityBlocks", parityBlocks);
    result->setProperty("scope", "Device-free exact dry/transition/analysis/state parity and embedded EQ cost. Timing is diagnostic_only; no hardware or subjective sound claim.");
    return juce::var(result);
}

juce::var runInlineEQDryRegression() { return OpenStudioEQ::runEmbeddedDryRegression(); }
