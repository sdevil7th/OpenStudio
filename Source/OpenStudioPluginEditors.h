#pragma once

#include <JuceHeader.h>
#include "BuiltInEffects.h"
#include "BuiltInEffects2.h"
#include <functional>

// ============================================================================
// OpenStudio Dark LookAndFeel for plugin editors
// ============================================================================
class OpenStudioLookAndFeel : public juce::LookAndFeel_V4
{
public:
    OpenStudioLookAndFeel();

    void drawRotarySlider(juce::Graphics&, int x, int y, int width, int height,
                          float sliderPos, float rotaryStartAngle, float rotaryEndAngle,
                          juce::Slider&) override;

    void drawLinearSlider(juce::Graphics&, int x, int y, int width, int height,
                          float sliderPos, float minSliderPos, float maxSliderPos,
                          juce::Slider::SliderStyle, juce::Slider&) override;

    void drawToggleButton(juce::Graphics&, juce::ToggleButton&,
                          bool shouldDrawButtonAsHighlighted, bool shouldDrawButtonAsDown) override;

    void drawComboBox(juce::Graphics&, int width, int height, bool isButtonDown,
                      int buttonX, int buttonY, int buttonW, int buttonH,
                      juce::ComboBox&) override;

    void drawPopupMenuItem(juce::Graphics&, const juce::Rectangle<int>& area,
                           bool isSeparator, bool isActive, bool isHighlighted,
                           bool isTicked, bool hasSubMenu, const juce::String& text,
                           const juce::String& shortcutKeyText,
                           const juce::Drawable* icon, const juce::Colour* textColour) override;

    juce::Font getComboBoxFont(juce::ComboBox&) override;
    juce::Font getPopupMenuFont() override;

    // Colors
    static constexpr juce::uint32 bgDark       = 0xff121212;
    static constexpr juce::uint32 bgPanel      = 0xff1a1a1a;
    static constexpr juce::uint32 bgSection    = 0xff222222;
    static constexpr juce::uint32 bgKnob       = 0xff2a2a2a;
    static constexpr juce::uint32 accent       = 0xff0078d4;
    static constexpr juce::uint32 accentBright = 0xff3399ff;
    static constexpr juce::uint32 textPrimary  = 0xffe0e0e0;
    static constexpr juce::uint32 textDim      = 0xff888888;
    static constexpr juce::uint32 borderColor  = 0xff3a3a3a;
    static constexpr juce::uint32 meterGreen   = 0xff22c55e;
    static constexpr juce::uint32 meterYellow  = 0xffeab308;
    static constexpr juce::uint32 meterRed     = 0xffef4444;
};

// ============================================================================
// OpenStudioLabeledKnob -- A rotary knob with label and value display
// ============================================================================
class OpenStudioLabeledKnob : public juce::Component
{
public:
    OpenStudioLabeledKnob(const juce::String& name, const juce::String& suffix,
                   float minVal, float maxVal, float defaultVal, float step = 0.01f);

    void resized() override;
    void setValue(float val, juce::NotificationType nt = juce::dontSendNotification);
    float getValue() const;
    void setSkew(float midPoint);

    std::function<void(float)> onValueChange;
    std::function<juce::String(float)> formatValue;

    juce::Slider& getSlider() { return slider; }

private:
    juce::Slider slider;
    juce::Label nameLabel;
    juce::Label valueLabel;
    juce::String suffix;

    void updateValueLabel();
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioLabeledKnob)
};

// ============================================================================
// OpenStudioModeToggle -- Multi-mode switch (supports 2 or 3 modes)
// ============================================================================
class OpenStudioModeToggle : public juce::Component
{
public:
    OpenStudioModeToggle();
    void setLabels(const juce::StringArray& labels);

    void paint(juce::Graphics& g) override;
    void mouseDown(const juce::MouseEvent& e) override;

    int getMode() const { return currentMode; }
    bool isAdvanced() const { return currentMode == numModes - 1; }
    std::function<void(int)> onModeChanged;
    std::function<void(bool)> onModeChange; // legacy

private:
    int currentMode = 0;
    int numModes = 2;
    juce::StringArray modeLabels { "Basic", "Advanced" };
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioModeToggle)
};

// ============================================================================
// OpenStudioGainReductionMeter -- Vertical GR meter
// ============================================================================
class OpenStudioGainReductionMeter : public juce::Component
{
public:
    void paint(juce::Graphics& g) override;
    void setGainReduction(float grDB); // negative values
private:
    float grDB = 0.0f;
};

