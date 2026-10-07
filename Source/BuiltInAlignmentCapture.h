#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>
#include <complex>
#include <vector>

// Single producer, serialized control consumer. Arm allocates the bounded window
// before publishing it; recording only copies into that prepared storage.
class BuiltInAlignmentCapture
{
public:
    static constexpr int capacity=65536; // Existing short capture and EQ Match limit.
    static constexpr int maximumCapture=192000*4;
    std::array<std::vector<float>,2> audio;
    std::atomic<int> state{0}; // 0 idle, 1 armed, 2 complete, 3 producer owns, -1 invalid
    std::atomic<double> sampleRate{0};
    void prepare(double rate) noexcept { sampleRate.store(rate); abort(); }
    bool arm(juce::int64 first,int length,double rate)
    {
        const int bounded=juce::jlimit(1,maximumCapture,length);
        return armWindows(first,bounded,bounded,1,rate);
    }
    bool armSparse(juce::int64 first,juce::int64 span,int window,double rate)
    {
        if(window<4096||window>capacity||span<static_cast<juce::int64>(window)*3)return false;
        return armWindows(first,span,window,3,rate);
    }
    bool armSpan(juce::int64 first,juce::int64 span,int window,double rate)
    {
        if(window<4096||window>capacity||span<static_cast<juce::int64>(window)*16)return false;
        return armWindows(first,span,window,16,rate);
    }
    // Bounded single-producer/single-consumer stream. Every sample in the selected
    // span reaches the worker; overload invalidates the capture instead of skipping.
    bool armContinuous(juce::int64 first,juce::int64 span,int window,double rate)
    {
        if(window<4096||window>capacity||span<window||!armWindows(first,span,window,1,rate,false))return false;
        state.store(0,std::memory_order_release);
        for(auto& channel:streamAudio)channel.resize(static_cast<size_t>(window*streamSlots));
        streamReadIndex.store(0);streamWriteIndex.store(0);streamOffset=0;streamTotal=0;streamEnabled=true;
        state.store(1,std::memory_order_release);return true;
    }
    bool readContinuous(std::array<std::vector<float>,2>& destination,int& valid)
    {
        const auto read=streamReadIndex.load(std::memory_order_relaxed);
        if(read==streamWriteIndex.load(std::memory_order_acquire))return false;
        const auto slot=static_cast<size_t>(read%streamSlots);valid=streamLengths[slot];
        for(size_t ch=0;ch<2;++ch){destination[ch].resize(static_cast<size_t>(valid));std::copy_n(streamAudio[ch].data()+slot*static_cast<size_t>(windowLength),valid,destination[ch].data());}
        streamReadIndex.store(read+1,std::memory_order_release);return true;
    }
    bool continuousDrained() const noexcept {return streamReadIndex.load()==streamWriteIndex.load();}
    void abort() noexcept { cancel.store(true,std::memory_order_release);int expected=1;state.compare_exchange_strong(expected,-1,std::memory_order_acq_rel); }
    void process(const juce::AudioBuffer<float>& buffer,juce::int64 position,bool playing) noexcept
    {
        int expectedState=1;if(!state.compare_exchange_strong(expectedState,3,std::memory_order_acq_rel))return;
        if(cancel.load(std::memory_order_acquire)||!playing||buffer.getNumChannels()==0
            ||(havePosition&&position!=nextPosition)){state.store(-1,std::memory_order_release);return;}
        const auto end=position+buffer.getNumSamples();havePosition=true;nextPosition=end;
        if(position>start&&written==0&&progressSamples.load()==0){state.store(-1,std::memory_order_release);return;}
        if(streamEnabled)
        {
            const auto first=juce::jmax(position,start),last=juce::jmin(end,start+spanSamples);
            for(auto absolute=first;absolute<last;)
            {
                const auto write=streamWriteIndex.load(std::memory_order_relaxed);
                if(write-streamReadIndex.load(std::memory_order_acquire)>=streamSlots){state.store(-1,std::memory_order_release);return;}
                const auto slot=static_cast<size_t>(write%streamSlots);
                const int amount=static_cast<int>(juce::jmin<juce::int64>(windowLength-streamOffset,last-absolute));
                for(int ch=0;ch<2;++ch)for(int i=0;i<amount;++i)
                {
                    const float value=buffer.getSample(juce::jmin(ch,buffer.getNumChannels()-1),static_cast<int>(absolute-position)+i);
                    streamAudio[static_cast<size_t>(ch)][slot*static_cast<size_t>(windowLength)+static_cast<size_t>(streamOffset+i)]=std::isfinite(value)?value:0;
                }
                absolute+=amount;streamOffset+=amount;streamTotal+=amount;
                if(streamOffset==windowLength||streamTotal==spanSamples){streamLengths[slot]=streamOffset;streamOffset=0;streamWriteIndex.store(write+1,std::memory_order_release);}
            }
            progressSamples.store(juce::jlimit<juce::int64>(0,spanSamples,end-start),std::memory_order_release);
            state.store(cancel.load()?-1:streamTotal==spanSamples?2:1,std::memory_order_release);return;
        }
        for(int window=0;window<windowCount;++window)
        {
            const auto first=juce::jmax(position,start+windowStarts[static_cast<size_t>(window)]);
            const auto last=juce::jmin(end,start+windowStarts[static_cast<size_t>(window)]+windowLength);
            if(last<=first)continue;
            const int source=static_cast<int>(first-position);
            const int destination=window*windowLength+static_cast<int>(first-start-windowStarts[static_cast<size_t>(window)]);
            const int length=static_cast<int>(last-first);
            for(int ch=0;ch<2;++ch)for(int i=0;i<length;++i)
            {
                const float value=buffer.getSample(juce::jmin(ch,buffer.getNumChannels()-1),source+i);
                audio[static_cast<size_t>(ch)][static_cast<size_t>(destination+i)]=std::isfinite(value)?value:0;
            }
            written+=length;
        }
        progressSamples.store(juce::jlimit<juce::int64>(0,spanSamples,end-start),std::memory_order_release);
        const bool missed=end>=start+spanSamples&&written!=count;
        state.store(cancel.load()||missed?-1:written==count?2:1,std::memory_order_release);
    }
    int size()const noexcept{return count;}
    double progress()const noexcept{return static_cast<double>(progressSamples.load(std::memory_order_acquire))/static_cast<double>(juce::jmax<juce::int64>(1,spanSamples));}
private:
    bool armWindows(juce::int64 first,juce::int64 span,int window,int windows,double rate,bool publish=true)
    {
        const int current=state.load(std::memory_order_acquire);
        if(current==1||current==3||sampleRate.load()!=rate)return false;
        cancel.store(false,std::memory_order_release);
        for(auto& channel:audio)
        {
            const auto requested=static_cast<size_t>(window*windows);
            if(channel.capacity()>requested)std::vector<float>(requested).swap(channel);else channel.resize(requested);
        }
        if(cancel.load(std::memory_order_acquire)||sampleRate.load()!=rate)return false;
        streamEnabled=false;start=first;spanSamples=span;windowLength=window;windowCount=windows;count=window*windows;written=0;
        windowStarts.fill(0);
        for(int i=1;i<windows;++i)windowStarts[static_cast<size_t>(i)]=(span-window)*i/(windows-1);
        havePosition=false;nextPosition=0;progressSamples.store(0);
        state.store(publish?1:0,std::memory_order_release);return true;
    }
    static constexpr int streamSlots=16;
    std::array<std::vector<float>,2> streamAudio;
    std::array<int,streamSlots> streamLengths{};
    std::atomic<juce::int64> streamReadIndex{0},streamWriteIndex{0};
    juce::int64 streamTotal=0;
    int streamOffset=0;bool streamEnabled=false;
    std::atomic<bool> cancel{false};
    std::atomic<juce::int64> progressSamples{0};
    juce::int64 start=0,spanSamples=0,nextPosition=0;
    std::array<juce::int64,16> windowStarts{};
    int count=0,written=0,windowLength=0,windowCount=1;
    bool havePosition=false;
};

