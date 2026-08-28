#include "TrackProcessor.h"
#include "BuiltInParameterSupport.h"
#include "BuiltInEffects2.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

// Maximum channel count for the pre-allocated FX processing buffer.
// Must be large enough for multi-output instruments (e.g. Komplete Kontrol = 32 out).
static constexpr int kMaxFXChannels = 64;
static constexpr int kMinimumHostedPluginBlockSize = 512;
static constexpr int kHostBypassLatencyHeadroomSamples = 4096;
static constexpr int kRealtimeFXTailTimerMilliseconds = 250;
static constexpr double kRealtimeFXTailSafetySeconds = 1.0;
static constexpr double kRealtimeFXTailQuietWindowSeconds = 0.65;
static constexpr float kRealtimeFXTailQuietPeak = 3.1622776601683795e-5f; // -90 dBFS
static constexpr juce::uint32 kMIDIActivityHoldMilliseconds = 90;
static constexpr juce::uint32 kMIDIActivityDecayMilliseconds = 360;

namespace
{
float decayMIDIActivity(float level, juce::uint32 ageMilliseconds) noexcept
{
    if (ageMilliseconds <= kMIDIActivityHoldMilliseconds)
        return level;

    const auto decayAge = ageMilliseconds - kMIDIActivityHoldMilliseconds;
    if (decayAge >= kMIDIActivityDecayMilliseconds)
        return 0.0f;

    return level * (1.0f - static_cast<float>(decayAge)
        / static_cast<float>(kMIDIActivityDecayMilliseconds));
}

float getMIDIMessageActivity(const juce::MidiMessage& message) noexcept
{
    if (message.isNoteOn())
        return juce::jlimit(0.0f, 1.0f, message.getFloatVelocity());
    if (message.isController())
        return juce::jmax(0.12f, juce::jlimit(0.0f, 1.0f,
            static_cast<float>(message.getControllerValue()) / 127.0f));
    if (message.isAftertouch())
        return juce::jmax(0.12f, juce::jlimit(0.0f, 1.0f,
            static_cast<float>(message.getAfterTouchValue()) / 127.0f));
    if (message.isChannelPressure())
        return juce::jmax(0.12f, juce::jlimit(0.0f, 1.0f,
            static_cast<float>(message.getChannelPressureValue()) / 127.0f));
    if (message.isPitchWheel())
        return juce::jmax(0.12f, juce::jlimit(0.0f, 1.0f,
            static_cast<float>(message.getPitchWheelValue()) / 16383.0f));
    if (message.isProgramChange())
        return 0.5f;

    // Note-off and transport/clock/active-sensing messages must not keep an
    // armed track's input meter illuminated.
    return 0.0f;
}

class ScopedTrackRealtimeReader final
{
public:
    explicit ScopedTrackRealtimeReader(
        std::atomic<std::uint32_t>& readersToUse,
        bool active = true) noexcept
        : readers(active ? &readersToUse : nullptr)
    {
        if (readers != nullptr)
            readers->fetch_add(1, std::memory_order_seq_cst);
    }

    ~ScopedTrackRealtimeReader()
    {
        if (readers != nullptr)
            readers->fetch_sub(1, std::memory_order_seq_cst);
    }

    ScopedTrackRealtimeReader(
        const ScopedTrackRealtimeReader&) = delete;
    ScopedTrackRealtimeReader& operator=(
        const ScopedTrackRealtimeReader&) = delete;

private:
    std::atomic<std::uint32_t>* readers = nullptr;
};
}

// juce::MidiOutput::sendBlockOfMessages() allocates one PendingMessage and
// takes an internal CriticalSection for every event. Keep that entire code
// path, along with device lifetime changes, off the audio callback.
class TrackMIDIOutputDispatcher final : private juce::Thread
{
public:
    TrackMIDIOutputDispatcher()
        : juce::Thread("OpenStudio Track MIDI Sender")
    {
    }

    ~TrackMIDIOutputDispatcher() override
    {
        connected.store(false, std::memory_order_release);
        generation.fetch_add(1, std::memory_order_acq_rel);
        signalThreadShouldExit();
        stopThread(2000);

        const juce::ScopedLock sl(outputLock);
        output.reset();
        outputDeviceName.clear();
    }

    bool connect(const juce::String& deviceName)
    {
        disconnect();

        std::unique_ptr<juce::MidiOutput> newOutput;
        for (const auto& device : juce::MidiOutput::getAvailableDevices())
        {
            if (device.name == deviceName)
            {
                newOutput = juce::MidiOutput::openDevice(device.identifier);
                break;
            }
        }

        if (newOutput == nullptr)
            return false;

        {
            const juce::ScopedLock sl(outputLock);
            output = std::move(newOutput);
            outputDeviceName = deviceName;
            generation.fetch_add(1, std::memory_order_acq_rel);
            connected.store(true, std::memory_order_release);
        }

        if (!isThreadRunning()
            && !startThread(juce::Thread::Priority::high))
        {
            disconnect();
            return false;
        }

        notify();
        return true;
    }

    void disconnect()
    {
        connected.store(false, std::memory_order_release);
        generation.fetch_add(1, std::memory_order_acq_rel);
        notify();

        const juce::ScopedLock sl(outputLock);
        output.reset();
        outputDeviceName.clear();
    }

    bool isConnected() const noexcept
    {
        return connected.load(std::memory_order_acquire);
    }

    juce::String getDeviceName() const
    {
        const juce::ScopedLock sl(outputLock);
        return outputDeviceName;
    }

    void enqueueBuffer(const juce::MidiBuffer& buffer,
                       double sampleRate,
                       bool resetMessagesOnly) noexcept
    {
        if (!connected.load(std::memory_order_acquire) || buffer.isEmpty())
            return;

        const double safeSampleRate =
            sampleRate > 0.0 ? sampleRate : 44100.0;
        const double blockStartMs =
            juce::Time::getMillisecondCounterHiRes();
        const double millisecondsPerSample = 1000.0 / safeSampleRate;

        for (const auto metadata : buffer)
        {
            if (resetMessagesOnly
                && !isResetMessage(
                    metadata.data,
                    metadata.numBytes))
            {
                continue;
            }

            const double eventTimeMs =
                blockStartMs
                + static_cast<double>(
                    juce::jmax(0, metadata.samplePosition))
                    * millisecondsPerSample;
            enqueueMessage(
                metadata.data,
                metadata.numBytes,
                eventTimeMs);
        }
    }

private:
    struct Packet
    {
        std::array<std::uint8_t, 256> bytes {};
        double eventTimeMs = 0.0;
        std::uint32_t generation = 0;
        std::uint16_t size = 0;
    };

    static constexpr std::uint32_t kQueueCapacity = 512;
    static constexpr int kMaxMessageBytes =
        static_cast<int>(Packet{}.bytes.size());
    static_assert(
        (kQueueCapacity & (kQueueCapacity - 1)) == 0);
    static_assert(std::atomic<bool>::is_always_lock_free);
    static_assert(
        std::atomic<std::uint32_t>::is_always_lock_free);

    static bool isResetMessage(const std::uint8_t* bytes,
                               int size) noexcept
    {
        if (bytes == nullptr || size < 1)
            return false;

        const auto status =
            static_cast<std::uint8_t>(bytes[0] & 0xf0u);
        if (status == 0xb0u && size >= 3)
        {
            const auto controller = bytes[1];
            return controller == 64u
                || controller == 120u
                || controller == 121u
                || controller == 123u;
        }

        if (status == 0xe0u && size >= 3)
        {
            const int pitchWheel =
                static_cast<int>(bytes[1])
                | (static_cast<int>(bytes[2]) << 7);
            return pitchWheel == 8192;
        }

        return false;
    }

    bool enqueueMessage(const std::uint8_t* bytes,
                        int size,
                        double eventTimeMs) noexcept
    {
        if (bytes == nullptr
            || size <= 0
            || size > kMaxMessageBytes
            || !connected.load(std::memory_order_acquire))
        {
            if (size > kMaxMessageBytes)
                oversizedMessageCount.fetch_add(
                    1, std::memory_order_relaxed);
            return false;
        }

        const auto write =
            writePosition.load(std::memory_order_relaxed);
        const auto read =
            readPosition.load(std::memory_order_acquire);
        if (write - read >= kQueueCapacity)
        {
            droppedMessageCount.fetch_add(
                1, std::memory_order_relaxed);
            return false;
        }

        auto& packet =
            queue[write & (kQueueCapacity - 1)];
        packet.eventTimeMs = eventTimeMs;
        packet.generation =
            generation.load(std::memory_order_acquire);
        packet.size = static_cast<std::uint16_t>(size);
        for (int index = 0; index < size; ++index)
        {
            packet.bytes[static_cast<std::size_t>(index)] =
                bytes[index];
        }

        writePosition.store(
            write + 1, std::memory_order_release);
        return true;
    }

    bool dequeue(Packet& packet) noexcept
    {
        const auto read =
            readPosition.load(std::memory_order_relaxed);
        if (read == writePosition.load(
                        std::memory_order_acquire))
        {
            return false;
        }

        packet = queue[read & (kQueueCapacity - 1)];
        readPosition.store(
            read + 1, std::memory_order_release);
        return true;
    }

    void run() override
    {
        Packet packet;
        bool hasPacket = false;

        while (!threadShouldExit())
        {
            if (!hasPacket)
                hasPacket = dequeue(packet);

            if (!hasPacket)
            {
                const bool active =
                    connected.load(std::memory_order_relaxed);
                wait(active ? 1 : 20);
                continue;
            }

            const auto currentGeneration =
                generation.load(std::memory_order_acquire);
            if (!connected.load(std::memory_order_acquire)
                || packet.generation != currentGeneration)
            {
                hasPacket = false;
                continue;
            }

            const double nowMs =
                juce::Time::getMillisecondCounterHiRes();
            const double remainingMs =
                packet.eventTimeMs - nowMs;
            if (remainingMs > 0.75)
            {
                wait(juce::jlimit(
                    1,
                    20,
                    static_cast<int>(
                        std::floor(remainingMs))));
                continue;
            }

            {
                const juce::ScopedLock sl(outputLock);
                if (output != nullptr
                    && connected.load(
                        std::memory_order_acquire)
                    && packet.generation
                        == generation.load(
                            std::memory_order_acquire))
                {
                    output->sendMessageNow(
                        juce::MidiMessage(
                            packet.bytes.data(),
                            static_cast<int>(packet.size)));
                }
            }

            hasPacket = false;
        }
    }

    std::array<Packet, kQueueCapacity> queue {};
    std::atomic<std::uint32_t> writePosition { 0 };
    std::atomic<std::uint32_t> readPosition { 0 };
    std::atomic<std::uint32_t> generation { 1 };
    std::atomic<std::uint32_t> droppedMessageCount { 0 };
    std::atomic<std::uint32_t> oversizedMessageCount { 0 };
    std::atomic<bool> connected { false };
    mutable juce::CriticalSection outputLock;
    std::unique_ptr<juce::MidiOutput> output;
    juce::String outputDeviceName;
};

static bool isBuiltInInstrumentProcessor(const juce::AudioProcessor* processor)
{
    if (processor == nullptr)
        return false;

    const auto name = processor->getName();
    return name == "OpenStudio Piano"
        || name == "OpenStudio Drums"
        || name == "OpenStudio Basic Synth"
        || name == "OpenStudio Clean Guitar"
        || name == "Studio13 Piano"
        || name == "Studio13 Drums"
        || name == "Studio13 Basic Synth"
        || name == "Studio13 Clean Guitar";
}

static bool hasInternalAuditionSourceActive(
    const std::vector<std::shared_ptr<juce::AudioProcessor>>* processors)
{
    if (processors == nullptr)
        return false;

    for (const auto& processor : *processors)
    {
        if (auto* rack = dynamic_cast<S13NAMRack*>(processor.get()))
            if (rack->hasAuditionSourceActive())
                return true;
    }

    return false;
}

// Debug logging — always active for FX diagnostics
static void logToDisk(const juce::String& msg)
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    auto openStudioLog = documentsDir.getChildFile("OpenStudio").getChildFile("debug_log.txt");
    auto legacyLog = documentsDir.getChildFile("Studio13").getChildFile("debug_log.txt");
    auto f = !openStudioLog.existsAsFile() && legacyLog.existsAsFile() ? legacyLog : openStudioLog;
    f.getParentDirectory().createDirectory();
    f.appendText(juce::Time::getCurrentTime().toString(true, true) + ": " + msg + "\n");
}

static int getSafeHostedPluginBlockSize(int requestedBlockSize)
{
    return juce::jmax(kMinimumHostedPluginBlockSize,
                      requestedBlockSize > 0 ? requestedBlockSize : kMinimumHostedPluginBlockSize);
}

static float polyBlep(float phase, float phaseDelta)
{
    if (phaseDelta <= 0.0f)
        return 0.0f;

    if (phase < phaseDelta)
    {
        const float t = phase / phaseDelta;
        return t + t - t * t - 1.0f;
    }

    if (phase > 1.0f - phaseDelta)
    {
        const float t = (phase - 1.0f) / phaseDelta;
        return t * t + t + t + 1.0f;
    }

    return 0.0f;
}

static float polyBlepSaw(float phase, float phaseDelta)
{
    return (2.0f * phase - 1.0f) - polyBlep(phase, phaseDelta);
}

static float polyBlepSquare(float phase, float phaseDelta, float pulseWidth)
{
    const float clampedPulseWidth = juce::jlimit(0.08f, 0.92f, pulseWidth);
    float value = phase < clampedPulseWidth ? 1.0f : -1.0f;
    value += polyBlep(phase, phaseDelta);

    float fallingPhase = phase - clampedPulseWidth;
    if (fallingPhase < 0.0f)
        fallingPhase += 1.0f;
    value -= polyBlep(fallingPhase, phaseDelta);
    return value;
}

static float cubicInterpolate(float a, float b, float c, float d, float frac)
{
    const float p = (d - c) - (a - b);
    const float q = (a - b) - p;
    const float r = c - a;
    return ((p * frac + q) * frac + r) * frac + b;
}

static float fastNoise(int sampleAge, int note)
{
    const float x = static_cast<float>(sampleAge * 1103515245u + note * 12345u);
    return std::sin(x * 0.0000137f) * std::sin(x * 0.000091f);
}

static float getDrumBaseFrequency(int note)
{
    switch (note)
    {
        case 35:
        case 36: return 52.0f;
        case 37:
        case 38:
        case 40: return 190.0f;
        case 41: return 82.0f;
        case 43: return 98.0f;
        case 45: return 123.0f;
        case 47: return 146.0f;
        case 48: return 164.0f;
        case 50: return 196.0f;
        default: return 440.0f;
    }
}

static float getDrumDecaySeconds(int note)
{
    switch (note)
    {
        case 35:
        case 36: return 0.42f;
        case 37:
        case 38:
        case 40: return 0.24f;
        case 42: return 0.055f;
        case 44: return 0.09f;
        case 46: return 0.62f;
        case 49:
        case 52:
        case 55:
        case 57: return 1.55f;
        case 51:
        case 53:
        case 59: return 1.15f;
        default: return note >= 41 && note <= 50 ? 0.42f : 0.28f;
    }
}

static void computePanLawGains(PanLaw panLaw, float pan, float volumeGain,
                               float& leftGain, float& rightGain)
{
    const float clampedPan = juce::jlimit(-1.0f, 1.0f, pan);
    const float normalizedPan = (clampedPan + 1.0f) * 0.5f;
    const float panAngle = (clampedPan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;

    switch (panLaw)
    {
        case PanLaw::Minus4_5dB:
        {
            const float cpL = std::cos(panAngle);
            const float cpR = std::sin(panAngle);
            const float linL = 1.0f - normalizedPan;
            const float linR = normalizedPan;
            leftGain = (cpL + linL) * 0.5f * volumeGain;
            rightGain = (cpR + linR) * 0.5f * volumeGain;
            break;
        }
        case PanLaw::Minus6dB:
        {
            leftGain = (1.0f - normalizedPan) * volumeGain;
            rightGain = normalizedPan * volumeGain;
            break;
        }
        case PanLaw::Linear:
        {
            leftGain = juce::jmin(1.0f, 1.0f - clampedPan) * volumeGain;
            rightGain = juce::jmin(1.0f, 1.0f + clampedPan) * volumeGain;
            break;
        }
        case PanLaw::ConstantPower:
        default:
        {
            leftGain = std::cos(panAngle) * volumeGain;
            rightGain = std::sin(panAngle) * volumeGain;
            break;
        }
    }
}

static void normalizeMonoLikeBufferToDualMono(juce::AudioBuffer<float>& buffer,
                                              int bufferChannels,
                                              int numSamples)
{
    if (bufferChannels < 2 || numSamples <= 0)
        return;

    const auto* left = buffer.getReadPointer(0);
    const auto* right = buffer.getReadPointer(1);

    float peakLeft = 0.0f;
    float peakRight = 0.0f;
    float maxDifference = 0.0f;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float absLeft = std::abs(left[sample]);
        const float absRight = std::abs(right[sample]);
        peakLeft = juce::jmax(peakLeft, absLeft);
        peakRight = juce::jmax(peakRight, absRight);
        maxDifference = juce::jmax(maxDifference, std::abs(left[sample] - right[sample]));
    }

    constexpr float silenceThreshold = 1.0e-5f;
    const float identicalTolerance = juce::jmax(1.0e-4f, juce::jmax(peakLeft, peakRight) * 1.0e-3f);

    const bool leftSilent = peakLeft <= silenceThreshold;
    const bool rightSilent = peakRight <= silenceThreshold;
    const bool nearlyIdentical = maxDifference <= identicalTolerance;

    if (nearlyIdentical)
        return;

    if (!leftSilent && rightSilent)
    {
        buffer.copyFrom(1, 0, buffer, 0, 0, numSamples);
        return;
    }

    if (leftSilent && !rightSilent)
        buffer.copyFrom(0, 0, buffer, 1, 0, numSamples);
}

static float backendWidthToPercent(float backendWidth)
{
    return juce::jlimit(0.0f, 200.0f, (juce::jlimit(-1.0f, 1.0f, backendWidth) + 1.0f) * 100.0f);
}

static float widthPercentToBackend(float widthPercent)
{
    return juce::jlimit(-1.0f, 1.0f, (juce::jlimit(0.0f, 200.0f, widthPercent) / 100.0f) - 1.0f);
}

static void applyStereoWidthToBuffer(juce::AudioBuffer<float>& buffer,
                                     int bufferChannels,
                                     int numSamples,
                                     float widthPercent)
{
    if (bufferChannels < 2 || std::abs(widthPercent - 100.0f) <= 0.01f)
        return;

    const float widthFactor = widthPercent / 100.0f;
    float* left = buffer.getWritePointer(0);
    float* right = buffer.getWritePointer(1);

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float mid = (left[sample] + right[sample]) * 0.5f;
        const float side = (left[sample] - right[sample]) * 0.5f;
        left[sample] = mid + side * widthFactor;
        right[sample] = mid - side * widthFactor;
    }
}

void TrackProcessor::registerMIDIInputActivity(
    const juce::MidiMessage& message) noexcept
{
    const auto activity = getMIDIMessageActivity(message);
    if (activity <= 0.0f)
        return;

    const auto now = juce::Time::getMillisecondCounter();
    const auto previousTimestamp = midiInputActivityTimestampMs.load(
        std::memory_order_acquire);
    const auto previousLevel = midiInputActivityLevel.load(
        std::memory_order_acquire);
    const auto decayedPrevious = previousTimestamp == 0
        ? 0.0f
        : decayMIDIActivity(previousLevel, now - previousTimestamp);

    midiInputActivityLevel.store(
        juce::jmax(activity, decayedPrevious),
        std::memory_order_release);
    midiInputActivityTimestampMs.store(now, std::memory_order_release);
}

float TrackProcessor::getMIDIInputActivityLevel() const noexcept
{
    const auto timestamp = midiInputActivityTimestampMs.load(
        std::memory_order_acquire);
    if (timestamp == 0)
        return 0.0f;

    const auto level = midiInputActivityLevel.load(std::memory_order_acquire);
    return decayMIDIActivity(
        level,
        juce::Time::getMillisecondCounter() - timestamp);
}

TrackProcessor::TrackProcessor()
     : AudioProcessor (BusesProperties()
                       .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
       midiOutputDispatcher(
           std::make_unique<TrackMIDIOutputDispatcher>())
{
    // Give the inline Channel Strip EQ its own explicit six-band contract.
    // S13EQ's plug-in defaults are an eight-band layout, so relying on them
    // made the strip's HPF/LPF labels disagree with the filters that actually
    // ran until a user moved each control at least once.
    static constexpr std::array<float, channelStripEQBandCount> stripFrequencies {
        80.0f, 200.0f, 1000.0f, 3000.0f, 8000.0f, 18000.0f
    };
    static constexpr std::array<float, channelStripEQBandCount> stripQ {
        0.707f, 0.707f, 1.0f, 1.0f, 0.707f, 0.707f
    };
    for (int bandIndex = 0; bandIndex < channelStripEQBandCount; ++bandIndex)
    {
        auto& band = channelStripEQ.bands[static_cast<size_t>(bandIndex)];
        band.type.store(
            static_cast<float>(
                bandIndex == 0
                    ? S13EQ::FilterType::LowCut
                    : bandIndex == channelStripEQBandCount - 1
                        ? S13EQ::FilterType::HighCut
                        : S13EQ::FilterType::Bell),
            std::memory_order_relaxed);
        band.freq.store(stripFrequencies[static_cast<size_t>(bandIndex)],
                        std::memory_order_relaxed);
        band.gain.store(0.0f, std::memory_order_relaxed);
        band.q.store(stripQ[static_cast<size_t>(bandIndex)],
                     std::memory_order_relaxed);
        band.enabled.store(0.0f, std::memory_order_relaxed);
    }
    for (int bandIndex = channelStripEQBandCount;
         bandIndex < S13EQ::numBands;
         ++bandIndex)
    {
        channelStripEQ.bands[static_cast<size_t>(bandIndex)].enabled.store(
            0.0f, std::memory_order_relaxed);
    }
    widthAutomation.setDefaultValue(widthPercentToBackend(stereoWidth.load(std::memory_order_relaxed)));
    preFXVolumeAutomation.setDefaultValue(0.0f);
    preFXPanAutomation.setDefaultValue(0.0f);
    preFXWidthAutomation.setDefaultValue(0.0f);
    trimVolumeAutomation.setDefaultValue(0.0f);
    muteAutomation.setDefaultValue(0.0f);
    midiVelocityScaleAutomation.setDefaultValue(1.0f);
    midiPitchBendAutomation.setDefaultValue(0.0f);
    midiChannelPressureAutomation.setDefaultValue(0.0f);
    publishPluginAutomationRoutes(
        std::make_shared<const PluginAutomationRouteSnapshot>());
    publishMIDICCAutomationRoutes(
        std::make_shared<const MIDICCAutomationRouteSnapshot>());
    for (size_t channel = 0; channel < midiNoteCurrentlyActive.size(); ++channel)
    {
        for (size_t note = 0; note < midiNoteCurrentlyActive[channel].size(); ++note)
        {
            midiNoteCurrentlyActive[channel][note].store(false, std::memory_order_relaxed);
            midiNoteLastOnMs[channel][note].store(0, std::memory_order_relaxed);
            midiNoteLastOffMs[channel][note].store(0, std::memory_order_relaxed);
            midiNoteLastVelocity[channel][note].store(0, std::memory_order_relaxed);
        }
    }
    publishRealtimeStateSnapshots();
    startTimer(kRealtimeFXTailTimerMilliseconds);
}

TrackProcessor::~TrackProcessor()
{
    stopTimer();
    hasScheduledMIDIClipsForAudio.store(
        false, std::memory_order_release);
    scheduledMIDIClipsForAudio.store(
        nullptr, std::memory_order_seq_cst);
    realtimeGraphSnapshotForAudio.store(
        nullptr, std::memory_order_seq_cst);
    pluginAutomationSnapshotForAudio.store(
        nullptr, std::memory_order_seq_cst);
    midiCCAutomationSnapshotForAudio.store(
        nullptr, std::memory_order_seq_cst);
    fallbackSamplerSampleForAudio.store(
        nullptr, std::memory_order_seq_cst);
    jassert(
        scheduledMIDIAudioReaders.load(
            std::memory_order_seq_cst) == 0);
    jassert(
        realtimeGraphAudioReaders.load(
            std::memory_order_seq_cst) == 0);
    jassert(
        realtimeAuxAudioReaders.load(
            std::memory_order_seq_cst) == 0);
    reclaimRetiredScheduledMIDISnapshots();
    reclaimRetiredRealtimeGraphSnapshots();
    reclaimRetiredRealtimeAuxOwners();
}

std::optional<TrackProcessor::PluginAutomationParameterRef> TrackProcessor::parsePluginAutomationParameterId(const juce::String& parameterId) const
{
    if (parameterId.startsWith("builtin_"))
    {
        const auto suffix = parameterId.substring(8);
        const int firstSeparator = suffix.indexOfChar('_');
        const int secondSeparator = suffix.indexOfChar(firstSeparator + 1, '_');
        if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1)
            return std::nullopt;

        const auto chain = suffix.substring(0, firstSeparator);
        PluginAutomationParameterRef ref;
        if (chain != "input" && chain != "track")
            return std::nullopt;

        ref.isInputFX = chain == "input";
        ref.fxIndex = suffix.substring(firstSeparator + 1, secondSeparator).getIntValue();
        ref.builtInParamId = juce::URL::removeEscapeChars(suffix.substring(secondSeparator + 1));
        if (ref.fxIndex < 0 || ref.builtInParamId.isEmpty())
            return std::nullopt;
        return ref;
    }

    if (!parameterId.startsWith("plugin_"))
        return std::nullopt;

    auto suffix = parameterId.substring(7);
    auto parts = juce::StringArray::fromTokens(suffix, "_", "");
    PluginAutomationParameterRef ref;

    if (parts.size() == 3 && (parts[0] == "input" || parts[0] == "track"))
    {
        ref.isInputFX = parts[0] == "input";
        ref.fxIndex = parts[1].getIntValue();
        ref.paramIndex = parts[2].getIntValue();
    }
    else if (parts.size() == 2)
    {
        ref.fxIndex = parts[0].getIntValue();
        ref.paramIndex = parts[1].getIntValue();

        const bool hasInputFx = ref.fxIndex >= 0 && ref.fxIndex < getNumInputFX();
        const bool hasTrackFx = ref.fxIndex >= 0 && ref.fxIndex < getNumTrackFX();
        if (hasInputFx == hasTrackFx)
            return std::nullopt;
        ref.isInputFX = hasInputFx;
    }
    else
    {
        return std::nullopt;
    }

    if (ref.fxIndex < 0 || ref.paramIndex < 0)
        return std::nullopt;

    return ref;
}

std::shared_ptr<TrackProcessor::PluginAutomationRoute> TrackProcessor::findPluginAutomationRoute(const juce::String& parameterId) const
{
    auto snapshot = std::atomic_load_explicit(&pluginAutomationSnapshot, std::memory_order_acquire);
    if (!snapshot)
        return nullptr;

    for (const auto& route : *snapshot)
    {
        if (route && route->parameterId == parameterId)
            return route;
    }

    return nullptr;
}

std::shared_ptr<TrackProcessor::PluginAutomationRoute>
TrackProcessor::clonePluginAutomationRoute(
    const PluginAutomationRoute& source)
{
    auto clone = std::make_shared<PluginAutomationRoute>();
    clone->parameterId = source.parameterId;
    clone->isInputFX = source.isInputFX;
    clone->fxIndex = source.fxIndex;
    clone->targetProcessor = source.targetProcessor;
    clone->paramIndex = source.paramIndex;
    clone->builtInParamId = source.builtInParamId;
    clone->builtInMinimum = source.builtInMinimum;
    clone->builtInMaximum = source.builtInMaximum;
    clone->builtInDiscrete = source.builtInDiscrete;
    clone->builtInCurve = source.builtInCurve;
    clone->automation = source.automation;
    clone->lastAppliedValue.store(
        source.lastAppliedValue.load(std::memory_order_acquire),
        std::memory_order_relaxed);
    return clone;
}

void TrackProcessor::publishPluginAutomationRoutes(
    std::shared_ptr<const PluginAutomationRouteSnapshot> snapshot)
{
    const bool hasRoutes = snapshot != nullptr && !snapshot->empty();
    const juce::ScopedLock publicationGuard(
        realtimeAuxPublicationLock);
    reclaimRetiredRealtimeAuxOwners();
    const auto previous = std::atomic_load_explicit(
        &pluginAutomationSnapshot,
        std::memory_order_acquire);
    {
        const juce::ScopedLock retirementGuard(
            realtimeAuxRetirementLock);
        if (previous != nullptr
            && previous.get() != snapshot.get())
        {
            retiredRealtimeAuxOwners.push_back(
                std::static_pointer_cast<const void>(
                    previous));
        }
        std::atomic_store_explicit(
            &pluginAutomationSnapshot,
            snapshot,
            std::memory_order_release);
        pluginAutomationSnapshotForAudio.store(
            snapshot.get(),
            std::memory_order_seq_cst);
    }
    hasPublishedPluginAutomationRoutes.store(hasRoutes, std::memory_order_release);
}

