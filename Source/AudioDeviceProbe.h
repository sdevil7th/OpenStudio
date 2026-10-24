#pragma once
#include "AudioDeviceConfiguration.h"
#include "AudioRecorder.h"
#include "ASIOCapabilities.h"
#include "AppPaths.h"
#include <atomic>
#include <limits>

// Opt-in hardware qualification. Uses the same device transaction and recording
// writer as the app, without loading/saving user settings or opening a project.
namespace AudioDeviceProbe
{
class SilentCallback final : public juce::AudioIODeviceCallback
{
public:
    void audioDeviceAboutToStart(juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}
    void audioDeviceIOCallbackWithContext(const float* const* inputs, int inputCount,
        float* const* outputs, int outputCount, int samples,
        const juce::AudioIODeviceCallbackContext&) override
    {
        // Physical inputs are deliberately never read, copied or recorded.
        juce::ignoreUnused(inputs, inputCount);
        for (int channel = 0; channel < outputCount; ++channel)
            if (outputs[channel] != nullptr)
                juce::FloatVectorOperations::clear(outputs[channel], samples);
        frames.fetch_add(samples, std::memory_order_relaxed);
        blocks.fetch_add(1, std::memory_order_relaxed);
        int previousMinimum = minimumBlock.load(std::memory_order_relaxed);
        while (samples < previousMinimum && ! minimumBlock.compare_exchange_weak(
            previousMinimum, samples, std::memory_order_relaxed)) {}
        int previousMaximum = maximumBlock.load(std::memory_order_relaxed);
        while (samples > previousMaximum && ! maximumBlock.compare_exchange_weak(
            previousMaximum, samples, std::memory_order_relaxed)) {}
    }
    void clearCounters() noexcept
    {
        frames.store(0, std::memory_order_relaxed);
        blocks.store(0, std::memory_order_relaxed);
        minimumBlock.store(std::numeric_limits<int>::max(), std::memory_order_relaxed);
        maximumBlock.store(0, std::memory_order_relaxed);
    }
    std::atomic<juce::int64> frames {0}, blocks {0};
    std::atomic<int> minimumBlock {std::numeric_limits<int>::max()}, maximumBlock {0};
};

// Explicit opt-in, silent device transaction test. Run with other audio clients
// closed: an inactive ASIO driver exposes its preferred buffer, not another
// application's active stream configuration. No settings file is loaded/saved.
inline int runSilentASIOBufferChange(const juce::String& nameFragment,
                                    const juce::File& directory,
                                    int durationMilliseconds = 750)
{
    if (nameFragment.isEmpty() || durationMilliseconds < 100 || durationMilliseconds > 1500
        || directory.exists() || ! directory.createDirectory())
        return 2;
    juce::Array<juce::var> checks;
    bool passed = true;
    const auto report = [&] (const juce::String& id, bool success, const juce::var& detail)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty("id", id);
        row->setProperty("status", success ? "pass" : "fail");
        row->setProperty("detail", detail);
        checks.add(row);
        passed = passed && success;
    };
    const auto settingsFile = AppPaths::applicationData().getChildFile("audio_device_settings.xml");
    const bool settingsExisted = settingsFile.exists();
    juce::MemoryBlock settingsBefore;
    const bool settingsReadable = ! settingsExisted || settingsFile.loadFileAsData(settingsBefore);
    report("saved_settings_snapshot", settingsReadable, settingsFile.getFullPathName());

    auto manager = std::make_unique<juce::AudioDeviceManager>();
    juce::String selected;
    juce::StringArray matches;
    for (auto* type : manager->getAvailableDeviceTypes())
    {
        if (type->getTypeName() != "ASIO")
            continue;
        type->scanForDevices();
        for (const auto& name : type->getDeviceNames(false))
            if (name.containsIgnoreCase(nameFragment) && type->getDeviceNames(true).contains(name))
                matches.addIfNotAlreadyThere(name);
    }
    if (matches.size() == 1)
        selected = matches[0];
    report("unique_duplex_asio_device", selected.isNotEmpty(), matches.joinIntoString(", "));

