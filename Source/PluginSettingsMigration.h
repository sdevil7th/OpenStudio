#pragma once
#include <JuceHeader.h>
#include <filesystem>
#include "JsonEnvelope.h"

// Runs only on first external-plugin use, never during empty-session startup.
// Publish the entire validated directory at once; existing OpenStudio files stay intact.
inline juce::Result migrateOpenStudioPluginSettings(const juce::File& source, const juce::File& destination)
{
    if (source == destination || destination.isDirectory()) return juce::Result::ok();
    std::error_code error;
    const auto path = std::filesystem::u8path(source.getFullPathName().toRawUTF8());
    const bool sourceExists = std::filesystem::exists(path, error);
    if (error) return juce::Result::fail("Cannot access existing OpenStudio plugin settings. Allow Documents access in System Settings, then retry.");
    if (sourceExists)
    {
        // Directory enumeration distinguishes denied access from an empty/new installation.
        const std::filesystem::directory_iterator readable(path, error);
        juce::ignoreUnused(readable);
        if (error) return juce::Result::fail("Existing OpenStudio plugin settings are inaccessible. Allow Documents access in System Settings, then retry. No settings were replaced.");
    }
    const auto staging = destination.getSiblingFile(".plugin-settings-" + juce::Uuid().toString());
    if (staging.createDirectory().failed()) return juce::Result::fail("Cannot create the OpenStudio plugin settings folder.");
    struct Cleanup { juce::File directory; ~Cleanup() { directory.deleteRecursively(); } } cleanup { staging };
    for (const auto* name : { "PluginList.xml", "PluginBlacklist.txt", "PluginSearchPaths.xml", "PluginScanDeadMansPedal.txt", "PluginHosting.json" })
    {
        const auto original = source.getChildFile(name);
        const bool exists = sourceExists && std::filesystem::exists(std::filesystem::u8path(original.getFullPathName().toRawUTF8()), error);
        if (error) return juce::Result::fail("Cannot inspect existing plugin settings: " + juce::String(name));
        if (!exists) continue;
        juce::MemoryBlock bytes;
        if (original.getSize() > 8 * 1024 * 1024 || !original.loadFileAsData(bytes))
            return juce::Result::fail("Cannot read existing plugin settings: " + juce::String(name));
        const auto text = bytes.toString();
        if (juce::String(name).endsWith(".xml"))
        {
            const auto xml = juce::XmlDocument::parse(text);
            const auto expectedTag = juce::String(name) == "PluginList.xml" ? "KNOWNPLUGINS" : "PLUGIN_SEARCH_PATHS";
            if (xml == nullptr || !xml->hasTagName(expectedTag))
                return juce::Result::fail("Invalid existing plugin settings: " + juce::String(name));
        }
        if (juce::String(name).endsWith(".json"))
        {
            // Use the same envelope limits as the destination reader. A copy
            // that the reader would silently discard must not change isolation.
            if (!hasBoundedJsonEnvelope(text, 1024 * 1024))
                return juce::Result::fail("Invalid existing plugin hosting preferences.");
            const auto policy = juce::JSON::parse(text);
            const auto* values = policy.getArray();
            if (values == nullptr || values->size() > 10000)
                return juce::Result::fail("Invalid existing plugin hosting preferences.");
            for (const auto& value : *values)
                if (!value.isString() || value.toString().length() > 4096)
                    return juce::Result::fail("Invalid existing plugin isolation entry.");
        }
        const auto copy = staging.getChildFile(name);
        juce::MemoryBlock readback;
        if (!copy.replaceWithData(bytes.getData(), bytes.getSize()) || !copy.loadFileAsData(readback) || readback != bytes)
            return juce::Result::fail("Could not verify copied plugin settings: " + juce::String(name));
    }
    if (!staging.getChildFile("settings-initialized").replaceWithText("OpenStudio plugin settings\n")
        || destination.exists() || !staging.moveFileTo(destination))
        return juce::Result::fail("Could not publish OpenStudio plugin settings. Original files were preserved; retry.");
    return juce::Result::ok();
}
