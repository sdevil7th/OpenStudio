#pragma once
#include "BuiltInContinuousAlignment.h"

inline juce::var measureFreeSuiteStress()
{
    using Make=std::function<std::unique_ptr<juce::AudioProcessor>()>;
    const std::vector<std::pair<const char*,Make>> factories{
        {"EQ 32 prepared mixed-configuration programs",[]{auto p=std::make_unique<OpenStudioEQ>(true);for(int slot=0;slot<32;++slot){p->phaseMode.store(slot%2?1.0f:0.0f);p->phaseQuality.store(2);p->spectralProcessing.store(slot%3==0?1.0f:0.0f);p->outputGain.store(static_cast<float>(slot%8-8));auto* edit=new juce::DynamicObject();edit->setProperty("action","capture");edit->setProperty("bank",0);edit->setProperty("program",slot);edit->setProperty("name","Prepared stress");p->editMIDIProgram(juce::var(edit));}p->phaseMode.store(0);auto* enable=new juce::DynamicObject();enable->setProperty("action","configure");enable->setProperty("enabled",true);enable->setProperty("channel",0);p->editMIDIProgram(juce::var(enable));return p;}},
        {"EQ Linear high resolution + spectral",[]{auto p=std::make_unique<OpenStudioEQ>(true);p->phaseMode.store(1);p->phaseQuality.store(2);p->spectralProcessing.store(1);for(int band=0;band<24;++band){p->bands[band].enabled.store(1);p->bands[band].gain.store(band%2?3.0f:-3.0f);}return p;}},
        {"Limiter 4x",[]{auto p=std::make_unique<OpenStudioLimiter>(true);p->oversampleQuality.store(2);return p;}},
        {"Limiter 16x",[]{auto p=std::make_unique<OpenStudioLimiter>(true);p->oversampleQuality.store(4);return p;}},
        {"Synth 32 notes",[]{return std::make_unique<OpenStudioBasicSynthInstrument>();}},
        {"Piano 32 notes + coupled body",[]{auto p=std::make_unique<OpenStudioPianoInstrument>();p->coupledBody.store(.5f);return p;}},
        {"Guitar 32 notes",[]{return std::make_unique<OpenStudioCleanGuitarInstrument>();}},
        {"Drums 32 notes + separate outputs",[]{auto p=std::make_unique<OpenStudioDrumInstrument>();for(size_t piece=0;piece<8;++piece)p->pieceOutput[piece].store(static_cast<float>(piece+1));return p;}},
        {"Reverb Room to Shimmer switch with retained tail",[]{auto p=std::make_unique<OpenStudioReverb>(true);p->tailSpillover.store(1);p->decayTime.store(2);return p;}},
        {"Reverb 4-path IR / four outputs",[]{auto p=std::make_unique<OpenStudioReverb>(true);juce::AudioBuffer<float> ir(4,96000);ir.clear();for(int ch=0;ch<4;++ch)for(int i=ch;i<96000;i+=127)ir.setSample(ch,i,static_cast<float>(.03*std::exp(-i/20000.0)));const auto file=juce::File::getCurrentWorkingDirectory().getChildFile("output/performance-four-path-ir.wav");writeProbeWave(file,ir,48000);p->convolutionSpace.loadFile(file);auto* shape=new juce::DynamicObject();shape->setProperty("outputLayout",1);p->convolutionSpace.edit(juce::var(shape));p->algorithm.store(7);return p;}}
    };
    juce::Array<juce::var> rows;bool finite=true;
    const auto run=[&](const juce::String& name,std::vector<std::unique_ptr<juce::AudioProcessor>>& processors,double rate,int block,int notes)
    {
        const auto privateBytes=[]()->juce::int64 {
#if JUCE_WINDOWS
            PROCESS_MEMORY_COUNTERS_EX value{};value.cb=sizeof(value);if(K32GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&value),sizeof(value)))return static_cast<juce::int64>(value.PrivateUsage);
#endif
            return -1;
        };
        const auto bytesBefore=privateBytes(),prepareStart=juce::Time::getHighResolutionTicks();
        std::vector<juce::AudioBuffer<float>> audio;std::vector<juce::MidiBuffer> midi;audio.reserve(processors.size());midi.resize(processors.size());
        for(size_t i=0;i<processors.size();++i){auto& p=processors[i];p->setRateAndBufferSizeDetails(rate,block);p->prepareToPlay(rate,block);audio.emplace_back(juce::jmax(2,p->getTotalNumOutputChannels()),block);midi[i].ensureSize(4096);}
        const double prepareMs=juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks()-prepareStart)*1000;const auto bytesPrepared=privateBytes();
        const int iterations=name.startsWith("Eight parallel")?11250:1024;
        std::vector<double> times;times.reserve(static_cast<size_t>(iterations));int overruns=0;double peak=0;
        for(int frame=-128;frame<iterations;++frame)
        {
            for(size_t i=0;i<processors.size();++i)
            {
                auto& buffer=audio[i];buffer.clear();midi[i].clear();
                const bool tailOnly=name.contains("retained tail");
                if(!tailOnly||frame<0)for(int sample=0;sample<block;++sample){const float value=.1f*std::sin(.0576f*static_cast<float>((frame+128)*block+sample));buffer.setSample(0,sample,value);buffer.setSample(1,sample,value);}
                if(tailOnly&&frame==0)if(auto* reverb=dynamic_cast<OpenStudioReverb*>(processors[i].get()))reverb->selectAlgorithm(4);
                if(auto* eq=dynamic_cast<OpenStudioEQ*>(processors[i].get());eq&&eq->hasPreparedMIDIPrograms()&&(frame+128)%64==0)midi[i].addEvent(juce::MidiMessage::programChange(1,((frame+128)/64)%32),19);
                if(processors[i]->acceptsMidi()&&(frame+128)%128==0){midi[i].addEvent(juce::MidiMessage::allSoundOff(1),0);for(int note=0;note<notes;++note)midi[i].addEvent(juce::MidiMessage::noteOn(1,36+note,.5f),0);}
            }
            const auto started=juce::Time::getHighResolutionTicks();
            for(size_t i=0;i<processors.size();++i)processors[i]->processBlock(audio[i],midi[i]);
            const double elapsed=juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks()-started)*1e6;
            if(frame>=0){times.push_back(elapsed);if(elapsed>block/rate*1e6)++overruns;}
            for(const auto& buffer:audio)for(int ch=0;ch<buffer.getNumChannels();++ch)for(int sample=0;sample<block;++sample){const float value=buffer.getSample(ch,sample);finite=finite&&std::isfinite(value);peak=juce::jmax(peak,std::abs(static_cast<double>(value)));}
        }
        std::sort(times.begin(),times.end());auto* row=new juce::DynamicObject();row->setProperty("case",name);row->setProperty("rate",rate);row->setProperty("block",block);row->setProperty("instances",static_cast<int>(processors.size()));row->setProperty("notesPerInstrument",notes);
        row->setProperty("iterations",iterations);row->setProperty("audioSeconds",iterations*block/rate);row->setProperty("prepareMs",prepareMs);row->setProperty("incrementalPreparedPrivateBytes",bytesPrepared-bytesBefore);row->setProperty("steadyPrivateGrowthBytes",privateBytes()-bytesPrepared);
        row->setProperty("medianUs",times[times.size()/2]);row->setProperty("p95Us",times[times.size()*95/100]);row->setProperty("p99Us",times[times.size()*99/100]);row->setProperty("maxUs",times.back());row->setProperty("deadlineOverruns",overruns);row->setProperty("peak",peak);rows.add(row);
    };
    for(const auto& factory:factories)for(int profile:{0,1}){std::vector<std::unique_ptr<juce::AudioProcessor>> processors;processors.push_back(factory.second());run(factory.first,processors,profile?96000:48000,profile?64:128,32);}
    std::vector<std::unique_ptr<juce::AudioProcessor>> session;const auto suite=freeSuiteFactories();for(int index:{0,2,4,7,8,11,12,14})session.push_back(suite[static_cast<size_t>(index)].second());run("Eight parallel instances: EQ, compressor, limiter, reverb, delay, pitch, synth, guitar",session,48000,128,4);
    juce::Array<juce::var> alignmentCases;
    for(double rate:{48000.0,192000.0})
    {
        const int window=juce::jmin(28672,juce::roundToInt(rate*.5));constexpr int windows=12;
        std::array<BuiltInAlignmentCapture,8> owners;std::vector<BuiltInAlignmentCapture*> captures;
        for(auto& owner:owners){owner.prepare(rate);finite=owner.armContinuous(0,window*windows,window,rate)&&finite;captures.push_back(&owner);}
        BuiltInContinuousAlignment stream(8);juce::AudioBuffer<float> audio(2,window);double totalMs=0,maxMs=0;
        for(int frame=0;frame<windows;++frame)
        {
            for(int member=0;member<8;++member){for(int sample=0;sample<window;++sample){auto value=static_cast<juce::uint32>(frame*window+sample-member*17);value^=value>>16;value*=0x7feb352dU;value^=value>>15;value*=0x846ca68bU;value^=value>>16;const float amplitude=(static_cast<float>(value&65535)/65535.0f-.5f)*(member%2?-.2f:.2f);for(int ch=0;ch<2;++ch)audio.setSample(ch,sample,amplitude);}owners[static_cast<size_t>(member)].process(audio,frame*window,true);}
            const auto start=juce::Time::getHighResolutionTicks();finite=stream.consume(captures,false)&&finite;const double ms=juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks()-start)*1000;totalMs+=ms;maxMs=juce::jmax(maxMs,ms);
        }
        const auto matrix=stream.matrix(false);bool accepted=stream.covered==window*windows;for(size_t member=1;member<8;++member)accepted=accepted&&matrix[0][member][0].accepted&&std::abs(matrix[0][member][0].lag-member*17)<.1&&matrix[0][member][0].invert==(member%2==1);finite=finite&&accepted;
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("members",8);row->setProperty("windowSamples",window);row->setProperty("windows",windows);row->setProperty("coveredSamples",stream.covered);row->setProperty("knownLagsAndPolarity",accepted);row->setProperty("meanWorkerMs",totalMs/windows);row->setProperty("maxWorkerMs",maxMs);row->setProperty("audioWindowMs",window/rate*1000);alignmentCases.add(row);
    }
    auto* result=new juce::DynamicObject();result->setProperty("alignmentWorkerCases",alignmentCases);result->setProperty("plugin","Suite heavy modes and fixed session timing");result->setProperty("cases",rows);result->setProperty("pass",finite);result->setProperty("finite",finite);result->setProperty("scope","Optimized in-process callback screen; timing is diagnostic_only and excludes device/host scheduling. No listening qualification.");return result;
}
