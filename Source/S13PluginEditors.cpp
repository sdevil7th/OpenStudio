#include "S13PluginEditors.h"
#include <cmath>

// ============================================================================
// S13LookAndFeel
// ============================================================================

S13LookAndFeel::S13LookAndFeel()
{
    setColour(juce::Slider::rotarySliderFillColourId, juce::Colour(accent));
    setColour(juce::Slider::rotarySliderOutlineColourId, juce::Colour(bgKnob));
    setColour(juce::Slider::thumbColourId, juce::Colour(accentBright));
    setColour(juce::Slider::trackColourId, juce::Colour(accent));
    setColour(juce::Slider::backgroundColourId, juce::Colour(bgKnob));
    setColour(juce::Label::textColourId, juce::Colour(textPrimary));
    setColour(juce::ComboBox::backgroundColourId, juce::Colour(bgSection));
    setColour(juce::ComboBox::textColourId, juce::Colour(textPrimary));
    setColour(juce::ComboBox::outlineColourId, juce::Colour(borderColor));
    setColour(juce::ComboBox::arrowColourId, juce::Colour(textDim));
    setColour(juce::PopupMenu::backgroundColourId, juce::Colour(bgPanel));
    setColour(juce::PopupMenu::textColourId, juce::Colour(textPrimary));
    setColour(juce::PopupMenu::highlightedBackgroundColourId, juce::Colour(accent));
    setColour(juce::PopupMenu::highlightedTextColourId, juce::Colours::white);
    setColour(juce::ToggleButton::textColourId, juce::Colour(textPrimary));
    setColour(juce::ToggleButton::tickColourId, juce::Colour(accent));
    setColour(juce::ToggleButton::tickDisabledColourId, juce::Colour(textDim));
    setColour(juce::TextEditor::backgroundColourId, juce::Colour(bgSection));
    setColour(juce::TextEditor::textColourId, juce::Colour(textPrimary));
    setColour(juce::TextEditor::outlineColourId, juce::Colour(borderColor));
}

void S13LookAndFeel::drawRotarySlider(juce::Graphics& g, int x, int y, int w, int h,
                                       float sliderPos, float rotaryStartAngle, float rotaryEndAngle,
                                       juce::Slider& slider)
{
    juce::ignoreUnused(slider);
    const float radius = static_cast<float>(juce::jmin(w, h)) * 0.4f;
    const float centerX = static_cast<float>(x) + static_cast<float>(w) * 0.5f;
    const float centerY = static_cast<float>(y) + static_cast<float>(h) * 0.5f;
    const float angle = rotaryStartAngle + sliderPos * (rotaryEndAngle - rotaryStartAngle);

    // Background circle
    g.setColour(juce::Colour(bgKnob));
    g.fillEllipse(centerX - radius, centerY - radius, radius * 2.0f, radius * 2.0f);

    // Outline
    g.setColour(juce::Colour(borderColor));
    g.drawEllipse(centerX - radius, centerY - radius, radius * 2.0f, radius * 2.0f, 1.5f);

    // Arc track (background)
    const float trackWidth = 3.0f;
    const float arcRadius = radius - 4.0f;
    juce::Path bgArc;
    bgArc.addCentredArc(centerX, centerY, arcRadius, arcRadius, 0.0f,
                         rotaryStartAngle, rotaryEndAngle, true);
    g.setColour(juce::Colour(0xff333333));
    g.strokePath(bgArc, juce::PathStrokeType(trackWidth, juce::PathStrokeType::curved,
                                              juce::PathStrokeType::rounded));

    // Arc track (filled)
    if (sliderPos > 0.001f)
    {
        juce::Path valueArc;
        valueArc.addCentredArc(centerX, centerY, arcRadius, arcRadius, 0.0f,
                                rotaryStartAngle, angle, true);
        g.setColour(juce::Colour(accent));
        g.strokePath(valueArc, juce::PathStrokeType(trackWidth, juce::PathStrokeType::curved,
                                                     juce::PathStrokeType::rounded));
    }

    // Pointer line
    const float pointerLength = radius * 0.5f;
    const float pointerThickness = 2.5f;
    juce::Path pointer;
    pointer.addRoundedRectangle(-pointerThickness * 0.5f, -radius + 6.0f,
                                 pointerThickness, pointerLength, 1.0f);
    pointer.applyTransform(juce::AffineTransform::rotation(angle).translated(centerX, centerY));
    g.setColour(juce::Colours::white);
    g.fillPath(pointer);
}

void S13LookAndFeel::drawLinearSlider(juce::Graphics& g, int x, int y, int w, int h,
                                       float sliderPos, float minSliderPos, float maxSliderPos,
                                       juce::Slider::SliderStyle style, juce::Slider& slider)
{
    juce::ignoreUnused(minSliderPos, maxSliderPos);
    if (style == juce::Slider::LinearHorizontal)
    {
        const float trackY = static_cast<float>(y) + static_cast<float>(h) * 0.5f;
        const float trackH = 4.0f;

        // Track background
        g.setColour(juce::Colour(bgKnob));
        g.fillRoundedRectangle(static_cast<float>(x), trackY - trackH * 0.5f,
                                static_cast<float>(w), trackH, 2.0f);

        // Filled portion
        g.setColour(juce::Colour(accent));
        g.fillRoundedRectangle(static_cast<float>(x), trackY - trackH * 0.5f,
                                sliderPos - static_cast<float>(x), trackH, 2.0f);

        // Thumb
        g.setColour(juce::Colours::white);
        g.fillEllipse(sliderPos - 5.0f, trackY - 5.0f, 10.0f, 10.0f);
    }
    else
    {
        LookAndFeel_V4::drawLinearSlider(g, x, y, w, h, sliderPos, minSliderPos, maxSliderPos, style, slider);
    }
}

void S13LookAndFeel::drawToggleButton(juce::Graphics& g, juce::ToggleButton& btn,
                                       bool shouldDrawButtonAsHighlighted, bool shouldDrawButtonAsDown)
{
    juce::ignoreUnused(shouldDrawButtonAsDown);
    const auto bounds = btn.getLocalBounds().toFloat();
    const float boxSize = 16.0f;
    const float boxX = 4.0f;
    const float boxY = (bounds.getHeight() - boxSize) * 0.5f;

    // Checkbox background
    g.setColour(juce::Colour(bgSection));
    g.fillRoundedRectangle(boxX, boxY, boxSize, boxSize, 3.0f);
    g.setColour(juce::Colour(borderColor));
    g.drawRoundedRectangle(boxX, boxY, boxSize, boxSize, 3.0f, 1.0f);

    if (btn.getToggleState())
    {
        g.setColour(juce::Colour(accent));
        g.fillRoundedRectangle(boxX + 2.0f, boxY + 2.0f, boxSize - 4.0f, boxSize - 4.0f, 2.0f);
    }

    // Label text
    g.setColour(shouldDrawButtonAsHighlighted ? juce::Colours::white : juce::Colour(textPrimary));
    g.setFont(12.0f);
    g.drawText(btn.getButtonText(), static_cast<int>(boxX + boxSize + 6.0f), 0,
               btn.getWidth() - static_cast<int>(boxX + boxSize + 6.0f), btn.getHeight(),
               juce::Justification::centredLeft);
}

void S13LookAndFeel::drawComboBox(juce::Graphics& g, int w, int h, bool isButtonDown,
                                   int buttonX, int buttonY, int buttonW, int buttonH,
                                   juce::ComboBox& box)
{
    juce::ignoreUnused(isButtonDown, buttonX, buttonY, buttonW, buttonH);
    auto bounds = juce::Rectangle<float>(0.0f, 0.0f, static_cast<float>(w), static_cast<float>(h));
    g.setColour(juce::Colour(bgSection));
    g.fillRoundedRectangle(bounds, 4.0f);
    g.setColour(juce::Colour(borderColor));
    g.drawRoundedRectangle(bounds.reduced(0.5f), 4.0f, 1.0f);

    // Arrow
    const float arrowX = static_cast<float>(w) - 18.0f;
    const float arrowY = static_cast<float>(h) * 0.5f - 3.0f;
    juce::Path arrow;
    arrow.addTriangle(arrowX, arrowY, arrowX + 10.0f, arrowY, arrowX + 5.0f, arrowY + 6.0f);
    g.setColour(box.findColour(juce::ComboBox::arrowColourId));
    g.fillPath(arrow);
}

void S13LookAndFeel::drawPopupMenuItem(juce::Graphics& g, const juce::Rectangle<int>& area,
                                        bool isSeparator, bool isActive, bool isHighlighted,
                                        bool isTicked, bool hasSubMenu, const juce::String& text,
                                        const juce::String& shortcutKeyText,
                                        const juce::Drawable* icon, const juce::Colour* textColour)
{
    juce::ignoreUnused(icon, shortcutKeyText, textColour, hasSubMenu);
    if (isSeparator)
    {
        g.setColour(juce::Colour(borderColor));
        g.fillRect(area.reduced(4, 0).withHeight(1));
        return;
    }

    if (isHighlighted && isActive)
    {
        g.setColour(juce::Colour(accent));
        g.fillRect(area);
    }

    g.setColour(isActive ? (isHighlighted ? juce::Colours::white : juce::Colour(textPrimary))
                         : juce::Colour(textDim));
    g.setFont(13.0f);

    auto textArea = area.reduced(8, 0);
    if (isTicked)
    {
        g.setColour(juce::Colour(accent));
        g.fillEllipse(static_cast<float>(textArea.getX()), static_cast<float>(area.getCentreY()) - 3.0f, 6.0f, 6.0f);
        textArea.removeFromLeft(14);
    }

    g.drawText(text, textArea, juce::Justification::centredLeft);
}

juce::Font S13LookAndFeel::getComboBoxFont(juce::ComboBox&)
{
    return juce::Font(juce::FontOptions(13.0f));
}

juce::Font S13LookAndFeel::getPopupMenuFont()
{
    return juce::Font(juce::FontOptions(13.0f));
}


// ============================================================================
// S13LabeledKnob
// ============================================================================

S13LabeledKnob::S13LabeledKnob(const juce::String& name, const juce::String& sfx,
                                 float minVal, float maxVal, float defaultVal, float step)
    : suffix(sfx)
{
    slider.setSliderStyle(juce::Slider::RotaryHorizontalVerticalDrag);
    slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    slider.setRange(static_cast<double>(minVal), static_cast<double>(maxVal), static_cast<double>(step));
    slider.setValue(static_cast<double>(defaultVal), juce::dontSendNotification);
    slider.setDoubleClickReturnValue(true, static_cast<double>(defaultVal));
    addAndMakeVisible(slider);

    nameLabel.setText(name, juce::dontSendNotification);
    nameLabel.setJustificationType(juce::Justification::centred);
    nameLabel.setFont(juce::Font(juce::FontOptions(10.0f)));
    nameLabel.setColour(juce::Label::textColourId, juce::Colour(S13LookAndFeel::textDim));
    addAndMakeVisible(nameLabel);

    valueLabel.setJustificationType(juce::Justification::centred);
    valueLabel.setFont(juce::Font(juce::FontOptions(11.0f)));
    valueLabel.setColour(juce::Label::textColourId, juce::Colour(S13LookAndFeel::textPrimary));
    addAndMakeVisible(valueLabel);

    slider.onValueChange = [this]()
    {
        updateValueLabel();
        if (onValueChange)
            onValueChange(static_cast<float>(slider.getValue()));
    };

    updateValueLabel();
}

void S13LabeledKnob::resized()
{
    auto b = getLocalBounds();
    nameLabel.setBounds(b.removeFromTop(14));
    valueLabel.setBounds(b.removeFromBottom(14));
    slider.setBounds(b);
}

void S13LabeledKnob::setValue(float val, juce::NotificationType nt)
{
    slider.setValue(static_cast<double>(val), nt);
    updateValueLabel();
}

float S13LabeledKnob::getValue() const
{
    return static_cast<float>(slider.getValue());
}

void S13LabeledKnob::setSkew(float midPoint)
{
    slider.setSkewFactorFromMidPoint(static_cast<double>(midPoint));
}

void S13LabeledKnob::updateValueLabel()
{
    if (formatValue)
    {
        valueLabel.setText(formatValue(static_cast<float>(slider.getValue())), juce::dontSendNotification);
    }
    else
    {
        auto val = static_cast<float>(slider.getValue());
        juce::String text;
        if (std::abs(val) >= 1000.0f)
            text = juce::String(val / 1000.0f, 1) + "k" + suffix;
        else if (std::abs(val) >= 100.0f)
            text = juce::String(static_cast<int>(val)) + suffix;
        else if (std::abs(val) >= 10.0f)
            text = juce::String(val, 1) + suffix;
        else
            text = juce::String(val, 2) + suffix;
        valueLabel.setText(text, juce::dontSendNotification);
    }
}


