#pragma once
#include <thread>
#if JUCE_WINDOWS && defined(_DEBUG)
#include <crtdbg.h>
namespace EQMIDIHeapProbe
{
    inline thread_local bool active=false;
    inline thread_local int allocations=0,frees=0;
    inline _CRT_ALLOC_HOOK previous=nullptr;
    inline int hook(int kind,void* data,size_t size,int block,long request,const unsigned char* file,int line)
    {
        if(active){if(kind==_HOOK_ALLOC||kind==_HOOK_REALLOC)++allocations;if(kind==_HOOK_FREE)++frees;}
        return previous?previous(kind,data,size,block,request,file,line):1;
    }
}
#endif
inline juce::var checkEQMIDIPrograms()
{
    auto* result=new juce::DynamicObject();bool timing=true,policy=true,state=true,validation=true;double maximumError=0;int allocations=0,frees=0;bool heapMeasured=false;
    const auto edit=[](OpenStudioEQ& eq,const char* action,int bank=0,int program=0,int channel=0)
    {
        auto* item=new juce::DynamicObject();item->setProperty("action",action);item->setProperty("bank",bank);item->setProperty("program",program);item->setProperty("channel",channel);item->setProperty("enabled",true);item->setProperty("name","Captured EQ");return eq.editMIDIProgram(juce::var(item));
    };
    const auto targets=[](OpenStudioEQ& eq,int variant){eq.bands[0].freq.store(variant==1?500.0f:variant==2?1700.0f:1000.0f);eq.bands[0].gain.store(variant==1?-12.0f:variant==2?9.0f:0.0f);eq.outputGain.store(variant==2?-3.0f:0.0f);};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        auto actual=std::make_unique<OpenStudioEQ>(true),oracle=std::make_unique<OpenStudioEQ>(true);targets(*actual,1);state=edit(*actual,"capture",257,17)&&state;targets(*actual,2);state=edit(*actual,"capture",257,18)&&state;targets(*actual,0);state=edit(*actual,"configure",0,0,3)&&state;
        actual->prepareToPlay(rate,2048);oracle->prepareToPlay(rate,2048);juce::AudioBuffer<float> warm(2,2048);warm.clear();juce::MidiBuffer empty;actual->processBlock(warm,empty);oracle->processBlock(warm,empty);
        juce::AudioBuffer<float> audio(2,2048),expected(2,2048);for(int ch=0;ch<2;++ch)for(int i=0;i<2048;++i){const float value=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*(ch?701:997)*i/rate));audio.setSample(ch,i,value);expected.setSample(ch,i,value);}
        juce::MidiBuffer midi;midi.addEvent(juce::MidiMessage::controllerEvent(3,0,2),4);midi.addEvent(juce::MidiMessage::controllerEvent(3,32,1),5);midi.addEvent(juce::MidiMessage::programChange(3,17),73);midi.addEvent(juce::MidiMessage::programChange(3,18),997);midi.addEvent(juce::MidiMessage::noteOn(3,60,.7f),1200);const int events=midi.getNumEvents();
#if JUCE_WINDOWS && defined(_DEBUG)
        EQMIDIHeapProbe::allocations=EQMIDIHeapProbe::frees=0;EQMIDIHeapProbe::previous=_CrtSetAllocHook(EQMIDIHeapProbe::hook);EQMIDIHeapProbe::active=true;
#endif
        actual->processBlock(audio,midi);
#if JUCE_WINDOWS && defined(_DEBUG)
        EQMIDIHeapProbe::active=false;_CrtSetAllocHook(EQMIDIHeapProbe::previous);allocations+=EQMIDIHeapProbe::allocations;frees+=EQMIDIHeapProbe::frees;heapMeasured=true;
