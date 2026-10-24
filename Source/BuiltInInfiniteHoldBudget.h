#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

// A continuing-input lossless reservoir cannot accumulate unbounded energy.
// Limit the *linked writes*, before they enter its history, using a smooth knee.
// Below the knee this is an exact bypass. New input remains part of every
// write; this never turns Infinite into input-rejecting Freeze. No state or
// parameter is persisted, and finite/Freeze paths do not call the governor.
class BuiltInInfiniteHoldBudget
{
public:
    void reset() noexcept
    {
        interventions = 0;
        maximumStored = 0;
    }

    template <std::size_t count>
    void process(std::array<float, count>& samples, float limit) noexcept
    {
        float peak = 0;
        for (const float sample : samples)
            peak = std::max(peak, std::abs(sample));

        const float knee = limit * .75f;
        if (peak > knee)
        {
            const float excess = peak - knee, span = limit - knee;
            const float mapped = knee + span * (excess / (span + excess));
            const float gain = mapped / peak;
            for (auto& sample : samples)
                sample *= gain;

            ++interventions;
            peak = mapped;
        }
        maximumStored = std::max(maximumStored, peak);
    }

    std::uint64_t interventionCount() const noexcept { return interventions; }
    float storedPeak() const noexcept { return maximumStored; }

private:
    std::uint64_t interventions = 0;
    float maximumStored = 0;
};
