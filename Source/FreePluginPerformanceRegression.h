#pragma once

// Timings are measurements, not an audio-quality test or driver qualification.
using FreeSuiteMake=std::function<std::unique_ptr<juce::AudioProcessor>()>;
inline std::vector<std::pair<const char*,FreeSuiteMake>> freeSuiteFactories()
{
    return {
        {"EQ",[]{return std::make_unique<OpenStudioEQ>(true);}},
        {"Graphic EQ",[]{return std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::GraphicEQ);}},
        {"Compressor",[]{return std::make_unique<OpenStudioCompressor>(true);}},
        {"Gate",[]{return std::make_unique<OpenStudioGate>(true);}},
        {"Limiter",[]{return std::make_unique<OpenStudioLimiter>(true);}},
        {"Preamp",[]{return std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::Preamp);}},
        {"Saturator",[]{return std::make_unique<OpenStudioSaturator>();}},
        {"Reverb",[]{return std::make_unique<OpenStudioReverb>(true);}},
        {"Delay",[]{return std::make_unique<OpenStudioDelay>(24.1f,true);}},
        {"Chorus",[]{return std::make_unique<OpenStudioChorus>();}},
        {"Gain Phase",[]{return std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::GainPhase);}},
        {"Pitch Correct",[]{return std::make_unique<OpenStudioPitchCorrector>();}},
        {"Synth",[]{return std::make_unique<OpenStudioBasicSynthInstrument>();}},
        {"Piano",[]{return std::make_unique<OpenStudioPianoInstrument>();}},
        {"Guitar",[]{return std::make_unique<OpenStudioCleanGuitarInstrument>();}},
        {"Drums",[]{return std::make_unique<OpenStudioDrumInstrument>();}}
    };
}
inline juce::var describeSuiteEditors()
{
    auto* result=new juce::DynamicObject();juce::Array<juce::var> schemas;
    for(const auto& entry:freeSuiteFactories()){auto processor=entry.second();schemas.add(describeFreePluginForRegression(*processor));}
    OpenStudioNAMRack rack; schemas.add(describeFreePluginForRegression(rack));
    result->setProperty("plugin","Current suite editor schemas");result->setProperty("schemas",schemas);result->setProperty("pass",schemas.size()==17);return result;
}
juce::var measureFreePluginPerformance()
{
    const auto factories=freeSuiteFactories();
    const auto memory=[]()->juce::int64 {
       #if JUCE_WINDOWS
        PROCESS_MEMORY_COUNTERS_EX value{};value.cb=sizeof(value);
        if(K32GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&value),sizeof(value)))
            return static_cast<juce::int64>(value.PrivateUsage);
       #endif
        return -1;
    };
    juce::Array<juce::var> cases;bool finite=true;
    constexpr double rate=48000;constexpr int block=128,warmup=128,iterations=1024;
    for(const auto& entry:factories)
    {
        const auto before=memory();auto processor=entry.second();
        processor->setRateAndBufferSizeDetails(rate,block);processor->prepareToPlay(rate,block);
        const auto prepared=memory();
        const int channels=juce::jmax(2,processor->getTotalNumOutputChannels());
        juce::AudioBuffer<float> audio(channels,block);juce::MidiBuffer midi;midi.ensureSize(2048);
        for(const bool idle:{false,true})
        {
            processor->reset();std::vector<double> times;times.reserve(iterations);int overruns=0;double peak=0;
            const auto steadyStart=memory();
            for(int frame=-warmup;frame<iterations;++frame)
            {
                audio.clear();midi.clear();
                if(!idle)
                {
                    for(int sample=0;sample<block;++sample){const float value=.08f*std::sin(.0575959f*static_cast<float>((frame+warmup)*block+sample));audio.setSample(0,sample,value);audio.setSample(1,sample,value*.8f);}
                    if(processor->acceptsMidi()&&(frame+warmup)%64==0)
                    {
                        midi.addEvent(juce::MidiMessage::allNotesOff(1),0);
                        for(int note:std::array<int,4>{36,38,42,51})midi.addEvent(juce::MidiMessage::noteOn(1,note,.65f),0);
                    }
                }
                const auto start=juce::Time::getHighResolutionTicks();processor->processBlock(audio,midi);
                const double micros=juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks()-start)*1e6;
                if(frame>=0){times.push_back(micros);if(micros>block/rate*1e6)++overruns;}
                for(int channel=0;channel<channels;++channel)for(int sample=0;sample<block;++sample){const float value=audio.getSample(channel,sample);finite=finite&&std::isfinite(value);peak=juce::jmax(peak,std::abs(static_cast<double>(value)));}
            }
            std::sort(times.begin(),times.end());
            auto* item=new juce::DynamicObject();item->setProperty("plugin",entry.first);item->setProperty("mode",idle?"idle after reset":"factory active, four MIDI notes when accepted");
            item->setProperty("rate",rate);item->setProperty("block",block);item->setProperty("channels",channels);item->setProperty("iterations",iterations);
            item->setProperty("medianUs",times[times.size()/2]);item->setProperty("p95Us",times[times.size()*95/100]);item->setProperty("p99Us",times[times.size()*99/100]);item->setProperty("maxUs",times.back());item->setProperty("deadlineOverruns",overruns);
            item->setProperty("privateBytesBefore",before);item->setProperty("privateBytesPrepared",prepared);item->setProperty("incrementalPrivateBytes",prepared-before);item->setProperty("steadyPrivateGrowthBytes",memory()-steadyStart);item->setProperty("peak",peak);cases.add(item);
        }
        processor->releaseResources();
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Suite performance screen");result->setProperty("pass",finite);result->setProperty("finite",finite);result->setProperty("cases",cases);
    result->setProperty("cpu",juce::SystemStats::getCpuModel());result->setProperty("logicalCpus",juce::SystemStats::getNumCpus());result->setProperty("os",juce::SystemStats::getOperatingSystemName());
    #if JUCE_DEBUG
    result->setProperty("build","Debug: diagnostic_only");
   #else
    result->setProperty("build","Release optimized");
   #endif
    result->setProperty("compiled",juce::String(__DATE__)+" "+__TIME__);
    result->setProperty("scope","Editor closed, sequential in-process warmed callbacks; private commit deltas include allocator retention. Finite output is the only pass assertion. Timings do not certify device dropout behavior.");return result;
}
