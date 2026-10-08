void OpenStudioEQ::applyMIDIConfiguration(const std::array<float,MIDIProgramBank::configurationCount>& values) noexcept
{
    phaseMode.store(values[0]);phaseQuality.store(values[1]);minimumPhaseFIR.store(values[2]);analogResponse.store(values[3]);
    spectralProcessing.store(values[4]);linearBandDynamics.store(values[5]);externalDetector.store(values[6]);
}

std::shared_ptr<BuiltInEQPreparedPrograms> OpenStudioEQ::preparedMIDIView() const
{
    const std::lock_guard<std::mutex> lock(midiProgramMutex);
    return midiProgramOwner?midiProgramOwner->prepared:nullptr;
}

bool OpenStudioEQ::prepareMIDIPrograms(MIDIProgramBank& bank)
{
    bank.prepared.reset();
    const auto configuration=midiProgramConfiguration();
    bool different=false;
    for(int slot=0;slot<bank.count;++slot)different=different||bank.entries[static_cast<size_t>(slot)].configuration!=configuration;
    if(!bank.enabled||!different||!filtersPrepared)return true;
    auto prepared=std::make_shared<BuiltInEQPreparedPrograms>();
    prepared->block=juce::jmax(1,msScratch.getNumSamples());prepared->fadeLength=juce::jmax(1,juce::roundToInt(cachedSampleRate*.02));
    prepared->voices.reserve(static_cast<size_t>(bank.count+1));
    std::array<float,MIDIProgramBank::valueCount> current{};size_t field=0;
    visitMIDIProgramParameters([&](auto& parameter,float,float){current[field++]=parameter.load();});
    for(int slot=0;slot<=bank.count;++slot)
    {
        const auto& values=slot==0?current:bank.entries[static_cast<size_t>(slot-1)].values;
        const auto& mode=slot==0?configuration:bank.entries[static_cast<size_t>(slot-1)].configuration;
        BuiltInEQPreparedPrograms::Voice voice;voice.engine=std::make_unique<OpenStudioEQ>(true);
        voice.engine->setBusesLayout(getBusesLayout());voice.engine->setNonRealtime(isNonRealtime());
        voice.engine->setRateAndBufferSizeDetails(cachedSampleRate,prepared->block);
        voice.engine->applyMIDIConfiguration(mode);field=0;
        voice.engine->visitMIDIProgramParameters([&](auto& parameter,float,float){parameter.store(values[field++]);});
        voice.engine->prepareToPlay(cachedSampleRate,prepared->block);
        voice.audio.setSize(juce::jmax(2,getTotalNumInputChannels()),prepared->block);
        prepared->latency=juce::jmax(prepared->latency,voice.engine->getLatencySamples());
        prepared->tailSeconds=juce::jmax(prepared->tailSeconds,voice.engine->getTailLengthSeconds());
        prepared->voices.push_back(std::move(voice));
    }
    for(auto& voice:prepared->voices)
    {
        voice.delay=prepared->latency-voice.engine->getLatencySamples();
        voice.alignment.setSize(2,juce::jmax(1,voice.delay));voice.alignment.clear();
    }
    bank.prepared=std::move(prepared);return true;
}

void OpenStudioEQ::rebuildMIDIPrograms()
{
    const std::lock_guard<std::mutex> lock(midiProgramMutex);
    if(!midiProgramOwner)return;
    auto next=std::make_unique<MIDIProgramBank>(*midiProgramOwner);
    if(prepareMIDIPrograms(*next))publishMIDIPrograms(std::move(next));
}

void OpenStudioEQ::selectPreparedMIDI(BuiltInEQPreparedPrograms& bank,int slot) noexcept
{
    const int selected=slot+1;
    bank.displayed.store(selected,std::memory_order_release);
    // Finish a crossfade already audible before starting the latest queued target.
    // Replacing a partially audible voice would introduce a discontinuity.
    if(bank.pending>=0&&bank.fadePosition>0){bank.queued=selected;return;}
    bank.queued=-1;
    if(selected==bank.active){bank.pending=-1;return;}
    bank.pending=selected;bank.voices[static_cast<size_t>(selected)].reset();
    bank.warmRemaining=bank.latency;bank.fadePosition=0;
}

