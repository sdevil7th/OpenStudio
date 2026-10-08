bool checkMIDISeekPedalsAtRate(double rate)
{
    bool pass=true;
    for(int scenario=0;scenario<7;++scenario)
    {
        TrackProcessor track;TrackProcessor::ScheduledMIDIClip clip;clip.duration=2;
        const auto cc=[&](double time,int number,int value){clip.events.push_back({time,juce::MidiMessage::controllerEvent(1,number,value)});};
        const auto note=[&](int key,double on,double off){clip.events.push_back({on,juce::MidiMessage::noteOn(1,key,.7f)});clip.events.push_back({off,juce::MidiMessage::noteOff(1,key)});};
        const bool sostenuto=scenario==2||scenario==3;
        note(60,.1,sostenuto?.3:.2);cc(.15,sostenuto?66:64,127);
        if(sostenuto){note(64,.2,.4);note(67,.35,1.8);}
        if(scenario==1)cc(.25,64,0);
        if(scenario==3)cc(.45,66,0);
        if(scenario==4)cc(.18,123,0);
        if(scenario==5)cc(.25,120,0);
        if(scenario==6)cc(.25,121,0);
        track.setScheduledMIDIClips({clip});juce::MidiBuffer midi;midi.ensureSize(131072);track.buildMidiBuffer(midi,.5,127,rate,true);
        int index=0,on60=-1,off60=-1,on64=-1,on67=-1,off67=-1,pedalOn=-1,noteCount=0;
        for(const auto metadata:midi)
        {
            const auto message=metadata.getMessage();
            if(message.isController()&&message.getControllerNumber()==(sostenuto?66:64)&&message.getControllerValue()>=64)pedalOn=index;
            if(message.isNoteOn()){++noteCount;if(message.getNoteNumber()==60)on60=index;else if(message.getNoteNumber()==64)on64=index;else if(message.getNoteNumber()==67)on67=index;}
            if(message.isNoteOff()){if(message.getNoteNumber()==60)off60=index;else if(message.getNoteNumber()==67)off67=index;}
            ++index;
        }
        if(scenario==0||scenario==4)pass=pass&&noteCount==1&&pedalOn>=0&&pedalOn<on60&&on60<off60;
        else if(scenario==2)pass=pass&&noteCount==2&&on60>=0&&on60<pedalOn&&pedalOn<on67&&off60>pedalOn&&off67<0&&on64<0;
        else if(scenario==3)pass=pass&&noteCount==1&&on67>=0&&off67<0&&on60<0&&on64<0;
        else pass=pass&&noteCount==0;
    }
    return pass;
}

