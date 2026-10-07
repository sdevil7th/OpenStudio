// Immutable project-local MIDI maps. Mutation/decoding/reclamation stays off audio.
namespace
{
    bool readEQMIDIInteger(const juce::var& value, int low, int high, int& result)
    {
        if (!(value.isInt() || value.isInt64() || value.isDouble())) return false;
        const double number = static_cast<double>(value);
        if (!std::isfinite(number) || number < low || number > high || std::floor(number) != number) return false;
        result = static_cast<int>(number); return true;
    }
}

std::array<float,OpenStudioEQ::MIDIProgramBank::configurationCount> OpenStudioEQ::midiProgramConfiguration() const noexcept
{
    const auto flag=[](float value){return value>=.5f?1.0f:0.0f;};
    return {flag(phaseMode.load()),static_cast<float>(juce::jlimit(0,2,juce::roundToInt(phaseQuality.load()))),flag(minimumPhaseFIR.load()),flag(analogResponse.load()),flag(spectralProcessing.load()),flag(linearBandDynamics.load()),flag(externalDetector.load())};
}
void OpenStudioEQ::publishMIDIPrograms(std::unique_ptr<MIDIProgramBank> next)
{
    if(next)
    {
        juce::uint64 hash=1469598103934665603ULL;const auto add=[&](juce::uint64 value){hash=(hash^value)*1099511628211ULL;};
        add(static_cast<juce::uint64>(next->enabled));add(static_cast<juce::uint64>(next->channel));add(static_cast<juce::uint64>(next->count));
        for(int i=0;i<next->count;++i){const auto& entry=next->entries[static_cast<size_t>(i)];add(static_cast<juce::uint64>(entry.bank));add(static_cast<juce::uint64>(entry.program));add(static_cast<juce::uint64>(entry.name.hashCode64()));for(float value:entry.values){std::uint32_t bits;std::memcpy(&bits,&value,sizeof(bits));add(bits);}for(float value:entry.configuration){std::uint32_t bits;std::memcpy(&bits,&value,sizeof(bits));add(bits);}}
        next->fingerprint=hash;
    }
    // Reserve retirement storage before changing latency or processor state.
    // A failed allocation must leave the currently published bank untouched.
    if(midiProgramOwner)retiredMIDIPrograms.reserve(retiredMIDIPrograms.size()+1);
    const bool hadPrepared=preparedMIDILatency.load()>=0;
    const int reserved=next&&next->prepared?next->prepared->latency:-1;
    if(reserved>=0)setLatencySamples(reserved);
    else if(hadPrepared&&filtersPrepared){preparePhaseProcessing();resetWetPathState();resetDetectorConfiguration(false);updateFilters(true);}
    preparedMIDITail.store(next&&next->prepared?next->prepared->tailSeconds+reserved/juce::jmax(1.0,cachedSampleRate):0);
    preparedMIDILatency.store(reserved,std::memory_order_release);
    // Retain the old owner before publishing: vector growth may throw, whereas
    // the following pointer publication and unique_ptr move cannot.
    if(midiProgramOwner)retiredMIDIPrograms.push_back(std::move(midiProgramOwner));
    publishedMIDIPrograms.store(next.get(),std::memory_order_seq_cst);
    midiProgramOwner=std::move(next);
    if(midiProgramReaders.load(std::memory_order_seq_cst)==0)retiredMIDIPrograms.clear();
}
bool OpenStudioEQ::editMIDIProgram(const juce::var& edit)
{
    if(!supportsExternalKey()||!edit.isObject())return false;
    const std::lock_guard<std::mutex> lock(midiProgramMutex);
    auto next=midiProgramOwner?std::make_unique<MIDIProgramBank>(*midiProgramOwner):std::make_unique<MIDIProgramBank>();
    if(midiProgramReaders.load(std::memory_order_seq_cst)==0)retiredMIDIPrograms.clear();
    else if(retiredMIDIPrograms.size()>=64)return false;
    const auto action=edit["action"].toString();
    if(action=="configure")
    {
        int channel=0;if(!readEQMIDIInteger(edit["channel"],0,16,channel)||!edit["enabled"].isBool())return false;
        next->enabled=static_cast<bool>(edit["enabled"]);next->channel=channel;
    }
    else if(action=="capture"||action=="remove")
    {
        int bank=0,program=0;if(!readEQMIDIInteger(edit["bank"],0,16383,bank)||!readEQMIDIInteger(edit["program"],0,127,program))return false;
        int slot=0;for(;slot<next->count;++slot)if(next->entries[static_cast<size_t>(slot)].bank==bank&&next->entries[static_cast<size_t>(slot)].program==program)break;
        if(action=="remove")
        {
            if(slot==next->count)return false;
            for(int i=slot;i+1<next->count;++i)next->entries[static_cast<size_t>(i)]=std::move(next->entries[static_cast<size_t>(i+1)]);
            next->entries[static_cast<size_t>(--next->count)]={};
        }
        else
        {
            if(slot==next->count){if(next->count==32)return false;++next->count;}
            auto& entry=next->entries[static_cast<size_t>(slot)];entry.bank=bank;entry.program=program;entry.name=edit["name"].toString().trim().substring(0,80);if(entry.name.isEmpty())entry.name="EQ setting";
            entry.configuration=midiProgramConfiguration();bool coherent=false;
            for(int attempt=0;attempt<3&&!coherent;++attempt)
            {
                const auto revision=midiParameterRevision.load(std::memory_order_acquire);if(revision&1u)continue;
                size_t field=0;visitMIDIProgramParameters([&](auto& parameter,float lo,float hi){const float value=parameter.load();entry.values[field++]=std::isfinite(value)?juce::jlimit(lo,hi,value):lo;});
                std::atomic_thread_fence(std::memory_order_acquire);
                coherent=revision==midiParameterRevision.load(std::memory_order_acquire);
            }
            if(!coherent)return false;
        }
    }
    else if(action=="clear")next->count=0;
    else return false;
    try {if(!prepareMIDIPrograms(*next))return false;publishMIDIPrograms(std::move(next));}catch(...){return false;}
    midiProgramRestoreRejected.store(false);return true;
}
juce::var OpenStudioEQ::midiProgramInfo() const
{
    const std::lock_guard<std::mutex> lock(midiProgramMutex);
    auto* info=new juce::DynamicObject();juce::Array<juce::var> entries;
    info->setProperty("enabled",midiProgramOwner&&midiProgramOwner->enabled);info->setProperty("channel",midiProgramOwner?midiProgramOwner->channel:0);info->setProperty("capacity",32);
    if(midiProgramOwner)for(int i=0;i<midiProgramOwner->count;++i)
    {
        const auto& entry=midiProgramOwner->entries[static_cast<size_t>(i)];auto* item=new juce::DynamicObject();item->setProperty("bank",entry.bank);item->setProperty("program",entry.program);item->setProperty("name",entry.name);item->setProperty("compatible",midiProgramOwner->prepared!=nullptr||entry.configuration==midiProgramConfiguration());entries.add(item);
    }
    info->setProperty("preparedConfigurations",midiProgramOwner&&midiProgramOwner->prepared);
    info->setProperty("reservedLatency",preparedMIDILatency.load()>=0?preparedMIDILatency.load():getLatencySamples());
    info->setProperty("preparationRequiresStopped",true);
    info->setProperty("fingerprint",midiProgramOwner&&(midiProgramOwner->count||midiProgramOwner->enabled||midiProgramOwner->channel)?juce::String::toHexString(static_cast<juce::int64>(midiProgramOwner->fingerprint)):juce::String());
    info->setProperty("entries",entries);const auto observed=midiProgramObservation.load(std::memory_order_acquire);
    info->setProperty("lastProgram",static_cast<int>(observed&127));info->setProperty("lastBank",static_cast<int>((observed>>7)&16383));info->setProperty("lastChannel",static_cast<int>((observed>>21)&15)+1);info->setProperty("lastStatus",static_cast<int>((observed>>25)&7));info->setProperty("sequence",static_cast<juce::int64>(observed>>28));info->setProperty("restoreRejected",midiProgramRestoreRejected.load());return info;
}
void OpenStudioEQ::saveMIDIPrograms(juce::ValueTree& state) const
{
    const std::lock_guard<std::mutex> lock(midiProgramMutex);
    if(!supportsExternalKey()||!midiProgramOwner||(midiProgramOwner->count==0&&!midiProgramOwner->enabled&&midiProgramOwner->channel==0))return;
    juce::ValueTree map("MIDIPrograms");map.setProperty("version",1,nullptr);map.setProperty("enabled",midiProgramOwner->enabled,nullptr);map.setProperty("channel",midiProgramOwner->channel,nullptr);
    for(int i=0;i<midiProgramOwner->count;++i)
    {
        const auto& entry=midiProgramOwner->entries[static_cast<size_t>(i)];juce::ValueTree slot("Slot");slot.setProperty("bank",entry.bank,nullptr);slot.setProperty("program",entry.program,nullptr);slot.setProperty("name",entry.name,nullptr);
        juce::Array<juce::var> values,configuration;for(float value:entry.values)values.add(value);for(float value:entry.configuration)configuration.add(value);slot.setProperty("values",values,nullptr);slot.setProperty("configuration",configuration,nullptr);map.addChild(slot,-1,nullptr);
    }
    state.addChild(map,-1,nullptr);
}
void OpenStudioEQ::restoreMIDIPrograms(const juce::ValueTree& state)
{
    const std::lock_guard<std::mutex> lock(midiProgramMutex);const auto map=state.getChildWithName("MIDIPrograms");
    if(!supportsExternalKey()||!map.isValid()){midiProgramRestoreRejected.store(false);publishMIDIPrograms(nullptr);return;}
    auto next=std::make_unique<MIDIProgramBank>();bool valid=true;
    if(supportsExternalKey()&&map.isValid())
    {
        next->enabled=static_cast<bool>(map.getProperty("enabled",false));int version=0;valid=readEQMIDIInteger(map.getProperty("version"),1,1,version)&&map.getNumChildren()<=32&&readEQMIDIInteger(map.getProperty("channel"),0,16,next->channel)&&map.getProperty("enabled").isBool();
        for(int i=0;valid&&i<map.getNumChildren();++i)
        {
            const auto slot=map.getChild(i);auto& entry=next->entries[static_cast<size_t>(i)];valid=readEQMIDIInteger(slot.getProperty("bank"),0,16383,entry.bank)&&readEQMIDIInteger(slot.getProperty("program"),0,127,entry.program);entry.name=slot.getProperty("name").toString().substring(0,80);
            const auto valuesVar=slot.getProperty("values"),configurationVar=slot.getProperty("configuration");const auto* values=valuesVar.getArray();const auto* configuration=configurationVar.getArray();
            valid=valid&&slot.hasType("Slot")&&entry.bank>=0&&entry.bank<=16383&&entry.program>=0&&entry.program<=127&&values&&configuration&&values->size()==static_cast<int>(entry.values.size())&&configuration->size()==static_cast<int>(entry.configuration.size());
            for(int old=0;valid&&old<i;++old)valid=next->entries[static_cast<size_t>(old)].bank!=entry.bank||next->entries[static_cast<size_t>(old)].program!=entry.program;
            if(!valid)break;
            size_t field=0;visitMIDIProgramParameters([&](auto&,float lo,float hi){const auto& property=(*values)[static_cast<int>(field)];const float value=static_cast<float>(property);valid=valid&&(property.isDouble()||property.isInt()||property.isInt64())&&std::isfinite(value)&&value>=lo&&value<=hi;entry.values[field++]=value;});
            for(size_t f=0;f<entry.configuration.size();++f){const auto& property=(*configuration)[static_cast<int>(f)];const float value=static_cast<float>(property);valid=valid&&(property.isDouble()||property.isInt()||property.isInt64())&&std::isfinite(value)&&value>=0&&value<=(f==1?2.0f:1.0f)&&std::floor(value)==value;entry.configuration[f]=value;}
            if(valid)++next->count;
        }
    }
    if(valid)try {valid=prepareMIDIPrograms(*next);}catch(...){valid=false;}
    if(!valid)next.reset();
    midiProgramRestoreRejected.store(!valid);
    publishMIDIPrograms(std::move(next));
}
void OpenStudioEQ::observeMIDIProgram(int bank,int program,int channel,int status) noexcept
{
    static_assert(std::atomic<juce::uint64>::is_always_lock_free);
    const auto packed=(static_cast<juce::uint64>(++midiProgramSerial)<<28)|(static_cast<juce::uint64>(status)<<25)|(static_cast<juce::uint64>(channel)<<21)|(static_cast<juce::uint64>(bank)<<7)|static_cast<juce::uint64>(program);
    midiProgramObservation.store(packed,std::memory_order_release);
}
void OpenStudioEQ::processBlock(juce::AudioBuffer<float>& buffer,juce::MidiBuffer& midi)
{
    if(!supportsExternalKey()){processEQAudioBlock(buffer);return;}
    struct Reader{std::atomic<std::uint32_t>& count;explicit Reader(std::atomic<std::uint32_t>& c):count(c){count.fetch_add(1,std::memory_order_seq_cst);}~Reader(){count.fetch_sub(1,std::memory_order_seq_cst);}} reader(midiProgramReaders);
    const auto* map=publishedMIDIPrograms.load(std::memory_order_seq_cst);
    auto* prepared=map&&map->enabled?map->prepared.get():nullptr;
    if(!map||!map->enabled||midi.isEmpty()||buffer.getNumChannels()>16)
    {if(prepared)processPreparedMIDI(*prepared,buffer);else processEQAudioBlock(buffer);return;}
    int cursor=0;const int samples=buffer.getNumSamples();
    const auto processUntil=[&](int end)
    {
        if(end<=cursor)return;
        std::array<float*,32> channels{};for(int ch=0;ch<buffer.getNumChannels();++ch)channels[static_cast<size_t>(ch)]=buffer.getWritePointer(ch,cursor);
        juce::AudioBuffer<float> slice(channels.data(),buffer.getNumChannels(),end-cursor);midiProgramSampleOffset=cursor;if(prepared)processPreparedMIDI(*prepared,slice);else processEQAudioBlock(slice);cursor=end;
    };
    for(const auto metadata:midi)
    {
        const auto* bytes=metadata.data;if(metadata.numBytes>0&&bytes[0]==0xff){midiBankMSB.fill(0);midiBankLSB.fill(0);continue;}if(metadata.numBytes<2)continue;const int status=bytes[0]&0xf0,channel=bytes[0]&15;
        if(status==0xb0&&metadata.numBytes>=3){if(bytes[1]==0)midiBankMSB[static_cast<size_t>(channel)]=bytes[2]&127;else if(bytes[1]==32)midiBankLSB[static_cast<size_t>(channel)]=bytes[2]&127;continue;}
        if(status!=0xc0||(map->channel!=0&&map->channel!=channel+1))continue;
        const int bank=(midiBankMSB[static_cast<size_t>(channel)]<<7)|midiBankLSB[static_cast<size_t>(channel)],program=bytes[1]&127;const MIDIProgramBank::Entry* selected=nullptr;
        for(int i=0;i<map->count;++i){const auto& entry=map->entries[static_cast<size_t>(i)];if(entry.bank==bank&&entry.program==program){selected=&entry;break;}}
        if(!selected){observeMIDIProgram(bank,program,channel,2);continue;}
        if(!prepared&&selected->configuration!=midiProgramConfiguration()){observeMIDIProgram(bank,program,channel,3);continue;}
        processUntil(juce::jlimit(0,samples,metadata.samplePosition));midiParameterRevision.fetch_add(1,std::memory_order_acq_rel);if(prepared)applyMIDIConfiguration(selected->configuration);size_t field=0;visitMIDIProgramParameters([&](auto& parameter,float,float){parameter.store(selected->values[field++],std::memory_order_relaxed);});midiParameterRevision.fetch_add(1,std::memory_order_release);if(prepared)selectPreparedMIDI(*prepared,static_cast<int>(selected-map->entries.data()));observeMIDIProgram(bank,program,channel,1);
    }
    processUntil(samples);midiProgramSampleOffset=0;
}

void OpenStudioEQ::getStateInformation(juce::MemoryBlock& destination)
{
    // Copy only atomics inside the revision window. Tree allocation/serialization
    // follows after the snapshot, so a dense MIDI stream cannot tear a preset.
    std::array<float, MIDIProgramBank::valueCount> snapshot{};
    std::array<float, MIDIProgramBank::configurationCount> configuration{};
    for (;;)
    {
        const auto revision = midiParameterRevision.load(std::memory_order_acquire);
        if ((revision & 1u) == 0)
        {
            size_t field = 0;
            visitMIDIProgramParameters([&](auto& parameter, float, float) { snapshot[field++] = parameter.load(); });
            configuration=midiProgramConfiguration();
            std::atomic_thread_fence(std::memory_order_acquire);
            if (revision == midiParameterRevision.load(std::memory_order_acquire)) break;
        }
        juce::Thread::yield(); // Message/serialization thread only; never the audio callback.
    }
    getEQStateInformationRaw(destination, snapshot, configuration);
}
