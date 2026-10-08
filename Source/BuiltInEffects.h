#pragma once
#include "BuiltInEQMIDIPrograms.h"
#include "BuiltInAlignmentCapture.h"

#include <JuceHeader.h>
#include "BuiltInPeakReconstruction.h"
#include "BuiltInOutputMeter.h"
#include "BuiltInLimiterEnvelope.h"
#include "BuiltInLimiterOutputGuard.h"
#include "BuiltInAverageMeter.h"
#include "BuiltInDetectorTilt.h"
#include "BuiltInExternalKey.h"
#include "BuiltInLinearPhaseEQ.h"
#include "BuiltInEQAdaptiveDynamics.h"
#include "BuiltInEQDraftPreview.h"
#include "BuiltInSpectralEQ.h"
#include <array>
#include <mutex>
#include <vector>

using OpenStudioIIRCoefficientSet = std::array<float, 5>;

//==============================================================================
/**
 * Base class for all OpenStudio built-in effects.
 */
class OpenStudioBuiltInEffect : public juce::AudioProcessor
{
public:
    explicit OpenStudioBuiltInEffect(bool externalKeyBus = false);
    ~OpenStudioBuiltInEffect() override = default;

    bool isOpenStudioBuiltIn() const { return true; }

    // ---- AudioProcessor boilerplate ----
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;

    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int index) override { juce::ignoreUnused(index); }
    const juce::String getProgramName(int index) override { juce::ignoreUnused(index); return {}; }
    void changeProgramName(int index, const juce::String& newName) override { juce::ignoreUnused(index, newName); }

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    void setOversamplingEnabled(bool enabled);
    bool isOversamplingEnabled() const { return oversamplingEnabled; }

    // Gain reduction metering (for compressor, gate, limiter)
    float getGainReductionDB() const { return gainReductionDB.load(); }
    std::atomic<float> externalDetector { 0.0f };
    bool supportsExternalKey() const noexcept { return getBusCount(true) > 1; }

protected:
    BuiltInExternalKey detectorKey;
    void captureDetectorKey(const juce::AudioBuffer<float>& buffer) noexcept;
    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler;
    bool oversamplingEnabled = false;
    std::atomic<float> gainReductionDB { 0.0f };

private:
    static BusesProperties builtInBuses(bool externalKey);
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioBuiltInEffect)
};

//==============================================================================
/**
 * OpenStudioEQ -- 8-band parametric EQ with selectable filter types per band.
 *
 * Each band: Bell, Low Shelf, High Shelf, Low Cut, High Cut, Notch, Band Pass.
 * Slopes for cut/shelf: 6, 12, 24, 48 dB/oct.
 * Includes FFT spectrum analyzer data output.
 */
class OpenStudioEQ : public OpenStudioBuiltInEffect
{
public:
    explicit OpenStudioEQ(bool standalone = false);
    ~OpenStudioEQ() override = default;
    bool acceptsMidi() const override { return supportsExternalKey(); }

