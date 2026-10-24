#pragma once
#include "BuiltInReverbSparseDiffusion.h"
#include <type_traits>
#if JUCE_WINDOWS && defined(_DEBUG)
#include <crtdbg.h>
namespace ReverbSparseHeapProbe
{
inline thread_local bool active = false;
inline thread_local int allocations = 0, frees = 0;
inline _CRT_ALLOC_HOOK previous = nullptr;
inline int hook(int kind, void* data, size_t size, int block, long request, const unsigned char* file, int line)
{
    if (active)
    {
        if (kind == _HOOK_ALLOC || kind == _HOOK_REALLOC) ++allocations;
        if (kind == _HOOK_FREE) ++frees;
    }
    return previous ? previous(kind, data, size, block, request, file, line) : 1;
}
}
#endif

namespace ReverbSparseRegression
{
struct Capture
{
    juce::AudioBuffer<float> audio;
    juce::uint64 sparseFrames = 0;
    bool finite = true;
    int allocations = 0, frees = 0;
};

template <typename Family>
Capture render(double rate, int mode, int blockSize, bool refined, bool toggle = false,
               bool retire = false, bool spillover = false, bool held = false)
{
    auto family = std::make_unique<Family>();
    family->prepare(rate, mode);
    typename Family::Settings settings;
    settings.refined = refined;
    settings.decay = 2;
    const int length = juce::roundToInt(rate * .6);
    const int feedEnd = juce::roundToInt(rate * .08);
    const int holdAt = juce::roundToInt(rate * .10);
    const int toggleAt = juce::roundToInt(rate * .12);
    const int offAt = juce::roundToInt(rate * .22);
    const int toggleBackAt = juce::roundToInt(rate * .24);
    const int thirdToggleAt = juce::roundToInt(rate * .36);
    const int reselectAt = juce::roundToInt(rate * .38);
    Capture result { juce::AudioBuffer<float>(2, length) };
    juce::uint32 random = 371;
#if JUCE_WINDOWS && defined(_DEBUG)
    ReverbSparseHeapProbe::allocations = ReverbSparseHeapProbe::frees = 0;
    ReverbSparseHeapProbe::previous = _CrtSetAllocHook(ReverbSparseHeapProbe::hook);
    ReverbSparseHeapProbe::active = true;
#endif
    for (int start = 0; start < length;)
    {
        int count = juce::jmin(blockSize, length - start);
        for (const int event : {feedEnd, holdAt, toggleAt, offAt, toggleBackAt, thirdToggleAt, reselectAt})
            if (start < event) count = juce::jmin(count, event - start);
        const bool active = !retire || start < offAt || start >= reselectAt;
        settings.refined = toggle ? start >= toggleAt && (start < toggleBackAt || start >= thirdToggleAt) : refined;
        if constexpr (std::is_same_v<Family, BuiltInPlateReverb>) settings.freeze = held && start >= holdAt;
        else settings.hold = held && start >= holdAt ? 2.0f : 0.0f;
        family->configure(active ? mode : -1, settings, spillover);
        for (int sample = start; sample < start + count; ++sample)
        {
            random = random * 1664525u + 1013904223u;
            const float noise = (static_cast<float>(random >> 8) / 8388608.0f - 1) * .1f;
            // Keep nonzero input during deselection to detect leaked history;
            // reselection receives silence and must stay silent without Spillover.
            const bool feed = sample < feedEnd || (retire && sample >= offAt && sample < reselectAt);
            const auto output = family->process(feed ? noise : 0, feed ? -noise * .7f : 0);
            for (int channel = 0; channel < 2; ++channel)
            {
                const float value = output[static_cast<size_t>(channel)];
                result.finite = result.finite && std::isfinite(value);
                result.audio.setSample(channel, sample, value);
            }
        }
        start += count;
    }
#if JUCE_WINDOWS && defined(_DEBUG)
    ReverbSparseHeapProbe::active = false;
    _CrtSetAllocHook(ReverbSparseHeapProbe::previous);
    result.allocations = ReverbSparseHeapProbe::allocations;
    result.frees = ReverbSparseHeapProbe::frees;
#endif
    result.sparseFrames = family->sparseProcessedFrames();
    return result;
}

inline double difference(const juce::AudioBuffer<float>& first, const juce::AudioBuffer<float>& second)
{
    double error = 0;
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = 0; sample < first.getNumSamples(); ++sample)
            error = juce::jmax(error, std::abs(static_cast<double>(first.getSample(channel, sample)) - second.getSample(channel, sample)));
    return error;
}

