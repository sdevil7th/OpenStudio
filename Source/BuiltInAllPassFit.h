#pragma once
#include "BuiltInPhaseAlignment.h"
#include "BuiltInAlignmentCapture.h"
#include <functional>

// Worker-only bounded fit of the existing causal all-pass controls. No arbitrary
// spectral correction kernel is generated, and analysis never mutates audio state.
struct BuiltInAllPassFit
{
    bool applied=false, invert=false;
    int stages=0;
    double frequency=1000, lag=0, before=0, after=0;
    juce::String reason="Time-only recommendation";
};

namespace BuiltInAllPassFitting
{
struct Bin { double omega=0, phase=0, weight=0; };
struct Evidence { std::array<std::vector<Bin>,2> halves; bool supported=false; };
inline Evidence evidence(const float* reference,const float* target,int count,double rate,const BuiltInAlignmentEstimate& timing)
{
    Evidence result;if(!timing.accepted)return result;
    int order=10;while((1<<order)<rate*.04&&order<13)++order;const int size=1<<order,hop=size/2;
    const int lag=static_cast<int>(std::floor(timing.lag)),aStart=juce::jmax(0,-lag),bStart=juce::jmax(0,lag),length=count-std::abs(lag);
    const int frames=(length-size)/hop+1;if(frames<4)return result;
    using Complex=std::complex<float>;juce::dsp::FFT fft(order);
    std::vector<Complex> a(static_cast<size_t>(size)),b(a.size()),fa(a.size()),fb(a.size());
    std::array<std::vector<std::complex<double>>,2> cross;
    std::array<std::vector<double>,2> powerA,powerB;
    for(size_t part=0;part<2;++part){cross[part].resize(static_cast<size_t>(size/2));powerA[part].resize(cross[part].size());powerB[part].resize(cross[part].size());}
    for(int frame=0;frame<frames;++frame)
    {
        const size_t part=frame<frames/2?0:1;const int start=frame*hop;
        for(int i=0;i<size;++i){const float window=static_cast<float>(.5-.5*std::cos(juce::MathConstants<double>::twoPi*i/(size-1)));a[static_cast<size_t>(i)]=reference[aStart+start+i]*window;b[static_cast<size_t>(i)]=target[bStart+start+i]*window;}
        fft.perform(a.data(),fa.data(),false);fft.perform(b.data(),fb.data(),false);
        for(int bin=1;bin<size/2;++bin){const auto at=static_cast<size_t>(bin);cross[part][at]+=static_cast<std::complex<double>>(fb[at])*std::conj(static_cast<std::complex<double>>(fa[at]));powerA[part][at]+=std::norm(fa[at]);powerB[part][at]+=std::norm(fb[at]);}
    }
    result.supported=true;
    for(size_t part=0;part<2;++part)
    {
        double maximum=0;for(size_t bin=1;bin<cross[part].size();++bin)maximum=juce::jmax(maximum,std::sqrt(powerA[part][bin]*powerB[part][bin]));
        int previous=-1;double total=0,minFrequency=rate,maxFrequency=0;std::array<bool,10> octaves{};
        for(int point=0;point<192;++point)
        {
            const double frequency=40*std::pow(juce::jmin(18000.0,rate*.4)/40,point/191.0);
            const int bin=juce::jlimit(1,size/2-1,juce::roundToInt(frequency*size/rate));if(bin==previous)continue;previous=bin;const auto at=static_cast<size_t>(bin);
            const double power=std::sqrt(powerA[part][at]*powerB[part][at]);if(power<maximum*.001||power<1e-20)continue;
            const double coherence=juce::jlimit(0.0,1.0,std::norm(cross[part][at])/(power*power));if(coherence<.7)continue;
            const double omega=juce::MathConstants<double>::twoPi*bin/size,weight=std::sqrt(power/maximum)*coherence*coherence;
            result.halves[part].push_back({omega,std::arg(cross[part][at])+omega*(timing.lag-lag)+(timing.invert?juce::MathConstants<double>::pi:0),weight});total+=weight;
            const double actual=bin*rate/size;minFrequency=juce::jmin(minFrequency,actual);maxFrequency=juce::jmax(maxFrequency,actual);octaves[static_cast<size_t>(juce::jlimit(0,9,static_cast<int>(std::log2(actual/40))))]=true;
        }
        int bands=0;for(const bool present:octaves)if(present)++bands;
        result.supported=result.supported&&result.halves[part].size()>=20&&bands>=4&&maxFrequency>=minFrequency*4&&total>0;
        for(auto& bin:result.halves[part])bin.weight/=juce::jmax(1e-30,total);
    }
    return result;
}
inline double phase(double omega,double coefficient)
{
    const auto z=std::polar(1.0,-omega);return std::arg((coefficient+z)/(1.0+coefficient*z));
}
inline double score(const std::vector<Bin>& bins,double rate,int stages,double frequency,double delta,bool invert)
{
    double sum=0;const double coefficient=BuiltInPhaseAlignment::coefficient(rate,frequency);
    for(const auto& bin:bins)sum+=bin.weight*std::cos(bin.phase+(stages?stages*phase(bin.omega,coefficient):0)+bin.omega*delta);
    return invert?-sum:sum;
}
}