    const juce::String getName() const override { return "OpenStudio EQ"; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void reset() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // Filter types
    enum class FilterType : int
    {
        Bell = 0, LowShelf, HighShelf, LowCut, HighCut, Notch, BandPass, AllPass, TiltShelf, FlatTilt
    };

    // Slope options for cut/shelf filters
    enum class FilterSlope : int
    {
        dB6 = 0, dB12, dB24, dB48, dB72, dB96
    };

    static constexpr int numBands = 8; // legacy channel-strip/native-editor count
    static constexpr int maxBands = 24;
    const int bandCount;
    static constexpr std::array<float, numBands> defaultFrequencies { 20.0f, 100.0f, 250.0f, 500.0f, 1000.0f, 2500.0f, 6000.0f, 20000.0f };

    struct BandParams
    {
        std::atomic<float> target { 0.0f }; // 0 stereo, 1 L, 2 R, 3 Mid, 4 Side
        std::atomic<float> enabled { 1.0f };    // 0 = bypassed, 1 = active
        std::atomic<float> type { 0.0f };       // FilterType as float
        std::atomic<float> freq { 1000.0f };    // Hz (standalone requested 10-30000; legacy 20-20000)
        std::atomic<float> gain { 0.0f };       // dB (-30 to +30)
        std::atomic<float> q { 1.0f };          // 0.1 to 30.0
        std::atomic<float> slope { 1.0f };      // FilterSlope as float (for cut/shelf)
        std::atomic<float> dynamicEnabled { 0.0f };   // 0 = static, 1 = dynamic
        std::atomic<float> dynamicThreshold { -24.0f }; // detector threshold dB
        std::atomic<float> dynamicRange { 0.0f };      // dB added above threshold
        std::atomic<float> dynamicAttack { 10.0f };    // ms
        std::atomic<float> dynamicRelease { 150.0f };  // ms
        std::atomic<float> detectorSource {0}; // Global, Internal, External
        std::atomic<float> detectorMode {0}; // Band, Free
        std::atomic<float> detectorLowCut {20}, detectorHighCut {20000};
        std::atomic<float> allPass {0}; // separate flag preserves the legacy type automation range
        std::atomic<float> dynamicThresholdMode {0}, dynamicTimingMode {0}, dynamicSensitivity {0};
        std::atomic<float> spectralEnabled {0}, spectralDensity {.75f}, spectralTilt {1};
        std::atomic<float> gainQInteraction {0};
        std::atomic<float> cutMode {0}, continuousSlope {12}; // stepped, continuous, brickwall target
    };
    std::array<BandParams, maxBands> bands;

    std::atomic<float> outputGain { 0.0f };    // dB (-12 to +12)
    std::atomic<float> editorBypass { 0.0f };
    std::array<std::atomic<float>, 2> outputPeaks { -100.0f, -100.0f };
    void publishOutputPeaks(const juce::AudioBuffer<float>& buffer) noexcept;
    std::atomic<float> autoGain { 0.0f };      // 0 = off, 1 = on
    std::atomic<float> auditionBand { 0.0f };  // 0 = off, 1-8 = solo/audition band
    std::atomic<float> stereoMode { 0.0f };    // 0 = stereo, 1 = mid, 2 = side
    std::atomic<float> phaseMode { 0.0f }, phaseQuality { 1.0f }, spectralProcessing {0}, linearBandDynamics {0};
    std::atomic<float> minimumPhaseFIR {0}, analogResponse {0};
    bool setMinimumPhaseFIR(float enabled);
    bool setAnalogResponse(float enabled);
    bool usesPreparedEQ() const noexcept { return phaseMode.load() >= .5f || minimumPhaseFIR.load() >= .5f; }
    int preparedEQLatency() const noexcept { return phaseMode.load() >= .5f ? BuiltInLinearPhaseEQ::latency(juce::roundToInt(phaseQuality.load())) : minimumPhaseFIR.load() >= .5f ? BuiltInLinearPhaseEQ::quantum + (analogResponse.load() >= .5f ? BuiltInMinimumEQDesign::analogDelay : 0) : 0; }
    bool setSpectralConfiguration(float enabled);
    bool setLinearDynamicsConfiguration(float enabled);
    std::atomic<float> detectorListenBand {0}; // Off or one-based band
    bool setPhaseConfiguration(float mode, float quality);
    bool setEditorPhaseConfiguration(float mode, float minimumFIR, bool preserveBandDynamics);
    bool isLinearPhaseUpdating() const noexcept;
    double getTailLengthSeconds() const override;

    // Used by the channel-strip host. The EQ stays in the callback so that
    // enable/disable transitions can be ramped instead of hard-skipped.
    void setPowerEnabled(bool enabled) noexcept
    {
        powerEnabled.store(enabled, std::memory_order_release);
    }
    bool isPowerEnabled() const noexcept
    {
        return powerEnabled.load(std::memory_order_acquire);
    }

    bool editMIDIProgram(const juce::var& edit);
    bool hasPreparedMIDIPrograms() const noexcept { return preparedMIDILatency.load() >= 0; }
    juce::var midiProgramInfo() const;

    BuiltInEQDraftPreview draftPreview;
    uint64_t draftFingerprint() const noexcept;
    bool canPreviewDraft() const noexcept;
    juce::var commandDraftPreview(const juce::String& session,bool stop,bool immediate=false);
    juce::var startDraftPreview(const juce::String& session, const juce::var& proposal, const juce::String& expectedState, bool update = false);
    std::unique_ptr<BuiltInAlignmentCapture> matchCapture;
    void captureMatchOutput(const juce::AudioBuffer<float>& buffer) noexcept;

    // Spectrum analyzer data
    static constexpr int fftOrder = 11;        // 2048-point FFT
    static constexpr int fftSize = 1 << fftOrder;

    static constexpr int maxSpectrumSize = 8192;
    struct SpectrumData
    {
        std::array<float, maxSpectrumSize / 2> preEQ {}, postEQ {}, externalKey {};
        int fftLength = fftSize, source = 0;
        bool ready = false;
    };
    SpectrumData getSpectrumData(int requestedSize = 0, int source = 0);

    // Get magnitude response at given frequencies (for drawing the EQ curve)
    std::vector<float> getMagnitudeResponse(const std::vector<float>& frequencies) const;
    float getBandDynamicGainDB(int bandIndex) const;
    std::array<float,3> getBandDynamicControls(int bandIndex) const;

private:
    using MIDIProgramBank=BuiltInEQMIDIProgramBank;
    std::atomic<const MIDIProgramBank*> publishedMIDIPrograms {nullptr};
    std::atomic<std::uint32_t> midiProgramReaders {0}, midiParameterRevision {0};
    std::unique_ptr<MIDIProgramBank> midiProgramOwner;
    std::vector<std::unique_ptr<MIDIProgramBank>> retiredMIDIPrograms;
    mutable std::mutex midiProgramMutex;
    std::array<int,16> midiBankMSB{},midiBankLSB{};
    std::atomic<juce::uint64> midiProgramObservation {0};
    std::atomic<bool> midiProgramRestoreRejected {false};
    std::atomic<int> preparedMIDILatency{-1};
    std::atomic<double> preparedMIDITail{0};
    std::shared_ptr<BuiltInEQPreparedPrograms> preparedMIDIView() const;
    bool prepareMIDIPrograms(MIDIProgramBank& bank);
    void rebuildMIDIPrograms();
    void processPreparedMIDI(BuiltInEQPreparedPrograms& bank, juce::AudioBuffer<float>& buffer);
    void selectPreparedMIDI(BuiltInEQPreparedPrograms& bank, int slot) noexcept;
    void applyMIDIConfiguration(const std::array<float,MIDIProgramBank::configurationCount>& values) noexcept;
    std::uint32_t midiProgramSerial=0;
    int midiProgramSampleOffset=0;
    void processEQAudioBlock(juce::AudioBuffer<float>& buffer);
    void publishMIDIPrograms(std::unique_ptr<MIDIProgramBank> next);
    void getEQStateInformationRaw(juce::MemoryBlock& destination, const std::array<float, MIDIProgramBank::valueCount>& snapshot, const std::array<float, MIDIProgramBank::configurationCount>& configuration);
    void saveMIDIPrograms(juce::ValueTree& state) const;
    void restoreMIDIPrograms(const juce::ValueTree& state);
    std::array<float,MIDIProgramBank::configurationCount> midiProgramConfiguration() const noexcept;
    void observeMIDIProgram(int bank,int program,int channel,int status) noexcept;
    template<class Visitor> void visitMIDIProgramParameters(Visitor&& visit)
    {
        visit(outputGain,-12.0f,12.0f);
        visit(autoGain,0.0f,1.0f);
        visit(editorBypass,0.0f,1.0f);
        visit(auditionBand,0.0f,24.0f);
        visit(stereoMode,0.0f,2.0f);
        visit(detectorListenBand,0.0f,24.0f);
        for(auto& band:bands)
        {
            visit(band.target,0.0f,4.0f);
            visit(band.enabled,0.0f,1.0f);
            visit(band.type,0.0f,9.0f);
            visit(band.freq,10.0f,30000.0f);
            visit(band.gain,-30.0f,30.0f);
            visit(band.q,0.1f,30.0f);
            visit(band.slope,0.0f,5.0f);
            visit(band.dynamicEnabled,0.0f,1.0f);
            visit(band.dynamicThreshold,-80.0f,0.0f);
            visit(band.dynamicRange,-30.0f,30.0f);
            visit(band.dynamicAttack,0.2f,250.0f);
            visit(band.dynamicRelease,5.0f,2000.0f);
            visit(band.detectorSource,0.0f,2.0f);
            visit(band.detectorMode,0.0f,1.0f);
            visit(band.detectorLowCut,20.0f,19000.0f);
            visit(band.detectorHighCut,21.0f,20000.0f);
            visit(band.allPass,0.0f,1.0f);
            visit(band.dynamicThresholdMode,0.0f,1.0f);
            visit(band.dynamicTimingMode,0.0f,1.0f);
            visit(band.dynamicSensitivity,-12.0f,12.0f);
            visit(band.spectralEnabled,0.0f,1.0f);
            visit(band.spectralDensity,0.0f,1.0f);
            visit(band.spectralTilt,0.0f,1.0f);
            visit(band.gainQInteraction,0.0f,1.0f);
            visit(band.cutMode,0.0f,2.0f);
            visit(band.continuousSlope,3.0f,96.0f);
        }
    }
    std::unique_ptr<BuiltInLinearPhaseEQ> linearPhase;
    std::unique_ptr<BuiltInSpectralEQ> spectralEQ;
    juce::AudioBuffer<float> spectralPreScratch;
    void processSpectral(juce::AudioBuffer<float>& buffer, bool spectrumRequested, const juce::AudioBuffer<float>& fullBuffer);
    bool frequencyProcessingRequested() const noexcept { return spectralProcessing.load() >= .5f || (usesPreparedEQ() && linearBandDynamics.load() >= .5f); }
    bool usesSpectralBand(int band) const noexcept { return spectralEQ && ((spectralProcessing.load() >= .5f && bands[band].spectralEnabled.load() >= .5f) || (usesPreparedEQ() && linearBandDynamics.load() >= .5f)); }
    BuiltInLinearPhaseEQ::Snapshot linearSnapshot() const noexcept;
    void preparePhaseProcessing();
    void processLinearPhase(juce::AudioBuffer<float>& buffer, bool spectrumRequested, const juce::AudioBuffer<float>& fullBuffer);
    static constexpr int maxStagesPerBand = 8; // through 96 dB/oct
    static constexpr int coefficientMorphChunkSize = 16;
    using StereoIIR = juce::dsp::ProcessorDuplicator<juce::dsp::IIR::Filter<float>,
                                                      juce::dsp::IIR::Coefficients<float>>;

    StereoIIR bandFilters[maxBands][maxStagesPerBand];
    int activeStages[maxBands] = {};
    int targetStages[maxBands] = {};
    std::array<std::array<OpenStudioIIRCoefficientSet, maxStagesPerBand>, maxBands>
        targetBandCoefficients {};
    bool filtersPrepared = false;
    bool filtersNeedSmoothing = false;
    float coefficientMorphProportion = 1.0f;
    juce::dsp::IIR::Filter<float> dynamicDetectorFilters[maxBands][2];
    juce::dsp::IIR::Filter<float> freeDetectorFilters[maxBands][2][2];
    std::array<std::array<juce::SmoothedValue<float>, 3>, maxBands> detectorSourceWeights;
    std::array<juce::SmoothedValue<float>, maxBands> freeDetectorWeights, detectorListenWeights;
    std::array<std::array<float, 2>, maxBands> cachedFreeDetectorCuts {};
    juce::AudioBuffer<float> detectorListenScratch;
    juce::SmoothedValue<float> detectorListenMix;
    void resetDetectorConfiguration(bool prepare);
    std::array<float, maxBands> dynamicEnvelope {};
    std::array<BuiltInEQAdaptiveDynamics,maxBands> adaptiveDetectors;
    std::array<bool,maxBands> adaptiveWasActive {};
    std::array<std::array<std::atomic<float>,3>,maxBands> effectiveDynamicControls {};
    std::array<std::atomic<float>, maxBands> dynamicGainDB {};
    juce::AudioBuffer<float> msScratch;
    juce::AudioBuffer<float> dryScratch, bandScratch;
    std::array<std::array<juce::SmoothedValue<float>,5>,maxBands> targetWeights;
    void resetTargetWeights(bool prepare);

    std::atomic<bool> powerEnabled { true };
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedPowerMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedModeMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedOutputGain;
    int activeProcessingMode = 0;
    int pendingProcessingMode = 0;
    bool modeTransitionPending = false;
    bool wetPathHasState = false;

    struct CachedBandState
    {
        bool valid = false;
        float enabled = -1.0f;
        int type = -1;
        float freq = -1.0f;
        float gain = -999.0f;
        float q = -1.0f;
        int slope = -1;
        float gainQ = -1;
    };
    std::array<CachedBandState, maxBands> cachedBandStates {};

    struct CachedDynamicDetectorState
    {
        bool valid = false;
        float freq = -1.0f;
        float q = -1.0f;
    };
    std::array<CachedDynamicDetectorState, maxBands> cachedDynamicDetectorStates {};
    int cachedAuditionIndex = -2;

    double cachedSampleRate = 44100.0; // callback-owned after prepare
    std::atomic<double> publishedSampleRate { 44100.0 };
    float smoothedAutoGainDB = 0.0f;
    float cachedAutoGainTargetDB = 0.0f;
    float autoGainProbeWeightedSum = 0.0f;
    float autoGainProbeWeightTotal = 0.0f;
    int autoGainProbeIndex = 0;
    int autoGainProbeSamplesUntilAdvance = 0;

    void updateFilters(bool forceImmediate = false);
    void updateBand(int bandIndex, int auditionIndex, bool forceImmediate);
    void updateDynamicBands(const juce::AudioBuffer<float>& buffer,
                            int detectorChannels);
    int getNumStagesForSlope(FilterSlope slope) const;
    int buildBandTargets(
        int bandIndex,
        bool shouldProcess,
        std::array<OpenStudioIIRCoefficientSet, maxStagesPerBand>& targets,
        bool includeDynamics = true, bool analogPrototype = false) const noexcept;
    bool advanceStageCoefficients(int bandIndex, int stageIndex) noexcept;
    void resetWetPathState() noexcept;
    void advanceAutoGainEstimateProbe() noexcept;

    // Spectrum capture is lock-free on the callback. FFT work is performed by
    // getSpectrumData() on the UI/schema caller only while it is polling.
    juce::dsp::FFT fft1024 {10}, fft2048 {11}, fft4096 {12}, fft8192 {13};
    juce::dsp::WindowingFunction<float> window1024 {1024, juce::dsp::WindowingFunction<float>::hann},
        window2048 {2048, juce::dsp::WindowingFunction<float>::hann},
        window4096 {4096, juce::dsp::WindowingFunction<float>::hann},
        window8192 {8192, juce::dsp::WindowingFunction<float>::hann};

    struct SpectrumCaptureSlot
    {
        // 0 = free, 1 = callback is writing, 2 = ready, 3 = consumer is reading
        std::atomic<int> state { 0 };
        std::atomic<juce::uint64> generation { 0 };
        int length = fftSize;
        std::array<std::array<float, maxSpectrumSize>, 6> audio {};
    };
    std::unique_ptr<std::array<SpectrumCaptureSlot, 2>> spectrumCaptureSlots = std::make_unique<std::array<SpectrumCaptureSlot, 2>>();
    std::atomic<int> spectrumDemandSamplesRemaining { 0 };
    int spectrumCaptureSlot = -1;
    int spectrumCaptureWritePos = 0;
    juce::uint64 spectrumCaptureGeneration = 0;
    std::mutex spectrumConsumerMutex;
    SpectrumData lastSpectrumOutput;
    std::atomic<int> requestedSpectrumSize {fftSize};
    std::atomic<unsigned int> spectrumResetEpoch {0};
    unsigned int spectrumObservedEpoch = 0;
    juce::uint64 spectrumReadGeneration = 0;

    void computeSpectrum(const SpectrumCaptureSlot& slot, int source, SpectrumData& output);
    bool isSpectrumCaptureRequested(int numSamples) noexcept;
    int claimSpectrumCaptureSlot() noexcept;
    void captureSpectrumBlock(const juce::AudioBuffer<float>& preEQ,
                              const juce::AudioBuffer<float>& postEQ,
                              const juce::AudioBuffer<float>& fullBuffer) noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioEQ)
};

