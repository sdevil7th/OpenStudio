#pragma once

inline juce::var checkFreeSignalCompatibility()
{
    bool pass = true; juce::Array<juce::var> cases;
    for (const auto& entry : freeSuiteFactories())
    {
        const juce::String name = entry.first;
        if (name == "Reverb" || name == "Delay" || name == "Compressor" || name == "Gate" || name == "Limiter"
            || name == "Graphic EQ" || name == "Gain Phase") continue;
        auto p = entry.second();
        const auto selected = [](juce::AudioProcessor& processor)
        {
            const auto schema = describeFreePluginForRegression(processor);
            if (const auto* parameters = schema["parameters"].getArray())
                for (const auto& parameter : *parameters)
                    if (parameter["id"].toString() == "signalPath") return static_cast<int>(parameter["value"]);
            return -1;
        };
        bool okay = selected(*p) == 1;
        juce::MemoryBlock modern; p->getStateInformation(modern);
        auto tree = juce::ValueTree::readFromData(modern.getData(), modern.getSize());
        tree.removeProperty("signalPath", nullptr);
        juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
        p->setStateInformation(old.getData(), static_cast<int>(old.getSize()));
        okay = okay && selected(*p) == 0;
        juce::MemoryBlock legacy; p->getStateInformation(legacy);
        // All four containers carry the full plugin bytes. Exercise the native
        // restoration entry point after portable base64 encode/decode as well
        // as direct old-project recall; alternate snapshots model Compare A/B.
        for (int iteration = 0; iteration < 4; ++iteration)
        {
            const auto& expected = iteration % 2 == 0 ? modern : legacy;
            juce::MemoryBlock decoded; okay = decoded.fromBase64Encoding(expected.toBase64Encoding()) && okay;
            okay = restoreFreePluginStateForRegression(*p, decoded) && okay;
            juce::MemoryBlock actual; p->getStateInformation(actual);
            const auto expectedTree = juce::ValueTree::readFromData(expected.getData(), expected.getSize());
            const auto actualTree = juce::ValueTree::readFromData(actual.getData(), actual.getSize());
            okay = expectedTree.isEquivalentTo(actualTree) && selected(*p) == (iteration % 2 == 0 ? 1 : 0) && okay;
        }
        auto* row = new juce::DynamicObject(); row->setProperty("plugin", name); row->setProperty("pass", okay);
        cases.add(row); pass = pass && okay;
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Signal path old-state and complete snapshot compatibility");
    result->setProperty("cases", cases); result->setProperty("pass", pass && cases.size() == 9); return result;
}

inline juce::var checkFreePitchRangeRepair()
{
    bool pass = true; juce::Array<juce::var> rows;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (double frequency : {40.0, 55.0, 82.406889, 110.0, 220.0, 440.0, 997.0})
        {
            PitchDetector detector; detector.setRateNormalized(true);
            detector.setMinFrequency(40); detector.setMaxFrequency(1000); detector.prepare(rate, 127);
            std::array<float, 127> input {};
            for (int position = 0; position < static_cast<int>(rate * .3); position += 127)
            {
                for (int i = 0; i < 127; ++i) input[static_cast<size_t>(i)] = static_cast<float>(.2 * std::sin(juce::MathConstants<double>::twoPi * frequency * (position + i) / rate));
                detector.processSamples(input.data(), 127);
            }
            const double actual = detector.getDetectedFrequency();
            const double cents = actual > 0 ? 1200 * std::log2(actual / frequency) : 9999;
            const bool okay = std::abs(cents) < 5 && detector.getConfidence() > .95f;
            auto* row = new juce::DynamicObject(); row->setProperty("rate", rate); row->setProperty("hz", frequency);
            row->setProperty("centsError", cents); row->setProperty("pass", okay); rows.add(row); pass = pass && okay;
        }
    // Stop-band signals which would alias into the advertised tracking band
    // without the decimator filter must remain below the detector silence gate.
    bool aliasPass = true;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        PitchDetector detector; detector.setRateNormalized(true); detector.setMinFrequency(40); detector.setMaxFrequency(1000); detector.prepare(rate, 127);
        const double analysisRate = rate / std::ceil(rate / 32000.0);
        const double frequency = analysisRate - 440;
        if (frequency >= rate * .5) continue;
        std::array<float, 127> input {};
        for (int position = 0; position < static_cast<int>(rate * .3); position += 127)
        {
            for (int i = 0; i < 127; ++i) input[static_cast<size_t>(i)] = static_cast<float>(.9 * std::sin(juce::MathConstants<double>::twoPi * frequency * (position + i) / rate));
            detector.processSamples(input.data(), 127);
        }
        aliasPass = aliasPass && detector.getDetectedFrequency() == 0;
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Corrected pitch range and anti-alias rejection");
    result->setProperty("cases", rows); result->setProperty("aliasRejection", aliasPass); result->setProperty("pass", pass && aliasPass);
    result->setProperty("audioQuality", "not_asserted"); return result;
}

inline juce::var checkFreeSignalTransitions()
{
    bool pass = true; juce::Array<juce::var> rows;
    // Repeated/reversed changes have identical event times at every partition.
    for (int oversampling : {0, 1, 2})
    {
        const auto render = [oversampling](int partition)
        {
            OpenStudioSaturator p; p.drive.store(18); p.mix.store(1); p.setOversamplingMode(static_cast<float>(oversampling));
            p.prepareToPlay(48000, partition); juce::MidiBuffer midi;
            juce::AudioBuffer<float> block(2, partition); std::vector<float> result(12000);
            const std::array<int, 6> times {2400, 2500, 2700, 5000, 5700, 12000};
            const std::array<float, 5> types {3, 0, 7, 6, 8}; size_t event = 0;
            for (int start = 0; start < 12000;)
            {
                if (start == times[event]) { p.satType.store(types[event]); ++event; }
                const int count = juce::jmin(partition, times[event] - start);
                block.setSize(2, count, false, false, true);
                for (int i = 0; i < count; ++i) for (int ch = 0; ch < 2; ++ch)
                    block.setSample(ch, i, .2f * std::sin(.13f * static_cast<float>(start + i)));
                p.processBlock(block, midi);
                for (int i = 0; i < count; ++i) result[static_cast<size_t>(start + i)] = block.getSample(0, i);
                start += count;
            }
            return result;
        };
        const auto reference = render(1);
        for (int partition : {32, 64, 127, 512, 1024})
        {
            const auto actual = render(partition); double error = 0; bool finite = true;
            for (size_t i = 0; i < actual.size(); ++i) { finite = finite && std::isfinite(actual[i]); error = juce::jmax(error, std::abs(static_cast<double>(actual[i] - reference[i]))); }
            const bool okay = finite && error < 2e-5; pass = pass && okay;
            auto* row = new juce::DynamicObject(); row->setProperty("oversampling", 1 << oversampling); row->setProperty("partition", partition); row->setProperty("maxError", error); row->setProperty("pass", okay); rows.add(row);
        }
    }
    juce::Array<juce::var> bypassRows;
    for (int channels : {1, 2}) for (int character : {0, 1}) for (double rate : {44100.0, 192000.0})
    {
        OpenStudioUtilityEffect p(OpenStudioUtilityEffect::Kind::Preamp);
        p.setControl("audioCharacter", static_cast<float>(character)); p.setControl("bypass", 1); p.prepareToPlay(rate, 32);
        const int latency = p.getLatencySamples(); juce::AudioBuffer<float> block(channels, 1024); juce::MidiBuffer midi;
        std::array<float, 4096> input {}; double error = 0; bool finite = true;
        for (size_t i = 0; i < input.size(); ++i) input[i] = .2f * std::sin(static_cast<float>(i) * .27f) + (i == 117 ? .4f : 0);
        for (int start = 0; start < 4096; start += 1024)
        {
            for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < 1024; ++i) block.setSample(ch, i, input[static_cast<size_t>(start+i)]);
            p.processBlock(block, midi);
            for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < 1024; ++i)
            {
                const float expected = start + i < latency ? 0 : input[static_cast<size_t>(start + i - latency)];
                finite = finite && std::isfinite(block.getSample(ch,i)); error = juce::jmax(error, std::abs(static_cast<double>(block.getSample(ch,i)-expected)));
            }
        }
        const bool okay = finite && error == 0; pass = pass && okay;
        auto* row = new juce::DynamicObject(); row->setProperty("channels", channels); row->setProperty("character", character); row->setProperty("rate", rate); row->setProperty("maxError", error); row->setProperty("pass", okay); bypassRows.add(row);
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Corrected signal transitions and Preamp oversize bypass");
    result->setProperty("saturator", rows); result->setProperty("preamp", bypassRows); result->setProperty("pass", pass); return result;
}

