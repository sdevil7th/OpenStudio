#pragma once
inline juce::var checkPositionedHold()
{
    juce::ScopedNoDenormals noDenormals;
    struct Render{juce::AudioBuffer<float> audio;bool suspended=false;double liveDryEnergy=0;};
    const auto render=[](double rate,int block,int spacing,bool hold,bool infinite,bool extra,bool edited,bool retire=false)
    {
        BuiltInEchoRoom engine;engine.prepare(rate,1);BuiltInEchoRoom::Settings settings;
        settings.size=.6f;settings.shape=static_cast<float>(spacing);settings.x=.35f;settings.y=.65f;settings.time=300;settings.feedback=.25f;settings.motion=.7f;settings.damping=.6f;settings.spacing=static_cast<float>(spacing);settings.predelay=20;
        const int count=static_cast<int>(rate*4.5),holdAt=static_cast<int>(rate*.06),editAt=static_cast<int>(rate*1.2),releaseAt=static_cast<int>(rate*3);
        Render result;result.audio.setSize(2,count);
        for(int start=0;start<count;)
        {
            int end=juce::jmin(count,start+block);for(int edge:{holdAt,editAt,releaseAt})if(start<edge)end=juce::jmin(end,edge);
            settings.hold=hold&&start>=holdAt&&start<releaseAt;settings.acceptsInput=infinite;
            if(edited&&start>=editAt){settings.size=.1f;settings.shape=2;settings.x=.9f;settings.y=.1f;settings.damping=.1f;}
            engine.configure(retire&&start>=releaseAt?0:1,settings,retire);
            for(int i=start;i<end;++i){const float source=i<static_cast<int>(rate*.025)?static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*997*i/rate))
                :extra&&i>=editAt&&i<editAt+static_cast<int>(rate*.1)?static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*701*i/rate)):0;
                const auto y=engine.process(source,source*.3f);if(i>=editAt&&i<releaseAt)result.liveDryEnergy+=y[3]*y[3]+y[4]*y[4];for(int ch=0;ch<2;++ch)result.audio.setSample(ch,i,y[static_cast<size_t>(ch)]);}
            start=end;
        }
        if(retire){const auto before=engine.processedFrames()[1];for(int i=0;i<static_cast<int>(rate*4);++i)engine.process(0,0);const auto after=engine.processedFrames()[1];for(int i=0;i<1024;++i)engine.process(0,0);result.suspended=after>=before&&engine.processedFrames()[1]==after;}
        return result;
    };
    const auto energy=[](const auto& audio,double rate,double from,double to){double value=0;for(int ch=0;ch<2;++ch)for(int i=static_cast<int>(rate*from);i<static_cast<int>(rate*to);++i)value+=std::pow(audio.getSample(ch,i),2);return value;};
    bool sustain=true,infinite=true,release=true,finite=true;double partition=0,geometry=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int spacing:{0,1})
    {
        const auto held=render(rate,127,spacing,true,false,false,false),extra=render(rate,511,spacing,true,false,true,false),added=render(rate,127,spacing,true,true,true,false),normal=render(rate,127,spacing,false,false,false,false);
        const double first=energy(held.audio,rate,.6,1.5),late=energy(held.audio,rate,1.8,2.7),base=energy(normal.audio,rate,1.8,2.7),accumulated=energy(added.audio,rate,1.8,2.7),drained=energy(held.audio,rate,4,4.5);
        sustain=sustain&&late>1e-10&&late>first*.8&&late<first*1.2&&late>base*100;infinite=infinite&&accumulated>late*1.2&&extra.liveDryEnergy>1e-5;release=release&&drained<late*.01;
        for(int ch=0;ch<2;++ch)for(int i=0;i<held.audio.getNumSamples();++i){partition=juce::jmax(partition,std::abs(static_cast<double>(held.audio.getSample(ch,i)-extra.audio.getSample(ch,i))));finite=finite&&std::isfinite(added.audio.getSample(ch,i))&&std::abs(added.audio.getSample(ch,i))<=2.1f;}
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("spacing",spacing);row->setProperty("heldEnergyRatio",late/first);row->setProperty("addedEnergyRatio",accumulated/late);row->setProperty("releaseEnergyRatio",drained/late);cases.add(row);
    }
    const auto baseline=render(48000,127,1,true,false,false,false),edited=render(48000,511,1,true,false,false,true),retired=render(48000,127,1,true,true,true,false,true);
    for(int ch=0;ch<2;++ch)for(int i=0;i<144000;++i)geometry=juce::jmax(geometry,std::abs(static_cast<double>(baseline.audio.getSample(ch,i)-edited.audio.getSample(ch,i))));
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);source->algorithm.store(16);source->positionedHold.store(1);source->holdInputModes[16].store(1);
    juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);
    bool recall=state==again&&copy->positionedHold.load()==1&&copy->holdInputModes[16].load()==1&&copy->getTailLengthSeconds()>=120;
    juce::ValueTree legacy("OpenStudioReverb");legacy.setProperty("algorithm",16,nullptr);legacy.setProperty("freezeMode",1,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);legacy.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->positionedHold.load()==0;
    const auto schema=describeFreePluginForRegression(*source);const auto* parameters=schema["parameters"].getArray();recall=recall&&parameters&&parameters->size()>1082&&(*parameters)[1082]["id"].toString()=="positionedHold"&&setFreePluginParamForRegression(*source,"positionedHold",0)&&source->positionedHold.load()==0;
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Positioned Room Freeze and Infinite");result->setProperty("cases",cases);result->setProperty("sustainedEnergy",sustain);result->setProperty("freezeAndPartitionError",partition);result->setProperty("infiniteAccumulatesAndDryStaysLive",infinite);result->setProperty("releaseDecays",release);result->setProperty("retirementSuspends",retired.suspended);result->setProperty("heldGeometryError",geometry);result->setProperty("stateDefaultsTailAndAppend",recall);result->setProperty("finite",finite);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");result->setProperty("pass",sustain&&partition==0&&infinite&&release&&retired.suspended&&geometry==0&&recall&&finite);return result;
}
