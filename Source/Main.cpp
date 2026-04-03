#include <JuceHeader.h>
#include "ApplicationLaunchState.h"
#include "AudioEngine.h"
#include "AppUpdater.h"
#include "MainComponent.h"
#include "MixerWindowManager.h"

#if JUCE_WINDOWS
 #include <dwmapi.h>
#endif

namespace
{
juce::File getWritableStartupLogFile()
{
    auto logDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                    .getChildFile("OpenStudio")
                    .getChildFile("logs");

    if (logDir.createDirectory())
        return logDir.getChildFile("OpenStudio_Startup.log");

    return juce::File::getSpecialLocation(juce::File::SpecialLocationType::currentApplicationFile)
        .getSiblingFile("OpenStudio_Debug.log");
}

juce::Rectangle<int> rectangleFromVar(const juce::var& value)
{
    if (auto* obj = value.getDynamicObject())
    {
        return {
            static_cast<int>(obj->getProperty("x")),
            static_cast<int>(obj->getProperty("y")),
            static_cast<int>(obj->getProperty("width")),
            static_cast<int>(obj->getProperty("height"))
        };
    }

    return {};
}

juce::var rectangleToVar(const juce::Rectangle<int>& bounds)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("x", bounds.getX());
    obj->setProperty("y", bounds.getY());
    obj->setProperty("width", bounds.getWidth());
    obj->setProperty("height", bounds.getHeight());
    return juce::var(obj);
}
}

//==============================================================================
class OpenStudioApplication  : public juce::JUCEApplication
{
public:
    OpenStudioApplication() = default;

    const juce::String getApplicationName() override       { return ProjectInfo::projectName; }
    const juce::String getApplicationVersion() override    { return ProjectInfo::versionString; }
    bool moreThanOneInstanceAllowed() override             { return true; }

    void initialise (const juce::String& commandLine) override
    {
        OpenStudioLaunchState::setPendingProjectPath(commandLine);

        auto logFile = getWritableStartupLogFile();
        juce::Logger::setCurrentLogger(new juce::FileLogger(logFile, "OpenStudio Startup Log"));
        juce::Logger::writeToLog("Application Initialising...");
        juce::Logger::writeToLog("Startup log path: " + logFile.getFullPathName());

        mixerWindowManager = std::make_unique<MixerWindowManager>(
            [this]()
            {
                return std::make_unique<MainComponent>(audioEngine,
                                                       appUpdater,
                                                       MainComponent::WindowRole::mixer,
                                                       createWindowCallbacks());
            },
            [this](const juce::Rectangle<int>& bounds)
            {
                handleMixerWindowClosed(bounds);
            });

        mainWindow = std::make_unique<MainWindow>(getApplicationName(),
                                                  audioEngine,
                                                  appUpdater,
                                                  createWindowCallbacks());

        if (auto* component = mainWindow->getMainComponent())
            audioEngine.setPluginWindowOwnerComponent(component);

        audioEngine.onPeaksReady = [] (const juce::String& filePath)
        {
            auto* data = new juce::DynamicObject();
            data->setProperty("filePath", filePath);
            MainComponent::broadcastEventToAll("peaksReady", juce::var(data));
        };

        appUpdater.setStatusCallback([](const juce::var& status)
        {
            MainComponent::broadcastEventToAll("updateStatusChanged", status);
        });

        audioEngine.setPluginWindowShortcutForwardCallback([](const juce::var& payload)
        {
            MainComponent::broadcastEventToAll("nativeGlobalShortcut", payload);
        });

        juce::Logger::writeToLog("MainWindow Created.");
    }

    void shutdown() override
    {
        juce::Logger::writeToLog("Application Check-out.");

        mixerWindowManager = nullptr;
        mainWindow = nullptr;

        juce::Logger::setCurrentLogger(nullptr);
    }

    void systemRequestedQuit() override
    {
        if (mixerWindowManager != nullptr)
            mixerWindowManager->close();

        quit();
    }

    void anotherInstanceStarted (const juce::String& commandLine) override
    {
        OpenStudioLaunchState::setPendingProjectPath(commandLine);
    }

