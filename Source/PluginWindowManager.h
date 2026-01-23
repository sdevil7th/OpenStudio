#pragma once

#include <JuceHeader.h>
#include <memory>
#include <map>

// Manages plugin editor windows
// Opens native VST3 GUIs for plugins like Amplitube, Guitar Rig, Kontakt, etc.
class PluginWindowManager : public juce::Timer
{
public:
    PluginWindowManager();
    ~PluginWindowManager() override;
    
    // Open plugin editor for a specific processor
    void openEditor(juce::AudioProcessor* processor, const juce::String& windowTitle);
    
    // Close editor for a specific processor
    void closeEditor(juce::AudioProcessor* processor);
    
    // Close all plugin windows
    void closeAllEditors();
    
    // Check if editor is open
    bool isEditorOpen(juce::AudioProcessor* processor) const;
    
    // Timer callback to update plugin windows
    void timerCallback() override;

private:
    struct PluginWindow : public juce::DocumentWindow
    {
        PluginWindow(juce::AudioProcessor& proc, const juce::String& title);
        ~PluginWindow() override;
        
        void closeButtonPressed() override;
        
        juce::AudioProcessor& processor;
    };
    
    std::map<juce::AudioProcessor*, std::unique_ptr<PluginWindow>> activeWindows;
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginWindowManager)
};
