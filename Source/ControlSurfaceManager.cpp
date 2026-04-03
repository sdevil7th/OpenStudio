#include "ControlSurfaceManager.h"

//==============================================================================
// GenericMIDIControl
//==============================================================================

GenericMIDIControl::GenericMIDIControl() = default;

GenericMIDIControl::~GenericMIDIControl()
{
    disconnect();
}

bool GenericMIDIControl::connect(const juce::String& midiInputName, const juce::String& midiOutputName)
{
    disconnect();

    // Open MIDI input
    auto devices = juce::MidiInput::getAvailableDevices();
    for (const auto& d : devices)
    {
        if (d.name == midiInputName)
        {
            midiInput = juce::MidiInput::openDevice(d.identifier, this);
            if (midiInput)
            {
                midiInput->start();
                juce::Logger::writeToLog("GenericMIDI: Connected input: " + midiInputName);
            }
            break;
        }
    }

    // Open MIDI output (for feedback to motorized faders)
    if (midiOutputName.isNotEmpty())
    {
        auto outDevices = juce::MidiOutput::getAvailableDevices();
        for (const auto& d : outDevices)
        {
            if (d.name == midiOutputName)
            {
                midiOutput = juce::MidiOutput::openDevice(d.identifier);
                if (midiOutput)
                    juce::Logger::writeToLog("GenericMIDI: Connected output: " + midiOutputName);
                break;
            }
        }
    }

    connected = (midiInput != nullptr);
    return connected;
}

void GenericMIDIControl::disconnect()
{
    if (midiInput)
    {
        midiInput->stop();
        midiInput.reset();
    }
    midiOutput.reset();
    connected = false;
}

void GenericMIDIControl::startLearn(const juce::String& trackId, const juce::String& parameter)
{
    learnActive = true;
    learnTrackId = trackId;
    learnParameter = parameter;
    juce::Logger::writeToLog("GenericMIDI: Learn mode started for " + trackId + "/" + parameter);
}

void GenericMIDIControl::cancelLearn()
{
    learnActive = false;
    learnTrackId.clear();
    learnParameter.clear();
}

void GenericMIDIControl::addMapping(const MIDICCMapping& mapping)
{
    juce::ScopedLock sl(mappingLock);
    int key = (mapping.channel << 8) | mapping.cc;
    mappings[key] = mapping;
    juce::Logger::writeToLog("GenericMIDI: Added mapping ch=" + juce::String(mapping.channel) +
                             " cc=" + juce::String(mapping.cc) + " -> " +
                             mapping.trackId + "/" + mapping.parameter);
}

void GenericMIDIControl::removeMapping(int channel, int cc)
{
    juce::ScopedLock sl(mappingLock);
    int key = (channel << 8) | cc;
    mappings.erase(key);
}

void GenericMIDIControl::clearMappings()
{
    juce::ScopedLock sl(mappingLock);
    mappings.clear();
}

std::vector<MIDICCMapping> GenericMIDIControl::getMappings() const
{
    juce::ScopedLock sl(mappingLock);
    std::vector<MIDICCMapping> result;
    for (const auto& pair : mappings)
        result.push_back(pair.second);
    return result;
}

void GenericMIDIControl::loadMappings(const juce::File& file)
{
    if (!file.existsAsFile()) return;

    auto json = juce::JSON::parse(file);
    if (!json.isArray()) return;

    juce::ScopedLock sl(mappingLock);
    mappings.clear();

    auto* arr = json.getArray();
    for (int i = 0; i < arr->size(); ++i)
    {
        auto item = (*arr)[i];
        MIDICCMapping m;
        m.channel = (int)item.getProperty("channel", 0);
        m.cc = (int)item.getProperty("cc", 0);
        m.trackId = item.getProperty("trackId", "").toString();
        m.parameter = item.getProperty("parameter", "").toString();
        int key = (m.channel << 8) | m.cc;
        mappings[key] = m;
    }
    juce::Logger::writeToLog("GenericMIDI: Loaded " + juce::String((int)mappings.size()) + " mappings from " + file.getFullPathName());
}

