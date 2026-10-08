#pragma once
#include <JuceHeader.h>
#include <array>
#include <vector>
#include "BuiltInIRColour.h"
#include "BuiltInOctaveAnalysis.h"
#include <functional>

// Off-callback diagnostic only: broadband Schroeder integration and a T20 fit.
// Conservative heuristics reject inadequate tails; this is not ISO certification.
struct BuiltInIRDecay
{
    struct Point { double seconds=0,db=-80; };
    bool available=false;double rt60=0,rSquared=0,start=0,end=0,fitStart=0,fitEnd=0,noiseDb=-100;
    juce::String reason="No applied response";
    std::array<Point,96> curve{};
    bool hasCurve=false;
    juce::String bandName="Broadband";double lowHz=0,highHz=0;
    std::vector<BuiltInIRDecay> bands;
    std::vector<BuiltInIRDecay> octaves;
    double centreHz=0,minimumReliableRT60=0;
    juce::String filterMethod;
    juce::var toVar() const
    {
        auto* result=new juce::DynamicObject();result->setProperty("available",available);result->setProperty("reason",reason);
        result->setProperty("rt60Seconds",rt60);result->setProperty("rSquared",rSquared);result->setProperty("startSeconds",start);result->setProperty("endSeconds",end);result->setProperty("fitStartSeconds",fitStart);result->setProperty("fitEndSeconds",fitEnd);result->setProperty("endpointDb",noiseDb);result->setProperty("diagnosticOnly",true);
        result->setProperty("bandName",bandName);result->setProperty("lowHz",lowHz);result->setProperty("highHz",highHz);
        result->setProperty("centreHz",centreHz);result->setProperty("minimumReliableRT60",minimumReliableRT60);result->setProperty("filterMethod",filterMethod);
        if(!bands.empty()){juce::Array<juce::var> entries;for(const auto& band:bands)entries.add(band.toVar());result->setProperty("bands",entries);}
        if(!octaves.empty()){juce::Array<juce::var> entries;for(const auto& band:octaves)entries.add(band.toVar());result->setProperty("octaves",entries);}
        juce::Array<juce::var> points;if(hasCurve)for(const auto& point:curve){auto* p=new juce::DynamicObject();p->setProperty("seconds",point.seconds);p->setProperty("db",point.db);points.add(juce::var(p));}result->setProperty("curve",points);return juce::var(result);
    }
    static BuiltInIRDecay analyze(const juce::AudioBuffer<float>& audio,double rate,double tailStart)
    {
        BuiltInIRDecay result;
        if(!std::isfinite(rate)||rate<8000||rate>384000||!std::isfinite(tailStart)||audio.getNumChannels()<1){result.reason="Invalid response";return result;}
        const int first=juce::jlimit(0,audio.getNumSamples(),juce::roundToInt(juce::jlimit(0.0,audio.getNumSamples()/rate,tailStart)*rate));
        const int count=audio.getNumSamples()-first;result.start=first/rate;result.end=audio.getNumSamples()/rate;
        if(count<rate*.12){result.reason="Tail shorter than 120 ms";return result;}
        const int stride=juce::jmax(1,static_cast<int>(std::ceil(rate*.001))),bins=(count+stride-1)/stride;
        std::vector<double> energy(static_cast<size_t>(bins),0);double endpointEnergy=0;
        const int endpointCount=juce::jmax(1,juce::jmin(count/10,juce::roundToInt(rate*.05)));
        for(int i=0;i<count;++i)
        {
            double power=0;for(int ch=0;ch<audio.getNumChannels();++ch){const double sample=audio.getSample(ch,first+i);if(!std::isfinite(sample)){result.reason="Nonfinite response";return result;}power+=sample*sample;}
            energy[static_cast<size_t>(i/stride)]+=power;if(i>=count-endpointCount)endpointEnergy+=power;
        }
        return fit(std::move(energy),count,first,rate,endpointEnergy);
    }
    static BuiltInIRDecay analyzeBands(const juce::AudioBuffer<float>& audio,double rate,double tailStart,double lowSplit,double highSplit)
    {
        auto result=analyze(audio,rate,tailStart);
        if(!std::isfinite(rate)||rate<8000||rate>384000||!std::isfinite(tailStart)||!std::isfinite(lowSplit)||!std::isfinite(highSplit)||audio.getNumChannels()<1)return result;
        const int first=juce::jlimit(0,audio.getNumSamples(),juce::roundToInt(juce::jlimit(0.0,audio.getNumSamples()/rate,tailStart)*rate));
        const int count=audio.getNumSamples()-first,stride=juce::jmax(1,static_cast<int>(std::ceil(rate*.001)));
        const double high=juce::jlimit(120.0,rate*.45,highSplit),low=juce::jlimit(60.0,high*.5,lowSplit);
        result.highHz=rate*.5;
        result.bands.resize(3);
        for(size_t band=0;band<3;++band){auto& value=result.bands[band];value.bandName=band==0?"Low":(band==1?"Mid":"High");value.lowHz=band==0?0:(band==1?low:high);value.highHz=band==0?low:(band==1?high:rate*.5);value.reason=result.reason;value.start=result.start;value.end=result.end;}
        if(count<rate*.12||result.reason=="Nonfinite response")return result;
        // Filtering includes the complete impulse, before the selected tail.
        for(int ch=0;ch<audio.getNumChannels();++ch)for(int i=0;i<first;++i)if(!std::isfinite(audio.getSample(ch,i))){for(auto& band:result.bands)band.reason="Nonfinite response";return result;}
        const int bins=(count+stride-1)/stride,padding=static_cast<int>(std::ceil(rate*.15));
        const int endpointCount=juce::jmax(1,juce::jmin(count/10,juce::roundToInt(rate*.05)));
        std::array<std::vector<double>,3> energy;for(auto& values:energy)values.assign(static_cast<size_t>(bins),0);
        std::array<double,3> endpoint{};
        std::vector<double> work(static_cast<size_t>(audio.getNumSamples()+2*padding)),lower(static_cast<size_t>(count));
        for(int ch=0;ch<audio.getNumChannels();++ch)
        {
            BuiltInIRColour::lowPassZeroPhase(audio,ch,rate,low,work,padding);
            for(int i=0;i<count;++i)lower[static_cast<size_t>(i)]=work[static_cast<size_t>(first+i+padding)];
            BuiltInIRColour::lowPassZeroPhase(audio,ch,rate,high,work,padding);
            for(int i=0;i<count;++i)
            {
                const double l=lower[static_cast<size_t>(i)],upper=work[static_cast<size_t>(first+i+padding)];
                const std::array<double,3> values{l,upper-l,audio.getSample(ch,first+i)-upper};
                for(size_t band=0;band<3;++band){const double power=values[band]*values[band];energy[band][static_cast<size_t>(i/stride)]+=power;if(i>=count-endpointCount)endpoint[band]+=power;}
            }
        }
        for(size_t band=0;band<3;++band)
        {
            auto estimate=fit(std::move(energy[band]),count,first,rate,endpoint[band]);
            estimate.bandName=result.bands[band].bandName;estimate.lowHz=result.bands[band].lowHz;estimate.highHz=result.bands[band].highHz;
            if(estimate.available)estimate.reason="Broad-band T20 extrapolation; diagnostic only";
            result.bands[band]=std::move(estimate);
        }
        return result;
    }
    static BuiltInIRDecay analyzeOctave(const juce::AudioBuffer<float>& audio,double rate,double tailStart,size_t band,const std::function<bool()>& keepRunning={})
    {
        BuiltInIRDecay result;BuiltInOctaveAnalysis filter;
        const bool usable=filter.prepare(band,rate);
        result.bandName=band<BuiltInOctaveAnalysis::nominal.size()?juce::String(BuiltInOctaveAnalysis::nominal[band])+" Hz octave":"Invalid octave";
        result.centreHz=filter.centre;result.lowHz=filter.low;result.highHz=filter.high;
        result.minimumReliableRT60=filter.minimumDecay;result.filterMethod="Sixth-order causal Butterworth, prewarped base-10 octave edges";
        if(!usable){result.reason="Octave upper edge exceeds the analysis rate limit";return result;}
        if(!std::isfinite(tailStart)||audio.getNumChannels()<1){result.reason="Invalid response";return result;}
        const int first=juce::jlimit(0,audio.getNumSamples(),juce::roundToInt(juce::jlimit(0.0,audio.getNumSamples()/rate,tailStart)*rate));
        const int count=audio.getNumSamples()-first;result.start=first/rate;result.end=audio.getNumSamples()/rate;
        if(count<rate*.12){result.reason="Tail shorter than 120 ms";return result;}
        const int stride=juce::jmax(1,static_cast<int>(std::ceil(rate*.001))),bins=(count+stride-1)/stride;
        const int endpointCount=juce::jmax(1,juce::jmin(count/10,juce::roundToInt(rate*.05)));
        std::vector<double> energy(static_cast<size_t>(bins),0);double endpoint=0;
        for(int ch=0;ch<audio.getNumChannels();++ch)
        {
            std::array<std::array<double,2>,3> history {};
            for(int i=0;i<audio.getNumSamples();++i)
            {
                if((i&4095)==0&&keepRunning&&!keepRunning()){result.reason="Analysis canceled";return result;}
                const double value=audio.getSample(ch,i);if(!std::isfinite(value)){result.reason="Nonfinite response";return result;}
                const double filtered=filter.process(value,history);
                if(i<first)continue;
                const int sample=i-first;const double power=filtered*filtered;energy[static_cast<size_t>(sample/stride)]+=power;
                if(sample>=count-endpointCount)endpoint+=power;
            }
        }
        auto fitted=fit(std::move(energy),count,first,rate,endpoint);
        fitted.bandName=result.bandName;fitted.centreHz=result.centreHz;fitted.lowHz=result.lowHz;fitted.highHz=result.highHz;fitted.minimumReliableRT60=result.minimumReliableRT60;fitted.filterMethod=result.filterMethod;
        if(fitted.available&&fitted.rt60<filter.minimumDecay){fitted.available=false;fitted.reason="Decay is too short to separate from this octave filter's ringing";}
        else if(fitted.available)fitted.reason="Octave-band T20 extrapolation; diagnostic only";
        return fitted;
    }
    void addOctaves(const juce::AudioBuffer<float>& audio,double rate,double tailStart,const std::function<bool()>& keepRunning={})
    {
        octaves.clear();octaves.reserve(BuiltInOctaveAnalysis::nominal.size());
        for(size_t band=0;band<BuiltInOctaveAnalysis::nominal.size();++band)
        {if(keepRunning&&!keepRunning())return;octaves.push_back(analyzeOctave(audio,rate,tailStart,band,keepRunning));}
    }
private:
    static BuiltInIRDecay fit(std::vector<double> energy,int count,int first,double rate,double endpointEnergy)
    {
        BuiltInIRDecay result;result.start=first/rate;result.end=(first+count)/rate;
        const int stride=juce::jmax(1,static_cast<int>(std::ceil(rate*.001))),bins=static_cast<int>(energy.size());
        const int endpointCount=juce::jmax(1,juce::jmin(count/10,juce::roundToInt(rate*.05)));
        double peakMean=0;
        for(int i=0;i<bins;++i)peakMean=juce::jmax(peakMean,energy[static_cast<size_t>(i)]/juce::jmin(stride,count-i*stride));
        double total=0;for(int i=bins-1;i>=0;--i){total+=energy[static_cast<size_t>(i)];energy[static_cast<size_t>(i)]=total;}
        if(total<1e-18||peakMean<1e-24){result.reason="No measurable tail energy";return result;}
        result.noiseDb=10*std::log10(juce::jmax(1e-10,endpointEnergy/endpointCount/peakMean));
        for(auto& value:energy)value=10*std::log10(juce::jmax(1e-10,value/total));
        result.hasCurve=true;
        for(size_t i=0;i<result.curve.size();++i){const size_t index=i*static_cast<size_t>(bins-1)/(result.curve.size()-1);result.curve[i]={result.start+static_cast<double>(index*static_cast<size_t>(stride))/rate,juce::jmax(-80.0,energy[index])};}
        int firstFit=-1,lastFit=-1,minus35=-1;double sumX=0,sumY=0,sumXX=0,sumXY=0,sumYY=0,n=0;
        for(int i=0;i<bins;++i)
        {
            const double db=energy[static_cast<size_t>(i)],seconds=static_cast<double>(i*stride)/rate;
            if(db<=-35&&minus35<0)minus35=i;
            if(db<=-5&&db>=-25){if(firstFit<0)firstFit=i;lastFit=i;sumX+=seconds;sumY+=db;sumXX+=seconds*seconds;sumXY+=seconds*db;sumYY+=db*db;++n;}
        }
        if(firstFit<0||lastFit<=firstFit||n<32){result.reason="Insufficient 20 dB decay span";return result;}
        result.fitStart=result.start+static_cast<double>(firstFit*stride)/rate;result.fitEnd=result.start+static_cast<double>(lastFit*stride)/rate;
        const double span=result.fitEnd-result.fitStart,xx=n*sumXX-sumX*sumX,xy=n*sumXY-sumX*sumY,yy=n*sumYY-sumY*sumY;
        if(span<.08||xx<=0||yy<=0){result.reason="Decay fit shorter than 80 ms";return result;}
        const double slope=xy/xx;result.rSquared=juce::jlimit(0.0,1.0,xy*xy/(xx*yy));
        if(result.noiseDb>-35){result.reason="Endpoint energy too high; noisy or truncated tail";return result;}
        if(slope>=0||result.rSquared<.98){result.reason="Tail does not follow a stable single decay";return result;}
        const double continuation=static_cast<double>((minus35-lastFit)*stride)/rate;
        if(minus35<0||continuation<span*.325||continuation>span*.8){result.reason="Insufficient decay continuation after fit";return result;}
        result.rt60=-60/slope;
        if(!std::isfinite(result.rt60)||result.rt60>120){result.rt60=0;result.reason="Decay outside diagnostic range";return result;}
        result.available=true;result.reason="Broadband T20 extrapolation; diagnostic only";return result;
    }
};
