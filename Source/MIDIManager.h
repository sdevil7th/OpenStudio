#pragma once

#include <JuceHeader.h>
#include <vector>
#include <functional>

/**
 * MIDIManager handles MIDI device enumeration and input routing.
 * Implements MidiInputCallback to receive MIDI messages from devices.
 */
class MIDIManager : public juce::MidiInputCallback
{
public:
    // Callback type for MIDI messages: (deviceName, channel, message)
    using MIDIMessageCallback = std::function<void(const juce::String&, int, const juce::MidiMessage&)>;
    
    MIDIManager();
    ~MIDIManager() override;
    
    // Device enumeration
    juce::StringArray getAvailableDevices() const;
    
    // Device management
    bool openDevice(const juce::String& deviceName);
    void closeDevice(const juce::String& deviceName);
    void closeAllDevices();
    
    // Get list of currently open devices
    juce::StringArray getOpenDevices() const;
    
    // Set callback for MIDI messages
    void setMessageCallback(MIDIMessageCallback callback);
    
    // MidiInputCallback implementation
    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message) override;
    
private:
    struct DeviceInfo
    {
        juce::String name;
        std::unique_ptr<juce::MidiInput> input;
        bool isOpen;
    };
    
    std::vector<DeviceInfo> devices;
    MIDIMessageCallback messageCallback;
    juce::CriticalSection lock;
    
    // Find device by name
    DeviceInfo* findDevice(const juce::String& name);
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MIDIManager)
};
