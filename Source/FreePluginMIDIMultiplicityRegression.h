#pragma once

// Independent event interpreter for the regression: no prepared lifetime fields
// are used to decide the expected sounding voices or pedal capture set.
struct MIDIChaseVoiceOracle
{
    struct Voice {int channel=1,key=60,velocity=0,releaseVelocity=0;bool held=true,captured=false;};
    std::vector<Voice> voices;std::array<bool,16> sustain {},sostenuto {};
    void apply(const juce::MidiMessage& message)
    {
        const int ch=message.getChannel();if(ch<1||ch>16)return;const auto channel=static_cast<size_t>(ch-1);
        if(message.isNoteOn())voices.push_back({ch,message.getNoteNumber(),message.getVelocity(),0,true,false});
        else if(message.isNoteOff())
        {
            for(auto& voice:voices)if(voice.channel==ch&&voice.key==message.getNoteNumber()&&voice.held)
            {voice.held=false;voice.releaseVelocity=message.getVelocity();break;}
        }
        else if(message.isController())
        {
            const int cc=message.getControllerNumber();const bool down=message.getControllerValue()>=64;
            if(cc==64)sustain[channel]=down;
            if(cc==66)
            {
                if(down&&!sostenuto[channel])for(auto& voice:voices)if(voice.channel==ch)voice.captured=voice.held;
                if(!down)for(auto& voice:voices)if(voice.channel==ch)voice.captured=false;
                sostenuto[channel]=down;
            }
            if(cc==121){sustain[channel]=sostenuto[channel]=false;for(auto& voice:voices)if(voice.channel==ch)voice.captured=false;}
            if(cc==123||cc>=124)for(auto& voice:voices)if(voice.channel==ch){voice.held=false;voice.releaseVelocity=0;}
            if(cc==120)voices.erase(std::remove_if(voices.begin(),voices.end(),[&](const auto& voice){return voice.channel==ch;}),voices.end());
        }
        voices.erase(std::remove_if(voices.begin(),voices.end(),[&](const auto& voice){return !voice.held&&!sustain[static_cast<size_t>(voice.channel-1)]&&!voice.captured;}),voices.end());
    }
    juce::String signature() const
    {
        juce::StringArray rows;for(const auto& voice:voices)rows.add(juce::String(voice.channel)+":"+juce::String(voice.key)+":"+juce::String(voice.velocity)+":"+juce::String(static_cast<int>(voice.held))+":"+juce::String(static_cast<int>(voice.captured))+":"+juce::String(voice.releaseVelocity));rows.sort(false);return rows.joinIntoString("|");
    }
};

