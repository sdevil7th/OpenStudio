#include "AudioFileConversionRegression.h"
#include "AudioFileConversion.h"
#include "FFmpegLocator.h"
#include "OwnedChildProcess.h"
#include "ProjectRateCopy.h"
#include "PlaybackEngine.h"
#include <cmath>

namespace
{
bool writeFixture(const juce::File& path, int rate, int channels, int length, double frequency)
{
    juce::WavAudioFormat format;
    std::unique_ptr<juce::OutputStream> stream = path.createOutputStream();
    auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
        .withSampleRate(rate).withNumChannels(channels).withBitsPerSample(24));
    if (!writer) return false;
    juce::AudioBuffer<float> samples(channels, length);
    for (int channel = 0; channel < channels; ++channel)
        for (int sample = 0; sample < length; ++sample)
            samples.setSample(channel, sample, static_cast<float>((channel == 0 ? 0.25 : -0.125)
                * std::sin(juce::MathConstants<double>::twoPi * frequency * sample / rate)));
    return writer->writeFromAudioSampleBuffer(samples, 0, length) && writer->flush();
}
std::unique_ptr<juce::AudioFormatReader> openFixture(const juce::File& file)
{
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    return std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(file));
}

juce::Result convertFixture(const juce::File& source, const juce::File& destination,
                            const AudioFileConversion::Options& options,
                            const std::function<bool()>& keepRunning)
{
    const auto result = AudioFileConversion::convert(source, destination, options, keepRunning);
    if (result.failed())
        juce::Logger::writeToLog("Audio conversion fixture " + source.getFileName() + " -> "
            + destination.getFileName() + ": " + result.getErrorMessage());
    return result;
}
}