    class MainWindow    : public juce::DocumentWindow,
                          private juce::Timer
    {
    public:
        MainWindow (juce::String name,
                    AudioEngine& audioEngine,
                    AppUpdater& appUpdater,
                    MainComponent::WindowCallbacks callbacks)
            : DocumentWindow (name,
                              juce::Colours::black,
                              0)
        {
            setUsingNativeTitleBar (false);
            setTitleBarHeight (0);
            setContentOwned (new MainComponent(audioEngine,
                                               appUpdater,
                                               MainComponent::WindowRole::main,
                                               std::move(callbacks)),
                             true);

           #if JUCE_IOS || JUCE_ANDROID
            setFullScreen (true);
           #else
            setResizable (true, true);
            setResizeLimits (800, 600, 10000, 10000);
            centreWithSize (1280, 800);
           #endif

            setVisible (true);

           #if JUCE_WINDOWS
            if (auto* peer = getPeer())
            {
                auto hwnd = static_cast<HWND> (peer->getNativeHandle());

                auto style = ::GetWindowLongPtr (hwnd, GWL_STYLE);
                style |= WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
                ::SetWindowLongPtr (hwnd, GWL_STYLE, style);
                ::SetWindowPos (hwnd, nullptr, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

                BOOL useDarkMode = TRUE;
                ::DwmSetWindowAttribute (hwnd, 20, &useDarkMode, sizeof (useDarkMode));
            }
           #endif

            startTimer (600);
        }

        void closeButtonPressed() override
        {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

        MainComponent* getMainComponent() const
        {
            return dynamic_cast<MainComponent*>(getContentComponent());
        }

        juce::BorderSize<int> getBorderThickness() const override { return { 0, 0, 0, 0 }; }
        juce::BorderSize<int> getContentComponentBorder() const override { return { 0, 0, 0, 0 }; }

    private:
        void timerCallback() override
        {
            stopTimer();

            auto b = getBounds();
            setBounds (b.withWidth (b.getWidth() + 1));
            setBounds (b);
        }

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
    };

private:
    MainComponent::WindowCallbacks createWindowCallbacks()
    {
        MainComponent::WindowCallbacks callbacks;
        callbacks.requestAppClose = [this]()
        {
            systemRequestedQuit();
        };
        callbacks.openMixerWindow = [this](const juce::var& bounds)
        {
            return openMixerWindow(bounds);
        };
        callbacks.closeMixerWindow = [this]()
        {
            return closeMixerWindow();
        };
        callbacks.getMixerWindowState = [this]()
        {
            return getMixerWindowState();
        };
        callbacks.publishMixerUISnapshot = [this](const juce::var& snapshot)
        {
            publishMixerUISnapshot(snapshot);
        };
        callbacks.getMixerUISnapshot = [this]()
        {
            return getMixerUISnapshot();
        };
        return callbacks;
    }

    bool openMixerWindow(const juce::var& boundsValue)
    {
        if (mixerWindowManager == nullptr)
            return false;

        return mixerWindowManager->open(rectangleFromVar(boundsValue));
    }

    bool closeMixerWindow()
    {
        if (mixerWindowManager == nullptr)
            return false;

        return mixerWindowManager->close();
    }

    juce::var getMixerWindowState() const
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("isOpen", mixerWindowManager != nullptr && mixerWindowManager->isOpen());
        return juce::var(obj);
    }

    void publishMixerUISnapshot(const juce::var& snapshot)
    {
        {
            const juce::ScopedLock sl(mixerSnapshotLock);
            latestMixerUISnapshot = snapshot;
        }

        MainComponent::broadcastEventToAll("mixerUISync", snapshot);
    }

    juce::var getMixerUISnapshot() const
    {
        const juce::ScopedLock sl(mixerSnapshotLock);
        return latestMixerUISnapshot;
    }

    void handleMixerWindowClosed(const juce::Rectangle<int>& bounds)
    {
        if (auto* component = mainWindow != nullptr ? mainWindow->getMainComponent() : nullptr)
            audioEngine.setPluginWindowOwnerComponent(component);

        auto* payload = new juce::DynamicObject();
        payload->setProperty("bounds", rectangleToVar(bounds));
        MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "mixerWindowClosed", juce::var(payload));
    }

    AudioEngine audioEngine;
    AppUpdater appUpdater;
    std::unique_ptr<MainWindow> mainWindow;
    std::unique_ptr<MixerWindowManager> mixerWindowManager;
    mutable juce::CriticalSection mixerSnapshotLock;
    juce::var latestMixerUISnapshot;
};

START_JUCE_APPLICATION (OpenStudioApplication)
