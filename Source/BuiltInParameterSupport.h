#pragma once

#include <JuceHeader.h>

struct OpenStudioBuiltInAutomationDescriptor
{
    float minimum = 0.0f;
    float maximum = 1.0f;
    float currentValue = 0.0f;
    bool discrete = false;
};

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
