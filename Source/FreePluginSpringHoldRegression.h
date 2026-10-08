#pragma once
inline juce::var checkSpringHold()
{
    juce::ScopedNoDenormals noDenormals;
    struct Render { juce::AudioBuffer<float> audio; bool suspended=false; };
    const auto render=[](double rate,int block,bool hold,bool infinite,bool newInput,bool edits,bool retire=false)
    {
        BuiltInSpringReverb engine;engine.prepare(rate);BuiltInSpringReverb::Settings settings;
        settings.decay=.8f;settings.motion=.7f;settings.damping=.7f;settings.predelay=50;
        const int count=static_cast<int>(rate*4.5),holdAt=static_cast<int>(rate*.2),editAt=static_cast<int>(rate*1.2),releaseAt=static_cast<int>(rate*3);
        Render result;result.audio.setSize(2,count);
        for(int start=0;start<count;)
        {
            int end=juce::jmin(count,start+block);
            for(int edge:{holdAt,editAt,releaseAt})if(start<edge)end=juce::jmin(end,edge);
            settings.hold=hold&&start>=holdAt&&start<releaseAt;settings.acceptsInput=infinite;
            if(edits&&start>=editAt){settings.tension=.9f;settings.dispersion=.1f;settings.count=3;}
            engine.configure(!retire||start<releaseAt,settings,retire);
            for(int i=start;i<end;++i)
            {
                const float input=i<static_cast<int>(rate*.03)?static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*997*i/rate))
                    :newInput&&i>=editAt&&i<editAt+static_cast<int>(rate*.1)?static_cast<float>(.12*std::sin(juce::MathConstants<double>::twoPi*701*i/rate)):0;
                const auto y=engine.process(input,input*.4f);for(int ch=0;ch<2;++ch)result.audio.setSample(ch,i,y[static_cast<size_t>(ch)]);
            }
            start=end;
        }
        if(retire){engine.configure(false,settings,true);for(int i=0;i<static_cast<int>(rate*3);++i)engine.process(0,0);}
        result.suspended=engine.isSuspended();return result;
    };
    const auto energy=[](const auto& audio,double rate,double from,double to){double e=0;for(int ch=0;ch<2;++ch)for(int i=static_cast<int>(rate*from);i<static_cast<int>(rate*to);++i)e+=std::pow(audio.getSample(ch,i),2);return e;};
    bool sustain=true,freeze=true,infinite=true,release=true,finite=true;double partition=0,geometry=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto held=render(rate,127,true,false,false,false),extra=render(rate,511,true,false,true,false),accumulated=render(rate,127,true,true,true,false),decay=render(rate,127,false,false,false,false);
        const double first=energy(held.audio,rate,.7,1.7),late=energy(held.audio,rate,1.9,2.9),normal=energy(decay.audio,rate,1.9,2.9),added=energy(accumulated.audio,rate,1.9,2.9),drained=energy(held.audio,rate,4,4.5);
        sustain=sustain&&late>1e-10&&late>first*.65&&late<first*1.4&&late>normal*100;
        infinite=infinite&&added>late*1.2;release=release&&drained<late*.01;
        for(int ch=0;ch<2;++ch)for(int i=0;i<held.audio.getNumSamples();++i){partition=juce::jmax(partition,std::abs(static_cast<double>(held.audio.getSample(ch,i)-extra.audio.getSample(ch,i))));finite=finite&&std::isfinite(accumulated.audio.getSample(ch,i));}
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("heldEnergyRatio",late/first);item->setProperty("heldVersusDecayingEnergy",late/juce::jmax(1e-30,normal));item->setProperty("infiniteAddedEnergyRatio",added/late);item->setProperty("releasedEnergyRatio",drained/late);cases.add(item);
    }
    freeze=partition==0;
    const auto baseline=render(48000,127,true,false,false,false),edited=render(48000,511,true,false,false,true),retired=render(48000,127,true,true,true,false,true);
    for(int ch=0;ch<2;++ch)for(int i=0;i<144000;++i)geometry=juce::jmax(geometry,std::abs(static_cast<double>(baseline.audio.getSample(ch,i)-edited.audio.getSample(ch,i))));
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);
    source->algorithm.store(4);source->springControls[0].store(1);source->springHold.store(1);source->holdInputModes[4].store(1);
    juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);
    bool recall=state==again&&copy->springHold.load()==1&&copy->holdInputModes[4].load()==1&&copy->getTailLengthSeconds()>=120;
    juce::ValueTree legacy("OpenStudioReverb");legacy.setProperty("algorithm",4,nullptr);legacy.setProperty("freezeMode",1,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);legacy.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->springHold.load()==0;
    const auto schema=describeFreePluginForRegression(*source);const auto* parameters=schema["parameters"].getArray();recall=recall&&parameters&&parameters->size()>1079&&(*parameters)[1079]["id"].toString()=="springHold"&&setFreePluginParamForRegression(*source,"springHold",0)&&source->springHold.load()==0;
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Dispersive Spring Freeze and Infinite");result->setProperty("cases",cases);result->setProperty("sustainedEnergy",sustain);result->setProperty("freezeExcludesNewInputAndExactPartition",freeze);result->setProperty("infiniteAccumulatesInput",infinite);result->setProperty("releaseDecays",release);result->setProperty("retirementSuspends",retired.suspended);result->setProperty("heldGeometryError",geometry);result->setProperty("stateDefaultsTailAndAppend",recall);result->setProperty("finite",finite);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");result->setProperty("pass",sustain&&freeze&&infinite&&release&&retired.suspended&&geometry==0&&recall&&finite);return result;
}
