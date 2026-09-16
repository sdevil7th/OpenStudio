#pragma once

#include <JuceHeader.h>

// Isolated, headless metronome contract checks; never opens a device or editor.
juce::var runMetronomeRegression();
