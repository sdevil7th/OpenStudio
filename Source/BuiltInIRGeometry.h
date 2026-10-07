#pragma once
#include <JuceHeader.h>
#include "BuiltInIRPreparation.h"
#include <array>

// Worker-only, original direct-path propagation approximation. Measured room
// reflections are retained; coordinates do not synthesize a new room response.
struct BuiltInIRGeometry
{
    struct Settings
    {
        bool geometryEnabled=false;
        // Recorded sources L/R, microphones L/R, requested sources L/R, metres.
        std::array<std::array<double,2>,6> geometryPoints {{ {-1,2},{1,2},{-.15,0},{.15,0},{-1,2},{1,2} }};
    };
    static constexpr std::array<const char*,12> ids {"geometrySourceLX","geometrySourceLY","geometrySourceRX","geometrySourceRY","geometryMicLX","geometryMicLY","geometryMicRX","geometryMicRY","geometryTargetLX","geometryTargetLY","geometryTargetRX","geometryTargetRY"};
    struct Plan
    {
        std::array<double,4> recordedDistance {},targetDistance {},delaySeconds {},gain {};
        double commonDelaySeconds=0;bool changed=false,gainLimited=false;
    };
    static bool valid(const Settings& settings) noexcept
    {
        for(const auto& point:settings.geometryPoints)for(double value:point)if(!std::isfinite(value)||std::abs(value)>50)return false;
        if(settings.geometryEnabled)for(size_t source:{0u,1u,4u,5u})for(size_t mic:{2u,3u})
            if(distance(settings.geometryPoints[source],settings.geometryPoints[mic])<.1)return false;
        return true;
    }
    static Plan plan(const Settings& settings,double rate)
    {
        Plan result;double minimum=0;bool fractional=false;
        for(size_t source=0;source<2;++source)for(size_t mic=0;mic<2;++mic)
        {
            const size_t path=source*2+mic;
            result.recordedDistance[path]=distance(settings.geometryPoints[source],settings.geometryPoints[mic+2]);
            result.targetDistance[path]=distance(settings.geometryPoints[source+4],settings.geometryPoints[mic+2]);
            result.delaySeconds[path]=(result.targetDistance[path]-result.recordedDistance[path])/343.0;
            const double ratio=result.recordedDistance[path]/juce::jmax(.1,result.targetDistance[path]);
            result.gain[path]=juce::jlimit(.125,8.0,ratio);result.gainLimited=result.gainLimited||result.gain[path]!=ratio;
            minimum=juce::jmin(minimum,result.delaySeconds[path]);result.changed=result.changed||std::abs(result.delaySeconds[path])>1e-12||std::abs(result.gain[path]-1)>1e-12;
        }
        for(double delay:result.delaySeconds){const double samples=(delay-minimum)*rate;fractional=fractional||std::abs(samples-std::round(samples))>1e-8;}
        result.commonDelaySeconds=-minimum+(fractional?32/rate:0);
        for(auto& delay:result.delaySeconds)delay+=result.commonDelaySeconds;
        return result;
    }
    static juce::var describe(const Settings& settings,double rate)
    {
        const auto values=plan(settings,rate);auto* result=new juce::DynamicObject();juce::Array<juce::var> paths;
        result->setProperty("enabled",settings.geometryEnabled);result->setProperty("commonDelayMs",values.commonDelaySeconds*1000);result->setProperty("gainLimited",values.gainLimited);result->setProperty("speedMetresPerSecond",343);
        for(size_t i=0;i<4;++i){auto* path=new juce::DynamicObject();path->setProperty("path",i==0?"LL":i==1?"LR":i==2?"RL":"RR");path->setProperty("recordedDistance",values.recordedDistance[i]);path->setProperty("targetDistance",values.targetDistance[i]);path->setProperty("delayMs",values.delaySeconds[i]*1000);path->setProperty("gain",values.gain[i]);paths.add(path);}
        result->setProperty("paths",paths);result->setProperty("scope","Declared-geometry direct-path approximation; measured reflections stay in place");return result;
    }
    static bool apply(juce::AudioBuffer<float>& response,double rate,double directEnd,int order,const Settings& settings,BuiltInIRPreparation* progress=nullptr)
    {
        if(!settings.geometryEnabled)return true;
        if(response.getNumChannels()!=4||!valid(settings)||rate<8000||rate>384000)return false;
        const auto values=plan(settings,rate);if(!values.changed||directEnd<=0)return true;
        const int directCount=juce::jmin(response.getNumSamples(),juce::roundToInt(directEnd*rate));if(directCount<=0)return true;
        double maximumDelay=0;for(double delay:values.delaySeconds)maximumDelay=juce::jmax(maximumDelay,delay);
        juce::AudioBuffer<float> original;original.makeCopyOf(response);
        const int length=juce::jmax(response.getNumSamples(),directCount+static_cast<int>(std::ceil(maximumDelay*rate))+34);
        response.setSize(4,length,true,true);if(length>original.getNumSamples())response.clear(original.getNumSamples(),length-original.getNumSamples());
        constexpr int taps=64;
        for(size_t path=0;path<4;++path)
        {
            const int channel=order==0?static_cast<int>(path):path==1?2:path==2?1:static_cast<int>(path);
            const double delay=values.delaySeconds[path]*rate;const int whole=static_cast<int>(std::floor(delay));const double fraction=delay-whole;
            std::array<double,taps> coefficients {};double sum=0;
            if(std::abs(fraction)<1e-8)coefficients[31]=1;
            else for(int tap=0;tap<taps;++tap)
            {
                const double x=static_cast<double>(tap-31)-fraction;
                const double sinc=std::abs(x)<1e-12?1:std::sin(juce::MathConstants<double>::pi*x)/(juce::MathConstants<double>::pi*x);
                const double window=.42+.5*std::cos(juce::MathConstants<double>::pi*x/32)+.08*std::cos(juce::MathConstants<double>::twoPi*x/32);
                coefficients[static_cast<size_t>(tap)]=sinc*window;sum+=sinc*window;
            }
            if(sum!=0)for(auto& coefficient:coefficients)coefficient/=sum;
            for(int i=0;i<directCount;++i)
            {
                if((i&4095)==0&&progress&&progress->isCancelled())return false;
                const double transition=juce::jlimit(0.0,1.0,(static_cast<double>(i)/directCount-.8)/.2);
                const float direct=original.getSample(channel,i)*static_cast<float>(.5+.5*std::cos(juce::MathConstants<double>::pi*transition));
                response.addSample(channel,i,-direct);if(direct==0)continue;
                for(int tap=0;tap<taps;++tap)
                {
                    const int destination=i+whole+tap-31;
                    if(destination>=0&&destination<length)response.addSample(channel,destination,static_cast<float>(direct*values.gain[path]*coefficients[static_cast<size_t>(tap)]));
                }
            }
        }
        return true;
    }
private:
    static double distance(const std::array<double,2>& a,const std::array<double,2>& b) noexcept
    {return std::hypot(a[0]-b[0],a[1]-b[1]);}
};
