#pragma once

#include <JuceHeader.h>
#include <cmath>

enum class OpenStudioBuiltInParameterCurve
{
    linear,
    chorusRateSplitLog,
    preEqHighPassLogWithOff,
    preEqLowPassLogWithOff,
    graphicEqHighPassLogWithOff,
    graphicEqLowPassLogWithOff
};

struct OpenStudioBuiltInAutomationDescriptor
{
    float minimum = 0.0f;
    float maximum = 1.0f;
    float currentValue = 0.0f;
    bool discrete = false;
    OpenStudioBuiltInParameterCurve curve =
        OpenStudioBuiltInParameterCurve::linear;
};

inline float openStudioChorusRateFromNormalized(float normalized) noexcept
{
    constexpr float curveK = 0.37784223634921743f;
    const auto curveUnit = [curveK] (float value) noexcept
    {
        const float x = juce::jlimit(0.0f, 1.0f, value);
        return x + curveK * x * (1.0f - x);
    };

    const float n = juce::jlimit(0.0f, 1.0f, normalized);
    if (n <= 0.5f)
        return 0.01f * std::pow(100.0f, curveUnit(n * 2.0f));
    return std::pow(8.0f, curveUnit(n * 2.0f - 1.0f));
}

inline float openStudioChorusRateToNormalized(float rateHz) noexcept
{
    constexpr float curveK = 0.37784223634921743f;
    const auto inverseCurveUnit = [curveK] (float value) noexcept
    {
        const float y = juce::jlimit(0.0f, 1.0f, value);
        const float onePlusK = 1.0f + curveK;
        const float discriminant = juce::jmax(
            0.0f, onePlusK * onePlusK - 4.0f * curveK * y);
        return juce::jlimit(
            0.0f,
            1.0f,
            (onePlusK - std::sqrt(discriminant))
                / (2.0f * curveK));
    };

    const float hz = juce::jlimit(0.01f, 8.0f, rateHz);
    if (hz <= 1.0f)
    {
        const float curveValue =
            std::log(hz / 0.01f) / std::log(100.0f);
        return 0.5f * inverseCurveUnit(curveValue);
    }

    const float curveValue = std::log(hz) / std::log(8.0f);
    return 0.5f * (1.0f + inverseCurveUnit(curveValue));
}

inline constexpr float openStudioGraphicEqFilterOffDetent = 0.06f;
inline constexpr float openStudioGraphicEqHighPassOffHz = 0.0f;
inline constexpr float openStudioGraphicEqHighPassMinimumHz = 20.0f;
inline constexpr float openStudioGraphicEqHighPassMaximumHz = 500.0f;
inline constexpr float openStudioGraphicEqLowPassMinimumHz = 3000.0f;
inline constexpr float openStudioGraphicEqLowPassMaximumHz = 20000.0f;
inline constexpr float openStudioGraphicEqLowPassOffHz = 24000.0f;
inline constexpr float openStudioGraphicEqLowPassOffBoundaryHz = 22000.0f;
inline constexpr float openStudioPreEqHighPassOffHz = 0.0f;
inline constexpr float openStudioPreEqHighPassMinimumHz = 35.0f;
inline constexpr float openStudioPreEqHighPassMaximumHz = 180.0f;
inline constexpr float openStudioPreEqLowPassMinimumHz = 3000.0f;
inline constexpr float openStudioPreEqLowPassMaximumHz = 20000.0f;
inline constexpr float openStudioPreEqLowPassOffHz = 24000.0f;
inline constexpr float openStudioPreEqLowPassOffBoundaryHz = 22000.0f;

inline float openStudioLogFrequencyFromUnit(
    float normalized,
    float minimumHz,
    float maximumHz) noexcept
{
    return minimumHz * std::pow(
        maximumHz / minimumHz,
        juce::jlimit(0.0f, 1.0f, normalized));
}

inline float openStudioLogFrequencyToUnit(
    float frequencyHz,
    float minimumHz,
    float maximumHz) noexcept
{
    const float hz = juce::jlimit(minimumHz, maximumHz, frequencyHz);
    return std::log(hz / minimumHz)
        / std::log(maximumHz / minimumHz);
}

inline float openStudioGraphicEqHighPassFromNormalized(
    float normalized) noexcept
{
    const float n = juce::jlimit(0.0f, 1.0f, normalized);
    if (n < openStudioGraphicEqFilterOffDetent)
        return openStudioGraphicEqHighPassOffHz;

    const float activeUnit =
        (n - openStudioGraphicEqFilterOffDetent)
        / (1.0f - openStudioGraphicEqFilterOffDetent);
    return openStudioLogFrequencyFromUnit(
        activeUnit,
        openStudioGraphicEqHighPassMinimumHz,
        openStudioGraphicEqHighPassMaximumHz);
}

inline float openStudioGraphicEqHighPassToNormalized(
    float frequencyHz) noexcept
{
    if (! std::isfinite(frequencyHz)
        || frequencyHz < openStudioGraphicEqHighPassMinimumHz)
    {
        return 0.0f;
    }

    return openStudioGraphicEqFilterOffDetent
        + (1.0f - openStudioGraphicEqFilterOffDetent)
            * openStudioLogFrequencyToUnit(
                frequencyHz,
                openStudioGraphicEqHighPassMinimumHz,
                openStudioGraphicEqHighPassMaximumHz);
}

