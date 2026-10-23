#pragma once
#include "AudioDeviceConfiguration.h"
#include <limits>
#include <memory>
#include <utility>

namespace AudioDeviceConfigurationRegression
{
enum class OpenMode { normal, busy, coerceBuffer, coerceRate, coerceRollback };

class Device final : public juce::AudioIODevice
{
public:
    Device(const juce::String& type, const juce::String& name, std::shared_ptr<OpenMode> mode)
        : AudioIODevice(name, type), openMode(std::move(mode)) {}
    juce::StringArray getOutputChannelNames() override { return {"Out 1", "Out 2"}; }
    juce::StringArray getInputChannelNames() override { return {"In 1", "In 2"}; }
    juce::Array<double> getAvailableSampleRates() override { return {44100.0, 48000.0}; }
    juce::Array<int> getAvailableBufferSizes() override { return {8, 16, 32, 64, 128, 256, 512}; }
    int getDefaultBufferSize() override { return 512; }
    juce::String open(const juce::BigInteger& in, const juce::BigInteger& out, double sr, int bs) override
    {
        if (*openMode == OpenMode::busy) return "Fixture device busy";
        inputs = in;
        outputs = out;
        rate = *openMode == OpenMode::coerceRate ? 44100.0 : sr;
        block = (*openMode == OpenMode::coerceBuffer || *openMode == OpenMode::coerceRollback) && bs == 16 ? 8 : bs;
        if (*openMode == OpenMode::coerceRollback && bs == 512) block = 256;
        opened = true;
        return {};
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
    std::shared_ptr<OpenMode> openMode;
    bool opened = false;
    double rate = 48000.0;
    int block = 512;
    juce::BigInteger inputs, outputs;
    juce::AudioIODeviceCallback* callback = nullptr;
};

class Type final : public juce::AudioIODeviceType
{
public:
    Type(const juce::String& name, bool empty = false, OpenMode mode = OpenMode::normal,
         bool separate = true, juce::StringArray names = { "Interface" })
        : AudioIODeviceType(name), emptyDevices(empty), separateDevices(separate),
          deviceNames(std::move(names)), openMode(std::make_shared<OpenMode>(mode)) {}
    void setOpenMode(OpenMode mode) { *openMode = mode; }
    void scanForDevices() override {}
    juce::StringArray getDeviceNames(bool) const override
    { return emptyDevices ? juce::StringArray() : deviceNames; }
    int getDefaultDeviceIndex(bool) const override { return emptyDevices ? -1 : 0; }
    int getIndexOfDevice(juce::AudioIODevice* device, bool) const override
    { return device == nullptr ? -1 : deviceNames.indexOf(device->getName()); }
    bool hasSeparateInputsAndOutputs() const override { return separateDevices; }
    juce::AudioIODevice* createDevice(const juce::String& output, const juce::String& input) override
    { return new Device(getTypeName(), output.isNotEmpty() ? output : input, openMode); }
private:
    bool emptyDevices, separateDevices;
    juce::StringArray deviceNames;
    std::shared_ptr<OpenMode> openMode;
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
    manager.addAudioDeviceType(std::make_unique<Type>("Busy", false, OpenMode::busy));
    manager.addAudioDeviceType(std::make_unique<Type>("CoerceBuffer", false, OpenMode::coerceBuffer));
    manager.addAudioDeviceType(std::make_unique<Type>("CoerceRate", false, OpenMode::coerceRate));
    manager.addAudioDeviceType(std::make_unique<Type>("Coupled", false, OpenMode::normal, false,
        juce::StringArray { "Interface", "Other Interface" }));
    auto rollbackType = std::make_unique<Type>("RollbackCoercion");
    auto* const rollbackControl = rollbackType.get();
    manager.addAudioDeviceType(std::move(rollbackType));
    juce::AudioDeviceManager::AudioDeviceSetup request;
    request.sampleRate = 48000.0;
    request.bufferSize = 512;
    const auto apply = [&] (const juce::String& type, bool defaults, bool inputAllowed = true,
                           bool verifyRate = true, bool verifyBuffer = true,
                           juce::AudioDeviceManager::AudioDeviceSetup* accepted = nullptr)
    {
        return AudioDeviceConfiguration::apply(manager, type, request, defaults, inputAllowed, [] (auto& setup) {
            setup.inputChannels.clear(); setup.outputChannels.clear();
            if (setup.inputDeviceName.isNotEmpty()) setup.inputChannels.setRange(0, 2, true);
            if (setup.outputDeviceName.isNotEmpty()) setup.outputChannels.setRange(0, 2, true);
            setup.useDefaultInputChannels = setup.useDefaultOutputChannels = false;
        }, verifyRate, verifyBuffer, accepted);
    };
    check("audio_switch_defaults_open_duplex", apply("Working", true).isEmpty()
        && manager.getCurrentAudioDevice() != nullptr
        && manager.getAudioDeviceSetup().inputChannels.countNumberOfSetBits() == 2);
    check("audio_switch_other_type_opens_defaults", apply("Other", true).isEmpty()
        && manager.getCurrentAudioDeviceType() == "Other" && manager.getCurrentAudioDevice() != nullptr);
    auto* const deviceBeforeBufferChange = manager.getCurrentAudioDevice();
    request.bufferSize = 16;
    check("audio_in_place_16_sample_request_is_accepted", apply("Other", true).isEmpty()
        && manager.getCurrentAudioDevice() == deviceBeforeBufferChange
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 16);
    request.bufferSize = 512;
    check("audio_in_place_buffer_restore_is_accepted", apply("Other", true).isEmpty()
        && manager.getAudioDeviceSetup().bufferSize == 512);
    const auto previous = manager.createStateXml()->toString();
    check("audio_switch_empty_jack_preserves_working_device", apply("JACK", true).contains("JACK")
        && manager.getCurrentAudioDeviceType() == "Other" && manager.getCurrentAudioDevice() != nullptr);
    check("audio_switch_open_failure_rolls_back", apply("Busy", true).contains("Fixture device busy")
        && manager.getCurrentAudioDeviceType() == "Other" && manager.getCurrentAudioDevice() != nullptr
        && manager.createStateXml()->toString() == previous);
    juce::AudioDeviceManager::AudioDeviceSetup accepted;
    request.bufferSize = 16;
    const auto coercedBufferError = apply("CoerceBuffer", true, true, true, true, &accepted);
    check("audio_successful_buffer_coercion_is_rejected_and_rolled_back",
        coercedBufferError.contains("16 samples") && coercedBufferError.contains("8 samples")
        && accepted.bufferSize == 8
        && manager.getCurrentAudioDeviceType() == "Other"
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 512
        && manager.createStateXml()->toString() == previous);
    request.bufferSize = 512;
    const auto coercedRateError = apply("CoerceRate", true, true, true, true, &accepted);
    check("audio_successful_rate_coercion_is_rejected_and_rolled_back",
        coercedRateError.contains("48000 Hz") && coercedRateError.contains("44100 Hz")
        && accepted.sampleRate == 44100.0
        && manager.getCurrentAudioDeviceType() == "Other"
        && manager.createStateXml()->toString() == previous);
    check("audio_automatic_rate_accepts_driver_fallback", apply("CoerceRate", true, true, false).isEmpty()
        && manager.getCurrentAudioDevice()->getCurrentSampleRate() == 44100.0);
    request.bufferSize = 16;
    check("audio_automatic_buffer_accepts_driver_fallback", apply("CoerceBuffer", true, true, true, false).isEmpty()
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 8);
    request.bufferSize = 512;
    check("audio_coercing_device_accepts_baseline", apply("CoerceBuffer", true).isEmpty());
    const auto coercingBaseline = manager.createStateXml()->toString();
    request.bufferSize = 16;
    check("audio_in_place_successful_coercion_restores_same_driver",
        apply("CoerceBuffer", true).contains("did not accept")
        && manager.getCurrentAudioDeviceType() == "CoerceBuffer"
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 512
        && manager.createStateXml()->toString() == coercingBaseline);
    request.bufferSize = 512;
    check("audio_restore_after_automatic_fallback", apply("Other", true).isEmpty());
    check("audio_rollback_coercion_fixture_opens_baseline", apply("RollbackCoercion", true).isEmpty());
    rollbackControl->setOpenMode(OpenMode::coerceRollback);
    request.bufferSize = 16;
    const auto rollbackCoercionError = apply("RollbackCoercion", true);
    check("audio_silent_rollback_coercion_is_reported_honestly",
        rollbackCoercionError.contains("Previous audio settings could not be restored")
        && rollbackCoercionError.contains("256 samples")
        && manager.getCurrentAudioDevice() != nullptr
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 256);
    rollbackControl->setOpenMode(OpenMode::normal);
    request.bufferSize = 512;
    check("audio_restore_after_rollback_coercion", apply("Other", true).isEmpty());
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