void TrackProcessor::remapPluginAutomationRoutesForReorder(
    bool isInputFX, int fromIndex, int toIndex)
{
    const juce::ScopedLock routeGuard(pluginAutomationRouteLock);
    const auto snapshot = std::atomic_load_explicit(
        &pluginAutomationSnapshot, std::memory_order_acquire);
    if (snapshot == nullptr || snapshot->empty())
        return;

    auto nextSnapshot = std::make_shared<PluginAutomationRouteSnapshot>();
    nextSnapshot->reserve(snapshot->size());
    for (const auto& route : *snapshot)
    {
        if (route == nullptr)
        {
            nextSnapshot->push_back(route);
            continue;
        }

        // Route objects already visible to the callback are immutable. Clone
        // before changing Strings or indices so the old reader epoch remains
        // race-free until retirement.
        auto nextRoute = clonePluginAutomationRoute(*route);
        if (route->isInputFX != isInputFX)
        {
            nextSnapshot->push_back(std::move(nextRoute));
            continue;
        }

        int mappedIndex = route->fxIndex;
        if (mappedIndex == fromIndex)
            mappedIndex = toIndex;
        else if (fromIndex < toIndex
                 && mappedIndex > fromIndex
                 && mappedIndex <= toIndex)
            --mappedIndex;
        else if (fromIndex > toIndex
                 && mappedIndex >= toIndex
                 && mappedIndex < fromIndex)
            ++mappedIndex;

        nextRoute->fxIndex = mappedIndex;
        const auto chain = isInputFX ? "input" : "track";
        nextRoute->parameterId = nextRoute->builtInParamId.isNotEmpty()
            ? "builtin_" + juce::String(chain) + "_" + juce::String(mappedIndex)
                + "_" + juce::URL::addEscapeChars(nextRoute->builtInParamId, true)
            : "plugin_" + juce::String(chain) + "_" + juce::String(mappedIndex)
                + "_" + juce::String(nextRoute->paramIndex);
        nextRoute->lastAppliedValue.store(
            std::numeric_limits<float>::quiet_NaN(),
            std::memory_order_release);
        nextSnapshot->push_back(std::move(nextRoute));
    }

    publishPluginAutomationRoutes(
        std::static_pointer_cast<const PluginAutomationRouteSnapshot>(nextSnapshot));
}

void TrackProcessor::remapPluginAutomationRoutesForRemoval(
    bool isInputFX, int removedIndex)
{
    const juce::ScopedLock routeGuard(pluginAutomationRouteLock);
    const auto snapshot = std::atomic_load_explicit(
        &pluginAutomationSnapshot, std::memory_order_acquire);
    if (snapshot == nullptr || snapshot->empty())
        return;

    auto nextSnapshot = std::make_shared<PluginAutomationRouteSnapshot>();
    nextSnapshot->reserve(snapshot->size());
    for (const auto& route : *snapshot)
    {
        if (route == nullptr)
        {
            nextSnapshot->push_back(route);
            continue;
        }
        if (route->isInputFX == isInputFX
            && route->fxIndex == removedIndex)
            continue;

        auto nextRoute = clonePluginAutomationRoute(*route);

        if (route->isInputFX == isInputFX
            && route->fxIndex > removedIndex)
        {
            --nextRoute->fxIndex;
            const auto chain = isInputFX ? "input" : "track";
            nextRoute->parameterId = nextRoute->builtInParamId.isNotEmpty()
                ? "builtin_" + juce::String(chain) + "_" + juce::String(nextRoute->fxIndex)
                    + "_" + juce::URL::addEscapeChars(nextRoute->builtInParamId, true)
                : "plugin_" + juce::String(chain) + "_" + juce::String(nextRoute->fxIndex)
                    + "_" + juce::String(nextRoute->paramIndex);
            nextRoute->lastAppliedValue.store(
                std::numeric_limits<float>::quiet_NaN(),
                std::memory_order_release);
        }
        nextSnapshot->push_back(std::move(nextRoute));
    }

    publishPluginAutomationRoutes(
        std::static_pointer_cast<const PluginAutomationRouteSnapshot>(nextSnapshot));
}

std::shared_ptr<TrackProcessor::PluginAutomationRoute> TrackProcessor::getOrCreatePluginAutomationRoute(const juce::String& parameterId)
{
    if (auto existing = findPluginAutomationRoute(parameterId))
        return existing;

    auto parsed = parsePluginAutomationParameterId(parameterId);
    if (!parsed.has_value())
        return nullptr;

    const auto parsedRef = *parsed;
    auto route = std::make_shared<PluginAutomationRoute>();
    route->parameterId = parameterId;
    route->isInputFX = parsedRef.isInputFX;
    route->fxIndex = parsedRef.fxIndex;
    route->paramIndex = parsedRef.paramIndex;
    route->builtInParamId = parsedRef.builtInParamId;

    const bool validRoute = route->isInputFX
        ? route->fxIndex < getNumInputFX()
        : route->fxIndex < getNumTrackFX();
    if (!validRoute)
        return nullptr;

    auto* processor = route->isInputFX
        ? getInputFXProcessor(route->fxIndex)
        : getTrackFXProcessor(route->fxIndex);
    route->targetProcessor = processor;
    if (route->builtInParamId.isNotEmpty())
    {
        OpenStudioBuiltInAutomationDescriptor descriptor;
        if (! getOpenStudioBuiltInAutomationDescriptor(processor, route->builtInParamId, descriptor))
            return nullptr;
        route->builtInMinimum = descriptor.minimum;
        route->builtInMaximum = descriptor.maximum;
        route->builtInDiscrete = descriptor.discrete;
        route->builtInCurve = descriptor.curve;
        route->automation->setDefaultValue(
            openStudioBuiltInValueToNormalized(
                descriptor, descriptor.currentValue));
    }

    const juce::ScopedLock sl(pluginAutomationRouteLock);
    if (auto existing = findPluginAutomationRoute(parameterId))
        return existing;

    auto snapshot = std::atomic_load_explicit(&pluginAutomationSnapshot, std::memory_order_acquire);
    auto nextSnapshot = std::make_shared<PluginAutomationRouteSnapshot>();
    if (snapshot)
        *nextSnapshot = *snapshot;
    nextSnapshot->push_back(route);
    publishPluginAutomationRoutes(
        std::static_pointer_cast<const PluginAutomationRouteSnapshot>(nextSnapshot));
    return route;
}

std::optional<int> TrackProcessor::parseMIDICCAutomationParameterId(const juce::String& parameterId)
{
    if (!parameterId.startsWith("midi_cc_"))
        return std::nullopt;

    const int controller = parameterId.substring(8).getIntValue();
    if (controller < 0 || controller > 127)
        return std::nullopt;
    return controller;
}

std::shared_ptr<TrackProcessor::MIDICCAutomationRoute> TrackProcessor::findMIDICCAutomationRoute(const juce::String& parameterId) const
{
    auto snapshot = std::atomic_load_explicit(&midiCCAutomationSnapshot, std::memory_order_acquire);
    if (!snapshot)
        return nullptr;

    for (const auto& route : *snapshot)
        if (route && route->parameterId == parameterId)
            return route;

    return nullptr;
}

void TrackProcessor::publishMIDICCAutomationRoutes(
    std::shared_ptr<const MIDICCAutomationRouteSnapshot> snapshot)
{
    const bool hasRoutes = snapshot != nullptr && !snapshot->empty();
    const juce::ScopedLock publicationGuard(
        realtimeAuxPublicationLock);
    reclaimRetiredRealtimeAuxOwners();
    const auto previous = std::atomic_load_explicit(
        &midiCCAutomationSnapshot,
        std::memory_order_acquire);
    {
        const juce::ScopedLock retirementGuard(
            realtimeAuxRetirementLock);
        if (previous != nullptr
            && previous.get() != snapshot.get())
        {
            retiredRealtimeAuxOwners.push_back(
                std::static_pointer_cast<const void>(
                    previous));
        }
        std::atomic_store_explicit(
            &midiCCAutomationSnapshot,
            snapshot,
            std::memory_order_release);
        midiCCAutomationSnapshotForAudio.store(
            snapshot.get(),
            std::memory_order_seq_cst);
    }
    hasPublishedMIDICCAutomationRoutes.store(hasRoutes, std::memory_order_release);
}

std::shared_ptr<TrackProcessor::MIDICCAutomationRoute> TrackProcessor::getOrCreateMIDICCAutomationRoute(const juce::String& parameterId)
{
    if (auto existing = findMIDICCAutomationRoute(parameterId))
        return existing;

    auto controller = parseMIDICCAutomationParameterId(parameterId);
    if (!controller.has_value())
        return nullptr;

    auto route = std::make_shared<MIDICCAutomationRoute>();
    route->parameterId = parameterId;
    route->controller = *controller;
    route->automation->setDefaultValue(0.0f);

    const juce::ScopedLock sl(midiAutomationRouteLock);
    if (auto existing = findMIDICCAutomationRoute(parameterId))
        return existing;

    auto snapshot = std::atomic_load_explicit(&midiCCAutomationSnapshot, std::memory_order_acquire);
    auto nextSnapshot = std::make_shared<MIDICCAutomationRouteSnapshot>();
    if (snapshot)
        *nextSnapshot = *snapshot;
    nextSnapshot->push_back(route);
    publishMIDICCAutomationRoutes(
        std::static_pointer_cast<const MIDICCAutomationRouteSnapshot>(nextSnapshot));
    return route;
}

std::optional<TrackProcessor::AutomationTarget> TrackProcessor::resolveAutomationTarget(const juce::String& parameterId,
                                                                                        bool createIfNeeded)
{
    AutomationTarget target;
    if (parameterId == "volume")
    {
        target.kind = AutomationTarget::Kind::Volume;
        target.list = &volumeAutomation;
        return target;
    }
    if (parameterId == "pan")
    {
        target.kind = AutomationTarget::Kind::Pan;
        target.list = &panAutomation;
        return target;
    }
    if (parameterId == "width")
    {
        target.kind = AutomationTarget::Kind::Width;
        target.list = &widthAutomation;
        return target;
    }
    if (parameterId == "volume_prefx")
    {
        target.kind = AutomationTarget::Kind::PreFXVolume;
        target.list = &preFXVolumeAutomation;
        return target;
    }
    if (parameterId == "pan_prefx")
    {
        target.kind = AutomationTarget::Kind::PreFXPan;
        target.list = &preFXPanAutomation;
        return target;
    }
    if (parameterId == "width_prefx")
    {
        target.kind = AutomationTarget::Kind::PreFXWidth;
        target.list = &preFXWidthAutomation;
        return target;
    }
    if (parameterId == "trim_volume")
    {
        target.kind = AutomationTarget::Kind::TrimVolume;
        target.list = &trimVolumeAutomation;
        return target;
    }
    if (parameterId == "mute")
    {
        target.kind = AutomationTarget::Kind::Mute;
        target.list = &muteAutomation;
        return target;
    }
    if (parameterId == "midi_velocity_scale")
    {
        target.kind = AutomationTarget::Kind::MIDIVelocityScale;
        target.list = &midiVelocityScaleAutomation;
        return target;
    }
    if (parameterId == "midi_pitch_bend")
    {
        target.kind = AutomationTarget::Kind::MIDIPitchBend;
        target.list = &midiPitchBendAutomation;
        return target;
    }
    if (parameterId == "midi_channel_pressure")
    {
        target.kind = AutomationTarget::Kind::MIDIChannelPressure;
        target.list = &midiChannelPressureAutomation;
        return target;
    }

    auto midiCCRoute = createIfNeeded ? getOrCreateMIDICCAutomationRoute(parameterId) : findMIDICCAutomationRoute(parameterId);
    if (midiCCRoute)
    {
        target.kind = AutomationTarget::Kind::MIDICC;
        target.list = midiCCRoute->automation.get();
        target.midiCC = midiCCRoute->controller;
        return target;
    }

    auto route = createIfNeeded ? getOrCreatePluginAutomationRoute(parameterId) : findPluginAutomationRoute(parameterId);
    if (!route)
        return std::nullopt;

    target.kind = AutomationTarget::Kind::PluginParameter;
    target.list = route->automation.get();
    target.isInputFX = route->isInputFX;
    target.fxIndex = route->fxIndex;
    target.paramIndex = route->paramIndex;
    target.builtInParamId = route->builtInParamId;
    return target;
}

float TrackProcessor::getAutomationDefaultValue(const AutomationTarget& target) const
{
    switch (target.kind)
    {
        case AutomationTarget::Kind::Volume:
            return getVolume();
        case AutomationTarget::Kind::Pan:
            return getPan();
        case AutomationTarget::Kind::Width:
            return widthPercentToBackend(getStereoWidth());
        case AutomationTarget::Kind::PreFXVolume:
        case AutomationTarget::Kind::PreFXPan:
        case AutomationTarget::Kind::PreFXWidth:
        case AutomationTarget::Kind::TrimVolume:
            return 0.0f;
        case AutomationTarget::Kind::Mute:
            return getMute() ? 1.0f : 0.0f;
        case AutomationTarget::Kind::MIDIVelocityScale:
            return 1.0f;
        case AutomationTarget::Kind::MIDIPitchBend:
        case AutomationTarget::Kind::MIDIChannelPressure:
        case AutomationTarget::Kind::MIDICC:
            return 0.0f;
        case AutomationTarget::Kind::PluginParameter:
        {
            const juce::AudioProcessor* processor = nullptr;
            if (target.isInputFX)
            {
                if (target.fxIndex >= 0 && target.fxIndex < getNumInputFX())
                    processor = getInputFXProcessor(target.fxIndex);
            }
            else
            {
                if (target.fxIndex >= 0 && target.fxIndex < getNumTrackFX())
                    processor = getTrackFXProcessor(target.fxIndex);
            }

            if (processor == nullptr)
                return 0.0f;

            if (target.builtInParamId.isNotEmpty())
            {
                OpenStudioBuiltInAutomationDescriptor descriptor;
                if (! getOpenStudioBuiltInAutomationDescriptor(
                        const_cast<juce::AudioProcessor*>(processor),
                        target.builtInParamId,
                        descriptor))
                {
                    return 0.0f;
                }
                return openStudioBuiltInValueToNormalized(
                    descriptor, descriptor.currentValue);
            }

            const auto& params = processor->getParameters();
            if (target.paramIndex < 0 || target.paramIndex >= params.size() || params[target.paramIndex] == nullptr)
                return 0.0f;

            return params[target.paramIndex]->getValue();
        }
        default:
            return 0.0f;
    }
}

bool TrackProcessor::hasPluginAutomation() const
{
    if (!hasPublishedPluginAutomationRoutes.load(std::memory_order_acquire))
        return false;

    const ScopedTrackRealtimeReader readGuard(
        realtimeAuxAudioReaders);
    const auto* const snapshot =
        pluginAutomationSnapshotForAudio.load(
            std::memory_order_seq_cst);
    if (snapshot == nullptr)
        return false;

    for (const auto& route : *snapshot)
        if (route && route->automation && route->automation->getNumPoints() > 0
            && route->automation->shouldPlaybackForRead())
            return true;

    return false;
}

bool TrackProcessor::hasMIDIAutomation() const
{
    if (midiVelocityScaleAutomation.shouldPlaybackForRead() && midiVelocityScaleAutomation.getNumPoints() > 0)
        return true;
    if (midiPitchBendAutomation.shouldPlaybackForRead() && midiPitchBendAutomation.getNumPoints() > 0)
        return true;
    if (midiChannelPressureAutomation.shouldPlaybackForRead() && midiChannelPressureAutomation.getNumPoints() > 0)
        return true;

    if (!hasPublishedMIDICCAutomationRoutes.load(std::memory_order_acquire))
        return false;

    const ScopedTrackRealtimeReader readGuard(
        realtimeAuxAudioReaders);
    const auto* const snapshot =
        midiCCAutomationSnapshotForAudio.load(
            std::memory_order_seq_cst);
    if (snapshot == nullptr)
        return false;

    for (const auto& route : *snapshot)
        if (route && route->automation && route->automation->getNumPoints() > 0
            && route->automation->shouldPlaybackForRead())
            return true;

    return false;
}

bool TrackProcessor::shouldApplyAutomation(const AutomationList& automation) const
{
    return forceAutomationReadDuringProcessing.load(std::memory_order_relaxed)
        ? automation.shouldPlaybackForRead()
        : automation.shouldPlayback();
}

void TrackProcessor::resetAutomationTouchState()
{
    volumeAutomation.resetTouchAndLatch();
    panAutomation.resetTouchAndLatch();
    widthAutomation.resetTouchAndLatch();
    preFXVolumeAutomation.resetTouchAndLatch();
    preFXPanAutomation.resetTouchAndLatch();
    preFXWidthAutomation.resetTouchAndLatch();
    trimVolumeAutomation.resetTouchAndLatch();
    muteAutomation.resetTouchAndLatch();
    midiVelocityScaleAutomation.resetTouchAndLatch();
    midiPitchBendAutomation.resetTouchAndLatch();
    midiChannelPressureAutomation.resetTouchAndLatch();

    if (hasPublishedPluginAutomationRoutes.load(std::memory_order_acquire))
    {
        auto pluginSnapshot = std::atomic_load_explicit(
            &pluginAutomationSnapshot, std::memory_order_acquire);
        if (pluginSnapshot)
            for (const auto& route : *pluginSnapshot)
                if (route && route->automation)
                    route->automation->resetTouchAndLatch();
    }

    if (hasPublishedMIDICCAutomationRoutes.load(std::memory_order_acquire))
    {
        auto midiSnapshot = std::atomic_load_explicit(
            &midiCCAutomationSnapshot, std::memory_order_acquire);
        if (midiSnapshot)
            for (const auto& route : *midiSnapshot)
                if (route && route->automation)
                    route->automation->resetTouchAndLatch();
    }
}

void TrackProcessor::reclaimRetiredRealtimeGraphSnapshots()
{
    std::vector<std::shared_ptr<const RealtimeGraphSnapshot>>
        reclaim;
    {
        const juce::ScopedLock retirementGuard(
            realtimeGraphRetirementLock);
        if (realtimeGraphAudioReaders.load(
                std::memory_order_seq_cst) == 0)
        {
            reclaim.swap(
                retiredRealtimeGraphSnapshots);
        }
    }
}

void TrackProcessor::reclaimRetiredRealtimeAuxOwners()
{
    std::vector<std::shared_ptr<const void>> reclaim;
    {
        const juce::ScopedLock retirementGuard(
            realtimeAuxRetirementLock);
        if (realtimeAuxAudioReaders.load(
                std::memory_order_seq_cst) == 0)
        {
            reclaim.swap(
                retiredRealtimeAuxOwners);
        }
    }
}

void TrackProcessor::reclaimRetiredScheduledMIDISnapshots()
{
    std::vector<std::shared_ptr<const std::vector<ScheduledMIDIClip>>>
        reclaim;
    {
        const juce::ScopedLock retirementGuard(
            scheduledMIDIRetirementLock);
        if (scheduledMIDIAudioReaders.load(
                std::memory_order_seq_cst) == 0)
        {
            reclaim.swap(
                retiredScheduledMIDISnapshots);
        }
    }
}

void TrackProcessor::publishScheduledMIDIClips(
    std::shared_ptr<const std::vector<ScheduledMIDIClip>> snapshot)
{
    const juce::ScopedLock publicationGuard(
        scheduledMIDIPublicationLock);
    reclaimRetiredScheduledMIDISnapshots();
    const auto previous = std::atomic_load_explicit(
        &scheduledMIDIClips, std::memory_order_acquire);
    {
        const juce::ScopedLock retirementGuard(
            scheduledMIDIRetirementLock);
        if (previous != nullptr
            && previous.get() != snapshot.get())
        {
            retiredScheduledMIDISnapshots.push_back(
                previous);
        }
        std::atomic_store_explicit(
            &scheduledMIDIClips,
            snapshot,
            std::memory_order_release);
        const bool hasScheduledClips =
            snapshot != nullptr
            && ! snapshot->empty();
        scheduledMIDIClipsForAudio.store(
            hasScheduledClips
                ? snapshot.get()
                : nullptr,
            std::memory_order_seq_cst);
        hasScheduledMIDIClipsForAudio.store(
            hasScheduledClips,
            std::memory_order_release);
    }
}

void TrackProcessor::publishRealtimeStateSnapshots()
{
    // Serialise control-side publishers. The callback never acquires this lock.
    const juce::ScopedLock publicationGuard(
        realtimeGraphPublicationLock);
    // Reclaim only owners retired by an earlier publication. The owner replaced
    // below must survive at least one publication boundary so a reader that
    // starts concurrently can still observe it safely.
    reclaimRetiredRealtimeGraphSnapshots();
    const auto previous = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    auto next = std::make_shared<RealtimeGraphSnapshot>();
    next->generation =
        realtimeGraphGeneration.fetch_add(1, std::memory_order_relaxed) + 1;
    next->inputFX.assign(inputFXPlugins.begin(), inputFXPlugins.end());
    next->trackFX.assign(trackFXPlugins.begin(), trackFXPlugins.end());
    next->inputFXBypass = inputFXBypassedState;
    next->trackFXBypass = trackFXBypassedState;
    next->inputFXPrecisionOverrides = inputFXForceFloatOverrides;
    next->trackFXPrecisionOverrides = trackFXForceFloatOverrides;
    next->instrument = instrumentPlugin;
    next->sidechainSources = sidechainSources;
    next->sends = sends;

    const int preparedBlockSize = juce::jmax(
        1,
        fxBypassDryBuffer.getNumSamples() > 0
            ? fxBypassDryBuffer.getNumSamples()
            : kMinimumHostedPluginBlockSize);
    const auto prepareDelayStorage =
        [preparedBlockSize] (
            const ProcessorPtr& processor,
            const FXBypassDelayStoragePtr& reusable)
            -> FXBypassDelayStoragePtr
    {
        if (processor == nullptr)
            return {};

        const int reportedLatency =
            juce::jmax(0, processor->getLatencySamples());
        const int requiredCapacity =
            juce::jmax(
                kHostBypassLatencyHeadroomSamples,
                reportedLatency)
            + preparedBlockSize + 1;
        if (reusable != nullptr
            && reusable->processor == processor.get()
            && reusable->ring.getNumChannels()
                    >= hostBypassDryChannels
            && reusable->ring.getNumSamples()
                    >= requiredCapacity)
        {
            reusable->publishedLatency.store(
                reportedLatency,
                std::memory_order_release);
            return reusable;
        }

        auto storage =
            std::make_shared<FXBypassDelayStorage>();
        storage->processor = processor.get();
        storage->publishedLatency.store(
            reportedLatency,
            std::memory_order_relaxed);
        storage->ring.setSize(
            hostBypassDryChannels,
            requiredCapacity,
            false,
            true,
            false);
        storage->ring.clear();
        return storage;
    };

    for (size_t index = 0;
         index < maxRealtimeFXContinuitySlots;
         ++index)
    {
        const auto previousInput =
            previous != nullptr
                ? previous->inputFXBypassDelay[index]
                : FXBypassDelayStoragePtr {};
        const auto previousTrack =
            previous != nullptr
                ? previous->trackFXBypassDelay[index]
                : FXBypassDelayStoragePtr {};
        if (index < next->inputFX.size())
        {
            next->inputFXBypassDelay[index] =
                prepareDelayStorage(
                    next->inputFX[index],
                    previousInput);
        }
        if (index < next->trackFX.size())
        {
            next->trackFXBypassDelay[index] =
                prepareDelayStorage(
                    next->trackFX[index],
                    previousTrack);
        }
    }

    const auto published =
        std::static_pointer_cast<const RealtimeGraphSnapshot>(
            next);
    {
        const juce::ScopedLock retirementGuard(
            realtimeGraphRetirementLock);
        if (previous != nullptr
            && previous.get() != published.get())
        {
            retiredRealtimeGraphSnapshots.push_back(
                previous);
        }
        std::atomic_store_explicit(
            &realtimeGraphSnapshot,
            published,
            std::memory_order_release);
        realtimeGraphSnapshotForAudio.store(
            published.get(),
            std::memory_order_seq_cst);
    }
}

void TrackProcessor::resetFXContinuityStates() noexcept
{
    inputFXContinuity.fill({});
    trackFXContinuity.fill({});
    instrumentContinuity = {};
}

void TrackProcessor::refreshHostBypassDelayStorage()
{
    const auto snapshot =
        std::atomic_load_explicit(
            &realtimeGraphSnapshot,
            std::memory_order_acquire);
    if (snapshot == nullptr)
        return;

    const int preparedBlockSize =
        juce::jmax(
            1,
            fxBypassDryBuffer.getNumSamples()
                    > 0
                ? fxBypassDryBuffer
                      .getNumSamples()
                : kMinimumHostedPluginBlockSize);
    const auto publishLatencyInPlace =
        [preparedBlockSize] (
            const ProcessorSnapshot& processors,
            const auto& storageArray)
    {
        if (processors.size()
            > storageArray.size())
            return false;

        for (size_t index = 0;
             index < processors.size();
             ++index)
        {
            const auto& processor =
                processors[index];
            const auto& storage =
                storageArray[index];
            if (processor == nullptr)
                continue;

            const int reportedLatency =
                juce::jmax(
                    0,
                    processor
                        ->getLatencySamples());
            const int requiredCapacity =
                juce::jmax(
                    kHostBypassLatencyHeadroomSamples,
                    reportedLatency)
                + preparedBlockSize + 1;
            if (storage == nullptr
                || storage->processor
                       != processor.get()
                || storage->ring
                       .getNumChannels()
                       < hostBypassDryChannels
                || storage->ring
                       .getNumSamples()
                       < requiredCapacity)
            {
                return false;
            }

            storage->publishedLatency.store(
                reportedLatency,
                std::memory_order_release);
        }
        return true;
    };

    // NAM sample-rate conversion changes the reported latency by only a few
    // dozen samples, well inside the existing 4096-sample headroom. Updating
    // these atomics avoids allocating and publishing a replacement graph
    // snapshot, whose final shared_ptr release could otherwise occur on a
    // 16-sample callback.
    if (publishLatencyInPlace(
            snapshot->inputFX,
            snapshot->inputFXBypassDelay)
        && publishLatencyInPlace(
            snapshot->trackFX,
            snapshot->trackFXBypassDelay))
    {
        return;
    }

    // Only genuinely larger plugin latency requires new delay storage.
    const juce::ScopedLock processorCallbackGuard(
        getCallbackLock());
    publishRealtimeStateSnapshots();
}

void TrackProcessor::applyPluginAutomationForProcessor(juce::AudioProcessor* proc,
                                                       bool isInputFX,
                                                       int fxIndex,
                                                       double blockTimeSeconds,
                                                       const PluginAutomationRouteSnapshot* routes)
{
    if (proc == nullptr
        || routes == nullptr
        || routes->empty())
        return;

    auto& params = proc->getParameters();

    for (const auto& route : *routes)
    {
        const bool processorMatches = route != nullptr
            && (route->targetProcessor != nullptr
                    ? route->targetProcessor == proc
                    : (route->isInputFX == isInputFX
                       && route->fxIndex == fxIndex));
        if (!route
            || ! processorMatches
            || route->automation == nullptr)
        {
            continue;
        }

        // Legacy projects may still contain automation lanes for retired NAM
        // controls. Ignore them permanently so old sessions cannot reactivate
        // or repeatedly publish unsupported topology/state choices.
        if (dynamic_cast<S13NAMRack*>(proc) != nullptr
            && (route->builtInParamId == "transposeSemitones"
                || route->builtInParamId == "inputMode"))
        {
            continue;
        }

        const float automatedValue = shouldApplyAutomation(*route->automation)
            ? route->automation->eval(blockTimeSeconds)
            : route->automation->getDefaultValue();
        if (! std::isfinite(automatedValue))
            continue;

        const float clampedValue = juce::jlimit(0.0f, 1.0f, automatedValue);
        const float lastValue = route->lastAppliedValue.load(std::memory_order_relaxed);
        if (std::isfinite(lastValue) && std::abs(lastValue - clampedValue) <= 1.0e-6f)
            continue;

        if (route->builtInParamId.isNotEmpty())
        {
            OpenStudioBuiltInAutomationDescriptor descriptor;
            descriptor.minimum = route->builtInMinimum;
            descriptor.maximum = route->builtInMaximum;
            descriptor.discrete = route->builtInDiscrete;
            descriptor.curve = route->builtInCurve;
            auto rawValue = openStudioBuiltInNormalizedToValue(
                descriptor, clampedValue);
            if (route->builtInDiscrete)
                rawValue = std::round(rawValue);
            if (! setOpenStudioBuiltInParameterValue(proc, route->builtInParamId, rawValue))
                continue;
        }
        else
        {
            if (route->paramIndex < 0 || route->paramIndex >= params.size())
                continue;
            auto* param = params[route->paramIndex];
            if (param == nullptr)
                continue;
            param->setValue(clampedValue);
        }
        route->lastAppliedValue.store(clampedValue, std::memory_order_relaxed);
    }
}

const juce::String TrackProcessor::getName() const
{
    return "Track Processor";
}

bool TrackProcessor::acceptsMidi() const
{
    auto currentTrackType = trackType.load(std::memory_order_acquire);
    return currentTrackType == TrackType::MIDI || currentTrackType == TrackType::Instrument;
}

bool TrackProcessor::producesMidi() const
{
    auto currentTrackType = trackType.load(std::memory_order_acquire);
    return currentTrackType == TrackType::MIDI || currentTrackType == TrackType::Instrument;
}

bool TrackProcessor::isMidiEffect() const
{
    return false;
}

double TrackProcessor::getTailLengthSeconds() const
{
    double serialTailSeconds = 0.0;
    const auto addProcessorTail = [&serialTailSeconds] (const juce::AudioProcessor* processor)
    {
        if (processor == nullptr)
            return;

        const double processorTail = processor->getTailLengthSeconds();
        if (std::isfinite(processorTail) && processorTail > 0.0)
            serialTailSeconds += processorTail;
    };

    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
    {
        const auto& plugin = inputFXPlugins[static_cast<size_t>(index)];
        if (plugin && ! getInputFXBypassed(index))
            addProcessorTail(plugin.get());
    }

    addProcessorTail(instrumentPlugin.get());

    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
    {
        const auto& plugin = trackFXPlugins[static_cast<size_t>(index)];
        if (plugin && ! getTrackFXBypassed(index))
            addProcessorTail(plugin.get());
    }

    return serialTailSeconds;
}

