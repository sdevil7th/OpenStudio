#pragma once
#include "AudioDeviceConfiguration.h"

namespace AudioDeviceConfigurationRegression
{
class Device final : public juce::AudioIODevice
{
public:
    Device(const juce::String& type, bool fail) : AudioIODevice("Interface", type), failOpen(fail) {}
    juce::StringArray getOutputChannelNames() override { return {"Out 1", "Out 2"}; }
    juce::StringArray getInputChannelNames() override { return {"In 1", "In 2"}; }
    juce::Array<double> getAvailableSampleRates() override { return {44100.0, 48000.0}; }
    juce::Array<int> getAvailableBufferSizes() override { return {256, 512}; }
    int getDefaultBufferSize() override { return 512; }
    juce::String open(const juce::BigInteger& in, const juce::BigInteger& out, double sr, int bs) override
    {
        if (failOpen) return "Fixture device busy";
        inputs = in; outputs = out; rate = sr; block = bs; opened = true; return {};
    }
    void close() override { opened = false; }
    bool isOpen() override { return opened; }
    void start(juce::AudioIODeviceCallback* value) override
    { callback = value; if (callback != nullptr) callback->audioDeviceAboutToStart(this); }
    void stop() override
    { if (callback != nullptr) callback->audioDeviceStopped(); callback = nullptr; }
    bool isPlaying() override { return callback != nullptr; }
    juce::String getLastError() override { return {}; }
    int getCurrentBufferSizeSamples() override { return block; }
    double getCurrentSampleRate() override { return rate; }
    int getCurrentBitDepth() override { return 24; }
    juce::BigInteger getActiveOutputChannels() const override { return outputs; }
    juce::BigInteger getActiveInputChannels() const override { return inputs; }
    int getOutputLatencyInSamples() override { return 0; }
    int getInputLatencyInSamples() override { return 0; }
private:
    bool failOpen = false, opened = false;
    double rate = 48000.0;
    int block = 512;
    juce::BigInteger inputs, outputs;
    juce::AudioIODeviceCallback* callback = nullptr;
};

class Type final : public juce::AudioIODeviceType
{
public:
    Type(const juce::String& name, bool empty = false, bool fail = false)
        : AudioIODeviceType(name), emptyDevices(empty), failOpen(fail) {}
    void scanForDevices() override {}
    juce::StringArray getDeviceNames(bool) const override
    { return emptyDevices ? juce::StringArray() : juce::StringArray{"Interface"}; }
    int getDefaultDeviceIndex(bool) const override { return emptyDevices ? -1 : 0; }
    int getIndexOfDevice(juce::AudioIODevice*, bool) const override { return 0; }
    bool hasSeparateInputsAndOutputs() const override { return true; }
    juce::AudioIODevice* createDevice(const juce::String&, const juce::String&) override
    { return new Device(getTypeName(), failOpen); }
private:
    bool emptyDevices, failOpen;
};

template <typename Check>
void run(Check check)
{
    juce::AudioDeviceManager manager;
    // Only simulated drivers: never open or disturb a user's physical interface.
    juce::Array<juce::AudioIODeviceType*> types;
    for (auto* type : manager.getAvailableDeviceTypes()) types.add(type);
    for (auto* type : types) manager.removeAudioDeviceType(type);
    manager.addAudioDeviceType(std::make_unique<Type>("Working"));
    manager.addAudioDeviceType(std::make_unique<Type>("Other"));
    manager.addAudioDeviceType(std::make_unique<Type>("JACK", true));
    manager.addAudioDeviceType(std::make_unique<Type>("Busy", false, true));
    juce::AudioDeviceManager::AudioDeviceSetup request;
    request.sampleRate = 48000.0;
    request.bufferSize = 512;
    const auto apply = [&] (const juce::String& type, bool defaults, bool inputAllowed = true)
    {
        return AudioDeviceConfiguration::apply(manager, type, request, defaults, inputAllowed, [] (auto& setup) {
            setup.inputChannels.clear(); setup.outputChannels.clear();
            if (setup.inputDeviceName.isNotEmpty()) setup.inputChannels.setRange(0, 2, true);
            if (setup.outputDeviceName.isNotEmpty()) setup.outputChannels.setRange(0, 2, true);
            setup.useDefaultInputChannels = setup.useDefaultOutputChannels = false;
        });
    };
    check("audio_switch_defaults_open_duplex", apply("Working", true).isEmpty()
        && manager.getCurrentAudioDevice() != nullptr
        && manager.getAudioDeviceSetup().inputChannels.countNumberOfSetBits() == 2);
    check("audio_switch_other_type_opens_defaults", apply("Other", true).isEmpty()
        && manager.getCurrentAudioDeviceType() == "Other" && manager.getCurrentAudioDevice() != nullptr);
    const auto previous = manager.createStateXml()->toString();
    check("audio_switch_empty_jack_preserves_working_device", apply("JACK", true).contains("JACK")
        && manager.getCurrentAudioDeviceType() == "Other" && manager.getCurrentAudioDevice() != nullptr);
    check("audio_switch_open_failure_rolls_back", apply("Busy", true).contains("Fixture device busy")
        && manager.getCurrentAudioDeviceType() == "Other" && manager.getCurrentAudioDevice() != nullptr
        && manager.createStateXml()->toString() == previous);
    request.bufferSize = 0;
    check("audio_invalid_buffer_does_not_switch", apply("Working", true).isNotEmpty()
        && manager.getCurrentAudioDeviceType() == "Other");
    request.bufferSize = 512;
    request.sampleRate = std::numeric_limits<double>::quiet_NaN();
    check("audio_invalid_rate_does_not_switch", apply("Working", true).isNotEmpty()
        && manager.getCurrentAudioDeviceType() == "Other");
    request.sampleRate = 48000.0;
    check("audio_unknown_type_preserves_device", apply("Missing", true).isNotEmpty()
        && manager.getCurrentAudioDeviceType() == "Other");
    request.inputDeviceName = "Unplugged";
    request.outputDeviceName = "Interface";
    check("audio_unplugged_input_preserves_device", apply("Other", false).contains("unavailable")
        && manager.getCurrentAudioDevice() != nullptr);
    request.inputDeviceName.clear();
    check("audio_explicit_empty_input_stays_disabled", apply("Other", false).isEmpty()
        && manager.getAudioDeviceSetup().inputDeviceName.isEmpty()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().isZero());
    check("audio_permission_denied_defaults_remain_output_only", apply("Working", true, false).isEmpty()
        && manager.getAudioDeviceSetup().inputDeviceName.isEmpty()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().isZero());
    check("audio_permission_revoked_rollback_cannot_reopen_input", apply("Working", true).isEmpty()
        && apply("Busy", true, false).isNotEmpty()
        && manager.getCurrentAudioDevice() != nullptr
        && manager.getAudioDeviceSetup().inputDeviceName.isEmpty()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().isZero());
    request.outputDeviceName.clear();
    check("audio_explicit_disable_both_closes_device", apply("Working", false).isEmpty()
        && manager.getCurrentAudioDevice() == nullptr);
}
}
