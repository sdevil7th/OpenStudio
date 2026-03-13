#pragma once

#include <JuceHeader.h>
#include <ysfx.h>
#include <vector>
#include <mutex>

/**
 * S13FXProcessor — JUCE AudioProcessor wrapper around a YSFX (JSFX) effect instance.
 *
 * Slots into the existing FX chain (TrackProcessor::inputFXPlugins / trackFXPlugins)
 * exactly like a VST3 plugin. The caller adds this via TrackProcessor::addInputFX()
 * or addTrackFX() — no special handling needed in the audio pipeline.
 */
class S13FXProcessor : public juce::AudioProcessor
{
public:
    S13FXProcessor();
    ~S13FXProcessor() override;

    // Script management
    bool loadScript(const juce::String& path);
    bool reloadScript();
    juce::String getScriptPath() const { return scriptPath; }
    bool isScriptLoaded() const;

    // Slider (parameter) access for the frontend
    struct SliderInfo
    {
        uint32_t index;
        juce::String name;
        double min;
        double max;
        double def;
        double inc;
        double value;
        bool isEnum;
        juce::StringArray enumNames;
    };

    std::vector<SliderInfo> getSliders() const;
    bool setSliderValue(uint32_t index, double value);

    // Identify as S13FX (not VST3)
    bool isS13FX() const { return true; }

    // @gfx support — used by S13FXGfxEditor
    ysfx_t* getEffect() const { return effect; }
    std::mutex& getGfxMutex() { return gfxMutex; }
    float getGfxScaleFactor() const { return gfxScaleFactor; }
    void setGfxScaleFactor(float sf) { gfxScaleFactor = sf; }
    bool hasGfxSection() const;

    // ---- juce::AudioProcessor overrides ----
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override;
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    bool hasEditor() const override;
    juce::AudioProcessorEditor* createEditor() override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

private:
    ysfx_t* effect = nullptr;
    ysfx_config_t* config = nullptr;
    juce::String scriptPath;
    juce::String effectName;

    double cachedSampleRate = 44100.0;
    int cachedBlockSize = 512;

    // Pre-allocated channel pointer arrays for ysfx_process_float
    std::vector<const float*> inputPtrs;
    std::vector<float*> outputPtrs;

    // Temporary buffer when in-place processing with different channel counts
    juce::AudioBuffer<float> tempBuffer;

    void updateTimeInfo();

    // Mutex for thread safety between audio thread and gfx rendering (message thread)
    std::mutex gfxMutex;
    float gfxScaleFactor = 1.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13FXProcessor)
};
