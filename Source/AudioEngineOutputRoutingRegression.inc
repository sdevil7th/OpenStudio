    {
        const auto source=addTrack("drum-output-source","midi");
        const auto destination=addTrack("drum-output-destination","bus");
        bool ready=addTrackBuiltInFX(source,"OpenStudio Drums",false);
        setTrackVolume(source,0);setTrackVolume(destination,0);
        setTrackMIDIClips(source,R"json([{"id":"routed-drum-clip","startTime":0,"duration":0.25,"events":[{"type":"noteOn","timestamp":0.01,"note":36,"velocity":90,"channel":1},{"type":"noteOff","timestamp":0.2,"note":36,"velocity":0,"channel":1}]}])json");
        const auto render=[&](const juce::String& mode,const juce::String& label,juce::AudioBuffer<float>& audio)
        {
            const auto file=outputDirectory.getChildFile("drum-outputs-"+label+".wav");double rate=0;
            return renderProject(mode,0,.25,file.getFullPathName(),"wav",48000,32,2,false,false,0,false)
                &&readAudioFileForParity(file,audio,rate);
        };
        juce::AudioBuffer<float> baseline,routed,stem,missing;
        ready=render("master","main",baseline)&&ready;
        const int index=addTrackSend(source,destination);setTrackSendLevel(source,index,1);
        ready=index>=0&&setTrackSendSourceChannel(source,index,2)&&setBuiltInPluginParam(source,"track",0,"pieceOutput0",1)&&ready;
        ready=render("master","routed",routed)&&render("stem:"+destination,"stem",stem)&&ready;
        double error=0;
        ready=ready&&baseline.getNumSamples()==routed.getNumSamples()&&routed.getNumSamples()==stem.getNumSamples();
        if(ready)for(int channel=0;channel<2;++channel)for(int sample=0;sample<baseline.getNumSamples();++sample)
            error=juce::jmax<double>(error,std::abs(baseline.getSample(channel,sample)*std::sqrt(.5f)-routed.getSample(channel,sample)),std::abs(routed.getSample(channel,sample)-stem.getSample(channel,sample)));
        addCheck("drum_output_master_stem_parity",ready&&baseline.getMagnitude(0,baseline.getNumSamples())>1e-5f&&error<2e-6,
            "An exclusive kick output survives the send graph and destination stem without duplicate master audio; includes the send's -3 dB centre pan law.",error);
        setTrackSendSourceChannel(source,index,4);
        const bool silent=render("master","unassigned",missing)&&missing.getMagnitude(0,missing.getNumSamples())==0;
        addCheck("drum_unassigned_pair_silence",silent,"A send from an unassigned output pair cannot fall back to the main pair.");
        // Complete restoration must never install a default Main 1/2 route.
        const auto replacement = [&](bool enabled, int pair) {
            auto* send = new juce::DynamicObject();
            send->setProperty("destTrackId", destination); send->setProperty("level", .75);
            send->setProperty("pan", -.25); send->setProperty("enabled", enabled);
            send->setProperty("preFader", true); send->setProperty("phaseInvert", true);
            send->setProperty("sourceChannel", pair);
            return juce::var(juce::Array<juce::var>{juce::var(send)});
        };
        bool atomicRestore = replaceTrackSends(source, replacement(false, 2));
        const auto disabledState = juce::JSON::toString(getTrackSends(source));
        juce::AudioBuffer<float> disabled;
        atomicRestore = atomicRestore && render("stem:" + destination, "atomic-disabled", disabled)
            && disabled.getMagnitude(0, disabled.getNumSamples()) == 0;
        for (const int badPair : {-2, 1, 64})
            atomicRestore = !replaceTrackSends(source, replacement(true, badPair))
                && juce::JSON::toString(getTrackSends(source)) == disabledState && atomicRestore;
        auto duplicate = replacement(true, 2);
        const juce::var duplicateEntry = duplicate[0];
        duplicate.append(duplicateEntry);
        atomicRestore = !replaceTrackSends(source, duplicate)
            && juce::JSON::toString(getTrackSends(source)) == disabledState && atomicRestore;
        atomicRestore = replaceTrackSends(source, replacement(true, 4)) && atomicRestore;
        juce::AudioBuffer<float> atomicMissing;
        atomicRestore = render("stem:" + destination, "atomic-unassigned", atomicMissing)
            && atomicMissing.getMagnitude(0, atomicMissing.getNumSamples()) == 0 && atomicRestore;
        addCheck("complete_send_restore_has_no_main_pair_fallback", atomicRestore,
            "Complete disabled/auxiliary configurations publish together; malformed and duplicate batches leave the previous state intact, and neither disabled nor absent auxiliary routes leak main audio.");
        const auto freeze=freezeTrack(source);
        addCheck("auxiliary_output_freeze_guard",!static_cast<bool>(freeze["success"])&&freeze["error"].toString().contains("auxiliary"),
            "Stereo freeze explicitly rejects an enabled auxiliary-output send instead of dropping its signal; destination stem rendering remains available.");
        removeTrack(source);removeTrack(destination);
    }

    {
        const auto source=addTrack("convolution-output-source","midi"),destination=addTrack("convolution-output-cross","bus");
        bool ready=addTrackBuiltInFX(source,"OpenStudio Drums",false)&&addTrackBuiltInFX(source,"OpenStudio Reverb",false);
        setTrackVolume(source,0);setTrackVolume(destination,0);
        setTrackMIDIClips(source,R"json([{"id":"convolution-output-note","startTime":0,"duration":0.3,"events":[{"type":"noteOn","timestamp":0.01,"note":36,"velocity":90,"channel":1}]}])json");
        juce::AudioBuffer<float> impulse(4,256);impulse.clear();impulse.setSample(0,0,.5f);impulse.setSample(1,31,.2f);impulse.setSample(2,67,-.1f);impulse.setSample(3,11,.4f);
        const auto impulseFile=outputDirectory.getChildFile("convolution-output-matrix.wav");
        auto* load=new juce::DynamicObject();load->setProperty("irFile",impulseFile.getFullPathName());
        ready=writeBufferToWavFile(impulse,256,48000,impulseFile)&&ready
            &&setBuiltInPluginParam(source,"track",1,"reverbTypeExpanded",7)
            &&setBuiltInPluginParam(source,"track",1,"wetLevel",1)&&setBuiltInPluginParam(source,"track",1,"dryLevel",0)
            &&setBuiltInPluginState(source,"track",1,juce::JSON::toString(juce::var(load)))
            &&setBuiltInPluginState(source,"track",1,R"json({"irShape":{"normalise":false,"outputLayout":0}})json");
        const auto render=[&](const juce::String& mode,const juce::String& label,juce::AudioBuffer<float>& audio)
        {
            const auto file=outputDirectory.getChildFile("convolution-outputs-"+label+".wav");double rate=0;
            return renderProject(mode,0,.3,file.getFullPathName(),"wav",48000,32,2,false,false,0,false)&&readAudioFileForParity(file,audio,rate);
        };
        juce::AudioBuffer<float> baseline,master,direct,cross;
        ready=render("master","summed",baseline)&&ready;
        const int send=addTrackSend(source,destination);setTrackSendLevel(source,send,1);setTrackVolume(destination,juce::Decibels::gainToDecibels(std::sqrt(2.0f)));
        ready=send>=0&&setTrackSendSourceChannel(source,send,2)
            &&setBuiltInPluginState(source,"track",1,R"json({"irShape":{"outputLayout":1}})json")&&ready;
        const auto saved=getBuiltInPluginState(source,"track",1);
        ready=render("master","split",master)&&render("stem:"+source,"direct",direct)&&render("stem:"+destination,"cross",cross)&&ready;
        ready=ready&&master.getNumSamples()==baseline.getNumSamples()&&direct.getNumSamples()==master.getNumSamples()&&cross.getNumSamples()==master.getNumSamples();
        double error=0;if(ready)for(int channel=0;channel<2;++channel)for(int sample=0;sample<master.getNumSamples();++sample)
            error=juce::jmax<double>(error,std::abs(master.getSample(channel,sample)-baseline.getSample(channel,sample)),std::abs(master.getSample(channel,sample)-direct.getSample(channel,sample)-cross.getSample(channel,sample)));
        addCheck("convolution_four_output_host_stems",ready&&cross.getMagnitude(0,cross.getNumSamples())>1e-6f&&error<2e-6,"Four-path convolution direct/cross outputs survive native sends and stems; recombining recovers stereo-sum processing.",error);
        const bool restored=setBuiltInPluginState(source,"track",1,R"json({"irShape":{"outputLayout":0}})json")&&setBuiltInPluginState(source,"track",1,juce::JSON::toString(saved))
            &&getBuiltInPluginState(source,"track",1)["fullState"].toString()==saved["fullState"].toString();
        addCheck("convolution_output_layout_portable_host",restored,"Complete host state restores the portable IR and its explicit output layout.");
        removeTrack(source);removeTrack(destination);
    }