inline juce::var checkDrumReleaseRepair()
{
    bool pass = true; juce::Array<juce::var> rows;
    for (int engine : {0, 1}) for (int note : {46, 49, 51}) for (int output = 0; output <= 8; ++output)
    {
        const auto render = [engine, note, output](int controller)
        {
            auto p = std::make_unique<OpenStudioDrumInstrument>(); p->articulationEngine.store(static_cast<float>(engine));
            for (auto& destination : p->pieceOutput) destination.store(static_cast<float>(output));
            p->prepareToPlay(48000, 127); juce::AudioBuffer<float> block(18, 127), result(18, 96000); juce::MidiBuffer events, midi;
            events.addEvent(juce::MidiMessage::noteOn(10,note,1.0f),0);
            if (controller >= 0) events.addEvent(juce::MidiMessage::controllerEvent(10,controller,0),24000);
            for (int start=0;start<96000;start+=127)
            {
                const int count=juce::jmin(127,96000-start); block.setSize(18,count,false,false,true); block.clear();midi.clear();midi.addEvents(events,start,count,-start);
                p->processBlock(block,midi);for(int ch=0;ch<18;++ch)result.copyFrom(ch,start,block,ch,0,count);
            }
            return result;
        };
        const auto original=render(-1),released=render(123),panic=render(120);double error=0;
        for(int ch=0;ch<18;++ch)for(int i=0;i<96000;++i)error=juce::jmax(error,std::abs(static_cast<double>(original.getSample(ch,i)-released.getSample(ch,i))));
        const bool okay=error==0 && released.getMagnitude(24000,12000)>1e-5f && panic.getMagnitude(24000,72000)==0;
        auto* row=new juce::DynamicObject();row->setProperty("engine",engine);row->setProperty("note",note);row->setProperty("outputPair",output);row->setProperty("CC123Null",error);row->setProperty("pass",okay);rows.add(row);pass=pass&&okay;
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Drum CC123 decay and CC120 panic");result->setProperty("cases",rows);result->setProperty("pass",pass);return result;
}

inline juce::var profileSignalPitchCost()
{
    juce::Array<juce::var> rows; bool finite = true;
    for (int mode : {0, 1}) for (double rate : {48000.0, 96000.0, 192000.0}) for (int block : {32, 64, 128}) for (int count : {1, 4})
    {
        std::vector<std::unique_ptr<OpenStudioPitchCorrector>> processors;
        std::vector<juce::AudioBuffer<float>> buffers;
        for (int i=0;i<count;++i)
        {
            auto p=std::make_unique<OpenStudioPitchCorrector>();p->signalPath.store(static_cast<float>(mode));p->minFreqParam.store(40);p->maxFreqParam.store(1000);
            p->setRateAndBufferSizeDetails(rate,block);p->prepareToPlay(rate,block);processors.push_back(std::move(p));buffers.emplace_back(2,block);
        }
        juce::MidiBuffer midi;midi.ensureSize(1024);std::vector<double> times;times.reserve(2048);int overruns=0;
        for (int frame=-512;frame<2048;++frame)
        {
            midi.clear();for(auto& audio:buffers)for(int i=0;i<block;++i)for(int ch=0;ch<2;++ch)audio.setSample(ch,i,static_cast<float>(.15*std::sin(juce::MathConstants<double>::twoPi*82.406889*((frame+512)*block+i)/rate)));
            const auto start=juce::Time::getHighResolutionTicks();for(int i=0;i<count;++i)processors[static_cast<size_t>(i)]->processBlock(buffers[static_cast<size_t>(i)],midi);
            const double us=juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks()-start)*1e6;
            if(frame>=0){times.push_back(us);if(us>block/rate*1e6)++overruns;}
            for(const auto& audio:buffers)for(int ch=0;ch<2;++ch)for(int i=0;i<block;++i)finite=finite&&std::isfinite(audio.getSample(ch,i));
        }
        std::sort(times.begin(),times.end());auto* row=new juce::DynamicObject();row->setProperty("signalPath",mode);row->setProperty("rate",rate);row->setProperty("block",block);row->setProperty("instances",count);
        row->setProperty("medianUs",times[times.size()/2]);row->setProperty("p99Us",times[times.size()*99/100]);row->setProperty("maxUs",times.back());row->setProperty("deadlineUs",block/rate*1e6);row->setProperty("overruns",overruns);rows.add(row);
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Pitch signal repair deadline diagnostics");result->setProperty("cases",rows);result->setProperty("pass",finite);
    result->setProperty("status","diagnostic_only; sequential warmed in-process CPU; excludes audio-device scheduling");return result;
}

inline juce::var checkSignalPitchFFTParity()
{
    bool pass=true;juce::Array<juce::var> rows;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int block:{32,127,512})
    {
        signalsmith::stretch::SignalsmithStretch<float> oldEngine;
        signalsmith::stretch::SignalsmithStretch<float,void,true> newEngine;
        const auto setup=[&](auto& engine){engine.presetCheaper(2,static_cast<float>(rate));engine.setTransposeFactor(1.25f);engine.setFormantBase(static_cast<float>(220/rate));engine.setFormantSemitones(2,true);};setup(oldEngine);setup(newEngine);
        juce::AudioBuffer<float> input(2,block),a(2,block),b(2,block);std::array<const float*,2> in{input.getReadPointer(0),input.getReadPointer(1)};std::array<float*,2> outA{a.getWritePointer(0),a.getWritePointer(1)},outB{b.getWritePointer(0),b.getWritePointer(1)};
        double error=0,energy=0;bool finite=true;
        for(int start=0;start<static_cast<int>(rate*.4);start+=block)
        {
            for(int ch=0;ch<2;++ch)for(int i=0;i<block;++i)input.setSample(ch,i,static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*(220+ch*110)*(start+i)/rate)+.03*std::sin(.172*(start+i))));
            oldEngine.process(in,block,outA,block);newEngine.process(in,block,outB,block);
            for(int ch=0;ch<2;++ch)for(int i=0;i<block;++i){const double value=b.getSample(ch,i);finite=finite&&std::isfinite(value);energy+=value*value;error=juce::jmax(error,std::abs(value-a.getSample(ch,i)));}
        }
        const bool okay=finite&&energy>.01&&error<1e-5&&oldEngine.inputLatency()==newEngine.inputLatency()&&oldEngine.outputLatency()==newEngine.outputLatency();pass=pass&&okay;
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("block",block);row->setProperty("maximumError",error);row->setProperty("pass",okay);rows.add(row);
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Pitch Correct opt-in fine FFT scheduling parity");result->setProperty("cases",rows);result->setProperty("pass",pass);return result;
}