// ============================================================================
// OpenStudioSpectrumDisplay -- FFT spectrum analyzer for EQ
// ============================================================================
class OpenStudioSpectrumDisplay : public juce::Component, public juce::Timer
{
public:
    OpenStudioSpectrumDisplay(OpenStudioEQ& eq);
    void paint(juce::Graphics& g) override;
    void timerCallback() override;

private:
    OpenStudioEQ& eqProcessor;
    std::array<float, OpenStudioEQ::fftSize / 2> preSpectrum {};
    std::array<float, OpenStudioEQ::fftSize / 2> postSpectrum {};
    float smoothedPre[OpenStudioEQ::fftSize / 2] = {};
    float smoothedPost[OpenStudioEQ::fftSize / 2] = {};
    bool hasData = false;

    float freqToX(float freq, float width) const;
    float dbToY(float db, float height) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioSpectrumDisplay)
};

// ============================================================================
// OpenStudioParametricEQGraph -- Interactive EQ graph with draggable band points
// ============================================================================
class OpenStudioParametricEQGraph : public juce::Component, public juce::Timer
{
public:
    OpenStudioParametricEQGraph(OpenStudioEQ& eq);
    void paint(juce::Graphics& g) override;
    void timerCallback() override;

    void mouseDown(const juce::MouseEvent& e) override;
    void mouseDrag(const juce::MouseEvent& e) override;
    void mouseUp(const juce::MouseEvent& e) override;
    void mouseMove(const juce::MouseEvent& e) override;
    void mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& w) override;
    void mouseDoubleClick(const juce::MouseEvent& e) override;

    std::function<void()> onBandChanged; // notify editor to sync knobs

private:
    OpenStudioEQ& eqProcessor;

    // Spectrum data
    float smoothedPre[OpenStudioEQ::fftSize / 2] = {};
    float smoothedPost[OpenStudioEQ::fftSize / 2] = {};
    bool hasSpectrumData = false;

    // Interaction state
    int dragBand = -1;       // which band is being dragged (-1 = none)
    int hoveredBand = -1;    // which band is hovered
    bool dragging = false;

    // Coordinate helpers
    float freqToX(float freq) const;
    float xToFreq(float x) const;
    float dbToY(float db) const;
    float yToDb(float y) const;
    int findBandAt(float x, float y) const;
    int findFirstDisabledBand() const;

    static constexpr float minFreq = 20.0f;
    static constexpr float maxFreq = 20000.0f;
    static constexpr float minDB = -30.0f;
    static constexpr float maxDB = 30.0f;
    static constexpr float pointRadius = 8.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioParametricEQGraph)
};

// ============================================================================
// OpenStudioInteractiveCompressorDisplay -- Draggable threshold/ratio on transfer curve
// ============================================================================
class OpenStudioInteractiveCompressorDisplay : public juce::Component, public juce::Timer
{
public:
    OpenStudioInteractiveCompressorDisplay(OpenStudioCompressor& comp);
    void paint(juce::Graphics& g) override;
    void timerCallback() override;

    void mouseDown(const juce::MouseEvent& e) override;
    void mouseDrag(const juce::MouseEvent& e) override;
    void mouseUp(const juce::MouseEvent& e) override;
    void mouseMove(const juce::MouseEvent& e) override;

    std::function<void()> onParamChanged;

private:
    OpenStudioCompressor& compressor;
    float displayGR = 0.0f;
    float displayInputLevel = -100.0f;

    enum DragTarget { None, Threshold, Ratio };
    DragTarget dragTarget = None;
    int hoveredTarget = None;
    float dragStartY = 0.0f;
    float dragStartValue = 0.0f;

    static constexpr float dbRange = 60.0f;
    float dbToX(float db) const;
    float dbToY(float db) const;
    float xToDb(float x) const;
    float yToDb(float y) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioInteractiveCompressorDisplay)
};

// ============================================================================
// OpenStudioCompressorDisplay -- Transfer curve + GR meter for compressor
// ============================================================================
class OpenStudioCompressorDisplay : public juce::Component, public juce::Timer
{
public:
    OpenStudioCompressorDisplay(OpenStudioCompressor& comp);
    void paint(juce::Graphics& g) override;
    void timerCallback() override;

private:
    OpenStudioCompressor& compressor;
    float displayGR = 0.0f;
    float displayInputLevel = -100.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioCompressorDisplay)
};

// ============================================================================
// Plugin Editor classes
// ============================================================================

