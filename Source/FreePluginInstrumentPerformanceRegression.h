#pragma once
inline juce::var checkInstrumentPerformanceTelemetry()
{
    bool pass = true;
    const auto check = [&pass](auto& processor)
    {
        processor.prepareToPlay(48000, 127);
        juce::AudioBuffer<float> audio(2,127); juce::MidiBuffer midi;
        midi.addEvent(juce::MidiMessage::noteOn(3,60,.75f),0);
        midi.addEvent(juce::MidiMessage::controllerEvent(3,64,127),2);
        midi.addEvent(juce::MidiMessage::controllerEvent(3,66,64),3);
        midi.addEvent(juce::MidiMessage::controllerEvent(3,67,32),4);
        processor.processBlock(audio,midi);
        const auto held=processor.performanceTelemetry.visualization();
        pass=pass&&held["notes"].size()==1&&static_cast<int>(held["notes"][0]["channel"])==3
            &&static_cast<int>(held["notes"][0]["note"])==60&&static_cast<double>(held["sustain"][2])==1
            &&static_cast<double>(held["sostenuto"][2])>0&&static_cast<double>(held["soft"][2])>0;
        midi.clear();midi.addEvent(juce::MidiMessage::noteOff(3,60),0);processor.processBlock(audio,midi);
        // A physically released key disappears even while its pedal sustains.
        const auto released=processor.performanceTelemetry.visualization();
        pass=pass&&released["notes"].size()==0&&static_cast<double>(released["sustain"][2])==1;
        processor.reset();const auto reset=processor.performanceTelemetry.visualization();
        pass=pass&&reset["notes"].size()==0&&static_cast<double>(reset["sustain"][2])==0;
    };
    OpenStudioBasicSynthInstrument synth;check(synth);
    OpenStudioPianoInstrument piano;check(piano);
    OpenStudioCleanGuitarInstrument guitar;check(guitar);
    OpenStudioDrumInstrument drums;check(drums);
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Instrument received key/pedal telemetry");
    result->setProperty("pass",pass);result->setProperty("scope","Received held keys are independent of sounding/releasing voices; four native processors, channel isolation, pedals and reset.");return result;
}
