#include "PlaybackTinyBlockRegression.h"
#include "PlaybackEngine.h"
#include <cmath>

namespace {
constexpr int frames = 8192;
constexpr double rate = 48000.0;
float value(int channel, int frame)
{
    return frame >= 0 && frame < frames
        ? static_cast<float>((frame % 127) - 63) / 128.0f * (channel == 0 ? 1.0f : -0.5f)
        : 0.0f;
}
float cubic(int channel, double position)
{
    position = juce::jlimit(0.0, static_cast<double>(frames - 1), position);
    const int centre = static_cast<int>(std::floor(position));
    const auto at = [&](int offset) { return value(channel, juce::jlimit(0, frames - 1, centre + offset)); };
    const float t = static_cast<float>(position - centre), t2 = t * t, t3 = t2 * t;
    return 0.5f * ((2.0f * at(0)) + (-at(-1) + at(1)) * t
        + (2.0f * at(-1) - 5.0f * at(0) + 4.0f * at(1) - at(2)) * t2
        + (-at(-1) + 3.0f * at(0) - 3.0f * at(1) + at(2)) * t3);
}
bool matches(PlaybackEngine& engine, const juce::String& track, double time,
             const std::function<float(int, int)>& expected, bool mono = false,
             double deviceRate = rate)
{
    juce::AudioBuffer<float> block(2, 8); block.clear();
    engine.fillTrackBuffer(track, block, time, 8, deviceRate, mono);
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = 0; sample < 8; ++sample)
            if (std::abs(block.getSample(channel, sample) - expected(channel, sample)) > 1.0e-7f) return false;
    return true;
}
}

