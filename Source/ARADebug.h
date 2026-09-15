#include "AppPaths.h"
#pragma once

#include <JuceHeader.h>

inline constexpr bool kEnableARADebugDiagnostics = true;

inline void logARADebugLine(const juce::String& msg)
{
    if (!kEnableARADebugDiagnostics)
        return;

    auto logFile = AppPaths::diagnostics().getChildFile("debug_log.txt");
    logFile.getParentDirectory().createDirectory();
    logFile.appendText(juce::Time::getCurrentTime().toString(true, true)
        + ": " + msg + "\n");
}
