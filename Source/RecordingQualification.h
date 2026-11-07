#pragma once
#include <JuceHeader.h>

// Explicitly opted-in, paced software capture. Never opens a device or UI.
juce::var runRecordingQualification(const juce::File& source,
                                   const juce::File& outputDirectory,
                                   double seconds);
