#pragma once

inline juce::var checkRetroReverb()
{
    auto* result=new juce::DynamicObject();juce::Array<juce::var> cases,controlCases;
    bool finite=true,partition=true,distinct=true,controls=true,hold=true,retained=true,recall=true;
    double maximumPartition=0,maximumPeak=0;auto engine=std::make_unique<BuiltInRetroReverb>();
    const auto difference=[](const auto& a,const auto& b){double error=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)error=juce::jmax(error,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));return error;};
    const auto energy=[](const auto& audio){double total=0;for(int ch=0;ch<2;++ch)for(int i=0;i<audio.getNumSamples();++i)total+=static_cast<double>(audio.getSample(ch,i))*audio.getSample(ch,i);return total;};
    const auto render=[&](double rate,int mode,BuiltInRetroReverb::Settings settings,int block,int retirement=0)
    {
        engine->configure(mode,settings,false);engine->reset();const int length=juce::roundToInt(rate*.65),change=juce::roundToInt(rate*.2);juce::AudioBuffer<float> audio(2,length);
        for(int start=0;start<length;)
        {
            const int n=juce::jmin(block,length-start,start<change?change-start:length-start);auto current=settings;
            if(retirement==2&&start>=change){current.decay=70;current.depth=1;current.era=0;current.lowCut=500;current.highCut=1000;current.aperture=1;}
            engine->configure(retirement&&start>=change?-1:mode,current,retirement!=0);
            for(int i=0;i<n;++i){const float pulse=start+i==0?.8f:0;const auto sample=engine->process(pulse,pulse*.31f);audio.setSample(0,start+i,sample[0]);audio.setSample(1,start+i,sample[1]);}start+=n;
        }
        return audio;
    };
    std::array<juce::AudioBuffer<float>,14> modes;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        engine->prepare(rate,-1);
        for(int mode=0;mode<14;++mode)
        {
            BuiltInRetroReverb::Settings settings;settings.decay=1;settings.damping=.2f;
            auto baseline=render(rate,mode,settings,127);const auto other=render(rate,mode,settings,512);
            const double error=difference(baseline,other),total=energy(baseline),peak=baseline.getMagnitude(0,baseline.getNumSamples());
            maximumPartition=juce::jmax(maximumPartition,error);maximumPeak=juce::jmax(maximumPeak,peak);partition=partition&&error==0;finite=finite&&std::isfinite(total)&&total>1e-8&&peak<4;
            auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("mode",BuiltInRetroReverb::names[static_cast<size_t>(mode)]);row->setProperty("core",BuiltInRetroReverb::profiles[static_cast<size_t>(mode)].core);row->setProperty("partitionError",error);row->setProperty("impulseEnergyDiagnostic",total);cases.add(row);
            if(rate==48000)modes[static_cast<size_t>(mode)]=std::move(baseline);
        }
    }
    for(size_t a=0;a<modes.size();++a)for(size_t b=a+1;b<modes.size();++b)distinct=distinct&&difference(modes[a],modes[b])>1e-5;
    engine->prepare(48000,-1);
    // Individually probe shared controls on both feedback structures and the
    // finite envelope, rather than treating different names as functionality.
    for(int mode:{0,3,5,9,12,13})
    {
        BuiltInRetroReverb::Settings settings;settings.decay=1;settings.damping=.2f;const auto baseline=render(48000,mode,settings,127);
        for(int field=0;field<12;++field)
        {
            if(mode==9&&field!=1&&field!=5&&field!=9)continue;
            if(field==8&&mode!=12&&mode!=13)continue;
            if(mode==5&&field==2)continue; // Reflection field Attack is balance, not onset.
            auto altered=settings;
            switch(field){case 0:altered.decay=12;break;case 1:altered.attack=.9f;break;case 2:altered.inputDiffusion=.1f;break;case 3:altered.depth=1;break;case 4:altered.speed=2;break;case 5:altered.era=0;break;case 6:altered.bassRatio=3;break;case 7:altered.bassRatio=3;altered.bassFrequency=3000;break;case 8:altered.aperture=1;break;case 9:altered.size=.1f;break;case 10:altered.diffusion=.1f;break;case 11:altered.damping=.9f;break;default:break;}
            const auto changed=render(48000,mode,altered,127);const double influence=difference(baseline,changed);controls=controls&&influence>1e-7;
            auto* row=new juce::DynamicObject();row->setProperty("mode",mode);row->setProperty("control",field<9?BuiltInRetroReverb::ids[static_cast<size_t>(field)]:field==9?"roomSize":field==10?"diffusion":"damping");row->setProperty("maximumDifference",influence);controlCases.add(row);
        }
        retained=retained&&difference(render(48000,mode,settings,127,1),render(48000,mode,settings,127,2))==0;
        if(mode!=9){settings.hold=true;settings.holdInput=false;const auto frozen=render(48000,mode,settings,127);settings.holdInput=true;const auto infinite=render(48000,mode,settings,127);hold=hold&&energy(frozen)==0&&energy(infinite)>1e-8;}
    }
    bool eraRates=true;juce::Array<juce::var> eraCases;
    for(int mode:{0,3,9})for(int era=0;era<3;++era)
    {
        BuiltInRetroReverb::Settings settings;settings.era=static_cast<float>(era);const auto audio=render(48000,mode,settings,127);
        const auto frames=engine->processingFrames(static_cast<size_t>(mode),static_cast<size_t>(era));
        constexpr std::array<double,3> rates{24000,32000,48000};const auto expected=static_cast<juce::int64>(rates[static_cast<size_t>(era)]*.65);
        eraRates=eraRates&&std::abs(static_cast<juce::int64>(frames)-expected)<=1&&energy(audio)>1e-8;
        auto* row=new juce::DynamicObject();row->setProperty("mode",mode);row->setProperty("era",era);row->setProperty("processedFrames",static_cast<juce::int64>(frames));row->setProperty("expectedFrames",expected);eraCases.add(row);
    }
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);
    for(int mode=27;mode<41;++mode)
    {
        recall=recall&&setFreePluginParamForRegression(*source,"reverbTypeAll",static_cast<float>(mode));
        for(size_t field=0;field<BuiltInRetroReverb::controlCount;++field)recall=recall&&setFreePluginParamForRegression(*source,BuiltInRetroReverb::ids[field],BuiltInRetroReverb::minima[field]+(BuiltInRetroReverb::maxima[field]-BuiltInRetroReverb::minima[field])*static_cast<float>(mode-26)/14);
        recall=recall&&setFreePluginParamForRegression(*source,"roomSize",static_cast<float>(mode-26)/14);
    }
    juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);recall=recall&&bytes==again;
    for(size_t bank=0;bank<14;++bank)for(size_t field=0;field<9;++field)recall=recall&&copy->retroControls[bank][field].load()==source->retroControls[bank][field].load();
    auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());for(int bank=0;bank<14;++bank)for(int field=0;field<9;++field)tree.removeProperty("retro"+juce::String(bank)+"_"+juce::String(field),nullptr);
    juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);tree.writeToStream(stream);copy->setStateInformation(oldBytes.getData(),static_cast<int>(oldBytes.getSize()));for(const auto& bank:copy->retroControls)for(size_t field=0;field<9;++field)recall=recall&&bank[field].load()==BuiltInRetroReverb::defaults[field];
    const auto schema=describeFreePluginForRegression(*source);const bool prefix=schema["parameters"].size()>=1077&&schema["parameters"][1076]["id"].toString()=="holdInput40"&&schema["parameters"][731]["id"].toString()=="reverbTypeAll"&&static_cast<int>(schema["parameters"][633]["max"])==26&&schema["parameters"][724]["id"].toString()=="modalMaterial";
    result->setProperty("plugin","Fourteen original digital spaces");result->setProperty("cases",cases);result->setProperty("controlCases",controlCases);result->setProperty("preparedEraRates",eraRates);result->setProperty("eraCases",eraCases);result->setProperty("finiteImpulse",finite);result->setProperty("distinctNetworks",distinct);result->setProperty("exactPartitioning",partition);result->setProperty("maximumPartitionError",maximumPartition);result->setProperty("maximumPeakDiagnostic",maximumPeak);result->setProperty("controlInfluence",controls);result->setProperty("holdInputPolicies",hold);result->setProperty("retiringSettingsRetained",retained);result->setProperty("stateAndDefaults",recall);result->setProperty("appendOnlyDescriptors",prefix);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");result->setProperty("decayCalibration","diagnostic_only");result->setProperty("pass",finite&&partition&&distinct&&controls&&hold&&retained&&recall&&prefix&&eraRates);return result;
}
