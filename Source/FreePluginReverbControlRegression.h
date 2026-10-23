#pragma once

// Complete native mix-path references, including auxiliary convolution output.
// This is a control/compatibility gate, not an audible-quality assessment.
inline juce::var checkReverbControlBehavior()
{
    using namespace ReverbReturnRegression;
    auto* result = new juce::DynamicObject();
    juce::Array<juce::var> rows;
    bool overall = true;
    const auto add = [&](const juce::String& name, bool pass, double maximum = 0) {
        auto* row = new juce::DynamicObject(); row->setProperty("kind", name);
        row->setProperty("pass", pass); row->setProperty("maximumError", maximum);
        rows.add(row); overall = overall && pass;
    };
    auto fresh = std::make_unique<OpenStudioReverb>(true);
    auto restored = std::make_unique<OpenStudioReverb>(true);
    auto embedded = std::make_unique<OpenStudioReverb>(false);
    bool state = fresh->reverbControlMode.load() == 1 && embedded->reverbControlMode.load() == 0;
    state = setFreePluginParamForRegression(*fresh, "reverbControlMode", 0) && state;
    juce::MemoryBlock saved, repeated; fresh->getStateInformation(saved);
    restored->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    restored->getStateInformation(repeated);
    state = saved == repeated && restored->reverbControlMode.load() == 0 && state;
    state = setFreePluginNormalizedForRegression(*restored, "reverbControlMode", 1) && state;
    restored->selectAlgorithm(40); restored->selectSendMode(true);
    state = restored->reverbControlMode.load() == 1 && state;
    auto old = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
    old.removeProperty("reverbControlMode", nullptr); const auto missing = bytes(old);
    restored->setStateInformation(missing.getData(), static_cast<int>(missing.getSize()));
    state = restored->reverbControlMode.load() == 0 && state;
    old.setProperty("reverbControlMode", std::numeric_limits<double>::quiet_NaN(), nullptr);
    const auto invalid = bytes(old); restored->setStateInformation(invalid.getData(), static_cast<int>(invalid.getSize()));
    state = restored->reverbControlMode.load() == 0 && state;
    state = !setFreePluginParamForRegression(*embedded, "reverbControlMode", 1)
        && !setFreePluginNormalizedForRegression(*embedded, "reverbControlMode", 1) && state;
    const auto params = describeFreePluginForRegression(*fresh)["parameters"];
    state = params.size() == 1090 && params[1089]["id"].toString() == "reverbControlMode" && state;
    add("state_migration_append_only_and_embedded", state);

    const auto matrixFile=juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-correction/matrix-wet-ramp.wav");
    juce::AudioBuffer<float> matrixIR(4,128); matrixIR.clear();
    for (int ch=0;ch<4;++ch) matrixIR.setSample(ch,3+ch*19,.2f+static_cast<float>(ch)*.04f);
    add("matrix_ir_fixture",writeProbeWave(matrixFile,matrixIR,48000));
    int allocations = 0, frees = 0; bool heapMeasured = false, finite = true;
    const auto render = [&](int type, double rate, int variant, bool irregular, int mode = 1) {
        auto processor = std::make_unique<OpenStudioReverb>(true);
        processor->selectAlgorithm(type); processor->reverbControlMode.store(static_cast<float>(mode));
        processor->wetLevel.store(variant == 1 ? 0.0f : 1.0f);
        processor->dryLevel.store(variant == 1 ? 1.0f : 0.0f);
        if (type == 7) {
            auto* settings=new juce::DynamicObject(); settings->setProperty("outputLayout",1); settings->setProperty("normalise",false);
            const bool loaded=processor->convolutionSpace.loadFile(matrixFile);
            const bool shaped=processor->convolutionSpace.edit(juce::var(settings));
            overall=loaded&&shaped&&overall;
        }
        if (variant == 3) {
            processor->roomSize.store(0);
            processor->spatialControls[static_cast<size_t>(type-12)][5].store(1);
            processor->spatialControls[static_cast<size_t>(type-12)][6].store(type==14?20.0f:2.0f);
        }
        processor->prepareToPlay(rate, 128);
        const int length = juce::roundToInt(rate * .30), first = juce::roundToInt(rate * .18), reverse = juce::roundToInt(rate * .19);
        const int outputs = processor->getTotalNumOutputChannels();
        juce::AudioBuffer<float> output(outputs, length), block(outputs, 257); juce::MidiBuffer midi;
        constexpr std::array<int,4> sizes{1, 37, 113, 257};
        for (int start = 0, part = 0; start < length; ++part)
        {
            if (variant == 2 && start == first) { processor->wetLevel.store(0); processor->dryLevel.store(1); }
            if (variant == 2 && start == reverse) { processor->wetLevel.store(.8f); processor->dryLevel.store(.2f); }
            if (variant == 3 && (start == first || start == reverse)) {
                processor->roomSize.store(start==first?1.0f:0.0f);
                processor->spatialControls[static_cast<size_t>(type-12)][5].store(start==first?0.0f:1.0f);
            }
            int count = juce::jmin(irregular ? sizes[static_cast<size_t>(part % 4)] : 128, length-start);
            if (start < first) count = juce::jmin(count, first-start);
            if (start < reverse) count = juce::jmin(count, reverse-start);
            block.setSize(outputs, count, false, false, true); block.clear();
            for (int i=0; i<count; ++i)
            {
                const double t = (start+i)/rate;
                const float input = .013f*static_cast<float>(std::sin(t*1741) + .4*std::sin(t*7193));
                block.setSample(0,i,input); block.setSample(1,i,-input*.71f);
            }
#if JUCE_WINDOWS && JUCE_DEBUG
            ReverbCompatibilityHeapProbe::allocations = ReverbCompatibilityHeapProbe::frees = 0;
            ReverbCompatibilityHeapProbe::previous = _CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
            ReverbCompatibilityHeapProbe::active = true;
#endif
            processor->processBlock(block,midi);
#if JUCE_WINDOWS && JUCE_DEBUG
            ReverbCompatibilityHeapProbe::active = false; _CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
            allocations += ReverbCompatibilityHeapProbe::allocations; frees += ReverbCompatibilityHeapProbe::frees; heapMeasured = true;
#endif
            for(int ch=0;ch<outputs;++ch) {
                output.copyFrom(ch,start,block,ch,0,count);
                for (int i=0;i<count;++i) finite = std::isfinite(block.getSample(ch,i)) && finite;
            }
            start += count;
        }
        return output;
    };
    for (int type = 0; type < 41; ++type)
    {
        constexpr double rate = 48000;
        const auto wet = render(type,rate,0,false), dry = render(type,rate,1,false);
        if (type == 7) add("nonzero_auxiliary_wet_reference",wet.getNumChannels()==4&&wet.getMagnitude(2,0,wet.getNumSamples())>1e-6f&&wet.getMagnitude(3,0,wet.getNumSamples())>1e-6f);
        const auto moved = render(type,rate,2,false), split = render(type,rate,2,true);
        double maximum = 0;
        for(int i=8640;i<moved.getNumSamples();++i)
        {
            const double w = i<9120 ? 1.0-(i-8640+1)/960.0 : i<10080 ? .5+.3*(i-9120+1)/960.0 : .8;
            for(int ch=0;ch<moved.getNumChannels();++ch)
                maximum = juce::jmax(maximum,std::abs(moved.getSample(ch,i)-(w*wet.getSample(ch,i)+(1-w)*dry.getSample(ch,i))));
        }
        const double partition = error(moved,split);
        add("wet_dry_interrupted_ramp_type_"+juce::String(type),maximum<2e-6&&partition<2e-6,juce::jmax(maximum,partition));
    }
    for(double rate : {44100.0,96000.0,192000.0})
    {
        const auto whole=render(14,rate,2,false), split=render(14,rate,2,true);
        const double maximum=error(whole,split);
        add("spatial_rate_partition_"+juce::String(rate,0),maximum<2e-6,maximum);
    }
    for (int type : {12,13,14}) for (double rate : {44100.0,48000.0,96000.0,192000.0}) {
        const auto whole=render(type,rate,3,false), split=render(type,rate,3,true);
        const double maximum=error(whole,split);
        add("spatial_extreme_transitions_"+juce::String(type)+"_"+juce::String(rate,0),maximum<2e-6,maximum);
    }
    for (int type : {0,7,14,24})
    {
        const auto wet=render(type,48000,0,false,0), dry=render(type,48000,1,false,0), moved=render(type,48000,2,false,0);
        double maximum=0;
        for(int i=8640;i<moved.getNumSamples();++i)
        {
            const double w=i<9120?0:.8;
            for(int ch=0;ch<moved.getNumChannels();++ch)
                maximum=juce::jmax(maximum,std::abs(moved.getSample(ch,i)-(w*wet.getSample(ch,i)+(1-w)*dry.getSample(ch,i))));
        }
        add("legacy_mix_retained_type_"+juce::String(type),maximum<2e-6,maximum);
    }
    add("callback_heap",allocations==0&&frees==0);
    add("finite_output",finite);
    result->setProperty("plugin","Standalone corrected controls"); result->setProperty("pass",overall);
    result->setProperty("cases",rows); result->setProperty("callbackAllocations",allocations); result->setProperty("callbackFrees",frees);
    result->setProperty("heapMeasured",heapMeasured); result->setProperty("audioQuality","not_asserted");
    return result;
}
