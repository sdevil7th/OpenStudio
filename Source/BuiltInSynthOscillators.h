#pragma once
#include <JuceHeader.h>
#include <array>

class BuiltInSynthOscillators
{
public:
    struct Frame {std::array<std::array<float,4>,2> weights{};std::array<int,2> selected{};std::array<bool,2> moving{};};
    static float blep(float phase,float delta) noexcept
    {
        if(delta<=0)return 0;
        if(phase<delta){const float t=phase/delta;return t+t-t*t-1.0f;}
        if(phase>1.0f-delta){const float t=(phase-1.0f)/delta;return t*t+t+t+1.0f;}
        return 0;
    }
    static float saw(float phase,float delta) noexcept{return (2.0f*phase-1.0f)-blep(phase,delta);}
    static float square(float phase,float delta) noexcept
    {
        float value=phase<.5f?1.0f:-1.0f;value+=blep(phase,delta);float fallingPhase=phase-.5f;if(fallingPhase<0)fallingPhase+=1.0f;value-=blep(fallingPhase,delta);return value;
    }
    // Integral of the quadratic BLEP, rounding both triangle slope changes.
    static float blamp(float phase,float delta) noexcept
    {
        if(delta<=0)return 0;
        const float distance=juce::jmin(phase,1-phase);
        if(distance>=delta)return 0;
        const float t=1-distance/delta;
        return delta*t*t*t/3;
    }
    static float wave(int shape,float phase,float delta) noexcept
    {
        if(shape==0)return saw(phase,delta);
        if(shape==1)return square(phase,delta);
        if(shape==3)return std::sin(juce::MathConstants<float>::twoPi*phase);
        float opposite=phase+.5f;if(opposite>=1)opposite-=1;
        return 1-4*std::abs(phase-.5f)+4*(blamp(phase,delta)-blamp(opposite,delta));
    }
    void prepare(double rate,int a,int b) noexcept {for(auto& bank:weights)for(auto& weight:bank)weight.reset(rate,.02);configure(a,b,true);}
    void configure(int a,int b,bool initialize=false) noexcept
    {
        selected={juce::jlimit(0,3,a),juce::jlimit(0,3,b)};
        for(size_t bank=0;bank<2;++bank)for(size_t shape=0;shape<4;++shape){const float value=static_cast<int>(shape)==selected[bank]?1.0f:0.0f;if(initialize)weights[bank][shape].setCurrentAndTargetValue(value);else weights[bank][shape].setTargetValue(value);}
    }
    Frame next() noexcept
    {
        Frame frame;frame.selected=selected;
        for(size_t bank=0;bank<2;++bank)for(size_t shape=0;shape<4;++shape){frame.moving[bank]=frame.moving[bank]||weights[bank][shape].isSmoothing();frame.weights[bank][shape]=weights[bank][shape].getNextValue();}
        return frame;
    }
    static float sample(const Frame& frame,size_t bank,float phase,float delta) noexcept
    {
        if(!frame.moving[bank])return wave(frame.selected[bank],phase,delta);
        float value=0;for(size_t shape=0;shape<4;++shape)if(frame.weights[bank][shape]!=0)value+=frame.weights[bank][shape]*wave(static_cast<int>(shape),phase,delta);return value;
    }
    static float modulatedSample(const Frame& frame,size_t bank,float phase,float delta,float shapeOffset,float pulseOffset) noexcept
    {
        if(shapeOffset==0&&pulseOffset==0)return sample(frame,bank,phase,delta);
        const float width=juce::jlimit(.05f,.95f,.5f+.45f*pulseOffset);
        const auto shaped=[&](int shape) noexcept
        {
            if(shape!=1||pulseOffset==0)return wave(shape,phase,delta);
            float falling=phase-width;if(falling<0)falling+=1;
            return (phase<width?1.0f:-1.0f)+blep(phase,delta)-blep(falling,delta)-(2*width-1);
        };
        float value=0;
        for(size_t shape=0;shape<4;++shape)
        {
            const float weight=frame.moving[bank]?frame.weights[bank][shape]:static_cast<int>(shape)==frame.selected[bank]?1.0f:0.0f;
            if(weight==0)continue;
            const float position=juce::jlimit(0.0f,3.0f,static_cast<float>(shape)+3*shapeOffset);
            const int low=static_cast<int>(position),high=juce::jmin(3,low+1);
            const float fraction=position-static_cast<float>(low);
            value+=weight*(shaped(low)*(1-fraction)+shaped(high)*fraction);
        }
        return value;
    }
private:
    std::array<std::array<juce::SmoothedValue<float>,4>,2> weights;
    std::array<int,2> selected{0,1};
};
