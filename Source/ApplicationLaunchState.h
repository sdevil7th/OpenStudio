#pragma once

#include <JuceHeader.h>

namespace OpenStudioLaunchState
{
juce::String normalisePendingProjectPath(const juce::String& commandLineOrPath);
void setPendingProjectPath(const juce::String& projectPath);
juce::String consumePendingProjectPath();
}