// ============================================================================
// S13ModeToggle
// ============================================================================

S13ModeToggle::S13ModeToggle() {}

void S13ModeToggle::setLabels(const juce::StringArray& labels)
{
    modeLabels = labels;
    numModes = labels.size();
    if (currentMode >= numModes)
        currentMode = 0;
    repaint();
}

void S13ModeToggle::paint(juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat().reduced(1.0f);
    g.setColour(juce::Colour(S13LookAndFeel::bgSection));
    g.fillRoundedRectangle(b, 4.0f);
    g.setColour(juce::Colour(S13LookAndFeel::borderColor));
    g.drawRoundedRectangle(b, 4.0f, 1.0f);

    const float segW = b.getWidth() / static_cast<float>(numModes);

    for (int i = 0; i < numModes; ++i)
    {
        auto segBounds = b.withX(b.getX() + segW * static_cast<float>(i)).withWidth(segW);

        if (i == currentMode)
        {
            g.setColour(juce::Colour(S13LookAndFeel::accent).withAlpha(0.3f));
            g.fillRoundedRectangle(segBounds.reduced(2.0f), 3.0f);
        }

        g.setFont(11.0f);
        g.setColour(i == currentMode ? juce::Colours::white : juce::Colour(S13LookAndFeel::textDim));
        g.drawText(modeLabels[i], segBounds, juce::Justification::centred);
    }
}

void S13ModeToggle::mouseDown(const juce::MouseEvent& e)
{
    const float segW = static_cast<float>(getWidth()) / static_cast<float>(numModes);
    int clicked = juce::jlimit(0, numModes - 1, static_cast<int>(e.position.x / segW));

    if (clicked != currentMode)
    {
        currentMode = clicked;
        repaint();
        if (onModeChanged)
            onModeChanged(currentMode);
        if (onModeChange)
            onModeChange(isAdvanced());
    }
}


// ============================================================================
// S13GainReductionMeter
// ============================================================================

void S13GainReductionMeter::setGainReduction(float gr)
{
    grDB = gr;
    repaint();
}

void S13GainReductionMeter::paint(juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat().reduced(1.0f);

    g.setColour(juce::Colour(S13LookAndFeel::bgKnob));
    g.fillRoundedRectangle(b, 2.0f);

    // GR bar (grows downward from top, representing reduction)
    const float maxGR = -24.0f;
    const float grNorm = juce::jlimit(0.0f, 1.0f, grDB / maxGR);
    const float barH = b.getHeight() * grNorm;

    if (barH > 0.5f)
    {
        auto grColor = grNorm > 0.7f ? juce::Colour(S13LookAndFeel::meterRed)
                     : grNorm > 0.4f ? juce::Colour(S13LookAndFeel::meterYellow)
                     : juce::Colour(S13LookAndFeel::accent);
        g.setColour(grColor);
        g.fillRoundedRectangle(b.getX(), b.getY(), b.getWidth(), barH, 2.0f);
    }

    // dB labels
    g.setFont(9.0f);
    g.setColour(juce::Colour(S13LookAndFeel::textDim));
    g.drawText("0", b.removeFromTop(12), juce::Justification::centred);
    g.drawText(juce::String(static_cast<int>(maxGR)), b.removeFromBottom(12), juce::Justification::centred);
}


// ============================================================================
// S13SpectrumDisplay
// ============================================================================

S13SpectrumDisplay::S13SpectrumDisplay(S13EQ& eq) : eqProcessor(eq)
{
    startTimerHz(30);
}

void S13SpectrumDisplay::timerCallback()
{
    auto data = eqProcessor.getSpectrumData();
    if (data.ready)
    {
        const float smoothing = 0.7f;
        for (int i = 0; i < S13EQ::fftSize / 2; ++i)
        {
            smoothedPre[i] = smoothedPre[i] * smoothing + data.preEQ[static_cast<size_t>(i)] * (1.0f - smoothing);
            smoothedPost[i] = smoothedPost[i] * smoothing + data.postEQ[static_cast<size_t>(i)] * (1.0f - smoothing);
        }
        hasData = true;
        repaint();
    }
}

float S13SpectrumDisplay::freqToX(float freq, float w) const
{
    const float minFreq = 20.0f;
    const float maxFreq = 20000.0f;
    return w * (std::log10(freq / minFreq) / std::log10(maxFreq / minFreq));
}

float S13SpectrumDisplay::dbToY(float db, float h) const
{
    const float minDB = -80.0f;
    const float maxDB = 6.0f;
    return h * (1.0f - (db - minDB) / (maxDB - minDB));
}

void S13SpectrumDisplay::paint(juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat();
    const float w = b.getWidth();
    const float h = b.getHeight();

    // Background
    g.setColour(juce::Colour(0xff181818));
    g.fillRoundedRectangle(b, 4.0f);

    // Grid lines
    g.setColour(juce::Colour(0xff2a2a2a));
    const float freqLines[] = { 50.0f, 100.0f, 200.0f, 500.0f, 1000.0f, 2000.0f, 5000.0f, 10000.0f };
    for (auto freq : freqLines)
    {
        float x = freqToX(freq, w);
        g.drawVerticalLine(static_cast<int>(x), b.getY(), b.getBottom());
    }

    const float dbLines[] = { -60.0f, -48.0f, -36.0f, -24.0f, -12.0f, 0.0f };
    for (auto db : dbLines)
    {
        float y = dbToY(db, h);
        g.drawHorizontalLine(static_cast<int>(y), b.getX(), b.getRight());
    }

    // 0dB line brighter
    g.setColour(juce::Colour(0xff444444));
    float zeroY = dbToY(0.0f, h);
    g.drawHorizontalLine(static_cast<int>(zeroY), b.getX(), b.getRight());

    // Freq labels
    g.setFont(9.0f);
    g.setColour(juce::Colour(S13LookAndFeel::textDim));
    const float labelFreqs[] = { 100.0f, 1000.0f, 10000.0f };
    const char* labelTexts[] = { "100", "1k", "10k" };
    for (int i = 0; i < 3; ++i)
    {
        float x = freqToX(labelFreqs[i], w);
        g.drawText(labelTexts[i], static_cast<int>(x - 15), static_cast<int>(h - 14), 30, 12, juce::Justification::centred);
    }

    if (!hasData)
        return;

    // Draw spectrum
    const float sampleRate = 44100.0f; // approximate
    const float binWidth = sampleRate / static_cast<float>(S13EQ::fftSize);

    auto drawSpectrum = [&](const float* data, juce::Colour color, float alpha)
    {
        juce::Path path;
        bool started = false;
        for (int i = 1; i < S13EQ::fftSize / 2; ++i)
        {
            float freq = static_cast<float>(i) * binWidth;
            if (freq < 20.0f || freq > 20000.0f)
                continue;
            float x = freqToX(freq, w);
            float magDB = 20.0f * std::log10(std::max(data[i], 1e-10f));
            float y = dbToY(magDB, h);
            y = juce::jlimit(0.0f, h, y);

            if (!started)
            {
                path.startNewSubPath(x, y);
                started = true;
            }
            else
            {
                path.lineTo(x, y);
            }
        }
        if (started)
        {
            g.setColour(color.withAlpha(alpha));
            g.strokePath(path, juce::PathStrokeType(1.5f));
        }
    };

    drawSpectrum(smoothedPre, juce::Colour(S13LookAndFeel::textDim), 0.3f);
    drawSpectrum(smoothedPost, juce::Colour(S13LookAndFeel::accent), 0.8f);

    // EQ curve overlay
    std::vector<float> curveFreqs;
    curveFreqs.reserve(200);
    for (int i = 0; i < 200; ++i)
    {
        float t = static_cast<float>(i) / 199.0f;
        float freq = 20.0f * std::pow(1000.0f, t);
        curveFreqs.push_back(freq);
    }

    auto magnitudes = eqProcessor.getMagnitudeResponse(curveFreqs);
    if (!magnitudes.empty())
    {
        juce::Path curvePath;
        for (size_t i = 0; i < curveFreqs.size(); ++i)
        {
            float x = freqToX(curveFreqs[i], w);
            float magDB = 20.0f * std::log10(std::max(magnitudes[i], 1e-10f));
            float y = dbToY(magDB, h);
            if (i == 0) curvePath.startNewSubPath(x, y);
            else curvePath.lineTo(x, y);
        }
        g.setColour(juce::Colour(S13LookAndFeel::accentBright).withAlpha(0.6f));
        g.strokePath(curvePath, juce::PathStrokeType(2.0f));
    }
}


// ============================================================================
// S13ParametricEQGraph
// ============================================================================

S13ParametricEQGraph::S13ParametricEQGraph(S13EQ& eq) : eqProcessor(eq)
{
    startTimerHz(30);
    setMouseCursor(juce::MouseCursor::CrosshairCursor);
}

void S13ParametricEQGraph::timerCallback()
{
    auto data = eqProcessor.getSpectrumData();
    if (data.ready)
    {
        const float smoothing = 0.7f;
        for (int i = 0; i < S13EQ::fftSize / 2; ++i)
        {
            smoothedPre[i] = smoothedPre[i] * smoothing + data.preEQ[static_cast<size_t>(i)] * (1.0f - smoothing);
            smoothedPost[i] = smoothedPost[i] * smoothing + data.postEQ[static_cast<size_t>(i)] * (1.0f - smoothing);
        }
        hasSpectrumData = true;
    }
    repaint();
}

float S13ParametricEQGraph::freqToX(float freq) const
{
    return static_cast<float>(getWidth()) * (std::log10(freq / minFreq) / std::log10(maxFreq / minFreq));
}

float S13ParametricEQGraph::xToFreq(float x) const
{
    float t = x / static_cast<float>(getWidth());
    return minFreq * std::pow(maxFreq / minFreq, t);
}

float S13ParametricEQGraph::dbToY(float db) const
{
    float h = static_cast<float>(getHeight());
    return h * (1.0f - (db - minDB) / (maxDB - minDB));
}

float S13ParametricEQGraph::yToDb(float y) const
{
    float h = static_cast<float>(getHeight());
    return minDB + (1.0f - y / h) * (maxDB - minDB);
}

int S13ParametricEQGraph::findBandAt(float x, float y) const
{
    float closestDist = pointRadius * 2.0f;
    int closest = -1;
    for (int i = 0; i < S13EQ::numBands; ++i)
    {
        if (eqProcessor.bands[i].enabled.load() < 0.5f)
            continue;
        float bx = freqToX(eqProcessor.bands[i].freq.load());
        float by = dbToY(eqProcessor.bands[i].gain.load());
        float dist = std::sqrt((x - bx) * (x - bx) + (y - by) * (y - by));
        if (dist < closestDist)
        {
            closestDist = dist;
            closest = i;
        }
    }
    return closest;
}

int S13ParametricEQGraph::findFirstDisabledBand() const
{
    for (int i = 0; i < S13EQ::numBands; ++i)
    {
        if (eqProcessor.bands[i].enabled.load() < 0.5f)
            return i;
    }
    return -1;
}

void S13ParametricEQGraph::mouseDown(const juce::MouseEvent& e)
{
    float mx = e.position.x;
    float my = e.position.y;

    // Right-click to disable band
    if (e.mods.isRightButtonDown())
    {
        int band = findBandAt(mx, my);
        if (band >= 0)
        {
            eqProcessor.bands[band].enabled = 0.0f;
            if (onBandChanged) onBandChanged();
        }
        return;
    }

    dragBand = findBandAt(mx, my);

    if (dragBand < 0)
    {
        // Click on empty space: enable a new band at this location
        int newBand = findFirstDisabledBand();
        if (newBand >= 0)
        {
            float freq = juce::jlimit(minFreq, maxFreq, xToFreq(mx));
            float gain = juce::jlimit(minDB, maxDB, yToDb(my));
            eqProcessor.bands[newBand].enabled = 1.0f;
            eqProcessor.bands[newBand].freq = freq;
            eqProcessor.bands[newBand].gain = gain;
            eqProcessor.bands[newBand].type = 0.0f; // Bell
            eqProcessor.bands[newBand].q = 1.0f;
            dragBand = newBand;
            if (onBandChanged) onBandChanged();
        }
    }

    dragging = (dragBand >= 0);
}

