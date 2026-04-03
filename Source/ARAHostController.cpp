#include "ARAHostController.h"

ARAHostController::ARAHostController() = default;

ARAHostController::~ARAHostController()
{
    shutdown();
}

#if S13_HAS_ARA

namespace
{
juce::String araContentTypeToString(ARA::ARAContentType type)
{
    switch (type)
    {
        case ARA::kARAContentTypeNotes: return "Notes";
        case ARA::kARAContentTypeTempoEntries: return "TempoEntries";
        case ARA::kARAContentTypeBarSignatures: return "BarSignatures";
        case ARA::kARAContentTypeStaticTuning: return "StaticTuning";
        case ARA::kARAContentTypeKeySignatures: return "KeySignatures";
        case ARA::kARAContentTypeSheetChords: return "SheetChords";
        default: return "Type" + juce::String(static_cast<int>(type));
    }
}
}

// =============================================================================
// ARA Host Interface Implementations
// =============================================================================

ARA::ARAAudioReaderHostRef
ARAHostController::S13AudioAccessController::createAudioReaderForSource (
    ARA::ARAAudioSourceHostRef audioSourceHostRef,
    bool use64BitSamples) noexcept
{
    auto reader = std::make_unique<AudioReader>();
    reader->sourceHostRef = audioSourceHostRef;
    reader->use64Bit = use64BitSamples;
    auto ref = ReaderConverter::toHostRef (reader.get());
    auto* ptr = reader.get();
    audioReaders.emplace (ptr, std::move (reader));

    logARADebugLine("ARA: createAudioReaderForSource called (use64Bit="
        + juce::String(use64BitSamples ? 1 : 0) + ")");

    return ref;
}

bool ARAHostController::S13AudioAccessController::readAudioSamples (
    ARA::ARAAudioReaderHostRef readerRef,
    ARA::ARASamplePosition samplePosition,
    ARA::ARASampleCount samplesPerChannel,
    void* const* buffers) noexcept
{
    auto* readerEntry = ReaderConverter::fromHostRef (readerRef);
    if (! readerEntry) return false;

    using SourceConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAAudioSourceHostRef>;
    auto* sourceEntry = SourceConverter::fromHostRef (readerEntry->sourceHostRef);
    if (! sourceEntry || ! sourceEntry->reader) return false;

    static int araReadCount = 0;
    if (araReadCount < 5)
    {
        logARADebugLine("ARA readAudioSamples: pos=" + juce::String (samplePosition)
            + " count=" + juce::String (samplesPerChannel)
            + " ch=" + juce::String (sourceEntry->reader->numChannels)
            + " len=" + juce::String (sourceEntry->reader->lengthInSamples)
            + " sr=" + juce::String (sourceEntry->reader->sampleRate));
        ++araReadCount;
    }

    if (readerEntry->use64Bit)
        return false;

    int nativeChannels = sourceEntry->nativeChannelCount > 0
        ? sourceEntry->nativeChannelCount
        : static_cast<int> (sourceEntry->reader->numChannels);
    int exposedChannels = sourceEntry->exposedChannelCount > 0
        ? sourceEntry->exposedChannelCount
        : nativeChannels;
    int numSamples  = static_cast<int> (samplesPerChannel);

    // Fast path: serve from pre-loaded memory buffer (no disk I/O, no heap alloc)
    if (sourceEntry->preloaded)
    {
        const auto& audio = sourceEntry->preloadedAudio;
        int srcLen = audio.getNumSamples();
        int srcCh  = audio.getNumChannels();

        // Clamp read range to available data
        int startSample = static_cast<int> (samplePosition);
        int available = (startSample >= 0 && startSample < srcLen)
            ? juce::jmin (numSamples, srcLen - startSample) : 0;

        if (exposedChannels == 1)
        {
            auto* dest = static_cast<float*> (buffers[0]);
            if (srcCh <= 1)
            {
                if (available > 0)
                    std::memcpy (dest, audio.getReadPointer (0) + startSample,
                                 static_cast<size_t> (available) * sizeof (float));
                if (available < numSamples)
                    std::memset (dest + available, 0,
                                 static_cast<size_t> (numSamples - available) * sizeof (float));
            }
            else
            {
                const float invCh = 1.0f / static_cast<float> (srcCh);
                for (int s = 0; s < available; ++s)
                {
                    float mono = 0.0f;
                    for (int ch = 0; ch < srcCh; ++ch)
                        mono += audio.getSample (ch, startSample + s);
                    dest[s] = mono * invCh;
                }
                if (available < numSamples)
                    std::memset (dest + available, 0,
                                 static_cast<size_t> (numSamples - available) * sizeof (float));
            }
        }
        else
        {
            for (int ch = 0; ch < juce::jmin (srcCh, exposedChannels); ++ch)
            {
                auto* dest = static_cast<float*> (buffers[ch]);
                if (available > 0)
                    std::memcpy (dest, audio.getReadPointer (ch) + startSample,
                                 static_cast<size_t> (available) * sizeof (float));
                if (available < numSamples)
                    std::memset (dest + available, 0,
                                 static_cast<size_t> (numSamples - available) * sizeof (float));
            }
        }

        return true;
    }

    // Fallback: disk-backed read (only used if pre-load failed)
    juce::AudioBuffer<float> tempBuffer (nativeChannels, numSamples);
    sourceEntry->reader->read (&tempBuffer, 0, numSamples,
                                samplePosition, true, nativeChannels > 1);

    if (exposedChannels == 1)
    {
        auto* dest = static_cast<float*> (buffers[0]);
        if (nativeChannels <= 1)
        {
            std::memcpy (dest, tempBuffer.getReadPointer (0),
                         static_cast<size_t> (numSamples) * sizeof (float));
        }
        else
        {
            const float invChannelCount = 1.0f / static_cast<float> (nativeChannels);
            for (int sample = 0; sample < numSamples; ++sample)
            {
                float monoSample = 0.0f;
                for (int ch = 0; ch < nativeChannels; ++ch)
                    monoSample += tempBuffer.getSample (ch, sample);
                dest[sample] = monoSample * invChannelCount;
            }
        }
    }
    else
    {
        for (int ch = 0; ch < juce::jmin (nativeChannels, exposedChannels); ++ch)
        {
            auto* dest = static_cast<float*> (buffers[ch]);
            std::memcpy (dest, tempBuffer.getReadPointer (ch),
                         static_cast<size_t> (numSamples) * sizeof (float));
        }
    }

    return true;
}

