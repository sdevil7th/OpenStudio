#pragma once

#include <juce_core/juce_core.h>

namespace OpenStudioRuntime
{
// JUCE's dladdr-based currentExecutableFile may reflect argv[0], which an
// AppImage sets to the outer download. Use the kernel's executable path for
// sibling assets/helpers and child processes. Preserve APPIMAGE for updater
// identity and never trust an inherited APPDIR for runtime resource discovery.
inline juce::File executableFile()
{
   #if JUCE_LINUX
    const auto executable = juce::File("/proc/self/exe").getLinkedTarget();
    if (executable.existsAsFile())
        return executable;
   #endif
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile);
}

inline juce::String nativePackageFormat()
{
   #if JUCE_LINUX
    const auto format = executableFile().getSiblingFile("OpenStudio.package").loadFileAsString().trim();
    if (format == "deb" || format == "rpm")
        return format;
   #endif
    return {};
}
}