void S13ParametricEQGraph::mouseDrag(const juce::MouseEvent& e)
{
    if (!dragging || dragBand < 0)
        return;

    float freq = juce::jlimit(minFreq, maxFreq, xToFreq(e.position.x));
    float gain = juce::jlimit(minDB, maxDB, yToDb(e.position.y));

    eqProcessor.bands[dragBand].freq = freq;
    eqProcessor.bands[dragBand].gain = gain;

    if (onBandChanged) onBandChanged();
}

void S13ParametricEQGraph::mouseUp(const juce::MouseEvent&)
{
    dragging = false;
    dragBand = -1;
}

void S13ParametricEQGraph::mouseMove(const juce::MouseEvent& e)
{
    int newHovered = findBandAt(e.position.x, e.position.y);
    if (newHovered != hoveredBand)
    {
        hoveredBand = newHovered;
        setMouseCursor(hoveredBand >= 0 ? juce::MouseCursor::DraggingHandCursor
                                        : juce::MouseCursor::CrosshairCursor);
        repaint();
    }
}

void S13ParametricEQGraph::mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& w)
{
    int band = findBandAt(e.position.x, e.position.y);
    if (band >= 0)
    {
        float q = eqProcessor.bands[band].q.load();
        float delta = w.deltaY * 0.5f;
        q = juce::jlimit(0.1f, 30.0f, q * (1.0f + delta));
        eqProcessor.bands[band].q = q;
        if (onBandChanged) onBandChanged();
    }
}

void S13ParametricEQGraph::mouseDoubleClick(const juce::MouseEvent& e)
{
    int band = findBandAt(e.position.x, e.position.y);
    if (band >= 0)
    {
        // Reset gain to 0 dB on double-click
        eqProcessor.bands[band].gain = 0.0f;
        if (onBandChanged) onBandChanged();
    }
}

void S13ParametricEQGraph::paint(juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat();
    const float w = b.getWidth();
    const float h = b.getHeight();

    // Background
    g.setColour(juce::Colour(0xff181818));
    g.fillRoundedRectangle(b, 4.0f);

    // Grid lines
    g.setColour(juce::Colour(0xff2a2a2a));
    const float freqLines[] = { 50.0f, 100.0f, 200.0f, 500.0f, 1000.0f, 2000.0f, 5000.0f, 10000.0f };
    for (auto freq : freqLines)
    {
        float x = freqToX(freq);
        g.drawVerticalLine(static_cast<int>(x), b.getY(), b.getBottom());
    }

    const float dbLines[] = { -24.0f, -18.0f, -12.0f, -6.0f, 6.0f, 12.0f, 18.0f, 24.0f };
    for (auto db : dbLines)
    {
        float y = dbToY(db);
        g.drawHorizontalLine(static_cast<int>(y), b.getX(), b.getRight());
    }

    // 0dB line brighter
    g.setColour(juce::Colour(0xff555555));
    float zeroY = dbToY(0.0f);
    g.drawHorizontalLine(static_cast<int>(zeroY), b.getX(), b.getRight());

    // Freq labels
    g.setFont(9.0f);
    g.setColour(juce::Colour(S13LookAndFeel::textDim));
    const float labelFreqs[] = { 50.0f, 100.0f, 200.0f, 500.0f, 1000.0f, 2000.0f, 5000.0f, 10000.0f, 20000.0f };
    const char* labelTexts[] = { "50", "100", "200", "500", "1k", "2k", "5k", "10k", "20k" };
    for (int i = 0; i < 9; ++i)
    {
        float x = freqToX(labelFreqs[i]);
        g.drawText(labelTexts[i], static_cast<int>(x - 15), static_cast<int>(h - 14), 30, 12, juce::Justification::centred);
    }

    // dB labels
    g.drawText("+24", 2, static_cast<int>(dbToY(24.0f)) - 6, 30, 12, juce::Justification::centredLeft);
    g.drawText("+12", 2, static_cast<int>(dbToY(12.0f)) - 6, 30, 12, juce::Justification::centredLeft);
    g.drawText("0", 2, static_cast<int>(zeroY) - 6, 30, 12, juce::Justification::centredLeft);
    g.drawText("-12", 2, static_cast<int>(dbToY(-12.0f)) - 6, 30, 12, juce::Justification::centredLeft);
    g.drawText("-24", 2, static_cast<int>(dbToY(-24.0f)) - 6, 30, 12, juce::Justification::centredLeft);

    // Draw spectrum (subtle background)
    if (hasSpectrumData)
    {
        const float sampleRate = 44100.0f;
        const float binWidth = sampleRate / static_cast<float>(S13EQ::fftSize);

        auto drawSpec = [&](const float* data, juce::Colour color, float alpha)
        {
            juce::Path path;
            bool started = false;
            for (int i = 1; i < S13EQ::fftSize / 2; ++i)
            {
                float freq = static_cast<float>(i) * binWidth;
                if (freq < 20.0f || freq > 20000.0f) continue;
                float x = freqToX(freq);
                // Map spectrum magnitude to our dB range (-30 to +30)
                float magDB = 20.0f * std::log10(std::max(data[i], 1e-10f));
                // Shift from absolute dB to relative (spectrum is roughly -80 to 0, shift to our range)
                float relDB = magDB + 30.0f; // approximate centering
                float y = dbToY(juce::jlimit(minDB, maxDB, relDB));
                if (!started) { path.startNewSubPath(x, y); started = true; }
                else path.lineTo(x, y);
            }
            if (started)
            {
                g.setColour(color.withAlpha(alpha));
                g.strokePath(path, juce::PathStrokeType(1.0f));
            }
        };

        drawSpec(smoothedPost, juce::Colour(S13LookAndFeel::accent), 0.15f);
    }

    // EQ magnitude response curve
    std::vector<float> curveFreqs;
    curveFreqs.reserve(300);
    for (int i = 0; i < 300; ++i)
    {
        float t = static_cast<float>(i) / 299.0f;
        curveFreqs.push_back(minFreq * std::pow(maxFreq / minFreq, t));
    }

    auto magnitudes = eqProcessor.getMagnitudeResponse(curveFreqs);
    if (!magnitudes.empty())
    {
        // Filled area under curve
        juce::Path fillPath;
        juce::Path curvePath;
        for (size_t i = 0; i < curveFreqs.size(); ++i)
        {
            float x = freqToX(curveFreqs[i]);
            float magDB = 20.0f * std::log10(std::max(magnitudes[i], 1e-10f));
            float y = dbToY(juce::jlimit(minDB, maxDB, magDB));
            if (i == 0)
            {
                curvePath.startNewSubPath(x, y);
                fillPath.startNewSubPath(x, zeroY);
                fillPath.lineTo(x, y);
            }
            else
            {
                curvePath.lineTo(x, y);
                fillPath.lineTo(x, y);
            }
        }
        fillPath.lineTo(freqToX(curveFreqs.back()), zeroY);
        fillPath.closeSubPath();

        g.setColour(juce::Colour(S13LookAndFeel::accent).withAlpha(0.1f));
        g.fillPath(fillPath);
        g.setColour(juce::Colour(S13LookAndFeel::accentBright).withAlpha(0.8f));
        g.strokePath(curvePath, juce::PathStrokeType(2.0f));
    }

    // Band colors
    const juce::Colour bandColors[] = {
        juce::Colour(0xffff6b6b), // red
        juce::Colour(0xffff9f43), // orange
        juce::Colour(0xffffd93d), // yellow
        juce::Colour(0xff6bcf7f), // green
        juce::Colour(0xff4ecdc4), // teal
        juce::Colour(0xff45b7d1), // cyan
        juce::Colour(0xff7c6cf0), // purple
        juce::Colour(0xfff06292), // pink
    };

    // Draw per-band individual response curves (subtle)
    for (int band = 0; band < S13EQ::numBands; ++band)
    {
        if (eqProcessor.bands[band].enabled.load() < 0.5f)
            continue;

        // Draw individual band curve
        // We'll approximate by computing what this band alone does
        auto color = bandColors[band];
        g.setColour(color.withAlpha(0.2f));

        // Just draw a visual hint around the band point
        float bx = freqToX(eqProcessor.bands[band].freq.load());
        float by = dbToY(eqProcessor.bands[band].gain.load());
        float qVal = eqProcessor.bands[band].q.load();
        float bandwidth = 60.0f / qVal; // visual width in pixels based on Q

        juce::Path bandHint;
        bandHint.startNewSubPath(bx - bandwidth, zeroY);
        bandHint.quadraticTo(bx, by, bx + bandwidth, zeroY);
        g.strokePath(bandHint, juce::PathStrokeType(1.5f));
    }

    // Draw band points
    for (int i = 0; i < S13EQ::numBands; ++i)
    {
        if (eqProcessor.bands[i].enabled.load() < 0.5f)
            continue;

        float bx = freqToX(eqProcessor.bands[i].freq.load());
        float by = dbToY(eqProcessor.bands[i].gain.load());
        auto color = bandColors[i];

        // Glow/halo for hovered/dragged
        if (i == hoveredBand || i == dragBand)
        {
            g.setColour(color.withAlpha(0.3f));
            g.fillEllipse(bx - pointRadius * 1.8f, by - pointRadius * 1.8f,
                          pointRadius * 3.6f, pointRadius * 3.6f);
        }

        // Point fill
        g.setColour(color);
        g.fillEllipse(bx - pointRadius, by - pointRadius, pointRadius * 2.0f, pointRadius * 2.0f);

        // Point border
        g.setColour(juce::Colours::white.withAlpha(0.8f));
        g.drawEllipse(bx - pointRadius, by - pointRadius, pointRadius * 2.0f, pointRadius * 2.0f, 1.5f);

        // Band number label
        g.setFont(10.0f);
        g.setColour(juce::Colours::white);
        g.drawText(juce::String(i + 1), static_cast<int>(bx - 5), static_cast<int>(by - 5), 10, 10,
                   juce::Justification::centred);

        // Tooltip: freq + gain when hovered
        if (i == hoveredBand || i == dragBand)
        {
            float freq = eqProcessor.bands[i].freq.load();
            float gain = eqProcessor.bands[i].gain.load();
            float qVal = eqProcessor.bands[i].q.load();
            juce::String tip;
            if (freq >= 1000.0f)
                tip = juce::String(freq / 1000.0f, 1) + "kHz  ";
            else
                tip = juce::String(static_cast<int>(freq)) + "Hz  ";
            tip += juce::String(gain, 1) + "dB  Q:" + juce::String(qVal, 1);

            g.setFont(11.0f);
            float tipX = juce::jlimit(0.0f, w - 120.0f, bx - 60.0f);
            float tipY = by > 30.0f ? by - 22.0f : by + pointRadius + 4.0f;
            g.setColour(juce::Colour(0xdd000000));
            g.fillRoundedRectangle(tipX, tipY, 120.0f, 16.0f, 3.0f);
            g.setColour(juce::Colours::white);
            g.drawText(tip, static_cast<int>(tipX), static_cast<int>(tipY), 120, 16,
                       juce::Justification::centred);
        }
    }

    // Instructions hint
    g.setFont(9.0f);
    g.setColour(juce::Colour(S13LookAndFeel::textDim).withAlpha(0.5f));
    g.drawText("Click to add  |  Drag to move  |  Scroll for Q  |  Right-click to remove  |  Double-click to reset",
               b.reduced(4.0f).removeFromTop(14), juce::Justification::centredRight);
}


// ============================================================================
// S13InteractiveCompressorDisplay
// ============================================================================

S13InteractiveCompressorDisplay::S13InteractiveCompressorDisplay(S13Compressor& comp)
    : compressor(comp)
{
    startTimerHz(30);
}

void S13InteractiveCompressorDisplay::timerCallback()
{
    displayGR = compressor.getCurrentGainReduction();
    displayInputLevel = compressor.getInputLevel();
    repaint();
}

float S13InteractiveCompressorDisplay::dbToX(float db) const
{
    return (db + dbRange) / dbRange * static_cast<float>(getWidth());
}

float S13InteractiveCompressorDisplay::dbToY(float db) const
{
    return static_cast<float>(getHeight()) - (db + dbRange) / dbRange * static_cast<float>(getHeight());
}

float S13InteractiveCompressorDisplay::xToDb(float x) const
{
    return x / static_cast<float>(getWidth()) * dbRange - dbRange;
}

float S13InteractiveCompressorDisplay::yToDb(float y) const
{
    return (1.0f - y / static_cast<float>(getHeight())) * dbRange - dbRange;
}

