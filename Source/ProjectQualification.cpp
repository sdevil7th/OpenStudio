#include "AudioEngine.h"
#include "ClipTempoAnalyzer.h"
#include <algorithm>
#include <cmath>
#include <set>

namespace
{
bool qualificationHasContent(const juce::var& value)
{
    if (const auto* values = value.getArray()) return !values->isEmpty();
    if (const auto* object = value.getDynamicObject()) return object->getProperties().size() != 0;
    return !value.isVoid() && !value.toString().isEmpty();
}

double qualificationNumber(const juce::var& object, const char* key, double fallback)
{
    return object.hasProperty(key) ? static_cast<double>(object[key]) : fallback;
}

juce::var qualificationAudioStats(const juce::File& file)
{
    auto* result = new juce::DynamicObject();
    result->setProperty("filePath", file.getFullPathName());
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
    if (reader == nullptr) { result->setProperty("readable", false); return juce::var(result); }
    const int channels = juce::jlimit(1, 2, static_cast<int>(reader->numChannels));
    juce::AudioBuffer<float> block(channels, 16384);
    bool valid = true; double peak = 0.0, energy = 0.0;
    juce::int64 visited = 0;
    while (visited < reader->lengthInSamples)
    {
        const int count = static_cast<int>(juce::jmin<juce::int64>(16384, reader->lengthInSamples - visited));
        if (!reader->read(&block, 0, count, visited, true, true)) { valid = false; break; }
        for (int channel = 0; channel < channels; ++channel)
            for (int sample = 0; sample < count; ++sample)
            {
                const double value = block.getSample(channel, sample);
                valid = valid && std::isfinite(value); peak = juce::jmax(peak, std::abs(value)); energy += value * value;
            }
        visited += count;
    }
    result->setProperty("readable", valid && visited == reader->lengthInSamples);
    result->setProperty("sampleRate", reader->sampleRate);
    result->setProperty("channels", static_cast<int>(reader->numChannels));
    result->setProperty("bitsPerSample", static_cast<int>(reader->bitsPerSample));
    result->setProperty("floatingPoint", reader->usesFloatingPointData);
    result->setProperty("frames", reader->lengthInSamples);
    result->setProperty("durationSeconds", static_cast<double>(reader->lengthInSamples) / reader->sampleRate);
    result->setProperty("peak", peak);
    result->setProperty("rms", visited > 0 ? std::sqrt(energy / (static_cast<double>(visited) * channels)) : 0.0);
    result->setProperty("sha256", juce::SHA256(file).toHexString());
    return juce::var(result);
}

juce::var qualificationComparePCM(const juce::File& firstFile, const juce::File& secondFile)
{
    auto* result = new juce::DynamicObject();
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> first(formats.createReaderFor(firstFile)), second(formats.createReaderFor(secondFile));
    bool valid = first != nullptr && second != nullptr;
    if (valid) valid = first->sampleRate == second->sampleRate && first->numChannels == second->numChannels
        && first->lengthInSamples == second->lengthInSamples && first->numChannels == 2;
    juce::AudioBuffer<float> a(2, 16384), b(2, 16384);
    double difference = 0.0; juce::int64 visited = 0;
    while (valid && visited < first->lengthInSamples)
    {
        const int count = static_cast<int>(juce::jmin<juce::int64>(16384, first->lengthInSamples - visited));
        valid = first->read(&a, 0, count, visited, true, true) && second->read(&b, 0, count, visited, true, true);
        for (int channel = 0; valid && channel < 2; ++channel)
            for (int sample = 0; sample < count; ++sample)
                difference = juce::jmax(difference, std::abs(static_cast<double>(a.getSample(channel, sample) - b.getSample(channel, sample))));
        visited += count;
    }
    result->setProperty("pass", valid && difference == 0.0);
    result->setProperty("maxAbsolutePCMError", difference);
    result->setProperty("framesCompared", visited);
    return juce::var(result);
}

struct QualificationStemWindow
{
    double startTime = 0.0, duration = 2.0, peak = 0.0, strongestRms = 0.0;
    juce::int64 scannedFrames = 0;
    juce::String clipId, reason;
    bool readable = true;
};
QualificationStemWindow qualificationStemWindow(const juce::var& track)
{
    QualificationStemWindow result;
    const auto* clips = track["clips"].getArray();
    if (clips == nullptr || clips->isEmpty())
    {
        result.reason = "No audio source: unassigned MIDI is intentionally silent.";
        return result;
    }
    result.startTime = static_cast<double>((*clips)[0]["startTime"]);
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    double bestEnergy = -1.0;
    for (const auto& clip : *clips)
    {
        if (static_cast<bool>(clip["muted"])) continue;
        std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(juce::File(clip["filePath"].toString())));
        if (reader == nullptr) { result.readable = false; result.reason = "Source could not be opened during full retained-range scan."; return result; }
        const double duration = static_cast<double>(clip["duration"]);
        const double offset = qualificationNumber(clip, "offset", 0.0);
        const auto first = static_cast<juce::int64>(std::floor(offset * reader->sampleRate));
        const auto last = juce::jmin(reader->lengthInSamples,
            static_cast<juce::int64>(std::ceil((offset + duration) * reader->sampleRate)));
        const int channels = juce::jlimit(1, 2, static_cast<int>(reader->numChannels));
        juce::AudioBuffer<float> probe(channels, 65536);
        for (auto position = first; position < last; position += 65536)
        {
            const int count = static_cast<int>(juce::jmin<juce::int64>(65536, last - position));
            if (!reader->read(&probe, 0, count, position, true, true))
            { result.readable = false; result.reason = "A source read failed during the full retained-range scan."; return result; }
            double energy = 0.0;
            for (int channel = 0; channel < channels; ++channel)
            {
                const double rms = probe.getRMSLevel(channel, 0, count);
                energy += rms * rms;
                result.peak = juce::jmax(result.peak, static_cast<double>(probe.getMagnitude(channel, 0, count)));
            }
            result.scannedFrames += count;
            if (energy > bestEnergy)
            {
                bestEnergy = energy;
                result.strongestRms = std::sqrt(energy / channels);
                result.duration = juce::jmin(2.0, duration);
                const double center = static_cast<double>(position - first) / reader->sampleRate + count * 0.5 / reader->sampleRate;
                result.startTime = static_cast<double>(clip["startTime"])
                    + juce::jlimit(0.0, juce::jmax(0.0, duration - result.duration), center - result.duration * 0.5);
                result.clipId = clip["id"].toString();
            }
        }
    }
    result.reason = result.peak == 0.0
        ? "Full retained-source PCM scan found only zero samples; silence is the expected content."
        : "Window contains the strongest retained-source RMS block from a bounded-memory full PCM scan.";
    return result;
}

}

