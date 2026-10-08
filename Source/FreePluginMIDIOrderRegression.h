juce::var checkOverlappingMIDIOrder()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Overlapping MIDI live and seek order");bool pass=true,stable=true;juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        TrackProcessor track;TrackProcessor::ScheduledMIDIClip newer,older;newer.startTime=older.startTime=0;newer.duration=older.duration=2;
        const auto cc=[](auto& clip,double time,int channel,int number,int value){clip.events.push_back({time,juce::MidiMessage::controllerEvent(channel,number,value)});};
        const auto rpn=[&](auto& clip,double time,int channel,int parameter,int value){cc(clip,time,channel,101,0);cc(clip,time,channel,100,parameter);cc(clip,time,channel,6,value);};
        rpn(older,.1,1,6,3);rpn(older,.2,1,0,1);rpn(older,.2,2,0,7);older.events.push_back({.2,juce::MidiMessage::pitchWheel(2,8192)});older.events.push_back({.2,juce::MidiMessage::channelPressureChange(2,0)});cc(older,.2,2,74,64);older.events.push_back({.3,juce::MidiMessage::noteOn(2,60,.4f)});older.events.push_back({.4,juce::MidiMessage::noteOff(2,60)});
        rpn(newer,.4,1,6,7);rpn(newer,.5,1,0,3);rpn(newer,.5,2,0,12);cc(newer,.5,2,38,50);newer.events.push_back({.5,juce::MidiMessage::pitchWheel(1,16383)});newer.events.push_back({.5,juce::MidiMessage::pitchWheel(2,16383)});newer.events.push_back({.5,juce::MidiMessage::channelPressureChange(2,96)});cc(newer,.5,2,74,100);newer.events.push_back({.6,juce::MidiMessage::noteOn(2,60,.7f)});newer.events.push_back({1.8,juce::MidiMessage::noteOff(2,60)});
        track.setScheduledMIDIClips({newer,older});juce::MidiBuffer seek,live;seek.ensureSize(8192);live.ensureSize(8192);track.buildMidiBuffer(seek,.75,127,rate,true);track.buildMidiBuffer(live,0,static_cast<int>(rate*.75),rate,true);
        const auto inspect=[](const auto& midi,double sampleRate){BuiltInSynthMPE mpe;mpe.prepare(sampleRate,{1,15,0,48,2,48,2});int noteCount=0;for(const auto metadata:midi){const auto message=metadata.getMessage();mpe.handle(message);if(message.isNoteOn()&&message.getChannel()==2){mpe.startVoice(1,0);++noteCount;}else if(message.isNoteOff()&&message.getChannel()==2)mpe.stopVoice(1,0);}const auto expression=mpe.currentTarget(1,0);return std::array<float,5>{expression.bend,expression.pressure,expression.slide,static_cast<float>(mpe.members(false)),static_cast<float>(noteCount)};};
        const auto chased=inspect(seek,rate),played=inspect(live,rate);const bool correct=chased[0]==15.5f&&std::abs(chased[1]-96.0f/127)<1e-6&&std::abs(chased[2]-36.0f/63)<1e-6&&chased[3]==7&&chased[4]==1&&played[4]==2;
        bool same=true;for(size_t i=0;i<4;++i)same=same&&chased[i]==played[i];pass=pass&&correct&&same;
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("correctChase",correct);row->setProperty("liveSeekExpressionEqual",same);cases.add(row);
    }
    // Equal timestamps retain clip/event insertion order; distinct times within
    // one quantized sample still follow chronological order.
    TrackProcessor track;TrackProcessor::ScheduledMIDIClip a,b;a.duration=b.duration=1;
    a.events={{.1,juce::MidiMessage::controllerEvent(1,1,1)},{.200002,juce::MidiMessage::controllerEvent(1,1,4)}};
    b.events={{.1,juce::MidiMessage::controllerEvent(1,1,2)},{.200001,juce::MidiMessage::controllerEvent(1,1,3)}};
    track.setScheduledMIDIClips({a,b});juce::MidiBuffer midi;midi.ensureSize(8192);track.buildMidiBuffer(midi,0,14400,48000,true);std::array<int,4> found{};size_t count=0;for(const auto metadata:midi){const auto message=metadata.getMessage();if(message.isController()&&message.getControllerNumber()==1&&count<found.size())found[count++]=message.getControllerValue();}stable=count==4&&found==std::array<int,4>{1,2,3,4};
    result->setProperty("pass",pass&&stable);result->setProperty("cases",cases);result->setProperty("stableEqualTimeAndSubsampleOrder",stable);result->setProperty("relativeRPN","not_asserted");result->setProperty("hardwareMPE","not_asserted");return result;
}