void S13InteractiveCompressorDisplay::mouseDown(const juce::MouseEvent& e)
{
    float thresh = compressor.threshold.load();
    float threshX = dbToX(thresh);

    // Check if near the threshold line (vertical)
    if (std::abs(e.position.x - threshX) < 10.0f)
    {
        dragTarget = Threshold;
        dragStartValue = thresh;
    }
    else if (e.position.x > threshX)
    {
        // Above threshold = ratio area
        dragTarget = Ratio;
        dragStartY = e.position.y;
        dragStartValue = compressor.ratio.load();
    }
}

void S13InteractiveCompressorDisplay::mouseDrag(const juce::MouseEvent& e)
{
    if (dragTarget == Threshold)
    {
        float newThresh = juce::jlimit(-60.0f, 0.0f, xToDb(e.position.x));
        compressor.threshold = newThresh;
        if (onParamChanged) onParamChanged();
    }
    else if (dragTarget == Ratio)
    {
        // Dragging down increases ratio (output goes down relative to 1:1)
        float deltaY = e.position.y - dragStartY;
        float ratioChange = deltaY * 0.05f;
        float newRatio = juce::jlimit(1.0f, 20.0f, dragStartValue + ratioChange);
        compressor.ratio = newRatio;
        if (onParamChanged) onParamChanged();
    }
}

void S13InteractiveCompressorDisplay::mouseUp(const juce::MouseEvent&)
{
    dragTarget = None;
}

void S13InteractiveCompressorDisplay::mouseMove(const juce::MouseEvent& e)
{
    float thresh = compressor.threshold.load();
    float threshX = dbToX(thresh);
    int newHovered = None;

    if (std::abs(e.position.x - threshX) < 10.0f)
        newHovered = Threshold;
    else if (e.position.x > threshX)
        newHovered = Ratio;

    if (newHovered != hoveredTarget)
    {
        hoveredTarget = newHovered;
        if (hoveredTarget == Threshold)
            setMouseCursor(juce::MouseCursor::LeftRightResizeCursor);
        else if (hoveredTarget == Ratio)
            setMouseCursor(juce::MouseCursor::UpDownResizeCursor);
        else
            setMouseCursor(juce::MouseCursor::NormalCursor);
    }
}

void S13InteractiveCompressorDisplay::paint(juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat();
    const float w = b.getWidth();
    const float h = b.getHeight();

    // Background
    g.setColour(juce::Colour(0xff181818));
    g.fillRoundedRectangle(b, 4.0f);

    // Grid
    g.setColour(juce::Colour(0xff2a2a2a));
    for (float db = -48.0f; db <= 0.0f; db += 12.0f)
    {
        float xPos = dbToX(db);
        float yPos = dbToY(db);
        g.drawVerticalLine(static_cast<int>(xPos), b.getY(), b.getBottom());
        g.drawHorizontalLine(static_cast<int>(yPos), b.getX(), b.getRight());
    }

    // 1:1 reference line
    g.setColour(juce::Colour(0xff444444));
    g.drawLine(0.0f, h, w, 0.0f, 1.0f);

    // Transfer curve
    const float thresh = compressor.threshold.load();
    const float ratio = compressor.ratio.load();
    const float kneeDB = compressor.knee.load();

    juce::Path curve;
    for (int px = 0; px < static_cast<int>(w); ++px)
    {
        float inputDB = xToDb(static_cast<float>(px));
        float outputDB;

        if (kneeDB > 0.01f && inputDB > (thresh - kneeDB * 0.5f) && inputDB < (thresh + kneeDB * 0.5f))
        {
            float x2 = inputDB - thresh + kneeDB * 0.5f;
            outputDB = inputDB + ((1.0f / ratio - 1.0f) * x2 * x2) / (2.0f * kneeDB);
        }
        else if (inputDB >= thresh + kneeDB * 0.5f)
        {
            outputDB = thresh + (inputDB - thresh) / ratio;
        }
        else
        {
            outputDB = inputDB;
        }

        float xPos = static_cast<float>(px);
        float yPos = dbToY(outputDB);
        yPos = juce::jlimit(0.0f, h, yPos);

        if (px == 0) curve.startNewSubPath(xPos, yPos);
        else curve.lineTo(xPos, yPos);
    }

    g.setColour(juce::Colour(S13LookAndFeel::accent));
    g.strokePath(curve, juce::PathStrokeType(2.0f));

    // Threshold marker (draggable)
    float threshX = dbToX(thresh);
    bool threshHovered = (hoveredTarget == Threshold || dragTarget == Threshold);
    g.setColour(juce::Colour(S13LookAndFeel::meterYellow).withAlpha(threshHovered ? 0.8f : 0.5f));
    g.drawVerticalLine(static_cast<int>(threshX), b.getY(), b.getBottom());

    // Threshold handle
    g.setColour(juce::Colour(S13LookAndFeel::meterYellow));
    g.fillRoundedRectangle(threshX - 4.0f, h - 16.0f, 8.0f, 16.0f, 2.0f);
    g.setFont(8.0f);
    g.setColour(juce::Colours::black);
    g.drawText("T", static_cast<int>(threshX - 4), static_cast<int>(h - 16), 8, 16, juce::Justification::centred);

    // Input level indicator
    if (displayInputLevel > -60.0f)
    {
        float inputX = dbToX(displayInputLevel);
        g.setColour(juce::Colour(S13LookAndFeel::meterGreen).withAlpha(0.4f));
        g.drawVerticalLine(static_cast<int>(inputX), b.getY(), b.getBottom());
    }

    // GR text
    g.setFont(14.0f);
    g.setColour(displayGR < -1.0f ? juce::Colour(S13LookAndFeel::meterYellow) : juce::Colour(S13LookAndFeel::textDim));
    g.drawText("GR: " + juce::String(displayGR, 1) + " dB",
               b.reduced(6.0f).removeFromTop(18), juce::Justification::topRight);

    // Ratio display
    g.setFont(11.0f);
    g.setColour(juce::Colour(S13LookAndFeel::textDim));
    g.drawText("Ratio: " + juce::String(ratio, 1) + ":1",
               b.reduced(6.0f).removeFromTop(36).removeFromBottom(18), juce::Justification::topRight);

    // Hint
    g.setFont(9.0f);
    g.setColour(juce::Colour(S13LookAndFeel::textDim).withAlpha(0.4f));
    g.drawText("Drag threshold line  |  Drag above threshold to change ratio",
               b.reduced(4.0f).removeFromBottom(14), juce::Justification::centredLeft);
}


// ============================================================================
// S13CompressorDisplay (legacy non-interactive)
// ============================================================================

S13CompressorDisplay::S13CompressorDisplay(S13Compressor& comp)
    : compressor(comp)
{
    startTimerHz(30);
}

void S13CompressorDisplay::timerCallback()
{
    displayGR = compressor.getCurrentGainReduction();
    displayInputLevel = compressor.getInputLevel();
    repaint();
}

void S13CompressorDisplay::paint(juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat();
    const float w = b.getWidth();
    const float h = b.getHeight();

    // Background
    g.setColour(juce::Colour(0xff181818));
    g.fillRoundedRectangle(b, 4.0f);

    const float dbRange = 60.0f;
    auto dbToPos = [&](float db) { return (db + dbRange) / dbRange; };

    // Grid
    g.setColour(juce::Colour(0xff2a2a2a));
    for (float db = -48.0f; db <= 0.0f; db += 12.0f)
    {
        float pos = dbToPos(db);
        g.drawVerticalLine(static_cast<int>(pos * w), b.getY(), b.getBottom());
        g.drawHorizontalLine(static_cast<int>(h - pos * h), b.getX(), b.getRight());
    }

    // 1:1 reference line
    g.setColour(juce::Colour(0xff444444));
    g.drawLine(0.0f, h, w, 0.0f, 1.0f);

    // Transfer curve
    const float thresh = compressor.threshold.load();
    const float ratio = compressor.ratio.load();
    const float kneeDB = compressor.knee.load();

    juce::Path curve;
    for (int px = 0; px < static_cast<int>(w); ++px)
    {
        float inputDB = -dbRange + (static_cast<float>(px) / w) * dbRange;
        float outputDB;

        if (kneeDB > 0.01f && inputDB > (thresh - kneeDB * 0.5f) && inputDB < (thresh + kneeDB * 0.5f))
        {
            float x2 = inputDB - thresh + kneeDB * 0.5f;
            outputDB = inputDB + ((1.0f / ratio - 1.0f) * x2 * x2) / (2.0f * kneeDB);
        }
        else if (inputDB >= thresh + kneeDB * 0.5f)
        {
            outputDB = thresh + (inputDB - thresh) / ratio;
        }
        else
        {
            outputDB = inputDB;
        }

        float xPos = static_cast<float>(px);
        float yPos = h - dbToPos(outputDB) * h;
        yPos = juce::jlimit(0.0f, h, yPos);

        if (px == 0) curve.startNewSubPath(xPos, yPos);
        else curve.lineTo(xPos, yPos);
    }

    g.setColour(juce::Colour(S13LookAndFeel::accent));
    g.strokePath(curve, juce::PathStrokeType(2.0f));

    // Threshold marker
    float threshX = dbToPos(thresh) * w;
    g.setColour(juce::Colour(S13LookAndFeel::meterYellow).withAlpha(0.5f));
    g.drawVerticalLine(static_cast<int>(threshX), b.getY(), b.getBottom());

    // GR text
    g.setFont(14.0f);
    g.setColour(displayGR < -1.0f ? juce::Colour(S13LookAndFeel::meterYellow) : juce::Colour(S13LookAndFeel::textDim));
    g.drawText("GR: " + juce::String(displayGR, 1) + " dB",
               b.reduced(6.0f).removeFromTop(18), juce::Justification::topRight);
}


// ============================================================================
// Helper: Layout for knobs in rows
// ============================================================================
namespace
{
    constexpr int knobW = 70;
    constexpr int knobH = 80;
    constexpr int headerH = 32;
    constexpr int modeToggleH = 24;
    constexpr int sectionPadding = 8;

    void layoutKnobRow(juce::Rectangle<int>& area, std::initializer_list<juce::Component*> knobs, int height = knobH)
    {
        auto row = area.removeFromTop(height);
        int count = static_cast<int>(knobs.size());
        int totalW = count * knobW;
        int startX = row.getX() + (row.getWidth() - totalW) / 2;
        for (auto* k : knobs)
        {
            if (k)
            {
                k->setBounds(startX, row.getY(), knobW, height);
                k->setVisible(true);
            }
            startX += knobW;
        }
    }

    void paintEditorBackground(juce::Graphics& g, juce::Component& comp, const juce::String& title)
    {
        auto b = comp.getLocalBounds().toFloat();
        // Gradient background
        g.setGradientFill(juce::ColourGradient(juce::Colour(S13LookAndFeel::bgDark), 0.0f, 0.0f,
                                                juce::Colour(S13LookAndFeel::bgPanel), 0.0f, b.getHeight(), false));
        g.fillAll();

        // Title
        g.setFont(juce::Font(juce::FontOptions(18.0f, juce::Font::bold)));
        g.setColour(juce::Colours::white);
        g.drawText(title, 12, 6, static_cast<int>(b.getWidth()) - 24, headerH - 6, juce::Justification::centredLeft);

        // Bottom border accent
        g.setColour(juce::Colour(S13LookAndFeel::accent));
        g.fillRect(0.0f, b.getHeight() - 2.0f, b.getWidth(), 2.0f);
    }
}


// ============================================================================
// S13EQEditor
// ============================================================================

