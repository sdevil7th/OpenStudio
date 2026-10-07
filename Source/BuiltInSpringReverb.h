#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"
#include <array>
#include <vector>

// Original dispersive bidirectional delay model. Its coefficients are not a
// measured spring geometry or a simulation of a commercial tank/transducer.
class BuiltInSpringReverb
{
public:
    struct Settings
    {
        float decay=3, damping=.5f, predelay=0, lowCut=20, highCut=20000, width=1;
        float count=2, dwell=0, dispersion=.6f, tension=.5f, bass=0, motion=.2f;
        bool hold=false, acceptsInput=false;
    };
private:
    struct Line
    {
        std::vector<float> data; int position=0, valid=0;
        void prepare(int length) { data.assign(static_cast<size_t>(length),0); reset(); }
        void reset() noexcept { position=valid=0; }
        float read(float delay) const noexcept
        {
            delay=juce::jlimit(1.0f,static_cast<float>(data.size()-2),delay);
            const int whole=static_cast<int>(delay); const float fraction=delay-static_cast<float>(whole);
            const auto at=[&](int offset){return offset>valid?0.0f:data[static_cast<size_t>((position-offset+static_cast<int>(data.size()))%static_cast<int>(data.size()))];};
            return at(whole)+(at(whole+1)-at(whole))*fraction;
        }
        void push(float value) noexcept { data[static_cast<size_t>(position)]=value;position=(position+1)%static_cast<int>(data.size());valid=juce::jmin(valid+1,static_cast<int>(data.size())-1); }
    };
    struct Allpass
    {
        double first=0, second=0;
        float process(float input,double a1,double a2) noexcept
        {
            const double output=a2*input+first;
            first=a1*input-a1*output+second;second=input-a2*output;
            return static_cast<float>(output);
        }
        void reset() noexcept { first=second=0; }
    };
    static constexpr size_t stages=12;
    struct Spring
    {
        Line forward, backward;
        std::array<std::array<Allpass,stages>,2> scatter;
        std::array<double,stages> targetA1{},targetA2{},a1{},a2{};
        juce::SmoothedValue<float> length, loss, amount;
        std::array<float,2> damping{};
        void reset() noexcept
        {
            forward.reset();backward.reset();for(auto& leg:scatter)for(auto& section:leg)section.reset();
            damping={};
        }
    };
    std::array<std::array<Spring,3>,2> springs;
    std::array<Line,2> pre;
    std::array<float,2> inputLow{}, wetLow{}, wetHigh{}, dcInput{}, dcOutput{};
    juce::SmoothedValue<float> weight, predelay, dampPole, bassGain, width, drive, nonlinear, lowPole, highPole, lowEnable, highEnable, motion, inputGate;
    double fs=48000, phase=0, coefficientStep=1;
    Settings settings;
    bool enabled=false, awake=false, initialized=false;
    float bassPole=0, dcPole=0;
    BuiltInReverbRetirement<1> retirement;

public:
    void prepare(double sampleRate)
    {
        fs=juce::jmax(8000.0,sampleRate);coefficientStep=1-std::exp(-1/(fs*.05));
        bassPole=static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*250/fs));
        dcPole=static_cast<float>(std::exp(-juce::MathConstants<double>::twoPi*8/fs));
        for(auto& channel:springs)for(auto& spring:channel)
        {
            spring.forward.prepare(static_cast<int>(fs*.15)+8);spring.backward.prepare(static_cast<int>(fs*.15)+8);
            for(auto* smoother:{&spring.length,&spring.loss,&spring.amount})smoother->reset(fs,.05);
        }
        for(auto& line:pre)line.prepare(static_cast<int>(fs*.501)+8);
        for(auto* smoother:{&weight,&predelay,&dampPole,&bassGain,&width,&drive,&nonlinear,&lowPole,&highPole,&lowEnable,&highEnable,&motion,&inputGate})smoother->reset(fs,.05);
        retirement.prepare(fs,-1);reset();
    }
    void reset() noexcept
    {
        for(auto& channel:springs)for(auto& spring:channel)spring.reset();for(auto& line:pre)line.reset();
        inputLow={};wetLow={};wetHigh={};dcInput={};dcOutput={};phase=0;initialized=false;awake=enabled=false;weight.setCurrentAndTargetValue(0);retirement.reset({weight});
    }
    double retiringTailSeconds()const noexcept{return retirement.retiringTailSeconds();}
    bool isSuspended() const noexcept { return !awake; }
    void configure(bool active,Settings next,bool retainTails=false)
    {
        if(!active&&retainTails&&awake){next=settings;next.hold=false;}
        if(active&&next.hold&&initialized&&awake)
        {
            // Hold the current lossless geometry; edited values remain in the
            // processor's saved controls and are picked up when Hold releases.
            next.tension=settings.tension;next.dispersion=settings.dispersion;next.count=settings.count;
        }
        retirement.configure(0,active,retainTails,juce::jlimit(.8,10.0,static_cast<double>(next.decay))*2+2+next.predelay*.001);
        const bool shapeChanged=!initialized||settings.tension!=next.tension||settings.dispersion!=next.dispersion||settings.decay!=next.decay||settings.hold!=next.hold;
        enabled=active;settings=next;
        if(active&&!awake){awake=true;initialized=false;}
        weight.setTargetValue(active?1.0f:0.0f);
        if(!awake)return;
        const auto set=[&](auto& smoother,float value){if(initialized)smoother.setTargetValue(value);else smoother.setCurrentAndTargetValue(value);};
        const int count=juce::jlimit(1,3,juce::roundToInt(next.count));
        const int colour=juce::jlimit(0,3,juce::roundToInt(next.dwell));
        constexpr float gains[]{1,2,4,8};set(drive,gains[colour]);set(nonlinear,colour>=2?1.0f:0.0f);
        set(predelay,next.predelay*static_cast<float>(fs)*.001f);set(width,next.width);set(motion,next.hold?0.0f:next.motion);
        set(inputGate,next.hold&&!next.acceptsInput?0.0f:1.0f);
        set(dampPole,next.hold?1.0f:static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*(12000-11000*next.damping)/fs)));
        set(bassGain,juce::Decibels::decibelsToGain(juce::jlimit(-10.0f,10.0f,next.bass)));
        set(lowPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*next.lowCut/fs)));
        set(highPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*next.highCut/fs)));
        set(lowEnable,next.lowCut>20?1.0f:0.0f);set(highEnable,next.highCut<20000?1.0f:0.0f);
        for(size_t ch=0;ch<2;++ch)for(size_t index=0;index<3;++index)
        {
            auto& spring=springs[ch][index];const double stretch=1.4-.8*juce::jlimit(0.0f,1.0f,next.tension);
            const double seconds=(.023+static_cast<double>(index)*.0073+static_cast<double>(ch)*.00071)*stretch;
            set(spring.length,static_cast<float>(std::round(seconds*fs)));
            set(spring.amount,static_cast<int>(index)<count?1.0f/static_cast<float>(count):0.0f);
            if(shapeChanged||!initialized)
            {
            double groupDelay=0;
            for(size_t stage=0;stage<stages;++stage)
            {
                const double center=(650+static_cast<double>(stage)*135+static_cast<double>(index)*73)/stretch;
                const double bandwidth=240-210*juce::jlimit(0.0f,1.0f,next.dispersion);
                const double radius=std::exp(-juce::MathConstants<double>::twoPi*bandwidth/fs);
                const double angle=juce::MathConstants<double>::twoPi*juce::jmin(center,fs*.4)/fs;
                spring.targetA1[stage]=-2*radius*std::cos(angle);spring.targetA2[stage]=radius*radius;
                if(!initialized){spring.a1[stage]=spring.targetA1[stage];spring.a2[stage]=spring.targetA2[stage];}
                const double omega=juce::MathConstants<double>::twoPi*1000/fs;
                groupDelay+=(1-radius*radius)/(1+radius*radius-2*radius*std::cos(omega-angle))
                    +(1-radius*radius)/(1+radius*radius-2*radius*std::cos(omega+angle));
            }
            // Nominal 1 kHz decay includes each dispersive propagation leg.
            set(spring.loss,next.hold?1.0f:static_cast<float>(std::exp(-6.907755*(seconds+groupDelay/fs)/juce::jlimit(.8f,10.0f,next.decay))));
            }
        }
        initialized=true;
    }
    std::array<float,3> process(float left,float right) noexcept
    {
        const float mix=weight.getNextValue(),wetMix=retirement.next(0);if(!awake)return {};
        if(!enabled&&mix<=0&&wetMix<=0){reset();return {};}
        const float delay=predelay.getNextValue(),damp=dampPole.getNextValue(),bass=bassGain.getNextValue(),spread=width.getNextValue();
        const float gain=drive.getNextValue(),colour=nonlinear.getNextValue(),low=lowPole.getNextValue(),high=highPole.getNextValue();
        const float useLow=lowEnable.getNextValue(),useHigh=highEnable.getNextValue(),depth=motion.getNextValue(),excitation=inputGate.getNextValue();
        phase+=juce::MathConstants<double>::twoPi*.37/fs;if(phase>=juce::MathConstants<double>::twoPi)phase-=juce::MathConstants<double>::twoPi;
        const std::array<float,2> input{left,right};std::array<float,2> wet{};
        for(size_t ch=0;ch<2;++ch)
        {
            float source=enabled&&std::isfinite(input[ch])?juce::jlimit(-8.0f,8.0f,input[ch]):0.0f;
            inputLow[ch]+=bassPole*(source-inputLow[ch]);source+=(bass-1)*inputLow[ch];
            source*=gain;const float saturation=std::tanh(source+.12f)-std::tanh(.12f);source+=colour*(saturation-source);
            const float dc=source-dcInput[ch]+dcPole*dcOutput[ch];dcInput[ch]=source;dcOutput[ch]=dc;source+=colour*(dc-source);
            source*=excitation;
            const float delayed=(delay<1?source:pre[ch].read(delay))*excitation;pre[ch].push(source);
            for(size_t index=0;index<3;++index)
            {
                auto& spring=springs[ch][index];const float length=spring.length.getNextValue(),loss=spring.loss.getNextValue();
                const float offset=depth*static_cast<float>(fs*.00015*std::sin(phase+static_cast<double>(index)*1.7+static_cast<double>(ch)*.8));
                float outward=spring.forward.read(length+offset),inward=spring.backward.read(length-offset);
                for(size_t stage=0;stage<stages;++stage)
                {
                    spring.a1[stage]+=coefficientStep*(spring.targetA1[stage]-spring.a1[stage]);spring.a2[stage]+=coefficientStep*(spring.targetA2[stage]-spring.a2[stage]);
                    outward=spring.scatter[0][stage].process(outward,spring.a1[stage],spring.a2[stage]);inward=spring.scatter[1][stage].process(inward,spring.a1[stage],spring.a2[stage]);
                }
                spring.damping[0]+=damp*(outward-spring.damping[0]);spring.damping[1]+=damp*(inward-spring.damping[1]);
                spring.forward.push(juce::jlimit(-4.0f,4.0f,delayed*.3f-spring.damping[1]*loss));
                spring.backward.push(juce::jlimit(-4.0f,4.0f,-spring.damping[0]*loss));
                wet[ch]+=outward*spring.amount.getNextValue();
            }
            wetLow[ch]+=low*(wet[ch]-wetLow[ch]);wet[ch]-=useLow*wetLow[ch];wetHigh[ch]+=high*(wet[ch]-wetHigh[ch]);wet[ch]+=useHigh*(wetHigh[ch]-wet[ch]);
        }
        const float mid=(wet[0]+wet[1])*.5f,side=(wet[0]-wet[1])*.5f*spread;
        return {(mid+side)*wetMix,(mid-side)*wetMix,mix};
    }
};