juce::var AudioEngine::runProjectQualification(const juce::File& projectFile, const juce::File& frontendPayload,
                                              const juce::File& outputDirectory)
{
    auto* report = new juce::DynamicObject();
    juce::Array<juce::var> checks, tracksReport, renders, stems, unsupported;
    bool allPassed = true;
    const auto hardwareEvidence = [this] {
        auto* object = new juce::DynamicObject();
        object->setProperty("startupMode", deviceStartupMode == DeviceStartup::offline ? "offline" : "openHardware");
        object->setProperty("audioDeviceOpened", deviceManager.getCurrentAudioDevice() != nullptr);
        object->setProperty("audioDeviceStartCount", static_cast<juce::int64>(audioDeviceStartCount.load()));
        object->setProperty("audioCallbackCount", static_cast<juce::int64>(audioCallbackCounter.load()));
        object->setProperty("callbackRegistrationCount", static_cast<int>(hardwareCallbackRegistrationCount.load()));
        return juce::var(object);
    };
    const auto zeroHardware = [](const juce::var& value) {
        return value["startupMode"].toString() == "offline" && !static_cast<bool>(value["audioDeviceOpened"])
            && static_cast<juce::int64>(value["audioDeviceStartCount"]) == 0
            && static_cast<juce::int64>(value["audioCallbackCount"]) == 0
            && static_cast<int>(value["callbackRegistrationCount"]) == 0;
    };
    const auto check = [&](const juce::String& id, bool pass, const juce::String& detail, const juce::var& diagnostic = {}) {
        auto* item = new juce::DynamicObject(); item->setProperty("id", id); item->setProperty("status", pass ? "pass" : "fail");
        item->setProperty("detail", detail); if (!diagnostic.isVoid()) item->setProperty("diagnostic", diagnostic);
        checks.add(item); allPassed = allPassed && pass;
    };
    const bool stemsOnly = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_PROJECT_STEMS_ONLY", {}) == "1";
    report->setProperty("harnessMode", stemsOnly ? "saved_project_stem_qualification" : "saved_project_qualification");
    report->setProperty("masterRenderScope", stemsOnly ? "not_asserted: stems-only run" : "full repeated master renders");
    report->setProperty("subjectiveAudioQuality", "not_asserted");
    report->setProperty("hardwareBefore", hardwareEvidence());
    const auto sourceHash = juce::SHA256(projectFile).toHexString();
    report->setProperty("projectPath", projectFile.getFullPathName()); report->setProperty("projectSha256", sourceHash);
    const auto finish = [&] {
        report->setProperty("hardwareAfter", hardwareEvidence());
        check("offline_launch_contract", zeroHardware(report->getProperty("hardwareBefore")) && zeroHardware(report->getProperty("hardwareAfter")),
              "Qualification opens no audio device, registers no callback and creates no application window.");
        check("project_copy_unchanged", juce::SHA256(projectFile).toHexString() == sourceHash, "Copied project bytes remain unchanged.");
        report->setProperty("checks", checks); report->setProperty("tracks", tracksReport);
        report->setProperty("renders", renders); report->setProperty("stems", stems); report->setProperty("unsupportedState", unsupported);
        report->setProperty("objectiveGateStatus", allPassed ? "pass" : "fail"); return juce::var(report);
    };
    check("offline_startup_required", zeroHardware(report->getProperty("hardwareBefore")), "Refuse qualification after hardware startup.");
    const auto project = juce::JSON::parse(projectFile);
    const auto payload = juce::JSON::parse(frontendPayload);
    const auto* rawTracks = project["tracks"].getArray();
    const auto* normalizedTracks = payload["tracks"].getArray();
    check("frontend_payload_provenance", projectFile.existsAsFile() && frontendPayload.existsAsFile()
        && payload["sourceProjectSha256"].toString() == sourceHash && rawTracks != nullptr && normalizedTracks != nullptr
        && rawTracks->size() == normalizedTracks->size(), "Frontend normalization and MIDI serialization belong to this exact copied project.");
    report->setProperty("frontendNormalizationEvidence", payload["qualification"]);
    check("frontend_project_load_completed", payload["qualification"]["loader"].toString() == "useDAWStore.loadProject"
        && !static_cast<bool>(payload["qualification"]["isProjectLoading"])
        && payload["qualification"]["projectRestoreError"].toString().isEmpty(), "The real frontend loader completed without a restore error.");
    check("output_directory_ready", outputDirectory.createDirectory().wasOk(), outputDirectory.getFullPathName());
    if (!allPassed) return finish();

    const auto rejectContent = [&](const juce::var& object, const char* property, const juce::String& context) {
        if (qualificationHasContent(object[property])) unsupported.add(context + ": " + property);
    };
    for (const auto* property : { "masterFXPaths", "masterFXStates", "masterFXStageState", "monitorFXStageState", "masterAutomationLanes", "unavailableFXStages" })
        rejectContent(project, property, "project");
    for (const auto& track : *rawTracks)
    {
        const auto context = track["name"].toString();
        for (const auto* property : { "inputFXPaths", "trackFXPaths", "inputFXStates", "trackFXStates", "instrumentPlugin", "instrumentState",
                                     "samplerSamplePath", "automationLanes", "unavailableFX", "sends", "trackFXSidechains", "takes", "midiOutputDevice" })
            rejectContent(track, property, context);
        if (track["type"].toString() != "audio" && track["type"].toString() != "midi") unsupported.add(context + ": track type");
        if (static_cast<bool>(track["channelStripEQEnabled"]) || qualificationHasContent(track["channelStripEQState"]))
            unsupported.add(context + ": inline channel EQ");
        if (const auto* clips = track["clips"].getArray()) for (const auto& clip : *clips)
        {
            if (static_cast<bool>(clip["reversed"]) || qualificationNumber(clip, "playbackRate", 1.0) != 1.0
                || qualificationNumber(clip, "pitchShift", 0.0) != 0.0 || qualificationHasContent(clip["pitchCorrectionSourceFilePath"]))
                unsupported.add(context + ": unsupported clip DSP state " + clip["id"].toString());
        }
    }
    check("complete_saved_dsp_state_supported", unsupported.isEmpty(), "Unsupported saved DSP state fails qualification before rendering.", unsupported);
    if (!allPassed) return finish();

    setPanLaw("linear"); setTempo(qualificationNumber(project, "tempo", 120.0));
    setTimeSignature(static_cast<int>(project["timeSignature"]["numerator"]), static_cast<int>(project["timeSignature"]["denominator"]));
    setTempoMarkers(juce::JSON::toString(project["tempoMarkers"]));
    setProcessingPrecision(project["processingPrecision"].toString());
    setMasterVolume(static_cast<float>(qualificationNumber(project, "masterVolume", 1.0)));
    setMasterPan(static_cast<float>(qualificationNumber(project, "masterPan", 0.0)));
    setMasterMute(static_cast<bool>(project["isMasterMuted"])); setMasterMono(static_cast<bool>(project["masterMono"]));
    setAutomationTrimValue("master", static_cast<float>(qualificationNumber(project, "masterTrimVolumeDB", 0.0)));
    report->setProperty("panLaw", getPanLaw()); report->setProperty("processingPrecision", getProcessingPrecision());
    report->setProperty("projectSampleRate", project["projectSampleRate"]);
    int audioClipCount = 0, midiClipCount = 0, midiEventCount = 0;
    juce::Array<juce::var> midiExportTracks;
    std::map<juce::String, std::vector<double>> expectedMIDI;
    const auto midiKey = [](const juce::String& type, int channel, int address, int value) {
        return type + ":" + juce::String(channel) + ":" + juce::String(address) + ":" + juce::String(value);
    };
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    std::set<juce::String> ids, sources;
    for (const auto& savedTrack : *rawTracks)
    {
        const auto id = savedTrack["id"].toString();
        juce::var track;
        for (const auto& candidate : *normalizedTracks) if (candidate["id"].toString() == id) { track = candidate; break; }
        if (track.isVoid() || id.isEmpty() || !ids.insert(id).second) { check("track_identity", false, id); return finish(); }
        const auto* savedClips = savedTrack["clips"].getArray();
        const auto* normalizedClips = track["clips"].getArray();
        if (savedClips == nullptr || normalizedClips == nullptr || savedClips->size() != normalizedClips->size())
        { check("audio_clip_identity", false, id); return finish(); }
        for (const auto& savedClip : *savedClips)
        {
            bool found = false;
            for (const auto& normalizedClip : *normalizedClips)
                if (savedClip["id"] == normalizedClip["id"] && savedClip["filePath"] == normalizedClip["filePath"]
                    && savedClip["startTime"] == normalizedClip["startTime"] && savedClip["duration"] == normalizedClip["duration"]
                    && qualificationNumber(savedClip, "offset", 0) == qualificationNumber(normalizedClip, "offset", 0)) found = true;
            if (!found) { check("audio_clip_identity", false, savedClip["id"].toString()); return finish(); }
        }
        const auto type = track["type"].toString();
        if (addTrack(id, type) != id) { check("track_creation", false, id); return finish(); }
        setTrackVolume(id, static_cast<float>(qualificationNumber(track, "volumeDB", 0.0)));
        setTrackPan(id, static_cast<float>(qualificationNumber(track, "pan", 0.0)));
        setTrackMute(id, static_cast<bool>(track["muted"])); setTrackSolo(id, static_cast<bool>(track["soloed"]));
        setTrackSoloSafe(id, static_cast<bool>(track["soloSafe"]));
        setTrackPhaseInvert(id, static_cast<bool>(track["phaseInverted"]));
        setTrackStereoWidth(id, static_cast<float>(qualificationNumber(track, "stereoWidth", 100.0)));
        setTrackMasterSendEnabled(id, !track.hasProperty("masterSendEnabled") || static_cast<bool>(track["masterSendEnabled"]));
        setTrackOutputChannels(id, static_cast<int>(track["outputStartChannel"]), static_cast<int>(qualificationNumber(track, "outputChannelCount", 2.0)));
        setTrackChannelCount(id, static_cast<int>(qualificationNumber(track, "trackChannelCount", 2.0)));
        setTrackPlaybackOffset(id, qualificationNumber(track, "playbackOffsetMs", 0.0));
        setTrackInputChannels(id, static_cast<int>(track["inputStartChannel"]), static_cast<int>(qualificationNumber(track, "inputChannelCount", 2.0)));
        setAutomationTrimValue(id, static_cast<float>(qualificationNumber(track, "trimVolumeDB", 0.0)));
        setTrackMIDIInput(id, track["midiInputDevice"].toString(), static_cast<int>(track["midiChannel"]));
        auto* item = new juce::DynamicObject(); item->setProperty("id", id); item->setProperty("name", track["name"]);
        item->setProperty("type", type); item->setProperty("routing", getTrackRoutingInfo(id));
        item->setProperty("volumeDB", trackMap[id]->getVolume()); item->setProperty("pan", trackMap[id]->getPan());
        item->setProperty("muted", trackMap[id]->getMute()); item->setProperty("soloed", trackMap[id]->getSolo());
        int loadedClips = 0;
        if (const auto* clips = track["clips"].getArray()) for (const auto& clip : *clips)
        {
            const juce::File file(clip["filePath"].toString());
            std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
            if (reader == nullptr) { check("readable_source", false, file.getFullPathName()); return finish(); }
            sources.insert(file.getFullPathName());
            if (static_cast<bool>(clip["muted"])) continue;
            addPlaybackClip(id, file.getFullPathName(), static_cast<double>(clip["startTime"]), static_cast<double>(clip["duration"]),
                            qualificationNumber(clip, "offset", 0), qualificationNumber(clip, "volumeDB", 0),
                            qualificationNumber(clip, "fadeIn", 0), qualificationNumber(clip, "fadeOut", 0), clip["id"].toString(), {}, -1.0,
                            static_cast<int>(clip["fadeInShape"]), static_cast<int>(clip["fadeOutShape"]));
            if (const auto* envelope = clip["gainEnvelope"].getArray())
            {
                std::vector<PlaybackEngine::GainEnvelopePoint> points;
                for (const auto& point : *envelope) points.push_back({ static_cast<double>(point["time"]), static_cast<float>(point["gain"]) });
                playbackEngine.setClipGainEnvelope(id, clip["id"].toString(), points);
            }
            ++loadedClips; ++audioClipCount;
        }
        const auto midi = payload["backendMIDIClipsByTrackId"][juce::Identifier(id)];
        const auto* midiClips = midi.getArray();
        if (midiClips == nullptr) { check("midi_serialization_present", false, id); return finish(); }
        setTrackMIDIClips(id, juce::JSON::toString(midi));
        int expectedEvents = 0;
        for (const auto& clip : *midiClips) if (const auto* events = clip["events"].getArray())
        {
            expectedEvents += events->size();
            for (const auto& event : *events)
            {
                const auto eventType = event["type"].toString();
                int address = 0, value = static_cast<int>(event["value"]);
                if (eventType == "noteOn" || eventType == "noteOff")
                {
                    address = static_cast<int>(event["note"]);
                    value = static_cast<int>(eventType == "noteOff" && event.hasProperty("releaseVelocity")
                        ? event["releaseVelocity"] : event["velocity"]);
                }
                else if (eventType == "cc") address = static_cast<int>(event["controller"]);
                else if (eventType == "polyPressure") address = static_cast<int>(event["note"]);
                expectedMIDI[track["name"].toString() + "|" + midiKey(eventType, static_cast<int>(event["channel"]), address, value)].push_back(
                    static_cast<double>(clip["startTime"]) + static_cast<double>(event["timestamp"]));
            }
        }
        if (!midiClips->isEmpty())
        {
            auto* exportTrack = new juce::DynamicObject(); exportTrack->setProperty("name", track["name"]);
            exportTrack->setProperty("clips", midi); midiExportTracks.add(exportTrack);
        }
        const auto* processor = trackMap[id];
        check("midi_event_count_" + id, processor->getScheduledMIDIClipCount() == midiClips->size()
            && processor->getScheduledMIDIEventCount() == expectedEvents, "Native scheduler retains all frontend-normalized MIDI clips and events.");
        midiClipCount += midiClips->size(); midiEventCount += expectedEvents;
        item->setProperty("audioClips", loadedClips); item->setProperty("midiClips", midiClips->size());
        item->setProperty("scheduledMIDIEvents", expectedEvents);
        item->setProperty("instrumentConfigured", false);
        item->setProperty("expectedSilentMIDI", type == "midi"); tracksReport.add(item);
    }
    report->setProperty("trackCount", static_cast<int>(ids.size())); report->setProperty("audioClipCount", audioClipCount);
    report->setProperty("midiClipCount", midiClipCount); report->setProperty("scheduledMIDIEventCount", midiEventCount);
    report->setProperty("distinctAudioSources", static_cast<int>(sources.size()));
    check("native_audio_clip_count", playbackEngine.getNumClips() == audioClipCount, "Every normalized, unmuted audio clip is present in native playback.");
    if (!allPassed) return finish();

    if (!stemsOnly)
    {
    const auto midiFile = outputDirectory.getChildFile("project-midi.mid");
    auto* midiTiming = new juce::DynamicObject(); midiTiming->setProperty("tempo", project["tempo"]);
    midiTiming->setProperty("tempoMarkers", project["tempoMarkers"]); midiTiming->setProperty("timeSignature", project["timeSignature"]);
    bool midiValid = exportProjectMIDI(midiFile.getFullPathName(), midiExportTracks, getTempo(), juce::var(midiTiming));
    juce::MidiFile exportedMIDI; juce::FileInputStream midiInput(midiFile);
    midiValid = midiValid && exportedMIDI.readFrom(midiInput);
    const int midiPPQ = exportedMIDI.getTimeFormat();
    int tempoMetadataCount = 0, meterMetadataCount = 0;
    for (int trackIndex = 0; midiValid && trackIndex < exportedMIDI.getNumTracks(); ++trackIndex)
        for (int eventIndex = 0; eventIndex < exportedMIDI.getTrack(trackIndex)->getNumEvents(); ++eventIndex)
        {
            const auto& message = exportedMIDI.getTrack(trackIndex)->getEventPointer(eventIndex)->message;
            if (message.isTempoMetaEvent() && std::abs(60.0 / message.getTempoSecondsPerQuarterNote() - getTempo()) < 0.001) ++tempoMetadataCount;
            if (message.isTimeSignatureMetaEvent())
            {
                int numerator = 0, denominator = 0; message.getTimeSignatureInfo(numerator, denominator);
                if (numerator == static_cast<int>(project["timeSignature"]["numerator"])
                    && denominator == static_cast<int>(project["timeSignature"]["denominator"])) ++meterMetadataCount;
            }
        }
    exportedMIDI.convertTimestampTicksToSeconds();
    std::map<juce::String, std::vector<double>> actualMIDI;
    int actualMIDIEvents = 0;
    for (int trackIndex = 0; midiValid && trackIndex < exportedMIDI.getNumTracks(); ++trackIndex)
    {
        juce::String exportedTrackName;
        for (int eventIndex = 0; eventIndex < exportedMIDI.getTrack(trackIndex)->getNumEvents(); ++eventIndex)
        {
            const auto& message = exportedMIDI.getTrack(trackIndex)->getEventPointer(eventIndex)->message;
            if (message.isTrackNameEvent()) exportedTrackName = message.getTextFromTextMetaEvent();
        }
        for (int eventIndex = 0; eventIndex < exportedMIDI.getTrack(trackIndex)->getNumEvents(); ++eventIndex)
        {
            const auto& message = exportedMIDI.getTrack(trackIndex)->getEventPointer(eventIndex)->message;
            juce::String type; int address = 0, value = 0;
            if (message.isNoteOn()) { type = "noteOn"; address = message.getNoteNumber(); value = message.getVelocity(); }
            else if (message.isNoteOff()) { type = "noteOff"; address = message.getNoteNumber(); value = message.getVelocity(); }
            else if (message.isController()) { type = "cc"; address = message.getControllerNumber(); value = message.getControllerValue(); }
            else if (message.isPitchWheel()) { type = "pitchBend"; value = message.getPitchWheelValue(); }
            else if (message.isProgramChange()) { type = "programChange"; value = message.getProgramChangeNumber(); }
            else if (message.isChannelPressure()) { type = "channelPressure"; value = message.getChannelPressureValue(); }
            else if (message.isAftertouch()) { type = "polyPressure"; address = message.getNoteNumber(); value = message.getAfterTouchValue(); }
            else continue;
            actualMIDI[exportedTrackName + "|" + midiKey(type, message.getChannel(), address, value)].push_back(message.getTimeStamp()); ++actualMIDIEvents;
        }
    }
    double midiTimeError = 0.0;
    bool midiIdentities = actualMIDI.size() == expectedMIDI.size();
    for (auto& entry : expectedMIDI)
    {
        auto& actual = actualMIDI[entry.first]; std::sort(actual.begin(), actual.end()); std::sort(entry.second.begin(), entry.second.end());
        if (actual.size() != entry.second.size()) { midiIdentities = false; continue; }
        for (size_t event = 0; event < actual.size(); ++event) midiTimeError = juce::jmax(midiTimeError, std::abs(actual[event] - entry.second[event]));
    }
    auto* midiReport = new juce::DynamicObject(); midiReport->setProperty("filePath", midiFile.getFullPathName());
    midiReport->setProperty("expectedMusicalEvents", midiEventCount); midiReport->setProperty("decodedMusicalEvents", actualMIDIEvents);
    midiReport->setProperty("maxTimestampErrorSeconds", midiTimeError); midiReport->setProperty("ticksPerQuarterNote", midiPPQ);
    midiReport->setProperty("sha256", juce::SHA256(midiFile).toHexString()); report->setProperty("midiExport", juce::var(midiReport));
    check("actual_project_midi_export_roundtrip", midiValid && midiIdentities && actualMIDIEvents == midiEventCount && midiPPQ > 0
        && tempoMetadataCount == midiExportTracks.size() && meterMetadataCount == midiExportTracks.size()
        && midiTimeError <= 60.0 / getTempo() / juce::jmax(1, midiPPQ) + 0.0001,
        "Actual normalized MIDI events retain types, channels, values and timing within one exported tick, with saved tempo/meter.", juce::var(midiReport));

    juce::Array<juce::var> tempoDiagnostics;
    std::set<juce::String> analyzedSources;
    for (const auto& track : *rawTracks)
    {
        const auto name = track["name"].toString();
        if (name != "Audio 1" && name != "Dist-Gtr_05" && name != "Chor_01" && name != "All takes done_19.08.25") continue;
        const auto* clips = track["clips"].getArray();
        if (clips == nullptr || clips->isEmpty()) continue;
        const auto clip = (*clips)[0];
        const auto path = clip["filePath"].toString();
        if (!analyzedSources.insert(path).second) continue;
        auto diagnostic = ClipTempoAnalyzer::analyze(juce::File(path), qualificationNumber(clip, "offset", 0), static_cast<double>(clip["duration"]));
        diagnostic.getDynamicObject()->setProperty("trackName", name);
        diagnostic.getDynamicObject()->setProperty("clipId", clip["id"]);
        diagnostic.getDynamicObject()->setProperty("filePath", path);
        diagnostic.getDynamicObject()->setProperty("classification", "diagnostic_only");
        diagnostic.getDynamicObject()->setProperty("savedProjectBPM", project["tempo"]);
        tempoDiagnostics.add(diagnostic);
    }
    report->setProperty("actualSourceTempoDiagnostics", tempoDiagnostics);

    }

    const double start = qualificationNumber(project["renderDialogOptions"], "startTime", 0.0);
    const double end = qualificationNumber(project["renderDialogOptions"], "endTime", qualificationNumber(project["projectRange"], "end", 0.0));
    const double tailMs = qualificationNumber(project["renderDialogOptions"], "tailLength", 1000.0);
    const bool addTail = static_cast<bool>(project["renderDialogOptions"]["addTail"]);
    report->setProperty("startTime", start); report->setProperty("endTime", end); report->setProperty("tailMs", addTail ? tailMs : 0.0);
    const auto render = [&](const juce::String& name, double rate, const juce::String& format, int bits) {
        const auto target = outputDirectory.getChildFile(name);
        juce::Logger::writeToLog("ProjectQualification: render " + name);
        const bool rendered = renderProject("master", start, end, target.getFullPathName(), format, rate, bits, 2,
                                            false, addTail, tailMs, false);
        auto stats = qualificationAudioStats(target);
        stats.getDynamicObject()->setProperty("sourceReadMisses", lastOfflineRenderSourceReadMisses.load());
        stats.getDynamicObject()->setProperty("sourceReadFailed", lastOfflineRenderSourceReadFailed.load());
        const double tolerance = format == "mp3" ? 0.15 : 2.0 / rate;
        check("render_" + name, rendered && static_cast<bool>(stats["readable"])
            && std::abs(static_cast<double>(stats["sampleRate"]) - rate) < 1.0
            && std::abs(static_cast<double>(stats["durationSeconds"]) - (end - start + (addTail ? tailMs * 0.001 : 0.0))) <= tolerance
            && lastOfflineRenderSourceReadMisses.load() == 0 && !lastOfflineRenderSourceReadFailed.load(),
            "Full saved-project render has complete finite PCM, requested rate/duration and no concealed source reads.", stats);
        renders.add(stats);
        auto* progress = new juce::DynamicObject(); progress->setProperty("completedRenders", renders);
        outputDirectory.getChildFile("progress.json").replaceWithText(juce::JSON::toString(juce::var(progress), true));
        return target;
    };
    if (!stemsOnly)
    {
    const auto first48 = render("master-48000-a.wav", 48000.0, "wav", 32);
    const auto second48 = render("master-48000-b.wav", 48000.0, "wav", 32);
    const auto parity48 = qualificationComparePCM(first48, second48);
    check("repeat_render_48000_pcm", static_cast<bool>(parity48["pass"]), "Independent render passes produce identical decoded PCM.", parity48);
    const auto first44 = render("master-44100-a.wav", 44100.0, "wav", 32);
    const auto second44 = render("master-44100-b.wav", 44100.0, "wav", 32);
    const auto parity44 = qualificationComparePCM(first44, second44);
    check("repeat_render_44100_pcm", static_cast<bool>(parity44["pass"]), "Independent render passes produce identical decoded PCM.", parity44);
    render("saved-mixdown-48000-320.mp3", 48000.0, "mp3", 320);

    }

    bool savedPreview = false;
    const bool anySolo = std::any_of(normalizedTracks->begin(), normalizedTracks->end(), [](const juce::var& track) { return static_cast<bool>(track["soloed"]); });
    for (const auto& track : *normalizedTracks)
    {
        if (static_cast<bool>(track["muted"]) || (anySolo && !static_cast<bool>(track["soloed"]) && !static_cast<bool>(track["soloSafe"]))) continue;
        const auto id = track["id"].toString();
        const auto* clips = track["clips"].getArray();
        const auto* midi = track["midiClips"].getArray();
        if ((clips == nullptr || clips->isEmpty()) && (midi == nullptr || midi->isEmpty())) continue;
        const auto selectedWindow = qualificationStemWindow(track);
        const double windowStart = selectedWindow.startTime;
        const double windowEnd = juce::jmin(end, windowStart + selectedWindow.duration);
        const auto target = outputDirectory.getChildFile("stem-" + id + ".wav");
        const bool rendered = renderProject("stem:" + id, windowStart, windowEnd, target.getFullPathName(), "wav", 48000, 32, 2, false, false, 0, false);
        auto stats = qualificationAudioStats(target);
        auto* object = stats.getDynamicObject(); object->setProperty("trackId", id); object->setProperty("name", track["name"]);
        object->setProperty("startTime", windowStart); object->setProperty("endTime", windowEnd);
        object->setProperty("sourceScanPeak", selectedWindow.peak); object->setProperty("sourceScanStrongestRms", selectedWindow.strongestRms);
        object->setProperty("sourceScanFrames", selectedWindow.scannedFrames); object->setProperty("windowReason", selectedWindow.reason);
        object->setProperty("sourceReadMisses", lastOfflineRenderSourceReadMisses.load());
        object->setProperty("sourceReadFailed", lastOfflineRenderSourceReadFailed.load());
        const bool silentMIDI = track["type"].toString() == "midi";
        object->setProperty("expectedSilentMIDI", silentMIDI);
        check("stem_" + id, selectedWindow.readable && rendered && static_cast<bool>(stats["readable"])
            && (silentMIDI || selectedWindow.peak == 0.0 || static_cast<double>(stats["peak"]) > 0.0)
            && lastOfflineRenderSourceReadMisses.load() == 0 && !lastOfflineRenderSourceReadFailed.load()
            && (!silentMIDI || static_cast<double>(stats["peak"]) == 0.0), "Saved track renders its window without missing reads; unassigned MIDI remains silent.", stats);
        stems.add(stats);
        if (!savedPreview && selectedWindow.peak > 0.0 && selectedWindow.clipId.isNotEmpty())
        {
            double clipStart = 0.0;
            for (const auto& clip : *clips) if (clip["id"].toString() == selectedWindow.clipId) clipStart = static_cast<double>(clip["startTime"]);
            const auto preview = getClipTempoPreviewData(id, selectedWindow.clipId, windowStart - clipStart, windowEnd - windowStart);
            juce::MemoryOutputStream wav;
            const bool decoded = juce::Base64::convertFromBase64(wav, preview["wavBase64"].toString());
            const auto previewFile = outputDirectory.getChildFile("tempo-preview-source.wav");
            savedPreview = decoded && previewFile.replaceWithData(wav.getData(), wav.getDataSize())
                && outputDirectory.getChildFile("tempo-preview-source.json").replaceWithText(juce::JSON::toString(preview, true));
            report->setProperty("drySourcePreviewArtifact", previewFile.getFullPathName());
        }
    }
    return finish();
}