double TrackProcessor::getOfflineRenderTailLengthSeconds() const
{
    double serialTailSeconds = 0.0;
    const auto automationSnapshot = std::atomic_load_explicit(
        &pluginAutomationSnapshot, std::memory_order_acquire);
    const auto getNAMTailAutomationModule = [] (const juce::String& parameterId)
    {
        if (parameterId == "delayEnabled" || parameterId == "delayMix"
            || parameterId == "delayTimeMs" || parameterId == "delayFeedback"
            || parameterId == "delayMod" || parameterId == "delayMode"
            || parameterId == "delayPingPong" || parameterId == "delayTempoSync")
            return static_cast<std::uint32_t>(S13NAMRack::tailAutomationDelay);
        if (parameterId == "reverbEnabled" || parameterId == "reverbMix"
            || parameterId == "reverbDecaySec" || parameterId == "reverbPreDelayMs"
            || parameterId == "reverbTone" || parameterId == "reverbLowCutHz"
            || parameterId == "reverbShimmer" || parameterId == "reverbVoice"
            || parameterId == "reverbPad")
            return static_cast<std::uint32_t>(S13NAMRack::tailAutomationReverb);
        if (parameterId == "modulatorEnabled" || parameterId == "chorusMix"
            || parameterId == "modulatorMode" || parameterId == "modulatorFeedback")
            return static_cast<std::uint32_t>(S13NAMRack::tailAutomationModulator);
        if (parameterId == "cabEnabled"
            || parameterId == "cabRoomEnabled"
            || parameterId == "cabRoomAmount"
            || parameterId == "cabRoomWidth"
            || parameterId == "cabDoublerEnabled"
            || parameterId == "cabDoublerMix"
            || parameterId == "cabDoublerDelayMs"
            || parameterId == "cabDoublerSpread")
            return static_cast<std::uint32_t>(S13NAMRack::tailAutomationCab);
        return static_cast<std::uint32_t>(S13NAMRack::tailAutomationNone);
    };
    const auto getTailAutomationMask = [&] (bool isInputFX, int fxIndex)
    {
        std::uint32_t mask = S13NAMRack::tailAutomationNone;
        if (! automationSnapshot)
            return mask;
        for (const auto& route : *automationSnapshot)
        {
            if (route && route->isInputFX == isInputFX && route->fxIndex == fxIndex
                && route->automation
                && route->automation->shouldPlaybackForRead())
            {
                const auto module =
                    getNAMTailAutomationModule(route->builtInParamId);
                const bool hasRelevantPoints =
                    route->automation->getNumPoints() > 0;
                if (hasRelevantPoints)
                {
                    mask |= module;
                }
            }
        }
        return mask;
    };
    const auto addProcessorTail = [&serialTailSeconds, &getTailAutomationMask]
        (const juce::AudioProcessor* processor, bool isInputFX, int fxIndex)
    {
        if (processor == nullptr)
            return;

        double processorTail = processor->getTailLengthSeconds();
        if (const auto* rack = dynamic_cast<const S13NAMRack*>(processor))
            processorTail = rack->getAutomatedTailLengthSeconds(
                getTailAutomationMask(isInputFX, fxIndex));
        if (std::isfinite(processorTail) && processorTail > 0.0)
            serialTailSeconds += processorTail;
    };

    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
    {
        const auto& plugin = inputFXPlugins[static_cast<size_t>(index)];
        if (plugin && ! getInputFXBypassed(index))
            addProcessorTail(plugin.get(), true, index);
    }
    // Instruments do not use track/input FX automation route identities.
    if (instrumentPlugin)
    {
        const double instrumentTail = instrumentPlugin->getTailLengthSeconds();
        if (std::isfinite(instrumentTail) && instrumentTail > 0.0)
            serialTailSeconds += instrumentTail;
    }
    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
    {
        const auto& plugin = trackFXPlugins[static_cast<size_t>(index)];
        if (plugin && ! getTrackFXBypassed(index))
            addProcessorTail(plugin.get(), false, index);
    }
    return serialTailSeconds;
}

int TrackProcessor::getNumPrograms()
{
    return 1;
}

int TrackProcessor::getCurrentProgram()
{
    return 0;
}

void TrackProcessor::setCurrentProgram (int index)
{
    juce::ignoreUnused (index);
}

const juce::String TrackProcessor::getProgramName (int index)
{
    juce::ignoreUnused (index);
    return {};
}

void TrackProcessor::recomputePanGains()
{
    const float currentVolumeDb = trackVolumeDB.load(std::memory_order_relaxed);
    const float currentPan = trackPan.load(std::memory_order_relaxed);
    const float volumeGain = juce::Decibels::decibelsToGain(currentVolumeDb);
    float lGain = 1.0f;
    float rGain = 1.0f;
    computePanLawGains(
        panLaw.load(std::memory_order_acquire),
        currentPan,
        volumeGain,
        lGain,
        rGain);

    cachedPanL.store(lGain, std::memory_order_relaxed);
    cachedPanR.store(rGain, std::memory_order_relaxed);
}

void TrackProcessor::setVolume(float newVolume)
{
    trackVolumeDB.store(juce::jlimit(-60.0f, 12.0f, newVolume), std::memory_order_relaxed);
    recomputePanGains();
}

void TrackProcessor::setPan(float newPan)
{
    trackPan.store(juce::jlimit(-1.0f, 1.0f, newPan), std::memory_order_relaxed);
    recomputePanGains();
}

void TrackProcessor::setMute(bool shouldMute)
{
    isMuted.store(shouldMute);
}

void TrackProcessor::setSolo(bool shouldSolo)
{
    isSoloed.store(shouldSolo);
}

void TrackProcessor::changeProgramName (int index, const juce::String& newName)
{
    juce::ignoreUnused (index, newName);
}

// Helper: call prepareToPlay on a plugin while preserving its bus layout.
//
// Some plugins (e.g. Amplitube 5) change their bus configuration in response to
// prepareToPlay — for example switching from mono-in/stereo-out (correct for a
// guitar amp) to stereo-in/stereo-out (incorrect: processes L and R independently
// through different cab tuning, producing a "polyphonic/doubled" artefact when
// the same mono signal is duplicated to both channels).
//
// The old code accidentally avoided this because TrackProcessor::prepareToPlay was
// empty, so getSampleRate()/getBlockSize() returned 0/0 and plugins ignored the call.
// Now that we call prepareToPlay with valid values, we must restore the layout.
static void preparePluginPreservingLayout(juce::AudioProcessor* plugin, double sampleRate,
                                          int maxBlock, ProcessingPrecisionMode precisionMode,
                                          int routedInputChannels = 2)
{
    const juce::ScopedLock pluginCallbackGuard(plugin->getCallbackLock());
    const int safeMaxBlock = getSafeHostedPluginBlockSize(maxBlock);

    // NAM graph topology depends on the host route width. Publish it before
    // prepare/reset so a newly inserted mono guitar Rack cannot begin in its
    // default stereo topology and perform an avoidable first-callback handoff.
    if (auto* const rack = dynamic_cast<S13NAMRack*>(plugin))
        rack->setRoutedInputChannelCount(routedInputChannels);

    if (plugin->supportsDoublePrecisionProcessing())
    {
        plugin->setProcessingPrecision(
            precisionMode == ProcessingPrecisionMode::Hybrid64
                ? juce::AudioProcessor::doublePrecision
                : juce::AudioProcessor::singlePrecision);
    }

    auto savedLayout = plugin->getBusesLayout();
    plugin->prepareToPlay(sampleRate, safeMaxBlock);

    // If prepareToPlay changed the bus layout, restore and re-prepare so the
    // plugin operates with its original (createPluginInstance) channel config.
    if (plugin->getBusesLayout() != savedLayout)
    {
        if (plugin->setBusesLayout(savedLayout))
        {
            plugin->prepareToPlay(sampleRate, safeMaxBlock);
        }
        else
        {
            juce::Logger::writeToLog("TrackProcessor: Plugin refused saved bus layout during prepare: "
                                     + plugin->getName()
                                     + " requestedBlock=" + juce::String(maxBlock)
                                     + " safeBlock=" + juce::String(safeMaxBlock));
        }
    }
}

static ProcessingPrecisionMode resolvePluginPrecisionMode(ProcessingPrecisionMode engineMode, bool forceFloat)
{
    return forceFloat ? ProcessingPrecisionMode::Float32 : engineMode;
}

void TrackProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    realtimeFXTailSampleRateHz.store(
        juce::roundToInt(juce::jlimit(8000.0, 384000.0,
                                     sampleRate > 0.0 ? sampleRate : 44100.0)),
        std::memory_order_release);
    // Pre-allocate FX processing buffer with enough channels for complex plugins.
    // Use the actual device block size here — the buffer just needs to hold one callback.
    fxProcessBuffer.setSize(kMaxFXChannels, samplesPerBlock);
    fxProcessBufferDouble.setSize(kMaxFXChannels, samplesPerBlock);
    fxBypassDryBuffer.setSize(kMaxFXChannels, samplesPerBlock);
    constexpr double hostBypassRampSeconds = 0.020;
    fxBypassRampStep = 1.0f
        / static_cast<float>(juce::jmax(
            1,
            juce::roundToInt(
                juce::jmax(1.0, sampleRate)
                * hostBypassRampSeconds)));
    constexpr double continuityRampSeconds = 0.008;
    fxContinuityRampSamples = juce::jmax(
        1,
        juce::roundToInt(
            juce::jmax(1.0, sampleRate)
            * continuityRampSeconds));

    // Prepare PDC delay line
    {
        juce::dsp::ProcessSpec spec;
        spec.sampleRate = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
        spec.numChannels = 2;
        pdcDelayLine.prepare(spec);
        pdcCurrentDelaySamples =
            juce::jmax(
                0,
                pdcDelaySamples.load(
                    std::memory_order_relaxed));
        pdcTargetDelaySamples =
            pdcCurrentDelaySamples;
        pdcPendingDelaySamples =
            pdcCurrentDelaySamples;
        pdcTransitionSamplesRemaining = 0;
        pdcTransitionSamplesTotal =
            juce::jmax(
                1,
                juce::roundToInt(
                    juce::jmax(1.0, sampleRate)
                    * 0.020));
        pdcDelayLine.setDelay(
            static_cast<float>(
                pdcCurrentDelaySamples));
    }

    // Prepare plugins with the actual device block size so realtime hosting
    // matches the hardware callback configuration.
    int pluginMaxBlock = getSafeHostedPluginBlockSize(samplesPerBlock);

    // Propagate new sample rate and buffer size to all internal FX plugins,
    // preserving each plugin's bus layout (see preparePluginPreservingLayout).
    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
    {
        auto& plugin = inputFXPlugins[static_cast<size_t>(index)];
        if (plugin)
        {
            preparePluginPreservingLayout(plugin.get(), sampleRate, pluginMaxBlock,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getInputFXPrecisionOverride(index)),
                                          inputChannelCount.load(std::memory_order_acquire));
            plugin->reset();
        }
    }

    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
    {
        auto& plugin = trackFXPlugins[static_cast<size_t>(index)];
        if (plugin)
        {
            juce::ignoreUnused (araController, araFXIndex);
            const int pluginBlockSize = pluginMaxBlock;
            preparePluginPreservingLayout(plugin.get(), sampleRate, pluginBlockSize,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getTrackFXPrecisionOverride(index)),
                                          inputChannelCount.load(std::memory_order_acquire));
            plugin->reset();
        }
    }

    // Also re-prepare instrument plugin if loaded
    if (instrumentPlugin)
    {
        preparePluginPreservingLayout(instrumentPlugin.get(), sampleRate, pluginMaxBlock,
                                      resolvePluginPrecisionMode(processingPrecisionMode,
                                                                 instrumentForceFloatOverride.load(std::memory_order_acquire)));
        instrumentPlugin->reset();
    }

    // Prepare channel strip EQ
    channelStripEQ.setPowerEnabled(
        channelStripEQEnabled.load(std::memory_order_acquire));
    channelStripEQ.prepareToPlay(sampleRate, samplesPerBlock);

    // Pre-allocate pre-fader buffer for send routing (2-channel stereo)
    preFaderBuffer.setSize(2, samplesPerBlock);
    automationGainBuffer.setSize(8, samplesPerBlock);
    realtimeFallbackBuffer.setSize(2, samplesPerBlock);
    publishRealtimeStateSnapshots();
    resetFXContinuityStates();
    invalidatePluginAutomationCache();
    refreshRealtimeFXTailBudgetOnControlThread();
    realtimeFXTailActive.store(false, std::memory_order_release);
    realtimeFXTailResetPending.store(false, std::memory_order_release);
    realtimeFXTailHardSamplesRemaining = 0;
    realtimeFXTailMinimumSamplesRemaining = 0;
    realtimeFXTailQuietSamples = 0;
    realtimeFXTailLastPublishedBudgetSamples = 0;
    realtimeFXPreviousBlockHadInput = false;
}

void TrackProcessor::releaseResources()
{
}

void TrackProcessor::refreshRealtimeFXTailBudgetOnControlThread()
{
    double reportedTailSeconds = 0.0;
    try
    {
        reportedTailSeconds = getTailLengthSeconds();
    }
    catch (...)
    {
        // A hosted plugin must not be able to disable bounded tail servicing.
        // The conservative fallback below is long enough for the built-in rack.
        reportedTailSeconds = 30.0;
    }

    if (! std::isfinite(reportedTailSeconds) || reportedTailSeconds < 0.0)
        reportedTailSeconds = 30.0;

    const double safeSampleRate = static_cast<double>(
        realtimeFXTailSampleRateHz.load(std::memory_order_acquire));
    // Keep the service finite without imposing an arbitrary musical limit.
    // The callback countdown is an int, so its representable duration at the
    // current sample rate is the only hard cap.  This covers the NAM Rack's
    // sparse 10-BPM synced repeats (and long standalone built-in delays) while
    // still protecting the realtime path from a malformed hosted tail report.
    const double maximumCountdownSeconds =
        static_cast<double>(std::numeric_limits<int>::max() - 1)
        / juce::jmax(1.0, safeSampleRate);
    const double boundedTailSeconds = juce::jlimit(
        0.0,
        juce::jmax(0.0,
                   maximumCountdownSeconds - kRealtimeFXTailSafetySeconds),
        reportedTailSeconds);
    const double budgetSeconds = juce::jlimit(
        kRealtimeFXTailQuietWindowSeconds,
        maximumCountdownSeconds,
        boundedTailSeconds + kRealtimeFXTailSafetySeconds);
    // A quiet window is not proof that a sparse delay has ended.  Do not allow
    // the quiet detector to finish servicing until the processor's complete
    // declared tail horizon has elapsed.
    const double minimumDrainSeconds = boundedTailSeconds;

    realtimeFXTailBudgetSamples.store(
        juce::jmax(1, juce::roundToInt(budgetSeconds * safeSampleRate)),
        std::memory_order_release);
    realtimeFXTailMinimumDrainSamples.store(
        juce::jmax(0, juce::roundToInt(minimumDrainSeconds * safeSampleRate)),
        std::memory_order_release);
}

void TrackProcessor::resetExpiredRealtimeFXTailOnControlThread()
{
    if (! realtimeFXTailResetPending.load(std::memory_order_acquire))
        return;

    const auto requestedGeneration =
        realtimeFXTailResetGeneration.load(std::memory_order_acquire);
    if (realtimeFXTailActivityGeneration.load(std::memory_order_acquire)
        != requestedGeneration)
    {
        realtimeFXTailResetPending.store(false, std::memory_order_release);
        return;
    }

    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    const auto resetProcessor = [&] (const ProcessorPtr& processor)
    {
        if (processor == nullptr
            || realtimeFXTailActivityGeneration.load(std::memory_order_acquire)
                != requestedGeneration)
        {
            return;
        }

        // Arbitrary hosted reset() implementations stay off the callback. Each
        // FX callback uses ScopedTryLock, so it falls back to latency-aligned
        // dry audio instead of ever waiting for this control-thread reset.
        const juce::ScopedLock processorGuard(processor->getCallbackLock());
        if (realtimeFXTailActivityGeneration.load(std::memory_order_acquire)
            == requestedGeneration)
        {
            processor->reset();
        }
    };

    if (graph != nullptr)
    {
        for (const auto& processor : graph->inputFX)
            resetProcessor(processor);
        resetProcessor(graph->instrument);
        for (const auto& processor : graph->trackFX)
            resetProcessor(processor);
    }

    if (realtimeFXTailActivityGeneration.load(std::memory_order_acquire)
        == requestedGeneration)
    {
        realtimeFXTailActive.store(false, std::memory_order_release);
        realtimeFXTailResetPending.store(false, std::memory_order_release);
    }
}

void TrackProcessor::timerCallback()
{
    if (realtimeFXTailActive.load(std::memory_order_acquire)
        && ! realtimeFXTailResetPending.load(std::memory_order_acquire))
    {
        // Tail controls (especially NAM Rack decay/delay) can change without a
        // graph publication. Query them on the control thread, never in the
        // 8/16-sample callback.
        refreshRealtimeFXTailBudgetOnControlThread();
    }

    resetExpiredRealtimeFXTailOnControlThread();
}

bool TrackProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    juce::ignoreUnused (layouts);
    return true; // Simplified
}

void TrackProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    processBlockInternal(buffer, midiMessages);
}

bool TrackProcessor::tryProcessBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    processBlockInternal(buffer, midiMessages);
    return true;
}