inline float openStudioGraphicEqLowPassFromNormalized(
    float normalized) noexcept
{
    const float n = juce::jlimit(0.0f, 1.0f, normalized);
    const float activeMaximum =
        1.0f - openStudioGraphicEqFilterOffDetent;
    if (n > activeMaximum)
        return openStudioGraphicEqLowPassOffHz;

    return openStudioLogFrequencyFromUnit(
        n / activeMaximum,
        openStudioGraphicEqLowPassMinimumHz,
        openStudioGraphicEqLowPassMaximumHz);
}

inline float openStudioGraphicEqLowPassToNormalized(
    float frequencyHz) noexcept
{
    if (! std::isfinite(frequencyHz)
        || frequencyHz >= openStudioGraphicEqLowPassOffBoundaryHz)
    {
        return 1.0f;
    }

    return (1.0f - openStudioGraphicEqFilterOffDetent)
        * openStudioLogFrequencyToUnit(
            frequencyHz,
            openStudioGraphicEqLowPassMinimumHz,
            openStudioGraphicEqLowPassMaximumHz);
}

inline float openStudioPreEqHighPassFromNormalized(
    float normalized) noexcept
{
    const float n = juce::jlimit(0.0f, 1.0f, normalized);
    if (n < openStudioGraphicEqFilterOffDetent)
        return openStudioPreEqHighPassOffHz;
    return openStudioLogFrequencyFromUnit(
        (n - openStudioGraphicEqFilterOffDetent)
            / (1.0f - openStudioGraphicEqFilterOffDetent),
        openStudioPreEqHighPassMinimumHz,
        openStudioPreEqHighPassMaximumHz);
}

inline float openStudioPreEqHighPassToNormalized(
    float frequencyHz) noexcept
{
    if (! std::isfinite(frequencyHz)
        || frequencyHz < openStudioPreEqHighPassMinimumHz)
    {
        return 0.0f;
    }
    return openStudioGraphicEqFilterOffDetent
        + (1.0f - openStudioGraphicEqFilterOffDetent)
            * openStudioLogFrequencyToUnit(
                frequencyHz,
                openStudioPreEqHighPassMinimumHz,
                openStudioPreEqHighPassMaximumHz);
}

inline float openStudioPreEqLowPassFromNormalized(
    float normalized) noexcept
{
    const float n = juce::jlimit(0.0f, 1.0f, normalized);
    const float activeMaximum =
        1.0f - openStudioGraphicEqFilterOffDetent;
    if (n > activeMaximum)
        return openStudioPreEqLowPassOffHz;
    return openStudioLogFrequencyFromUnit(
        n / activeMaximum,
        openStudioPreEqLowPassMinimumHz,
        openStudioPreEqLowPassMaximumHz);
}

inline float openStudioPreEqLowPassToNormalized(
    float frequencyHz) noexcept
{
    if (! std::isfinite(frequencyHz)
        || frequencyHz >= openStudioPreEqLowPassOffBoundaryHz)
    {
        return 1.0f;
    }
    return (1.0f - openStudioGraphicEqFilterOffDetent)
        * openStudioLogFrequencyToUnit(
            frequencyHz,
            openStudioPreEqLowPassMinimumHz,
            openStudioPreEqLowPassMaximumHz);
}

inline float openStudioBuiltInValueToNormalized(
    const OpenStudioBuiltInAutomationDescriptor& descriptor,
    float value) noexcept
{
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::chorusRateSplitLog)
    {
        return openStudioChorusRateToNormalized(value);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::preEqHighPassLogWithOff)
    {
        return openStudioPreEqHighPassToNormalized(value);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::preEqLowPassLogWithOff)
    {
        return openStudioPreEqLowPassToNormalized(value);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::graphicEqHighPassLogWithOff)
    {
        return openStudioGraphicEqHighPassToNormalized(value);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::graphicEqLowPassLogWithOff)
    {
        return openStudioGraphicEqLowPassToNormalized(value);
    }

    const float range = descriptor.maximum - descriptor.minimum;
    return range > 0.0f
        ? juce::jlimit(
              0.0f,
              1.0f,
              (value - descriptor.minimum) / range)
        : 0.0f;
}

inline float openStudioBuiltInNormalizedToValue(
    const OpenStudioBuiltInAutomationDescriptor& descriptor,
    float normalized) noexcept
{
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::chorusRateSplitLog)
    {
        return openStudioChorusRateFromNormalized(normalized);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::preEqHighPassLogWithOff)
    {
        return openStudioPreEqHighPassFromNormalized(normalized);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::preEqLowPassLogWithOff)
    {
        return openStudioPreEqLowPassFromNormalized(normalized);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::graphicEqHighPassLogWithOff)
    {
        return openStudioGraphicEqHighPassFromNormalized(normalized);
    }
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::graphicEqLowPassLogWithOff)
    {
        return openStudioGraphicEqLowPassFromNormalized(normalized);
    }

    return descriptor.minimum
        + juce::jlimit(0.0f, 1.0f, normalized)
            * (descriptor.maximum - descriptor.minimum);
}

// These helpers expose the existing schema-backed NAM Rack controls to the
// DAW's normalized automation and MIDI-learn paths. Resource selectors,
// calibration, audition-only controls, and latency-changing controls are not
// eligible.
bool getOpenStudioBuiltInAutomationDescriptor(
    juce::AudioProcessor* processor,
    const juce::String& parameterId,
    OpenStudioBuiltInAutomationDescriptor& descriptor);

bool setOpenStudioBuiltInParameterNormalized(
    juce::AudioProcessor* processor,
    const juce::String& parameterId,
    float normalizedValue);

// Realtime-safe for parameters admitted by the descriptor helper: this only
// dispatches to the existing atomic-backed built-in setter.
bool setOpenStudioBuiltInParameterValue(
    juce::AudioProcessor* processor,
    const juce::String& parameterId,
    float value);
