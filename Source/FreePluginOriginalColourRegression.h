#pragma once

inline juce::var checkOriginalColourStages()
{
    struct Render { std::vector<float> audio; int latency = 0; float reduction = 0; juce::MemoryBlock state; };
    const auto render = [](int model, bool original, float headroom, double rate, int blockSize,
        float amplitude, double frequency, float wet = 1.0f, bool impulse = false, float inputDrive = 0, float outputDrive = 0)
    {
        Render result;
        std::unique_ptr<juce::AudioProcessor> owner;
        OpenStudioCompressor* compressor = nullptr;
        if (model < 0)
        {
            auto preamp = std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::Preamp);
            preamp->setControl("audioCharacter", original ? 1.0f : 0.0f);
            preamp->setControl("headroom", headroom);
            preamp->setControl("drive", inputDrive);
            preamp->setControl("outputDrive", outputDrive);
            preamp->setControl("outputGain", -inputDrive-outputDrive);
            preamp->setControl("colour", 1);
            owner = std::move(preamp);
        }
        else
        {
            auto processor = std::make_unique<OpenStudioCompressor>(true);
            compressor = processor.get(); processor->selectModel(model);
            processor->audioCharacter.store(original ? 1.0f : 0.0f); processor->headroom.store(headroom);
            processor->mix.store(wet); processor->fetRatio.store(5); // Colour without gain reduction.
            for (auto& optical : processor->opticalControls) optical.reduction.store(0);
            processor->fetInput.store(inputDrive); processor->fetOutput.store(outputDrive);
            owner = std::move(processor);
        }
        owner->prepareToPlay(rate, blockSize);
        result.latency = owner->getLatencySamples();
        const int length = juce::roundToInt(rate * (impulse ? .07 : .32));
        result.audio.reserve(static_cast<size_t>(length));
        juce::AudioBuffer<float> buffer(2, blockSize); juce::MidiBuffer midi;
        for (int position = 0; position < length; position += blockSize)
        {
            const int count = juce::jmin(blockSize, length-position); buffer.setSize(2,count,false,false,true);
            for (int i = 0; i < count; ++i)
            {
                const float value = impulse ? (position+i == 0 ? amplitude : 0)
                    : amplitude * static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * frequency * (position+i) / rate));
                buffer.setSample(0,i,value); buffer.setSample(1,i,-value);
            }
            owner->processBlock(buffer,midi);
            result.audio.insert(result.audio.end(),buffer.getReadPointer(0),buffer.getReadPointer(0)+count);
        }
        if (compressor) result.reduction = compressor->getCurrentGainReduction();
        owner->getStateInformation(result.state);
        return result;
    };
    const auto difference = [](const auto& a, const auto& b, double gain = 1.0)
    {
        double worst = 0;
        for (size_t i=0;i<a.size();++i) worst=juce::jmax(worst,std::abs(a[i]-b[i]/gain));
        return worst;
    };
    bool finite = true, tangent = true, monotone = true, partitions = true, headroom = true, dry = true, state = true, character = true;
    double maxPartitionError=0,maxHeadroomError=0;
    juce::Array<juce::var> rows;
    for (int kind=0;kind<6;++kind)
    {
        const auto profile=static_cast<BuiltInOriginalColour::Profile>(kind);
        const double slope=(BuiltInOriginalColour::curve(1.0e-5,profile,.1)-BuiltInOriginalColour::curve(-1.0e-5,profile,.1))/2.0e-5;
        tangent=tangent&&std::abs(slope-1)<1.0e-6;
        double previous=-1.0e9;
        for(int i=-10000;i<=10000;++i)
        {
            const double value=BuiltInOriginalColour::curve(i*.01,profile,.1);
            monotone=monotone&&std::isfinite(value)&&value>=previous;previous=value;
        }
    }
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(int model:{-1,2,3,4,5,6})
        {
            const auto a=render(model,true,0,rate,127,.15f,1000);
            const auto b=render(model,true,0,rate,512,.15f,1000);
            const float factor=juce::Decibels::decibelsToGain(6.0f);
            const auto raised=render(model,true,6,rate,127,.15f*factor,1000);
            const double blockError=difference(a.audio,b.audio);
            const double scaleError=difference(a.audio,raised.audio,factor);
            maxPartitionError=juce::jmax(maxPartitionError,blockError);maxHeadroomError=juce::jmax(maxHeadroomError,scaleError);
            partitions=partitions&&blockError<1.0e-6;headroom=headroom&&scaleError<2.0e-5;
            for(float value:a.audio)finite=finite&&std::isfinite(value)&&std::abs(value)<=2.5f;
            auto* row=new juce::DynamicObject();row->setProperty("model",model);row->setProperty("rate",rate);
            row->setProperty("partitionError",blockError);row->setProperty("headroomSimilarityError",scaleError);row->setProperty("latencySamples",a.latency);rows.add(juce::var(row));
        }
        const auto bypass=render(2,true,0,rate,127,.01f,1000,0,true);
        for(size_t i=0;i<bypass.audio.size();++i)dry=dry&&bypass.audio[i]==(i==static_cast<size_t>(bypass.latency)?.01f:0.0f);
        const auto linear=render(1,true,0,rate,127,.01f,1000,1,true);
        const auto peak=static_cast<int>(std::max_element(linear.audio.begin(),linear.audio.end(),[](float a,float b){return std::abs(a)<std::abs(b);})-linear.audio.begin());
        dry=dry&&peak==linear.latency;
    }
    // Capture spectral diagnostics with coherent 1 kHz / 200 ms analysis after
    // 120 ms settling. These are implementation measurements, not audio quality.
    juce::Array<juce::var> spectra;
    for(int model:{-1,2,3,4,5,6})
    {
        const auto legacy=render(model,false,0,48000,127,.65f,1000);
        const auto original=render(model,true,0,48000,127,.65f,1000);
        juce::Array<juce::var> harmonics;
        for(int h=1;h<=9;++h)
        {
            double real=0,imaginary=0;
            for(int i=5760;i<15360;++i){const double phase=juce::MathConstants<double>::twoPi*1000*h*i/48000;real+=original.audio[static_cast<size_t>(i)]*std::cos(phase);imaginary-=original.audio[static_cast<size_t>(i)]*std::sin(phase);}
            harmonics.add(juce::Decibels::gainToDecibels(std::sqrt(real*real+imaginary*imaginary)/4800,-180.0));
        }
        const int shift=original.latency-legacy.latency;
        double changed=0;
        for(int i=6000;i<14000;++i)changed=juce::jmax(changed,std::abs(static_cast<double>(original.audio[static_cast<size_t>(i+shift)]-legacy.audio[static_cast<size_t>(i)])));
        character=character&&changed>1.0e-4;
        auto* row=new juce::DynamicObject();row->setProperty("model",model);row->setProperty("harmonicDbFS",harmonics);row->setProperty("differentFromLegacy",changed);spectra.add(juce::var(row));
    }
    // Moving gain from before the input stage to before the output stage must
    // differ at matched output. A single final saturator cannot satisfy this.
    const auto inputDriven=render(-1,true,0,48000,127,.15f,120,1,false,12,0);
    const auto outputDriven=render(-1,true,0,48000,127,.15f,120,1,false,0,12);
    character=character&&difference(inputDriven.audio,outputDriven.audio)>1.0e-3;

    OpenStudioCompressor processor(true);processor.selectModel(2);processor.prepareToPlay(48000,127);
    juce::MemoryBlock oldState;processor.getStateInformation(oldState);
    auto tree=juce::ValueTree::readFromData(oldState.getData(),oldState.getSize());
    state=state&&!tree.hasProperty("audioCharacter")&&!tree.hasProperty("headroom");
    const int oldLatency=processor.getLatencySamples();
    tree.setProperty("audioCharacter",1,nullptr);tree.setProperty("headroom",6,nullptr);
    juce::MemoryBlock newState;{juce::MemoryOutputStream stream(newState,false);tree.writeToStream(stream);}
    processor.setStateInformation(newState.getData(),static_cast<int>(newState.getSize()));
    state=state&&processor.getLatencySamples()>oldLatency&&processor.headroom.load()==6;
    processor.setStateInformation(oldState.getData(),static_cast<int>(oldState.getSize()));
    juce::MemoryBlock restored;processor.getStateInformation(restored);
    state=state&&processor.getLatencySamples()==oldLatency&&processor.audioCharacter.load()==0&&processor.headroom.load()==0&&restored==oldState;
    OpenStudioUtilityEffect preampState(OpenStudioUtilityEffect::Kind::Preamp);preampState.prepareToPlay(48000,127);
    juce::MemoryBlock preampLegacy;preampState.getStateInformation(preampLegacy);const int preampLegacyLatency=preampState.getLatencySamples();
    preampState.setControl("audioCharacter",1);const int preampOriginalLatency=preampState.getLatencySamples();
    juce::MemoryBlock preampOriginal;preampState.getStateInformation(preampOriginal);
    preampState.setStateInformation(preampLegacy.getData(),static_cast<int>(preampLegacy.getSize()));
    juce::MemoryBlock preampRestored;preampState.getStateInformation(preampRestored);
    state=state&&preampOriginalLatency>preampLegacyLatency&&preampState.getLatencySamples()==preampLegacyLatency&&preampRestored==preampLegacy;
    preampState.setStateInformation(preampOriginal.getData(),static_cast<int>(preampOriginal.getSize()));
    state=state&&preampState.getLatencySamples()==preampOriginalLatency&&preampState.values[12].load()==1;
    OpenStudioCompressor nam(false);nam.audioCharacter.store(1);nam.headroom.store(12);juce::MemoryBlock namState;nam.getStateInformation(namState);
    state=state&&!juce::ValueTree::readFromData(namState.getData(),namState.getSize()).hasProperty("audioCharacter");
    bool vcaResponseEngines = true;
    double maximumVCAStageError = 0;
    for (int selected : {5, 6}) for (int responseEngine : {0, 1})
    {
        OpenStudioCompressor vca(true);
        vca.selectModel(selected); vca.audioCharacter.store(1);
        vca.ratio.store(1); vca.makeupGain.store(0); vca.autoMakeup.store(0);
        auto& controls = vca.vcaControls[static_cast<size_t>(selected - 5)];
        controls.engine.store(static_cast<float>(responseEngine)); controls.routing.store(0);
        for (auto& channel : controls.channels)
        {
            channel[BuiltInVCACompressor::Input].store(0);
            channel[BuiltInVCACompressor::Output].store(0);
            channel[BuiltInVCACompressor::Threshold].store(selected == 5 ? -10.0f : -9.0f);
        }
        vca.prepareToPlay(48000, 127);
        BuiltInOversampledColour singleStage;
        singleStage.prepare(48000, selected == 5 ? BuiltInOriginalColour::BusVCA : BuiltInOriginalColour::PunchVCA);
        const int dryDelay = vca.getLatencySamples() - singleStage.latencySamples();
        const auto signal = [](int sample) { return sample < 0 ? 0.0f : .18f * std::sin(juce::MathConstants<float>::twoPi * 1000 * static_cast<float>(sample) / 48000); };
        juce::AudioBuffer<float> audio(2, 127); juce::MidiBuffer midi;
        double colourDifference = 0;
        for (int position = 0; position < 12065; position += 127)
        {
            for (int i = 0; i < 127; ++i) { const auto value = signal(position + i); audio.setSample(0, i, value); audio.setSample(1, i, -.7f * value); }
            vca.processBlock(audio, midi);
            for (int i = 0; i < 127; ++i)
            {
                const auto delayed = signal(position + i - dryDelay);
                const auto expected = singleStage.process({delayed, -.7f * delayed}, {1, 1}, {1, 1}, {1, 1});
                for (int ch = 0; ch < 2; ++ch)
                    maximumVCAStageError = juce::jmax(maximumVCAStageError, std::abs(static_cast<double>(audio.getSample(ch, i) - expected[static_cast<size_t>(ch)])));
                if (position > 6000) colourDifference = juce::jmax(colourDifference, std::abs(static_cast<double>(audio.getSample(0, i) - signal(position + i - vca.getLatencySamples()))));
            }
        }
        // Below the key threshold, either dynamics engine must match exactly
        // one amplifier pair. This rejects both lost and double-applied colour.
        vcaResponseEngines = vcaResponseEngines && colourDifference > 1.0e-4 && vca.getCurrentGainReduction() > -.001f;
    }
    vcaResponseEngines = vcaResponseEngines && maximumVCAStageError < 2.0e-6;
    bool transitions=true;
    OpenStudioCompressor changing(true);changing.audioCharacter.store(1);changing.selectModel(3);changing.prepareToPlay(48000,127);
    juce::AudioBuffer<float> transitionBuffer(2,127);juce::MidiBuffer transitionMidi;
    int sample=0;
    for(int next:{3,5,0,4,6,2,1,3,6,0})
    {
        changing.selectModel(next);
        for(auto& vca:changing.vcaControls)vca.routing.store(static_cast<float>(next%3));
        for(int block=0;block<12;++block)
        {
            for(int i=0;i<127;++i,++sample){const float value=.2f*std::sin(juce::MathConstants<float>::twoPi*173*static_cast<float>(sample)/48000);transitionBuffer.setSample(0,i,value);transitionBuffer.setSample(1,i,-.7f*value);}
            changing.processBlock(transitionBuffer,transitionMidi);
            for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)transitions=transitions&&std::isfinite(transitionBuffer.getSample(ch,i))&&std::abs(transitionBuffer.getSample(ch,i))<=2.5f;
        }
    }
    bool tails=true;double maximumTailResidue=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int model:{-1,2,3,4,5,6})
    {
        std::unique_ptr<juce::AudioProcessor> owner;
        if(model<0)
        {
            auto preamp=std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::Preamp);
            tails=tails&&preamp->getTailLengthSeconds()==0;
            preamp->setControl("audioCharacter",1);preamp->setControl("colour",1);preamp->setControl("drive",36);preamp->setControl("outputDrive",24);preamp->setControl("headroom",12);owner=std::move(preamp);
        }
        else
        {
            auto compressor=std::make_unique<OpenStudioCompressor>(true);compressor->selectModel(model);
            tails=tails&&compressor->getTailLengthSeconds()==0;
            compressor->audioCharacter.store(1);compressor->headroom.store(12);compressor->fetInput.store(36);compressor->fetOutput.store(24);compressor->fetRatio.store(5);
            for(auto& optical:compressor->opticalControls){optical.reduction.store(0);optical.gain.store(40);}
            owner=std::move(compressor);
        }
        owner->prepareToPlay(rate,127);tails=tails&&owner->getTailLengthSeconds()==1;
        juce::AudioBuffer<float> audio(2,127);juce::MidiBuffer midi;
        const int onset=juce::roundToInt(rate*.1),tailEnd=onset+juce::roundToInt(rate*owner->getTailLengthSeconds()),finish=tailEnd+juce::roundToInt(rate*.1);
        for(int position=0;position<finish;position+=127)
        {
            const int count=juce::jmin(127,finish-position);audio.setSize(2,count,false,false,true);
            // A DC pulse deliberately charges both slow DC-rejection memories.
            for(int i=0;i<count;++i){audio.setSample(0,i,position+i<onset?.9f:0);audio.setSample(1,i,position+i<onset?-.6f:0);}
            owner->processBlock(audio,midi);
            for(int i=0;i<count;++i)if(position+i>=tailEnd)for(int ch=0;ch<2;++ch)maximumTailResidue=juce::jmax(maximumTailResidue,std::abs(static_cast<double>(audio.getSample(ch,i))));
        }
    }
    tails=tails&&maximumTailResidue<1.0e-6;
    juce::Array<juce::var> processingCost;
    for(bool preamp:{false,true})for(bool original:{false,true})
    {
        std::unique_ptr<juce::AudioProcessor> owner;
        if(preamp){auto effect=std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::Preamp);effect->setControl("audioCharacter",original?1.0f:0.0f);owner=std::move(effect);}
        else {auto effect=std::make_unique<OpenStudioCompressor>(true);effect->selectModel(2);effect->audioCharacter.store(original?1.0f:0.0f);owner=std::move(effect);}
        owner->prepareToPlay(48000,128);juce::AudioBuffer<float> audio(2,128);juce::MidiBuffer midi;
        for(int block=0;block<20;++block){audio.clear();owner->processBlock(audio,midi);}
        const double begin=juce::Time::getMillisecondCounterHiRes();
        for(int block=0;block<200;++block)
        {
            for(int i=0;i<128;++i){const float value=.2f*std::sin(juce::MathConstants<float>::twoPi*1000*static_cast<float>(block*128+i)/48000);audio.setSample(0,i,value);audio.setSample(1,i,value);}
            owner->processBlock(audio,midi);
        }
        auto* cost=new juce::DynamicObject();cost->setProperty("processor",preamp?"Preamp":"FET compressor");cost->setProperty("audioCharacter",original?"Original stages":"Legacy");cost->setProperty("millisecondsFor200Blocks128",juce::Time::getMillisecondCounterHiRes()-begin);cost->setProperty("audioDurationMs",200.0*128/48);cost->setProperty("status","diagnostic_only");processingCost.add(juce::var(cost));
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Original preamp / compressor amplifier stages");
    result->setProperty("pass",finite&&tangent&&monotone&&partitions&&headroom&&dry&&state&&character&&transitions&&tails&&vcaResponseEngines);
    result->setProperty("finite",finite);result->setProperty("unitSmallSignalTangent",tangent);result->setProperty("monotoneStaticCurves",monotone);
    result->setProperty("blockPartitionInvariant",partitions);result->setProperty("headroomScaleSimilarity",headroom);result->setProperty("dryAndLinearLatency",dry);result->setProperty("stateAndLatencyRestore",state);result->setProperty("independentStagesAndColour",character);
    result->setProperty("maxPartitionError",maxPartitionError);result->setProperty("maxHeadroomError",maxHeadroomError);result->setProperty("cases",rows);result->setProperty("spectralDiagnostics",spectra);
    result->setProperty("modelAndRoutingTransitionsFinite",transitions);
    result->setProperty("vcaBothResponseEnginesSingleColourStage",vcaResponseEngines);
    result->setProperty("maximumVCAStageError",maximumVCAStageError);
    result->setProperty("processingCostDiagnostic",processingCost);result->setProperty("processingCostScope","Single instance,48kHz/128,20 warmup and200 timed blocks including sine fill; build/machine dependent, not a device-safety or release-performance gate.");
    result->setProperty("declaredTailBound",tails);result->setProperty("tailResidueAfterOneSecond",maximumTailResidue);result->setProperty("tailScope",juce::String::fromUTF8("Intentional Punch noise disabled; max-drive DC pulse followed by1s decay and100ms observation, four sample rates, silence below−120dBFS."));
    result->setProperty("commercialFidelity","not_asserted");result->setProperty("listeningAcceptance","not_asserted");result->setProperty("broadbandAliasingAndIMD","diagnostic_followup_required");
    return juce::var(result);
}