void runPlaybackTinyBlockRegression(const juce::File& directory,
    const std::function<void(const char*, bool)>& check)
{
    // Exercise both null and owned storage after the pinned HeapBlock guard.
    juce::HeapBlock<int> empty;
    empty.free(); empty.free();
    juce::HeapBlock<int> owned(8);
    owned[0] = 42;
    juce::HeapBlock<int> moved(std::move(owned));
    bool ownership = owned.getData() == nullptr && moved[0] == 42;
    owned.free(); moved.free(); moved.free();
    ownership &= empty.getData() == nullptr && moved.getData() == nullptr;
    check("realtime_heap_guard_preserves_empty_owned_and_moved_lifetimes", ownership);
    bool viewParity = true;
    for (const int channels : { 1, 2, 64 })
    {
        juce::AudioBuffer<float> storage(channels, 16);
        storage.clear();
        for (int repeat = 0; repeat < 32; ++repeat)
        {
            juce::AudioBuffer<float> view(storage.getArrayOfWritePointers(), channels, 8);
            view.setSample(channels - 1, 0, static_cast<float>(repeat));
            view.setDataToReferTo(storage.getArrayOfWritePointers(), channels, 8, 8);
            view.setSample(channels - 1, 0, static_cast<float>(repeat + 1));
        }
        juce::AudioBuffer<float> copy;
        copy.makeCopyOf(storage);
        storage.clear();
        viewParity &= copy.getSample(channels - 1, 0) == 31.0f
            && copy.getSample(channels - 1, 8) == 32.0f;
    }
    check("realtime_buffer_view_rebind_lifetime_and_owned_copy_parity", viewParity);
    const auto boundary = PlaybackEngine::runSampleBoundaryRegression();
    check("tiny_block_sample_boundary_exact_finite_parity", static_cast<bool>(boundary["exactFiniteParity"]));
    check("tiny_block_sample_boundary_benchmark_preserves_work", static_cast<bool>(boundary["matchingNonzeroChecksums"]));
    directory.getChildFile("sample-boundary-benchmark.json").replaceWithText(juce::JSON::toString(boundary, true));
    const auto fixture = directory.getChildFile("tiny-block-stereo.wav");
    juce::AudioBuffer<float> source(2, frames);
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = 0; sample < frames; ++sample) source.setSample(channel, sample, value(channel, sample));
    bool ready = false;
    {
        auto fileStream = fixture.createOutputStream();
        if (fileStream != nullptr)
        {
            fileStream->setPosition(0); fileStream->truncate();
            std::unique_ptr<juce::OutputStream> stream = std::move(fileStream);
            juce::WavAudioFormat format;
            auto writer = format.createWriterFor(stream,
                juce::AudioFormatWriterOptions{}.withSampleRate(rate).withNumChannels(2).withBitsPerSample(24));
            ready = writer != nullptr && writer->writeFromAudioSampleBuffer(source, 0, frames);
        }
    }
    check("tiny_block_fixture_written", ready);
    if (!ready) return;
    PlaybackEngine engine; engine.setOfflineSourceReads(true);
    const auto add = [&](const juce::String& track, const juce::String& id, double offset = 0.0,
                         double gain = 0.0, double fade = 0.0)
    {
        engine.addClip(fixture, 0.0, frames / rate - offset, track, offset, gain, fade, 0.0, id);
    };
    add("a", "a1"); add("b", "b1");
    bool preparedKeyParity = true;
    const auto preparedKey = PlaybackEngine::prepareTrackContinuityKey("a");
    for (const int frame : { 0, 8, 16, 2048, 2056, 31, frames - 8 })
    {
        juce::AudioBuffer<float> block(2, 8); block.clear();
        engine.fillTrackBuffer("a", block, frame / rate, 8, rate, false, preparedKey);
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < 8; ++sample)
                preparedKeyParity &= block.getSample(channel, sample) == value(channel, frame + sample);
    }
    check("prepared_track_key_preserves_tiny_block_pcm_and_seek_continuity", preparedKeyParity);
    bool exact = true;
    for (const int frame : { 0, 8, 31, 510, frames - 8 })
        exact &= matches(engine, "a", frame / rate,
            [frame](int channel, int sample) { return value(channel, frame + sample); });
    check("tiny_block_integer_cursor_exact_pcm_seek_and_eof", exact);
    check("tiny_block_integer_cursor_mono_fold",
        matches(engine, "a", 31.0 / rate, [](int, int sample) {
            return 0.5f * (value(0, 31 + sample) + value(1, 31 + sample)); }, true));
    add("fractional", "frac", 0.25 / rate);
    const bool fractional = matches(engine, "fractional", 31.0 / rate,
        [](int channel, int sample) { return cubic(channel, 31.25 + sample); });
    const bool conversion = matches(engine, "a", 31.0 / rate,
        [](int channel, int sample) { return cubic(channel, 31.0 + sample * rate / 44100.0); }, false, 44100.0);
    check("tiny_block_fractional_and_rate_conversion_preserve_cubic", fractional && conversion);
    add("gain", "gain", 0.0, -6.0, 0.01);
    check("tiny_block_fades_and_prepared_gain_preserved", matches(engine, "gain", 31.0 / rate,
        [](int channel, int sample) { return value(channel, 31 + sample)
            * juce::Decibels::decibelsToGain(-6.0f) * static_cast<float>((31.0 + sample) / rate / 0.01); }));
    engine.removeClipById("a", "a1");
    const auto silence = [](int, int) { return 0.0f; };
    const auto pcm = [](int channel, int sample) { return value(channel, 31 + sample); };
    bool mutations = matches(engine, "a", 31.0 / rate, silence)
        && matches(engine, "b", 31.0 / rate, pcm);
    add("a", "a2"); engine.removeClip("b", fixture.getFullPathName());
    mutations &= matches(engine, "b", 31.0 / rate, silence) && matches(engine, "a", 31.0 / rate, pcm);
    const auto snapshots = engine.getClipSnapshot(); engine.clearTrackClips("a");
    mutations &= matches(engine, "a", 31.0 / rate, silence);
    for (const auto& snapshot : snapshots) if (snapshot.trackId == "a") engine.addClipFromSnapshot(snapshot);
    mutations &= matches(engine, "a", 31.0 / rate, pcm);
    engine.clearAllClips();
    mutations &= matches(engine, "a", 31.0 / rate, silence);
    add("after-clear", "last");
    mutations &= matches(engine, "after-clear", 31.0 / rate, pcm);
    check("tiny_block_track_index_insert_erase_clear_and_snapshot_restore", mutations);
    // Exceeds the old callback scratch reserve (64 boundaries). Each prepared
    // segment references the same PCM at its original position.
    bool segmentsReady = true;
    for (int segment = 0; segment < 40; ++segment)
    {
        // Keep windows farther apart than preview replacement's 1 ms tolerance.
        const double start = segment * 128.0 / rate, end = (segment * 128.0 + 64.0) / rate;
        segmentsReady &= engine.setClipRenderedPreviewSegment("last", fixture, start, end, start);
    }
    const auto previewSnapshot = engine.getRenderedPreviewSegmentSnapshot();
    const auto preparedSegments = previewSnapshot.find("last");
    segmentsReady &= preparedSegments != previewSnapshot.end() && preparedSegments->second.size() == 40;
    const int reservesBefore = engine.getChunkBoundaryReserveCount();
    bool segmentParity = segmentsReady;
    for (int frame = 0; frame < 5120; frame += 8)
        segmentParity &= matches(engine, "after-clear", frame / rate,
            [frame](int channel, int sample) { return value(channel, frame + sample); });
    check("tiny_block_many_preview_segments_preserve_pcm", segmentParity);
    check("tiny_block_many_preview_segments_need_no_callback_reserve",
        segmentsReady && engine.getChunkBoundaryReserveCount() == reservesBefore);

    const auto replacement = directory.getChildFile("tiny-block-replacement.wav");
    source.applyGain(-0.25f);
    bool replacementReady = false;
    {
        auto fileStream = replacement.createOutputStream();
        if (fileStream != nullptr)
        {
            fileStream->setPosition(0); fileStream->truncate();
            std::unique_ptr<juce::OutputStream> stream = std::move(fileStream);
            juce::WavAudioFormat format;
            auto writer = format.createWriterFor(stream,
                juce::AudioFormatWriterOptions{}.withSampleRate(rate).withNumChannels(2).withBitsPerSample(24));
            replacementReady = writer != nullptr && writer->writeFromAudioSampleBuffer(source, 0, frames);
        }
    }
    check("prepared_source_replacement_fixture_written", replacementReady);
    if (!replacementReady) return;

    bool steadyBindings = true, replacementParity = true, previewParity = true, reloadParity = true;
    for (const bool offline : { false, true })
    {
        PlaybackEngine probe; probe.setOfflineSourceReads(offline);
        probe.addClip(fixture, 0, frames / rate, "binding", 0, 0, 0, 0, "binding-clip");
        steadyBindings &= matches(probe, "binding", 31.0 / rate, pcm);
        const auto warmResolutions = probe.getSourceBindingResolutionCount();
        for (int block = 0; block < 128; ++block)
        {
            const int frame = 64 + block * 8;
            steadyBindings &= matches(probe, "binding", frame / rate,
                [frame](int channel, int sample) { return value(channel, frame + sample); });
        }
        steadyBindings &= warmResolutions > 0 && warmResolutions == probe.getSourceBindingResolutionCount();
        const auto replacedPCM = [](int channel, int sample) { return -0.25f * value(channel, 31 + sample); };
        probe.replaceClipAudioFile("binding-clip", replacement);
        replacementParity &= matches(probe, "binding", 31.0 / rate, replacedPCM);
        // Restore an already cached key: no reader publication invalidates the
        // global generation here, so the clip itself must reset its binding.
        probe.replaceClipAudioFile("binding-clip", fixture);
        replacementParity &= matches(probe, "binding", 31.0 / rate, pcm);
        replacementParity &= probe.replaceClipSourcePreservingTimeline("binding", "binding-clip",
            fixture, replacement, fixture, 0.0);
        replacementParity &= matches(probe, "binding", 31.0 / rate, replacedPCM);
        replacementParity &= probe.replaceClipSourcePreservingTimeline("binding", "binding-clip",
            replacement, fixture, fixture, 0.0);
        replacementParity &= matches(probe, "binding", 31.0 / rate, pcm);

        previewParity &= probe.setClipRenderedPreviewSegment("binding-clip", replacement, 0.0, 0.1);
        previewParity &= matches(probe, "binding", 31.0 / rate, replacedPCM);
        // The preview survives a clear/re-add. Its old reader/decoded pointers
        // have been destroyed and must never be dereferenced after the reload.
        probe.clearAllClips();
        probe.addClip(fixture, 0, frames / rate, "binding", 0, 0, 0, 0, "binding-clip");
        reloadParity &= matches(probe, "binding", 31.0 / rate, replacedPCM);
        probe.clearClipRenderedPreviewSegments("binding-clip");
        reloadParity &= matches(probe, "binding", 31.0 / rate, pcm);
    }
    check("prepared_source_steady_tiny_blocks_reuse_resolved_readers", steadyBindings);
    check("prepared_source_replacement_and_cached_key_restore_exact_pcm", replacementParity);
    check("prepared_source_preview_uses_its_own_binding", previewParity);
    check("prepared_source_surviving_preview_rebinds_after_project_reload", reloadParity);
}
