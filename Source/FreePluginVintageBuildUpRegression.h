juce::var checkVintageBuildUp()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Vintage input build-up and diffusion");
    bool pass = true, defaults = true, dry = true, retained = true; double partition = 0; juce::Array<juce::var> cases;
    for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0}) for (const int mode : {0, 1})
    {
        const auto render = [&](float time, float diffusionValue, int blockSize)
        {
            BuiltInVintageReverb engine; engine.prepare(rate, mode); BuiltInVintageReverb::Settings settings;
            settings.colour = 2; settings.modulation = 0; settings.buildUp = time; settings.inputDiffusion = diffusionValue;
            const int count = static_cast<int>(rate * .8); juce::AudioBuffer<float> audio(2, count);
            for (int i = 0; i < count; ++i)
            {
                if (i % blockSize == 0) engine.configure(mode, settings);
                const auto wet = engine.process(i == 0 ? .2f : 0, i == 0 ? -.1f : 0);
                audio.setSample(0, i, wet[0]); audio.setSample(1, i, wet[1]);
            }
            return audio;
        };
        const auto original = render(0, .5f, 127), disabled = render(0, 1, 511);
        const auto delayed = render(200, 0, 127), spread = render(200, 1, 127), divided = render(200, 1, 511);
        int firstOriginal = -1, firstDelayed = -1; double earlyOriginal = 0, earlySpread = 0; bool finite = true;
        for (int i = 0; i < original.getNumSamples(); ++i)
        {
            if (firstOriginal < 0 && std::abs(original.getSample(0, i)) > 1e-10f) firstOriginal = i;
            if (firstDelayed < 0 && std::abs(delayed.getSample(0, i)) > 1e-10f) firstDelayed = i;
            for (int ch = 0; ch < 2; ++ch)
            {
                defaults = defaults && original.getSample(ch, i) == disabled.getSample(ch, i);
                finite = finite && std::isfinite(spread.getSample(ch, i)) && std::abs(spread.getSample(ch, i)) < 2;
                partition = juce::jmax(partition, std::abs(static_cast<double>(spread.getSample(ch, i) - divided.getSample(ch, i))));
                if (firstOriginal >= 0 && i < firstOriginal + rate * .015)
                { earlyOriginal += std::pow(original.getSample(ch, i), 2); earlySpread += std::pow(spread.getSample(ch, i), 2); }
            }
        }
        const bool onset = firstOriginal >= 0 && firstDelayed - firstOriginal > rate * .199 && firstDelayed - firstOriginal < rate * .201;
        const bool distributed = earlyOriginal > 0 && earlySpread < earlyOriginal * .2 && earlySpread > earlyOriginal * .01;
        pass = pass && finite && onset && distributed;
        auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("mode", mode); row->setProperty("finite", finite);
        row->setProperty("zeroDiffusionDelaySeconds", static_cast<double>(firstDelayed - firstOriginal) / rate);
        row->setProperty("distributedEarlyEnergyRatio", earlySpread / juce::jmax(1e-30, earlyOriginal)); row->setProperty("onsetContract", onset && distributed); cases.add(row);
    }
    auto source = std::make_unique<OpenStudioReverb>(true), copy = std::make_unique<OpenStudioReverb>(true);
    source->selectAlgorithm(10); source->wetLevel.store(0); source->dryLevel.store(1);
    const bool setters = setFreePluginParamForRegression(*source,"vintageBuildUp",200) && setFreePluginParamForRegression(*source,"vintageInputDiffusion",.8f)
        && setFreePluginParamForRegression(*source,"vintage1.buildUp",300) && setFreePluginParamForRegression(*source,"vintage1.inputDiffusion",1);
    source->prepareToPlay(48000,127); juce::AudioBuffer<float> block(2,127); juce::MidiBuffer midi;
    for(int i=0;i<127;++i){block.setSample(0,i,.1f);block.setSample(1,i,-.07f);} source->processBlock(block,midi);
    for(int i=0;i<127;++i) dry=dry&&block.getSample(0,i)==.1f&&block.getSample(1,i)==-.07f;
    juce::MemoryBlock state, again; source->getStateInformation(state); copy->setStateInformation(state.getData(),static_cast<int>(state.getSize())); copy->getStateInformation(again);
    bool recall = state == again && copy->vintageBuildUp[0].load()==200 && copy->vintageBuildUp[1].load()==300 && copy->vintageInputDiffusion[0].load()==.8f;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(int slot=0;slot<2;++slot){tree.removeProperty("vintage"+juce::String(slot)+"BuildUp",nullptr);tree.removeProperty("vintage"+juce::String(slot)+"InputDiffusion",nullptr);}
    juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));
    for(size_t slot=0;slot<2;++slot)recall=recall&&copy->vintageBuildUp[slot].load()==0&&copy->vintageInputDiffusion[slot].load()==.5f;
    source->wetLevel.store(1);const double withBuildUp=source->getTailLengthSeconds();source->vintageBuildUp[0].store(0);const bool tail=std::abs(withBuildUp-source->getTailLengthSeconds()-6)<1e-5;
    BuiltInVintageReverb a,b;a.prepare(48000,0);b.prepare(48000,0);BuiltInVintageReverb::Settings settings;settings.buildUp=300;settings.inputDiffusion=1;
    a.configure(0,settings,true);b.configure(0,settings,true);for(int i=0;i<7000;++i){a.process(i==0?.2f:0,0);b.process(i==0?.2f:0,0);}a.configure(-1,settings,true);settings.buildUp=0;settings.inputDiffusion=0;b.configure(-1,settings,true);
    for(int i=0;i<20000;++i)retained=retained&&a.process(0,0)==b.process(0,0);
    const auto schema=describeFreePluginForRegression(*source);const bool appended=schema["parameters"].size()>=538&&schema["parameters"][532]["id"].toString()=="vintageBuildUp"&&schema["parameters"][537]["id"].toString()=="vintage1.inputDiffusion";
    result->setProperty("pass",pass&&defaults&&dry&&retained&&setters&&recall&&tail&&appended&&partition==0);
    result->setProperty("zeroBuildUpExact",defaults);result->setProperty("dryExact",dry);result->setProperty("partitionError",partition);result->setProperty("retiringSettingsRetained",retained);
    result->setProperty("stateAndOldDefaults",recall);result->setProperty("hostTailIncludesDiffusers",tail);result->setProperty("setters",setters);result->setProperty("appendedDescriptors",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("referenceAndAudioQuality","not_asserted");return result;
}
