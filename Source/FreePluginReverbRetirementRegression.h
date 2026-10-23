#pragma once
#include <type_traits>

namespace ReverbRetirementRegression
{
struct Capture
{
    juce::AudioBuffer<float> audio;
    int dormantAt = -1;
    bool dormantAtEnd = false;
};

template <typename Family>
void setHold(typename Family::Settings& settings, bool hold)
{
    if constexpr (std::is_same_v<Family, BuiltInStudioReverb>
                  || std::is_same_v<Family, BuiltInPlateReverb>) settings.freeze = hold;
    else if constexpr (std::is_same_v<Family, BuiltInDriftingReverb>
                       || std::is_same_v<Family, BuiltInClearReverb>) settings.hold = hold;
    else juce::ignoreUnused(settings, hold);
}

template <typename Family>
Capture render(double rate, int mode, int blockSize, bool retire,
               bool spillover, bool reselect = false, bool fresh = false,
               bool holdBeforeRetirement = false, bool cancelSpillover = false)
{
    auto engine = std::make_unique<Family>();
    engine->prepare(rate, fresh ? -1 : mode);
    typename Family::Settings settings;
    settings.decay = 2;
    const int length = juce::roundToInt(rate * .55);
    const int holdAt = juce::roundToInt(rate * .09);
    const int offAt = juce::roundToInt(rate * .12);
    const int cancelAt = juce::roundToInt(rate * .20);
    const int returnAt = juce::roundToInt(rate * .24);
    const int newInputAt = juce::roundToInt(rate * .28);
    const int resumeSpilloverAt = juce::roundToInt(rate * .31);
    Capture capture { juce::AudioBuffer<float>(2, length), -1, false };
    juce::uint32 random = 123;
    for (int start = 0; start < length;)
    {
        int count = juce::jmin(blockSize, length - start);
        for (int event : {holdAt, offAt, cancelAt, returnAt, newInputAt, resumeSpilloverAt})
            if (start < event) count = juce::jmin(count, event - start);
        const bool active = (!fresh && (!retire || start < offAt))
            || (reselect && start >= returnAt);
        setHold<Family>(settings, holdBeforeRetirement && start >= holdAt && start < offAt);
        engine->configure(active ? mode : -1, settings,
                          spillover && (!cancelSpillover || start < cancelAt || start >= resumeSpilloverAt));
        for (int sample = start; sample < start + count; ++sample)
        {
            random = random * 1664525u + 1013904223u;
            const float noise = (static_cast<float>(random >> 8) / 8388608.0f - 1) * .1f;
            // Inactive input intentionally remains nonzero: it must not be
            // recorded into histories and resurrected after reselection.
            const bool feed = (!fresh && sample < juce::roundToInt(rate * .08))
                || (sample >= offAt && sample < returnAt)
                || (reselect && sample == newInputAt);
            const auto wet = engine->process(feed ? noise : 0, feed ? -noise * .7f : 0);
            for (int channel = 0; channel < 2; ++channel)
                capture.audio.setSample(channel, sample, wet[static_cast<size_t>(channel)]);
            if (retire && sample >= offAt && (!reselect || sample < returnAt)
                && capture.dormantAt < 0 && engine->isDormant()) capture.dormantAt = sample;
        }
        start += count;
    }
    capture.dormantAtEnd = engine->isDormant();
    return capture;
}

inline double difference(const juce::AudioBuffer<float>& first,
                         const juce::AudioBuffer<float>& second, int start = 0)
{
    double result = 0;
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = start; sample < first.getNumSamples(); ++sample)
            result = juce::jmax(result, std::abs(static_cast<double>(first.getSample(channel, sample))
                                               - second.getSample(channel, sample)));
    return result;
}

inline double energy(const juce::AudioBuffer<float>& audio, int start, int end)
{
    double result = 0;
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = start; sample < end; ++sample)
        {
            const double value = audio.getSample(channel, sample);
            result += value * value;
        }
    return result;
}

