#pragma once
#include <juce_core/juce_core.h>

namespace AIRuntimeMaintenance
{
// Called before constructing any recording-capable engine.
void runRequestedMaintenance(const juce::File& root);
}
