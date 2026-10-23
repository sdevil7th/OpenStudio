#pragma once
#include <juce_core/juce_core.h>

// The application prepares a transaction, then authorises it only on orderly
// shutdown. The independent helper never terminates an application process.
namespace UpdateInstaller
{
// POSIX staging directories are created with mode 0700. Existing directories
// and ancestors must already satisfy the updater's ownership/trust policy;
// their permissions are never changed. Windows retains normal inherited ACLs.
bool ensurePrivateDirectory(const juce::File& directory);
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
