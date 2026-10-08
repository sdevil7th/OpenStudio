juce::var checkReverbPeakHold()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Reverb retained sample peaks");bool pass=true,dry=true,reset=true,stateUnchanged=true;juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})for(const int channels:{1,2})
    {
        auto processor=std::make_unique<OpenStudioReverb>(true);processor->wetLevel.store(0);processor->dryLevel.store(1);processor->prepareToPlay(rate,127);juce::MemoryBlock before,after;processor->getStateInformation(before);juce::AudioBuffer<float> audio(channels,127);juce::MidiBuffer midi;
        audio.clear();audio.setSample(0,3,1.25f);if(channels==2)audio.setSample(1,9,-.5f);processor->processBlock(audio,midi);dry=dry&&audio.getSample(0,3)==1.25f&&(channels==1||audio.getSample(1,9)==-.5f);
        audio.clear();processor->processBlock(audio,midi);const double expected=juce::Decibels::gainToDecibels(1.25);const bool retained=std::abs(processor->peakHold.read(false,0)-expected)<1e-5&&std::abs(processor->peakHold.read(true,0)-expected)<1e-5&&processor->outputPeaksDb[0].load()==-100;
        const bool independent=std::abs(processor->peakHold.read(true,1)-juce::Decibels::gainToDecibels(channels==1?1.25f:.5f))<1e-5;
        const bool requested=setFreePluginParamForRegression(*processor,"peakHoldReset",1)&&processor->peakHold.resetPending();processor->processBlock(audio,midi);bool cleared=!processor->peakHold.resetPending();for(size_t channel=0;channel<2;++channel)cleared=cleared&&processor->peakHold.read(false,channel)==-100&&processor->peakHold.read(true,channel)==-100;reset=reset&&requested&&cleared;
        processor->getStateInformation(after);stateUnchanged=stateUnchanged&&before==after;
        audio.setSample(0,0,.25f);processor->processBlock(audio,midi);const bool resumed=std::abs(processor->peakHold.read(true,0)-juce::Decibels::gainToDecibels(.25f))<1e-5;
        pass=pass&&retained&&independent&&resumed;auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("channels",channels);row->setProperty("retained",retained);row->setProperty("independent",independent);row->setProperty("reset",requested&&cleared);row->setProperty("resumed",resumed);cases.add(row);
    }
    result->setProperty("pass",pass&&dry&&reset&&stateUnchanged);result->setProperty("cases",cases);result->setProperty("dryExact",dry);result->setProperty("resetNextBlock",reset);result->setProperty("serializedStateUnchanged",stateUnchanged);result->setProperty("truePeak","not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}
