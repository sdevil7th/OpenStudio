#pragma once

inline juce::var checkSynthGuitarSostenuto()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Synth/Guitar sostenuto receiver ownership");
    bool ownership=true,held=true,released=true,later=true,isolation=true,reset=true,partition=true,mpePass=true;
    BuiltInVoiceAllocation pool;std::array<std::array<bool,128>,16> active{};
    const auto a=pool.start(1,60,active);active[1][a]=true;
    pool.setSostenuto(0,true,[](size_t receiver){return receiver==1;});
    const auto b=pool.start(1,64,active);active[1][b]=true;
    pool.setSostenuto(1,true,[](size_t receiver){return receiver==1;});
    pool.stop(1,60);pool.stop(1,64);pool.setSostenuto(0,false,[](size_t){return false;});
    ownership=pool.sustained(1,a)&&pool.sustained(1,b);
    pool.setSostenuto(1,false,[](size_t){return false;});ownership=ownership&&!pool.sustained(1,a)&&!pool.sustained(1,b);
    pool.reset();active={};const auto c=pool.start(0,60,active);active[0][c]=true;pool.setSostenuto(0,true,[](size_t receiver){return receiver==0;});
    const auto d=pool.start(0,60,active);active[0][d]=true;pool.setSostenuto(0,true,[](size_t receiver){return receiver==0;});
    ownership=ownership&&pool.stop(0,60)==static_cast<int>(c)&&pool.sustained(0,c)&&pool.stop(0,60)==static_cast<int>(d)&&!pool.sustained(0,d);
    active[0][c]=false;const auto reused=pool.start(0,67,active);ownership=ownership&&reused==c&&!pool.sustained(0,reused);
    const auto render=[](double rate,int instrument,int scenario,int blockSize)
    {
        std::unique_ptr<juce::AudioProcessor> processor;
        if(instrument==0||instrument==3)
        {auto synth=std::make_unique<OpenStudioBasicSynthInstrument>();synth->releaseMs.store(20);synth->noiseLevel.store(0);synth->attackMs.store(1);if(instrument==3){synth->mpeEnabled.store(1);synth->mpeLowerMembers.store(2);synth->mpeUpperMembers.store(2);}processor=std::move(synth);}
        else {auto guitar=std::make_unique<OpenStudioCleanGuitarInstrument>();guitar->releaseMs.store(20);guitar->stringEngine.store(instrument==2?1.0f:0.0f);processor=std::move(guitar);}
        processor->prepareToPlay(rate,blockSize);const int count=juce::roundToInt(rate*.65);juce::AudioBuffer<float> output(2,count),block(2,blockSize);juce::MidiBuffer events;
        const int channel=instrument==3?2:1;const int sender=scenario==4?(instrument==3?16:2):(instrument==3?1:1);
        const auto add=[&](double seconds,const juce::MidiMessage& event){events.addEvent(event,juce::roundToInt(seconds*rate));};
        if(scenario==3){add(.01,juce::MidiMessage::controllerEvent(sender,66,127));add(.03,juce::MidiMessage::noteOn(channel,60,(juce::uint8)100));add(.04,juce::MidiMessage::controllerEvent(sender,66,127));}
        else{add(.01,juce::MidiMessage::noteOn(channel,60,(juce::uint8)100));if(scenario!=0)add(.03,juce::MidiMessage::controllerEvent(sender,66,127));}
        add(.06,juce::MidiMessage::noteOff(channel,60));
        if(scenario==2||scenario==7)add(.12,juce::MidiMessage::controllerEvent(sender,64,127));
        if(scenario==5)add(.14,juce::MidiMessage::controllerEvent(sender,121,0));
        if(scenario==6)add(.14,juce::MidiMessage::allSoundOff(sender));
        if(scenario==7)add(.2,juce::MidiMessage::controllerEvent(sender,66,0));
        if(instrument==3&&scenario==8){add(.04,juce::MidiMessage::controllerEvent(channel,66,127));add(.14,juce::MidiMessage::controllerEvent(sender,66,0));}
        add(.3,juce::MidiMessage::controllerEvent(sender,66,0));add(.3,juce::MidiMessage::controllerEvent(sender,64,0));
        if(instrument==3&&scenario==8)add(.3,juce::MidiMessage::controllerEvent(channel,66,0));
        for(int start=0;start<count;start+=blockSize)
        {
            const int n=juce::jmin(blockSize,count-start);block.setSize(2,n,false,false,true);block.clear();juce::MidiBuffer midi;
            for(const auto event:events)if(event.samplePosition>=start&&event.samplePosition<start+n)midi.addEvent(event.getMessage(),event.samplePosition-start);
            processor->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,n);
        }
        return output;
    };
    const auto energy=[](const juce::AudioBuffer<float>& audio,double rate,double from,double to){double value=0;for(int i=juce::roundToInt(from*rate);i<juce::roundToInt(to*rate);++i)for(int ch=0;ch<2;++ch){const double sample=audio.getSample(ch,i);value+=sample*sample;}return value;};
    const auto difference=[](const juce::AudioBuffer<float>& a,const juce::AudioBuffer<float>& b){double value=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)value=juce::jmax(value,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));return value;};
    juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int instrument:{0,1,2,3})
    {
        const auto dry=render(rate,instrument,0,512),sost=render(rate,instrument,1,512),changedBlock=render(rate,instrument,1,127);
        const double base=energy(dry,rate,.18,.25),latched=energy(sost,rate,.18,.25),after=energy(sost,rate,.5,.6);
        const bool sounds=latched>1e-12&&latched>base*2,ends=after<latched*.01;
        held=held&&sounds;released=released&&ends;partition=partition&&difference(sost,changedBlock)<1e-6;
        const auto late=render(rate,instrument,3,512),otherChannel=render(rate,instrument,4,512),controllerReset=render(rate,instrument,5,512),soundOff=render(rate,instrument,6,512),combined=render(rate,instrument,7,512);
        later=later&&energy(late,rate,.18,.25)<latched*.01;isolation=isolation&&difference(dry,otherChannel)<1e-7;
        reset=reset&&energy(controllerReset,rate,.24,.29)<latched*.01&&energy(soundOff,rate,.15,.25)==0;
        held=held&&energy(combined,rate,.23,.28)>1e-12;
        if(instrument==3){const auto dual=render(rate,instrument,8,512);mpePass=mpePass&&energy(dual,rate,.18,.25)>1e-12&&energy(dual,rate,.5,.6)<latched*.01;}
        auto* item=new juce::DynamicObject();item->setProperty("sampleRate",rate);item->setProperty("instrument",instrument);item->setProperty("heldEnergy",latched);item->setProperty("baseEnergy",base);item->setProperty("releaseEnergy",after);item->setProperty("held",sounds);item->setProperty("released",ends);cases.add(item);
    }
    result->setProperty("cases",cases);result->setProperty("ownerEdgesReuseFIFO",ownership);result->setProperty("heldAudio",held);result->setProperty("releasedAudio",released);
    result->setProperty("laterKeysExcluded",later);result->setProperty("channelIsolation",isolation);result->setProperty("resetAndSoundOff",reset);result->setProperty("partition",partition);result->setProperty("mpeIndependentOwners",mpePass);
    result->setProperty("pass",ownership&&held&&released&&later&&isolation&&reset&&partition&&mpePass);return result;
}
