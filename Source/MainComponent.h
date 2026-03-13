#pragma once

#include <JuceHeader.h>
#include "AudioEngine.h"

//==============================================================================
/*
    This component lives inside our window, and this is where you should put all
    your controls and content.
*/
class MainComponent  : public juce::Component,
                       public juce::Timer
{
public:
    //==============================================================================
    MainComponent();
    ~MainComponent() override;

    //==============================================================================
    void paint (juce::Graphics&) override;
    void resized() override;

    void timerCallback() override;

private:
    //==============================================================================
    // Your private member variables go here...
    juce::WebBrowserComponent webView;
    AudioEngine audioEngine;
    std::unique_ptr<juce::FileChooser> fileChooser;  // For async file dialogs

    // Async pitch analysis state
    std::atomic<bool> pitchAnalysisRunning { false };
    juce::var lastPitchAnalysisResult;  // Cached result for fetch-after-event pattern
    juce::CriticalSection pitchResultLock;

    // Background thread for pitch correction (1 slot — serialises apply calls)
    juce::ThreadPool pitchCorrectionPool { 1 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