S13EQEditor::S13EQEditor(S13EQ& p)
    : AudioProcessorEditor(p), proc(p), spectrum(p), parametricGraph(p),
      hpFreqKnob("HP Freq", "Hz", 20.0f, 2000.0f, 20.0f, 1.0f),
      lpFreqKnob("LP Freq", "Hz", 200.0f, 20000.0f, 20000.0f, 1.0f),
      outputGainKnob("Output", "dB", -12.0f, 12.0f, 0.0f)
{
    setLookAndFeel(&laf);

    modeToggle.setLabels({ "Basic", "Graph", "Advanced" });
    addAndMakeVisible(modeToggle);
    addAndMakeVisible(spectrum);
    addAndMakeVisible(parametricGraph);
    addAndMakeVisible(outputGainKnob);
    addAndMakeVisible(autoGainBtn);
    autoGainBtn.setButtonText("Auto Gain");

    // HP/LP filter controls (always visible)
    hpEnabledBtn = std::make_unique<juce::ToggleButton>();
    lpEnabledBtn = std::make_unique<juce::ToggleButton>();
    addAndMakeVisible(*hpEnabledBtn);
    addAndMakeVisible(*lpEnabledBtn);
    addAndMakeVisible(hpFreqKnob);
    addAndMakeVisible(lpFreqKnob);
    hpFreqKnob.setSkew(200.0f);
    lpFreqKnob.setSkew(4000.0f);

    // Band 0 = HP filter, Band 7 = LP filter by convention
    hpEnabledBtn->onClick = [this]() {
        proc.bands[0].enabled = hpEnabledBtn->getToggleState() ? 1.0f : 0.0f;
        if (hpEnabledBtn->getToggleState())
            proc.bands[0].type = 3.0f; // Low Cut
    };
    lpEnabledBtn->onClick = [this]() {
        proc.bands[7].enabled = lpEnabledBtn->getToggleState() ? 1.0f : 0.0f;
        if (lpEnabledBtn->getToggleState())
            proc.bands[7].type = 4.0f; // High Cut
    };
    hpFreqKnob.onValueChange = [this](float v) { proc.bands[0].freq = v; };
    lpFreqKnob.onValueChange = [this](float v) { proc.bands[7].freq = v; };

    outputGainKnob.onValueChange = [this](float v) { proc.outputGain = v; };
    autoGainBtn.onClick = [this]() { proc.autoGain = autoGainBtn.getToggleState() ? 1.0f : 0.0f; };

    for (int i = 0; i < S13EQ::numBands; ++i)
        setupBand(i);

    parametricGraph.onBandChanged = [this]() { syncFromProcessor(); };
    modeToggle.onModeChanged = [this](int) { resized(); };

    syncFromProcessor();
    setSize(700, 520); // must be after setupBand — setSize triggers resized()
    startTimerHz(10);
}

S13EQEditor::~S13EQEditor() { setLookAndFeel(nullptr); }

void S13EQEditor::setupBand(int idx)
{
    auto& bc = bandControls[idx];

    bc.enabled = std::make_unique<juce::ToggleButton>();
    bc.enabled->onClick = [this, idx]() { proc.bands[idx].enabled = bandControls[idx].enabled->getToggleState() ? 1.0f : 0.0f; };
    addAndMakeVisible(*bc.enabled);

    bc.type = std::make_unique<juce::ComboBox>();
    bc.type->addItem("Bell", 1);
    bc.type->addItem("Low Shelf", 2);
    bc.type->addItem("High Shelf", 3);
    bc.type->addItem("Low Cut", 4);
    bc.type->addItem("High Cut", 5);
    bc.type->addItem("Notch", 6);
    bc.type->addItem("Band Pass", 7);
    bc.type->onChange = [this, idx]() { proc.bands[idx].type = static_cast<float>(bandControls[idx].type->getSelectedId() - 1); };
    addAndMakeVisible(*bc.type);

    // Default frequencies spread across the spectrum
    const float defaultFreqs[] = { 50.0f, 120.0f, 250.0f, 500.0f, 1000.0f, 3000.0f, 8000.0f, 16000.0f };
    bc.freq = std::make_unique<S13LabeledKnob>("Freq", "Hz", 20.0f, 20000.0f, defaultFreqs[idx], 1.0f);
    bc.freq->setSkew(1000.0f);
    bc.freq->onValueChange = [this, idx](float v) { proc.bands[idx].freq = v; };
    addAndMakeVisible(*bc.freq);

    bc.gain = std::make_unique<S13LabeledKnob>("Gain", "dB", -30.0f, 30.0f, 0.0f, 0.1f);
    bc.gain->onValueChange = [this, idx](float v) { proc.bands[idx].gain = v; };
    addAndMakeVisible(*bc.gain);

    bc.q = std::make_unique<S13LabeledKnob>("Q", "", 0.1f, 30.0f, 1.0f, 0.01f);
    bc.q->setSkew(2.0f);
    bc.q->onValueChange = [this, idx](float v) { proc.bands[idx].q = v; };
    addAndMakeVisible(*bc.q);

    bc.slope = std::make_unique<juce::ComboBox>();
    bc.slope->addItem("6 dB/oct", 1);
    bc.slope->addItem("12 dB/oct", 2);
    bc.slope->addItem("24 dB/oct", 3);
    bc.slope->addItem("48 dB/oct", 4);
    bc.slope->onChange = [this, idx]() { proc.bands[idx].slope = static_cast<float>(bandControls[idx].slope->getSelectedId() - 1); };
    addAndMakeVisible(*bc.slope);
}

void S13EQEditor::syncFromProcessor()
{
    for (int i = 0; i < S13EQ::numBands; ++i)
    {
        auto& bc = bandControls[i];
        bc.enabled->setToggleState(proc.bands[i].enabled.load() > 0.5f, juce::dontSendNotification);
        bc.type->setSelectedId(static_cast<int>(proc.bands[i].type.load()) + 1, juce::dontSendNotification);
        bc.freq->setValue(proc.bands[i].freq.load());
        bc.gain->setValue(proc.bands[i].gain.load());
        bc.q->setValue(proc.bands[i].q.load());
        bc.slope->setSelectedId(static_cast<int>(proc.bands[i].slope.load()) + 1, juce::dontSendNotification);
    }
    // HP/LP filter sync
    hpEnabledBtn->setToggleState(proc.bands[0].enabled.load() > 0.5f && static_cast<int>(proc.bands[0].type.load()) == 3,
                                  juce::dontSendNotification);
    lpEnabledBtn->setToggleState(proc.bands[7].enabled.load() > 0.5f && static_cast<int>(proc.bands[7].type.load()) == 4,
                                  juce::dontSendNotification);
    hpFreqKnob.setValue(proc.bands[0].freq.load());
    lpFreqKnob.setValue(proc.bands[7].freq.load());

    outputGainKnob.setValue(proc.outputGain.load());
    autoGainBtn.setToggleState(proc.autoGain.load() > 0.5f, juce::dontSendNotification);
}

void S13EQEditor::timerCallback()
{
    // Sync values periodically (in case changed externally, e.g. automation)
    syncFromProcessor();
}

void S13EQEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio EQ");

    // HP icon (high-pass filter slope icon)
    auto hpBounds = hpEnabledBtn->getBounds().toFloat();
    float iconY = hpBounds.getCentreY();
    float iconX = hpBounds.getRight() + 2.0f;
    bool hpOn = hpEnabledBtn->getToggleState();

    g.setColour(hpOn ? juce::Colour(S13LookAndFeel::accent) : juce::Colour(S13LookAndFeel::textDim));
    g.setFont(10.0f);
    // Draw HP filter icon: rising slope
    {
        juce::Path hp;
        hp.startNewSubPath(iconX, iconY + 5.0f);
        hp.lineTo(iconX + 6.0f, iconY + 5.0f);
        hp.quadraticTo(iconX + 10.0f, iconY + 5.0f, iconX + 12.0f, iconY - 5.0f);
        hp.lineTo(iconX + 18.0f, iconY - 5.0f);
        g.strokePath(hp, juce::PathStrokeType(1.5f));
    }
    g.drawText("HP", static_cast<int>(iconX + 20), static_cast<int>(iconY - 6), 20, 12, juce::Justification::centredLeft);

    // LP icon (low-pass filter slope icon)
    auto lpBounds = lpEnabledBtn->getBounds().toFloat();
    float lpIconY = lpBounds.getCentreY();
    float lpIconX = lpBounds.getX() - 44.0f;
    bool lpOn = lpEnabledBtn->getToggleState();

    g.setColour(lpOn ? juce::Colour(S13LookAndFeel::accent) : juce::Colour(S13LookAndFeel::textDim));
    g.drawText("LP", static_cast<int>(lpIconX), static_cast<int>(lpIconY - 6), 20, 12, juce::Justification::centredRight);
    // Draw LP filter icon: falling slope
    {
        juce::Path lp;
        lp.startNewSubPath(lpIconX + 22.0f, lpIconY - 5.0f);
        lp.lineTo(lpIconX + 28.0f, lpIconY - 5.0f);
        lp.quadraticTo(lpIconX + 32.0f, lpIconY - 5.0f, lpIconX + 34.0f, lpIconY + 5.0f);
        lp.lineTo(lpIconX + 40.0f, lpIconY + 5.0f);
        g.strokePath(lp, juce::PathStrokeType(1.5f));
    }
}

void S13EQEditor::resized()
{
    auto b = getLocalBounds();
    auto topBar = b.removeFromTop(headerH);
    modeToggle.setBounds(topBar.removeFromRight(200).reduced(4, 4));

    int mode = modeToggle.getMode(); // 0=Basic, 1=Graph, 2=Advanced

    // HP/LP filter strip (always visible at top)
    auto filterStrip = b.removeFromTop(30);
    {
        auto hpArea = filterStrip.removeFromLeft(filterStrip.getWidth() / 2);
        auto lpArea = filterStrip;

        hpEnabledBtn->setBounds(hpArea.removeFromLeft(20).reduced(2));
        hpFreqKnob.setBounds(hpArea.removeFromLeft(knobW).withHeight(28));
        hpEnabledBtn->setVisible(true);
        hpFreqKnob.setVisible(true);

        lpEnabledBtn->setBounds(lpArea.removeFromRight(20).reduced(2));
        lpFreqKnob.setBounds(lpArea.removeFromRight(knobW).withHeight(28));
        lpEnabledBtn->setVisible(true);
        lpFreqKnob.setVisible(true);
    }

    // Show/hide displays based on mode
    spectrum.setVisible(mode != 1);       // hide spectrum in Graph mode
    parametricGraph.setVisible(mode == 1); // show graph only in Graph mode

    if (mode == 1) // Graph mode
    {
        // Large interactive graph
        parametricGraph.setBounds(b.removeFromTop(b.getHeight() - knobH - sectionPadding).reduced(8, 4));

        // Hide all band knob controls
        for (int i = 0; i < S13EQ::numBands; ++i)
        {
            auto& bc = bandControls[i];
            bc.freq->setVisible(false);
            bc.gain->setVisible(false);
            bc.q->setVisible(false);
            bc.slope->setVisible(false);
            bc.type->setVisible(false);
            bc.enabled->setVisible(false);
        }

        // Output knob + auto gain at bottom
        auto outputArea = b.reduced(8, 4).removeFromTop(knobH);
        outputGainKnob.setBounds(outputArea.removeFromLeft(knobW));
        autoGainBtn.setBounds(outputArea.removeFromLeft(100).withHeight(24).withY(outputArea.getCentreY() - 12));
    }
    else
    {
        // Spectrum display
        spectrum.setBounds(b.removeFromTop(180).reduced(8, 4));

        bool adv = (mode == 2);
        auto knobArea = b.reduced(8, 4);

        if (adv)
        {
            // 8 bands: each gets freq/gain/q + type/slope selectors
            int bandW = knobArea.getWidth() / 4;
            int bandH = (knobArea.getHeight() - knobH) / 2;

            for (int row = 0; row < 2; ++row)
            {
                auto rowArea = knobArea.removeFromTop(bandH);
                for (int col = 0; col < 4; ++col)
                {
                    int idx = row * 4 + col;
                    auto bandArea = rowArea.removeFromLeft(bandW);
                    auto& bc = bandControls[idx];

                    auto topRow2 = bandArea.removeFromTop(20);
                    bc.enabled->setBounds(topRow2.removeFromLeft(20));
                    bc.type->setBounds(topRow2.removeFromLeft(bandW / 2 - 10));
                    bc.slope->setBounds(topRow2);

                    bc.freq->setVisible(true);
                    bc.gain->setVisible(true);
                    bc.q->setVisible(true);
                    bc.slope->setVisible(true);
                    bc.type->setVisible(true);
                    bc.enabled->setVisible(true);

                    auto ctrlRow = bandArea;
                    int kw = ctrlRow.getWidth() / 3;
                    bc.freq->setBounds(ctrlRow.removeFromLeft(kw));
                    bc.gain->setBounds(ctrlRow.removeFromLeft(kw));
                    bc.q->setBounds(ctrlRow);
                }
            }
        }
        else
        {
            // Basic: 4 key bands (1,2,5,6 - mid bands) with freq+gain
            // Bands 0 and 7 are handled by HP/LP controls above
            const int basicBands[] = { 1, 2, 5, 6 };

            for (int i = 0; i < S13EQ::numBands; ++i)
            {
                auto& bc = bandControls[i];
                bool show = false;
                for (int bb : basicBands)
                    if (bb == i) show = true;

                bc.freq->setVisible(show);
                bc.gain->setVisible(show);
                bc.q->setVisible(false);
                bc.slope->setVisible(false);
                bc.type->setVisible(false);
                bc.enabled->setVisible(show);
            }

            auto basicRow = knobArea.removeFromTop(knobH + 20);
            int bandW = basicRow.getWidth() / 4;
            for (int bb : basicBands)
            {
                auto bandArea = basicRow.removeFromLeft(bandW);
                auto& bc = bandControls[bb];
                auto topPart = bandArea.removeFromTop(20);
                bc.enabled->setBounds(topPart.removeFromLeft(20));
                int kw = bandArea.getWidth() / 2;
                bc.freq->setBounds(bandArea.removeFromLeft(kw));
                bc.gain->setBounds(bandArea);
            }
        }

        // Output knob + auto gain
        auto outputArea = knobArea.removeFromTop(knobH);
        outputGainKnob.setBounds(outputArea.removeFromLeft(knobW));
        autoGainBtn.setBounds(outputArea.removeFromLeft(100).withHeight(24).withY(outputArea.getCentreY() - 12));
    }
}