struct BuiltInAlignmentEstimate
{
    bool accepted=false,invert=false;
    double lag=0,correlation=0,peakRatio=0,referenceRms=0,targetRms=0,phaseResidual=0;
    juce::String reason;
};

// One source transform can serve every pair in a continuous group window.
// Storage and FFT preparation remain on the analysis worker.
struct BuiltInAlignmentSpectrum
{
    using Complex=std::complex<float>;
    int count=0;double rms=0;
    std::vector<Complex> spectrum;
    std::vector<double> energy;
    void prepare(const float* source,int samples,juce::dsp::FFT& fft)
    {
        count=samples;spectrum.resize(static_cast<size_t>(fft.getSize()));energy.assign(static_cast<size_t>(count+1),0);
        std::vector<Complex> input(spectrum.size());double mean=0;
        for(int i=0;i<count;++i)mean+=source[i];mean/=count;
        for(int i=0;i<count;++i){const auto index=static_cast<size_t>(i);input[index]=static_cast<float>(source[i]-mean);energy[index+1]=energy[index]+std::norm(input[index]);}
        rms=std::sqrt(energy.back()/count);fft.perform(input.data(),spectrum.data(),false);
    }
};
struct BuiltInAlignmentWorkspace
{
    using Complex=std::complex<float>;
    std::vector<Complex> cross,correlation;
    std::vector<double> phaseAngles;
    explicit BuiltInAlignmentWorkspace(int size):cross(static_cast<size_t>(size)),correlation(cross.size()),phaseAngles(static_cast<size_t>(size*2/5)){}
};