inline juce::var checkSignalPoleAndMIDICompatibility()
{
    bool polePass = true; double maximumRelativeTimeError = 0;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        BuiltInRatePole pole; pole.prepare(rate);
        polePass = polePass && pole.map(0) == 0 && pole.map(1) == 1;
        for (float coefficient : {.018f, .033f, .12f, .37f, .71f, .98f})
        {
            // Compare physical e-fold decay time against the 48 kHz pole,
            // independently of sample count and the lookup-table construction.
            const double measuredSeconds = -1 / (rate * std::log1p(-pole.map(coefficient)));
            const double expectedSeconds = -1 / (48000 * std::log1p(-static_cast<double>(coefficient)));
            maximumRelativeTimeError = juce::jmax(maximumRelativeTimeError, std::abs(measuredSeconds / expectedSeconds - 1));
            polePass = polePass && std::isfinite(measuredSeconds) && std::abs(measuredSeconds / expectedSeconds - 1) < .0005;
        }
    }
    bool midiPass = true;
    OpenStudioEQ source(true);
    auto* capture = new juce::DynamicObject(); capture->setProperty("action", "capture"); capture->setProperty("bank", 0); capture->setProperty("program", 3); capture->setProperty("name", "Signal recall");
    midiPass = source.editMIDIProgram(capture) && midiPass;
    auto* configure = new juce::DynamicObject(); configure->setProperty("action", "configure"); configure->setProperty("enabled", true); configure->setProperty("channel", 1);
    midiPass = source.editMIDIProgram(configure) && midiPass;
    juce::MemoryBlock saved; source.getStateInformation(saved);
    for (int mode : {0, 1})
    {
        auto tree = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
        auto slot = tree.getChildWithName("MIDIPrograms").getChild(0);
        midiPass = midiPass && slot.getProperty("configuration").size() == 7;
        if (mode == 0) { tree.removeProperty("signalPath", nullptr); slot.removeProperty("signalPath", nullptr); }
        juce::MemoryBlock encoded; { juce::MemoryOutputStream stream(encoded, false); tree.writeToStream(stream); }
        OpenStudioEQ restored(true); restored.setStateInformation(encoded.getData(), static_cast<int>(encoded.getSize()));
        // Configuration changes prepare their alternate MIDI engines off-thread.
        restored.signalPath.store(static_cast<float>(1 - mode));
        restored.setRateAndBufferSizeDetails(48000, 64); restored.prepareToPlay(48000, 64);
        juce::AudioBuffer<float> audio(2, 64); audio.clear(); juce::MidiBuffer midi;
        midi.addEvent(juce::MidiMessage::programChange(1, 3), 17); restored.processBlock(audio, midi);
        midiPass = midiPass && !static_cast<bool>(restored.midiProgramInfo()["restoreRejected"]) && restored.signalPath.load() == static_cast<float>(mode);
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Physical pole-time and EQ MIDI signal-path compatibility");
    result->setProperty("polePass", polePass); result->setProperty("maximumRelativeTimeError", maximumRelativeTimeError);
    result->setProperty("midiPass", midiPass); result->setProperty("pass", polePass && midiPass); return result;
}
