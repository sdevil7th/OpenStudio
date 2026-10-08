#pragma once
inline juce::var checkVCANoiseMonitor()
{
    auto* result=new juce::DynamicObject();bool monitor=true,noise=true,state=true,finite=true;double partition=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(int routing=0;routing<3;++routing)for(int mode=0;mode<4;++mode){BuiltInVCAMonitor engine;engine.prepare(rate);engine.configure(true,0,0,routing,0,mode);engine.noise();const auto y=engine.listen(.3f,-.1f);
            const double first=routing==2?.2*std::sqrt(.5):.3,second=routing==2?.4*std::sqrt(.5):-.1;
            monitor=monitor&&std::abs(y[0]-(mode==0?.3:mode==1?first:mode==2?.1:second))<1e-7&&std::abs(y[1]-(mode==0?-.1:mode==1?first:mode==2?.1:second))<1e-7;}
        for(int hum=0;hum<2;++hum){BuiltInVCAMonitor engine;engine.prepare(rate);engine.configure(true,1,0,1,hum,0);double power=0,inPhase=0,quadrature=0;const int count=juce::roundToInt(rate);
            for(int i=0;i<count;++i){const auto y=engine.noise();finite=finite&&std::isfinite(y[0])&&y[1]==0;power+=y[0]*y[0];const double angle=juce::MathConstants<double>::twoPi*(hum==0?50:60)*i/rate;inPhase+=y[0]*std::sin(angle);quadrature+=y[0]*std::cos(angle);}
            const double rms=std::sqrt(power/count),amplitude=2*std::hypot(inPhase,quadrature)/count;noise=noise&&rms>.000125&&rms<.000142&&amplitude>.000058&&amplitude<.000069;
            auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("humHz",hum==0?50:60);row->setProperty("rms",rms);row->setProperty("humAmplitude",amplitude);cases.add(row);}
    }
    const auto render=[](int blockSize,float mix,int mode,float amount){auto processor=std::make_unique<OpenStudioCompressor>(true);processor->selectModel(6);processor->vcaControls[1].routing.store(1);for(auto& channel:processor->vcaControls[1].channels)channel[BuiltInVCACompressor::Ratio].store(1);processor->punchNoiseLeft.store(amount);processor->punchMonitor.store(static_cast<float>(mode));processor->mix.store(mix);processor->prepareToPlay(48000,blockSize);juce::AudioBuffer<float> output(2,9600),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<9600;start+=blockSize){const int count=juce::jmin(blockSize,9600-start);block.setSize(2,count,false,false,true);for(int i=0;i<count;++i){block.setSample(0,i,static_cast<float>(.05*std::sin(.1*(start+i))));block.setSample(1,i,static_cast<float>(.03*std::cos(.07*(start+i))));}processor->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);}return output;};
    for(float mix:{0.0f,.5f,1.0f}){const auto a=render(127,mix,1,1),b=render(511,mix,1,1),base=render(127,mix,0,0),zero=render(127,mix,0,1);double delta=0;
        for(int i=0;i<a.getNumSamples();++i){monitor=monitor&&a.getSample(0,i)==a.getSample(1,i);delta+=std::abs(zero.getSample(0,i)-base.getSample(0,i));for(int ch=0;ch<2;++ch)partition=juce::jmax(partition,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));}noise=noise&&(mix==0?delta==0:delta>.01);}
    auto source=std::make_unique<OpenStudioCompressor>(true),copy=std::make_unique<OpenStudioCompressor>(true);source->selectModel(6);
    for(const auto* id:{"punchNoiseLeft","punchNoiseRight","punchHum","punchMonitor"})state=setFreePluginNormalizedForRegression(*source,id,1)&&state;
    juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);state=state&&bytes==again&&copy->punchMonitor.load()==3;
    auto old=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());for(const auto* id:{"punchNoiseLeft","punchNoiseRight","punchHum","punchMonitor"})old.removeProperty(id,nullptr);bytes.reset();{juce::MemoryOutputStream stream(bytes,false);old.writeToStream(stream);}copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));state=state&&copy->punchNoiseLeft.load()==0&&copy->punchNoiseRight.load()==0&&copy->punchHum.load()==0&&copy->punchMonitor.load()==0;
    const auto schema=describeFreePluginForRegression(*source);
    const auto parameters=schema["parameters"];
    state=state&&parameters.size()>=78
        &&parameters[72]["id"].toString()=="punchNoiseLeft"
        &&parameters[73]["id"].toString()=="punchNoiseRight"
        &&parameters[74]["id"].toString()=="punchHum"
        &&parameters[75]["id"].toString()=="punchMonitor"
        &&parameters[76]["id"].toString()=="audioCharacter"
        &&parameters[77]["id"].toString()=="headroom";
    result->setProperty("plugin","Punch VCA synthetic floor and post-mix monitor");result->setProperty("cases",cases);result->setProperty("monitorRoutingAndDryMix",monitor);result->setProperty("noiseAndHumLevels",noise);result->setProperty("finiteAndChannelIsolation",finite);result->setProperty("partitionError",partition);result->setProperty("stateDefaultsAndAppend",state);result->setProperty("schema",schema);result->setProperty("hardwareFidelity","not_asserted");result->setProperty("pass",monitor&&noise&&finite&&state&&partition==0);return result;
}
