#pragma once

#include <algorithm>
#include <vector>

namespace OfflinePluginTransport
{
struct TempoPoint { double timeSeconds; double bpm; double ppqFromFirstMarker = 0.0; };
struct TempoPosition { double bpm; double ppq; };

template <typename Points>
TempoPosition positionAt(double time, double fallbackBpm, const Points& markers) noexcept
{
    const auto after = std::upper_bound(markers.begin(), markers.end(), time,
        [](double seconds, const auto& marker) { return seconds < marker.timeSeconds; });
    if (after == markers.begin()) return { fallbackBpm, time * fallbackBpm / 60.0 };
    const auto& marker = *(after - 1);
    const double firstBoundary = std::max(0.0, markers.front().timeSeconds);
    const double boundary = std::max(0.0, marker.timeSeconds);
    return { marker.bpm, firstBoundary * fallbackBpm / 60.0 + marker.ppqFromFirstMarker
        + (time - boundary) * marker.bpm / 60.0 };
}

// Each offline processing thread owns its clock. Export must not seek the live
// transport or expose its stopped device clock to tempo-synchronised plugins.
class Scope;
inline thread_local const Scope* active = nullptr;

class Scope
{
public:
    Scope(const void* engine, double time, double rate, double fallbackBpm,
          const std::vector<TempoPoint>& markers) noexcept
        : owner(engine), seconds(time), sampleRate(rate), bpm(fallbackBpm), previous(active)
    {
        const auto position = positionAt(time, fallbackBpm, markers);
        bpm = position.bpm;
        ppq = position.ppq;
        active = this;
    }
    ~Scope() { active = previous; }
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;

    const void* owner;
    double seconds, sampleRate, bpm, ppq = 0.0;
private:
    const Scope* previous;
};

inline const Scope* forEngine(const void* engine) noexcept
{
    return active && active->owner == engine ? active : nullptr;
}
}
