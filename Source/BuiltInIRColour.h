#pragma once
#include <complex>

// Original convolution tone controls. Preparation may allocate; Eq::process
// only evaluates prepared biquads. Neutral settings retain exact old playback.
namespace BuiltInIRColour
{
struct Settings
{
    double lowDecay = 0, midDecay = 0, highDecay = 0;
    double lowCrossover = 250, highCrossover = 4000;
    bool eqEnabled = true;
    std::array<double,4> eqFrequency {120, 500, 2500, 8000};
    std::array<double,4> eqGain {};
    std::array<double,4> eqQ {.7071067811865476, 1, 1, .7071067811865476};
};

struct Coefficients
{
    double b0=1, b1=0, b2=0, a1=0, a2=0;
    double process(double input, std::array<double,2>& state) const noexcept
    {
        const double output=b0*input+state[0];
        state[0]=b1*input-a1*output+state[1];
        state[1]=b2*input-a2*output;
        return output;
    }
    double magnitude(double frequency, double rate) const
    {
        const auto z=std::polar(1.0,-juce::MathConstants<double>::twoPi*frequency/rate);
        return std::abs((b0+b1*z+b2*z*z)/(1.0+a1*z+a2*z*z));
    }
    double settlingSeconds(double rate) const
    {
        const auto discriminant=std::sqrt(std::complex<double>(a1*a1-4*a2,0));
        const double radius=juce::jmax(std::abs((-a1+discriminant)*.5),std::abs((-a1-discriminant)*.5));
        return radius>0 && radius<1 ? std::log(1e-6)/std::log(radius)/rate : 0;
    }
};

// RBJ bilinear-transform peak/shelf filters, shelf slope S=1. Shelves are
// intentionally not labelled as an emulation of Altiverb's Baxandall filters.
inline Coefficients design(int band, double frequency, double gain, double q, double rate)
{
    if(gain==0) return {};
    const double a=std::pow(10.0,gain/40), omega=juce::MathConstants<double>::twoPi*juce::jlimit(20.0,rate*.45,frequency)/rate;
    const double c=std::cos(omega), sine=std::sin(omega);
    double b0,b1,b2,a0,a1,a2;
    if(band==0 || band==3)
    {
        const double t=std::sqrt(2*a)*sine;
        if(band==0)
        {
            b0=a*((a+1)-(a-1)*c+t); b1=2*a*((a-1)-(a+1)*c); b2=a*((a+1)-(a-1)*c-t);
            a0=(a+1)+(a-1)*c+t; a1=-2*((a-1)+(a+1)*c); a2=(a+1)+(a-1)*c-t;
        }
        else
        {
            b0=a*((a+1)+(a-1)*c+t); b1=-2*a*((a-1)+(a+1)*c); b2=a*((a+1)+(a-1)*c-t);
            a0=(a+1)-(a-1)*c+t; a1=2*((a-1)-(a+1)*c); a2=(a+1)-(a-1)*c-t;
        }
    }
    else
    {
        const double alpha=sine/(2*q);
        b0=1+alpha*a; b1=-2*c; b2=1-alpha*a;
        a0=1+alpha/a; a1=-2*c; a2=1-alpha/a;
    }
    return {b0/a0,b1/a0,b2/a0,a1/a0,a2/a0};
}

struct Eq
{
    std::array<Coefficients,4> filters;
    std::array<bool,4> active {};
    std::array<std::array<std::array<double,2>,4>,4> states {};
    double rate=48000, tail=0;
    void prepare(const Settings& settings, double sampleRate)
    {
        rate=sampleRate; tail=0; reset();
        for(size_t band=0;band<4;++band)
        {
            active[band]=settings.eqEnabled && settings.eqGain[band]!=0;
            filters[band]=active[band]?design(static_cast<int>(band),settings.eqFrequency[band],settings.eqGain[band],settings.eqQ[band],rate):Coefficients{};
            if(active[band]) tail+=filters[band].settlingSeconds(rate);
        }
    }
    void reset() noexcept { states={}; }
    bool isActive() const noexcept { return std::any_of(active.begin(),active.end(),[](bool value){return value;}); }
    float sample(float input, size_t channel) noexcept
    {
        for(size_t band=0;band<4;++band)if(active[band])input=static_cast<float>(filters[band].process(input,states[channel][band]));
        return input;
    }
    void process(juce::AudioBuffer<float>& audio, int count) noexcept
    {
        if(!isActive())return;
        for(int ch=0;ch<juce::jmin(4,audio.getNumChannels());++ch)
            for(int i=0;i<count;++i)audio.setSample(ch,i,sample(audio.getSample(ch,i),static_cast<size_t>(ch)));
    }
    juce::var response() const
    {
        juce::Array<juce::var> points;
        for(int i=0;i<=128;++i)
        {
            const double frequency=20*std::pow(juce::jmin(20000.0,rate*.45)/20,i/128.0);
            double magnitude=1; for(size_t band=0;band<4;++band)if(active[band])magnitude*=filters[band].magnitude(frequency,rate);
            auto* point=new juce::DynamicObject();point->setProperty("frequency",frequency);point->setProperty("db",20*std::log10(juce::jmax(magnitude,1e-12)));points.add(point);
        }
        return points;
    }
};

// Shared off-callback split for damping and diagnostic decay. Scratch includes
// 150 ms of zero padding at both ends; coefficients/state match the old path.
inline void lowPassZeroPhase(const juce::AudioBuffer<float>& audio, int channel,
    double rate, double frequency, std::vector<double>& work, int padding)
{
    std::fill(work.begin(),work.end(),0.0);
    for(int i=0;i<audio.getNumSamples();++i)work[static_cast<size_t>(i+padding)]=audio.getSample(channel,i);
    const auto coefficients=juce::dsp::IIR::Coefficients<double>::makeLowPass(rate,frequency);
    const auto* c=coefficients->getRawCoefficients();const Coefficients filter{c[0],c[1],c[2],c[3],c[4]};
    std::array<double,2> state{};
    for(auto& value:work)value=filter.process(value,state);
    state={};for(auto it=work.rbegin();it!=work.rend();++it)*it=filter.process(*it,state);
}

// Offline, zero-phase complementary bands: L=LP(low), M=LP(high)-L,
// H=input-LP(high). Butterworth forward/backward magnitudes are monotonic,
// nonnegative and sum to unity. Zero padding bounds filter-edge transients.
// Damping begins after earlyEnd in processed IR time and never adds energy
// to a band's envelope. It cannot invent or lengthen missing recorded tails.
inline void damp(juce::AudioBuffer<float>& audio, double rate, const Settings& settings, double onset)
{
    if(settings.lowDecay==0 && settings.midDecay==0 && settings.highDecay==0) return;
    const int length=audio.getNumSamples();
    if(onset>=length/rate) return;
    const auto attenuation=[](double time,double decay){return decay==0?1.0:std::exp(-std::log(1000.0)*time/decay);};
    if(settings.lowDecay==settings.midDecay && settings.midDecay==settings.highDecay)
    {
        for(int i=0;i<length;++i)
        {
            const float gain=static_cast<float>(attenuation(juce::jmax(0.0,i/rate-onset),settings.lowDecay));
            for(int ch=0;ch<audio.getNumChannels();++ch)audio.setSample(ch,i,audio.getSample(ch,i)*gain);
        }
        return;
    }
    const double highFrequency=juce::jmin(rate*.45,settings.highCrossover);
    const double lowFrequency=juce::jmin(highFrequency*.5,settings.lowCrossover);
    const int padding=static_cast<int>(std::ceil(rate*.15));
    std::vector<double> work(static_cast<size_t>(length+2*padding));
    std::vector<double> low(static_cast<size_t>(length));
    const auto split=[&](int ch,double frequency)
    {
        lowPassZeroPhase(audio,ch,rate,frequency,work,padding);
    };
    for(int ch=0;ch<audio.getNumChannels();++ch)
    {
        split(ch,lowFrequency);for(int i=0;i<length;++i)low[static_cast<size_t>(i)]=work[static_cast<size_t>(i+padding)];
        split(ch,highFrequency);
        for(int i=0;i<length;++i)
        {
            const double time=i/rate-onset;if(time<=0)continue;
            const double l=low[static_cast<size_t>(i)], upper=work[static_cast<size_t>(i+padding)], input=audio.getSample(ch,i);
            const double output=l*attenuation(time,settings.lowDecay)+(upper-l)*attenuation(time,settings.midDecay)+(input-upper)*attenuation(time,settings.highDecay);
            audio.setSample(ch,i,static_cast<float>(output));
        }
    }
}
}