//==============================================================================
/**
 * OpenStudioCompressor -- Multi-style feed-forward compressor.
 *
 * Styles: Clean, Punch, Opto, FET, VCA.
 * Includes dry/wet for parallel compression, sidechain HPF, lookahead,
 * and real-time gain reduction output.
 */
#include "BuiltInFETCompressor.h"
#include "BuiltInVCAMonitor.h"
#include "BuiltInOpticalCompressor.h"
#include "BuiltInVCACompressor.h"
class OpenStudioCompressor : public OpenStudioBuiltInEffect
{
public:
    explicit OpenStudioCompressor(bool standalone = false);
    ~OpenStudioCompressor() override = default;

    const juce::String getName() const override { return "OpenStudio Compressor"; }
    // Finite amplifier/filter residue only; intentional generator noise is not
    // a decaying tail. Preserve the historical zero declaration in Legacy/NAM.
    double getTailLengthSeconds() const override { return standaloneProcessing && audioCharacter.load() >= .5f ? 1.0 : 0.0; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void reset() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    enum class Style : int { Clean = 0, Punch, Opto, FET, VCA };

    std::atomic<float> threshold { 0.0f };     // -60 to 0 dB
    std::atomic<float> ratio { 1.0f };         // 1:1 to 20:1
    std::atomic<float> attack { 10.0f };       // 0.1 to 100 ms
    std::atomic<float> release { 100.0f };     // 10 to 2000 ms
    std::atomic<float> knee { 0.0f };          // 0 to 24 dB
    std::atomic<float> makeupGain { 0.0f };    // 0 to 36 dB
    std::atomic<float> mix { 1.0f };           // 0-1 (parallel compression)
    std::atomic<float> style { 0.0f };         // Style as float
    std::atomic<float> autoMakeup { 0.0f };    // 0 = off, 1 = on
    std::atomic<float> autoRelease { 0.0f };   // 0 = off, 1 = on
    std::atomic<float> sidechainHPF { 20.0f }; // <= 0 = bypass, otherwise 20-500 Hz
    std::atomic<float> lookaheadMs { 0.0f };   // 0-20 ms
    std::atomic<float> detectorMode { 0.0f };  // 0=Peak, 1=RMS, 2=Auto
    std::atomic<float> stereoLink { 1.0f };    // 0=average detector, 1=linked peak detector
    // Standalone models. Zero recalls the historical Style controls.
    std::atomic<float> model { 0.0f };
    // Opt-in configuration, prepared on the control thread. Old/NAM state omits it.
    std::atomic<float> audioCharacter { 0 }, headroom { 0 };
    void refreshCharacterConfiguration();
    // Standalone FET memories, independent of the frozen generic model banks.
    std::atomic<float> fetEngine { 1 }, fetInput { 0 }, fetOutput { 0 }, fetRatio { 0 };
    std::atomic<float> fetAttack { .1f }, fetRelease { 120 }, fetRecovery { .25f }, fetTilt { 0 };
    struct OpticalControls { std::atomic<float> engine { 1 }, reduction { 45 }, gain { 0 }, mode { 0 }, emphasis { 0 }; };
    std::array<OpticalControls, 2> opticalControls;
    struct VCAControls
    {
        std::atomic<float> engine { 1 }, routing { 0 };
        std::array<std::array<std::atomic<float>, BuiltInVCACompressor::Count>, 2> channels {};
    };
    std::array<VCAControls, 2> vcaControls;
    std::atomic<float> punchNoiseLeft{0},punchNoiseRight{0},punchHum{0},punchMonitor{0};
    std::array<std::array<std::atomic<float>, 12>, 7> modelBanks {};
    std::array<std::atomic<float>*, 12> modelControls();
    void selectModel(int);
    void initialiseModelBanks();
    bool isStandalone() const noexcept { return standaloneProcessing; }

    // Metering
    float getCurrentGainReduction() const { return gainReductionDB.load(); }
    float getInputLevel() const { return inputLevelDB.load(); }
    float getOutputLevel() const { return outputLevelDB.load(); }
    BuiltInAverageMeter averageMeter;
    std::atomic<float> meterMode{0},meterReference{-18},meterChannel{0};

private:
    const bool standaloneProcessing;
    juce::AudioBuffer<float> alignedDelay;
    int alignedPosition = 0;
    float opticalMemory = 0.0f;
    BuiltInFETCompressor fetProcessor;
    BuiltInVCAMonitor punchExtras;
    BuiltInDetectorTilt fetDetectorTilt;
    juce::SmoothedValue<float> fetWeight;
    std::array<BuiltInOpticalCompressor, 2> opticalProcessors;
    std::array<juce::SmoothedValue<float>, 2> opticalWeights;
    std::array<BuiltInVCACompressor, 2> vcaProcessors;
    std::array<juce::SmoothedValue<float>, 2> vcaWeights;
    int activeStandaloneModel = -1;
    bool originalCharacterPrepared = false;
    int preparedCharacterBlockSize = 0;
    BuiltInOversampledColour originalColour;
    juce::SmoothedValue<float> smoothedHeadroom;
    juce::SmoothedValue<float> detectorDelay;
    void processStandaloneBlock(juce::AudioBuffer<float>&);
    float envelopeLevel = 0.0f;
    float rmsEnvelopeLevel = 0.0f;
    float currentGainLin = 1.0f;

    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMakeup;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedThresholdDb;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCompressionSlope;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedKneeDb;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedSidechainHPFWet;
    double cachedSampleRate = 44100.0;

    juce::dsp::IIR::Filter<float> scHPF_L;
    juce::dsp::IIR::Filter<float> scHPF_R;
    float lastSCHPFFreq = 20.0f;
    std::vector<OpenStudioIIRCoefficientSet> scHPFCoefficientLut;
    OpenStudioIIRCoefficientSet targetSCHPFCoefficients {};
    float scHPFCoefficientSmoothingProportion = 1.0f;
    bool scHPFCoefficientsSmoothing = false;

    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> lookaheadDelayL { 8192 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> lookaheadDelayR { 8192 };
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedLookaheadMorph;
    float activeLookaheadSamples = 0.0f;
    float targetLookaheadSamples = 0.0f;
    float pendingLookaheadSamples = 0.0f;
    bool lookaheadMorphActive = false;

    std::atomic<float> inputLevelDB { -100.0f };
    std::atomic<float> outputLevelDB { -100.0f };

    static float computeGain(float inputDB,
                             float thresholdDB,
                             float compressionSlope,
                             float kneeDB) noexcept;
    void getStyleBallistics(float& atkMs, float& relMs) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioCompressor)
};

//==============================================================================
/**
 * OpenStudioGate -- Noise gate with hold, range, hysteresis, sidechain filter.
 */
class OpenStudioGate : public OpenStudioBuiltInEffect
{
public:
    explicit OpenStudioGate(bool standalone = false);
    ~OpenStudioGate() override = default;

