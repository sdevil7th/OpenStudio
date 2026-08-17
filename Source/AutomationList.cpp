#include "AutomationList.h"
#include <algorithm>
#include <cmath>

namespace
{
class ScopedAutomationPointReader final
{
public:
    explicit ScopedAutomationPointReader(
        std::atomic<std::uint32_t>& readersToUse) noexcept
        : readers(readersToUse)
    {
        readers.fetch_add(1, std::memory_order_seq_cst);
    }

    ~ScopedAutomationPointReader()
    {
        readers.fetch_sub(1, std::memory_order_seq_cst);
    }

    ScopedAutomationPointReader(
        const ScopedAutomationPointReader&) = delete;
    ScopedAutomationPointReader& operator=(
        const ScopedAutomationPointReader&) = delete;

private:
    std::atomic<std::uint32_t>& readers;
};
}

AutomationList::AutomationList()
    : pointsSnapshot(std::make_shared<const PointList>())
{
    pointsSnapshotForAudio.store(
        pointsSnapshot.get(), std::memory_order_seq_cst);
    retiredPointSnapshots.reserve(8);
}

void AutomationList::publishPoints(std::shared_ptr<const PointList> newSnapshot)
{
    if (newSnapshot == nullptr)
        newSnapshot = std::make_shared<const PointList>();

    if (pointsSnapshot != nullptr)
        retiredPointSnapshots.push_back(
            std::move(pointsSnapshot));

    pointsSnapshot = std::move(newSnapshot);
    pointsSnapshotForAudio.store(
        pointsSnapshot.get(), std::memory_order_seq_cst);
    pointCount.store(
        static_cast<int>(pointsSnapshot->size()),
        std::memory_order_release);

    // With seq_cst reader entry/publication, a zero count proves no callback
    // can still be holding an owner retired before this observation. Destruct
    // immutable vectors only on this control-side writer path.
    if (pointSnapshotAudioReaders.load(
            std::memory_order_seq_cst) == 0)
    {
        retiredPointSnapshots.clear();
    }
}

void AutomationList::setPoints(std::vector<AutomationPoint> newPoints)
{
    std::sort(newPoints.begin(), newPoints.end(),
              [] (const AutomationPoint& a, const AutomationPoint& b)
              {
                  return a.timeSeconds < b.timeSeconds;
              });

    const juce::ScopedLock sl(writerLock);
    publishPoints(std::make_shared<const PointList>(std::move(newPoints)));
}

void AutomationList::replacePointsInRange(double startTimeSeconds, double endTimeSeconds,
                                          std::vector<AutomationPoint> replacementPoints)
{
    if (endTimeSeconds < startTimeSeconds)
        std::swap(startTimeSeconds, endTimeSeconds);

    const juce::ScopedLock sl(writerLock);

    const auto current = pointsSnapshot;
    auto next = std::make_shared<PointList>();
    if (current)
    {
        next->reserve(current->size() + replacementPoints.size());
        for (const auto& point : *current)
            if (point.timeSeconds < startTimeSeconds || point.timeSeconds > endTimeSeconds)
                next->push_back(point);
    }

    for (const auto& point : replacementPoints)
        next->push_back(point);

    std::sort(next->begin(), next->end(),
              [] (const AutomationPoint& a, const AutomationPoint& b)
              {
                  return a.timeSeconds < b.timeSeconds;
              });
    publishPoints(std::static_pointer_cast<const PointList>(next));
}

void AutomationList::addPoint(double timeSeconds, float value)
{
    const juce::ScopedLock sl(writerLock);

    const auto current = pointsSnapshot;
    auto next = std::make_shared<PointList>(current ? *current : PointList());
    AutomationPoint point { timeSeconds, value };
    auto insertPos = std::lower_bound(next->begin(), next->end(), point,
                                      [] (const AutomationPoint& a, const AutomationPoint& b)
                                      {
                                          return a.timeSeconds < b.timeSeconds;
                                      });
    next->insert(insertPos, point);
    publishPoints(std::static_pointer_cast<const PointList>(next));
}

void AutomationList::removePointsInRange(double startTimeSeconds, double endTimeSeconds)
{
    const juce::ScopedLock sl(writerLock);

    const auto current = pointsSnapshot;
    auto next = std::make_shared<PointList>(current ? *current : PointList());
    next->erase(std::remove_if(next->begin(), next->end(),
                               [startTimeSeconds, endTimeSeconds] (const AutomationPoint& point)
                               {
                                   return point.timeSeconds >= startTimeSeconds
                                       && point.timeSeconds <= endTimeSeconds;
                               }),
                next->end());
    publishPoints(std::static_pointer_cast<const PointList>(next));
}

void AutomationList::clear()
{
    const juce::ScopedLock sl(writerLock);
    publishPoints(std::make_shared<const PointList>());
}

bool AutomationList::hasPointValueAtOrAbove(float threshold) const
{
    const ScopedAutomationPointReader readerGuard(
        pointSnapshotAudioReaders);
    const auto* const snapshot =
        pointsSnapshotForAudio.load(
            std::memory_order_seq_cst);
    if (snapshot == nullptr)
        return false;

    for (const auto& point : *snapshot)
    {
        // Invalid automation cannot prove that a discrete control stays off,
        // so keep tail planning conservative for that lane.
        if (! std::isfinite(point.value) || point.value >= threshold)
            return true;
    }

    return false;
}

