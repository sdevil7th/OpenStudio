#pragma once

inline juce::var checkMIDIChannelMix()
{
    auto* result=new juce::DynamicObject();bool levels=true,pan=true,isolation=true,reset=true,neutral=true,finite=true;double levelError=0,partitionError=0;juce::Array<juce::var> cases;
    const auto render=[&](double rate,int instrument,int scenario,int blockSize)
    {
        std::unique_ptr<juce::AudioProcessor> processor;
        if(instrument==0||instrument==4){auto p=std::make_unique<OpenStudioBasicSynthInstrument>();p->noiseLevel.store(0);p->outputGain.store(-30);if(instrument==4){p->mpeEnabled.store(1);p->mpeLowerMembers.store(2);}processor=std::move(p);}
        else if(instrument==1){auto p=std::make_unique<OpenStudioPianoInstrument>();p->outputGain.store(-30);processor=std::move(p);}
        else if(instrument==2){auto p=std::make_unique<OpenStudioCleanGuitarInstrument>();p->outputGain.store(-30);processor=std::move(p);}
        else {auto p=std::make_unique<OpenStudioDrumInstrument>();p->outputGain.store(-30);processor=std::move(p);}
        processor->prepareToPlay(rate,blockSize);juce::MemoryBlock before,after;processor->getStateInformation(before);
        const int count=juce::roundToInt(rate*.34);juce::AudioBuffer<float> output(2,count),block(2,blockSize);juce::MidiBuffer events;
        const auto cc=[&](double time,int number,int value,int channel=2){events.addEvent(juce::MidiMessage::controllerEvent(channel,number,value),juce::roundToInt(rate*time));};
        if(scenario==1){cc(.001,7,64);cc(.001,11,64);}
        if(scenario==2)cc(.001,7,0);
        if(scenario==3)cc(.001,11,0);
        if(scenario==4){cc(.001,7,0,3);cc(.001,11,0,3);cc(.001,10,0,3);}
        if(scenario==5||scenario==7)cc(.001,10,0);
        if(scenario==6)cc(.001,10,127);
        if(scenario==7){cc(.001,7,64);cc(.001,11,0);cc(.012,121,0);}
        if(scenario==8){cc(.08127,11,0);cc(.14,10,127);cc(.193,7,40);cc(.247,121,0);}
        if(scenario==9){cc(.001,7,64,1);cc(.001,11,64);}
        events.addEvent(juce::MidiMessage::noteOn(2,instrument==3?36:60,(juce::uint8)90),juce::roundToInt(rate*.03));
        for(int start=0;start<count;start+=blockSize){const int n=juce::jmin(blockSize,count-start);block.setSize(2,n,false,false,true);block.clear();juce::MidiBuffer midi;for(const auto event:events)if(event.samplePosition>=start&&event.samplePosition<start+n)midi.addEvent(event.getMessage(),event.samplePosition-start);processor->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,n);}
        processor->getStateInformation(after);neutral=neutral&&before==after;for(int ch=0;ch<2;++ch)for(int i=0;i<count;++i)finite=finite&&std::isfinite(output.getSample(ch,i));return output;
    };
    const auto difference=[](const auto& a,const auto& b,double factor=1.0){double error=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double expected=.96*std::tanh(std::atanh(static_cast<double>(b.getSample(ch,i))/.96)*factor);error=juce::jmax(error,std::abs(a.getSample(ch,i)-expected));}return error;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int instrument=0;instrument<5;++instrument)
    {
        const auto base=render(rate,instrument,0,127),both=render(rate,instrument,1,127),left=render(rate,instrument,5,127),right=render(rate,instrument,6,127);
        const double error=difference(both,base,std::pow(64.0/127,2));levelError=juce::jmax(levelError,error);
        levels=levels&&base.getMagnitude(0,base.getNumSamples())>1e-6&&render(rate,instrument,2,127).getMagnitude(0,base.getNumSamples())==0&&render(rate,instrument,3,127).getMagnitude(0,base.getNumSamples())==0;
        pan=pan&&left.getMagnitude(1,0,left.getNumSamples())==0&&right.getMagnitude(0,0,right.getNumSamples())==0&&left.getMagnitude(0,0,left.getNumSamples())>1e-6&&right.getMagnitude(1,0,right.getNumSamples())>1e-6;
        isolation=isolation&&difference(render(rate,instrument,4,127),base)<1e-8;
        reset=reset&&difference(render(rate,instrument,7,127),left,64.0/127)<2e-6;
        const auto a=render(rate,instrument,8,127),b=render(rate,instrument,8,512);double exact=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)exact=juce::jmax(exact,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));partitionError=juce::jmax(partitionError,exact);
        if(instrument==4)levels=levels&&difference(render(rate,instrument,9,127),both)<1e-8;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("instrument",instrument);row->setProperty("levelLawError",error);row->setProperty("partitionError",exact);cases.add(row);
    }
    BuiltInMIDIChannelMix mix;mix.reset(48000);mix.controller(juce::MidiMessage::controllerEvent(1,7,32),[](size_t){return false;});mix.controller(juce::MidiMessage::controllerEvent(1,10,127),[](size_t){return false;});for(int i=0;i<300;++i)mix.next();mix.reset(48000);const auto initial=mix.next();reset=reset&&initial[0].level==1&&initial[0].pan==0;
    result->setProperty("plugin","Instrument MIDI channel volume, expression and pan");result->setProperty("cases",cases);result->setProperty("levelsAndMPEManager",levels);result->setProperty("stereoPanEndpoints",pan);result->setProperty("channelIsolation",isolation);result->setProperty("resetPreservesVolumePan",reset);result->setProperty("stateNeutral",neutral);result->setProperty("finite",finite);result->setProperty("levelLawError",levelError);result->setProperty("partitionError",partitionError);result->setProperty("pass",levels&&pan&&isolation&&reset&&neutral&&finite&&levelError<2e-6&&partitionError==0);return result;
}
