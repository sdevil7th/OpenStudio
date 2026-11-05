#include "PeakCacheGenerationRegression.h"
#include "PeakCache.h"

namespace
{
bool writeSource(const juce::File& file, float value, int frames = 2048)
{
    juce::AudioBuffer<float> samples(1, frames);
    juce::FloatVectorOperations::fill(samples.getWritePointer(0), value, frames);
    auto output = file.createOutputStream();
    if (!output) return false;
    output->setPosition(0);
    output->truncate();
    std::unique_ptr<juce::OutputStream> stream(std::move(output));
    juce::WavAudioFormat format;
    auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
        .withSampleRate(48000).withNumChannels(1).withBitsPerSample(32)
        .withSampleFormat(juce::AudioFormatWriterOptions::SampleFormat::floatingPoint));
    return writer && writer->writeFromAudioSampleBuffer(samples, 0, frames);
}

bool peakEquals(const juce::var& peaks, float value)
{
    const auto* values = peaks.getArray();
    return values && values->size() >= 3
        && static_cast<float>((*values)[1]) == value && static_cast<float>((*values)[2]) == value;
}
}

struct PeakCacheGenerationRegressionAccess
{
    static juce::var run()
    {
        juce::Array<juce::var> checks;
        const auto check = [&checks](const char* id, bool pass, const char* detail)
        {
            auto* item = new juce::DynamicObject();
            item->setProperty("id", id);
            item->setProperty("pass", pass);
            item->setProperty("detail", detail);
            checks.add(juce::var(item));
        };
        juce::TemporaryFile source(".wav");
        const auto& audio = source.getFile();
        PeakCache cache;
        const auto sidecar = PeakCache::getPeakFilePath(audio);
        bool ready = writeSource(audio, 0.25f) && cache.generateSync(audio);
        const auto oldVersion = cache.captureSourceVersion(audio);
        auto oldEntry = std::make_shared<PeakCache::CacheEntry>();
        ready = ready && cache.loadFromFile(sidecar, audio, *oldEntry);
        juce::TemporaryFile oldStage(sidecar);
        ready = ready && PeakCache::writeStagedFile(oldStage.getFile(), *oldEntry,
                                                   oldVersion.size, oldVersion.modified);

        // Pause an actual completed load and staged write, refresh the same
        // unchanged source, then resume both old publication operations.
        cache.invalidate(audio);
        ready = ready && cache.generateSync(audio);
        const auto currentVersion = cache.captureSourceVersion(audio);
        const auto freshEntry = cache.memoryCache[audio.getFullPathName()];
        const auto rejected = cache.publishLoadedEntry(audio, oldVersion, oldEntry);
        check("peak_cache_stale_completed_load_cannot_replace_refresh", ready && !rejected
            && currentVersion.generation != oldVersion.generation
            && cache.memoryCache[audio.getFullPathName()] == freshEntry
            && peakEquals(cache.getPeaks(audio, 64, 0, 1), 0.25f),
            "A completed sidecar load resumed after invalidation cannot overwrite the refreshed immutable entry, even when source metadata is unchanged.");

        juce::MemoryBlock before, after;
        const bool captured = sidecar.loadFileAsData(before);
        const bool staleWrite = cache.publishGeneratedEntry(audio, oldVersion, oldEntry, oldStage, true);
        check("peak_cache_stale_staged_write_cannot_replace_sidecar", ready && captured && !staleWrite
            && sidecar.loadFileAsData(after) && before == after
            && cache.memoryCache[audio.getFullPathName()] == freshEntry,
            "A completed old-generation staging write cannot replace either the current sidecar bytes or its memory entry.");

        check("peak_cache_queued_old_generation_rejected", ready
            && !cache.generateSyncForVersion(audio, oldVersion)
            && cache.memoryCache[audio.getFullPathName()] == freshEntry,
            "Generation work uses its enqueue-time version and exits before scanning when that generation has been invalidated.");

        const bool newClaimed = cache.claimPendingGeneration(currentVersion);
        const bool oldEnqueueRejected = !cache.claimPendingGeneration(oldVersion);
        const auto pendingOwner = cache.pendingGenerations.find(currentVersion.key);
        check("peak_cache_old_enqueue_cannot_replace_new_pending_owner", newClaimed && oldEnqueueRejected
            && pendingOwner != cache.pendingGenerations.end() && pendingOwner->second == currentVersion.generation,
            "An old request resumed before enqueue cannot replace a newer generation's singleflight ownership.");
        cache.finishPendingGeneration(oldVersion);
        const bool retained = cache.pendingGenerations.count(currentVersion.key) != 0;
        cache.finishPendingGeneration(currentVersion);
        check("peak_cache_old_job_cannot_erase_new_pending_owner", retained
            && cache.pendingGenerations.count(currentVersion.key) == 0,
            "Completing an old generation retains the newer generation's singleflight ownership; its own completion releases it.");

        juce::TemporaryFile changedStage(sidecar);
        const bool changedStaged = PeakCache::writeStagedFile(changedStage.getFile(), *freshEntry,
            currentVersion.size, currentVersion.modified);
        ready = ready && writeSource(audio, 0.75f, 4096);
        const bool sourceChanged = audio.getSize() != currentVersion.size
            || audio.getLastModificationTime().toMilliseconds() != currentVersion.modified;
        const bool identityRejected = !cache.publishGeneratedEntry(audio, currentVersion,
            freshEntry, changedStage, changedStaged);
        // loadFileAsData appends; each independent sidecar snapshot must start
        // with a fresh block rather than reusing the prior assertion's bytes.
        juce::MemoryBlock afterChanged;
        const bool sidecarRead = sidecar.loadFileAsData(afterChanged);
        const bool sidecarUnchanged = before == afterChanged;
        check("peak_cache_changed_source_identity_rejects_staging", ready && changedStaged
            && sourceChanged && identityRejected && sidecarRead && sidecarUnchanged,
            "A size/mtime change during scanning or staging prevents old peak data from being relabeled or replacing the sidecar without an explicit invalidation.");
        auto* identityDiagnostic = new juce::DynamicObject();
        identityDiagnostic->setProperty("ready", ready);
        identityDiagnostic->setProperty("changedStaged", changedStaged);
        identityDiagnostic->setProperty("sourceChanged", sourceChanged);
        identityDiagnostic->setProperty("identityRejected", identityRejected);
        identityDiagnostic->setProperty("sidecarRead", sidecarRead);
        identityDiagnostic->setProperty("sidecarUnchanged", sidecarUnchanged);
        identityDiagnostic->setProperty("beforeBytes", static_cast<juce::int64>(before.getSize()));
        identityDiagnostic->setProperty("afterBytes", static_cast<juce::int64>(afterChanged.getSize()));
        identityDiagnostic->setProperty("sourceSizeBefore", currentVersion.size);
        identityDiagnostic->setProperty("sourceSizeAfter", audio.getSize());
        checks.getLast().getDynamicObject()->setProperty("diagnostic", juce::var(identityDiagnostic));

        cache.invalidate(audio);
        ready = ready && cache.generateSync(audio);
        const auto edgeVersion = cache.captureSourceVersion(audio);
        ready = ready && peakEquals(cache.getPeaks(audio, 64, 0, 1, 1, 2047), 0.75f);
        const auto oldEdges = cache.boundaryPeaks;
        cache.invalidate(audio);
        ready = ready && writeSource(audio, 0.5f, 4096)
            && audio.setLastModificationTime(juce::Time(edgeVersion.modified)) && cache.generateSync(audio);
        // Model an old edge worker resuming after the new generation cleared
        // the edge table. Runtime generation is part of its immutable key.
        cache.boundaryPeaks.insert(oldEdges.begin(), oldEdges.end());
        check("peak_cache_old_edge_publication_is_generation_isolated", ready
            && peakEquals(cache.getPeaks(audio, 64, 0, 1, 1, 2047), 0.5f),
            "Late clipped-edge aggregates from a prior generation cannot be reused, including same-size sources with restored modification time.");
        cache.invalidate(audio);
        auto* report = new juce::DynamicObject();
        report->setProperty("checks", checks);
        report->setProperty("scope", "Deterministic production publication interleavings; no timed races, generation-job scheduling, hardware or audio-quality assertion.");
        return juce::var(report);
    }
};

juce::var runPeakCacheGenerationRegression(const juce::File& outputDirectory)
{
    const auto report = PeakCacheGenerationRegressionAccess::run();
    if (outputDirectory.isDirectory())
        outputDirectory.getChildFile("peak-cache-generation-regression.json")
            .replaceWithText(juce::JSON::toString(report, true));
    return report;
}
