#include "TimecodeSync.h"

#include <array>
#include <cstdint>

static_assert(std::atomic<SMPTEFrameRate>::is_always_lock_free);

//==============================================================================
// Realtime MIDI output handoff
//==============================================================================

class TimecodeMIDIOutputDispatcher final : private juce::Thread
{
public:
    TimecodeMIDIOutputDispatcher()
        : juce::Thread("OpenStudio Timecode MIDI Sender")
    {
    }

    ~TimecodeMIDIOutputDispatcher() override
    {
        realtimeEnabled.store(false, std::memory_order_release);
        connected.store(false, std::memory_order_release);
        generation.fetch_add(1, std::memory_order_acq_rel);
        signalThreadShouldExit();
        stopThread(2000);

        const juce::ScopedLock sl(outputLock);
        output.reset();
    }

    bool connect(const juce::String& midiOutputName)
    {
        disconnect();

        std::unique_ptr<juce::MidiOutput> newOutput;
        for (const auto& device : juce::MidiOutput::getAvailableDevices())
        {
            if (device.name == midiOutputName)
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
            generation.fetch_add(1, std::memory_order_acq_rel);
            connected.store(true, std::memory_order_release);
        }

        if (!isThreadRunning()
            && !startThread(juce::Thread::Priority::normal))
        {
            disconnect();
            return false;
        }
        return true;
    }

    void disconnect()
    {
        connected.store(false, std::memory_order_release);
        generation.fetch_add(1, std::memory_order_acq_rel);
        notify();

        const juce::ScopedLock sl(outputLock);
        output.reset();
    }

    bool isConnected() const noexcept
    {
        return connected.load(std::memory_order_acquire);
    }

    void setRealtimeEnabled(bool shouldEnable) noexcept
    {
        if (shouldEnable)
        {
            generation.fetch_add(1, std::memory_order_acq_rel);
            realtimeEnabled.store(true, std::memory_order_release);
        }
        else
        {
            realtimeEnabled.store(false, std::memory_order_release);
            generation.fetch_add(1, std::memory_order_acq_rel);
        }
        notify();
    }

    bool enqueueRealtimeByte(std::uint8_t byte) noexcept
    {
        return enqueueRealtimeMessage(&byte, 1);
    }

    bool enqueueRealtimeMessage(const std::uint8_t* bytes, int size) noexcept
    {
        if (!realtimeEnabled.load(std::memory_order_acquire)
            || !connected.load(std::memory_order_acquire)
            || bytes == nullptr
            || size <= 0
            || size > kMaxRealtimeMessageBytes)
        {
            return false;
        }

        const auto write = writePosition.load(std::memory_order_relaxed);
        const auto read = readPosition.load(std::memory_order_acquire);
        if (write - read >= kQueueCapacity)
        {
            droppedMessageCount.fetch_add(1, std::memory_order_relaxed);
            return false;
        }

        auto& packet = queue[write & (kQueueCapacity - 1)];
        packet.generation = generation.load(std::memory_order_acquire);
        packet.size = static_cast<std::uint8_t>(size);
        for (int index = 0; index < size; ++index)
            packet.bytes[static_cast<std::size_t>(index)] = bytes[index];

        writePosition.store(write + 1, std::memory_order_release);
        return true;
    }

    void sendControlMessage(const std::uint8_t* bytes, int size)
    {
        if (bytes == nullptr || size <= 0)
            return;

        const juce::ScopedLock sl(outputLock);
        if (output != nullptr && connected.load(std::memory_order_acquire))
            output->sendMessageNow(juce::MidiMessage(bytes, size));
    }

private:
    struct Packet
    {
        std::array<std::uint8_t, 3> bytes {};
        std::uint32_t generation = 0;
        std::uint8_t size = 0;
    };

    static constexpr std::uint32_t kQueueCapacity = 1024;
    static constexpr int kMaxRealtimeMessageBytes = 3;
    static_assert((kQueueCapacity & (kQueueCapacity - 1)) == 0);
    static_assert(std::atomic<bool>::is_always_lock_free);
    static_assert(std::atomic<std::uint32_t>::is_always_lock_free);

    bool dequeue(Packet& packet) noexcept
    {
        const auto read = readPosition.load(std::memory_order_relaxed);
        if (read == writePosition.load(std::memory_order_acquire))
            return false;

        packet = queue[read & (kQueueCapacity - 1)];
        readPosition.store(read + 1, std::memory_order_release);
        return true;
    }

