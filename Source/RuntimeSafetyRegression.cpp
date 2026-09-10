#include "RuntimeSafetyRegression.h"
#include "FieldTestRegression.h"
#include "TrackProcessor.h"
#include "AudioRecorder.h"
#include "ProjectFileStore.h"
#include "MessageThreadLifetime.h"
#include "ControlSurfaceMidiInbox.h"
#include "AITrackEngine.h"
#include "RecordingWriterSafety.h"
#include "OwnedBackgroundTasks.h"
#include "AudioFileConversionRegression.h"
#include "PluginStateValidation.h"
#include "PluginManager.h"
#include "SendGraphSafety.h"
#include "JsonEnvelope.h"
#include "RecordingRecoveryRegression.h"
#include "PeakCache.h"
#include "JSFXProcessor.h"
#include "AppUpdater.h"
#include <atomic>
#include <limits>
#include <stdexcept>
#include <thread>
#if JUCE_WINDOWS
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace
{
class StorageFaultStream final : public juce::OutputStream
{
public:
    int mode = 0;
    juce::MemoryOutputStream memory;
    bool write(const void* bytes, size_t size) override { return mode != 1 && memory.write(bytes, size); }
    void flush() override { memory.flush(); }
    juce::int64 getPosition() override { return memory.getPosition(); }
    bool setPosition(juce::int64 position) override { return mode != 2 && memory.setPosition(position); }
};
class FaultProbe final : public juce::AudioProcessor
{
public:
    explicit FaultProbe(int channels = 2, bool sidechain = false, bool auxiliary = false, bool monoInput = false)
        : AudioProcessor(makeBuses(channels, sidechain, auxiliary, monoInput)) {}
    static BusesProperties makeBuses(int channels, bool sidechain, bool auxiliary, bool monoInput)
    {
        if (channels == 0) return {};
        auto buses = BusesProperties().withInput("Input", juce::AudioChannelSet::discreteChannels(monoInput ? 1 : channels), true)
            .withOutput("Output", juce::AudioChannelSet::discreteChannels(channels), true);
        if (sidechain) buses = buses.withInput("Sidechain", juce::AudioChannelSet::stereo(), true);
        return auxiliary ? buses.withInput("Auxiliary", juce::AudioChannelSet::stereo(), true) : buses;
    }
    std::atomic<int> mode { 0 }, calls { 0 };
    void prepareToPlay(double, int) override {}
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override { process(buffer); }
    void processBlock(juce::AudioBuffer<double>& buffer, juce::MidiBuffer&) override { process(buffer); }
    template <typename Sample> void process(juce::AudioBuffer<Sample>& buffer)
    {
        ++calls;
        if (buffer.getNumChannels() < juce::jmax(getTotalNumInputChannels(), getTotalNumOutputChannels()))
            throw std::runtime_error("host supplied a truncated bus layout");
        if (mode.load() == 1) throw std::runtime_error("injected processor exception");
        if (mode.load() == 2) buffer.setSample(0, 0, std::numeric_limits<Sample>::quiet_NaN());
        if (mode.load() == 3) buffer.setSample(0, 0, std::numeric_limits<Sample>::infinity());
        if (mode.load() == 4) buffer.setSample(0, 62, std::numeric_limits<Sample>::max());
    }
    bool supportsDoublePrecisionProcessing() const override { return true; }
    bool isBusesLayoutSupported(const BusesLayout&) const override { return true; }
    const juce::String getName() const override { return "Runtime safety probe"; }
    bool acceptsMidi() const override { return isMidiEffect(); }
    bool producesMidi() const override { return isMidiEffect(); }
    bool isMidiEffect() const override { return getTotalNumInputChannels() == 0 && getTotalNumOutputChannels() == 0; }
    double getTailLengthSeconds() const override { return 0; }
    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}
};

void fill(juce::AudioBuffer<float>& buffer)
{
    for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            buffer.setSample(channel, sample, 0.125f);
}
}

