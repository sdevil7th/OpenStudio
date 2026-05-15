#pragma once

#include <JuceHeader.h>
#include <functional>
#include <memory>

class MainComponent;

class MixerWindowManager
{
public:
    using ComponentFactory = std::function<std::unique_ptr<MainComponent>()>;
    using ClosedCallback = std::function<void(const juce::Rectangle<int>&)>;

    MixerWindowManager(ComponentFactory componentFactoryIn,
                       ClosedCallback closedCallbackIn,
                       juce::String windowTitleIn = "Mixer",
                       juce::Rectangle<int> defaultBoundsIn = { 120, 120, 1280, 540 },
                       int minWidthIn = 900,
                       int minHeightIn = 380);
    ~MixerWindowManager();

    bool open(const juce::Rectangle<int>& bounds);
    bool prewarm(const juce::Rectangle<int>& bounds);
    bool focus();
    bool hide();
    bool close();
    bool isOpen() const;

private:
    class MixerWindow;

    void handleWindowClosed();

    ComponentFactory componentFactory;
    ClosedCallback closedCallback;
    juce::String windowTitle;
    juce::Rectangle<int> defaultBounds;
    int minWidth = 900;
    int minHeight = 380;
    std::unique_ptr<MixerWindow> mixerWindow;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MixerWindowManager)
};
