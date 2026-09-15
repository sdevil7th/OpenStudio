#pragma once
#include <JuceHeader.h>

namespace ProjectFileStore
{
    // Worker/control threads only. Checked temporary writes and serialized
    // replacement; recovery generations are ordinary loadable .osproj files.
    juce::Result save(const juce::File& target, const juce::String& json,
                      bool recoveryOnly, int maxVersions, const juce::File& workRecoveryRoot = {});
    juce::Array<juce::File> recoveryFiles(const juce::File& target, int maxVersions);

    class RecoverySession
    {
    public:
        explicit RecoverySession(const juce::File& rootDirectory = defaultRoot());
        ~RecoverySession();
        static juce::File defaultRoot();
        juce::Result write(const juce::String& documentId, const juce::String& sourcePath,
                           const juce::String& json, int maxVersions);
        juce::var discover() const;
        juce::Result dismiss(const juce::String& candidateId);
        juce::Result retireDocument(const juce::String& documentId);
        juce::Result markClean(); // Explicit normal shutdown only, after file jobs drain.
        const juce::String& getId() const { return sessionId; }
    private:
        juce::File root;
        juce::String sessionId { juce::Uuid().toString() };
        juce::InterProcessLock sessionLock;
        bool lockHeld = false;
    };
}
