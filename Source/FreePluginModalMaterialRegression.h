#pragma once

inline juce::var checkModalPlateMaterial()
{
    auto* result=new juce::DynamicObject();bool finite=true,recall=true,defaults=true,contactInfluence=true;double frequencyError=0,apertureError=0,partition=0,coefficientParity=0;juce::Array<juce::var> cases;
    const auto difference=[](const auto& a,const auto& b){double error=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i)error=juce::jmax(error,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));return error;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        auto geometry=BuiltInModalPlate::defaults;geometry[4]=0;
        auto material=BuiltInModalPlate::materialDefaults;material[0]=1;
        auto plate=std::make_unique<BuiltInModalPlate>();plate->prepare(rate,geometry,true,material);
        const double poisson=material[3],h=material[4]*.001,kappa=h*std::sqrt(material[1]*1e9/(12.0*material[2]*(1-poisson*poisson)));
        const double k2=std::pow(juce::MathConstants<double>::pi/geometry[0],2)+std::pow(juce::MathConstants<double>::pi*geometry[1]/geometry[0],2);
        const double expected=std::sqrt(geometry[2]*geometry[2]*k2+kappa*kappa*k2*k2)/juce::MathConstants<double>::twoPi;
        frequencyError=juce::jmax(frequencyError,std::abs(plate->modeFrequency(0)-expected));
        const auto baseExciter=plate->excitationWeight(0,0),basePickup=plate->pickupWeight(0,0);
        auto broad=material;broad[5]=40;broad[6]=70;plate->prepare(rate,geometry,true,broad);
        apertureError=juce::jmax<double>(apertureError,std::abs(plate->excitationWeight(0,0)/baseExciter-std::exp(-.5*.04*.04*k2)),std::abs(plate->pickupWeight(0,0)/basePickup-std::exp(-.5*.07*.07*k2)));
        const auto render=[&](int block,auto controls,auto contact){
            auto engine=std::make_unique<BuiltInModalPlate>();engine->prepare(rate,controls,true,contact);BuiltInModalPlate::Settings settings;settings.decay=.4f;
            const int count=juce::roundToInt(rate*.2);juce::AudioBuffer<float> output(2,count);
            for(int i=0;i<count;++i){if(i%block==0)engine->configure(true,settings,false);const auto pair=engine->process(i==0?.1f:0,i==0?.07f:0);for(int ch=0;ch<2;++ch){const float value=pair[static_cast<size_t>(ch)];output.setSample(ch,i,value);finite=finite&&std::isfinite(value)&&std::abs(value)<2;}}return output;
        };
        const auto actual=render(127,geometry,material),point=render(127,geometry,broad);contactInfluence=contactInfluence&&difference(actual,point)>1e-5;
        partition=juce::jmax(partition,difference(point,render(512,geometry,broad)));
        auto coefficient=geometry;coefficient[3]=static_cast<float>(kappa);coefficientParity=juce::jmax(coefficientParity,difference(actual,render(127,coefficient,BuiltInModalPlate::materialDefaults)));
        for(size_t field:{size_t(1),size_t(2),size_t(3),size_t(4)})
        {
            auto changed=material;changed[field]=field==1?70.0f:field==2?2700.0f:field==3?.45f:2.0f;plate->prepare(rate,geometry,true,changed);
            const double nu=changed[3],bend=changed[4]*.001*std::sqrt(changed[1]*1e9/(12.0*changed[2]*(1-nu*nu)));
            const double target=std::sqrt(geometry[2]*geometry[2]*k2+bend*bend*k2*k2)/juce::MathConstants<double>::twoPi;
            frequencyError=juce::jmax(frequencyError,std::abs(plate->modeFrequency(0)-target));finite=finite&&plate->modeCount()>0;
        }
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("materialFundamentalHz",expected);row->setProperty("contactAudioDifference",difference(actual,point));cases.add(row);
    }
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);
    for(size_t i=0;i<BuiltInModalPlate::materialCount;++i)recall=recall&&setFreePluginParamForRegression(*source,BuiltInModalPlate::materialIds[i],i==0?1:BuiltInModalPlate::materialMaxima[i]);
    juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);recall=recall&&bytes==again&&copy->modalMaterialSettings()==source->modalMaterialSettings();
    auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());for(const auto* id:BuiltInModalPlate::materialIds)tree.removeProperty(id,nullptr);
    juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);tree.writeToStream(stream);copy->setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));defaults=copy->modalMaterialSettings()==BuiltInModalPlate::materialDefaults;
    const auto schema=describeFreePluginForRegression(*source);const bool descriptors=schema["parameters"].size()>=731&&schema["parameters"][724]["id"].toString()=="modalMaterial"&&schema["parameters"][721]["id"].toString()=="plateDecayFilter";
    result->setProperty("plugin","Modal Plate material and distributed contacts");result->setProperty("cases",cases);result->setProperty("finite",finite);result->setProperty("fundamentalErrorHz",frequencyError);result->setProperty("gaussianWeightError",apertureError);result->setProperty("partitionError",partition);result->setProperty("equivalentCoefficientAudioError",coefficientParity);result->setProperty("contactAudioInfluence",contactInfluence);result->setProperty("stateRoundTrip",recall);result->setProperty("oldStateDefaults",defaults);result->setProperty("appendedDescriptors",descriptors);result->setProperty("schema",schema);result->setProperty("physicalCalibration","not_asserted");result->setProperty("audioQuality","not_asserted");
    result->setProperty("pass",finite&&recall&&defaults&&descriptors&&contactInfluence&&frequencyError<1e-6&&apertureError<1e-12&&partition==0&&coefficientParity<1e-6);return result;
}