void TrackProcessor::processBlockInternal (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    const int activeARAFXIndexForBlock =
        araFXIndexForRealtime.load(
            std::memory_order_acquire);
    auto* const activeARAControllerForBlock =
        activeARAFXIndexForBlock >= 0
            ? araController.get()
            : nullptr;
    // Only time the track when ARA diagnostics are enabled and an ARA plugin is active.
    // QueryPerformanceCounter is cheap but not free — at 32-sample blocks this fires
    // 1500×/sec, so we avoid it for non-ARA tracks (e.g. Amplitube, S13 FX).
    const bool isARATrack = kEnableARADebugDiagnostics
                         && activeARAControllerForBlock != nullptr;
    const double trackProcessStartMs = isARATrack ? juce::Time::getMillisecondCounterHiRes() : 0.0;
    juce::ScopedNoDenormals noDenormals;
    auto totalNumInputChannels  = getTotalNumInputChannels();
    auto totalNumOutputChannels = getTotalNumOutputChannels();
    const auto currentTrackType = trackType.load(std::memory_order_acquire);
    // Avoid MSVC's process-wide atomic<shared_ptr> spin lock in the audio
    // callback. Control-side publication retains replaced immutable graphs
    // until this reader epoch has drained.
    const ScopedTrackRealtimeReader graphReadGuard(
        realtimeGraphAudioReaders);
    const auto* const graphSnapshot =
        realtimeGraphSnapshotForAudio.load(
            std::memory_order_seq_cst);
    const uint64 graphGeneration =
        graphSnapshot != nullptr ? graphSnapshot->generation : 0;
    const auto* const inputFXSnapshot =
        graphSnapshot != nullptr ? &graphSnapshot->inputFX : nullptr;
    const auto* const trackFXSnapshot =
        graphSnapshot != nullptr ? &graphSnapshot->trackFX : nullptr;
    const auto* const inputFXBypassSnapshot =
        graphSnapshot != nullptr ? &graphSnapshot->inputFXBypass : nullptr;
    const auto* const trackFXBypassSnapshot =
        graphSnapshot != nullptr ? &graphSnapshot->trackFXBypass : nullptr;
    const auto* const inputFXPrecisionOverrideSnapshot =
        graphSnapshot != nullptr
            ? &graphSnapshot->inputFXPrecisionOverrides
            : nullptr;
    const auto* const trackFXPrecisionOverrideSnapshot =
        graphSnapshot != nullptr
            ? &graphSnapshot->trackFXPrecisionOverrides
            : nullptr;
    auto* const instrumentSnapshot =
        graphSnapshot != nullptr ? graphSnapshot->instrument.get() : nullptr;
    const bool hasPluginAutomationRoutesForBlock =
        hasPublishedPluginAutomationRoutes.load(
            std::memory_order_acquire);
    const ScopedTrackRealtimeReader auxReadGuard(
        realtimeAuxAudioReaders,
        hasPluginAutomationRoutesForBlock
            || currentTrackType == TrackType::Instrument);
    const auto* const pluginAutomationRoutesForBlock =
        hasPluginAutomationRoutesForBlock
            ? pluginAutomationSnapshotForAudio.load(
                std::memory_order_seq_cst)
            : nullptr;
    const auto* const sidechainSnapshot =
        graphSnapshot != nullptr ? &graphSnapshot->sidechainSources : nullptr;
    const auto* const sendSnapshot =
        graphSnapshot != nullptr ? &graphSnapshot->sends : nullptr;
    const auto* const inputFXBypassDelaySnapshot =
        graphSnapshot != nullptr
            ? &graphSnapshot->inputFXBypassDelay
            : nullptr;
    const auto* const trackFXBypassDelaySnapshot =
        graphSnapshot != nullptr
            ? &graphSnapshot->trackFXBypassDelay
            : nullptr;
    const bool instrumentForceFloat = instrumentForceFloatOverride.load(std::memory_order_acquire);
    const double blockTimeSeconds = this->blockStartTimeSeconds;
    const auto hasEnabledProcessor = [] (
        const ProcessorSnapshot* processors,
        const BypassSnapshot* bypassState) noexcept
    {
        if (processors == nullptr)
            return false;

        for (int index = 0;
             index < static_cast<int>(processors->size());
             ++index)
        {
            if ((*processors)[static_cast<size_t>(index)] == nullptr)
                continue;
            const auto bypassIt = bypassState != nullptr
                ? bypassState->find(index)
                : BypassSnapshot::const_iterator {};
            if (bypassState == nullptr
                || bypassIt == bypassState->end()
                || ! bypassIt->second)
            {
                return true;
            }
        }
        return false;
    };
    const bool hasEnabledRealtimeFX =
        currentTrackType == TrackType::Audio
        && (hasEnabledProcessor(inputFXSnapshot, inputFXBypassSnapshot)
            || hasEnabledProcessor(trackFXSnapshot, trackFXBypassSnapshot));
    bool hasExternalAudioInput = false;
    if (hasEnabledRealtimeFX)
    {
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        {
            const float inputPeak = buffer.getMagnitude(
                channel, 0, buffer.getNumSamples());
            if (std::isfinite(inputPeak) && inputPeak > 0.0f)
            {
                hasExternalAudioInput = true;
                break;
            }
        }
    }

    if (! hasEnabledRealtimeFX)
    {
        realtimeFXTailActive.store(false, std::memory_order_release);
        realtimeFXTailResetPending.store(false, std::memory_order_release);
        realtimeFXTailHardSamplesRemaining = 0;
        realtimeFXTailMinimumSamplesRemaining = 0;
        realtimeFXTailQuietSamples = 0;
        realtimeFXTailLastPublishedBudgetSamples = 0;
        realtimeFXPreviousBlockHadInput = false;
    }
    else if (hasExternalAudioInput)
    {
        if (! realtimeFXPreviousBlockHadInput)
        {
            realtimeFXTailActivityGeneration.fetch_add(
                1, std::memory_order_acq_rel);
        }
        realtimeFXPreviousBlockHadInput = true;
        realtimeFXTailActive.store(true, std::memory_order_release);
        realtimeFXTailResetPending.store(false, std::memory_order_release);
        const int publishedBudget =
            realtimeFXTailBudgetSamples.load(std::memory_order_acquire);
        realtimeFXTailHardSamplesRemaining = juce::jmax(
            buffer.getNumSamples(),
            publishedBudget);
        realtimeFXTailMinimumSamplesRemaining = juce::jlimit(
            0,
            realtimeFXTailHardSamplesRemaining,
            realtimeFXTailMinimumDrainSamples.load(std::memory_order_acquire));
        realtimeFXTailQuietSamples = 0;
        realtimeFXTailLastPublishedBudgetSamples = publishedBudget;
    }
    else
    {
        realtimeFXPreviousBlockHadInput = false;
    }

    const bool isRealtimeFXTailDrainBlock =
        hasEnabledRealtimeFX
        && ! hasExternalAudioInput
        && realtimeFXTailActive.load(std::memory_order_acquire)
        && ! realtimeFXTailResetPending.load(std::memory_order_acquire);
    const auto finishRealtimeFXTailDrain = [&] (float outputPeak) noexcept
    {
        if (! isRealtimeFXTailDrainBlock)
            return;

        const int blockSamples = juce::jmax(0, buffer.getNumSamples());
        const int publishedBudget =
            realtimeFXTailBudgetSamples.load(std::memory_order_acquire);
        if (publishedBudget > realtimeFXTailLastPublishedBudgetSamples)
        {
            // A built-in processor can publish a longer live/frozen tail after
            // the external input has stopped.  Adopt that increase once; an
            // unchanged fixed plugin report must not refresh the countdown on
            // every timer tick.
            realtimeFXTailHardSamplesRemaining = juce::jmax(
                realtimeFXTailHardSamplesRemaining, publishedBudget);
            realtimeFXTailMinimumSamplesRemaining = juce::jmax(
                realtimeFXTailMinimumSamplesRemaining,
                realtimeFXTailMinimumDrainSamples.load(
                    std::memory_order_acquire));
        }
        realtimeFXTailLastPublishedBudgetSamples = publishedBudget;
        realtimeFXTailHardSamplesRemaining = juce::jmax(
            0, realtimeFXTailHardSamplesRemaining - blockSamples);
        realtimeFXTailMinimumSamplesRemaining = juce::jmax(
            0, realtimeFXTailMinimumSamplesRemaining - blockSamples);

        if (realtimeFXTailMinimumSamplesRemaining <= 0)
        {
            if (std::isfinite(outputPeak)
                && outputPeak < kRealtimeFXTailQuietPeak)
            {
                realtimeFXTailQuietSamples = juce::jmin(
                    std::numeric_limits<int>::max() - blockSamples,
                    realtimeFXTailQuietSamples) + blockSamples;
            }
            else
            {
                realtimeFXTailQuietSamples = 0;
            }
        }

        const int quietWindowSamples = juce::jmax(
            1,
            juce::roundToInt(
                static_cast<double>(realtimeFXTailSampleRateHz.load(
                    std::memory_order_relaxed))
                * kRealtimeFXTailQuietWindowSeconds));
        if (realtimeFXTailHardSamplesRemaining <= 0
            || realtimeFXTailQuietSamples >= quietWindowSamples)
        {
            const auto generation =
                realtimeFXTailActivityGeneration.load(std::memory_order_acquire);
            realtimeFXTailResetGeneration.store(
                generation, std::memory_order_release);
            realtimeFXTailResetPending.store(true, std::memory_order_release);
        }
    };
    bool hasTrackBuiltInInstrument = false;
    // Audio tracks cannot host OpenStudio's built-in instrument fallback.
    // Avoid calling getName() on every FX here: JUCE returns String by value,
    // which can allocate on the realtime thread even for a literal name.
    if (currentTrackType == TrackType::Instrument && trackFXSnapshot)
    {
        for (const auto& plugin : *trackFXSnapshot)
        {
            if (isBuiltInInstrumentProcessor(plugin.get()))
            {
                hasTrackBuiltInInstrument = true;
                break;
            }
        }
    }

    if (activeARAControllerForBlock != nullptr)
        activeARAControllerForBlock->updateTransportDebugState(
            araTransportPlayingDebugState.load(
                std::memory_order_acquire),
            blockTimeSeconds);

    // Safety: only clear channels that actually exist in the buffer
    int bufferChannels = buffer.getNumChannels();
    for (auto i = totalNumInputChannels; i < juce::jmin(totalNumOutputChannels, bufferChannels); ++i)
        buffer.clear (i, 0, buffer.getNumSamples());

    const bool muteAutomationCanUnmute = shouldApplyAutomation(muteAutomation) && muteAutomation.getNumPoints() > 0;
    // Static mute may only short-circuit if no mute automation can unmute this block.
    if (isMuted.load()
        && !ignoreStaticMuteDuringProcessing.load(std::memory_order_relaxed)
        && !muteAutomationCanUnmute)
    {
        buffer.clear();
        currentRMS = 0.0f;
        finishRealtimeFXTailDrain(0.0f);
        return;
    }

    // Apply Plugin Delay Compensation (PDC) before FX chains. A model-rate
    // change can alter another track's compensation by tens of samples. A
    // hard DelayLine::setDelay() repeats or drops that history at one sample
    // and sounds like a click, so crossfade the two already-warm integer taps.
    if (pdcDelayDirty.exchange(false, std::memory_order_acq_rel))
    {
        pdcPendingDelaySamples =
            juce::jlimit(
                0,
                pdcDelayLine
                    .getMaximumDelayInSamples(),
                pdcDelaySamples.load(
                    std::memory_order_relaxed));
    }

    // Process even at zero delay so the ring buffer always contains current
    // audio. A later 0 -> positive PDC change then cannot replay stale samples.
    const auto beginPendingPDCTransition =
        [this] () noexcept
    {
        if (pdcTransitionSamplesRemaining <= 0
            && pdcPendingDelaySamples
                   != pdcCurrentDelaySamples)
        {
            pdcTargetDelaySamples =
                pdcPendingDelaySamples;
            pdcTransitionSamplesRemaining =
                pdcTransitionSamplesTotal;
        }
    };
    beginPendingPDCTransition();
    for (int sample = 0;
         sample < buffer.getNumSamples();
         ++sample)
    {
        float transitionMix = 0.0f;
        const bool transitioning =
            pdcTransitionSamplesRemaining > 0;
        if (transitioning)
        {
            const float linearProgress =
                1.0f
                - static_cast<float>(
                      pdcTransitionSamplesRemaining
                      - 1)
                    / static_cast<float>(
                          pdcTransitionSamplesTotal);
            transitionMix =
                linearProgress
                * linearProgress
                * (3.0f
                   - 2.0f
                       * linearProgress);
        }

        for (int channel = 0;
             channel < bufferChannels;
             ++channel)
        {
            const float input =
                buffer.getSample(
                    channel, sample);
            pdcDelayLine.pushSample(
                channel, input);
            if (transitioning)
            {
                const float previousTap =
                    pdcDelayLine.popSample(
                        channel,
                        static_cast<float>(
                            pdcCurrentDelaySamples),
                        false);
                const float nextTap =
                    pdcDelayLine.popSample(
                        channel,
                        static_cast<float>(
                            pdcTargetDelaySamples),
                        true);
                buffer.setSample(
                    channel,
                    sample,
                    previousTap
                        + (nextTap - previousTap)
                            * transitionMix);
            }
            else
            {
                buffer.setSample(
                    channel,
                    sample,
                    pdcDelayLine.popSample(
                        channel));
            }
        }

        if (transitioning)
        {
            --pdcTransitionSamplesRemaining;
            if (pdcTransitionSamplesRemaining
                <= 0)
            {
                pdcCurrentDelaySamples =
                    pdcTargetDelaySamples;
                pdcDelayLine.setDelay(
                    static_cast<float>(
                        pdcCurrentDelaySamples));
                beginPendingPDCTransition();
            }
        }
    }

    bool hasAnyFX = (inputFXSnapshot && !inputFXSnapshot->empty())
                 || (trackFXSnapshot && !trackFXSnapshot->empty());

    // One-time diagnostic log on first processBlock call with FX loaded
    // (helps diagnose crashes — last log entry before crash shows where it stopped)
    static bool enableRealtimeFirstFXLog = false;
    static bool loggedFirstFXProcess = false;
    if (enableRealtimeFirstFXLog && hasAnyFX && !loggedFirstFXProcess)
    {
        loggedFirstFXProcess = true;
        logToDisk("TrackProcessor::processBlock FIRST CALL WITH FX");
        logToDisk("  buffer channels: " + juce::String(bufferChannels) +
                  " samples: " + juce::String(buffer.getNumSamples()));
        logToDisk("  totalNumInputChannels: " + juce::String(totalNumInputChannels) +
                  " totalNumOutputChannels: " + juce::String(totalNumOutputChannels));
        logToDisk("  inputFX count: " + juce::String(inputFXSnapshot ? (int)inputFXSnapshot->size() : 0) +
                  " trackFX count: " + juce::String(trackFXSnapshot ? (int)trackFXSnapshot->size() : 0));
        logToDisk("  fxProcessBuffer channels: " + juce::String(fxProcessBuffer.getNumChannels()) +
                  " samples: " + juce::String(fxProcessBuffer.getNumSamples()));
        logToDisk("  sampleRate: " + juce::String(getSampleRate()) +
                  " blockSize: " + juce::String(getBlockSize()));

        for (int i = 0; inputFXSnapshot && i < (int)inputFXSnapshot->size(); ++i)
        {
            auto* proc = (*inputFXSnapshot)[i].get();
            if (proc)
            {
                logToDisk("  inputFX[" + juce::String(i) + "]: " + proc->getName() +
                          " inCh=" + juce::String(proc->getTotalNumInputChannels()) +
                          " outCh=" + juce::String(proc->getTotalNumOutputChannels()) +
                          " sr=" + juce::String(proc->getSampleRate()) +
                          " bs=" + juce::String(proc->getBlockSize()));
            }
        }

        for (int i = 0; trackFXSnapshot && i < (int)trackFXSnapshot->size(); ++i)
        {
            auto* proc = (*trackFXSnapshot)[i].get();
            if (proc)
            {
                logToDisk("  trackFX[" + juce::String(i) + "]: " + proc->getName() +
                          " inCh=" + juce::String(proc->getTotalNumInputChannels()) +
                          " outCh=" + juce::String(proc->getTotalNumOutputChannels()) +
                          " sr=" + juce::String(proc->getSampleRate()) +
                          " bs=" + juce::String(proc->getBlockSize()));
            }
        }

        // Log safeProcessFX path decision for first plugin
        if (trackFXSnapshot && !trackFXSnapshot->empty() && (*trackFXSnapshot)[0])
        {
            auto* proc = (*trackFXSnapshot)[0].get();
            int pluginChannels = juce::jmax(proc->getTotalNumInputChannels(),
                                             proc->getTotalNumOutputChannels());
            logToDisk("  safeProcessFX: pluginChannels=" + juce::String(pluginChannels) +
                      " bufferChannels=" + juce::String(bufferChannels) +
                      " path=" + juce::String(pluginChannels == bufferChannels ? "DIRECT" : "EXPANDED"));
        }
    }

    const auto resolveFXContinuity =
        [&] (juce::AudioProcessor* proc,
             bool isInputFXChain,
             int fxIndex,
             bool bypassed) -> FXContinuityState*
    {
        FXContinuityState* continuity = nullptr;
        if (fxIndex < 0)
        {
            continuity = &instrumentContinuity;
        }
        else if (static_cast<size_t>(fxIndex) < maxRealtimeFXContinuitySlots)
        {
            continuity = isInputFXChain
                ? &inputFXContinuity[static_cast<size_t>(fxIndex)]
                : &trackFXContinuity[static_cast<size_t>(fxIndex)];
        }

        if (continuity == nullptr)
            return nullptr;

        if (continuity->processor != proc)
        {
            *continuity = {};
            continuity->processor = proc;
            continuity->hostBypassWetMix =
                bypassed ? 0.0f : 1.0f;
            continuity->targetBypassed = bypassed;
        }
        else if (continuity->targetBypassed != bypassed)
        {
            // Re-enabling follows a message-thread reset of the frozen
            // processor. Bridge the first fresh block from the last audible
            // endpoint even when the user reverses direction mid-fade.
            if (! bypassed)
                continuity->skippedLastBlock = true;
            continuity->targetBypassed = bypassed;
        }
        continuity->graphGeneration = graphGeneration;
        return continuity;
    };

    const auto scheduleEndpointCorrection =
        [&] (FXContinuityState* continuity)
    {
        if (continuity == nullptr
            || !continuity->valid
            || buffer.getNumSamples() <= 0)
        {
            return;
        }

        const int channels = juce::jmin(2, buffer.getNumChannels());
        for (int channel = 0; channel < channels; ++channel)
        {
            const float correction =
                continuity->lastOutput[static_cast<size_t>(channel)]
                - buffer.getSample(channel, 0);
            continuity->endpointCorrection[
                static_cast<size_t>(channel)] = correction;
            continuity->endpointCorrectionStep[
                static_cast<size_t>(channel)] =
                    correction
                    / static_cast<float>(
                        fxContinuityRampSamples);
        }
        continuity->endpointCorrectionSamplesRemaining =
            fxContinuityRampSamples;
    };

    const auto applyEndpointCorrection =
        [&] (FXContinuityState* continuity)
    {
        if (continuity == nullptr
            || continuity
                    ->endpointCorrectionSamplesRemaining <= 0)
            return;

        const int channels = juce::jmin(
            2, buffer.getNumChannels());
        const int samples = buffer.getNumSamples();
        for (int sample = 0;
             sample < samples
                && continuity
                        ->endpointCorrectionSamplesRemaining > 0;
             ++sample)
        {
            for (int channel = 0;
                 channel < channels;
                 ++channel)
            {
                const auto index =
                    static_cast<size_t>(channel);
                buffer.addSample(
                    channel,
                    sample,
                    continuity->endpointCorrection[index]);
                continuity->endpointCorrection[index] -=
                    continuity->endpointCorrectionStep[index];
            }
            --continuity
                ->endpointCorrectionSamplesRemaining;
        }

        if (continuity
                ->endpointCorrectionSamplesRemaining <= 0)
        {
            continuity->endpointCorrection = {
                0.0f, 0.0f
            };
            continuity->endpointCorrectionStep = {
                0.0f, 0.0f
            };
        }
    };

    const auto rememberOutputEndpoint =
        [&] (FXContinuityState* continuity)
    {
        if (continuity == nullptr || buffer.getNumSamples() <= 0)
            return;

        const int lastSample = buffer.getNumSamples() - 1;
        const int channels = juce::jmin(2, buffer.getNumChannels());
        for (int channel = 0; channel < channels; ++channel)
        {
            continuity->lastOutput[static_cast<size_t>(channel)] =
                buffer.getSample(channel, lastSample);
        }
        continuity->valid = channels > 0;
    };

    // Channel-safe raw FX processing helper. Host-bypass mixing and endpoint
    // bookkeeping are deliberately outside this function so the sidechain and
    // ordinary paths share exactly the same transition behaviour.
    auto safeProcessFX =
        [&] (juce::AudioProcessor* proc,
             bool forceFloat,
             bool isInputFXChain,
             int fxIndex) -> bool
    {
        juce::ScopedTryLock pluginProcessLock(proc->getCallbackLock());
        if (!pluginProcessLock.isLocked())
        {
            pluginBusySkipCount.fetch_add(1, std::memory_order_relaxed);
            return false;
        }

        if (auto* const rack =
                dynamic_cast<S13NAMRack*>(proc))
        {
            rack->setRoutedInputChannelCount(
                inputChannelCount.load(
                    std::memory_order_acquire));
        }

        applyPluginAutomationForProcessor(
            proc,
            isInputFXChain,
            fxIndex,
            blockTimeSeconds,
            pluginAutomationRoutesForBlock);

        // Compute isARAProcessor first so we can gate expensive QPC calls on it.
        // For non-ARA plugins (Amplitube, S13 FX, etc.) all timing overhead is skipped.
        int pluginChannels = juce::jmax(proc->getTotalNumInputChannels(),
                                         proc->getTotalNumOutputChannels());
        const bool isARAProcessor =
            activeARAControllerForBlock != nullptr
            && trackFXSnapshot
            && activeARAFXIndexForBlock
                < static_cast<int>(
                    trackFXSnapshot->size())
            && (*trackFXSnapshot)[
                   static_cast<size_t>(
                       activeARAFXIndexForBlock)]
                   .get() == proc;
        const double envelopeStartMs = isARAProcessor ? juce::Time::getMillisecondCounterHiRes() : 0.0;
        const bool useDoublePrecision =
            processingPrecisionMode == ProcessingPrecisionMode::Hybrid64
            && !forceFloat
            && proc->supportsDoublePrecisionProcessing();
        const int numSamps = buffer.getNumSamples();
        const int expandedCh = useDoublePrecision
            ? juce::jmin(pluginChannels, fxProcessBufferDouble.getNumChannels())
            : juce::jmin(pluginChannels, fxProcessBuffer.getNumChannels());
        double preProcessMs = 0.0;
        double processDurationMs = 0.0;
        auto logARAProcessDuration = [&](double postProcessMs)
        {
            if (!isARAProcessor)
                return;

            const double totalDurationMs = juce::Time::getMillisecondCounterHiRes() - envelopeStartMs;
            if (kEnableARADebugDiagnostics && (processDurationMs > 10.0 || totalDurationMs > 10.0))
            {
                const auto playbackRun = araPlaybackRunCounter.load(std::memory_order_acquire);
                const auto lastSlowRun = araLastSlowLogPlaybackRun.load(std::memory_order_acquire);
                if (lastSlowRun != playbackRun)
                {
                    araLastSlowLogPlaybackRun.store(playbackRun, std::memory_order_release);
                    const auto snapshot =
                        activeARAControllerForBlock
                            ->getDebugSnapshot();
                    logToDisk("ARA session slow-block: trackId=" + araDebugTrackId
                        + " fxIndex=" + juce::String(
                            activeARAFXIndexForBlock)
                        + " plugin=" + proc->getName()
                        + " callback=" + juce::String(static_cast<juce::int64>(currentARAProcessDebugInfo.callbackCounter))
                        + " firstCallbackAfterTransportStart=" + juce::String(currentARAProcessDebugInfo.firstCallbackAfterTransportStart ? "true" : "false")
                        + " trackBufferChannels=" + juce::String(bufferChannels)
                        + " pluginIn=" + juce::String(proc->getTotalNumInputChannels())
                        + " pluginOut=" + juce::String(proc->getTotalNumOutputChannels())
                        + " pluginSr=" + juce::String(proc->getSampleRate())
                        + " pluginBs=" + juce::String(proc->getBlockSize())
                        + " trackSr=" + juce::String(getSampleRate())
                        + " trackBs=" + juce::String(getBlockSize())
                        + " transportPos=" + juce::String(snapshot.transportPositionSeconds, 3)
                        + " editorAnalysis=" + juce::String(snapshot.analysisProgress, 3)
                        + " analysisRequested=" + juce::String(snapshot.analysisRequested ? "true" : "false")
                        + " analysisStarted=" + juce::String(snapshot.analysisStarted ? "true" : "false")
                        + " analysisComplete=" + juce::String(snapshot.analysisComplete ? "true" : "false")
                        + " editorFocusedAtPlayStart=" + juce::String(araEditorFocusedAtPlaybackStart.load(std::memory_order_acquire) ? "true" : "false")
                        + " playbackRegionCount=" + juce::String(snapshot.playbackRegionCount)
                        + " playbackRendererAttached=" + juce::String(snapshot.playbackRendererAttached ? "true" : "false")
                        + " editorRendererAttached=" + juce::String(snapshot.editorRendererAttached ? "true" : "false")
                        + " audioSourceSamplesAccessEnabled=" + juce::String(snapshot.audioSourceSamplesAccessEnabled ? "true" : "false")
                        + " sourceCount=" + juce::String(snapshot.sourceCount)
                        + " lastOperation=" + snapshot.lastOperation
                        + " lastEditType=" + snapshot.lastEditType
                        + " lastClipId=" + snapshot.lastClipId
                        + " pendingEditSinceLastPlay=" + juce::String(snapshot.hasPendingEditSinceLastPlay ? "true" : "false")
                        + " timeSinceLastPlayStartMs=" + juce::String(snapshot.timeSinceLastPlayStartMs, 2));
                }

                logToDisk("ARA FX processBlock slow: " + proc->getName()
                    + " callback=" + juce::String(static_cast<juce::int64>(currentARAProcessDebugInfo.callbackCounter))
                    + " firstCallbackAfterTransportStart=" + juce::String(currentARAProcessDebugInfo.firstCallbackAfterTransportStart ? "true" : "false")
                    + " preMs=" + juce::String(preProcessMs, 2)
                    + " processMs=" + juce::String(processDurationMs, 2)
                    + " postMs=" + juce::String(postProcessMs, 2)
                    + " totalMs=" + juce::String(totalDurationMs, 2)
                    + " callbackAgeMs=" + juce::String(juce::Time::getMillisecondCounterHiRes() - currentARAProcessDebugInfo.callbackStartWallTimeMs, 2)
                    + " samples=" + juce::String(numSamps));
            }
        };

        if (!useDoublePrecision && pluginChannels == bufferChannels)
        {
            const double processStartMs = isARAProcessor ? juce::Time::getMillisecondCounterHiRes() : 0.0;
            preProcessMs = isARAProcessor ? (processStartMs - envelopeStartMs) : 0.0;
            proc->processBlock(buffer, midiMessages);
            processDurationMs = isARAProcessor ? (juce::Time::getMillisecondCounterHiRes() - processStartMs) : 0.0;
            // Mono plugin on stereo track: duplicate processed output to all channels
            // (matches Reaper behaviour — avoids dry right channel when plugin is mono out)
            int outCh = proc->getTotalNumOutputChannels();
            if (outCh > 0 && outCh < bufferChannels)
            {
                for (int ch = outCh; ch < bufferChannels; ++ch)
                    buffer.copyFrom (ch, 0, buffer, 0, 0, numSamps);
            }
            logARAProcessDuration(isARAProcessor ? (juce::Time::getMillisecondCounterHiRes() - (processStartMs + processDurationMs)) : 0.0);
        }
        else
        {
            if (useDoublePrecision)
            {
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    auto* dest = fxProcessBufferDouble.getWritePointer(ch);
                    if (ch < bufferChannels)
                    {
                        auto* src = buffer.getReadPointer(ch);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = static_cast<double>(src[sample]);
                    }
                    else
                    {
                        juce::FloatVectorOperations::clear(dest, numSamps);
                    }
                }

                double* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBufferDouble.getWritePointer(ch);

                juce::AudioBuffer<double> pluginBuffer(channelPtrs, expandedCh, numSamps);
                const double processStartMs = isARAProcessor ? juce::Time::getMillisecondCounterHiRes() : 0.0;
                preProcessMs = isARAProcessor ? (processStartMs - envelopeStartMs) : 0.0;
                proc->processBlock(pluginBuffer, midiMessages);
                processDurationMs = isARAProcessor ? (juce::Time::getMillisecondCounterHiRes() - processStartMs) : 0.0;

                if (expandedCh == 1 && bufferChannels > 1)
                {
                    auto* mono = pluginBuffer.getReadPointer(0);
                    for (int ch = 0; ch < bufferChannels; ++ch)
                    {
                        auto* dest = buffer.getWritePointer(ch);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = static_cast<float>(mono[sample]);
                    }
                }
                else
                {
                    for (int ch = 0; ch < bufferChannels; ++ch)
                    {
                        auto* dest = buffer.getWritePointer(ch);
                        auto* src = pluginBuffer.getReadPointer(ch < expandedCh ? ch : 0);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = static_cast<float>(src[sample]);
                    }
                }
                logARAProcessDuration(isARAProcessor ? (juce::Time::getMillisecondCounterHiRes() - (processStartMs + processDurationMs)) : 0.0);
            }
            else
            {
                // Plugin needs more channels — use pre-allocated expanded buffer
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    if (expandedCh == 1 && bufferChannels > 1)
                    {
                        auto* dest = fxProcessBuffer.getWritePointer(ch);
                        auto* left = buffer.getReadPointer(0);
                        auto* right = buffer.getReadPointer(1);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = (left[sample] + right[sample]) * 0.5f;
                    }
                    else if (ch < bufferChannels)
                        fxProcessBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamps);
                    else
                        juce::FloatVectorOperations::clear(fxProcessBuffer.getWritePointer(ch), numSamps);
                }

                float* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBuffer.getWritePointer(ch);

                juce::AudioBuffer<float> pluginBuffer(channelPtrs, expandedCh, numSamps);
                const double processStartMs = isARAProcessor ? juce::Time::getMillisecondCounterHiRes() : 0.0;
                preProcessMs = isARAProcessor ? (processStartMs - envelopeStartMs) : 0.0;
                proc->processBlock(pluginBuffer, midiMessages);
                processDurationMs = isARAProcessor ? (juce::Time::getMillisecondCounterHiRes() - processStartMs) : 0.0;

                if (expandedCh == 1 && bufferChannels > 1)
                {
                    for (int ch = 0; ch < bufferChannels; ++ch)
                        buffer.copyFrom(ch, 0, pluginBuffer, 0, 0, numSamps);
                }
                else
                {
                    for (int ch = 0; ch < bufferChannels; ++ch)
                        buffer.copyFrom(ch, 0, pluginBuffer, ch < expandedCh ? ch : 0, 0, numSamps);
                }
                logARAProcessDuration(isARAProcessor ? (juce::Time::getMillisecondCounterHiRes() - (processStartMs + processDurationMs)) : 0.0);
            }
        }
        for (const auto metadata : midiMessages)
            markActiveMIDINoteState(metadata.getMessage());
        return true;
    };

    const auto canUseBypassDryBuffer = [&]
    {
        return buffer.getNumChannels()
                    <= fxBypassDryBuffer.getNumChannels()
            && buffer.getNumSamples()
                    <= fxBypassDryBuffer.getNumSamples();
    };

    const auto resolveBypassDelayStorage =
        [&] (bool isInputFXChain,
             int fxIndex) -> FXBypassDelayStorage*
    {
        if (fxIndex < 0
            || static_cast<size_t>(fxIndex)
                    >= maxRealtimeFXContinuitySlots)
            return nullptr;

        const auto* snapshot = isInputFXChain
            ? inputFXBypassDelaySnapshot
            : trackFXBypassDelaySnapshot;
        if (snapshot == nullptr)
            return nullptr;
        return (*snapshot)[static_cast<size_t>(fxIndex)].get();
    };

    const auto prepareLatencyAlignedDry =
        [&] (FXBypassDelayStorage* storage,
             const juce::AudioProcessor& processor,
             bool writeDryOutput,
             bool advanceHistory)
    {
        const int channels = buffer.getNumChannels();
        const int samples = buffer.getNumSamples();
        if (storage == nullptr
            || storage->processor != &processor
            || storage->ring.getNumChannels() < channels
            || storage->ring.getNumSamples() <= 0)
        {
            if (writeDryOutput)
            {
                for (int channel = 0;
                     channel < channels;
                     ++channel)
                {
                    fxBypassDryBuffer.copyFrom(
                        channel,
                        0,
                        buffer,
                        channel,
                        0,
                        samples);
                }
            }
            return false;
        }

        const int capacity =
            storage->ring.getNumSamples();
        const int reportedLatency = juce::jlimit(
            0,
            capacity - 1,
            storage->publishedLatency.load(
                std::memory_order_acquire));
        if (! storage->latencyInitialised)
        {
            storage->currentLatency = reportedLatency;
            storage->targetLatency = reportedLatency;
            storage->latencyRampRemaining = 0;
            storage->latencyRampLength = 0;
            storage->latencyInitialised = true;
        }
        else if (reportedLatency
                    != storage->targetLatency)
        {
            storage->targetLatency = reportedLatency;
            if (writeDryOutput
                && storage->currentLatency
                        != storage->targetLatency)
            {
                storage->latencyRampLength =
                    fxContinuityRampSamples;
                storage->latencyRampRemaining =
                    fxContinuityRampSamples;
            }
            else
            {
                storage->currentLatency =
                    storage->targetLatency;
                storage->latencyRampRemaining = 0;
                storage->latencyRampLength = 0;
            }
        }
        else if (! writeDryOutput
                 && storage->latencyRampRemaining > 0)
        {
            // No dry signal is currently audible, so adopt a latency update
            // immediately while continuing to keep the history ring warm.
            storage->currentLatency =
                storage->targetLatency;
            storage->latencyRampRemaining = 0;
            storage->latencyRampLength = 0;
        }

        auto writePosition = storage->writePosition;
        if (! advanceHistory)
        {
            writePosition -= samples % capacity;
            if (writePosition < 0)
                writePosition += capacity;
        }
        for (int sample = 0; sample < samples; ++sample)
        {
            if (advanceHistory)
            {
                for (int channel = 0;
                     channel < channels;
                     ++channel)
                {
                    storage->ring.setSample(
                        channel,
                        writePosition,
                        buffer.getSample(channel, sample));
                }
            }

            if (writeDryOutput)
            {
                int currentRead =
                    writePosition
                    - storage->currentLatency;
                if (currentRead < 0)
                    currentRead += capacity;
                int targetRead =
                    writePosition
                    - storage->targetLatency;
                if (targetRead < 0)
                    targetRead += capacity;
                const float latencyMix =
                    storage->latencyRampRemaining > 0
                        && storage->latencyRampLength > 0
                    ? 1.0f
                        - static_cast<float>(
                            storage
                                ->latencyRampRemaining)
                            / static_cast<float>(
                                storage
                                    ->latencyRampLength)
                    : 1.0f;
                for (int channel = 0;
                     channel < channels;
                     ++channel)
                {
                    const float currentDry =
                        storage->ring.getSample(
                            channel, currentRead);
                    const float targetDry =
                        storage->ring.getSample(
                            channel, targetRead);
                    fxBypassDryBuffer.setSample(
                        channel,
                        sample,
                        currentDry
                        + (targetDry - currentDry)
                            * latencyMix);
                }
            }

            ++writePosition;
            if (writePosition >= capacity)
                writePosition = 0;
            if (writeDryOutput
                && storage->latencyRampRemaining > 0)
            {
                --storage->latencyRampRemaining;
                if (storage->latencyRampRemaining == 0)
                {
                    storage->currentLatency =
                        storage->targetLatency;
                    storage->latencyRampLength = 0;
                }
            }
        }
        if (advanceHistory)
            storage->writePosition = writePosition;
        return true;
    };

    const auto applyHostBypassCrossfade =
        [&] (FXContinuityState& continuity,
             bool bypassed)
    {
        const float target = bypassed ? 0.0f : 1.0f;
        const int channels = buffer.getNumChannels();
        const int samples = buffer.getNumSamples();
        auto wetMix = continuity.hostBypassWetMix;
        for (int sample = 0; sample < samples; ++sample)
        {
            wetMix = target < wetMix
                ? juce::jmax(target, wetMix - fxBypassRampStep)
                : juce::jmin(target, wetMix + fxBypassRampStep);
            for (int channel = 0; channel < channels; ++channel)
            {
                const float dry =
                    fxBypassDryBuffer.getSample(channel, sample);
                const float wet = buffer.getSample(channel, sample);
                buffer.setSample(
                    channel,
                    sample,
                    dry + (wet - dry) * wetMix);
            }
        }
        continuity.hostBypassWetMix = wetMix;
    };

    const auto finishFXSlot =
        [&] (FXContinuityState* continuity,
             bool bypassed,
             bool processed,
             bool dryInputCaptured)
    {
        if (continuity == nullptr)
            return;

        if (processed && dryInputCaptured)
            applyHostBypassCrossfade(*continuity, bypassed);
        else if (! processed && bypassed)
        {
            // A busy processor already leaves the dry input in place. Still
            // advance a bypass request so it reaches the zero-CPU steady state.
            continuity->hostBypassWetMix = juce::jmax(
                0.0f,
                continuity->hostBypassWetMix
                    - fxBypassRampStep
                        * static_cast<float>(
                            buffer.getNumSamples()));
        }

        if (processed)
        {
            if (continuity->skippedLastBlock)
                scheduleEndpointCorrection(continuity);
            applyEndpointCorrection(continuity);
            rememberOutputEndpoint(continuity);
            continuity->skippedLastBlock = false;
        }
        else
        {
            if (! continuity->skippedLastBlock)
                scheduleEndpointCorrection(continuity);
            applyEndpointCorrection(continuity);
            rememberOutputEndpoint(continuity);
            continuity->skippedLastBlock = true;
        }
    };

    const auto processFXWithHostBypass =
        [&] (juce::AudioProcessor* proc,
             bool forceFloat,
             bool isInputFXChain,
             int fxIndex,
             bool bypassed)
    {
        auto* continuity = resolveFXContinuity(
            proc, isInputFXChain, fxIndex, bypassed);
        if (continuity == nullptr && bypassed)
            return;

        const bool transitioning =
            continuity != nullptr
            && std::abs(
                continuity->hostBypassWetMix
                - (bypassed ? 0.0f : 1.0f)) > 1.0e-6f;
        auto* bypassDelay = resolveBypassDelayStorage(
            isInputFXChain, fxIndex);
        const bool canWriteDry =
            canUseBypassDryBuffer();
        const bool writeDryOutput =
            canWriteDry
            && fxIndex >= 0
            && (transitioning || bypassed);
        if (fxIndex >= 0)
        {
            prepareLatencyAlignedDry(
                bypassDelay,
                *proc,
                writeDryOutput,
                true);
        }

        if (continuity != nullptr
            && bypassed
            && continuity->hostBypassWetMix <= 0.0f)
        {
            if (writeDryOutput)
            {
                for (int channel = 0;
                     channel < buffer.getNumChannels();
                     ++channel)
                {
                    buffer.copyFrom(
                        channel,
                        0,
                        fxBypassDryBuffer,
                        channel,
                        0,
                        buffer.getNumSamples());
                }
            }
            applyEndpointCorrection(continuity);
            rememberOutputEndpoint(continuity);
            continuity->skippedLastBlock = true;
            return;
        }

        const bool dryInputCaptured =
            transitioning && writeDryOutput;
        if (transitioning && ! dryInputCaptured)
        {
            // The normal realtime layout is bounded by kMaxFXChannels. If a
            // hostile/invalid layout exceeds it, retain memory safety and fall
            // back to the requested hard state instead of allocating here.
            continuity->hostBypassWetMix =
                bypassed ? 0.0f : 1.0f;
            if (bypassed)
            {
                rememberOutputEndpoint(continuity);
                continuity->skippedLastBlock = true;
                return;
            }
        }
        const bool processed = safeProcessFX(
            proc, forceFloat, isInputFXChain, fxIndex);
        bool fallbackDryAvailable = writeDryOutput;
        if (! processed
            && ! fallbackDryAvailable
            && canWriteDry
            && fxIndex >= 0)
        {
            prepareLatencyAlignedDry(
                bypassDelay,
                *proc,
                true,
                false);
            fallbackDryAvailable = true;
        }
        if (! processed && fallbackDryAvailable)
        {
            realtimeFallbackReuseCount.fetch_add(
                1, std::memory_order_relaxed);
            for (int channel = 0;
                 channel < buffer.getNumChannels();
                 ++channel)
            {
                buffer.copyFrom(
                    channel,
                    0,
                    fxBypassDryBuffer,
                    channel,
                    0,
                    buffer.getNumSamples());
            }
        }
        finishFXSlot(
            continuity,
            bypassed,
            processed,
            dryInputCaptured);
    };

    // ===== PRE-FX AUTOMATION =====
    const int numSamps = buffer.getNumSamples();
    const double processingSampleRate = juce::jmax(1.0, getSampleRate());
    const auto blockPanLaw =
        panLaw.load(std::memory_order_acquire);
    if (automationGainBuffer.getNumChannels() < 8 || automationGainBuffer.getNumSamples() < numSamps)
        automationGainBuffer.setSize(8, numSamps, false, false, true);
    const float staticPreFXVolDb = 0.0f;
    const float staticPreFXPan = 0.0f;
    const float staticPreFXWidth = 100.0f;
    const bool preFXVolAutoActive = shouldApplyAutomation(preFXVolumeAutomation) && preFXVolumeAutomation.getNumPoints() > 0;
    const bool preFXPanAutoActive = shouldApplyAutomation(preFXPanAutomation) && preFXPanAutomation.getNumPoints() > 0;
    const bool preFXWidthAutoActive = shouldApplyAutomation(preFXWidthAutomation) && preFXWidthAutomation.getNumPoints() > 0;

    if (preFXVolAutoActive || preFXPanAutoActive)
    {
        auto* preFXVolValues = automationGainBuffer.getWritePointer(0);
        auto* preFXPanValues = automationGainBuffer.getWritePointer(1);
        if (preFXVolAutoActive)
            preFXVolumeAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, preFXVolValues);
        if (preFXPanAutoActive)
            preFXPanAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, preFXPanValues);

        for (int i = 0; i < numSamps; ++i)
        {
            float volDb = preFXVolAutoActive ? preFXVolValues[i] : staticPreFXVolDb;
            float pan = preFXPanAutoActive ? preFXPanValues[i] : staticPreFXPan;
            volDb = juce::jlimit(-60.0f, 12.0f, volDb);
            pan = juce::jlimit(-1.0f, 1.0f, pan);

            float leftGain = 1.0f;
            float rightGain = 1.0f;
            computePanLawGains(
                blockPanLaw,
                pan,
                juce::Decibels::decibelsToGain(volDb),
                leftGain,
                rightGain);

            if (bufferChannels >= 1)
                buffer.setSample(0, i, buffer.getSample(0, i) * leftGain);
            if (bufferChannels >= 2)
                buffer.setSample(1, i, buffer.getSample(1, i) * rightGain);
        }
    }

    if (bufferChannels >= 2)
    {
        if (preFXWidthAutoActive)
        {
            auto* preFXWidthValues = automationGainBuffer.getWritePointer(2);
            preFXWidthAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, preFXWidthValues);
            float* left = buffer.getWritePointer(0);
            float* right = buffer.getWritePointer(1);
            for (int i = 0; i < numSamps; ++i)
            {
                const float widthPercent = backendWidthToPercent(preFXWidthValues[i]);
                const float widthFactor = widthPercent / 100.0f;
                const float mid = (left[i] + right[i]) * 0.5f;
                const float side = (left[i] - right[i]) * 0.5f;
                left[i] = mid + side * widthFactor;
                right[i] = mid - side * widthFactor;
            }
        }
        else
        {
            applyStereoWidthToBuffer(buffer, bufferChannels, numSamps, staticPreFXWidth);
        }
    }

    // Channel strip EQ (processed before plugin FX chains). It stays in the
    // callback so its internal dry/wet ramp can make power changes click-free;
    // the steady disabled path returns immediately.
    channelStripEQ.processBlock(buffer, midiMessages);

    // Process through input FX chain
    if (inputFXSnapshot)
    {
        for (int pluginIndex = 0; pluginIndex < static_cast<int>(inputFXSnapshot->size()); ++pluginIndex)
        {
            const auto& plugin = (*inputFXSnapshot)[pluginIndex];
            const bool bypassed = inputFXBypassSnapshot != nullptr
                               && inputFXBypassSnapshot->count(pluginIndex) > 0
                               && inputFXBypassSnapshot->at(pluginIndex);
            const bool forceFloat = inputFXPrecisionOverrideSnapshot != nullptr
                                 && inputFXPrecisionOverrideSnapshot->count(pluginIndex) > 0
                                 && inputFXPrecisionOverrideSnapshot->at(pluginIndex);
            if (plugin)
                processFXWithHostBypass(
                    plugin.get(),
                    forceFloat,
                    true,
                    pluginIndex,
                    bypassed);
        }
    }

    // Instrument processing lives between input FX and track FX so that
    // instrument output can be post-processed by normal track FX.
    if (currentTrackType == TrackType::Instrument && instrumentSnapshot)
    {
        processFXWithHostBypass(
            instrumentSnapshot,
            instrumentForceFloat,
            false,
            -1,
            false);
    }
    else if (currentTrackType == TrackType::Instrument && !hasTrackBuiltInInstrument)
    {
        renderFallbackInstrument(buffer, midiMessages, numSamps, processingSampleRate);
    }

    // Process through track FX chain (with sidechain support)
    for (int fxIdx = 0; trackFXSnapshot && fxIdx < (int)trackFXSnapshot->size(); ++fxIdx)
    {
        auto* proc = (*trackFXSnapshot)[fxIdx].get();
        if (!proc) continue;
        bool bypassed = false;
        if (trackFXBypassSnapshot != nullptr)
        {
            auto bypassIt = trackFXBypassSnapshot->find(fxIdx);
            if (bypassIt != trackFXBypassSnapshot->end() && bypassIt->second)
                bypassed = true;
        }
        const bool forceFloat = trackFXPrecisionOverrideSnapshot != nullptr
                             && trackFXPrecisionOverrideSnapshot->count(fxIdx) > 0
                             && trackFXPrecisionOverrideSnapshot->at(fxIdx);

        // Check if this plugin has a sidechain source configured AND
        // the plugin actually supports sidechain input (more than 1 input bus)
        SidechainSourceSnapshot::const_iterator scIt;
        bool hasSidechain = false;
        if (sidechainSnapshot != nullptr)
        {
            scIt = sidechainSnapshot->find(fxIdx);
            hasSidechain = scIt != sidechainSnapshot->end();
        }
        hasSidechain = hasSidechain
                            && sidechainInputBuffer != nullptr
                            && proc->getBusCount(true) > 1;

        if (hasSidechain)
        {
            auto* continuity = resolveFXContinuity(
                proc, false, fxIdx, bypassed);
            if (continuity == nullptr && bypassed)
                continue;
            const bool transitioning =
                continuity != nullptr
                && std::abs(
                    continuity->hostBypassWetMix
                    - (bypassed ? 0.0f : 1.0f))
                        > 1.0e-6f;
            const bool canWriteDry =
                canUseBypassDryBuffer();
            auto* bypassDelay =
                resolveBypassDelayStorage(false, fxIdx);
            prepareLatencyAlignedDry(
                bypassDelay,
                *proc,
                canWriteDry
                    && (transitioning || bypassed),
                true);

            if (continuity != nullptr
                && bypassed
                && continuity->hostBypassWetMix <= 0.0f)
            {
                if (canWriteDry)
                {
                    for (int channel = 0;
                         channel < buffer.getNumChannels();
                         ++channel)
                    {
                        buffer.copyFrom(
                            channel,
                            0,
                            fxBypassDryBuffer,
                            channel,
                            0,
                            buffer.getNumSamples());
                    }
                }
                applyEndpointCorrection(continuity);
                rememberOutputEndpoint(continuity);
                continuity->skippedLastBlock = true;
                continue;
            }

            const bool dryInputCaptured =
                transitioning && canWriteDry;
            if (transitioning && ! dryInputCaptured)
            {
                continuity->hostBypassWetMix =
                    bypassed ? 0.0f : 1.0f;
                if (bypassed)
                {
                    rememberOutputEndpoint(continuity);
                    continuity->skippedLastBlock = true;
                    continue;
                }
            }
            juce::ScopedTryLock pluginProcessLock(proc->getCallbackLock());
            if (!pluginProcessLock.isLocked())
            {
                pluginBusySkipCount.fetch_add(1, std::memory_order_relaxed);
                if (canWriteDry
                    && ! (transitioning || bypassed))
                {
                    prepareLatencyAlignedDry(
                        bypassDelay,
                        *proc,
                        true,
                        false);
                }
                if (canWriteDry)
                {
                    realtimeFallbackReuseCount.fetch_add(
                        1, std::memory_order_relaxed);
                    for (int channel = 0;
                         channel < buffer.getNumChannels();
                         ++channel)
                    {
                        buffer.copyFrom(
                            channel,
                            0,
                            fxBypassDryBuffer,
                            channel,
                            0,
                            buffer.getNumSamples());
                    }
                }
                finishFXSlot(
                    continuity,
                    bypassed,
                    false,
                    dryInputCaptured);
                continue;
            }

            applyPluginAutomationForProcessor(
                proc,
                false,
                fxIdx,
                blockTimeSeconds,
                pluginAutomationRoutesForBlock);

            // Sidechain path: expand buffer to include sidechain channels after
            // the main stereo channels.  The plugin's second input bus receives
            // the sidechain audio.
            int numSamps2 = buffer.getNumSamples();

            // Determine total channel count: main channels + sidechain channels.
            // Most sidechain buses are stereo (2 channels), but query the plugin
            // to be safe.
            int mainCh = juce::jmax(proc->getMainBusNumInputChannels(),
                                     proc->getMainBusNumOutputChannels());
            if (mainCh < bufferChannels) mainCh = bufferChannels;

            // The sidechain bus is the second input bus (index 1).
            int scBusCh = 0;
            if (auto* scBus = proc->getBus(true, 1))
                scBusCh = scBus->getNumberOfChannels();
            if (scBusCh <= 0) scBusCh = 2; // Fallback: stereo sidechain

            int totalCh = mainCh + scBusCh;
            const bool useDoublePrecision =
                processingPrecisionMode == ProcessingPrecisionMode::Hybrid64
                && !forceFloat
                && proc->supportsDoublePrecisionProcessing();
            int expandedCh = useDoublePrecision
                ? juce::jmin(totalCh, fxProcessBufferDouble.getNumChannels())
                : juce::jmin(totalCh, fxProcessBuffer.getNumChannels());

            if (useDoublePrecision)
            {
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    auto* dest = fxProcessBufferDouble.getWritePointer(ch);
                    juce::FloatVectorOperations::clear(dest, numSamps2);
                    if (expandedCh == 1 && bufferChannels > 1)
                    {
                        auto* left = buffer.getReadPointer(0);
                        auto* right = buffer.getReadPointer(1);
                        for (int sample = 0; sample < numSamps2; ++sample)
                            dest[sample] = static_cast<double>((left[sample] + right[sample]) * 0.5f);
                    }
                    else if (ch < bufferChannels)
                    {
                        auto* src = buffer.getReadPointer(ch);
                        for (int sample = 0; sample < numSamps2; ++sample)
                            dest[sample] = static_cast<double>(src[sample]);
                    }
                }

                int scInputCh = sidechainInputBuffer->getNumChannels();
                for (int ch = 0; ch < scBusCh && (mainCh + ch) < expandedCh; ++ch)
                {
                    if (ch < scInputCh)
                    {
                        auto* dest = fxProcessBufferDouble.getWritePointer(mainCh + ch);
                        auto* src = sidechainInputBuffer->getReadPointer(ch);
                        for (int sample = 0; sample < numSamps2; ++sample)
                            dest[sample] = static_cast<double>(src[sample]);
                    }
                }

                double* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBufferDouble.getWritePointer(ch);

                juce::AudioBuffer<double> pluginBuffer(channelPtrs, expandedCh, numSamps2);
                proc->processBlock(pluginBuffer, midiMessages);

                for (int ch = 0; ch < bufferChannels; ++ch)
                {
                    auto* dest = buffer.getWritePointer(ch);
                    auto* src = pluginBuffer.getReadPointer(ch);
                    for (int sample = 0; sample < numSamps2; ++sample)
                        dest[sample] = static_cast<float>(src[sample]);
                }
            }
            else
            {
                // Copy main audio into pre-allocated buffer
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    if (ch < bufferChannels)
                        fxProcessBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamps2);
                    else
                        juce::FloatVectorOperations::clear(fxProcessBuffer.getWritePointer(ch), numSamps2);
                }

                // Copy sidechain audio into channels after the main channels
                int scInputCh = sidechainInputBuffer->getNumChannels();
                for (int ch = 0; ch < scBusCh && (mainCh + ch) < expandedCh; ++ch)
                {
                    if (ch < scInputCh)
                    {
                        fxProcessBuffer.copyFrom(mainCh + ch, 0,
                                                 *sidechainInputBuffer, ch, 0, numSamps2);
                    }
                }

                float* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBuffer.getWritePointer(ch);

                juce::AudioBuffer<float> pluginBuffer(channelPtrs, expandedCh, numSamps2);
                proc->processBlock(pluginBuffer, midiMessages);

                // Copy processed main channels back
                for (int ch = 0; ch < bufferChannels; ++ch)
                    buffer.copyFrom(ch, 0, pluginBuffer, ch, 0, numSamps2);
            }

            finishFXSlot(
                continuity,
                bypassed,
                true,
                dryInputCaptured);
        }
        else
        {
            // No sidechain — use normal channel-safe processing
            processFXWithHostBypass(
                proc,
                forceFloat,
                false,
                fxIdx,
                bypassed);
        }
    }

    const double trackProcessDurationMs = isARATrack ? (juce::Time::getMillisecondCounterHiRes() - trackProcessStartMs) : 0.0;
    if (kEnableARADebugDiagnostics
        && trackProcessDurationMs > 10.0
        && activeARAControllerForBlock != nullptr)
    {
        logToDisk("ARA track envelope slow: trackId=" + araDebugTrackId
            + " callback=" + juce::String(static_cast<juce::int64>(currentARAProcessDebugInfo.callbackCounter))
            + " firstCallbackAfterTransportStart=" + juce::String(currentARAProcessDebugInfo.firstCallbackAfterTransportStart ? "true" : "false")
            + " totalTrackMs=" + juce::String(trackProcessDurationMs, 2)
            + " blockStartSeconds=" + juce::String(blockTimeSeconds, 3)
            + " numSamples=" + juce::String(buffer.getNumSamples()));
    }

    // ===== DC OFFSET REMOVAL (after FX, before gain) =====
    if (dcOffsetRemoval.load(std::memory_order_acquire)
        && bufferChannels >= 1)
    {
        double sr = getSampleRate();
        if (sr <= 0) sr = 44100.0;
        float alpha = 1.0f - (2.0f * juce::MathConstants<float>::pi * 5.0f / static_cast<float>(sr));

        // Left channel
        {
            float prevIn = dcPrevInputL;
            float prevOut = dcFilterStateL;
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                float input = buffer.getSample(0, i);
                float output = input - prevIn + alpha * prevOut;
                prevIn = input;
                prevOut = output;
                buffer.setSample(0, i, output);
            }
            dcPrevInputL = prevIn;
            dcFilterStateL = prevOut;
        }

        // Right channel
        if (bufferChannels >= 2)
        {
            float prevIn = dcPrevInputR;
            float prevOut = dcFilterStateR;
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                float input = buffer.getSample(1, i);
                float output = input - prevIn + alpha * prevOut;
                prevIn = input;
                prevOut = output;
                buffer.setSample(1, i, output);
            }
            dcPrevInputR = prevIn;
            dcFilterStateR = prevOut;
        }
    }

    // ===== PHASE INVERT (polarity flip) =====
    if (phaseInverted.load(std::memory_order_relaxed))
    {
        for (int ch = 0; ch < bufferChannels; ++ch)
            juce::FloatVectorOperations::negate(
                buffer.getWritePointer(ch),
                buffer.getReadPointer(ch),
                buffer.getNumSamples());
    }

    // ===== POST-FX WIDTH =====
    const bool widthAutoActive = shouldApplyAutomation(widthAutomation) && widthAutomation.getNumPoints() > 0;
    if (bufferChannels >= 2)
    {
        if (widthAutoActive)
        {
            auto* widthValues = automationGainBuffer.getWritePointer(3);
            widthAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, widthValues);
            float* left = buffer.getWritePointer(0);
            float* right = buffer.getWritePointer(1);
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                const float widthPercent = backendWidthToPercent(widthValues[i]);
                const float widthFactor = widthPercent / 100.0f;
                const float mid = (left[i] + right[i]) * 0.5f;
                const float side = (left[i] - right[i]) * 0.5f;
                left[i] = mid + side * widthFactor;
                right[i] = mid - side * widthFactor;
            }
        }
        else
        {
            applyStereoWidthToBuffer(buffer, bufferChannels, buffer.getNumSamples(),
                                     stereoWidth.load(std::memory_order_relaxed));
        }
    }

    // Mirror effectively mono post-FX output before send taps so pre/post-fader sends,
    // receives, and the track output all hear the same centered mono image.
    normalizeMonoLikeBufferToDualMono(buffer, bufferChannels, buffer.getNumSamples());

    // ===== CAPTURE PRE-FADER BUFFER (for pre-fader sends) =====
    if (sendSnapshot && !sendSnapshot->empty())
    {
        int pfSamples = buffer.getNumSamples();
        if (preFaderBuffer.getNumSamples() < pfSamples)
            preFaderBuffer.setSize(2, pfSamples, false, false, true);
        for (int ch = 0; ch < juce::jmin(2, bufferChannels); ++ch)
            preFaderBuffer.copyFrom(ch, 0, buffer, ch, 0, pfSamples);
    }

    // ===== AUTOMATION-AWARE FADER/TAIL APPLICATION =====
    bool volAutoActive = shouldApplyAutomation(volumeAutomation) && volumeAutomation.getNumPoints() > 0;
    bool panAutoActive = shouldApplyAutomation(panAutomation) && panAutomation.getNumPoints() > 0;
    bool trimAutoActive = shouldApplyAutomation(trimVolumeAutomation) && trimVolumeAutomation.getNumPoints() > 0;
    bool muteAutoActive = shouldApplyAutomation(muteAutomation) && muteAutomation.getNumPoints() > 0;

    if (volAutoActive || panAutoActive)
    {
        float staticVolDB = trackVolumeDB.load(std::memory_order_relaxed);
        float staticPan = trackPan.load(std::memory_order_relaxed);
        auto* volumeValues = automationGainBuffer.getWritePointer(4);
        auto* panValues = automationGainBuffer.getWritePointer(5);
        if (volAutoActive)
            volumeAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, volumeValues);
        if (panAutoActive)
            panAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, panValues);

        for (int i = 0; i < numSamps; ++i)
        {
            float volDB = volAutoActive ? volumeValues[i] : staticVolDB;
            float pan   = panAutoActive ? panValues[i]   : staticPan;

            volDB = juce::jlimit(-60.0f, 12.0f, volDB);
            pan   = juce::jlimit(-1.0f, 1.0f, pan);

            float volumeGain = juce::Decibels::decibelsToGain(volDB);
            float lGain = 1.0f;
            float rGain = 1.0f;
            computePanLawGains(
                blockPanLaw,
                pan,
                volumeGain,
                lGain,
                rGain);

            // Apply per-sample gain
            if (bufferChannels >= 1)
                buffer.setSample(0, i, buffer.getSample(0, i) * lGain);
            if (bufferChannels >= 2)
                buffer.setSample(1, i, buffer.getSample(1, i) * rGain);
        }
    }
    else
    {
        float leftGain  = cachedPanL.load(std::memory_order_relaxed);
        float rightGain = cachedPanR.load(std::memory_order_relaxed);

        if (bufferChannels >= 1)
            buffer.applyGain(0, 0, numSamps, leftGain);
        if (bufferChannels >= 2)
            buffer.applyGain(1, 0, numSamps, rightGain);
    }

    if (trimAutoActive)
    {
        auto* trimValues = automationGainBuffer.getWritePointer(6);
        trimVolumeAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, trimValues);
        for (int i = 0; i < numSamps; ++i)
        {
            const float trimDb = juce::jlimit(-60.0f, 12.0f, trimValues[i]);
            const float trimGain = juce::Decibels::decibelsToGain(trimDb);
            if (bufferChannels >= 1)
                buffer.setSample(0, i, buffer.getSample(0, i) * trimGain);
            if (bufferChannels >= 2)
                buffer.setSample(1, i, buffer.getSample(1, i) * trimGain);
        }
    }

    if (muteAutoActive)
    {
        auto* muteValues = automationGainBuffer.getWritePointer(7);
        muteAutomation.evalBlock(blockTimeSeconds, processingSampleRate, numSamps, muteValues);
        for (int i = 0; i < numSamps; ++i)
        {
            const bool muted = muteValues[i] > 0.5f;
            if (!muted)
                continue;
            for (int ch = 0; ch < bufferChannels; ++ch)
                buffer.setSample(ch, i, 0.0f);
        }
    }

    // ---- REAPER-style peak metering with decimation ----
    // getMagnitude() uses FloatVectorOperations::findMinAndMax (SIMD, no sqrt),
    // which is much cheaper than getRMSLevel() (which computes sqrt per channel).
    // We accumulate the running peak over METER_UPDATE_SAMPLES then commit it
    // to currentRMS. At 32-sample ASIO blocks this fires ~86 times/sec instead
    // of 1378 times/sec — a 16× reduction in per-track metering overhead.
    float peak = 0.0f;
    for (int ch = 0; ch < bufferChannels; ++ch)
        peak = juce::jmax (peak, buffer.getMagnitude (ch, 0, buffer.getNumSamples()));

    if (peak > 1.0f)
        clipLatched.store(true, std::memory_order_relaxed);

    meterPeakAccum   = juce::jmax (meterPeakAccum, peak);
    meterSampleCount += buffer.getNumSamples();
    if (meterSampleCount >= METER_UPDATE_SAMPLES)
    {
        currentRMS.store (meterPeakAccum, std::memory_order_relaxed);
        meterPeakAccum   = 0.0f;
        meterSampleCount = 0;
    }

    finishRealtimeFXTailDrain(peak);

}

