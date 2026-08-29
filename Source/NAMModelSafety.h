#pragma once

#include <JuceHeader.h>

namespace OpenStudioNAMModelSafety
{
// Real-world NAM captures are generally far smaller than this. Keeping the
// supported ceiling at 64 MiB bounds the simultaneous UTF-8, parsed JSON, and
// dual-lane DSP construction footprint in the live process.
inline constexpr juce::int64 maximumFileBytes =
    static_cast<juce::int64>(64) * 1024 * 1024;
inline constexpr const char* maximumFileDescription = "64 MiB";
}