juce::var checkMIDISeekState()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","MIDI seek pressure, reset and bank/program state");bool pass=true;juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        TrackProcessor track;TrackProcessor::ScheduledMIDIClip clip;clip.duration=2;
        const auto event=[&](double time,const auto& message){clip.events.push_back({time,message});};
        const auto cc=[&](double time,int ch,int number,int value){event(time,juce::MidiMessage::controllerEvent(ch,number,value));};
        const auto note=[&](double start,double end,int ch,int key){event(start,juce::MidiMessage::noteOn(ch,key,.7f));event(end,juce::MidiMessage::noteOff(ch,key));};
        cc(.02,1,0,2);cc(.03,1,32,3);cc(.04,1,7,100);cc(.04,1,10,40);cc(.04,1,91,33);cc(.04,1,74,80);
        event(.05,juce::MidiMessage::programChange(1,5));cc(.06,1,0,4);
        cc(.07,1,1,100);cc(.07,1,11,40);cc(.07,1,64,127);
        event(.08,juce::MidiMessage::pitchWheel(1,10000));event(.09,juce::MidiMessage::channelPressureChange(1,60));
        note(.1,1.8,1,60);note(.1,1.8,1,64);note(.1,.33,1,67);note(.34,1.8,1,67);
        event(.2,juce::MidiMessage::aftertouchChange(1,60,33));event(.2,juce::MidiMessage::aftertouchChange(1,64,77));event(.2,juce::MidiMessage::aftertouchChange(1,67,10));
        cc(.25,1,121,0);event(.3,juce::MidiMessage::aftertouchChange(1,60,44));event(.31,juce::MidiMessage::aftertouchChange(1,64,88));
        event(.32,juce::MidiMessage::channelPressureChange(1,22));event(.32,juce::MidiMessage::pitchWheel(1,12288));cc(.32,1,1,64);
        note(.1,1.8,2,72);event(.2,juce::MidiMessage::aftertouchChange(2,72,33));cc(.4,2,123,0);note(.5,1.8,2,74);event(.6,juce::MidiMessage::aftertouchChange(2,74,99));
        note(.1,1.8,3,76);cc(.4,3,120,0);
        track.setScheduledMIDIClips({clip});juce::MidiBuffer midi;midi.ensureSize(131072);const auto* storage=midi.data.begin();track.buildMidiBuffer(midi,.75,127,rate,true);
        std::array<std::array<bool,128>,16> active{};std::array<std::array<int,128>,16> pressure{};
        int bend=8192,channelPressure=0,wheel=0,expression=127,pedal=0,volume=-1,pan=-1,effect=-1,sound=-1,bankMsb=-1,bankLsb=-1,programBankMsb=-1,programBankLsb=-1;
        bool pressureAfterNote=true;int resets=0;
        for(const auto metadata:midi)
        {
            const auto message=metadata.getMessage();const auto channel=static_cast<size_t>(message.getChannel()-1);
            if(message.isNoteOn()){active[channel][static_cast<size_t>(message.getNoteNumber())]=true;pressure[channel][static_cast<size_t>(message.getNoteNumber())]=0;}
            else if(message.isAftertouch()){const auto key=static_cast<size_t>(message.getNoteNumber());pressureAfterNote=pressureAfterNote&&active[channel][key];pressure[channel][key]=message.getAfterTouchValue();}
            else if(message.isController())
            {
                const int number=message.getControllerNumber(),value=message.getControllerValue();
                if(number==120||number==123||number>=124)active[channel].fill(false);
                if(channel!=0)continue;
                if(number==121){++resets;bend=8192;channelPressure=0;wheel=0;expression=127;pedal=0;pressure[channel].fill(0);}
                else if(number==0)bankMsb=value;else if(number==32)bankLsb=value;else if(number==1)wheel=value;else if(number==11)expression=value;else if(number==64)pedal=value;
                else if(number==7)volume=value;else if(number==10)pan=value;else if(number==91)effect=value;else if(number==74)sound=value;
            }
            else if(channel==0&&message.isPitchWheel())bend=message.getPitchWheelValue();
            else if(channel==0&&message.isChannelPressure())channelPressure=message.getChannelPressureValue();
            else if(channel==0&&message.isProgramChange()){programBankMsb=bankMsb;programBankLsb=bankLsb;}
        }
        const bool reset=resets==1&&bend==12288&&channelPressure==22&&wheel==64&&expression==127&&pedal==0&&volume==100&&pan==40&&effect==33&&sound==80;
        const bool perNote=pressureAfterNote&&pressure[0][60]==44&&pressure[0][64]==88&&pressure[0][67]==0&&active[0][67]&&pressure[1][74]==99&&!active[1][72]&&!active[2][76];
        const bool bank=programBankMsb==2&&programBankLsb==3&&bankMsb==4&&bankLsb==3;
        const bool storageStable=storage==midi.data.begin(),pedals=checkMIDISeekPedalsAtRate(rate);pass=pass&&reset&&perNote&&bank&&storageStable&&pedals;
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("resetAndPreservedControls",reset);row->setProperty("perNotePressureAndKilledNotes",perNote);row->setProperty("programBankThenPendingBank",bank);row->setProperty("preparedStorageStable",storageStable);row->setProperty("sustainSostenutoAndRelease",pedals);cases.add(row);
    }
    // Dense fixed-cache case: all notes/channels receive distinct key pressure.
    TrackProcessor dense;TrackProcessor::ScheduledMIDIClip clip;clip.duration=2;
    for(int channel=1;channel<=16;++channel)for(int key=0;key<128;++key){clip.events.push_back({.1,juce::MidiMessage::noteOn(channel,key,.5f)});clip.events.push_back({.2,juce::MidiMessage::aftertouchChange(channel,key,(key+channel)%128)});clip.events.push_back({1.8,juce::MidiMessage::noteOff(channel,key)});}
    dense.setScheduledMIDIClips({clip});juce::MidiBuffer midi;midi.ensureSize(131072);const auto* storage=midi.data.begin();dense.buildMidiBuffer(midi,.75,127,48000,true);int notes=0,pressures=0;for(const auto metadata:midi){notes+=metadata.getMessage().isNoteOn()?1:0;pressures+=metadata.getMessage().isAftertouch()?1:0;}
    const bool bounded=notes==2048&&pressures==2048&&storage==midi.data.begin();
    result->setProperty("pass",pass&&bounded);result->setProperty("cases",cases);result->setProperty("denseFixedCache",bounded);result->setProperty("historicalEnvelopeAndDeviceSpecificReset","not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}
