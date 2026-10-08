#pragma once
#include "BuiltInAlignmentCapture.h"

// Worker-only learning/fitting. No measured spectrum is an audio dependency.
namespace BuiltInEQMatch
{
constexpr int points=129, fftSize=8192;
using Curve=std::array<double,points>;
inline Curve frequencies(double rate)
{
    Curve result{};const double upper=juce::jmin(16000.0,rate*.4);
    for(int i=0;i<points;++i)result[static_cast<size_t>(i)]=80*std::pow(upper/80,static_cast<double>(i)/(points-1));
    return result;
}
struct Learner
{
    std::array<double,fftSize/2> power{};
    int windows=0;
    juce::dsp::FFT fft{13};
    juce::dsp::WindowingFunction<float> window{fftSize,juce::dsp::WindowingFunction<float>::hann,true};
    void add(const BuiltInAlignmentCapture& capture)
    {
        for(int start=0;start+fftSize<=capture.size();start+=fftSize/2)
        {
            for(size_t ch=0;ch<2;++ch)
            {
                std::array<float,fftSize*2> scratch{};
                std::copy_n(capture.audio[ch].data()+start,fftSize,scratch.data());
                window.multiplyWithWindowingTable(scratch.data(),fftSize);fft.performFrequencyOnlyForwardTransform(scratch.data());
                for(size_t bin=0;bin<power.size();++bin){const double amplitude=scratch[bin]*2/fftSize;power[bin]+=amplitude*amplitude*.5;}
            }
            ++windows;
        }
    }
    Curve spectrum(double rate)const
    {
        const auto hz=frequencies(rate);Curve result{};
        for(size_t i=0;i<result.size();++i)
        {
            double sum=0,weightSum=0;
            const double minimum=juce::jmax(1.0,hz[i]*std::pow(2.0,-.5)*fftSize/rate);
            const double maximum=juce::jmin(static_cast<double>(power.size()-1),hz[i]*std::pow(2.0,.5)*fftSize/rate);
            for(int bin=static_cast<int>(minimum);bin<=static_cast<int>(std::ceil(maximum));++bin)
            {
                const double octave=std::log2((bin*rate/fftSize)/hz[i]),weight=std::exp(-.5*octave*octave/(1.0/36));
                sum+=power[static_cast<size_t>(bin)]*weight;weightSum+=weight;
            }
            result[i]=10*std::log10(juce::jmax(1e-12,sum/(juce::jmax(1,windows)*juce::jmax(1e-12,weightSum))));
        }
        return result;
    }
};
struct Band { double frequency=1000,gain=0,q=1; int type=0,slope=1; };
inline Curve response(const Band& band,const Curve& hz,double rate,bool analog=false)
{
    // Preserve the production float coefficient/normalization rounding, then
    // evaluate in double. An ideal-double design diverges at low f / high Fs.
    using Coefficients=juce::dsp::IIR::ArrayCoefficients<float>;
    const int stages=band.type>=3?(band.slope<=1?1:band.slope==2?2:4):1;
    Curve result{};
    for(int stage=0;stage<stages;++stage)
    {
        std::array<float,6> raw{};
        const float frequency=static_cast<float>(analog ? rate / juce::MathConstants<double>::pi * std::atan(juce::MathConstants<double>::pi * band.frequency / rate) : band.frequency),gain=juce::Decibels::decibelsToGain(static_cast<float>(band.gain));
        if(band.type==1)raw=Coefficients::makeLowShelf(rate,frequency,static_cast<float>(band.q),gain);
        else if(band.type==2)raw=Coefficients::makeHighShelf(rate,frequency,static_cast<float>(band.q),gain);
        else if(band.type>=3&&band.slope==0)
        {
            const auto first=band.type==3?Coefficients::makeFirstOrderHighPass(rate,frequency):Coefficients::makeFirstOrderLowPass(rate,frequency);
            raw={first[0],first[1],0,first[2],first[3],0};
        }
        else if(band.type>=3)
        {
            const float angle=juce::MathConstants<float>::pi*static_cast<float>(2*stage+1)/static_cast<float>(4*stages);
            const float q=1/(2*std::cos(angle));
            raw=band.type==3?Coefficients::makeHighPass(rate,frequency,q):Coefficients::makeLowPass(rate,frequency,q);
        }
        else raw=Coefficients::makePeakFilter(rate,frequency,static_cast<float>(band.q),gain);
        const float inverse=1.0f/raw[3];
        const std::array<double,6> c{raw[0]*inverse,raw[1]*inverse,raw[2]*inverse,1.0,raw[4]*inverse,raw[5]*inverse};
        for(size_t i=0;i<hz.size();++i){const auto z=std::polar(1.0,analog ? -2*std::atan(juce::MathConstants<double>::pi*hz[i]/rate) : -juce::MathConstants<double>::twoPi*hz[i]/rate);const auto h=(c[0]+c[1]*z+c[2]*z*z)/(c[3]+c[4]*z+c[5]*z*z);result[i]+=20*std::log10(juce::jmax(1e-12,std::abs(h)));}
    }
    return result;
}
struct Fit { bool accepted=false;Curve target{},curve{};std::vector<Band> bands;double before=0,after=0,removedLevel=0;int validPoints=0;juce::String reason; };
inline Fit fit(const Curve& current,const Curve& reference,double rate,int maximumBands,bool normalizeLevel=true,bool mixedShapes=false,bool analog=false)
{
    Fit result;const auto hz=frequencies(rate);std::array<bool,points> valid{};
    const double peakA=*std::max_element(current.begin(),current.end()),peakB=*std::max_element(reference.begin(),reference.end());
    if(peakA< -85||peakB< -85){result.reason="Insufficient spectrum energy";return result;}
    for(size_t i=0;i<hz.size();++i){valid[i]=!normalizeLevel||(current[i]>peakA-45&&reference[i]>peakB-45);if(valid[i]){result.removedLevel+=reference[i]-current[i];++result.validPoints;}}
    if(result.validPoints<points/2){result.reason="Too little shared broadband energy";return result;}
    result.removedLevel/=result.validPoints;
    if(!normalizeLevel)result.removedLevel=0;
    for(size_t i=0;i<hz.size();++i)result.target[i]=valid[i]?juce::jlimit(mixedShapes?-48.0:-12.0,mixedShapes?24.0:12.0,reference[i]-current[i]-result.removedLevel):0;
    const auto error=[&](const Curve& curve){double sum=0;for(size_t i=0;i<hz.size();++i)if(valid[i]){const double residual=result.target[i]-curve[i];sum+=residual*residual;}return sum/result.validPoints;};
    result.before=std::sqrt(error(result.curve));
    struct Candidate{Band band;Curve unit;};std::vector<Candidate> dictionary;
    for(int i=0;i<points;i+=2)for(double q:{.35,.5,.7,1.0,1.4,2.0,3.0}){Band band{hz[static_cast<size_t>(i)],1,q};dictionary.push_back({band,response(band,hz,rate,analog)});}
    if(mixedShapes)for(int type:{1,2})for(int i=0;i<points;i+=2)for(double q:{.5,.70710678,1.0})
    {Band band{hz[static_cast<size_t>(i)],1,q,type,1};dictionary.push_back({band,response(band,hz,rate,analog)});}
    std::vector<Candidate> cuts;
    if(mixedShapes)for(int type:{3,4})for(int i=0;i<points;i+=2)for(int slope:{0,1,2,3})
    {Band band{hz[static_cast<size_t>(i)],0,.70710678,type,slope};cuts.push_back({band,response(band,hz,rate,analog)});}
    const double gainLimit=mixedShapes?18.0:9.0;
    for(int count=0;count<juce::jlimit(1,8,maximumBands);++count)
    {
        double bestError=error(result.curve);Band best;Curve bestCurve=result.curve;bool improved=false;
        // Rank with a unit-gain approximation, then evaluate the best candidate
        // with actual nonlinear-in-gain coefficients before accepting it.
        double bestRank=0;const Candidate* winner=nullptr;double winnerGain=0;
        for(const auto& candidate:dictionary)
        {
            double numerator=0,denominator=0;
            for(size_t i=0;i<hz.size();++i)if(valid[i]){numerator+=(result.target[i]-result.curve[i])*candidate.unit[i];denominator+=candidate.unit[i]*candidate.unit[i];}
            const double gain=juce::jlimit(-gainLimit,gainLimit,numerator/juce::jmax(1e-12,denominator));const double rank=2*gain*numerator-gain*gain*denominator;
            if(rank>bestRank){bestRank=rank;winner=&candidate;winnerGain=gain;}
        }
        if(winner)for(double offset:{-1.0,-.5,0.0,.5,1.0})
        {
            auto band=winner->band;band.gain=juce::jlimit(-gainLimit,gainLimit,winnerGain+offset);auto curve=response(band,hz,rate,analog);
            for(size_t i=0;i<hz.size();++i)curve[i]+=result.curve[i];
            const double score=error(curve);
            if(score<bestError){bestError=score;best=band;bestCurve=curve;improved=true;}
        }
        for(const auto& candidate:cuts)
        {
            auto curve=candidate.unit;for(size_t i=0;i<hz.size();++i)curve[i]+=result.curve[i];const double score=error(curve);
            if(score<bestError){bestError=score;best=candidate.band;bestCurve=curve;improved=true;}
        }
        if(!improved||(best.type<3&&std::abs(best.gain)<.15))break;
        result.bands.push_back(best);result.curve=bestCurve;
        if(std::sqrt(bestError)<.25)break;
    }
    result.after=std::sqrt(error(result.curve));result.accepted=result.after<=result.before&&result.validPoints>=points/2;
    result.reason=result.bands.empty()?"No material shape correction needed":mixedShapes?"Bounded mixed-filter proposal ready":"Bounded bell proposal ready";return result;
}
}
