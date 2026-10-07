#pragma once
#include "BuiltInContinuousAlignment.h"

inline juce::var checkContinuousAlignment()
{
    auto* result=new juce::DynamicObject();juce::Array<juce::var> cases;bool pass=true;int allocations=0,frees=0;
    const auto signal=[](juce::int64 sample){auto value=static_cast<juce::uint32>(sample);value^=value>>16;value*=0x7feb352dU;value^=value>>15;value*=0x846ca68bU;value^=value>>16;return (static_cast<float>(value&65535)/65535.0f-.5f)*.2f;};
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})for(const bool conflict:{false,true})
    {
        BuiltInAlignmentCapture reference,target;reference.prepare(rate);target.prepare(rate);
        const int window=juce::jmin(28672,juce::roundToInt(rate*.5));const juce::int64 span=window*19+57;
        bool okay=reference.armContinuous(19,span,window,rate)&&target.armContinuous(19,span,window,rate);
        BuiltInContinuousAlignment stream(2);std::vector<BuiltInAlignmentCapture*> captures{&reference,&target};
        juce::AudioBuffer<float> a(2,511),b(2,511);
        for(juce::int64 position=0;position<span+19;)
        {
            const int count=static_cast<int>(juce::jmin(static_cast<juce::int64>(position%2?127:511),span+19-position));
            a.setSize(2,count,false,false,true);b.setSize(2,count,false,false,true);
            for(int sample=0;sample<count;++sample)for(int ch=0;ch<2;++ch){a.setSample(ch,sample,signal(position+sample));b.setSample(ch,sample,-signal(position+sample-(conflict&&position>span/2?45:37)));}
#if JUCE_WINDOWS && defined(_DEBUG)
            EQMIDIHeapProbe::allocations=EQMIDIHeapProbe::frees=0;EQMIDIHeapProbe::previous=_CrtSetAllocHook(EQMIDIHeapProbe::hook);EQMIDIHeapProbe::active=true;
#endif
            reference.process(a,position,true);target.process(b,position,true);
#if JUCE_WINDOWS && defined(_DEBUG)
            EQMIDIHeapProbe::active=false;_CrtSetAllocHook(EQMIDIHeapProbe::previous);allocations+=EQMIDIHeapProbe::allocations;frees+=EQMIDIHeapProbe::frees;
#endif
            okay=stream.consume(captures,false)&&okay;position+=count;
        }
        while(!reference.continuousDrained()||!target.continuousDrained())okay=stream.consume(captures,false)&&okay;
        const auto estimate=stream.matrix(false)[0][1][0];
        okay=okay&&reference.state.load()==2&&target.state.load()==2&&stream.covered==span&&stream.windows==20;
        okay=okay&&(conflict?!estimate.accepted:estimate.accepted&&estimate.invert&&std::abs(estimate.lag-37)<.1);
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("conflictingSecondHalf",conflict);row->setProperty("coveredSamples",stream.covered);row->setProperty("expectedSamples",span);row->setProperty("windows",stream.windows);row->setProperty("accepted",estimate.accepted);row->setProperty("lag",estimate.lag);row->setProperty("pass",okay);cases.add(row);pass=pass&&okay;
    }
    BuiltInAlignmentCapture overflow;overflow.prepare(48000);overflow.armContinuous(0,4096*20,4096,48000);juce::AudioBuffer<float> large(2,4096*17);large.clear();overflow.process(large,0,true);const bool failsClosed=overflow.state.load()<0;
    overflow.armContinuous(0,4096*20,4096,48000);overflow.abort();const bool canceled=overflow.state.load()<0;
    overflow.armContinuous(0,4096*20,4096,48000);juce::AudioBuffer<float> shortAudio(2,128);shortAudio.clear();overflow.process(shortAudio,0,true);overflow.process(shortAudio,129,true);const bool seek=overflow.state.load()<0;
    result->setProperty("plugin","Continuous span capture and bounded consensus");result->setProperty("cases",cases);result->setProperty("overflowFailsClosed",failsClosed);result->setProperty("cancelAndSeekInvalidate",canceled&&seek);result->setProperty("allocations",allocations);result->setProperty("frees",frees);result->setProperty("acousticGroupingCorrectness","not_asserted");result->setProperty("pass",pass&&failsClosed&&canceled&&seek&&allocations==0&&frees==0);return result;
}
