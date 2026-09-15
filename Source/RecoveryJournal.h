#pragma once
#include <JuceHeader.h>

// Durable work metadata, not an audio log. Used only off the realtime callback.
// Each session owns a process lock; discovery never touches live-session work.
class RecoveryJournal
{
public:
    static juce::File defaultRoot();
    explicit RecoveryJournal(const juce::File& root = defaultRoot());
    ~RecoveryJournal();
    juce::String create(const juce::String& kind, const juce::var& payload);
    bool update(const juce::String& id, const juce::var& payload);
    juce::File entryFile(const juce::String& id) const;
    void markClean();
    static juce::var discover(const juce::File& root = defaultRoot());
    static juce::var readInactive(const juce::String& id, const juce::File& root = defaultRoot());
    static bool dismiss(const juce::String& id, const juce::File& root = defaultRoot());
    // Called only after an explicit project file has been published successfully.
    static void acknowledgeSavedProject(const juce::var& document, const juce::File& root = defaultRoot());
    static bool write(const juce::File& file, const juce::var& payload);
    static bool updateOwnedAI(const juce::String& id, const juce::var& fields,
                              const juce::File& root = defaultRoot());
private:
    juce::File root;
    juce::String sessionId { juce::Uuid().toString() };
    juce::InterProcessLock liveLock;
    bool locked = false;
};
