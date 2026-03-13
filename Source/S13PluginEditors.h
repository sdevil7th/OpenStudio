#pragma once

#include <JuceHeader.h>
#include "BuiltInEffects.h"
#include "BuiltInEffects2.h"
#include <functional>

// ============================================================================
// S13 Dark LookAndFeel for plugin editors
// ============================================================================
class S13LookAndFeel : public juce::LookAndFeel_V4
{
public:
    S13LookAndFeel();

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
// S13LabeledKnob -- A rotary knob with label and value display
// ============================================================================
class S13LabeledKnob : public juce::Component
{
public:
    S13LabeledKnob(const juce::String& name, const juce::String& suffix,
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
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13LabeledKnob)
};

// ============================================================================
// S13ModeToggle -- Multi-mode switch (supports 2 or 3 modes)
// ============================================================================
class S13ModeToggle : public juce::Component
{
public:
    S13ModeToggle();
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
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13ModeToggle)
};

// ============================================================================
// S13GainReductionMeter -- Vertical GR meter
// ============================================================================
class S13GainReductionMeter : public juce::Component
{
public:
    void paint(juce::Graphics& g) override;
    void setGainReduction(float grDB); // negative values
private:
    float grDB = 0.0f;
};

// ============================================================================
// S13SpectrumDisplay -- FFT spectrum analyzer for EQ
// ============================================================================
class S13SpectrumDisplay : public juce::Component, public juce::Timer
{
public:
    S13SpectrumDisplay(S13EQ& eq);
    void paint(juce::Graphics& g) override;
    void timerCallback() override;

private:
    S13EQ& eqProcessor;
    std::array<float, S13EQ::fftSize / 2> preSpectrum {};
    std::array<float, S13EQ::fftSize / 2> postSpectrum {};
    float smoothedPre[S13EQ::fftSize / 2] = {};
    float smoothedPost[S13EQ::fftSize / 2] = {};
    bool hasData = false;

    float freqToX(float freq, float width) const;
    float dbToY(float db, float height) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13SpectrumDisplay)
};

// ============================================================================
// S13ParametricEQGraph -- Interactive EQ graph with draggable band points
// ============================================================================
class S13ParametricEQGraph : public juce::Component, public juce::Timer
{
public:
    S13ParametricEQGraph(S13EQ& eq);
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
    S13EQ& eqProcessor;

    // Spectrum data
    float smoothedPre[S13EQ::fftSize / 2] = {};
    float smoothedPost[S13EQ::fftSize / 2] = {};
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

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13ParametricEQGraph)
};

// ============================================================================
// S13InteractiveCompressorDisplay -- Draggable threshold/ratio on transfer curve
// ============================================================================
class S13InteractiveCompressorDisplay : public juce::Component, public juce::Timer
{
public:
    S13InteractiveCompressorDisplay(S13Compressor& comp);
    void paint(juce::Graphics& g) override;
    void timerCallback() override;

    void mouseDown(const juce::MouseEvent& e) override;
    void mouseDrag(const juce::MouseEvent& e) override;
    void mouseUp(const juce::MouseEvent& e) override;
    void mouseMove(const juce::MouseEvent& e) override;

    std::function<void()> onParamChanged;

private:
    S13Compressor& compressor;
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

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13InteractiveCompressorDisplay)
};

// ============================================================================
// S13CompressorDisplay -- Transfer curve + GR meter for compressor
// ============================================================================
class S13CompressorDisplay : public juce::Component, public juce::Timer
{
public:
    S13CompressorDisplay(S13Compressor& comp);
    void paint(juce::Graphics& g) override;
    void timerCallback() override;

private:
    S13Compressor& compressor;
    float displayGR = 0.0f;
    float displayInputLevel = -100.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13CompressorDisplay)
};

// ============================================================================
// Plugin Editor classes
// ============================================================================

// --- S13EQ Editor ---
class S13EQEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13EQEditor(S13EQ& processor);
    ~S13EQEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13EQ& proc;
    S13LookAndFeel laf;
    S13ModeToggle modeToggle;
    S13SpectrumDisplay spectrum;
    S13ParametricEQGraph parametricGraph;

    // HP/LP filter controls (always visible in all modes)
    S13LabeledKnob hpFreqKnob;
    S13LabeledKnob lpFreqKnob;
    std::unique_ptr<juce::ToggleButton> hpEnabledBtn;
    std::unique_ptr<juce::ToggleButton> lpEnabledBtn;

    struct BandControls {
        std::unique_ptr<juce::ToggleButton> enabled;
        std::unique_ptr<juce::ComboBox> type;
        std::unique_ptr<S13LabeledKnob> freq;
        std::unique_ptr<S13LabeledKnob> gain;
        std::unique_ptr<S13LabeledKnob> q;
        std::unique_ptr<juce::ComboBox> slope;
    };
    std::array<BandControls, S13EQ::numBands> bandControls;
    S13LabeledKnob outputGainKnob;
    juce::ToggleButton autoGainBtn;

    void setupBand(int idx);
    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13EQEditor)
};

