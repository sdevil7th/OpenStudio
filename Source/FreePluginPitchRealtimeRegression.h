#pragma once
#include <cstring>

namespace PitchRealtimeRegression
{
// Retained scalar YIN arithmetic is an independent oracle for the paired-lag
// implementation. The oracle runs a complete frame synchronously and schedules
// its result at the original two-lags-per-retained-sample publication time.
inline std::array<float, 2> originalYIN(const std::array<float, 2048>& frame,
                                      double rate, float minimum, float maximum)
{
    std::array<float, 1024> yin {};
    yin[0] = 1;
    const int low = juce::jmax(1, static_cast<int>(rate / maximum));
    const int high = juce::jmin(1023, static_cast<int>(rate / minimum));
    if (high <= low) return {};
    float running = 0;
    for (int lag = 1; lag < 1024; ++lag)
    {
        float sum = 0;
        for (int j = 0; j < 1024; ++j)
        {
            const float delta = frame[static_cast<size_t>(j)] - frame[static_cast<size_t>(j + lag)];
            sum += delta * delta;
        }
        running += sum;
        yin[static_cast<size_t>(lag)] = running > 0 ? sum * static_cast<float>(lag) / running : 0;
    }
    int selected = -1;
    float best = .15f;
    for (int lag = low; lag <= high; ++lag)
        if (yin[static_cast<size_t>(lag)] < best)
        {
            while (lag + 1 <= high && yin[static_cast<size_t>(lag + 1)] < yin[static_cast<size_t>(lag)]) ++lag;
            selected = lag;
            best = yin[static_cast<size_t>(lag)];
            break;
        }
    if (selected < 0)
    {
        selected = low;
        best = yin[static_cast<size_t>(low)];
        for (int lag = low + 1; lag <= high; ++lag)
            if (yin[static_cast<size_t>(lag)] < best)
            {
                selected = lag;
                best = yin[static_cast<size_t>(lag)];
            }
    }
    float refined = static_cast<float>(selected);
    if (selected > 0 && selected < 1023)
    {
        const float a = yin[static_cast<size_t>(selected - 1)], b = yin[static_cast<size_t>(selected)];
        const float c = yin[static_cast<size_t>(selected + 1)], denominator = 2 * (2 * b - c - a);
        if (std::abs(denominator) >= 1e-10f) refined += (c - a) / denominator;
    }
    const float frequency = refined > 0 ? static_cast<float>(rate) / refined : 0;
    return frequency < minimum || frequency > maximum ? std::array<float, 2> {}
        : std::array<float, 2> { frequency, juce::jlimit(0.0f, 1.0f, 1 - best) };
}

struct DetectionEvent
{
    int inputPosition = 0;
    std::array<float, 2> result {};
};

inline std::vector<DetectionEvent> originalDetection(const std::vector<float>& input,
                                                    double rate, float minimum)
{
    const int decimation = juce::jmax(1, static_cast<int>(std::ceil(rate / 32000.0)));
    const double analysisRate = rate / decimation;
    const int length = decimation > 1 ? 64 * decimation + 1 : 1;
    std::vector<float> coefficients(static_cast<size_t>(length)), history(static_cast<size_t>(length));
    const double cutoff = juce::jmin(6000.0, analysisRate * .4) / rate;
    double coefficientSum = 0;
    for (int i = 0; i < length; ++i)
    {
        const int offset = i - length / 2;
        const double x = 2 * juce::MathConstants<double>::pi * cutoff * offset;
        const double sinc = offset == 0 ? 2 * cutoff : std::sin(x) / (juce::MathConstants<double>::pi * offset);
        const double window = length == 1 ? 1.0 : .42 - .5 * std::cos(2 * juce::MathConstants<double>::pi * i / (length - 1))
            + .08 * std::cos(4 * juce::MathConstants<double>::pi * i / (length - 1));
        coefficients[static_cast<size_t>(i)] = static_cast<float>(sinc * window);
        coefficientSum += sinc * window;
    }
    for (auto& coefficient : coefficients) coefficient = static_cast<float>(coefficient / coefficientSum);
    std::vector<float> retained;
    retained.reserve(input.size() / static_cast<size_t>(decimation));
    int position = 0, decimationPosition = 0;
    for (float sample : input)
    {
        if (decimation > 1)
        {
            history[static_cast<size_t>(position)] = sample;
            if (++position == length) position = 0;
            if (++decimationPosition < decimation) continue;
            decimationPosition = 0;
            sample = 0;
            int index = position;
            for (int tap = 0; tap < length; ++tap)
            {
                if (--index < 0) index = length - 1;
                sample += coefficients[static_cast<size_t>(tap)] * history[static_cast<size_t>(index)];
            }
        }
        retained.push_back(sample);
    }
    std::vector<DetectionEvent> events;
    for (int end = 512; end <= static_cast<int>(retained.size()); end += 512)
    {
        std::array<float, 2048> frame {};
        float squares = 0;
        for (int j = 0; j < 2048; ++j)
        {
            const int index = end - 2048 + j;
            if (index >= 0) frame[static_cast<size_t>(j)] = retained[static_cast<size_t>(index)];
            squares += frame[static_cast<size_t>(j)] * frame[static_cast<size_t>(j)];
        }
        const float rms = std::sqrt(squares / 2048.0f);
        const float db = rms > 0 ? 20.0f * std::log10(rms) : -100.0f;
        if (db < -60)
            events.push_back({ end * decimation, {} });
        else
        {
            const int maximumLag = juce::jmin(1023, static_cast<int>(analysisRate / minimum) + 1);
            events.push_back({ (end + (maximumLag + 1) / 2) * decimation,
                originalYIN(frame, analysisRate, minimum, 1200) });
        }
    }
    std::stable_sort(events.begin(), events.end(), [](const auto& a, const auto& b) { return a.inputPosition < b.inputPosition; });
    return events;
}

inline float inputSample(int position, int channel, double rate)
{
    return static_cast<float>(.18 * std::sin(juce::MathConstants<double>::twoPi * (channel == 0 ? 220 : 329.63) * position / rate)
        + .025 * std::sin(.173 * position));
}

inline double mapperCacheParity()
{
    PitchMapper mapper;
    mapper.prepare(48000);
    float previousMidi = 0;
    bool hasPrevious = false;
    double maximumError = 0;
    const std::array<float, 5> speeds { 0, .5f, 20, 200, 50 };
    const std::array<float, 4> durations { 32.0f / 48000, 127.0f / 48000, 127.0f / 48000, 512.0f / 48000 };
    for (int i = 0; i < 600; ++i)
    {
        if (i == 311) { mapper.reset(); previousMidi = 0; hasPrevious = false; }
        const float speed = speeds[static_cast<size_t>((i / 31) % 5)];
        const float dt = durations[static_cast<size_t>((i / 7) % 4)];
        const float strength = i % 19 < 7 ? .4f : 1.0f;
        const float humanize = i % 23 < 11 ? 72.0f : 0.0f;
        const int transpose = i < 230 ? 4 : -3;
        const float hz = i % 29 == 0 ? 0 : 440.0f * std::pow(2.0f, (.47f * std::sin(static_cast<float>(i) * .31f)) / 12.0f);
        const float confidence = i % 13 < 4 ? .23f : 1.0f;
        mapper.setRetuneSpeed(speed); mapper.setCorrectionStrength(strength);
        mapper.setHumanize(humanize); mapper.setTranspose(transpose);
        float expected = hz;
        if (hz > 0)
        {
            const float inputMidi = 69.0f + 12.0f * std::log2(hz / 440.0f);
            float target = std::round(inputMidi) + static_cast<float>(transpose);
            target = inputMidi + (target - inputMidi) * strength;
            if (humanize > 0) target += (inputMidi - target) * (humanize / 100.0f);
            if (!hasPrevious || speed <= .5f) previousMidi = target;
            else
            {
                const float tau = speed / 1000.0f;
                const float alpha = juce::jlimit(0.0f, 1.0f, 1.0f - std::exp(-dt / tau));
                previousMidi += (target - previousMidi) * alpha;
            }
            hasPrevious = true;
            if (confidence < .5f) previousMidi = inputMidi + (previousMidi - inputMidi) * (confidence / .5f);
        }
        if (hasPrevious) expected = 440.0f * std::pow(2.0f, (previousMidi - 69.0f) / 12.0f);
        maximumError = juce::jmax(maximumError, std::abs(static_cast<double>(mapper.mapPitch(hz, confidence, dt) - expected)));
    }
    return maximumError;
}
}

