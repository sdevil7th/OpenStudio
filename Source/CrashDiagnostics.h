#pragma once

#include <JuceHeader.h>

namespace OpenStudioCrashDiagnostics
{
    void installCrashHandlers();
    void recordBreadcrumb(const juce::String& stage, const juce::String& detail = {});
    juce::File getBreadcrumbLogFile();
    juce::File getLastCrashDumpFile();
}