void GenericMIDIControl::saveMappings(const juce::File& file)
{
    juce::ScopedLock sl(mappingLock);
    juce::Array<juce::var> arr;
    for (const auto& pair : mappings)
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty("channel", pair.second.channel);
        obj->setProperty("cc", pair.second.cc);
        obj->setProperty("trackId", pair.second.trackId);
        obj->setProperty("parameter", pair.second.parameter);
        arr.add(juce::var(obj.get()));
    }

    file.getParentDirectory().createDirectory();
    file.replaceWithText(juce::JSON::toString(juce::var(arr)));
    juce::Logger::writeToLog("GenericMIDI: Saved " + juce::String((int)mappings.size()) + " mappings to " + file.getFullPathName());
}

void GenericMIDIControl::sendFeedback(const juce::String& trackId, const juce::String& parameter, float value)
{
    if (!midiOutput) return;

    juce::ScopedLock sl(mappingLock);
    for (const auto& pair : mappings)
    {
        if (pair.second.trackId == trackId && pair.second.parameter == parameter)
        {
            int ccValue = juce::jlimit(0, 127, (int)(value * 127.0f));
            midiOutput->sendMessageNow(juce::MidiMessage::controllerEvent(
                pair.second.channel + 1, pair.second.cc, ccValue));
            break;
        }
    }
}

void GenericMIDIControl::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    juce::ignoreUnused(source);

    if (!message.isController()) return;

    int channel = message.getChannel() - 1; // Convert to 0-based
    int cc = message.getControllerNumber();
    float value01 = message.getControllerValue() / 127.0f;

    // MIDI Learn mode: capture this CC
    if (learnActive)
    {
        MIDICCMapping newMapping;
        newMapping.channel = channel;
        newMapping.cc = cc;
        newMapping.trackId = learnTrackId;
        newMapping.parameter = learnParameter;
        addMapping(newMapping);

        learnActive = false;
        learnTrackId.clear();
        learnParameter.clear();
        return;
    }

    // Look up mapping
    juce::ScopedLock sl(mappingLock);
    int key = (channel << 8) | cc;
    auto it = mappings.find(key);

    // Also try "any channel" mapping (-1 << 8 | cc)
    if (it == mappings.end())
    {
        key = (-1 << 8) | cc;
        it = mappings.find(key);
    }

    if (it == mappings.end() || !callback) return;

    const auto& m = it->second;

    if (m.parameter == "volume")
        callback->onControlSurfaceTrackVolume(m.trackId, value01);
    else if (m.parameter == "pan")
        callback->onControlSurfaceTrackPan(m.trackId, value01 * 2.0f - 1.0f); // Map 0-1 to -1..+1
    else if (m.parameter == "mute")
        callback->onControlSurfaceTrackMute(m.trackId, value01 > 0.5f);
    else if (m.parameter == "solo")
        callback->onControlSurfaceTrackSolo(m.trackId, value01 > 0.5f);
    else if (m.parameter == "recordArm")
        callback->onControlSurfaceTrackRecordArm(m.trackId, value01 > 0.5f);
    else if (m.parameter == "play")
        callback->onControlSurfaceTransportPlay();
    else if (m.parameter == "stop")
        callback->onControlSurfaceTransportStop();
    else if (m.parameter == "record")
        callback->onControlSurfaceTransportRecord();
    else if (m.parameter == "masterVolume")
        callback->onControlSurfaceMasterVolume(value01);
}

//==============================================================================
// OSCControl
//==============================================================================

OSCControl::OSCControl() = default;

OSCControl::~OSCControl()
{
    disconnect();
}

bool OSCControl::connect(int receivePort, const juce::String& sendHost, int sendPort)
{
    disconnect();

    // Start receiving OSC
    if (!receiver.connect(receivePort))
    {
        juce::Logger::writeToLog("OSC: Failed to listen on port " + juce::String(receivePort));
        return false;
    }
    receiver.addListener(this);

    // Connect sender
    if (sendHost.isNotEmpty() && sendPort > 0)
    {
        if (!sender.connect(sendHost, sendPort))
        {
            juce::Logger::writeToLog("OSC: Failed to connect sender to " + sendHost + ":" + juce::String(sendPort));
        }
    }

    connected = true;
    juce::Logger::writeToLog("OSC: Connected - receive:" + juce::String(receivePort) +
                             " send:" + sendHost + ":" + juce::String(sendPort));
    return true;
}

void OSCControl::disconnect()
{
    receiver.removeListener(this);
    receiver.disconnect();
    sender.disconnect();
    connected = false;
}

void OSCControl::sendTrackState(int trackIndex, const juce::String& param, float value)
{
    if (!connected) return;
    juce::String address = "/track/" + juce::String(trackIndex + 1) + "/" + param;
    sender.send(juce::OSCMessage(juce::OSCAddressPattern(address), value));
}

