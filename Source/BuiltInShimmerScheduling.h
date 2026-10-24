#pragma once
#include "BuiltInReverbPitchVoice.h"

// Opt-in split scheduling keeps the pinned 120 ms / 30 ms spectral setup.
// The additional hop is internal to the pitch return, never the dry path.
class BuiltInSpreadReverbPitchVoice
{
public:
    void prepare(double sampleRate, int phaseQuarter)
    {
        stretch.presetDefault(2, static_cast<float>(sampleRate), true);
        stretch.setTransposeFactor(1.0f);
        primeSamples = stretch.intervalSamples() * juce::jlimit(0, 3, phaseQuarter) / 4;
        reset();
    }
    void reset()
    {
        beginReset();
        while (!resetStep()) {}
        while (!primeStep()) {}
    }
    // Live changes call beginReset once and advance at most one silent sample
    // per real sample. Never run the entire role offset in one audio callback.
    void beginReset()
    {
        stretch.beginReset();resetting=true;
        for(auto& bank:input)for(auto& channel:bank)channel.fill(0);
        for (auto& channel : output) channel.fill(0);
        position = 0;
        writeBank=0;groupReady=false;groupSilence=0;
        primeRemaining = primeSamples;
        // Role offsets are reproducible, including after a reset/reprepare.
        // No plugin identity, wall clock or random instance phase is used.
    }
    bool resetStep()
    {
        if(resetting)resetting=!stretch.resetStep(resetBudget);
        return !resetting;
    }
    int resetSamples()const noexcept{return static_cast<int>(stretch.resetStepCount(resetBudget));}
    bool primeStep()
    {
        if (primeRemaining > 0) { process(0, 0, 1); --primeRemaining; }
        return primeRemaining == 0;
    }
    int primingSamples() const noexcept { return primeSamples; }
    int latencySamples() const noexcept
    {
        return stretch.inputLatency() + stretch.outputLatency() + chunkSize;
    }
    int extraLatencySamples() const noexcept { return stretch.intervalSamples(); }
    std::array<float, 2> process(float left, float right, float ratio)
    {
        const auto slot = static_cast<size_t>(position);
        const std::array<float, 2> result{output[0][slot], output[1][slot]};
        input[writeBank][0][slot] = left; input[writeBank][1][slot] = right;
        position=(position+1)%chunkSize;
        if(position==0)
        {
            writeBank=1-writeBank;groupReady=true;
            const auto& pending=input[1-writeBank];
            const float* completeGroup[]{pending[0].data(),pending[1].data()};
            stretch.setTransposeFactor(juce::jlimit(.25f,4.0f,ratio));
            groupSilence=stretch.beginProcessGroup(completeGroup,chunkSize)?1:0;
        }
        if(groupReady&&position%workQuantum==0)
        {
            // Keep the existing 64-sample return delay, but distribute the
            // library's spectral stages over eight-sample work quanta. At
            // 192 kHz the former adapter regrouped split stages into bursts.
            const auto offset=static_cast<size_t>(position);
            const auto& pending=input[1-writeBank];
            const float* in[]{pending[0].data()+offset,pending[1].data()+offset};
            float* out[]{output[0].data()+offset, output[1].data()+offset};
            stretch.process(in, workQuantum, out, workQuantum,groupSilence);
        }
        return result;
    }
private:
    static constexpr int chunkSize = 64;
    static constexpr int workQuantum = 8;
    static constexpr size_t resetBudget = 32;
    signalsmith::stretch::SignalsmithStretch<float, void, true> stretch{0};
    std::array<std::array<std::array<float,chunkSize>,2>,2> input{};
    std::array<std::array<float, chunkSize>, 2> output{};
    int position = 0, primeSamples = 0, primeRemaining = 0;
    bool resetting = false;
    size_t writeBank=0;
    bool groupReady=false;
    int groupSilence=0;
};