int RuntimeSafetyRegression::run(const juce::File& directory)
{
    if (!directory.createDirectory() || directory.getChildFile("result.json").exists()) return 2;
    juce::Array<juce::var> checks;
    bool passed = true;
    const auto check = [&] (const char* name, bool success)
    {
        auto result = std::make_unique<juce::DynamicObject>();
        result->setProperty("name", name);
        result->setProperty("status", success ? "pass" : "fail");
        checks.add(juce::var(result.release()));
        passed = passed && success;
    };
    juce::MidiBuffer midi;
    runFieldTestRegression(directory, check);
    runAudioFileConversionRegression(directory, check);
    runRecordingRecoveryRegression(directory, check);
    {
        juce::PluginDescription catalog;
        catalog.name = "Identity fixture";
        catalog.pluginFormatName = "VST3";
        catalog.fileOrIdentifier = directory.getChildFile("Multi.vst3").getFullPathName();
        catalog.uniqueId = 101;
        catalog.deprecatedUid = 11;
        auto second = catalog;
        second.uniqueId = 202;
        second.deprecatedUid = 22;
        auto runtime = second;
        runtime.fileOrIdentifier = juce::File(catalog.fileOrIdentifier)
            .getChildFile("Contents/x86_64-win/Multi.vst3").getFullPathName();
        const juce::Array<juce::PluginDescription> candidates { catalog, second };
        check("plugin_identity_preserves_exact_class_across_bundle_binary_paths",
            runtime.createIdentifierString() != second.createIdentifierString()
            && PluginManager::resolvePluginIdentifier(runtime, candidates) == second.createIdentifierString());
        check("plugin_identity_preserves_existing_catalog_identifiers",
            PluginManager::resolvePluginIdentifier(second, candidates) == second.createIdentifierString());
        auto unknown = runtime;
        unknown.uniqueId = 303; // Same name, same module, even a colliding legacy ID.
        check("plugin_identity_does_not_substitute_an_unknown_class",
            PluginManager::resolvePluginIdentifier(unknown, candidates) == unknown.createIdentifierString());
        auto otherModule = runtime;
        otherModule.fileOrIdentifier = directory.getChildFile("Other.vst3").getFullPathName();
        check("plugin_identity_does_not_substitute_another_module",
            PluginManager::resolvePluginIdentifier(otherModule, candidates) == otherModule.createIdentifierString());
        auto otherFormat = runtime;
        otherFormat.pluginFormatName = "CLAP";
        check("plugin_identity_does_not_substitute_another_format",
            PluginManager::resolvePluginIdentifier(otherFormat, candidates) == otherFormat.createIdentifierString());
    }
    {
        const auto script = directory.getChildFile("state-roundtrip.jsfx");
        const bool written = script.replaceWithText(
            "desc:OpenStudio state fixture\nslider1:1<0,1,0.001>Gain\n@sample\nspl0 *= slider1; spl1 *= slider1;\n");
        JSFXProcessor original;
        const bool loaded = written && original.loadScript(script.getFullPathName());
        const bool edited = loaded && original.setSliderValue(0, 0.375);
        juce::MemoryBlock state;
        original.getStateInformation(state);
        JSFXProcessor restored;
        restored.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
        restored.prepareToPlay(48000.0, 64);
        juce::AudioBuffer<float> block(2, 64);
        fill(block);
        restored.processBlock(block, midi);
        check("jsfx_new_state_restores_script_controls_and_processing", edited && state.getSize() > 0
            && restored.isScriptLoaded() && restored.getScriptPath() == script.getFullPathName()
            && std::abs(block.getSample(0, 63) - 0.046875f) < 0.000001f
            && std::abs(block.getSample(1, 63) - 0.046875f) < 0.000001f);
    }
    {
        const auto audio = directory.getChildFile("peak-source.bin");
        audio.replaceWithText("fixture identity only");
        const auto file = PeakCache::getPeakFilePath(audio);
        PeakCache cache;
        PeakCache::CacheEntry entry;
        entry.numChannels = 1; entry.totalSamples = 64; entry.sampleRate = 48000;
        for (const int stride : { 64, 256, 1024, 4096 })
            entry.levels.push_back({ stride, 1, 1, { -0.25f, 0.5f } });
        const auto write = [&] { return PeakCache::writeToFile(file, entry, audio.getSize(), audio.getLastModificationTime().toMilliseconds()); };
        PeakCache::CacheEntry loaded;
        check("peak_cache_atomic_round_trip", write() && cache.hasCachedPeaks(audio)
            && cache.loadFromFile(file, audio, loaded) && loaded.levels[0].data == entry.levels[0].data);
        entry.levels[0].numPeaks = INT_MAX;
        check("peak_cache_rejects_oversized_count_before_allocation", write() && !cache.hasCachedPeaks(audio)
            && !cache.loadFromFile(file, audio, loaded));
        entry.levels[0].numPeaks = 1; entry.sampleRate = std::numeric_limits<double>::quiet_NaN();
        check("peak_cache_rejects_invalid_rate", write() && !cache.hasCachedPeaks(audio) && !cache.loadFromFile(file, audio, loaded));
        entry.sampleRate = 48000; entry.levels[0].data[0] = std::numeric_limits<float>::infinity();
        check("peak_cache_rejects_nonfinite_values", write() && !cache.loadFromFile(file, audio, loaded));
        check("peak_requests_bound_pixel_allocation", cache.getPeaks(audio, 0, 0, INT_MAX).size() == 0
            && cache.getPeaks(audio, 64, 0, -1).size() == 0);
        cache.stopping.store(true);
        check("peak_generation_rejects_work_after_shutdown", !cache.generateSync(audio));
    }
    {
        // Local file transfer only: no network access or installer launch.
        const auto source = directory.getChildFile("update-source.bin");
        const auto target = directory.getChildFile("update-copy.bin");
        source.replaceWithText(juce::String::repeatedString("payload", 10000));
        const auto digest = juce::SHA256(source).toHexString();
        MessageThreadLifetime lifetime;
        juce::String error;
        check("updater_requires_https_and_integrity_metadata",
            AppUpdater::validateUpdateDownload("https://github.com/example/setup.exe", digest, source.getSize(), error)
            && !AppUpdater::validateUpdateDownload("http://github.com/example/setup.exe", digest, source.getSize(), error)
            && !AppUpdater::validateUpdateDownload("file:///tmp/setup.exe", digest, source.getSize(), error)
            && !AppUpdater::validateUpdateDownload("https://github.com/example/setup.exe", "", source.getSize(), error)
            && !AppUpdater::validateUpdateDownload("https://github.com/example/setup.exe", digest, 0, error));
        check("updater_rejects_missing_or_mismatched_checksum",
            AppUpdater::verifyDownloadedFileSha256(source, digest, error)
            && !AppUpdater::verifyDownloadedFileSha256(source, "", error)
            && !AppUpdater::verifyDownloadedFileSha256(source, juce::String::repeatedString("0", 64), error));
        check("updater_rejects_missing_or_mismatched_size",
            AppUpdater::verifyDownloadedFileSize(source, source.getSize(), error)
            && !AppUpdater::verifyDownloadedFileSize(source, 0, error)
            && !AppUpdater::verifyDownloadedFileSize(source, source.getSize() + 1, error));
        check("updater_transfer_publishes_complete_file", AppUpdater::downloadToFile(juce::URL(source), target, error, lifetime.token())
            && source.loadFileAsString() == target.loadFileAsString());
        target.replaceWithText("preserve previous download");
        std::atomic<bool> cancelled { true };
        check("updater_user_cancel_preserves_previous_download", !AppUpdater::downloadToFile(juce::URL(source), target, error, lifetime.token(), &cancelled)
            && target.loadFileAsString() == "preserve previous download");
        juce::int64 progressBytes = 0;
        check("updater_reports_download_progress", AppUpdater::downloadToFile(juce::URL(source), target, error, lifetime.token(), nullptr,
            [&](juce::int64 bytes) { progressBytes = bytes; }) && progressBytes > 0);
        target.replaceWithText("preserve previous download");
        lifetime.invalidate();
        check("updater_cancel_preserves_previous_download", !AppUpdater::downloadToFile(juce::URL(source), target, error, lifetime.token())
            && target.loadFileAsString() == "preserve previous download");
        AppUpdater updater;
        check("updater_equal_release_not_newer", AppUpdater::compareVersions("v0.1.01", "0.1.01") == 0
            && AppUpdater::compareVersions("0.1.1", "0.1.01") == 0
            && AppUpdater::compareVersions("0.1.1.0", "0.1.01") == 0);
        check("updater_only_newer_release_qualifies", AppUpdater::compareVersions("0.1.0", "0.1.01") < 0
            && AppUpdater::compareVersions("0.1.02", "0.1.01") > 0);
        juce::DynamicObject::Ptr sameVersion = new juce::DynamicObject();
        sameVersion->setProperty("version", updater.getCurrentVersion());
        check("updater_same_version_download_rejected_before_network", updater.performDownload(juce::var(sameVersion.get()))["status"].toString() == "up-to-date");
        updater.downloadedUpdate = juce::var(sameVersion.get());
        check("updater_same_version_install_rejected_before_launch", updater.performInstall()["status"].toString() == "up-to-date");
       #if JUCE_DEBUG
        int developmentReplies = 0;
        const auto rejected = [&](const juce::var& status) { if (status["status"].toString() == "development") ++developmentReplies; };
        updater.checkForUpdates(false, rejected);
        updater.checkForUpdates(true, rejected);
        updater.downloadUpdate(rejected);
        updater.installDownloadedUpdate(rejected);
        check("updater_development_never_offers_or_launches_installer", developmentReplies == 4
            && !updater.checkInProgress.load() && !updater.installInProgress.load());
       #endif
        updater.shutdown();
        int completions = 0;
        updater.checkForUpdates(true, [&](const juce::var&) { ++completions; });
        check("updater_rejects_new_jobs_after_shutdown", !updater.checkInProgress.load() && completions == 0);
    }
    {
        const auto successors = [](const juce::String& id) {
            return id == "a" ? juce::StringArray { "b" } : id == "b" ? juce::StringArray { "c" } : juce::StringArray();
        };
        check("native_routing_rejects_self_and_multi_stage_feedback", sendWouldCreateCycle("a", "a", successors)
            && sendWouldCreateCycle("c", "a", successors) && !sendWouldCreateCycle("a", "c", successors));
        const auto deep = juce::String::repeatedString("[", 65) + "0" + juce::String::repeatedString("]", 65);
        check("project_json_depth_rejected_before_recursive_parser", !hasBoundedJsonEnvelope(deep)
            && hasBoundedJsonEnvelope("{\"tracks\":[],\"text\":\"[{}]\\\"\"}")
            && !hasBoundedJsonEnvelope("{]\""));
    }
    {
        juce::MemoryBlock output;
        bool rejected = true;
        for (const auto* invalid : { "-1.", "2147483647.", "67108865.", "1.", "1.???", "1.AAextra", "1.++", "00.", "x.AA", "1.A/" })
            rejected = !PluginStateValidation::decode(invalid, output) && rejected;
        check("plugin_state_rejects_allocation_prefix_and_malformed_encoding", rejected);
        bool roundTrips = true;
        for (size_t length = 0; length < 256; ++length)
        {
            juce::MemoryBlock input(length);
            for (size_t byte = 0; byte < length; ++byte) static_cast<char*>(input.getData())[byte] = static_cast<char>(byte + length);
            roundTrips = PluginStateValidation::decode(input.toBase64Encoding(), output) && output == input && roundTrips;
        }
        check("plugin_state_valid_juce_encoding_round_trips_all_padding_lengths", roundTrips);
    }
    {
        OwnedBackgroundTasks work;
        int completions = 0;
        auto completion = work.guardCompletion(std::function<void(juce::var)>([&](juce::var) { ++completions; }));
        (*completion)(true);
        check("owned_media_completion_accepts_live_owner", completions == 1);
        juce::WaitableEvent entered;
        std::atomic<bool> joined { false }, queuedRan { false };
        work.addJob([&work, &entered, &joined] {
            const auto alive = work.token();
            entered.signal();
            while (MessageThreadLifetime::accepts(alive)) juce::Thread::sleep(1);
            joined = true;
        });
        const bool started = entered.wait(2000);
        work.addJob([&] { queuedRan = true; });
        work.shutdown();
        check("owned_media_shutdown_joins_before_dependency_release", started && joined.load());
        check("owned_media_shutdown_discards_queued_work", !queuedRan.load());
        (*completion)(true); // A queued message-thread completion after shutdown.
        check("owned_media_completion_rejects_retired_owner", completions == 1);
    }
    {
        TrackProcessor track;
        juce::AudioBuffer<float> normal(2, 64);
        fill(normal);
        check("unprepared_rejected", !track.tryProcessBlock(normal, midi) && normal.getMagnitude(0, 64) == 0.0f);
        track.setRateAndBufferSizeDetails(48000, 64);
        track.prepareToPlay(48000, 64);
        auto processor = std::make_unique<FaultProbe>(4);
        auto* probe = processor.get();
        track.addTrackFX(std::move(processor), 48000, 64);
        auto* scratch = track.fxProcessBuffer.getWritePointer(0);
        auto* automation = track.automationGainBuffer.getWritePointer(0);
        auto* preFader = track.preFaderBuffer.getWritePointer(0);
        for (int samples : { 1, 8, 63, 64, 65, 512, 65537 })
        {
            juce::AudioBuffer<float> block(2, samples);
            fill(block);
            const auto previousCalls = probe->calls.load();
            const bool accepted = track.tryProcessBlock(block, midi);
            check(samples <= 64 ? "prepared_or_short_block" : "oversized_rejected_before_plugin",
                  samples <= 64 ? accepted && probe->calls == previousCalls + 1
                    : !accepted && probe->calls == previousCalls && block.getMagnitude(0, samples) == 0.0f);
        }
        check("callback_scratch_identity_unchanged", scratch == track.fxProcessBuffer.getWritePointer(0)
            && automation == track.automationGainBuffer.getWritePointer(0)
            && preFader == track.preFaderBuffer.getWritePointer(0));
        for (int channels : { 0, 3, 65 })
        {
            juce::AudioBuffer<float> block(channels, 64);
            check("invalid_track_channels_rejected", !track.tryProcessBlock(block, midi));
        }
        fill(normal);
        check("valid_block_recovers_after_contract_fault", track.tryProcessBlock(normal, midi)
            && ProcessorSafety::isFinite(normal) && normal.getMagnitude(0, 64) > 0.0f);
        normal.setSample(0, 0, std::numeric_limits<float>::infinity());
        check("invalid_input_rejected_before_dsp", !track.tryProcessBlock(normal, midi));
        track.releaseResources();
        check("released_processor_rejected", !track.tryProcessBlock(normal, midi));
        track.prepareToPlay(44100, 128);
        fill(normal);
        check("device_reprepare_recovers", track.tryProcessBlock(normal, midi));
    }
    for (int failureMode : { 1, 2, 3 })
    {
        TrackProcessor track;
        track.setRateAndBufferSizeDetails(48000, 64);
        track.prepareToPlay(48000, 64);
        auto processor = std::make_unique<FaultProbe>();
        auto* probe = processor.get();
        track.addTrackFX(std::move(processor), 48000, 64);
        juce::AudioBuffer<float> block(2, 64);
        fill(block);
        track.processBlock(block, midi);
        probe->mode = failureMode;
        fill(block);
        track.processBlock(block, midi);
        const auto faultCalls = probe->calls.load();
        bool finite = ProcessorSafety::isFinite(block);
        for (int index = 0; index < 100; ++index)
        {
            fill(block);
            track.processBlock(block, midi);
            finite = finite && ProcessorSafety::isFinite(block);
        }
        check("fault_is_finite_and_quarantined_without_retry_loop", finite && probe->calls == faultCalls);
        track.publishRealtimeStateSnapshots();
        fill(block);
        track.processBlock(block, midi);
        check("publication_does_not_clear_quarantine", probe->calls == faultCalls);
        track.bypassTrackFX(0, true);
        probe->mode = 0;
        track.bypassTrackFX(0, false);
        fill(block);
        track.processBlock(block, midi);
        check("explicit_reset_can_recover", probe->calls > faultCalls && ProcessorSafety::isFinite(block));
    }
    {
        TrackProcessor track;
        track.setRateAndBufferSizeDetails(48000, 64);
        track.prepareToPlay(48000, 64);
        auto processor = std::make_unique<FaultProbe>(65);
        auto* probe = processor.get();
        track.addTrackFX(std::move(processor), 48000, 64);
        juce::AudioBuffer<float> block(2, 64);
        fill(block);
        track.processBlock(block, midi);
        check("hosted_layout_not_silently_truncated", probe->calls == 0 && ProcessorSafety::isFinite(block));
    }
    {
        TrackProcessor track;
        track.setRateAndBufferSizeDetails(48000, 64);
        track.prepareToPlay(48000, 64);
        track.addTrackFX(std::make_unique<FaultProbe>(2, true), 48000, 64);
        track.setSidechainSource(0, "short-sidechain");
        juce::AudioBuffer<float> shortSource(2, 3), block(2, 64);
        fill(shortSource);
        track.setSidechainBuffer(&shortSource);
        fill(block);
        track.processBlock(block, midi);
        check("short_sidechain_zero_padded", ProcessorSafety::isFinite(block)
            && track.fxProcessBuffer.getSample(2, 2) == 0.125f
            && track.fxProcessBuffer.getSample(2, 3) == 0.0f
            && track.fxProcessBuffer.getSample(2, 63) == 0.0f);
    }
    for (const bool monoInput : { false, true })
    {
        TrackProcessor track;
        track.setRateAndBufferSizeDetails(48000, 64);
        track.prepareToPlay(48000, 64);
        auto effect = std::make_unique<FaultProbe>(2, true, true, monoInput);
        auto* probe = effect.get();
        track.addTrackFX(std::move(effect), 48000, 64);
        track.setSidechainSource(0, "multi-bus");
        juce::AudioBuffer<float> source(2, 64), block(2, 64);
        fill(source);
        source.applyGain(2.0f);
        track.setSidechainBuffer(&source);
        fill(block);
        track.processBlock(block, midi);
        const int offset = monoInput ? 1 : 2;
        check(monoInput ? "sidechain_uses_input_bus_offset" : "all_auxiliary_buses_have_storage",
            probe->calls == 1 && track.getProcessorFault(false, 0) == 0
            && track.fxProcessBuffer.getSample(offset, 0) == 0.25f
            && track.fxProcessBuffer.getSample(offset + 2, 0) == 0.0f);
    }
    {
        TrackProcessor track;
        track.setRateAndBufferSizeDetails(48000, 64);
        track.prepareToPlay(48000, 64);
        std::atomic<bool> stop { false }, finite { true };
        std::atomic<int> callbacks { 0 };
        std::thread reader([&]
        {
            juce::AudioBuffer<float> block(2, 64);
            juce::MidiBuffer events;
            while (!stop.load())
            {
                fill(block);
                track.processBlock(block, events);
                if (!ProcessorSafety::isFinite(block)) finite = false;
                ++callbacks;
            }
        });
        for (int iteration = 0; iteration < 200; ++iteration)
        {
            track.addTrackFX(std::make_unique<FaultProbe>(), 48000, 64);
            track.bypassTrackFX(0, true);
            track.bypassTrackFX(0, false);
            track.removeTrackFX(0);
        }
        stop = true;
        reader.join();
        track.reclaimRetiredRealtimeGraphSnapshots();
        check("concurrent_graph_publish_remove_bypass", finite && callbacks > 0
            && track.realtimeGraphAudioReaders == 0 && track.retiredRealtimeGraphSnapshots.empty());
    }
    {
        AudioRecorder recorder;
        const auto file = directory.getChildFile("recording.wav");
        check("recording_started", recorder.startRecording("fixture", file, 48000, 2));
        check("invalid_setup_preserves_take", !recorder.startRecording("fixture", file,
            std::numeric_limits<double>::quiet_NaN(), 2) && recorder.isRecording("fixture"));
        juce::AudioBuffer<float> stereo(2, 64), mono(1, 64);
        fill(stereo);
        recorder.writeBlock("fixture", mono, 64);
        recorder.writeBlock("fixture", stereo, 65);
        recorder.writeBlock("fixture", stereo, -1);
        recorder.writeBlock("fixture", stereo, 64, 0.0);
        recorder.writeBlock("fixture", stereo, 64, 64.0 / 48000.0);
        recorder.stopRecording("fixture");
        juce::WavAudioFormat wav;
        auto stream = file.createInputStream();
        std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(stream.release(), true));
        check("rejected_recording_blocks_never_read_or_append", reader && reader->lengthInSamples == 128);
    }
    {
        const auto target = directory.getChildFile("session.osproj");
        const juce::String first = "{\"tracks\":[],\"projectName\":\"first\"}";
        const juce::String second = "{\"tracks\":[],\"projectName\":\"second\"}";
        check("checked_project_first_save", ProjectFileStore::save(target, first, false, 3).wasOk());
        check("recovery_does_not_replace_explicit_save", ProjectFileStore::save(target, second, true, 3).wasOk()
            && target.loadFileAsString() == first);
        check("invalid_json_preserves_previous_project", ProjectFileStore::save(target, "{truncated", false, 3).failed()
            && target.loadFileAsString() == first);
        check("manual_save_keeps_prior_generation", ProjectFileStore::save(target, second, false, 3).wasOk()
            && target.loadFileAsString() == second);
        bool priorFound = false;
        for (const auto& file : ProjectFileStore::recoveryFiles(target, 3))
            priorFound = priorFound || (file.existsAsFile() && file.loadFileAsString() == first);
        check("prior_generation_is_loadable", priorFound);
        bool rotationValid = true;
        for (int index = 0; index < 10; ++index)
            rotationValid = rotationValid && ProjectFileStore::save(target, first, true, 3).wasOk();
        check("bounded_recovery_rotation", rotationValid && directory.findChildFiles(juce::File::findFiles,
            false, "session.osproj.recovery-*.osproj").size() == 3);
        const auto blocked = directory.getChildFile("blocked.osproj");
        blocked.createDirectory();
        check("invalid_destination_rejected", ProjectFileStore::save(blocked, first, false, 3).failed()
            && blocked.isDirectory() && target.loadFileAsString() == second);
#if JUCE_WINDOWS
        const bool readOnly = target.setReadOnly(true);
        const bool rejected = readOnly && ProjectFileStore::save(target, first, false, 3).failed();
        const bool retained = target.loadFileAsString() == second;
        const bool writableAgain = target.setReadOnly(false);
        check("failed_project_publication_retains_previous_bytes", rejected && retained && writableAgain);
#endif
    }
    {
        MessageThreadLifetime::Token retired;
        {
            MessageThreadLifetime owner;
            retired = owner.token();
            check("deferred_callback_live_owner", MessageThreadLifetime::accepts(retired));
        }
        check("deferred_callback_rejects_destroyed_owner", !MessageThreadLifetime::accepts(retired));
        int received = 0;
        bool messageThreadOnly = true;
        ControlSurfaceMidiInbox inbox([&](const juce::MidiMessage& message)
        {
            ++received;
            messageThreadOnly = messageThreadOnly && message.isController()
                && juce::MessageManager::getInstance()->isThisTheMessageThread();
        });
        int accepted = 0;
        std::thread producer([&]
        {
            for (int index = 0; index < 1000; ++index)
                if (inbox.push(juce::MidiMessage::controllerEvent(1, 7, index % 128))) ++accepted;
        });
        producer.join();
        check("controller_inbox_bounded_and_deferred", accepted == 255 && received == 0);
        inbox.dispatchPending();
        check("controller_commands_run_on_message_thread", received == accepted && messageThreadOnly);
        inbox.push(juce::MidiMessage::controllerEvent(1, 7, 1));
        inbox.clear();
        inbox.dispatchPending();
        check("controller_disconnect_discards_queued_commands", received == accepted);
    }
    {
        TrackProcessor track;
        std::atomic<int> accepted { 0 };
        std::array<std::thread, 4> producers;
        for (int device = 0; device < 4; ++device)
            producers[static_cast<size_t>(device)] = std::thread([&, device]
            {
                for (int note = 0; note < 100; ++note)
                    if (track.enqueueMidiMessage(juce::MidiMessage::noteOn(device + 1, note, juce::uint8(64)))) ++accepted;
            });
        for (auto& producer : producers) producer.join();
        std::array<bool, 400> seen {};
        bool unique = true;
        const auto count = track.midiQueueWriteIndex.load();
        for (int index = 0; index < count; ++index)
        {
            const auto& message = track.pendingMidiQueue[static_cast<size_t>(index)].message;
            const int key = (message.getChannel() - 1) * 100 + message.getNoteNumber();
            if (key < 0 || key >= 400 || seen[static_cast<size_t>(key)]) { unique = false; break; }
            seen[static_cast<size_t>(key)] = true;
        }
        check("concurrent_midi_producers_preserve_every_event", accepted == 400 && count == 400 && unique);
    }
    {
        ProcessorSafety barrier;
        FaultProbe probe;
        juce::AudioBuffer<double> block(2, 63);
        block.clear();
        probe.mode = 2;
        check("double_precision_nonfinite_contained", !barrier.process(probe, block, midi)
            && ProcessorSafety::isFinite(block));
        barrier.reset();
        probe.mode = 0;
        check("double_precision_explicit_reset_recovers", barrier.process(probe, block, midi));
        probe.mode = 4;
        check("finite_double_cannot_overflow_float_output", !barrier.process(probe, block, midi)
            && ProcessorSafety::isFinite(block));
    }
    {
        TrackProcessor track;
        track.setRateAndBufferSizeDetails(48000, 64);
        track.prepareToPlay(48000, 64);
        auto effect = std::make_unique<FaultProbe>(0);
        auto* probe = effect.get();
        track.addTrackFX(std::move(effect), 48000, 64);
        juce::AudioBuffer<float> block(2, 64);
        fill(block);
        track.processBlock(block, midi);
        check("zero_bus_midi_effect_is_not_a_channel_fault", probe->calls == 1
            && track.getProcessorFault(false, 0) == 0 && ProcessorSafety::isFinite(block));
    }
    {
        const auto recoveryRoot = directory.getChildFile("discovery");
        const auto documentId = juce::Uuid().toString();
        ProjectFileStore::RecoverySession observer(recoveryRoot);
        juce::String abandonedId;
        {
            ProjectFileStore::RecoverySession abandoned(recoveryRoot);
            abandonedId = abandoned.getId();
            check("untitled_recovery_written_without_project_path", abandoned.write(documentId, "",
                "{\"tracks\":[],\"projectName\":\"Unsaved bass session\"}", 3).wasOk());
            check("live_recovery_session_not_offered", observer.discover().size() == 0);
            check("recovery_path_traversal_rejected", abandoned.write("../unsafe", "", "{\"tracks\":[]}", 3).failed()
                && abandoned.dismiss("../unsafe").failed());
            check("malformed_recovery_does_not_replace_snapshot", abandoned.write(documentId, "", "{truncated", 3).failed());
        } // Release ownership without a normal-close marker (interrupted session).
        auto entries = observer.discover();
        check("interrupted_untitled_recovery_discovered", entries.size() == 1
            && entries[0].getProperty("sourcePath", "missing").toString().isEmpty()
            && entries[0].getProperty("projectName", "").toString() == "Unsaved bass session");
        const juce::File snapshot(entries[0].getProperty("path", "").toString());
        check("discovered_snapshot_is_loadable_project", snapshot.existsAsFile()
            && juce::JSON::parse(snapshot).getProperty("tracks", {}).isArray());
        check("dismissal_retains_recovery_bytes", observer.dismiss(abandonedId + "/" + documentId).wasOk()
            && observer.discover().size() == 0 && snapshot.existsAsFile());
        {
            ProjectFileStore::RecoverySession clean(recoveryRoot);
            check("named_recovery_written", clean.write(documentId, "C:/original.osproj", "{\"tracks\":[]}", 3).wasOk());
            check("clean_recovery_marker_checked", clean.markClean().wasOk());
        }
        check("cleanly_closed_session_not_offered", observer.discover().size() == 0);
        {
            ProjectFileStore::RecoverySession session(recoveryRoot);
            check("retired_document_recovers_on_next_edit", session.write(documentId, "", "{\"tracks\":[]}", 3).wasOk()
                && session.retireDocument(documentId).wasOk()
                && session.write(documentId, "", "{\"tracks\":[],\"projectName\":\"New edit\"}", 3).wasOk());
        }
        check("edited_document_is_pending_again", observer.discover().size() == 1);
    }
    {
        AITrackEngine generation;
        generation.currentRequestId_ = "active";
        generation.currentProgress_.requestId = "active";
        generation.currentProgress_.state = "generating";
        generation.generationActive_ = true;
        generation.parseOutputLine("{\"requestId\":\"foreign\",\"state\":\"done\",\"outputFile\":\"other.wav\"}");
        check("native_ai_rejects_foreign_terminal_progress", generation.currentProgress_.state == "generating" && generation.generationActive_);
        generation.currentOutputFile_ = directory.getChildFile("partial-ai.wav");
        generation.currentOutputFile_.replaceWithText("partial WAV data");
        generation.handleWorkerExit();
        check("partial_ai_file_does_not_prove_generation_complete", generation.currentProgress_.state == "error"
            && generation.currentOutputFile_.existsAsFile());
        generation.parseOutputLine("{\"requestId\":\"active\",\"state\":\"done\"}");
        check("late_ai_terminal_message_cannot_replace_failure", generation.currentProgress_.state == "error");
        generation.currentProgress_.state = "generating";
        generation.parseOutputLine("{\"requestId\":\"active\",\"state\":\"done\",\"outputFile\":\"other.wav\"}");
        check("native_ai_rejects_unexpected_output_path", generation.currentProgress_.phase == "invalid_worker_output");
    }
    for (int failureMode : { 1, 2 })
    {
        auto status = std::make_shared<RecordingWriteStatus>();
        auto faulty = std::make_unique<StorageFaultStream>();
        auto* disk = faulty.get();
        std::unique_ptr<juce::OutputStream> stream = std::make_unique<CheckedRecordingStream>(std::move(faulty), status);
        auto* observed = stream.get();
        juce::WavAudioFormat wav;
        auto wavWriter = wav.createWriterFor(stream, juce::AudioFormatWriterOptions().withSampleRate(48000).withNumChannels(2).withBitsPerSample(16));
        auto writer = std::make_unique<CheckedRecordingWriter>(std::move(wavWriter), status, observed);
        juce::AudioBuffer<float> block(2, 128);
        fill(block);
        check("recording_checked_writer_accepts_valid_samples", writer->writeFromAudioSampleBuffer(block, 0, 128));
        const bool flushed = writer->flush();
        std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(
            new juce::MemoryInputStream(disk->memory.getData(), disk->memory.getDataSize(), true), true));
        check("recording_header_flush_is_loadable_before_close", flushed
            && status->writtenSamples.load() == 128 && reader && reader->lengthInSamples == 128);
        disk->mode = failureMode;
        const bool rejected = failureMode == 1 ? !writer->writeFromAudioSampleBuffer(block, 0, 128) : !writer->flush();
        check(failureMode == 1 ? "injected_storage_write_failure_observed" : "injected_storage_seek_flush_failure_observed",
            rejected && status->fault.load() != RecordingWriteStatus::none);
        disk->mode = 0;
        check("failed_writer_latches_without_retrying_audio", !writer->writeFromAudioSampleBuffer(block, 0, 128)
            && status->writtenSamples.load() == 128);
        writer.reset();
        check("failed_writer_finalization_status_survives_writer", status->finished.load());
    }