// Worker-only normalized FFT correlation. Confidence is an explicit heuristic,
// not a probability of acoustic correctness or a spectral phase correction.
inline BuiltInAlignmentEstimate estimateBuiltInAlignment(const BuiltInAlignmentSpectrum& a,const BuiltInAlignmentSpectrum& b,
    juce::dsp::FFT& fft,BuiltInAlignmentWorkspace& workspace,double minimumCorrelation=.55,double minimumPeakRatio=1.15)
{
    BuiltInAlignmentEstimate result;const int count=a.count,size=fft.getSize();
    if(count<4096||b.count!=count){result.reason="Capture is too short or mismatched";return result;}
    const auto& energyA=a.energy;const auto& energyB=b.energy;
    const auto& fa=a.spectrum;const auto& fb=b.spectrum;
    auto& cross=workspace.cross;auto& correlation=workspace.correlation;auto& phaseAngles=workspace.phaseAngles;
    result.referenceRms=a.rms;result.targetRms=b.rms;
    if(result.referenceRms<1e-4||result.targetRms<1e-4){result.reason="Insufficient signal above -80 dBFS RMS";return result;}
    for(int i=0;i<size;++i)cross[static_cast<size_t>(i)]=fb[static_cast<size_t>(i)]*std::conj(fa[static_cast<size_t>(i)]);
    fft.perform(cross.data(),correlation.data(),true);
    const int limit=juce::jmin(2048,count/4);
    const auto coefficient=[&](int lag)
    {
        const int aStart=juce::jmax(0,-lag),bStart=juce::jmax(0,lag),length=count-std::abs(lag);
        const double ea=energyA[static_cast<size_t>(aStart+length)]-energyA[static_cast<size_t>(aStart)];
        const double eb=energyB[static_cast<size_t>(bStart+length)]-energyB[static_cast<size_t>(bStart)];
        return static_cast<double>(correlation[static_cast<size_t>(lag<0?size+lag:lag)].real())/juce::jmax(1e-30,std::sqrt(ea*eb));
    };
    int best=0;double peak=0,runner=0;
    for(int lag=-limit;lag<=limit;++lag){const double value=std::abs(coefficient(lag));if(value>peak){peak=value;best=lag;}}
    for(int lag=-limit;lag<=limit;++lag)if(std::abs(lag-best)>8)runner=juce::jmax(runner,std::abs(coefficient(lag)));
    result.correlation=juce::jlimit(0.0,1.0,peak);result.invert=coefficient(best)<0;result.peakRatio=peak/juce::jmax(1e-12,runner);
    // Refine a sub-sample delay from the residual phase around the integer peak.
    double numerator=0,denominator=0,weightSum=0;double maximumPower=0;
    for(int bin=1;bin<size/2;++bin)maximumPower=juce::jmax(maximumPower,static_cast<double>(std::abs(cross[static_cast<size_t>(bin)])));
    const int phaseBins=size*2/5;
    const double binOmega=juce::MathConstants<double>::twoPi/size;
    const auto rotationStep=std::polar(1.0,binOmega*best);
    auto rotation=rotationStep;
    for(int bin=1;bin<phaseBins;++bin)
    {
        // One recurrence replaces per-bin sin/cos. Re-anchor periodically to
        // bound accumulated roundoff, including large integer lag estimates.
        if((bin&255)==0)rotation=std::polar(1.0,binOmega*best*bin);
        const auto currentRotation=rotation;rotation*=rotationStep;
        const double weight=std::abs(cross[static_cast<size_t>(bin)]);if(weight<maximumPower*.001)continue;
        const double omega=binOmega*bin;
        const std::complex<double> rotated=static_cast<std::complex<double>>(cross[static_cast<size_t>(bin)])
            *currentRotation*(result.invert?-1.0:1.0);
        const double angle=std::arg(rotated);phaseAngles[static_cast<size_t>(bin)]=angle;
        numerator-=weight*omega*angle;denominator+=weight*omega*omega;weightSum+=weight;
    }
    const double fraction=denominator>0?juce::jlimit(-.5,.5,numerator/denominator):0;
    result.lag=best+fraction;
    double residual=0;
    for(int bin=1;bin<phaseBins;++bin)
    {
        const double weight=std::abs(cross[static_cast<size_t>(bin)]);if(weight<maximumPower*.001)continue;
        double angle=phaseAngles[static_cast<size_t>(bin)]+binOmega*bin*fraction;
        if(angle>juce::MathConstants<double>::pi)angle-=juce::MathConstants<double>::twoPi;
        else if(angle<-juce::MathConstants<double>::pi)angle+=juce::MathConstants<double>::twoPi;
        residual+=weight*angle*angle;
    }
    result.phaseResidual=std::sqrt(residual/juce::jmax(1e-30,weightSum));
    result.accepted=peak>=minimumCorrelation&&result.peakRatio>=minimumPeakRatio&&std::abs(best)<limit;
    result.reason=result.accepted?"Time/polarity estimate accepted":std::abs(best)>=limit?"Best lag reaches the search boundary":peak<minimumCorrelation?"Low correlation":"Ambiguous periodic or repeated signal";
    return result;
}

