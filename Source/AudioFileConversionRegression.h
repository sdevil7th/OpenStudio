#pragma once
#include <JuceHeader.h>
#include <functional>
void runAudioFileConversionRegression(const juce::File&, const std::function<void(const char*, bool)>&);
