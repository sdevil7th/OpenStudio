#include "TimecodeSync.h"

//==============================================================================
// MIDIClockOutput
//==============================================================================

MIDIClockOutput::~MIDIClockOutput()
{
    disconnect();
}

bool MIDIClockOutput::connect(const juce::String& midiOutputName)
{
    disconnect();
    auto devices = juce::MidiOutput::getAvailableDevices();
    for (const auto& d : devices)
    {
        if (d.name == midiOutputName)
        {
            output = juce::MidiOutput::openDevice(d.identifier);
            if (output)
                juce::Logger::writeToLog("MIDIClockOutput: Connected to " + midiOutputName);
            break;
        }
    }
    return output != nullptr;
}

void MIDIClockOutput::disconnect()
{
    if (output)
    {
        sendStop();
        output.reset();
    }
    clockAccumulator = 0.0;
}

void MIDIClockOutput::processBlock(int numSamples, double sampleRate, double bpm, bool playing)
{
    if (!output || !isEnabled || !playing || bpm <= 0.0 || sampleRate <= 0.0)
        return;

    // MIDI Clock: 24 pulses per quarter note
    double samplesPerClock = (60.0 / bpm) * sampleRate / 24.0;

    clockAccumulator += numSamples;

    while (clockAccumulator >= samplesPerClock)
    {
        output->sendMessageNow(juce::MidiMessage(0xF8)); // Timing Clock
        clockAccumulator -= samplesPerClock;
    }
}

void MIDIClockOutput::sendStart()
{
    if (output && isEnabled)
    {
        clockAccumulator = 0.0;
        output->sendMessageNow(juce::MidiMessage(0xFA)); // Start
    }
}

void MIDIClockOutput::sendStop()
{
    if (output && isEnabled)
        output->sendMessageNow(juce::MidiMessage(0xFC)); // Stop
}

void MIDIClockOutput::sendContinue()
{
    if (output && isEnabled)
        output->sendMessageNow(juce::MidiMessage(0xFB)); // Continue
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

MTCGenerator::~MTCGenerator()
{
    disconnect();
}

bool MTCGenerator::connect(const juce::String& midiOutputName)
{
    disconnect();
    auto devices = juce::MidiOutput::getAvailableDevices();
    for (const auto& d : devices)
    {
        if (d.name == midiOutputName)
        {
            output = juce::MidiOutput::openDevice(d.identifier);
            if (output)
                juce::Logger::writeToLog("MTCGenerator: Connected to " + midiOutputName);
            break;
        }
    }
    return output != nullptr;
}

void MTCGenerator::disconnect()
{
    output.reset();
    qfCounter = 0;
    qfAccumulator = 0.0;
}

double MTCGenerator::getActualFrameRate() const
{
    switch (frameRate)
    {
        case SMPTEFrameRate::fps24:     return 24.0;
        case SMPTEFrameRate::fps25:     return 25.0;
        case SMPTEFrameRate::fps2997df: return 29.97;
        case SMPTEFrameRate::fps30:     return 30.0;
    }
    return 25.0;
}

MTCGenerator::SMPTETime MTCGenerator::positionToSMPTE(double seconds) const
{
    SMPTETime t;
    double fps = getActualFrameRate();

    int totalFrames = (int)(seconds * fps);

    // Drop frame compensation for 29.97
    if (frameRate == SMPTEFrameRate::fps2997df)
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
    if (!output || !isEnabled || !playing || sampleRate <= 0.0)
        return;

    // MTC quarter-frame rate: 2 per frame × fps / 4 = fps/2 quarter-frames per second
    // But the standard says: 4 quarter-frames per frame, so 4 * fps QF per second
    // Each QF is sent at fps * 4 rate (e.g., at 25fps = 100 QF/sec)
    double fps = getActualFrameRate();
    double samplesPerQF = sampleRate / (fps * 4.0);

    qfAccumulator += numSamples;

    while (qfAccumulator >= samplesPerQF)
    {
        SMPTETime t = positionToSMPTE(positionSeconds);

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
            case 7: data = (0x70) | ((t.hours >> 4) & 0x01) | ((int)frameRate << 1); break;
        }

        // Quarter-frame message: F1 <data>
        output->sendMessageNow(juce::MidiMessage(0xF1, data));

        qfCounter = (qfCounter + 1) & 7;
        qfAccumulator -= samplesPerQF;
    }
}

void MTCGenerator::sendFullFrame(double positionSeconds)
{
    if (!output || !isEnabled) return;

    SMPTETime t = positionToSMPTE(positionSeconds);

    // Full frame SysEx: F0 7F 7F 01 01 hr mn sc fr F7
    uint8_t sysex[10];
    sysex[0] = 0xF0;
    sysex[1] = 0x7F; // Universal real-time
    sysex[2] = 0x7F; // All devices
    sysex[3] = 0x01; // MTC
    sysex[4] = 0x01; // Full frame
    sysex[5] = (uint8_t)(((int)frameRate << 5) | (t.hours & 0x1F));
    sysex[6] = (uint8_t)(t.minutes & 0x3F);
    sysex[7] = (uint8_t)(t.seconds & 0x3F);
    sysex[8] = (uint8_t)(t.frames & 0x1F);
    sysex[9] = 0xF7;

    output->sendMessageNow(juce::MidiMessage(sysex, 10));
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
