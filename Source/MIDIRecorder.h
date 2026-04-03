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

    struct LivePreviewActiveNote
    {
        int note = 60;
        double startTimestamp = 0.0;
    };

    struct LivePreviewRequest
    {
        juce::String trackId;
        uint64_t generation = 0;
        int knownEventCount = 0;
    };

    struct LivePreviewSnapshot
    {
        juce::String trackId;
        uint64_t generation = 0;
        double recordingStartTime = 0.0;
        int totalEventCount = 0;
        std::vector<MIDIEvent> deltaEvents;
        std::vector<LivePreviewActiveNote> activeNotes;
    };

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

    /// Get live MIDI preview snapshots for actively recording tracks.
    /// Uses ScopedTryLock to avoid stalling the MIDI callback.
    std::vector<LivePreviewSnapshot> getLivePreviewSnapshots(const std::vector<LivePreviewRequest>& requests) const;

    /// Stop a single track recording.
    void stopRecording(const juce::String& trackId);

private:
    struct HeldPreviewNote
    {
        int note = 60;
        int channel = 1;
        double startTimestamp = 0.0;
    };

    struct ActiveMIDIRecording
    {
        juce::String trackId;
        std::vector<MIDIEvent> events;   // Accumulated MIDI events
        std::vector<MIDIEvent> previewNoteEvents; // Note-only events for live preview
        std::vector<HeldPreviewNote> activeHeldNotes;
        double startTime = 0.0;          // Timeline start time in seconds
        double sampleRate = 44100.0;
        uint64_t generation = 0;
        std::atomic<bool> isActive { false };
    };

    std::map<juce::String, ActiveMIDIRecording> activeRecordings;
    mutable juce::CriticalSection recLock;  // Protects activeRecordings map
    std::atomic<uint64_t> nextPreviewGeneration { 1 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MIDIRecorder)
};
