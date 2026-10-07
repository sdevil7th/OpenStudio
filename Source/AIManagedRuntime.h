#pragma once

#include <JuceHeader.h>

namespace AIManagedRuntime
{
inline juce::File getActiveStemRuntimeRoot(const juce::File& userDataRoot)
{
    const auto fallback = userDataRoot.getChildFile("stem-runtime");
    const auto marker = userDataRoot.getChildFile("stem-runtime-active.txt");
    if (! marker.existsAsFile())
        return fallback;

    const auto name = marker.loadFileAsString().trim();
    if (name == "stem-runtime")
        return fallback;

    const juce::String prefix("stem-runtime-directml-");
    const auto suffix = name.substring(prefix.length());
    if (! name.startsWith(prefix) || suffix.length() != 32
        || ! suffix.containsOnly("0123456789abcdef"))
        return fallback;

    const auto candidate = userDataRoot.getChildFile(name);
    return candidate.isDirectory() ? candidate : fallback;
}
}
