#pragma once

inline juce::var checkGuitarArticulations()
{
    auto* result=new juce::DynamicObject();juce::Array<juce::var> cases;bool finite=true,influence=true,ownership=true,keys=true,recall=true;double partition=0,transferError=0;
    const auto render=[](double rate,int style,int blockSize,int events=0)
    {
        auto guitar=std::make_unique<OpenStudioCleanGuitarInstrument>();guitar->stringEngine.store(1);guitar->articulation.store(static_cast<float>(events>=3?0:style));guitar->articulationKeys.store(events>=3?1.0f:0.0f);guitar->harmonicNode.store(3);guitar->pickNoise.store(0);guitar->slideTime.store(110);guitar->prepareToPlay(rate,blockSize);
        const int length=juce::roundToInt(rate*.55);juce::MidiBuffer all;
        if(events>=3)all.addEvent(juce::MidiMessage::noteOn(1,24+style,.8f),0);
        all.addEvent(juce::MidiMessage::noteOn(1,55,.75f),0);
        if(style==3||style==4){all.addEvent(juce::MidiMessage::noteOn(1,60,.7f),juce::roundToInt(rate*.12));if(events!=1)all.addEvent(juce::MidiMessage::noteOff(1,55),juce::roundToInt(rate*.2));all.addEvent(juce::MidiMessage::noteOff(1,60),juce::roundToInt(rate*.35));}
        else all.addEvent(juce::MidiMessage::noteOff(1,55),juce::roundToInt(rate*.3));
        if(events==2)all.addEvent(juce::MidiMessage::allSoundOff(1),juce::roundToInt(rate*.25));
        juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<length;start+=blockSize){const int n=juce::jmin(blockSize,length-start);block.setSize(2,n,false,false,true);midi.clear();midi.addEvents(all,start,n,-start);guitar->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,n);}return output;
    };
    const auto difference=[](const auto& a,const auto& b){double error=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)error=juce::jmax(error,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));return error;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto baseline=render(rate,0,127);
        for(int style=0;style<9;++style)
        {
            const auto a=render(rate,style,127),b=render(rate,style,511);const double error=difference(a,b),change=difference(a,baseline);partition=juce::jmax(partition,error);influence=influence&&(style==0||change>1e-5);
            for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)finite=finite&&std::isfinite(a.getSample(ch,i))&&std::abs(a.getSample(ch,i))<=2.5;
            keys=keys&&difference(a,render(rate,style,127,3))==0;
            if(style==3||style==4)ownership=ownership&&difference(a,render(rate,style,127,1))==0;
            const auto stopped=render(rate,style,127,2);if(style==3||style==4)for(int ch=0;ch<2;++ch)for(int i=juce::roundToInt(rate*.26);i<stopped.getNumSamples();++i)ownership=ownership&&stopped.getSample(ch,i)==0;
            auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("articulation",style);row->setProperty("audioDifference",change);row->setProperty("partitionError",error);cases.add(row);
        }
        auto a=std::make_unique<BuiltInPluckedLoop>(),b=std::make_unique<BuiltInPluckedLoop>();a->prepare(rate);b->prepare(rate);BuiltInPluckedLoop::Parameters p;a->start(0,55,.7f,p);b->start(0,55,.7f,p);const float freq=static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(55));
        for(int i=0;i<static_cast<int>(rate*.1);++i){a->process(0,freq,p);b->process(0,freq,p);}ownership=ownership&&b->transfer(1,0);for(int i=0;i<static_cast<int>(rate*.1);++i)transferError=juce::jmax(transferError,std::abs(static_cast<double>(a->process(0,freq,p)-b->process(1,freq,p))));
    }
    auto source=std::make_unique<OpenStudioCleanGuitarInstrument>(),copy=std::make_unique<OpenStudioCleanGuitarInstrument>();for(const auto& control:source->articulationControls)recall=recall&&setFreePluginParamForRegression(*source,control.id,control.maximum);
    juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);recall=recall&&bytes==again;
    auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());for(const auto& control:source->articulationControls)tree.removeProperty(control.id,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));for(const auto& control:copy->articulationControls)recall=recall&&(copy.get()->*control.member).load()==control.initial;
    const auto schema=describeFreePluginForRegression(*source);const bool appended=schema["parameters"].size()>=23&&schema["parameters"][19]["id"].toString()=="articulation"&&schema["parameters"][9]["id"].toString()=="stringEngine";
    result->setProperty("plugin","Guitar original articulations and string-history transfer");result->setProperty("cases",cases);result->setProperty("finite",finite);result->setProperty("audioInfluence",influence);result->setProperty("partitionError",partition);result->setProperty("exactHistoryTransferError",transferError);result->setProperty("oldNoteOffAndPanicOwnership",ownership);result->setProperty("keyswitchAudioParity",keys);result->setProperty("stateAndOldDefaults",recall);result->setProperty("appendedDescriptors",appended);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");result->setProperty("pass",finite&&influence&&partition==0&&transferError==0&&ownership&&keys&&recall&&appended);return result;
}