bool TrackProcessor::hasEditor() const
{
    return false;
}

juce::AudioProcessorEditor* TrackProcessor::createEditor()
{
    return nullptr;
}

void TrackProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::ignoreUnused (destData);
}

void TrackProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    juce::ignoreUnused (data, sizeInBytes);
}

void TrackProcessor::setInputChannels(int startChannel, int numChannels)
{
    inputStartChannel.store(startChannel, std::memory_order_release);
    inputChannelCount.store(numChannels, std::memory_order_release);
    juce::Logger::writeToLog("TrackProcessor: Input channels set to " +
                           juce::String(startChannel) + "-" +
                           juce::String(startChannel + numChannels - 1));
}

//==============================================================================
// FX Chain Management (Phase 3)
// Plugins are stored directly in vectors — no AudioProcessorGraph wrapper.
// This gives us full control over the plugin lifecycle and avoids any graph
// interference (bus layout changes, re-preparation, etc.).

bool TrackProcessor::addInputFX(std::unique_ptr<juce::AudioProcessor> plugin, double callerSampleRate, int callerBlockSize)
{
    if (!plugin)
        return false;

    const juce::ScopedLock processorCallbackGuard(getCallbackLock());

    // Only set stereo layout if the plugin has no channels configured
    // (some plugins start at 0-in/0-out and need explicit bus setup).
    // Don't change plugins that already have a valid default layout
    // (e.g. guitar amp sims like Amplitube default to mono-in/stereo-out;
    // forcing stereo-in makes them apply different L/R processing to the
    // duplicated mono signal, producing a "polyphonic" doubled sound).
    if (plugin->getTotalNumInputChannels() == 0 && plugin->getTotalNumOutputChannels() == 0)
    {
        juce::AudioProcessor::BusesLayout stereoLayout;
        stereoLayout.inputBuses.add(juce::AudioChannelSet::stereo());
        stereoLayout.outputBuses.add(juce::AudioChannelSet::stereo());
        plugin->setBusesLayout(stereoLayout);
    }

    // Prefer caller-supplied rate (from AudioEngine), fall back to our own,
    // then to 44100 as last resort. Use the realtime device block size when known.
    double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
    int bs = getSafeHostedPluginBlockSize(callerBlockSize > 0 ? callerBlockSize : getBlockSize());
    if (sr <= 0) sr = 44100.0;
    if (bs <= 0) bs = kMinimumHostedPluginBlockSize;

    // Prepare while preserving bus layout (see preparePluginPreservingLayout).
    preparePluginPreservingLayout(plugin.get(), sr, bs,
                                  resolvePluginPrecisionMode(processingPrecisionMode, false),
                                  inputChannelCount.load(std::memory_order_acquire));

    juce::Logger::writeToLog("TrackProcessor: Added Input FX plugin (" + plugin->getName() +
                             ") prepared at " + juce::String(sr) + "Hz / " + juce::String(bs) + " samples" +
                             " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                             " outCh=" + juce::String(plugin->getTotalNumOutputChannels()));

    inputFXPlugins.push_back(std::shared_ptr<juce::AudioProcessor>(std::move(plugin)));
    publishRealtimeStateSnapshots();
    return true;
}

bool TrackProcessor::addTrackFX(std::unique_ptr<juce::AudioProcessor> plugin, double callerSampleRate, int callerBlockSize)
{
    if (!plugin)
        return false;

    const juce::ScopedLock processorCallbackGuard(getCallbackLock());

    // Only set stereo layout if the plugin has no channels configured
    // (same rationale as addInputFX — preserve the plugin's default layout).
    if (plugin->getTotalNumInputChannels() == 0 && plugin->getTotalNumOutputChannels() == 0)
    {
        juce::AudioProcessor::BusesLayout stereoLayout;
        stereoLayout.inputBuses.add(juce::AudioChannelSet::stereo());
        stereoLayout.outputBuses.add(juce::AudioChannelSet::stereo());
        plugin->setBusesLayout(stereoLayout);
    }

    // Prefer caller-supplied rate (from AudioEngine), fall back to our own,
    // then to 44100 as last resort. Use the realtime device block size when known.
    double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
    int bs = getSafeHostedPluginBlockSize(callerBlockSize > 0 ? callerBlockSize : getBlockSize());
    if (sr <= 0) sr = 44100.0;
    if (bs <= 0) bs = kMinimumHostedPluginBlockSize;

    // Prepare while preserving bus layout (see preparePluginPreservingLayout).
    preparePluginPreservingLayout(plugin.get(), sr, bs,
                                  resolvePluginPrecisionMode(processingPrecisionMode, false),
                                  inputChannelCount.load(std::memory_order_acquire));

    juce::Logger::writeToLog("TrackProcessor: Added Track FX plugin (" + plugin->getName() +
                             ") prepared at " + juce::String(sr) + "Hz / " + juce::String(bs) + " samples" +
                             " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                             " outCh=" + juce::String(plugin->getTotalNumOutputChannels()));

    trackFXPlugins.push_back(std::shared_ptr<juce::AudioProcessor>(std::move(plugin)));
    publishRealtimeStateSnapshots();
    return true;
}

void TrackProcessor::removeInputFX(int index)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (index >= 0 && index < (int)inputFXPlugins.size())
    {
        inputFXPlugins.erase(inputFXPlugins.begin() + index);
        std::map<int, bool> updatedOverrides;
        std::map<int, bool> updatedBypass;
        for (const auto& [fxIndex, forceFloat] : inputFXForceFloatOverrides)
        {
            if (fxIndex == index)
                continue;
            updatedOverrides[fxIndex > index ? fxIndex - 1 : fxIndex] = forceFloat;
        }
        for (const auto& [fxIndex, bypassed] : inputFXBypassedState)
        {
            if (fxIndex == index)
                continue;
            updatedBypass[fxIndex > index ? fxIndex - 1 : fxIndex] = bypassed;
        }
        inputFXForceFloatOverrides = std::move(updatedOverrides);
        inputFXBypassedState = std::move(updatedBypass);
        remapPluginAutomationRoutesForRemoval(true, index);
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Removed Input FX at index " + juce::String(index));
    }
}

void TrackProcessor::removeTrackFX(int index)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (index >= 0 && index < (int)trackFXPlugins.size())
    {
        if (index == araFXIndex)
        {
            // Deactivate the plugin BEFORE ARA shutdown to stop its internal
            // threads from calling readAudioSamples on sources we're about to
            // destroy. Without this, the audio thread or plugin analysis thread
            // accesses freed memory → crash.
            if (auto& plugin = trackFXPlugins[static_cast<size_t>(index)])
                plugin->releaseResources();
            shutdownARA();
        }
        else if (index < araFXIndex)
        {
            --araFXIndex;
            if (araFXIndexForRealtime.load(
                    std::memory_order_acquire) >= 0)
            {
                araFXIndexForRealtime.store(
                    araFXIndex,
                    std::memory_order_release);
            }
        }

        trackFXPlugins.erase(trackFXPlugins.begin() + index);
        std::map<int, bool> updatedOverrides;
        std::map<int, bool> updatedBypass;
        for (const auto& [fxIndex, forceFloat] : trackFXForceFloatOverrides)
        {
            if (fxIndex == index)
                continue;
            updatedOverrides[fxIndex > index ? fxIndex - 1 : fxIndex] = forceFloat;
        }
        for (const auto& [fxIndex, bypassed] : trackFXBypassedState)
        {
            if (fxIndex == index)
                continue;
            updatedBypass[fxIndex > index ? fxIndex - 1 : fxIndex] = bypassed;
        }
        trackFXForceFloatOverrides = std::move(updatedOverrides);
        trackFXBypassedState = std::move(updatedBypass);
        remapPluginAutomationRoutesForRemoval(false, index);
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Removed Track FX at index " + juce::String(index));
    }
}

void TrackProcessor::bypassInputFX(int index, bool bypassed)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (index >= 0 && index < (int)inputFXPlugins.size())
    {
        const bool wasBypassed =
            inputFXBypassedState.count(index) > 0
            && inputFXBypassedState.at(index);
        if (wasBypassed && ! bypassed)
        {
            if (auto& processor =
                    inputFXPlugins[static_cast<size_t>(index)])
            {
                // reset() is intentionally performed on the control thread
                // under the processor lock. The callback uses a try-lock, so
                // an arbitrary hosted plugin can never block the audio thread
                // or resume with a frozen delay/detector endpoint.
                const juce::ScopedLock pluginGuard(
                    processor->getCallbackLock());
                processor->reset();
            }
        }
        if (bypassed)
            inputFXBypassedState[index] = true;
        else
            inputFXBypassedState.erase(index);
    }

    publishRealtimeStateSnapshots();
}

