#pragma once

#if JUCE_WINDOWS && JUCE_DEBUG
#include <crtdbg.h>
namespace ReverbCompatibilityHeapProbe
{
inline thread_local bool active = false;
inline thread_local int allocations = 0, frees = 0;
inline _CRT_ALLOC_HOOK previous = nullptr;
inline int hook(int kind, void* data, size_t size, int blockType, long request, const unsigned char* file, int line)
{
    if (active)
    {
        if (kind == _HOOK_ALLOC || kind == _HOOK_REALLOC) ++allocations;
        if (kind == _HOOK_FREE) ++frees;
    }
    return previous ? previous(kind, data, size, blockType, request, file, line) : 1;
}
}
#endif

// Include outside FreePluginRegression.cpp's anonymous namespace so this
// fixture's narrowly-scoped friend matches the production declaration.
struct OpenStudioReverbCompatibilityRegressionAccess
{
    static void forceProcessing(OpenStudioReverb& reverb, bool force) { reverb.compatibilitySleepEnabled = !force; }
    static std::uint64_t calls(const OpenStudioReverb& reverb) { return reverb.compatibilityProcessingCalls; }
    static bool sleeping(const OpenStudioReverb& reverb) { return reverb.compatibilitySleeping; }
    static void unguardedV2(OpenStudioReverb& reverb) { reverb.v2DiffusionHistoryGuardsEnabled = false; }
    static void zeroV2Pool(OpenStudioReverb& reverb) { std::fill(reverb.v2DiffusionPool.begin(), reverb.v2DiffusionPool.end(), 0.0f); }
    static const BuiltInInfiniteHoldBudget& nonlinearBudget(const OpenStudioReverb& reverb){return reverb.additionalSpaces.nonlinearInfiniteBudget();}
    static const BuiltInInfiniteHoldBudget& nonlinearLateBudget(const OpenStudioReverb& reverb){return reverb.additionalSpaces.nonlinearLateInfiniteBudget();}
    static const BuiltInInfiniteHoldBudget& springBudget(const OpenStudioReverb& reverb){return reverb.springSpace.infiniteBudget();}
    static const BuiltInInfiniteHoldBudget& risingBudget(const OpenStudioReverb& reverb){return reverb.ambientSpace.risingInfiniteBudget();}
    static bool shimmerSettled(const OpenStudioReverb& reverb){return reverb.additionalSpaces.shimmerSchedulingSettled();}
    static bool shimmerSpread(const OpenStudioReverb& reverb){return reverb.additionalSpaces.shimmerSchedulingSpread();}
    static std::array<float,14> smoothers(const OpenStudioReverb& reverb)
    {
        return {reverb.smoothedWetLevel.getCurrentValue(), reverb.smoothedDryLevel.getCurrentValue(),
            reverb.smoothedEarlyLevel.getCurrentValue(), reverb.smoothedInputSend.getCurrentValue(),
            reverb.smoothedShimmerAmount.getCurrentValue(), reverb.smoothedV2Width.getCurrentValue(),
            reverb.smoothedV2Ducking.getCurrentValue(), reverb.smoothedV2Movement.getCurrentValue(),
            reverb.smoothedV2EarlyLate.getCurrentValue(), reverb.smoothedV2Diffusion.getCurrentValue(),
            reverb.smoothedV2ShimmerRegen.getCurrentValue(), reverb.smoothedV5AlternativeVoiceBlend.getCurrentValue(),
            reverb.smoothedV3PadMode.getCurrentValue(), reverb.smoothedV3LoopDampingCoefficient.getCurrentValue()};
    }
};

