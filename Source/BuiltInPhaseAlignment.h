#pragma once
#include <JuceHeader.h>

// Original causal timing and allpass primitives. Intentional timing offsets are
// not host compensation latency. Integer taps retain exact legacy samples.
class BuiltInPhaseAlignment
{
public:
    struct Tap
    {
        double delay = 0;
        int integer = 0;
        std::array<double, 4> weights { 1,0,0,0 };
        void set(double samples)
        {
            delay = samples; integer = static_cast<int>(std::floor(samples));
            const double f = samples-integer;
            weights = { -(f-1)*(f-2)*(f-3)/6, f*(f-2)*(f-3)/2, -f*(f-1)*(f-3)/2, f*(f-1)*(f-2)/6 };
        }
        float read(const juce::AudioBuffer<float>& ring, int channel, int position) const noexcept
        {
            const int size = ring.getNumSamples();
            const int index = (position-integer+size)%size;
            if (weights[0] == 1) return ring.getSample(channel,index);
            double result = 0;
            for (size_t i=0;i<4;++i) result += weights[i]*ring.getSample(channel,(index-static_cast<int>(i)+size)%size);
            return static_cast<float>(result);
        }
    };
    struct Channel { float enabled=0, frequency=1000, stages=0; };
    static double coefficient(double rate, double frequency)
    {
        const double tangent=std::tan(juce::MathConstants<double>::pi*juce::jlimit(20.0,rate*.45,frequency)/rate);
        return (tangent-1)/(tangent+1);
    }
    void prepare(double sampleRate)
    {
        rate=sampleRate;
        for(auto& smoother:coefficients) smoother.reset(rate,.01);
        for(auto& channel:weights) for(auto& weight:channel) weight.reset(rate,.01);
        reset();
    }
    void reset() noexcept { histories={}; initialized=false; }
    void configure(const std::array<Channel,2>& settings)
    {
        const auto set=[this](auto& smoother,auto value) { if(initialized) smoother.setTargetValue(value); else smoother.setCurrentAndTargetValue(value); };
        for(size_t ch=0;ch<2;++ch)
        {
            set(coefficients[ch],coefficient(rate,settings[ch].frequency));
            const int stages=settings[ch].enabled>=.5f?juce::jlimit(1,4,juce::roundToInt(settings[ch].stages)+1):0;
            for(size_t i=0;i<5;++i) set(weights[ch][i],static_cast<int>(i)==stages?1.0:0.0);
        }
        initialized=true;
    }
    float process(size_t channel,float input) noexcept
    {
        const double a=coefficients[channel].getNextValue(); double signal=input;
        double weight=weights[channel][0].getNextValue(), sum=weight, output=signal*weight;
        for(size_t stage=0;stage<4;++stage)
        {
            auto& history=histories[channel][stage];
            const double next=a*signal+history;
            history=signal-a*next; signal=next;
            weight=weights[channel][stage+1].getNextValue(); sum+=weight; output+=weight*signal;
        }
        return static_cast<float>(output/juce::jmax(1e-12,sum));
    }
private:
    double rate=48000;
    bool initialized=false;
    std::array<juce::SmoothedValue<double>,2> coefficients;
    std::array<std::array<juce::SmoothedValue<double>,5>,2> weights;
    std::array<std::array<double,4>,2> histories {};
};