    const juce::String getName() const override { return "OpenStudio Gate"; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void reset() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    std::atomic<float> threshold { -40.0f };   // -80 to 0 dB
    std::atomic<float> attackMs { 1.0f };      // 0.01 to 50 ms
    std::atomic<float> holdMs { 50.0f };       // 0 to 500 ms
    std::atomic<float> releaseMs { 50.0f };    // 5 to 2000 ms
    std::atomic<float> range { -80.0f };       // -80 to 0 dB
    std::atomic<float> hysteresis { 0.0f };    // 0 to 20 dB
    std::atomic<float> sidechainHPF { 20.0f }; // 20-2000 Hz
    std::atomic<float> sidechainLPF { 20000.0f }; // 200-20000 Hz
    std::atomic<float> mix { 1.0f };           // 0-1
    std::atomic<float> detectorMode { 0.0f };  // 0=Peak, 1=RMS, 2=Auto
    std::atomic<float> rateIndependentDetector { 0.0f };
    std::atomic<float> transientResponse { 0.0f }; // Legacy or immediate peak detector

    std::atomic<float> expansionMode {0}, expansionRatio {2}, expansionKnee {6}, detectorListen {0};
    std::atomic<float> detectorLevelDb {-100};
    std::atomic<int> envelopeStage {0}; // closed, opening, open, holding, closing, expanding
    static float expansionGainDb(float relativeDb,float ratio,float knee,float minimumDb) noexcept;
    bool isGateOpen() const { return gateOpen.load(); }

private:
    juce::SmoothedValue<float> expansionBlend, listenBlend, smoothedExpansionRatio, smoothedExpansionKnee;
    float envelopeLevel = 0.0f;
    float rmsEnvelopeLevel = 0.0f;
    int holdCounter = 0;
    float currentGain = 0.0f;
    std::atomic<bool> gateOpen { false };

    float attackCoeff = 0.0f;
    float releaseCoeff = 0.0f;
    int holdSamples = 0;
    float thresholdLinear = 0.0f;
    float closeThresholdLinear = 0.0f;
    float rangeGain = 0.0f;

    juce::dsp::IIR::Filter<float> scHPF_L, scHPF_R;
    juce::dsp::IIR::Filter<float> scLPF_L, scLPF_R;
    std::vector<OpenStudioIIRCoefficientSet> scHPFCoefficientLut;
    std::vector<OpenStudioIIRCoefficientSet> scLPFCoefficientLut;
    OpenStudioIIRCoefficientSet targetHPFCoefficients {};
    OpenStudioIIRCoefficientSet targetLPFCoefficients {};
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMix;
    float sidechainCoefficientSmoothingProportion = 1.0f;
    bool hpfCoefficientsSmoothing = false;
    bool lpfCoefficientsSmoothing = false;

    double cachedSampleRate = 44100.0;
    float lastSidechainHPF = -1.0f;
    float lastSidechainLPF = -1.0f;

    void updateCoefficients(bool forceImmediate);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioGate)
};

//==============================================================================
/**
 * OpenStudioLimiter -- Brickwall limiter with ceiling and lookahead.
 */
class OpenStudioLimiter : public OpenStudioBuiltInEffect
{
public:
    explicit OpenStudioLimiter(bool standalone = false);
    ~OpenStudioLimiter() override = default;

