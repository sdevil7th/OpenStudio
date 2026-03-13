#include "ARAHostController.h"

ARAHostController::ARAHostController() = default;

ARAHostController::~ARAHostController()
{
    shutdown();
}

#if S13_HAS_ARA

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

    // Find the source entry by matching hostRef
    using SourceConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAAudioSourceHostRef>;
    auto* sourceEntry = SourceConverter::fromHostRef (readerEntry->sourceHostRef);
    if (! sourceEntry || ! sourceEntry->reader) return false;

    if (readerEntry->use64Bit)
        return false;

    // Cast void* const* -> float* const* (safe: we know the plugin passes float buffers for 32-bit)
    auto* floatBuffers = static_cast<float* const*> (static_cast<const void*> (buffers));

    // MemoryMappedAudioFormatReader::read takes int** (non-const pointer array)
    // but only reads into them, so we need a temporary non-const array
    int numChannels = static_cast<int> (sourceEntry->reader->numChannels);
    std::vector<float*> channelPtrs (static_cast<size_t> (numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        channelPtrs[static_cast<size_t> (ch)] = const_cast<float*> (floatBuffers[ch]);

    return sourceEntry->reader->read (channelPtrs.data(), numChannels,
                                       samplePosition,
                                       static_cast<int> (samplesPerChannel));
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
    return nullptr;
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
    if (state == ARA::kARAAnalysisProgressCompleted)
        analysisComplete.store (true);
}

void ARAHostController::S13ModelUpdateController::notifyAudioSourceContentChanged (
    ARA::ARAAudioSourceHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept {}
void ARAHostController::S13ModelUpdateController::notifyAudioModificationContentChanged (
    ARA::ARAAudioModificationHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept {}
void ARAHostController::S13ModelUpdateController::notifyPlaybackRegionContentChanged (
    ARA::ARAPlaybackRegionHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept {}
void ARAHostController::S13ModelUpdateController::notifyDocumentDataChanged() noexcept {}

// Playback Controller
void ARAHostController::S13PlaybackController::requestStartPlayback() noexcept {}
void ARAHostController::S13PlaybackController::requestStopPlayback() noexcept {}
void ARAHostController::S13PlaybackController::requestSetPlaybackPosition (ARA::ARATimePosition) noexcept {}
void ARAHostController::S13PlaybackController::requestSetCycleRange (ARA::ARATimePosition, ARA::ARATimeDuration) noexcept {}
void ARAHostController::S13PlaybackController::requestEnableCycle (bool) noexcept {}

// Simple PlayHead
juce::Optional<juce::AudioPlayHead::PositionInfo>
ARAHostController::SimplePlayHead::getPosition() const
{
    juce::AudioPlayHead::PositionInfo info;
    info.setTimeInSamples (timeInSamples.load());
    info.setIsPlaying (isPlaying.load());
    return info;
}

// =============================================================================
// Main ARA Host Controller Implementation
// =============================================================================

void ARAHostController::initializeForPlugin (juce::AudioPluginInstance* plugin,
                                              double sampleRate, int blockSize,
                                              std::function<void (bool)> onComplete)
{
    if (! plugin)
    {
        if (onComplete) onComplete (false);
        return;
    }

    shutdown(); // Clean up any previous state

    araProcessor = plugin;
    currentSampleRate = sampleRate;
    currentBlockSize = blockSize;

    // Use JUCE's async factory creation to get ARA factory from plugin
    juce::createARAFactoryAsync (*plugin, [this, onComplete] (juce::ARAFactoryWrapper factory) {
        completeInitialization (std::move (factory), onComplete);
    });
}

void ARAHostController::completeInitialization (juce::ARAFactoryWrapper factory,
                                                 std::function<void (bool)> onComplete)
{
    if (! factory.get())
    {
        juce::Logger::writeToLog ("ARAHostController: Plugin does not support ARA.");
        if (onComplete) onComplete (false);
        return;
    }

    try
    {
        // Create the host-side controllers (we keep raw pointers before moving ownership)
        auto audioAccess = std::make_unique<S13AudioAccessController>();
        auto archiving = std::make_unique<S13ArchivingController>();
        auto contentAccess = std::make_unique<S13ContentAccessController>();
        auto modelUpdate = std::make_unique<S13ModelUpdateController>();
        auto playbackCtrl = std::make_unique<S13PlaybackController>();

        audioAccessControllerPtr = audioAccess.get();
        archivingControllerPtr = archiving.get();
        contentAccessControllerPtr = contentAccess.get();
        modelUpdateControllerPtr = modelUpdate.get();
        playbackControllerPtr = playbackCtrl.get();

        // Create the JUCE ARA document controller (takes ownership of controllers)
        araDocController = juce::ARAHostDocumentController::create (
            std::move (factory),
            "Studio13 Document",
            std::move (audioAccess),
            std::move (archiving),
            std::move (contentAccess),
            std::move (modelUpdate),
            std::move (playbackCtrl));

        if (! araDocController)
        {
            juce::Logger::writeToLog ("ARAHostController: Failed to create ARA document controller.");
            if (onComplete) onComplete (false);
            return;
        }

        auto& dc = araDocController->getDocumentController();

        // Create musical context
        {
            juce::ARAEditGuard editGuard (dc);

            auto mcProps = ARAHostModel::MusicalContext::getEmptyProperties();
            mcProps.name = "Studio13 Musical Context";
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

        // Bind the document to the plugin instance
        pluginExtension = araDocController->bindDocumentToPluginInstance (
            *araProcessor,
            ARA::kARAPlaybackRendererRole | ARA::kARAEditorRendererRole | ARA::kARAEditorViewRole,
            ARA::kARAPlaybackRendererRole);

        if (pluginExtension.isValid())
        {
            playbackRenderer = std::make_unique<ARAHostModel::PlaybackRendererInterface> (
                pluginExtension.getPlaybackRendererInterface());
        }

        araProcessor->setPlayHead (&araPlayHead);

        araActive = true;
        juce::Logger::writeToLog ("ARAHostController: Initialized successfully for ARA plugin.");
        if (onComplete) onComplete (true);
    }
    catch (const std::exception& e)
    {
        juce::Logger::writeToLog ("ARAHostController: Exception during init: " + juce::String (e.what()));
        if (onComplete) onComplete (false);
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

    // Create memory-mapped reader for the audio file
    juce::WavAudioFormat wavFormat;
    entry->reader.reset (wavFormat.createMemoryMappedReader (audioFile));
    if (! entry->reader)
    {
        juce::Logger::writeToLog ("ARAHostController: Only WAV files are supported for ARA (memory-mapped reader required).");
        return {};
    }
    entry->reader->mapEntireFile();

    entry->startTimeInTrack = startTimeInTrack;
    entry->duration = duration;
    entry->offsetInSource = offsetInSource;

    auto& dc = araDocController->getDocumentController();

    try
    {
        juce::ARAEditGuard editGuard (dc);

        // Create ARA audio source
        auto srcProps = ARAHostModel::AudioSource::getEmptyProperties();
        srcProps.name = audioFile.getFullPathName().toRawUTF8();
        srcProps.persistentID = clipId.toRawUTF8();
        srcProps.sampleCount = entry->reader->lengthInSamples;
        srcProps.sampleRate = entry->reader->sampleRate;
        srcProps.channelCount = static_cast<int> (entry->reader->numChannels);
        srcProps.merits64BitSamples = false;

        using SrcConverter = ARAHostModel::ConversionFunctions<ARASourceEntry*, ARA::ARAAudioSourceHostRef>;
        entry->audioSource = std::make_unique<ARAHostModel::AudioSource> (
            SrcConverter::toHostRef (entry.get()), dc, srcProps);

        // Enable audio source samples access
        entry->audioSource->enableAudioSourceSamplesAccess (true);

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

        // Register the playback region with the renderer
        if (playbackRenderer && playbackRenderer->isValid())
            playbackRenderer->add (*entry->playbackRegion);

        sources[clipId] = std::move (entry);
        juce::Logger::writeToLog ("ARAHostController: Added audio source: " + clipId);
        return clipId;
    }
    catch (const std::exception& e)
    {
        juce::Logger::writeToLog ("ARAHostController: Error adding source: " + juce::String (e.what()));
        return {};
    }
}

void ARAHostController::removeAudioSource (const juce::String& clipId)
{
    auto it = sources.find (clipId);
    if (it == sources.end()) return;

    if (araDocController)
    {
        auto& dc = araDocController->getDocumentController();
        juce::ARAEditGuard editGuard (dc);

        // Remove from playback renderer first
        if (playbackRenderer && playbackRenderer->isValid() && it->second->playbackRegion)
            playbackRenderer->remove (*it->second->playbackRegion);

        // Destroy in reverse order: region -> modification -> source
        it->second->playbackRegion.reset();
        it->second->audioModification.reset();
        it->second->audioSource.reset();
    }

    sources.erase (it);
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
}

void ARAHostController::processBlock (juce::AudioBuffer<float>& buffer, int numSamples,
                                       double playbackPositionSeconds, bool playing)
{
    if (! araActive || ! araProcessor) return;
    juce::ignoreUnused (numSamples);

    // Update playhead
    araPlayHead.timeInSamples.store (
        static_cast<juce::int64> (playbackPositionSeconds * currentSampleRate));
    araPlayHead.isPlaying.store (playing);

    // Process through the ARA-enabled plugin
    juce::MidiBuffer emptyMidi;
    araProcessor->processBlock (buffer, emptyMidi);
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
    playbackRenderer.reset();
    regionSequence.reset();
    musicalContext.reset();
    araDocController.reset();

    // Clear raw pointers (owned by araDocController, now destroyed)
    audioAccessControllerPtr = nullptr;
    archivingControllerPtr = nullptr;
    contentAccessControllerPtr = nullptr;
    modelUpdateControllerPtr = nullptr;
    playbackControllerPtr = nullptr;

    araProcessor = nullptr;
    araActive = false;

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
        mcProps.name = "Studio13 Musical Context";
        mcProps.orderIndex = 0;
        mcProps.color = nullptr;
        musicalContext->update (mcProps);
    }
}

#else // !S13_HAS_ARA

// Stub implementations when ARA is not available

void ARAHostController::initializeForPlugin (juce::AudioPluginInstance*, double, int,
                                              std::function<void (bool)> onComplete)
{
    juce::Logger::writeToLog ("ARAHostController: ARA support not compiled in.");
    if (onComplete) onComplete (false);
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

#endif // S13_HAS_ARA