void OpenStudioEQ::processPreparedMIDI(BuiltInEQPreparedPrograms& bank,juce::AudioBuffer<float>& buffer)
{
    const int channels=buffer.getNumChannels();
    if(channels<1||channels>bank.voices[0].audio.getNumChannels()){buffer.clear();return;}
    std::array<float,MIDIProgramBank::valueCount> values{};size_t field=0;
    visitMIDIProgramParameters([&](auto& parameter,float,float){values[field++]=parameter.load();});
    for(int start=0;start<buffer.getNumSamples();start+=bank.block)
    {
        const int count=juce::jmin(bank.block,buffer.getNumSamples()-start);
        const auto render=[&](int index,bool update)
        {
            auto& voice=bank.voices[static_cast<size_t>(index)];
            if(update){size_t next=0;voice.engine->visitMIDIProgramParameters([&](auto& parameter,float,float){parameter.store(values[next++],std::memory_order_relaxed);});}
            voice.engine->setPowerEnabled(powerEnabled.load());voice.engine->setPlayHead(getPlayHead());
            for(int channel=0;channel<voice.audio.getNumChannels();++channel)
                if(channel<channels)voice.audio.copyFrom(channel,0,buffer,channel,start,count);else voice.audio.clear(channel,0,count);
            std::array<float*,4> pointers{};for(int channel=0;channel<channels;++channel)pointers[static_cast<size_t>(channel)]=voice.audio.getWritePointer(channel);
            juce::AudioBuffer<float> view(pointers.data(),channels,count);voice.engine->midiProgramSampleOffset=midiProgramSampleOffset+start;
            voice.engine->processEQAudioBlock(view);voice.align(count);
        };
        render(bank.active,bank.pending<0);if(bank.pending>=0)render(bank.pending,bank.pending==bank.displayed.load());
        const int sounding=bank.active,incoming=bank.pending;
        for(int sample=0;sample<count;++sample)
        {
            float blend=0;
            if(incoming>=0)
            {
                if(bank.warmRemaining>0)--bank.warmRemaining;
                else blend=juce::jmin(1.0f,static_cast<float>(++bank.fadePosition)/static_cast<float>(bank.fadeLength));
            }
            for(int channel=0;channel<juce::jmin(2,channels);++channel)
            {
                const float previous=bank.voices[static_cast<size_t>(sounding)].audio.getSample(channel,sample);
                const float next=incoming>=0?bank.voices[static_cast<size_t>(incoming)].audio.getSample(channel,sample):previous;
                buffer.setSample(channel,start+sample,previous+(next-previous)*blend);
            }
        }
        if(incoming>=0&&bank.fadePosition>=bank.fadeLength)
        {
            bank.active=incoming;bank.pending=-1;
            if(bank.queued>=0){const int target=bank.queued;bank.queued=-1;selectPreparedMIDI(bank,target-1);}
        }
        auto& display=*bank.voices[static_cast<size_t>(bank.displayed.load())].engine;
        for(size_t channel=0;channel<outputPeaks.size();++channel)outputPeaks[channel].store(display.outputPeaks[channel].load());
        for(size_t band=0;band<dynamicGainDB.size();++band){dynamicGainDB[band].store(display.getBandDynamicGainDB(static_cast<int>(band)));const auto controls=display.getBandDynamicControls(static_cast<int>(band));for(size_t control=0;control<3;++control)effectiveDynamicControls[band][control].store(controls[control]);}
    }
    captureMatchOutput(buffer);
}

bool OpenStudioEQ::isLinearPhaseUpdating() const noexcept
{
    if(const auto prepared=preparedMIDIView())return prepared->voices[static_cast<size_t>(prepared->displayed.load())].engine->isLinearPhaseUpdating();
    return linearPhase&&linearPhase->updating();
}
