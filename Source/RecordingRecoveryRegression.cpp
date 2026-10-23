#include "RuntimeLocation.h"
#include "RecordingRecoveryRegression.h"
#include "RecordingRecovery.h"
#include "AudioRecorder.h"
#include "OwnedChildProcess.h"
#include "ProjectFileStore.h"
#include "ExpectedWavFailureLog.h"
#include <atomic>
#include <limits>
#include <thread>

namespace
{
// Let PCM reach a real file, then fail only the final WAV header update.
class HeaderFaultStream final : public juce::OutputStream
{
public:
    explicit HeaderFaultStream(const juce::File& file) : output(file) {}
    int failure = 0; // 1: header write, 2: header seek.
    bool write(const void* data, size_t bytes) override
    { return failure != 1 && output.write(data, bytes); }
    void flush() override { output.flush(); }
    juce::int64 getPosition() override { return output.getPosition(); }
    bool setPosition(juce::int64 position) override
    { return failure != 2 && output.setPosition(position); }
private:
    juce::FileOutputStream output;
};

void checkFinalizationRecovery(const juce::File& directory, const std::function<void(const char*, bool)>& check)
{
    for (int fixture = 0; fixture < 5; ++fixture)
    {
        const bool healthy = fixture == 4;
        const bool shortHeader = (fixture % 2) != 0;
        const auto label = juce::String("recording_finalization_") + juce::String(fixture);
        const auto root = directory.getChildFile(label);
        root.createDirectory();
        const auto file = root.getChildFile("take.wav");
        const auto journals = root.getChildFile("journals");
        juce::String id;
        juce::File journalFile;
        auto status = std::make_shared<RecordingWriteStatus>();
        {
            RecoveryJournal journal(journals);
            auto metadata = juce::JSON::parse("{\"sampleRate\":48000,\"channels\":1,\"status\":\"recording\",\"writeFault\":0}");
            metadata.getDynamicObject()->setProperty("path", file.getFullPathName());
            id = journal.create("recording", metadata);
            journalFile = journal.entryFile(id);
            status->journalFile = journalFile;
            status->journalMetadata = juce::JSON::parse(journalFile.loadFileAsString());
            auto faulty = std::make_unique<HeaderFaultStream>(file);
            auto* control = faulty.get();
            std::unique_ptr<juce::OutputStream> stream = std::make_unique<CheckedRecordingStream>(std::move(faulty), status);
            auto* observed = stream.get();
            juce::WavAudioFormat format;
            auto wavWriter = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
                .withSampleRate(48000).withNumChannels(1).withBitsPerSample(16));
            if (!wavWriter) { check("recording_finalization_fixture_writer", false); continue; }
            auto writer = std::make_unique<CheckedRecordingWriter>(std::move(wavWriter), status, observed);
            juce::AudioBuffer<float> samples(1, 128);
            for (int sample = 0; sample < 128; ++sample) samples.setSample(0, sample, 0.125f);
            bool wrote = writer->writeFromAudioSampleBuffer(samples, 0, 128);
            if (shortHeader) wrote = writer->flush() && wrote;
            for (int sample = 0; sample < 128; ++sample) samples.setSample(0, sample, 0.25f);
            wrote = writer->writeFromAudioSampleBuffer(samples, 0, 128) && wrote;
            control->failure = healthy ? 0 : fixture / 2 + 1;
            {
                ExpectedWavFailureLog expectedSeekFailure(control->failure == 2);
                writer.reset();
            }
            check((label + "_pcm_written").toRawUTF8(), wrote && !id.isEmpty());
            const auto saved = juce::JSON::parse(journalFile.loadFileAsString());
            check((label + "_journal_status").toRawUTF8(), status->finished.load()
                && saved.getProperty("status", "").toString() == (healthy ? "finalized" : "recording")
                && (status->fault.load() == RecordingWriteStatus::none) == healthy);
            if (!healthy) journal.markClean(); // Faulted takes must survive even a normal shutdown.
        }
        if (healthy)
        {
            auto tail = file.createOutputStream();
            tail->setPosition(file.getSize());
            tail->writeInt(0); tail->flush(); // A finalized data chunk excludes trailing bytes.
        }
        auto entry = RecoveryJournal::readInactive(id, journals);
        const auto info = RecordingRecovery::inspect(entry);
        check((label + "_all_frames_recoverable").toRawUTF8(), info.getProperty("error", "").toString().isEmpty()
            && static_cast<int>(info.getProperty("recoverableFrames", 0)) == 256);
        if (!healthy)
        {
            // Also handle journals already written with the incorrect terminal status.
            entry.getDynamicObject()->setProperty("status", "finalized");
            check((label + "_faulted_finalized_journal_written").toRawUTF8(), RecoveryJournal::write(journalFile, entry));
        }
        juce::MemoryBlock before, after;
        file.loadFileAsData(before);
        const auto repaired = RecordingRecovery::repair(id, [] { return true; }, journals);
        const auto repairedPath = repaired.getProperty("repairedPath", "").toString();
        bool exact = repaired.getProperty("error", "").toString().isEmpty() && repairedPath.isNotEmpty();
        if (exact)
        {
            juce::WavAudioFormat format;
            std::unique_ptr<juce::AudioFormatReader> reader(format.createReaderFor(new juce::FileInputStream(juce::File(repairedPath)), true));
            juce::AudioBuffer<float> samples(1, 256);
            exact = reader && reader->lengthInSamples == 256 && reader->read(&samples, 0, 256, 0, true, false);
            for (int sample = 0; exact && sample < 256; ++sample)
                exact = samples.getSample(0, sample) == (sample < 128 ? 0.125f : 0.25f);
        }
        file.loadFileAsData(after);
        check((label + "_repair_exact_original_unchanged").toRawUTF8(), exact && before == after);
    }
}
}

