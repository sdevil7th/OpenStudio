#pragma once
#include <juce_core/juce_core.h>

// The unsigned outer JSON remains readable by older clients. New clients only
// consume the exact UTF-8 payload authenticated by the embedded Ed25519 key.
namespace UpdateManifest
{
juce::var verify(const juce::var& envelope, const juce::String& publicKeyHex, juce::String& error);
juce::String publicKey();
juce::String architecture();
juce::String systemVersion();
juce::String libcVersion();
bool numericVersion(const juce::String& version);
int compareVersions(const juce::String& left, const juce::String& right);
bool compatible(const juce::var& platform, const juce::String& arch,
                const juce::String& osVersion, const juce::String& glibc, juce::String& error);
}
