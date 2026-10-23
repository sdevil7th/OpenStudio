#pragma once

#include <JuceHeader.h>
#include <cmath>

namespace AudioDeviceConfiguration
{
inline juce::String resolveDeviceName(const juce::var& request,
                                     const juce::Identifier& key,
                                     const juce::StringArray& available,
                                     int defaultIndex,
                                     bool useDefaultDevices)
{
    const auto requested = request.getProperty(key, {}).toString();
    if (!useDefaultDevices && request.hasProperty(key) && requested.isEmpty())
        return {};
    if (available.contains(requested))
        return requested;
    return available.isEmpty() ? juce::String()
        : available[juce::jlimit(0, available.size() - 1, defaultIndex)];
}

struct CoupledDeviceNames
{
    juce::String input;
    juce::String output;
};

// A scalar settings edit must retain an explicitly disabled side. Missing names
// and a new audio-system selection still use the driver's coupled defaults.
inline CoupledDeviceNames resolveCoupledDeviceNames(const juce::var& request,
                                                    const juce::String& resolvedInput,
                                                    const juce::String& resolvedOutput,
                                                    bool useDefaultDevices)
{
    const auto requestedInput = request.getProperty("inputDevice", {}).toString();
    const auto requestedOutput = request.getProperty("outputDevice", {}).toString();
    if (!useDefaultDevices && request.hasProperty("inputDevice") && requestedInput.isEmpty()
        && requestedOutput.isNotEmpty() && requestedOutput == resolvedOutput)
        return { {}, resolvedOutput };
    if (!useDefaultDevices && request.hasProperty("outputDevice") && requestedOutput.isEmpty()
        && requestedInput.isNotEmpty() && requestedInput == resolvedInput)
        return { resolvedInput, {} };

    const auto selected = resolvedOutput.isNotEmpty() ? resolvedOutput : resolvedInput;
    return { selected, selected };
}

// ASIO exposes one coupled device even when only its input or output is active.
// Treat an inactive side as absent, rather than probing the streaming driver a
// second time just because its saved input/output names differ from the draft.
inline bool isSameStreamingDevice(const juce::String& requestedType,
                                  const juce::String& requestedInput,
                                  const juce::String& requestedOutput,
                                  const juce::String& activeType,
                                  const juce::String& activeInput,
                                  const juce::String& activeOutput,
                                  bool separateInputsAndOutputs)
{
    if (requestedType != activeType)
        return false;
    if (separateInputsAndOutputs)
        return requestedInput == activeInput && requestedOutput == activeOutput;

    const auto selected = requestedOutput.isNotEmpty() ? requestedOutput : requestedInput;
    return selected.isNotEmpty()
        && (requestedInput.isEmpty() || requestedInput == selected)
        && (requestedOutput.isEmpty() || requestedOutput == selected)
        && (activeInput.isNotEmpty() || activeOutput.isNotEmpty())
        && (activeInput.isEmpty() || activeInput == selected)
        && (activeOutput.isEmpty() || activeOutput == selected);
}

// Message-thread transaction. Explicit empty names mean disabled; only a type
// switch requesting defaults may substitute the driver's default devices.
template <typename ConfigureChannels>
juce::String apply(juce::AudioDeviceManager& manager,
                   const juce::String& typeName,
                   juce::AudioDeviceManager::AudioDeviceSetup setup,
                   bool useDefaultDevices,
                   bool inputAllowed,
                   ConfigureChannels configureChannels,
                   bool verifySampleRate = true,
                   bool verifyBufferSize = true,
                   juce::AudioDeviceManager::AudioDeviceSetup* acceptedSetup = nullptr)
{
    if (acceptedSetup != nullptr)
        *acceptedSetup = {};
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
    if (auto* device = manager.getCurrentAudioDevice())
    {
        auto accepted = manager.getAudioDeviceSetup();
        accepted.sampleRate = device->getCurrentSampleRate();
        accepted.bufferSize = device->getCurrentBufferSizeSamples();
        if (acceptedSetup != nullptr)
            *acceptedSetup = accepted;
        if (error.isEmpty()
            && ((verifySampleRate && (!std::isfinite(accepted.sampleRate)
                                     || std::abs(accepted.sampleRate - setup.sampleRate) > 1.0))
                || (verifyBufferSize && accepted.bufferSize != setup.bufferSize)))
        {
            error = "The audio driver did not accept the requested settings. Requested "
                + juce::String(setup.sampleRate, 0) + " Hz / " + juce::String(setup.bufferSize)
                + " samples; opened " + juce::String(accepted.sampleRate, 0) + " Hz / "
                + juce::String(accepted.bufferSize)
                + " samples. Choose supported settings or change them in the driver's control panel.";
        }
    }
    if (error.isEmpty()
        && (setup.inputDeviceName.isNotEmpty() || setup.outputDeviceName.isNotEmpty())
        && manager.getCurrentAudioDevice() == nullptr)
        error = "The audio system did not open the selected device.";
    if (error.isNotEmpty())
    {
        manager.closeAudioDevice();
        auto restoreError = manager.initialise(oldSetup.inputChannels.countNumberOfSetBits(),
                                               oldSetup.outputChannels.countNumberOfSetBits(),
                                               previous.get(), false);
        if (restoreError.isEmpty()
            && (oldSetup.inputDeviceName.isNotEmpty() || oldSetup.outputDeviceName.isNotEmpty()))
        {
            auto* restored = manager.getCurrentAudioDevice();
            if (restored == nullptr)
                restoreError = "The previous device did not reopen.";
            else if (!std::isfinite(restored->getCurrentSampleRate())
                     || std::abs(restored->getCurrentSampleRate() - oldSetup.sampleRate) > 1.0
                     || restored->getCurrentBufferSizeSamples() != oldSetup.bufferSize)
                restoreError = "The driver reopened at " + juce::String(restored->getCurrentSampleRate(), 0)
                    + " Hz / " + juce::String(restored->getCurrentBufferSizeSamples())
                    + " samples instead of the previous " + juce::String(oldSetup.sampleRate, 0)
                    + " Hz / " + juce::String(oldSetup.bufferSize) + " samples.";
        }
        if (restoreError.isNotEmpty())
            error += " Previous audio settings could not be restored: " + restoreError;
    }
    return error;
}
}
