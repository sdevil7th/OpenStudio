#pragma once
#include "AudioDeviceConfiguration.h"
#include "AudioRecorder.h"
#include <atomic>

// Opt-in hardware qualification. Uses the same device transaction and recording
// writer as the app, without loading/saving user settings or opening a project.
namespace AudioDeviceProbe
{
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
