#pragma once

#include <JuceHeader.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace PackedWaveformPeaks
{
inline constexpr int maximumChannels = 64;
inline constexpr int maximumPeaks = 32768;

// Display data only. This preserves every stored Float32 bit without asking
// JUCE's message-thread JSON writer to decimal-format each individual peak.
// The byte order is explicit even on a big-endian native host.
inline juce::var encode(const juce::var& flat)
{
    auto* result = new juce::DynamicObject();
    juce::var payload(result);
    result->setProperty("format", "openstudio.waveform.f32");
    result->setProperty("version", 1);
    result->setProperty("byteOrder", "little");
    const auto fail = [&payload, result](const char* message)
    {
        result->setProperty("error", message);
        return payload;
    };
    const auto* values = flat.getArray();
    if (values == nullptr)
        return fail("Waveform data is not an array.");
    if (values->isEmpty())
    {
        result->setProperty("channels", 0);
        result->setProperty("peakCount", 0);
        result->setProperty("byteLength", 0);
        result->setProperty("data", "");
        return payload;
    }
    const auto& channelEntry = (*values)[0];
    const double channelValue = static_cast<double>(channelEntry);
    if ((! channelEntry.isInt() && ! channelEntry.isInt64() && ! channelEntry.isDouble())
        || ! std::isfinite(channelValue) || channelValue < 1.0
        || channelValue > maximumChannels || std::floor(channelValue) != channelValue)
        return fail("Invalid waveform channel count.");
    const auto channels = static_cast<int>(channelValue);
    const auto valueCount = values->size() - 1;
    if (valueCount % (channels * 2) != 0 || valueCount / (channels * 2) > maximumPeaks)
        return fail("Invalid waveform peak count.");
    juce::MemoryBlock bytes(static_cast<size_t>(valueCount) * sizeof(float));
    auto* destination = static_cast<std::uint8_t*>(bytes.getData());
    static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559,
                  "Packed waveform transport requires IEEE-754 Float32.");
    for (int index = 0; index < valueCount; ++index)
    {
        const auto& value = (*values)[index + 1];
        if ((! value.isDouble() && ! value.isInt() && ! value.isInt64())
            || ! std::isfinite(static_cast<double>(value)))
            return fail("Non-finite waveform peak.");
        const auto sample = static_cast<float>(static_cast<double>(value));
        if (! std::isfinite(sample))
            return fail("Waveform peak exceeds Float32 range.");
        std::uint32_t bits = 0;
        std::memcpy(&bits, &sample, sizeof(bits));
        for (int byte = 0; byte < 4; ++byte)
            destination[static_cast<size_t>(index) * 4 + static_cast<size_t>(byte)] =
                static_cast<std::uint8_t>(bits >> (byte * 8));
    }
    result->setProperty("channels", channels);
    result->setProperty("peakCount", valueCount / (channels * 2));
    result->setProperty("byteLength", static_cast<int>(bytes.getSize()));
    result->setProperty("data", juce::Base64::toBase64(bytes.getData(), bytes.getSize()));
    return payload;
}
}
