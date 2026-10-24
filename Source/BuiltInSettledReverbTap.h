#pragma once
#include <JuceHeader.h>

// Opt-in removal of a static fractional-delay loss. The original interpolated
// sample remains the moving branch; an integer anchor is changed only while
// its blend is zero. Switching modes or moving a delay fades that fixed anchor
// out, rather than rounding a moving read head into one-sample jumps.
// See Smith, Physical Audio Signal Processing, Delay-Line Interpolation.
class BuiltInSettledReverbTap
{
public:
    void prepare(double rate) noexcept
    {
        blend.reset(rate, .02);
        reset();
    }

    void reset() noexcept
    {
        blend.setCurrentAndTargetValue(0);
        anchor = 1;
        initialized = false;
        originalBypass = true;
    }

    // Callers can skip both the full controller and stationary-tap eligibility
    // work on the Original hot path. Observing Original still records history,
    // so a later live Refined enable must fade instead of taking a fresh jump.
    bool needsProcessing(bool refined) noexcept
    {
        if (refined || !originalBypass)
            return true;
        initialized = true;
        return false;
    }

    template <typename ReadInteger>
    float process(float original, float delay, bool refined, bool stationary, ReadInteger&& readInteger) noexcept
    {
        if (!needsProcessing(refined))
            return original;
        if (! initialized)
        {
            anchor = rounded(delay);
            blend.setCurrentAndTargetValue(refined && stationary ? 1.0f : 0.0f);
            initialized = true;
        }
        else if (refined && stationary)
        {
            const float requested = rounded(delay);
            if (requested != anchor)
            {
                blend.setTargetValue(0);
                if (blend.getCurrentValue() == 0)
                {
                    anchor = requested;
                    blend.setTargetValue(1);
                }
            }
            else
                blend.setTargetValue(1);
        }
        else
            blend.setTargetValue(0);

        const double preciseAmount = blend.getNextValue();
        originalBypass = preciseAmount == 0;
        const float amount = static_cast<float>(preciseAmount);
        if (amount == 0)
            return original; // Original is an exact floating-point bypass.
        const float integer = readInteger(anchor);
        if (amount == 1)
            return integer;
        return original + amount * (integer - original);
    }

    float integerBlend() const noexcept { return static_cast<float>(blend.getCurrentValue()); }
    float integerAnchor() const noexcept { return anchor; }

private:
    static float rounded(float delay) noexcept { return std::round(juce::jmax(1.0f, delay)); }
    // A double accumulator keeps long high-rate fades from accumulating float
    // rounding and producing an oversized final step when the target is set.
    juce::SmoothedValue<double> blend;
    float anchor = 1;
    bool initialized = false;
    bool originalBypass = true;
};
