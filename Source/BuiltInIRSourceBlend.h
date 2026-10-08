#pragma once
#include <JuceHeader.h>

// Interpolation between the two recorded source columns of a true-stereo IR.
// No geometry, HRTF or new propagation path is inferred from these measurements.
struct BuiltInIRSourceBlend
{
    static void apply(juce::AudioBuffer<float>& response,int order,double left,double right) noexcept
    {
        if(response.getNumChannels()!=4||(left==0&&right==1))return;
        const int lr=order==0?1:2,rl=order==0?2:1;
        const float a=static_cast<float>(juce::jlimit(0.0,1.0,left)),b=static_cast<float>(juce::jlimit(0.0,1.0,right));
        for(int i=0;i<response.getNumSamples();++i)
        {
            const float ll=response.getSample(0,i),lToR=response.getSample(lr,i),rToL=response.getSample(rl,i),rr=response.getSample(3,i);
            response.setSample(0,i,ll+a*(rToL-ll));response.setSample(lr,i,lToR+a*(rr-lToR));
            response.setSample(rl,i,ll+b*(rToL-ll));response.setSample(3,i,lToR+b*(rr-lToR));
        }
    }
};