    void run() override
    {
        while (!threadShouldExit())
        {
            bool consumedPacket = false;
            Packet packet;
            while (dequeue(packet))
            {
                consumedPacket = true;
                const auto currentGeneration = generation.load(std::memory_order_acquire);
                if (packet.generation != currentGeneration
                    || !connected.load(std::memory_order_acquire)
                    || !realtimeEnabled.load(std::memory_order_acquire))
                {
                    continue;
                }

                const juce::ScopedLock sl(outputLock);
                if (output != nullptr
                    && connected.load(std::memory_order_acquire)
                    && realtimeEnabled.load(std::memory_order_acquire)
                    && packet.generation == generation.load(std::memory_order_acquire))
                {
                    output->sendMessageNow(
                        juce::MidiMessage(packet.bytes.data(), static_cast<int>(packet.size)));
                }
            }

            if (!consumedPacket)
            {
                const bool active = connected.load(std::memory_order_relaxed)
                    && realtimeEnabled.load(std::memory_order_relaxed);
                wait(active ? 1 : 20);
            }
        }
    }

    std::array<Packet, kQueueCapacity> queue {};
    std::atomic<std::uint32_t> writePosition { 0 };
    std::atomic<std::uint32_t> readPosition { 0 };
    std::atomic<std::uint32_t> generation { 1 };
    std::atomic<std::uint32_t> droppedMessageCount { 0 };
    std::atomic<bool> connected { false };
    std::atomic<bool> realtimeEnabled { false };
    juce::CriticalSection outputLock;
    std::unique_ptr<juce::MidiOutput> output;
};

//==============================================================================
// MIDIClockOutput
//==============================================================================

MIDIClockOutput::MIDIClockOutput()
    : outputDispatcher(std::make_unique<TimecodeMIDIOutputDispatcher>())
{
}

MIDIClockOutput::~MIDIClockOutput()
{
    disconnect();
}

bool MIDIClockOutput::connect(const juce::String& midiOutputName)
{
    disconnect();
    const bool connected = outputDispatcher->connect(midiOutputName);
    outputDispatcher->setRealtimeEnabled(isEnabled.load(std::memory_order_acquire));
    resetClockAccumulatorRequested.store(true, std::memory_order_release);
    if (connected)
        juce::Logger::writeToLog("MIDIClockOutput: Connected to " + midiOutputName);
    return connected;
}

void MIDIClockOutput::disconnect()
{
    const bool wasConnected = outputDispatcher->isConnected();
    outputDispatcher->setRealtimeEnabled(false);
    if (wasConnected)
        sendStop();
    outputDispatcher->disconnect();
    resetClockAccumulatorRequested.store(true, std::memory_order_release);
}

bool MIDIClockOutput::isConnected() const noexcept
{
    return outputDispatcher->isConnected();
}

void MIDIClockOutput::setEnabled(bool enabled) noexcept
{
    isEnabled.store(enabled, std::memory_order_release);
    outputDispatcher->setRealtimeEnabled(enabled);
    if (!enabled)
        resetClockAccumulatorRequested.store(true, std::memory_order_release);
}

void MIDIClockOutput::processBlock(int numSamples, double sampleRate, double bpm, bool playing)
{
    if (!isEnabled.load(std::memory_order_relaxed))
        return;

    if (resetClockAccumulatorRequested.exchange(false, std::memory_order_acq_rel))
        clockAccumulator = 0.0;

    if (!playing || bpm <= 0.0 || sampleRate <= 0.0 || !outputDispatcher->isConnected())
        return;

    // MIDI Clock: 24 pulses per quarter note
    double samplesPerClock = (60.0 / bpm) * sampleRate / 24.0;

    clockAccumulator += numSamples;

    while (clockAccumulator >= samplesPerClock)
    {
        outputDispatcher->enqueueRealtimeByte(0xF8); // Timing Clock
        clockAccumulator -= samplesPerClock;
    }
}

void MIDIClockOutput::sendStart()
{
    if (isEnabled.load(std::memory_order_acquire) && outputDispatcher->isConnected())
    {
        resetClockAccumulatorRequested.store(true, std::memory_order_release);
        const std::uint8_t start = 0xFA;
        outputDispatcher->sendControlMessage(&start, 1);
    }
}

void MIDIClockOutput::sendStop()
{
    if (isEnabled.load(std::memory_order_acquire) && outputDispatcher->isConnected())
    {
        const std::uint8_t stop = 0xFC;
        outputDispatcher->sendControlMessage(&stop, 1);
    }
}

void MIDIClockOutput::sendContinue()
{
    if (isEnabled.load(std::memory_order_acquire) && outputDispatcher->isConnected())
    {
        const std::uint8_t resume = 0xFB;
        outputDispatcher->sendControlMessage(&resume, 1);
    }
}

