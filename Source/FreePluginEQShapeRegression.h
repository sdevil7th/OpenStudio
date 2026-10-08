#pragma once

inline juce::var checkExtendedEQShapes()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "EQ tilt, Gain-Q and extended frequency");
    bool finite = true, curves = true, interaction = true, ranges = true, recall = true;
    double graphError = 0; juce::Array<juce::var> cases;
    const auto render = [](OpenStudioEQ& eq, int length)
    {
        juce::AudioBuffer<float> output(2,length), block(2,127); juce::MidiBuffer midi;
        for (int start = 0; start < length; start += 127)
        {
            const int count = juce::jmin(127,length-start); block.setSize(2,count,false,false,true); block.clear();
            if (start == 0) {block.setSample(0,0,.001f);block.setSample(1,0,.001f);}
            eq.processBlock(block,midi); for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);
        }
        return output;
    };
    const auto measured = [](const juce::AudioBuffer<float>& audio,double rate,float frequency)
    {
        const auto z = std::polar(1.0,-juce::MathConstants<double>::twoPi*frequency/rate);std::complex<double> phase=1,sum=0;
        for(int i=0;i<audio.getNumSamples();++i){sum+=phase*static_cast<double>(audio.getSample(0,i));phase*=z;}
        return juce::Decibels::gainToDecibels(std::abs(sum)/.001,-100.0);
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(int shape:{8,9})for(int phase:{0,1})
        {
            auto eq=std::make_unique<OpenStudioEQ>(true);eq->setNonRealtime(true);
            for(auto& band:eq->bands)band.enabled.store(0);
            eq->bands[1].enabled.store(1);eq->bands[1].type.store(static_cast<float>(shape));eq->bands[1].freq.store(1000);eq->bands[1].gain.store(6);eq->bands[1].q.store(.7071f);
            eq->setPhaseConfiguration(static_cast<float>(phase),1);eq->prepareToPlay(rate,127);
            const auto audio=render(*eq,static_cast<int>(rate*.5)+eq->getLatencySamples());
            for(int i=0;i<audio.getNumSamples();++i)finite=finite&&std::isfinite(audio.getSample(0,i))&&std::abs(audio.getSample(0,i))<.02;
            const std::vector<float> frequencies{100,300,1000,3000,10000};const auto graph=eq->getMagnitudeResponse(frequencies);juce::Array<juce::var> values;
            for(size_t i=0;i<frequencies.size();++i){const double db=measured(audio,rate,frequencies[i]);graphError=juce::jmax(graphError,std::abs(db-graph[i]));values.add(db);}
            curves=curves&&graph.front()< -1&&graph.back()>1;
            if(phase==0)curves=curves&&std::abs(graph[2])<.04f;
            auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("shape",shape);row->setProperty("phase",phase);row->setProperty("responseDb",values);cases.add(row);
        }
        auto eq=std::make_unique<OpenStudioEQ>(true);for(auto& band:eq->bands)band.enabled.store(0);
        auto& band=eq->bands[1];band.enabled.store(1);band.freq.store(1000);band.q.store(4);band.gain.store(12);eq->prepareToPlay(rate,127);
        const std::vector<float> frequencies{800,1000,1200};const auto plain=eq->getMagnitudeResponse(frequencies);band.gainQInteraction.store(1);const auto coupled=eq->getMagnitudeResponse(frequencies);
        interaction=interaction&&std::abs(plain[1]-12)<.02&&std::abs(coupled[1]-12.96)<.02&&coupled[0]<plain[0];
        for(float frequency:{10.0f,30000.0f})for(int shape:{0,8,9})
        {
            band.freq.store(frequency);band.type.store(static_cast<float>(shape));band.q.store(1);band.gain.store(6);band.gainQInteraction.store(0);eq->prepareToPlay(rate,127);
            const auto audio=render(*eq,static_cast<int>(rate*.25));
            for(int i=0;i<audio.getNumSamples();++i)finite=finite&&std::isfinite(audio.getSample(0,i))&&std::abs(audio.getSample(0,i))<.2;
        }
    }
    auto eq=std::make_unique<OpenStudioEQ>(true),copy=std::make_unique<OpenStudioEQ>(true);
    for(float normalized:{0.0f,.5f,1.0f})
    {
        ranges=ranges&&setFreePluginNormalizedForRegression(*eq,"band1.freq",normalized)&&eq->bands[1].freq.load()==20+19980*normalized;
        ranges=ranges&&setFreePluginNormalizedForRegression(*eq,"band1.frequencyExtended",normalized)&&eq->bands[1].freq.load()==10+29990*normalized;
        ranges=ranges&&setFreePluginNormalizedForRegression(*eq,"band1.type",normalized)&&eq->bands[1].type.load()==6*normalized;
    }
    ranges=ranges&&setFreePluginParamForRegression(*eq,"band1.typeExpanded",9)&&setFreePluginParamForRegression(*eq,"band1.frequencyExtended",30000)&&setFreePluginParamForRegression(*eq,"band1.gainQInteraction",1);
    juce::MemoryBlock state,again;eq->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);
    recall=state==again&&copy->bands[1].type.load()==9&&copy->bands[1].freq.load()==30000&&copy->bands[1].gainQInteraction.load()==1;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());tree.removeProperty("band1_gainQInteraction",nullptr);
    juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->bands[1].gainQInteraction.load()==0;
    const auto schema=describeFreePluginForRegression(*eq);
    const bool appended=schema["parameters"].size() >= 715&&schema["parameters"][643]["id"].toString()=="band0.typeExpanded";
    result->setProperty("pass",finite&&curves&&interaction&&ranges&&recall&&appended&&graphError<.12);
    result->setProperty("finiteAtFourRatesAndRangeEdges",finite);result->setProperty("tiltCurves",curves);result->setProperty("gainQInteraction",interaction);
    result->setProperty("preservedAutomationRanges",ranges);result->setProperty("stateAndDefaults",recall);result->setProperty("appended",appended);
    result->setProperty("maximumGraphErrorDb",graphError);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("referenceCurveEquivalence", "not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}