// ============================================================================
// S13CompressorEditor
// ============================================================================

S13CompressorEditor::S13CompressorEditor(S13Compressor& p)
    : AudioProcessorEditor(p), proc(p), display(p),
      thresholdKnob("Threshold", "dB", -60.0f, 0.0f, 0.0f, 0.1f),
      ratioKnob("Ratio", ":1", 1.0f, 20.0f, 1.0f, 0.1f),
      attackKnob("Attack", "ms", 0.1f, 100.0f, 10.0f, 0.1f),
      releaseKnob("Release", "ms", 10.0f, 2000.0f, 100.0f, 1.0f),
      kneeKnob("Knee", "dB", 0.0f, 24.0f, 0.0f, 0.1f),
      makeupKnob("Makeup", "dB", 0.0f, 36.0f, 0.0f, 0.1f),
      mixKnob("Mix", "%", 0.0f, 100.0f, 100.0f, 1.0f),
      scHPFKnob("SC HPF", "Hz", 20.0f, 500.0f, 20.0f, 1.0f),
      lookaheadKnob("Lookahead", "ms", 0.0f, 20.0f, 0.0f, 0.1f)
{
    setLookAndFeel(&laf);
    setSize(540, 400);

    addAndMakeVisible(modeToggle);
    addAndMakeVisible(display);

    // Interactive display syncs back to knobs
    display.onParamChanged = [this]() { syncFromProcessor(); };

    for (auto* k : { &thresholdKnob, &ratioKnob, &attackKnob, &releaseKnob,
                     &kneeKnob, &makeupKnob, &mixKnob, &scHPFKnob, &lookaheadKnob })
        addAndMakeVisible(*k);

    thresholdKnob.onValueChange = [this](float v) { proc.threshold = v; };
    ratioKnob.onValueChange = [this](float v) { proc.ratio = v; };
    attackKnob.onValueChange = [this](float v) { proc.attack = v; };
    releaseKnob.onValueChange = [this](float v) { proc.release = v; };
    kneeKnob.onValueChange = [this](float v) { proc.knee = v; };
    makeupKnob.onValueChange = [this](float v) { proc.makeupGain = v; };
    mixKnob.onValueChange = [this](float v) { proc.mix = v / 100.0f; };
    scHPFKnob.onValueChange = [this](float v) { proc.sidechainHPF = v; };
    lookaheadKnob.onValueChange = [this](float v) { proc.lookaheadMs = v; };

    attackKnob.setSkew(10.0f);
    releaseKnob.setSkew(200.0f);
    scHPFKnob.setSkew(100.0f);

    ratioKnob.formatValue = [](float v) { return juce::String(v, 1) + ":1"; };

    addAndMakeVisible(styleBox);
    styleBox.addItem("Clean", 1);
    styleBox.addItem("Punch", 2);
    styleBox.addItem("Opto", 3);
    styleBox.addItem("FET", 4);
    styleBox.addItem("VCA", 5);
    styleBox.onChange = [this]() { proc.style = static_cast<float>(styleBox.getSelectedId() - 1); };

    addAndMakeVisible(autoMakeupBtn);
    autoMakeupBtn.setButtonText("Auto Makeup");
    autoMakeupBtn.onClick = [this]() { proc.autoMakeup = autoMakeupBtn.getToggleState() ? 1.0f : 0.0f; };

    addAndMakeVisible(autoReleaseBtn);
    autoReleaseBtn.setButtonText("Auto Release");
    autoReleaseBtn.onClick = [this]() { proc.autoRelease = autoReleaseBtn.getToggleState() ? 1.0f : 0.0f; };

    modeToggle.onModeChange = [this](bool) { resized(); };

    syncFromProcessor();
    startTimerHz(10);
}

S13CompressorEditor::~S13CompressorEditor() { setLookAndFeel(nullptr); }

void S13CompressorEditor::syncFromProcessor()
{
    thresholdKnob.setValue(proc.threshold.load());
    ratioKnob.setValue(proc.ratio.load());
    attackKnob.setValue(proc.attack.load());
    releaseKnob.setValue(proc.release.load());
    kneeKnob.setValue(proc.knee.load());
    makeupKnob.setValue(proc.makeupGain.load());
    mixKnob.setValue(proc.mix.load() * 100.0f);
    scHPFKnob.setValue(proc.sidechainHPF.load());
    lookaheadKnob.setValue(proc.lookaheadMs.load());
    styleBox.setSelectedId(static_cast<int>(proc.style.load()) + 1, juce::dontSendNotification);
    autoMakeupBtn.setToggleState(proc.autoMakeup.load() > 0.5f, juce::dontSendNotification);
    autoReleaseBtn.setToggleState(proc.autoRelease.load() > 0.5f, juce::dontSendNotification);
}

void S13CompressorEditor::timerCallback() { syncFromProcessor(); }

void S13CompressorEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio Compressor");
}

void S13CompressorEditor::resized()
{
    auto b = getLocalBounds();
    auto topBar = b.removeFromTop(headerH);
    modeToggle.setBounds(topBar.removeFromRight(140).reduced(4, 4));

    display.setBounds(b.removeFromTop(160).reduced(8, 4));

    bool adv = modeToggle.isAdvanced();
    auto area = b.reduced(8, 4);

    // Style selector
    auto styleRow = area.removeFromTop(28);
    styleBox.setBounds(styleRow.removeFromLeft(120).reduced(0, 2));

    // Basic knobs: Threshold, Ratio, Attack, Release, Makeup
    layoutKnobRow(area, { &thresholdKnob, &ratioKnob, &attackKnob, &releaseKnob, &makeupKnob });

    // Advanced knobs
    kneeKnob.setVisible(adv);
    mixKnob.setVisible(adv);
    scHPFKnob.setVisible(adv);
    lookaheadKnob.setVisible(adv);
    autoMakeupBtn.setVisible(adv);
    autoReleaseBtn.setVisible(adv);

    if (adv)
    {
        layoutKnobRow(area, { &kneeKnob, &mixKnob, &scHPFKnob, &lookaheadKnob });
        auto btnRow = area.removeFromTop(24);
        autoMakeupBtn.setBounds(btnRow.removeFromLeft(130));
        autoReleaseBtn.setBounds(btnRow.removeFromLeft(130));
    }
}


// ============================================================================
// S13GateEditor
// ============================================================================

S13GateEditor::S13GateEditor(S13Gate& p)
    : AudioProcessorEditor(p), proc(p),
      thresholdKnob("Threshold", "dB", -80.0f, 0.0f, -40.0f, 0.1f),
      attackKnob("Attack", "ms", 0.01f, 50.0f, 1.0f, 0.01f),
      holdKnob("Hold", "ms", 0.0f, 500.0f, 50.0f, 1.0f),
      releaseKnob("Release", "ms", 5.0f, 2000.0f, 50.0f, 1.0f),
      rangeKnob("Range", "dB", -80.0f, 0.0f, -80.0f, 0.1f),
      hysteresisKnob("Hysteresis", "dB", 0.0f, 20.0f, 0.0f, 0.1f),
      mixKnob("Mix", "%", 0.0f, 100.0f, 100.0f, 1.0f),
      scHPFKnob("SC HPF", "Hz", 20.0f, 2000.0f, 20.0f, 1.0f),
      scLPFKnob("SC LPF", "Hz", 200.0f, 20000.0f, 20000.0f, 1.0f)
{
    setLookAndFeel(&laf);
    setSize(480, 320);

    addAndMakeVisible(modeToggle);
    addAndMakeVisible(gateIndicator);

    for (auto* k : { &thresholdKnob, &attackKnob, &holdKnob, &releaseKnob,
                     &rangeKnob, &hysteresisKnob, &mixKnob, &scHPFKnob, &scLPFKnob })
        addAndMakeVisible(*k);

    thresholdKnob.onValueChange = [this](float v) { proc.threshold = v; };
    attackKnob.onValueChange = [this](float v) { proc.attackMs = v; };
    holdKnob.onValueChange = [this](float v) { proc.holdMs = v; };
    releaseKnob.onValueChange = [this](float v) { proc.releaseMs = v; };
    rangeKnob.onValueChange = [this](float v) { proc.range = v; };
    hysteresisKnob.onValueChange = [this](float v) { proc.hysteresis = v; };
    mixKnob.onValueChange = [this](float v) { proc.mix = v / 100.0f; };
    scHPFKnob.onValueChange = [this](float v) { proc.sidechainHPF = v; };
    scLPFKnob.onValueChange = [this](float v) { proc.sidechainLPF = v; };

    releaseKnob.setSkew(200.0f);
    scHPFKnob.setSkew(200.0f);
    scLPFKnob.setSkew(4000.0f);

    modeToggle.onModeChange = [this](bool) { resized(); };

    syncFromProcessor();
    startTimerHz(10);
}

S13GateEditor::~S13GateEditor() { setLookAndFeel(nullptr); }

void S13GateEditor::syncFromProcessor()
{
    thresholdKnob.setValue(proc.threshold.load());
    attackKnob.setValue(proc.attackMs.load());
    holdKnob.setValue(proc.holdMs.load());
    releaseKnob.setValue(proc.releaseMs.load());
    rangeKnob.setValue(proc.range.load());
    hysteresisKnob.setValue(proc.hysteresis.load());
    mixKnob.setValue(proc.mix.load() * 100.0f);
    scHPFKnob.setValue(proc.sidechainHPF.load());
    scLPFKnob.setValue(proc.sidechainLPF.load());
}

void S13GateEditor::timerCallback()
{
    syncFromProcessor();

    // Gate indicator
    bool open = proc.isGateOpen();
    gateIndicator.repaint();
    juce::ignoreUnused(open);
}

void S13GateEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio Gate");

    // Gate indicator
    auto indBounds = gateIndicator.getBounds().toFloat();
    g.setColour(proc.isGateOpen() ? juce::Colour(S13LookAndFeel::meterGreen) : juce::Colour(S13LookAndFeel::meterRed));
    g.fillEllipse(indBounds.reduced(2.0f));
}

void S13GateEditor::resized()
{
    auto b = getLocalBounds();
    auto topBar = b.removeFromTop(headerH);
    modeToggle.setBounds(topBar.removeFromRight(140).reduced(4, 4));
    gateIndicator.setBounds(topBar.removeFromRight(24).reduced(4));

    bool adv = modeToggle.isAdvanced();
    auto area = b.reduced(8, 4);

    // Basic: Threshold, Attack, Hold, Release
    layoutKnobRow(area, { &thresholdKnob, &attackKnob, &holdKnob, &releaseKnob });

    // Advanced
    rangeKnob.setVisible(adv);
    hysteresisKnob.setVisible(adv);
    mixKnob.setVisible(adv);
    scHPFKnob.setVisible(adv);
    scLPFKnob.setVisible(adv);

    if (adv)
    {
        layoutKnobRow(area, { &rangeKnob, &hysteresisKnob, &mixKnob, &scHPFKnob, &scLPFKnob });
    }
}


// ============================================================================
// S13LimiterEditor
// ============================================================================

S13LimiterEditor::S13LimiterEditor(S13Limiter& p)
    : AudioProcessorEditor(p), proc(p),
      thresholdKnob("Threshold", "dB", -20.0f, 0.0f, -1.0f, 0.1f),
      releaseKnob("Release", "ms", 10.0f, 500.0f, 100.0f, 1.0f),
      ceilingKnob("Ceiling", "dB", -3.0f, 0.0f, 0.0f, 0.1f),
      lookaheadKnob("Lookahead", "ms", 0.0f, 20.0f, 5.0f, 0.1f)
{
    setLookAndFeel(&laf);
    setSize(400, 280);

    addAndMakeVisible(grMeter);

    for (auto* k : { &thresholdKnob, &releaseKnob, &ceilingKnob, &lookaheadKnob })
        addAndMakeVisible(*k);

    thresholdKnob.onValueChange = [this](float v) { proc.threshold = v; };
    releaseKnob.onValueChange = [this](float v) { proc.releaseMs = v; };
    ceilingKnob.onValueChange = [this](float v) { proc.ceiling = v; };
    lookaheadKnob.onValueChange = [this](float v) { proc.lookaheadMs = v; };

    syncFromProcessor();
    startTimerHz(10);
}

