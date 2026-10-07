#pragma once
#include <JuceHeader.h>
#include <array>

// Wet-output retention is separate from type weights used by the dry mixer.
// Existing prepared tanks still own history, excitation and finite drain expiry.
template <size_t Count>
class BuiltInReverbSpillover
{
    std::array<juce::SmoothedValue<float>,Count> wet;
    std::array<bool,Count> wasActive {}, retained {};
public:
    void prepare(double rate,int selected)
    {
        for(size_t i=0;i<Count;++i){wet[i].reset(rate,.05);wasActive[i]=selected==static_cast<int>(i);retained[i]=false;wet[i].setCurrentAndTargetValue(wasActive[i]?1.0f:0.0f);}
    }
    void reset(const std::array<juce::SmoothedValue<float>,Count>& activeWeights) noexcept
    {
        retained.fill(false);
        for(size_t i=0;i<Count;++i){wet[i]=activeWeights[i];wasActive[i]=wet[i].getTargetValue()>0;}
    }
    void configure(size_t index,bool active,bool spillover,bool hasTail) noexcept
    {
        if(active)retained[index]=false;
        else if(wasActive[index])retained[index]=spillover;
        if(!spillover||!hasTail)retained[index]=false;
        const float target=active?1.0f:retained[index]?wet[index].getCurrentValue():0.0f;
        wet[index].setTargetValue(target);wasActive[index]=active;
    }
    bool audibleRetiring(size_t index) const noexcept { return !wasActive[index] && wet[index].getCurrentValue()>0; }
    float next(size_t index) noexcept{return wet[index].getNextValue();}
};

// Families that previously suspended after their selection fade need a finite
// retirement clock as well as a separate wet weight. Expiry runs per sample so
// its fade and suspension do not depend on host block partitioning.
template <size_t Count>
class BuiltInReverbRetirement
{
    std::array<juce::SmoothedValue<float>, Count> wet;
    std::array<bool, Count> active {}, retained {};
    std::array<juce::int64, Count> remaining {}, duration {};
    double sampleRate = 48000;
    juce::int64 fadeSamples = 2400;
public:
    void prepare(double rate, int selected)
    {
        sampleRate = rate;
        fadeSamples = juce::jmax<juce::int64>(1, static_cast<juce::int64>(std::ceil(rate * .05)));
        remaining.fill(0); duration.fill(0); retained.fill(false);
        for (size_t i = 0; i < Count; ++i)
        {
            active[i] = selected == static_cast<int>(i);
            wet[i].reset(rate, .05);
            wet[i].setCurrentAndTargetValue(active[i] ? 1.0f : 0.0f);
        }
    }
    void reset(const std::array<juce::SmoothedValue<float>, Count>& selection) noexcept
    {
        remaining.fill(0); duration.fill(0); retained.fill(false);
        for (size_t i = 0; i < Count; ++i) { wet[i] = selection[i]; active[i] = selection[i].getTargetValue() > 0; }
    }
    void configure(size_t i, bool selected, bool spillover, double seconds) noexcept
    {
        if (selected)
        {
            duration[i] = static_cast<juce::int64>(std::ceil(sampleRate * juce::jlimit(.05, 120.0, std::isfinite(seconds) ? seconds : .05)));
            remaining[i] = 0; retained[i] = false; wet[i].setTargetValue(1);
        }
        else
        {
            if (active[i])
            {
                retained[i] = spillover && duration[i] > 0;
                remaining[i] = retained[i] ? duration[i] : 0;
                if (retained[i]) wet[i].setCurrentAndTargetValue(wet[i].getCurrentValue());
            }
            if (!spillover) { retained[i] = false; remaining[i] = 0; }
            if (!retained[i]) wet[i].setTargetValue(0);
        }
        active[i] = selected;
    }
    float next(size_t i) noexcept
    {
        if (retained[i])
        {
            if (remaining[i] <= fadeSamples) wet[i].setTargetValue(0);
            if (remaining[i] > 0) --remaining[i];
            if (remaining[i] == 0) retained[i] = false;
        }
        return wet[i].getNextValue();
    }
    double retiringTailSeconds() const noexcept
    {
        juce::int64 samples = 0;
        for (size_t i = 0; i < Count; ++i)
            if (!active[i] && wet[i].getCurrentValue() > 0) samples = juce::jmax(samples, remaining[i]);
        return static_cast<double>(samples) / sampleRate;
    }
};