void OSCControl::sendTransportState(const juce::String& param, float value)
{
    if (!connected) return;
    juce::String address = "/transport/" + param;
    sender.send(juce::OSCMessage(juce::OSCAddressPattern(address), value));
}

void OSCControl::oscMessageReceived(const juce::OSCMessage& message)
{
    if (!callback) return;

    juce::String address = message.getAddressPattern().toString();

    // Parse address: /track/{index}/param or /transport/param or /master/param
    juce::StringArray parts;
    parts.addTokens(address, "/", "");
    parts.removeEmptyStrings();

    if (parts.size() < 2) return;

    float value = 0.0f;
    if (message.size() > 0 && message[0].isFloat32())
        value = message[0].getFloat32();
    else if (message.size() > 0 && message[0].isInt32())
        value = (float)message[0].getInt32();

    if (parts[0] == "track" && parts.size() >= 3)
    {
        int trackIndex = parts[1].getIntValue() - 1; // 1-based to 0-based

        // Refresh track ID cache from callback
        if (callback)
            cachedTrackIds = callback->getTrackIds();

        if (trackIndex < 0 || trackIndex >= (int)cachedTrackIds.size()) return;
        const auto& trackId = cachedTrackIds[(size_t)trackIndex];

        if (parts[2] == "volume")
            callback->onControlSurfaceTrackVolume(trackId, value);
        else if (parts[2] == "pan")
            callback->onControlSurfaceTrackPan(trackId, value);
        else if (parts[2] == "mute")
            callback->onControlSurfaceTrackMute(trackId, value > 0.5f);
        else if (parts[2] == "solo")
            callback->onControlSurfaceTrackSolo(trackId, value > 0.5f);
        else if (parts[2] == "arm")
            callback->onControlSurfaceTrackRecordArm(trackId, value > 0.5f);
    }
    else if (parts[0] == "transport")
    {
        if (parts[1] == "play")
            callback->onControlSurfaceTransportPlay();
        else if (parts[1] == "stop")
            callback->onControlSurfaceTransportStop();
        else if (parts[1] == "record")
            callback->onControlSurfaceTransportRecord();
    }
    else if (parts[0] == "master")
    {
        if (parts[1] == "volume")
            callback->onControlSurfaceMasterVolume(value);
    }
}

//==============================================================================
// MCUControl — Mackie Control Universal
//==============================================================================

MCUControl::MCUControl() = default;

MCUControl::~MCUControl()
{
    disconnect();
}

bool MCUControl::connect(const juce::String& midiInputName, const juce::String& midiOutputName)
{
    disconnect();

    auto devices = juce::MidiInput::getAvailableDevices();
    for (const auto& d : devices)
    {
        if (d.name == midiInputName)
        {
            midiInput = juce::MidiInput::openDevice(d.identifier, this);
            if (midiInput)
            {
                midiInput->start();
                juce::Logger::writeToLog("MCU: Connected input: " + midiInputName);
            }
            break;
        }
    }

    if (midiOutputName.isNotEmpty())
    {
        auto outDevices = juce::MidiOutput::getAvailableDevices();
        for (const auto& d : outDevices)
        {
            if (d.name == midiOutputName)
            {
                midiOutput = juce::MidiOutput::openDevice(d.identifier);
                if (midiOutput)
                    juce::Logger::writeToLog("MCU: Connected output: " + midiOutputName);
                break;
            }
        }
    }

    connected = (midiInput != nullptr);
    if (connected)
        refreshSurface();
    return connected;
}

void MCUControl::disconnect()
{
    if (midiInput)
    {
        midiInput->stop();
        midiInput.reset();
    }
    midiOutput.reset();
    connected = false;
}

void MCUControl::updateFader(int channel, float value01)
{
    if (!midiOutput || channel < 0 || channel > 8) return;
    int value14 = juce::jlimit(0, 16383, (int)(value01 * 16383.0f));
    int lsb = value14 & 0x7F;
    int msb = (value14 >> 7) & 0x7F;
    // MCU faders use pitch bend on channels 0-7 (channel 8 = master)
    midiOutput->sendMessageNow(juce::MidiMessage::pitchWheel(channel + 1, (msb << 7) | lsb));
}

