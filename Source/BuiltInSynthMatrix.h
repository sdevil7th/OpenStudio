#pragma once
#include <JuceHeader.h>
#include <array>

class BuiltInSynthMatrix
{
public:
    static constexpr size_t targetCount=28;
    using Destinations=std::array<float,targetCount>;
    struct RouteFrame
    {
        std::array<float,13> sources{};Destinations targets{};
        int source=0,target=0;float amount=0;bool transitioning=false;
    };
    struct Frame
    {
        std::array<RouteFrame,8> routes{};
        std::array<float,4> macros{};
        std::array<float,16> wheel{},pressure{};
        float globalLfo=0,legacyWheel=1;
    };
    void prepare(double rate,const std::array<float,11>& values)
    {
        for(auto& route:routes){route.amount.reset(rate,.02);for(auto& source:route.sources)source.reset(rate,.02);for(auto& target:route.targets)target.reset(rate,.02);}
        for(auto* controls:{&wheel,&pressure})for(auto& control:*controls)control.reset(rate,.02);
        for(auto& channel:polyPressure)for(auto& voice:channel)voice.reset(rate,.02);
        for(auto& macro:macros)macro.reset(rate,.02);
        setExtendedTargets({},true);
        globalLfo.reset(rate,.02);legacyWheel.reset(rate,.02);setTargets(values,true);reset();
    }
    void reset() noexcept
    {
        for(auto* controls:{&wheel,&pressure})for(auto& control:*controls)control.setCurrentAndTargetValue(0);
        for(auto& channel:polyPressure)for(auto& voice:channel)voice.setCurrentAndTargetValue(0);
        globalLfo.setCurrentAndTargetValue(globalLfo.getTargetValue());legacyWheel.setCurrentAndTargetValue(legacyWheel.getTargetValue());
    }
    void setTargets(const std::array<float,11>& values,bool initialize=false) noexcept
    {
        const auto set=[initialize](auto& control,float value){if(initialize)control.setCurrentAndTargetValue(value);else control.setTargetValue(value);};
        set(globalLfo,values[0]>=.5f?1.0f:0.0f);set(legacyWheel,values[1]>=.5f?0.0f:1.0f);
        for(size_t i=0;i<3;++i)
        {
            auto& route=routes[i];route.source=juce::jlimit(0,12,juce::roundToInt(values[2+i*3]));route.target=juce::jlimit(0,static_cast<int>(targetCount)-1,juce::roundToInt(values[3+i*3]));
            set(route.amount,juce::jlimit(-1.0f,1.0f,values[4+i*3]));
            for(size_t j=0;j<route.sources.size();++j)set(route.sources[j],static_cast<int>(j)==route.source?1.0f:0.0f);
            for(size_t j=0;j<route.targets.size();++j)set(route.targets[j],static_cast<int>(j)==route.target?1.0f:0.0f);
            route.updateTransition();
        }
    }
    // Five appended routes, followed by four globally smoothed performance macros.
    void setExtendedTargets(const std::array<float,19>& values,bool initialize=false) noexcept
    {
        const auto set=[initialize](auto& control,float value){if(initialize)control.setCurrentAndTargetValue(value);else control.setTargetValue(value);};
        for(size_t i=0;i<5;++i)
        {
            auto& route=routes[i+3];route.source=juce::jlimit(0,12,juce::roundToInt(values[i*3]));route.target=juce::jlimit(0,static_cast<int>(targetCount)-1,juce::roundToInt(values[1+i*3]));
            set(route.amount,juce::jlimit(-1.0f,1.0f,values[2+i*3]));
            for(size_t j=0;j<route.sources.size();++j)set(route.sources[j],static_cast<int>(j)==route.source?1.0f:0.0f);
            for(size_t j=0;j<route.targets.size();++j)set(route.targets[j],static_cast<int>(j)==route.target?1.0f:0.0f);
            route.updateTransition();
        }
        for(size_t i=0;i<macros.size();++i)set(macros[i],juce::jlimit(0.0f,1.0f,values[15+i]));
    }
    void wheelTarget(size_t channel,float value) noexcept {wheel[channel].setTargetValue(value);}
    void pressureTarget(size_t channel,float value) noexcept {pressure[channel].setTargetValue(value);}
    void polyTarget(size_t channel,size_t slot,float value) noexcept {polyPressure[channel][slot].setTargetValue(value);}
    void startVoice(size_t channel,size_t slot) noexcept {polyPressure[channel][slot].setCurrentAndTargetValue(0);}
    float poly(size_t channel,size_t slot) noexcept {return polyPressure[channel][slot].getNextValue();}
    void resetChannel(size_t channel) noexcept
    {
        wheel[channel].setTargetValue(0);pressure[channel].setTargetValue(0);
        for(auto& voice:polyPressure[channel])voice.setTargetValue(0);
    }
    Frame next() noexcept
    {
        Frame frame;for(size_t i=0;i<macros.size();++i)frame.macros[i]=macros[i].getNextValue();
        frame.globalLfo=globalLfo.getNextValue();frame.legacyWheel=legacyWheel.getNextValue();
        for(size_t channel=0;channel<16;++channel){frame.wheel[channel]=wheel[channel].getNextValue();frame.pressure[channel]=pressure[channel].getNextValue();}
        for(size_t i=0;i<routes.size();++i)
        {
            auto& route=routes[i];auto& value=frame.routes[i];value.source=route.source;value.target=route.target;value.amount=route.amount.getNextValue();
            value.transitioning=route.transitioning;
            if(value.transitioning)
            {
                for(size_t j=0;j<route.sources.size();++j)value.sources[j]=route.sources[j].getNextValue();
                for(size_t j=0;j<route.targets.size();++j)value.targets[j]=route.targets[j].getNextValue();
                route.updateTransition();
            }
        }
        return frame;
    }
    static Destinations applyExtended(const Frame& frame,const std::array<float,13>& sources) noexcept
    {
        Destinations result{};
        for(const auto& route:frame.routes)
        {
            if(route.amount==0)continue;
            if(!route.transitioning){result[static_cast<size_t>(route.target)]+=route.amount*sources[static_cast<size_t>(route.source)];continue;}
            float value=0;for(size_t i=0;i<sources.size();++i)value+=sources[i]*route.sources[i];
            for(size_t i=0;i<result.size();++i)result[i]+=value*route.amount*route.targets[i];
        }
        for(auto& value:result)value=juce::jlimit(-1.0f,1.0f,value);
        return result;
    }
    // Retain the original helper contract for existing callers and regressions.
    static std::array<float,4> apply(const Frame& frame,const std::array<float,9>& sources) noexcept
    {
        std::array<float,13> expanded{};std::copy(sources.begin(),sources.end(),expanded.begin());
        const auto result=applyExtended(frame,expanded);return {result[0],result[1],result[2],result[3]};
    }
private:
    struct Route
    {
        std::array<juce::SmoothedValue<float>,13> sources;
        std::array<juce::SmoothedValue<float>,targetCount> targets;
        juce::SmoothedValue<float> amount;
        int source=0,target=0;
        bool transitioning=false;
        // Selectors change at control updates. Once their ramps finish, avoid
        // scanning all 168 selector weights on every steady-state sample.
        void updateTransition() noexcept
        {
            transitioning=false;
            for(const auto& control:sources)transitioning=transitioning||control.isSmoothing();
            for(const auto& control:targets)transitioning=transitioning||control.isSmoothing();
        }
    };
    std::array<Route,8> routes;
    std::array<juce::SmoothedValue<float>,4> macros;
    std::array<juce::SmoothedValue<float>,16> wheel,pressure;
    std::array<std::array<juce::SmoothedValue<float>,16>,16> polyPressure;
    juce::SmoothedValue<float> globalLfo,legacyWheel;
};