inline juce::var checkPitchDetectorSchedulingParity()
{
    using namespace PitchRealtimeRegression;
    bool pass = true;
    juce::Array<juce::var> rows;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
        for (float minimum : { 40.0f, 80.0f, 220.0f })
        {
            std::vector<float> input(static_cast<size_t>(rate * .18));
            for (size_t i = 0; i < input.size(); ++i)
                input[i] = static_cast<float>(.17 * std::sin(juce::MathConstants<double>::twoPi * 443.7 * static_cast<double>(i) / rate)
                    + .03 * std::sin(.37 * static_cast<double>(i)) + .02 * std::sin(juce::MathConstants<double>::twoPi * 887.4 * static_cast<double>(i) / rate));
            const auto expected = originalDetection(input, rate, minimum);
            double maximumError = 0;
            int comparisons = 0;
            for (bool variableBlocks : { false, true })
            {
                PitchDetector actual;
                actual.setRateNormalized(true);
                actual.setMinFrequency(minimum);
                actual.setMaxFrequency(1200);
                actual.prepare(rate, 511);
                size_t nextEvent = 0;
                std::array<float, 2> latest {};
                const std::array<int, 5> partitions { 1, 17, 64, 127, 511 };
                int block = 0;
                for (int position = 0; position < static_cast<int>(input.size());)
                {
                    const int count = juce::jmin(variableBlocks ? partitions[static_cast<size_t>(block++ % 5)] : 127,
                                                static_cast<int>(input.size()) - position);
                    actual.processSamples(input.data() + position, count);
                    position += count;
                    while (nextEvent < expected.size() && expected[nextEvent].inputPosition <= position)
                        latest = expected[nextEvent++].result;
                    maximumError = juce::jmax(maximumError,
                        std::abs(static_cast<double>(actual.getDetectedFrequency() - latest[0])),
                        std::abs(static_cast<double>(actual.getConfidence() - latest[1])));
                    ++comparisons;
                }
            }
            const bool okay = maximumError == 0;
            pass = pass && okay;
            auto* row = new juce::DynamicObject();
            row->setProperty("sampleRate", rate); row->setProperty("minimumHz", minimum);
            row->setProperty("comparisons", comparisons); row->setProperty("maximumError", maximumError); row->setProperty("pass", okay);
            rows.add(row);
        }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Pitch detector arithmetic and publication parity");
    result->setProperty("cases", rows); result->setProperty("pass", pass); result->setProperty("audioQuality", "not_asserted");
    return result;
}

