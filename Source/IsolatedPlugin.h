#pragma once
#include <JuceHeader.h>
#include <memory>

// Windows opt-in, per-instance process hosting. No processor binary is loaded
// in the parent, including its state reader and native editor.
class IsolatedPlugin final : public juce::AudioPluginInstance, private juce::Timer
{
public:
    using juce::AudioProcessor::BusesProperties;
    static std::unique_ptr<IsolatedPlugin> create(const juce::PluginDescription&, double, int,
                                                 juce::String& error);
    ~IsolatedPlugin() override;
    const juce::String getName() const override;
    void fillInPluginDescription(juce::PluginDescription&) const override;
    void prepareToPlay(double, int) override;
    void releaseResources() override;
    void reset() override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram(int) override;
    const juce::String getProgramName(int) override;
    void changeProgramName(int, const juce::String&) override {} // Names belong to the remote native editor.
    void getStateInformation(juce::MemoryBlock&) override;
    void setStateInformation(const void*, int) override;
    bool isBusesLayoutSupported(const BusesLayout&) const override;
    bool isHealthy() const noexcept;
    juce::String failureDescription() const;
    bool restart(); // Explicit control-thread action; last acknowledged state only.
    bool openRemoteEditor();
    void closeRemoteEditor();
    bool remoteEditorHasFocus() const;
    bool remoteEditorIsOpen() const;
    bool takeUnhandledKey(juce::KeyPress&, bool& repeat);
    uint32_t processId() const;
    int transportLatencySamples() const noexcept;
    const std::atomic<uint32_t>* faultFlag() const noexcept;
    // Device-free subprocess fixture uses the exact production transport.
    bool setTestFailure(int);
private:
    struct Impl;
    IsolatedPlugin(std::unique_ptr<Impl>, const BusesProperties&);
    std::unique_ptr<Impl> impl;
    void timerCallback() override;
};

// Runs before constructing AudioEngine/devices in this owned helper process.
int runIsolatedPluginWorker(const juce::String& mappingName);
int runIsolatedPluginRegression(const juce::File& directory, bool exerciseEditors = false);
int runIsolatedPluginCompatibility(const juce::File& catalog, const juce::String& name, const juce::File& directory);
