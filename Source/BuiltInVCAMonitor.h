#pragma once
#include <JuceHeader.h>

// Original optional noise floor and post-mix monitor. Not sampled hardware noise.
class BuiltInVCAMonitor
{
public:
    void prepare(double sampleRate){rate=sampleRate;for(auto& value:amount)value.reset(rate,.02);for(auto& value:monitor)value.reset(rate,.02);matrix.reset(rate,.02);reset();}
    void reset() noexcept{seeds={0x31415926u,0x27182818u};phase=0;initialized=false;}
    void configure(bool active,float left,float right,int routing,int hum,int mode)
    {
        const auto set=[this](auto& value,double target){if(initialized)value.setTargetValue(target);else value.setCurrentAndTargetValue(target);};
        const auto safe=[](float x){return std::isfinite(x)?juce::jlimit(0.0,1.0,static_cast<double>(x)):0;};
        set(amount[0],active?safe(left):0);set(amount[1],active?safe(routing==0?left:right):0);
        // Fade the coordinate change too, retaining independent random streams.
        for(size_t i=0;i<4;++i)set(monitor[i],i==static_cast<size_t>(active?juce::jlimit(0,3,mode):0)?1:0);
        set(matrix,active&&routing==2?1:0);increment=(hum==1?60.0:50.0)/rate;initialized=true;
    }
    std::array<float,2> noise() noexcept
    {
        std::array<double,2> level {amount[0].getNextValue(),amount[1].getNextValue()};
        matrixMix=matrix.getNextValue();if(level[0]==0&&level[1]==0)return {};
        const double hum=std::sin(juce::MathConstants<double>::twoPi*phase)*.000063095734448;phase+=increment;if(phase>=1)phase-=1;
        std::array<float,2> output{};
        for(size_t ch=0;ch<2;++ch){const double a=uniform(ch),b=uniform(ch);output[ch]=static_cast<float>(level[ch]*((a-b)*.00030837506693+hum));}
        if(matrixMix>0)return{static_cast<float>(output[0]*(1-matrixMix)+(output[0]+output[1])*.7071067811865475*matrixMix),static_cast<float>(output[1]*(1-matrixMix)+(output[0]-output[1])*.7071067811865475*matrixMix)};
        return output;
    }
    std::array<float,2> listen(float left,float right) noexcept
    {
        std::array<double,4> weights{};for(size_t i=0;i<4;++i)weights[i]=monitor[i].getNextValue();
        if(weights[0]==1)return{left,right};
        const double mono=(static_cast<double>(left)+right)*.5;
        const double first=left*(1-matrixMix)+(left+right)*.7071067811865475*matrixMix,second=right*(1-matrixMix)+(left-right)*.7071067811865475*matrixMix;
        return{static_cast<float>(weights[0]*left+weights[1]*first+weights[2]*mono+weights[3]*second),
            static_cast<float>(weights[0]*right+weights[1]*first+weights[2]*mono+weights[3]*second)};
    }
private:
    double uniform(size_t ch) noexcept{auto& x=seeds[ch];x^=x<<13;x^=x>>17;x^=x<<5;return static_cast<double>(x>>8)/16777216.0;}
    double rate=48000,phase=0,increment=50.0/48000;double matrixMix=0;bool initialized=false;
    juce::SmoothedValue<double> matrix;
    std::array<uint32_t,2> seeds{};
    std::array<juce::SmoothedValue<double>,2> amount;
    std::array<juce::SmoothedValue<double>,4> monitor;
};
