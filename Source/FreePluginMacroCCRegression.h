#pragma once

inline juce::var checkMacroCCMapping()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Synth MIDI macro mapping and event observation");
    bool mapping=true,stateNeutral=true,recall=true,legacy=true,guards=true;double parity=0,partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int slot,int blockSize,bool manual,bool wrongChannel,bool liveChanges)
    {
        auto synth=std::make_unique<OpenStudioBasicSynthInstrument>();synth->noiseLevel.store(0);synth->matrix1Source.store(static_cast<float>(9+slot));synth->matrix1Target.store(1);synth->matrix1Amount.store(.35f);
        synth->setModulationControl("macro"+juce::String(slot+1),manual?1.0f:0.0f);
        synth->setModulationControl("macro"+juce::String(slot+1)+"CC",manual?0.0f:75.0f);synth->setModulationControl("macro"+juce::String(slot+1)+"Channel",2);
        synth->prepareToPlay(rate,blockSize);const int count=juce::roundToInt(rate*.35);juce::AudioBuffer<float> output(2,count),block(2,blockSize);juce::MidiBuffer events;
        events.addEvent(juce::MidiMessage::controllerEvent(wrongChannel?3:2,74,127),0);
        events.addEvent(juce::MidiMessage::noteOn(1,60,(juce::uint8)100),juce::roundToInt(rate*.12));
        if(liveChanges){events.addEvent(juce::MidiMessage::controllerEvent(2,74,32),juce::roundToInt(rate*.173));events.addEvent(juce::MidiMessage::controllerEvent(2,121,0),juce::roundToInt(rate*.231));}
        for(int pos=0;pos<count;pos+=blockSize){const int n=juce::jmin(blockSize,count-pos);block.setSize(2,n,false,false,true);block.clear();juce::MidiBuffer midi;for(const auto event:events)if(event.samplePosition>=pos&&event.samplePosition<pos+n)midi.addEvent(event.getMessage(),event.samplePosition-pos);synth->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,pos,block,ch,0,n);}
        return output;
    };
    const auto difference=[](const auto& a,const auto& b){double d=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)d=juce::jmax(d,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));return d;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int slot=0;slot<4;++slot)
    {
        const auto midi=render(rate,slot,512,false,false,false),manual=render(rate,slot,512,true,false,false);
        const double error=difference(midi,manual);parity=juce::jmax(parity,error);
        const auto a=render(rate,slot,512,false,false,true),b=render(rate,slot,127,false,false,true);partition=juce::jmax(partition,difference(a,b));
        mapping=mapping&&difference(midi,render(rate,slot,512,false,true,false))>1e-4;
        auto* item=new juce::DynamicObject();item->setProperty("sampleRate",rate);item->setProperty("macro",slot+1);item->setProperty("manualParityError",error);cases.add(item);
    }
    BuiltInSynthCCMacros receiver;receiver.configure({75,75,0,0},{0,3,0,0});
    receiver.controller(juce::MidiMessage::controllerEvent(3,74,64),[](int){return false;});
    guards=guards&&receiver.value(0,0)==64.0f/127&&receiver.value(1,0)==64.0f/127;
    receiver.controller(juce::MidiMessage::controllerEvent(4,121,0),[](int channel){return channel==3;});guards=guards&&receiver.value(0,0)>0;
    receiver.clear(0);receiver.configure({75,75,0,0},{0,3,0,0});guards=guards&&receiver.value(0,.2f)==.2f&&receiver.value(1,0)>0;
    receiver.controller(juce::MidiMessage::controllerEvent(3,121,0),[](int channel){return channel==2;});guards=guards&&receiver.value(1,.3f)==.3f;
    const auto telemetry=receiver.visualization({0,0,0,0});guards=guards&&telemetry["midiCCEvent"].size()==4&&static_cast<int>(telemetry["midiCCEvent"][1])==74&&static_cast<int>(telemetry["midiCCEvent"][2])==3;
    auto source=std::make_unique<OpenStudioBasicSynthInstrument>(),copy=std::make_unique<OpenStudioBasicSynthInstrument>();
    for(const auto& control:source->macroMappings)recall=recall&&setFreePluginParamForRegression(*source,control.id,control.maximum);
    source->macro1CC.store(75);source->macro1Channel.store(0);source->prepareToPlay(48000,512);
    juce::MemoryBlock before,after;source->getStateInformation(before);juce::AudioBuffer<float> audio(2,512);audio.clear();juce::MidiBuffer events;events.addEvent(juce::MidiMessage::controllerEvent(3,74,127),0);source->processBlock(audio,events);source->getStateInformation(after);stateNeutral=before==after&&source->macro1.load()==0&&source->extendedMatrixValues()[15]==1;
    copy->setStateInformation(before.getData(),static_cast<int>(before.getSize()));copy->getStateInformation(after);recall=recall&&before==after&&copy->extendedMatrixValues()[15]==0;
    auto old=juce::ValueTree::readFromData(before.getData(),before.getSize());for(const auto& control:source->macroMappings)old.removeProperty(control.id,nullptr);juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);old.writeToStream(stream);copy->setStateInformation(oldBytes.getData(),static_cast<int>(oldBytes.getSize()));for(const auto& control:copy->macroMappings)legacy=legacy&&(copy.get()->*control.member).load()==0;
    const auto schema=describeFreePluginForRegression(*source);const bool descriptors=schema["parameters"].size()>=78&&schema["parameters"][64]["id"].toString()=="matrix1SourceExpanded"&&schema["parameters"][70]["id"].toString()=="macro1CC"&&!static_cast<bool>(schema["parameters"][70]["automatable"]);
    result->setProperty("cases",cases);result->setProperty("manualParityError",parity);result->setProperty("sampleAccuratePartitionError",partition);result->setProperty("channelMapping",mapping);result->setProperty("stateNeutralPerformance",stateNeutral);result->setProperty("mappingRecall",recall);result->setProperty("oldStateDefaultsOff",legacy);result->setProperty("resetManualEditAndTelemetry",guards);result->setProperty("appendedDescriptors",descriptors);result->setProperty("schema",schema);
    result->setProperty("pass",parity<2e-6&&partition==0&&mapping&&stateNeutral&&recall&&legacy&&guards&&descriptors);return result;
}