inline BuiltInAllPassFit fitBuiltInAllPass(const std::array<const float*,2>& reference,const std::array<const float*,2>& target,
    int channels,int count,double rate,const BuiltInAlignmentEstimate& timing,const std::function<bool()>& keepRunning={})
{
    using namespace BuiltInAllPassFitting;
    BuiltInAllPassFit result;result.lag=timing.lag;result.invert=timing.invert;
    if(!timing.accepted){result.reason="Time estimate was not accepted";return result;}
    std::vector<Evidence> evidenceSets;
    for(int channel=0;channel<channels;++channel)
    {
        auto measured=evidence(reference[static_cast<size_t>(channel)],target[static_cast<size_t>(channel)],count,rate,timing);
        if(!measured.supported){result.reason="Insufficient broadband coherent evidence for phase fit";return result;}
        evidenceSets.push_back(std::move(measured));
    }
    std::vector<Bin> all;for(const auto& set:evidenceSets)for(const auto& half:set.halves)for(auto bin:half){bin.weight/=static_cast<double>(channels*2);all.push_back(bin);}
    result.before=score(all,rate,0,1000,0,false);result.after=result.before;
    if(result.before>.995){result.reason="Timing already has near-unity phase agreement";return result;}
    const double unit=rate/48000,maximumFrequency=juce::jmin(16000.0,rate*.35);
    double best=result.before,frequency=1000,delta=0;int stages=0;bool invert=false;
    const auto tryCandidate=[&](int candidateStages,double candidateFrequency,double candidateDelta)
    {
        const double value=score(all,rate,candidateStages,candidateFrequency,candidateDelta,false);
        if(std::abs(value)>best){best=std::abs(value);frequency=candidateFrequency;delta=candidateDelta;stages=candidateStages;invert=value<0;}
    };
    for(int candidateStages=1;candidateStages<=4;++candidateStages)
    {
        if(keepRunning&&!keepRunning()){result.reason="Phase fit canceled";return result;}
        for(int point=0;point<40;++point)
        {
            const double candidateFrequency=40*std::pow(maximumFrequency/40,point/39.0);
            const double coefficient=BuiltInPhaseAlignment::coefficient(rate,candidateFrequency);
            std::vector<double> phases;phases.reserve(all.size());for(const auto& bin:all)phases.push_back(bin.phase+candidateStages*phase(bin.omega,coefficient));
            for(int step=-32;step<=32;++step)
            {
                const double candidateDelta=step*unit;double value=0;
                for(size_t bin=0;bin<all.size();++bin)value+=all[bin].weight*std::cos(phases[bin]+all[bin].omega*candidateDelta);
                if(std::abs(value)>best){best=std::abs(value);frequency=candidateFrequency;delta=candidateDelta;stages=candidateStages;invert=value<0;}
            }
        }
    }
    // Refine the best coarse candidate, retaining a bounded worker search.
    for(int iteration=0;iteration<4&&stages>0;++iteration)
    {
        const double centreFrequency=frequency,centreDelta=delta,frequencyStep=std::pow(2.0,-iteration)*.12,delayStep=unit*std::pow(.25,iteration+1);
        for(int f=-2;f<=2;++f)for(int d=-4;d<=4;++d)
            tryCandidate(stages,juce::jlimit(20.0,juce::jmin(20000.0,rate*.45),centreFrequency*std::exp(f*frequencyStep)),juce::jlimit(-32*unit,32*unit,centreDelta+d*delayStep));
    }
    bool stable=stages>0&&best>.8&&best-result.before>.025&&(1-best)<(1-result.before)*.75;
    for(const auto& set:evidenceSets)for(const auto& half:set.halves)
    {
        const double before=score(half,rate,0,1000,0,false),after=score(half,rate,stages,frequency,delta,invert);
        stable=stable&&after>=before+.01&&after>.75;
    }
    if(!stable){result.reason="No stable all-pass improvement across capture sections";return result;}
    result.applied=true;result.stages=stages;result.frequency=frequency;result.lag=timing.lag+delta;result.invert=timing.invert!=invert;result.after=best;result.reason="Bounded all-pass fit improves both capture sections";return result;
}