// Both banks are prepared off the callback. A live change clears the target
// voices one at a time, warms their history, then fades for 20 ms. The inactive
// bank does no spectral work once the fade ends. Original takes an exact bypass.
class BuiltInShimmerScheduling
{
public:
    void prepare(double sampleRate, int warmupSamples, int primeSamples = 0, int resetSamples = 0)
    {
        fade.reset(sampleRate, .02);
        warmup = juce::jmax(1, warmupSamples);
        priming = juce::jmax(0, primeSamples);
        clearingSamples = juce::jmax(0, resetSamples);
        reset();
    }
    void reset() noexcept
    {
        initialized = false; requestedSpread = stableSpread = targetSpread = false;
        phase = idle; remaining = resetVoice = resetCountdown = 0;
        blend = 0; fade.setCurrentAndTargetValue(0);
    }
    void configure(bool spread, bool spreadHistoryReady = true) noexcept
    {
        requestedSpread = spread;
        if (!initialized)
        {
            const bool startSpread = spread && spreadHistoryReady;
            initialized = true; stableSpread = targetSpread = startSpread;
            blend = startSpread ? 1.0f : 0.0f;
            fade.setCurrentAndTargetValue(startSpread ? 1.0 : 0.0);
        }
        else if (phase == fading)
            fade.setTargetValue(spread ? 1.0 : 0.0);
    }
    // Returns one target-bank voice to reset, at most once every 64 samples.
    // This moves existing-library reset/prime work away from one large burst.
    int advance() noexcept
    {
        if (phase != fading && requestedSpread == stableSpread)
        {
            phase = idle; blend = stableSpread ? 1.0f : 0.0f;
            return -1;
        }
        if (phase == idle)
        {
            targetSpread = requestedSpread;
            phase = clearing; resetVoice = resetCountdown = 0;
        }
        if (phase == clearing)
        {
            if (resetCountdown > 0) { --resetCountdown; return -1; }
            const int voice = resetVoice++;
            resetCountdown = 63;
            if (resetVoice == 4)
            {
                phase = clearingSamples>0?clearingBank:targetSpread && priming > 0 ? primingBank : warming;
                remaining = phase==clearingBank?clearingSamples:phase == primingBank ? priming : warmup;
            }
            return voice;
        }
        if(phase==clearingBank)
        {
            if(--remaining<=0){phase=targetSpread&&priming>0?primingBank:warming;remaining=phase==primingBank?priming:warmup;}
            return -1;
        }
        if (phase == primingBank)
        {
            if (--remaining <= 0) { phase = warming; remaining = warmup; }
            return -1;
        }
        if (phase == warming)
        {
            if (--remaining <= 0)
            {
                phase = fading;
                fade.setCurrentAndTargetValue(stableSpread ? 1.0 : 0.0);
                fade.setTargetValue(requestedSpread ? 1.0 : 0.0);
            }
            else return -1;
        }
        if (phase == fading)
        {
            blend = static_cast<float>(fade.getNextValue());
            if (!fade.isSmoothing())
            {
                stableSpread = requestedSpread;
                targetSpread = stableSpread;
                phase = idle; blend = stableSpread ? 1.0f : 0.0f;
            }
        }
        return -1;
    }
    bool resetSpreadBank() const noexcept { return targetSpread; }
    bool clearingTargetBank()const noexcept{return phase==clearing||phase==clearingBank;}
    bool primeSpreadBank() const noexcept { return phase == primingBank; }
    bool processOriginal() const noexcept
    {
        return !stableSpread || phase == fading || (phase == warming && !targetSpread);
    }
    bool processSpread() const noexcept
    {
        return stableSpread || phase == fading || (phase == warming && targetSpread);
    }
    bool isSettled() const noexcept { return phase == idle && requestedSpread == stableSpread; }
    bool isSpread() const noexcept { return stableSpread; }
    std::array<float, 2> mix(const std::array<float, 2>& original,
                           const std::array<float, 2>& spread) const noexcept
    {
        if (blend == 0) return original;
        if (blend == 1) return spread;
        return {original[0] * (1 - blend) + spread[0] * blend,
                original[1] * (1 - blend) + spread[1] * blend};
    }
private:
    enum Phase {idle, clearing, clearingBank, primingBank, warming, fading};
    Phase phase = idle;
    juce::SmoothedValue<double> fade;
    int warmup = 1, priming = 0, clearingSamples=0, remaining = 0, resetVoice = 0, resetCountdown = 0;
    float blend = 0;
    bool initialized = false, requestedSpread = false, stableSpread = false, targetSpread = false;
};