void TrackProcessor::bypassTrackFX(int index, bool bypassed)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (index >= 0 && index < (int)trackFXPlugins.size())
    {
        const bool wasBypassed =
            trackFXBypassedState.count(index) > 0
            && trackFXBypassedState.at(index);
        if (wasBypassed && ! bypassed)
        {
            if (auto& processor =
                    trackFXPlugins[static_cast<size_t>(index)])
            {
                const juce::ScopedLock pluginGuard(
                    processor->getCallbackLock());
                processor->reset();
            }
        }
        if (bypassed)
            trackFXBypassedState[index] = true;
        else
            trackFXBypassedState.erase(index);
    }

    publishRealtimeStateSnapshots();
}

int TrackProcessor::getNumInputFX() const
{
    return (int)inputFXPlugins.size();
}

int TrackProcessor::getNumTrackFX() const
{
    return (int)trackFXPlugins.size();
}

int TrackProcessor::getNumSends() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr ? static_cast<int>(graph->sends.size()) : 0;
}

juce::AudioProcessor* TrackProcessor::getInputFXProcessor(int index)
{
    if (index >= 0 && index < (int)inputFXPlugins.size())
        return inputFXPlugins[index].get();
    return nullptr;
}

const juce::AudioProcessor* TrackProcessor::getInputFXProcessor(int index) const
{
    if (index >= 0 && index < (int)inputFXPlugins.size())
        return inputFXPlugins[index].get();
    return nullptr;
}

juce::AudioProcessor* TrackProcessor::getTrackFXProcessor(int index)
{
    if (index >= 0 && index < (int)trackFXPlugins.size())
        return trackFXPlugins[index].get();
    return nullptr;
}

const juce::AudioProcessor* TrackProcessor::getTrackFXProcessor(int index) const
{
    if (index >= 0 && index < (int)trackFXPlugins.size())
        return trackFXPlugins[index].get();
    return nullptr;
}

std::shared_ptr<juce::AudioProcessor> TrackProcessor::getInputFXProcessorShared(int index) const
{
    if (index >= 0 && index < (int)inputFXPlugins.size())
        return inputFXPlugins[static_cast<size_t>(index)];
    return {};
}

std::shared_ptr<juce::AudioProcessor> TrackProcessor::getTrackFXProcessorShared(int index) const
{
    if (index >= 0 && index < (int)trackFXPlugins.size())
        return trackFXPlugins[static_cast<size_t>(index)];
    return {};
}

std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> TrackProcessor::getInputFXSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr
        ? std::shared_ptr<const ProcessorSnapshot>(graph, &graph->inputFX)
        : std::shared_ptr<const ProcessorSnapshot>();
}

std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> TrackProcessor::getTrackFXSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr
        ? std::shared_ptr<const ProcessorSnapshot>(graph, &graph->trackFX)
        : std::shared_ptr<const ProcessorSnapshot>();
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getInputFXBypassSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr
        ? std::shared_ptr<const BypassSnapshot>(graph, &graph->inputFXBypass)
        : std::shared_ptr<const BypassSnapshot>();
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getTrackFXBypassSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr
        ? std::shared_ptr<const BypassSnapshot>(graph, &graph->trackFXBypass)
        : std::shared_ptr<const BypassSnapshot>();
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getInputFXPrecisionOverrideSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr
        ? std::shared_ptr<const PrecisionOverrideSnapshot>(
              graph, &graph->inputFXPrecisionOverrides)
        : std::shared_ptr<const PrecisionOverrideSnapshot>();
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getTrackFXPrecisionOverrideSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr
        ? std::shared_ptr<const PrecisionOverrideSnapshot>(
              graph, &graph->trackFXPrecisionOverrides)
        : std::shared_ptr<const PrecisionOverrideSnapshot>();
}

bool TrackProcessor::reorderInputFX(int fromIndex, int toIndex)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (fromIndex < 0 || fromIndex >= (int)inputFXPlugins.size() ||
        toIndex < 0 || toIndex >= (int)inputFXPlugins.size() ||
        fromIndex == toIndex)
        return false;

    auto plugin = std::move(inputFXPlugins[fromIndex]);
    inputFXPlugins.erase(inputFXPlugins.begin() + fromIndex);
    inputFXPlugins.insert(inputFXPlugins.begin() + toIndex, std::move(plugin));
    std::map<int, bool> updatedOverrides;
    std::map<int, bool> updatedBypass;
    for (const auto& [fxIndex, forceFloat] : inputFXForceFloatOverrides)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedOverrides[newIndex] = forceFloat;
    }
    for (const auto& [fxIndex, bypassed] : inputFXBypassedState)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedBypass[newIndex] = bypassed;
    }
    inputFXForceFloatOverrides = std::move(updatedOverrides);
    inputFXBypassedState = std::move(updatedBypass);
    remapPluginAutomationRoutesForReorder(true, fromIndex, toIndex);
    publishRealtimeStateSnapshots();

    juce::Logger::writeToLog("TrackProcessor: Reordered input FX from " +
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
}

bool TrackProcessor::reorderTrackFX(int fromIndex, int toIndex)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (fromIndex < 0 || fromIndex >= (int)trackFXPlugins.size() ||
        toIndex < 0 || toIndex >= (int)trackFXPlugins.size() ||
        fromIndex == toIndex)
        return false;

    auto plugin = std::move(trackFXPlugins[fromIndex]);
    trackFXPlugins.erase(trackFXPlugins.begin() + fromIndex);
    trackFXPlugins.insert(trackFXPlugins.begin() + toIndex, std::move(plugin));
    std::map<int, bool> updatedOverrides;
    std::map<int, bool> updatedBypass;
    for (const auto& [fxIndex, forceFloat] : trackFXForceFloatOverrides)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedOverrides[newIndex] = forceFloat;
    }
    for (const auto& [fxIndex, bypassed] : trackFXBypassedState)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedBypass[newIndex] = bypassed;
    }
    trackFXForceFloatOverrides = std::move(updatedOverrides);
    trackFXBypassedState = std::move(updatedBypass);
    remapPluginAutomationRoutesForReorder(false, fromIndex, toIndex);
    if (araFXIndex == fromIndex)
        araFXIndex = toIndex;
    else if (fromIndex < toIndex && araFXIndex > fromIndex && araFXIndex <= toIndex)
        --araFXIndex;
    else if (fromIndex > toIndex && araFXIndex >= toIndex && araFXIndex < fromIndex)
        ++araFXIndex;
    if (araFXIndexForRealtime.load(
            std::memory_order_acquire) >= 0)
    {
        araFXIndexForRealtime.store(
            araFXIndex,
            std::memory_order_release);
    }
    publishRealtimeStateSnapshots();

    juce::Logger::writeToLog("TrackProcessor: Reordered track FX from " +
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
}

//==============================================================================
// Sidechain Routing (Phase 4.4)

void TrackProcessor::setSidechainSource(int pluginIndex, const juce::String& sourceTrackId)
{
    sidechainSources[pluginIndex] = sourceTrackId;
    publishRealtimeStateSnapshots();
    juce::Logger::writeToLog("TrackProcessor: Set sidechain source for FX[" +
                             juce::String(pluginIndex) + "] = " + sourceTrackId);
}

void TrackProcessor::clearSidechainSource(int pluginIndex)
{
    sidechainSources.erase(pluginIndex);
    publishRealtimeStateSnapshots();
    juce::Logger::writeToLog("TrackProcessor: Cleared sidechain source for FX[" +
                             juce::String(pluginIndex) + "]");
}

juce::String TrackProcessor::getSidechainSource(int pluginIndex) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph != nullptr)
    {
        const auto it = graph->sidechainSources.find(pluginIndex);
        if (it != graph->sidechainSources.end())
            return it->second;
    }
    return {};
}

void TrackProcessor::setSidechainBuffer(const juce::AudioBuffer<float>* buffer)
{
    sidechainInputBuffer = buffer;
}

bool TrackProcessor::hasAnySidechainSources() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return graph != nullptr && !graph->sidechainSources.empty();
}

//==============================================================================
// Send Management (Phase 4 / Phase 11)

int TrackProcessor::addSend(const juce::String& destTrackId)
{
    SendConfig cfg;
    cfg.destTrackId = destTrackId;
    cfg.level = 0.5f;
    cfg.pan = 0.0f;
    cfg.enabled = true;
    cfg.preFader = false;
    sends.push_back(cfg);
    publishRealtimeStateSnapshots();
    juce::Logger::writeToLog("TrackProcessor: Added send to " + destTrackId + " (index " + juce::String(sends.size() - 1) + ")");
    return static_cast<int>(sends.size()) - 1;
}

void TrackProcessor::removeSend(int sendIndex)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends.erase(sends.begin() + sendIndex);
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Removed send at index " + juce::String(sendIndex));
    }
}

void TrackProcessor::setSendLevel(int sendIndex, float level)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].level = juce::jlimit(0.0f, 1.0f, level);
        publishRealtimeStateSnapshots();
    }
}

void TrackProcessor::setSendPan(int sendIndex, float pan)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].pan = juce::jlimit(-1.0f, 1.0f, pan);
        publishRealtimeStateSnapshots();
    }
}

void TrackProcessor::setSendEnabled(int sendIndex, bool enabled)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].enabled = enabled;
        publishRealtimeStateSnapshots();
    }
}

void TrackProcessor::setSendPreFader(int sendIndex, bool preFader)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].preFader = preFader;
        publishRealtimeStateSnapshots();
    }
}

juce::String TrackProcessor::getSendDestination(int sendIndex) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph != nullptr
        && sendIndex >= 0
        && sendIndex < static_cast<int>(graph->sends.size()))
    {
        return graph->sends[static_cast<size_t>(sendIndex)].destTrackId;
    }
    return {};
}

float TrackProcessor::getSendLevel(int sendIndex) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph != nullptr
        && sendIndex >= 0
        && sendIndex < static_cast<int>(graph->sends.size()))
    {
        return graph->sends[static_cast<size_t>(sendIndex)].level;
    }
    return 0.0f;
}

float TrackProcessor::getSendPan(int sendIndex) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph != nullptr
        && sendIndex >= 0
        && sendIndex < static_cast<int>(graph->sends.size()))
    {
        return graph->sends[static_cast<size_t>(sendIndex)].pan;
    }
    return 0.0f;
}

bool TrackProcessor::getSendEnabled(int sendIndex) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph != nullptr
        && sendIndex >= 0
        && sendIndex < static_cast<int>(graph->sends.size()))
    {
        return graph->sends[static_cast<size_t>(sendIndex)].enabled;
    }
    return false;
}

bool TrackProcessor::getSendPreFader(int sendIndex) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph != nullptr
        && sendIndex >= 0
        && sendIndex < static_cast<int>(graph->sends.size()))
    {
        return graph->sends[static_cast<size_t>(sendIndex)].preFader;
    }
    return false;
}

void TrackProcessor::fillSendBuffer(int sendIndex, const juce::AudioBuffer<float>& preFaderBuf,
                                    const juce::AudioBuffer<float>& postFaderBuf,
                                    juce::AudioBuffer<float>& destBuffer, int numSamples) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph == nullptr
        || sendIndex < 0
        || sendIndex >= static_cast<int>(graph->sends.size()))
    {
        return;
    }
    const auto& send = graph->sends[static_cast<size_t>(sendIndex)];
    if (!send.enabled || send.level <= 0.0f) return;

    const auto& srcBuf = send.preFader ? preFaderBuf : postFaderBuf;
    const int srcChannels = srcBuf.getNumChannels();
    const int destChannels = destBuffer.getNumChannels();

    // Apply send level, pan, and optional phase invert, mix into dest
    const float level = send.level;
    const float phaseMultiplier = send.phaseInvert ? -1.0f : 1.0f;
    const float pi = juce::MathConstants<float>::pi;
    float panAngle = (send.pan + 1.0f) * pi / 4.0f;
    float leftGain = std::cos(panAngle) * level * phaseMultiplier;
    float rightGain = std::sin(panAngle) * level * phaseMultiplier;

    if (destChannels >= 2 && srcChannels >= 2)
    {
        for (int s = 0; s < numSamples; ++s)
        {
            destBuffer.getWritePointer(0)[s] += srcBuf.getReadPointer(0)[s] * leftGain;
            destBuffer.getWritePointer(1)[s] += srcBuf.getReadPointer(1)[s] * rightGain;
        }
    }
    else if (destChannels >= 1 && srcChannels >= 1)
    {
        for (int s = 0; s < numSamples; ++s)
            destBuffer.getWritePointer(0)[s] += srcBuf.getReadPointer(0)[s] * level;
    }
}

//==============================================================================
// MIDI & Instrument (Phase 2)

void TrackProcessor::setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin,
                                   double callerSampleRate, int callerBlockSize)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (plugin)
    {
        double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
        int bs = getSafeHostedPluginBlockSize(callerBlockSize > 0 ? callerBlockSize : getBlockSize());
        if (sr <= 0) sr = 44100.0;
        if (bs <= 0) bs = kMinimumHostedPluginBlockSize;

        preparePluginPreservingLayout(plugin.get(), sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode,
                                                                 instrumentForceFloatOverride.load(std::memory_order_acquire)));
        fallbackInstrumentResetRequested.store(true, std::memory_order_release);
        instrumentPlugin = std::shared_ptr<juce::AudioPluginInstance>(std::move(plugin));
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Instrument plugin loaded");
    }
}

void TrackProcessor::clearInstrument()
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    queueAllNotesOff();
    fallbackInstrumentResetRequested.store(true, std::memory_order_release);
    instrumentPlugin.reset();
    instrumentForceFloatOverride.store(false, std::memory_order_release);
    publishRealtimeStateSnapshots();
    juce::Logger::writeToLog("TrackProcessor: Instrument plugin removed");
}

bool TrackProcessor::isUsingFallbackInstrument() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    return trackType.load(std::memory_order_acquire) == TrackType::Instrument
        && (graph == nullptr || graph->instrument == nullptr);
}

void TrackProcessor::publishFallbackSamplerSample(
    std::shared_ptr<const FallbackSamplerSample> sample)
{
    const juce::ScopedLock publicationGuard(
        realtimeAuxPublicationLock);
    reclaimRetiredRealtimeAuxOwners();
    const auto previous = std::atomic_load_explicit(
        &fallbackSamplerSample,
        std::memory_order_acquire);
    {
        const juce::ScopedLock retirementGuard(
            realtimeAuxRetirementLock);
        if (previous != nullptr
            && previous.get() != sample.get())
        {
            retiredRealtimeAuxOwners.push_back(
                std::static_pointer_cast<const void>(
                    previous));
        }
        std::atomic_store_explicit(
            &fallbackSamplerSample,
            sample,
            std::memory_order_release);
        fallbackSamplerSampleForAudio.store(
            sample.get(),
            std::memory_order_seq_cst);
    }
}

bool TrackProcessor::loadFallbackSamplerSample(const juce::String& filePath, int rootNote)
{
    const juce::File sampleFile(filePath);
    if (!sampleFile.existsAsFile())
        return false;

    if (sampleFile.getFileExtension().toLowerCase() == ".sf2")
    {
        juce::MemoryBlock soundFontData;
        if (!sampleFile.loadFileAsData(soundFontData) || soundFontData.getSize() < 12)
            return false;

        const auto* bytes = static_cast<const juce::uint8*>(soundFontData.getData());
        const size_t byteCount = soundFontData.getSize();

        auto matchesFourCC = [] (const juce::uint8* ptr, const char* text)
        {
            return ptr[0] == static_cast<juce::uint8>(text[0])
                && ptr[1] == static_cast<juce::uint8>(text[1])
                && ptr[2] == static_cast<juce::uint8>(text[2])
                && ptr[3] == static_cast<juce::uint8>(text[3]);
        };

        auto readI16 = [] (const juce::uint8* ptr) -> int
        {
            const int raw = static_cast<int>(ptr[0]) | (static_cast<int>(ptr[1]) << 8);
            return raw >= 32768 ? raw - 65536 : raw;
        };

        auto readU32 = [] (const juce::uint8* ptr) -> juce::uint32
        {
            return static_cast<juce::uint32>(ptr[0])
                | (static_cast<juce::uint32>(ptr[1]) << 8)
                | (static_cast<juce::uint32>(ptr[2]) << 16)
                | (static_cast<juce::uint32>(ptr[3]) << 24);
        };

        struct SoundFontSampleHeader
        {
            juce::uint32 start = 0;
            juce::uint32 end = 0;
            juce::uint32 sampleRate = 44100;
            int originalPitch = 60;
        };

        const juce::uint8* smplChunk = nullptr;
        size_t smplChunkBytes = 0;
        std::vector<SoundFontSampleHeader> sampleHeaders;

        auto scanListChunks = [&] (const juce::uint8* listBytes, size_t listBytesCount)
        {
            for (size_t offset = 0; offset + 8 <= listBytesCount;)
            {
                const auto* chunk = listBytes + offset;
                const auto chunkSize = static_cast<size_t>(readU32(chunk + 4));
                const size_t chunkDataOffset = offset + 8;
                if (chunkDataOffset > listBytesCount || chunkSize > listBytesCount - chunkDataOffset)
                    break;

                const auto* chunkData = listBytes + chunkDataOffset;
                if (matchesFourCC(chunk, "smpl"))
                {
                    smplChunk = chunkData;
                    smplChunkBytes = chunkSize;
                }
                else if (matchesFourCC(chunk, "shdr"))
                {
                    constexpr size_t headerBytes = 46;
                    for (size_t headerOffset = 0; headerOffset + headerBytes <= chunkSize; headerOffset += headerBytes)
                    {
                        const auto* header = chunkData + headerOffset;
                        const auto start = readU32(header + 20);
                        const auto end = readU32(header + 24);
                        const auto sampleRate = readU32(header + 32);
                        const int originalPitch = static_cast<int>(header[40]);

                        if (end > start)
                        {
                            sampleHeaders.push_back({
                                start,
                                end,
                                sampleRate > 0 ? sampleRate : static_cast<juce::uint32>(44100),
                                juce::jlimit(0, 127, originalPitch),
                            });
                        }
                    }
                }

                offset = chunkDataOffset + chunkSize + (chunkSize & 1u);
            }
        };

        if (!matchesFourCC(bytes, "RIFF") || !matchesFourCC(bytes + 8, "sfbk"))
            return false;

        for (size_t offset = 12; offset + 12 <= byteCount;)
        {
            const auto* chunk = bytes + offset;
            const auto chunkSize = static_cast<size_t>(readU32(chunk + 4));
            const size_t chunkDataOffset = offset + 8;
            if (chunkDataOffset > byteCount || chunkSize > byteCount - chunkDataOffset)
                break;

            const auto* chunkData = bytes + chunkDataOffset;
            if (matchesFourCC(chunk, "LIST") && chunkSize >= 4)
                scanListChunks(chunkData + 4, chunkSize - 4);

            offset = chunkDataOffset + chunkSize + (chunkSize & 1u);
        }

        const auto smplSampleCount = smplChunkBytes / 2;
        const SoundFontSampleHeader* selectedHeader = nullptr;
        for (const auto& header : sampleHeaders)
        {
            if (header.end > header.start + 8 && header.end <= smplSampleCount)
            {
                selectedHeader = &header;
                break;
            }
        }

        if (smplChunk == nullptr || selectedHeader == nullptr)
            return false;

        const double sourceSampleRate = selectedHeader->sampleRate > 0
            ? static_cast<double>(selectedHeader->sampleRate)
            : 44100.0;
        const auto availableSamples = static_cast<size_t>(selectedHeader->end - selectedHeader->start);
        const auto maxSamples = static_cast<size_t>(juce::jmax(1.0, sourceSampleRate) * 60.0);
        const int samplesToRead = static_cast<int>(
            std::max<size_t>(1, std::min(availableSamples, maxSamples)));

        auto sample = std::make_shared<FallbackSamplerSample>();
        sample->samples.setSize(1, samplesToRead);
        sample->samples.clear();
        sample->sourceSampleRate = sourceSampleRate;
        sample->rootNote = juce::jlimit(0, 127, rootNote >= 0 ? rootNote : selectedHeader->originalPitch);
        sample->filePath = sampleFile.getFullPathName();

        const auto startSample = static_cast<size_t>(selectedHeader->start);
        for (int sampleIndex = 0; sampleIndex < samplesToRead; ++sampleIndex)
        {
            const auto sourceOffset = (startSample + static_cast<size_t>(sampleIndex)) * 2;
            sample->samples.setSample(0, sampleIndex,
                                      static_cast<float>(readI16(smplChunk + sourceOffset)) / 32768.0f);
        }

        const juce::ScopedLock processorCallbackGuard(getCallbackLock());
        publishFallbackSamplerSample(
            std::static_pointer_cast<const FallbackSamplerSample>(
                sample));
        clearFallbackInstrumentState();
        fallbackInstrumentResetRequested.store(true, std::memory_order_release);
        juce::Logger::writeToLog("TrackProcessor: Loaded fallback SoundFont sample "
                                 + sampleFile.getFullPathName());
        return true;
    }

    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(sampleFile));
    if (reader == nullptr || reader->lengthInSamples <= 0 || reader->numChannels <= 0)
        return false;

    const auto maxSamples = static_cast<juce::int64>(
        juce::jmax(1.0, reader->sampleRate) * 60.0);
    const int samplesToRead = static_cast<int>(
        std::min<juce::int64>(reader->lengthInSamples, maxSamples));
    const int channelsToRead = juce::jlimit(1, 2, static_cast<int>(reader->numChannels));

    auto sample = std::make_shared<FallbackSamplerSample>();
    sample->samples.setSize(channelsToRead, samplesToRead);
    sample->samples.clear();
    sample->sourceSampleRate = reader->sampleRate > 0.0 ? reader->sampleRate : 44100.0;
    sample->rootNote = juce::jlimit(0, 127, rootNote);
    sample->filePath = sampleFile.getFullPathName();

    if (!reader->read(&sample->samples, 0, samplesToRead, 0, true, true))
        return false;

    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    publishFallbackSamplerSample(
        std::static_pointer_cast<const FallbackSamplerSample>(
            sample));
    clearFallbackInstrumentState();
    fallbackInstrumentResetRequested.store(true, std::memory_order_release);
    juce::Logger::writeToLog("TrackProcessor: Loaded fallback sampler sample " + sampleFile.getFullPathName());
    return true;
}

void TrackProcessor::clearFallbackSamplerSample()
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    publishFallbackSamplerSample(nullptr);
    clearFallbackInstrumentState();
    fallbackInstrumentResetRequested.store(true, std::memory_order_release);
}

bool TrackProcessor::hasFallbackSamplerSample() const
{
    auto sample = std::atomic_load_explicit(&fallbackSamplerSample, std::memory_order_acquire);
    return sample != nullptr && sample->samples.getNumSamples() > 0;
}

juce::String TrackProcessor::getFallbackSamplerSamplePath() const
{
    auto sample = std::atomic_load_explicit(&fallbackSamplerSample, std::memory_order_acquire);
    return sample != nullptr ? sample->filePath : juce::String();
}

void TrackProcessor::clearFallbackInstrumentState()
{
    for (auto& channelNotes : fallbackInstrumentNoteActive)
        channelNotes.fill(false);
    for (auto& channelNotes : fallbackInstrumentNoteReleasing)
        channelNotes.fill(false);
    for (auto& channelPhases : fallbackInstrumentPhase)
        channelPhases.fill(0.0f);
    for (auto& channelPhases : fallbackInstrumentPhaseB)
        channelPhases.fill(0.0f);
    for (auto& channelPhases : fallbackInstrumentSubPhase)
        channelPhases.fill(0.0f);
    for (auto& channelFilters : fallbackInstrumentFilterState)
        channelFilters.fill(0.0f);
    for (auto& channelVelocities : fallbackInstrumentVelocity)
        channelVelocities.fill(0.0f);
    for (auto& channelEnvelopes : fallbackInstrumentEnvelope)
        channelEnvelopes.fill(0.0f);
    for (auto& channelAges : fallbackInstrumentVoiceAgeSamples)
        channelAges.fill(0);
    for (auto& channelPositions : fallbackSamplerPosition)
        channelPositions.fill(0.0);
    for (auto& channelIncrements : fallbackSamplerIncrement)
        channelIncrements.fill(0.0);
    fallbackInstrumentPitchBend.fill(0.0f);
    fallbackInstrumentModulation.fill(0.0f);
    fallbackInstrumentModPhase.fill(0.0f);
}

float TrackProcessor::getFallbackInstrumentParam(const juce::String& paramId) const
{
    if (paramId == "attackMs") return fallbackSynthAttackMs.load(std::memory_order_relaxed);
    if (paramId == "releaseMs") return fallbackSynthReleaseMs.load(std::memory_order_relaxed);
    if (paramId == "brightness") return fallbackSynthBrightness.load(std::memory_order_relaxed);
    if (paramId == "detuneCents") return fallbackSynthDetuneCents.load(std::memory_order_relaxed);
    if (paramId == "subLevel") return fallbackSynthSubLevel.load(std::memory_order_relaxed);
    if (paramId == "noiseLevel") return fallbackSynthNoiseLevel.load(std::memory_order_relaxed);
    if (paramId == "outputGainDb") return fallbackSynthOutputGainDb.load(std::memory_order_relaxed);
    if (paramId == "instrumentMode") return fallbackInstrumentMode.load(std::memory_order_relaxed);
    if (paramId == "pianoTone") return fallbackPianoTone.load(std::memory_order_relaxed);
    if (paramId == "pianoBody") return fallbackPianoBody.load(std::memory_order_relaxed);
    if (paramId == "drumKit") return fallbackDrumKit.load(std::memory_order_relaxed);
    if (paramId == "drumTuning") return fallbackDrumTuning.load(std::memory_order_relaxed);
    if (paramId == "drumAmbience") return fallbackDrumAmbience.load(std::memory_order_relaxed);
    return 0.0f;
}

