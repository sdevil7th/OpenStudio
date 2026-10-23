#pragma once
#include "BuiltInShimmerScheduling.h"

namespace ShimmerPerformanceRegression
{
// Retained pre-optimization adapter as a signal oracle, not a production path.
class PreviousSpreadVoice
{
public:
    void prepare(double rate, int phase)
    {
        stretch.presetDefault(2, static_cast<float>(rate), true);
        stretch.setTransposeFactor(1);
        for (int i = 0; i < stretch.intervalSamples() * phase / 4; ++i) process(0, 0, 1);
    }
    std::array<float, 2> process(float left, float right, float ratio)
    {
        const auto slot = static_cast<size_t>(position);
        const std::array<float, 2> result{output[0][slot], output[1][slot]};
        input[0][slot] = left; input[1][slot] = right;
        if (++position == 64)
        {
            position = 0; stretch.setTransposeFactor(ratio);
            const float* in[]{input[0].data(), input[1].data()};
            float* out[]{output[0].data(), output[1].data()};
            stretch.process(in, 64, out, 64);
        }
        return result;
    }
private:
    signalsmith::stretch::SignalsmithStretch<float> stretch{0};
    std::array<std::array<float, 64>, 2> input{}, output{};
    int position = 0;
};
}

inline juce::var checkShimmerPerformanceBehavior()
{
    juce::Array<juce::var> rows; bool pass = true;
    int allocations = 0, frees = 0; bool heapMeasured = false;
    const auto beginHeap = [] {
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::allocations = ReverbCompatibilityHeapProbe::frees = 0;
        ReverbCompatibilityHeapProbe::previous = _CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
        ReverbCompatibilityHeapProbe::active = true;
#endif
    };
    const auto endHeap = [&] {
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::active = false;
        _CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
        allocations += ReverbCompatibilityHeapProbe::allocations;
        frees += ReverbCompatibilityHeapProbe::frees; heapMeasured = true;
#endif
    };
    const auto add = [&](juce::DynamicObject* row, bool good) {
        row->setProperty("pass", good); rows.add(row); pass = pass && good;
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (int role = 0; role < 4; ++role)
        for (bool afterSilence : {false, true})
    {
        ShimmerPerformanceRegression::PreviousSpreadVoice previous; previous.prepare(rate, role);
        BuiltInSpreadReverbPitchVoice current, deferred; current.prepare(rate, role); deferred.prepare(rate, role);
        // Populate analysis, synthesis and phase history, including at 192k.
        for (int i = 0; i < static_cast<int>(rate*.35); ++i)
            deferred.process(.1f*std::sin(.037f*static_cast<float>(i)),-.07f*std::cos(.051f*static_cast<float>(i)),2);
        double previousError = 0, deferredError = 0, energy = 0; bool finite = true;
        std::uint32_t noise = 17;
        beginHeap(); deferred.beginReset();
        int clearSteps=0;
        do { ++clearSteps; } while(!deferred.resetStep());
        int primeSteps = 0;
        do { ++primeSteps; } while (!deferred.primeStep());
        for (int i = 0; i < static_cast<int>(rate * (afterSilence ? 1.0 : .7)); ++i)
        {
            noise = noise * 1664525u + 1013904223u;
            float input = static_cast<float>(.08 * std::sin(i * 2 * juce::MathConstants<double>::pi * 223 / rate)
                + .031 * std::cos(i * 2 * juce::MathConstants<double>::pi * 997 / rate));
            if (afterSilence) input = i < static_cast<int>(rate * .35) ? 0
                : input + .02f * (static_cast<float>(noise >> 8) / 16777215.0f - .5f);
            const float ratio = std::array<float, 4>{.5f, 1, 2, std::pow(2.0f, 19.0f / 12.0f)}[static_cast<size_t>(role)];
            const auto a = previous.process(input, -.73f * input, ratio);
            const auto b = current.process(input, -.73f * input, ratio);
            const auto c = deferred.process(input, -.73f * input, ratio);
            for (size_t ch = 0; ch < 2; ++ch)
            {
                finite = finite && std::isfinite(b[ch]) && std::isfinite(c[ch]); energy += b[ch] * b[ch];
                previousError = juce::jmax(previousError, std::abs(static_cast<double>(a[ch]) - b[ch]));
                deferredError = juce::jmax(deferredError, std::abs(static_cast<double>(b[ch]) - c[ch]));
            }
        }
        endHeap();
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "fine_fft_and_incremental_reset_signal_parity");
        row->setProperty("sampleRate", rate); row->setProperty("role", role);
        row->setProperty("afterSilenceBroadband", afterSilence);
        row->setProperty("previousAdapterMaxError", previousError); row->setProperty("deferredResetMaxError", deferredError);
        row->setProperty("primeSteps", primeSteps);
        row->setProperty("boundedResetSteps",clearSteps);
        add(row, finite && energy > .001 && previousError < 1e-5 && deferredError == 0
            && clearSteps==deferred.resetSamples() && clearSteps>1
            && primeSteps == juce::jmax(1, deferred.primingSamples()));
    }
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        BuiltInReverbPitchVoice fresh,deferred;
        fresh.prepare(rate);deferred.prepare(rate);
        for(int sample=0;sample<static_cast<int>(rate*.35);++sample)
            deferred.process(.1f*std::sin(.037f*static_cast<float>(sample)),-.07f*std::cos(.051f*static_cast<float>(sample)),2);
        beginHeap();deferred.beginReset();
        int steps=0;do{++steps;}while(!deferred.resetStep());
        double maximumError=0,energy=0;
        for(int sample=0;sample<static_cast<int>(rate*.45);++sample)
        {
            const float input=.08f*std::sin(.029f*static_cast<float>(sample));
            const auto expected=fresh.process(input,-.73f*input,1.5f);
            const auto actual=deferred.process(input,-.73f*input,1.5f);
            for(size_t channel=0;channel<2;++channel)
            {
                maximumError=juce::jmax(maximumError,std::abs(static_cast<double>(actual[channel])-expected[channel]));
                energy+=static_cast<double>(actual[channel])*actual[channel];
            }
        }
        endHeap();
        auto* row=new juce::DynamicObject();row->setProperty("kind","original_populated_history_incremental_reset_parity");
        row->setProperty("sampleRate",rate);row->setProperty("boundedResetSteps",steps);row->setProperty("maxError",maximumError);
        add(row,maximumError==0&&energy>.001&&steps==deferred.resetSamples()&&steps>1);
    }
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (bool spread : {false, true})
    {
        auto engine = std::make_unique<BuiltInAdditionalReverbs>(); engine->prepare(rate, 5);
        BuiltInAdditionalReverbs::Settings settings{.1f, .3f, .6f, .7f, 0, 20, 10000, 1, 1};
        settings.spreadShimmer = spread; settings.shimmerRoute = 1; settings.voiceMix = .5f;
        engine->configure(5, settings);
        bool finite = true, gate = true;
        beginHeap();
        for (int i = 0; i < static_cast<int>(rate * .4); ++i)
        {
            const auto out = engine->process(i < 100 ? .1f : 0, 0);
            finite = finite && std::isfinite(out[0]) && std::isfinite(out[1]);
        }
        const auto inputFrames = engine->shimmerTankPitchProcessedFrames();
        const bool slept = engine->shimmerTankPitchSuspended();
        settings.shimmerRoute = 2; engine->configure(5, settings);
        engine->process(0, 0);
        const int warmup = engine->shimmerTankPitchWarmupRemaining();
        gate = !spread || (warmup > 0 && engine->shimmerTankRouteGain() == 0);
        // Cancel before history is ready; no partially warmed return is allowed.
        for (int i = 0; i < static_cast<int>(rate * .03); ++i) engine->process(0, 0);
        settings.shimmerRoute = 1; engine->configure(5, settings);
        for (int i = 0; i < static_cast<int>(rate * .06); ++i) engine->process(0, 0);
        gate = gate && (!spread || engine->shimmerTankPitchSuspended());
        // Wake again, and automate pitch while refilling.
        settings.shimmerRoute = 0; settings.pitchA = -12; settings.pitchB = 19;
        engine->configure(5, settings);
        for (int i = 0; i < static_cast<int>(rate * .4); ++i)
        {
            const auto out = engine->process(0, 0);
            finite = finite && std::isfinite(out[0]) && std::isfinite(out[1]);
            if (engine->shimmerTankPitchWarmupRemaining() > 0) gate = gate && engine->shimmerTankRouteGain() == 0;
        }
        gate = gate && !engine->shimmerTankPitchSuspended() && engine->shimmerTankPitchWarmupRemaining() == 0
            && engine->shimmerTankRouteGain() == 1;
        double staleEnergy = 0;
        for (int i = 0; i < static_cast<int>(rate * .5); ++i)
        {
            const auto out = engine->process(0, 0);
            staleEnergy += out[0] * out[0] + out[1] * out[1];
        }
        endHeap();
        auto* row = new juce::DynamicObject(); row->setProperty("kind", "input_sleep_interrupted_route_wakeup_no_stale_return");
        row->setProperty("sampleRate", rate); row->setProperty("spread", spread);
        row->setProperty("inputTankProcessedFrames", static_cast<juce::int64>(inputFrames));
        row->setProperty("wakeSamples", warmup); row->setProperty("staleEnergy", staleEnergy);
        add(row, finite && gate && slept == spread && (spread ? inputFrames == 0 : inputFrames > 0) && staleEnergy < 1e-8);
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Shimmer performance signal and lifecycle gates");
    result->setProperty("cases", rows); result->setProperty("pass", pass && allocations == 0 && frees == 0);
    result->setProperty("callbackHeapMeasured", heapMeasured); result->setProperty("callbackAllocations", allocations);
    result->setProperty("callbackFrees", frees); result->setProperty("audioQuality", "not_asserted");
    return juce::var(result);
}