    const auto coupledRequest = [] (const juce::String& input, const juce::String& output)
    {
        auto* values = new juce::DynamicObject();
        values->setProperty("inputDevice", input);
        values->setProperty("outputDevice", output);
        return juce::var(values);
    };
    request.bufferSize = 8;
    request.outputDeviceName = "Interface";
    check("audio_coupled_output_only_fixture_opens", apply("Coupled", false).isEmpty()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().isZero());
    auto names = AudioDeviceConfiguration::resolveCoupledDeviceNames(
        coupledRequest({}, "Interface"), "Interface", "Interface", false);
    request.inputDeviceName = names.input;
    request.outputDeviceName = names.output;
    request.bufferSize = 16;
    check("audio_coupled_output_only_buffer_edit_preserves_disabled_input",
        apply("Coupled", false).isEmpty()
        && manager.getAudioDeviceSetup().inputDeviceName.isEmpty()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().isZero()
        && manager.getCurrentAudioDevice()->getActiveOutputChannels().countNumberOfSetBits() == 2
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 16);
    request.inputDeviceName = "Interface";
    request.outputDeviceName.clear();
    request.bufferSize = 8;
    check("audio_coupled_input_only_fixture_opens", apply("Coupled", false).isEmpty()
        && manager.getCurrentAudioDevice()->getActiveOutputChannels().isZero());
    names = AudioDeviceConfiguration::resolveCoupledDeviceNames(
        coupledRequest("Interface", {}), "Interface", "Interface", false);
    request.inputDeviceName = names.input;
    request.outputDeviceName = names.output;
    request.bufferSize = 16;
    check("audio_coupled_input_only_buffer_edit_preserves_disabled_output",
        apply("Coupled", false).isEmpty()
        && manager.getAudioDeviceSetup().outputDeviceName.isEmpty()
        && manager.getCurrentAudioDevice()->getActiveOutputChannels().isZero()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().countNumberOfSetBits() == 2
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 16);
    names = AudioDeviceConfiguration::resolveCoupledDeviceNames(
        coupledRequest("Other Interface", "Other Interface"), "Other Interface", "Other Interface", false);
    request.inputDeviceName = names.input;
    request.outputDeviceName = names.output;
    check("audio_coupled_driver_selection_enables_requested_duplex",
        apply("Coupled", false).isEmpty()
        && manager.getCurrentAudioDevice()->getName() == "Other Interface"
        && manager.getCurrentAudioDevice()->getActiveInputChannels().countNumberOfSetBits() == 2
        && manager.getCurrentAudioDevice()->getActiveOutputChannels().countNumberOfSetBits() == 2);
    names = AudioDeviceConfiguration::resolveCoupledDeviceNames(
        coupledRequest({}, "Interface"), "Interface", "Interface", true);
    check("audio_new_coupled_system_uses_duplex_defaults",
        names.input == "Interface" && names.output == "Interface");
    auto omittedInput = coupledRequest({}, "Interface");
    omittedInput.getDynamicObject()->removeProperty("inputDevice");
    names = AudioDeviceConfiguration::resolveCoupledDeviceNames(omittedInput, "Interface", "Interface", false);
    check("audio_omitted_coupled_input_uses_default_rather_than_disable",
        names.input == "Interface" && names.output == "Interface");
    auto omittedOutput = coupledRequest("Interface", {});
    omittedOutput.getDynamicObject()->removeProperty("outputDevice");
    names = AudioDeviceConfiguration::resolveCoupledDeviceNames(omittedOutput, "Interface", "Interface", false);
    check("audio_omitted_coupled_output_uses_default_rather_than_disable",
        names.input == "Interface" && names.output == "Interface");

