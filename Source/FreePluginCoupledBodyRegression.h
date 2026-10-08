#pragma once

inline juce::var checkCoupledInstrumentBodies()
{
    auto* result = new juce::DynamicObject(); juce::Array<juce::var> cases;
    bool passive = true, transfer = true, finite = true, ownership = true, state = true, influenced = true;
    double partition = 0, maximumEnergyGrowth = 0;
    const auto render = [](bool piano, double rate, int blockSize, float amount, int channel, bool panic)
    {
        std::unique_ptr<juce::AudioProcessor> instrument;
        if (piano) { auto p=std::make_unique<OpenStudioPianoInstrument>(); p->coupledBody.store(amount);p->performanceMode.store(1);instrument=std::move(p); }
        else { auto p=std::make_unique<OpenStudioCleanGuitarInstrument>();p->coupledBody.store(amount);p->stringEngine.store(1);instrument=std::move(p); }
        instrument->prepareToPlay(rate,blockSize); const int length=juce::roundToInt(rate*.4);
        juce::MidiBuffer events;events.addEvent(juce::MidiMessage::controllerEvent(channel,10,channel==1?0:127),0);
        events.addEvent(juce::MidiMessage::noteOn(channel,60,.8f),0);
        events.addEvent(juce::MidiMessage::noteOff(channel,60),juce::roundToInt(rate*.15));
        if(panic)events.addEvent(juce::MidiMessage::allSoundOff(channel),juce::roundToInt(rate*.25));
        juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<length;start+=blockSize)
        {
            const int n=juce::jmin(blockSize,length-start);block.setSize(2,n,false,false,true);midi.clear();midi.addEvents(events,start,n,-start);
            instrument->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,n);
        }
        return output;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0}) for(bool piano:{true,false})
    {
        auto network=std::make_unique<BuiltInCoupledBody>();network->prepare(rate,piano);network->configure(1,8);
        network->process(0,1);double previous=network->energy(0);bool stringMoved=false;
        for(int i=0;i<12000;++i)
        {
            const float out=network->process(0,0,1);const double current=network->energy(0);
            maximumEnergyGrowth=juce::jmax(maximumEnergyGrowth,current-previous);
            passive=passive&&current<=previous*(1+1e-12);previous=current;finite=finite&&std::isfinite(out);
            stringMoved=stringMoved||network->stringEnergy(0)>1e-12;
            ownership=ownership&&network->process(1,0)==0&&network->energy(1)==0;
        }
        transfer=transfer&&stringMoved;network->resetChannel(0);ownership=ownership&&network->energy(0)==0;
        // Closed piano dampers must dissipate more energy than open strings.
        if(piano)
        {
            auto closed=std::make_unique<BuiltInCoupledBody>();closed->prepare(rate,true);closed->configure(1,8);
            network->process(0,1,1);closed->process(0,1,0);
            for(int i=0;i<12000;++i){network->process(0,0,1);closed->process(0,0,0);}
            transfer=transfer&&closed->energy(0)<network->energy(0);
        }
        const auto a=render(piano,rate,127,1,1,false),b=render(piano,rate,511,1,1,false),dry=render(piano,rate,127,0,1,false),stopped=render(piano,rate,127,1,2,true);
        double changed=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)
        {
            partition=juce::jmax(partition,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));
            changed=juce::jmax(changed,std::abs(static_cast<double>(a.getSample(ch,i)-dry.getSample(ch,i))));
            finite=finite&&std::isfinite(a.getSample(ch,i));
            if(ch==1&&i>juce::roundToInt(rate*.03))ownership=ownership&&a.getSample(ch,i)==0;
            if(i>juce::roundToInt(rate*.26))ownership=ownership&&stopped.getSample(ch,i)==0;
        }
        influenced=influenced&&changed>1e-5;
        auto* row=new juce::DynamicObject();row->setProperty("piano",piano);row->setProperty("sampleRate",rate);row->setProperty("audioInfluence",changed);cases.add(row);
    }
    const auto checkState=[&](auto& processor)
    {
        for(const auto& control:processor.coupledBodyControls)state=state&&setFreePluginParamForRegression(processor,control.id,control.maximum);
        juce::MemoryBlock bytes,again;processor.getStateInformation(bytes);processor.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));processor.getStateInformation(again);state=state&&bytes==again;
        auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());for(const auto& control:processor.coupledBodyControls)tree.removeProperty(control.id,nullptr);
        juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);processor.setStateInformation(old.getData(),static_cast<int>(old.getSize()));
        for(const auto& control:processor.coupledBodyControls)state=state&&(processor.*control.member).load()==control.initial;
    };
    auto piano=std::make_unique<OpenStudioPianoInstrument>();auto guitar=std::make_unique<OpenStudioCleanGuitarInstrument>();checkState(*piano);checkState(*guitar);
    result->setProperty("plugin","Original secondary coupled string/body networks");result->setProperty("cases",cases);
    result->setProperty("unforcedEnergyContract",passive);result->setProperty("maximumEnergyGrowth",maximumEnergyGrowth);result->setProperty("mutualTransferAndDamperLoss",transfer);
    result->setProperty("finite",finite);result->setProperty("channelPanIsolationAndPanic",ownership);result->setProperty("stateAndOldDefaults",state);result->setProperty("audioInfluence",influenced);result->setProperty("partitionError",partition);
    result->setProperty("pianoSchema",describeFreePluginForRegression(*piano));result->setProperty("guitarSchema",describeFreePluginForRegression(*guitar));
    result->setProperty("physicalCalibration","not_asserted");result->setProperty("audioQuality","not_asserted");
    result->setProperty("pass",passive&&transfer&&finite&&ownership&&state&&influenced&&partition==0);return result;
}
