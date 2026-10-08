#pragma once

inline juce::var checkAdvancedEQCuts()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "EQ continuous/brickwall FIR targets and All Pass");
    bool responsePass = true, allPass = true, recall = true, descriptors = true, finite = true;
    double graphError = 0, symmetryError = 0, allPassMagnitudeError = 0;
    juce::Array<juce::var> cases;
    const auto render = [](OpenStudioEQ& eq, int length)
    {
        juce::AudioBuffer<float> output(2, length), block(2, 127); juce::MidiBuffer midi;
        for (int start = 0; start < length; start += 127)
        {
            const int count = juce::jmin(127, length - start); block.setSize(2, count, false, false, true); block.clear();
            if (start == 0) { block.setSample(0,0,.01f); block.setSample(1,0,.01f); }
            eq.processBlock(block,midi); for (int channel = 0; channel < 2; ++channel) output.copyFrom(channel,start,block,channel,0,count);
        }
        return output;
    };
    const auto response = [](const juce::AudioBuffer<float>& audio, double rate, double hz)
    {
        const auto z = std::polar(1.0,-juce::MathConstants<double>::twoPi*hz/rate);
        std::complex<double> phase=1, value=0;
        for (int i=0;i<audio.getNumSamples();++i) { value+=phase*static_cast<double>(audio.getSample(0,i));phase*=z; }
        return value/.01;
    };
    for (double rate : {44100.0,48000.0,96000.0,192000.0})
    {
        for (int shape : {3,4}) for (int mode : {1,2})
        {
            auto eq=std::make_unique<OpenStudioEQ>(true);eq->setNonRealtime(true);
            for(auto& band:eq->bands)band.enabled.store(0);
            eq->bands[0].enabled.store(1);eq->bands[0].type.store(static_cast<float>(shape));eq->bands[0].freq.store(2000);
            eq->bands[0].cutMode.store(static_cast<float>(mode));eq->bands[0].continuousSlope.store(15);
            eq->setPhaseConfiguration(1,1);eq->prepareToPlay(rate,127);
            const auto audio=render(*eq,5000);const int centre=eq->getLatencySamples();
            for(int i=0;i<audio.getNumSamples();++i)finite=finite&&std::isfinite(audio.getSample(0,i));
            for(int i=0;i<=2048;++i)symmetryError=juce::jmax(symmetryError,std::abs(static_cast<double>(audio.getSample(0,centre-i)-audio.getSample(0,centre+i))));
            const std::vector<float> frequencies{500,1000,2000,4000,8000};const auto graph=eq->getMagnitudeResponse(frequencies);
            juce::Array<juce::var> measured;
            for(size_t i=0;i<frequencies.size();++i)
            {
                const double db=juce::Decibels::gainToDecibels(std::abs(response(audio,rate,frequencies[i])),-100.0);measured.add(db);
                // Below -60 dB, tiny FIR/FFT errors are not useful relative-dB assertions.
                if(db>-60)graphError=juce::jmax(graphError,std::abs(db-graph[i]));
                if(mode==1)
                {
                    const double ratio=std::tan(juce::MathConstants<double>::pi*frequencies[i]/rate)/std::tan(juce::MathConstants<double>::pi*2000/rate);
                    const double ideal=-10*std::log10(1+std::pow(shape==3?1/ratio:ratio,5.0));
                    responsePass=responsePass&&std::abs(db-ideal)<.3;
                }
                else if(i!=2)responsePass=responsePass&&((shape==3?frequencies[i]<2000:frequencies[i]>2000)?db<-55:std::abs(db)<.03);
                else responsePass=responsePass&&std::abs(db+6.0206)<.12;
            }
            auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("shape",shape);row->setProperty("target",mode);row->setProperty("responseDb",measured);cases.add(row);
        }
        auto eq=std::make_unique<OpenStudioEQ>(true);for(auto& band:eq->bands)band.enabled.store(0);
        eq->bands[1].enabled.store(1);eq->bands[1].freq.store(2000);eq->bands[1].q.store(.7071f);eq->bands[1].allPass.store(1);eq->prepareToPlay(rate,127);
        const auto audio=render(*eq,4096);
        for(double hz:{100.0,1000.0,2000.0,8000.0})allPassMagnitudeError=juce::jmax(allPassMagnitudeError,std::abs(std::abs(response(audio,rate,hz))-1));
        const auto atCutoff=response(audio,rate,2000);allPass=allPass&&atCutoff.real()<-.999&&std::abs(atCutoff.imag())<.001&&eq->getLatencySamples()==0;
        eq->setNonRealtime(true);eq->setPhaseConfiguration(1,0);eq->prepareToPlay(rate,127);const auto linear=render(*eq,2048);
        for(int i=0;i<linear.getNumSamples();++i)allPass=allPass&&linear.getSample(0,i)==(i==eq->getLatencySamples()?.01f:0);
    }
    auto original=std::make_unique<OpenStudioEQ>(true),restored=std::make_unique<OpenStudioEQ>(true);
    original->bands[23].allPass.store(1);original->bands[22].cutMode.store(2);original->bands[21].continuousSlope.store(17.5f);
    juce::MemoryBlock state,again;original->getStateInformation(state);restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));restored->getStateInformation(again);recall=state==again;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(int b=0;b<24;++b)for(const auto* field:{"allPass","cutMode","continuousSlope"})tree.removeProperty("band"+juce::String(b)+"_"+field,nullptr);
    juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);tree.writeToStream(stream);restored->setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));
    for(const auto& band:restored->bands)recall=recall&&band.allPass.load()==0&&band.cutMode.load()==0&&band.continuousSlope.load()==12;
    const auto schema=describeFreePluginForRegression(*original);const auto& params=schema["parameters"];
    descriptors=params.size()>=465&&params[393]["id"].toString()=="band0.cutMode"&&params[441]["id"].toString()=="band0.allPass";
    for(const auto& param:*params.getArray())if(param["id"].toString().endsWith(".type"))descriptors=descriptors&&static_cast<int>(param["max"])==6;
    result->setProperty("pass",finite&&responsePass&&graphError<.03&&symmetryError<1e-8&&allPass&&allPassMagnitudeError<.0002&&recall&&descriptors);
    result->setProperty("finite",finite);result->setProperty("filterTargets",responsePass);result->setProperty("graphErrorDb",graphError);result->setProperty("symmetryError",symmetryError);
    result->setProperty("allPassPhaseAndLinearBypass",allPass);result->setProperty("allPassMagnitudeError",allPassMagnitudeError);result->setProperty("allPassMagnitudeTolerance",.0002);result->setProperty("stateAndLegacyDefaults",recall);result->setProperty("appendedDescriptorsAndLegacyTypeRange",descriptors);
    result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