void MCUControl::updateVPot(int channel, int mode, int value)
{
    if (!midiOutput || channel < 0 || channel > 7) return;
    // V-Pot LED ring: CC 0x30+channel, value = (mode << 4) | position
    int ccValue = ((mode & 0x07) << 4) | (value & 0x0F);
    midiOutput->sendMessageNow(juce::MidiMessage::controllerEvent(1, 0x30 + channel, ccValue));
}

void MCUControl::updateMeter(int channel, int level)
{
    if (!midiOutput || channel < 0 || channel > 7) return;
    // Channel pressure / aftertouch: high nibble = channel, low nibble = level (0-12)
    int meterValue = ((channel & 0x07) << 4) | juce::jlimit(0, 12, level);
    midiOutput->sendMessageNow(juce::MidiMessage::channelPressureChange(1, meterValue));
}

void MCUControl::updateLCD(int channel, const juce::String& topLine, const juce::String& bottomLine)
{
    if (!midiOutput || channel < 0 || channel > 7) return;

    // MCU LCD uses SysEx: F0 00 00 66 14 12 <offset> <chars...> F7
    // Each channel gets 7 chars, top row offset 0, bottom row offset 56
    auto sendLCDText = [&](int rowOffset, const juce::String& text) {
        int offset = rowOffset + channel * 7;
        juce::String padded = text.paddedRight(' ', 7).substring(0, 7);

        uint8_t sysex[15];
        sysex[0] = 0xF0;
        sysex[1] = 0x00; sysex[2] = 0x00; sysex[3] = 0x66; // Mackie
        sysex[4] = 0x14; // MCU
        sysex[5] = 0x12; // LCD write
        sysex[6] = (uint8_t)offset;
        for (int i = 0; i < 7; ++i)
            sysex[7 + i] = (uint8_t)padded[i];
        sysex[14] = 0xF7;

        midiOutput->sendMessageNow(juce::MidiMessage(sysex, 15));
    };

    sendLCDText(0, topLine);
    sendLCDText(56, bottomLine);
}

void MCUControl::updateButtonLED(int noteNumber, bool on)
{
    if (!midiOutput) return;
    midiOutput->sendMessageNow(juce::MidiMessage::noteOn(1, noteNumber, (uint8_t)(on ? 127 : 0)));
}

void MCUControl::refreshSurface()
{
    if (!callback || !midiOutput) return;

    cachedTrackIds = callback->getTrackIds();

    // Update all 8 channels
    for (int ch = 0; ch < 8; ++ch)
    {
        int trackIdx = bankOffset + ch;
        if (trackIdx < (int)cachedTrackIds.size())
        {
            const auto& trackId = cachedTrackIds[(size_t)trackIdx];

            // Fader position
            float vol = callback->getTrackVolume01(trackId);
            updateFader(ch, vol);

            // Pan as V-Pot (mode 1 = centered dot, value = pan mapped to 0-11)
            float pan = callback->getTrackPan(trackId);
            int panPos = juce::jlimit(0, 11, (int)((pan + 1.0f) * 5.5f));
            updateVPot(ch, 1, panPos);

            // Mute/Solo/Arm LEDs
            updateButtonLED(kMCU_Mute1 + ch, callback->getTrackMuted(trackId));
            updateButtonLED(kMCU_Solo1 + ch, callback->getTrackSoloed(trackId));

            // LCD scribble strip
            // We don't have track names from the callback — just show index
            updateLCD(ch, "Trk " + juce::String(trackIdx + 1), juce::String(vol * 100.0f, 0) + "%");
        }
        else
        {
            // No track for this channel — clear
            updateFader(ch, 0.0f);
            updateVPot(ch, 0, 0);
            updateButtonLED(kMCU_Mute1 + ch, false);
            updateButtonLED(kMCU_Solo1 + ch, false);
            updateLCD(ch, "", "");
        }
    }
}

void MCUControl::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    juce::ignoreUnused(source);

    if (message.isNoteOn())
        handleNoteOn(message.getNoteNumber(), message.getVelocity());
    else if (message.isController())
        handleCC(message.getControllerNumber(), message.getControllerValue());
    else if (message.isPitchWheel())
        handlePitchBend(message.getChannel() - 1, message.getPitchWheelValue());
}

