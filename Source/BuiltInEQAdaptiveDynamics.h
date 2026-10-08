#pragma once
#include <JuceHeader.h>

// Original band-level adaptation, distinct from per-frequency spectral dynamics.
class BuiltInEQAdaptiveDynamics
{
    float average=0, peak=0, rms=0, rise=0, fall=0, peakDecay=0, rmsStep=0;
    bool initialized=false;
public:
    void prepare(double rate) noexcept
    {
        rise=static_cast<float>(1-std::exp(-1/(rate*.5)));
        fall=static_cast<float>(1-std::exp(-1/(rate*2)));
        rmsStep=static_cast<float>(1-std::exp(-1/(rate*.003)));
        peakDecay=static_cast<float>(std::exp(-1/(rate*.08)));reset();
    }
    void reset(float initialPower=0) noexcept
    {
        average=peak=rms=std::isfinite(initialPower)?juce::jlimit(0.0f,1024.0f,initialPower):0;
        initialized=average>1e-12f;
    }
    void process(float power) noexcept
    {
        power=std::isfinite(power)?juce::jlimit(0.0f,1024.0f,power):0;
        if(!initialized&&power>1e-12f){average=peak=rms=power;initialized=true;}
        average+=(power>average?rise:fall)*(power-average);
        peak=juce::jmax(power,peak*peakDecay);
        rms+=rmsStep*(power-rms);
    }
    float level()const noexcept{return std::sqrt(juce::jmax(0.0f,rms));}
    float threshold(float sensitivity) const noexcept
    {
        const float level=10*std::log10(juce::jmax(1e-10f,average));
        return juce::jlimit(-80.0f,0.0f,level+6-juce::jlimit(-12.0f,12.0f,sensitivity));
    }
    std::array<float,2> timing(float frequency,float range) const noexcept
    {
        const float crest=juce::jlimit(0.0f,3.0f,std::sqrt(peak/juce::jmax(1e-10f,average))-1);
        const float hz=juce::jlimit(20.0f,20000.0f,frequency);
        return {juce::jlimit(.2f,80.0f,2000/hz/(1+crest)),
            juce::jlimit(40.0f,1000.0f,10000/hz+80+8*std::abs(range)+30*crest)};
    }
};
