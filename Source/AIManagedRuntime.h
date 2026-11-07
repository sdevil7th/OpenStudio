#pragma once

#include <JuceHeader.h>

namespace AIManagedRuntime
{
inline juce::File fileForIO(const juce::File& file)
{
   #if JUCE_WINDOWS
    const auto path = file.getFullPathName();
    if (path.startsWith("\\\\?\\")) return file;
    return juce::File(path.startsWith("\\\\") ? "\\\\?\\UNC\\" + path.substring(2) : "\\\\?\\" + path);
   #else
    return file;
   #endif
}

inline juce::File getActiveStemRuntimeRoot(const juce::File& userDataRoot)
{
    const auto fallback = userDataRoot.getChildFile("stem-runtime");
    const auto marker = userDataRoot.getChildFile("stem-runtime-active.txt");
    if (! marker.existsAsFile())
        return fallback;

    const auto name = marker.loadFileAsString().trim();
    if (name == "stem-runtime")
        return fallback;

    const juce::String prefix(name.startsWith("stem-runtime-candidate-")
        ? "stem-runtime-candidate-" : "stem-runtime-directml-");
    const auto suffix = name.substring(prefix.length());
    if (! name.startsWith(prefix) || suffix.length() != 32
        || ! suffix.containsOnly("0123456789abcdef"))
        return fallback;

    const auto candidate = userDataRoot.getChildFile(name);
    return candidate.isDirectory() ? candidate : fallback;
}

inline juce::File getActiveCompilerRuntimeRoot(const juce::File& userDataRoot, const juce::File& requirements)
{
    const auto root = userDataRoot.getChildFile("compiler-runtime");
    const auto marker = root.getChildFile("active.json");
    if (!marker.existsAsFile() || marker.isSymbolicLink() || marker.getSize() > 16384 || !requirements.existsAsFile()) return {};
    const auto active = juce::JSON::parse(marker);
    const auto name = active.getProperty("slot", "").toString();
    const juce::String prefix("compiler-runtime-");
    const auto suffix = name.substring(prefix.length());
    if (static_cast<int>(active.getProperty("schemaVersion", 0)) != 1
        || active.getProperty("profile", "").toString() != "stable-audio-cuda-compile-v1"
        || !name.startsWith(prefix) || suffix.length() != 32 || !suffix.containsOnly("0123456789abcdef")) return {};
    const auto slot = root.getChildFile(name);
    const auto ready = slot.getChildFile("ready.json");
    if (slot.isSymbolicLink() || !ready.existsAsFile() || ready.isSymbolicLink() || ready.getSize() > 65536) return {};
    const auto receipt = juce::JSON::parse(ready);
    const auto recipeText = requirements.loadFileAsString().replace("\r\n", "\n");
    if (receipt.getProperty("profile", "").toString() != "stable-audio-cuda-compile-v1"
        || receipt.getProperty("validation", "").toString() != "pass"
        || receipt.getProperty("requirementsSha256", "").toString()
            != juce::SHA256(recipeText.toRawUTF8(), recipeText.getNumBytesAsUTF8()).toHexString()) return {};
    return slot.getChildFile("runtime");
}
}
