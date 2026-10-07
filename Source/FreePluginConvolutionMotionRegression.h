#pragma once

inline juce::var checkConvolutionMotion()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Convolution wet-return modulation");
    bool bypass=true,finite=true,reset=true,dry=true,integration=true;double partition=0,analyticError=0,motionEnergy=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int blockSize,float depth)
    {
        BuiltInConvolutionMotion motion;motion.prepare(rate);motion.configure(depth,.3f);
        const int length=juce::roundToInt(rate*.6);juce::AudioBuffer<float> output(2,length),block(2,blockSize);
        for(int start=0;start<length;start+=blockSize)
        {
            const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);
            for(int i=0;i<count;++i)for(int ch=0;ch<2;++ch)block.setSample(ch,i,static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*997*(start+i)/rate)));
            motion.process(block);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);
        }
        return output;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto off=render(rate,127,0),on=render(rate,127,3),other=render(rate,511,3);double localError=0,energy=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<on.getNumSamples();++i)
        {
            const float original=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*997*i/rate));bypass=bypass&&off.getSample(ch,i)==original;
            const double sample=on.getSample(ch,i);finite=finite&&std::isfinite(sample)&&std::abs(sample)<=.100001;partition=juce::jmax(partition,std::abs(sample-other.getSample(ch,i)));
            if(i>rate*.1)
            {
                const double delay=.003*.5*(1+std::sin(juce::MathConstants<double>::twoPi*(static_cast<double>(.3f)*i/rate+ch*.25)));
                const double expected=.1*std::sin(juce::MathConstants<double>::twoPi*997*(i/rate-delay));localError=juce::jmax(localError,std::abs(sample-expected));
                const double difference=sample-off.getSample(ch,i);energy+=difference*difference;
            }
        }
        analyticError=juce::jmax(analyticError,localError);motionEnergy+=energy;integration=integration&&energy>1;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("analyticDelayError",localError);row->setProperty("changedOutputEnergy",energy);cases.add(row);
    }
    BuiltInConvolutionMotion empty;empty.prepare(48000);empty.configure(5,5);juce::AudioBuffer<float> silence(2,512);silence.clear();empty.process(silence);empty.reset();empty.configure(5,5);empty.process(silence);reset=silence.getMagnitude(0,512)==0&&!empty.isDraining();
    const auto hosted=[](int channels,float depth,bool dryOnly)
    {
        auto reverb=std::make_unique<OpenStudioReverb>(true);reverb->selectAlgorithm(7);reverb->irModDepth.store(depth);reverb->wetLevel.store(dryOnly?0.0f:1.0f);reverb->dryLevel.store(dryOnly?1.0f:0.0f);reverb->prepareToPlay(48000,127);
        juce::AudioBuffer<float> output(channels,28800),block(channels,127);juce::MidiBuffer midi;
        for(int start=0;start<output.getNumSamples();start+=127){const int count=juce::jmin(127,output.getNumSamples()-start);block.setSize(channels,count,false,false,true);for(int ch=0;ch<channels;++ch)for(int i=0;i<count;++i)block.setSample(ch,i,static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*997*(start+i)/48000)));reverb->processBlock(block,midi);for(int ch=0;ch<channels;++ch)output.copyFrom(ch,start,block,ch,0,count);}
        return output;
    };
    for(int channels:{1,2})for(bool dryOnly:{false,true})
    {
        const auto off=hosted(channels,0,dryOnly),on=hosted(channels,3,dryOnly);double energy=0;
        for(int ch=0;ch<channels;++ch)for(int i=0;i<on.getNumSamples();++i){const double difference=on.getSample(ch,i)-off.getSample(ch,i);energy+=difference*difference;finite=finite&&std::isfinite(on.getSample(ch,i));}
        if(dryOnly)dry=dry&&energy==0;else integration=integration&&energy>1e-7;
    }
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);
    const bool setters=setFreePluginParamForRegression(*source,"irModDepth",4)&&setFreePluginParamForRegression(*source,"irModRate",2);juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);bool recall=state==again&&copy->irModDepth.load()==4&&copy->irModRate.load()==2;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());tree.removeProperty("irModDepth",nullptr);tree.removeProperty("irModRate",nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->irModDepth.load()==0&&copy->irModRate.load()==.3f;
    const auto schema=describeFreePluginForRegression(*source);const bool appended=schema["parameters"].size()>=518&&schema["parameters"][516]["id"].toString()=="irModDepth"&&schema["parameters"][517]["id"].toString()=="irModRate";
    result->setProperty("pass",bypass&&finite&&reset&&dry&&integration&&setters&&recall&&appended&&partition==0&&analyticError<.001);result->setProperty("zeroDepthExact",bypass);result->setProperty("dryMonoStereoExact",dry);result->setProperty("hostedWetMotion",integration);result->setProperty("finite",finite);result->setProperty("resetSilence",reset);result->setProperty("partitionError",partition);result->setProperty("analyticDelayError",analyticError);result->setProperty("motionEnergy",motionEnergy);result->setProperty("stateLegacyDefaults",recall);result->setProperty("setters",setters);result->setProperty("appendedDescriptors",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
