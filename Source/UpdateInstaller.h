#pragma once
#include <juce_core/juce_core.h>

// The application prepares a transaction, then authorises it only on orderly
// shutdown. The independent helper never terminates an application process.
namespace UpdateInstaller
{
juce::File installedApplication();
bool prepare(const juce::File& package, const juce::var& envelope,
             const juce::File& stateRoot, juce::File& transaction, juce::String& error,
             std::function<bool()> shouldCancel = {});
void cancel(const juce::File& transaction);
void commit(const juce::File& transaction);
bool registerRunningApplication(const juce::String& startupReceipt = {});
void acknowledgeFrontendReady();
juce::String previousResult(const juce::File& stateRoot);
int runHelper(const juce::File& transaction);
int selfTest(const juce::File& directory);
}
