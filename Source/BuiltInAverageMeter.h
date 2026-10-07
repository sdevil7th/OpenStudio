#pragma once
#include <JuceHeader.h>
#include <array>

// Original average meter: rectified sine-peak calibration and two real poles.
// The 300 ms / 99% step target is not certified electromechanical VU behavior.
class BuiltInAverageMeter
{
public:
    void prepare(double rate) noexcept { coefficient=-std::expm1(-6.63835206799/(.3*juce::jmax(8000.0,rate)));reset(); }
    void reset() noexcept
    {
        first={};second={};for(auto& value:levels)value.store(-100);
    }
    void measure(const juce::AudioBuffer<float>& audio,bool output) noexcept
    {
        if(audio.getNumChannels()<1)return;
        for(size_t channel=0;channel<2;++channel)
        {
            const size_t index=(output?2:0)+channel;
            const auto* samples=audio.getReadPointer(juce::jmin(static_cast<int>(channel),audio.getNumChannels()-1));
            for(int i=0;i<audio.getNumSamples();++i)
            {
                const double value=std::isfinite(samples[i])?juce::jmin(16.0,std::abs(static_cast<double>(samples[i]))):0;
                first[index]+=coefficient*(value-first[index]);
                second[index]+=coefficient*(first[index]-second[index]);
            }
            levels[index].store(static_cast<float>(juce::Decibels::gainToDecibels(second[index]*juce::MathConstants<double>::halfPi,-100.0)),std::memory_order_relaxed);
        }
    }
    float db(bool output,int channel) const noexcept { return levels[static_cast<size_t>((output?2:0)+juce::jlimit(0,1,channel))].load(std::memory_order_relaxed); }
private:
    double coefficient=.001;
    std::array<double,4> first{},second{};
    std::array<std::atomic<float>,4> levels{-100,-100,-100,-100};
};
