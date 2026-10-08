#pragma once
inline juce::var checkLimiterStrategies()
{
    auto* result=new juce::DynamicObject();bool finite=true,distinct=true,links=true,ceiling=true,state=true;double partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int blockSize,int style,bool linked,bool tp,int quality=0,bool automatic=false,bool change=false)
    {
        auto processor=std::make_unique<OpenStudioLimiter>(true);processor->limitingStyle.store(static_cast<float>(style));processor->threshold.store(-12);processor->ceiling.store(-1);processor->releaseMs.store(180);processor->slowAttackMs.store(15);processor->continuousGain.store(tp?1.0f:0.0f);processor->truePeak.store(tp?1.0f:0.0f);processor->transientLink.store(linked?1.0f:0.0f);processor->releaseLink.store(linked?1.0f:0.0f);processor->automaticRelease.store(automatic?1.0f:0.0f);processor->oversampleQuality.store(static_cast<float>(quality));processor->prepareToPlay(rate,blockSize);
        const int count=juce::roundToInt(rate*.8),changeAt=juce::roundToInt(rate*.4);juce::AudioBuffer<float> output(2,count),buffer(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<count;){int size=juce::jmin(blockSize,count-start);if(change&&start<changeAt)size=juce::jmin(size,changeAt-start);if(change&&start==changeAt)processor->limitingStyle.store(7);buffer.setSize(2,size,false,false,true);
            for(int i=0;i<size;++i){const double time=(start+i)/rate,phase=std::fmod(time,.23);const double level=phase>.04&&phase<.13?.95:.07;buffer.setSample(0,i,static_cast<float>(level*(.7*std::sin(juce::MathConstants<double>::twoPi*(tp?rate*.43:997)*time)+.3*std::sin(juce::MathConstants<double>::twoPi*83*time))));buffer.setSample(1,i,static_cast<float>(.025*std::sin(juce::MathConstants<double>::twoPi*701*time)));}
            if(start==0){buffer.setSample(0,0,std::numeric_limits<float>::quiet_NaN());buffer.setSample(1,0,std::numeric_limits<float>::infinity());}
            processor->processBlock(buffer,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,buffer,ch,0,size);start+=size;}
        return output;
    };
    const auto difference=[](const auto& a,const auto& b){double total=0;for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double d=a.getSample(ch,i)-b.getSample(ch,i);total+=d*d;}return total;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        std::array<juce::AudioBuffer<float>,4> styles;
        for(int style=4;style<=7;++style)
        {
            styles[static_cast<size_t>(style-4)]=render(rate,127,style,false,false);const auto& independent=styles[static_cast<size_t>(style-4)];const auto linked=render(rate,127,style,true,false),other=render(rate,511,style,false,false);double linkedPower=0,independentPower=0,isolation=0;
            for(int ch=0;ch<2;++ch)for(int i=0;i<independent.getNumSamples();++i){const double sample=independent.getSample(ch,i);finite=finite&&std::isfinite(sample)&&std::abs(sample)<=.892;partition=juce::jmax(partition,std::abs(sample-other.getSample(ch,i)));}
            for(int i=static_cast<int>(rate*.1);i<independent.getNumSamples();++i){linkedPower+=std::pow(linked.getSample(1,i),2);independentPower+=std::pow(independent.getSample(1,i),2);const float expected=static_cast<float>(.025*std::sin(juce::MathConstants<double>::twoPi*701*(i-juce::roundToInt(rate*.02))/rate));isolation=juce::jmax(isolation,std::abs(static_cast<double>(independent.getSample(1,i)-expected)));}
            links=links&&isolation<1e-6&&linkedPower<independentPower*.98;
            const auto protectedAudio=render(rate,127,style,false,true);juce::dsp::Oversampling<float> oracle(2,4,juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,true);oracle.initProcessing(static_cast<size_t>(protectedAudio.getNumSamples()));const auto up=oracle.processSamplesUp(juce::dsp::AudioBlock<const float>(protectedAudio));double peak=0;for(size_t ch=0;ch<up.getNumChannels();++ch)for(size_t i=0;i<up.getNumSamples();++i)peak=juce::jmax(peak,std::abs(static_cast<double>(up.getSample(static_cast<int>(ch),static_cast<int>(i)))));ceiling=ceiling&&peak<=juce::Decibels::decibelsToGain(-1.0)+1e-4;
            auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("style",style);row->setProperty("independentRightError",isolation);row->setProperty("linkedEnergyRatio",linkedPower/independentPower);row->setProperty("fixture16xPeakDb",juce::Decibels::gainToDecibels(peak));cases.add(row);
        }
        for(size_t a=0;a<4;++a)for(size_t b=a+1;b<4;++b)distinct=distinct&&difference(styles[a],styles[b])>1e-5;
    }
    const auto transition=render(48000,127,4,false,false,0,false,true),transitionOther=render(48000,511,4,false,false,0,false,true);partition=juce::jmax(partition,std::sqrt(difference(transition,transitionOther)));
    for(int style:{4,5,7})distinct=distinct&&difference(render(48000,127,style,false,false),render(48000,127,style,false,false,0,true))>1e-6;
    const bool edgeIgnoresAuto=difference(render(48000,127,6,false,false),render(48000,127,6,false,false,0,true))==0;
    for(int style=4;style<=7;++style){const auto a=render(48000,127,style,false,true,2),b=render(48000,511,style,false,true,2);partition=juce::jmax(partition,std::sqrt(difference(a,b)));finite=finite&&a.getMagnitude(0,a.getNumSamples())<.892f;}
    auto source=std::make_unique<OpenStudioLimiter>(true),copy=std::make_unique<OpenStudioLimiter>(true);source->prepareToPlay(48000,127);const int latency=source->getLatencySamples();
    for(int style=4;style<=7;++style){state=setFreePluginParamForRegression(*source,"limitingStyleAll",static_cast<float>(style))&&state;juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);state=state&&bytes==again&&copy->limitingStyle.load()==static_cast<float>(style)&&source->getLatencySamples()==latency;}
    const auto schema=describeFreePluginForRegression(*source);state=state&&schema["parameters"][14]["id"].toString()=="limitingStyleAll"&&static_cast<float>(schema["parameters"][6]["max"])==3;
    result->setProperty("plugin","Four original appended limiter strategies");result->setProperty("cases",cases);result->setProperty("finiteAndSampleBound",finite);result->setProperty("distinctStrategiesAndAutomaticRecovery",distinct);result->setProperty("edgeAutomaticRecoveryInactive",edgeIgnoresAuto);result->setProperty("independentAndLinkedChannels",links);result->setProperty("fixtureReconstructedPeakBound",ceiling);result->setProperty("partitionErrorIncludingQualityAndTransition",partition);result->setProperty("stateAndLatencyAppend",state);result->setProperty("schema",schema);result->setProperty("referenceEquivalenceAndArbitraryInputProof","not_asserted");result->setProperty("pass",finite&&distinct&&edgeIgnoresAuto&&links&&ceiling&&partition<1e-6&&state);return result;
}