#endif
        int start=0;for(int end:{73,997,2048}){float* channels[]{expected.getWritePointer(0,start),expected.getWritePointer(1,start)};juce::AudioBuffer<float> slice(channels,2,end-start);oracle->processBlock(slice,empty);start=end;if(end==73)targets(*oracle,1);if(end==997)targets(*oracle,2);}
        for(int ch=0;ch<2;++ch)for(int i=0;i<2048;++i)maximumError=juce::jmax(maximumError,std::abs(static_cast<double>(audio.getSample(ch,i)-expected.getSample(ch,i))));
        timing=timing&&midi.getNumEvents()==events&&actual->bands[0].gain.load()==9&&actual->outputGain.load()==-3;
        auto info=actual->midiProgramInfo();timing=timing&&static_cast<int>(info["lastStatus"])==1&&static_cast<int>(info["lastBank"])==257&&static_cast<int>(info["lastProgram"])==18;
        juce::MemoryBlock bytes,again;actual->getStateInformation(bytes);auto copy=std::make_unique<OpenStudioEQ>(true);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);state=state&&bytes==again&&copy->midiProgramInfo()["entries"].size()==2;
        midi.clear();midi.addEvent(juce::MidiMessage::programChange(4,17),0);actual->processBlock(warm,midi);policy=policy&&actual->bands[0].gain.load()==9;
        midi.clear();midi.addEvent(juce::MidiMessage::programChange(3,99),0);actual->processBlock(warm,midi);policy=policy&&actual->bands[0].gain.load()==9&&static_cast<int>(actual->midiProgramInfo()["lastStatus"])==2;
        actual->phaseQuality.store(0);midi.clear();midi.addEvent(juce::MidiMessage::programChange(3,17),0);actual->processBlock(warm,midi);policy=policy&&actual->bands[0].gain.load()==9&&static_cast<int>(actual->midiProgramInfo()["lastStatus"])==3&&actual->getLatencySamples()==0;actual->phaseQuality.store(1);
        actual->reset();midi.clear();midi.addEvent(juce::MidiMessage::programChange(3,17),0);actual->processBlock(warm,midi);policy=policy&&static_cast<int>(actual->midiProgramInfo()["lastStatus"])==2&&static_cast<int>(actual->midiProgramInfo()["lastBank"])==0;
        auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());auto map=tree.getChildWithName("MIDIPrograms");map.getChild(0).setProperty("values",juce::var(),nullptr);juce::MemoryBlock invalid;juce::MemoryOutputStream invalidStream(invalid,false);tree.writeToStream(invalidStream);copy->setStateInformation(invalid.getData(),static_cast<int>(invalid.getSize()));validation=validation&&static_cast<bool>(copy->midiProgramInfo()["restoreRejected"])&&!static_cast<bool>(copy->midiProgramInfo()["enabled"]);
        tree.removeChild(tree.getChildWithName("MIDIPrograms"),nullptr);juce::MemoryBlock old;juce::MemoryOutputStream oldStream(old,false);tree.writeToStream(oldStream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));state=state&&!static_cast<bool>(copy->midiProgramInfo()["enabled"])&&copy->midiProgramInfo()["entries"].size()==0;
    }
    auto capacity=std::make_unique<OpenStudioEQ>(true);for(int i=0;i<32;++i)validation=edit(*capacity,"capture",0,i)&&validation;validation=!edit(*capacity,"capture",0,32)&&validation&&edit(*capacity,"capture",0,0)&&edit(*capacity,"remove",0,1)&&edit(*capacity,"capture",0,32)&&!edit(*capacity,"capture",16384,0)&&!edit(*capacity,"capture",0,128);
    for (const juce::var& bad : {juce::var(1.5), juce::var("1"), juce::var(std::numeric_limits<double>::infinity())})
    {
        auto* invalid = new juce::DynamicObject(); invalid->setProperty("action", "capture"); invalid->setProperty("bank", bad); invalid->setProperty("program", 0); validation = !capacity->editMIDIProgram(juce::var(invalid)) && validation;
    }
    // Concurrent MIDI writes, map publication and full-state capture must never
    // produce a mixture of the two program settings or reclaim an active map.
    bool coherent = true; int publishedEdits=0,rejectedEdits=0; auto concurrent = std::make_unique<OpenStudioEQ>(true);
    targets(*concurrent,1);edit(*concurrent,"capture",0,0);targets(*concurrent,2);edit(*concurrent,"capture",0,1);edit(*concurrent,"configure");concurrent->prepareToPlay(48000,64);
    std::atomic<bool> stop{false};std::atomic<int> blocks{0};
    std::thread audioThread([&] {juce::AudioBuffer<float> audio(2,64);juce::MidiBuffer first,second;first.addEvent(juce::MidiMessage::programChange(1,0),0);second.addEvent(juce::MidiMessage::programChange(1,1),0);while(!stop.load()){audio.clear();concurrent->processBlock(audio,(blocks.load()&1)?first:second);blocks.fetch_add(1);}});
    while(blocks.load()==0)juce::Thread::yield();
    for(int i=0;i<100;++i)
    {
        juce::MemoryBlock captured;concurrent->getStateInformation(captured);const auto tree=juce::ValueTree::readFromData(captured.getData(),captured.getSize());
        const float gain=static_cast<float>(tree["band0_gain"]),output=static_cast<float>(tree["outputGain"]);
        coherent=coherent&&tree.isValid()&&((gain==-12&&output==0)||(gain==9&&output==-3))&&tree.getChildWithName("MIDIPrograms").getNumChildren()==2;
        if(edit(*concurrent,"configure"))++publishedEdits;else ++rejectedEdits;
    }
    stop.store(true);audioThread.join();const bool publishedAfterIdle=edit(*concurrent,"configure");result->setProperty("concurrentSnapshotsCoherent",coherent);result->setProperty("concurrentPublishedEdits",publishedEdits);result->setProperty("concurrentBoundedBackpressure",rejectedEdits);result->setProperty("publicationResumesAfterIdle",publishedAfterIdle);coherent=coherent&&publishedEdits>0&&publishedAfterIdle;result->setProperty("concurrentCaptureAndPublication",coherent);result->setProperty("concurrentAudioBlocks",blocks.load());state=state&&coherent;
    auto legacy=std::make_unique<OpenStudioEQ>(false);validation=!edit(*legacy,"capture")&&!legacy->acceptsMidi()&&capacity->acceptsMidi()&&validation;
    result->setProperty("plugin","Preloaded EQ MIDI bank/program recall");result->setProperty("sampleAccurateTargetsAndMIDIPassThrough",timing);result->setProperty("manualEventSplitError",maximumError);result->setProperty("channelUnmappedConfigurationAndResetPolicy",policy);result->setProperty("completeStateAndOldDefault",state);result->setProperty("boundedMapAndMalformedState",validation);result->setProperty("audioThreadHeapMeasured",heapMeasured);result->setProperty("audioThreadAllocations",allocations);result->setProperty("audioThreadFrees",frees);result->setProperty("schema",describeFreePluginForRegression(*capacity));result->setProperty("audioQuality","not_asserted");result->setProperty("pass",timing&&maximumError<1e-7&&policy&&state&&validation&&allocations==0&&frees==0);return result;
}