int runInterruptedRecordingFixture(const juce::File& root)
{
    if (!root.isDirectory()) return 2;
    AudioRecorder recorder(root.getChildFile("journals"));
    const auto file = root.getChildFile("interrupted.wav");
    if (!recorder.startRecording("interrupted-track", file, 48000, 1)) return 3;
    recorder.setRecordingStartTime("interrupted-track", 2.5);
    juce::AudioBuffer<float> buffer(1, 512);
    for (int sample = 0; sample < 512; ++sample) buffer.setSample(0, sample, 0.125f);
    for (int block = 0; block < 96; ++block)
    {
        recorder.writeBlock("interrupted-track", buffer, 512);
        juce::Thread::sleep(1);
    }
    juce::Thread::sleep(150);
    if (!root.getChildFile("ready").replaceWithText("Terminate this fixture while the take is open")) return 4;
    juce::Thread::sleep(30000); // Parent intentionally terminates only this child.
    return 0;
}

void runRecordingRecoveryRegression(const juce::File& directory, const std::function<void(const char*, bool)>& check)
{
    // No device or user preferences: native recorder, synthetic audio and an
    // isolated journal. The bounded total fits each writer FIFO even if disk
    // scheduling pauses, so a preview-induced lost frame cannot be hidden.
    const auto previewRoot = directory.getChildFile("recording-preview");
    previewRoot.createDirectory();
    for (const int blockSize : { 8, 16, 64 })
    {
        const auto blockRoot = previewRoot.getChildFile("blocks-" + juce::String(blockSize));
        const auto checkBlock = [&](const char* name, bool passed) {
            const auto qualifiedName = juce::String(name) + "_" + juce::String(blockSize) + "_samples";
            check(qualifiedName.toRawUTF8(), passed);
        };
        AudioRecorder recorder(blockRoot.getChildFile("journals"));
        const auto monoFile = blockRoot.getChildFile("mono.wav");
        const auto stereoFile = blockRoot.getChildFile("stereo.wav");
        const bool started = recorder.startRecording("mono", monoFile, 48000.0, 1)
            && recorder.startRecording("stereo", stereoFile, 48000.0, 2);
        checkBlock("recording_preview_concurrent_fixture_started", started);
        if (started)
        {
            juce::AudioBuffer<float> mono(1, blockSize), stereo(2, blockSize);
            for (int sample = 0; sample < blockSize; ++sample)
            {
                mono.setSample(0, sample, 0.125f);
                stereo.setSample(0, sample, 0.125f); stereo.setSample(1, sample, -0.25f);
            }
            const auto write = [&] {
                recorder.writeBlock("mono", mono, blockSize);
                recorder.writeBlock("stereo", stereo, blockSize);
            };
            for (int block = 0; block < 4; ++block) write();
            juce::WaitableEvent written;
            bool independent = false;
            std::thread writer;
            {
                // Deliberately stall every non-realtime preview/status lock.
                // Audio writes must finish before these locks are released.
                const juce::ScopedLock previewLock(recorder.previewRegistryLock);
                const juce::ScopedLock statusLock(recorder.statusLock);
                const juce::ScopedLock growthLock(recorder.recordingPreviews.at("mono")->growthLock);
                writer = std::thread([&] { for (int block = 0; block < 64; ++block) write(); written.signal(); });
                independent = written.wait(2000);
            }
            writer.join();
            checkBlock("recording_writes_ignore_preview_status_growth_locks", independent);
            std::atomic<bool> done { false }, previewValid { true };
            std::atomic<int> polls { 0 };
            juce::WaitableEvent polling;
            std::thread reader([&] {
                polling.signal();
                while (!done.load(std::memory_order_acquire))
                {
                    for (const auto& id : { "mono", "stereo" })
                    {
                        const auto peaks = recorder.getRecordingPeaks(id, 256, 2048);
                        if (const auto* values = peaks.getArray(); values != nullptr && !values->isEmpty())
                        {
                            const int channels = static_cast<int>((*values)[0]);
                            if (channels != (juce::String(id) == "mono" ? 1 : 2)
                                || (values->size() - 1) % (channels * 2) != 0) previewValid = false;
                        }
                    }
                    if (recorder.takeWriteFailures().size() != 0) previewValid = false;
                    recorder.maintainRecordingPreviews();
                    polls.fetch_add(1, std::memory_order_release);
                    std::this_thread::yield();
                }
            });
            polling.wait(2000);
            for (int block = 0; block < 512; ++block)
            {
                write();
                if (block % 16 == 0) juce::Thread::sleep(1);
            }
            done.store(true, std::memory_order_release); reader.join();
            const auto completed = recorder.stopAllRecordings(48000.0);
            const int expectedFrames = (4 + 64 + 512) * blockSize;
            bool exact = completed.size() == 2 && previewValid && polls.load() > 0
                && recorder.getWriteLockMissCount() == 0 && recorder.getWriterBufferOverflowCount() == 0;
            for (const auto& file : { monoFile, stereoFile })
            {
                juce::WavAudioFormat format;
                std::unique_ptr<juce::AudioFormatReader> audio(format.createReaderFor(new juce::FileInputStream(file), true));
                const int channels = file == monoFile ? 1 : 2;
                juce::AudioBuffer<float> samples(channels, expectedFrames);
                const bool readable = audio && audio->lengthInSamples == expectedFrames
                    && audio->read(&samples, 0, expectedFrames, 0, true, true);
                exact = readable && exact;
                if (readable) for (int channel = 0; channel < channels; ++channel)
                    for (int sample = 0; sample < expectedFrames; ++sample)
                        exact = exact && samples.getSample(channel, sample) == (channel == 0 ? 0.125f : -0.25f);
            }
            checkBlock("recording_preview_status_poll_preserves_every_pcm_frame", exact);
        }
    }
    {
        AudioRecorder recorder(previewRoot.getChildFile("boundary-journals"));
        const auto firstFile = previewRoot.getChildFile("boundary.wav");
        const bool started = recorder.startRecording("boundary", firstFile, 48000.0, 1);
        check("recording_preview_boundary_fixture_started", started);
        if (started)
        {
            juce::AudioBuffer<float> block(1, 256);
            block.clear(); block.setSample(0, 0, 0.125f);
            recorder.writeBlock("boundary", block, 256);
            const auto first = recorder.getRecordingPeaks("boundary", 256, 1);
            block.clear(); block.setSample(0, 0, 0.75f);
            recorder.writeBlock("boundary", block, 255);
            const auto partial = recorder.getRecordingPeaks("boundary", 256, 2);
            block.clear(); recorder.writeBlock("boundary", block, 1);
            const auto repeated = recorder.getRecordingPeaks("boundary", 256, 1);
            const auto appended = recorder.getRecordingPeaks("boundary", 256, 1, 256);
            check("recording_preview_complete_bucket_append_matches_refetch",
                first.size() == 3 && partial.size() == 3 && repeated.size() == 3 && appended.size() == 3
                && static_cast<float>(first[2]) == 0.125f && static_cast<float>(repeated[2]) == 0.125f
                && static_cast<float>(appended[2]) == 0.75f);
            auto retained = recorder.recordingPreviews.at("boundary");
            std::atomic<bool> done { false }, valid { true };
            std::thread reader([&] {
                while (!done.load(std::memory_order_acquire))
                {
                    const auto peaks = recorder.getRecordingPeaks("boundary", 256, 8192);
                    if (const auto* values = peaks.getArray(); values != nullptr && !values->isEmpty())
                        if (static_cast<int>((*values)[0]) != 1 || values->size() > 5) valid = false;
                }
            });
            AudioRecorder::CompletedRecording previous;
            const bool rolled = recorder.rolloverRecording("boundary", previewRoot.getChildFile("rolled.wav"), 48000.0, 1, 4.0, previous);
            block.clear(); block.setSample(0, 0, -0.5f); recorder.writeBlock("boundary", block, 256);
            const auto rolledPeaks = recorder.getRecordingPeaks("boundary", 256, 1);
            recorder.stopRecording("boundary");
            done.store(true, std::memory_order_release); reader.join();
            check("recording_preview_stop_rollover_retains_readers_and_resets_take",
                rolled && valid && previous.duration == 512.0 / 48000.0
                && !retained->active.load() && retained->peakChunks[0][1] == 0.125f
                && rolledPeaks.size() == 3 && static_cast<float>(rolledPeaks[1]) == -0.5f
                && recorder.getRecordingPeaks("boundary", 256, 1).size() == 0);
        }
    }
    {
        AudioRecorder recorder(previewRoot.getChildFile("gap-journals"));
        const bool started = recorder.startRecording("gap", previewRoot.getChildFile("gap.wav"), 48000.0, 1);
        check("recording_preview_gap_fixture_started", started);
        if (started)
        {
            // Advance only the preview clock to the first storage boundary.
            // Real writes still exercise the callback's missing-storage path.
            const auto preview = recorder.recordingPreviews.at("gap");
            const auto boundary = preview->peakChunkEntries;
            preview->peakTableSize.store(boundary, std::memory_order_release);
            juce::AudioBuffer<float> block(1, 256);
            block.clear(); block.setSample(0, 0, 0.5f);
            recorder.writeBlock("gap", block, 256);
            const bool clockAdvanced = preview->peakTableSize.load() == boundary + 1;
            recorder.maintainRecordingPreviews();
            block.clear(); block.setSample(0, 0, 0.75f);
            recorder.writeBlock("gap", block, 256);
            const auto peaks = recorder.getRecordingPeaks("gap", 256, 2,
                static_cast<juce::int64>(boundary) * AudioRecorder::recordingPeakStride);
            check("recording_preview_delayed_growth_keeps_zero_gap_and_sample_time",
                clockAdvanced && peaks.size() == 5
                && static_cast<float>(peaks[1]) == 0.0f && static_cast<float>(peaks[2]) == 0.0f
                && static_cast<float>(peaks[4]) == 0.75f);
            const auto maximum = boundary * AudioRecorder::RecordingPreview::PEAK_MAX_CHUNKS;
            preview->peakTableSize.store(maximum, std::memory_order_release);
            recorder.writeBlock("gap", block, 256);
            const auto completed = recorder.stopAllRecordings(48000.0);
            check("recording_preview_capacity_saturates_without_stopping_pcm",
                preview->peakTableSize.load() == maximum && completed.size() == 1
                && completed.front().duration == 768.0 / 48000.0
                && recorder.getWriterBufferOverflowCount() == 0);
        }
    }
    {
        // Virtual published bucket history avoids writing hundreds of seconds
        // of PCM merely to exercise visibility-independent maintenance/bounds.
        AudioRecorder recorder(previewRoot.getChildFile("bounds-journals"));
        auto preview = std::make_shared<AudioRecorder::RecordingPreview>(384000.0, 2);
        recorder.recordingPreviews["virtual"] = preview;
        preview->peakTableSize.store(preview->peakChunkEntries);
        recorder.maintainRecordingPreviews(); // No waveform request preceded this.
        const bool grew = preview->peakAllocatedChunks.load() == 2;
        for (size_t chunk = 0; chunk < 2; ++chunk)
            if (preview->peakChunks[chunk])
                for (size_t entry = 0; entry < preview->peakChunkEntries; ++entry)
                {
                    auto* values = preview->peakChunks[chunk].get() + entry * 4;
                    values[0] = -0.125f; values[1] = 0.25f; values[2] = -0.5f; values[3] = 0.75f;
                }
        preview->peakTableSize.store(preview->peakChunkEntries * 2, std::memory_order_release);
        const auto pixels = recorder.getRecordingPeaks("virtual", 256, std::numeric_limits<int>::max());
        const auto work = recorder.getRecordingPeaks("virtual", 65536, std::numeric_limits<int>::max());
        const auto legacy = recorder.getRecordingPeaks("virtual", 64, 1);
        const auto invalid = recorder.getRecordingPeaks("virtual", 0, 100);
        const auto distant = recorder.getRecordingPeaks("virtual", 256, 10, std::numeric_limits<juce::int64>::max());
        check("recording_preview_maintenance_grows_without_visible_requests", grew);
        check("recording_preview_payload_work_and_integer_bounds",
            pixels.size() == 1 + AudioRecorder::maximumRecordingPeakPixels * 4
            && work.size() == 1 + static_cast<int>(AudioRecorder::maximumRecordingPeakEntriesPerRequest / 256) * 4
            && legacy.size() == 5 && static_cast<float>(legacy[2]) == 0.25f
            && invalid.size() == 0 && distant.size() == 0);
    }

    checkFinalizationRecovery(directory, check);
    const auto root = directory.getChildFile("recording-interruption");
    root.createDirectory();
    const auto journals = root.getChildFile("journals");
    OwnedChildProcess child;
    const auto executable = OpenStudioRuntime::executableFile();
    bool started = child.start({ executable.getFullPathName(), "--recording-recovery-fixture", root.getFullPathName() });
    const auto began = juce::Time::getMillisecondCounterHiRes();
    while (started && child.isRunning() && !root.getChildFile("ready").existsAsFile()
        && juce::Time::getMillisecondCounterHiRes() - began < 5000) juce::Thread::sleep(10);
    started = started && root.getChildFile("ready").existsAsFile() && child.isRunning();
    check("interrupted_recording_child_accepts_audio_without_a_device", started);
    check("recording_discovery_excludes_live_process", RecoveryJournal::discover(journals).size() == 0);
    child.kill();
    const std::atomic<bool> keepRunning { true };
    check("interrupted_recording_child_terminated_before_discovery", child.waitForProcessToFinish(2000, keepRunning));
    const auto found = RecoveryJournal::discover(journals);
    const auto* entries = found.getArray();
    check("interrupted_recording_discovered_after_real_process_death", entries != nullptr && entries->size() == 1);
    if (entries == nullptr || entries->size() != 1) return;
    const auto entry = entries->getFirst();
    const auto id = entry.getProperty("id", "").toString();
    const auto info = RecordingRecovery::inspect(entry);
    check("stale_recording_header_retains_complete_pcm_frames", info.getProperty("error", "").toString().isEmpty()
        && static_cast<juce::int64>(info.getProperty("recoverableFrames", 0)) > 0
        && static_cast<bool>(info.getProperty("staleHeader", false))
        && static_cast<double>(info.getProperty("startTime", 0)) == 2.5);
    const juce::File original(entry.getProperty("path", "").toString());
    juce::MemoryBlock before, after;
    original.loadFileAsData(before);
    const auto repaired = RecordingRecovery::repair(id, [] { return true; }, journals);
    root.getChildFile("repair-result.json").replaceWithText(juce::JSON::toString(repaired));
    const auto repairedPath = repaired.getProperty("repairedPath", "").toString();
    bool readable = repaired.getProperty("error", "").toString().isEmpty() && repairedPath.isNotEmpty();
    if (readable)
    {
        juce::WavAudioFormat format;
        std::unique_ptr<juce::AudioFormatReader> reader(format.createReaderFor(new juce::FileInputStream(juce::File(repairedPath)), true));
        readable = reader && reader->lengthInSamples == static_cast<juce::int64>(info.getProperty("recoverableFrames", 0));
        if (readable)
        {
            juce::AudioBuffer<float> samples(1, 128);
            readable = reader->read(&samples, 0, 128, 0, true, false);
            for (int sample = 0; sample < 128; ++sample) readable = samples.getSample(0, sample) == 0.125f && readable;
        }
    }
    original.loadFileAsData(after);
    check("recording_repair_is_readable_bit_exact_and_preserves_original", readable && before == after);
    const auto cancelled = RecordingRecovery::repair(id, [] { return false; }, journals);
    check("cancelled_recording_repair_preserves_original_and_prior_copy", cancelled.getProperty("error", "").toString().isNotEmpty()
        && juce::File(repairedPath).existsAsFile() && original.getSize() == static_cast<juce::int64>(before.getSize()));
    {
        auto tail = original.createOutputStream();
        tail->setPosition(original.getSize());
        tail->writeByte(0x55); tail->flush();
    }
    const auto truncated = RecordingRecovery::inspect(entry);
    check("recording_partial_pcm_frame_is_omitted_not_invented", static_cast<int>(truncated.getProperty("ignoredTailBytes", 0)) == 1
        && truncated.getProperty("recoverableFrames", 0) == info.getProperty("recoverableFrames", 0));
    auto invalid = entry.clone();
    invalid.getDynamicObject()->setProperty("sampleRate", 44100);
    check("recording_repair_rejects_journal_format_mismatch", RecordingRecovery::inspect(invalid).getProperty("error", "").toString().isNotEmpty());
    check("recovery_ids_cannot_escape_owned_storage", !RecoveryJournal::readInactive("../../outside", journals).isObject()
        && !RecoveryJournal::dismiss("../outside", journals));
    check("recording_dismissal_preserves_both_original_and_repaired_audio", RecoveryJournal::dismiss(id, journals)
        && RecoveryJournal::discover(journals).size() == 0 && original.existsAsFile() && juce::File(repairedPath).existsAsFile());
    {
        AudioRecorder clean(journals);
        const auto file = root.getChildFile("clean.wav");
        check("clean_recording_fixture_starts", clean.startRecording("clean", file, 48000, 2));
        check("recorder_refuses_to_overwrite_an_existing_take", !clean.startRecording("other", file, 48000, 2));
    }
    check("healthy_normal_recording_shutdown_does_not_offer_recovery", RecoveryJournal::discover(journals).size() == 0);
    {
        const auto invalidRoot = root.getChildFile("not-a-directory");
        invalidRoot.replaceWithText("protected");
        AudioRecorder failedJournal(invalidRoot);
        check("recording_is_not_started_without_a_durable_journal", !failedJournal.startRecording("failed", root.getChildFile("failed.wav"), 48000, 1)
            && invalidRoot.loadFileAsString() == "protected");
    }
    juce::String aiId;
    {
        RecoveryJournal ai(journals);
        auto payload = std::make_unique<juce::DynamicObject>();
        payload->setProperty("status", "queued"); payload->setProperty("seed", 123);
        aiId = ai.create("ai", juce::var(payload.release()));
        auto completed = std::make_unique<juce::DynamicObject>();
        completed->setProperty("status", "completed"); completed->setProperty("outputFile", repairedPath);
        check("ai_native_completion_is_journalled_before_frontend_poll", RecoveryJournal::updateOwnedAI(aiId, juce::var(completed.release()), journals));
        ai.markClean();
    }
    const auto recoveredAI = RecoveryJournal::readInactive(aiId, journals);
    check("ai_completed_artifact_survives_clean_restart_and_preserves_request", recoveredAI.getProperty("outputFile", "").toString() == repairedPath
        && static_cast<int>(recoveredAI.getProperty("seed", 0)) == 123 && recoveredAI.getProperty("status", "").toString() == "completed");
    const auto project = root.getChildFile("recovered.osproj");
    const auto savedDocument = juce::String("{\"tracks\":[{\"clips\":[{\"recoveryJobId\":\"") + aiId + "\"}]}]}";
    check("recovery_snapshot_does_not_retire_unsaved_audio", ProjectFileStore::save(project, savedDocument, true, 3, journals).wasOk()
        && RecoveryJournal::readInactive(aiId, journals).isObject());
    check("failed_project_save_keeps_audio_recoverable", ProjectFileStore::save(root, savedDocument, false, 3, journals).failed()
        && RecoveryJournal::readInactive(aiId, journals).isObject());
    check("saving_other_clips_keeps_audio_recoverable", ProjectFileStore::save(project, "{\"tracks\":[]}", false, 3, journals).wasOk()
        && RecoveryJournal::readInactive(aiId, journals).isObject());
    check("explicit_save_retires_only_durable_recovery_audio", ProjectFileStore::save(project, savedDocument, false, 3, journals).wasOk()
        && !RecoveryJournal::readInactive(aiId, journals).isObject() && juce::File(repairedPath).existsAsFile());
    juce::String liveId, unsavedId;
    {
        RecoveryJournal live(journals);
        auto data = juce::JSON::parse("{\"status\":\"completed\"}");
        liveId = live.create("ai", data);
        unsavedId = live.create("ai", data);
        const auto json = juce::String("{\"tracks\":[{\"clips\":[{\"recoveryJobId\":\"") + liveId + "\"}]}]}";
        check("saving_live_ai_result_is_durable", ProjectFileStore::save(project, json, false, 3, journals).wasOk());
        live.update(liveId, data); // A delayed terminal update must not resurrect the reminder.
    }
    check("live_ai_save_acknowledgement_survives_restart", !RecoveryJournal::readInactive(liveId, journals).isObject()
        && RecoveryJournal::readInactive(unsavedId, journals).isObject());
}
