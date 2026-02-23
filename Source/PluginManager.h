#pragma once

#include <JuceHeader.h>
#include <memory>
#include <vector>

// Manages VST3 plugin scanning and loading
class PluginManager
{
public:
    PluginManager();
    ~PluginManager();
    
    // Scan for available plugins
    void scanForPlugins();
    
    // Get list of available plugins
    juce::Array<juce::PluginDescription> getAvailablePlugins() const;
    
    // Load a plugin by its description (uses actual device sample rate & block size)
    std::unique_ptr<juce::AudioProcessor> loadPlugin(const juce::PluginDescription& description,
                                                     double sampleRate = 44100.0, int blockSize = 512);

    // Load a plugin by file path (uses actual device sample rate & block size)
    std::unique_ptr<juce::AudioProcessor> loadPluginFromFile(const juce::String& filePath,
                                                              double sampleRate = 44100.0, int blockSize = 512);

private:
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPluginList;
    juce::File pluginListFile;
    
    void savePluginList();
    void loadPluginList();
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginManager)
};
