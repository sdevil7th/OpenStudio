#pragma once

#include <JuceHeader.h>

inline constexpr bool kEnableARADebugDiagnostics = true;

inline void logARADebugLine(const juce::String& msg)
{
    if (!kEnableARADebugDiagnostics)
        return;

    auto logFile = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
        .getChildFile("OpenStudio").getChildFile("debug_log.txt");
    logFile.getParentDirectory().createDirectory();
    logFile.appendText(juce::Time::getCurrentTime().toString(true, true)
        + ": " + msg + "\n");
}
