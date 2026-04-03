#pragma once

#include <juce_core/system/juce_TargetPlatform.h>

// ARA hosting requires the ARA SDK and JUCE_PLUGINHOST_ARA=1
#if JUCE_PLUGINHOST_ARA && (JUCE_MAC || JUCE_WINDOWS || JUCE_LINUX)
#define S13_HAS_ARA 1
#else
#define S13_HAS_ARA 0
#endif

#include <JuceHeader.h>
#include "ARADebug.h"

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
    struct DebugSnapshot
    {
        float analysisProgress = 0.0f;
        bool analysisComplete = false;
        bool analysisRequested = false;
        bool analysisStarted = false;
        float lastAnalysisProgressValue = 0.0f;
        int sourceCount = 0;
        int playbackRegionCount = 0;
        bool audioSourceSamplesAccessEnabled = false;
        bool editorRendererAttached = false;
        bool playbackRendererAttached = false;
        bool transportPlaying = false;
        double transportPositionSeconds = 0.0;
        double timeSinceLastPlayStartMs = 0.0;
        bool hasPendingEditSinceLastPlay = false;
        double lastEditTimestampMs = 0.0;
        juce::String lastEditType;
        juce::String lastOperation;
        juce::String lastClipId;
        uint64 editGeneration = 0;
    };

    struct PlaybackRequestHandlers
    {
        std::function<void()> startPlayback;
        std::function<void()> stopPlayback;
        std::function<void(double)> setPlaybackPosition;
        std::function<void(double, double)> setCycleRange;
        std::function<void(bool)> enableCycle;
    };

    ARAHostController();
    ~ARAHostController();

    // Initialize ARA hosting for a loaded plugin (async — uses createARAFactoryAsync)
    // Calls onComplete(true) on success, onComplete(false) on failure
    void initializeForPlugin (juce::AudioPluginInstance* plugin, double sampleRate, int blockSize,
                              std::function<void (bool, bool, const juce::String&)> onComplete = nullptr);

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

    void setPlaybackRequestHandlers(PlaybackRequestHandlers handlers);
    float getAnalysisProgress() const;
    bool isAnalysisComplete() const;
    DebugSnapshot getDebugSnapshot() const;
    void updateTransportDebugState(bool playing, double positionSeconds);
    void notePlaybackStart(double positionSeconds);
    void notePlaybackStop(double positionSeconds);


private:
    bool araActive = false;
    juce::AudioPluginInstance* araProcessor = nullptr;
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;
    int pluginInputChannelCount = 0;

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
        explicit S13ModelUpdateController(ARAHostController& ownerIn) : owner(ownerIn) {}

        void notifyAudioSourceAnalysisProgress (ARA::ARAAudioSourceHostRef, ARA::ARAAnalysisProgressState, float) noexcept override;
        void notifyAudioSourceContentChanged (ARA::ARAAudioSourceHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override;
        void notifyAudioModificationContentChanged (ARA::ARAAudioModificationHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override;
        void notifyPlaybackRegionContentChanged (ARA::ARAPlaybackRegionHostRef, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override;
        void notifyDocumentDataChanged() noexcept override;

        std::atomic<float> analysisProgress { 0.0f };
        std::atomic<bool> analysisComplete { false };
        std::atomic<int> lastLoggedAnalysisBucket { -1 };

    private:
        ARAHostController& owner;
    };

    class S13PlaybackController final : public ARA::Host::PlaybackControllerInterface
    {
    public:
        explicit S13PlaybackController(ARAHostController& ownerIn) : owner(ownerIn) {}

        void requestStartPlayback() noexcept override;
        void requestStopPlayback() noexcept override;
        void requestSetPlaybackPosition (ARA::ARATimePosition timePosition) noexcept override;
        void requestSetCycleRange (ARA::ARATimePosition startTime, ARA::ARATimeDuration duration) noexcept override;
        void requestEnableCycle (bool enable) noexcept override;

    private:
        ARAHostController& owner;
    };

    // =========================================================================
    // ARA Model Objects
    // =========================================================================

    struct ARASourceEntry
    {
        juce::String clipId;
        juce::File audioFile;
        std::unique_ptr<juce::AudioFormatReader> reader;
        int nativeChannelCount = 0;
        int exposedChannelCount = 0;

        // Pre-loaded audio data — eliminates disk I/O during processBlock.
        // ARA plugins call readAudioSamples() on the audio thread; serving
        // from memory avoids ~300ms/block disk contention.
        juce::AudioBuffer<float> preloadedAudio;
        bool preloaded = false;

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
    std::unique_ptr<ARAHostModel::EditorRendererInterface> editorRenderer;
    std::vector<ARA::ARAContentType> requestedAnalysisContentTypes;

    // Musical context and region sequence
    std::unique_ptr<ARAHostModel::MusicalContext> musicalContext;
    std::unique_ptr<ARAHostModel::RegionSequence> regionSequence;

    // Registered audio sources
    std::map<juce::String, std::unique_ptr<ARASourceEntry>> sources;

    // Helper: complete initialization after factory is obtained
    void completeInitialization (juce::ARAFactoryWrapper factory,
                                 std::function<void (bool, bool, const juce::String&)> onComplete);

    friend class S13AudioAccessController;

#endif // S13_HAS_ARA

    void noteDebugOperation(const juce::String& operationType, const juce::String& clipId);
    void noteEditDrivenDebugEvent(const juce::String& eventType, const juce::String& clipId);
    juce::String describeRequestedAnalysisContentTypes() const;

    void requestStartPlaybackFromPlugin() const;
    void requestStopPlaybackFromPlugin() const;
    void requestSetPlaybackPositionFromPlugin(double timePosition) const;
    void requestSetCycleRangeFromPlugin(double startTime, double duration) const;
    void requestEnableCycleFromPlugin(bool enable) const;

    PlaybackRequestHandlers playbackRequestHandlers;
    mutable juce::CriticalSection debugStateLock;
    std::atomic<bool> debugTransportPlaying { false };
    std::atomic<double> debugTransportPositionSeconds { 0.0 };
    std::atomic<double> debugLastPlayStartTimestampMs { 0.0 };
    std::atomic<double> debugLastEditTimestampMs { 0.0 };
    std::atomic<bool> debugAnalysisRequested { false };
    std::atomic<bool> debugAnalysisStarted { false };
    std::atomic<float> debugLastAnalysisProgressValue { 0.0f };
    std::atomic<int> debugSourceCount { 0 };
    std::atomic<int> debugPlaybackRegionCount { 0 };
    std::atomic<int> debugSamplesAccessEnabledCount { 0 };
    std::atomic<uint64> debugEditGeneration { 0 };
    std::atomic<uint64> debugLastPlaybackObservedEditGeneration { 0 };
    juce::String debugLastEditType;
    juce::String debugLastOperation;
    juce::String debugLastClipId;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ARAHostController)
};
