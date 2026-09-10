#pragma once
#include "RecoveryJournal.h"
#include <functional>

namespace RecordingRecovery
{
juce::var inspect(const juce::var& entry);
juce::var repair(const juce::String& id, const std::function<bool()>& keepRunning,
                 const juce::File& root = RecoveryJournal::defaultRoot());
}
