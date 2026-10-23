#pragma once
#include "AudioEngine.h"
#include "AudioDeviceConfiguration.h"
#include "ASIOCapabilities.h"
#include "AppPaths.h"
#include "BuiltInEffects2.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

// Explicit opt-in hardware diagnostic. It never exposes physical input samples
// to the engine, and the device receives silence regardless of the engine output.
namespace NAMLiveCallbackProbe
{
constexpr int scratchCapacity = 8192;
struct Options
{
    int trackCount = 2;
    int oversamplingFactor = 4;
    double sampleRate = 44100.0;
    int warmupSeconds = 10, measurementSeconds = 10;
    std::vector<int> buffers {8, 16, 128};
    bool recording = false;
    int workerCount = -1;
    int workerSpinMicroseconds = 0;
    int recoveryGraceMicroseconds = 0;
};

inline bool validOptions(const Options& value)
{
    if (value.trackCount < 1 || value.trackCount > 64 || !std::isfinite(value.sampleRate)
        || (value.oversamplingFactor != 2 && value.oversamplingFactor != 4 && value.oversamplingFactor != 8)
        || (value.sampleRate != 44100.0 && value.sampleRate != 48000.0 && value.sampleRate != 88200.0
            && value.sampleRate != 96000.0 && value.sampleRate != 176400.0 && value.sampleRate != 192000.0)
        || value.warmupSeconds < 0 || value.warmupSeconds > 60 || value.measurementSeconds < 1 || value.measurementSeconds > 1800
        || value.buffers.empty() || value.buffers.size() > 16 || value.workerCount < -1 || value.workerCount > 127
        || value.workerSpinMicroseconds < 0 || value.workerSpinMicroseconds > 2000
        || value.recoveryGraceMicroseconds < 0 || value.recoveryGraceMicroseconds > 2000) return false;
    std::vector<int> sorted = value.buffers;
    std::sort(sorted.begin(), sorted.end());
    return sorted.front() >= 8 && sorted.back() <= scratchCapacity
        && std::adjacent_find(sorted.begin(), sorted.end()) == sorted.end();
}

class Callback final : public juce::AudioIODeviceCallback
{
public:
    struct Record { juce::int64 frame, arrival, duration; int samples; };
    Callback(AudioEngine& owner, const Options& requested)
        : engine(owner), options(requested), cycleFrames(static_cast<int>(options.sampleRate * 2.0)),
          input(options.trackCount, cycleFrames + scratchCapacity), output(2, scratchCapacity), records(65536), missedRecords(4096)
    {
        for (int channel = 0; channel < options.trackCount; ++channel)
        {
            // Half-Hz frequencies give an exactly two-second periodic fixture.
            // Each track has its own frequency and phase, even when presets repeat.
            const double frequency = (channel % 2 == 0 ? 82.5 : 31.0) + 1.5 * (channel / 2);
            for (int frame = 0; frame < cycleFrames; ++frame)
            {
                const double phase = juce::MathConstants<double>::twoPi * (frequency * frame / options.sampleRate + 0.11 * channel);
                input.setSample(channel, frame, static_cast<float>(0.15 * std::sin(phase) + 0.035 * std::sin(7.0 * phase)));
            }
            input.copyFrom(channel, cycleFrames, input, channel, 0, scratchCapacity);
        }
    }
    void begin(int block)
    {
        requestedBlock = block; frames = 0; count = 0; missedCount = 0; previousArrival = 0;
        measuredBlocks = measuredFrames = deadlineMisses = lateArrivals = arrivalCount = totalTicks = maximumTicks = maximumArrival = 0;
        durationHistogram.fill(0); arrivalHistogram.fill(0);
        warmupFrames = static_cast<juce::int64>(options.sampleRate * options.warmupSeconds);
        targetFrames = static_cast<juce::int64>(options.sampleRate * options.measurementSeconds);
        const auto expectedBlocks = (targetFrames + block - 1) / block;
        traceStride = std::max<juce::int64>(1, (expectedBlocks + static_cast<juce::int64>(records.size()) - 1) / static_cast<juce::int64>(records.size()));
        budgetTicks = static_cast<double>(juce::Time::getHighResolutionTicksPerSecond()) * block / options.sampleRate;
        peak = 0.0f; nonFinite = 0; clipped = 0; starts = 0;
        invalid.store(false); finished.store(false); enabled.store(false);
    }
    void start() noexcept { enabled.store(true, std::memory_order_release); }
    juce::int64 processedFrames() const noexcept { return frames; } // Control thread after callback removal.
    float inputAt(int channel, juce::int64 frame) const { return input.getSample(channel, static_cast<int>(frame % cycleFrames)); }
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override
    {
        if (++starts != 1 || device == nullptr || device->getCurrentSampleRate() != options.sampleRate
            || device->getCurrentBufferSizeSamples() != requestedBlock)
            invalid.store(true, std::memory_order_relaxed);
        engine.audioDeviceAboutToStart(device);
    }
    void audioDeviceStopped() override { engine.audioDeviceStopped(); }
    void audioDeviceError(const juce::String& error) override
    { invalid.store(true, std::memory_order_relaxed); engine.audioDeviceError(error); }
    void audioDeviceIOCallbackWithContext(const float* const* physicalInputs, int inputCount,
        float* const* physicalOutputs, int outputCount, int samples,
        const juce::AudioIODeviceCallbackContext& context) override
    {
        const auto arrival = juce::Time::getHighResolutionTicks();
        juce::ignoreUnused(physicalInputs, inputCount);
        for (int channel = 0; channel < outputCount; ++channel)
            if (physicalOutputs[channel] != nullptr) juce::FloatVectorOperations::clear(physicalOutputs[channel], samples);
        if (!enabled.load(std::memory_order_acquire) || finished.load(std::memory_order_relaxed)) return;
        if (samples != requestedBlock || samples <= 0 || samples > scratchCapacity || outputCount != 2)
        { invalid.store(true, std::memory_order_relaxed); finished.store(true, std::memory_order_release); return; }
        const int position = static_cast<int>(frames % cycleFrames);
        std::array<const float*, 64> synthetic {};
        for (int channel = 0; channel < options.trackCount; ++channel) synthetic[static_cast<size_t>(channel)] = input.getReadPointer(channel, position);
        float* scratch[] { output.getWritePointer(0), output.getWritePointer(1) };
        output.clear(0, samples);
        const auto before = juce::Time::getHighResolutionTicks();
        engine.audioDeviceIOCallbackWithContext(synthetic.data(), options.trackCount, scratch, 2, samples, context);
        const auto duration = juce::Time::getHighResolutionTicks() - before;
        if (frames >= warmupFrames && frames < warmupFrames + targetFrames)
        {
            const auto interval = previousArrival == 0 ? 0 : arrival - previousArrival;
            const Record record { frames, interval, duration, samples };
            if (measuredBlocks % traceStride == 0 && count < records.size()) records[count++] = record;
            ++measuredBlocks; measuredFrames += samples; totalTicks += duration; maximumTicks = juce::jmax(maximumTicks, duration);
            ++durationHistogram[histogramBin(duration)];
            if (duration > budgetTicks)
            { ++deadlineMisses; if (missedCount < missedRecords.size()) missedRecords[missedCount++] = record; }
            if (interval > 0)
            {
                ++arrivalCount; ++arrivalHistogram[histogramBin(interval)]; maximumArrival = juce::jmax(maximumArrival, interval);
                if (interval > budgetTicks * 1.5) ++lateArrivals;
            }
            for (int channel = 0; channel < 2; ++channel)
                for (int sample = 0; sample < samples; ++sample)
                {
                    const float value = scratch[channel][sample];
                    if (!std::isfinite(value)) ++nonFinite;
                    else { peak = juce::jmax(peak, std::abs(value)); if (std::abs(value) >= 1.0f) ++clipped; }
                }
        }
        previousArrival = arrival; frames += samples;
        if (frames >= warmupFrames + targetFrames) finished.store(true, std::memory_order_release);
    }
    juce::var report(const juce::File& csv) const // Only after removeAudioCallback has joined callbacks.
    {
        auto* result = new juce::DynamicObject();
        juce::String text("kind,frame,samples,engine_microseconds,arrival_interval_microseconds\n");
        text.preallocateBytes(112 * (count + missedCount) + 128);
        const double budget = requestedBlock * 1.0e6 / options.sampleRate;
        const auto append = [&](const Record& row, const char* kind)
        {
            const double elapsed = juce::Time::highResolutionTicksToSeconds(row.duration) * 1.0e6;
            const double interval = juce::Time::highResolutionTicksToSeconds(row.arrival) * 1.0e6;
            text << kind << ',' << row.frame << ',' << row.samples << ',' << juce::String(elapsed, 3) << ',' << juce::String(interval, 3) << '\n';
        };
        for (size_t index = 0; index < count; ++index) append(records[index], "uniform");
        for (size_t index = 0; index < missedCount; ++index) append(missedRecords[index], "deadline_miss");
        const bool valid = !invalid.load() && finished.load() && starts == 1 && measuredBlocks > 0 && nonFinite == 0
            && measuredFrames >= targetFrames - requestedBlock && peak > 0.000001f;
        result->setProperty("processingValid", valid); result->setProperty("requestedBufferSamples", requestedBlock);
        result->setProperty("measuredBlocks", measuredBlocks); result->setProperty("measuredFrames", measuredFrames); result->setProperty("processedFrames", frames);
        result->setProperty("budgetMicroseconds", budget); result->setProperty("meanMicroseconds", measuredBlocks == 0 ? 0.0 : juce::Time::highResolutionTicksToSeconds(totalTicks) * 1.0e6 / static_cast<double>(measuredBlocks));
        result->setProperty("p99Microseconds", percentile(durationHistogram, measuredBlocks, .99, maximumTicks)); result->setProperty("p999Microseconds", percentile(durationHistogram, measuredBlocks, .999, maximumTicks));
        result->setProperty("maximumMicroseconds", juce::Time::highResolutionTicksToSeconds(maximumTicks) * 1.0e6); result->setProperty("engineDeadlineMisses", deadlineMisses);
        result->setProperty("arrivalP99Microseconds", percentile(arrivalHistogram, arrivalCount, .99, maximumArrival)); result->setProperty("arrivalMaximumMicroseconds", juce::Time::highResolutionTicksToSeconds(maximumArrival) * 1.0e6);
        result->setProperty("percentileMethod", "All callbacks counted in 1/256-budget histogram bins; upper bin bound reported. Overflow at 4 budgets conservatively reports observed maximum.");
        result->setProperty("durationHistogramOverflow", durationHistogram.back()); result->setProperty("arrivalHistogramOverflow", arrivalHistogram.back());
        result->setProperty("uniformTraceStride", traceStride); result->setProperty("uniformTraceRows", static_cast<int>(count)); result->setProperty("deadlineTraceRows", static_cast<int>(missedCount));
        result->setProperty("traceScope", "Bounded uniform sample plus first 4096 deadline misses; duplicate rows are intentional. Summary counts, extrema and histograms include every measured callback.");
        result->setProperty("arrivalIntervalsAbove150Percent", lateArrivals); result->setProperty("arrivalStatus", "diagnostic_only: driver batching and scheduling both affect arrival intervals");
        result->setProperty("outputPeak", peak); result->setProperty("outputSamplesAtOrAboveFullScale", clipped);
        result->setProperty("nonFiniteOutputSamples", nonFinite); result->setProperty("clippingStatus", "diagnostic_only: synthetic signal and unchanged preset gains");
        result->setProperty("capacityStatus", !valid ? "not_asserted" : deadlineMisses == 0 ? "pass" : "fail");
        result->setProperty("engineCapacityStatus", !valid ? "not_asserted" : deadlineMisses == 0 ? "pass" : "fail");
        result->setProperty("traceWritten", !csv.exists() && csv.replaceWithText(text));
        return juce::var(result);
    }
    std::atomic<bool> finished {false}, invalid {false};
private:
    size_t histogramBin(juce::int64 ticks) const noexcept
    { return static_cast<size_t>(juce::jlimit(0.0, 1024.0, static_cast<double>(ticks) * 256.0 / budgetTicks)); }
    double percentile(const std::array<juce::int64, 1025>& histogram, juce::int64 observations, double fraction, juce::int64 maximum) const
    {
        if (observations == 0) return 0.0;
        const auto rank = static_cast<juce::int64>(std::ceil(static_cast<double>(observations) * fraction));
        juce::int64 cumulative = 0;
        for (size_t bin = 0; bin < histogram.size(); ++bin)
        {
            cumulative += histogram[bin];
            if (cumulative >= rank) return bin == histogram.size() - 1
                ? juce::Time::highResolutionTicksToSeconds(maximum) * 1.0e6
                : static_cast<double>(bin + 1) * requestedBlock * 1.0e6 / (options.sampleRate * 256.0);
        }
        return 0.0;
    }
    AudioEngine& engine;
    const Options options;
    const int cycleFrames;
    juce::AudioBuffer<float> input, output;
    std::vector<Record> records, missedRecords;
    std::array<juce::int64, 1025> durationHistogram {}, arrivalHistogram {};
    std::atomic<bool> enabled {false};
    size_t count = 0, missedCount = 0;
    juce::int64 frames = 0, previousArrival = 0, nonFinite = 0, clipped = 0;
    juce::int64 warmupFrames = 0, targetFrames = 0, measuredBlocks = 0, measuredFrames = 0, deadlineMisses = 0, lateArrivals = 0;
    juce::int64 totalTicks = 0, maximumTicks = 0, maximumArrival = 0, arrivalCount = 0, traceStride = 1;
    double budgetTicks = 1.0;
    int requestedBlock = 0, starts = 0;
    float peak = 0.0f;
};

inline juce::var verifyRecordings(AudioEngine& engine, const Callback& callback, const juce::StringArray& tracks,
                                 const juce::File& directory, double sampleRate)
{
    const auto clips = engine.getLastCompletedClips();
    const auto failures = engine.takeRecordingWriteFailures();
    bool valid = clips.size() == static_cast<size_t>(tracks.size()) && failures.isArray() && failures.getArray()->isEmpty();
    juce::StringArray seen;
    juce::Array<juce::var> files;
    juce::WavAudioFormat format;
    juce::AudioBuffer<float> audio(1, 65536);
    for (const auto& clip : clips)
    {
        const int channel = tracks.indexOf(clip.trackId);
        bool sane = channel >= 0 && !seen.contains(clip.trackId) && clip.file.isAChildOf(directory) && clip.file.existsAsFile();
        seen.add(clip.trackId);
        std::unique_ptr<juce::AudioFormatReader> reader(sane ? format.createReaderFor(clip.file.createInputStream().release(), true) : nullptr);
        sane = sane && reader != nullptr && reader->sampleRate == sampleRate && reader->numChannels == 1
            && reader->lengthInSamples == callback.processedFrames() && reader->lengthInSamples > 0;
        float peak = 0.0f, maximumDifference = 0.0f;
        if (sane)
            for (juce::int64 offset = 0; offset < reader->lengthInSamples; offset += audio.getNumSamples())
            {
                const int count = static_cast<int>(std::min<juce::int64>(audio.getNumSamples(), reader->lengthInSamples - offset));
                sane = reader->read(&audio, 0, count, offset, true, false) && sane;
                for (int sample = 0; sample < count; ++sample)
                {
                    const float value = audio.getSample(0, sample);
                    sane = sane && std::isfinite(value);
                    if (std::isfinite(value))
                    {
                        peak = juce::jmax(peak, std::abs(value));
                        maximumDifference = juce::jmax(maximumDifference, std::abs(value - callback.inputAt(channel, offset + sample)));
                    }
                }
            }
        const double tolerance = reader != nullptr && !reader->usesFloatingPointData
            ? 2.0 * std::ldexp(1.0, 1 - static_cast<int>(reader->bitsPerSample)) : 0.000002;
        sane = sane && peak > 0.000001f && maximumDifference <= tolerance;
        auto* row = new juce::DynamicObject(); row->setProperty("trackId", clip.trackId); row->setProperty("path", clip.file.getFullPathName());
        row->setProperty("status", sane ? "pass" : "fail"); row->setProperty("frames", reader != nullptr ? reader->lengthInSamples : 0);
        row->setProperty("expectedFrames", callback.processedFrames()); row->setProperty("peak", peak); row->setProperty("maximumRawInputDifference", maximumDifference);
        row->setProperty("bitsPerSample", reader != nullptr ? static_cast<int>(reader->bitsPerSample) : 0);
        row->setProperty("rawInputTolerance", tolerance);
        files.add(row); valid = valid && sane;
    }
    auto* result = new juce::DynamicObject(); result->setProperty("status", valid ? "pass" : "fail");
    result->setProperty("files", files); result->setProperty("writeFailures", failures);
    result->setProperty("scope", "Production raw recording tap and ThreadedWriter; every sample checked against the independent synthetic input, exact frame count, mono layout and rate. Tolerance is two PCM LSBs, or 2e-6 for floating-point recordings.");
    return juce::var(result);
}

inline int run(const juce::String& nameFragment, const juce::File& guitar, const juce::File& bass,
               const juce::File& directory, const Options& options = {})
{
    if (!validOptions(options) || nameFragment.isEmpty() || !guitar.existsAsFile() || !bass.existsAsFile() || directory.exists() || !directory.createDirectory()) return 2;
    juce::Array<juce::var> checks, cases, presets;
    bool passed = true;
    const auto check = [&](const juce::String& id, bool success, const juce::var& detail)
    {
        auto* value = new juce::DynamicObject(); value->setProperty("id", id);
        value->setProperty("status", success ? "pass" : "fail"); value->setProperty("detail", detail);
        checks.add(value); passed = passed && success;
    };
    const auto settings = AppPaths::applicationData().getChildFile("audio_device_settings.xml");
    const bool settingsExisted = settings.exists(); juce::MemoryBlock settingsBefore;
    const bool settingsReadable = !settingsExisted || settings.loadFileAsData(settingsBefore);
    check("settings_snapshot", settingsReadable, settings.getFullPathName());
    auto engine = std::make_unique<AudioEngine>(AudioEngine::DeviceStartup::offline);
    const bool workersConfigured = engine->setRealtimeTrackWorkerCount(options.workerCount);
    const bool spinConfigured = engine->setRealtimeTrackWorkerSpinMicroseconds(options.workerSpinMicroseconds);
    const bool graceConfigured = engine->setProbeTrackRecoveryGraceMicroseconds(options.recoveryGraceMicroseconds);
    check("worker_recovery_grace", graceConfigured, options.recoveryGraceMicroseconds);
    check("worker_configuration", workersConfigured, engine->getRealtimeTrackExecutionDiagnostics());
    check("worker_spin_configuration", spinConfigured, options.workerSpinMicroseconds);
    auto& manager = engine->getDeviceManager();
    manager.removeAudioCallback(engine.get()); // Defensive: the offline constructor currently registers no callback.
    juce::StringArray matches;
    for (auto* type : manager.getAvailableDeviceTypes())
        if (type->getTypeName() == "ASIO")
        {
            type->scanForDevices();
            for (const auto& name : type->getDeviceNames(false))
                if (name.containsIgnoreCase(nameFragment) && type->getDeviceNames(true).contains(name)) matches.addIfNotAlreadyThere(name);
        }
    const juce::String selected = matches.size() == 1 ? matches[0] : juce::String();
    check("unique_asio_device", selected.isNotEmpty(), matches.joinIntoString(", "));
    juce::DynamicObject::Ptr before = new juce::DynamicObject(), channels = new juce::DynamicObject();
    const bool queried = selected.isNotEmpty() && ASIOCapabilities::query(selected, *before, *channels);
    const double originalRate = static_cast<double>(before->getProperty("reportedCurrentSampleRate"));
    const int originalBuffer = static_cast<int>(before->getProperty("reportedPreferredBufferSize"));
    const bool restorable = queried && static_cast<bool>(before->getProperty("currentSampleRateReadbackValid"))
        && std::isfinite(originalRate) && originalRate > 0.0 && originalBuffer > 0;
    check("inactive_driver_restorable", restorable, juce::var(before.get()));
    const auto buffers = before->getProperty("bufferSizes"), rates = before->getProperty("sampleRates");
    bool supported = buffers.isArray() && rates.isArray() && static_cast<int>(channels->getProperty("numInputChannels")) >= 2
        && static_cast<int>(channels->getProperty("numOutputChannels")) >= 2;
    for (int size : options.buffers) supported = supported && buffers.getArray()->contains(juce::var(size));
    supported = supported && rates.getArray()->contains(juce::var(options.sampleRate));
    check("requested_configuration_supported", supported, juce::var(channels.get()));
    check("default_oversampling_is_four", engine->getNAMRackOversamplingFactor() == 4, "No settings-writing oversampling or device setter is called.");
    std::vector<juce::MemoryBlock> states(static_cast<size_t>(options.trackCount));
    juce::StringArray tracks;
    for (int index = 0; index < options.trackCount; ++index) tracks.add("nam-probe-" + juce::String(index + 1) + (index % 2 == 0 ? "-guitar" : "-bass"));
    const std::array<juce::File, 2> files { guitar, bass };
    for (size_t index = 0; index < states.size(); ++index)
    {
        bool migrated = false;
        const auto& presetFile = files[index % files.size()];
        bool valid = presetFile.loadFileAsData(states[index]) && OpenStudioNAMRack::migratePresetStateToCurrent(states[index], migrated);
        auto tree = juce::ValueTree::readFromData(states[index].getData(), states[index].getSize());
        valid = valid && tree.hasType("OpenStudioNAMRack");
        if (index % 2 == 0 && valid) tree.setProperty("chaosEnabled", 1.0f, nullptr);
        auto* resource = new juce::DynamicObject(); resource->setProperty("path", presetFile.getFullPathName());
        resource->setProperty("sha256", juce::SHA256(presetFile).toHexString()); resource->setProperty("migratedInMemory", migrated);
        resource->setProperty("instrumentProfile", tree.getProperty("instrumentProfile"));
        resource->setProperty("syntheticInputChannel", static_cast<int>(index));
        resource->setProperty("syntheticFundamentalHz", (index % 2 == 0 ? 82.5 : 31.0) + 1.5 * static_cast<double>(index / 2));
        valid = valid && tree.getProperty("ampModelPath").toString().isNotEmpty() && static_cast<float>(tree.getProperty("ampEnabled", 1.0f)) >= 0.5f;
        for (const auto* key : {"ampModelPath", "pedalModelPath", "cabIRPath"})
        {
            const auto path = tree.getProperty(key).toString();
            if (path.isEmpty()) continue;
            const juce::File file(path); valid = valid && file.existsAsFile();
            resource->setProperty(key, path); resource->setProperty(juce::String(key) + "Sha256", file.existsAsFile() ? juce::SHA256(file).toHexString() : juce::String());
        }
        const auto xml = tree.createXml(); resource->setProperty("requestedState", xml != nullptr ? xml->toString() : juce::String());
        states[index].reset(); { juce::MemoryOutputStream stream(states[index], false); tree.writeToStream(stream); }
        const auto id = tracks[static_cast<int>(index)];
        valid = valid && engine->addTrack(id, "audio") == id && engine->addTrackBuiltInFX(id, "OpenStudio NAM Rack", false);
        engine->setTrackInputChannels(id, static_cast<int>(index), 1); engine->setTrackRecordArm(id, true); engine->setTrackInputMonitoring(id, true);
        presets.add(resource); check("preset_" + juce::String(static_cast<int>(index)), valid, juce::var(resource));
    }
    bool restored = false, restoreAttempted = false, touched = false;
    if (passed && settingsReadable && restorable && supported)
    {
        Callback callback(*engine, options);
        const auto apply = [&](double sampleRate, int block)
        {
            juce::AudioDeviceManager::AudioDeviceSetup setup;
            setup.inputDeviceName = setup.outputDeviceName = selected; setup.sampleRate = sampleRate; setup.bufferSize = block;
            return AudioDeviceConfiguration::apply(manager, "ASIO", setup, false, true, [](auto& value)
            {
                value.inputChannels.setRange(0, 2, true); value.outputChannels.setRange(0, 2, true);
                value.useDefaultInputChannels = value.useDefaultOutputChannels = false;
            });
        };
        const auto restore = [&]
        {
            restoreAttempted = true;
            manager.removeAudioCallback(&callback);
            if (engine->isTransportRecording()) engine->finalizeInterruptedRecording();
            engine->setTransportPlaying(false); manager.closeAudioDevice();
            const auto error = apply(originalRate, originalBuffer);
            auto* device = manager.getCurrentAudioDevice();
            restored = error.isEmpty() && device != nullptr && std::abs(device->getCurrentSampleRate() - originalRate) <= 1.0
                && device->getCurrentBufferSizeSamples() == originalBuffer;
            check("restore_driver_configuration", restored, error);
            manager.closeAudioDevice();
        };
        const juce::ScopeGuard cleanup {[&] { if (touched && !restoreAttempted) restore(); manager.removeAudioCallback(&callback); manager.closeAudioDevice(); }};
        try
        {
            for (int block : options.buffers)
            {
                bool ready = true;
                juce::Array<juce::var> stateReadbacks;
                for (size_t index = 0; index < states.size(); ++index)
                {
                    const auto id = tracks[static_cast<int>(index)];
                    ready = engine->setPluginState(id, 0, false, states[index].toBase64Encoding()) && ready;
                    ready = engine->setProbeNAMRackOversamplingFactor(id, options.oversamplingFactor) && ready;
                    juce::MemoryBlock readback; ready = readback.fromBase64Encoding(engine->getPluginState(id, 0, false)) && ready;
                    const auto actual = juce::ValueTree::readFromData(readback.getData(), readback.getSize());
                    const auto requested = juce::ValueTree::readFromData(states[index].getData(), states[index].getSize());
                    for (const auto* key : {"ampModelPath", "pedalModelPath", "cabIRPath"})
                        if (requested.hasProperty(key)) ready = ready && actual.hasProperty(key)
                            && actual.getProperty(key).toString() == requested.getProperty(key).toString();
                    for (const auto* key : {"instrumentProfile", "ampEnabled", "cabEnabled",
                        "cabRoomEnabled", "cabDoublerEnabled", "precisionDriveEnabled", "chaosEnabled", "fuzzEnabled", "octaverEnabled",
                        "compressorEnabled", "preEqEnabled", "eqEnabled", "modulatorEnabled", "delayEnabled", "reverbEnabled"})
                        if (requested.hasProperty(key))
                        {
                            const double expected = static_cast<double>(requested.getProperty(key));
                            const double accepted = static_cast<double>(actual.getProperty(key));
                            ready = ready && actual.hasProperty(key) && std::isfinite(expected)
                                && std::isfinite(accepted) && accepted == expected;
                        }
                    ready = ready && static_cast<float>(actual.getProperty("ampEnabled", 0.0f)) >= 0.5f;
                    const auto xml = actual.createXml(); stateReadbacks.add(xml != nullptr ? xml->toString() : juce::String());
                }
                check("state_restore_" + juce::String(block), ready, stateReadbacks);
                const auto recordingDirectory = directory.getChildFile("recordings-buffer-" + juce::String(block));
                if (options.recording)
                {
                    const bool isolated = !recordingDirectory.exists() && recordingDirectory.createDirectory()
                        && engine->setProbeRecordingDirectory(recordingDirectory);
                    check("recording_directory_" + juce::String(block), isolated, recordingDirectory.getFullPathName());
                    ready = ready && isolated;
                }
                if (!ready) break;
                callback.begin(block); manager.addAudioCallback(&callback); touched = true;
                const auto error = apply(options.sampleRate, block);
                auto* device = manager.getCurrentAudioDevice();
                bool accepted = error.isEmpty() && device != nullptr && device->getCurrentSampleRate() == options.sampleRate && device->getCurrentBufferSizeSamples() == block;
                bool recordingStarted = !options.recording;
                if (accepted && options.recording)
                {
                    engine->setTransportPosition(0.0); engine->setTransportRecording(true); engine->setTransportPlaying(true);
                    recordingStarted = engine->isTransportRecording() && engine->isTransportPlaying();
                    check("recording_started_" + juce::String(block), recordingStarted, "Production armed-track recording with synthetic inputs; physical inputs are discarded.");
                }
                const auto workerBaseline = engine->getRealtimeTrackExecutionDiagnostics();
                if (accepted && recordingStarted) callback.start();
                const auto deadline = juce::Time::getMillisecondCounterHiRes() + (options.warmupSeconds + options.measurementSeconds + 15.0) * 1000.0;
                while (accepted && recordingStarted && !callback.finished.load(std::memory_order_acquire) && juce::Time::getMillisecondCounterHiRes() < deadline)
                    juce::MessageManager::getInstance()->runDispatchLoopUntil(100);
                // finished publishes the last engine return; subsequent proxy
                // calls only clear output. Capture live worker/MMCSS counts
                // before audioDeviceStopped retires the worker threads.
                const auto workerState = engine->getRealtimeTrackExecutionDiagnostics();
                manager.removeAudioCallback(&callback);
                // Preserve rolling-window telemetry before CSV formatting or
                // other report work can age the stopped callback samples out.
                const auto engineState = engine->getAudioDebugSnapshot();
                bool witnesses = true; juce::Array<juce::var> diagnostics;
                for (const auto& id : tracks)
                {
                    const auto state = engine->getNAMRackDiagnostics(id, "track", 0); diagnostics.add(state);
                    witnesses = witnesses && static_cast<int>(state.getProperty("lastAmpDspFrames", 0)) > 0
                        && static_cast<int>(state.getProperty("embeddedDriveRequestedOversamplingFactor", 0)) == options.oversamplingFactor
                        && static_cast<int>(state.getProperty("embeddedDriveActiveOversamplingFactor", 0)) == options.oversamplingFactor
                        && static_cast<int>(state.getProperty("routedInputChannelCount", 0)) == 1
                        && static_cast<double>(state.getProperty("lastRawInputPeakDb", -120.0)) > -80.0
                        && static_cast<double>(state.getProperty("maximumOutputPeakLinear", 0.0)) > 0.000001
                        && !static_cast<bool>(state.getProperty("ampModelFaulted", true)) && !static_cast<bool>(state.getProperty("realtimeDSPBlocked", true));
                    for (const auto* key : {"modelProcessFailCount", "audioThreadResizeAvoidedCount", "oversizeBypassCount", "modelSnapshotLockMissCount", "realtimeSafetyBypassCount", "rackOutputEmergencyMuteTripCount", "inputNonFiniteSampleCount"})
                        witnesses = witnesses && static_cast<juce::int64>(state.getProperty(key, -1)) == 0;
                }
                device = manager.getCurrentAudioDevice();
                accepted = accepted && device != nullptr && device->getCurrentSampleRate() == options.sampleRate && device->getCurrentBufferSizeSamples() == block;
                const int xruns = device != nullptr ? device->getXRunCount() : -1;
                juce::var recordingResult;
                if (options.recording)
                {
                    if (!engine->finalizeInterruptedRecording()) { engine->setTransportRecording(false); engine->setTransportPlaying(false); }
                    recordingResult = verifyRecordings(*engine, callback, tracks, recordingDirectory, options.sampleRate);
                    recordingStarted = recordingStarted && recordingResult.getProperty("status", {}).toString() == "pass";
                }
                auto row = callback.report(directory.getChildFile("buffer-" + juce::String(block) + ".csv"));
                auto* detail = row.getDynamicObject(); detail->setProperty("openError", error); detail->setProperty("settingsAccepted", accepted);
                detail->setProperty("callbackDurationCapacityStatus", row.getProperty("engineCapacityStatus", "not_asserted"));
                detail->setProperty("driverXRuns", xruns);
                detail->setProperty("deviceCapacityStatus", !accepted || xruns < 0 ? "not_asserted" : xruns == 0 ? "pass" : "fail");
                detail->setProperty("deviceCapacityScope", "Driver-reported xruns over warmup and measurement; unsupported readback is not_asserted. Separate from engine processing duration.");
                detail->setProperty("engineDiagnostics", engineState);
                detail->setProperty("workerDiagnostics", workerState); detail->setProperty("workerBaseline", workerBaseline);
                auto* workerDelta = new juce::DynamicObject(); bool workerCountersValid = true, workerCapacity = true;
                for (const auto* key : {"deadlineMisses", "rejectedTrackJobs", "quarantinedBlocks", "cancelledJobs", "rejectedBatches",
                    "batches", "completedBatches", "completedLateBatches", "hardDeadlineMisses",
                    "callbackJobs", "workerJobs", "parallelTrackBlocks"})
                {
                    const auto initial = static_cast<juce::int64>(workerBaseline.getProperty(key, -1));
                    const auto final = static_cast<juce::int64>(workerState.getProperty(key, -1));
                    const auto delta = final - initial;
                    workerCountersValid = workerCountersValid && initial >= 0 && final >= initial;
                    workerDelta->setProperty(key, delta);
                }
                for (const auto* key : {"deadlineMisses", "rejectedTrackJobs", "quarantinedBlocks", "cancelledJobs", "rejectedBatches"})
                    workerCapacity = workerCapacity && static_cast<juce::int64>(workerDelta->getProperty(key)) == 0;
                detail->setProperty("workerCaseDeltas", juce::var(workerDelta));
                detail->setProperty("workerCapacityStatus", !workerCountersValid ? "not_asserted" : workerCapacity ? "pass" : "fail");
                detail->setProperty("workerCapacityScope", "Per-case deltas over warmup and measurement. Cancelled/rejected/quarantined work fails capacity even when the outer callback returns within its deadline.");
                detail->setProperty("recording", options.recording ? recordingResult : juce::var("not_requested"));
                detail->setProperty("rackDiagnostics", diagnostics); detail->setProperty("stateReadbacks", stateReadbacks);
                const bool mmcss = static_cast<bool>(engineState.getProperty("windowsAudioCallbackMMCSSActive", false))
                    && static_cast<bool>(engineState.getProperty("windowsAudioCallbackMMCSSPriorityApplied", false));
                const int expectedWorkers = options.workerCount < 0
                    ? RealtimeTrackExecutor::recommendedWorkerCount() : options.workerCount;
                const bool workersReady = static_cast<int>(workerState.getProperty("workers", -1)) == expectedWorkers
                    && static_cast<int>(workerState.getProperty("mmcssRegisteredWorkers", -1)) == expectedWorkers
                    && static_cast<int>(workerState.getProperty("mmcssPriorityWorkers", -1)) == expectedWorkers;
                detail->setProperty("workerConfigurationVerified", workersReady);
                const bool valid = accepted && witnesses && mmcss && workersReady && recordingStarted && workerCountersValid && static_cast<bool>(row.getProperty("processingValid", false)) && static_cast<bool>(row.getProperty("traceWritten", false));
                detail->setProperty("processingIntegrity", valid ? "pass" : "fail");
                if (!valid) { detail->setProperty("capacityStatus", "not_asserted"); detail->setProperty("engineCapacityStatus", "not_asserted"); }
                // An observed executor overrun remains a capacity failure even
                // when dropped work also prevents an output/execution witness.
                if (workerCountersValid && !workerCapacity) { detail->setProperty("capacityStatus", "fail"); detail->setProperty("engineCapacityStatus", "fail"); }
                if (accepted && xruns > 0) detail->setProperty("capacityStatus", "fail");
                detail->setProperty("engineCapacityScope", "Callback-duration deadlines and worker completion; cancelled/rejected/quarantined DSP is a capacity failure. Driver telemetry remains separate.");
                check("loaded_callback_" + juce::String(block), valid, "Driver settings, finite nonzero synthetic output, loaded NAM execution, "
                    + juce::String(options.oversamplingFactor) + "x oversampling, MMCSS and callback safety counters.");
                cases.add(row); manager.closeAudioDevice();
                if (!accepted) break;
            }
        }
        catch (const std::exception& error) { check("probe_exception", false, juce::String(error.what())); }
        catch (...) { check("probe_exception", false, "Unknown exception"); }
        if (touched) restore();
    }
    check("global_oversampling_preference_unchanged", engine->getNAMRackOversamplingFactor() == 4,
        "Per-rack probe requests never call the settings-writing global oversampling setter.");
    engine.reset();
    if (touched)
    {
        juce::DynamicObject::Ptr after = new juce::DynamicObject(), afterChannels = new juce::DynamicObject();
        const bool read = ASIOCapabilities::query(selected, *after, *afterChannels);
        check("inactive_driver_restored", restored && read && static_cast<bool>(after->getProperty("currentSampleRateReadbackValid"))
            && std::abs(static_cast<double>(after->getProperty("reportedCurrentSampleRate")) - originalRate) <= 1.0
            && static_cast<int>(after->getProperty("reportedPreferredBufferSize")) == originalBuffer, juce::var(after.get()));
    }
    juce::MemoryBlock settingsAfter;
    check("saved_settings_byte_identical", settingsReadable && settingsExisted == settings.exists()
        && (!settingsExisted || (settings.loadFileAsData(settingsAfter) && settingsBefore == settingsAfter)), settings.getFullPathName());
    check("requested_cases_completed", cases.size() == static_cast<int>(options.buffers.size()), cases.size());
    auto* result = new juce::DynamicObject(); result->setProperty("success", passed); result->setProperty("checks", checks); result->setProperty("cases", cases);
    result->setProperty("presets", presets); result->setProperty("driver", selected); result->setProperty("sampleRate", options.sampleRate); result->setProperty("oversampling", options.oversamplingFactor);
    result->setProperty("warmupSeconds", options.warmupSeconds); result->setProperty("measurementSeconds", options.measurementSeconds);
    result->setProperty("trackCount", options.trackCount); result->setProperty("requestedWorkerCount", options.workerCount); result->setProperty("recordingRequested", options.recording);
    result->setProperty("requestedWorkerSpinMicroseconds", options.workerSpinMicroseconds);
    result->setProperty("requestedRecoveryGraceMicroseconds", options.recoveryGraceMicroseconds);
    result->setProperty("inputFixtureVersion", 2); result->setProperty("inputFixturePeriodSeconds", 2);
    juce::Array<juce::var> requestedBuffers; for (int buffer : options.buffers) requestedBuffers.add(buffer); result->setProperty("requestedBuffers", requestedBuffers);
   #if JUCE_DEBUG
    result->setProperty("buildConfiguration", "Debug");
   #else
    result->setProperty("buildConfiguration", "Release");
   #endif
    const auto executable = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    result->setProperty("executable", executable.getFullPathName()); result->setProperty("executableSha256", juce::SHA256(executable).toHexString());
    result->setProperty("inputPolicy", "Physical input pointers are never read or recorded; independent periodic guitar/bass mono fixtures feed unique synthetic channels. Physical I/O stays at two channels, and physical outputs are always silent.");
    result->setProperty("timingScope", "Wall time of the full AudioEngine callback on the real ASIO callback thread, including engine telemetry. Excludes proxy preparation/inspection and surrounding JUCE/ASIO wrapper work. No WebView is loaded.");
    result->setProperty("audioQuality", "not_asserted: silent synthetic hardware qualification cannot establish audible live crackle, tone or instrument routing");
    result->setProperty("restorationScope", "Inactive ASIO observed rate/preferred buffer restored; other audio clients must be closed. User settings and source presets are never saved.");
    const bool written = directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(juce::var(result), true));
    return passed && written ? 0 : 1;
}
}
