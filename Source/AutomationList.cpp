#include "AutomationList.h"
#include <algorithm>

AutomationList::AutomationList() = default;

// ============================================================================
// Message-thread write API
// ============================================================================

void AutomationList::setPoints(std::vector<AutomationPoint> newPoints)
{
    // Sort by time before storing
    std::sort(newPoints.begin(), newPoints.end(),
              [](const AutomationPoint& a, const AutomationPoint& b) {
                  return a.timeSamples < b.timeSamples;
              });

    const juce::ScopedLock sl(lock);
    points = std::move(newPoints);
}

void AutomationList::addPoint(double timeSamples, float value)
{
    const juce::ScopedLock sl(lock);

    AutomationPoint pt { timeSamples, value };

    // Insert in sorted order
    auto it = std::lower_bound(points.begin(), points.end(), pt,
                                [](const AutomationPoint& a, const AutomationPoint& b) {
                                    return a.timeSamples < b.timeSamples;
                                });
    points.insert(it, pt);
}

void AutomationList::removePointsInRange(double startSample, double endSample)
{
    const juce::ScopedLock sl(lock);
    points.erase(
        std::remove_if(points.begin(), points.end(),
                       [startSample, endSample](const AutomationPoint& p) {
                           return p.timeSamples >= startSample && p.timeSamples <= endSample;
                       }),
        points.end());
}

void AutomationList::clear()
{
    const juce::ScopedLock sl(lock);
    points.clear();
}

int AutomationList::getNumPoints() const
{
    const juce::ScopedLock sl(lock);
    return static_cast<int>(points.size());
}

// ============================================================================
// Audio-thread read API
// ============================================================================

bool AutomationList::shouldPlayback() const
{
    auto m = mode.load(std::memory_order_relaxed);
    switch (m)
    {
        case AutomationMode::Read:
            return true;
        case AutomationMode::Touch:
        case AutomationMode::Latch:
            return !isTouching.load(std::memory_order_relaxed);
        case AutomationMode::Write:
        case AutomationMode::Off:
        default:
            return false;
    }
}

bool AutomationList::shouldRecord() const
{
    auto m = mode.load(std::memory_order_relaxed);
    switch (m)
    {
        case AutomationMode::Write:
            return true;
        case AutomationMode::Touch:
            return isTouching.load(std::memory_order_relaxed);
        case AutomationMode::Latch:
            return true;  // Latch always records once activated
        case AutomationMode::Read:
        case AutomationMode::Off:
        default:
            return false;
    }
}

int AutomationList::findPointBefore(double timeSamples) const
{
    // Binary search: find last point at or before timeSamples
    // points must be sorted by timeSamples (guaranteed by setPoints/addPoint)
    if (points.empty())
        return -1;

    int lo = 0;
    int hi = static_cast<int>(points.size()) - 1;
    int result = -1;

    while (lo <= hi)
    {
        int mid = lo + (hi - lo) / 2;
        if (points[static_cast<size_t>(mid)].timeSamples <= timeSamples)
        {
            result = mid;
            lo = mid + 1;
        }
        else
        {
            hi = mid - 1;
        }
    }

    return result;
}

float AutomationList::eval(double timeSamples) const
{
    const juce::ScopedTryLock sl(lock);
    if (!sl.isLocked() || points.empty())
        return defaultValue.load(std::memory_order_relaxed);

    int idx = findPointBefore(timeSamples);

    // Before first point — hold first point's value
    if (idx < 0)
        return points.front().value;

    auto sz = static_cast<int>(points.size());

    // At or after last point — hold last point's value
    if (idx >= sz - 1)
        return points.back().value;

    // Between two points — interpolate
    const auto& p0 = points[static_cast<size_t>(idx)];
    const auto& p1 = points[static_cast<size_t>(idx + 1)];

    if (interpolation == AutomationInterpolation::Discrete)
        return p0.value;

    double dt = p1.timeSamples - p0.timeSamples;
    if (dt <= 0.0)
        return p0.value;

    double t = (timeSamples - p0.timeSamples) / dt;  // 0.0 to 1.0

    if (interpolation == AutomationInterpolation::Exponential)
    {
        // Quadratic ease for smoother volume curves
        t = t * t;
    }

    return static_cast<float>(p0.value + (p1.value - p0.value) * t);
}

void AutomationList::evalBlock(double startSample, double sampleRate, int numSamples, float* outputBuffer) const
{
    juce::ignoreUnused(sampleRate);

    const juce::ScopedTryLock sl(lock);
    if (!sl.isLocked() || points.empty())
    {
        float def = defaultValue.load(std::memory_order_relaxed);
        for (int i = 0; i < numSamples; ++i)
            outputBuffer[i] = def;
        return;
    }

    auto sz = static_cast<int>(points.size());

    // Start search from the point before the block start
    int idx = findPointBefore(startSample);

    for (int i = 0; i < numSamples; ++i)
    {
        double t = startSample + static_cast<double>(i);

        // Advance idx to the correct segment for this sample
        while (idx < sz - 1 && points[static_cast<size_t>(idx + 1)].timeSamples <= t)
            ++idx;

        if (idx < 0)
        {
            // Before first point
            outputBuffer[i] = points.front().value;
        }
        else if (idx >= sz - 1)
        {
            // At/after last point — fill rest of buffer and break
            float val = points.back().value;
            for (int j = i; j < numSamples; ++j)
                outputBuffer[j] = val;
            break;
        }
        else
        {
            const auto& p0 = points[static_cast<size_t>(idx)];
            const auto& p1 = points[static_cast<size_t>(idx + 1)];

            if (interpolation == AutomationInterpolation::Discrete)
            {
                outputBuffer[i] = p0.value;
            }
            else
            {
                double dt = p1.timeSamples - p0.timeSamples;
                if (dt <= 0.0)
                {
                    outputBuffer[i] = p0.value;
                }
                else
                {
                    double frac = (t - p0.timeSamples) / dt;
                    if (interpolation == AutomationInterpolation::Exponential)
                        frac = frac * frac;
                    outputBuffer[i] = static_cast<float>(p0.value + (p1.value - p0.value) * frac);
                }
            }
        }
    }
}