template <typename Family>
bool checkFamily(juce::Array<juce::var>& cases, const char* name, int modes, double rate)
{
    bool pass = true;
    const int offAt = juce::roundToInt(rate * .12);
    const int returnAt = juce::roundToInt(rate * .24);
    const int newInputAt = juce::roundToInt(rate * .28);
    const int fadeSamples = static_cast<int>(rate * .05);
    for (int mode = 0; mode < modes; ++mode)
    {
        const auto active = render<Family>(rate, mode, 127, false, false);
        const auto activePartition = render<Family>(rate, mode, 512, false, false);
        const auto activeRetaining = render<Family>(rate, mode, 127, false, true);
        const auto muted = render<Family>(rate, mode, 127, true, false);
        const auto mutedPartition = render<Family>(rate, mode, 512, true, false);
        const auto retained = render<Family>(rate, mode, 127, true, true);
        const auto resumed = render<Family>(rate, mode, 127, true, false, true);
        const auto fresh = render<Family>(rate, mode, 127, true, false, true, true);
        const auto held = render<Family>(rate, mode, 127, true, false, false, false, true);
        const auto cancelled = render<Family>(rate, mode, 127, true, true, false, false, false, true);
        const int cancelledDormantAt = juce::roundToInt(rate * .20) + fadeSamples - 1;
        const double partitionError = juce::jmax(difference(active.audio, activePartition.audio),
                                                 difference(muted.audio, mutedPartition.audio));
        const double activeError = difference(active.audio, activeRetaining.audio);
        const double resumedError = difference(resumed.audio, fresh.audio, returnAt);
        const double dormantEnergy = energy(muted.audio, offAt + fadeSamples, muted.audio.getNumSamples());
        const double reselectedSilentEnergy = energy(resumed.audio, returnAt, newInputAt);
        const double retainedEnergy = energy(retained.audio, returnAt, newInputAt);
        const double reEnabledSpilloverEnergy = energy(cancelled.audio, juce::roundToInt(rate * .31), cancelled.audio.getNumSamples());
        // Clear's periodic oscillator normalization follows its cumulative
        // processing counter; reset histories may differ by floating-point
        // roundoff from a newly prepared bank, while silence must stay exact.
        const bool rowPass = partitionError == 0 && activeError == 0 && resumedError <= 1e-7
            && dormantEnergy == 0 && reselectedSilentEnergy == 0 && retainedEnergy > 0
            && muted.dormantAt == offAt + fadeSamples - 1 && muted.dormantAtEnd
            && held.dormantAt == offAt + fadeSamples - 1 && held.dormantAtEnd
            && cancelled.dormantAt == cancelledDormantAt && cancelled.dormantAtEnd
            && reEnabledSpilloverEnergy == 0
            && !retained.dormantAtEnd;
        pass = pass && rowPass;
        auto* row = new juce::DynamicObject();
        row->setProperty("family", name); row->setProperty("mode", mode); row->setProperty("sampleRate", rate);
        row->setProperty("pass", rowPass); row->setProperty("partitionError", partitionError);
        row->setProperty("activeSpilloverParityError", activeError); row->setProperty("freshReselectionError", resumedError);
        row->setProperty("dormantAtSample", muted.dormantAt); row->setProperty("expectedDormantAtSample", offAt + fadeSamples - 1);
        row->setProperty("dormantOutputEnergy", dormantEnergy); row->setProperty("reselectedSilentEnergy", reselectedSilentEnergy);
        row->setProperty("retainedEnergyDiagnostic", retainedEnergy); row->setProperty("heldThenRetired", held.dormantAtEnd);
        row->setProperty("cancelledSpilloverDormantAtSample", cancelled.dormantAt);
        row->setProperty("expectedCancelledSpilloverDormantAtSample", cancelledDormantAt);
        row->setProperty("reEnabledSpilloverEnergy", reEnabledSpilloverEnergy);
        cases.add(row);
    }
    return pass;
}

inline bool checkVintageRateBanks(juce::Array<juce::var>& cases)
{
    constexpr double rate = 48000;
    const int switchAt = juce::roundToInt(rate * .12);
    const int fadeSamples = static_cast<int>(rate * .05);
    bool pass = true;
    for (int mode = 0; mode < 2; ++mode) for (int outgoing = 0; outgoing < 3; ++outgoing)
    {
        auto engine = std::make_unique<BuiltInVintageReverb>();
        engine->prepare(rate, mode);
        BuiltInVintageReverb::Settings settings;
        settings.tankRate = static_cast<float>(outgoing);
        engine->configure(mode, settings, false);
        int retiredAt = -1;
        for (int sample = 0; sample < switchAt + fadeSamples + 1; ++sample)
        {
            if (sample == switchAt)
            {
                settings.tankRate = static_cast<float>((outgoing + 1) % 3);
                engine->configure(mode, settings, false);
            }
            const auto wet = engine->process(sample == 0 ? .1f : 0, 0);
            juce::ignoreUnused(wet);
            // A 24 kHz incoming bank gets its first processing tick on the
            // second host sample; before that, one running bank is the old one.
            const auto incoming = static_cast<size_t>((outgoing + 1) % 3);
            if (sample >= switchAt && retiredAt < 0 && engine->runningTankCount(static_cast<size_t>(mode)) == 1
                && engine->processingFrames(static_cast<size_t>(mode), incoming) > 0)
                retiredAt = sample;
        }
        const bool rowPass = retiredAt == switchAt + fadeSamples - 1;
        pass = pass && rowPass;
        auto* row = new juce::DynamicObject();
        row->setProperty("family", "Vintage tank rate"); row->setProperty("mode", mode);
        row->setProperty("outgoingRateBank", outgoing); row->setProperty("pass", rowPass);
        row->setProperty("retiredAtSample", retiredAt); row->setProperty("expectedRetiredAtSample", switchAt + fadeSamples - 1);
        cases.add(row);
    }
    return pass;
}
}

inline juce::var checkReverbRetirement()
{
    juce::Array<juce::var> cases;
    bool pass = true;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        pass = ReverbRetirementRegression::checkFamily<BuiltInStudioReverb>(cases, "Studio", 6, rate) && pass;
        pass = ReverbRetirementRegression::checkFamily<BuiltInPlateReverb>(cases, "Plate", 3, rate) && pass;
        pass = ReverbRetirementRegression::checkFamily<BuiltInDriftingReverb>(cases, "Drifting", 3, rate) && pass;
        pass = ReverbRetirementRegression::checkFamily<BuiltInClearReverb>(cases, "Clear", 3, rate) && pass;
        pass = ReverbRetirementRegression::checkFamily<BuiltInVintageReverb>(cases, "Vintage", 2, rate) && pass;
    }
    pass = ReverbRetirementRegression::checkVintageRateBanks(cases) && pass;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Inaudible standalone reverb tank retirement");
    result->setProperty("pass", pass); result->setProperty("cases", cases);
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