void runAudioFileConversionRegression(const juce::File& root, const std::function<void(const char*, bool)>& check)
{
   #if !JUCE_WINDOWS
    // Exercise the actual POSIX pipe on a quiet long-lived child; FFmpeg normally
    // writes no diagnostics on success. Neither the read nor timeout may wait for EOF.
    {
        OwnedChildProcess quiet;
        const bool started = quiet.start({ "/bin/sh", "-c", "sleep 30" });
        char bytes[4096];
        const auto before = juce::Time::getMillisecondCounterHiRes();
        const auto count = quiet.readProcessOutput(bytes, sizeof(bytes));
        check("posix_quiet_child_read_is_nonblocking", started && count == 0
            && juce::Time::getMillisecondCounterHiRes() - before < 100.0);
        std::atomic<bool> keepRunning { true };
        check("posix_quiet_child_timeout_terminates_group", !quiet.waitForProcessToFinish(50, keepRunning)
            && juce::Time::getMillisecondCounterHiRes() - before < 2000.0);
    }
    {
        OwnedChildProcess quiet;
        const bool started = quiet.start({ "/bin/sh", "-c", "sleep 30" });
        std::atomic<bool> keepRunning { false };
        const auto before = juce::Time::getMillisecondCounterHiRes();
        check("posix_quiet_child_cancellation_is_bounded", started && !quiet.waitForProcessToFinish(30000, keepRunning)
            && juce::Time::getMillisecondCounterHiRes() - before < 2000.0);
    }
   #endif
    const auto directory = root.getChildFile("conversion");
    directory.createDirectory();
    const auto ffmpeg = OpenStudioFFmpeg::findExecutable();
    check("converter_ffmpeg_runtime_available", ffmpeg.existsAsFile());
    juce::Logger::writeToLog("Audio conversion fixture FFmpeg: "
        + (ffmpeg.existsAsFile() ? ffmpeg.getFullPathName() : "not found in the bundle or PATH"));
    const auto alive = [] { return true; };
    AudioFileConversion::Options options;
    options.bitDepth = 24;
    bool ratesPass = true, pitchPass = true;
    for (const int sourceRate : { 44100, 48000, 96000 })
    {
        const auto source = directory.getChildFile("source-" + juce::String(sourceRate) + ".wav");
        ratesPass = writeFixture(source, sourceRate, 1, sourceRate / 5, 1000) && ratesPass;
        for (const int outputRate : { 44100, 48000, 96000 })
        {
            options.sampleRate = outputRate;
            const auto output = directory.getChildFile(juce::String(sourceRate) + "-" + juce::String(outputRate) + ".wav");
            const auto result = convertFixture(source, output, options, alive);
            auto reader = openFixture(output);
            ratesPass = result.wasOk() && reader && reader->sampleRate == outputRate
                && reader->lengthInSamples == outputRate / 5 && ratesPass;
            if (!reader) { pitchPass = false; continue; }
            juce::AudioBuffer<float> samples(1, static_cast<int>(reader->lengthInSamples));
            pitchPass = reader->read(&samples, 0, samples.getNumSamples(), 0, true, false) && pitchPass;
            double error = 0;
            for (int i = 256; i < samples.getNumSamples() - 256; ++i)
            {
                const auto expected = 0.25 * std::sin(juce::MathConstants<double>::twoPi * 1000 * i / outputRate);
                error = juce::jmax(error, std::abs(expected - samples.getSample(0, i)));
            }
            pitchPass = error < 0.0001 && pitchPass;
        }
    }
    check("converter_all_44100_48000_96000_rate_pairs_preserve_duration", ratesPass);
    check("converter_rate_changes_preserve_1khz_frequency_and_amplitude", pitchPass);
    const auto stereo = directory.getChildFile("stereo.wav");
    check("converter_stereo_fixture_written", writeFixture(stereo, 48000, 2, 9600, 1000));
    options.sampleRate = 48000;
    const auto same = directory.getChildFile("same.wav");
    bool parity = convertFixture(stereo, same, options, alive).wasOk();
    auto original = openFixture(stereo);
    auto copied = openFixture(same);
    if (original && copied)
    {
        juce::AudioBuffer<float> a(2, 9600), b(2, 9600);
        parity = original->read(&a, 0, 9600, 0, true, true) && copied->read(&b, 0, 9600, 0, true, true) && parity;
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < 9600; ++sample)
                parity = a.getSample(channel, sample) == b.getSample(channel, sample) && parity;
    }
    else parity = false;
    check("converter_same_rate_same_depth_sample_parity", parity);
    options.channels = 1;
    const auto mono = directory.getChildFile("mono.wav");
    bool monoPass = convertFixture(stereo, mono, options, alive).wasOk();
    auto downmix = openFixture(mono);
    if (downmix)
    {
        juce::AudioBuffer<float> samples(1, 9600);
        monoPass = downmix->numChannels == 1 && downmix->read(&samples, 0, 9600, 0, true, false) && monoPass;
        for (int sample = 0; sample < 9600; ++sample)
            monoPass = std::abs(samples.getSample(0, sample) - 0.0625
                * std::sin(juce::MathConstants<double>::twoPi * 1000 * sample / 48000)) < 0.000001 && monoPass;
    }
    else monoPass = false;
    check("converter_stereo_to_mono_uses_explicit_average", monoPass);
    options.channels = 2;
    const auto duplicated = directory.getChildFile("duplicated.wav");
    bool stereoPass = convertFixture(mono, duplicated, options, alive).wasOk();
    auto upmix = openFixture(duplicated);
    if (upmix)
    {
        juce::AudioBuffer<float> samples(2, 9600);
        stereoPass = upmix->numChannels == 2 && upmix->read(&samples, 0, 9600, 0, true, true) && stereoPass;
        for (int sample = 0; sample < 9600; ++sample)
            stereoPass = samples.getSample(0, sample) == samples.getSample(1, sample) && stereoPass;
    }
    else stereoPass = false;
    check("converter_mono_to_stereo_duplicates_without_gain_change", stereoPass);
    options.channels = 0;
    const auto high = directory.getChildFile("above-nyquist.wav");
    writeFixture(high, 96000, 1, 19200, 30000);
    options.sampleRate = 44100;
    const auto filtered = directory.getChildFile("filtered.wav");
    bool aliasPass = convertFixture(high, filtered, options, alive).wasOk();
    auto filteredReader = openFixture(filtered);
    if (filteredReader)
    {
        juce::AudioBuffer<float> samples(1, 8820);
        aliasPass = filteredReader->read(&samples, 0, 8820, 0, true, false)
            && samples.getRMSLevel(0, 256, 8308) < 0.0001f && aliasPass;
    }
    else aliasPass = false;
    check("converter_downsampling_rejects_above_nyquist_signal", aliasPass);
    bool shortPass = true;
    for (const int length : { 1, 2, 17, 63 })
    {
        const auto source = directory.getChildFile("short-" + juce::String(length) + ".wav");
        const auto output = directory.getChildFile("short-out-" + juce::String(length) + ".wav");
        writeFixture(source, 48000, 1, length, 1000);
        shortPass = convertFixture(source, output, options, alive).wasOk() && shortPass;
        auto reader = openFixture(output);
        shortPass = reader && reader->lengthInSamples == std::llround(length * 44100.0 / 48000) && shortPass;
    }
    check("converter_sub_filter_window_files_have_exact_length", shortPass);
    bool formatsPass = true;
    for (const auto* format : { "wav", "aiff", "flac" })
    {
        options.format = format;
        const auto output = directory.getChildFile(juce::String("format.") + format);
        formatsPass = convertFixture(stereo, output, options, alive).wasOk() && formatsPass;
    }
    check("converter_wav_aiff_flac_are_finalized_and_readable", formatsPass);
    options.format = "wav";
    const auto protectedOutput = directory.getChildFile("preserve.wav");
    check("converter_pre_cancel_preserves_existing_destination",
        protectedOutput.replaceWithText("existing destination")
        && AudioFileConversion::convert(stereo, protectedOutput, options, [] { return false; }).failed()
        && protectedOutput.loadFileAsString() == "existing destination");
    int cancellationChecks = 0;
    check("converter_running_child_cancel_preserves_existing_destination",
        protectedOutput.replaceWithText("existing destination")
        && AudioFileConversion::convert(stereo, protectedOutput, options, [&] { return ++cancellationChecks < 3; }).failed()
        && protectedOutput.loadFileAsString() == "existing destination");
    options.timeoutMs = 1;
    const auto timeoutDirectory = directory.getChildFile("timeout");
    const auto timeoutOutput = timeoutDirectory.getChildFile("preserve.wav");
    const bool timeoutReady = timeoutDirectory.createDirectory().wasOk()
        && timeoutOutput.replaceWithText("existing destination");
    bool delayedAfterStaging = false;
    const auto allowConversion = [&] {
        // Keep a real FFmpeg child and the strict deadline. If it finishes too
        // quickly to hit a polling timeout, expire the budget at the observable
        // staging checkpoint. This needs neither a callback-count assumption
        // nor a production clock/process override.
        if (!delayedAfterStaging && timeoutDirectory.getNumberOfChildFiles(juce::File::findFiles) > 1)
        {
            delayedAfterStaging = true;
            juce::Thread::sleep(10);
        }
        return true;
    };
    const auto timeoutResult = AudioFileConversion::convert(stereo, timeoutOutput, options, allowConversion);
    check("converter_timeout_preserves_existing_destination",
        timeoutReady && timeoutResult.failed() && timeoutOutput.loadFileAsString() == "existing destination"
        && timeoutDirectory.getNumberOfChildFiles(juce::File::findFiles) == 1);
    options.timeoutMs = 30000;
    options.sampleRate = -1;
    check("converter_invalid_rate_rejected_before_publication",
        protectedOutput.replaceWithText("existing destination")
        && AudioFileConversion::convert(stereo, protectedOutput, options, alive).failed()
        && protectedOutput.loadFileAsString() == "existing destination");
    options.sampleRate = 48000;
    check("converter_unwritable_destination_is_reported",
        AudioFileConversion::convert(stereo, directory, options, alive).failed());
    check("converter_invalid_input_preserves_destination",
        protectedOutput.replaceWithText("existing destination")
        && AudioFileConversion::convert(protectedOutput, same, options, alive).failed() && openFixture(same) != nullptr);

    const auto cache = directory.getChildFile("rate-copy-cache");
    const auto sourceHash = juce::SHA256(stereo).toHexString();
    const auto rateCopy = ProjectRateCopy::create(stereo, cache, 44100, alive);
    const auto cachedCopy = ProjectRateCopy::create(stereo, cache, 44100, alive);
    const juce::File convertedFile(rateCopy["filePath"].toString());
    auto rateReader = openFixture(convertedFile);
    check("project_rate_copy_float32_channels_duration", static_cast<bool>(rateCopy["success"]) && rateReader
        && rateReader->sampleRate == 44100 && rateReader->numChannels == 2 && rateReader->lengthInSamples == 8820
        && rateReader->bitsPerSample == 32 && rateReader->usesFloatingPointData);
    check("project_rate_copy_content_cache_preserves_original", static_cast<bool>(cachedCopy["success"])
        && static_cast<bool>(cachedCopy["cacheHit"]) && cachedCopy["filePath"] == rateCopy["filePath"]
        && juce::SHA256(stereo).toHexString() == sourceHash);
    // Final SHA256-named files fit below MAX_PATH, while the former nested
    // basename-derived staging paths exceed it. Keep that boundary covered.
    const auto longCache = directory.getChildFile(juce::String::repeatedString("p",
        juce::jmax(1, 180 - directory.getFullPathName().length() - 1)));
    const auto longPathCopy = ProjectRateCopy::create(stereo, longCache, 44100, alive);
    const auto longPathHit = ProjectRateCopy::create(stereo, longCache, 44100, alive);
    auto longPathReader = openFixture(juce::File(longPathCopy["filePath"].toString()));
    check("project_rate_copy_long_project_path_has_short_atomic_staging",
        static_cast<bool>(longPathCopy["success"]) && static_cast<bool>(longPathHit["cacheHit"])
        && longPathReader && longPathReader->lengthInSamples == 8820
        && longCache.getNumberOfChildFiles(juce::File::findFiles) == 2
        && juce::SHA256(stereo).toHexString() == sourceHash);
    const auto back = ProjectRateCopy::create(convertedFile, cache, 48000, alive);
    auto backReader = openFixture(juce::File(back["filePath"].toString()));
    bool roundtripPitch = static_cast<bool>(back["success"]) && backReader && backReader->lengthInSamples == 9600 && backReader->numChannels == 2;
    if (backReader)
    {
        juce::AudioBuffer<float> audio(2, 9600);
        roundtripPitch = backReader->read(&audio, 0, 9600, 0, true, true) && roundtripPitch;
        for (int sample = 256; sample < 9344; ++sample)
            roundtripPitch = std::abs(audio.getSample(0, sample) - 0.25 * std::sin(juce::MathConstants<double>::twoPi * 1000 * sample / 48000)) < 0.0001 && roundtripPitch;
    }
    check("project_rate_copy_48000_44100_48000_pitch_duration", roundtripPitch);
    const auto changedSource = directory.getChildFile("identity-source.wav");
    const bool firstIdentityWritten = writeFixture(changedSource, 48000, 1, 9600, 1000);
    const auto firstIdentity = ProjectRateCopy::create(changedSource, cache, 44100, alive);
    const auto unchangedTime = changedSource.getLastModificationTime();
    const bool secondIdentityWritten = writeFixture(changedSource, 48000, 1, 9600, 2000);
    changedSource.setLastModificationTime(unchangedTime);
    const auto secondIdentity = ProjectRateCopy::create(changedSource, cache, 44100, alive);
    check("project_rate_copy_identity_includes_source_content", firstIdentityWritten && secondIdentityWritten
        && static_cast<bool>(firstIdentity["success"]) && static_cast<bool>(secondIdentity["success"])
        && firstIdentity["filePath"] != secondIdentity["filePath"]);
    const auto cancelledCopy = ProjectRateCopy::create(stereo, cache, 44100, [] { return false; });
    check("project_rate_copy_cancelled_job_never_publishes_clip", !static_cast<bool>(cancelledCopy["success"])
        && static_cast<bool>(cancelledCopy["cancelled"]) && juce::SHA256(stereo).toHexString() == sourceHash);

    PlaybackEngine sourceRoute; sourceRoute.setOfflineSourceReads(true);
    sourceRoute.addClip(stereo, 12.3, 0.1, "conversion-track", 0.05, -3.0, 0.01, 0.02, "conversion-clip", stereo, 0.05, 1, 2);
    sourceRoute.setClipGainEnvelope("conversion-track", "conversion-clip", { { 0, 0.5f }, { 0.1, 0.75f } });
    const bool routeApplied = static_cast<bool>(rateCopy["success"]) && sourceRoute.replaceClipSourcePreservingTimeline(
        "conversion-track", "conversion-clip", stereo, convertedFile, convertedFile, 0.05, alive);
    const auto routeAfter = sourceRoute.getClipSnapshot();
    check("project_rate_copy_atomic_route_preserves_trim_gain_fades", routeApplied && routeAfter.size() == 1
        && routeAfter[0].audioFile == convertedFile && routeAfter[0].originalAudioFile == convertedFile
        && routeAfter[0].offset == 0.05 && routeAfter[0].originalOffset == 0.05 && routeAfter[0].startTime == 12.3
        && routeAfter[0].duration == 0.1 && routeAfter[0].volumeDB == -3 && routeAfter[0].fadeInCurve == 1
        && routeAfter[0].fadeOutCurve == 2 && routeAfter[0].gainEnvelope.size() == 2);
    const bool staleRejected = !sourceRoute.replaceClipSourcePreservingTimeline("conversion-track", "conversion-clip", stereo, stereo, stereo, 0.05, alive);
    const bool restoredRoute = sourceRoute.replaceClipSourcePreservingTimeline("conversion-track", "conversion-clip", convertedFile, stereo, stereo, 0.05, alive);
    check("project_rate_copy_route_undo_and_stale_compare_swap", staleRejected && restoredRoute
        && sourceRoute.getClipSnapshot()[0].audioFile == stereo && sourceRoute.getClipSnapshot()[0].offset == 0.05);
    const bool projectReloadRejected = !sourceRoute.replaceClipSourcePreservingTimeline("conversion-track", "conversion-clip", stereo, convertedFile, convertedFile, 0.05, alive, [&]() {
        sourceRoute.clearAllClips(); sourceRoute.addClip(stereo, 0, 0.1, "conversion-track", 0, 0, 0, 0, "conversion-clip");
        return std::static_pointer_cast<void>(std::make_shared<int>(1));
    });
    check("project_rate_copy_reopened_identity_cannot_receive_stale_source", projectReloadRejected && sourceRoute.getClipSnapshot()[0].audioFile == stereo);

    PlaybackEngine envelopeRoute; envelopeRoute.setOfflineSourceReads(true);
    envelopeRoute.addClip(stereo, 0, 0.2, "envelope-track", 0, 0, 0, 0, "envelope-clip");
    std::vector<PlaybackEngine::GainEnvelopePoint> envelope;
    for (int point = 4095; point >= 0; --point) envelope.push_back({ point * 0.2 / 4095.0, 0.25f + 0.5f * static_cast<float>(point) / 4095.0f });
    envelopeRoute.setClipGainEnvelope("envelope-track", "envelope-clip", envelope);
    juce::AudioBuffer<float> envelopeAudio(2, 4096); envelopeAudio.clear();
    envelopeRoute.fillTrackBuffer("envelope-track", envelopeAudio, 0, 4096, 48000);
    double envelopeError = 0.0;
    for (int sample = 0; sample < 4096; ++sample)
    {
        const double expected = 0.25 * std::sin(juce::MathConstants<double>::twoPi * 1000 * sample / 48000)
            * (0.25 + 0.5 * (sample / 48000.0) / 0.2);
        envelopeError = juce::jmax(envelopeError, std::abs(envelopeAudio.getSample(0, sample) - expected));
    }
    check("large_sorted_gain_envelope_binary_lookup_audio_parity", envelopeError < 1.0e-6);

    const auto impulseSource = directory.getChildFile("float-overunity-impulse.wav");
    juce::WavAudioFormat impulseFormat;
    std::unique_ptr<juce::OutputStream> impulseStream = impulseSource.createOutputStream();
    auto impulseWriter = impulseFormat.createWriterFor(impulseStream, juce::AudioFormatWriterOptions()
        .withSampleRate(48000).withNumChannels(2).withBitsPerSample(32));
    juce::AudioBuffer<float> impulse(2, 1024); impulse.clear();
    impulse.setSample(0, 800, 1.5f); impulse.setSample(1, 800, -0.75f);
    bool impulsePass = impulseWriter && impulseWriter->writeFromAudioSampleBuffer(impulse, 0, 1024) && impulseWriter->flush();
    impulseWriter.reset();
    const auto impulseConverted = ProjectRateCopy::create(impulseSource, cache, 44100, alive);
    auto impulseReader = openFixture(juce::File(impulseConverted["filePath"].toString()));
    if (impulseReader)
    {
        juce::AudioBuffer<float> convertedImpulse(2, static_cast<int>(impulseReader->lengthInSamples));
        impulsePass = impulseReader->read(&convertedImpulse, 0, convertedImpulse.getNumSamples(), 0, true, true) && impulsePass;
        int peakSample = 0; float peakValue = 0;
        for (int sample = 0; sample < convertedImpulse.getNumSamples(); ++sample)
        {
            const float value = std::abs(convertedImpulse.getSample(0, sample));
            if (value > peakValue) { peakValue = value; peakSample = sample; }
            impulsePass = std::abs(convertedImpulse.getSample(1, sample) + 0.5f * convertedImpulse.getSample(0, sample)) < 1.0e-6f && impulsePass;
        }
        impulsePass = peakValue > 1.0f && std::abs(peakSample - 735) <= 1 && impulsePass;
    }
    else impulsePass = false;
    check("project_rate_copy_impulse_timing_float_headroom_and_channel_phase", impulsePass && static_cast<bool>(impulseConverted["success"]));
    auto* diagnostics = new juce::DynamicObject();
    diagnostics->setProperty("firstCopy", rateCopy); diagnostics->setProperty("cachedCopy", cachedCopy);
    diagnostics->setProperty("roundtripCopy", back); diagnostics->setProperty("longPathCopy", longPathCopy);
    diagnostics->setProperty("longPathCacheDirectoryCharacters", longCache.getFullPathName().length());
    directory.getChildFile("project-rate-copy-regression.json").replaceWithText(juce::JSON::toString(juce::var(diagnostics), true));
}
