#pragma once
#include <JuceHeader.h>
#include <functional>
void runPlaybackTinyBlockRegression(const juce::File& directory,
    const std::function<void(const char*, bool)>& check);
