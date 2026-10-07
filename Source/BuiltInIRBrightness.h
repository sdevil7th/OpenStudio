#pragma once
#include <JuceHeader.h>
#include "BuiltInIRPreparation.h"

// Prepared original synthetic bright response. Causal 10 ms energy envelopes
// drive deterministic high-band noise independently for each measured path.
// This does not infer venue geometry or recover frequencies absent in the input.
struct BuiltInIRBrightness
{
    static bool apply(juce::AudioBuffer<float>& response,double sampleRate,double amount,double directEnd,BuiltInIRPreparation* progress=nullptr)
    {
        if(amount<=0)return true;amount=juce::jlimit(0.0,1.0,amount);
        const int count=response.getNumSamples(),first=juce::jlimit(0,count,static_cast<int>(std::ceil(directEnd*sampleRate)));
        if(first>=count)return true;
        const double envelopePole=std::exp(-1/(sampleRate*.01)),highPole=std::exp(-juce::MathConstants<double>::twoPi*juce::jmin(3000.0,sampleRate*.2)/sampleRate);
        const int fade=juce::jmax(1,juce::jmin(count-first,juce::roundToInt(sampleRate*.01)));
        std::vector<float> synthetic(static_cast<size_t>(count-first));
        for(int ch=0;ch<response.getNumChannels();++ch)
        {
            juce::Random random(0x4f534252+ch*7919);double envelope=0,low1=0,low2=0,originalEnergy=0,syntheticEnergy=0;
            for(int i=first;i<count;++i)
            {
                if((i&4095)==0&&progress&&progress->isCancelled())return false;
                const double value=response.getSample(ch,i);originalEnergy+=value*value;
                envelope=envelopePole*envelope+(1-envelopePole)*value*value;
                const double noise=(random.nextDouble()*2-1)*std::sqrt(3.0*envelope);
                low1=noise+highPole*(low1-noise);const double high1=noise-low1;
                low2=high1+highPole*(low2-high1);const double high2=high1-low2;
                const double endFade=juce::jlimit(0.0,1.0,static_cast<double>(count-1-i)/fade);
                const float sample=static_cast<float>(high2*endFade);synthetic[static_cast<size_t>(i-first)]=sample;syntheticEnergy+=sample*sample;
            }
            if(originalEnergy<=1e-24||syntheticEnergy<=1e-24)continue;
            const float gain=static_cast<float>(amount*.5*std::sqrt(originalEnergy/syntheticEnergy));
            for(int i=first;i<count;++i)response.addSample(ch,i,synthetic[static_cast<size_t>(i-first)]*gain);
        }
        return true;
    }
};
