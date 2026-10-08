#pragma once

#include <JuceHeader.h>
#include <cmath>

namespace AudioDeviceConfiguration
{
// Message-thread transaction. Explicit empty names mean disabled; only a type
// switch requesting defaults may substitute the driver's default devices.
template <typename ConfigureChannels>
juce::String apply(juce::AudioDeviceManager& manager,
                   const juce::String& typeName,
                   juce::AudioDeviceManager::AudioDeviceSetup setup,
                   bool useDefaultDevices,
                   bool inputAllowed,
                   ConfigureChannels configureChannels)
{
    if (!std::isfinite(setup.sampleRate) || setup.sampleRate <= 0.0)
        return "The requested audio sample rate must be positive and finite.";
    if (setup.bufferSize <= 0)
        return "The requested audio buffer size must be positive.";

    juce::AudioIODeviceType* type = nullptr;
    for (auto* candidate : manager.getAvailableDeviceTypes())
        if (candidate->getTypeName() == typeName) type = candidate;
    if (type == nullptr) return "The requested audio system is unavailable: " + typeName;
    type->scanForDevices();
    const auto inputs = type->getDeviceNames(true);
    const auto outputs = type->getDeviceNames(false);
    if (useDefaultDevices)
    {
        setup.inputDeviceName = inputAllowed ? inputs[type->getDefaultDeviceIndex(true)] : juce::String();
        setup.outputDeviceName = outputs[type->getDefaultDeviceIndex(false)];
        if (setup.inputDeviceName.isEmpty() && setup.outputDeviceName.isEmpty())
            return typeName == "JACK"
                ? "JACK has no available audio ports. Start a JACK server or configure PipeWire's JACK support, or select ALSA."
                : "No audio devices are available for " + typeName + ".";
    }
    if (!inputAllowed) setup.inputDeviceName.clear();
    if (setup.inputDeviceName.isNotEmpty() && !inputs.contains(setup.inputDeviceName))
        return "The selected input device is unavailable: " + setup.inputDeviceName;
    if (setup.outputDeviceName.isNotEmpty() && !outputs.contains(setup.outputDeviceName))
        return "The selected output device is unavailable: " + setup.outputDeviceName;
    configureChannels(setup);

    // Retain MIDI selections and unrelated manager settings when changing audio.
    auto previous = manager.createStateXml();
    if (previous == nullptr) previous = std::make_unique<juce::XmlElement>("DEVICESETUP");
    const auto writeSetup = [] (juce::XmlElement& xml, const juce::String& name,
                               const juce::AudioDeviceManager::AudioDeviceSetup& value)
    {
        xml.removeAttribute("audioDeviceName");
        xml.setAttribute("deviceType", name);
        xml.setAttribute("audioInputDeviceName", value.inputDeviceName);
        xml.setAttribute("audioOutputDeviceName", value.outputDeviceName);
        xml.setAttribute("audioDeviceRate", value.sampleRate);
        xml.setAttribute("audioDeviceBufferSize", value.bufferSize);
        xml.setAttribute("audioDeviceInChans", value.inputChannels.toString(2));
        xml.setAttribute("audioDeviceOutChans", value.outputChannels.toString(2));
    };
    auto oldSetup = manager.getAudioDeviceSetup();
    if (!inputAllowed)
    {
        oldSetup.inputDeviceName.clear();
        oldSetup.inputChannels.clear();
        oldSetup.useDefaultInputChannels = false;
    }
    writeSetup(*previous, manager.getCurrentAudioDeviceType(), oldSetup);
    auto requested = *previous;
    writeSetup(requested, typeName, setup);
    // JUCE compares names/setup before considering the device type. Different
    // drivers may expose identical names, so explicitly retire the old device.
    if (manager.getCurrentAudioDeviceType() != typeName)
        manager.closeAudioDevice();
    auto error = manager.initialise(setup.inputChannels.countNumberOfSetBits(),
                                    setup.outputChannels.countNumberOfSetBits(),
                                    &requested, false);
    if (error.isEmpty()
        && (setup.inputDeviceName.isNotEmpty() || setup.outputDeviceName.isNotEmpty())
        && manager.getCurrentAudioDevice() == nullptr)
        error = "The audio system did not open the selected device.";
    if (error.isNotEmpty())
    {
        manager.closeAudioDevice();
        const auto restoreError = manager.initialise(oldSetup.inputChannels.countNumberOfSetBits(),
                                                     oldSetup.outputChannels.countNumberOfSetBits(),
                                                     previous.get(), false);
        if (restoreError.isNotEmpty())
            error += " Previous audio settings could not be restored: " + restoreError;
    }
    return error;
}
}
