#pragma once

#include <vector>

/**
 * RubberBandShifter — Offline pitch shifting wrapper around Rubber Band Library.
 *
 * Supports multi-channel audio and per-block varying pitch ratios.
 * Uses R3 engine with high quality pitch mode and formant preservation.
 *
 * Usage:
 *   1. Construct with sample rate, channels, and total sample count
 *   2. Call process() with interleaved per-sample pitch ratios
 *   3. Output is same length as input, all channels
 */
class RubberBandShifter
{
public:
    RubberBandShifter() = default;

    /**
     * Process audio with per-sample pitch ratios (offline, study + process).
     *
     * @param input         Per-channel input buffers [numChannels][numSamples]
     * @param numChannels   Number of audio channels
     * @param numSamples    Number of samples per channel
     * @param sampleRate    Sample rate in Hz
     * @param ratios        Per-sample pitch ratios (length = numSamples). 1.0 = no change.
     * @param blockSize     Processing block size for ratio granularity (default 256)
     * @param preserveFormants  Enable formant preservation (default true)
     * @return              Per-channel output buffers [numChannels][numSamples]
     */
    std::vector<std::vector<float>> process(
        const float* const* input,
        int numChannels,
        int numSamples,
        double sampleRate,
        const std::vector<float>& ratios,
        int blockSize = 256,
        bool preserveFormants = true);
};