#if JUCE_WINDOWS
    for (const bool readRequest : { false, true })
    {
        AITrackEngine generation;
        juce::StreamingSocket listener;
        const bool listening = listener.createListener(0, "127.0.0.1");
        check("uncooperative_ai_socket_fixture_listens", listening);
        if (listening)
        {
            std::atomic<bool> connected { false }, finish { false }, requestReturned { false }, received { false };
            std::thread server([&] {
                if (listener.waitUntilReady(true, 3000) <= 0) return;
                std::unique_ptr<juce::StreamingSocket> connection(listener.waitForNextConnection());
                connected = connection != nullptr;
                char chunk[4096];
                while (connection && !finish.load())
                {
                    if (readRequest && connection->waitUntilReady(true, 10) > 0)
                        received = connection->read(chunk, sizeof(chunk), false) > 0 || received.load();
                    else juce::Thread::sleep(5);
                }
            });
            generation.workerPort_ = listener.getBoundPort();
            generation.currentRequestId_ = "blocked-request";
            generation.expectedScriptVersion_ = "fixture";
            generation.currentProgress_.state = "generating";
            generation.generationActive_ = true;
            const auto parameters = juce::String::repeatedString("x", readRequest ? 4096 : 4 * 1024 * 1024);
            generation.generationThread_ = std::thread([&] {
                generation.sendGenerateRequest("stable-audio-3-medium", "variation", parameters, directory.getChildFile("never-generated.wav"));
                requestReturned = true;
            });
            const auto connectDeadline = juce::Time::getMillisecondCounterHiRes() + 3000.0;
            while ((!connected.load() || (readRequest && !received.load()))
                && juce::Time::getMillisecondCounterHiRes() < connectDeadline) juce::Thread::sleep(5);
            juce::Thread::sleep(50);
            const auto cancelStart = juce::Time::getMillisecondCounterHiRes();
            generation.cancel();
            const auto elapsed = juce::Time::getMillisecondCounterHiRes() - cancelStart;
            finish = true;
            server.join();
            check(readRequest ? "ai_cancel_bounds_missing_acknowledgement" : "ai_cancel_bounds_large_request_preparation",
                connected.load() && (!readRequest || received.load()) && requestReturned.load() && elapsed < 2000.0);
            checks.getLast().getDynamicObject()->setProperty("elapsedMs", elapsed);
        }
    }
    {
        const auto workerDirectory = directory.getChildFile("owned-worker");
        workerDirectory.createDirectory();
        const auto executable = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
        OwnedChildProcess independent;
        check("independent_worker_started", independent.start({ executable.getFullPathName(), "--owned-worker-fixture", workerDirectory.getFullPathName(), "--owned-worker-leaf" }));
        unsigned long descendantPid = 0;
        {
            OwnedChildProcess parent;
            check("owned_process_tree_started", parent.start({ executable.getFullPathName(), "--owned-worker-fixture", workerDirectory.getFullPathName() }));
            char byte;
            const auto readStart = juce::Time::getMillisecondCounterHiRes();
            const auto bytes = parent.readProcessOutput(&byte, 1);
            check("silent_worker_output_read_is_nonblocking", bytes == 0 && juce::Time::getMillisecondCounterHiRes() - readStart < 100.0);
            const auto deadline = juce::Time::getMillisecondCounterHiRes() + 5000.0;
            while (!workerDirectory.getChildFile("descendant.pid").existsAsFile() && juce::Time::getMillisecondCounterHiRes() < deadline)
                juce::Thread::sleep(10);
            descendantPid = static_cast<unsigned long>(workerDirectory.getChildFile("descendant.pid").loadFileAsString().getLargeIntValue());
            check("owned_descendant_created", descendantPid > 0);
        }
        auto descendant = OpenProcess(SYNCHRONIZE, FALSE, descendantPid);
        check("job_close_terminates_descendants", descendantPid > 0 && (descendant == nullptr || WaitForSingleObject(descendant, 3000) == WAIT_OBJECT_0));
        if (descendant != nullptr) CloseHandle(descendant);
        check("stopping_one_job_leaves_other_session_alive", independent.isRunning());
        std::atomic<bool> keepRunning { true };
        std::thread cancellation([&] { juce::Thread::sleep(50); keepRunning = false; });
        const auto waitStart = juce::Time::getMillisecondCounterHiRes();
        const bool finishedNormally = independent.waitForProcessToFinish(30000, keepRunning);
        cancellation.join();
        check("owned_media_process_wait_observes_cancellation", !finishedNormally
            && juce::Time::getMillisecondCounterHiRes() - waitStart < 2000.0);
        independent.kill();
    }
    {
        AITrackEngine generation;
        const auto workerDirectory = directory.getChildFile("cancel-worker");
        workerDirectory.createDirectory();
        generation.workerProcess_ = std::make_unique<OwnedChildProcess>();
        const auto executable = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
        check("cancellation_fixture_worker_started", generation.workerProcess_->start({ executable.getFullPathName(), "--owned-worker-fixture", workerDirectory.getFullPathName(), "--owned-worker-leaf" }));
        std::atomic<bool> retained { false };
        generation.generationThread_ = std::thread([&] {
            while (!generation.stopRequested_.load()) juce::Thread::sleep(1);
            const juce::ScopedLock lock(generation.lock_);
            retained = generation.workerProcess_ != nullptr;
        });
        generation.readerThread_ = std::thread([&] { generation.readerLoop(); });
        const auto start = juce::Time::getMillisecondCounterHiRes();
        generation.cancel();
        check("cancel_joins_launcher_before_retiring_process", retained.load() && !generation.workerProcess_);
        check("silent_worker_cancel_returns_without_killing_host_thread", juce::Time::getMillisecondCounterHiRes() - start < 2000.0);
    }
    {
        AITrackEngine generation;
        generation.workerProcess_ = std::make_unique<OwnedChildProcess>();
        const auto executable = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
        const bool started = generation.workerProcess_->start({ executable.getFullPathName(), "--owned-worker-fixture",
            directory.getFullPathName(), "--owned-worker-leaf" });
        generation.currentProgress_.state = "error";
        std::atomic<bool> retained { false };
        generation.generationThread_ = std::thread([&] {
            while (!generation.stopRequested_.load()) juce::Thread::sleep(1);
            retained = generation.workerProcess_ != nullptr;
        });
        generation.pollProgress();
        check("terminal_ai_poll_joins_launcher_before_retiring_worker", started && retained.load() && !generation.workerProcess_);
    }
#endif
    auto report = std::make_unique<juce::DynamicObject>();
    report->setProperty("passed", passed);
    report->setProperty("checks", checks);
    report->setProperty("subjectiveAudio", "not_asserted");
    report->setProperty("hardwareDrivers", "not_asserted");
#if defined(__SANITIZE_ADDRESS__)
    report->setProperty("addressSanitizer", true);
#else
    report->setProperty("addressSanitizer", false);
#endif
    const bool wrote = directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(juce::var(report.release()), true));
    return passed && wrote ? 0 : 1;
}
