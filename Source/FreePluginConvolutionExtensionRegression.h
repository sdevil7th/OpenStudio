#pragma once
inline juce::var checkConvolutionExtension()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Three-band synthetic convolution tail enhancement");
    bool bypass=true,finite=true,extended=true,dry=true,integration=true,recall=true;double partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int blockSize,float amount,float decay,int band)
    {
        BuiltInConvolutionExtension extension;extension.prepare(rate);std::array<float,6> settings{amount,.15f,.15f,.15f,250,4000};if(band>=0)settings[static_cast<size_t>(band+1)]=decay;extension.configure(settings);
        const int length=juce::roundToInt(rate*1.2);juce::AudioBuffer<float> output(2,length),block(2,blockSize);
        for(int start=0;start<length;start+=blockSize)
        {
            const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);
            for(int i=0;i<count;++i)for(int ch=0;ch<2;++ch)block.setSample(ch,i,start+i<rate*.02?static_cast<float>(.08*std::sin((start+i)*.317+ch*.51)+.07*std::sin((start+i)*.031)):0);
            extension.process(block);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);
        }return output;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto off=render(rate,127,0,2,0),shortTail=render(rate,127,1,.15f,0);
        for(int ch=0;ch<2;++ch)for(int i=0;i<off.getNumSamples();++i){const float input=i<rate*.02?static_cast<float>(.08*std::sin(i*.317+ch*.51)+.07*std::sin(i*.031)):0;bypass=bypass&&off.getSample(ch,i)==input;}
        for(int band=0;band<3;++band)
        {
            const auto a=render(rate,127,1,2,band),b=render(rate,511,1,2,band);double late=0,shortLate=0;
            for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double value=a.getSample(ch,i);finite=finite&&std::isfinite(value)&&std::abs(value)<2.5;partition=juce::jmax(partition,std::abs(value-b.getSample(ch,i)));if(i>rate*.5){late+=value*value;const double other=shortTail.getSample(ch,i);shortLate+=other*other;}}
            extended=extended&&late>1e-10&&late>shortLate*10;auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("band",band);row->setProperty("lateEnergy",late);row->setProperty("shortDecayLateEnergy",shortLate);row->setProperty("rt60Calibration","diagnostic_only; not measured by this check");cases.add(row);
        }
    }
    BuiltInConvolutionExtension reset;reset.prepare(48000);reset.configure({1,20,20,20,250,4000});juce::AudioBuffer<float> silence(2,512);silence.clear();reset.process(silence);reset.reset();reset.configure({1,20,20,20,250,4000});reset.process(silence);const bool cleared=silence.getMagnitude(0,512)==0&&!reset.isDraining();
    const auto hosted=[](int channels,float amount,bool dryOnly,float width=1)
    {
        auto reverb=std::make_unique<OpenStudioReverb>(true);reverb->selectAlgorithm(7);reverb->irExtensionControls[0].store(amount);reverb->width.store(width);reverb->wetLevel.store(dryOnly?0.0f:1.0f);reverb->dryLevel.store(dryOnly?1.0f:0.0f);reverb->prepareToPlay(48000,127);
        juce::AudioBuffer<float> output(channels,24000),block(channels,127);juce::MidiBuffer midi;
        for(int start=0;start<output.getNumSamples();start+=127){const int count=juce::jmin(127,output.getNumSamples()-start);block.setSize(channels,count,false,false,true);for(int ch=0;ch<channels;++ch)for(int i=0;i<count;++i)block.setSample(ch,i,start+i<4800?static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*997*(start+i)/48000)):0);reverb->processBlock(block,midi);for(int ch=0;ch<channels;++ch)output.copyFrom(ch,start,block,ch,0,count);}return output;
    };
    for(int channels:{1,2})for(bool dryOnly:{false,true})
    {
        const auto off=hosted(channels,0,dryOnly),on=hosted(channels,1,dryOnly);double energy=0;for(int ch=0;ch<channels;++ch)for(int i=0;i<on.getNumSamples();++i){const double delta=on.getSample(ch,i)-off.getSample(ch,i);energy+=delta*delta;finite=finite&&std::isfinite(on.getSample(ch,i));}if(dryOnly)dry=dry&&energy==0;else integration=integration&&energy>1e-9;
    }
    const auto monoWidth=hosted(2,1,false,0);bool widthPreserved=true;for(int i=0;i<monoWidth.getNumSamples();++i)widthPreserved=widthPreserved&&monoWidth.getSample(0,i)==monoWidth.getSample(1,i);
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);bool setters=true;const std::array<float,6> values{1,3,4,5,350,6000};for(size_t i=0;i<values.size();++i)setters=setters&&setFreePluginParamForRegression(*source,"irExtension"+juce::String(static_cast<int>(i)),values[i]);
    source->selectAlgorithm(7);const bool tail=source->getTailLengthSeconds()>=11;juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);recall=state==again;for(size_t i=0;i<values.size();++i)recall=recall&&copy->irExtensionControls[i].load()==values[i];
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(int i=0;i<6;++i)tree.removeProperty("irExtension"+juce::String(i),nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));const std::array<float,6> defaults{0,2,2,2,250,4000};for(size_t i=0;i<defaults.size();++i)recall=recall&&copy->irExtensionControls[i].load()==defaults[i];
    const auto schema=describeFreePluginForRegression(*source);const bool appended=schema["parameters"].size()>=527&&schema["parameters"][521]["id"].toString()=="irExtension0"&&schema["parameters"][526]["id"].toString()=="irExtension5";
    result->setProperty("pass",bypass&&finite&&extended&&dry&&widthPreserved&&integration&&cleared&&setters&&recall&&tail&&appended&&partition==0);result->setProperty("zeroAmountExact",bypass);result->setProperty("finite",finite);result->setProperty("allBandsExtendTail",extended);result->setProperty("partitionError",partition);result->setProperty("dryMonoStereoExact",dry);result->setProperty("hostedWetPath",integration);result->setProperty("zeroWidthMono",widthPreserved);result->setProperty("resetSilence",cleared);result->setProperty("stateAndOldDefaults",recall);result->setProperty("setters",setters);result->setProperty("hostTailBound",tail);result->setProperty("appendedDescriptors",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
