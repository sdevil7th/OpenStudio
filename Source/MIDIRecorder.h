#pragma once

#include <JuceHeader.h>
#include "MIDIClip.h"
#include <map>
#include <vector>

/**
 * MIDIRecorder — thread-safe MIDI event accumulation during recording.
 *
 * Mirrors the AudioRecorder pattern: message thread calls start/stop,
 * audio/MIDI callback thread pushes events via recordEvent().
 * On stop, completed MIDI clips are collected with metadata.
 *
 * Unlike AudioRecorder, MIDI data is tiny so we accumulate in memory
 * (no disk I/O) and optionally export to .mid files after recording stops.
 */
class MIDIRecorder
{
public:
    MIDIRecorder() = default;
    ~MIDIRecorder() = default;

    /// Start recording for a track. Call on message thread.
    void startRecording(const juce::String& trackId, double sampleRate);

    /// Record a MIDI event. Call from MIDI callback thread.
    /// Uses ScopedTryLock — drops events if lock is held (start/stop).
    void recordEvent(const juce::String& trackId, double timeInSeconds, const juce::MidiMessage& message);

    /// Set recording start time (called from audio thread on first block).
    void setRecordingStartTime(const juce::String& trackId, double timeInSeconds);

    /// Check if a track is recording (audio-thread safe).
    bool isRecording(const juce::String& trackId) const;

    /// Result returned when recording finishes.
    struct CompletedMIDIRecording
    {
        juce::String trackId;
        juce::File midiFile;       // Path to exported .mid file (empty if export failed)
        double startTime;          // When recording started (seconds)
        double duration;           // Duration of recorded MIDI data
        std::vector<MIDIEvent> events;  // All recorded events (timestamps relative to clip start)
    };

    /// Stop all recordings, export to .mid files, return completed clips.
    /// Call on message thread.
    std::vector<CompletedMIDIRecording> stopAllRecordings(const juce::File& outputFolder, double tempo);

    /// Stop a single track recording.
    void stopRecording(const juce::String& trackId);

private:
    struct ActiveMIDIRecording
    {
        juce::String trackId;
        std::vector<MIDIEvent> events;   // Accumulated MIDI events
        double startTime = 0.0;          // Timeline start time in seconds
        double sampleRate = 44100.0;
        std::atomic<bool> isActive { false };
    };

    std::map<juce::String, ActiveMIDIRecording> activeRecordings;
    mutable juce::CriticalSection recLock;  // Protects activeRecordings map

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MIDIRecorder)
};
