#pragma once

#include <JuceHeader.h>
#include <vector>
#include <atomic>

//==============================================================================
// Clip launch/trigger modes
//==============================================================================

enum class ClipLaunchMode
{
    OneShot,    // Play once and stop
    Loop,       // Loop continuously
    Gate        // Play while held (trigger starts, re-trigger stops)
};

//==============================================================================
// Follow actions — what happens when a clip finishes playing
//==============================================================================

enum class FollowAction
{
    None,       // Do nothing
    Next,       // Trigger next slot
    Previous,   // Trigger previous slot
    Random,     // Trigger a random slot on this track
    Stop        // Stop the track
};

//==============================================================================
// Quantize modes for clip launch timing
//==============================================================================

enum class TriggerQuantizeMode
{
    None,       // Launch immediately
    Quarter,    // Quantize to quarter note
    Half,       // Quantize to half note
    Bar,        // Quantize to bar boundary
    TwoBar,     // Quantize to 2-bar boundary
    FourBar     // Quantize to 4-bar boundary
};

//==============================================================================
// ClipSlot — a single slot in the trigger grid
//==============================================================================

struct ClipSlot
{
    // Audio file reference
    juce::String filePath;

    // Clip timing
    double startTime = 0.0;     // Clip start position (seconds) — used for timeline reference
    double duration = 0.0;      // Clip duration (seconds)
    double offset = 0.0;        // Offset into the audio file (seconds)

    // Launch mode
    ClipLaunchMode mode = ClipLaunchMode::OneShot;

    // Playback state (written from audio thread only)
    bool isPlaying = false;
    bool isQueued = false;       // Queued for launch (waiting for quantize boundary)
    bool isStopQueued = false;   // Queued for stop (waiting for quantize boundary)
    double playPosition = 0.0;  // Current playback position within the clip (seconds)

    // Volume
    float volume = 0.0f;        // Slot volume in dB

    // Follow action
    FollowAction followAction = FollowAction::None;
    double followActionTime = 0.0;  // When to execute follow action (in beats)

    // Helpers
    bool hasClip() const { return filePath.isNotEmpty() && duration > 0.0; }
};

//==============================================================================
// TriggerEngine — Ableton Live-style clip launching
//
// Manages a grid of ClipSlots (tracks x slots). The actual audio mixing of
// triggered clips is handled by the existing PlaybackEngine — TriggerEngine
// manages trigger state and timing only. The frontend/AudioEngine reads slot
// states and feeds clips to PlaybackEngine when slots become active.
//==============================================================================

class TriggerEngine
{
public:
    TriggerEngine();
    ~TriggerEngine();

    //--------------------------------------------------------------------------
    // Grid management
    //--------------------------------------------------------------------------

    /** Resize the grid. Pre-allocates all vectors. Call from message thread only. */
    void setGridSize(int numTracks, int numSlots);

    /** Get grid dimensions. */
    int getNumTracks() const { return numTracks_; }
    int getNumSlots() const { return numSlots_; }

    //--------------------------------------------------------------------------
    // Slot content management (message thread)
    //--------------------------------------------------------------------------

    /** Assign an audio clip to a slot. */
    void setSlotClip(int trackIndex, int slotIndex,
                     const juce::String& filePath,
                     double duration, double offset = 0.0);

    /** Clear a slot's clip data. Stops it if playing. */
    void clearSlot(int trackIndex, int slotIndex);

    /** Set a slot's launch mode. */
    void setSlotMode(int trackIndex, int slotIndex, ClipLaunchMode mode);

    /** Set a slot's volume in dB. */
    void setSlotVolume(int trackIndex, int slotIndex, float volumeDB);

    /** Set a slot's follow action and timing. */
    void setSlotFollowAction(int trackIndex, int slotIndex,
                             FollowAction action, double timeInBeats);

    //--------------------------------------------------------------------------
    // Trigger control (message thread — queued for audio thread)
    //--------------------------------------------------------------------------

    /** Queue a slot for launch at the next quantize boundary. */
    void triggerSlot(int trackIndex, int slotIndex);

    /** Queue a slot for stop at the next quantize boundary. */
    void stopSlot(int trackIndex, int slotIndex);

    /** Stop all slots on a track. */
    void stopTrack(int trackIndex);

    /** Trigger all tracks at this slot index (scene launch). */
    void triggerScene(int slotIndex);

    /** Stop all playing and queued slots. */
    void stopAll();

    //--------------------------------------------------------------------------
    // Quantize
    //--------------------------------------------------------------------------

    /** Set the quantize mode for clip launching. */
    void setQuantize(TriggerQuantizeMode mode);

    /** Get the current quantize mode. */
    TriggerQuantizeMode getQuantize() const { return quantizeMode_.load(); }

    //--------------------------------------------------------------------------
    // Audio thread processing
    //--------------------------------------------------------------------------

    /** Called from the audio callback. Checks queued triggers against quantize
        boundaries, advances play positions, handles follow actions.
        No heap allocations occur in this method. */
    void processBlock(int numSamples, double sampleRate, double bpm, double currentBeat);

    //--------------------------------------------------------------------------
    // State queries (message thread — reads atomic/lock-protected state)
    //--------------------------------------------------------------------------

    /** Get a single slot's state as a juce::var for UI sync. */
    juce::var getSlotState(int trackIndex, int slotIndex) const;

    /** Get the entire grid state as a juce::var. */
    juce::var getGridState() const;

    //--------------------------------------------------------------------------
    // Callbacks — set from message thread, called from audio thread context
    // (the actual invocation is deferred to message thread via callAsync)
    //--------------------------------------------------------------------------

    /** Called when a slot starts playing. Args: trackIndex, slotIndex. */
    std::function<void(int, int)> onSlotStarted;

    /** Called when a slot stops playing. Args: trackIndex, slotIndex. */
    std::function<void(int, int)> onSlotStopped;

private:
    //--------------------------------------------------------------------------
    // Grid storage
    //--------------------------------------------------------------------------

    std::vector<std::vector<ClipSlot>> grid_;
    int numTracks_ = 0;
    int numSlots_ = 0;

    //--------------------------------------------------------------------------
    // Quantize
    //--------------------------------------------------------------------------

    std::atomic<TriggerQuantizeMode> quantizeMode_ { TriggerQuantizeMode::Bar };

    /** Previous beat position — used to detect quantize boundary crossings. */
    double previousBeat_ = -1.0;

    //--------------------------------------------------------------------------
    // Thread safety
    //--------------------------------------------------------------------------

    /** SpinLock for queue operations (trigger/stop are called from message thread,
        processBlock reads from audio thread). Lightweight for audio thread use. */
    juce::SpinLock spinLock_;

    //--------------------------------------------------------------------------
    // Internal helpers (called within locked context or from audio thread)
    //--------------------------------------------------------------------------

    /** Check if a quantize boundary was crossed between previousBeat and currentBeat. */
    bool isQuantizeBoundary(double currentBeat, double bpm) const;

    /** Get the number of beats per quantize unit for the current mode. */
    double getBeatsPerQuantize() const;

    /** Start a slot playing (immediate, no queue check). */
    void startSlotInternal(int trackIndex, int slotIndex);

    /** Stop a slot (immediate, no queue check). */
    void stopSlotInternal(int trackIndex, int slotIndex);

    /** Execute follow action for a slot that has reached its end. */
    void executeFollowAction(int trackIndex, int slotIndex);

    /** Bounds check helper. */
    bool isValidSlot(int trackIndex, int slotIndex) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TriggerEngine)
};
