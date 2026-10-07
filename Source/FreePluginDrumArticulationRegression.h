#pragma once
inline juce::var checkDrumArticulations()
{
    auto* result=new juce::DynamicObject();bool mapping=true,influence=true,finite=true,choke=true,state=true;double partition=0;juce::Array<juce::var> cases;
    using Kind=BuiltInDrumArticulations::Kind;
    const std::array<std::pair<int,Kind>,18> expected{{{37,Kind::SideStick},{40,Kind::RimShot},{53,Kind::RideBell},{52,Kind::RideEdge},{56,Kind::Muted},{83,Kind::Muted},{82,Kind::TomRim},{81,Kind::TomRimOnly},{71,Kind::RimOnly},{33,Kind::SnareEdge},{84,Kind::CymbalBow},{3,Kind::Tambourine},{2,Kind::Shaker},{1,Kind::OneShot},{23,Kind::PedalOpen},{21,Kind::PedalClosed},{19,Kind::HatTip},{20,Kind::HatEdge}}};
    for(const auto& item:expected)mapping=mapping&&BuiltInDrumArticulations::identify(2,item.first).kind==item.second;
    for(int note=0;note<128;++note){const auto voice=BuiltInDrumArticulations::identify(2,note);mapping=mapping&&(note==0||note==4||note==5?voice.note==-1:voice.note>=0&&voice.note<128);}
    const auto render=[](double rate,int blockSize,int note,int map,float engine,float decay,int target=-2,int pressureChannel=0,bool changeMap=false)
    {
        auto drums=std::make_unique<OpenStudioDrumInstrument>();drums->articulationEngine.store(engine);drums->mapPreset.store(static_cast<float>(map));drums->ambience.store(0);drums->outputGain.store(-24);drums->stereoWidth.store(1);
        for(auto& value:drums->pieceDecay)value.store(decay);if(target>=-1){drums->customMapEnabled.store(1);drums->noteMap[static_cast<size_t>(note)].store(static_cast<float>(target));}
        drums->prepareToPlay(rate,blockSize);const int count=juce::roundToInt(rate*.4),change=juce::roundToInt(rate*.12);juce::AudioBuffer<float> output(2,count),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<count;){int size=juce::jmin(blockSize,count-start);if(start<change)size=juce::jmin(size,change-start);block.setSize(2,size,false,false,true);block.clear();midi.clear();if(start==0)midi.addEvent(juce::MidiMessage::noteOn(10,note,.8f),0);
            if(start==change){if(changeMap){drums->customMapEnabled.store(1);drums->noteMap[static_cast<size_t>(note)].store(38);}if(pressureChannel)midi.addEvent(juce::MidiMessage::aftertouchChange(pressureChannel,note,127),0);}drums->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,size);start+=size;}
        return output;
    };
    const auto difference=[](const auto& a,const auto& b){double total=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double d=a.getSample(ch,i)-b.getSample(ch,i);total+=d*d;}return total;};
    const auto energy=[](const auto& a,int start){double total=0;for(int ch=0;ch<2;++ch)for(int i=start;i<a.getNumSamples();++i){const double sample=a.getSample(ch,i);total+=sample*sample;}return total;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(const auto& pair:std::array<std::pair<int,int>,9>{{{37,38},{38,40},{51,53},{51,52},{55,56},{41,73},{42,22},{12,17},{84,55}}})
        {const auto a=render(rate,127,pair.first,2,1,1),b=render(rate,127,pair.second,2,1,1);const double delta=difference(a,b);influence=influence&&delta>1e-6;finite=finite&&std::isfinite(a.getMagnitude(0,a.getNumSamples()))&&a.getMagnitude(0,a.getNumSamples())<2;auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("first",pair.first);row->setProperty("second",pair.second);row->setProperty("differenceEnergy",delta);cases.add(row);}
        const auto a=render(rate,127,53,2,1,1),b=render(rate,511,53,2,1,1);for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)partition=juce::jmax(partition,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));
        const auto shortDecay=render(rate,127,38,2,1,.3f),longDecay=render(rate,127,38,2,1,2);influence=influence&&energy(longDecay,static_cast<int>(rate*.15))>energy(shortDecay,static_cast<int>(rate*.15))*4;
        mapping=mapping&&difference(render(rate,127,60,2,1,1,53),a)==0&&energy(render(rate,127,60,2,1,1,-1),0)==0;
        const auto kept=render(rate,127,55,2,1,1,-2,0,true),stopped=render(rate,127,55,2,1,1,-2,10,true),unrelated=render(rate,127,55,2,1,1,-2,2,true);
        choke=choke&&difference(kept,unrelated)==0&&energy(stopped,static_cast<int>(rate*.15))==0&&energy(kept,static_cast<int>(rate*.15))>1e-5;
    }
    auto drums=std::make_unique<OpenStudioDrumInstrument>(),copy=std::make_unique<OpenStudioDrumInstrument>();state=setFreePluginParamForRegression(*drums,"articulationEngine",1)&&setFreePluginParamForRegression(*drums,"drumMapAll",2)&&setFreePluginParamForRegression(*drums,"customMapEnabled",1);
    for(int i=0;i<128;++i)state=setFreePluginParamForRegression(*drums,"noteMap"+juce::String(i),static_cast<float>(127-i))&&state;for(int i=0;i<8;++i)state=setFreePluginParamForRegression(*drums,"pieceDecay"+juce::String(i),.2f+static_cast<float>(i)*.3f)&&state;
    juce::MemoryBlock bytes,again;drums->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);state=state&&bytes==again;
    auto old=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());old.removeProperty("articulationEngine",nullptr);old.removeProperty("customMapEnabled",nullptr);old.setProperty("mapPreset",0,nullptr);for(int i=0;i<128;++i)old.removeProperty("noteMap"+juce::String(i),nullptr);for(int i=0;i<8;++i)old.removeProperty("pieceDecay"+juce::String(i),nullptr);bytes.reset();{juce::MemoryOutputStream stream(bytes,false);old.writeToStream(stream);}copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));state=state&&copy->articulationEngine.load()==0&&copy->customMapEnabled.load()==0;for(size_t i=0;i<128;++i)state=state&&copy->noteMap[i].load()==static_cast<float>(i);for(const auto& value:copy->pieceDecay)state=state&&value.load()==1;
    const auto schema=describeFreePluginForRegression(*drums);state=state&&schema["parameters"][33]["id"].toString()=="articulationEngine"&&schema["parameters"][34]["id"].toString()=="drumMapAll"&&static_cast<float>(schema["parameters"][9]["max"])==1;
    copy->prepareToPlay(48000,64);const auto priorEvent=copy->observedNoteEvent.load();juce::AudioBuffer<float> block(2,64);block.clear();juce::MidiBuffer midi;midi.addEvent(juce::MidiMessage::noteOn(2,71,.5f),7);copy->processBlock(block,midi);const auto event=copy->observedNoteEvent.load();state=state&&(event>>8)==(priorEvent>>8)+1&&(event&127u)==71;
    result->setProperty("plugin","Drum articulated synthesis, input maps and decay");result->setProperty("cases",cases);result->setProperty("mappingAndIgnore",mapping);result->setProperty("articulationAndDecayInfluence",influence);result->setProperty("finite",finite);result->setProperty("partitionError",partition);result->setProperty("chokeOwnershipAfterRemapAndChannelIsolation",choke);result->setProperty("stateDefaultsAppendAndObservation",state);result->setProperty("schema",schema);result->setProperty("factorySchema",describeFreePluginForRegression(*copy));result->setProperty("sampleLibraryEquivalence","not_asserted");result->setProperty("pass",mapping&&influence&&finite&&partition==0&&choke&&state);return result;
}
