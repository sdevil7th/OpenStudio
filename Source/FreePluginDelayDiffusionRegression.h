#pragma once
inline juce::var checkDelayDiffusion()
{
    auto* result = new juce::DynamicObject(); bool finite = true, changed = true, state = true, tail = true, reset = true;
    double partition = 0, bypass = 0; int cases = 0;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (int channels : {1, 2}) for (int mode = 0; mode < 5; ++mode)
    {
        const auto render = [&](float amount, int blockSize)
        {
            auto delay = std::make_unique<OpenStudioDelay>(.25f, true);
            delay->delayTimeL.store(31); delay->delayTimeR.store(43); delay->delayMode.store(static_cast<float>(mode));
            delay->diffusionAmount.store(amount); delay->diffusionSpanMs.store(200); delay->mix.store(1); delay->prepareToPlay(rate, blockSize);
            const int count = static_cast<int>(rate * .35); juce::AudioBuffer<float> audio(channels, count); audio.clear();
            audio.setSample(0, 0, .2f); if (channels > 1) audio.setSample(1, 0, -.11f); juce::MidiBuffer midi;
            for (int start = 0; start < count; start += blockSize)
            {
                float* pointers[]{audio.getWritePointer(0, start), channels > 1 ? audio.getWritePointer(1, start) : nullptr};
                juce::AudioBuffer<float> part(pointers, channels, juce::jmin(blockSize, count - start)); delay->processBlock(part, midi);
            }
            return audio;
        };
        const auto direct = render(0, 127), diffuse = render(1, 127), other = render(1, 512); double difference = 0;
        for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < direct.getNumSamples(); ++i)
        {
            const double value = diffuse.getSample(ch, i); finite = finite && std::isfinite(value) && std::abs(value) < 1;
            difference += std::abs(value - direct.getSample(ch, i)); partition = juce::jmax(partition, std::abs(value - other.getSample(ch, i)));
        }
        changed = changed && difference > .01; ++cases;
    }
    BuiltInDelayDiffusion helper; helper.prepare(48000, 0, 40);
    for (int i = 0; i < 1000; ++i) { float left = i * .001f, right = -left; helper.process(left, right); bypass = juce::jmax(bypass, std::abs(static_cast<double>(left - i * .001f)), std::abs(static_cast<double>(right + i * .001f))); }
    helper.configure(1, 200); for (int i = 0; i < 10000; ++i) { float l = i == 0 ? 1.0f : 0.0f, r = l; helper.process(l, r); }
    helper.configure(0, 5); for (int i = 0; i < 5000; ++i) { float l = 0, r = 0; helper.process(l, r); finite = finite && std::isfinite(l) && std::isfinite(r); }
    helper.configure(1, 40); for (int i = 0; i < 5000; ++i) { float l = 0, r = 0; helper.process(l, r); reset = reset && l == 0 && r == 0; }
    auto processor = std::make_unique<OpenStudioDelay>(.5f, true); processor->setStandaloneControl("diffusionAmount", .7f); processor->setStandaloneControl("diffusionSpanMs", 170);
    const double withDiffusion = processor->getTailLengthSeconds(); processor->diffusionAmount.store(0); tail = withDiffusion >= processor->getTailLengthSeconds() + 10; processor->diffusionAmount.store(.7f);
    juce::MemoryBlock bytes, again; processor->getStateInformation(bytes); auto copy = std::make_unique<OpenStudioDelay>(.5f, true); copy->setStateInformation(bytes.getData(), static_cast<int>(bytes.getSize())); copy->getStateInformation(again); state = bytes == again && copy->diffusionAmount.load() == .7f && copy->diffusionSpanMs.load() == 170;
    auto old = juce::ValueTree::readFromData(bytes.getData(), bytes.getSize()); old.removeProperty("diffusionAmount", nullptr); old.removeProperty("diffusionSpanMs", nullptr); juce::MemoryBlock oldBytes; juce::MemoryOutputStream stream(oldBytes, false); old.writeToStream(stream); copy->setStateInformation(oldBytes.getData(), static_cast<int>(oldBytes.getSize())); state = state && copy->diffusionAmount.load() == 0 && copy->diffusionSpanMs.load() == 40;
    const auto schema = describeFreePluginForRegression(*processor); const auto* parameters = schema["parameters"].getArray(); state = state && parameters && parameters->size() >= 35 && (*parameters)[32]["id"].toString() == "delayType" && (*parameters)[33]["id"].toString() == "diffusionAmount" && (*parameters)[34]["id"].toString() == "diffusionSpanMs";
    result->setProperty("plugin", "Standalone delay wet diffusion"); result->setProperty("rateChannelModeCases", cases); result->setProperty("finite", finite); result->setProperty("allModesChanged", changed); result->setProperty("partitionError", partition); result->setProperty("exactOffError", bypass); result->setProperty("offClearsHistory", reset); result->setProperty("stateAndOldDefaults", state); result->setProperty("conservativeTail", tail); result->setProperty("schema", schema); result->setProperty("audioQuality", "not_asserted"); result->setProperty("pass", finite && changed && partition < 1e-7 && bypass == 0 && reset && state && tail); return result;
}