// --- OpenStudioEQ Editor ---
class OpenStudioEQEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioEQEditor(OpenStudioEQ& processor);
    ~OpenStudioEQEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioEQ& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioModeToggle modeToggle;
    OpenStudioSpectrumDisplay spectrum;
    OpenStudioParametricEQGraph parametricGraph;

    // HP/LP filter controls (always visible in all modes)
    OpenStudioLabeledKnob hpFreqKnob;
    OpenStudioLabeledKnob lpFreqKnob;
    std::unique_ptr<juce::ToggleButton> hpEnabledBtn;
    std::unique_ptr<juce::ToggleButton> lpEnabledBtn;

    struct BandControls {
        std::unique_ptr<juce::ToggleButton> enabled;
        std::unique_ptr<juce::ComboBox> type;
        std::unique_ptr<OpenStudioLabeledKnob> freq;
        std::unique_ptr<OpenStudioLabeledKnob> gain;
        std::unique_ptr<OpenStudioLabeledKnob> q;
        std::unique_ptr<juce::ComboBox> slope;
    };
    std::array<BandControls, OpenStudioEQ::numBands> bandControls;
    OpenStudioLabeledKnob outputGainKnob;
    juce::ToggleButton autoGainBtn;

    void setupBand(int idx);
    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioEQEditor)
};

// --- OpenStudioCompressor Editor ---
class OpenStudioCompressorEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioCompressorEditor(OpenStudioCompressor& processor);
    ~OpenStudioCompressorEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioCompressor& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioModeToggle modeToggle;
    OpenStudioInteractiveCompressorDisplay display;

    OpenStudioLabeledKnob thresholdKnob, ratioKnob, attackKnob, releaseKnob;
    OpenStudioLabeledKnob kneeKnob, makeupKnob, mixKnob;
    OpenStudioLabeledKnob scHPFKnob, lookaheadKnob;
    juce::ComboBox styleBox;
    juce::ToggleButton autoMakeupBtn, autoReleaseBtn;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioCompressorEditor)
};

// --- OpenStudioGate Editor ---
class OpenStudioGateEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioGateEditor(OpenStudioGate& processor);
    ~OpenStudioGateEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioGate& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioModeToggle modeToggle;

    OpenStudioLabeledKnob thresholdKnob, attackKnob, holdKnob, releaseKnob;
    OpenStudioLabeledKnob rangeKnob, hysteresisKnob, mixKnob;
    OpenStudioLabeledKnob scHPFKnob, scLPFKnob;

    juce::Component gateIndicator;
    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioGateEditor)
};

// --- OpenStudioLimiter Editor ---
class OpenStudioLimiterEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioLimiterEditor(OpenStudioLimiter& processor);
    ~OpenStudioLimiterEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioLimiter& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioGainReductionMeter grMeter;

    OpenStudioLabeledKnob thresholdKnob, releaseKnob, ceilingKnob, lookaheadKnob;
    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioLimiterEditor)
};

// --- OpenStudioDelay Editor ---
class OpenStudioDelayEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioDelayEditor(OpenStudioDelay& processor);
    ~OpenStudioDelayEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioDelay& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioModeToggle modeToggle;

    OpenStudioLabeledKnob delayLKnob, delayRKnob, feedbackKnob, crossFeedKnob, mixKnob;
    OpenStudioLabeledKnob lpfKnob, hpfKnob, saturationKnob, widthKnob;
    juce::ToggleButton pingPongBtn, tempoSyncBtn;
    juce::ComboBox syncNoteLBox, syncNoteRBox, delayModeBox;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioDelayEditor)
};

// --- OpenStudioReverb Editor ---
class OpenStudioReverbEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioReverbEditor(OpenStudioReverb& processor);
    ~OpenStudioReverbEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioReverb& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioModeToggle modeToggle;

    OpenStudioLabeledKnob roomSizeKnob, dampingKnob, wetKnob, dryKnob, widthKnob;
    OpenStudioLabeledKnob preDelayKnob, decayKnob, diffusionKnob;
    OpenStudioLabeledKnob lowCutKnob, highCutKnob, earlyLevelKnob;
    juce::ComboBox algorithmBox;
    juce::ToggleButton freezeBtn;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioReverbEditor)
};

// --- OpenStudioChorus Editor ---
class OpenStudioChorusEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioChorusEditor(OpenStudioChorus& processor);
    ~OpenStudioChorusEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioChorus& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioModeToggle modeToggle;

    OpenStudioLabeledKnob rateKnob, depthKnob, feedbackKnob, mixKnob;
    OpenStudioLabeledKnob voicesKnob, spreadKnob, highCutKnob, lowCutKnob;
    juce::ComboBox modeBox, lfoShapeBox;
    juce::ToggleButton tempoSyncBtn;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioChorusEditor)
};

// --- OpenStudioSaturator Editor ---
class OpenStudioSaturatorEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit OpenStudioSaturatorEditor(OpenStudioSaturator& processor);
    ~OpenStudioSaturatorEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    OpenStudioSaturator& proc;
    OpenStudioLookAndFeel laf;
    OpenStudioModeToggle modeToggle;

    OpenStudioLabeledKnob driveKnob, mixKnob, toneKnob, outputKnob, asymmetryKnob;
    juce::ComboBox satTypeBox, oversampleBox;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioSaturatorEditor)
};