//==============================================================================
// MIDIClockInput
//==============================================================================

MIDIClockInput::~MIDIClockInput()
{
    disconnect();
}

bool MIDIClockInput::connect(const juce::String& midiInputName)
{
    disconnect();
    auto devices = juce::MidiInput::getAvailableDevices();
    for (const auto& d : devices)
    {
        if (d.name == midiInputName)
        {
            input = juce::MidiInput::openDevice(d.identifier, this);
            if (input)
            {
                input->start();
                juce::Logger::writeToLog("MIDIClockInput: Connected to " + midiInputName);
            }
            break;
        }
    }
    return input != nullptr;
}

void MIDIClockInput::disconnect()
{
    if (input)
    {
        input->stop();
        input.reset();
    }
    locked = false;
    clockCount = 0;
}

void MIDIClockInput::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    juce::ignoreUnused(source);
    if (!isEnabled) return;

    auto rawByte = message.getRawData()[0];

    if (rawByte == 0xF8) // Timing Clock
    {
        double now = juce::Time::getMillisecondCounterHiRes() / 1000.0;

        if (clockCount > 0 && lastClockTime > 0.0)
        {
            double interval = now - lastClockTime;
            if (interval > 0.0 && interval < 1.0) // Sanity check
            {
                // BPM = 60 / (interval_per_clock * 24)
                double instantBPM = 60.0 / (interval * kClocksPerBeat);

                // Simple exponential moving average for smoothing
                double alpha = 0.1;
                double smoothedBPM = externalBPM.load() * (1.0 - alpha) + instantBPM * alpha;
                externalBPM = smoothedBPM;
                locked = true;

                if (clockCount % kMeasureWindow == 0 && onBPMUpdate)
                    onBPMUpdate(smoothedBPM);
            }
        }

        lastClockTime = now;
        clockCount++;
    }
    else if (rawByte == 0xFA) // Start
    {
        externalPlaying = true;
        clockCount = 0;
        lastClockTime = 0.0;
        if (onExternalStart)
            juce::MessageManager::callAsync(onExternalStart);
    }
    else if (rawByte == 0xFB) // Continue
    {
        externalPlaying = true;
        if (onExternalContinue)
            juce::MessageManager::callAsync(onExternalContinue);
    }
    else if (rawByte == 0xFC) // Stop
    {
        externalPlaying = false;
        locked = false;
        if (onExternalStop)
            juce::MessageManager::callAsync(onExternalStop);
    }
}

//==============================================================================
// MTCGenerator
//==============================================================================

MTCGenerator::MTCGenerator()
    : outputDispatcher(std::make_unique<TimecodeMIDIOutputDispatcher>())
{
}

MTCGenerator::~MTCGenerator()
{
    disconnect();
}

bool MTCGenerator::connect(const juce::String& midiOutputName)
{
    disconnect();
    const bool connected = outputDispatcher->connect(midiOutputName);
    outputDispatcher->setRealtimeEnabled(isEnabled.load(std::memory_order_acquire));
    resetGeneratorStateRequested.store(true, std::memory_order_release);
    if (connected)
        juce::Logger::writeToLog("MTCGenerator: Connected to " + midiOutputName);
    return connected;
}

void MTCGenerator::disconnect()
{
    outputDispatcher->setRealtimeEnabled(false);
    outputDispatcher->disconnect();
    resetGeneratorStateRequested.store(true, std::memory_order_release);
}

bool MTCGenerator::isConnected() const noexcept
{
    return outputDispatcher->isConnected();
}

void MTCGenerator::setEnabled(bool enabled) noexcept
{
    isEnabled.store(enabled, std::memory_order_release);
    outputDispatcher->setRealtimeEnabled(enabled);
    if (!enabled)
        resetGeneratorStateRequested.store(true, std::memory_order_release);
}

void MTCGenerator::setFrameRate(SMPTEFrameRate rate) noexcept
{
    frameRate.store(rate, std::memory_order_release);
    resetGeneratorStateRequested.store(true, std::memory_order_release);
}

double MTCGenerator::getActualFrameRate(SMPTEFrameRate rate) noexcept
{
    switch (rate)
    {
        case SMPTEFrameRate::fps24:     return 24.0;
        case SMPTEFrameRate::fps25:     return 25.0;
        case SMPTEFrameRate::fps2997df: return 29.97;
        case SMPTEFrameRate::fps30:     return 30.0;
    }
    return 25.0;
}