inline juce::var checkPitchRealtimeContracts()
{
    using namespace PitchRealtimeRegression;
    const double mapperError = mapperCacheParity();
    bool pass = mapperError == 0, heapMeasured = false;
    int allocations = 0, frees = 0;
    juce::Array<juce::var> rows;
    for (int signalPath : { 0, 1 }) for (double rate : { 48000.0, 192000.0 }) for (int channels : { 1, 2 })
    {
        constexpr int capacity = 127, largeBlock = capacity * 7;
        OpenStudioPitchCorrector large, reference, alwaysActive;
        for (auto* processor : { &large, &reference, &alwaysActive })
        {
            processor->signalPath.store(static_cast<float>(signalPath));
            processor->midiOutputEnabled.store(1);
            processor->getMapper().setTranspose(4);
            processor->prepareToPlay(rate, capacity);
        }
        const int latency = large.getLatencySamples();
        bool stableLatency = latency > 0, midiParity = true, finite = true, interiorMidi = false;
        bool releasedNote = false, bypassWasAudited = false, resumeWasAudited = false;
        double outputError = 0, bypassDryError = 0, resumedWetError = 0;
        juce::AudioBuffer<float> audio(channels, largeBlock), expected(channels, largeBlock);
        juce::AudioBuffer<float> wetReference(channels, largeBlock);
        juce::MidiBuffer actualMidi, expectedMidi, partMidi;
        actualMidi.ensureSize(32768); expectedMidi.ensureSize(32768); partMidi.ensureSize(4096);
        const int blocks = static_cast<int>(rate * .5) / largeBlock + 1;
        for (int frame = 0; frame < blocks; ++frame)
        {
            // The 10 ms bypass crossfade remains hot, including detector,
            // stretcher and MIDI note release. Automation boundaries match.
            const bool bypassed = frame >= blocks / 3 && frame < 2 * blocks / 3;
            large.bypass.store(bypassed ? 1.0f : 0.0f);
            reference.bypass.store(bypassed ? 1.0f : 0.0f);
            for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < largeBlock; ++i)
            {
                const float sample = inputSample(frame * largeBlock + i, ch, rate);
                audio.setSample(ch, i, sample); expected.setSample(ch, i, sample); wetReference.setSample(ch, i, sample);
            }
            actualMidi.clear(); expectedMidi.clear();
#if JUCE_WINDOWS && defined(_DEBUG)
            EQMIDIHeapProbe::allocations = EQMIDIHeapProbe::frees = 0;
            EQMIDIHeapProbe::previous = _CrtSetAllocHook(EQMIDIHeapProbe::hook); EQMIDIHeapProbe::active = true;
#endif
            large.processBlock(audio, actualMidi);
#if JUCE_WINDOWS && defined(_DEBUG)
            EQMIDIHeapProbe::active = false; _CrtSetAllocHook(EQMIDIHeapProbe::previous);
            allocations += EQMIDIHeapProbe::allocations; frees += EQMIDIHeapProbe::frees; heapMeasured = true;
#endif
            // An independent, continuously active engine proves that bypass
            // has not retired its history or changed reactivation latency.
            partMidi.clear(); alwaysActive.processBlock(wetReference, partMidi);
            for (int offset = 0; offset < largeBlock; offset += capacity)
            {
                float* pointers[2] { expected.getWritePointer(0, offset), channels > 1 ? expected.getWritePointer(1, offset) : nullptr };
                juce::AudioBuffer<float> part(pointers, channels, capacity);
                partMidi.clear(); reference.processBlock(part, partMidi);
                expectedMidi.addEvents(partMidi, 0, capacity, offset);
            }
            auto a = actualMidi.begin(), b = expectedMidi.begin();
            while (a != actualMidi.end() && b != expectedMidi.end())
            {
                const auto actualEvent = *a, expectedEvent = *b;
                midiParity = midiParity && actualEvent.samplePosition == expectedEvent.samplePosition
                    && actualEvent.numBytes == expectedEvent.numBytes
                    && std::memcmp(actualEvent.data, expectedEvent.data, static_cast<size_t>(actualEvent.numBytes)) == 0;
                interiorMidi = interiorMidi || actualEvent.samplePosition > 0;
                releasedNote = releasedNote || (bypassed && actualEvent.getMessage().isNoteOff());
                ++a; ++b;
            }
            midiParity = midiParity && a == actualMidi.end() && b == expectedMidi.end();
            for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < largeBlock; ++i)
            {
                finite = finite && std::isfinite(audio.getSample(ch, i));
                outputError = juce::jmax(outputError, std::abs(static_cast<double>(audio.getSample(ch, i) - expected.getSample(ch, i))));
                const int position = frame * largeBlock + i;
                const int rampSamples = static_cast<int>(rate * .010) + 1;
                if (bypassed && position >= (blocks / 3) * largeBlock + rampSamples)
                {
                    const float dry = position < latency ? 0 : inputSample(position - latency, ch, rate);
                    bypassDryError = juce::jmax(bypassDryError, std::abs(static_cast<double>(audio.getSample(ch, i) - dry)));
                    bypassWasAudited = true;
                }
                if (position >= (2 * blocks / 3) * largeBlock + rampSamples)
                {
                    resumedWetError = juce::jmax(resumedWetError, std::abs(static_cast<double>(audio.getSample(ch, i) - wetReference.getSample(ch, i))));
                    resumeWasAudited = true;
                }
            }
            stableLatency = stableLatency && large.getLatencySamples() == latency;
        }
        // Extra channels are cleared, and an unprepared direct call is silent.
        juce::AudioBuffer<float> invalid(4, 19);
        for (int ch = 0; ch < 4; ++ch) for (int i = 0; i < 19; ++i) invalid.setSample(ch, i, .1f);
        actualMidi.clear(); large.processBlock(invalid, actualMidi);
        const bool extraChannels = invalid.getMagnitude(2, 0, 19) == 0 && invalid.getMagnitude(3, 0, 19) == 0;
        OpenStudioPitchCorrector unprepared;
        unprepared.processBlock(invalid, actualMidi);
        const bool preparationGuard = invalid.getMagnitude(0, 19) == 0;
        const bool okay = finite && outputError == 0 && stableLatency && midiParity && interiorMidi && extraChannels && preparationGuard
            && releasedNote && bypassWasAudited && resumeWasAudited && bypassDryError == 0 && resumedWetError == 0;
        pass = pass && okay;
        auto* row = new juce::DynamicObject();
        row->setProperty("signalPath", signalPath); row->setProperty("sampleRate", rate); row->setProperty("channels", channels);
        row->setProperty("outputError", outputError); row->setProperty("stableLatency", stableLatency);
        row->setProperty("midiParity", midiParity); row->setProperty("interiorMidi", interiorMidi);
        row->setProperty("bypassReleasedNote", releasedNote); row->setProperty("bypassDryError", bypassDryError);
        row->setProperty("resumedWetError", resumedWetError);
        row->setProperty("extraChannelsCleared", extraChannels); row->setProperty("unpreparedGuard", preparationGuard); row->setProperty("pass", okay);
        rows.add(row);
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Pitch bounded blocks, bypass, MIDI and latency");
    result->setProperty("mapperCacheMaximumError", mapperError);
    result->setProperty("cases", rows); result->setProperty("callbackHeapMeasured", heapMeasured);
    result->setProperty("callbackAllocations", allocations); result->setProperty("callbackFrees", frees);
    result->setProperty("pass", pass && allocations == 0 && frees == 0);
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