bool TrackProcessor::setFallbackInstrumentParam(const juce::String& paramId, float value)
{
    if (paramId == "attackMs")
    {
        fallbackSynthAttackMs.store(juce::jlimit(0.5f, 2000.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "releaseMs")
    {
        fallbackSynthReleaseMs.store(juce::jlimit(5.0f, 5000.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "brightness")
    {
        fallbackSynthBrightness.store(juce::jlimit(0.0f, 1.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "detuneCents")
    {
        fallbackSynthDetuneCents.store(juce::jlimit(0.0f, 35.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "subLevel")
    {
        fallbackSynthSubLevel.store(juce::jlimit(0.0f, 0.8f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "noiseLevel")
    {
        fallbackSynthNoiseLevel.store(juce::jlimit(0.0f, 0.25f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "outputGainDb")
    {
        fallbackSynthOutputGainDb.store(juce::jlimit(-36.0f, 0.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "instrumentMode")
    {
        fallbackInstrumentMode.store(juce::jlimit(0.0f, 2.0f, std::round(value)), std::memory_order_relaxed);
        fallbackInstrumentResetRequested.store(true, std::memory_order_release);
        return true;
    }
    if (paramId == "pianoTone")
    {
        fallbackPianoTone.store(juce::jlimit(0.0f, 1.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "pianoBody")
    {
        fallbackPianoBody.store(juce::jlimit(0.0f, 1.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "drumKit")
    {
        fallbackDrumKit.store(juce::jlimit(0.0f, 2.0f, std::round(value)), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "drumTuning")
    {
        fallbackDrumTuning.store(juce::jlimit(-12.0f, 12.0f, value), std::memory_order_relaxed);
        return true;
    }
    if (paramId == "drumAmbience")
    {
        fallbackDrumAmbience.store(juce::jlimit(0.0f, 1.0f, value), std::memory_order_relaxed);
        return true;
    }

    return false;
}

bool TrackProcessor::hasActiveFallbackInstrumentVoices() const
{
    for (size_t channel = 0; channel < fallbackInstrumentEnvelope.size(); ++channel)
    {
        for (size_t note = 0; note < fallbackInstrumentEnvelope[channel].size(); ++note)
        {
            if (fallbackInstrumentNoteActive[channel][note]
                || fallbackInstrumentNoteReleasing[channel][note]
                || fallbackInstrumentEnvelope[channel][note] > 0.0001f)
                return true;
        }
    }
    return false;
}

void TrackProcessor::handleFallbackInstrumentMidi(const juce::MidiMessage& message, double sampleRate)
{
    const int channelIndex = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);

    if (message.isNoteOn())
    {
        const auto* const samplerSample =
            fallbackSamplerSampleForAudio.load(
                std::memory_order_seq_cst);
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        fallbackInstrumentNoteActive[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = true;
        fallbackInstrumentNoteReleasing[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = false;
        fallbackInstrumentVelocity[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)]
            = static_cast<float>(message.getVelocity()) / 127.0f;
        fallbackInstrumentPhase[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = 0.0f;
        fallbackInstrumentPhaseB[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = 0.13f;
        fallbackInstrumentSubPhase[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = 0.31f;
        fallbackInstrumentFilterState[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = 0.0f;
        fallbackInstrumentEnvelope[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)]
            = fallbackInstrumentMode.load(std::memory_order_relaxed) >= 1.5f ? 1.0f : 0.0f;
        fallbackInstrumentVoiceAgeSamples[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = 0;
        fallbackSamplerPosition[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = 0.0;
        fallbackSamplerIncrement[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)]
            = samplerSample != nullptr && sampleRate > 0.0
                ? (samplerSample->sourceSampleRate / sampleRate)
                    * std::pow(2.0, (static_cast<double>(note - samplerSample->rootNote)) / 12.0)
                : 0.0;
        return;
    }

    if (message.isNoteOff())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        fallbackInstrumentNoteReleasing[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = true;
        return;
    }

    if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (int note = 0; note < 128; ++note)
            fallbackInstrumentNoteReleasing[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = true;
        return;
    }

    if (message.isController())
    {
        const int controller = message.getControllerNumber();
        if (controller == 1)
        {
            fallbackInstrumentModulation[static_cast<size_t>(channelIndex)]
                = static_cast<float>(message.getControllerValue()) / 127.0f;
            return;
        }
        if (controller == 121)
        {
            fallbackInstrumentModulation[static_cast<size_t>(channelIndex)] = 0.0f;
            fallbackInstrumentPitchBend[static_cast<size_t>(channelIndex)] = 0.0f;
            return;
        }
        if (controller == 120 || controller == 123)
        {
            for (int note = 0; note < 128; ++note)
                fallbackInstrumentNoteReleasing[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = true;
        }
        return;
    }

    if (message.isPitchWheel())
    {
        const float normalized = (static_cast<float>(message.getPitchWheelValue()) - 8192.0f) / 8192.0f;
        fallbackInstrumentPitchBend[static_cast<size_t>(channelIndex)] = juce::jlimit(-1.0f, 1.0f, normalized);
    }
}

void TrackProcessor::renderFallbackInstrument(juce::AudioBuffer<float>& buffer,
                                              const juce::MidiBuffer& midiMessages,
                                              int numSamples,
                                              double sampleRate)
{
    if (numSamples <= 0 || sampleRate <= 0.0 || buffer.getNumChannels() <= 0)
        return;

    if (fallbackInstrumentResetRequested.exchange(false, std::memory_order_acq_rel))
        clearFallbackInstrumentState();

    const int bufferChannels = buffer.getNumChannels();
    const auto* const samplerSample =
        fallbackSamplerSampleForAudio.load(
            std::memory_order_seq_cst);
    const int instrumentMode = juce::jlimit(0, 2, static_cast<int>(std::round(fallbackInstrumentMode.load(std::memory_order_relaxed))));
    const bool useSampler = instrumentMode != 2
        && samplerSample != nullptr
        && samplerSample->samples.getNumSamples() > 1
        && samplerSample->samples.getNumChannels() > 0;
    const float attackMs = juce::jlimit(0.5f, 2000.0f, fallbackSynthAttackMs.load(std::memory_order_relaxed));
    const float releaseMs = juce::jlimit(5.0f, 5000.0f, fallbackSynthReleaseMs.load(std::memory_order_relaxed));
    const float attackStep = 1.0f / juce::jmax(1.0f, static_cast<float>(sampleRate) * attackMs * 0.001f);
    const float releaseStep = 1.0f / juce::jmax(1.0f, static_cast<float>(sampleRate) * releaseMs * 0.001f);
    const float brightness = juce::jlimit(0.0f, 1.0f, fallbackSynthBrightness.load(std::memory_order_relaxed));
    const float detuneCents = juce::jlimit(0.0f, 35.0f, fallbackSynthDetuneCents.load(std::memory_order_relaxed));
    const float detuneFactor = std::pow(2.0f, detuneCents / 1200.0f);
    const float subLevel = juce::jlimit(0.0f, 0.8f, fallbackSynthSubLevel.load(std::memory_order_relaxed));
    const float noiseLevel = juce::jlimit(0.0f, 0.25f, fallbackSynthNoiseLevel.load(std::memory_order_relaxed));
    const float pianoTone = juce::jlimit(0.0f, 1.0f, fallbackPianoTone.load(std::memory_order_relaxed));
    const float pianoBody = juce::jlimit(0.0f, 1.0f, fallbackPianoBody.load(std::memory_order_relaxed));
    const int drumKit = juce::jlimit(0, 2, static_cast<int>(std::round(fallbackDrumKit.load(std::memory_order_relaxed))));
    const float drumTuningFactor = std::pow(2.0f, juce::jlimit(-12.0f, 12.0f, fallbackDrumTuning.load(std::memory_order_relaxed)) / 12.0f);
    const float drumAmbience = juce::jlimit(0.0f, 1.0f, fallbackDrumAmbience.load(std::memory_order_relaxed));
    const float synthGain = useSampler
        ? 0.24f
        : juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, fallbackSynthOutputGainDb.load(std::memory_order_relaxed)));
    const float twoPi = juce::MathConstants<float>::twoPi;

    auto renderSegment = [&] (int startSample, int endSample)
    {
        if (endSample <= startSample)
            return;

        for (int sample = startSample; sample < endSample; ++sample)
        {
            float mixed = 0.0f;
            for (size_t channel = 0; channel < fallbackInstrumentNoteActive.size(); ++channel)
            {
                const float modulation = juce::jlimit(0.0f, 1.0f, fallbackInstrumentModulation[channel]);
                float& modulationPhase = fallbackInstrumentModPhase[channel];
                const float vibratoSemitones = std::sin(modulationPhase) * modulation * 0.35f;
                modulationPhase += twoPi * (5.2f + modulation * 1.8f) / static_cast<float>(sampleRate);
                if (modulationPhase >= twoPi)
                    modulationPhase -= twoPi;

                const float pitchBendFactor = std::pow(2.0f, ((fallbackInstrumentPitchBend[channel] * 2.0f) + vibratoSemitones) / 12.0f);
                for (size_t note = 0; note < fallbackInstrumentNoteActive[channel].size(); ++note)
                {
                    const bool isActive = fallbackInstrumentNoteActive[channel][note];
                    const bool isReleasing = fallbackInstrumentNoteReleasing[channel][note];
                    float& envelope = fallbackInstrumentEnvelope[channel][note];
                    int& voiceAge = fallbackInstrumentVoiceAgeSamples[channel][note];
                    if (!isActive && envelope <= 0.0f)
                        continue;

                    if (instrumentMode == 2)
                    {
                        const float ageSec = static_cast<float>(voiceAge) / static_cast<float>(sampleRate);
                        envelope = std::exp(-ageSec / getDrumDecaySeconds(static_cast<int>(note)));
                        if (envelope < 0.0002f)
                            envelope = 0.0f;
                    }
                    else if (instrumentMode == 1)
                    {
                        if (isActive && !isReleasing)
                            envelope = juce::jmin(1.0f, envelope + juce::jmax(attackStep, 1.0f / juce::jmax(1.0f, static_cast<float>(sampleRate) * 0.003f)));
                        else
                            envelope = juce::jmax(0.0f, envelope - releaseStep * 0.55f);
                    }
                    else if (isActive && !isReleasing)
                    {
                        envelope = juce::jmin(1.0f, envelope + attackStep);
                    }
                    else
                    {
                        envelope = juce::jmax(0.0f, envelope - releaseStep);
                    }

                    if (envelope <= 0.0f)
                    {
                        fallbackInstrumentNoteActive[channel][note] = false;
                        fallbackInstrumentNoteReleasing[channel][note] = false;
                        fallbackInstrumentVelocity[channel][note] = 0.0f;
                        continue;
                    }

                    if (instrumentMode == 2)
                    {
                        const int midiNote = static_cast<int>(note);
                        const float ageSec = static_cast<float>(voiceAge) / static_cast<float>(sampleRate);
                        float& phase = fallbackInstrumentPhase[channel][note];
                        const float baseFreq = getDrumBaseFrequency(midiNote) * drumTuningFactor;
                        const float sweep = (midiNote == 35 || midiNote == 36) ? std::exp(-ageSec / 0.035f) * 72.0f : 0.0f;
                        const float freq = juce::jlimit(20.0f, 8000.0f, baseFreq + sweep);
                        phase += freq / static_cast<float>(sampleRate);
                        if (phase >= 1.0f)
                            phase -= std::floor(phase);

                        const float noise = fastNoise(voiceAge, midiNote);
                        float drum = 0.0f;
                        if (midiNote == 35 || midiNote == 36)
                        {
                            const float body = std::sin(twoPi * phase) * std::exp(-ageSec / (drumKit == 1 ? 0.52f : 0.36f));
                            const float click = noise * std::exp(-ageSec / 0.012f) * (drumKit == 2 ? 0.38f : 0.18f);
                            drum = body * 1.18f + click;
                        }
                        else if (midiNote == 37 || midiNote == 38 || midiNote == 40)
                        {
                            const float snap = noise * std::exp(-ageSec / (drumKit == 1 ? 0.22f : 0.16f));
                            const float body = std::sin(twoPi * phase) * std::exp(-ageSec / 0.12f);
                            drum = snap * (drumKit == 2 ? 0.95f : 0.72f) + body * 0.34f;
                        }
                        else if (midiNote == 42 || midiNote == 44 || midiNote == 46)
                        {
                            const float metal = std::sin(twoPi * phase * 7.1f) * 0.24f + std::sin(twoPi * phase * 11.7f) * 0.18f;
                            drum = (noise * 0.78f + metal) * std::exp(-ageSec / getDrumDecaySeconds(midiNote));
                        }
                        else if (midiNote == 49 || midiNote == 51 || midiNote == 52 || midiNote == 53 || midiNote == 55 || midiNote == 57 || midiNote == 59)
                        {
                            const float shimmer = std::sin(twoPi * phase * 5.3f) * 0.15f + std::sin(twoPi * phase * 9.7f) * 0.12f;
                            drum = (noise * 0.64f + shimmer) * std::exp(-ageSec / getDrumDecaySeconds(midiNote));
                        }
                        else
                        {
                            const float body = std::sin(twoPi * phase) * std::exp(-ageSec / getDrumDecaySeconds(midiNote));
                            drum = body * 0.9f + noise * 0.08f * std::exp(-ageSec / 0.04f);
                        }

                        const float room = std::sin(twoPi * phase * 0.37f + static_cast<float>(midiNote)) * drumAmbience * 0.08f * std::exp(-ageSec / 0.9f);
                        mixed += (drum + room) * fallbackInstrumentVelocity[channel][note] * 0.34f;
                        ++voiceAge;
                    }
                    else if (useSampler)
                    {
                        double& samplePosition = fallbackSamplerPosition[channel][note];
                        const int sourceLength = samplerSample->samples.getNumSamples();
                        if (samplePosition >= static_cast<double>(sourceLength - 1))
                        {
                            fallbackInstrumentNoteActive[channel][note] = false;
                            fallbackInstrumentNoteReleasing[channel][note] = false;
                            fallbackInstrumentVelocity[channel][note] = 0.0f;
                            envelope = 0.0f;
                            continue;
                        }

                        const int index = juce::jlimit(0, sourceLength - 2, static_cast<int>(samplePosition));
                        const float frac = static_cast<float>(samplePosition - static_cast<double>(index));
                        const int sourceChannels = samplerSample->samples.getNumChannels();
                        float sampleValue = 0.0f;
                        for (int sourceChannel = 0; sourceChannel < sourceChannels; ++sourceChannel)
                        {
                            const int i0 = juce::jlimit(0, sourceLength - 1, index - 1);
                            const int i1 = juce::jlimit(0, sourceLength - 1, index);
                            const int i2 = juce::jlimit(0, sourceLength - 1, index + 1);
                            const int i3 = juce::jlimit(0, sourceLength - 1, index + 2);
                            sampleValue += cubicInterpolate(samplerSample->samples.getSample(sourceChannel, i0),
                                                            samplerSample->samples.getSample(sourceChannel, i1),
                                                            samplerSample->samples.getSample(sourceChannel, i2),
                                                            samplerSample->samples.getSample(sourceChannel, i3),
                                                            frac);
                        }
                        sampleValue /= static_cast<float>(sourceChannels);
                        mixed += sampleValue * envelope * fallbackInstrumentVelocity[channel][note] * synthGain;
                        samplePosition += fallbackSamplerIncrement[channel][note] * static_cast<double>(pitchBendFactor);
                        ++voiceAge;
                    }
                    else if (instrumentMode == 1)
                    {
                        const float frequency = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(static_cast<int>(note))) * pitchBendFactor;
                        const float phaseDelta = juce::jlimit(0.0f, 0.49f, frequency / static_cast<float>(sampleRate));
                        float& phase = fallbackInstrumentPhase[channel][note];
                        const float ageSec = static_cast<float>(voiceAge) / static_cast<float>(sampleRate);
                        const float noteBright = juce::jlimit(0.35f, 1.35f, 0.72f + (static_cast<float>(note) - 60.0f) * 0.008f);
                        const float decay = std::exp(-ageSec / (0.85f + pianoBody * 2.6f + (1.0f - noteBright) * 0.4f));
                        const float hammer = fastNoise(voiceAge, static_cast<int>(note)) * std::exp(-ageSec / 0.012f) * (0.03f + pianoTone * 0.05f);
                        const float fundamental = std::sin(twoPi * phase) * (0.82f + pianoBody * 0.28f);
                        const float partial2 = std::sin(twoPi * phase * 2.003f) * (0.24f + pianoTone * 0.20f) * std::exp(-ageSec / 1.1f);
                        const float partial3 = std::sin(twoPi * phase * 3.011f) * (0.13f + pianoTone * 0.15f) * std::exp(-ageSec / 0.74f);
                        const float partial5 = std::sin(twoPi * phase * 5.031f) * (0.04f + pianoTone * 0.08f) * std::exp(-ageSec / 0.42f);
                        const float piano = (fundamental + partial2 + partial3 + partial5 + hammer) * decay;
                        mixed += piano * envelope * fallbackInstrumentVelocity[channel][note] * synthGain * 0.92f;

                        phase += phaseDelta;
                        if (phase >= 1.0f)
                            phase -= std::floor(phase);
                        ++voiceAge;
                    }
                    else
                    {
                        const float frequency = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(static_cast<int>(note))) * pitchBendFactor;
                        const float phaseDeltaA = juce::jlimit(0.0f, 0.49f, frequency / static_cast<float>(sampleRate));
                        const float phaseDeltaB = juce::jlimit(0.0f, 0.49f, (frequency * detuneFactor) / static_cast<float>(sampleRate));
                        const float subDelta = juce::jlimit(0.0f, 0.49f, (frequency * 0.5f) / static_cast<float>(sampleRate));
                        float& phaseA = fallbackInstrumentPhase[channel][note];
                        float& phaseB = fallbackInstrumentPhaseB[channel][note];
                        float& subPhase = fallbackInstrumentSubPhase[channel][note];
                        float& filterState = fallbackInstrumentFilterState[channel][note];

                        const float sawA = polyBlepSaw(phaseA, phaseDeltaA);
                        const float sawB = polyBlepSaw(phaseB, phaseDeltaB);
                        const float pulseWidth = 0.48f + 0.12f * std::sin(modulationPhase + static_cast<float>(note) * 0.07f);
                        const float square = polyBlepSquare(phaseA, phaseDeltaA, pulseWidth);
                        const float sub = polyBlepSquare(subPhase, subDelta, 0.5f);
                        const float air = std::sin((phaseA * 91.7f + phaseB * 53.1f + static_cast<float>(note)) * twoPi) * noiseLevel;

                        float tone = (sawA * 0.42f + sawB * 0.32f + square * (0.10f + 0.16f * brightness)
                                      + sub * subLevel + air) / (0.92f + subLevel + noiseLevel);
                        const float cutoff = juce::jlimit(220.0f, 18000.0f,
                                                          520.0f + brightness * 8600.0f
                                                          + frequency * (1.2f + brightness * 5.0f)
                                                          + envelope * 3200.0f);
                        const float filterAlpha = juce::jlimit(0.001f, 0.98f,
                                                               1.0f - std::exp(-twoPi * cutoff / static_cast<float>(sampleRate)));
                        filterState += filterAlpha * (tone - filterState);
                        tone = filterState;

                        mixed += tone * envelope * fallbackInstrumentVelocity[channel][note] * synthGain;

                        phaseA += phaseDeltaA;
                        phaseB += phaseDeltaB;
                        subPhase += subDelta;
                        if (phaseA >= 1.0f) phaseA -= std::floor(phaseA);
                        if (phaseB >= 1.0f) phaseB -= std::floor(phaseB);
                        if (subPhase >= 1.0f) subPhase -= std::floor(subPhase);
                        ++voiceAge;
                    }
                }
            }

            mixed = juce::jlimit(-0.75f, 0.75f, mixed);
            for (int channel = 0; channel < bufferChannels; ++channel)
                buffer.addSample(channel, sample, mixed);
        }
    };

    int cursor = 0;
    for (const auto metadata : midiMessages)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        renderSegment(cursor, eventSample);
        handleFallbackInstrumentMidi(metadata.getMessage(), sampleRate);
        cursor = eventSample;
    }
    renderSegment(cursor, numSamples);
}

bool TrackProcessor::enqueueMidiMessage(const juce::MidiMessage& message, int sampleOffset)
{
    int writeIndex = midiQueueWriteIndex.load(std::memory_order_relaxed);
    const int nextIndex = (writeIndex + 1) % MIDI_QUEUE_CAPACITY;
    const int readIndex = midiQueueReadIndex.load(std::memory_order_acquire);

    if (nextIndex == readIndex)
    {
        midiQueueOverflowCount.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    pendingMidiQueue[static_cast<size_t>(writeIndex)].message = message;
    pendingMidiQueue[static_cast<size_t>(writeIndex)].sampleOffset = sampleOffset;
    midiQueueWriteIndex.store(nextIndex, std::memory_order_release);
    return true;
}

void TrackProcessor::setScheduledMIDIClips(std::vector<ScheduledMIDIClip> clips)
{
    auto sharedClips = std::make_shared<const std::vector<ScheduledMIDIClip>>(std::move(clips));
    publishScheduledMIDIClips(
        std::move(sharedClips));
    requestMIDIChase();
}

void TrackProcessor::markActiveMIDINoteState(const juce::MidiMessage& message)
{
    if (message.getChannel() <= 0)
        return;

    const int channelIndex = juce::jlimit(0, 15, message.getChannel() - 1);
    const auto nowMs = juce::Time::getMillisecondCounter();

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        activeMIDINotes[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = true;
        midiNoteCurrentlyActive[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)].store(true, std::memory_order_relaxed);
        midiNoteLastOnMs[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)].store(nowMs, std::memory_order_relaxed);
        midiNoteLastVelocity[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)]
            .store(juce::jlimit(0, 127, static_cast<int>(message.getVelocity())), std::memory_order_relaxed);
    }
    else if (message.isNoteOff())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        activeMIDINotes[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)] = false;
        midiNoteCurrentlyActive[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)].store(false, std::memory_order_relaxed);
        midiNoteLastOffMs[static_cast<size_t>(channelIndex)][static_cast<size_t>(note)].store(nowMs, std::memory_order_relaxed);
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& noteActive : activeMIDINotes[static_cast<size_t>(channelIndex)])
            noteActive = false;
        for (size_t note = 0; note < midiNoteCurrentlyActive[static_cast<size_t>(channelIndex)].size(); ++note)
        {
            midiNoteCurrentlyActive[static_cast<size_t>(channelIndex)][note].store(false, std::memory_order_relaxed);
            midiNoteLastOffMs[static_cast<size_t>(channelIndex)][note].store(nowMs, std::memory_order_relaxed);
        }
    }
}

std::vector<TrackProcessor::MIDINoteActivity> TrackProcessor::getRecentMIDINoteActivity(juce::uint32 maxAgeMs) const
{
    std::vector<MIDINoteActivity> result;
    result.reserve(16);
    const auto nowMs = juce::Time::getMillisecondCounter();
    const auto safeMaxAgeMs = juce::jmax(static_cast<juce::uint32>(1), maxAgeMs);

    for (size_t channel = 0; channel < midiNoteLastOnMs.size(); ++channel)
    {
        for (size_t note = 0; note < midiNoteLastOnMs[channel].size(); ++note)
        {
            const auto lastOnMs = midiNoteLastOnMs[channel][note].load(std::memory_order_relaxed);
            const auto lastOffMs = midiNoteLastOffMs[channel][note].load(std::memory_order_relaxed);
            const auto latestMs = juce::jmax(lastOnMs, lastOffMs);
            if (latestMs == 0)
                continue;

            const auto ageMs = nowMs - latestMs;
            if (ageMs > safeMaxAgeMs)
                continue;

            MIDINoteActivity activity;
            activity.note = static_cast<int>(note);
            activity.channel = static_cast<int>(channel) + 1;
            activity.velocity = midiNoteLastVelocity[channel][note].load(std::memory_order_relaxed);
            activity.active = midiNoteCurrentlyActive[channel][note].load(std::memory_order_relaxed);
            activity.ageMs = ageMs;
            result.push_back(activity);
        }
    }

    return result;
}

void TrackProcessor::appendScheduledMIDIToBuffer(juce::MidiBuffer& destination,
                                                 const std::vector<ScheduledMIDIClip>* const clips,
                                                 double blockTimeSeconds,
                                                 int numSamples, double sampleRate) const
{
    if (clips == nullptr || clips->empty() || sampleRate <= 0.0)
        return;

    const double blockEndTimeSeconds = blockTimeSeconds + (static_cast<double>(numSamples) / sampleRate);

    for (const auto& clip : *clips)
    {
        if (clip.events.empty())
            continue;

        const double clipEndTime = clip.startTime + clip.duration;
        if (clipEndTime <= blockTimeSeconds || clip.startTime >= blockEndTimeSeconds)
            continue;

        for (const auto& event : clip.events)
        {
            const double absoluteEventTime = clip.startTime + event.timestampSeconds;
            if (absoluteEventTime < blockTimeSeconds || absoluteEventTime >= blockEndTimeSeconds)
                continue;

            int sampleOffset = static_cast<int>(std::floor((absoluteEventTime - blockTimeSeconds) * sampleRate));
            sampleOffset = juce::jlimit(0, juce::jmax(0, numSamples - 1), sampleOffset);
            destination.addEvent(event.message, sampleOffset);
        }
    }
}

void TrackProcessor::appendScheduledMIDIChaseToBuffer(juce::MidiBuffer& destination,
                                                      const std::vector<ScheduledMIDIClip>* const clips,
                                                      double blockTimeSeconds,
                                                      double sampleRate) const
{
    if (clips == nullptr || clips->empty() || sampleRate <= 0.0)
        return;

    std::array<std::array<const ScheduledMIDIEvent*, 128>, 16> activeNoteStarts {};
    std::array<std::array<const ScheduledMIDIEvent*, 128>, 16> ccChase {};
    std::array<const ScheduledMIDIEvent*, 16> pitchBendChase {};
    std::array<const ScheduledMIDIEvent*, 16> pressureChase {};
    std::array<const ScheduledMIDIEvent*, 16> programChase {};

    auto sameNote = [] (const juce::MidiMessage& a, const juce::MidiMessage& b)
    {
        return a.getChannel() == b.getChannel() && a.getNoteNumber() == b.getNoteNumber();
    };

    for (const auto& clip : *clips)
    {
        if (clip.events.empty())
            continue;

        const double clipEndTime = clip.startTime + clip.duration;
        if (clip.startTime > blockTimeSeconds || clipEndTime <= blockTimeSeconds)
            continue;

        for (size_t eventIndex = 0; eventIndex < clip.events.size(); ++eventIndex)
        {
            const auto& event = clip.events[eventIndex];
            const auto& message = event.message;
            const double absoluteEventTime = clip.startTime + event.timestampSeconds;
            if (absoluteEventTime >= blockTimeSeconds)
                break;

            const int channelIndex = juce::jlimit(0, 15, message.getChannel() - 1);
            if (message.isNoteOn())
            {
                bool noteEndsAfterBlock = false;
                for (size_t endIndex = eventIndex + 1; endIndex < clip.events.size(); ++endIndex)
                {
                    const auto& endEvent = clip.events[endIndex];
                    const auto& endMessage = endEvent.message;
                    if (!endMessage.isNoteOff() || !sameNote(message, endMessage))
                        continue;

                    const double absoluteEndTime = clip.startTime + endEvent.timestampSeconds;
                    noteEndsAfterBlock = absoluteEndTime > blockTimeSeconds;
                    break;
                }

                if (noteEndsAfterBlock)
                    activeNoteStarts[static_cast<size_t>(channelIndex)]
                                    [static_cast<size_t>(message.getNoteNumber())] = &event;
            }
            else if (message.isNoteOff())
            {
                activeNoteStarts[static_cast<size_t>(channelIndex)]
                                [static_cast<size_t>(message.getNoteNumber())] = nullptr;
            }
            else if (message.isController())
            {
                ccChase[static_cast<size_t>(channelIndex)]
                       [static_cast<size_t>(juce::jlimit(0, 127, message.getControllerNumber()))] = &event;
            }
            else if (message.isPitchWheel())
            {
                pitchBendChase[static_cast<size_t>(channelIndex)] = &event;
            }
            else if (message.isChannelPressure() || message.isAftertouch())
            {
                pressureChase[static_cast<size_t>(channelIndex)] = &event;
            }
            else if (message.isProgramChange())
            {
                programChase[static_cast<size_t>(channelIndex)] = &event;
            }
        }
    }

    for (const auto* event : programChase)
        if (event != nullptr)
            destination.addEvent(event->message, 0);

    for (const auto* event : pitchBendChase)
        if (event != nullptr)
            destination.addEvent(event->message, 0);

    for (const auto* event : pressureChase)
        if (event != nullptr)
            destination.addEvent(event->message, 0);

    for (const auto& channelCCs : ccChase)
        for (const auto* event : channelCCs)
            if (event != nullptr)
                destination.addEvent(event->message, 0);

    for (const auto& channelNotes : activeNoteStarts)
        for (const auto* event : channelNotes)
            if (event != nullptr)
                destination.addEvent(event->message, 0);
}

void TrackProcessor::appendQueuedMIDIToBuffer(juce::MidiBuffer& destination, int numSamples)
{
    int readIndex = midiQueueReadIndex.load(std::memory_order_relaxed);
    const int writeIndex = midiQueueWriteIndex.load(std::memory_order_acquire);

    while (readIndex != writeIndex)
    {
        auto& queuedEvent = pendingMidiQueue[static_cast<size_t>(readIndex)];
        int sampleOffset = juce::jlimit(0, juce::jmax(0, numSamples - 1), queuedEvent.sampleOffset);
        destination.addEvent(queuedEvent.message, sampleOffset);

        readIndex = (readIndex + 1) % MIDI_QUEUE_CAPACITY;
        midiQueueReadIndex.store(readIndex, std::memory_order_release);
    }
}

void TrackProcessor::applyMIDIAutomationToBuffer(juce::MidiBuffer& destination, double blockTimeSeconds,
                                                 int numSamples, double sampleRate,
                                                 const MIDICCAutomationRouteSnapshot* ccRoutes)
{
    if (numSamples <= 0 || sampleRate <= 0.0)
        return;

    const bool velocityActive = shouldApplyAutomation(midiVelocityScaleAutomation)
                             && midiVelocityScaleAutomation.getNumPoints() > 0;
    const bool pitchBendActive = shouldApplyAutomation(midiPitchBendAutomation)
                              && midiPitchBendAutomation.getNumPoints() > 0;
    const bool channelPressureActive = shouldApplyAutomation(midiChannelPressureAutomation)
                                    && midiChannelPressureAutomation.getNumPoints() > 0;
    const bool hasCCRoutedAutomation =
        ccRoutes != nullptr
        && ! ccRoutes->empty();

    if (!velocityActive && !pitchBendActive && !channelPressureActive && !hasCCRoutedAutomation)
        return;

    juce::MidiBuffer transformed;

    if (velocityActive)
    {
        for (const auto metadata : destination)
        {
            auto message = metadata.getMessage();
            if (message.isNoteOn())
            {
                const double eventTime = blockTimeSeconds + static_cast<double>(metadata.samplePosition) / sampleRate;
                const float scale = juce::jlimit(0.0f, 2.0f, midiVelocityScaleAutomation.eval(eventTime));
                const int velocity = juce::jlimit(1, 127, static_cast<int>(std::round(message.getVelocity() * scale)));
                message = juce::MidiMessage::noteOn(message.getChannel(), message.getNoteNumber(), static_cast<juce::uint8>(velocity));
            }
            transformed.addEvent(message, metadata.samplePosition);
        }
    }
    else
    {
        transformed = destination;
    }

    auto addForConfiguredChannels = [this, &transformed] (auto createMessage)
    {
        const int configuredChannel = juce::jlimit(
            0,
            16,
            midiChannel.load(
                std::memory_order_acquire));
        if (configuredChannel > 0)
        {
            transformed.addEvent(createMessage(configuredChannel), 0);
            return;
        }

        for (int channel = 1; channel <= 16; ++channel)
            transformed.addEvent(createMessage(channel), 0);
    };

    if (pitchBendActive)
    {
        const float bend = juce::jlimit(-1.0f, 1.0f, midiPitchBendAutomation.eval(blockTimeSeconds));
        const int wheel = juce::jlimit(0, 16383, static_cast<int>(std::round((bend + 1.0f) * 8191.5f)));
        addForConfiguredChannels([wheel] (int channel) { return juce::MidiMessage::pitchWheel(channel, wheel); });
    }

    if (channelPressureActive)
    {
        const int pressure = juce::jlimit(0, 127, static_cast<int>(std::round(midiChannelPressureAutomation.eval(blockTimeSeconds))));
        addForConfiguredChannels([pressure] (int channel) { return juce::MidiMessage::channelPressureChange(channel, pressure); });
    }

    if (hasCCRoutedAutomation)
    {
        for (const auto& route : *ccRoutes)
        {
            if (!route || !route->automation || route->controller < 0 || route->controller > 127)
                continue;
            if (!shouldApplyAutomation(*route->automation) || route->automation->getNumPoints() <= 0)
                continue;

            const int controller = route->controller;
            const int value = juce::jlimit(0, 127, static_cast<int>(std::round(route->automation->eval(blockTimeSeconds))));
            addForConfiguredChannels([controller, value] (int channel)
            {
                return juce::MidiMessage::controllerEvent(channel, controller, value);
            });
        }
    }

    destination.swapWith(transformed);
}

bool TrackProcessor::hasQueuedMIDI() const
{
    return allNotesOffRequested.load(
               std::memory_order_acquire)
        || midiQueueReadIndex.load(
               std::memory_order_acquire)
            != midiQueueWriteIndex.load(
                std::memory_order_acquire);
}

bool TrackProcessor::hasScheduledMIDIClips() const
{
    auto clips = std::atomic_load_explicit(&scheduledMIDIClips, std::memory_order_acquire);
    return clips && !clips->empty();
}

std::vector<TrackProcessor::ScheduledMIDIClip> TrackProcessor::getScheduledMIDIClipSnapshot() const
{
    auto clips = std::atomic_load_explicit(&scheduledMIDIClips, std::memory_order_acquire);
    return clips ? *clips : std::vector<ScheduledMIDIClip>();
}

int TrackProcessor::getScheduledMIDIClipCount() const
{
    auto clips = std::atomic_load_explicit(&scheduledMIDIClips, std::memory_order_acquire);
    return clips ? static_cast<int>(clips->size()) : 0;
}

int TrackProcessor::getScheduledMIDIEventCount() const
{
    auto clips = std::atomic_load_explicit(&scheduledMIDIClips, std::memory_order_acquire);
    if (!clips)
        return 0;

    int count = 0;
    for (const auto& clip : *clips)
        count += static_cast<int>(clip.events.size());
    return count;
}

bool TrackProcessor::hasScheduledMIDIInBlock(
    double blockTimeSeconds,
    int numSamples,
    double sampleRate,
    const std::vector<ScheduledMIDIClip>* const clips) const
{
    if (clips == nullptr || clips->empty() || sampleRate <= 0.0)
        return false;

    const double blockEndTimeSeconds = blockTimeSeconds + (static_cast<double>(numSamples) / sampleRate);
    for (const auto& clip : *clips)
    {
        if (clip.events.empty())
            continue;

        const double clipEndTime = clip.startTime + clip.duration;
        if (clipEndTime <= blockTimeSeconds || clip.startTime >= blockEndTimeSeconds)
            continue;

        for (const auto& event : clip.events)
        {
            const double absoluteEventTime = clip.startTime + event.timestampSeconds;
            if (absoluteEventTime >= blockTimeSeconds && absoluteEventTime < blockEndTimeSeconds)
                return true;
        }
    }

    return false;
}

void TrackProcessor::buildMidiBuffer(juce::MidiBuffer& destination, double blockTimeSeconds,
                                     int numSamples, double sampleRate, bool playing)
{
    destination.clear();

    appendQueuedMIDIToBuffer(destination, numSamples);
    if (allNotesOffRequested.exchange(
            false, std::memory_order_acq_rel))
    {
        for (size_t channel = 0;
             channel < activeMIDINotes.size();
             ++channel)
        {
            for (size_t note = 0;
                 note < activeMIDINotes[channel].size();
                 ++note)
            {
                if (! activeMIDINotes[channel][note])
                    continue;

                destination.addEvent(
                    juce::MidiMessage::noteOff(
                        static_cast<int>(channel) + 1,
                        static_cast<int>(note)),
                    0);
                activeMIDINotes[channel][note] =
                    false;
            }

            const int midiChannelNumber =
                static_cast<int>(channel) + 1;
            destination.addEvent(
                juce::MidiMessage::allNotesOff(
                    midiChannelNumber),
                0);
            destination.addEvent(
                juce::MidiMessage::controllerEvent(
                    midiChannelNumber, 64, 0),
                0);
            destination.addEvent(
                juce::MidiMessage::controllerEvent(
                    midiChannelNumber, 120, 0),
                0);
            destination.addEvent(
                juce::MidiMessage::controllerEvent(
                    midiChannelNumber, 121, 0),
                0);
            destination.addEvent(
                juce::MidiMessage::controllerEvent(
                    midiChannelNumber, 123, 0),
                0);
            destination.addEvent(
                juce::MidiMessage::pitchWheel(
                    midiChannelNumber, 8192),
                0);
        }
    }

    if (playing
        && hasScheduledMIDIClipsForAudio.load(
            std::memory_order_acquire))
    {
        const ScopedTrackRealtimeReader scheduledMIDIReadGuard(
            scheduledMIDIAudioReaders);
        const auto* const scheduledClips =
            scheduledMIDIClipsForAudio.load(
                std::memory_order_seq_cst);
        if (scheduledMIDIChaseRequested.exchange(false, std::memory_order_acq_rel))
        {
            appendScheduledMIDIChaseToBuffer(
                destination,
                scheduledClips,
                blockTimeSeconds,
                sampleRate);
        }
        appendScheduledMIDIToBuffer(
            destination,
            scheduledClips,
            blockTimeSeconds,
            numSamples,
            sampleRate);
    }

    const bool hasMIDIAutomationRoutesForBlock =
        hasPublishedMIDICCAutomationRoutes.load(
            std::memory_order_acquire);
    const ScopedTrackRealtimeReader midiAutomationReadGuard(
        realtimeAuxAudioReaders,
        hasMIDIAutomationRoutesForBlock);
    const auto* const midiAutomationRoutesForBlock =
        hasMIDIAutomationRoutesForBlock
            ? midiCCAutomationSnapshotForAudio.load(
                std::memory_order_seq_cst)
            : nullptr;
    applyMIDIAutomationToBuffer(
        destination,
        blockTimeSeconds,
        numSamples,
        sampleRate,
        midiAutomationRoutesForBlock);

    lastBuiltMidiEventCount.store(destination.getNumEvents(), std::memory_order_relaxed);
    int prevMax = maxBuiltMidiEventCount.load(std::memory_order_relaxed);
    while (destination.getNumEvents() > prevMax
           && !maxBuiltMidiEventCount.compare_exchange_weak(prevMax, destination.getNumEvents(),
                                                            std::memory_order_relaxed))
    {
    }

    for (const auto metadata : destination)
        markActiveMIDINoteState(metadata.getMessage());
}

bool TrackProcessor::needsProcessing(double blockTimeSeconds, int numSamples,
                                     double sampleRate, bool playing) const
{
    if (realtimeFXTailActive.load(std::memory_order_acquire)
        || realtimeFXTailResetPending.load(std::memory_order_acquire))
    {
        return true;
    }

    const ScopedTrackRealtimeReader graphReadGuard(
        realtimeGraphAudioReaders);
    const auto* const graph =
        realtimeGraphSnapshotForAudio.load(
            std::memory_order_seq_cst);
    const auto* const trackFXSnapshot =
        graph != nullptr ? &graph->trackFX : nullptr;
    const auto* const inputFXSnapshot =
        graph != nullptr ? &graph->inputFX : nullptr;

    if (hasInternalAuditionSourceActive(trackFXSnapshot)
        || hasInternalAuditionSourceActive(inputFXSnapshot))
        return true;

    // Instrument tracks must always be processed so they can respond to
    // live MIDI input and produce sustain / reverb tails after note-off.
    if (trackType.load(std::memory_order_acquire) == TrackType::Instrument)
    {
        if (graph != nullptr && graph->instrument != nullptr)
            return true;

        if (trackFXSnapshot)
        {
            for (const auto& plugin : *trackFXSnapshot)
            {
                if (isBuiltInInstrumentProcessor(plugin.get()))
                    return true;
            }
        }

        if (hasActiveFallbackInstrumentVoices()
            || fallbackInstrumentResetRequested.load(std::memory_order_acquire))
            return true;
    }

    if (hasQueuedMIDI())
        return true;

    if (playing
        && hasScheduledMIDIClipsForAudio.load(
            std::memory_order_acquire))
    {
        const ScopedTrackRealtimeReader scheduledMIDIReadGuard(
            scheduledMIDIAudioReaders);
        const auto* const scheduledClips =
            scheduledMIDIClipsForAudio.load(
                std::memory_order_seq_cst);
        if (scheduledClips != nullptr
            && scheduledMIDIChaseRequested.load(
                std::memory_order_acquire))
        {
            return true;
        }

        if (hasScheduledMIDIInBlock(
                blockTimeSeconds,
                numSamples,
                sampleRate,
                scheduledClips))
        {
            return true;
        }
    }

    if (playing && hasMIDIAutomation())
        return true;

    return false;
}

void TrackProcessor::queueAllNotesOff(bool requestChase)
{
    if (requestChase)
        requestMIDIChase();
    fallbackInstrumentResetRequested.store(true, std::memory_order_release);
    allNotesOffRequested.store(
        true, std::memory_order_release);
}

std::vector<juce::String> TrackProcessor::getSidechainSourceSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    std::vector<juce::String> sourceIds;
    if (graph == nullptr)
        return sourceIds;

    sourceIds.reserve(graph->sidechainSources.size());
    for (const auto& entry : graph->sidechainSources)
    {
        if (entry.second.isNotEmpty())
            sourceIds.push_back(entry.second);
    }
    return sourceIds;
}

std::vector<TrackProcessor::RealtimeSendInfo> TrackProcessor::getRealtimeSendSnapshot() const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    std::vector<RealtimeSendInfo> snapshot;
    if (graph == nullptr)
        return snapshot;

    snapshot.reserve(graph->sends.size());
    for (const auto& send : graph->sends)
    {
        RealtimeSendInfo info;
        info.destTrackId = send.destTrackId;
        info.level = send.level;
        info.pan = send.pan;
        const float phaseMultiplier = send.phaseInvert ? -1.0f : 1.0f;
        const float panAngle =
            (send.pan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;
        info.leftGain =
            std::cos(panAngle) * send.level * phaseMultiplier;
        info.rightGain =
            std::sin(panAngle) * send.level * phaseMultiplier;
        info.enabled = send.enabled;
        info.preFader = send.preFader;
        info.phaseInvert = send.phaseInvert;
        snapshot.push_back(std::move(info));
    }
    return snapshot;
}

void TrackProcessor::setInputFXPrecisionOverride(int index, bool forceFloat)
{
    const juce::ScopedLock callbackGuard(getCallbackLock());
    if (index < 0 || index >= static_cast<int>(inputFXPlugins.size()))
        return;

    inputFXForceFloatOverrides[index] = forceFloat;
    if (auto* plugin = inputFXPlugins[static_cast<size_t>(index)].get())
    {
        double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
        int bs = getSafeHostedPluginBlockSize(getBlockSize());
        preparePluginPreservingLayout(plugin, sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode, forceFloat),
                                      inputChannelCount.load(std::memory_order_acquire));
    }
    publishRealtimeStateSnapshots();
}

void TrackProcessor::setTrackFXPrecisionOverride(int index, bool forceFloat)
{
    const juce::ScopedLock callbackGuard(getCallbackLock());
    if (index < 0 || index >= static_cast<int>(trackFXPlugins.size()))
        return;

    trackFXForceFloatOverrides[index] = forceFloat;
    if (auto* plugin = trackFXPlugins[static_cast<size_t>(index)].get())
    {
        double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
        int bs = getSafeHostedPluginBlockSize(getBlockSize());
        preparePluginPreservingLayout(plugin, sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode, forceFloat),
                                      inputChannelCount.load(std::memory_order_acquire));
    }
    publishRealtimeStateSnapshots();
}

void TrackProcessor::setInstrumentPrecisionOverride(bool forceFloat)
{
    const juce::ScopedLock callbackGuard(getCallbackLock());
    instrumentForceFloatOverride.store(forceFloat, std::memory_order_release);
    if (instrumentPlugin)
    {
        double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
        int bs = getSafeHostedPluginBlockSize(getBlockSize());
        preparePluginPreservingLayout(instrumentPlugin.get(), sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode, forceFloat));
    }
}

bool TrackProcessor::getInputFXPrecisionOverride(int index) const
{
    auto it = inputFXForceFloatOverrides.find(index);
    return it != inputFXForceFloatOverrides.end() && it->second;
}

bool TrackProcessor::getTrackFXPrecisionOverride(int index) const
{
    auto it = trackFXForceFloatOverrides.find(index);
    return it != trackFXForceFloatOverrides.end() && it->second;
}

bool TrackProcessor::getInputFXBypassed(int index) const
{
    auto it = inputFXBypassedState.find(index);
    return it != inputFXBypassedState.end() && it->second;
}

bool TrackProcessor::getTrackFXBypassed(int index) const
{
    auto it = trackFXBypassedState.find(index);
    return it != trackFXBypassedState.end() && it->second;
}

void TrackProcessor::setProcessingPrecisionMode(ProcessingPrecisionMode mode)
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    if (processingPrecisionMode == mode)
        return;

    processingPrecisionMode = mode;

    double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
    int bs = getSafeHostedPluginBlockSize(getBlockSize());

    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
        if (auto* plugin = inputFXPlugins[static_cast<size_t>(index)].get())
            preparePluginPreservingLayout(plugin, sr, bs,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getInputFXPrecisionOverride(index)),
                                          inputChannelCount.load(std::memory_order_acquire));

    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
        if (auto* plugin = trackFXPlugins[static_cast<size_t>(index)].get())
            preparePluginPreservingLayout(plugin, sr, bs,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getTrackFXPrecisionOverride(index)),
                                          inputChannelCount.load(std::memory_order_acquire));

    if (instrumentPlugin)
        preparePluginPreservingLayout(instrumentPlugin.get(), sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode,
                                                                 instrumentForceFloatOverride.load(std::memory_order_acquire)));
}

//==============================================================================
// Plugin Delay Compensation (PDC)

int TrackProcessor::getChainLatency() const
{
    juce::int64 totalLatency = 0;
    const auto addProcessorLatency = [&totalLatency] (const juce::AudioProcessor* processor)
    {
        if (processor != nullptr)
            totalLatency += juce::jmax(0, processor->getLatencySamples());
    };

    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
    {
        const auto& plugin = inputFXPlugins[static_cast<size_t>(index)];
        if (plugin)
            addProcessorLatency(plugin.get());
    }
    addProcessorLatency(instrumentPlugin.get());
    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
    {
        const auto& plugin = trackFXPlugins[static_cast<size_t>(index)];
        if (plugin)
            addProcessorLatency(plugin.get());
    }
    return static_cast<int>(juce::jmin<juce::int64>(totalLatency,
                                                    std::numeric_limits<int>::max()));
}

void TrackProcessor::setPDCDelay(int delaySamples)
{
    const int safeDelaySamples =
        juce::jmax(0, delaySamples);
    if (pdcDelaySamples.exchange(
            safeDelaySamples,
            std::memory_order_acq_rel)
        != safeDelaySamples)
    {
        pdcDelayDirty.store(
            true, std::memory_order_release);
    }
}

void TrackProcessor::resetPDCDelayState()
{
    pdcDelayLine.reset();
    pdcCurrentDelaySamples =
        juce::jlimit(
            0,
            pdcDelayLine
                .getMaximumDelayInSamples(),
            pdcDelaySamples.load(
                std::memory_order_relaxed));
    pdcTargetDelaySamples =
        pdcCurrentDelaySamples;
    pdcPendingDelaySamples =
        pdcCurrentDelaySamples;
    pdcTransitionSamplesRemaining = 0;
    pdcDelayLine.setDelay(
        static_cast<float>(
            pdcCurrentDelaySamples));
    pdcDelayDirty.store(false, std::memory_order_release);
}

void TrackProcessor::resetOfflineRenderState()
{
    resetPDCDelayState();
    channelStripEQ.reset();
    dcFilterStateL = 0.0f;
    dcFilterStateR = 0.0f;
    dcPrevInputL = 0.0f;
    dcPrevInputR = 0.0f;
    clearFallbackInstrumentState();
    for (auto& channelNotes : activeMIDINotes)
        channelNotes.fill(false);
    fallbackInstrumentResetRequested.store(false, std::memory_order_release);
    preFaderBuffer.clear();
    automationGainBuffer.clear();
    realtimeFallbackBuffer.clear();

    // State/preset restoration can change a parameter without changing its
    // automation lane value. Force the first block of every offline pass to
    // re-apply that value instead of trusting a cache from realtime/pass 1.
    invalidatePluginAutomationCache();
}

void TrackProcessor::invalidatePluginAutomationCache() noexcept
{
    if (!hasPublishedPluginAutomationRoutes.load(std::memory_order_acquire))
        return;

    auto snapshot = std::atomic_load_explicit(&pluginAutomationSnapshot, std::memory_order_acquire);
    if (snapshot)
        for (const auto& route : *snapshot)
            if (route)
                route->lastAppliedValue.store(std::numeric_limits<float>::quiet_NaN(),
                                              std::memory_order_relaxed);
}

void TrackProcessor::setChannelStripEQParam(int paramIndex, float value)
{
    if (paramIndex < 0
        || paramIndex >= channelStripEQBandCount * channelStripEQValuesPerBand)
        return;

    const int surfaceBand = paramIndex / channelStripEQValuesPerBand;
    const int field = paramIndex % channelStripEQValuesPerBand;
    // The compact strip exposes HPF, four bells, and LPF. Map those onto the
    // first six S13EQ bands while setting the two edge filter types explicitly.
    auto& band = channelStripEQ.bands[static_cast<size_t>(surfaceBand)];
    if (surfaceBand == 0)
        band.type.store(static_cast<float>(S13EQ::FilterType::LowCut),
                        std::memory_order_relaxed);
    else if (surfaceBand == channelStripEQBandCount - 1)
        band.type.store(static_cast<float>(S13EQ::FilterType::HighCut),
                        std::memory_order_relaxed);
    else
        band.type.store(static_cast<float>(S13EQ::FilterType::Bell),
                        std::memory_order_relaxed);

    switch (field)
    {
        case 0:
            band.freq.store(juce::jlimit(20.0f, 20000.0f, value),
                            std::memory_order_relaxed);
            break;
        case 1:
            band.gain.store(juce::jlimit(-18.0f, 18.0f, value),
                            std::memory_order_relaxed);
            break;
        case 2:
            band.q.store(juce::jlimit(0.1f, 10.0f, value),
                         std::memory_order_relaxed);
            break;
        case 3:
            band.enabled.store(value >= 0.5f ? 1.0f : 0.0f,
                               std::memory_order_relaxed);
            break;
        default:
            break;
    }
}

float TrackProcessor::getChannelStripEQParam(int paramIndex) const
{
    if (paramIndex < 0
        || paramIndex >= channelStripEQBandCount * channelStripEQValuesPerBand)
        return 0.0f;

    const int surfaceBand = paramIndex / channelStripEQValuesPerBand;
    const int field = paramIndex % channelStripEQValuesPerBand;
    const auto& band =
        channelStripEQ.bands[static_cast<size_t>(surfaceBand)];
    switch (field)
    {
        case 0: return band.freq.load(std::memory_order_relaxed);
        case 1: return band.gain.load(std::memory_order_relaxed);
        case 2: return band.q.load(std::memory_order_relaxed);
        case 3: return band.enabled.load(std::memory_order_relaxed);
        default: return 0.0f;
    }
}

//==============================================================================
// Send Phase Invert

void TrackProcessor::setSendPhaseInvert(int sendIndex, bool invert)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].phaseInvert = invert;
        publishRealtimeStateSnapshots();
    }
}

bool TrackProcessor::getSendPhaseInvert(int sendIndex) const
{
    const auto graph = std::atomic_load_explicit(
        &realtimeGraphSnapshot, std::memory_order_acquire);
    if (graph != nullptr
        && sendIndex >= 0
        && sendIndex < static_cast<int>(graph->sends.size()))
    {
        return graph->sends[static_cast<size_t>(sendIndex)].phaseInvert;
    }
    return false;
}

//==============================================================================
// Output Channel Routing

void TrackProcessor::setOutputChannels(int startChannel, int numChannels)
{
    outputStartChannel.store(juce::jmax(0, startChannel), std::memory_order_release);
    outputChannelCount.store(juce::jlimit(1, 8, numChannels), std::memory_order_release);
}

//==============================================================================
// Per-track MIDI Output

void TrackProcessor::setMIDIOutputDevice(const juce::String& deviceName)
{
    if (midiOutputDispatcher == nullptr
        || deviceName == midiOutputDispatcher->getDeviceName())
        return;

    if (deviceName.isEmpty())
    {
        midiOutputDispatcher->disconnect();
        return;
    }

    if (midiOutputDispatcher->connect(deviceName))
        juce::Logger::writeToLog(
            "TrackProcessor: MIDI output connected: "
            + deviceName);
}

juce::String TrackProcessor::getMIDIOutputDeviceName() const
{
    return midiOutputDispatcher != nullptr
        ? midiOutputDispatcher->getDeviceName()
        : juce::String();
}

bool TrackProcessor::hasMIDIOutputDevice() const noexcept
{
    return midiOutputDispatcher != nullptr
        && midiOutputDispatcher->isConnected();
}

void TrackProcessor::sendMIDIToOutput(const juce::MidiBuffer& buffer, double sampleRate, bool resetMessagesOnly)
{
    if (midiOutputDispatcher == nullptr || buffer.isEmpty())
        return;

    if (sampleRate <= 0.0)
        sampleRate = getSampleRate() > 0.0 ? getSampleRate() : 44100.0;

    midiOutputDispatcher->enqueueBuffer(
        buffer, sampleRate, resetMessagesOnly);
}

// =============================================================================
// ARA Plugin Hosting (Phase 9)
// =============================================================================

bool TrackProcessor::initializeARA(int fxIndex, double sampleRate, int araBlockSize,
                                    std::function<void(bool, bool, const juce::String&)> onComplete)
{
#if S13_HAS_ARA
    if (fxIndex < 0 || fxIndex >= static_cast<int>(trackFXPlugins.size()))
    {
        updateARAAttemptStatus(fxIndex, true, false, false, "Invalid FX index.");
        if (onComplete) onComplete(false, false, "Invalid FX index.");
        return false;
    }

    auto* plugin = dynamic_cast<juce::AudioPluginInstance*>(trackFXPlugins[static_cast<size_t>(fxIndex)].get());
    if (!plugin)
    {
        juce::Logger::writeToLog("TrackProcessor::initializeARA: Plugin at index "
            + juce::String(fxIndex) + " is not an AudioPluginInstance.");
        updateARAAttemptStatus(fxIndex, true, false, false, "Plugin is not an AudioPluginInstance.");
        if (onComplete) onComplete(false, false, "Plugin is not an AudioPluginInstance.");
        return false;
    }

    updateARAAttemptStatus(fxIndex, false, false, false, {});

    if (araController && araController->isActive())
    {
        if (araFXIndex == fxIndex)
        {
            araFXIndexForRealtime.store(
                araFXIndex,
                std::memory_order_release);
            updateARAAttemptStatus(fxIndex, true, true, true, {});
            if (onComplete) onComplete(true, true, {});
            return true;
        }

        juce::createARAFactoryAsync(*plugin, [this, fxIndex, onComplete] (juce::ARAFactoryWrapper factory)
        {
            if (!factory.get())
            {
                updateARAAttemptStatus(fxIndex, true, false, false, {});
                if (onComplete) onComplete(false, false, {});
                return;
            }

            juce::String errorMessage = "Another ARA plugin is already active on this track.";
            updateARAAttemptStatus(fxIndex, true, true, false, errorMessage);
            if (onComplete) onComplete(false, true, errorMessage);
        });
        return true;
    }

    shutdownARA();

    araController = std::make_unique<ARAHostController>();
    araController->setPlaybackRequestHandlers(araPlaybackRequestHandlers);

    araFXIndex = fxIndex;
    araController->initializeForPlugin(plugin, sampleRate, araBlockSize,
        [this, fxIndex, onComplete] (bool success, bool pluginSupportsARA, const juce::String& errorMessage) {
            if (success)
            {
                araFXIndexForRealtime.store(
                    araFXIndex,
                    std::memory_order_release);
                juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA initialized at FX index "
                    + juce::String(fxIndex));
                updateARAAttemptStatus(fxIndex, true, true, true, {});
            }
            else
            {
                araFXIndexForRealtime.store(
                    -1,
                    std::memory_order_release);
                juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA initialization failed for FX index "
                    + juce::String(fxIndex));
                updateARAAttemptStatus(fxIndex, true, pluginSupportsARA, false, errorMessage);
                araController.reset();
                araFXIndex = -1;
            }
            if (onComplete) onComplete(success, pluginSupportsARA, errorMessage);
        });

    return true;
#else
    juce::ignoreUnused(fxIndex, sampleRate, araBlockSize, onComplete);
    juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA support not compiled in.");
    updateARAAttemptStatus(fxIndex, true, false, false, "ARA support not compiled in.");
    if (onComplete) onComplete(false, false, "ARA support not compiled in.");
    return false;
#endif
}