    juce::DynamicObject::Ptr before = new juce::DynamicObject(), beforeChannels = new juce::DynamicObject();
    const bool queried = selected.isNotEmpty() && settingsReadable
        && ASIOCapabilities::query(selected, *before, *beforeChannels);
    const double originalRate = static_cast<double>(before->getProperty("reportedCurrentSampleRate"));
    const int originalBuffer = static_cast<int>(before->getProperty("reportedPreferredBufferSize"));
    const int inputChannels = juce::jmin(2, static_cast<int>(beforeChannels->getProperty("numInputChannels")));
    const int outputChannels = juce::jmin(2, static_cast<int>(beforeChannels->getProperty("numOutputChannels")));
    const auto supportedBuffers = before->getProperty("bufferSizes");
    const bool restorable = queried && static_cast<bool>(before->getProperty("currentSampleRateReadbackValid"))
        && std::isfinite(originalRate) && originalRate > 0.0 && originalBuffer > 0
        && inputChannels > 0 && outputChannels > 0;
    const bool supported = supportedBuffers.isArray() && supportedBuffers.getArray()->contains(juce::var(8))
        && supportedBuffers.getArray()->contains(juce::var(16))
        && supportedBuffers.getArray()->contains(juce::var(64));
    report("inactive_driver_readback_before", restorable, juce::var(before.get()));
    report("driver_advertises_8_16_and_64", supported, supportedBuffers);

    if (restorable && supported)
    {
        SilentCallback callback;
        manager->addAudioCallback(&callback);
        const auto apply = [&] (int buffer)
        {
            juce::AudioDeviceManager::AudioDeviceSetup setup;
            setup.inputDeviceName = setup.outputDeviceName = selected;
            setup.sampleRate = originalRate;
            setup.bufferSize = buffer;
            return AudioDeviceConfiguration::apply(*manager, "ASIO", setup, false, true,
                [&] (auto& value)
                {
                    value.inputChannels.setRange(0, inputChannels, true);
                    value.outputChannels.setRange(0, outputChannels, true);
                    value.useDefaultInputChannels = value.useDefaultOutputChannels = false;
                });
        };
        bool restored = false;
        const auto restore = [&]
        {
            const auto error = apply(originalBuffer);
            auto* device = manager->getCurrentAudioDevice();
            const bool matchesOriginal = error.isEmpty() && device != nullptr
                && std::abs(device->getCurrentSampleRate() - originalRate) <= 1.0
                && device->getCurrentBufferSizeSamples() == originalBuffer;
            auto* detail = new juce::DynamicObject();
            detail->setProperty("error", error);
            detail->setProperty("requestedSampleRate", originalRate);
            detail->setProperty("requestedBufferSize", originalBuffer);
            detail->setProperty("acceptedSampleRate", device != nullptr ? device->getCurrentSampleRate() : 0.0);
            detail->setProperty("acceptedBufferSize", device != nullptr ? device->getCurrentBufferSizeSamples() : 0);
            report("restore_original_driver_configuration", matchesOriginal, juce::var(detail));
            restored = true;
        };
        const juce::ScopeGuard closeAndRestore {[&]
        {
            if (! restored)
                restore();
            manager->removeAudioCallback(&callback);
            manager->closeAudioDevice();
        }};
        int step = 0;
        for (const int requestedBuffer : {8, 16, 64, 8})
        {
            const auto error = apply(requestedBuffer);
            auto* device = manager->getCurrentAudioDevice();
            const bool accepted = error.isEmpty() && device != nullptr
                && std::abs(device->getCurrentSampleRate() - originalRate) <= 1.0
                && device->getCurrentBufferSizeSamples() == requestedBuffer;
            callback.clearCounters();
            if (accepted)
                juce::MessageManager::getInstance()->runDispatchLoopUntil(durationMilliseconds);
            // Read again after callbacks so an asynchronous driver reset cannot
            // turn a transient acceptance into a false success.
            device = manager->getCurrentAudioDevice();
            const auto frames = callback.frames.load(std::memory_order_relaxed);
            const auto blocks = callback.blocks.load(std::memory_order_relaxed);
            const auto smallest = callback.minimumBlock.load(std::memory_order_relaxed);
            const auto largest = callback.maximumBlock.load(std::memory_order_relaxed);
            auto* detail = new juce::DynamicObject();
            detail->setProperty("requestedBufferSize", requestedBuffer);
            detail->setProperty("error", error);
            detail->setProperty("acceptedSampleRate", device != nullptr ? device->getCurrentSampleRate() : 0.0);
            detail->setProperty("acceptedBufferSize", device != nullptr ? device->getCurrentBufferSizeSamples() : 0);
            detail->setProperty("callbackFrames", frames);
            detail->setProperty("callbackBlocks", blocks);
            detail->setProperty("minimumCallbackBlock", blocks > 0 ? smallest : 0);
            detail->setProperty("maximumCallbackBlock", largest);
            detail->setProperty("driverXRunsDiagnostic", device != nullptr ? device->getXRunCount() : -1);
            const bool stable = accepted && device != nullptr
                && std::abs(device->getCurrentSampleRate() - originalRate) <= 1.0
                && device->getCurrentBufferSizeSamples() == requestedBuffer
                && frames > 0 && blocks > 0 && smallest == requestedBuffer && largest == requestedBuffer;
            report("buffer_step_" + juce::String(++step) + "_" + juce::String(requestedBuffer), stable, juce::var(detail));
        }
        restore();
    }

