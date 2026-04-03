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
    rebuildDeviceRoutes();

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
        rebuildDeviceRoutes();
        juce::Logger::writeToLog("MIDIManager: Closed device: " + deviceName);
    }
}

void MIDIManager::closeAllDevices()
{
    juce::ScopedLock sl(lock);
    devices.clear();
    rebuildDeviceRoutes();
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
    messageCallback = std::make_shared<MIDIMessageCallback>(std::move(callback));
}

void MIDIManager::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message)
{
    auto callback = std::atomic_load_explicit(&messageCallback, std::memory_order_acquire);
    if (callback == nullptr || !(*callback))
        return;

    auto routes = std::atomic_load_explicit(&deviceRoutes, std::memory_order_acquire);

    juce::String deviceName;
    if (routes != nullptr)
    {
        for (const auto& route : *routes)
        {
            if (route.input == source)
            {
                deviceName = route.name;
                break;
            }
        }
    }

    int channel = message.getChannel();
    (*callback)(deviceName, channel, message);
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

void MIDIManager::rebuildDeviceRoutes()
{
    std::vector<DeviceRoute> routes;
    routes.reserve(devices.size());

    for (const auto& device : devices)
    {
        routes.push_back(DeviceRoute { device.input.get(), device.name });
    }

    std::atomic_store_explicit(
        &deviceRoutes,
        std::make_shared<const std::vector<DeviceRoute>>(std::move(routes)),
        std::memory_order_release);
}