void ARAHostController::S13AudioAccessController::destroyAudioReader (
    ARA::ARAAudioReaderHostRef readerRef) noexcept
{
    audioReaders.erase (ReaderConverter::fromHostRef (readerRef));
}

// Archiving Controller
ARA::ARASize ARAHostController::S13ArchivingController::getArchiveSize (
    ARA::ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
{
    return static_cast<ARA::ARASize> (ReaderConverter::fromHostRef (archiveReaderHostRef)->getSize());
}

bool ARAHostController::S13ArchivingController::readBytesFromArchive (
    ARA::ARAArchiveReaderHostRef archiveReaderHostRef,
    ARA::ARASize position, ARA::ARASize length,
    ARA::ARAByte* buffer) noexcept
{
    auto* block = ReaderConverter::fromHostRef (archiveReaderHostRef);
    if (position + length <= block->getSize())
    {
        std::memcpy (buffer, juce::addBytesToPointer (block->getData(), position), length);
        return true;
    }
    return false;
}

bool ARAHostController::S13ArchivingController::writeBytesToArchive (
    ARA::ARAArchiveWriterHostRef archiveWriterHostRef,
    ARA::ARASize position, ARA::ARASize length,
    const ARA::ARAByte* buffer) noexcept
{
    auto* stream = WriterConverter::fromHostRef (archiveWriterHostRef);
    if (stream->setPosition (static_cast<juce::int64> (position)) && stream->write (buffer, length))
        return true;
    return false;
}

void ARAHostController::S13ArchivingController::notifyDocumentArchivingProgress (float) noexcept {}
void ARAHostController::S13ArchivingController::notifyDocumentUnarchivingProgress (float) noexcept {}

ARA::ARAPersistentID ARAHostController::S13ArchivingController::getDocumentArchiveID (
    ARA::ARAArchiveReaderHostRef) noexcept
{
    return "studio13-ara-archive-v1";
}

// Content Access Controller
bool ARAHostController::S13ContentAccessController::isMusicalContextContentAvailable (
    ARA::ARAMusicalContextHostRef, ARA::ARAContentType type) noexcept
{
    return type == ARA::kARAContentTypeTempoEntries || type == ARA::kARAContentTypeBarSignatures;
}

ARA::ARAContentGrade ARAHostController::S13ContentAccessController::getMusicalContextContentGrade (
    ARA::ARAMusicalContextHostRef, ARA::ARAContentType) noexcept
{
    return ARA::kARAContentGradeInitial;
}

ARA::ARAContentReaderHostRef
ARAHostController::S13ContentAccessController::createMusicalContextContentReader (
    ARA::ARAMusicalContextHostRef, ARA::ARAContentType type,
    const ARA::ARAContentTimeRange*) noexcept
{
    return Converter::toHostRef (type);
}

bool ARAHostController::S13ContentAccessController::isAudioSourceContentAvailable (
    ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept
{
    return false;
}

ARA::ARAContentGrade ARAHostController::S13ContentAccessController::getAudioSourceContentGrade (
    ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept
{
    return ARA::kARAContentGradeInitial;
}

ARA::ARAContentReaderHostRef
ARAHostController::S13ContentAccessController::createAudioSourceContentReader (
    ARA::ARAAudioSourceHostRef, ARA::ARAContentType,
    const ARA::ARAContentTimeRange*) noexcept
{
    return nullptr;
}

ARA::ARAInt32 ARAHostController::S13ContentAccessController::getContentReaderEventCount (
    ARA::ARAContentReaderHostRef contentReaderHostRef) noexcept
{
    auto contentType = Converter::fromHostRef (contentReaderHostRef);
    if (contentType == ARA::kARAContentTypeTempoEntries || contentType == ARA::kARAContentTypeBarSignatures)
        return 2;
    return 0;
}

const void* ARAHostController::S13ContentAccessController::getContentReaderDataForEvent (
    ARA::ARAContentReaderHostRef contentReaderHostRef,
    ARA::ARAInt32 eventIndex) noexcept
{
    if (Converter::fromHostRef (contentReaderHostRef) == ARA::kARAContentTypeTempoEntries)
    {
        if (eventIndex == 0)
        {
            tempoEntry.timePosition = 0.0;
            tempoEntry.quarterPosition = 0.0;
        }
        else if (eventIndex == 1)
        {
            tempoEntry.timePosition = 60.0 / bpm;  // One beat duration
            tempoEntry.quarterPosition = 1.0;
        }
        return &tempoEntry;
    }
    else if (Converter::fromHostRef (contentReaderHostRef) == ARA::kARAContentTypeBarSignatures)
    {
        barSignature.position = (eventIndex == 0) ? 0.0 : static_cast<double> (timeSigNum);
        barSignature.numerator = timeSigNum;
        barSignature.denominator = timeSigDenom;
        return &barSignature;
    }

    return nullptr;
}

void ARAHostController::S13ContentAccessController::destroyContentReader (
    ARA::ARAContentReaderHostRef) noexcept {}

// Model Update Controller
void ARAHostController::S13ModelUpdateController::notifyAudioSourceAnalysisProgress (
    ARA::ARAAudioSourceHostRef, ARA::ARAAnalysisProgressState state, float value) noexcept
{
    analysisProgress.store (value);
    owner.debugAnalysisStarted.store(true, std::memory_order_release);
    owner.debugLastAnalysisProgressValue.store(value, std::memory_order_release);

    const int bucket = static_cast<int>(value * 20.0f);
    const int previousBucket = lastLoggedAnalysisBucket.exchange(bucket);
    if (bucket != previousBucket || state == ARA::kARAAnalysisProgressCompleted)
    {
        owner.noteDebugOperation("analysis_progress_state_" + juce::String(static_cast<int>(state)), {});
        logARADebugLine(juce::String("ARA model update: type=analysis_progress")
            + " state=" + juce::String(static_cast<int>(state))
            + " value=" + juce::String(value, 3));
    }

    if (state == ARA::kARAAnalysisProgressCompleted)
        analysisComplete.store (true);
}

void ARAHostController::S13ModelUpdateController::notifyAudioSourceContentChanged (
    ARA::ARAAudioSourceHostRef audioSourceHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept
{
    using SrcConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAAudioSourceHostRef>;
    auto* entry = SrcConverter::fromHostRef(audioSourceHostRef);
    owner.noteEditDrivenDebugEvent("notifyAudioSourceContentChanged", entry != nullptr ? entry->clipId : juce::String());
}
void ARAHostController::S13ModelUpdateController::notifyAudioModificationContentChanged (
    ARA::ARAAudioModificationHostRef audioModificationHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept
{
    using ModConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAAudioModificationHostRef>;
    auto* entry = ModConverter::fromHostRef(audioModificationHostRef);
    owner.noteEditDrivenDebugEvent("notifyAudioModificationContentChanged", entry != nullptr ? entry->clipId : juce::String());
}
void ARAHostController::S13ModelUpdateController::notifyPlaybackRegionContentChanged (
    ARA::ARAPlaybackRegionHostRef playbackRegionHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept
{
    using RegConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAPlaybackRegionHostRef>;
    auto* entry = RegConverter::fromHostRef(playbackRegionHostRef);
    owner.noteEditDrivenDebugEvent("notifyPlaybackRegionContentChanged", entry != nullptr ? entry->clipId : juce::String());
}

// Playback Controller
void ARAHostController::S13PlaybackController::requestStartPlayback() noexcept
{
    owner.requestStartPlaybackFromPlugin();
}

void ARAHostController::S13PlaybackController::requestStopPlayback() noexcept
{
    owner.requestStopPlaybackFromPlugin();
}

void ARAHostController::S13PlaybackController::requestSetPlaybackPosition (ARA::ARATimePosition timePosition) noexcept
{
    owner.requestSetPlaybackPositionFromPlugin(static_cast<double> (timePosition));
}

void ARAHostController::S13PlaybackController::requestSetCycleRange (ARA::ARATimePosition startTime,
                                                                     ARA::ARATimeDuration duration) noexcept
{
    owner.requestSetCycleRangeFromPlugin(static_cast<double> (startTime),
                                         static_cast<double> (duration));
}

void ARAHostController::S13PlaybackController::requestEnableCycle (bool enable) noexcept
{
    owner.requestEnableCycleFromPlugin(enable);
}

// =============================================================================
// Main ARA Host Controller Implementation
// =============================================================================

void ARAHostController::initializeForPlugin (juce::AudioPluginInstance* plugin,
                                              double sampleRate, int blockSize,
                                              std::function<void (bool, bool, const juce::String&)> onComplete)
{
    if (! plugin)
    {
        if (onComplete) onComplete (false, false, "Invalid plugin instance.");
        return;
    }

    shutdown(); // Clean up any previous state

    araProcessor = plugin;
    currentSampleRate = sampleRate;
    currentBlockSize = blockSize;
    pluginInputChannelCount = juce::jmax (1,
        juce::jmax (plugin->getMainBusNumInputChannels(), plugin->getTotalNumInputChannels()));

    // Use JUCE's async factory creation to get ARA factory from plugin
    juce::createARAFactoryAsync (*plugin, [this, onComplete] (juce::ARAFactoryWrapper factory) {
        completeInitialization (std::move (factory), onComplete);
    });
}

void ARAHostController::completeInitialization (juce::ARAFactoryWrapper factory,
                                                 std::function<void (bool, bool, const juce::String&)> onComplete)
{
    if (! factory.get())
    {
        juce::Logger::writeToLog ("ARAHostController: Plugin does not support ARA.");
        if (onComplete) onComplete (false, false, {});
        return;
    }

    try
    {
        // Create the host-side controllers (we keep raw pointers before moving ownership)
        auto audioAccess = std::make_unique<S13AudioAccessController>();
        auto archiving = std::make_unique<S13ArchivingController>();
        auto contentAccess = std::make_unique<S13ContentAccessController>();
        auto modelUpdate = std::make_unique<S13ModelUpdateController>(*this);
        auto playbackCtrl = std::make_unique<S13PlaybackController>(*this);
        requestedAnalysisContentTypes.clear();

        const auto* araFactory = factory.get();
        if (araFactory != nullptr && araFactory->analyzeableContentTypesCount > 0 && araFactory->analyzeableContentTypes != nullptr)
        {
            requestedAnalysisContentTypes.assign(araFactory->analyzeableContentTypes,
                                                 araFactory->analyzeableContentTypes + araFactory->analyzeableContentTypesCount);
            logARADebugLine("ARA: plugin analyzeable content types=" + describeRequestedAnalysisContentTypes());
        }
        else
        {
            logARADebugLine("ARA: plugin reports no analyzeable content types");
        }

        audioAccessControllerPtr = audioAccess.get();
        archivingControllerPtr = archiving.get();
        contentAccessControllerPtr = contentAccess.get();
        modelUpdateControllerPtr = modelUpdate.get();
        playbackControllerPtr = playbackCtrl.get();

        // Create the JUCE ARA document controller (takes ownership of controllers)
        araDocController = juce::ARAHostDocumentController::create (
            std::move (factory),
            "OpenStudio Document",
            std::move (audioAccess),
            std::move (archiving),
            std::move (contentAccess),
            std::move (modelUpdate),
            std::move (playbackCtrl));

        if (! araDocController)
        {
            juce::Logger::writeToLog ("ARAHostController: Failed to create ARA document controller.");
            if (onComplete) onComplete (false, true, "Failed to create ARA document controller.");
            return;
        }

        auto& dc = araDocController->getDocumentController();

        // Create musical context
        {
            juce::ARAEditGuard editGuard (dc);

            auto mcProps = ARAHostModel::MusicalContext::getEmptyProperties();
            mcProps.name = "OpenStudio Musical Context";
            mcProps.orderIndex = 0;
            mcProps.color = nullptr;

            using MCConverter = ARAHostModel::ConversionFunctions<ARAHostController*, ARA::ARAMusicalContextHostRef>;
            musicalContext = std::make_unique<ARAHostModel::MusicalContext> (
                MCConverter::toHostRef (this), dc, mcProps);

            // Create region sequence (represents the track)
            auto rsProps = ARAHostModel::RegionSequence::getEmptyProperties();
            rsProps.name = "Track";
            rsProps.orderIndex = 0;
            rsProps.musicalContextRef = musicalContext->getPluginRef();
            rsProps.color = nullptr;

            using RSConverter = ARAHostModel::ConversionFunctions<ARAHostController*, ARA::ARARegionSequenceHostRef>;
            regionSequence = std::make_unique<ARAHostModel::RegionSequence> (
                RSConverter::toHostRef (this), dc, rsProps);
        }

        // Bind the document to the plugin instance with all ARA roles assigned.
        // RePitch and similar ARA editors need the editor renderer + editor view
        // roles, not just playback rendering, otherwise the editor can open with
        // an empty document even though clip attach succeeded.
        const auto allRoles = ARA::kARAPlaybackRendererRole
                            | ARA::kARAEditorRendererRole
                            | ARA::kARAEditorViewRole;

        pluginExtension = araDocController->bindDocumentToPluginInstance (
            *araProcessor,
            allRoles,
            allRoles);

        logARADebugLine("ARA binding: valid=" + juce::String (pluginExtension.isValid() ? 1 : 0));

        if (pluginExtension.isValid())
        {
            playbackRenderer = std::make_unique<ARAHostModel::PlaybackRendererInterface> (
                pluginExtension.getPlaybackRendererInterface());
            editorRenderer = std::make_unique<ARAHostModel::EditorRendererInterface> (
                pluginExtension.getEditorRendererInterface());

            logARADebugLine("ARA interfaces: playbackValid="
                + juce::String (playbackRenderer != nullptr && playbackRenderer->isValid() ? 1 : 0)
                + " editorValid="
                + juce::String (editorRenderer != nullptr && editorRenderer->isValid() ? 1 : 0));
        }

        // NOTE: Do NOT override the plugin's playhead here. The host (AudioEngine)
        // sets the playhead via plugin->setPlayHead(this) before ARA init, providing
        // full position info (BPM, PPQ, time sig, isPlaying, etc.) that ARA plugins
        // need. Overriding it with a local SimplePlayHead that never gets updated
        // causes the ARA renderer to always see pos=0/not-playing → empty editor.

        araActive = true;
        juce::Logger::writeToLog ("ARAHostController: Initialized successfully for ARA plugin.");
        if (onComplete) onComplete (true, true, {});
    }
    catch (const std::exception& e)
    {
        juce::Logger::writeToLog ("ARAHostController: Exception during init: " + juce::String (e.what()));
        if (onComplete) onComplete (false, true, juce::String (e.what()));
    }
}

juce::String ARAHostController::addAudioSource (const juce::File& audioFile,
                                                  const juce::String& clipId,
                                                  double startTimeInTrack,
                                                  double duration,
                                                  double offsetInSource)
{
    if (! araActive || ! araDocController) return {};

    // Remove existing source with same clipId
    removeAudioSource (clipId);

    auto entry = std::make_unique<ARASourceEntry>();
    entry->clipId = clipId;
    entry->audioFile = audioFile;

    // Create audio format reader for the file
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    entry->reader.reset (fmtMgr.createReaderFor (audioFile));
    if (! entry->reader)
    {
        juce::Logger::writeToLog ("ARAHostController: Failed to create reader for: " + audioFile.getFullPathName());
        return {};
    }
    entry->nativeChannelCount = static_cast<int> (entry->reader->numChannels);
    entry->exposedChannelCount = (pluginInputChannelCount <= 1)
        ? 1
        : juce::jmax (1, entry->nativeChannelCount);

    // Pre-load entire file into memory so readAudioSamples() can serve from
    // RAM instead of hitting the disk on the audio thread.
    {
        int fileCh = entry->nativeChannelCount;
        auto fileLen = static_cast<int> (entry->reader->lengthInSamples);
        entry->preloadedAudio.setSize (fileCh, fileLen);
        entry->reader->read (&entry->preloadedAudio, 0, fileLen, 0, true, fileCh > 1);
        entry->preloaded = true;
        juce::Logger::writeToLog ("ARAHostController: pre-loaded " + juce::String (fileLen)
            + " samples x " + juce::String (fileCh) + " channels ("
            + juce::String (fileLen * fileCh * sizeof(float) / (1024 * 1024)) + " MB)");
    }

    entry->startTimeInTrack = startTimeInTrack;
    entry->duration = duration;
    entry->offsetInSource = offsetInSource;

    auto& dc = araDocController->getDocumentController();

    auto araLog = [] (const juce::String& msg) { logARADebugLine(msg); };

    try
    {
        // =====================================================================
        // Step 1: Create all ARA model objects inside edit guard
        // =====================================================================
        {
            juce::ARAEditGuard editGuard (dc);

            // Create audio source
            auto srcProps = ARAHostModel::AudioSource::getEmptyProperties();
            srcProps.name = audioFile.getFullPathName().toRawUTF8();
            srcProps.persistentID = clipId.toRawUTF8();
            srcProps.sampleCount = entry->reader->lengthInSamples;
            srcProps.sampleRate = entry->reader->sampleRate;
            srcProps.channelCount = entry->exposedChannelCount;
            srcProps.merits64BitSamples = false;

            using SrcConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAAudioSourceHostRef>;
            entry->audioSource = std::make_unique<ARAHostModel::AudioSource> (
                SrcConverter::toHostRef (entry.get()), dc, srcProps);

            // NOTE: Do NOT call enableAudioSourceSamplesAccess() here inside
            // the edit guard — the ARA spec forbids it within editing brackets.
            // It is called after the edit guard closes (see Step 1b below).

            // Create audio modification
            auto modProps = ARAHostModel::AudioModification::getEmptyProperties();
            modProps.persistentID = (clipId + "_mod").toRawUTF8();

            using ModConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAAudioModificationHostRef>;
            entry->audioModification = std::make_unique<ARAHostModel::AudioModification> (
                ModConverter::toHostRef (entry.get()), dc,
                *entry->audioSource, modProps);

            // Create playback region
            auto regionProps = ARAHostModel::PlaybackRegion::getEmptyProperties();
            regionProps.transformationFlags = ARA::kARAPlaybackTransformationNoChanges;
            regionProps.startInModificationTime = offsetInSource;
            regionProps.durationInModificationTime = duration;
            regionProps.startInPlaybackTime = startTimeInTrack;
            regionProps.durationInPlaybackTime = duration;
            regionProps.musicalContextRef = musicalContext->getPluginRef();
            regionProps.regionSequenceRef = regionSequence->getPluginRef();
            regionProps.name = nullptr;
            regionProps.color = nullptr;

            using RegConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAPlaybackRegionHostRef>;
            entry->playbackRegion = std::make_unique<ARAHostModel::PlaybackRegion> (
                RegConverter::toHostRef (entry.get()), dc,
                *entry->audioModification, regionProps);

            araLog ("ARA: created source + modification + region inside edit guard");
        }
        // =====================================================================
        // Edit guard released — document is now in a stable state
        // =====================================================================

        // =====================================================================
        // Step 1b: Enable audio samples access OUTSIDE the edit guard.
        // ARA spec: enableAudioSourceSamplesAccess must NOT be called within
        // an editing bracket. Without this, the plugin cannot read audio and
        // analysis will never start (editor stays empty).
        // =====================================================================
        entry->audioSource->enableAudioSourceSamplesAccess (true);
        debugSamplesAccessEnabledCount.fetch_add(1, std::memory_order_acq_rel);
        araLog ("ARA: enableAudioSourceSamplesAccess(true) for " + clipId);

        // =====================================================================
        // Step 2: Add region to BOTH renderers
        // Note: NOT deactivating the plugin here — in our architecture the plugin
        // is in the audio graph and releaseResources() triggers device restarts
        // which cascade and prevent ARA analysis from ever starting.
        // =====================================================================
        if (playbackRenderer && playbackRenderer->isValid())
            playbackRenderer->add (*entry->playbackRegion);

        if (editorRenderer && editorRenderer->isValid())
            editorRenderer->add (*entry->playbackRegion);

        araLog ("ARA: added region to playbackRenderer + editorRenderer");

        // =====================================================================
        // Step 3: Request analysis OUTSIDE the edit guard, after renderers updated
        // =====================================================================
        double srcSampleRate = entry->reader->sampleRate;
        int srcChannels = static_cast<int> (entry->reader->numChannels);
        auto srcLength = entry->reader->lengthInSamples;
        auto* sourceEntry = entry.get();
        sources[clipId] = std::move (entry);
        debugSourceCount.store(static_cast<int>(sources.size()), std::memory_order_release);
        debugPlaybackRegionCount.store(static_cast<int>(sources.size()), std::memory_order_release);
        noteDebugOperation("clip_attach", clipId);

        if (!requestedAnalysisContentTypes.empty())
        {
            debugAnalysisRequested.store(true, std::memory_order_release);
            debugAnalysisStarted.store(false, std::memory_order_release);
            debugLastAnalysisProgressValue.store(0.0f, std::memory_order_release);
            if (modelUpdateControllerPtr != nullptr)
            {
                modelUpdateControllerPtr->analysisProgress.store(0.0f, std::memory_order_release);
                modelUpdateControllerPtr->analysisComplete.store(false, std::memory_order_release);
                modelUpdateControllerPtr->lastLoggedAnalysisBucket.store(-1, std::memory_order_release);
            }
            dc.requestAudioSourceContentAnalysis (
                sourceEntry->audioSource->getPluginRef(),
                static_cast<ARA::ARASize> (requestedAnalysisContentTypes.size()),
                requestedAnalysisContentTypes.data());

            araLog ("ARA: requestAudioSourceContentAnalysis called for " + clipId
                + " contentTypes=" + describeRequestedAnalysisContentTypes());
        }
        else
        {
            debugAnalysisRequested.store(false, std::memory_order_release);
            debugAnalysisStarted.store(false, std::memory_order_release);
            debugLastAnalysisProgressValue.store(0.0f, std::memory_order_release);
            if (modelUpdateControllerPtr != nullptr)
            {
                modelUpdateControllerPtr->analysisProgress.store(0.0f, std::memory_order_release);
                modelUpdateControllerPtr->analysisComplete.store(false, std::memory_order_release);
                modelUpdateControllerPtr->lastLoggedAnalysisBucket.store(-1, std::memory_order_release);
            }
            araLog ("ARA: skipped analysis request for " + clipId + " because plugin exposed no analyzeable content types");
        }

        araLog ("ARA: addAudioSource complete — " + clipId
            + " sr=" + juce::String (srcSampleRate)
            + " ch=" + juce::String (srcChannels)
            + " len=" + juce::String (srcLength)
            + " file=" + audioFile.getFullPathName());
        return clipId;
    }
    catch (const std::exception& e)
    {
        araLog ("ARA: ERROR in addAudioSource: " + juce::String (e.what()));
        return {};
    }
}

void ARAHostController::removeAudioSource (const juce::String& clipId)
{
    auto it = sources.find (clipId);
    if (it == sources.end()) return;

    if (araDocController)
    {
        // Remove from both renderers first — stops the plugin from requesting
        // audio for this region during processBlock.
        if (playbackRenderer && playbackRenderer->isValid() && it->second->playbackRegion)
            playbackRenderer->remove (*it->second->playbackRegion);
        if (editorRenderer && editorRenderer->isValid() && it->second->playbackRegion)
            editorRenderer->remove (*it->second->playbackRegion);

        // Disable audio source access BEFORE destroying the source.
        // This tells the plugin to stop calling readAudioSamples for this
        // source. Without this, the plugin's internal threads may still be
        // reading from preloadedAudio when we destroy it → crash.
        if (it->second->audioSource)
            it->second->audioSource->enableAudioSourceSamplesAccess (false);

        // Destroy model objects inside edit guard (reverse order)
        auto& dc = araDocController->getDocumentController();
        juce::ARAEditGuard editGuard (dc);
        it->second->playbackRegion.reset();
        it->second->audioModification.reset();
        it->second->audioSource.reset();
    }

    sources.erase (it);
    debugSourceCount.store(static_cast<int>(sources.size()), std::memory_order_release);
    debugPlaybackRegionCount.store(static_cast<int>(sources.size()), std::memory_order_release);
    if (debugSamplesAccessEnabledCount.load(std::memory_order_acquire) > 0)
        debugSamplesAccessEnabledCount.fetch_sub(1, std::memory_order_acq_rel);
    noteDebugOperation("clip_remove", clipId);
}

void ARAHostController::updatePlaybackRegion (const juce::String& clipId,
                                                double startTimeInTrack,
                                                double duration,
                                                double offsetInSource)
{
    auto it = sources.find (clipId);
    if (it == sources.end() || ! araDocController) return;

    auto& entry = it->second;
    entry->startTimeInTrack = startTimeInTrack;
    entry->duration = duration;
    entry->offsetInSource = offsetInSource;

    auto regionProps = ARAHostModel::PlaybackRegion::getEmptyProperties();
    regionProps.transformationFlags = ARA::kARAPlaybackTransformationNoChanges;
    regionProps.startInModificationTime = offsetInSource;
    regionProps.durationInModificationTime = duration;
    regionProps.startInPlaybackTime = startTimeInTrack;
    regionProps.durationInPlaybackTime = duration;
    regionProps.musicalContextRef = musicalContext->getPluginRef();
    regionProps.regionSequenceRef = regionSequence->getPluginRef();
    regionProps.name = nullptr;
    regionProps.color = nullptr;

    entry->playbackRegion->update (regionProps);
    noteEditDrivenDebugEvent("updatePlaybackRegion", clipId);
}

void ARAHostController::processBlock (juce::AudioBuffer<float>& buffer, int numSamples,
                                       double playbackPositionSeconds, bool playing)
{
    // NOTE: This method is currently unused. The ARA plugin's processBlock() is
    // called through the normal FX chain in TrackProcessor::processBlock() via
    // safeProcessFX(). The plugin's playhead is set to AudioEngine (which provides
    // full position info), so no manual playhead update is needed here.
    // Kept for potential future use (e.g., custom ARA rendering paths).
    if (! araActive || ! araProcessor) return;
    juce::ignoreUnused (numSamples, playbackPositionSeconds, playing);
}

juce::MemoryBlock ARAHostController::saveState() const
{
    juce::MemoryBlock stateData;

    if (! araActive || ! araDocController) return stateData;

    auto& dc = araDocController->getDocumentController();

    // Use the ARA archiving interface to save document state
    juce::MemoryOutputStream stream (stateData, false);
    auto writerRef = S13ArchivingController::WriterConverter::toHostRef (&stream);
    dc.storeDocumentToArchive (writerRef);

    return stateData;
}

bool ARAHostController::restoreState (const juce::MemoryBlock& data)
{
    if (! araActive || ! araDocController || data.getSize() == 0) return false;

    auto& dc = araDocController->getDocumentController();

    auto dataCopy = data; // Need non-const
    auto readerRef = S13ArchivingController::ReaderConverter::toHostRef (&dataCopy);
    bool ok = dc.beginRestoringDocumentFromArchive (readerRef);
    if (ok)
        ok = dc.endRestoringDocumentFromArchive (readerRef);
    return ok;
}

void ARAHostController::shutdown()
{
    if (! araActive) return;

    // Remove all sources (in reverse order of creation)
    while (! sources.empty())
    {
        auto it = sources.begin();
        removeAudioSource (it->first);
    }

    // Destroy ARA objects in reverse order
    editorRenderer.reset();
    playbackRenderer.reset();
    regionSequence.reset();
    musicalContext.reset();
    araDocController.reset();
    requestedAnalysisContentTypes.clear();

    // Clear raw pointers (owned by araDocController, now destroyed)
    audioAccessControllerPtr = nullptr;
    archivingControllerPtr = nullptr;
    contentAccessControllerPtr = nullptr;
    modelUpdateControllerPtr = nullptr;
    playbackControllerPtr = nullptr;

    araProcessor = nullptr;
    araActive = false;
    pluginInputChannelCount = 0;
    debugAnalysisRequested.store(false, std::memory_order_release);
    debugAnalysisStarted.store(false, std::memory_order_release);
    debugLastAnalysisProgressValue.store(0.0f, std::memory_order_release);
    debugSourceCount.store(0, std::memory_order_release);
    debugPlaybackRegionCount.store(0, std::memory_order_release);
    debugSamplesAccessEnabledCount.store(0, std::memory_order_release);

    juce::Logger::writeToLog ("ARAHostController: Shut down.");
}

juce::AudioProcessorEditor* ARAHostController::createEditor()
{
    if (! araActive || ! araProcessor) return nullptr;
    if (! araProcessor->hasEditor()) return nullptr;
    return araProcessor->createEditor();
}

void ARAHostController::updateMusicalContext (double bpm, int timeSigNumerator, int timeSigDenominator)
{
    if (contentAccessControllerPtr)
    {
        contentAccessControllerPtr->bpm = bpm;
        contentAccessControllerPtr->timeSigNum = timeSigNumerator;
        contentAccessControllerPtr->timeSigDenom = timeSigDenominator;
    }

    // Notify ARA that musical context has changed
    if (araDocController && musicalContext)
    {
        auto& dc = araDocController->getDocumentController();
        juce::ARAEditGuard editGuard (dc);

        auto mcProps = ARAHostModel::MusicalContext::getEmptyProperties();
        mcProps.name = "OpenStudio Musical Context";
        mcProps.orderIndex = 0;
        mcProps.color = nullptr;
        musicalContext->update (mcProps);
    }
}

void ARAHostController::setPlaybackRequestHandlers(PlaybackRequestHandlers handlers)
{
    playbackRequestHandlers = std::move(handlers);
}

float ARAHostController::getAnalysisProgress() const
{
#if S13_HAS_ARA
    return modelUpdateControllerPtr != nullptr
        ? modelUpdateControllerPtr->analysisProgress.load()
        : 0.0f;
#else
    return 0.0f;
#endif
}

bool ARAHostController::isAnalysisComplete() const
{
#if S13_HAS_ARA
    return modelUpdateControllerPtr != nullptr
        ? modelUpdateControllerPtr->analysisComplete.load()
        : false;
#else
    return false;
#endif
}

ARAHostController::DebugSnapshot ARAHostController::getDebugSnapshot() const
{
    DebugSnapshot snapshot;
    snapshot.analysisProgress = getAnalysisProgress();
    snapshot.analysisComplete = isAnalysisComplete();
    snapshot.analysisRequested = debugAnalysisRequested.load(std::memory_order_acquire);
    snapshot.analysisStarted = debugAnalysisStarted.load(std::memory_order_acquire);
    snapshot.lastAnalysisProgressValue = debugLastAnalysisProgressValue.load(std::memory_order_acquire);
    snapshot.sourceCount = debugSourceCount.load(std::memory_order_acquire);
    snapshot.playbackRegionCount = debugPlaybackRegionCount.load(std::memory_order_acquire);
    snapshot.audioSourceSamplesAccessEnabled = snapshot.sourceCount > 0
        && debugSamplesAccessEnabledCount.load(std::memory_order_acquire) >= snapshot.sourceCount;
    snapshot.editorRendererAttached = editorRenderer != nullptr && editorRenderer->isValid();
    snapshot.playbackRendererAttached = playbackRenderer != nullptr && playbackRenderer->isValid();
    snapshot.transportPlaying = debugTransportPlaying.load(std::memory_order_acquire);
    snapshot.transportPositionSeconds = debugTransportPositionSeconds.load(std::memory_order_acquire);
    snapshot.lastEditTimestampMs = debugLastEditTimestampMs.load(std::memory_order_acquire);
    snapshot.editGeneration = debugEditGeneration.load(std::memory_order_acquire);
    const auto lastPlaybackObservedEditGeneration = debugLastPlaybackObservedEditGeneration.load(std::memory_order_acquire);
    snapshot.hasPendingEditSinceLastPlay = snapshot.editGeneration > lastPlaybackObservedEditGeneration;
    const auto lastPlayStartTimestampMs = debugLastPlayStartTimestampMs.load(std::memory_order_acquire);
    if (lastPlayStartTimestampMs > 0.0)
        snapshot.timeSinceLastPlayStartMs = juce::Time::getMillisecondCounterHiRes() - lastPlayStartTimestampMs;

    const juce::ScopedLock sl(debugStateLock);
    snapshot.lastEditType = debugLastEditType;
    snapshot.lastOperation = debugLastOperation;
    snapshot.lastClipId = debugLastClipId;
    return snapshot;
}

void ARAHostController::updateTransportDebugState(bool playing, double positionSeconds)
{
    debugTransportPlaying.store(playing, std::memory_order_release);
    debugTransportPositionSeconds.store(positionSeconds, std::memory_order_release);
}

void ARAHostController::notePlaybackStart(double positionSeconds)
{
    debugTransportPlaying.store(true, std::memory_order_release);
    debugTransportPositionSeconds.store(positionSeconds, std::memory_order_release);
    debugLastPlayStartTimestampMs.store(juce::Time::getMillisecondCounterHiRes(), std::memory_order_release);
    debugLastPlaybackObservedEditGeneration.store(debugEditGeneration.load(std::memory_order_acquire), std::memory_order_release);
    noteDebugOperation("playback_start", {});
}

void ARAHostController::notePlaybackStop(double positionSeconds)
{
    debugTransportPlaying.store(false, std::memory_order_release);
    debugTransportPositionSeconds.store(positionSeconds, std::memory_order_release);
    noteDebugOperation("playback_stop", {});
}

void ARAHostController::noteDebugOperation(const juce::String& operationType, const juce::String& clipId)
{
    const juce::ScopedLock sl(debugStateLock);
    debugLastOperation = operationType;
    if (clipId.isNotEmpty())
        debugLastClipId = clipId;
}

void ARAHostController::noteEditDrivenDebugEvent(const juce::String& eventType, const juce::String& clipId)
{
    const double nowMs = juce::Time::getMillisecondCounterHiRes();
    debugLastEditTimestampMs.store(nowMs, std::memory_order_release);
    debugEditGeneration.fetch_add(1, std::memory_order_acq_rel);
    {
        const juce::ScopedLock sl(debugStateLock);
        debugLastEditType = eventType;
        debugLastOperation = "edit_driven_content_change";
        if (clipId.isNotEmpty())
            debugLastClipId = clipId;
    }

    const bool transportPlaying = debugTransportPlaying.load(std::memory_order_acquire);
    const double positionSeconds = debugTransportPositionSeconds.load(std::memory_order_acquire);
    const double lastPlayStartTimestampMs = debugLastPlayStartTimestampMs.load(std::memory_order_acquire);
    const double timeSinceLastPlayStartMs = lastPlayStartTimestampMs > 0.0
        ? juce::Time::getMillisecondCounterHiRes() - lastPlayStartTimestampMs
        : -1.0;

    logARADebugLine("ARA model update: type=" + eventType
        + " clipId=" + (clipId.isNotEmpty() ? clipId : juce::String("<none>"))
        + " transportPlaying=" + juce::String(transportPlaying ? "true" : "false")
        + " transportPosition=" + juce::String(positionSeconds, 3)
        + " timeSinceLastPlayStartMs=" + juce::String(timeSinceLastPlayStartMs, 2));
}

juce::String ARAHostController::describeRequestedAnalysisContentTypes() const
{
    juce::StringArray names;
    names.ensureStorageAllocated(static_cast<int>(requestedAnalysisContentTypes.size()));

    for (auto contentType : requestedAnalysisContentTypes)
        names.add(araContentTypeToString(contentType));

    return names.joinIntoString(",");
}

void ARAHostController::requestStartPlaybackFromPlugin() const
{
    if (!playbackRequestHandlers.startPlayback)
        return;

    juce::Logger::writeToLog("ARAHostController: Plugin requested start playback");
    auto handler = playbackRequestHandlers.startPlayback;
    juce::MessageManager::callAsync([handler]() { handler(); });
}

void ARAHostController::requestStopPlaybackFromPlugin() const
{
    if (!playbackRequestHandlers.stopPlayback)
        return;

    juce::Logger::writeToLog("ARAHostController: Plugin requested stop playback");
    auto handler = playbackRequestHandlers.stopPlayback;
    juce::MessageManager::callAsync([handler]() { handler(); });
}

void ARAHostController::requestSetPlaybackPositionFromPlugin(double timePosition) const
{
    if (!playbackRequestHandlers.setPlaybackPosition)
        return;

    juce::Logger::writeToLog("ARAHostController: Plugin requested playback position " + juce::String(timePosition));
    auto handler = playbackRequestHandlers.setPlaybackPosition;
    juce::MessageManager::callAsync([handler, timePosition]() { handler(timePosition); });
}

void ARAHostController::requestSetCycleRangeFromPlugin(double startTime, double duration) const
{
    if (!playbackRequestHandlers.setCycleRange)
        return;

    juce::Logger::writeToLog("ARAHostController: Plugin requested cycle range start="
        + juce::String(startTime) + " duration=" + juce::String(duration));
    auto handler = playbackRequestHandlers.setCycleRange;
    juce::MessageManager::callAsync([handler, startTime, duration]() { handler(startTime, duration); });
}

void ARAHostController::requestEnableCycleFromPlugin(bool enable) const
{
    if (!playbackRequestHandlers.enableCycle)
        return;

    juce::Logger::writeToLog("ARAHostController: Plugin requested cycle " + juce::String(enable ? "enable" : "disable"));
    auto handler = playbackRequestHandlers.enableCycle;
    juce::MessageManager::callAsync([handler, enable]() { handler(enable); });
}

#else // !S13_HAS_ARA

// Stub implementations when ARA is not available

void ARAHostController::initializeForPlugin (juce::AudioPluginInstance*, double, int,
                                              std::function<void (bool, bool, const juce::String&)> onComplete)
{
    juce::Logger::writeToLog ("ARAHostController: ARA support not compiled in.");
    if (onComplete) onComplete (false, false, "ARA support not compiled in.");
}

juce::String ARAHostController::addAudioSource (const juce::File&, const juce::String&,
                                                  double, double, double)
{ return {}; }

void ARAHostController::removeAudioSource (const juce::String&) {}

void ARAHostController::updatePlaybackRegion (const juce::String&, double, double, double) {}

void ARAHostController::processBlock (juce::AudioBuffer<float>&, int, double, bool) {}

juce::MemoryBlock ARAHostController::saveState() const { return {}; }
bool ARAHostController::restoreState (const juce::MemoryBlock&) { return false; }

void ARAHostController::shutdown() {}

juce::AudioProcessorEditor* ARAHostController::createEditor() { return nullptr; }

void ARAHostController::updateMusicalContext (double, int, int) {}

void ARAHostController::setPlaybackRequestHandlers(PlaybackRequestHandlers) {}

float ARAHostController::getAnalysisProgress() const { return 0.0f; }

bool ARAHostController::isAnalysisComplete() const { return false; }

ARAHostController::DebugSnapshot ARAHostController::getDebugSnapshot() const { return {}; }

void ARAHostController::updateTransportDebugState(bool, double) {}

void ARAHostController::notePlaybackStart(double) {}

void ARAHostController::notePlaybackStop(double) {}

#endif // S13_HAS_ARA
