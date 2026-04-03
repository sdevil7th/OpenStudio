#pragma once

#include <JuceHeader.h>
#include <memory>
#include <vector>

// Info for a discovered S13FX/JSFX script
struct S13FXInfo
{
    juce::String name;
    juce::String filePath;
    juce::String author;
    juce::StringArray tags;
    bool isStock = false;  // true = shipped with app (read-only)
};

// Manages VST3 plugin scanning and S13FX/JSFX script discovery
class PluginManager
{
public:
    PluginManager();
    ~PluginManager();

    // Scan for available plugins (VST3 + S13FX/JSFX)
    void scanForPlugins();

    // Get list of available VST3 plugins
    juce::Array<juce::PluginDescription> getAvailablePlugins() const;

    // Get list of available S13FX/JSFX scripts
    const std::vector<S13FXInfo>& getAvailableS13FX() const { return s13fxList; }

    // Scan for S13FX/JSFX scripts only
    void scanForS13FX();

    // Load a plugin by its description (uses actual device sample rate & block size)
    std::unique_ptr<juce::AudioProcessor> loadPlugin(const juce::PluginDescription& description,
                                                     double sampleRate = 44100.0, int blockSize = 512);

    // Load a plugin by file path (uses actual device sample rate & block size)
    std::unique_ptr<juce::AudioProcessor> loadPluginFromFile(const juce::String& filePath,
                                                              double sampleRate = 44100.0, int blockSize = 512);

    // Get the user effects directory (Documents/OpenStudio/Effects/, with Studio13 fallback)
    static juce::File getUserEffectsDirectory();

    // Get the stock effects directory (app bundle Resources/effects on macOS, or <exe>/effects)
    static juce::File getStockEffectsDirectory();

    // ARA plugin detection
    bool isARAPlugin(const juce::PluginDescription& description) const;
    juce::Array<juce::PluginDescription> getARAPlugins() const;

    // Plugin crash isolation: check if a plugin previously crashed
    bool isPluginBlacklisted(const juce::String& pluginId) const;
    void blacklistPlugin(const juce::String& pluginId);
    void removeFromBlacklist(const juce::String& pluginId);
    juce::StringArray getBlacklistedPlugins() const;

private:
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPluginList;
    juce::File pluginListFile;
    juce::File blacklistFile;
    juce::StringArray blacklistedPlugins;
    std::vector<S13FXInfo> s13fxList;

    void savePluginList();
    void loadPluginList();
    void scanDirectory(const juce::File& dir, bool isStock);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginManager)
};
