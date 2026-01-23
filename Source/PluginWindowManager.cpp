#include "PluginWindowManager.h"

//==============================================================================
// PluginWindow implementation

PluginWindowManager::PluginWindow::PluginWindow(juce::AudioProcessor& proc, const juce::String& title)
    : DocumentWindow(title,
                    juce::Colours::darkgrey,
                    DocumentWindow::allButtons),
      processor(proc)
{
    setUsingNativeTitleBar(true);
    setResizable(true, false);
    
    // Create and add editor component
    if (auto* editor = processor.createEditorIfNeeded())
    {
        setContentOwned(editor, true);
        
        // Center on screen
        centreWithSize(editor->getWidth(), editor->getHeight());
        setVisible(true);
        
        juce::Logger::writeToLog("PluginWindow: Opened editor for " + processor.getName());
    }
    else
    {
        juce::Logger::writeToLog("PluginWindow: Failed to create editor for " + processor.getName());
    }
}

PluginWindowManager::PluginWindow::~PluginWindow()
{
    clearContentComponent();
}

void PluginWindowManager::PluginWindow::closeButtonPressed()
{
    setVisible(false);
}

//==============================================================================
// PluginWindowManager implementation

PluginWindowManager::PluginWindowManager()
{
    // Update windows at 30 Hz
    startTimerHz(30);
}

PluginWindowManager::~PluginWindowManager()
{
    stopTimer();
    closeAllEditors();
}

void PluginWindowManager::openEditor(juce::AudioProcessor* processor, const juce::String& windowTitle)
{
    if (!processor)
        return;
    
    // Close existing window if open
    closeEditor(processor);
    
    // Create new window on the message thread
    juce::MessageManager::callAsync([this, processor, windowTitle]()
    {
        if (processor->hasEditor())
        {
            auto window = std::make_unique<PluginWindow>(*processor, windowTitle);
            activeWindows[processor] = std::move(window);
            
            juce::Logger::writeToLog("PluginWindowManager: Opened window for " + processor->getName());
        }
        else
        {
            juce::Logger::writeToLog("PluginWindowManager: Plugin has no editor: " + processor->getName());
        }
    });
}

void PluginWindowManager::closeEditor(juce::AudioProcessor* processor)
{
    if (!processor)
        return;
    
    auto it = activeWindows.find(processor);
    if (it != activeWindows.end())
    {
        juce::MessageManager::callAsync([this, processor]()
        {
            activeWindows.erase(processor);
            juce::Logger::writeToLog("PluginWindowManager: Closed window for " + processor->getName());
        });
    }
}

void PluginWindowManager::closeAllEditors()
{
    juce::MessageManager::callAsync([this]()
    {
        activeWindows.clear();
        juce::Logger::writeToLog("PluginWindowManager: Closed all plugin windows");
    });
}

bool PluginWindowManager::isEditorOpen(juce::AudioProcessor* processor) const
{
    return activeWindows.find(processor) != activeWindows.end();
}

void PluginWindowManager::timerCallback()
{
    // Remove windows that have been closed
    for (auto it = activeWindows.begin(); it != activeWindows.end();)
    {
        if (!it->second->isVisible())
        {
            it = activeWindows.erase(it);
        }
        else
        {
            ++it;
        }
    }
}
