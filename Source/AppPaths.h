#pragma once
#include <JuceHeader.h>

namespace AppPaths
{
inline juce::File documents()
{
    return juce::File::getSpecialLocation(juce::File::userDocumentsDirectory).getChildFile("OpenStudio");
}
inline juce::File applicationData()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("OpenStudio");
}
inline juce::File diagnostics()
{
   #if JUCE_MAC
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("Logs/OpenStudio");
   #else
    return documents();
   #endif
}
inline juce::File pluginSettings()
{
   #if JUCE_MAC
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("Application Support/OpenStudio/Plugins");
   #else
    return documents();
   #endif
}
}
