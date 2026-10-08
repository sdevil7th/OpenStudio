#pragma once
inline juce::var checkNonlinearHold()
{
    juce::ScopedNoDenormals noDenormals;
    struct Render{juce::AudioBuffer<float> audio;bool suspended=false;};
    const auto render=[](double rate,int block,float late,bool hold,bool infinite,bool extra,bool edited,bool retire=false)
    {
        BuiltInAdditionalReverbs engine;engine.prepare(rate,6);BuiltInAdditionalReverbs::Settings settings{.3f,.5f,.6f,.5f,40,20,20000,0,1};
        settings.nonlinearFeedback=.2f;settings.nonlinearModulation=.7f;settings.nonlinearRate=2;settings.nonlinearDiffusion=.5f;settings.lateLevel=late;settings.lateDecay=.5f;
        const int count=static_cast<int>(rate*4.5),holdAt=static_cast<int>(rate*.2),editAt=static_cast<int>(rate*1.2),releaseAt=static_cast<int>(rate*3);
        Render result;result.audio.setSize(2,count);
        for(int start=0;start<count;)
        {
            int end=juce::jmin(count,start+block);for(int edge:{holdAt,editAt,releaseAt})if(start<edge)end=juce::jmin(end,edge);
            settings.nonlinearHold=hold&&start>=holdAt&&start<releaseAt;settings.infiniteInput=infinite;
            if(edited&&start>=editAt){settings.decay=1.1f;settings.shape=7;}
            engine.configure(retire&&start>=releaseAt?-1:6,settings,retire);
            for(int i=start;i<end;++i){const float source=i<static_cast<int>(rate*.08)?static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*997*i/rate))
                :extra&&i>=editAt&&i<editAt+static_cast<int>(rate*.1)?static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*701*i/rate)):0;
                const auto y=engine.process(source,source*.3f);for(int ch=0;ch<2;++ch)result.audio.setSample(ch,i,y[static_cast<size_t>(ch)]);}
            start=end;
        }
        if(retire){for(int i=0;i<static_cast<int>(rate*8);++i)engine.process(0,0);result.suspended=engine.isDormant();}
        return result;
    };
    const auto energy=[](const auto& audio,double rate,double from,double to){double value=0;for(int ch=0;ch<2;++ch)for(int i=static_cast<int>(rate*from);i<static_cast<int>(rate*to);++i)value+=std::pow(audio.getSample(ch,i),2);return value;};
    bool sustain=true,infinite=true,release=true,finite=true;double partition=0,geometry=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(float late:{0.0f,1.0f})
    {
        const auto held=render(rate,127,late,true,false,false,false),extra=render(rate,511,late,true,false,true,false),added=render(rate,127,late,true,true,true,false),normal=render(rate,127,late,false,false,false,false);
        const double first=energy(held.audio,rate,.6,1.5),end=energy(held.audio,rate,1.8,2.7),base=energy(normal.audio,rate,1.8,2.7),accumulated=energy(added.audio,rate,1.8,2.7),drained=energy(held.audio,rate,4,4.5);
        sustain=sustain&&end>1e-10&&end>first*.75&&end<first*1.3&&end>base*100;infinite=infinite&&accumulated>end*1.2;release=release&&drained<end*.01;
        for(int ch=0;ch<2;++ch)for(int i=0;i<held.audio.getNumSamples();++i){partition=juce::jmax(partition,std::abs(static_cast<double>(held.audio.getSample(ch,i)-extra.audio.getSample(ch,i))));finite=finite&&std::isfinite(added.audio.getSample(ch,i))&&std::abs(added.audio.getSample(ch,i))<=4.1f;}
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("lateLevel",late);row->setProperty("heldEnergyRatio",end/first);row->setProperty("addedEnergyRatio",accumulated/end);row->setProperty("releaseEnergyRatio",drained/end);cases.add(row);
    }
    const auto baseline=render(48000,127,1,true,false,false,false),edited=render(48000,511,1,true,false,false,true),retired=render(48000,127,1,true,true,true,false,true);
    for(int ch=0;ch<2;++ch)for(int i=0;i<144000;++i)geometry=juce::jmax(geometry,std::abs(static_cast<double>(baseline.audio.getSample(ch,i)-edited.audio.getSample(ch,i))));
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);source->algorithm.store(6);source->nonlinearHold.store(1);source->holdInputModes[6].store(1);
    juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);
    bool recall=state==again&&copy->nonlinearHold.load()==1&&copy->holdInputModes[6].load()==1&&copy->getTailLengthSeconds()>=120;
    juce::ValueTree legacy("OpenStudioReverb");legacy.setProperty("algorithm",6,nullptr);legacy.setProperty("freezeMode",1,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);legacy.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->nonlinearHold.load()==0;
    const auto schema=describeFreePluginForRegression(*source);const auto* parameters=schema["parameters"].getArray();recall=recall&&parameters&&parameters->size()>1081&&(*parameters)[1081]["id"].toString()=="nonlinearHold"&&setFreePluginParamForRegression(*source,"nonlinearHold",0)&&source->nonlinearHold.load()==0;
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Nonlinear early-pattern and late-network Hold");result->setProperty("cases",cases);result->setProperty("sustainedEnergy",sustain);result->setProperty("freezeAndPartitionError",partition);result->setProperty("infiniteAccumulates",infinite);result->setProperty("releaseDecays",release);result->setProperty("retirementSuspends",retired.suspended);result->setProperty("heldEnvelopeDurationError",geometry);result->setProperty("stateDefaultsTailAndAppend",recall);result->setProperty("finite",finite);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");result->setProperty("pass",sustain&&partition==0&&infinite&&release&&retired.suspended&&geometry==0&&recall&&finite);return result;
}
