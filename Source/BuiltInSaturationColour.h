#pragma once
#include <JuceHeader.h>

// Original frequency- and history-dependent voices; no hardware-model claim.
class BuiltInSaturationColour
{
public:
    struct Settings {int engine=0;float dynamics=1,tilt=0,bump=0,lowCut=20,highCut=20000;bool steep=false;};
    void prepare(double sampleRate){rate=sampleRate;reset();}
    void reset(){channels={};postHistory={};drivenPeak=0;initialized=false;}
    void configure(Settings settings,int factor)
    {
        selected=settings;const double fs=rate*factor;
        static constexpr std::array<float,5> attacks{3,8,15,1,5},releases{90,180,240,35,120};
        const size_t voice=static_cast<size_t>(juce::jlimit(1,5,selected.engine)-1);
        attack=static_cast<float>(std::exp(-1/(.001*attacks[voice]*fs)));release=static_cast<float>(std::exp(-1/(.001*releases[voice]*fs)));
        lowMemory=static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*(voice==2?120:80)/fs));
        tiltCoefficient=static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*1000/fs));
        dcCoefficient=static_cast<float>(std::exp(-juce::MathConstants<double>::twoPi*5/fs));
        slew=static_cast<float>(juce::MathConstants<double>::twoPi*6000/fs);
        lowGain=juce::Decibels::decibelsToGain(-settings.tilt*6);highGain=juce::Decibels::decibelsToGain(settings.tilt*6);
        bump=bell(fs,settings.lowCut,settings.bump);
        const double k=std::tan(juce::MathConstants<double>::pi*juce::jlimit(20.0,rate*.45,static_cast<double>(settings.highCut))/rate);
        postCoefficients[0]={k/(1+k),k/(1+k),0,(k-1)/(k+1),0};
        for(size_t stage=1;stage<3;++stage)
        {
            const double q=1/(2*std::cos(juce::MathConstants<double>::pi*static_cast<double>(stage)/5));
            const double norm=1/(1+k/q+k*k);postCoefficients[stage]={k*k*norm,2*k*k*norm,k*k*norm,2*(k*k-1)*norm,(1-k/q+k*k)*norm};
        }
        parameterCoefficient=static_cast<float>(1-std::exp(-1/(fs*.025)));postCoefficient=static_cast<float>(1-std::exp(-1/(rate*.025)));
        if(!initialized){for(auto& state:channels){state.lowGain=lowGain;state.highGain=highGain;state.dynamics=settings.dynamics;state.bumpCoefficients=bump;state.postCoefficients=postCoefficients;state.steep=settings.steep?1.0f:0.0f;}initialized=true;}
        drivenPeak=0;
    }
    float shape(float input,float asymmetry,int channel)
    {
        auto& state=channels[static_cast<size_t>(juce::jlimit(0,1,channel))];
        const float safe=std::isfinite(input)?juce::jlimit(-64.0f,64.0f,input):0;
        state.tilt+=tiltCoefficient*(safe-state.tilt);
        state.lowGain+=parameterCoefficient*(lowGain-state.lowGain);state.highGain+=parameterCoefficient*(highGain-state.highGain);
        state.dynamics+=parameterCoefficient*(selected.dynamics-state.dynamics);
        for(size_t i=0;i<bump.size();++i)state.bumpCoefficients[i]+=parameterCoefficient*(bump[i]-state.bumpCoefficients[i]);
        const float tilted=state.tilt*state.lowGain+(safe-state.tilt)*state.highGain;
        const float x=static_cast<float>(filter(tilted,state.bumpCoefficients,state.bump));
        drivenPeak=juce::jmax(drivenPeak,std::abs(x));
        const float coefficient=std::abs(x)>state.envelope?attack:release;
        state.envelope=coefficient*state.envelope+(1-coefficient)*std::abs(x);
        state.memory+=lowMemory*(x-state.memory);
        const float amount=juce::jlimit(0.0f,1.0f,state.dynamics);
        static constexpr std::array<float,5> sag{.16f,.32f,.22f,.08f,.25f};
        const size_t voice=static_cast<size_t>(juce::jlimit(1,5,selected.engine)-1);
        const float headroom=1/(1+amount*sag[voice]*state.envelope);
        float driven=x;
        if(voice==0)driven+=amount*.18f*std::tanh(state.memory*2);
        if(voice==2)driven+=amount*.3f*std::tanh(state.memory);
        if(voice==3){state.slew+=juce::jlimit(-slew,slew,driven-state.slew);driven+=amount*(state.slew-driven);}
        const float bias=asymmetry*.2f+(voice==1?.22f:voice==2?.08f:0);
        const auto transfer=[voice](float value)
        {
            if(voice==4)return value/std::sqrt(1+value*value);
            if(voice==3)return static_cast<float>(std::atan(value)*2/juce::MathConstants<double>::pi);
            return std::tanh(value);
        };
        const float normalization=voice==4?std::pow(1+bias*bias,1.5f):voice==3?(1+bias*bias)*juce::MathConstants<float>::halfPi:1/juce::jmax(.1f,1-std::pow(std::tanh(bias),2.0f));
        const float shaped=(transfer(driven/headroom+bias)-transfer(bias))*headroom*normalization;
        const float output=shaped-state.dcInput+dcCoefficient*state.dcOutput;state.dcInput=shaped;state.dcOutput=output;
        return std::isfinite(output)?output:0;
    }
    float post(float input,int channel)
    {
        auto& history=postHistory[static_cast<size_t>(juce::jlimit(0,1,channel))];auto& state=channels[static_cast<size_t>(juce::jlimit(0,1,channel))];double value=input,first=input;
        for(size_t stage=0;stage<3;++stage){for(size_t i=0;i<5;++i)state.postCoefficients[stage][i]+=postCoefficient*(postCoefficients[stage][i]-state.postCoefficients[stage][i]);value=filter(value,state.postCoefficients[stage],history[stage]);if(stage==0)first=value;}
        state.steep+=postCoefficient*((selected.steep?1.0f:0.0f)-state.steep);
        return static_cast<float>(first+state.steep*(value-first));
    }
    float getDrivenPeak() const noexcept{return drivenPeak;}
