#pragma once

#include <juce_core/system/juce_TargetPlatform.h>

// ARA hosting requires the ARA SDK and JUCE_PLUGINHOST_ARA=1
#if JUCE_PLUGINHOST_ARA && (JUCE_MAC || JUCE_WINDOWS || JUCE_LINUX)
#define S13_HAS_ARA 1
#else
#define S13_HAS_ARA 0
#endif

#include <JuceHeader.h>

#if S13_HAS_ARA
#include <ARA_API/ARAInterface.h>
#include <ARA_Library/Dispatch/ARAHostDispatch.h>
#endif

/**
 * ARAHostController — Manages ARA 2 plugin hosting for a single track.
 *
 * Uses JUCE's high-level ARA hosting API (ARAHostDocumentController) to manage
 * the ARA document lifecycle, audio sources, and playback regions.
 *
 * Usage:
 *   1. Detect ARA-capable plugins via PluginManager::isARAPlugin()
 *   2. Call initializeForPlugin() with the loaded AudioPluginInstance
 *   3. Call addAudioSource() for each clip on the track
 *   4. During playback, call processBlock() instead of normal plugin processing
 *   5. Call saveState()/restoreState() for project save/load
 */
class ARAHostController
{
public:
    ARAHostController();
    ~ARAHostController();

    // Initialize ARA hosting for a loaded plugin (async — uses createARAFactoryAsync)
    // Calls onComplete(true) on success, onComplete(false) on failure
    void initializeForPlugin (juce::AudioPluginInstance* plugin, double sampleRate, int blockSize,
                              std::function<void (bool)> onComplete = nullptr);

    // Check if ARA is currently active
    bool isActive() const { return araActive; }

    // Add an audio source (clip) to the ARA document
    juce::String addAudioSource (const juce::File& audioFile,
                                  const juce::String& clipId,
                                  double startTimeInTrack,
                                  double duration,
                                  double offsetInSource = 0.0);

    // Remove an audio source from the document
    void removeAudioSource (const juce::String& clipId);

    // Update playback region timing (when clip is moved/resized)
    void updatePlaybackRegion (const juce::String& clipId,
                                double startTimeInTrack,
                                double duration,
                                double offsetInSource);

    // Process audio through the ARA renderer
    void processBlock (juce::AudioBuffer<float>& buffer, int numSamples,
                       double playbackPositionSeconds, bool isPlaying);

    // State save/load for project persistence
    juce::MemoryBlock saveState() const;
    bool restoreState (const juce::MemoryBlock& data);

    // Cleanup
    void shutdown();

    // Get the ARA plugin's editor component
    juce::AudioProcessorEditor* createEditor();

    // Notify ARA of tempo/time signature changes
    void updateMusicalContext (double bpm, int timeSigNumerator, int timeSigDenominator);

private:
    bool araActive = false;
    juce::AudioPluginInstance* araProcessor = nullptr;
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;

#if S13_HAS_ARA

    // =========================================================================
    // ARA Host Interface Controllers
    // =========================================================================

    class S13AudioAccessController final : public ARA::Host::AudioAccessControllerInterface
    {
    public:
        struct AudioReader
        {
            ARA::ARAAudioSourceHostRef sourceHostRef;
            bool use64Bit;
        };

        using ReaderConverter = ARAHostModel::ConversionFunctions<AudioReader*, ARA::ARAAudioReaderHostRef>;

        ARA::ARAAudioReaderHostRef createAudioReaderForSource (
            ARA::ARAAudioSourceHostRef audioSourceHostRef,
            bool use64BitSamples) noexcept override;

        bool readAudioSamples (ARA::ARAAudioReaderHostRef readerRef,
                               ARA::ARASamplePosition samplePosition,
                               ARA::ARASampleCount samplesPerChannel,
                               void* const* buffers) noexcept override;

        void destroyAudioReader (ARA::ARAAudioReaderHostRef readerRef) noexcept override;

        std::map<AudioReader*, std::unique_ptr<AudioReader>> audioReaders;
    };

    class S13ArchivingController final : public ARA::Host::ArchivingControllerInterface
    {
    public:
        using ReaderConverter = ARAHostModel::ConversionFunctions<juce::MemoryBlock*, ARA::ARAArchiveReaderHostRef>;
        using WriterConverter = ARAHostModel::ConversionFunctions<juce::MemoryOutputStream*, ARA::ARAArchiveWriterHostRef>;

        ARA::ARASize getArchiveSize (ARA::ARAArchiveReaderHostRef archiveReaderHostRef) noexcept override;
        bool readBytesFromArchive (ARA::ARAArchiveReaderHostRef archiveReaderHostRef,
                                    ARA::ARASize position, ARA::ARASize length,
                                    ARA::ARAByte* buffer) noexcept override;
        bool writeBytesToArchive (ARA::ARAArchiveWriterHostRef archiveWriterHostRef,
                                  ARA::ARASize position, ARA::ARASize length,
                                  const ARA::ARAByte* buffer) noexcept override;
        void notifyDocumentArchivingProgress (float value) noexcept override;
        void notifyDocumentUnarchivingProgress (float value) noexcept override;
        ARA::ARAPersistentID getDocumentArchiveID (ARA::ARAArchiveReaderHostRef archiveReaderHostRef) noexcept override;
    };

