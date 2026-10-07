#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <cstdint>
#include <cmath>
#include <limits>
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
    bool hasPlaybackData() const { return hasPreview() || hasWrittenValue() || getNumPoints() > 0; }
    bool hasWrittenValue() const { return std::isfinite(writtenValue.load(std::memory_order_acquire)); }
    void setWrittenValue(float value, double start = 0.0) { if (std::isfinite(value) && std::isfinite(start)) { writtenStart.store(start,std::memory_order_relaxed); writtenValue.store(value, std::memory_order_release); } }
    void clearWrittenValue() { writtenValue.store(std::numeric_limits<float>::quiet_NaN(), std::memory_order_release); }
    bool hasPreview() const { return std::isfinite(previewValue.load(std::memory_order_acquire)); }
    void setPreviewValue(float value) { if (std::isfinite(value)) previewValue.store(value, std::memory_order_release); }
    void clearPreview() { previewValue.store(std::numeric_limits<float>::quiet_NaN(), std::memory_order_release); }
    bool hasPointValueAtOrAbove(float threshold) const;

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

    // Synchronous processing-thread visitor, using a single immutable snapshot.
    // Linear SDK queues need only segment boundaries; event-value protocols need
    // every changed sample. The sink is bounded and may reject excess events.
    int deliverSampleAccuratePoints(double start, double rate, int samples, bool linearQueue,
                                   void* context, bool (*sink)(void*, int, float)) const noexcept;

    bool shouldPlayback() const;
    bool shouldPlaybackForRead() const;
    bool shouldRecord() const;

private:
    using PointList = std::vector<AutomationPoint>;

    // MSVC's atomic shared_ptr free functions use a process-wide internal
    // lock. Keep ownership on the control side and publish a raw immutable
    // pointer to the callback under a reader epoch instead.
    std::shared_ptr<const PointList> pointsSnapshot;
    std::atomic<const PointList*> pointsSnapshotForAudio { nullptr };
    mutable std::atomic<std::uint32_t> pointSnapshotAudioReaders { 0 };
    std::vector<std::shared_ptr<const PointList>> retiredPointSnapshots;
    mutable juce::CriticalSection writerLock;
    std::atomic<int> pointCount { 0 };

    std::atomic<AutomationMode> mode { AutomationMode::Off };
    std::atomic<float> defaultValue { 0.0f };
    std::atomic<float> previewValue { std::numeric_limits<float>::quiet_NaN() };
    std::atomic<float> writtenValue { std::numeric_limits<float>::quiet_NaN() };
    std::atomic<double> writtenStart { 0.0 };
    std::atomic<bool> isTouching { false };
    std::atomic<bool> latchActive { false };
    std::atomic<AutomationInterpolation> interpolation { AutomationInterpolation::Linear };

    static int findPointBefore(const PointList& points, double timeSeconds);
    void publishPoints(std::shared_ptr<const PointList> newSnapshot);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AutomationList)
};
