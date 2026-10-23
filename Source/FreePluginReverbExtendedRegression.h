#pragma once
#include <limits>

// Opt-in, deliberately longer than the ordinary regression suite. This checks
// actual wrapper safety and callback partitioning, not musical quality, an
// acoustic RT60 contract, indefinite Hold, or hardware/device performance.
// Include after FreePluginReverbCompatibilityRegression.h for its CRT probe.
namespace ReverbExtendedRegression
{
struct Options
{
    int type = 0, channels = 2, processing = 0;
    double rate = 48000;
    bool hold = false, boundedProbe = false;
    bool spreadShimmer = false;
    float vowelBody = 0;
    int nonlinearShape = 0;
    float nonlinearMotion = 0, nonlinearMotionRate = .7f;
    int returnMode = 1;
    bool heldAcceptsInput = true;
    float outputDb = 0;
    bool liveReturnSwitch=false;
};

struct Measurement
{
    bool prepared = true, finite = true, stateParity = true;
    double peak = 0, partitionError = 0, inputEnergy = 0, releaseStartEnergy = 0;
    double finalEnergy = 0, silentHoldEnergy = 0, outputEnergy = 0;
    juce::int64 samplesAtSafetyBound = 0, callbacks = 0;
    std::array<juce::int64, 4> phaseSafetyBoundSamples {};
    double firstSafetyBoundSeconds = -1;
    juce::int64 finalSamples = 0, releaseSamples = 0, silentHoldSamples = 0;
    int allocations = 0, frees = 0;
    bool heapMeasured = false;
    double seconds = 0, declaredReleaseTail = 0;
    double nonlinearStoredPeak=0,nonlinearLateStoredPeak=0;
    std::uint64_t nonlinearBudgetInterventions=0,nonlinearLateBudgetInterventions=0;
    double springStoredPeak=0,risingStoredPeak=0;
    std::uint64_t springBudgetInterventions=0,risingBudgetInterventions=0;
};

inline void setHold(OpenStudioReverb& processor, int type, bool held, bool acceptsInput = true)
{
    const float value = held ? 1.0f : 0.0f;
    if (type == 4) processor.springHold.store(value);
    else if (type == 5) processor.shimmerHold.store(value);
    else if (type == 6) processor.nonlinearHold.store(value);
    else if (type == 15) processor.magneticHold.store(value);
    else if (type == 16) processor.positionedHold.store(value);
    else if (type >= 17 && type <= 20)
        processor.ambientControls[static_cast<size_t>(type - 17)][9].store(held ? acceptsInput ? 1.0f : 2.0f : 0.0f); // 1 = Hold accepting input, 2 = Freeze.
    else processor.freezeMode.store(value);
}

inline void setDecay(OpenStudioReverb& processor, int type, bool extended)
{
    processor.decayTime.store(extended ? (type == 6 ? 2.0f : 20.0f) : .25f);
    if (type == 19) processor.ambientControls[2][8].store(extended ? 50.0f : 1.0f);
    if (type >= 27) processor.retroControls[static_cast<size_t>(type - 27)][0].store(extended ? 70.0f : .25f);
    if (type == 6)
    {
        processor.creativeControls[1].store(extended ? .95f : 0.0f);
        processor.creativeControls[2].store(extended ? 20.0f : .25f);
        processor.creativeControls[3].store(1.0f);
    }
    // Delay-based spaces have independent feedback rather than this Decay knob.
    // A finite feedback target is explicit on release; it is never a Hold clear.
    if (!extended && type == 15) processor.echoRoomControls[0][3].store(.2f);
    if (!extended && type >= 12 && type <= 14) processor.spatialControls[static_cast<size_t>(type - 12)][1].store(.2f);
}

inline bool configure(OpenStudioReverb& processor, const Options& options)
{
    auto layout = processor.getBusesLayout();
    const auto channels = options.channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo();
    layout.inputBuses.set(0, channels); layout.outputBuses.set(0, channels);
    const bool layoutPass = processor.setBusesLayout(layout);
    processor.selectAlgorithm(options.type);
    processor.wetLevel.store(1); processor.dryLevel.store(0); processor.outputTrimDb.store(options.outputDb);
    processor.reverbReturnMode.store(static_cast<float>(options.returnMode)); processor.reverbCharacterMode.store(static_cast<float>(options.processing));
    processor.shimmerScheduling.store(options.spreadShimmer ? 1.0f : 0.0f);
    processor.ambBody.store(options.vowelBody);
    processor.nonlinearShape.store(static_cast<float>(options.nonlinearShape));
    processor.nonlinearModulation.store(options.nonlinearMotion);
    processor.nonlinearRate.store(options.nonlinearMotionRate);
    processor.tailSpillover.store(0);
    processor.holdInputModes[static_cast<size_t>(options.type)].store(options.heldAcceptsInput ? 1.0f : 0.0f);
    if (options.type == 4) processor.springControls[0].store(1); // Qualify the prepared dispersive engine.
    setDecay(processor, options.type, true);
    processor.prepareToPlay(options.rate, 256);
    return layoutPass;
}

inline void processChecked(OpenStudioReverb& processor, juce::AudioBuffer<float>& block,
                           juce::MidiBuffer& midi, Measurement& measurement)
{
#if JUCE_WINDOWS && JUCE_DEBUG
    ReverbCompatibilityHeapProbe::allocations = ReverbCompatibilityHeapProbe::frees = 0;
    ReverbCompatibilityHeapProbe::previous = _CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
    ReverbCompatibilityHeapProbe::active = true;
#endif
    processor.processBlock(block, midi);
#if JUCE_WINDOWS && JUCE_DEBUG
    ReverbCompatibilityHeapProbe::active = false;
    _CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
    measurement.allocations += ReverbCompatibilityHeapProbe::allocations;
    measurement.frees += ReverbCompatibilityHeapProbe::frees;
    measurement.heapMeasured = true;
#endif
    ++measurement.callbacks;
}

inline Measurement measure(const Options& options)
{
    Measurement measurement;
    auto regular = std::make_unique<OpenStudioReverb>(true);
    auto irregular = std::make_unique<OpenStudioReverb>(true);
    measurement.prepared = configure(*regular, options) && configure(*irregular, options);
    if (!measurement.prepared) return measurement;
    const int outputs = regular->getTotalNumOutputChannels();
    measurement.prepared = outputs == irregular->getTotalNumOutputChannels() && outputs >= options.channels && outputs <= 4;
    if (!measurement.prepared) return measurement;

    constexpr int windowSize = 1024;
    juce::AudioBuffer<float> reference(outputs, windowSize), variant(outputs, windowSize);
    // One deterministic periodic table is prepared outside callbacks. Source
    // indexing depends on absolute sample position, never callback boundaries.
    juce::AudioBuffer<float> excitation(2, juce::roundToInt(options.rate));
    juce::uint32 random = 0x8f1735u;
    for (int sample = 0; sample < excitation.getNumSamples(); ++sample)
    {
        random = random * 1664525u + 1013904223u;
        const float noise = static_cast<float>(random >> 8) / 8388608.0f - 1;
        const double time = static_cast<double>(sample) / options.rate;
        const float tone = static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * 223 * time)
            + .47 * std::sin(juce::MathConstants<double>::twoPi * 977 * time)
            + .21 * std::sin(juce::MathConstants<double>::twoPi * 3001 * time));
        excitation.setSample(0, sample, .06f * noise + .035f * tone);
        excitation.setSample(1, sample, -.047f * noise + .023f * tone);
    }
    const int holdStart = juce::roundToInt(options.rate * (options.boundedProbe ? .12 : 1));
    const int sourceEnd = options.hold ? juce::roundToInt(options.rate * (options.boundedProbe ? .32 : 31)) : holdStart;
    const int release = options.hold ? juce::roundToInt(options.rate * (options.boundedProbe ? .52 : 61)) : -1;
    const int returnSwitch=options.liveReturnSwitch?juce::roundToInt(options.rate*3):-1;
    // Fresh finite long-tail capture covers the conservative declared allowance
    // plus two seconds. Hold is 30 s with input followed by 30 s with zero input.
    const double naturalTail = regular->getTailLengthSeconds();
    const int length = options.hold ? juce::roundToInt(options.rate * (options.boundedProbe ? .92 : 73))
        : juce::roundToInt(options.rate * (1 + naturalTail + 2));
    measurement.seconds = static_cast<double>(length) / options.rate;
    measurement.declaredReleaseTail = naturalTail;
    juce::MidiBuffer midi;
    const std::array<int, 5> partitions {1, 17, 63, 257, 1021};
    size_t partitionIndex = 0;
    for (int start = 0; start < length;)
    {
        if (options.hold && start == holdStart)
        {
            setHold(*regular, options.type, true, options.heldAcceptsInput); setHold(*irregular, options.type, true, options.heldAcceptsInput);
        }
        if (options.hold && start == release)
        {
            setHold(*regular, options.type, false); setHold(*irregular, options.type, false);
            setDecay(*regular, options.type, false); setDecay(*irregular, options.type, false);
            measurement.declaredReleaseTail = regular->getTailLengthSeconds();
        }
        if(start==returnSwitch){regular->reverbReturnMode.store(1);irregular->reverbReturnMode.store(1);}
        int count = juce::jmin(windowSize, length - start);
        for (const int event : {holdStart, sourceEnd, release,returnSwitch})
            if (start < event) count = juce::jmin(count, event - start);
        reference.clear(); variant.clear();
        for (int sample = 0; sample < count; ++sample)
            if (start + sample < sourceEnd)
                for (int channel = 0; channel < options.channels; ++channel)
                {
                    const float value = excitation.getSample(channel, (start + sample) % excitation.getNumSamples());
                    reference.setSample(channel, sample, value); variant.setSample(channel, sample, value);
                    measurement.inputEnergy += static_cast<double>(value) * value;
                }
        const auto processWindow = [&] (OpenStudioReverb& processor, juce::AudioBuffer<float>& buffer, bool irregularBlocks)
        {
            for (int offset = 0; offset < count;)
            {
                const int chunk = juce::jmin(irregularBlocks ? partitions[partitionIndex++ % partitions.size()] : 256, count - offset);
                std::array<float*, 4> pointers {};
                for (int channel = 0; channel < outputs; ++channel)
                    pointers[static_cast<size_t>(channel)] = buffer.getWritePointer(channel, offset);
                juce::AudioBuffer<float> view(pointers.data(), outputs, chunk);
                processChecked(processor, view, midi, measurement);
                offset += chunk;
            }
        };
        processWindow(*regular, reference, false); processWindow(*irregular, variant, true);
        if(options.type==6)
        {
            const auto& generator=OpenStudioReverbCompatibilityRegressionAccess::nonlinearBudget(*regular);
            const auto& late=OpenStudioReverbCompatibilityRegressionAccess::nonlinearLateBudget(*regular);
            measurement.nonlinearStoredPeak=juce::jmax(measurement.nonlinearStoredPeak,static_cast<double>(generator.storedPeak()));
            measurement.nonlinearLateStoredPeak=juce::jmax(measurement.nonlinearLateStoredPeak,static_cast<double>(late.storedPeak()));
            measurement.nonlinearBudgetInterventions=juce::jmax(measurement.nonlinearBudgetInterventions,generator.interventionCount());
            measurement.nonlinearLateBudgetInterventions=juce::jmax(measurement.nonlinearLateBudgetInterventions,late.interventionCount());
        }
        else if(options.type==4)
        {
            const auto& budget=OpenStudioReverbCompatibilityRegressionAccess::springBudget(*regular);
            measurement.springStoredPeak=juce::jmax(measurement.springStoredPeak,static_cast<double>(budget.storedPeak()));
            measurement.springBudgetInterventions=juce::jmax(measurement.springBudgetInterventions,budget.interventionCount());
        }
        else if(options.type==17)
        {
            const auto& budget=OpenStudioReverbCompatibilityRegressionAccess::risingBudget(*regular);
            measurement.risingStoredPeak=juce::jmax(measurement.risingStoredPeak,static_cast<double>(budget.storedPeak()));
            measurement.risingBudgetInterventions=juce::jmax(measurement.risingBudgetInterventions,budget.interventionCount());
        }
        for (int channel = 0; channel < outputs; ++channel)
            for (int sample = 0; sample < count; ++sample)
            {
                const double value = reference.getSample(channel, sample), other = variant.getSample(channel, sample);
                measurement.finite = std::isfinite(value) && std::isfinite(other) && measurement.finite;
                measurement.peak = juce::jmax(measurement.peak, std::abs(value), std::abs(other));
                measurement.partitionError = juce::jmax(measurement.partitionError, std::abs(value - other));
                measurement.outputEnergy += value * value;
                const int position = start + sample;
                if (std::abs(value) >= 4 || std::abs(other) >= 4)
                {
                    ++measurement.samplesAtSafetyBound;
                    const double seconds = static_cast<double>(position) / options.rate;
                    if (measurement.firstSafetyBoundSeconds < 0 || seconds < measurement.firstSafetyBoundSeconds)
                        measurement.firstSafetyBoundSeconds = seconds;
                    const size_t phase = !options.hold ? position < sourceEnd ? 0u : 3u
                        : position < holdStart ? 0u : position < sourceEnd ? 1u : position < release ? 2u : 3u;
                    ++measurement.phaseSafetyBoundSamples[phase];
                }
                if (position >= length - excitation.getNumSamples())
                {
                    measurement.finalEnergy += value * value; ++measurement.finalSamples;
                }
                if (options.hold && position >= juce::jmax(sourceEnd, release - excitation.getNumSamples()) && position < release)
                {
                    measurement.silentHoldEnergy += value * value; ++measurement.silentHoldSamples;
                }
                const int releaseStart = options.hold ? release : sourceEnd;
                if (position >= releaseStart && position < releaseStart + excitation.getNumSamples())
                {
                    measurement.releaseStartEnergy += value * value; ++measurement.releaseSamples;
                }
            }
        start += count;
    }
    juce::MemoryBlock firstState, secondState;
    regular->getStateInformation(firstState); irregular->getStateInformation(secondState);
    measurement.stateParity = firstState == secondState;
    return measurement;
}
}