    const juce::String getName() const override { return "OpenStudio Limiter"; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void reset() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    std::atomic<float> threshold { -1.0f };    // -20 to 0 dB
    std::atomic<float> releaseMs { 100.0f };   // 10 to 500 ms
    std::atomic<float> ceiling { 0.0f };       // -3 to 0 dB
    std::atomic<float> lookaheadMs { 5.0f };   // 0 to 20 ms
    std::atomic<float> continuousGain { 0.0f };
    std::atomic<float> truePeak { 0.0f };
    std::atomic<float> limitingStyle {0}, slowAttackMs {20}, automaticRelease {0}, transientLink {1}, releaseLink {1};
    std::atomic<float> linkedEdits {0}, unityAudition {0};
    std::atomic<float> oversampleQuality {0}; // Off, 2x, 4x, 8x, 16x, 32x; prepared configuration
    bool setQualityConfiguration(float quality);
    bool isStandalone() const noexcept { return standaloneProcessing; }

    BuiltInOutputMeter outputMeter;

private:
    const bool standaloneProcessing;
    std::unique_ptr<juce::dsp::Oversampling<float>> qualityOversampler;
    BuiltInLimiterOutputGuard outputGuard;
    double processingSampleRate = 44100;
    int processingLatency = 0, preparedBlockSize = 0, oversamplingFactor = 1;
    bool qualityPrepared = false;
    void processQualityBlock(juce::AudioBuffer<float>& buffer);
    BuiltInLimiterEnvelope responseEnvelope;
    juce::SmoothedValue<float> unityBlend;
    BuiltInPeakReconstruction peakReconstruction;
    float reconstructionGain = 1.0f;
    std::vector<float> reconstructionPeaks;
    std::vector<uint64_t> reconstructionTimes;
    size_t reconstructionHead = 0, reconstructionCount = 0;
    uint64_t reconstructionClock = 0;
    int peakHoldSamples = 0;
    juce::SmoothedValue<float> detectorDelay;
    void processStandaloneBlock(juce::AudioBuffer<float>&);
    juce::dsp::Limiter<float> limiter;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedThresholdGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCeiling;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedLookaheadMorph;
    double cachedSampleRate = 44100.0;

    juce::AudioBuffer<float> lookaheadBuffer;
    int lookaheadWriteIndex = 0;
    int activeLookaheadSamples = 0;
    int targetLookaheadSamples = 0;
    int pendingLookaheadSamples = 0;
    bool lookaheadMorphActive = false;
    float gainEnvelope = 1.0f;
    std::array<float, 2> previousDetectorSample {};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioLimiter)
};
