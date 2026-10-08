#pragma once

inline juce::var checkEQPreparedPrograms()
{
    auto* result=new juce::DynamicObject();juce::Array<juce::var> cases;bool pass=true;
    const auto edit=[](OpenStudioEQ& eq,const char* action,int program=0,bool enabled=true)
    {
        auto* value=new juce::DynamicObject();value->setProperty("action",action);value->setProperty("bank",0);
        value->setProperty("program",program);value->setProperty("channel",0);value->setProperty("enabled",enabled);
        value->setProperty("name","Prepared mode");return eq.editMIDIProgram(juce::var(value));
    };
    const auto mode=[](OpenStudioEQ& eq,int index)
    {
        eq.phaseMode.store(index==1?1.0f:0.0f);eq.phaseQuality.store(0);eq.minimumPhaseFIR.store(index==2?1.0f:0.0f);
        eq.analogResponse.store(index==2?1.0f:0.0f);eq.spectralProcessing.store(index==3?1.0f:0.0f);
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        auto eq=std::make_unique<OpenStudioEQ>(true);bool prepared=true,stable=true,finite=true,state=true,reset=true;
        for(int index=0;index<4;++index){mode(*eq,index);eq->outputGain.store(static_cast<float>(index*3-9));prepared=edit(*eq,"capture",index)&&prepared;}
        mode(*eq,0);eq->outputGain.store(0);prepared=edit(*eq,"configure")&&prepared;eq->prepareToPlay(rate,128);
        const int latency=eq->getLatencySamples();prepared=prepared&&eq->hasPreparedMIDIPrograms()&&latency>0;
        juce::AudioBuffer<float> audio(2,128);juce::MidiBuffer midi;midi.ensureSize(128);
        int first=-1,allocations=0,frees=0;double peak=0,maxStep=0;float last=0;
        for(int position=0;position<latency+256;position+=128)
        {
            audio.clear();if(position==0){audio.setSample(0,0,1);audio.setSample(1,0,1);}eq->processBlock(audio,midi);
            for(int i=0;i<128;++i)if(first<0&&std::abs(audio.getSample(0,i))>1e-5f)first=position+i;
        }
        stable=first==latency;
        // Dense changes exercise the latest-target queue during an audible fade.
        for(int frame=0;frame<768;++frame)
        {
            midi.clear();if(frame%71==0||frame%71==16||frame%71==18)midi.addEvent(juce::MidiMessage::programChange(1,(frame/71+(frame%71==16?1:frame%71==18?2:0))%4),37);
            for(int i=0;i<128;++i)for(int ch=0;ch<2;++ch)audio.setSample(ch,i,.1f*std::sin(static_cast<float>(frame*128+i)*.013f));
#if JUCE_WINDOWS && defined(_DEBUG)
            EQMIDIHeapProbe::allocations=EQMIDIHeapProbe::frees=0;EQMIDIHeapProbe::previous=_CrtSetAllocHook(EQMIDIHeapProbe::hook);EQMIDIHeapProbe::active=true;
#endif
            eq->processBlock(audio,midi);
#if JUCE_WINDOWS && defined(_DEBUG)
            EQMIDIHeapProbe::active=false;_CrtSetAllocHook(EQMIDIHeapProbe::previous);allocations+=EQMIDIHeapProbe::allocations;frees+=EQMIDIHeapProbe::frees;
#endif
            stable=stable&&eq->getLatencySamples()==latency;
            for(int i=0;i<128;++i){const float value=audio.getSample(0,i);finite=finite&&std::isfinite(value);peak=juce::jmax(peak,std::abs(static_cast<double>(value)));maxStep=juce::jmax(maxStep,std::abs(static_cast<double>(value-last)));last=value;}
        }
        juce::MemoryBlock bytes,again;eq->getStateInformation(bytes);auto copy=std::make_unique<OpenStudioEQ>(true);
        copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);state=bytes==again;
        copy->prepareToPlay(rate,512);state=state&&copy->hasPreparedMIDIPrograms()&&copy->getLatencySamples()==latency;
        const auto selectedMode=eq->phaseMode.load();const auto selectedSpectral=eq->spectralProcessing.load();eq->reset();audio.clear();midi.clear();eq->processBlock(audio,midi);
        reset=eq->phaseMode.load()==selectedMode&&eq->spectralProcessing.load()==selectedSpectral&&eq->getLatencySamples()==latency;
        const bool guarded=!eq->setPhaseConfiguration(1,1)&&edit(*eq,"configure",0,false)&&!eq->hasPreparedMIDIPrograms()&&eq->setPhaseConfiguration(0,0);
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("prepared",prepared);item->setProperty("reservedLatency",latency);item->setProperty("firstImpulseSample",first);
        item->setProperty("stableLatency",stable);item->setProperty("finite",finite);item->setProperty("peak",peak);item->setProperty("maxStepDiagnostic",maxStep);item->setProperty("stateAndReprepare",state);
        item->setProperty("resetKeepsSelectedMode",reset);item->setProperty("configurationGuardAndDisarm",guarded);item->setProperty("allocations",allocations);item->setProperty("frees",frees);
        const bool okay=prepared&&stable&&finite&&state&&reset&&guarded&&allocations==0&&frees==0;item->setProperty("pass",okay);pass=pass&&okay;cases.add(juce::var(item));
    }
    auto audition=std::make_unique<OpenStudioEQ>(true);mode(*audition,1);edit(*audition,"capture",0);mode(*audition,0);edit(*audition,"configure");audition->prepareToPlay(48000,128);
    juce::MemoryBlock before,after;audition->getStateInformation(before);auto oracle=std::make_unique<OpenStudioEQ>(true);oracle->setStateInformation(before.getData(),static_cast<int>(before.getSize()));oracle->prepareToPlay(48000,128);
    auto* band=new juce::DynamicObject();band->setProperty("frequency",1000);band->setProperty("gain",-12);band->setProperty("q",1);
    juce::Array<juce::var> proposal;proposal.add(band);const auto started=audition->startDraftPreview("prepared-draft",proposal,before.toBase64Encoding());
    juce::AudioBuffer<float> actual(2,128),expected(2,128);juce::MidiBuffer empty;double auditionEnergy=0,originalEnergy=0;
    for(int frame=0;frame<128;++frame)
    {
        for(int sample=0;sample<128;++sample)for(int ch=0;ch<2;++ch){const float value=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*1000*(frame*128+sample)/48000));actual.setSample(ch,sample,value);expected.setSample(ch,sample,value);}
        audition->processBlock(actual,empty);oracle->processBlock(expected,empty);
        if(frame>64)for(int sample=0;sample<128;++sample){auditionEnergy+=std::pow(actual.getSample(0,sample),2);originalEnergy+=std::pow(expected.getSample(0,sample),2);}
    }
    audition->getStateInformation(after);const auto stopped=audition->commandDraftPreview("prepared-draft",true);
    const bool preview=static_cast<bool>(started["success"])&&static_cast<bool>(stopped["success"])&&before==after&&auditionEnergy<originalEnergy*.2&&audition->getLatencySamples()==oracle->getLatencySamples();
    result->setProperty("draftAuditionInPreparedBank",preview);result->setProperty("draftEnergyRatio",auditionEnergy/juce::jmax(1e-30,originalEnergy));pass=pass&&preview;
    result->setProperty("plugin","Prepared EQ configuration-changing MIDI bank");result->setProperty("cases",cases);result->setProperty("audioQuality","not_asserted");result->setProperty("pass",pass);return result;
}
