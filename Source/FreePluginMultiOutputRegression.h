#pragma once

juce::var checkDrumMultiOutputs()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Drum independent outputs and host channel preservation");
    bool isolation = true, recall = true, legacy = true, finite = true, host = true;
    double maximumLeak = 0.0, maximumLegacyError = 0.0;
    const std::array<int, 8> notes {36, 38, 42, 46, 41, 48, 49, 51};
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (size_t piece = 0; piece < notes.size(); ++piece)
        {
            auto drums = std::make_unique<OpenStudioDrumInstrument>();
            drums->pieceOutput[piece].store(static_cast<float>(piece + 1));
            drums->prepareToPlay(rate, 257);
            juce::AudioBuffer<float> buffer(18, 257);
            juce::MidiBuffer midi;
            midi.addEvent(juce::MidiMessage::noteOn(1, notes[piece], .8f), 19);
            drums->processBlock(buffer, midi);
            double energy = 0;
            for (int channel = 0; channel < 18; ++channel)
                for (int sample = 0; sample < 257; ++sample)
                {
                    const float value = buffer.getSample(channel, sample);
                    finite = finite && std::isfinite(value);
                    if (channel / 2 == static_cast<int>(piece + 1)) energy += value * value;
                    else maximumLeak = juce::jmax(maximumLeak, std::abs(static_cast<double>(value)));
                    if (sample < 19) isolation = isolation && value == 0.0f;
                }
            isolation = isolation && energy > 1.0e-7;
            juce::MemoryBlock state;
            drums->getStateInformation(state);
            auto restored = std::make_unique<OpenStudioDrumInstrument>();
            restored->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            recall = recall && restored->pieceOutput[piece].load() == static_cast<float>(piece + 1);
            auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize());
            for (int index = 0; index < 8; ++index) tree.removeProperty("pieceOutput" + juce::String(index), nullptr);
            juce::MemoryBlock old;
            { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
            restored->setStateInformation(old.getData(), static_cast<int>(old.getSize()));
            for (const auto& output : restored->pieceOutput) legacy = legacy && output.load() == 0.0f;
        }
        auto stereo = std::make_unique<OpenStudioDrumInstrument>();
        auto expanded = std::make_unique<OpenStudioDrumInstrument>();
        stereo->prepareToPlay(rate, 257); expanded->prepareToPlay(rate, 257);
        juce::AudioBuffer<float> a(2,257), b(18,257);
        juce::MidiBuffer midi;
        for (int note : notes) midi.addEvent(juce::MidiMessage::noteOn(1,note,.6f),0);
        stereo->processBlock(a,midi); expanded->processBlock(b,midi);
        for(int channel=0;channel<2;++channel) for(int sample=0;sample<257;++sample)
            maximumLegacyError=juce::jmax(maximumLegacyError,std::abs(static_cast<double>(a.getSample(channel,sample)-b.getSample(channel,sample))));
    }
    auto track = std::make_unique<TrackProcessor>();
    auto drums = std::make_unique<OpenStudioDrumInstrument>();
    drums->pieceOutput[0].store(1);
    host = track->addTrackFX(std::move(drums),48000,256) && host;
    // A following stereo processor must not copy its main pair over the auxiliary buses.
    host = track->addTrackFX(std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::GainPhase),48000,256) && host;
    const int send=track->addSend("drum-destination");
    host = track->setSendSourceChannel(send,2) && track->getProcessingChannelCount()==18 && host;
    host = !track->setSendSourceChannel(send,3) && !track->setSendSourceChannel(send,64) && host;
    track->setVolume(-6); track->prepareToPlay(48000,256);
    juce::AudioBuffer<float> audio(18,256), pre(2,256), post(2,256);
    audio.clear();pre.clear();post.clear();juce::MidiBuffer midi;
    midi.addEvent(juce::MidiMessage::noteOn(1,36,.8f),0);
    track->processBlock(audio,midi);
    TrackProcessor::mixSendPair(track->getPreFaderBuffer(),pre,2,256,1,1,1);
    TrackProcessor::mixSendPair(audio,post,2,256,1,1,1);
    host=host&&audio.getMagnitude(0,0,256)==0&&audio.getMagnitude(1,0,256)==0
        &&pre.getMagnitude(0,0,256)>1.0e-5f&&post.getMagnitude(0,0,256)<pre.getMagnitude(0,0,256);
    juce::AudioBuffer<float> absent(2,256);absent.clear();
    TrackProcessor::mixSendPair(audio,absent,62,256,1,1,1);
    host=host&&absent.getMagnitude(0,0,256)==0&&track->getRealtimeSendSnapshot()[0].sourceChannel==2;
    auto previewSource=std::make_shared<OpenStudioDrumInstrument>();previewSource->pieceOutput[0].store(8);
    BuiltInInstrumentPreview preview;const bool started=preview.send("aux-audition",previewSource,36,true,48000,[]{return std::make_unique<OpenStudioDrumInstrument>();});
    juce::AudioBuffer<float> audition(2,512);audition.clear();preview.render(audition.getArrayOfWritePointers(),2,512,48000);
    const bool previewPass=started&&audition.getMagnitude(0,512)>1e-5f&&previewSource->pieceOutput[0].load()==8;
    host=host&&previewPass;result->setProperty("isolatedAuxiliaryAudition",previewPass);
    result->setProperty("pass",isolation&&recall&&legacy&&finite&&host&&maximumLeak==0&&maximumLegacyError==0);
    result->setProperty("isolatedOutputs",isolation); result->setProperty("stateRecall",recall);
    result->setProperty("oldStateMainOutput",legacy);result->setProperty("finite",finite);
    result->setProperty("hostPreservationAndFaders",host);result->setProperty("maximumLeak",maximumLeak);
    result->setProperty("legacyStereoError",maximumLegacyError);
    result->setProperty("audioQuality","not_asserted");return result;
}
