#pragma once
inline juce::var checkSynthOscillatorShapes()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Independent synthesized oscillator shapes");
    bool bounded=true,shapes=true,recall=true;double maximumMean=0,partition=0;juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(int shape=0;shape<4;++shape)
        {
            double mean=0,re=0,im=0;constexpr int count=128;for(int i=0;i<count;++i){const float value=BuiltInSynthOscillators::wave(shape,static_cast<float>(i)/count,1.0f/count);bounded=bounded&&std::isfinite(value)&&std::abs(value)<=1.00001;mean+=value;re+=value*std::cos(juce::MathConstants<double>::twoPi*i/count);im+=value*std::sin(juce::MathConstants<double>::twoPi*i/count);}
            const double fundamental=2*std::hypot(re,im)/count,expected=shape==0?2/juce::MathConstants<double>::pi:shape==1?4/juce::MathConstants<double>::pi:shape==2?8/(juce::MathConstants<double>::pi*juce::MathConstants<double>::pi):1;
            maximumMean=juce::jmax(maximumMean,std::abs(mean/count));shapes=shapes&&std::abs(fundamental-expected)<.001;
            auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("shape",shape);row->setProperty("fundamental",fundamental);row->setProperty("periodSamples",count);cases.add(row);
        }
        const auto render=[rate](int blockSize,int shape)
        {
            OpenStudioBasicSynthInstrument synth;synth.oscillatorAShape.store(static_cast<float>(shape));synth.oscillatorBShape.store(static_cast<float>(3-shape));synth.subLevel.store(0);synth.noiseLevel.store(0);synth.prepareToPlay(rate,blockSize);
            const int length=static_cast<int>(rate*.25),change=static_cast<int>(rate*.1);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
            for(int start=0;start<length;){int count=juce::jmin(blockSize,length-start);if(start<change)count=juce::jmin(count,change-start);else if(start==change){synth.oscillatorAShape.store(static_cast<float>((shape+1)%4));synth.oscillatorBShape.store(static_cast<float>(shape));}block.setSize(2,count,false,false,true);midi.clear();if(start==0)midi.addEvent(juce::MidiMessage::noteOn(1,60,.7f),0);synth.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;}return output;
        };
        double difference=0;const auto base=render(127,0);
        for(int shape=0;shape<4;++shape){const auto a=render(127,shape),b=render(511,shape);for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double value=a.getSample(ch,i);bounded=bounded&&std::isfinite(value)&&std::abs(value)<2.5;partition=juce::jmax(partition,std::abs(value-b.getSample(ch,i)));if(shape>0)difference+=std::abs(value-base.getSample(ch,i));}}shapes=shapes&&difference>1;
    }
    OpenStudioBasicSynthInstrument original,copy;const bool setters=setFreePluginParamForRegression(original,"oscillatorAShape",2)&&setFreePluginParamForRegression(original,"oscillatorBShape",3);juce::MemoryBlock state,again;original.getStateInformation(state);copy.setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy.getStateInformation(again);recall=state==again&&copy.oscillatorAShape.load()==2&&copy.oscillatorBShape.load()==3;
    auto tree=juce::ValueTree::readFromData(state.getData(),static_cast<int>(state.getSize()));tree.removeProperty("oscillatorAShape",nullptr);tree.removeProperty("oscillatorBShape",nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy.setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy.oscillatorAShape.load()==0&&copy.oscillatorBShape.load()==1;
    const auto schema=describeFreePluginForRegression(original);const bool appended=schema["parameters"].size()>=45&&schema["parameters"][43]["id"].toString()=="oscillatorAShape"&&schema["parameters"][44]["id"].toString()=="oscillatorBShape";
    result->setProperty("pass",bounded&&shapes&&recall&&setters&&appended&&maximumMean<1e-6&&partition==0);result->setProperty("bounded",bounded);result->setProperty("waveformAndAudiblePath",shapes);result->setProperty("maximumMean",maximumMean);result->setProperty("partitionErrorIncludingShapeChanges",partition);result->setProperty("stateAndLegacyDefaults",recall);result->setProperty("setters",setters);result->setProperty("appendedDescriptors",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("aliasQuality","not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}