    class S13ContentAccessController final : public ARA::Host::ContentAccessControllerInterface
    {
    public:
        using Converter = ARAHostModel::ConversionFunctions<ARA::ARAContentType, ARA::ARAContentReaderHostRef>;

        bool isMusicalContextContentAvailable (ARA::ARAMusicalContextHostRef, ARA::ARAContentType type) noexcept override;
        ARA::ARAContentGrade getMusicalContextContentGrade (ARA::ARAMusicalContextHostRef, ARA::ARAContentType) noexcept override;
        ARA::ARAContentReaderHostRef createMusicalContextContentReader (ARA::ARAMusicalContextHostRef, ARA::ARAContentType type, const ARA::ARAContentTimeRange*) noexcept override;
        bool isAudioSourceContentAvailable (ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept override;
        ARA::ARAContentGrade getAudioSourceContentGrade (ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept override;
        ARA::ARAContentReaderHostRef createAudioSourceContentReader (ARA::ARAAudioSourceHostRef, ARA::ARAContentType, const ARA::ARAContentTimeRange*) noexcept override;
        ARA::ARAInt32 getContentReaderEventCount (ARA::ARAContentReaderHostRef contentReaderHostRef) noexcept override;
        const void* getContentReaderDataForEvent (ARA::ARAContentReaderHostRef contentReaderHostRef, ARA::ARAInt32 eventIndex) noexcept override;
        void destroyContentReader (ARA::ARAContentReaderHostRef) noexcept override;

        // Musical context data (set by host)
        double bpm = 120.0;
        int timeSigNum = 4;
        int timeSigDenom = 4;

    private:
        ARA::ARAContentTempoEntry tempoEntry {};
        ARA::ARAContentBarSignature barSignature {};
    };

    class S13ModelUpdateController final : public ARA::Host::ModelUpdateControllerInterface
    {
    public:
        void notifyAudioSourceAnalysisProgress (ARA::ARAAudioSourceHostRef, ARA::ARAAnalysisProgressState, float) noexcept override;
        void notifyAudioSourceContentChanged (ARA::ARAAudioSourceHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override;
        void notifyAudioModificationContentChanged (ARA::ARAAudioModificationHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override;
        void notifyPlaybackRegionContentChanged (ARA::ARAPlaybackRegionHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override;
        void notifyDocumentDataChanged() noexcept override;

        std::atomic<float> analysisProgress { 0.0f };
        std::atomic<bool> analysisComplete { false };
    };

    class S13PlaybackController final : public ARA::Host::PlaybackControllerInterface
    {
    public:
        void requestStartPlayback() noexcept override;
        void requestStopPlayback() noexcept override;
        void requestSetPlaybackPosition (ARA::ARATimePosition timePosition) noexcept override;
        void requestSetCycleRange (ARA::ARATimePosition startTime, ARA::ARATimeDuration duration) noexcept override;
        void requestEnableCycle (bool enable) noexcept override;
    };

    // =========================================================================
    // ARA Model Objects
    // =========================================================================

    struct ARASourceEntry
    {
        juce::String clipId;
        juce::File audioFile;
        std::unique_ptr<juce::MemoryMappedAudioFormatReader> reader;

        // ARA model objects (must be destroyed in reverse order of creation)
        std::unique_ptr<ARAHostModel::PlaybackRegion> playbackRegion;
        std::unique_ptr<ARAHostModel::AudioModification> audioModification;
        std::unique_ptr<ARAHostModel::AudioSource> audioSource;

        double startTimeInTrack = 0.0;
        double duration = 0.0;
        double offsetInSource = 0.0;
    };

    // Raw pointers to our controllers (ownership is transferred to ARAHostDocumentController)
    S13AudioAccessController* audioAccessControllerPtr = nullptr;
    S13ArchivingController* archivingControllerPtr = nullptr;
    S13ContentAccessController* contentAccessControllerPtr = nullptr;
    S13ModelUpdateController* modelUpdateControllerPtr = nullptr;
    S13PlaybackController* playbackControllerPtr = nullptr;

    // JUCE high-level ARA document controller (owns the host interface controllers)
    std::unique_ptr<juce::ARAHostDocumentController> araDocController;

    // Plugin extension instance (returned by bindDocumentToPluginInstance)
    ARAHostModel::PlugInExtensionInstance pluginExtension;
    std::unique_ptr<ARAHostModel::PlaybackRendererInterface> playbackRenderer;

    // Musical context and region sequence
    std::unique_ptr<ARAHostModel::MusicalContext> musicalContext;
    std::unique_ptr<ARAHostModel::RegionSequence> regionSequence;

    // Registered audio sources
    std::map<juce::String, std::unique_ptr<ARASourceEntry>> sources;

    // Simple playhead for ARA renderer
    struct SimplePlayHead final : public juce::AudioPlayHead
    {
        juce::Optional<juce::AudioPlayHead::PositionInfo> getPosition() const override;
        std::atomic<juce::int64> timeInSamples { 0 };
        std::atomic<bool> isPlaying { false };
    };
    SimplePlayHead araPlayHead;

    // Helper: complete initialization after factory is obtained
    void completeInitialization (juce::ARAFactoryWrapper factory,
                                 std::function<void (bool)> onComplete);

    friend class S13AudioAccessController;

#endif // S13_HAS_ARA

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ARAHostController)
};