inline double energy(const juce::AudioBuffer<float>& audio, int start, int end)
{
    double value = 0;
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = start; sample < end; ++sample)
        {
            const double amplitude = audio.getSample(channel, sample);
            value += amplitude * amplitude;
        }
    return value;
}

template <typename Family>
bool checkFamily(juce::Array<juce::var>& cases, const char* name, int mode, double rate, bool expectedRefinement)
{
    const auto original = render<Family>(rate, mode, 127, false);
    const auto originalPartition = render<Family>(rate, mode, 513, false);
    const auto refined = render<Family>(rate, mode, 127, true);
    const auto refinedPartition = render<Family>(rate, mode, 513, true);
    const auto live = render<Family>(rate, mode, 127, false, true);
    const auto livePartition = render<Family>(rate, mode, 513, false, true);
    const auto retired = render<Family>(rate, mode, 127, true, false, true);
    const auto retained = render<Family>(rate, mode, 127, true, false, true, true);
    const auto held = render<Family>(rate, mode, 127, true, false, false, false, true);
    const double partitionError = juce::jmax(difference(original.audio, originalPartition.audio),
        difference(refined.audio, refinedPartition.audio), difference(live.audio, livePartition.audio));
    const double changed = difference(original.audio, refined.audio);
    const int reselectAt = juce::roundToInt(rate * .38);
    const double staleEnergy = energy(retired.audio, reselectAt, retired.audio.getNumSamples());
    const double retainedEnergy = energy(retained.audio, reselectAt, retained.audio.getNumSamples());
    bool finite = true, noHeap = true;
    for (const auto* capture : {&original, &originalPartition, &refined, &refinedPartition, &live, &livePartition, &retired, &retained, &held})
    {
        finite = capture->finite && finite;
        noHeap = capture->allocations == 0 && capture->frees == 0 && noHeap;
    }
    const bool pass = finite && noHeap && partitionError == 0 && original.sparseFrames == 0
        && (expectedRefinement ? changed > 0 && refined.sparseFrames > 0 : changed == 0 && refined.sparseFrames == 0)
        && staleEnergy == 0 && retainedEnergy > 0
        && energy(held.audio, juce::roundToInt(rate * .3), held.audio.getNumSamples()) > 0;
    auto* row = new juce::DynamicObject();
    row->setProperty("family", name); row->setProperty("mode", mode); row->setProperty("sampleRate", rate);
    row->setProperty("pass", pass); row->setProperty("finite", finite); row->setProperty("partitionError", partitionError);
    row->setProperty("originalSparseFrames", static_cast<juce::int64>(original.sparseFrames));
    row->setProperty("refinedSparseFrames", static_cast<juce::int64>(refined.sparseFrames));
    row->setProperty("responseDifferenceDiagnostic", changed); row->setProperty("staleReselectionEnergy", staleEnergy);
    row->setProperty("retainedEnergyDiagnostic", retainedEnergy); row->setProperty("heapFree", noHeap);
    row->setProperty("originalEnergyBefore80msDiagnostic", energy(original.audio, 0, juce::roundToInt(rate * .08)));
    row->setProperty("refinedEnergyBefore80msDiagnostic", energy(refined.audio, 0, juce::roundToInt(rate * .08)));
    cases.add(row);
    return pass;
}

