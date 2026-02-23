#include <JuceHeader.h>
#include "MainComponent.h"

#if JUCE_WINDOWS
 #include <dwmapi.h>
#endif

//==============================================================================
class Studio13Application  : public juce::JUCEApplication
{
public:
    //==============================================================================
    Studio13Application() {}

    const juce::String getApplicationName() override       { return ProjectInfo::projectName; }
    const juce::String getApplicationVersion() override    { return ProjectInfo::versionString; }
    bool moreThanOneInstanceAllowed() override             { return true; }

    //==============================================================================
    void initialise (const juce::String& commandLine) override
    {
        juce::ignoreUnused (commandLine);
        // Debug Logging
        auto logFile = juce::File::getSpecialLocation(juce::File::SpecialLocationType::currentApplicationFile)
                                .getSiblingFile("Studio13_Debug.log");
        juce::Logger::setCurrentLogger(new juce::FileLogger(logFile, "Studio13 Startup Log"));
        juce::Logger::writeToLog("Application Initialising...");

        // This method is where you should create your mainWindow
        mainWindow.reset (new MainWindow (getApplicationName()));
        
        juce::Logger::writeToLog("MainWindow Created.");
    }

    void shutdown() override
    {
        juce::Logger::writeToLog("Application Check-out.");
        
        // Add your application's shutdown code here..

        mainWindow = nullptr; // (deletes our window)
        
        juce::Logger::setCurrentLogger(nullptr);
    }

    //==============================================================================
    void systemRequestedQuit() override
    {
        // This is called when the app is being asked to quit: you can ignore this
        // request and let the app carry on running, or call quit() to allow the app to close.
        quit();
    }

    void anotherInstanceStarted (const juce::String& commandLine) override
    {
        juce::ignoreUnused (commandLine);
    }

    //==============================================================================
    /*
        This class implements the desktop window that contains an instance of
        our MainComponent class.
    */
    class MainWindow    : public juce::DocumentWindow,
                          private juce::Timer
    {
    public:
        MainWindow (juce::String name)
            : DocumentWindow (name,
                              juce::Colours::black,
                              0)  // No JUCE title bar buttons — custom controls in React
        {
            setUsingNativeTitleBar (false);
            setTitleBarHeight (0);
            setContentOwned (new MainComponent(), true);

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

                // Add native resize frame (WS_THICKFRAME) — drawn outside client area,
                // no clipping.  Also enables Windows Snap (drag-to-edge tiling).
                auto style = ::GetWindowLongPtr (hwnd, GWL_STYLE);
                style |= WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
                ::SetWindowLongPtr (hwnd, GWL_STYLE, style);
                ::SetWindowPos (hwnd, nullptr, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

                // DWMWA_USE_IMMERSIVE_DARK_MODE (attribute 20) — dark window shadow
                BOOL useDarkMode = TRUE;
                ::DwmSetWindowAttribute (hwnd, 20, &useDarkMode, sizeof (useDarkMode));
            }
           #endif

            // WebView2 creates its native control asynchronously (typically
            // 200-500ms after construction).  We need to force a resize AFTER
            // the control exists so it picks up the correct window dimensions.
            // A one-shot timer handles this reliably across platforms.
            startTimer (600);
        }

        void closeButtonPressed() override
        {
            JUCEApplication::getInstance()->systemRequestedQuit();
        }

        // Return zero borders so the content fills the full client area.
        // Native resize is handled by WS_THICKFRAME (outside the client area).
        juce::BorderSize<int> getBorderThickness() const override { return { 0, 0, 0, 0 }; }
        juce::BorderSize<int> getContentComponentBorder() const override { return { 0, 0, 0, 0 }; }

    private:
        void timerCallback() override
        {
            stopTimer();

            // Force a real resize cycle by nudging the size ±1px.
            // This triggers WM_SIZE → DocumentWindow::resized() →
            // MainComponent::resized() → webView.setBounds(), which
            // now reaches the fully-initialised WebView2 native control.
            auto b = getBounds();
            setBounds (b.withWidth (b.getWidth() + 1));
            setBounds (b);
        }

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
    };

private:
    std::unique_ptr<MainWindow> mainWindow;
};

//==============================================================================
// This macro generates the main() routine that launches the app.
START_JUCE_APPLICATION (Studio13Application)
