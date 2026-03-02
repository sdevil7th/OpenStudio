#pragma once

#include <JuceHeader.h>

//==============================================================================
// Speaker position in spherical coordinates
struct SpeakerPosition
{
    float azimuth;    // Degrees: 0 = front, +90 = right, -90 = left, 180 = rear
    float elevation;  // Degrees: 0 = ear level, +90 = above, -90 = below
};

//==============================================================================
// Speaker layout definition with named presets
struct SpeakerLayout
{
    juce::String name;
    std::vector<SpeakerPosition> speakers;

    // Preset layouts
    static SpeakerLayout stereo();       // 2.0: L (-30), R (+30)
    static SpeakerLayout quad();         // 4.0: FL, FR, RL, RR
    static SpeakerLayout surround51();   // 5.1: L, R, C, LFE, Ls, Rs
    static SpeakerLayout surround71();   // 7.1: L, R, C, LFE, Ls, Rs, Lss, Rss
    static SpeakerLayout atmos714();     // 7.1.4: 7.1 bed + 4 height speakers
};

//==============================================================================
/**
    VBAP (Vector Base Amplitude Panning) implementation.

    Distributes a mono source across a surround speaker layout using
    vector-base decomposition. For 2D layouts (elevation == 0), finds
    the speaker pair bracketing the source azimuth and computes gains
    proportional to angular proximity. For 3D layouts, finds the
    speaker triplet and computes gains via inverse matrix.
*/
class VBAPPanner
{
public:
    VBAPPanner();
    ~VBAPPanner() = default;

    /** Set the speaker layout. Rebuilds internal lookup structures. */
    void setSpeakerLayout (const SpeakerLayout& layout);

    /** Set the source panning position in degrees. */
    void setPanPosition (float azimuth, float elevation = 0.0f);

    /** Get per-speaker gain coefficients (size == number of speakers). */
    std::vector<float> getGains() const;

    /** Distribute a mono input buffer to a multi-channel surround output.
        surroundOutput must have at least as many channels as speakers. */
    void processBlock (const juce::AudioBuffer<float>& monoInput,
                       juce::AudioBuffer<float>& surroundOutput,
                       int numSamples);

    /** Returns the current speaker layout. */
    const SpeakerLayout& getSpeakerLayout() const { return currentLayout; }

    /** Returns number of speakers in current layout. */
    int getNumSpeakers() const { return static_cast<int> (currentLayout.speakers.size()); }

private:
    // Cartesian unit vector from spherical coords
    struct Vec3 { float x, y, z; };
    static Vec3 sphericalToCartesian (float azimuthDeg, float elevationDeg);

    // Recompute gains for current source position and layout
    void recalculateGains();

    // 2D panning: find bracketing speaker pair and compute gains
    void calculate2DGains();

    // 3D panning: find enclosing speaker triplet and compute gains via inverse matrix
    void calculate3DGains();

    SpeakerLayout currentLayout;
    float sourceAzimuth   = 0.0f;
    float sourceElevation = 0.0f;

    // Cached gains (one per speaker)
    std::vector<float> gains;

    // Whether the layout uses elevation (3D mode)
    bool is3D = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (VBAPPanner)
};

//==============================================================================
/**
    SurroundPannerProcessor — wraps VBAPPanner as a juce::AudioProcessor
    so it can be inserted into TrackProcessor FX chains or used standalone.
*/
class SurroundPannerProcessor  : public juce::AudioProcessor
{
public:
    SurroundPannerProcessor();
    ~SurroundPannerProcessor() override;

    // AudioProcessor overrides
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    const juce::String getName() const override;

    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // Public access to panner
    VBAPPanner& getPanner() { return panner; }

    // Convenience setters (also update parameters)
    void setAzimuth (float degrees);
    void setElevation (float degrees);
    void setSpread (float value);  // 0.0 to 1.0

private:
    VBAPPanner panner;

    std::atomic<float> azimuth   { 0.0f };    // -180 to 180
    std::atomic<float> elevation { 0.0f };     // -90 to 90
    std::atomic<float> spread    { 0.0f };     // 0.0 to 1.0

    // Pre-allocated mono buffer for downmixing stereo input
    juce::AudioBuffer<float> monoBuffer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SurroundPannerProcessor)
};