void MCUControl::handleNoteOn(int note, int velocity)
{
    juce::ignoreUnused(velocity);
    if (!callback) return;

    // Refresh track IDs
    cachedTrackIds = callback->getTrackIds();

    // Transport buttons
    if (note == kMCU_Play)   { callback->onControlSurfaceTransportPlay(); return; }
    if (note == kMCU_Stop)   { callback->onControlSurfaceTransportStop(); return; }
    if (note == kMCU_Record) { callback->onControlSurfaceTransportRecord(); return; }

    // Bank buttons
    if (note == kMCU_BankLeft)  { bankOffset = std::max(0, bankOffset - 8); refreshSurface(); return; }
    if (note == kMCU_BankRight) { bankOffset = std::min((int)cachedTrackIds.size() - 1, bankOffset + 8); refreshSurface(); return; }
    if (note == kMCU_ChLeft)    { bankOffset = std::max(0, bankOffset - 1); refreshSurface(); return; }
    if (note == kMCU_ChRight)   { bankOffset = std::min((int)cachedTrackIds.size() - 1, bankOffset + 1); refreshSurface(); return; }

    // Channel buttons (mute, solo, rec arm, select)
    for (int ch = 0; ch < 8; ++ch)
    {
        int trackIdx = bankOffset + ch;
        if (trackIdx >= (int)cachedTrackIds.size()) continue;
        const auto& trackId = cachedTrackIds[(size_t)trackIdx];

        if (note == kMCU_Mute1 + ch)
        {
            bool current = callback->getTrackMuted(trackId);
            callback->onControlSurfaceTrackMute(trackId, !current);
            updateButtonLED(kMCU_Mute1 + ch, !current);
            return;
        }
        if (note == kMCU_Solo1 + ch)
        {
            bool current = callback->getTrackSoloed(trackId);
            callback->onControlSurfaceTrackSolo(trackId, !current);
            updateButtonLED(kMCU_Solo1 + ch, !current);
            return;
        }
        if (note == kMCU_RecArm1 + ch)
        {
            callback->onControlSurfaceTrackRecordArm(trackId, true);
            return;
        }
    }
}

void MCUControl::handleCC(int cc, int value)
{
    if (!callback) return;

    // V-Pot rotation: CC 0x10-0x17 for channels 1-8
    // Value: bit 6 = direction (0=CW, 1=CCW), bits 0-5 = speed
    if (cc >= 0x10 && cc <= 0x17)
    {
        int ch = cc - 0x10;
        int trackIdx = bankOffset + ch;
        if (trackIdx >= (int)cachedTrackIds.size()) return;
        const auto& trackId = cachedTrackIds[(size_t)trackIdx];

        bool ccw = (value & 0x40) != 0;
        int speed = value & 0x3F;
        float delta = (ccw ? -1.0f : 1.0f) * speed * 0.05f;

        // Adjust pan
        float currentPan = callback->getTrackPan(trackId);
        float newPan = juce::jlimit(-1.0f, 1.0f, currentPan + delta);
        callback->onControlSurfaceTrackPan(trackId, newPan);

        int panPos = juce::jlimit(0, 11, (int)((newPan + 1.0f) * 5.5f));
        updateVPot(ch, 1, panPos);
    }
}

void MCUControl::handlePitchBend(int channel, int value14bit)
{
    if (!callback || channel < 0 || channel > 8) return;

    if (channel == 8)
    {
        // Master fader
        float value01 = value14bit / 16383.0f;
        callback->onControlSurfaceMasterVolume(value01);
        return;
    }

    int trackIdx = bankOffset + channel;
    cachedTrackIds = callback->getTrackIds();
    if (trackIdx >= (int)cachedTrackIds.size()) return;

    float value01 = value14bit / 16383.0f;
    callback->onControlSurfaceTrackVolume(cachedTrackIds[(size_t)trackIdx], value01);
}

//==============================================================================
// ControlSurfaceManager
//==============================================================================

ControlSurfaceManager::ControlSurfaceManager() = default;
ControlSurfaceManager::~ControlSurfaceManager() = default;

void ControlSurfaceManager::setCallback(ControlSurfaceCallback* cb)
{
    midiControl.setCallback(cb);
    oscControl.setCallback(cb);
    mcuControl.setCallback(cb);
}

juce::StringArray ControlSurfaceManager::getAvailableMIDIInputs()
{
    juce::StringArray names;
    for (const auto& d : juce::MidiInput::getAvailableDevices())
        names.add(d.name);
    return names;
}

juce::StringArray ControlSurfaceManager::getAvailableMIDIOutputs()
{
    juce::StringArray names;
    for (const auto& d : juce::MidiOutput::getAvailableDevices())
        names.add(d.name);
    return names;
}
