#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <memory>
#include <vector>

// Automation interpolation mode
enum class AutomationInterpolation
{
    Discrete,   // Step: hold value until next point
    Linear,     // Linear interpolation between points
    Exponential // Quadratic ease, useful for volume curves
};

// Automation playback/record mode
enum class AutomationMode
{
    Off,    // No automation; use the manual/static value
    Read,   // Play stored automation
    Write,  // Overwrite armed automation while transport rolls
    Touch,  // Write while touching, then return to reading
    Latch   // Start writing on touch, then keep writing until transport stop
};

struct AutomationPoint
{
    double timeSeconds = 0.0;
    float value = 0.0f;
};

// Thread-safe automation data for a single parameter.
// Message thread publishes immutable point snapshots; audio thread evaluates
// those snapshots without taking locks.
class AutomationList
{
public:
    AutomationList();
    ~AutomationList() = default;

    void setPoints(std::vector<AutomationPoint> newPoints);
    void replacePointsInRange(double startTimeSeconds, double endTimeSeconds,
                              std::vector<AutomationPoint> replacementPoints);
    void addPoint(double timeSeconds, float value);
    void removePointsInRange(double startTimeSeconds, double endTimeSeconds);
    void clear();

    int getNumPoints() const { return pointCount.load(std::memory_order_acquire); }

    void setDefaultValue(float val) { defaultValue.store(val, std::memory_order_relaxed); }
    float getDefaultValue() const { return defaultValue.load(std::memory_order_relaxed); }

    void setMode(AutomationMode newMode);
    AutomationMode getMode() const { return mode.load(std::memory_order_relaxed); }

    void setInterpolation(AutomationInterpolation interp) { interpolation.store(interp, std::memory_order_release); }
    AutomationInterpolation getInterpolation() const { return interpolation.load(std::memory_order_acquire); }

    void beginTouch();
    void endTouch();
    void resetTouchAndLatch();
    bool touching() const { return isTouching.load(std::memory_order_relaxed); }

    float eval(double timeSeconds) const;
    void evalBlock(double startTimeSeconds, double sampleRate, int numSamples, float* outputBuffer) const;

    bool shouldPlayback() const;
    bool shouldPlaybackForRead() const;
    bool shouldRecord() const;

private:
    using PointList = std::vector<AutomationPoint>;

    std::shared_ptr<const PointList> pointsSnapshot { std::make_shared<const PointList>() };
    mutable juce::CriticalSection writerLock;
    std::atomic<int> pointCount { 0 };

    std::atomic<AutomationMode> mode { AutomationMode::Off };
    std::atomic<float> defaultValue { 0.0f };
    std::atomic<bool> isTouching { false };
    std::atomic<bool> latchActive { false };
    std::atomic<AutomationInterpolation> interpolation { AutomationInterpolation::Linear };

    static int findPointBefore(const PointList& points, double timeSeconds);
    void publishPoints(std::shared_ptr<const PointList> newSnapshot);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AutomationList)
};