MTCGenerator::SMPTETime MTCGenerator::positionToSMPTE(double seconds, SMPTEFrameRate rate)
{
    SMPTETime t;
    const double fps = getActualFrameRate(rate);

    int totalFrames = (int)(seconds * fps);

    // Drop frame compensation for 29.97
    if (rate == SMPTEFrameRate::fps2997df)
    {
        // Drop frame: skip frame 0 and 1 at the start of each minute
        // except every 10th minute
        int d = totalFrames;
        int dropFrames = 2;
        int framesPerMinute = 30 * 60 - dropFrames;
        int framesPer10Min = framesPerMinute * 10 + dropFrames;

        int tenMinBlocks = d / framesPer10Min;
        int remainder = d % framesPer10Min;

        int adjusted = tenMinBlocks * 10 * 30 * 60;
        if (remainder < dropFrames)
            adjusted += remainder;
        else
            adjusted += dropFrames + (int)((remainder - dropFrames) / (double)framesPerMinute) * 30 * 60
                        + (remainder - dropFrames) % framesPerMinute;

        totalFrames = adjusted;
    }

    t.frames = totalFrames % (int)fps;
    int totalSeconds = totalFrames / (int)fps;
    t.seconds = totalSeconds % 60;
    t.minutes = (totalSeconds / 60) % 60;
    t.hours = (totalSeconds / 3600) % 24;

    return t;
}

void MTCGenerator::processBlock(int numSamples, double sampleRate, double positionSeconds, bool playing)
{
    if (!isEnabled.load(std::memory_order_relaxed))
        return;

    if (resetGeneratorStateRequested.exchange(false, std::memory_order_acq_rel))
    {
        qfCounter = 0;
        qfAccumulator = 0.0;
    }

    if (!playing || sampleRate <= 0.0 || !outputDispatcher->isConnected())
        return;

    // MTC quarter-frame rate: 2 per frame × fps / 4 = fps/2 quarter-frames per second
    // But the standard says: 4 quarter-frames per frame, so 4 * fps QF per second
    // Each QF is sent at fps * 4 rate (e.g., at 25fps = 100 QF/sec)
    const auto currentFrameRate = frameRate.load(std::memory_order_acquire);
    const double fps = getActualFrameRate(currentFrameRate);
    const double samplesPerQF = sampleRate / (fps * 4.0);

    qfAccumulator += numSamples;

    while (qfAccumulator >= samplesPerQF)
    {
        const SMPTETime t = positionToSMPTE(positionSeconds, currentFrameRate);

        int data = 0;
        switch (qfCounter)
        {
            case 0: data = (0x00) | (t.frames & 0x0F); break;
            case 1: data = (0x10) | ((t.frames >> 4) & 0x01); break;
            case 2: data = (0x20) | (t.seconds & 0x0F); break;
            case 3: data = (0x30) | ((t.seconds >> 4) & 0x03); break;
            case 4: data = (0x40) | (t.minutes & 0x0F); break;
            case 5: data = (0x50) | ((t.minutes >> 4) & 0x03); break;
            case 6: data = (0x60) | (t.hours & 0x0F); break;
            case 7: data = (0x70) | ((t.hours >> 4) & 0x01)
                | (static_cast<int>(currentFrameRate) << 1); break;
        }

        // Quarter-frame message: F1 <data>
        const std::uint8_t message[2] {
            0xF1,
            static_cast<std::uint8_t>(data)
        };
        outputDispatcher->enqueueRealtimeMessage(message, 2);

        qfCounter = (qfCounter + 1) & 7;
        qfAccumulator -= samplesPerQF;
    }
}

void MTCGenerator::sendFullFrame(double positionSeconds)
{
    if (!isEnabled.load(std::memory_order_acquire) || !outputDispatcher->isConnected())
        return;

    const auto currentFrameRate = frameRate.load(std::memory_order_acquire);
    const SMPTETime t = positionToSMPTE(positionSeconds, currentFrameRate);

    // Full frame SysEx: F0 7F 7F 01 01 hr mn sc fr F7
    std::uint8_t sysex[10];
    sysex[0] = 0xF0;
    sysex[1] = 0x7F; // Universal real-time
    sysex[2] = 0x7F; // All devices
    sysex[3] = 0x01; // MTC
    sysex[4] = 0x01; // Full frame
    sysex[5] = static_cast<std::uint8_t>(
        (static_cast<int>(currentFrameRate) << 5) | (t.hours & 0x1F));
    sysex[6] = static_cast<std::uint8_t>(t.minutes & 0x3F);
    sysex[7] = static_cast<std::uint8_t>(t.seconds & 0x3F);
    sysex[8] = static_cast<std::uint8_t>(t.frames & 0x1F);
    sysex[9] = 0xF7;

    outputDispatcher->sendControlMessage(sysex, 10);
}

