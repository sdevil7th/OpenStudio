#include "IntegerPDCRegression.h"
#include "PreparedIntegerDelayLine.h"
#include "TrackProcessor.h"
#include <array>
#include <cstring>
#include <limits>

namespace {
using ReferenceLine = juce::dsp::DelayLine<float>;
constexpr int maximumDelay = 96000, ringSize = maximumDelay + 2;
juce::dsp::ProcessSpec spec(int channels, int blockSize)
{
    return { 48000.0, static_cast<juce::uint32>(blockSize), static_cast<juce::uint32>(channels) };
}
float source(int frame, int channel, int track = 0)
{
    return static_cast<float>(((frame + track * 7 + channel * 3) % 127) - 63) / 256.0f + 0.03125f;
}
bool identical(float left, float right) { return std::memcmp(&left, &right, sizeof(float)) == 0; }
juce::uint64 hashSample(juce::uint64 hash, float sample)
{
    juce::uint32 bits = 0; std::memcpy(&bits, &sample, sizeof(bits));
    return (hash ^ bits) * 1099511628211ULL;
}
bool stableTapParity()
{
    ReferenceLine reference(maximumDelay); PreparedIntegerDelayLine candidate(maximumDelay);
    bool exact = true;
    constexpr int blocks[] { 1, 8, 16, 512 };
    for (const int tap : { 0, 1, 6, 128, 96000 })
    {
        reference.prepare(spec(2, 512)); candidate.prepare(spec(2, 512));
        reference.setDelay(static_cast<float>(tap)); candidate.setDelay(static_cast<float>(tap));
        int frame = 0, block = 0;
        while (frame < ringSize * 2 + 19)
        {
            const int count = juce::jmin(blocks[block++ % 4], ringSize * 2 + 19 - frame);
            for (int sample = 0; sample < count; ++sample, ++frame)
                for (int channel = 0; channel < 2; ++channel)
                {
                    const float input = source(frame, channel);
                    reference.pushSample(channel, input); candidate.pushSample(channel, input);
                    exact = identical(reference.popSample(channel), candidate.popSample(channel)) && exact;
                }
        }
    }
    return exact;
}
bool multiTapTransitionParity()
{
    ReferenceLine reference(maximumDelay); PreparedIntegerDelayLine candidate(maximumDelay);
    reference.prepare(spec(2, 512)); candidate.prepare(spec(2, 512));
    int current = 0, target = 0, pending = 0, remaining = 0;
    constexpr int ramp = 960;
    bool exact = true;
    const auto begin = [&] { if (remaining == 0 && pending != current) { target = pending; remaining = ramp; } };
    for (int frame = 0; frame < ringSize * 2 + 31; ++frame)
    {
        if (frame % 337 == 0) pending = std::array<int, 5>{ 0, 1, 6, 128, 96000 }[static_cast<size_t>((frame / 337) % 5)];
        begin();
        const float progress = remaining > 0 ? 1.0f - static_cast<float>(remaining - 1) / ramp : 0.0f;
        const float mix = progress * progress * (3.0f - 2.0f * progress);
        for (int channel = 0; channel < 2; ++channel)
        {
            reference.pushSample(channel, source(frame, channel)); candidate.pushSample(channel, source(frame, channel));
            if (remaining > 0)
            {
                const float oldReference = reference.popSample(channel, static_cast<float>(current), false);
                const float oldCandidate = candidate.popSample(channel, static_cast<float>(current), false);
                // Repeated peeks must not advance either cursor.
                exact = identical(oldReference, reference.popSample(channel, static_cast<float>(current), false))
                    && identical(oldCandidate, candidate.popSample(channel, static_cast<float>(current), false)) && exact;
                const float nextReference = reference.popSample(channel, static_cast<float>(target), true);
                const float nextCandidate = candidate.popSample(channel, static_cast<float>(target), true);
                exact = identical(oldReference + (nextReference - oldReference) * mix,
                                  oldCandidate + (nextCandidate - oldCandidate) * mix) && exact;
            }
            else exact = identical(reference.popSample(channel), candidate.popSample(channel)) && exact;
        }
        if (remaining > 0 && --remaining == 0)
        {
            current = target;
            reference.setDelay(static_cast<float>(current)); candidate.setDelay(static_cast<float>(current)); begin();
        }
    }
    return exact;
}
bool stableBlockParity()
{
    ReferenceLine reference(maximumDelay);
    PreparedIntegerDelayLine candidate(maximumDelay);
    std::array<float, 512> audio {};
    constexpr int lengths[] { 0, 1, 8, 16, 512 };
    constexpr float taps[] { 0.0f, 1.0f, 6.0f, 128.0f, 96000.0f, 0.5f, 127.75f };
    const std::array<float, 6> edges { -0.0f, 0.0f, std::numeric_limits<float>::max(),
        -std::numeric_limits<float>::max(), std::numeric_limits<float>::denorm_min(), -0.25f };
    bool exact = true;
    for (const int channels : { 2, 1, 2 })
    {
        reference.prepare(spec(channels, 512)); candidate.prepare(spec(channels, 512));
        int frame = 0, block = 0;
        while (frame < ringSize * 2 + 19)
        {
            const int count = juce::jmin(lengths[block % 5], ringSize * 2 + 19 - frame);
            const float tap = taps[(block / 13) % 7];
            reference.setDelay(tap); candidate.setDelay(tap);
            for (int channel = 0; channel < channels; ++channel)
            {
                for (int sample = 0; sample < count; ++sample)
                    audio[static_cast<size_t>(sample)] = (block % 11) == 0
                        ? edges[static_cast<size_t>(sample % 6)] : source(frame + sample, channel);
                const auto input = audio;
                candidate.processChannel(channel, audio.data(), count);
                for (int sample = 0; sample < count; ++sample)
                {
                    reference.pushSample(channel, input[static_cast<size_t>(sample)]);
                    exact = identical(reference.popSample(channel), audio[static_cast<size_t>(sample)]) && exact;
                }
                // Mix both APIs to expose cursor/history errors across block boundaries.
                reference.pushSample(channel, 0.125f); candidate.pushSample(channel, 0.125f);
                exact = identical(reference.popSample(channel, tap, false), candidate.popSample(channel, tap, false)) && exact;
                exact = identical(reference.popSample(channel), candidate.popSample(channel)) && exact;
            }
            frame += count; ++block;
        }
    }
    return exact;
}
bool lifecycleAndFloatParity()
{
    ReferenceLine reference(maximumDelay); PreparedIntegerDelayLine candidate(maximumDelay);
    bool exact = candidate.getMaximumDelayInSamples() == reference.getMaximumDelayInSamples();
    const std::array<float, 10> values { 0.0f, -0.0f, 1.0f, -1.0f, std::numeric_limits<float>::max(),
        -std::numeric_limits<float>::max(), std::numeric_limits<float>::denorm_min(),
        -std::numeric_limits<float>::denorm_min(), 0.25f, -0.5f };
    for (const int channels : { 2, 1, 2 })
    {
        reference.prepare(spec(channels, 8)); candidate.prepare(spec(channels, 8));
        for (const float tap : { 0.0f, 1.0f, 6.0f, 128.0f, 96000.0f, 0.5f, 127.75f })
        {
            reference.setDelay(tap); candidate.setDelay(tap);
            for (int frame = 0; frame < 1024; ++frame)
                for (int channel = 0; channel < channels; ++channel)
                {
                    const float input = values[static_cast<size_t>((frame + channel) % static_cast<int>(values.size()))];
                    reference.pushSample(channel, input); candidate.pushSample(channel, input);
                    exact = identical(reference.popSample(channel), candidate.popSample(channel)) && exact;
                }
            reference.reset(); candidate.reset();
            exact = reference.getDelay() == candidate.getDelay() && exact;
            for (int frame = 0; frame < 16; ++frame)
                for (int channel = 0; channel < channels; ++channel)
                {
                    reference.pushSample(channel, source(frame, channel)); candidate.pushSample(channel, source(frame, channel));
                    exact = identical(reference.popSample(channel), candidate.popSample(channel)) && exact;
                }
        }
    }
    return exact;
}
juce::var statistics(std::vector<double> values)
{
    std::sort(values.begin(), values.end());
    auto* result = new juce::DynamicObject();
    result->setProperty("medianMicrosecondsPer31TrackBatch", values[values.size() / 2]);
    result->setProperty("p95MicrosecondsPer31TrackBatch", values[static_cast<size_t>(0.95 * static_cast<double>(values.size() - 1))]);
    result->setProperty("p99MicrosecondsPer31TrackBatch", values[static_cast<size_t>(0.99 * static_cast<double>(values.size() - 1))]);
    return juce::var(result);
}
juce::var benchmark(bool mixedTaps)
{
    constexpr int tracks = 31, batches = 6000, blockSize = 8;
    std::vector<std::unique_ptr<ReferenceLine>> references;
    std::vector<std::unique_ptr<PreparedIntegerDelayLine>> candidates;
    for (int track = 0; track < tracks; ++track)
    {
        auto reference = std::make_unique<ReferenceLine>(maximumDelay);
        auto candidate = std::make_unique<PreparedIntegerDelayLine>(maximumDelay);
        reference->prepare(spec(2, blockSize)); candidate->prepare(spec(2, blockSize));
        const float tap = static_cast<float>(mixedTaps ? std::array<int, 5>{ 0, 1, 6, 128, 96000 }[static_cast<size_t>(track % 5)] : 0);
        reference->setDelay(tap); candidate->setDelay(tap);
        references.push_back(std::move(reference)); candidates.push_back(std::move(candidate));
    }
    std::array<float, tracks * blockSize * 2> input {}, referenceOutput {}, candidateOutput {};
    std::vector<double> referenceTimes, candidateTimes;
    referenceTimes.reserve(batches); candidateTimes.reserve(batches);
    juce::uint64 referenceChecksum = 1469598103934665603ULL, candidateChecksum = referenceChecksum;
    bool exact = true;
    const double toMicroseconds = 1.0e6 / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
    for (int batch = 0; batch < batches; ++batch)
    {
        for (int track = 0; track < tracks; ++track)
            for (int sample = 0; sample < blockSize; ++sample)
                for (int channel = 0; channel < 2; ++channel)
                    input[static_cast<size_t>((track * blockSize + sample) * 2 + channel)] = source(batch * blockSize + sample, channel, track);
        const auto measureReference = [&]
        {
            const auto start = juce::Time::getHighResolutionTicks();
            for (int track = 0; track < tracks; ++track)
                for (int sample = 0; sample < blockSize; ++sample)
                    for (int channel = 0; channel < 2; ++channel)
                    {
                        const auto index = static_cast<size_t>((track * blockSize + sample) * 2 + channel);
                        references[static_cast<size_t>(track)]->pushSample(channel, input[index]);
                        referenceOutput[index] = references[static_cast<size_t>(track)]->popSample(channel);
                    }
            referenceTimes.push_back(static_cast<double>(juce::Time::getHighResolutionTicks() - start) * toMicroseconds);
        };
        const auto measureCandidate = [&]
        {
            const auto start = juce::Time::getHighResolutionTicks();
            for (int track = 0; track < tracks; ++track)
                for (int sample = 0; sample < blockSize; ++sample)
                    for (int channel = 0; channel < 2; ++channel)
                    {
                        const auto index = static_cast<size_t>((track * blockSize + sample) * 2 + channel);
                        candidates[static_cast<size_t>(track)]->pushSample(channel, input[index]);
                        candidateOutput[index] = candidates[static_cast<size_t>(track)]->popSample(channel);
                    }
            candidateTimes.push_back(static_cast<double>(juce::Time::getHighResolutionTicks() - start) * toMicroseconds);
        };
        if ((batch & 1) == 0) { measureReference(); measureCandidate(); }
        else { measureCandidate(); measureReference(); }
        // Output reads/hash occur outside the timers and keep both computations
        // observable without charging checksum overhead to either implementation.
        for (size_t index = 0; index < referenceOutput.size(); ++index)
        {
            exact = identical(referenceOutput[index], candidateOutput[index]) && exact;
            referenceChecksum = hashSample(referenceChecksum, referenceOutput[index]);
            candidateChecksum = hashSample(candidateChecksum, candidateOutput[index]);
        }
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("trackCount", tracks); result->setProperty("callbackBatches", batches);
    result->setProperty("blockSize", blockSize); result->setProperty("channelsPerTrack", 2);
    result->setProperty("reference", statistics(std::move(referenceTimes)));
    result->setProperty("candidate", statistics(std::move(candidateTimes)));
    result->setProperty("exactPCMParity", exact);
    result->setProperty("referenceChecksumHex", juce::String::toHexString(referenceChecksum));
    result->setProperty("candidateChecksumHex", juce::String::toHexString(candidateChecksum));
    result->setProperty("matchingChecksums", referenceChecksum == candidateChecksum);
    return juce::var(result);
}
}

void runIntegerPDCRegression(const juce::File& directory,
    const std::function<void(const char*, bool)>& check)
{
    const bool stable = stableTapParity(), transitions = multiTapTransitionParity(), lifecycle = lifecycleAndFloatParity();
    check("integer_pdc_candidate_stable_integral_taps_and_wrap_exact", stable);
    check("integer_pdc_candidate_dual_peek_advance_and_transition_exact", transitions);
    check("integer_pdc_block_channel_warm_history_wrap_and_float_parity", stableBlockParity());
    check("integer_pdc_candidate_reset_reprepare_signed_zero_and_overflow_exact", lifecycle);
    const auto production = TrackProcessor::runPreparedPDCRegression();
    check("integer_pdc_production_track_helper_exact_juce_reference", static_cast<bool>(production["pass"]));
    const auto zero = benchmark(false), mixed = benchmark(true);
    check("integer_pdc_candidate_zero_benchmark_exact_pcm_and_checksum", static_cast<bool>(zero["exactPCMParity"]) && static_cast<bool>(zero["matchingChecksums"]));
    check("integer_pdc_candidate_mixed_benchmark_exact_pcm_and_checksum", static_cast<bool>(mixed["exactPCMParity"]) && static_cast<bool>(mixed["matchingChecksums"]));
    auto* report = new juce::DynamicObject();
    report->setProperty("classification", "diagnostic_only: device-free PDC primitive cost; no hardware or audible-quality acceptance");
    report->setProperty("productionIntegration", true);
    report->setProperty("productionTrackReference", production);
    report->setProperty("stableTapParity", stable); report->setProperty("transitionParity", transitions); report->setProperty("lifecycleFloatParity", lifecycle);
    report->setProperty("zeroDelay", zero); report->setProperty("mixedSteadyTaps", mixed);
    directory.getChildFile("integer-pdc-benchmark.json").replaceWithText(juce::JSON::toString(juce::var(report), true));
}