void AutomationList::setMode(AutomationMode newMode)
{
    mode.store(newMode, std::memory_order_release);
    if (newMode != AutomationMode::Touch && newMode != AutomationMode::Latch)
        resetTouchAndLatch();
    else if (newMode == AutomationMode::Touch)
        latchActive.store(false, std::memory_order_release);
}

void AutomationList::beginTouch()
{
    isTouching.store(true, std::memory_order_release);
    if (mode.load(std::memory_order_acquire) == AutomationMode::Latch)
        latchActive.store(true, std::memory_order_release);
}

void AutomationList::endTouch()
{
    isTouching.store(false, std::memory_order_release);
}

void AutomationList::resetTouchAndLatch()
{
    isTouching.store(false, std::memory_order_release);
    latchActive.store(false, std::memory_order_release);
}

bool AutomationList::shouldPlayback() const
{
    switch (mode.load(std::memory_order_acquire))
    {
        case AutomationMode::Read:
            return true;
        case AutomationMode::Touch:
            return !isTouching.load(std::memory_order_acquire);
        case AutomationMode::Latch:
            return !latchActive.load(std::memory_order_acquire);
        case AutomationMode::Write:
        case AutomationMode::Off:
        default:
            return false;
    }
}

bool AutomationList::shouldPlaybackForRead() const
{
    return mode.load(std::memory_order_acquire) != AutomationMode::Off;
}

bool AutomationList::shouldRecord() const
{
    switch (mode.load(std::memory_order_acquire))
    {
        case AutomationMode::Write:
            return true;
        case AutomationMode::Touch:
            return isTouching.load(std::memory_order_acquire);
        case AutomationMode::Latch:
            return latchActive.load(std::memory_order_acquire);
        case AutomationMode::Read:
        case AutomationMode::Off:
        default:
            return false;
    }
}

int AutomationList::findPointBefore(const PointList& points, double timeSeconds)
{
    if (points.empty())
        return -1;

    int lo = 0;
    int hi = static_cast<int>(points.size()) - 1;
    int result = -1;

    while (lo <= hi)
    {
        const int mid = lo + (hi - lo) / 2;
        if (points[static_cast<size_t>(mid)].timeSeconds <= timeSeconds)
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

float AutomationList::eval(double timeSeconds) const
{
    const ScopedAutomationPointReader readerGuard(
        pointSnapshotAudioReaders);
    const auto* const snapshot =
        pointsSnapshotForAudio.load(
            std::memory_order_seq_cst);
    if (snapshot == nullptr || snapshot->empty())
        return defaultValue.load(std::memory_order_relaxed);

    const auto& points = *snapshot;
    const int idx = findPointBefore(points, timeSeconds);
    if (idx < 0)
        return points.front().value;

    const auto size = static_cast<int>(points.size());
    if (idx >= size - 1)
        return points.back().value;

    const auto& p0 = points[static_cast<size_t>(idx)];
    const auto& p1 = points[static_cast<size_t>(idx + 1)];
    const auto interp = interpolation.load(std::memory_order_acquire);

    if (interp == AutomationInterpolation::Discrete)
        return p0.value;

    const double dt = p1.timeSeconds - p0.timeSeconds;
    if (dt <= 0.0)
        return p0.value;

    double fraction = (timeSeconds - p0.timeSeconds) / dt;
    if (interp == AutomationInterpolation::Exponential)
        fraction *= fraction;

    return static_cast<float>(p0.value + (p1.value - p0.value) * fraction);
}

void AutomationList::evalBlock(double startTimeSeconds, double sampleRate, int numSamples, float* outputBuffer) const
{
    if (outputBuffer == nullptr || numSamples <= 0)
        return;

    const ScopedAutomationPointReader readerGuard(
        pointSnapshotAudioReaders);
    const auto* const snapshot =
        pointsSnapshotForAudio.load(
            std::memory_order_seq_cst);
    if (snapshot == nullptr
        || snapshot->empty()
        || sampleRate <= 0.0)
    {
        const float def = defaultValue.load(std::memory_order_relaxed);
        for (int i = 0; i < numSamples; ++i)
            outputBuffer[i] = def;
        return;
    }

    const auto& points = *snapshot;
    const auto size = static_cast<int>(points.size());
    const auto interp = interpolation.load(std::memory_order_acquire);
    int idx = findPointBefore(points, startTimeSeconds);

    for (int i = 0; i < numSamples; ++i)
    {
        const double timeSeconds = startTimeSeconds + static_cast<double>(i) / sampleRate;
        while (idx < size - 1 && points[static_cast<size_t>(idx + 1)].timeSeconds <= timeSeconds)
            ++idx;

        if (idx < 0)
        {
            outputBuffer[i] = points.front().value;
        }
        else if (idx >= size - 1)
        {
            const float value = points.back().value;
            for (int j = i; j < numSamples; ++j)
                outputBuffer[j] = value;
            break;
        }
        else
        {
            const auto& p0 = points[static_cast<size_t>(idx)];
            const auto& p1 = points[static_cast<size_t>(idx + 1)];

            if (interp == AutomationInterpolation::Discrete)
            {
                outputBuffer[i] = p0.value;
                continue;
            }

            const double dt = p1.timeSeconds - p0.timeSeconds;
            if (dt <= 0.0)
            {
                outputBuffer[i] = p0.value;
                continue;
            }

            double fraction = (timeSeconds - p0.timeSeconds) / dt;
            if (interp == AutomationInterpolation::Exponential)
                fraction *= fraction;
            outputBuffer[i] = static_cast<float>(p0.value + (p1.value - p0.value) * fraction);
        }
    }
}
