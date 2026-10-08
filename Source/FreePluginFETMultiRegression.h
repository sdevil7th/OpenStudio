#pragma once

inline juce::var checkFETMultiButtons()
{
    auto* result=new juce::DynamicObject();bool finite=true,distinct=true,state=true,oldLane=true;double partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int mode,int blockSize)
    {
        auto processor=std::make_unique<OpenStudioCompressor>(true);processor->selectModel(2);processor->fetRatio.store(static_cast<float>(mode));processor->fetInput.store(6);processor->fetOutput.store(-6);processor->fetRecovery.store(.7f);processor->prepareToPlay(rate,blockSize);
        const int length=juce::roundToInt(rate*.32);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<length;start+=blockSize){const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);
            for(int i=0;i<count;++i){const double time=(start+i)/rate;const float x=static_cast<float>((time<.08||time>.18?.6:.06)*std::sin(juce::MathConstants<double>::twoPi*173*time));block.setSample(0,i,x);block.setSample(1,i,x*.7f);}processor->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);}return output;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        std::vector<juce::AudioBuffer<float>> renders;
        for(int mode=0;mode<11;++mode){const auto a=render(rate,mode,127),b=render(rate,mode,511);double energy=0;
            for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double x=a.getSample(ch,i);finite=finite&&std::isfinite(x)&&std::abs(x)<2;energy+=x*x;partition=juce::jmax(partition,std::abs(x-b.getSample(ch,i)));}
            finite=finite&&energy>1e-6;for(const auto& previous:renders){double difference=0;for(int i=0;i<a.getNumSamples();++i)difference+=std::abs(a.getSample(0,i)-previous.getSample(0,i));distinct=distinct&&difference>1e-4;}
            juce::AudioBuffer<float> saved;saved.makeCopyOf(a);renders.push_back(std::move(saved));auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("mode",mode);row->setProperty("energy",energy);cases.add(row);}
    }
    auto source=std::make_unique<OpenStudioCompressor>(true),copy=std::make_unique<OpenStudioCompressor>(true);source->selectModel(2);
    for(int mode=0;mode<11;++mode){state=state&&setFreePluginNormalizedForRegression(*source,"fetRatioExtended",static_cast<float>(mode)/10);juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);state=state&&bytes==again&&copy->fetRatio.load()==mode;}
    oldLane=setFreePluginNormalizedForRegression(*source,"fetRatio",1)&&source->fetRatio.load()==5;
    auto schema=describeFreePluginForRegression(*source);const auto params=schema["parameters"];oldLane=oldLane&&params[71]["id"].toString()=="fetRatioExtended"&&params[70]["id"].toString()=="fetTilt";
    for(const auto& parameter:*params.getArray())if(parameter["id"].toString()=="fetRatio")oldLane=oldLane&&static_cast<int>(parameter["max"])==5;
    juce::MemoryBlock bytes;source->getStateInformation(bytes);auto old=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());old.removeProperty("fetRatio",nullptr);bytes.reset();{juce::MemoryOutputStream stream(bytes,false);old.writeToStream(stream);}copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));oldLane=oldLane&&copy->fetRatio.load()==0;
    result->setProperty("plugin","Original FET adjacent-button profiles");result->setProperty("cases",cases);result->setProperty("finite",finite);result->setProperty("allModesDistinct",distinct);result->setProperty("partitionError",partition);result->setProperty("stateRoundTrips",state);result->setProperty("oldLaneAndDefaults",oldLane);result->setProperty("schema",schema);result->setProperty("hardwareFidelity","not_asserted");result->setProperty("pass",finite&&distinct&&partition==0&&state&&oldLane);return result;
}
