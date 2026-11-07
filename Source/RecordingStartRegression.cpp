#include "AudioEngine.h"
#include "AudioDeviceConfigurationRegression.h"
#include <algorithm>
#include <cmath>

juce::var AudioEngine::runPreparedRecordingStartRegression(const juce::File& outputDirectory)
{
    auto* result = new juce::DynamicObject();
    juce::Array<juce::var> checks;
    const auto check = [&](const char* id, bool pass, const juce::String& detail) {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", id); item->setProperty("pass", pass); item->setProperty("detail", detail);
        checks.add(item);
    };
    auto engine = std::make_unique<AudioEngine>(DeviceStartup::offline);
    engine->setRealtimeTrackWorkerCount(0);
    AudioDeviceConfigurationRegression::Device device("Offline recording fixture", "Synthetic PCM",
        std::make_shared<AudioDeviceConfigurationRegression::OpenMode>(AudioDeviceConfigurationRegression::OpenMode::normal));
    device.open(juce::BigInteger(3), juce::BigInteger(3), 48000.0, 8);
    engine->audioDeviceAboutToStart(&device); // Simulated descriptor only; no manager/device registration.
    const auto trackId = engine->addTrack("prepared-recording-fixture", "audio");
    engine->setTrackInputChannels(trackId, 0, 2);
    engine->setTrackRecordArm(trackId, true);
    juce::AudioBuffer<float> input(2, 256), output(2, 256);
    input.clear(); input.setSample(0, 0, 0.5f); input.setSample(1, 0, -0.25f);
    const float* inputs[] { input.getReadPointer(0), input.getReadPointer(1) };
    float* outputs[] { output.getWritePointer(0), output.getWritePointer(1) };
    const auto callback = [&] {
        engine->audioDeviceIOCallbackWithContext(inputs, 2, outputs, 2, 8, {});
    };
    for (const double start : { 0.0, 17.25 })
    {
        const auto directory = outputDirectory.getChildFile(start == 0.0 ? "prepared-start-zero" : "prepared-start-nonzero");
        engine->setProbeRecordingDirectory(directory);
        engine->setTransportPosition(start);
        int guards = 0;
        bool accepted = false, positionHeld = true;
        engine->startPreparedRecordingAsync([&](bool success) { accepted = success; }, [&] {
            // On the second validity check the production writer is prepared,
            // but playback is still stopped. Simulate 85ms of callback traffic.
            if (++guards == 2)
                for (int block = 0; block < 512; ++block) { callback(); positionHeld &= engine->getTransportPosition() == start; }
            return true;
        });
        callback();
        engine->setTransportPlaying(false);
        engine->setTransportRecording(false);
        const auto completed = engine->getLastCompletedClips();
        juce::AudioFormatManager formats; formats.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader(completed.empty() ? nullptr : formats.createReaderFor(completed[0].file));
        juce::AudioBuffer<float> recorded(2, 8);
        const bool readable = reader && reader->read(&recorded, 0, 8, 0, true, true);
        const bool exactStart = accepted && guards == 2 && positionHeld && completed.size() == 1
            && completed[0].startTime == start && reader && reader->lengthInSamples == 8
            && std::abs(completed[0].duration * 48000.0 - 8.0) < 0.5;
        check(start == 0.0 ? "prepared_record_start_zero_no_missing_first_block" : "prepared_record_start_nonzero_no_stopped_capture",
              exactStart && readable && std::abs(recorded.getSample(0, 0) - 0.5f) <= 1.0f / 32768.0f
              && std::abs(recorded.getSample(1, 0) + 0.25f) <= 1.0f / 32768.0f,
              "Writers prepare with 512 stopped 8-frame callbacks; first actual 8-frame input block and exact sample-origin metadata survive.");
    }
    engine->setProbeRecordingDirectory(outputDirectory.getChildFile("prepared-start-cancelled"));
    engine->setTransportPosition(3.0);
    int guards = 0;
    bool cancelledAccepted = true;
    engine->startPreparedRecordingAsync([&](bool success) { cancelledAccepted = success; }, [&] { return ++guards != 2; });
    callback();
    const auto cancelledTakes = engine->getLastCompletedClips();
    check("prepared_record_start_cancel_discards_unstarted_capture",
          !cancelledAccepted && !engine->isTransportPlaying() && !engine->isTransportRecording()
          && engine->getTransportPosition() == 3.0
          && std::all_of(cancelledTakes.begin(), cancelledTakes.end(), [](const auto& take) { return take.duration == 0.0; }),
          "A superseded request after writer preparation cannot start playback or capture stopped input.");

    engine->setProbeRecordingDirectory(outputDirectory.getChildFile("prepared-start-punch"));
    engine->setTransportPosition(8.0);
    engine->setTransportPlaying(true);
    callback();
    const double punchPosition = engine->getTransportPosition();
    bool freshAcceptedWhilePlaying = true;
    engine->startPreparedRecordingAsync([&](bool success) { freshAcceptedWhilePlaying = success; });
    engine->setTransportRecording(true); // Existing rolling punch-in path.
    callback();
    engine->setTransportPlaying(false); engine->setTransportRecording(false);
    const auto punchTakes = engine->getLastCompletedClips();
    check("prepared_record_start_preserves_rolling_punch_in",
          !freshAcceptedWhilePlaying && punchTakes.size() == 1
          && std::abs(punchTakes[0].startTime - punchPosition) < 1.0 / 48000.0
          && std::abs(punchTakes[0].duration * 48000.0 - 8.0) < 0.5,
          "Fresh-start operation rejects an already rolling transport; ordinary punch-in retains its current sample cursor.");

    const auto invalidDirectory = outputDirectory.getChildFile("prepared-start-invalid-directory");
    invalidDirectory.replaceWithText("A file cannot be a recording directory.");
    engine->setProbeRecordingDirectory(invalidDirectory);
    engine->setTransportPosition(0.0);
    bool failedAccepted = true;
    engine->startPreparedRecordingAsync([&](bool success) { failedAccepted = success; });
    check("prepared_record_start_writer_failure_leaves_transport_stopped",
          !failedAccepted && !engine->isTransportPlaying() && !engine->isTransportRecording()
          && engine->getTransportPosition() == 0.0,
          "Writer/destination failure is reported before playback publication.");
    check("prepared_record_start_synthetic_fixture_opens_no_hardware",
          engine->deviceManager.getCurrentAudioDevice() == nullptr && engine->hardwareCallbackRegistrationCount.load() == 0,
          "AudioDeviceAboutToStart and callback calls use a synthetic descriptor and explicit PCM only.");

    // Default recording must remain independent of old clips, sends, monitor
    // gain/mute and the fallback recorder lane used by a quarantined worker.
    device.open(juce::BigInteger(3), juce::BigInteger(3), 48000.0, 8);
    engine->audioDeviceAboutToStart(&device);
    const auto sourceFile = outputDirectory.getChildFile("raw-record-distinct-playback.wav");
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> sourceStream = sourceFile.createOutputStream();
    auto sourceWriter = wav.createWriterFor(sourceStream, juce::AudioFormatWriterOptions()
        .withSampleRate(48000).withNumChannels(2).withBitsPerSample(32));
    juce::AudioBuffer<float> background(2, 512);
    for (int sample = 0; sample < 512; ++sample) { background.setSample(0, sample, 0.25f); background.setSample(1, sample, -0.125f); }
    const bool backgroundWritten = sourceWriter && sourceWriter->writeFromAudioSampleBuffer(background, 0, 512) && sourceWriter->flush();
    sourceWriter.reset();
    engine->playbackEngine.addClip(sourceFile, 0, 512.0 / 48000, trackId, 0, 0, 0, 0, "raw-record-old-clip");
    const auto sender = engine->addTrack("raw-record-send-fixture", "audio");
    engine->playbackEngine.addClip(sourceFile, 0, 512.0 / 48000, sender, 0, 0, 0, 0, "raw-record-send-clip");
    const int send = engine->addTrackSend(sender, trackId);
    engine->setTrackSendLevel(sender, send, 0.5f);
    for (int sample = 0; sample < 256; ++sample) { input.setSample(0, sample, 0.0625f); input.setSample(1, sample, -0.03125f); }
    struct Case { const char* id; bool mono, quarantined, muted, punch; };
    int rawFixtureIndex = 0;
    for (const auto& fixture : std::initializer_list<Case> {
        { "raw_record_eight_frames_stereo_excludes_clips_and_sends", false, false, false, false },
        { "raw_record_eight_frames_mono_preserves_selected_input", true, false, false, false },
        { "raw_record_eight_frames_muted_monitor_still_captures_input", false, false, true, false },
        { "raw_record_eight_frames_punch_has_exact_sample_edges", false, false, false, true },
        { "raw_record_quarantined_lane_excludes_clips_and_sends", false, true, false, false },
        { "raw_record_quarantined_mono_preserves_selected_input", true, true, false, false },
        { "raw_record_quarantined_punch_matches_normal_lane", false, true, false, true } })
    {
        // Keep take filenames within the platform path budget. The descriptive
        // check ID is intentionally independent of the fixture directory name.
        engine->setProbeRecordingDirectory(outputDirectory.getChildFile("raw-input-" + juce::String(++rawFixtureIndex)));
        engine->setTrackInputChannels(trackId, fixture.mono ? 1 : 0, fixture.mono ? 1 : 2);
        engine->setTrackMute(trackId, fixture.muted);
        engine->setPunchRange(19.0 / 48000, 53.0 / 48000, fixture.punch);
        engine->setTransportPosition(0);
        bool accepted = false;
        engine->startPreparedRecordingAsync([&](bool success) { accepted = success; });
        const auto snapshot = std::atomic_load(&engine->realtimeTrackSnapshot);
        const auto entry = std::find_if(snapshot->tracks.begin(), snapshot->tracks.end(), [&](const auto& candidate) { return candidate.id == trackId; });
        for (int block = 0; block < 16; ++block)
        {
            if (fixture.quarantined && entry != snapshot->tracks.end())
            {
                if (entry->sendAccumBuffer)
                    for (int channel = 0; channel < 2; ++channel)
                        for (int sample = 0; sample < 8; ++sample)
                            entry->sendAccumBuffer->setSample(channel, sample, channel == 0 ? 0.125f : -0.0625f);
                engine->recordTrackHardwareInput(*entry, inputs, 2, 8, block * 8);
                engine->currentSamplePosition.store((block + 1) * 8);
            }
            else engine->audioDeviceIOCallbackWithContext(inputs, 2, outputs, 2, 8, {});
        }
        engine->setTransportPlaying(false); engine->setTransportRecording(false);
        const auto takes = engine->getLastCompletedClips();
        juce::AudioFormatManager formats; formats.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader(takes.empty() ? nullptr : formats.createReaderFor(takes[0].file));
        const int expectedFrames = fixture.punch ? 34 : 128;
        const int expectedChannels = fixture.mono ? 1 : 2;
        juce::AudioBuffer<float> captured(expectedChannels, expectedFrames);
        bool exact = accepted && backgroundWritten && send >= 0 && takes.size() == 1 && reader
            && reader->lengthInSamples == expectedFrames && static_cast<int>(reader->numChannels) == expectedChannels
            && std::abs(takes[0].startTime * 48000 - (fixture.punch ? 19 : 0)) < 0.5
            && reader->read(&captured, 0, expectedFrames, 0, true, expectedChannels > 1);
        for (int channel = 0; channel < expectedChannels && exact; ++channel)
            for (int sample = 0; sample < expectedFrames; ++sample)
                exact &= std::abs(captured.getSample(channel, sample) - input.getSample(fixture.mono ? 1 : channel, 0)) <= 1.0f / 32768.0f;
        check(fixture.id, exact, "Selected hardware PCM only; distinct existing clips and incoming sends never enter the take, with identical normal/quarantined punch bounds.");
    }
    engine->setPunchRange(0, 0, false);
    engine->setTrackMute(trackId, false);
    engine->audioDeviceStopped();
    result->setProperty("checks", checks);
    result->setProperty("primaryBlockSize", 8);
    result->setProperty("sampleRate", 48000);
    result->setProperty("preparedStoppedCallbackCount", 512);
    result->setProperty("scope", "Synthetic native callbacks; electrical latency and listening quality not_asserted.");
    const juce::var value(result);
    outputDirectory.getChildFile("prepared-record-start-regression.json").replaceWithText(juce::JSON::toString(value, true));
    return value;
}
