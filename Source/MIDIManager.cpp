#include "MIDIManager.h"

MIDIManager::MIDIManager()
{
    juce::Logger::writeToLog("MIDIManager: Initializing...");
}

MIDIManager::~MIDIManager()
{
    closeAllDevices();
}

juce::StringArray MIDIManager::getAvailableDevices() const
{
    juce::StringArray deviceNames;
    auto devices = juce::MidiInput::getAvailableDevices();
    
    for (const auto& device : devices)
    {
        deviceNames.add(device.name);
    }
    
    return deviceNames;
}

bool MIDIManager::openDevice(const juce::String& deviceName)
{
    juce::ScopedLock sl(lock);
    
    // Check if already open
    if (findDevice(deviceName) != nullptr)
    {
        juce::Logger::writeToLog("MIDIManager: Device already open: " + deviceName);
        return true;
    }
    
    // Find device in available devices
    auto availableDevices = juce::MidiInput::getAvailableDevices();
    int deviceIndex = -1;
    
    for (int i = 0; i < availableDevices.size(); ++i)
    {
        if (availableDevices[i].name == deviceName)
        {
            deviceIndex = i;
            break;
        }
    }
    
    if (deviceIndex == -1)
    {
        juce::Logger::writeToLog("MIDIManager: Device not found: " + deviceName);
        return false;
    }
    
    // Open the device
    auto midiInput = juce::MidiInput::openDevice(availableDevices[deviceIndex].identifier, this);
    
    if (midiInput == nullptr)
    {
        juce::Logger::writeToLog("MIDIManager: Failed to open device: " + deviceName);
        return false;
    }
    
    midiInput->start();
    
    DeviceInfo info;
    info.name = deviceName;
    info.input = std::move(midiInput);
    info.isOpen = true;
    
    devices.push_back(std::move(info));
    
    juce::Logger::writeToLog("MIDIManager: Opened device: " + deviceName);
    return true;
}

void MIDIManager::closeDevice(const juce::String& deviceName)
{
    juce::ScopedLock sl(lock);
    
    auto it = std::remove_if(devices.begin(), devices.end(),
        [&deviceName](const DeviceInfo& info) {
            return info.name == deviceName;
        });
    
    if (it != devices.end())
    {
        devices.erase(it, devices.end());
        juce::Logger::writeToLog("MIDIManager: Closed device: " + deviceName);
    }
}

void MIDIManager::closeAllDevices()
{
    juce::ScopedLock sl(lock);
    devices.clear();
    juce::Logger::writeToLog("MIDIManager: Closed all devices");
}

juce::StringArray MIDIManager::getOpenDevices() const
{
    juce::ScopedLock sl(lock);
    juce::StringArray openDevices;
    
    for (const auto& device : devices)
    {
        if (device.isOpen)
            openDevices.add(device.name);
    }
    
    return openDevices;
}

void MIDIManager::setMessageCallback(MIDIMessageCallback callback)
{
    juce::ScopedLock sl(lock);
    messageCallback = callback;
}

void MIDIManager::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    juce::ScopedLock sl(lock);
    
    if (messageCallback == nullptr)
        return;
    
    // Find which device sent this message
    juce::String deviceName;
    for (const auto& device : devices)
    {
        if (device.input.get() == source)
        {
            deviceName = device.name;
            break;
        }
    }
    
    // Extract MIDI channel (1-16)
    int channel = message.getChannel();
    
    // Call the callback
    messageCallback(deviceName, channel, message);
}

MIDIManager::DeviceInfo* MIDIManager::findDevice(const juce::String& name)
{
    for (auto& device : devices)
    {
        if (device.name == name)
            return &device;
    }
    return nullptr;
}