private:
    using Coefficients=std::array<double,5>;
    static Coefficients bell(double fs,float frequency,float gain)
    {
        const double w=juce::MathConstants<double>::twoPi*juce::jlimit(20.0,fs*.45,static_cast<double>(frequency))/fs,a=std::pow(10.0,gain/40.0),alpha=std::sin(w)/(2*.7),norm=1/(1+alpha/a);
        return {(1+alpha*a)*norm,-2*std::cos(w)*norm,(1-alpha*a)*norm,-2*std::cos(w)*norm,(1-alpha/a)*norm};
    }
    static double filter(double x,const Coefficients& c,std::array<double,2>& state){const double y=c[0]*x+state[0];state[0]=c[1]*x-c[3]*y+state[1];state[1]=c[2]*x-c[4]*y;return y;}
    struct Channel {float envelope=0,memory=0,tilt=0,slew=0,dcInput=0,dcOutput=0;std::array<double,2> bump{};float lowGain=1,highGain=1,dynamics=1,steep=0;Coefficients bumpCoefficients{1,0,0,0,0};std::array<Coefficients,3> postCoefficients{{{1,0,0,0,0},{1,0,0,0,0},{1,0,0,0,0}}};};
    Settings selected;bool initialized=false;double rate=48000;float attack=0,release=0,lowMemory=0,tiltCoefficient=0,dcCoefficient=0,slew=0,lowGain=1,highGain=1,drivenPeak=0,parameterCoefficient=0,postCoefficient=0;
    Coefficients bump{};std::array<Coefficients,3> postCoefficients{};
    std::array<Channel,2> channels{};
    std::array<std::array<std::array<double,2>,3>,2> postHistory{};
};
