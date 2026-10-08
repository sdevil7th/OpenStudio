#pragma once

inline juce::var checkPlateDecayFilters()
{
    auto* result=new juce::DynamicObject();bool finite=true,legacy=true,feedback=true,hold=true,retained=true,recall=true;double outputError=0,partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int kind,int blockSize,BuiltInPlateReverb::Settings settings,int retire=0)
    {
        BuiltInPlateReverb space;space.prepare(rate,kind);const int length=juce::roundToInt(rate*.55),change=juce::roundToInt(rate*.18);juce::AudioBuffer<float> audio(2,length);
        for(int pos=0;pos<length;){int n=juce::jmin(blockSize,length-pos);if(pos<change)n=juce::jmin(n,change-pos);auto current=settings;const bool retiring=retire&&pos>=change;if(retiring&&retire==2){current.decayFilter=1;current.decayCutoff=200;current.outputCutOff=!settings.outputCutOff;current.highCut=1000;}
            space.configure(retiring?-1:kind,current,retire!=0);for(int i=0;i<n;++i){const float pulse=pos+i==0?.1f:0;const auto value=space.process(pulse,pulse*.7f);audio.setSample(0,pos+i,value[0]);audio.setSample(1,pos+i,value[1]);}pos+=n;}return audio;
    };
    const auto difference=[](const auto& a,const auto& b){double error=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)error=juce::jmax(error,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));return error;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int kind=0;kind<3;++kind)
    {
        BuiltInPlateReverb::Settings settings;settings.modulation=0;settings.decay=.3f;settings.damping=0;settings.highCut=2000;settings.decayFilter=1;settings.outputCutOff=true;
        const auto off=render(rate,kind,127,settings);settings.decayFilter=0;legacy=legacy&&difference(off,render(rate,kind,127,settings))==0;
        settings.decayFilter=1;settings.outputCutOff=false;const auto filtered=render(rate,kind,127,settings),other=render(rate,kind,512,settings);partition=juce::jmax(partition,difference(filtered,other));
        const float pole=std::exp(-juce::MathConstants<float>::twoPi*2000/static_cast<float>(rate));double error=0;std::array<float,2> previous{};
        for(int ch=0;ch<2;++ch)for(int i=0;i<off.getNumSamples();++i){const auto v=off.getSample(ch,i);previous[static_cast<size_t>(ch)]=v+pole*(previous[static_cast<size_t>(ch)]-v);error=juce::jmax(error,std::abs(static_cast<double>(filtered.getSample(ch,i)-previous[static_cast<size_t>(ch)])));finite=finite&&std::isfinite(filtered.getSample(ch,i));}
        outputError=juce::jmax(outputError,error);settings.outputCutOff=true;settings.decayFilter=2;settings.decayCutoff=700;const auto damped=render(rate,kind,127,settings);const double influence=difference(off,damped);feedback=feedback&&influence>1e-5;
        retained=retained&&difference(render(rate,kind,127,settings,1),render(rate,kind,127,settings,2))==0;
        settings.freeze=true;settings.infiniteInput=true;const auto held=render(rate,kind,127,settings);settings.decayFilter=1;hold=hold&&difference(held,render(rate,kind,127,settings))==0;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("topology",kind);row->setProperty("outputPoleError",error);row->setProperty("feedbackControlInfluence",influence);cases.add(row);
    }
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);
    for(size_t field=0;field<3;++field)recall=recall&&setFreePluginParamForRegression(*source,OpenStudioReverb::plateToneIds[field],field==1?1234:OpenStudioReverb::studioToneMax[field]);
    juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);recall=recall&&bytes==again;
    auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());for(const auto* id:OpenStudioReverb::plateToneIds)tree.removeProperty(id,nullptr);
    juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);tree.writeToStream(stream);copy->setStateInformation(oldBytes.getData(),static_cast<int>(oldBytes.getSize()));for(size_t field=0;field<3;++field)recall=recall&&copy->plateToneControls[field].load()==OpenStudioReverb::studioToneDefaults[field];
    const auto schema=describeFreePluginForRegression(*source);const bool descriptors=schema["parameters"].size()>=724&&schema["parameters"][721]["id"].toString()=="plateDecayFilter"&&schema["parameters"][633]["id"].toString()=="reverbTypeExtended";
    result->setProperty("plugin","Independent Studio Plate feedback/output filters");result->setProperty("cases",cases);result->setProperty("finite",finite);result->setProperty("legacyOffParity",legacy);result->setProperty("feedbackControlInfluence",feedback);result->setProperty("holdSuspendsDecayFilter",hold);result->setProperty("retiringControlsRetained",retained);result->setProperty("stateAndMigration",recall);result->setProperty("appendedDescriptors",descriptors);result->setProperty("outputPoleError",outputError);result->setProperty("partitionError",partition);result->setProperty("schema",schema);result->setProperty("decayCalibration","diagnostic_only");result->setProperty("pass",finite&&legacy&&feedback&&hold&&retained&&recall&&descriptors&&outputError<1e-6&&partition==0);return result;
}
