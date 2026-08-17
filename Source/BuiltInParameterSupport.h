#pragma once

#include <JuceHeader.h>
#include <cmath>

enum class OpenStudioBuiltInParameterCurve
{
    linear,
    chorusRateSplitLog
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

inline float openStudioBuiltInValueToNormalized(
    const OpenStudioBuiltInAutomationDescriptor& descriptor,
    float value) noexcept
{
    if (descriptor.curve
        == OpenStudioBuiltInParameterCurve::chorusRateSplitLog)
    {
        return openStudioChorusRateToNormalized(value);
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