S13LimiterEditor::~S13LimiterEditor() { setLookAndFeel(nullptr); }

void S13LimiterEditor::syncFromProcessor()
{
    thresholdKnob.setValue(proc.threshold.load());
    releaseKnob.setValue(proc.releaseMs.load());
    ceilingKnob.setValue(proc.ceiling.load());
    lookaheadKnob.setValue(proc.lookaheadMs.load());
}

void S13LimiterEditor::timerCallback()
{
    syncFromProcessor();
    grMeter.setGainReduction(proc.getGainReductionDB());
}

void S13LimiterEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio Limiter");
}

void S13LimiterEditor::resized()
{
    auto b = getLocalBounds();
    b.removeFromTop(headerH);

    // GR meter on the right
    grMeter.setBounds(b.removeFromRight(30).reduced(4));

    auto area = b.reduced(8, 4);
    layoutKnobRow(area, { &thresholdKnob, &releaseKnob, &ceilingKnob, &lookaheadKnob });
}


// ============================================================================
// S13DelayEditor
// ============================================================================

S13DelayEditor::S13DelayEditor(S13Delay& p)
    : AudioProcessorEditor(p), proc(p),
      delayLKnob("Delay L", "ms", 1.0f, 2000.0f, 250.0f, 1.0f),
      delayRKnob("Delay R", "ms", 1.0f, 2000.0f, 250.0f, 1.0f),
      feedbackKnob("Feedback", "%", 0.0f, 95.0f, 40.0f, 1.0f),
      crossFeedKnob("X-Feed", "%", 0.0f, 95.0f, 0.0f, 1.0f),
      mixKnob("Mix", "%", 0.0f, 100.0f, 50.0f, 1.0f),
      lpfKnob("LPF", "Hz", 200.0f, 20000.0f, 20000.0f, 1.0f),
      hpfKnob("HPF", "Hz", 20.0f, 2000.0f, 20.0f, 1.0f),
      saturationKnob("Saturation", "%", 0.0f, 100.0f, 0.0f, 1.0f),
      widthKnob("Width", "%", 0.0f, 200.0f, 100.0f, 1.0f)
{
    setLookAndFeel(&laf);
    setSize(540, 360);

    addAndMakeVisible(modeToggle);

    for (auto* k : { &delayLKnob, &delayRKnob, &feedbackKnob, &crossFeedKnob, &mixKnob,
                     &lpfKnob, &hpfKnob, &saturationKnob, &widthKnob })
        addAndMakeVisible(*k);

    delayLKnob.setSkew(250.0f);
    delayRKnob.setSkew(250.0f);
    lpfKnob.setSkew(4000.0f);
    hpfKnob.setSkew(200.0f);

    delayLKnob.onValueChange = [this](float v) { proc.delayTimeL = v; };
    delayRKnob.onValueChange = [this](float v) { proc.delayTimeR = v; };
    feedbackKnob.onValueChange = [this](float v) { proc.feedback = v / 100.0f; };
    crossFeedKnob.onValueChange = [this](float v) { proc.crossFeed = v / 100.0f; };
    mixKnob.onValueChange = [this](float v) { proc.mix = v / 100.0f; };
    lpfKnob.onValueChange = [this](float v) { proc.lpfFreq = v; };
    hpfKnob.onValueChange = [this](float v) { proc.hpfFreq = v; };
    saturationKnob.onValueChange = [this](float v) { proc.fbSaturation = v / 100.0f; };
    widthKnob.onValueChange = [this](float v) { proc.stereoWidth = v / 100.0f; };

    addAndMakeVisible(pingPongBtn);
    pingPongBtn.setButtonText("Ping Pong");
    pingPongBtn.onClick = [this]() { proc.pingPong = pingPongBtn.getToggleState() ? 1.0f : 0.0f; };

    addAndMakeVisible(tempoSyncBtn);
    tempoSyncBtn.setButtonText("Tempo Sync");
    tempoSyncBtn.onClick = [this]() { proc.tempoSync = tempoSyncBtn.getToggleState() ? 1.0f : 0.0f; };

    addAndMakeVisible(delayModeBox);
    delayModeBox.addItem("Digital", 1);
    delayModeBox.addItem("Tape", 2);
    delayModeBox.addItem("Analog", 3);
    delayModeBox.onChange = [this]() { proc.delayMode = static_cast<float>(delayModeBox.getSelectedId() - 1); };

    addAndMakeVisible(syncNoteLBox);
    addAndMakeVisible(syncNoteRBox);
    const char* noteNames[] = { "1/4", "1/8", "1/16", "1/4D", "1/8D", "1/16D", "1/4T", "1/8T", "1/16T" };
    for (int i = 0; i < 9; ++i)
    {
        syncNoteLBox.addItem(noteNames[i], i + 1);
        syncNoteRBox.addItem(noteNames[i], i + 1);
    }
    syncNoteLBox.onChange = [this]() { proc.syncNoteL = static_cast<float>(syncNoteLBox.getSelectedId() - 1); };
    syncNoteRBox.onChange = [this]() { proc.syncNoteR = static_cast<float>(syncNoteRBox.getSelectedId() - 1); };

    modeToggle.onModeChange = [this](bool) { resized(); };

    syncFromProcessor();
    startTimerHz(10);
}

S13DelayEditor::~S13DelayEditor() { setLookAndFeel(nullptr); }

void S13DelayEditor::syncFromProcessor()
{
    delayLKnob.setValue(proc.delayTimeL.load());
    delayRKnob.setValue(proc.delayTimeR.load());
    feedbackKnob.setValue(proc.feedback.load() * 100.0f);
    crossFeedKnob.setValue(proc.crossFeed.load() * 100.0f);
    mixKnob.setValue(proc.mix.load() * 100.0f);
    lpfKnob.setValue(proc.lpfFreq.load());
    hpfKnob.setValue(proc.hpfFreq.load());
    saturationKnob.setValue(proc.fbSaturation.load() * 100.0f);
    widthKnob.setValue(proc.stereoWidth.load() * 100.0f);
    pingPongBtn.setToggleState(proc.pingPong.load() > 0.5f, juce::dontSendNotification);
    tempoSyncBtn.setToggleState(proc.tempoSync.load() > 0.5f, juce::dontSendNotification);
    delayModeBox.setSelectedId(static_cast<int>(proc.delayMode.load()) + 1, juce::dontSendNotification);
    syncNoteLBox.setSelectedId(static_cast<int>(proc.syncNoteL.load()) + 1, juce::dontSendNotification);
    syncNoteRBox.setSelectedId(static_cast<int>(proc.syncNoteR.load()) + 1, juce::dontSendNotification);
}

void S13DelayEditor::timerCallback() { syncFromProcessor(); }

void S13DelayEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio Delay");
}

void S13DelayEditor::resized()
{
    auto b = getLocalBounds();
    auto topBar = b.removeFromTop(headerH);
    modeToggle.setBounds(topBar.removeFromRight(140).reduced(4, 4));

    bool adv = modeToggle.isAdvanced();
    auto area = b.reduced(8, 4);

    // Mode + options row
    auto optRow = area.removeFromTop(28);
    delayModeBox.setBounds(optRow.removeFromLeft(100).reduced(0, 2));
    pingPongBtn.setBounds(optRow.removeFromLeft(100));
    tempoSyncBtn.setBounds(optRow.removeFromLeft(100));

    bool sync = tempoSyncBtn.getToggleState();
    syncNoteLBox.setVisible(sync);
    syncNoteRBox.setVisible(sync);
    delayLKnob.setVisible(!sync);
    delayRKnob.setVisible(!sync);

    if (sync)
    {
        auto syncRow = area.removeFromTop(28);
        syncNoteLBox.setBounds(syncRow.removeFromLeft(80).reduced(0, 2));
        syncNoteRBox.setBounds(syncRow.removeFromLeft(80).reduced(0, 2));
    }

    // Main knobs
    if (sync)
    {
        layoutKnobRow(area, { &feedbackKnob, &mixKnob });
    }
    else
    {
        layoutKnobRow(area, { &delayLKnob, &delayRKnob, &feedbackKnob, &mixKnob });
    }

    // Advanced
    crossFeedKnob.setVisible(adv);
    lpfKnob.setVisible(adv);
    hpfKnob.setVisible(adv);
    saturationKnob.setVisible(adv);
    widthKnob.setVisible(adv);

    if (adv)
    {
        layoutKnobRow(area, { &crossFeedKnob, &lpfKnob, &hpfKnob, &saturationKnob, &widthKnob });
    }
}


// ============================================================================
// S13ReverbEditor
// ============================================================================

S13ReverbEditor::S13ReverbEditor(S13Reverb& p)
    : AudioProcessorEditor(p), proc(p),
      roomSizeKnob("Size", "", 0.0f, 100.0f, 50.0f, 1.0f),
      dampingKnob("Damping", "%", 0.0f, 100.0f, 50.0f, 1.0f),
      wetKnob("Wet", "%", 0.0f, 100.0f, 33.0f, 1.0f),
      dryKnob("Dry", "%", 0.0f, 100.0f, 70.0f, 1.0f),
      widthKnob("Width", "%", 0.0f, 100.0f, 100.0f, 1.0f),
      preDelayKnob("Pre-Delay", "ms", 0.0f, 500.0f, 0.0f, 1.0f),
      decayKnob("Decay", "s", 0.1f, 20.0f, 2.0f, 0.1f),
      diffusionKnob("Diffusion", "%", 0.0f, 100.0f, 50.0f, 1.0f),
      lowCutKnob("Low Cut", "Hz", 20.0f, 500.0f, 20.0f, 1.0f),
      highCutKnob("High Cut", "Hz", 1000.0f, 20000.0f, 20000.0f, 1.0f),
      earlyLevelKnob("Early Ref", "%", 0.0f, 100.0f, 50.0f, 1.0f)
{
    setLookAndFeel(&laf);
    setSize(540, 360);

    addAndMakeVisible(modeToggle);

    for (auto* k : { &roomSizeKnob, &dampingKnob, &wetKnob, &dryKnob, &widthKnob,
                     &preDelayKnob, &decayKnob, &diffusionKnob,
                     &lowCutKnob, &highCutKnob, &earlyLevelKnob })
        addAndMakeVisible(*k);

    roomSizeKnob.onValueChange = [this](float v) { proc.roomSize = v / 100.0f; };
    dampingKnob.onValueChange = [this](float v) { proc.damping = v / 100.0f; };
    wetKnob.onValueChange = [this](float v) { proc.wetLevel = v / 100.0f; };
    dryKnob.onValueChange = [this](float v) { proc.dryLevel = v / 100.0f; };
    widthKnob.onValueChange = [this](float v) { proc.width = v / 100.0f; };
    preDelayKnob.onValueChange = [this](float v) { proc.preDelay = v; };
    decayKnob.onValueChange = [this](float v) { proc.decayTime = v; };
    diffusionKnob.onValueChange = [this](float v) { proc.diffusion = v / 100.0f; };
    lowCutKnob.onValueChange = [this](float v) { proc.lowCut = v; };
    highCutKnob.onValueChange = [this](float v) { proc.highCut = v; };
    earlyLevelKnob.onValueChange = [this](float v) { proc.earlyLevel = v / 100.0f; };

    preDelayKnob.setSkew(100.0f);
    decayKnob.setSkew(3.0f);
    lowCutKnob.setSkew(100.0f);
    highCutKnob.setSkew(4000.0f);

    addAndMakeVisible(algorithmBox);
    algorithmBox.addItem("Room", 1);
    algorithmBox.addItem("Hall", 2);
    algorithmBox.addItem("Plate", 3);
    algorithmBox.addItem("Chamber", 4);
    algorithmBox.addItem("Shimmer", 5);
    algorithmBox.onChange = [this]() { proc.algorithm = static_cast<float>(algorithmBox.getSelectedId() - 1); };

    addAndMakeVisible(freezeBtn);
    freezeBtn.setButtonText("Freeze");
    freezeBtn.onClick = [this]() { proc.freezeMode = freezeBtn.getToggleState() ? 1.0f : 0.0f; };

    modeToggle.onModeChange = [this](bool) { resized(); };

    syncFromProcessor();
    startTimerHz(10);
}