// --- S13Compressor Editor ---
class S13CompressorEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13CompressorEditor(S13Compressor& processor);
    ~S13CompressorEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13Compressor& proc;
    S13LookAndFeel laf;
    S13ModeToggle modeToggle;
    S13InteractiveCompressorDisplay display;

    S13LabeledKnob thresholdKnob, ratioKnob, attackKnob, releaseKnob;
    S13LabeledKnob kneeKnob, makeupKnob, mixKnob;
    S13LabeledKnob scHPFKnob, lookaheadKnob;
    juce::ComboBox styleBox;
    juce::ToggleButton autoMakeupBtn, autoReleaseBtn;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13CompressorEditor)
};

// --- S13Gate Editor ---
class S13GateEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13GateEditor(S13Gate& processor);
    ~S13GateEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13Gate& proc;
    S13LookAndFeel laf;
    S13ModeToggle modeToggle;

    S13LabeledKnob thresholdKnob, attackKnob, holdKnob, releaseKnob;
    S13LabeledKnob rangeKnob, hysteresisKnob, mixKnob;
    S13LabeledKnob scHPFKnob, scLPFKnob;

    juce::Component gateIndicator;
    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13GateEditor)
};

// --- S13Limiter Editor ---
class S13LimiterEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13LimiterEditor(S13Limiter& processor);
    ~S13LimiterEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13Limiter& proc;
    S13LookAndFeel laf;
    S13GainReductionMeter grMeter;

    S13LabeledKnob thresholdKnob, releaseKnob, ceilingKnob, lookaheadKnob;
    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13LimiterEditor)
};

// --- S13Delay Editor ---
class S13DelayEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13DelayEditor(S13Delay& processor);
    ~S13DelayEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13Delay& proc;
    S13LookAndFeel laf;
    S13ModeToggle modeToggle;

    S13LabeledKnob delayLKnob, delayRKnob, feedbackKnob, crossFeedKnob, mixKnob;
    S13LabeledKnob lpfKnob, hpfKnob, saturationKnob, widthKnob;
    juce::ToggleButton pingPongBtn, tempoSyncBtn;
    juce::ComboBox syncNoteLBox, syncNoteRBox, delayModeBox;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13DelayEditor)
};

// --- S13Reverb Editor ---
class S13ReverbEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13ReverbEditor(S13Reverb& processor);
    ~S13ReverbEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13Reverb& proc;
    S13LookAndFeel laf;
    S13ModeToggle modeToggle;

    S13LabeledKnob roomSizeKnob, dampingKnob, wetKnob, dryKnob, widthKnob;
    S13LabeledKnob preDelayKnob, decayKnob, diffusionKnob;
    S13LabeledKnob lowCutKnob, highCutKnob, earlyLevelKnob;
    juce::ComboBox algorithmBox;
    juce::ToggleButton freezeBtn;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13ReverbEditor)
};

// --- S13Chorus Editor ---
class S13ChorusEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13ChorusEditor(S13Chorus& processor);
    ~S13ChorusEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13Chorus& proc;
    S13LookAndFeel laf;
    S13ModeToggle modeToggle;

    S13LabeledKnob rateKnob, depthKnob, feedbackKnob, mixKnob;
    S13LabeledKnob voicesKnob, spreadKnob, highCutKnob, lowCutKnob;
    juce::ComboBox modeBox, lfoShapeBox;
    juce::ToggleButton tempoSyncBtn;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13ChorusEditor)
};

// --- S13Saturator Editor ---
class S13SaturatorEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13SaturatorEditor(S13Saturator& processor);
    ~S13SaturatorEditor() override;
    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    S13Saturator& proc;
    S13LookAndFeel laf;
    S13ModeToggle modeToggle;

    S13LabeledKnob driveKnob, mixKnob, toneKnob, outputKnob, asymmetryKnob;
    juce::ComboBox satTypeBox, oversampleBox;

    void syncFromProcessor();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13SaturatorEditor)
};
