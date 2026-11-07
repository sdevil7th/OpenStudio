#pragma once
#include <JuceHeader.h>
#include <functional>

void runTempoDetectionRegression(const juce::File& root,
    const std::function<void(const char*, bool)>& check);
