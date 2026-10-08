#pragma once
inline juce::var checkModalPlate()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Original rectangular modal plate");
    bool finite=true,excitation=true,clock=true,reset=true,dispersion=true,hold=true,retire=true;double partition=0;juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto render=[&](int block,bool opposite,auto controls)
        {
            auto engine=std::make_unique<BuiltInModalPlate>();engine->prepare(rate,controls,true);BuiltInModalPlate::Settings settings;settings.decay=1;
            const int count=static_cast<int>(rate*.15);juce::AudioBuffer<float> output(2,count);
            for(int i=0;i<count;++i){if(i%block==0)engine->configure(true,settings,false);const auto sample=engine->process(i==0?.5f:0,i==0?(opposite?-.5f:.25f):0);for(int ch=0;ch<2;++ch){output.setSample(ch,i,sample[static_cast<size_t>(ch)]);finite=finite&&std::isfinite(sample[static_cast<size_t>(ch)])&&std::abs(sample[static_cast<size_t>(ch)])<2;}}
            clock=clock&&engine->processingRate()==24000&&std::abs(static_cast<double>(engine->processingFrames())-count*24000/rate)<=1;
            const double k2=std::pow(juce::MathConstants<double>::pi/controls[0],2)+std::pow(juce::MathConstants<double>::pi*controls[1]/controls[0],2);
            const double expected=std::sqrt(controls[2]*controls[2]*k2+controls[3]*controls[3]*k2*k2)/juce::MathConstants<double>::twoPi;
            dispersion=dispersion&&std::abs(engine->modeFrequency(0)-expected)<.0001&&engine->modeCount()>200&&engine->modeFrequency(engine->modeCount()-1)<10800;
            engine->reset();engine->configure(true,settings,false);for(int i=0;i<1000;++i){const auto sample=engine->process(0,0);reset=reset&&sample[0]==0&&sample[1]==0;}
            return output;
        };
        const auto a=render(127,false,BuiltInModalPlate::defaults),b=render(511,false,BuiltInModalPlate::defaults),opposed=render(127,true,BuiltInModalPlate::defaults);
        auto moved=BuiltInModalPlate::defaults;moved[7]=.47f;const auto changed=render(127,false,moved);double energy=0,opposedEnergy=0,difference=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double value=a.getSample(ch,i);energy+=value*value;opposedEnergy+=std::pow(opposed.getSample(ch,i),2);difference+=std::abs(value-changed.getSample(ch,i));partition=juce::jmax(partition,std::abs(value-b.getSample(ch,i)));}
        excitation=excitation&&energy>1e-7&&opposedEnergy>1e-7&&difference>.01;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("energyDiagnostic",energy);row->setProperty("opposedStereoEnergy",opposedEnergy);row->setProperty("pickupDifference",difference);cases.add(row);
    }
    // Geometry changes actual eigenfrequencies, not just colour filtering.
    auto low=std::make_unique<BuiltInModalPlate>(),high=std::make_unique<BuiltInModalPlate>();auto geometry=BuiltInModalPlate::defaults;low->prepare(48000,geometry,true);geometry[3]*=2;high->prepare(48000,geometry,true);
    dispersion=dispersion&&high->modeFrequency(0)>low->modeFrequency(0)&&high->modeFrequency(100)/low->modeFrequency(100)>high->modeFrequency(0)/low->modeFrequency(0);
    BuiltInModalPlate::Settings settings;low->configure(true,settings,false);high->prepare(48000,BuiltInModalPlate::defaults,true);high->configure(true,settings,false);
    for(int i=0;i<5000;++i){low->process(i==0?.5f:0,0);high->process(i==0?.5f:0,0);}
    settings.freeze=true;low->configure(true,settings,false);high->configure(true,settings,false);
    for(int i=0;i<4000;++i){low->process(0,0);high->process(0,0);}
    double heldEnergy=0;
    for(int i=0;i<6000;++i){const auto a=low->process(i%100==0?.5f:0,0),b=high->process(0,0);hold=hold&&a==b;heldEnergy+=a[0]*a[0]+a[1]*a[1];}
    hold=hold&&heldEnergy>1e-7;settings.infiniteInput=true;low->configure(true,settings,false);
    double added=0;for(int i=0;i<6000;++i){const auto a=low->process(i%100==0?.5f:0,0),b=high->process(0,0);added+=std::abs(a[0]-b[0]);finite=finite&&std::isfinite(a[0])&&std::isfinite(a[1]);}hold=hold&&added>.01;
    for(const bool spill:{false,true})
    {
        auto engine=std::make_unique<BuiltInModalPlate>();engine->prepare(48000,BuiltInModalPlate::defaults,true);settings={};engine->configure(true,settings,spill);for(int i=0;i<5000;++i)engine->process(i==0?.5f:0,0);
        engine->configure(false,settings,spill);double energy=0;for(int i=0;i<6000;++i){const auto sample=engine->process(0,0);if(i>=4000)energy+=std::abs(sample[0])+std::abs(sample[1]);}
        retire=retire&&(spill?energy>1e-7&&engine->retiringTailSeconds()>0:energy==0&&engine->retiringTailSeconds()==0);
    }
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);source->selectAlgorithm(2);
    const bool setters=setFreePluginParamForRegression(*source,"plateEngineExpanded",2)&&setFreePluginParamForRegression(*source,"modalLength",2)&&setFreePluginParamForRegression(*source,"modalModes",2);
    source->prepareToPlay(48000,127);juce::MemoryBlock saved,again;source->getStateInformation(saved);copy->setStateInformation(saved.getData(),static_cast<int>(saved.getSize()));copy->getStateInformation(again);
    bool recall=saved==again&&copy->plateEngine.load()==2&&copy->modalControls[0].load()==2&&copy->modalControls[4].load()==2;
    const auto schema=describeFreePluginForRegression(*source);bool appended=schema["parameters"].size()>=629&&schema["parameters"][617]["id"].toString()=="plateEngineExpanded";
    for(int i=618;i<629;++i)appended=appended&&!static_cast<bool>(schema["parameters"][i]["automatable"]);
    bool automation=true;for(int i=0;i<2;++i)automation=automation&&setFreePluginNormalizedForRegression(*source,"plateEngine",static_cast<float>(i))&&source->plateEngine.load()==i;
    for(int i=0;i<3;++i)automation=automation&&setFreePluginNormalizedForRegression(*source,"plateEngineExpanded",static_cast<float>(i)/2)&&source->plateEngine.load()==i;
    auto tree=juce::ValueTree::readFromData(saved.getData(),saved.getSize());tree.removeProperty("plateEngine",nullptr);for(const auto* id:BuiltInModalPlate::ids)tree.removeProperty(id,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->plateEngine.load()==0&&copy->modalSettings()==BuiltInModalPlate::defaults;
    source->wetLevel.store(0);source->dryLevel.store(1);source->prepareToPlay(48000,127);juce::MidiBuffer midi;juce::AudioBuffer<float> buffer(2,127);bool dry=true;
    for(int block=0;block<25;++block){for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)buffer.setSample(ch,i,static_cast<float>(i)*.001f);source->processBlock(buffer,midi);if(block>20)for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)dry=dry&&buffer.getSample(ch,i)==static_cast<float>(i)*.001f;}
    result->setProperty("pass",finite&&excitation&&clock&&reset&&dispersion&&hold&&retire&&partition==0&&setters&&recall&&appended&&automation&&dry);result->setProperty("finite",finite);result->setProperty("stereoAndPickupInfluence",excitation);result->setProperty("preparedClock",clock);result->setProperty("resetSilence",reset);result->setProperty("dispersiveEigenfrequencies",dispersion);result->setProperty("holdInputPolicies",hold);result->setProperty("tailSpillover",retire);result->setProperty("partitionMaximumError",partition);result->setProperty("setters",setters);result->setProperty("stateLegacyDefaults",recall);result->setProperty("appendedDescriptors",appended);result->setProperty("originalAutomationRange",automation);result->setProperty("dryParity",dry);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");result->setProperty("modalDensityAndDecayCalibration","diagnostic_only");return result;
}
