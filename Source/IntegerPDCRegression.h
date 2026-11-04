#pragma once
#include <JuceHeader.h>
#include <functional>
void runIntegerPDCRegression(const juce::File& directory,
    const std::function<void(const char*, bool)>& check);
