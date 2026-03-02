#pragma once

#include <JuceHeader.h>
#include <clap/clap.h>

// CLAP plugin hosting for JUCE — implements juce::AudioPluginFormat
// so CLAP plugins appear alongside VST3/LV2 in the plugin browser.

class CLAPPluginFormat : public juce::AudioPluginFormat
{
public:
    CLAPPluginFormat();
    ~CLAPPluginFormat() override;

    // --- juce::AudioPluginFormat overrides ---
    juce::String getName() const override { return "CLAP"; }
    bool canScanForPlugins() const override { return true; }
    bool isTrivialToScan() const override { return false; }

    void findAllTypesForFile(juce::OwnedArray<juce::PluginDescription>& results,
                             const juce::String& fileOrIdentifier) override;

    bool fileMightContainThisPluginType(const juce::String& fileOrIdentifier) override;
    juce::String getNameOfPluginFromIdentifier(const juce::String& fileOrIdentifier) override;
    bool pluginNeedsRescanning(const juce::PluginDescription& desc) override;
    bool doesPluginStillExist(const juce::PluginDescription& desc) override;
    juce::StringArray searchPathsForPlugins(const juce::FileSearchPath& directoriesToSearch,
                                             bool recursive, bool allowAsync) override;
    juce::FileSearchPath getDefaultLocationsToSearch() override;
    bool requiresUnblockedMessageThreadDuringCreation(const juce::PluginDescription&) const override { return false; }

protected:
    void createPluginInstance(const juce::PluginDescription& desc,
                              double initialSampleRate, int initialBufferSize,
                              PluginCreationCallback callback) override;

private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CLAPPluginFormat)
};
