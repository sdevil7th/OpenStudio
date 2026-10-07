#pragma once
#include "BuiltInConvolution.h"

// One output-only audition. The worker owns allocation and reclamation; the
// callback owns samples only between its successful 1 -> 2 -> 1/0 exchanges.
class BuiltInIRPreview
{
public:
    using Ticket=juce::uint64;
    Ticket begin(const juce::String& owner)
    {
        const juce::ScopedLock lock(controlLock);
        session=owner;stopRequested.store(true);preparing=true;progress.store(0);
        heartbeat.store(juce::Time::getMillisecondCounter());
        return ++generation;
    }
    bool alive(Ticket ticket) const noexcept
    {
        return generation.load()==ticket
            &&static_cast<juce::uint32>(juce::Time::getMillisecondCounter()-heartbeat.load())<5000;
    }
    void advance(Ticket ticket,float value) noexcept { if(generation.load()==ticket)progress.store(value); }
    void finish(Ticket ticket) { const juce::ScopedLock lock(controlLock);if(generation.load()==ticket)preparing=false; }
    bool publish(Ticket ticket,juce::AudioBuffer<float>&& samples,double sampleRate,const std::shared_ptr<juce::AudioProcessor>& owner)
    {
        const juce::ScopedLock lock(controlLock);
        if(!alive(ticket)||!owner||samples.getNumChannels()!=2||samples.getNumSamples()<1||!std::isfinite(sampleRate)||sampleRate<=0)return false;
        int idle=0;if(!state.compare_exchange_strong(idle,-1))return false;
        audio=std::move(samples);rate=sampleRate;source=owner;position=0;gain=1;
        stopRequested.store(false);preparing=false;progress.store(1);state.store(1);return true;
    }
    void stop(const juce::String& owner)
    {
        const juce::ScopedLock lock(controlLock);
        if(owner!=session)return;
        ++generation;preparing=false;stopRequested.store(true);
    }
    void stopAll()
    {
        const juce::ScopedLock lock(controlLock);
        ++generation;preparing=false;stopRequested.store(true);
    }
    juce::var status(const juce::String& owner)
    {
        const juce::ScopedLock lock(controlLock);const bool owns=owner==session;
        if(owns)heartbeat.store(juce::Time::getMillisecondCounter());
        auto* result=new juce::DynamicObject();result->setProperty("success",true);
        result->setProperty("preparing",owns&&preparing);result->setProperty("playing",owns&&state.load()>0&&!stopRequested.load());
        result->setProperty("progress",owns?progress.load():0.0f);return result;
    }
    void render(float* const* output,int channels,int count,double sampleRate) noexcept
    {
        int ready=1;if(!state.compare_exchange_strong(ready,2))return;
        const bool stopped=stopRequested.load()||source.expired()||rate!=sampleRate
            ||static_cast<juce::uint32>(juce::Time::getMillisecondCounter()-heartbeat.load())>=5000;
        const float step=1.0f/static_cast<float>(rate*.01);
        for(int i=0;i<count&&position<audio.getNumSamples();++i,++position)
        {
            if(stopped)gain=juce::jmax(0.0f,gain-step);
            for(int ch=0;ch<juce::jmin(2,channels);++ch)if(output[ch])output[ch][i]+=audio.getSample(ch,position)*gain;
        }
        state.store(position>=audio.getNumSamples()||gain==0?0:1);
    }
private:
    juce::CriticalSection controlLock;
    std::atomic<Ticket> generation{0};std::atomic<int> state{0};std::atomic<bool> stopRequested{true};
    std::atomic<juce::uint32> heartbeat{0};std::atomic<float> progress{0};
    juce::String session;bool preparing=false;
    juce::AudioBuffer<float> audio;std::weak_ptr<juce::AudioProcessor> source;
    double rate=48000;int position=0;float gain=1;
};

struct BuiltInIRAudition
{
    juce::AudioBuffer<float> audio;juce::String name,error;
    double duration=0,attenuationDb=0;bool truncated=false;
};

inline BuiltInIRAudition renderBuiltInIRAudition(BuiltInConvolution& source,double rate,int sound,int input,
    const std::function<bool(float)>& progress)
{
    BuiltInIRAudition result;
    if(!std::isfinite(rate)||rate<8000||rate>192000||sound<0||sound>1||input<0||input>2){result.error="Invalid audition settings";return result;}
    const auto proceed=[&](float value){if(!progress||progress(value))return true;result.error="Audition cancelled";return false;};
    if(!proceed(.02f))return result;
    juce::ValueTree state("IRAudition");source.save(state);result.name=state.getProperty("irName").toString();
    if(!proceed(.05f))return result;
    auto clone=std::make_unique<BuiltInConvolution>();
    if(!clone->restore(state)){result.error="Could not snapshot the applied response";return result;}
    if(!proceed(.1f))return result;
    clone->prepare(rate,256);
    const double duration=clone->tail()+.12;result.truncated=duration>24;result.duration=juce::jlimit(.12,24.0,duration);
    const int samples=static_cast<int>(std::ceil(rate*result.duration));result.audio.setSize(2,samples);result.audio.clear();
    juce::AudioBuffer<float> chunk(2,256);juce::uint32 random=0x4f534952;
    const int onset=static_cast<int>(rate*.01),burst=juce::jmax(1,static_cast<int>(rate*.08));
    float peak=0;
    for(int start=0;start<samples;start+=256)
    {
        if(!proceed(.15f+.8f*static_cast<float>(start)/samples)){result.audio.setSize(0,0);return result;}
        const int length=juce::jmin(256,samples-start);chunk.setSize(2,length,false,false,true);chunk.clear();
        for(int i=0;i<length;++i)
        {
            const int at=start+i-onset;float excitation=0;
            if(sound==0&&at==0)excitation=.1f;
            else if(sound==1&&at>=0&&at<burst)
            {
                random^=random<<13;random^=random>>17;random^=random<<5;
                const float window=std::sin(juce::MathConstants<float>::pi*static_cast<float>(at)/burst);
                excitation=(static_cast<float>(random)/2147483648.0f-1.0f)*.1f*window*window;
            }
            if(input!=2)chunk.setSample(0,i,excitation);
            if(input!=1)chunk.setSample(1,i,excitation);
        }
        clone->process(chunk,0,20,20000,1,true,false);
        for(int ch=0;ch<2;++ch)for(int i=0;i<length;++i)
        {
            const float value=chunk.getSample(ch,i);
            if(!std::isfinite(value)){result.error="Response produced non-finite audition audio";result.audio.setSize(0,0);return result;}
            result.audio.setSample(ch,start+i,value);peak=juce::jmax(peak,std::abs(value));
        }
    }
    if(!proceed(.98f)){result.audio.setSize(0,0);return result;}
    const float attenuation=peak>.25f?.25f/peak:1.0f;result.attenuationDb=juce::Decibels::gainToDecibels(attenuation);
    result.audio.applyGain(attenuation);
    const int fade=juce::jmin(samples,static_cast<int>(rate*.02));result.audio.applyGainRamp(samples-fade,fade,1,0);
    return result;
}