S13ReverbEditor::~S13ReverbEditor() { setLookAndFeel(nullptr); }

void S13ReverbEditor::syncFromProcessor()
{
    roomSizeKnob.setValue(proc.roomSize.load() * 100.0f);
    dampingKnob.setValue(proc.damping.load() * 100.0f);
    wetKnob.setValue(proc.wetLevel.load() * 100.0f);
    dryKnob.setValue(proc.dryLevel.load() * 100.0f);
    widthKnob.setValue(proc.width.load() * 100.0f);
    preDelayKnob.setValue(proc.preDelay.load());
    decayKnob.setValue(proc.decayTime.load());
    diffusionKnob.setValue(proc.diffusion.load() * 100.0f);
    lowCutKnob.setValue(proc.lowCut.load());
    highCutKnob.setValue(proc.highCut.load());
    earlyLevelKnob.setValue(proc.earlyLevel.load() * 100.0f);
    algorithmBox.setSelectedId(static_cast<int>(proc.algorithm.load()) + 1, juce::dontSendNotification);
    freezeBtn.setToggleState(proc.freezeMode.load() > 0.5f, juce::dontSendNotification);
}

void S13ReverbEditor::timerCallback() { syncFromProcessor(); }

void S13ReverbEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio Reverb");
}

void S13ReverbEditor::resized()
{
    auto b = getLocalBounds();
    auto topBar = b.removeFromTop(headerH);
    modeToggle.setBounds(topBar.removeFromRight(140).reduced(4, 4));

    bool adv = modeToggle.isAdvanced();
    auto area = b.reduced(8, 4);

    auto optRow = area.removeFromTop(28);
    algorithmBox.setBounds(optRow.removeFromLeft(120).reduced(0, 2));
    freezeBtn.setBounds(optRow.removeFromLeft(80));

    // Basic: Size, Damping, Wet, Dry
    layoutKnobRow(area, { &roomSizeKnob, &dampingKnob, &wetKnob, &dryKnob });

    // Advanced
    widthKnob.setVisible(adv);
    preDelayKnob.setVisible(adv);
    decayKnob.setVisible(adv);
    diffusionKnob.setVisible(adv);
    lowCutKnob.setVisible(adv);
    highCutKnob.setVisible(adv);
    earlyLevelKnob.setVisible(adv);

    if (adv)
    {
        layoutKnobRow(area, { &preDelayKnob, &decayKnob, &widthKnob, &diffusionKnob });
        layoutKnobRow(area, { &lowCutKnob, &highCutKnob, &earlyLevelKnob });
    }
}


// ============================================================================
// S13ChorusEditor
// ============================================================================

S13ChorusEditor::S13ChorusEditor(S13Chorus& p)
    : AudioProcessorEditor(p), proc(p),
      rateKnob("Rate", "Hz", 0.01f, 20.0f, 1.0f, 0.01f),
      depthKnob("Depth", "%", 0.0f, 100.0f, 50.0f, 1.0f),
      feedbackKnob("Feedback", "%", -100.0f, 100.0f, 0.0f, 1.0f),
      mixKnob("Mix", "%", 0.0f, 100.0f, 50.0f, 1.0f),
      voicesKnob("Voices", "", 1.0f, 6.0f, 2.0f, 1.0f),
      spreadKnob("Spread", "%", 0.0f, 100.0f, 50.0f, 1.0f),
      highCutKnob("High Cut", "Hz", 200.0f, 20000.0f, 20000.0f, 1.0f),
      lowCutKnob("Low Cut", "Hz", 20.0f, 2000.0f, 20.0f, 1.0f)
{
    setLookAndFeel(&laf);
    setSize(480, 320);

    addAndMakeVisible(modeToggle);

    for (auto* k : { &rateKnob, &depthKnob, &feedbackKnob, &mixKnob,
                     &voicesKnob, &spreadKnob, &highCutKnob, &lowCutKnob })
        addAndMakeVisible(*k);

    rateKnob.setSkew(3.0f);
    highCutKnob.setSkew(4000.0f);
    lowCutKnob.setSkew(200.0f);

    rateKnob.onValueChange = [this](float v) { proc.rate = v; };
    depthKnob.onValueChange = [this](float v) { proc.depth = v / 100.0f; };
    feedbackKnob.onValueChange = [this](float v) { proc.fbAmount = v / 100.0f; };
    mixKnob.onValueChange = [this](float v) { proc.mix = v / 100.0f; };
    voicesKnob.onValueChange = [this](float v) { proc.voices = v; };
    spreadKnob.onValueChange = [this](float v) { proc.spread = v / 100.0f; };
    highCutKnob.onValueChange = [this](float v) { proc.highCut = v; };
    lowCutKnob.onValueChange = [this](float v) { proc.lowCut = v; };

    voicesKnob.formatValue = [](float v) { return juce::String(static_cast<int>(v)); };

    addAndMakeVisible(modeBox);
    modeBox.addItem("Chorus", 1);
    modeBox.addItem("Flanger", 2);
    modeBox.addItem("Phaser", 3);
    modeBox.onChange = [this]() { proc.mode = static_cast<float>(modeBox.getSelectedId() - 1); };

    addAndMakeVisible(lfoShapeBox);
    lfoShapeBox.addItem("Sine", 1);
    lfoShapeBox.addItem("Triangle", 2);
    lfoShapeBox.addItem("Square", 3);
    lfoShapeBox.addItem("S&H", 4);
    lfoShapeBox.onChange = [this]() { proc.lfoShape = static_cast<float>(lfoShapeBox.getSelectedId() - 1); };

    addAndMakeVisible(tempoSyncBtn);
    tempoSyncBtn.setButtonText("Tempo Sync");
    tempoSyncBtn.onClick = [this]() { proc.tempoSync = tempoSyncBtn.getToggleState() ? 1.0f : 0.0f; };

    modeToggle.onModeChange = [this](bool) { resized(); };

    syncFromProcessor();
    startTimerHz(10);
}

S13ChorusEditor::~S13ChorusEditor() { setLookAndFeel(nullptr); }

void S13ChorusEditor::syncFromProcessor()
{
    rateKnob.setValue(proc.rate.load());
    depthKnob.setValue(proc.depth.load() * 100.0f);
    feedbackKnob.setValue(proc.fbAmount.load() * 100.0f);
    mixKnob.setValue(proc.mix.load() * 100.0f);
    voicesKnob.setValue(proc.voices.load());
    spreadKnob.setValue(proc.spread.load() * 100.0f);
    highCutKnob.setValue(proc.highCut.load());
    lowCutKnob.setValue(proc.lowCut.load());
    modeBox.setSelectedId(static_cast<int>(proc.mode.load()) + 1, juce::dontSendNotification);
    lfoShapeBox.setSelectedId(static_cast<int>(proc.lfoShape.load()) + 1, juce::dontSendNotification);
    tempoSyncBtn.setToggleState(proc.tempoSync.load() > 0.5f, juce::dontSendNotification);
}

void S13ChorusEditor::timerCallback() { syncFromProcessor(); }

void S13ChorusEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio Chorus");
}

void S13ChorusEditor::resized()
{
    auto b = getLocalBounds();
    auto topBar = b.removeFromTop(headerH);
    modeToggle.setBounds(topBar.removeFromRight(140).reduced(4, 4));

    bool adv = modeToggle.isAdvanced();
    auto area = b.reduced(8, 4);

    auto optRow = area.removeFromTop(28);
    modeBox.setBounds(optRow.removeFromLeft(100).reduced(0, 2));
    lfoShapeBox.setBounds(optRow.removeFromLeft(100).reduced(0, 2));
    tempoSyncBtn.setBounds(optRow.removeFromLeft(110));

    // Basic: Rate, Depth, Feedback, Mix
    layoutKnobRow(area, { &rateKnob, &depthKnob, &feedbackKnob, &mixKnob });

    // Advanced
    voicesKnob.setVisible(adv);
    spreadKnob.setVisible(adv);
    highCutKnob.setVisible(adv);
    lowCutKnob.setVisible(adv);

    if (adv)
    {
        layoutKnobRow(area, { &voicesKnob, &spreadKnob, &highCutKnob, &lowCutKnob });
    }
}


// ============================================================================
// S13SaturatorEditor
// ============================================================================

S13SaturatorEditor::S13SaturatorEditor(S13Saturator& p)
    : AudioProcessorEditor(p), proc(p),
      driveKnob("Drive", "dB", 0.0f, 30.0f, 6.0f, 0.1f),
      mixKnob("Mix", "%", 0.0f, 100.0f, 100.0f, 1.0f),
      toneKnob("Tone", "Hz", 200.0f, 20000.0f, 20000.0f, 1.0f),
      outputKnob("Output", "dB", -12.0f, 0.0f, 0.0f, 0.1f),
      asymmetryKnob("Asymmetry", "", -100.0f, 100.0f, 0.0f, 1.0f)
{
    setLookAndFeel(&laf);
    setSize(440, 280);

    addAndMakeVisible(modeToggle);

    for (auto* k : { &driveKnob, &mixKnob, &toneKnob, &outputKnob, &asymmetryKnob })
        addAndMakeVisible(*k);

    toneKnob.setSkew(4000.0f);

    driveKnob.onValueChange = [this](float v) { proc.drive = v; };
    mixKnob.onValueChange = [this](float v) { proc.mix = v / 100.0f; };
    toneKnob.onValueChange = [this](float v) { proc.toneFreq = v; };
    outputKnob.onValueChange = [this](float v) { proc.outputGain = v; };
    asymmetryKnob.onValueChange = [this](float v) { proc.asymmetry = v / 100.0f; };

    addAndMakeVisible(satTypeBox);
    satTypeBox.addItem("Tape", 1);
    satTypeBox.addItem("Tube", 2);
    satTypeBox.addItem("Transistor", 3);
    satTypeBox.addItem("Hard Clip", 4);
    satTypeBox.addItem("Bit Crush", 5);
    satTypeBox.onChange = [this]() { proc.satType = static_cast<float>(satTypeBox.getSelectedId() - 1); };

    addAndMakeVisible(oversampleBox);
    oversampleBox.addItem("No OS", 1);
    oversampleBox.addItem("2x OS", 2);
    oversampleBox.addItem("4x OS", 3);
    oversampleBox.onChange = [this]() { proc.oversampleMode = static_cast<float>(oversampleBox.getSelectedId() - 1); };

    modeToggle.onModeChange = [this](bool) { resized(); };

    syncFromProcessor();
    startTimerHz(10);
}

S13SaturatorEditor::~S13SaturatorEditor() { setLookAndFeel(nullptr); }

void S13SaturatorEditor::syncFromProcessor()
{
    driveKnob.setValue(proc.drive.load());
    mixKnob.setValue(proc.mix.load() * 100.0f);
    toneKnob.setValue(proc.toneFreq.load());
    outputKnob.setValue(proc.outputGain.load());
    asymmetryKnob.setValue(proc.asymmetry.load() * 100.0f);
    satTypeBox.setSelectedId(static_cast<int>(proc.satType.load()) + 1, juce::dontSendNotification);
    oversampleBox.setSelectedId(static_cast<int>(proc.oversampleMode.load()) + 1, juce::dontSendNotification);
}

void S13SaturatorEditor::timerCallback() { syncFromProcessor(); }

void S13SaturatorEditor::paint(juce::Graphics& g)
{
    paintEditorBackground(g, *this, "OpenStudio Saturator");
}

void S13SaturatorEditor::resized()
{
    auto b = getLocalBounds();
    auto topBar = b.removeFromTop(headerH);
    modeToggle.setBounds(topBar.removeFromRight(140).reduced(4, 4));

    bool adv = modeToggle.isAdvanced();
    auto area = b.reduced(8, 4);

    auto optRow = area.removeFromTop(28);
    satTypeBox.setBounds(optRow.removeFromLeft(120).reduced(0, 2));

    // Basic: Drive, Mix, Tone, Output
    layoutKnobRow(area, { &driveKnob, &mixKnob, &toneKnob, &outputKnob });

    // Advanced
    asymmetryKnob.setVisible(adv);
    oversampleBox.setVisible(adv);

    if (adv)
    {
        auto advRow = area.removeFromTop(knobH);
        asymmetryKnob.setBounds(advRow.removeFromLeft(knobW));
        oversampleBox.setBounds(advRow.removeFromLeft(100).withHeight(28).withY(advRow.getCentreY() - 14));
    }
}
