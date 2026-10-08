#pragma once
// Explicit diagnostic export only; not part of the default regression run.
inline juce::var renderTenHourListeningExamples()
{
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/free-suite-ten-hour-listening");
    bool filesOK = directory.createDirectory().wasOk(); constexpr double rate = 48000; constexpr int length = 48000 * 8;
    juce::AudioBuffer<float> source(2, length); source.clear();
    for (int onset : {0, 144000}) for (int i=0; i<3360; ++i)
    {
        const double t=i/rate, envelope=std::sin(juce::MathConstants<double>::pi*i/3360.0)*std::exp(-t*35);
        const float value=static_cast<float>(.2*envelope*(std::sin(juce::MathConstants<double>::twoPi*220*t)+.4*std::sin(juce::MathConstants<double>::twoPi*1320*t)));
        source.setSample(0,onset+i,value);source.setSample(1,onset+i,value*.7f);
    }
    filesOK=writeProbeWave(directory.getChildFile("source-two-plucks.wav"),source,rate)&&filesOK;
    juce::Array<juce::var> files;
    const auto render=[&](std::unique_ptr<juce::AudioProcessor> processor,const juce::String& name,const juce::String& explanation,const juce::MidiBuffer& events,const std::vector<int>& edges,const std::function<void(int)>& change,bool audioInput)
    {
        processor->setNonRealtime(true);processor->setRateAndBufferSizeDetails(rate,512);processor->prepareToPlay(rate,512);
        juce::MemoryBlock initial;processor->getStateInformation(initial);filesOK=directory.getChildFile(name+".state").replaceWithData(initial.getData(),initial.getSize())&&filesOK;
        auto* item=new juce::DynamicObject();item->setProperty("file",name+".wav");item->setProperty("initialState",name+".state");item->setProperty("description",explanation);item->setProperty("settings",describeFreePluginForRegression(*processor));
        juce::Array<juce::var> midiEvents;for(const auto event:events){auto* row=new juce::DynamicObject();row->setProperty("sample",event.samplePosition);row->setProperty("bytes",juce::String::toHexString(event.data,event.numBytes));midiEvents.add(row);}item->setProperty("midi",midiEvents);
        juce::AudioBuffer<float> output(2,length),block(2,512);juce::MidiBuffer midi;
        for(int start=0;start<length;)
        {
            if(change)change(start);
            int count=juce::jmin(512,length-start);
            for(int edge:edges)if(edge>start)count=juce::jmin(count,edge-start);
            block.setSize(2,count,false,false,true);block.clear();midi.clear();midi.addEvents(events,start,count,-start);
            if(audioInput)for(int ch=0;ch<2;++ch)block.copyFrom(ch,0,source,ch,start,count);
            processor->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;
        }
        bool finite=true;double energy=0;float peak=0;for(int ch=0;ch<2;++ch)for(int i=0;i<length;++i){const float value=output.getSample(ch,i);finite=finite&&std::isfinite(value);peak=juce::jmax(peak,std::abs(value));energy+=static_cast<double>(value)*value;}
        item->setProperty("finite",finite);item->setProperty("peakLinear",peak);item->setProperty("rmsLinear",std::sqrt(energy/(2*length)));item->setProperty("levelMatched",false);item->setProperty("subjectiveAcceptance","not_asserted");
        filesOK=finite&&energy>0&&writeProbeWave(directory.getChildFile(name+".wav"),output,rate)&&filesOK;files.add(item);
    };
    juce::MidiBuffer empty;
    for(int type:{4,6,15,16})for(int infinite:{0,1})
    {
        auto reverb=std::make_unique<OpenStudioReverb>(true);auto* controls=reverb.get();reverb->selectAlgorithm(type);reverb->wetLevel.store(.7f);reverb->dryLevel.store(0);reverb->holdInputModes[static_cast<size_t>(type)].store(static_cast<float>(infinite));
        if(type==4)reverb->springControls[0].store(1);
        const juce::String label=type==4?"spring":type==6?"nonlinear":type==15?"magnetic":"positioned";
        auto* hold=type==4?&controls->springHold:type==6?&controls->nonlinearHold:type==15?&controls->magneticHold:&controls->positionedHold;
        render(std::move(reverb),label+(infinite?"-infinite":"-freeze"),"Wet only, 70% gain; source plucks at 0 and 3 s. Hold on at 0.12 s, off at 6 s. Freeze excludes the second pluck; Infinite accepts it. Original synthetic diagnostic.",empty,{5760,288000},[hold](int at){if(at==5760)hold->store(1);if(at==288000)hold->store(0);},true);
    }
    {
        auto guitar=std::make_unique<OpenStudioCleanGuitarInstrument>();guitar->stringEngine.store(1);guitar->articulationKeys.store(1);guitar->harmonicNode.store(3);guitar->outputGain.store(-16);juce::MidiBuffer events;
        for(int style=0;style<9;++style){const int at=style*33600;events.addEvent(juce::MidiMessage::noteOn(1,24+style,.7f),at);events.addEvent(juce::MidiMessage::noteOn(1,60,.75f),at+48);events.addEvent(juce::MidiMessage::noteOn(1,64,.75f),at+7248);events.addEvent(juce::MidiMessage::allSoundOff(1),at+31200);}
        render(std::move(guitar),"guitar-nine-articulations","Nine keyswitch articulations in ID order 0-8, 0.7 s each; two notes per style. Initial state and MIDI bytes identify exact controls/events. Not level matched.",events,{}, {},false);
    }
    {
        auto drums=std::make_unique<OpenStudioDrumInstrument>();drums->articulationEngine.store(1);drums->mapPreset.store(2);drums->ambience.store(0);drums->outputGain.store(-20);juce::MidiBuffer events;const std::array<int,16> notes{36,38,37,40,33,71,42,19,20,23,51,53,52,56,3,2};
        for(size_t i=0;i<notes.size();++i)events.addEvent(juce::MidiMessage::noteOn(10,notes[i],.75f),static_cast<int>(i)*19200);
        render(std::move(drums),"drums-sixteen-articulations","Extended studio map; sixteen notes at 0.4 s spacing: 36,38,37,40,33,71,42,19,20,23,51,53,52,56,3,2. Ambience off; original synthesized voices.",events,{}, {},false);
    }
    for(bool piano:{true,false})for(float coupling:{0.0f,.65f})
    {
        std::unique_ptr<juce::AudioProcessor> instrument;
        if(piano){auto p=std::make_unique<OpenStudioPianoInstrument>();p->performanceMode.store(1);p->coupledBody.store(coupling);instrument=std::move(p);}else{auto p=std::make_unique<OpenStudioCleanGuitarInstrument>();p->stringEngine.store(1);p->coupledBody.store(coupling);instrument=std::move(p);}
        juce::MidiBuffer events;for(int chord=0;chord<3;++chord)for(int note:{48,55,60}){const int at=chord*96000;events.addEvent(juce::MidiMessage::noteOn(1,note+chord*2,.65f),at);events.addEvent(juce::MidiMessage::noteOff(1,note+chord*2),at+60000);}
        render(std::move(instrument),juce::String(piano?"piano":"guitar")+(coupling>0?"-coupled":"-uncoupled"),"Three identical chord gestures for the paired files; secondary coupled body amount 0 or 0.65, other settings unchanged. Raw levels; physical/reference fidelity not asserted.",events,{}, {},false);
    }
    auto* report=new juce::DynamicObject();report->setProperty("plugin","Ten-hour listening diagnostics");report->setProperty("pass",filesOK);report->setProperty("path",directory.getFullPathName());report->setProperty("sampleRate",rate);report->setProperty("secondsPerFile",8);report->setProperty("format","stereo 32-bit float WAV");report->setProperty("source","Original deterministic synthetic plucks or generated MIDI, no reference recordings");report->setProperty("files",files);report->setProperty("audioQuality","not_asserted");report->setProperty("claimLevel","file_sanity_only");const juce::var result(report);directory.getChildFile("manifest.json").replaceWithText(juce::JSON::toString(result,true));return result;
}
