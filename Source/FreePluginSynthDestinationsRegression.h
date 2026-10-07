#pragma once

inline juce::var checkSynthDestinations()
{
    auto* result=new juce::DynamicObject();bool influence=true,finite=true,recall=true,legacy=true;double partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int target,int blockSize,bool shared=false)
    {
        auto synth=std::make_unique<OpenStudioBasicSynthInstrument>();synth->filterMode.store(1);synth->filterCutoff.store(1800);synth->filterEnvelope.store(2);synth->filterEnvelopeSource.store(1);synth->filterAttackMs.store(50);synth->filterDecayMs.store(90);synth->filterReleaseMs.store(90);synth->attackMs.store(40);synth->decayMs.store(80);synth->releaseMs.store(80);synth->sustain.store(.4f);synth->filterSustain.store(.4f);
        synth->lfoDestination.store(1);synth->lfoDepth.store(.4f);synth->lfoRate.store(3);synth->lfoMode.store(shared?1.0f:0.0f);synth->oscillatorAShape.store(1);synth->oscillatorBShape.store(1);
        synth->matrix8Source.store(target<0?0.0f:1.0f);synth->matrix8Target.store(static_cast<float>(juce::jmax(0,target)));synth->matrix8Amount.store(.6f);synth->prepareToPlay(rate,blockSize);
        const int length=juce::roundToInt(rate*.38),release=juce::roundToInt(rate*.19);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<length;){const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);midi.clear();if(start==0)midi.addEvent(juce::MidiMessage::noteOn(1,67,.7f),0);if(release>=start&&release<start+count)midi.addEvent(juce::MidiMessage::noteOff(1,67),release-start);synth->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;}return output;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto baseline=render(rate,-1,127);
        for(int target=8;target<28;++target)
        {
            const auto a=render(rate,target,127),b=render(rate,target,511);double difference=0,error=0;
            for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double sample=a.getSample(ch,i);finite=finite&&std::isfinite(sample)&&std::abs(sample)<=2.5;difference+=std::abs(sample-baseline.getSample(ch,i));error=juce::jmax(error,std::abs(sample-b.getSample(ch,i)));}
            partition=juce::jmax(partition,error);influence=influence&&difference>1e-4;auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("destination",target);row->setProperty("absoluteAudioDifference",difference);row->setProperty("partitionError",error);cases.add(row);
        }
        const auto shared=render(rate,20,127,true),sharedOther=render(rate,20,511,true),sharedBase=render(rate,-1,127,true);double sharedDifference=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<shared.getNumSamples();++i){sharedDifference+=std::abs(shared.getSample(ch,i)-sharedBase.getSample(ch,i));partition=juce::jmax(partition,std::abs(static_cast<double>(shared.getSample(ch,i)-sharedOther.getSample(ch,i))));}
        influence=influence&&sharedDifference>1e-4;
    }
    auto source=std::make_unique<OpenStudioBasicSynthInstrument>(),copy=std::make_unique<OpenStudioBasicSynthInstrument>();
    for(int slot=1;slot<=8;++slot)for(int destination=0;destination<28;++destination)
    {
        const auto id="matrix"+juce::String(slot)+"TargetFull";recall=recall&&setFreePluginNormalizedForRegression(*source,id,static_cast<float>(destination)/27);
        juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);recall=recall&&state==again;
    }
    for(int slot=1;slot<=8;++slot){const auto id="matrix"+juce::String(slot)+"Target";legacy=legacy&&setFreePluginNormalizedForRegression(*source,id,1);const auto schema=describeFreePluginForRegression(*source);for(const auto& parameter:*schema["parameters"].getArray())if(parameter["id"].toString()==id)legacy=legacy&&static_cast<int>(parameter["value"])==(slot<=3?3:7);}
    const auto schema=describeFreePluginForRegression(*source);const bool appended=schema["parameters"].size()==86&&schema["parameters"][78]["id"].toString()=="matrix1TargetFull"&&schema["parameters"][64]["id"].toString()=="matrix1SourceExpanded";
    result->setProperty("plugin","Expanded per-voice Synth destinations");result->setProperty("cases",cases);result->setProperty("allDestinationsChangeAudio",influence);result->setProperty("finite",finite);result->setProperty("partitionError",partition);result->setProperty("allRouteStateRoundTrips",recall);result->setProperty("legacyNormalizedRanges",legacy);result->setProperty("appendedDescriptors",appended);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");result->setProperty("pass",influence&&finite&&partition==0&&recall&&legacy&&appended);return result;
}
