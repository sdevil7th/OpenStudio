#pragma once

#include <JuceHeader.h>

namespace OpenStudioLaunchState
{
bool isOrdinaryLaunch(const juce::String& commandLine);
juce::String normalisePendingProjectPath(const juce::String& commandLineOrPath);
void setPendingProjectPath(const juce::String& projectPath);
juce::String consumePendingProjectPath();
}
