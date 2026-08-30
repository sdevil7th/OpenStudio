#pragma once

#include <JuceHeader.h>

namespace OpenStudioFFmpeg
{
inline juce::String executableName()
{
#if JUCE_WINDOWS
    return "ffmpeg.exe";
#else
    return "ffmpeg";
#endif
}

inline juce::Array<juce::File> bundledCandidates()
{
    const auto executableDirectory =
        juce::File::getSpecialLocation(
            juce::File::currentExecutableFile)
            .getParentDirectory();
    const auto name = executableName();
    juce::Array<juce::File> candidates;
    candidates.add(executableDirectory.getChildFile(name));
    candidates.add(
        executableDirectory.getChildFile("ffmpeg-runtime").getChildFile(name));
    candidates.add(
        executableDirectory.getChildFile("tools")
            .getChildFile("ffmpeg-runtime")
            .getChildFile(name));
#if JUCE_MAC
    candidates.add(
        executableDirectory.getParentDirectory()
            .getChildFile("Resources")
            .getChildFile(name));
#endif
    auto parent = executableDirectory.getParentDirectory();
    for (int level = 0; level < 3; ++level)
    {
        candidates.add(
            parent.getChildFile("tools")
                .getChildFile("ffmpeg-runtime")
                .getChildFile(name));
        parent = parent.getParentDirectory();
    }
    return candidates;
}

inline juce::File findExecutable()
{
    for (const auto& candidate : bundledCandidates())
    {
        if (candidate.existsAsFile())
            return candidate;
    }

    const auto pathValue = juce::SystemStats::getEnvironmentVariable(
        "PATH", {});
    juce::StringArray directories;
#if JUCE_WINDOWS
    directories.addTokens(pathValue, ";", "\"");
#else
    directories.addTokens(pathValue, ":", "\"");
#endif
    const auto name = executableName();
    for (auto directory : directories)
    {
        directory = directory.trim().unquoted();
        if (directory.isEmpty())
            continue;
        const auto candidate = juce::File(directory).getChildFile(name);
        if (candidate.existsAsFile())
            return candidate;
    }

    return {};
}
}
