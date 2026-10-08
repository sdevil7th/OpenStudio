#pragma once
inline juce::var checkExpandedSynthMatrix()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Eight synth routes and four macros");
    bool transitions=true,mapping=true,finite=true,effect=true,recall=true,legacy=true;double partition=0;juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        // A repeated target must not restart a ramp; rapid reversal must
        // settle on the original selector with one final transition frame.
        BuiltInSynthMatrix switching;std::array<float,11> initial{};switching.prepare(rate,initial);
        transitions=transitions&&!switching.next().routes[0].transitioning;
        auto changed=initial;changed[2]=12;changed[3]=7;switching.setTargets(changed);
        const int ramp=static_cast<int>(rate*.02);
        for(int sample=0;sample<ramp;++sample)
        {
            if(sample==ramp/2)switching.setTargets(changed);
            const auto frame=switching.next();transitions=transitions&&frame.routes[0].transitioning;
            if(sample==ramp-1)transitions=transitions&&frame.routes[0].sources[12]==1&&frame.routes[0].targets[7]==1;
        }
        transitions=transitions&&!switching.next().routes[0].transitioning;
        switching.setTargets(initial);switching.next();switching.setTargets(changed);
        for(int sample=0;sample<ramp;++sample)switching.next();
        const auto settled=switching.next();transitions=transitions&&!settled.routes[0].transitioning&&settled.routes[0].source==12&&settled.routes[0].target==7;
        // Every appended route, source and destination uses the same bounded sum.
        for(size_t slot=0;slot<8;++slot)for(int source=9;source<=12;++source)for(int target=0;target<8;++target)
        {
            BuiltInSynthMatrix matrix;std::array<float,11> original{};std::array<float,19> extended{};
            if(slot<3){original[2+slot*3]=static_cast<float>(source);original[3+slot*3]=static_cast<float>(target);original[4+slot*3]=-.75f;}
            else{extended[(slot-3)*3]=static_cast<float>(source);extended[1+(slot-3)*3]=static_cast<float>(target);extended[2+(slot-3)*3]=-.75f;}
            extended[15+static_cast<size_t>(source-9)]=.8f;matrix.prepare(rate,original);matrix.setExtendedTargets(extended,true);const auto frame=matrix.next();
            const auto routed=BuiltInSynthMatrix::applyExtended(frame,{0,0,0,0,0,0,0,0,0,frame.macros[0],frame.macros[1],frame.macros[2],frame.macros[3]});
            for(size_t i=0;i<routed.size();++i)mapping=mapping&&std::abs(routed[i]-(static_cast<int>(i)==target?-.6f:0))<1e-6;
        }
        const auto render=[rate](int blockSize,int target,bool active)
        {
            OpenStudioBasicSynthInstrument synth;synth.filterMode.store(1);synth.filterCutoff.store(1400);synth.filterQ.store(1.1f);synth.matrix8Source.store(active?12.0f:0.0f);synth.matrix8Target.store(static_cast<float>(target));synth.matrix8Amount.store(.6f);synth.macro4.store(.7f);synth.prepareToPlay(rate,blockSize);
            const int length=static_cast<int>(rate*.2),change=static_cast<int>(rate*.08);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
            for(int start=0;start<length;){int count=juce::jmin(blockSize,length-start);if(start<change)count=juce::jmin(count,change-start);else if(start==change)synth.macro4.store(.25f);block.setSize(2,count,false,false,true);midi.clear();if(start==0)midi.addEvent(juce::MidiMessage::noteOn(1,60,.7f),0);synth.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;}return output;
        };
        const auto base=render(127,0,false);
        for(int target=0;target<8;++target)
        {
            const auto a=render(127,target,true),b=render(511,target,true);double difference=0;
            for(int i=0;i<a.getNumSamples();++i){const double value=a.getSample(0,i);finite=finite&&std::isfinite(value)&&std::abs(value)<2.5;partition=juce::jmax(partition,std::abs(value-b.getSample(0,i)));difference+=std::abs(value-base.getSample(0,i));}
            effect=effect&&difference>.01;auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("destination",target);row->setProperty("absoluteAudioDifference",difference);cases.add(row);
        }
    }
    OpenStudioBasicSynthInstrument original,copy;
    for(int slot=1;slot<=3;++slot)
    {
        const auto prefix="matrix"+juce::String(slot);
        for(int source=0;source<=8;++source)legacy=legacy&&setFreePluginNormalizedForRegression(original,prefix+"Source",static_cast<float>(source)/8)&&original.matrixValues()[static_cast<size_t>(2+(slot-1)*3)]==source;
        for(int target=0;target<=3;++target)legacy=legacy&&setFreePluginNormalizedForRegression(original,prefix+"Target",static_cast<float>(target)/3)&&original.matrixValues()[static_cast<size_t>(3+(slot-1)*3)]==target;
        for(int source=0;source<=12;++source)mapping=mapping&&setFreePluginNormalizedForRegression(original,prefix+"SourceExpanded",static_cast<float>(source)/12)&&original.matrixValues()[static_cast<size_t>(2+(slot-1)*3)]==source;
        for(int target=0;target<=7;++target)mapping=mapping&&setFreePluginNormalizedForRegression(original,prefix+"TargetExpanded",static_cast<float>(target)/7)&&original.matrixValues()[static_cast<size_t>(3+(slot-1)*3)]==target;
    }
    for(size_t i=35;i<OpenStudioBasicSynthInstrument::modulationControls.size();++i){const auto& control=OpenStudioBasicSynthInstrument::modulationControls[i];mapping=mapping&&setFreePluginParamForRegression(original,control.id,control.maximum);}
    juce::MemoryBlock state,again;original.getStateInformation(state);copy.setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy.getStateInformation(again);recall=state==again&&original.matrixValues()==copy.matrixValues()&&original.extendedMatrixValues()==copy.extendedMatrixValues();
    auto tree=juce::ValueTree::readFromData(state.getData(),static_cast<int>(state.getSize()));for(size_t i=35;i<OpenStudioBasicSynthInstrument::modulationControls.size();++i)tree.removeProperty(OpenStudioBasicSynthInstrument::modulationControls[i].id,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy.setStateInformation(old.getData(),static_cast<int>(old.getSize()));for(float value:copy.extendedMatrixValues())legacy=legacy&&value==0;
    const auto schema=describeFreePluginForRegression(original);const bool descriptors=schema["parameters"].size() >= 70&&schema["parameters"][43]["id"].toString()=="oscillatorAShape"&&schema["parameters"][45]["id"].toString()=="matrix4Source"&&schema["parameters"][64]["id"].toString()=="matrix1SourceExpanded";
    result->setProperty("pass",transitions&&mapping&&finite&&effect&&recall&&legacy&&descriptors&&partition==0);result->setProperty("selectorTransitionBoundaries",transitions);result->setProperty("allRouteSourceDestinationMappings",mapping);result->setProperty("finite",finite);result->setProperty("allDestinationsChangeAudio",effect);result->setProperty("partitionErrorIncludingMacroChange",partition);result->setProperty("stateRoundTrip",recall);result->setProperty("legacyNormalizedRangesAndDefaults",legacy);result->setProperty("appendedDescriptors",descriptors);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
