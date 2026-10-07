#pragma once

#include <JuceHeader.h>

namespace OpenStudioRuntimeAssets
{
inline juce::File preferAppImageRoot(const juce::File& executableDirectory)
{
#if JUCE_LINUX
    // AppImage exports both variables when it launches the payload. Validate
    // the expected layout before selecting this root over JUCE's executable
    // path, which can resolve to the outer AppImage in the download folder.
    const auto appImagePath = juce::SystemStats::getEnvironmentVariable("APPIMAGE", {});
    const auto appDirPath = juce::SystemStats::getEnvironmentVariable("APPDIR", {});
    if (appImagePath.isNotEmpty() && appDirPath.isNotEmpty())
    {
        const auto appBin = juce::File(appDirPath).getChildFile("usr/bin");
        if (appBin.getChildFile("OpenStudio").existsAsFile()
            && appBin.getChildFile("webui/index.html").existsAsFile())
            return appBin;
    }
#endif
    return executableDirectory;
}
}