    // Release JUCE's ASIO instance as well as its stream before querying an
    // inactive driver again; some drivers reject simultaneous COM instances.
    manager.reset();
    juce::DynamicObject::Ptr after = new juce::DynamicObject(), afterChannels = new juce::DynamicObject();
    const bool queriedAfter = restorable && ASIOCapabilities::query(selected, *after, *afterChannels);
    report("inactive_driver_readback_after", queriedAfter
        && static_cast<bool>(after->getProperty("currentSampleRateReadbackValid"))
        && std::abs(static_cast<double>(after->getProperty("reportedCurrentSampleRate")) - originalRate) <= 1.0
        && static_cast<int>(after->getProperty("reportedPreferredBufferSize")) == originalBuffer,
        juce::var(after.get()));
    juce::MemoryBlock settingsAfter;
    const bool settingsUnchanged = settingsReadable && settingsExisted == settingsFile.exists()
        && (! settingsExisted || (settingsFile.loadFileAsData(settingsAfter) && settingsBefore == settingsAfter));
    report("saved_settings_byte_identical", settingsUnchanged, "The probe never loads settings into the manager or saves application settings.");
    auto* result = new juce::DynamicObject();
    result->setProperty("success", passed);
    result->setProperty("checks", checks);
    result->setProperty("inputPolicy", "Physical input pointers are never read or recorded; all active output samples are cleared.");
    result->setProperty("scope", "Silent ASIO device transaction 8 -> 16 -> 64 -> 8 at the driver's observed sample rate, followed by explicit restoration. No project or Rack is loaded.");
    result->setProperty("audioQualityAndNAMCapacity", "not_asserted: this qualifies settings acceptance and callback block sizes only");
    result->setProperty("inactiveDriverReadback", "ASIO reports its preferred buffer when inactive; other audio clients must be closed before running.");
    const bool written = directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(juce::var(result), true));
    return passed && written ? 0 : 1;
}

class Capture final : public juce::AudioIODeviceCallback
{
public:
    explicit Capture(AudioRecorder& writer) : recorder(writer) {}
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override
    { scratch.setSize(2, device->getCurrentBufferSizeSamples()); }
    void audioDeviceStopped() override {}
    void audioDeviceIOCallbackWithContext(const float* const* inputs, int inputCount,
        float* const* outputs, int outputCount, int samples,
        const juce::AudioIODeviceCallbackContext&) override
    {
        for (int ch = 0; ch < outputCount; ++ch)
            if (outputs[ch] != nullptr) juce::FloatVectorOperations::clear(outputs[ch], samples);
        if (samples > scratch.getNumSamples()) { oversized.store(true); return; }
        scratch.clear();
        for (int ch = 0; ch < juce::jmin(2, inputCount); ++ch)
            if (inputs[ch] != nullptr) scratch.copyFrom(ch, 0, inputs[ch], samples);
        recorder.writeBlock("capture", scratch, samples);
        frames.fetch_add(samples, std::memory_order_relaxed);
    }
    std::atomic<juce::int64> frames{0};
    std::atomic<bool> oversized{false};
private:
    AudioRecorder& recorder;
    juce::AudioBuffer<float> scratch;
};

