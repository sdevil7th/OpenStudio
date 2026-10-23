#pragma once
#include "BuiltInConvolution.h"
#include <array>
#include <limits>

// Kernel identity and crossfade arithmetic only. Shared wrapper EQ, modulation
// and tail-extension history are intentionally outside this isolated oracle.
namespace ReverbReturnIRRegression
{
inline constexpr int maximumCallbackSamples = 1021;
struct Capture
{
    juce::AudioBuffer<float> audio;
    bool prepared = true, finite = true;
    double oracleError = 0, outgoingHistoryPeak = 0, crossPeak = 0;
    double settledCrossPeak = 0;
};

inline double difference(const juce::AudioBuffer<float>& first,
                         const juce::AudioBuffer<float>& second, int firstChannel = 0)
{
    if (first.getNumChannels() != second.getNumChannels()
        || first.getNumSamples() != second.getNumSamples())
        return std::numeric_limits<double>::infinity();
    double maximum = 0;
    for (int channel = firstChannel; channel < first.getNumChannels(); ++channel)
        for (int sample = 0; sample < first.getNumSamples(); ++sample)
            maximum = juce::jmax(maximum, std::abs(static_cast<double>(first.getSample(channel, sample))
                - static_cast<double>(second.getSample(channel, sample))));
    return maximum;
}
}

