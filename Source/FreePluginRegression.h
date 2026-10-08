#pragma once
#include <JuceHeader.h>

// Runs without an audio device, WebView, or application window.
juce::var runFreePluginRegression(const juce::File& fixtureDirectory, bool captureMissingFixtures = false, const juce::String& selectedCase = {});

juce::var describeFreePluginForRegression(juce::AudioProcessor& processor);

bool setFreePluginParamForRegression(juce::AudioProcessor&, const juce::String&, float);

bool restoreFreePluginStateForRegression(juce::AudioProcessor&, const juce::MemoryBlock&);

bool setFreePluginNormalizedForRegression(juce::AudioProcessor&, const juce::String&, float);
