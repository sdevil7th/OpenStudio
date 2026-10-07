#pragma once
#include <JuceHeader.h>

// Original wet-return pitch spread. This modulates a prepared fractional delay,
// not the captured room geometry or the portable source impulse response.
class BuiltInConvolutionMotion
{
    std::array<std::vector<float>,2> history;
    juce::SmoothedValue<float> depth, speed;
    double rate=48000, phase=0;
    int position=0, valid=0, drain=0;
public:
    void prepare(double sampleRate)
    {
        rate=sampleRate;
        for(auto& channel:history)channel.assign(static_cast<size_t>(std::ceil(rate*.005))+2,0);
        depth.reset(rate,.03);speed.reset(rate,.05);reset();
    }
    void reset() noexcept
    {
        position=valid=drain=0;phase=0;
        depth.setCurrentAndTargetValue(0);speed.setCurrentAndTargetValue(.3f);
    }
    void configure(float milliseconds,float hertz) noexcept
    {
        depth.setTargetValue(std::isfinite(milliseconds)?juce::jlimit(0.0f,5.0f,milliseconds):0);
        speed.setTargetValue(std::isfinite(hertz)?juce::jlimit(.05f,5.0f,hertz):.3f);
    }
    bool isDraining() const noexcept { return drain>0; }
    void process(juce::AudioBuffer<float>& buffer) noexcept
    {
        if(history[0].empty())return;
        const int size=static_cast<int>(history[0].size());
        for(int sample=0;sample<buffer.getNumSamples();++sample)
        {
            const float amount=depth.getNextValue()*static_cast<float>(rate)*.001f;
            const float frequency=speed.getNextValue();
            bool excited=false;
            for(int channel=0;channel<2;++channel)
            {
                const float input=buffer.getSample(channel,sample);
                auto& data=history[static_cast<size_t>(channel)];data[static_cast<size_t>(position)]=input;
                excited=excited||input!=0;
                if(amount>0)
                {
                    const float delay=amount*.5f*(1+static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*(phase+channel*.25))));
                    const int whole=static_cast<int>(delay);const float fraction=delay-static_cast<float>(whole);
                    const float first=whole<=valid?data[static_cast<size_t>((position+size-whole)%size)]:0;
                    const float second=whole+1<=valid?data[static_cast<size_t>((position+size-whole-1)%size)]:0;
                    buffer.setSample(channel,sample,first+fraction*(second-first));
                }
            }
            drain=excited?size:juce::jmax(0,drain-1);
            valid=juce::jmin(size-1,valid+1);if(++position==size)position=0;
            phase+=frequency/rate;if(phase>=1)phase-=1;
        }
    }
};
