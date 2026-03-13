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

    if (auto* editor = processor.createEditor())
    {
        setContentOwned(editor, true);

        int w = juce::jmax(editor->getWidth(), 200);
        int h = juce::jmax(editor->getHeight(), 150);
        centreWithSize(w, h);
        setVisible(true);
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
    auto it = activeWindows.find(processor);
    if (it != activeWindows.end())
        activeWindows.erase(it);

    if (!processor->hasEditor())
        return;

    auto window = std::make_unique<PluginWindow>(*processor, windowTitle);
    activeWindows[processor] = std::move(window);
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

void PluginWindowManager::closeEditorsForTrack(const std::vector<juce::AudioProcessor*>& processors)
{
    // Must be called from the message thread to synchronously destroy windows
    // before the processors are deleted
    for (auto* proc : processors)
    {
        if (proc)
        {
            auto it = activeWindows.find(proc);
            if (it != activeWindows.end())
            {
                juce::Logger::writeToLog("PluginWindowManager: Closing editor for track processor: " + proc->getName());
                activeWindows.erase(it);
            }
        }
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

void PluginWindowManager::closeAllEditorsSync()
{
    activeWindows.clear();
    juce::Logger::writeToLog("PluginWindowManager: Closed all plugin windows (sync)");
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
