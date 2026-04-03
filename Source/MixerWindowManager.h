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
                       ClosedCallback closedCallbackIn);
    ~MixerWindowManager();

    bool open(const juce::Rectangle<int>& bounds);
    bool close();
    bool isOpen() const;

private:
    class MixerWindow;

    void handleWindowClosed();

    ComponentFactory componentFactory;
    ClosedCallback closedCallback;
    std::unique_ptr<MixerWindow> mixerWindow;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MixerWindowManager)
};