void TrackProcessor::setARAPlaybackRequestHandlers(ARAHostController::PlaybackRequestHandlers handlers)
{
    araPlaybackRequestHandlers = std::move(handlers);
    if (araController)
        araController->setPlaybackRequestHandlers(araPlaybackRequestHandlers);
}

void TrackProcessor::setCurrentAudioCallbackDebugInfo(const ARAProcessDebugInfo& info)
{
    currentARAProcessDebugInfo = info;
}

void TrackProcessor::noteARATransportPlaybackStateChanged(const juce::String& trackId, bool playing, double positionSeconds,
                                                          bool editorFocusedAtPlayStart)
{
    araDebugTrackId = trackId;
    araTransportPlayingDebugState.store(playing, std::memory_order_release);

    if (!araController || !araController->isActive())
        return;

    araController->updateTransportDebugState(playing, positionSeconds);

    if (playing)
    {
        araEditorFocusedAtPlaybackStart.store(editorFocusedAtPlayStart, std::memory_order_release);
        const auto snapshotBeforeStart = araController->getDebugSnapshot();
        const uint64 playbackRun = araPlaybackRunCounter.fetch_add(1, std::memory_order_acq_rel) + 1;
        araStructuredPlaySessionLogged.store(true, std::memory_order_release);
        if (kEnableARADebugDiagnostics)
        {
            logToDisk("ARA session start: trackId=" + trackId
                + " fxIndex=" + juce::String(araFXIndex)
                + " plugin=" + juce::String((araFXIndex >= 0 && araFXIndex < static_cast<int>(trackFXPlugins.size()) && trackFXPlugins[static_cast<size_t>(araFXIndex)] != nullptr)
                    ? trackFXPlugins[static_cast<size_t>(araFXIndex)]->getName() : juce::String("<none>"))
                + " playbackRun=" + juce::String(static_cast<juce::int64>(playbackRun))
                + " positionSeconds=" + juce::String(positionSeconds, 3)
                + " pendingEditSinceLastPlay=" + juce::String(snapshotBeforeStart.hasPendingEditSinceLastPlay ? "true" : "false")
                + " lastEditType=" + snapshotBeforeStart.lastEditType
                + " lastOperation=" + snapshotBeforeStart.lastOperation
                + " lastClipId=" + snapshotBeforeStart.lastClipId
                + " analysisRequested=" + juce::String(snapshotBeforeStart.analysisRequested ? "true" : "false")
                + " analysisStarted=" + juce::String(snapshotBeforeStart.analysisStarted ? "true" : "false")
                + " analysisProgress=" + juce::String(snapshotBeforeStart.analysisProgress, 3)
                + " analysisComplete=" + juce::String(snapshotBeforeStart.analysisComplete ? "true" : "false")
                + " editorFocusedAtPlayStart=" + juce::String(editorFocusedAtPlayStart ? "true" : "false")
                + " sourceCount=" + juce::String(snapshotBeforeStart.sourceCount)
                + " playbackRegionCount=" + juce::String(snapshotBeforeStart.playbackRegionCount)
                + " playbackRendererAttached=" + juce::String(snapshotBeforeStart.playbackRendererAttached ? "true" : "false")
                + " editorRendererAttached=" + juce::String(snapshotBeforeStart.editorRendererAttached ? "true" : "false")
                + " audioSourceSamplesAccessEnabled=" + juce::String(snapshotBeforeStart.audioSourceSamplesAccessEnabled ? "true" : "false"));
        }

        araController->notePlaybackStart(positionSeconds);
    }
    else
    {
        araEditorFocusedAtPlaybackStart.store(false, std::memory_order_release);
        araController->notePlaybackStop(positionSeconds);
    }
}

float TrackProcessor::getARAAnalysisProgress() const
{
    return araController ? araController->getAnalysisProgress() : 0.0f;
}

bool TrackProcessor::isARAAnalysisComplete() const
{
    return araController ? araController->isAnalysisComplete() : false;
}

ARAHostController::DebugSnapshot TrackProcessor::getARADebugSnapshot() const
{
    return araController ? araController->getDebugSnapshot() : ARAHostController::DebugSnapshot{};
}

juce::String TrackProcessor::getARALastAttemptError() const
{
    const juce::ScopedLock sl(araStatusLock);
    return araLastAttemptError;
}

void TrackProcessor::shutdownARA()
{
    araFXIndexForRealtime.store(
        -1, std::memory_order_release);
#if S13_HAS_ARA
    if (araController)
    {
        araController->shutdown();
        araController.reset();
        araFXIndex = -1;
    }
#endif
    updateARAAttemptStatus(-1, true, false, false, {});
}

void TrackProcessor::updateARAAttemptStatus(int fxIndex, bool completed, bool wasARAPlugin,
                                            bool succeeded, const juce::String& errorMessage)
{
    araLastAttemptFXIndex.store(fxIndex, std::memory_order_release);
    araLastAttemptComplete.store(completed, std::memory_order_release);
    araLastAttemptWasARAPlugin.store(wasARAPlugin, std::memory_order_release);
    araLastAttemptSucceeded.store(succeeded, std::memory_order_release);
    const juce::ScopedLock sl(araStatusLock);
    araLastAttemptError = errorMessage;
}