inline BuiltInAlignmentEstimate estimateBuiltInAlignment(const float* reference,const float* target,int count,double minimumCorrelation=.55,double minimumPeakRatio=1.15)
{
    if(count<4096){BuiltInAlignmentEstimate result;result.reason="Capture is too short";return result;}
    int order=1;while((1<<order)<count*2)++order;
    juce::dsp::FFT fft(order);BuiltInAlignmentSpectrum a,b;
    a.prepare(reference,count,fft);b.prepare(target,count,fft);BuiltInAlignmentWorkspace workspace(fft.getSize());
    return estimateBuiltInAlignment(a,b,fft,workspace,minimumCorrelation,minimumPeakRatio);
}

// Preserve stereo timing/polarity by deriving one offset from agreeing channels.
// Missing energy may follow the other channel; contradictory evidence fails shut.
inline BuiltInAlignmentEstimate linkBuiltInAlignment(const std::array<BuiltInAlignmentEstimate,2>& channels)
{
    const auto measurable=[](const auto& value){return value.referenceRms>=1e-4&&value.targetRms>=1e-4;};
    const bool left=measurable(channels[0]),right=measurable(channels[1]);
    if(!left&&!right){BuiltInAlignmentEstimate result;result.reason="Stereo link has no measurable channel";return result;}
    const size_t first=left?0:1;auto result=channels[first];
    if(!result.accepted){result.reason="Stereo link: "+result.reason;return result;}
    if(!left||!right){result.reason=left?"Stereo linked from Left; Right has insufficient signal":"Stereo linked from Right; Left has insufficient signal";return result;}
    const auto& other=channels[1];
    if(!other.accepted){result.accepted=false;result.reason="Stereo link: "+other.reason;return result;}
    if(result.invert!=other.invert){result.accepted=false;result.reason="Stereo channels disagree in polarity";return result;}
    if(std::abs(result.lag-other.lag)>1.0){result.accepted=false;result.reason="Stereo channel lags differ by more than one sample";return result;}
    const double a=result.referenceRms*result.targetRms,b=other.referenceRms*other.targetRms;
    result.lag=(a*result.lag+b*other.lag)/(a+b);result.correlation=juce::jmin(result.correlation,other.correlation);result.peakRatio=juce::jmin(result.peakRatio,other.peakRatio);result.phaseResidual=juce::jmax(result.phaseResidual,other.phaseResidual);result.reason="Stereo linked; both channels agree";return result;
}

