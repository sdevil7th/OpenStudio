#include "MixerWindowManager.h"
#include "MainComponent.h"

namespace
{
juce::Rectangle<int> sanitiseMixerBounds(const juce::Rectangle<int>& requested)
{
    constexpr int minWidth = 900;
    constexpr int minHeight = 380;

    auto bounds = requested;
    if (bounds.getWidth() <= 0 || bounds.getHeight() <= 0)
        bounds = { 120, 120, 1280, 540 };

    bounds.setWidth(juce::jmax(minWidth, bounds.getWidth()));
    bounds.setHeight(juce::jmax(minHeight, bounds.getHeight()));

    if (auto* display = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay())
    {
        const auto area = display->userArea;
        if (bounds.getWidth() > area.getWidth())
            bounds.setWidth(area.getWidth());
        if (bounds.getHeight() > area.getHeight())
            bounds.setHeight(area.getHeight());
        if (!area.contains(bounds))
            bounds = bounds.withPosition(area.getX() + 40, area.getY() + 40);
    }

    return bounds;
}
}

class MixerWindowManager::MixerWindow : public juce::DocumentWindow
{
public:
    MixerWindow(MixerWindowManager& ownerIn, std::unique_ptr<MainComponent> content)
        : juce::DocumentWindow("Mixer",
                               juce::Colours::black,
                               juce::DocumentWindow::allButtons),
          owner(ownerIn)
    {
        setUsingNativeTitleBar(true);
        setResizable(true, true);
        setResizeLimits(900, 380, 10000, 10000);
        setContentOwned(content.release(), true);
    }

    void closeButtonPressed() override
    {
        owner.close();
    }

private:
    MixerWindowManager& owner;
};

MixerWindowManager::MixerWindowManager(ComponentFactory componentFactoryIn,
                                       ClosedCallback closedCallbackIn)
    : componentFactory(std::move(componentFactoryIn)),
      closedCallback(std::move(closedCallbackIn))
{
}

MixerWindowManager::~MixerWindowManager()
{
    close();
}

bool MixerWindowManager::open(const juce::Rectangle<int>& bounds)
{
    const auto targetBounds = sanitiseMixerBounds(bounds);

    if (mixerWindow != nullptr)
    {
        mixerWindow->setBounds(targetBounds);
        mixerWindow->setVisible(true);
        mixerWindow->toFront(true);
        return true;
    }

    if (!componentFactory)
        return false;

    auto content = componentFactory();
    if (content == nullptr)
        return false;

    mixerWindow = std::make_unique<MixerWindow>(*this, std::move(content));
    mixerWindow->setBounds(targetBounds);
    mixerWindow->setVisible(true);
    mixerWindow->toFront(true);

    juce::Component::SafePointer<juce::DocumentWindow> safeWindow(mixerWindow.get());
    juce::Timer::callAfterDelay(600, [safeWindow]()
    {
        if (safeWindow != nullptr)
        {
            const auto boundsNow = safeWindow->getBounds();
            safeWindow->setBounds(boundsNow.withWidth(boundsNow.getWidth() + 1));
            safeWindow->setBounds(boundsNow);
        }
    });

    return true;
}

bool MixerWindowManager::close()
{
    if (mixerWindow == nullptr)
        return false;

    handleWindowClosed();
    return true;
}

bool MixerWindowManager::isOpen() const
{
    return mixerWindow != nullptr;
}

void MixerWindowManager::handleWindowClosed()
{
    if (mixerWindow == nullptr)
        return;

    const auto bounds = mixerWindow->getBounds();
    mixerWindow->setVisible(false);
    mixerWindow = nullptr;

    if (closedCallback)
        closedCallback(bounds);
}
