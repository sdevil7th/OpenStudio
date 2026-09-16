#pragma once
#include <JuceHeader.h>
#include <functional>

// Offline file work only. The shipped FFmpeg worker performs band-limited SRC;
// it never changes a file's rate by merely relabelling its original samples.
namespace AudioFileConversion
{
struct Options
{
    juce::String format = "wav";
    int sampleRate = 0, bitDepth = 0, channels = 0; // 0 preserves source.
    int timeoutMs = 30 * 60 * 1000;
};
juce::Result convert(const juce::File& source, const juce::File& destination,
                     const Options&, const std::function<bool()>& keepRunning);
}
