#pragma once

#include <JuceHeader.h>
#include <vector>
#include <atomic>

// Automation interpolation mode
enum class AutomationInterpolation
{
    Discrete,   // Step — hold value until next point
    Linear,     // Linear interpolation between points
    Exponential // Exponential curve (useful for volume)
};

// Automation playback/record mode
enum class AutomationMode
{
    Off,    // No automation (use manual fader value)
    Read,   // Play back recorded automation
    Write,  // Overwrite all automation while transport rolls
    Touch,  // Record only while touching a control
    Latch   // Record on touch, continue writing last value after release
};

// A single automation point (time + value)
struct AutomationPoint
{
    double timeSamples;  // Position in samples (absolute timeline position)
    float value;         // Normalised 0.0–1.0 for most params, or raw dB for volume
};

// Thread-safe automation data for a single parameter.
// Message thread writes the point list; audio thread evaluates via eval().
// Uses ScopedTryLock pattern matching the rest of the codebase (REAPER-style).
class AutomationList
{
public:
    AutomationList();
    ~AutomationList() = default;

    // --- Message-thread API (write side) ---

    // Replace all points (bulk set from frontend JSON).
    // Acquires lock — audio thread will output silence during very brief window.
    void setPoints(std::vector<AutomationPoint> newPoints);

    // Add a single point (for recording). Keeps list sorted.
    void addPoint(double timeSamples, float value);

    // Remove points in a time range (for automation trim / delete)
    void removePointsInRange(double startSample, double endSample);

    // Clear all points
    void clear();

    // Get current point count
    int getNumPoints() const;

    // Set the default value (used when no points exist or mode is Off)
    void setDefaultValue(float val) { defaultValue.store(val, std::memory_order_relaxed); }
    float getDefaultValue() const { return defaultValue.load(std::memory_order_relaxed); }

    // Mode
    void setMode(AutomationMode newMode) { mode.store(newMode, std::memory_order_relaxed); }
    AutomationMode getMode() const { return mode.load(std::memory_order_relaxed); }

    // Interpolation style
    void setInterpolation(AutomationInterpolation interp) { interpolation = interp; }
    AutomationInterpolation getInterpolation() const { return interpolation; }

    // Touch state (set from message thread when user grabs/releases a fader)
    void beginTouch() { isTouching.store(true, std::memory_order_relaxed); }
    void endTouch() { isTouching.store(false, std::memory_order_relaxed); }
    bool touching() const { return isTouching.load(std::memory_order_relaxed); }

    // --- Audio-thread API (read side) ---

    // Evaluate automation value at a single sample position.
    // Returns the interpolated value, or defaultValue if no points / mode is Off.
    // Uses ScopedTryLock — returns defaultValue if lock is held (message thread writing).
    float eval(double timeSamples) const;

    // Batch evaluate: fill outputBuffer with per-sample values for a block.
    // startSample = timeline position of first sample in block.
    // Much more efficient than calling eval() per sample — uses cached search position.
    void evalBlock(double startSample, double sampleRate, int numSamples, float* outputBuffer) const;

    // Should the audio thread apply automation right now?
    // Read mode: always. Touch: only when NOT touching. Latch: when NOT touching.
    // Write mode: never (audio thread doesn't apply — it's being overwritten).
    bool shouldPlayback() const;

    // Should the message thread record automation right now?
    // Write: always during playback. Touch: only while touching. Latch: while touching + after.
    bool shouldRecord() const;

private:
    // Points — sorted by timeSamples, protected by lock
    std::vector<AutomationPoint> points;
    mutable juce::CriticalSection lock;

    // Atomic state (read from audio thread without lock)
    std::atomic<AutomationMode> mode { AutomationMode::Off };
    std::atomic<float> defaultValue { 0.0f };
    std::atomic<bool> isTouching { false };

    AutomationInterpolation interpolation { AutomationInterpolation::Linear };

    // Binary search helper — find index of last point at or before timeSamples
    int findPointBefore(double timeSamples) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AutomationList)
};
