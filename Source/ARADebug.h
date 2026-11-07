#pragma once

#include "AppPaths.h"
#include "RealtimeDiagnosticsConfig.h"
#include <JuceHeader.h>

inline constexpr bool kEnableARADebugDiagnostics = OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS != 0;

#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
inline void logARADebugLine(const juce::String& msg)
{
    if (!kEnableARADebugDiagnostics)
        return;

    auto logFile = AppPaths::diagnostics().getChildFile("debug_log.txt");
    logFile.getParentDirectory().createDirectory();
    logFile.appendText(juce::Time::getCurrentTime().toString(true, true)
        + ": " + msg + "\n");
}
#else
// Discard arguments too: formatting a disabled diagnostic is still audio work.
#define logARADebugLine(...) do {} while (false)
#endif