struct BuiltInAlignmentSections
{
    BuiltInAlignmentEstimate combined;
    std::array<BuiltInAlignmentEstimate,3> sections;
    int window=0;
};
// Three disjoint beginning/middle/end windows. A changing source, polarity or
// lag fails closed; averaging a disagreement would hide a moving microphone.
inline BuiltInAlignmentSections estimateBuiltInAlignmentSections(const float* reference,const float* target,int count)
{
    BuiltInAlignmentSections result;result.window=juce::jmin(BuiltInAlignmentCapture::capacity,count/3);
    if(result.window<4096){result.combined.reason="Capture is too short for three sections";return result;}
    double weight=0,lag=0,minLag=1e10,maxLag=-1e10;bool accepted=true;
    for(size_t section=0;section<3;++section)
    {
        const int start=static_cast<int>(section)*(count-result.window)/2;
        auto& estimate=result.sections[section];estimate=estimateBuiltInAlignment(reference+start,target+start,result.window);
        if(!estimate.accepted){accepted=false;result.combined.reason="Section "+juce::String(static_cast<int>(section)+1)+": "+estimate.reason;}
        if(section==0)result.combined=estimate;
        else if(estimate.invert!=result.sections[0].invert){accepted=false;result.combined.reason="Capture sections disagree in polarity";}
        minLag=juce::jmin(minLag,estimate.lag);maxLag=juce::jmax(maxLag,estimate.lag);
        const double strength=estimate.referenceRms*estimate.targetRms;weight+=strength;lag+=strength*estimate.lag;
        result.combined.correlation=juce::jmin(result.combined.correlation,estimate.correlation);
        result.combined.peakRatio=juce::jmin(result.combined.peakRatio,estimate.peakRatio);
        result.combined.referenceRms=juce::jmin(result.combined.referenceRms,estimate.referenceRms);result.combined.targetRms=juce::jmin(result.combined.targetRms,estimate.targetRms);
        result.combined.phaseResidual=juce::jmax(result.combined.phaseResidual,estimate.phaseResidual);
    }
    if(maxLag-minLag>1){accepted=false;result.combined.reason="Capture section lags differ by more than one sample";}
    result.combined.lag=weight>0?lag/weight:0;result.combined.accepted=accepted;
    if(accepted)result.combined.reason="Three capture sections agree";
    return result;
}

struct BuiltInAlignmentSpan
{
    BuiltInAlignmentEstimate combined;
    std::array<BuiltInAlignmentEstimate,16> sections;
    int measurable=0,qualified=0;
};
// Worker-only agreement over sixteen retained windows. Silence is reported and
// omitted; contradictory qualified evidence is never averaged away.
inline BuiltInAlignmentSpan estimateBuiltInAlignmentSpan(const float* reference,const float* target,int count,bool weakSignal)
{
    BuiltInAlignmentSpan result;const int window=count/16;
    if(window<4096||window>BuiltInAlignmentCapture::capacity){result.combined.reason="Invalid project-span windows";return result;}
    double weight=0,weightedLag=0,minLag=1e10,maxLag=-1e10;bool polarity=false,conflict=false;
    result.combined.correlation=1;result.combined.peakRatio=1e10;
    for(size_t section=0;section<16;++section)
    {
        auto& estimate=result.sections[section];
        estimate=estimateBuiltInAlignment(reference+section*static_cast<size_t>(window),target+section*static_cast<size_t>(window),window,weakSignal?.15:.55,weakSignal?1.5:1.15);
        if(estimate.referenceRms<1e-4||estimate.targetRms<1e-4)continue;
        ++result.measurable;if(!estimate.accepted)continue;
        if(result.qualified==0)polarity=estimate.invert;else conflict=conflict||polarity!=estimate.invert;
        ++result.qualified;minLag=juce::jmin(minLag,estimate.lag);maxLag=juce::jmax(maxLag,estimate.lag);
        const double strength=estimate.correlation*estimate.correlation;weight+=strength;weightedLag+=strength*estimate.lag;
        result.combined.correlation=juce::jmin(result.combined.correlation,estimate.correlation);
        result.combined.peakRatio=juce::jmin(result.combined.peakRatio,estimate.peakRatio);
        result.combined.referenceRms=juce::jmax(result.combined.referenceRms,estimate.referenceRms);
        result.combined.targetRms=juce::jmax(result.combined.targetRms,estimate.targetRms);
        result.combined.phaseResidual=juce::jmax(result.combined.phaseResidual,estimate.phaseResidual);
    }
    result.combined.lag=weight>0?weightedLag/weight:0;result.combined.invert=polarity;
    result.combined.accepted=result.qualified>=6&&result.qualified*4>=result.measurable*3&&!conflict&&maxLag-minLag<=1;
    result.combined.reason=result.qualified<6?"Fewer than six qualified windows":result.qualified*4<result.measurable*3?"Too many measured windows disagree":conflict?"Project windows disagree in polarity":maxLag-minLag>1?"Project window lags differ by more than one sample":weakSignal?"Repeated shared-signal timing evidence accepted":"Project-span timing windows agree";
    if(result.qualified==0){result.combined.correlation=0;result.combined.peakRatio=0;}
    return result;
}
