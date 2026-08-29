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

// Manages external plugin scanning and S13FX/JSFX script discovery
class PluginManager
{
public:
    PluginManager();
    ~PluginManager();

    // Scan for available external plugins. The returned object contains a
    // per-format discovery report suitable for presenting in the UI.
    juce::var scanForPlugins(bool forceRescan = false);

    // Persistent folders supplied by the user are searched by every supported
    // external plugin format, in addition to that format's standard locations.
    juce::var getPluginScanConfiguration() const;
    bool addPluginSearchPath(const juce::String& directoryPath);
    bool removePluginSearchPath(const juce::String& directoryPath);

    // Get all discovered external plugins
    juce::Array<juce::PluginDescription> getAvailablePlugins() const;

    // Get list of available S13FX/JSFX scripts
    std::vector<S13FXInfo> getAvailableS13FX() const;

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
    bool removeFromBlacklist(const juce::String& pluginId);
    juce::StringArray getBlacklistedPlugins() const;

private:
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPluginList;
    juce::File pluginListFile;
    juce::File blacklistFile;
    juce::File pluginSearchPathsFile;
    juce::File pluginScanDeadMansPedalFile;
    juce::StringArray blacklistedPlugins;
    juce::StringArray customPluginSearchPaths;
    std::vector<S13FXInfo> s13fxList;
    mutable juce::CriticalSection pluginManagerLock;
    juce::CriticalSection pluginScanLock;
    bool liveLv2PathsNeedPriming = true;
    juce::uint64 pluginStateRevision = 0;

    bool savePluginList();
    void loadPluginList();
    bool savePluginSearchPaths() const;
    void loadPluginSearchPaths();
    static void scanDirectory(const juce::File& dir,
                              bool isStock,
                              std::vector<S13FXInfo>& destination);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginManager)
};
