#pragma once
#include <JuceHeader.h>
#include <functional>

namespace ProjectRateCopy
{
// Worker-only, content-addressed WAV float copies. Never writes to the source.
juce::var create(const juce::File& source, const juce::File& cacheDirectory, int targetRate,
                 const std::function<bool()>& keepRunning);
}