inline juce::var checkMIDINoteMultiplicity()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Prepared repeated-key MIDI lifetimes");bool pass=true,storage=true;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int scenario=0;scenario<10;++scenario)
    {
        TrackProcessor::ScheduledMIDIClip a,b;a.duration=b.duration=2;
        const auto cc=[&](double time,int number,int value){a.events.push_back({time,juce::MidiMessage::controllerEvent(1,number,value)});};
        const auto note=[&](auto& clip,double on,double off,int velocity,int release){clip.events.push_back({on,juce::MidiMessage::noteOn(1,60,static_cast<juce::uint8>(velocity))});clip.events.push_back({off,juce::MidiMessage::noteOff(1,60,static_cast<juce::uint8>(release))});};
        if(scenario==4||scenario==5)
        {
            cc(.01,64,127);note(a,.05,.1,31,17);note(a,.12,.2,61,37);cc(.15,66,127);note(a,.25,.9,91,57);
            if(scenario==5)cc(.35,64,0);
        }
        else
        {
            note(a,.1,.4,31,17);note(b,.2,.8,91,57);
            if(scenario==1||scenario==6||scenario==7)cc(.05,64,127);
            if(scenario==2)cc(.25,66,127);
            if(scenario==3)cc(.15,66,127);
            if(scenario==6)cc(.35,123,0);
            if(scenario==7)cc(.45,121,0);
            if(scenario==8)cc(.45,120,0);
            if(scenario==9){cc(.15,66,127);cc(.22,66,0);cc(.3,66,127);}
        }
        TrackProcessor::ScheduledMIDISnapshot prepared({b,a});
        for(double seek:{.3,.5,.85})
        {
            MIDIChaseVoiceOracle live,recalled;
            for(const auto& entry:prepared.chronological){if(entry.time>=seek)break;live.apply(prepared.clips[entry.clip].events[entry.event].message);}
            TrackProcessor track;track.setScheduledMIDIClips({b,a});juce::MidiBuffer midi;midi.ensureSize(131072);const auto* before=midi.data.begin();track.buildMidiBuffer(midi,seek,1,rate,true);storage=storage&&before==midi.data.begin();
            for(const auto metadata:midi)recalled.apply(metadata.getMessage());
            // Events exactly on the seek boundary play in that first sample.
            for(const auto& entry:prepared.chronological)if(entry.time>=seek&&entry.time<seek+1/rate)live.apply(prepared.clips[entry.clip].events[entry.event].message);
            const bool same=live.signature()==recalled.signature();pass=pass&&same;
            auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("scenario",scenario);row->setProperty("seek",seek);row->setProperty("pass",same);if(!same){row->setProperty("live",live.signature());row->setProperty("seekState",recalled.signature());}cases.add(row);
        }
    }
    TrackProcessor::ScheduledMIDIClip dense;dense.duration=2;
    for(int i=0;i<64;++i){dense.events.push_back({.001*i,juce::MidiMessage::noteOn(2,60,static_cast<juce::uint8>(i+1))});dense.events.push_back({1+.001*i,juce::MidiMessage::noteOff(2,60)});}
    TrackProcessor track;track.setScheduledMIDIClips({dense});juce::MidiBuffer midi;midi.ensureSize(131072);const auto* before=midi.data.begin();track.buildMidiBuffer(midi,.5,127,48000,true);int count=0;for(const auto metadata:midi)if(metadata.getMessage().isNoteOn())++count;
    const bool multiplicity=count==64&&before==midi.data.begin();
    TrackProcessor activity;juce::MidiBuffer liveBuffer;liveBuffer.ensureSize(131072);
    activity.enqueueMidiMessage(juce::MidiMessage::noteOn(1,60,.4f));activity.enqueueMidiMessage(juce::MidiMessage::noteOn(1,60,.8f));
    activity.buildMidiBuffer(liveBuffer,0,127,48000,false);activity.enqueueMidiMessage(juce::MidiMessage::noteOff(1,60));activity.buildMidiBuffer(liveBuffer,0,127,48000,false);
    auto notes=activity.getRecentMIDINoteActivity(10000);bool activityPass=notes.size()==1&&notes[0].active;
    activity.enqueueMidiMessage(juce::MidiMessage::noteOff(1,60));activity.buildMidiBuffer(liveBuffer,0,127,48000,false);notes=activity.getRecentMIDINoteActivity(10000);activityPass=activityPass&&notes.size()==1&&!notes[0].active;
    TrackProcessor edge;TrackProcessor::ScheduledMIDIClip clip;clip.duration=.5;clip.events={{.1,juce::MidiMessage::noteOn(1,60,.7f)},{.7,juce::MidiMessage::noteOff(1,60)}};
    edge.setScheduledMIDIClips({clip});edge.buildMidiBuffer(liveBuffer,.25,1,48000,true);const bool closesEdge=edge.needsProcessing(.5,1,48000,true);
    result->setProperty("repeatedKeyActivity",activityPass);result->setProperty("rightEdgeRemainsScheduled",closesEdge);
    result->setProperty("pass",pass&&storage&&multiplicity&&activityPass&&closesEdge);result->setProperty("liveSeekFIFOAndPedals",pass);result->setProperty("reservedBufferUnchanged",storage);result->setProperty("sixtyFourRepeatedKeys",multiplicity);result->setProperty("cases",cases);
    result->setProperty("receiverSpecificAllocationAndVoiceAge","not_asserted");return result;
}
