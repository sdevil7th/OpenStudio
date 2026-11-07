#pragma once
#include <juce_core/juce_core.h>

namespace AIRuntimeMaintenance
{
// Called before constructing any recording-capable engine.
void runStartupMaintenance(const juce::File& root, const juce::String& version);
// Records a new version once. Eligibility uses only installed files.
bool claimUpdateOffer(const juce::File& root, const juce::String& version);
}
