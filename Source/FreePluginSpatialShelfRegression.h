// Included inside the free-plugin regression translation unit.
juce::var checkSpatialShelf()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Spatial low shelf and zero-delay feedback");
    bool finite=true,zeroDelay=true,dry=true,recall=true;double maxError=0,partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int mode,int block,float shelf,float feedback,float delay,double frequency)
    {
        BuiltInSpatialReverb processor;processor.prepare(rate,mode);BuiltInSpatialReverb::Settings settings;settings.lowShelfDb=shelf;settings.feedback=feedback;settings.delayMs=delay;settings.amount=0;settings.modulation=0;
        juce::AudioBuffer<float> output(2,static_cast<int>(rate*.5));
        for(int start=0;start<output.getNumSamples();start+=block){processor.configure(mode,settings);for(int i=start;i<juce::jmin(start+block,output.getNumSamples());++i){const float x=.05f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*frequency*i/rate));const auto y=processor.process(x,-x);output.setSample(0,i,y[0]);output.setSample(1,i,y[1]);}}return output;
    };
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(const double frequency:{20.0,5000.0})
        {
            const auto neutral=render(rate,0,127,0,0,10,frequency),cut=render(rate,0,127,-24,0,10,frequency),other=render(rate,0,511,-24,0,10,frequency);double baseEnergy=0,cutEnergy=0;
            for(int i=0;i<cut.getNumSamples();++i){for(int ch=0;ch<2;++ch){finite=finite&&std::isfinite(cut.getSample(ch,i));partition=juce::jmax(partition,std::abs(static_cast<double>(cut.getSample(ch,i)-other.getSample(ch,i))));}if(i>=rate*.25){baseEnergy+=std::pow(neutral.getSample(0,i),2);cutEnergy+=std::pow(cut.getSample(0,i),2);}}
            const double actual=10*std::log10(cutEnergy/baseEnergy),ratio=std::tan(juce::MathConstants<double>::pi*frequency/rate)/std::tan(juce::MathConstants<double>::pi*250/rate),gain=std::pow(10.0,-24.0/20);const double expected=10*std::log10((gain*gain+ratio*ratio)/(1+ratio*ratio));maxError=juce::jmax(maxError,std::abs(actual-expected));
            auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("frequency",frequency);row->setProperty("measuredDb",actual);row->setProperty("expectedDb",expected);cases.add(row);
        }
        for(int mode=0;mode<3;++mode){const auto off=render(rate,mode,127,0,0,0,440),full=render(rate,mode,511,0,1,0,440);for(int i=0;i<off.getNumSamples();++i)for(int ch=0;ch<2;++ch)zeroDelay=zeroDelay&&off.getSample(ch,i)==full.getSample(ch,i);}
    }
    // The shelf acts on incoming material once and again on each recirculation.
    BuiltInSpatialReverb loop;loop.prepare(48000,0);BuiltInSpatialReverb::Settings settings;settings.lowShelfDb=-6;settings.feedback=.5f;settings.delayMs=100;settings.amount=0;settings.modulation=0;loop.configure(0,settings);std::array<double,3> areas{};
    for(int i=0;i<19200;++i){const auto output=loop.process(i==0?.1f:0,0);if(i>=4800)areas[static_cast<size_t>(juce::jmin(2,i/4800-1))]+=output[0];}
    const double gain=juce::Decibels::decibelsToGain(-6.0);bool repeats=true;for(size_t i=0;i<3;++i)repeats=repeats&&std::abs(areas[i]-.1*std::pow(gain,static_cast<int>(i)+1)*std::pow(.5,static_cast<int>(i)))<1e-6;
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);source->selectAlgorithm(12);source->wetLevel.store(0);source->dryLevel.store(1);const bool setter=setFreePluginParamForRegression(*source,"spatialLowShelf",-12)&&setFreePluginParamForRegression(*source,"spatialLowShelf1",-6)&&setFreePluginParamForRegression(*source,"spatialLowShelf2",-24);source->prepareToPlay(48000,127);juce::AudioBuffer<float> audio(2,127);juce::MidiBuffer midi;for(int i=0;i<127;++i){audio.setSample(0,i,.1f);audio.setSample(1,i,-.07f);}source->processBlock(audio,midi);for(int i=0;i<127;++i)dry=dry&&audio.getSample(0,i)==.1f&&audio.getSample(1,i)==-.07f;
    juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);recall=state==again;for(size_t i=0;i<3;++i)recall=recall&&source->spatialLowShelf[i].load()==copy->spatialLowShelf[i].load();auto tree=juce::ValueTree::readFromData(state.getData(),static_cast<int>(state.getSize()));for(int i=0;i<3;++i)tree.removeProperty("spatialLowShelf"+juce::String(i),nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));for(const auto& shelf:copy->spatialLowShelf)recall=recall&&shelf.load()==0;
    source->wetLevel.store(1);source->spatialControls[0][0].store(0);source->spatialControls[0][1].store(1);const bool tail=source->getTailLengthSeconds()<120;
    const auto schema=describeFreePluginForRegression(*source);const bool appended=schema["parameters"].size()>=532&&schema["parameters"][528]["id"].toString()=="spatialLowShelf"&&schema["parameters"][531]["id"].toString()=="spatialLowShelf2";
    result->setProperty("pass",finite&&zeroDelay&&dry&&recall&&setter&&tail&&appended&&repeats&&maxError<.03&&partition==0);result->setProperty("finite",finite);result->setProperty("zeroDelayFeedbackInvariant",zeroDelay);result->setProperty("dryExact",dry);result->setProperty("shelfErrorDb",maxError);result->setProperty("partitionError",partition);result->setProperty("progressiveRepeats",repeats);result->setProperty("stateOldDefaults",recall);result->setProperty("setter",setter);result->setProperty("zeroDelayTail",tail);result->setProperty("appendedDescriptors",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("referenceFilterMatch","not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}