    const juce::StringArray endpoints { "Interface" };
    const auto endpointSelection = coupledRequest({}, "Interface");
    request.inputDeviceName = AudioDeviceConfiguration::resolveDeviceName(
        endpointSelection, "inputDevice", endpoints, 0, false);
    request.outputDeviceName = AudioDeviceConfiguration::resolveDeviceName(
        endpointSelection, "outputDevice", endpoints, 0, false);
    request.bufferSize = 8;
    check("audio_separate_output_only_fixture_opens", apply("Working", false).isEmpty()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().isZero());
    request.bufferSize = 16;
    check("audio_separate_output_only_buffer_edit_preserves_disabled_input",
        apply("Working", false).isEmpty()
        && manager.getAudioDeviceSetup().inputDeviceName.isEmpty()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().isZero()
        && manager.getCurrentAudioDevice()->getActiveOutputChannels().countNumberOfSetBits() == 2
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 16);
    check("audio_separate_omitted_input_resolves_default",
        AudioDeviceConfiguration::resolveDeviceName(omittedInput, "inputDevice", endpoints, 0, false) == "Interface");
    check("audio_separate_new_system_resolves_defaults",
        AudioDeviceConfiguration::resolveDeviceName(endpointSelection, "inputDevice", endpoints, 0, true) == "Interface");
    const auto inputOnlySelection = coupledRequest("Interface", {});
    request.inputDeviceName = AudioDeviceConfiguration::resolveDeviceName(
        inputOnlySelection, "inputDevice", endpoints, 0, false);
    request.outputDeviceName = AudioDeviceConfiguration::resolveDeviceName(
        inputOnlySelection, "outputDevice", endpoints, 0, false);
    request.bufferSize = 8;
    check("audio_separate_input_only_fixture_opens", apply("Working", false).isEmpty()
        && manager.getCurrentAudioDevice()->getActiveOutputChannels().isZero());
    request.bufferSize = 16;
    check("audio_separate_input_only_buffer_edit_preserves_disabled_output",
        apply("Working", false).isEmpty()
        && manager.getAudioDeviceSetup().outputDeviceName.isEmpty()
        && manager.getCurrentAudioDevice()->getActiveOutputChannels().isZero()
        && manager.getCurrentAudioDevice()->getActiveInputChannels().countNumberOfSetBits() == 2
        && manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 16);
    check("audio_separate_omitted_output_resolves_default",
        AudioDeviceConfiguration::resolveDeviceName(omittedOutput, "outputDevice", endpoints, 0, false) == "Interface");

    const auto sameASIO = [] (const juce::String& activeInput, const juce::String& activeOutput)
    {
        return AudioDeviceConfiguration::isSameStreamingDevice(
            "ASIO", "Interface", "Interface", "ASIO", activeInput, activeOutput, false);
    };
    check("audio_active_asio_duplex_uses_cached_capabilities", sameASIO("Interface", "Interface"));
    check("audio_active_asio_output_only_uses_cached_capabilities", sameASIO({}, "Interface"));
    check("audio_active_asio_input_only_uses_cached_capabilities", sameASIO("Interface", {}));
    check("audio_inactive_asio_requires_capability_probe", !sameASIO({}, {}));
    check("audio_different_asio_device_requires_capability_probe", !sameASIO("Other", "Other"));
    check("audio_separate_endpoints_preserve_exact_identity",
        !AudioDeviceConfiguration::isSameStreamingDevice(
            "WASAPI", "Interface", "Interface", "WASAPI", {}, "Interface", true));
    check("audio_different_system_preserves_exact_identity",
        !AudioDeviceConfiguration::isSameStreamingDevice(
            "ASIO", "Interface", "Interface", "Other", "Interface", "Interface", false));
}
}