inline juce::var checkReverbCompatibilitySleep()
{
    using Access = OpenStudioReverbCompatibilityRegressionAccess;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Standalone compatibility dispatcher sleep");
    result->setProperty("audioQuality", "not_asserted");
    result->setProperty("timing", "diagnostic_only");
    juce::Array<juce::var> cases;
    bool overall = true;
    double maximumOutputError = 0, maximumSmootherError = 0;
    int allocations = 0, frees = 0;
    bool heapMeasured = false;
    const auto processChecked = [&] (OpenStudioReverb& processor, juce::AudioBuffer<float>& audio, juce::MidiBuffer& midi) {
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::allocations = ReverbCompatibilityHeapProbe::frees = 0;
        ReverbCompatibilityHeapProbe::previous = _CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
        ReverbCompatibilityHeapProbe::active = true;
#endif
        processor.processBlock(audio, midi);
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::active = false;
        _CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
        allocations += ReverbCompatibilityHeapProbe::allocations;
        frees += ReverbCompatibilityHeapProbe::frees;
        heapMeasured = true;
#endif
    };
    const auto add = [&] (juce::DynamicObject* item, bool pass) {
        item->setProperty("pass", pass); cases.add(juce::var(item)); overall = overall && pass;
    };
    const auto configure = [] (OpenStudioReverb& reverb, int channels, int type, float engine, double rate) {
        auto layout = reverb.getBusesLayout();
        layout.inputBuses.set(0, channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
        layout.outputBuses.set(0, channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
        const bool layoutPass = reverb.setBusesLayout(layout);
        reverb.selectAlgorithm(type); reverb.engineVersion.store(engine);
        reverb.wetLevel.store(.6f); reverb.dryLevel.store(.25f); reverb.shimmerAmount.store(.17f);
        reverb.prepareToPlay(rate, 512);
        return layoutPass;
    };
    const auto signal = [] (int sample, int channel, double rate) {
        return .035f * std::sin(static_cast<float>(sample) * static_cast<float>(1079.0 / rate))
            * (channel == 0 ? 1.0f : -.73f) + (sample == 0 ? .125f : 0.0f);
    };
    const auto renderPair = [&] (double rate, int channels, int type, float engine, bool embedded, bool oldDiffuser) {
        const int previousAllocations = allocations, previousFrees = frees;
        auto optimized = std::make_unique<OpenStudioReverb>(!embedded);
        auto baseline = std::make_unique<OpenStudioReverb>(!embedded);
        bool pass = configure(*optimized, channels, type, engine, rate)
            && configure(*baseline, channels, type, engine, rate);
        Access::forceProcessing(*baseline, true);
        if (oldDiffuser) Access::unguardedV2(*baseline);
        const int length = juce::roundToInt(rate * .30), event = juce::roundToInt(rate * .18);
        const int settled = juce::roundToInt(rate * .14);
        const int outputs = optimized->getTotalNumOutputChannels();
        juce::AudioBuffer<float> actual(outputs, 512), expected(outputs, 512);
        juce::MidiBuffer midi;
        double outputError = 0, smootherError = 0;
        std::uint64_t settledCalls = 0;
        for (int start = 0, block = 0; start < length; ++block)
        {
            if (start == event)
            {
                for (auto* processor : {optimized.get(), baseline.get()})
                {
                    processor->wetLevel.store(.39f); processor->dryLevel.store(.67f);
                    processor->width.store(.31f); processor->movement.store(.71f);
                    processor->earlyLevel.store(.19f); processor->diffusion.store(.81f);
                    processor->ducking.store(.61f); processor->earlyLate.store(.76f);
                    processor->shimmerAmount.store(.31f); processor->shimmerRegen.store(.29f);
                }
                if (oldDiffuser)
                {
                    optimized->resetTailState(); baseline->resetTailState();
                    // Historical baseline explicitly swept this V2 pool.
                    // This fixture performs that sweep outside processBlock.
                    Access::zeroV2Pool(*baseline);
                }
            }
            const std::array<int,4> partitions {17,127,512,63};
            int count = juce::jmin(partitions[static_cast<size_t>(block % 4)], length - start);
            if (start < event) count = juce::jmin(count, event - start);
            actual.setSize(outputs, count, false, false, true); actual.clear();
            for (int ch = 0; ch < channels; ++ch)
                for (int i = 0; i < count; ++i) actual.setSample(ch, i, signal(start + i, ch, rate));
            expected.makeCopyOf(actual, true);
            const auto before = Access::calls(*optimized);
            processChecked(*optimized, actual, midi); baseline->processBlock(expected, midi);
            if (start >= settled) settledCalls += Access::calls(*optimized) - before;
            for (int ch = 0; ch < outputs; ++ch)
                for (int i = 0; i < count; ++i)
                {
                    pass = std::isfinite(actual.getSample(ch, i)) && pass;
                    outputError = juce::jmax(outputError, std::abs(static_cast<double>(actual.getSample(ch, i)) - expected.getSample(ch, i)));
                }
            const auto a = Access::smoothers(*optimized), b = Access::smoothers(*baseline);
            for (size_t i = 0; i < a.size(); ++i) smootherError = juce::jmax(smootherError, std::abs(static_cast<double>(a[i]) - b[i]));
            start += count;
        }
        pass = pass && outputError == 0 && smootherError == 0;
        pass = pass && (embedded ? settledCalls > 0 && !Access::sleeping(*optimized)
                               : settledCalls == 0 && Access::sleeping(*optimized));
        maximumOutputError = juce::jmax(maximumOutputError, outputError);
        maximumSmootherError = juce::jmax(maximumSmootherError, smootherError);
        auto* item = new juce::DynamicObject(); item->setProperty("kind", oldDiffuser ? "guarded_vs_swept_v2" : embedded ? "embedded_nam_unchanged" : "forced_processing_parity");
        item->setProperty("sampleRate", rate); item->setProperty("channels", channels); item->setProperty("type", type);
        item->setProperty("engine", engine); item->setProperty("maxOutputError", outputError);
        item->setProperty("maxSmootherError", smootherError); item->setProperty("settledCompatibilityCalls", static_cast<double>(settledCalls));
        item->setProperty("allocations", allocations - previousAllocations); item->setProperty("frees", frees - previousFrees);
        add(item, pass);
    };
    for (const double rate : {44100.0,48000.0,96000.0,192000.0})
        for (const int channels : {1,2})
        {
            for (const float engine : {1.0f,2.0f,3.0f,4.0f,5.0f})
            {
                renderPair(rate, channels, 0, engine, false, false);
                renderPair(rate, channels, 0, engine, true, engine == 2.0f);
            }
        }
    for (int type = 1; type < OpenStudioReverb::standaloneTypeCount; ++type)
        renderPair(48000, 2, type, 1, false, false);

    // Exercise sleeping -> audible compatibility transitions with silent input.
    // Outgoing dedicated tanks are allowed to finish their 50 ms selection ramp;
    // their presence must not be mistaken for resurrected compatibility history.
    for (const double rate : {44100.0,48000.0,96000.0,192000.0})
        for (const int channels : {1,2})
            for (const float engine : {1.0f,2.0f,3.0f,4.0f,5.0f})
            {
                const int previousAllocations = allocations, previousFrees = frees;
                auto processor = std::make_unique<OpenStudioReverb>(true);
                bool pass = configure(*processor, channels, 6, engine, rate);
                processor->dryLevel.store(0); processor->wetLevel.store(1);
                juce::AudioBuffer<float> block(processor->getTotalNumOutputChannels(), 512); juce::MidiBuffer midi;
                const int wake = juce::roundToInt(rate * .20), end = juce::roundToInt(rate * .39);
                std::uint64_t wakeCalls = 0; double silencePeak = 0;
                for (int start = 0; start < end;)
                {
                    if (start == wake)
                    {
                        pass = pass && Access::sleeping(*processor);
                        processor->studioEngines[0].store(0); processor->selectAlgorithm(0);
                        processor->dryLevel.store(0); processor->wetLevel.store(1);
                        wakeCalls = Access::calls(*processor);
                    }
                    int count = juce::jmin(127, end - start); if (start < wake) count = juce::jmin(count, wake - start);
                    block.setSize(block.getNumChannels(), count, false, false, true); block.clear();
                    if (start < juce::roundToInt(rate * .035))
                        for (int ch = 0; ch < channels; ++ch)
                            for (int i = 0; i < count; ++i) block.setSample(ch, i, signal(start + i, ch, rate));
                    processChecked(*processor, block, midi);
                    if (start >= wake + juce::roundToInt(rate * .065)) silencePeak = juce::jmax(silencePeak, static_cast<double>(block.getMagnitude(0, count)));
                    start += count;
                }
                pass = pass && Access::calls(*processor) > wakeCalls && !Access::sleeping(*processor) && silencePeak == 0;
                auto* item = new juce::DynamicObject(); item->setProperty("kind", "silent_compatibility_wake");
                item->setProperty("sampleRate", rate); item->setProperty("channels", channels); item->setProperty("engine", engine);
                item->setProperty("postFadeSilencePeak", silencePeak);
                item->setProperty("allocations", allocations - previousAllocations); item->setProperty("frees", frees - previousFrees); add(item, pass);
            }

    // IR response, layout and selector edits each abandon the old coverage proof.
    auto reverb = std::make_unique<OpenStudioReverb>(true);
    bool publicationPass = configure(*reverb, 2, 7, 1, 48000);
    juce::AudioBuffer<float> block(reverb->getTotalNumOutputChannels(), 127); juce::MidiBuffer midi;
    const auto settle = [&] { for (int i = 0; i < 80; ++i) { block.clear(); processChecked(*reverb, block, midi); } return Access::sleeping(*reverb); };
    const auto wakes = [&] { const auto before = Access::calls(*reverb); block.clear(); processChecked(*reverb, block, midi); return Access::calls(*reverb) > before && !Access::sleeping(*reverb); };
    juce::Array<juce::var> publicationEvents;
    const auto publicationEvent = [&] (const char* name, bool pass) {
        auto* event = new juce::DynamicObject(); event->setProperty("event", name); event->setProperty("pass", pass);
        event->setProperty("sleeping", Access::sleeping(*reverb)); event->setProperty("calls", static_cast<double>(Access::calls(*reverb)));
        publicationEvents.add(event); publicationPass = publicationPass && pass;
    };
    publicationEvent("initial_settle", settle());
    // Split auxiliary layout is valid only for a four-path IR. Publish a
    // deterministic prepared matrix first; a stereo default must reject that
    // layout, so using it here would test an invalid request rather than wake.
    juce::MemoryBlock matrixBytes;
    {
        juce::MemoryOutputStream stream(matrixBytes, false);
        stream.writeInt(0x4f534952); stream.writeDouble(48000); stream.writeInt(4); stream.writeInt(2048);
        for (int channel = 0; channel < 4; ++channel)
            for (int sample = 0; sample < 2048; ++sample)
                stream.writeFloat(sample == 60 + channel * 47 ? .3f : 0.0f);
    }
    publicationEvent("matrix_replacement", reverb->convolutionSpace.restore(juce::var(matrixBytes), "Compatibility matrix fixture", 0));
    publicationEvent("replacement_wake", wakes()); publicationEvent("replacement_settle", settle());
    const auto previousRevision = reverb->convolutionSpace.publicationRevision();
    auto* layout = new juce::DynamicObject(); layout->setProperty("outputLayout", 1);
    publicationEvent("layout_edit", reverb->convolutionSpace.edit(juce::var(layout)));
    publicationEvent("layout_revision", reverb->convolutionSpace.publicationRevision() > previousRevision);
    publicationEvent("layout_wake", wakes()); publicationEvent("layout_settle", settle());
    auto* response = new juce::DynamicObject(); response->setProperty("reverse", true);
    publicationEvent("response_edit", reverb->convolutionSpace.edit(juce::var(response)));
    publicationEvent("response_wake", wakes()); publicationEvent("response_settle", settle());
    reverb->selectAlgorithm(2); publicationEvent("selector_wake", wakes()); publicationEvent("selector_settle", settle());
    reverb->plateCharacter.store(2); publicationEvent("plate_character_wake", wakes()); publicationEvent("plate_character_settle", settle());
    reverb->engineVersion.store(2); publicationEvent("engine_wake", wakes()); publicationEvent("engine_settle", settle());
    reverb->tailSpillover.store(1); publicationEvent("spillover_wake", wakes()); publicationEvent("spillover_settle", settle());
    reverb->plateEngine.store(0); publicationEvent("legacy_wake", wakes()); publicationEvent("legacy_remains_awake", !settle());
    auto* publication = new juce::DynamicObject(); publication->setProperty("kind", "routing_and_ir_publication_wake");
    publication->setProperty("events", publicationEvents); add(publication, publicationPass);
    result->setProperty("cases", cases); result->setProperty("caseCount", cases.size());
    result->setProperty("maxOutputError", maximumOutputError); result->setProperty("maxSmootherError", maximumSmootherError);
    result->setProperty("audioThreadHeapMeasured", heapMeasured);
    result->setProperty("audioThreadAllocations", allocations); result->setProperty("audioThreadFrees", frees);
    result->setProperty("pass", overall && allocations == 0 && frees == 0); return juce::var(result);
}
