#pragma once
#include <JuceHeader.h>
#include <functional>
int runInterruptedRecordingFixture(const juce::File&);
void runRecordingRecoveryRegression(const juce::File&, const std::function<void(const char*, bool)>&);