inline juce::var runReverbExtendedQualification(bool boundedHeapProbe, int finiteType = -1, bool holdHeadroom = false)
{
    using namespace ReverbExtendedRegression;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", boundedHeapProbe ? "Standalone Reverb bounded callback heap transitions" : "Standalone Reverb extended Hold and tail qualification");
    result->setProperty("profile", holdHeadroom ? "focused_accumulating_hold_headroom" : finiteType >= 0 ? "focused_maximum_finite_tail" : boundedHeapProbe ? "bounded_debug_heap_transitions" : "full_extended_release_qualification");
    result->setProperty("audioQuality", "not_asserted");
    result->setProperty("indefiniteHold", "not_asserted");
    result->setProperty("hardwareDeviceDropouts", "not_asserted");
    result->setProperty("realRecordedVoice", "not_asserted");
    result->setProperty("bound", "Existing final output sanitizer +/-4; samples at this bound are separately reported, not treated as unclipped audio.");
    result->setProperty("internalRingAndFdnSaturation", "Infinite write-budget telemetry covers Nonlinear generator/late FDN, dispersive Spring and Rising tank; other internal states are not_asserted");
    juce::Array<juce::var> cases;
    bool overall = true, heapMeasured = false;
    int allocations = 0, frees = 0;
    double partitionError = 0;
    const double startedAt = juce::Time::getMillisecondCounterHiRes();
    const auto progressFile = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-extended/progress.json");
    const bool progressDirectoryReady = progressFile.getParentDirectory().createDirectory().wasOk();
    bool progressWritten = progressDirectoryReady;
    const auto checkpoint = [&] (const Options* options, bool rowPass)
    {
        // Harness-only disk work occurs after the complete measured row, with
        // the callback heap probe disabled. Never perform this in processBlock.
        auto* progress = new juce::DynamicObject();
        progress->setProperty("profile", result->getProperty("profile"));
        progress->setProperty("completedCount", cases.size());
        progress->setProperty("elapsedSeconds", (juce::Time::getMillisecondCounterHiRes() - startedAt) * .001);
        const auto now = juce::Time::getCurrentTime();
        progress->setProperty("updatedAt", now.toISO8601(true)); // Includes the explicit local UTC offset.
        progress->setProperty("updatedUnixMilliseconds", now.toMilliseconds());
        progress->setProperty("overallPassSoFar", overall);
        progress->setProperty("lastRowPass", rowPass);
        if (options != nullptr)
        {
            progress->setProperty("type", options->type); progress->setProperty("sampleRate", options->rate);
            progress->setProperty("channels", options->channels); progress->setProperty("processingMode", options->processing);
            progress->setProperty("hold", options->hold); progress->setProperty("shimmerScheduling", options->spreadShimmer ? 1 : 0);
            progress->setProperty("vowelBody", options->vowelBody); progress->setProperty("nonlinearShape", options->nonlinearShape);
            progress->setProperty("nonlinearMotion", options->nonlinearMotion);
            progress->setProperty("nonlinearMotionRate", options->nonlinearMotionRate);
            progress->setProperty("returnMode", options->returnMode); progress->setProperty("heldAcceptsInput", options->heldAcceptsInput);
            progress->setProperty("outputDb", options->outputDb);
        }
        const juce::var snapshot(progress);
        progressWritten = progressDirectoryReady && progressFile.replaceWithText(juce::JSON::toString(snapshot)) && progressWritten;
    };
    checkpoint(nullptr, true);
    const auto add = [&] (const Options& options)
    {
        const auto capture = measure(options);
        // Absolute floor is numerical silence for this small source; relative
        // energy requires >=60 dB RMS reduction after the finite release. It
        // is a decay-to-silence safety gate, never a fitted RT60 assertion.
        const double finalRms = std::sqrt(capture.finalEnergy / static_cast<double>(juce::jmax(juce::int64{1}, capture.finalSamples)));
        const double releaseRms = std::sqrt(capture.releaseStartEnergy / static_cast<double>(juce::jmax(juce::int64{1}, capture.releaseSamples)));
        const double silentHoldRms = std::sqrt(capture.silentHoldEnergy / static_cast<double>(juce::jmax(juce::int64{1}, capture.silentHoldSamples)));
        const bool released = finalRms <= releaseRms * .001 + 1e-7;
        const bool pass = capture.prepared && capture.finite && capture.peak <= 4 && capture.inputEnergy > 0
            && capture.outputEnergy > 0 && capture.stateParity && capture.partitionError <= 2e-6
            && (options.boundedProbe || released) && capture.allocations == 0 && capture.frees == 0
            && (!holdHeadroom || (capture.samplesAtSafetyBound==0 && capture.nonlinearStoredPeak<4 && capture.nonlinearLateStoredPeak<4
                && capture.springStoredPeak<4 && capture.risingStoredPeak<2));
        auto* row = new juce::DynamicObject();
        row->setProperty("kind", options.boundedProbe ? "bounded_hold_release_callback_heap_transition" : options.hold ? options.heldAcceptsInput ? "sixty_second_infinite_hold_and_finite_release" : "sixty_second_freeze_hold_and_finite_release" : "maximum_decay_declared_tail_capture");
        row->setProperty("type", options.type); row->setProperty("processingMode", options.processing);
        row->setProperty("shimmerScheduling", options.spreadShimmer ? 1 : 0); row->setProperty("vowelBody", options.vowelBody);
        row->setProperty("nonlinearShape", options.nonlinearShape); row->setProperty("nonlinearMotion", options.nonlinearMotion);
        row->setProperty("nonlinearMotionRate", options.nonlinearMotionRate);
        row->setProperty("returnMode", options.returnMode); row->setProperty("heldAcceptsInput", options.heldAcceptsInput);
        row->setProperty("outputDb", options.outputDb);
        row->setProperty("liveOriginalToCalibratedAtThreeSeconds",options.liveReturnSwitch);
        row->setProperty("sampleRate", options.rate); row->setProperty("channels", options.channels);
        row->setProperty("seconds", capture.seconds); row->setProperty("holdWithInputSeconds", options.hold ? options.boundedProbe ? .2 : 30 : 0);
        row->setProperty("holdWithZeroInputSeconds", options.hold ? options.boundedProbe ? .2 : 30 : 0);
        row->setProperty("releaseObservationSeconds", options.hold ? options.boundedProbe ? .4 : 12 : capture.seconds - 1);
        row->setProperty("declaredReleaseTailSeconds", capture.declaredReleaseTail);
        row->setProperty("inputEnergy", capture.inputEnergy); row->setProperty("outputEnergy", capture.outputEnergy);
        row->setProperty("silentHoldFinalRmsDiagnostic", silentHoldRms); row->setProperty("releaseStartRms", releaseRms);
        row->setProperty("finalRms", finalRms); row->setProperty("releasedToNumericalSilence", options.boundedProbe ? juce::var("not_asserted_in_bounded_probe") : juce::var(released));
        row->setProperty("finite", capture.finite); row->setProperty("peak", capture.peak);
        row->setProperty("samplesAtSafetyBoundDiagnostic", capture.samplesAtSafetyBound);
        row->setProperty("firstFinalSafetyClipSecondsDiagnostic", capture.firstSafetyBoundSeconds);
        if(options.type==6)
        {
            row->setProperty("infiniteGeneratorMaximumStoredSample",capture.nonlinearStoredPeak);
            row->setProperty("infiniteLateMaximumStoredSample",capture.nonlinearLateStoredPeak);
            row->setProperty("infiniteGeneratorBudgetInterventions",static_cast<juce::int64>(capture.nonlinearBudgetInterventions));
            row->setProperty("infiniteLateBudgetInterventions",static_cast<juce::int64>(capture.nonlinearLateBudgetInterventions));
            row->setProperty("noFinalOrInfiniteStorageGuardHits",capture.samplesAtSafetyBound==0&&capture.nonlinearStoredPeak<4&&capture.nonlinearLateStoredPeak<4);
        }
        else if(options.type==4)
        {
            row->setProperty("infiniteSpringMaximumStoredSample",capture.springStoredPeak);
            row->setProperty("infiniteSpringBudgetInterventions",static_cast<juce::int64>(capture.springBudgetInterventions));
        }
        else if(options.type==17)
        {
            row->setProperty("infiniteRisingMaximumStoredSample",capture.risingStoredPeak);
            row->setProperty("infiniteRisingBudgetInterventions",static_cast<juce::int64>(capture.risingBudgetInterventions));
        }
        auto* phaseClips = new juce::DynamicObject();
        phaseClips->setProperty("initialExcitation", capture.phaseSafetyBoundSamples[0]);
        phaseClips->setProperty("heldWithSourceInput", capture.phaseSafetyBoundSamples[1]);
        phaseClips->setProperty("heldWithZeroSourceInput", capture.phaseSafetyBoundSamples[2]);
        phaseClips->setProperty("finiteRelease", capture.phaseSafetyBoundSamples[3]);
        row->setProperty("phaseFinalSafetyClipSamplesDiagnostic", juce::var(phaseClips));
        row->setProperty("maxPartitionError", capture.partitionError); row->setProperty("parameterStateParity", capture.stateParity);
        row->setProperty("callbackCount", capture.callbacks); row->setProperty("callbackHeapMeasured", capture.heapMeasured);
        row->setProperty("callbackAllocations", capture.allocations); row->setProperty("callbackFrees", capture.frees);
        row->setProperty("pass", pass); cases.add(juce::var(row)); overall = overall && pass;
        allocations += capture.allocations; frees += capture.frees; heapMeasured = heapMeasured || capture.heapMeasured;
        partitionError = juce::jmax(partitionError, capture.partitionError);
        checkpoint(&options, pass);
    };
    // Maximum finite tail allowance for every current selector, including the
    // Vintage, convolution and finite-reflection voices without Hold support.
    if (holdHeadroom)
    {
        Options options; options.hold = true;
        for(const int type:{4,6,17})for (const int mode : {0, 1})
            for (const bool acceptsInput : {false, true})
            {
                options.type=type;
                options.returnMode = mode; options.heldAcceptsInput = acceptsInput; add(options);
            }
        options.type=6;
        options.returnMode = 1; options.heldAcceptsInput = true; options.outputDb = -30; add(options);
        options.returnMode=0;options.outputDb=0;options.liveReturnSwitch=true;
        for(const int type:{4,6,17}){options.type=type;add(options);}
    }
    if (!boundedHeapProbe && !holdHeadroom) for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
    {
        if (finiteType >= 0 && type != finiteType) continue;
        Options options; options.type = type;
        if (finiteType == 6)
        {
            // Equal tap energy bounds the loop; different envelope spectra and
            // moving reads still require actual release qualification. Motion
            // 1 uses the highest supported rate, not a scalar feedback estimate.
            options.nonlinearMotionRate = 8;
            for (int shape = 0; shape < 8; ++shape)
                for (const float motion : {0.0f, 1.0f})
                {
                    options.nonlinearShape = shape; options.nonlinearMotion = motion; add(options);
                }
        }
        else add(options);
    }
    // Independent prepared families/cores and ambient excitation laws. Vintage,
    // convolution, spatial image and finite Retro reflections have no Infinite
    // Hold semantics and are covered by the finite-tail rows above instead.
    if (finiteType < 0 && !holdHeadroom) for (const int type : {0, 2, 4, 5, 6, 12, 15, 16, 17, 18, 19, 20, 21, 24, 27, 30, 39})
        for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0})
            for (const int channels : {1, 2})
            {
                Options options; options.type = type; options.rate = rate; options.channels = channels; options.hold = true;
                options.boundedProbe = boundedHeapProbe;
                add(options);
                if (type == 2 || type == 19 || type == 21 || type == 24 || type == 27 || type == 30 || type == 39)
                {
                    options.processing = 1; add(options);
                }
                if (type == 5) { options.spreadShimmer = true; add(options); }
                if (type == 20) { options.vowelBody = .5f; add(options); }
            }
    result->setProperty("pass", overall); result->setProperty("cases", cases); result->setProperty("caseCount", cases.size());
    result->setProperty("maxPartitionError", partitionError); result->setProperty("callbackHeapMeasured", heapMeasured);
    result->setProperty("callbackAllocations", allocations); result->setProperty("callbackFrees", frees);
    result->setProperty("progressCheckpointWritten", progressWritten);
    result->setProperty("progressCheckpoint", progressFile.getFullPathName());
    result->setProperty("scope", holdHeadroom
        ? "Focused accumulating Hold headroom,48k stereo: dispersive Spring, Nonlinear and Rising x Original/Calibrated Return x Freeze/Infinite, Nonlinear Calibrated Infinite Output-30dB, and all three Infinite families with a live Original-to-Calibrated return change. Every row has1s excitation,30s held with continuing source,30s held with zero source,12s finite release; Freeze rejects new held source. Zero final +/-4 guard hits and measured Infinite write peaks below their storage guards are assertions. Other internal states and subjective quality remain not_asserted. Regular256 and irregular1/17/63/257/1021 callback output/state parity and finite release remain asserted."
        : finiteType >= 0
        ? "Focused actual wrapper maximum Nonlinear finite tail:8 shapes x Motion0/1 at maximum8Hz rate,48k stereo;1s deterministic excitation then declared finite tail plus2s; regular256 versus irregular1/17/63/257/1021 callbacks. Final1s RMS must fall60dB relative to first1s tail plus1e-7 floor. This is numerical release qualification, not all control combinations, acoustic RT60 or sound quality."
        : boundedHeapProbe
        ? "Bounded actual wrapper callback allocation probe: independent Hold families/cores at44.1/48/96/192k mono/stereo, .2s Hold with input then.2s Hold with zero input then.4s release. Same prepared transitions/partitions as full qualification; long stability and release-to-silence are not asserted by this profile. Debug CRT heap only."
        : "Opt-in streaming actual wrapper: all41 maximum finite tails at48k stereo; independent Hold families/cores at44.1/48/96/192k mono/stereo, 30s ongoing excitation then30s zero input then12s finite release; regular256 versus irregular1/17/63/257/1021 callbacks with prepared256. Debug CRT callback heap only; device/dropout and sonic quality are not asserted.");
    return result;
}

inline juce::var checkReverbExtendedQualification() { return runReverbExtendedQualification(false); }
inline juce::var checkReverbExtendedHeapTransitions() { return runReverbExtendedQualification(true); }
inline juce::var checkReverbExtendedNonlinearTail() { return runReverbExtendedQualification(false, 6); }
inline juce::var checkReverbExtendedHoldHeadroom() { return runReverbExtendedQualification(false, 6, true); }