inline int run(const juce::String& nameFragment, const juce::File& directory,
               int durationSeconds = 10, int bufferSize = 512)
{
    if (durationSeconds < 1 || durationSeconds > 600 || bufferSize < 32 || bufferSize > 8192) return 2;
    if (nameFragment.isEmpty() || directory.exists() || !directory.createDirectory()) return 2;
    juce::AudioDeviceManager manager;
    juce::Array<juce::var> checks;
    bool passed = true;
    const auto report = [&] (const juce::String& name, bool success, const juce::var& detail)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty("id", name); row->setProperty("status", success ? "pass" : "fail");
        row->setProperty("detail", detail); checks.add(juce::var(row)); passed = passed && success;
    };
    juce::String selected;
    juce::Array<juce::var> enumerated;
    for (auto* type : manager.getAvailableDeviceTypes())
    {
        if (type->getTypeName() != "ALSA") continue;
        type->scanForDevices();
        for (const auto& name : type->getDeviceNames(true)) enumerated.add("input: " + name);
        for (const auto& name : type->getDeviceNames(false)) enumerated.add("output: " + name);
        for (const auto& name : type->getDeviceNames(true))
            if (name.containsIgnoreCase(nameFragment) && type->getDeviceNames(false).contains(name))
            {
                if (selected.isNotEmpty()) { selected.clear(); break; }
                selected = name;
            }
    }
    report("unique_duplex_alsa_device", selected.isNotEmpty(), selected);
    if (selected.isNotEmpty())
    {
        for (const double rate : {44100.0, 48000.0})
        {
            juce::AudioDeviceManager::AudioDeviceSetup setup;
            setup.inputDeviceName = setup.outputDeviceName = selected;
            setup.sampleRate = rate; setup.bufferSize = bufferSize;
            const auto error = AudioDeviceConfiguration::apply(manager, "ALSA", setup, false, true, [] (auto& value) {
                value.inputChannels.setRange(0, 2, true); value.outputChannels.setRange(0, 2, true);
                value.useDefaultInputChannels = value.useDefaultOutputChannels = false;
            });
            const auto prefix = juce::String(static_cast<int>(rate));
            report(prefix + "_open", error.isEmpty() && manager.getCurrentAudioDevice() != nullptr, error);
            auto* device = manager.getCurrentAudioDevice();
            if (error.isNotEmpty() || device == nullptr) continue;
            const auto file = directory.getChildFile(prefix + "-inputs-1-2.wav");
            AudioRecorder recorder(directory.getChildFile(prefix + "-recovery"));
            const bool started = recorder.startRecording("capture", file, device->getCurrentSampleRate(), 2);
            report(prefix + "_writer_started", started, file.getFullPathName());
            Capture capture(recorder);
            if (started)
            {
                manager.addAudioCallback(&capture);
                juce::MessageManager::getInstance()->runDispatchLoopUntil(durationSeconds * 1000);
                manager.removeAudioCallback(&capture);
                recorder.stopRecording("capture");
            }
            auto* details = new juce::DynamicObject();
            details->setProperty("sampleRate", device->getCurrentSampleRate());
            details->setProperty("bufferSize", device->getCurrentBufferSizeSamples());
            details->setProperty("availableInputs", device->getInputChannelNames().size());
            details->setProperty("availableOutputs", device->getOutputChannelNames().size());
            details->setProperty("activeInputs", device->getActiveInputChannels().toString(2));
            details->setProperty("activeOutputs", device->getActiveOutputChannels().toString(2));
            details->setProperty("capturedFrames", capture.frames.load());
            details->setProperty("requestedDurationSeconds", durationSeconds);
            details->setProperty("requestedBufferSize", bufferSize);
            details->setProperty("xruns", device->getXRunCount());
            report(prefix + "_callbacks", capture.frames.load() >= static_cast<juce::int64>(rate * durationSeconds * 0.9)
                && !capture.oversized.load() && device->getCurrentSampleRate() == rate, juce::var(details));
            report(prefix + "_no_reported_xruns", device->getXRunCount() == 0, device->getXRunCount());
            juce::WavAudioFormat format;
            std::unique_ptr<juce::AudioFormatReader> reader(format.createReaderFor(file.createInputStream().release(), true));
            bool sane = reader != nullptr && reader->numChannels == 2 && reader->lengthInSamples > 0;
            juce::Array<juce::var> peaks;
            if (sane)
            {
                juce::AudioBuffer<float> audio(2, 65536);
                float maximum[2]{};
                for (juce::int64 offset = 0; offset < reader->lengthInSamples; offset += audio.getNumSamples())
                {
                    const auto samples = static_cast<int>(std::min<juce::int64>(audio.getNumSamples(), reader->lengthInSamples - offset));
                    sane = reader->read(&audio, 0, samples, offset, true, true) && sane;
                    for (int ch = 0; ch < 2; ++ch)
                    {
                        maximum[ch] = juce::jmax(maximum[ch], audio.getMagnitude(ch, 0, samples));
                        for (int i = 0; i < samples; ++i)
                            sane = sane && std::isfinite(audio.getSample(ch, i));
                    }
                }
                for (auto value : maximum) peaks.add(value);
            }
            report(prefix + "_recorded_file", sane, peaks);
            manager.closeAudioDevice();
        }
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("checks", checks); result->setProperty("success", passed);
    result->setProperty("alsaDevices", enumerated);
    result->setProperty("signalPeaks", "diagnostic_only: silence/noise cannot establish correct physical source routing");
    result->setProperty("monitoringAndLatency", "not_asserted: outputs are silent; this checks device I/O and the recording writer, not the full track graph");
    const bool written = directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(juce::var(result), true));
    return passed && written ? 0 : 1;
}
}