//==============================================================================
// MTCReceiver
//==============================================================================

MTCReceiver::~MTCReceiver()
{
    disconnect();
}

bool MTCReceiver::connect(const juce::String& midiInputName)
{
    disconnect();
    auto devices = juce::MidiInput::getAvailableDevices();
    for (const auto& d : devices)
    {
        if (d.name == midiInputName)
        {
            input = juce::MidiInput::openDevice(d.identifier, this);
            if (input)
            {
                input->start();
                juce::Logger::writeToLog("MTCReceiver: Connected to " + midiInputName);
            }
            break;
        }
    }
    return input != nullptr;
}

void MTCReceiver::disconnect()
{
    if (input)
    {
        input->stop();
        input.reset();
    }
    locked = false;
    qfCount = 0;
}

double MTCReceiver::assemblePosition() const
{
    int frames = (qfData[0] & 0x0F) | ((qfData[1] & 0x01) << 4);
    int seconds = (qfData[2] & 0x0F) | ((qfData[3] & 0x03) << 4);
    int minutes = (qfData[4] & 0x0F) | ((qfData[5] & 0x03) << 4);
    int hours = (qfData[6] & 0x0F) | ((qfData[7] & 0x01) << 4);

    double fps = 25.0;
    switch (detectedFrameRate)
    {
        case SMPTEFrameRate::fps24:     fps = 24.0; break;
        case SMPTEFrameRate::fps25:     fps = 25.0; break;
        case SMPTEFrameRate::fps2997df: fps = 29.97; break;
        case SMPTEFrameRate::fps30:     fps = 30.0; break;
    }

    return hours * 3600.0 + minutes * 60.0 + seconds + frames / fps;
}

void MTCReceiver::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    juce::ignoreUnused(source);
    if (!isEnabled) return;

    auto rawData = message.getRawData();
    int size = message.getRawDataSize();

    // Quarter-frame: F1 <data>
    if (size >= 2 && rawData[0] == 0xF1)
    {
        int nibble = (rawData[1] >> 4) & 0x07;
        int value = rawData[1] & 0x0F;

        qfData[nibble] = value;
        qfCount++;

        // After 8 quarter-frames, we have a complete position
        if (nibble == 7)
        {
            // Extract frame rate from byte 7
            int rateCode = (qfData[7] >> 1) & 0x03;
            detectedFrameRate = (SMPTEFrameRate)rateCode;

            double pos = assemblePosition();
            currentPosition = pos;
            locked = true;

            if (onPositionUpdate)
                juce::MessageManager::callAsync([this, pos]() { onPositionUpdate(pos); });
        }
    }
    // Full frame SysEx: F0 7F 7F 01 01 hr mn sc fr F7
    else if (size >= 10 && rawData[0] == 0xF0 && rawData[1] == 0x7F &&
             rawData[3] == 0x01 && rawData[4] == 0x01)
    {
        int rateCode = (rawData[5] >> 5) & 0x03;
        detectedFrameRate = (SMPTEFrameRate)rateCode;

        int hours = rawData[5] & 0x1F;
        int minutes = rawData[6] & 0x3F;
        int seconds = rawData[7] & 0x3F;
        int frames = rawData[8] & 0x1F;

        double fps = 25.0;
        switch (detectedFrameRate)
        {
            case SMPTEFrameRate::fps24:     fps = 24.0; break;
            case SMPTEFrameRate::fps25:     fps = 25.0; break;
            case SMPTEFrameRate::fps2997df: fps = 29.97; break;
            case SMPTEFrameRate::fps30:     fps = 30.0; break;
        }

        double pos = hours * 3600.0 + minutes * 60.0 + seconds + frames / fps;
        currentPosition = pos;
        locked = true;

        if (onPositionUpdate)
            juce::MessageManager::callAsync([this, pos]() { onPositionUpdate(pos); });
    }
}

//==============================================================================
// TimecodeSyncManager
//==============================================================================

void TimecodeSyncManager::processBlock(int numSamples, double sampleRate, double bpm,
                                        double positionSeconds, bool playing)
{
    // Always generate output if enabled (regardless of sync source)
    clockOutput.processBlock(numSamples, sampleRate, bpm, playing);
    mtcGenerator.processBlock(numSamples, sampleRate, positionSeconds, playing);
}

bool TimecodeSyncManager::isSyncLocked() const
{
    switch (syncSource)
    {
        case SyncSource::Internal:  return true; // Always locked to internal
        case SyncSource::MIDIClock: return clockInput.isLocked();
        case SyncSource::MTC:       return mtcReceiver.isLocked();
    }
    return false;
}