inline bool checkUtility(juce::Array<juce::var>& cases, double rate)
{
    BuiltInReverbSparseDiffusion diffusion;
    diffusion.prepare(rate); diffusion.configure(false);
    bool bypass = true, finite = true, bounded = true, resetSilent = true;
    for (int sample = 0; sample < 4096; ++sample)
    {
        const BuiltInReverbSparseDiffusion::Pair input {sample % 3 ? .371f : -.917f, sample % 7 ? -.537f : .819f};
        bypass = diffusion.process(input) == input && bypass;
    }
    bypass = diffusion.processedFrames() == 0 && bypass;
    diffusion.reset(); diffusion.configure(true);
    std::array<double, 2> impulseEnergy {};
    int lastNonzero = 0;
    for (int sample = 0; sample <= diffusion.supportSamples() + 2; ++sample)
    {
        const auto output = diffusion.process(sample == 0 ? BuiltInReverbSparseDiffusion::Pair {1,1} : BuiltInReverbSparseDiffusion::Pair {});
        for (size_t channel = 0; channel < 2; ++channel)
        {
            impulseEnergy[channel] += static_cast<double>(output[channel]) * output[channel];
            if (output[channel] != 0) lastNonzero = sample;
        }
    }
    const bool unitEnergy = std::abs(impulseEnergy[0] - 1) < 1e-6 && std::abs(impulseEnergy[1] - 1) < 1e-6;
    diffusion.reset(); diffusion.configure(true);
    for (int sample = 0; sample < 4096; ++sample)
    {
        const auto output = diffusion.process({sample % 2 ? 1.0f : -1.0f, sample % 3 ? -1.0f : 1.0f});
        for (const float value : output) { finite = finite && std::isfinite(value); bounded = bounded && std::abs(value) <= 2.829f; }
    }
    diffusion.configure(false);
    for (int sample = 0; sample < static_cast<int>(rate * .05) + 1; ++sample) diffusion.process({});
    diffusion.configure(true);
    for (int sample = 0; sample <= diffusion.supportSamples(); ++sample) resetSilent = diffusion.process({}) == BuiltInReverbSparseDiffusion::Pair {} && resetSilent;
    diffusion.reset(); diffusion.configure(true);
    for (int sample = 0; sample <= diffusion.supportSamples(); ++sample) resetSilent = diffusion.process({}) == BuiltInReverbSparseDiffusion::Pair {} && resetSilent;
    auto* row = new juce::DynamicObject();
    row->setProperty("family", "Sparse FIR"); row->setProperty("sampleRate", rate); row->setProperty("exactOriginalBypass", bypass);
    row->setProperty("unitImpulseEnergy", unitEnergy); row->setProperty("supportSamples", diffusion.supportSamples());
    row->setProperty("lastImpulseSample", lastNonzero); row->setProperty("peakAmplificationBound", 2.829);
    row->setProperty("resetAndDisableDiscardHistory", resetSilent); row->setProperty("finite", finite);
    const bool pass = bypass && unitEnergy && bounded && resetSilent && finite && lastNonzero == diffusion.supportSamples();
    row->setProperty("pass", pass); cases.add(row); return pass;
}
}

inline juce::var checkReverbSparseDiffusion()
{
    juce::Array<juce::var> cases;
    bool pass = true;
    for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        pass = ReverbSparseRegression::checkUtility(cases, rate) && pass;
        for (int mode = 0; mode < 3; ++mode)
            pass = ReverbSparseRegression::checkFamily<BuiltInPlateReverb>(cases, "Plate", mode, rate, true) && pass;
        for (int mode = 0; mode < 4; ++mode)
            pass = ReverbSparseRegression::checkFamily<BuiltInAmbientReverb>(cases, "Ambient", mode, rate, mode == 2) && pass;
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Opt-in sparse reverb readout diffusion"); result->setProperty("pass", pass); result->setProperty("cases", cases);
    result->setProperty("onsetAndEnergyMetrics", "diagnostic_only"); result->setProperty("audioQuality", "not_asserted");
    result->setProperty("loudnessMatch", "not_asserted");
#if JUCE_WINDOWS && defined(_DEBUG)
    result->setProperty("callbackHeapMeasured", true);
#else
    result->setProperty("callbackHeapMeasured", false);
#endif
    return result;
}