inline juce::var checkReverbReturnIRCrossfade()
{
    using namespace ReverbReturnIRRegression;
    constexpr int preparedBlock = 128, maximumBlock = maximumCallbackSamples;
    constexpr double fadeSeconds = .05;
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-return-ir-tests");
    const auto file = directory.getChildFile("matrix-crossfade.wav");
    juce::AudioBuffer<float> impulse(4, 4096); impulse.clear();
    for (int channel = 0; channel < 4; ++channel)
    {
        impulse.setSample(channel, 31 + channel * 73, .25f - .035f * static_cast<float>(channel));
        impulse.setSample(channel, 717 + channel * 109, -.09f + .017f * static_cast<float>(channel));
        impulse.setSample(channel, 3071 + channel * 127, .05f - .007f * static_cast<float>(channel));
    }
    bool fixture = writeProbeWave(file, impulse, 48000);
    BuiltInConvolution generatedSource, customSource;
    fixture = generatedSource.selectDefault() && customSource.loadFile(file) && fixture;
    auto* shape = new juce::DynamicObject();
    shape->setProperty("normalise", false); shape->setProperty("outputLayout", 1);
    fixture = customSource.edit(juce::var(shape)) && fixture;
    juce::ValueTree generatedState("IR"), customState("IR");
    generatedSource.save(generatedState); customSource.save(customState);
    fixture = static_cast<bool>(generatedState["irGeneratedDefault"])
        && !static_cast<bool>(customState["irGeneratedDefault"]) && fixture;

    int allocations = 0, frees = 0;
    bool heapMeasured = false;
    const auto processChecked = [&] (BuiltInConvolution& processor,
                                    juce::AudioBuffer<float>& block, const float* calibration) {
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::allocations = ReverbCompatibilityHeapProbe::frees = 0;
        ReverbCompatibilityHeapProbe::previous = _CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
        ReverbCompatibilityHeapProbe::active = true;
#endif
        processor.process(block, 0, 20, 20000, 1, true, false, calibration);
#if JUCE_WINDOWS && JUCE_DEBUG
        ReverbCompatibilityHeapProbe::active = false;
        _CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
        allocations += ReverbCompatibilityHeapProbe::allocations;
        frees += ReverbCompatibilityHeapProbe::frees;
        heapMeasured = true;
#endif
    };
    const auto render = [&] (double rate, bool generatedFirst, bool irregular, int mode) {
        Capture capture;
        const auto& outgoingState = generatedFirst ? generatedState : customState;
        const auto& incomingState = generatedFirst ? customState : generatedState;
        BuiltInConvolution dynamic, outgoing, incoming;
        capture.prepared = dynamic.restore(outgoingState) && outgoing.restore(outgoingState)
            && incoming.restore(incomingState);
        for (auto* processor : {&dynamic, &outgoing, &incoming}) processor->prepare(rate, preparedBlock);
        const int event = juce::roundToInt(rate * .12), length = juce::roundToInt(rate * .30);
        const int settled = event + static_cast<int>(rate * fadeSeconds) + preparedBlock;
        capture.audio.setSize(4, length); capture.audio.clear();
        juce::AudioBuffer<float> actual(4, maximumBlock), previous(4, maximumBlock), next(4, maximumBlock);
        std::array<float, ReverbReturnIRRegression::maximumCallbackSamples> calibration{};
        calibration.fill(mode == 1 ? 1.0f : 0.0f);
        const float* calibrationPointer = mode < 0 ? nullptr : calibration.data();
        juce::SmoothedValue<float> referenceFade;
        referenceFade.reset(rate, fadeSeconds); referenceFade.setCurrentAndTargetValue(0);
        referenceFade.setTargetValue(1);
        const float generatedGain = mode == 1 ? BuiltInReverbReturnLevels::linear[7] : 1.0f;
        const float outgoingGain = generatedFirst ? generatedGain : 1.0f;
        const float incomingGain = generatedFirst ? 1.0f : generatedGain;
        const std::array<int, 5> partitions{1, 17, 63, 257, 1021};
        for (int start = 0, part = 0; start < length; ++part)
        {
            if (start == event)
                capture.prepared = dynamic.restore(incomingState) && capture.prepared;
            int count = juce::jmin(irregular ? partitions[static_cast<size_t>(part % 5)] : preparedBlock, length - start);
            if (start < event) count = juce::jmin(count, event - start);
            for (auto* block : {&actual, &previous, &next})
            {
                block->setSize(4, count, false, false, true); block->clear();
                for (int sample = 0; sample < count; ++sample)
                {
                    const double time = static_cast<double>(start + sample) / rate;
                    const float left = .025f * static_cast<float>(
                        std::sin(juce::MathConstants<double>::twoPi * 223 * time)
                        + .47 * std::sin(juce::MathConstants<double>::twoPi * 977 * time));
                    const float right = .019f * static_cast<float>(
                        std::sin(juce::MathConstants<double>::twoPi * 331 * time)
                        - .31 * std::sin(juce::MathConstants<double>::twoPi * 1709 * time));
                    block->setSample(0, sample, left); block->setSample(1, sample, right);
                }
            }
            processChecked(dynamic, actual, calibrationPointer);
            processChecked(outgoing, previous, nullptr);
            // Incoming references start with a fresh FIR/FFT history, exactly
            // when the prepared replacement is accepted by the live kernel.
            if (start >= event) processChecked(incoming, next, nullptr);
            for (int sample = 0; sample < count; ++sample)
            {
                const float blend = start >= event ? referenceFade.getNextValue() : 0.0f;
                for (int channel = 0; channel < 4; ++channel)
                {
                    const float before = previous.getSample(channel, sample) * outgoingGain;
                    const float after = start >= event ? next.getSample(channel, sample) * incomingGain : 0.0f;
                    const float expected = start >= event ? before * (1 - blend) + after * blend : before;
                    const float value = actual.getSample(channel, sample);
                    capture.audio.setSample(channel, start + sample, value);
                    capture.finite = std::isfinite(value) && std::isfinite(expected) && capture.finite;
                    capture.oracleError = juce::jmax(capture.oracleError,
                        std::abs(static_cast<double>(value) - static_cast<double>(expected)));
                    if (start + sample >= event && start + sample < event + preparedBlock)
                        capture.outgoingHistoryPeak = juce::jmax(capture.outgoingHistoryPeak,
                            std::abs(static_cast<double>(previous.getSample(channel, sample))));
                    if (channel >= 2)
                    {
                        capture.crossPeak = juce::jmax(capture.crossPeak, std::abs(static_cast<double>(value)));
                        if (start + sample >= settled)
                            capture.settledCrossPeak = juce::jmax(capture.settledCrossPeak, std::abs(static_cast<double>(value)));
                    }
                }
            }
            start += count;
        }
        return capture;
    };

    juce::Array<juce::var> cases;
    bool passed = fixture;
    double maximumOracleError = 0, maximumPartitionError = 0, maximumUnityError = 0;
    double maximumCustomCrossError = 0;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (bool generatedFirst : {true, false})
        {
            std::array<Capture, 3> regular, irregular;
            for (int index = 0; index < 3; ++index)
            {
                const int mode = index - 1; // nullptr, explicit Original, Calibrated.
                regular[static_cast<size_t>(index)] = render(rate, generatedFirst, false, mode);
                irregular[static_cast<size_t>(index)] = render(rate, generatedFirst, true, mode);
            }
            double oracleError = 0, partitionError = 0;
            bool finite = true, ready = true, history = true, cross = true;
            for (size_t index = 0; index < regular.size(); ++index)
            {
                const auto& a = regular[index]; const auto& b = irregular[index];
                oracleError = juce::jmax(oracleError, juce::jmax(a.oracleError, b.oracleError));
                partitionError = juce::jmax(partitionError, difference(a.audio, b.audio));
                finite = a.finite && b.finite && finite; ready = a.prepared && b.prepared && ready;
                history = a.outgoingHistoryPeak > 1e-8 && b.outgoingHistoryPeak > 1e-8 && history;
                cross = a.crossPeak > 1e-8 && b.crossPeak > 1e-8 && cross;
                cross = (generatedFirst ? a.settledCrossPeak > 1e-8 && b.settledCrossPeak > 1e-8
                    : a.settledCrossPeak == 0 && b.settledCrossPeak == 0) && cross;
            }
            const double unityError = juce::jmax(difference(regular[0].audio, regular[1].audio),
                difference(irregular[0].audio, irregular[1].audio));
            const double customCrossError = juce::jmax(difference(regular[1].audio, regular[2].audio, 2),
                difference(irregular[1].audio, irregular[2].audio, 2));
            maximumOracleError = juce::jmax(maximumOracleError, oracleError);
            maximumPartitionError = juce::jmax(maximumPartitionError, partitionError);
            maximumUnityError = juce::jmax(maximumUnityError, unityError);
            maximumCustomCrossError = juce::jmax(maximumCustomCrossError, customCrossError);
            const bool rowPass = ready && finite && history && cross && oracleError < 2e-6
                && partitionError < 2e-6 && unityError == 0 && customCrossError == 0;
            auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", rate);
            row->setProperty("direction", generatedFirst ? "generated_to_custom_matrix" : "custom_matrix_to_generated");
            row->setProperty("prepared", ready); row->setProperty("finite", finite);
            row->setProperty("nonzeroOutgoingHistory", history); row->setProperty("crossPathsActiveAndSettled", cross);
            row->setProperty("maxOracleError", oracleError); row->setProperty("maxPartitionError", partitionError);
            row->setProperty("maxOriginalUnityError", unityError); row->setProperty("maxCustomCrossGainError", customCrossError);
            row->setProperty("pass", rowPass); cases.add(juce::var(row)); passed = rowPass && passed;
        }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Per-kernel IR return calibration crossfade");
    result->setProperty("pass", passed && allocations == 0 && frees == 0); result->setProperty("fixture", fixture);
    result->setProperty("cases", cases); result->setProperty("caseCount", cases.size());
    result->setProperty("maximumOracleError", maximumOracleError); result->setProperty("maximumPartitionError", maximumPartitionError);
    result->setProperty("maximumOriginalUnityError", maximumUnityError); result->setProperty("maximumCustomCrossGainError", maximumCustomCrossError);
    result->setProperty("callbackHeapMeasured", heapMeasured); result->setProperty("callbackAllocations", allocations);
    result->setProperty("callbackFrees", frees); result->setProperty("fadeSeconds", fadeSeconds);
    result->setProperty("audioQuality", "not_asserted");
    result->setProperty("scope", "Live generated/custom kernel identity, 50 ms independent reference mix, four paths, Original unity and callback partitioning. EQ and outer filters bypassed; shared wrapper addons excluded. Release heap measurement not asserted.");
    return juce::var(result);
}
