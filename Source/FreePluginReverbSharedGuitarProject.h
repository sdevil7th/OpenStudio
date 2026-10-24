#pragma once

// Opt-in local QA: the user's saved single-track guitar project is read only.
// Cache the complete native NAM track once, then compose each fresh Reverb with
// that identical signal. No source/output normalization or guitar-onset crop.
inline juce::var renderReverbSharedGuitarProject()
{
    constexpr int rate = 44100, frames = 512;
    constexpr double tailSeconds = 10;
    const auto root = juce::File::getCurrentWorkingDirectory();
    const auto projectFile = root.getChildFile("test projects/test guitar 1.osproj");
    const auto qaPath=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_REVERB_QA_OUTPUT", "output/reverb-shared-guitar-project");
    const auto directory = root.getChildFile(qaPath).getChildFile("native");
    const bool profileOutput=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_REVERB_QA_PROFILE_OUTPUT", "0")=="1";
    const auto filter=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_REVERB_QA_TYPE", "-1").getIntValue();
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Shared guitar project: saved native NAM track then standalone canonical Reverb");
    result->setProperty("directory", directory.getFullPathName());
    result->setProperty("projectPath", projectFile.getFullPathName());
    result->setProperty("sampleRate", rate); result->setProperty("blockSize", frames);
    result->setProperty("audibility", "not_asserted"); result->setProperty("audioQuality", "not_asserted");
    result->setProperty("rmsBalance", "diagnostic_only"); result->setProperty("dominance", "not_asserted");
    const auto fail = [result] (const juce::String& reason) { result->setProperty("pass", false); result->setProperty("failure", reason); return juce::var(result); };
    const auto project = juce::JSON::parse(projectFile.loadFileAsString());
    const auto tracksValue = project["tracks"];
    const auto* tracks = tracksValue.getArray();
    if (!projectFile.existsAsFile() || !tracks || tracks->size() != 1 || !directory.createDirectory().wasOk())
        return fail("Expected existing one-track project and writable isolated output directory");
    const auto trackState = tracks->getReference(0);
    const auto clipsValue = trackState["clips"], fxValue = trackState["trackFXPaths"], statesValue = trackState["trackFXStates"], assetsValue = project["namAssets"];
    const auto* clips = clipsValue.getArray();
    const auto* fx = fxValue.getArray();
    const auto* states = statesValue.getArray();
    const auto* assets = assetsValue.getArray();
    if (!clips || clips->size() != 1 || !fx || fx->size() != 1 || fx->getReference(0).toString() != "OpenStudio NAM Rack"
        || !states || states->size() != 1 || !assets || assets->size() != 1)
        return fail("Expected one saved NAM Rack, one clip and one referenced NAM model");
    const auto emptyArray = [] (const juce::var& value) { const auto* array = value.getArray(); return !array || array->isEmpty(); };
    const bool routing = static_cast<double>(trackState["volumeDB"]) == 0 && static_cast<double>(trackState["pan"]) == 0
        && static_cast<double>(trackState["stereoWidth"]) == 100 && static_cast<double>(trackState["playbackOffsetMs"]) == 0
        && static_cast<bool>(trackState["masterSendEnabled"]) && !static_cast<bool>(trackState["phaseInverted"])
        && !static_cast<bool>(trackState["muted"]) && !static_cast<bool>(trackState["monitorEnabled"])
        && emptyArray(trackState["sends"]) && emptyArray(trackState["inputFXPaths"])
        && emptyArray(trackState["automationLanes"]) && emptyArray(project["masterFXPaths"])
        && emptyArray(project["masterAutomationLanes"]) && static_cast<double>(project["masterVolume"]) == 1
        && static_cast<double>(project["masterPan"]) == 0 && !static_cast<bool>(project["masterMono"])
        && !static_cast<bool>(project["isMasterMuted"]) && project["processingPrecision"].toString() == "float32";
    if (!routing) return fail("Project routing changed: this QA renderer requires the audited single unity audio track without automation or other FX");
    const auto clip = clips->getReference(0);
    const auto path = [] (juce::String text) { return text.replace("\\\\", "\\"); };
    const juce::File sourceFile(path(clip["filePath"].toString()));
    const auto modelAsset = assets->getReference(0);
    const juce::File modelFile(path(modelAsset["path"].toString()));
    juce::MemoryBlock namState;
    if (!sourceFile.existsAsFile() || !modelFile.existsAsFile() || !namState.fromBase64Encoding(states->getReference(0).toString()))
        return fail("Missing recorded source/model or invalid saved JUCE NAM state");
    const auto namTree = juce::ValueTree::readFromData(namState.getData(), namState.getSize());
    const auto modelHash = juce::SHA256(modelFile).toHexString();
    if (!namTree.hasType("OpenStudioNAMRack") || modelHash != modelAsset["checksum"].toString()
        || static_cast<float>(namTree.getProperty("reverbEnabled")) != 0)
        return fail("Saved NAM type/model fingerprint or disabled internal reverb verification failed");
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(sourceFile));
    if (!reader || reader->sampleRate != rate || reader->numChannels != 1 || reader->lengthInSamples <= 0)
        return fail("Expected existing mono 44.1k guitar recording");
    const double projectEnd = static_cast<double>(project["projectRange"]["end"]);
    const double renderSeconds = projectEnd + tailSeconds;
    if (!(projectEnd > 0 && projectEnd < 120)) return fail("Unexpected project range");
    const int length = static_cast<int>(std::llround(renderSeconds * rate));
    const double sourceStart = static_cast<double>(clip["startTime"]);
    const auto trackId = trackState["id"].toString();
    auto rack = std::make_unique<OpenStudioNAMRack>(); rack->setNonRealtime(true);
    const bool restored = rack->restoreProjectStateInformation(namState.getData(), static_cast<int>(namState.getSize()));
    auto* rackPtr = rack.get();
    TrackProcessor nativeTrack; nativeTrack.setNonRealtime(true); nativeTrack.setTrackType(TrackType::Audio);
    nativeTrack.setTrackChannelCount(2); nativeTrack.setProcessingPrecisionMode(ProcessingPrecisionMode::Float32);
    nativeTrack.setInputChannels(static_cast<int>(trackState["inputStartChannel"]), static_cast<int>(trackState["inputChannelCount"]));
    nativeTrack.setVolume(0); nativeTrack.setPan(0); nativeTrack.setPanLaw(PanLaw::Linear); nativeTrack.setStereoWidth(100);
    nativeTrack.setMute(false); nativeTrack.setInputMonitoring(false); nativeTrack.setRecordArmed(false);
    nativeTrack.setChannelStripEQEnabled(false); nativeTrack.setDCOffsetRemoval(false); nativeTrack.setPDCDelay(0);
    const bool mounted = nativeTrack.addTrackFX(std::move(rack), rate, frames);
    nativeTrack.prepareToPlay(rate, frames); nativeTrack.resetOfflineRenderState();
    const bool ready = restored && mounted && rackPtr->hasAmpModel() && rackPtr->ampModelIncludesCab()
        && juce::File(rackPtr->getAmpModelPath()) == modelFile && rackPtr->getLastLoadError().isEmpty();
    if (!ready) return fail("Native saved NAM resource readiness failed: " + rackPtr->getLastLoadError());
    const int latency = juce::jmax(0, nativeTrack.getChainLatency());
    const int processedLength = length + latency;
    PlaybackEngine playback; playback.setRenderMode(true);
    playback.addClip(sourceFile, sourceStart, static_cast<double>(clip["duration"]), trackId,
        static_cast<double>(clip["offset"]), static_cast<double>(clip["volumeDB"]),
        static_cast<double>(clip["fadeIn"]), static_cast<double>(clip["fadeOut"]), clip["id"].toString());
    juce::AudioBuffer<float> block(2, frames), cachedUpstream(2, processedLength), baseline(2, length), sourceTimeline(2, length);
    juce::MidiBuffer midi; bool passed = true;
    for (int start = 0; start < processedLength; start += frames)
    {
        const int count = juce::jmin(frames, processedLength - start);
        block.setSize(2, count, false, false, true); block.clear(); midi.clear();
        playback.fillTrackBuffer(trackId, block, static_cast<double>(start) / rate, count, rate);
        if (start < length)
            for (int channel = 0; channel < 2; ++channel)
                sourceTimeline.copyFrom(channel, start, block, channel, 0, juce::jmin(count, length - start));
        nativeTrack.setCurrentBlockPosition(static_cast<double>(start) / rate);
        passed = nativeTrack.tryProcessBlock(block, midi) && passed;
        for (int channel = 0; channel < 2; ++channel) cachedUpstream.copyFrom(channel, start, block, channel, 0, count);
    }
    for (int channel = 0; channel < 2; ++channel) baseline.copyFrom(channel, 0, cachedUpstream, channel, latency, length);
    nativeTrack.releaseResources();
    passed = writeProbeWave(directory.getChildFile("baseline-nam-only.wav"), baseline, rate) && passed;
    passed = writeProbeWave(directory.getChildFile("source-timeline.wav"), sourceTimeline, rate) && passed;
    passed = directory.getChildFile("saved-nam-project.state").replaceWithData(namState.getData(), namState.getSize()) && passed;
    result->setProperty("baselineFile", "baseline-nam-only.wav"); result->setProperty("sourceTimelineFile", "source-timeline.wav");
    result->setProperty("sourcePath", sourceFile.getFullPathName()); result->setProperty("sourceStartSeconds", sourceStart);
    result->setProperty("sourceDurationSeconds", static_cast<double>(clip["duration"])); result->setProperty("sourceOffsetSeconds", static_cast<double>(clip["offset"]));
    result->setProperty("sourceTimelinePeak", sourceTimeline.getMagnitude(0, length)); result->setProperty("baselinePeak", baseline.getMagnitude(0, length));
    result->setProperty("renderSeconds", renderSeconds); result->setProperty("projectEndSeconds", projectEnd); result->setProperty("tailSeconds", tailSeconds);
    result->setProperty("upstreamLatencySamples", latency); result->setProperty("cachedUpstream", true); result->setProperty("sourceGain", 1);
    result->setProperty("dry", .7); result->setProperty("outputDb", profileOutput?juce::var("authored_per_voice"):juce::var(0)); result->setProperty("returnLevel", "Calibrated");
    auto* metadata = new juce::DynamicObject();
    metadata->setProperty("projectSha256", juce::SHA256(projectFile).toHexString()); metadata->setProperty("sourceSha256", juce::SHA256(sourceFile).toHexString());
    metadata->setProperty("savedNamStateSha256", juce::SHA256(namState).toHexString()); metadata->setProperty("modelPath", modelFile.getFullPathName());
    metadata->setProperty("modelSha256", modelHash); metadata->setProperty("modelCaptureType", rackPtr->getAmpCaptureType());
    metadata->setProperty("namReady", ready); metadata->setProperty("namInternalReverbEnabled", 0);
    metadata->setProperty("metronomeIncluded", false); metadata->setProperty("tempo", project["tempo"]); metadata->setProperty("timeSignature", project["timeSignature"]);
    metadata->setProperty("pipeline", "Actual PlaybackEngine timeline scheduling and TrackProcessor saved complete NAM Rack, cached once before latency compensation; each fresh native standalone Reverb consumes identical uncompensated cache, then the same reported upstream latency is trimmed from final output");
    metadata->setProperty("routingScope", "Audited single audio track, unity linear pan/fader/master, no monitoring/automation/sends/other FX; full AudioEngine graph and device playback not asserted");
    metadata->setProperty("normalization", "None: source input gain1 and native float32 mixed output; source silence and clip position preserved");
    metadata->setProperty("tailCompleteness", "not_asserted; fixed10 second listening tail after saved project range may truncate long reverbs");
    metadata->setProperty("assetUse", "Existing user project/audio and referenced local NAM model read only; reference metadata is not embedded model data; model licence unspecified in project");
    result->setProperty("metadata", juce::var(metadata));
    const std::array<const char*, 5> labels {"dry", "wet25", "wet50", "wet75", "wet100"};
    const std::array<float, 5> wetLevels {0, .25f, .5f, .75f, 1};
    const std::array<const char*, 27> originalNames {"Room", "Hall", "Plate", "Chamber", "Spring", "Shimmer", "Nonlinear", "Convolution", "Church", "Ambience", "Vintage hall", "Vintage random", "Contour room", "Open hall", "Diffuse loop", "Magnetic heads", "Positioned room", "Rising space", "Bloom field", "Cloud field", "Vowel hall", "Drifting hall", "Drifting chamber", "Drifting diffuse", "Clear plate", "Clear room", "Clear random"};
    juce::Array<juce::var> rows; double maximumScalingError = 0; juce::int64 allBoundSamples = 0;
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
    {
        if(filter>=0&&filter!=type)continue;
        const auto& voice = OpenStudioReverbFactoryPresets::profiles[static_cast<size_t>(type)];
        juce::MemoryBlock authoredState; const bool built = OpenStudioReverbFactoryPresets::buildState(voice.name, authoredState);
        const auto stateFile = juce::String("canonical-type-") + juce::String(type).paddedLeft('0', 2) + ".state";
        bool written = built && directory.getChildFile(stateFile).replaceWithData(authoredState.getData(), authoredState.getSize());
        std::array<juce::AudioBuffer<float>, 5> outputs;
        for (size_t variant = 0; variant < outputs.size(); ++variant)
        {
            auto processor = std::make_unique<OpenStudioReverb>(true); processor->setNonRealtime(true);
            processor->setStateInformation(authoredState.getData(), static_cast<int>(authoredState.getSize()));
            processor->dryLevel.store(.7f); processor->wetLevel.store(wetLevels[variant]); processor->sendMode.store(0);
            if (!profileOutput)
                processor->outputTrimDb.store(0);
            processor->reverbReturnMode.store(1);
            processor->prepareToPlay(rate, frames);
            const int channels = juce::jmax(2, processor->getTotalNumOutputChannels());
            juce::AudioBuffer<float> reverbBlock(channels, frames); outputs[variant].setSize(2, length);
            for (int start = 0; start < processedLength; start += frames)
            {
                const int count = juce::jmin(frames, processedLength - start);
                reverbBlock.setSize(channels, count, false, false, true); reverbBlock.clear(); midi.clear();
                for (int channel = 0; channel < 2; ++channel) reverbBlock.copyFrom(channel, 0, cachedUpstream, channel, start, count);
                processor->processBlock(reverbBlock, midi);
                const int first = juce::jmax(start, latency), end = juce::jmin(start + count, length + latency);
                if (end > first) for (int channel = 0; channel < 2; ++channel)
                    outputs[variant].copyFrom(channel, first - latency, reverbBlock, channel, first - start, end - first);
            }
            processor->releaseResources();
        }
        auto* files = new juce::DynamicObject(); auto* peaks = new juce::DynamicObject();
        auto* unityCounts = new juce::DynamicObject(); auto* boundCounts = new juce::DynamicObject();
        bool finite = true; double scalingError = 0, dryEnergy = 0, wetEnergy = 0;
        for (size_t variant = 0; variant < outputs.size(); ++variant)
        {
            const auto filename = juce::String(type).paddedLeft('0', 2) + "-" + labels[variant] + ".wav";
            files->setProperty(labels[variant], filename); written = writeProbeWave(directory.getChildFile(filename), outputs[variant], rate) && written;
            double peak = 0; juce::int64 unity = 0, bound = 0;
            for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < length; ++sample)
            {
                const double value = outputs[variant].getSample(channel, sample); finite = std::isfinite(value) && finite;
                peak = juce::jmax(peak, std::abs(value)); if (std::abs(value) > 1) ++unity; if (std::abs(value) >= 4) ++bound;
            }
            peaks->setProperty(labels[variant], peak); unityCounts->setProperty(labels[variant], unity); boundCounts->setProperty(labels[variant], bound);
            allBoundSamples += bound;
        }
        for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < length; ++sample)
        {
            const double dry = outputs[0].getSample(channel, sample), full = outputs[4].getSample(channel, sample) - dry;
            dryEnergy += dry * dry; wetEnergy += full * full;
            for (size_t variant = 1; variant < 4; ++variant)
                scalingError = juce::jmax(scalingError, std::abs(outputs[variant].getSample(channel, sample) - dry - wetLevels[variant] * full));
        }
        // Fixed scaling is only asserted when no final safety bound is active;
        // clipping and absolute level remain reported diagnostics.
        bool bounded = false; for (const auto* label : labels) bounded = static_cast<juce::int64>(boundCounts->getProperty(label)) > 0 || bounded;
        const bool rowPass = built && written && finite && dryEnergy > 0 && wetEnergy > 0 && (bounded || scalingError < 5e-5);
        auto* row = new juce::DynamicObject(); row->setProperty("type", type);
        row->setProperty("typeName", type < 27 ? juce::String(originalNames[static_cast<size_t>(type)]) : juce::String(BuiltInRetroReverb::names[static_cast<size_t>(type - 27)]));
        row->setProperty("outputTrimDb",profileOutput?voice.outputTrimDb:0); row->setProperty("presetName", voice.name); row->setProperty("stateFile", stateFile); row->setProperty("files", juce::var(files)); row->setProperty("peaks", juce::var(peaks));
        row->setProperty("samplesAboveUnityDiagnostic", juce::var(unityCounts)); row->setProperty("samplesAtSafetyBoundDiagnostic", juce::var(boundCounts));
        row->setProperty("wetScalingMaxError", scalingError); row->setProperty("wetScalingAssertion", bounded ? "not_asserted_when_safety_bound_active" : "pass_or_fail");
        row->setProperty("dryRmsFullWindow", std::sqrt(dryEnergy / (2 * length))); row->setProperty("wet100ResidualRmsFullWindowDiagnostic", std::sqrt(wetEnergy / (2 * length)));
        row->setProperty("finite", finite); row->setProperty("filesWritten", written); row->setProperty("pass", rowPass);
        maximumScalingError = juce::jmax(maximumScalingError, scalingError); passed = rowPass && passed; rows.add(juce::var(row));
        auto* progress = new juce::DynamicObject(); progress->setProperty("completed", rows.size()); progress->setProperty("total", 41);
        progress->setProperty("type", type); progress->setProperty("pass", rowPass); progress->setProperty("utc", juce::Time::getCurrentTime().toISO8601(true));
        directory.getParentDirectory().getChildFile("progress.json").replaceWithText(juce::JSON::toString(juce::var(progress), true));
    }
    result->setProperty("cases", rows); result->setProperty("caseCount", rows.size()); result->setProperty("mixedFileCount", rows.size() * 5);
    result->setProperty("maximumWetScalingError", maximumScalingError); result->setProperty("samplesAtSafetyBoundDiagnostic", allBoundSamples);
    result->setProperty("pass", passed); return juce::var(result);
}
