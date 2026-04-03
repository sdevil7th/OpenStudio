#pragma once

#include <vector>

/**
 * SignalsmithShifter — wrapper around Signalsmith Stretch for offline pitch correction.
 *
 * Handles:
 *   - Multi-channel audio natively (stereo, mono — no mid-side hack needed)
 *   - Per-block varying pitch ratio (block size = intervalSamples, ~30ms at 44100Hz)
 *   - Per-block formant compensation (keeps formants at original position)
 *   - Latency compensation (output is exactly numSamples, time-aligned with input)
 *
 * Usage:
 *   auto output = SignalsmithShifter::process(input, 2, numSamples, 44100,
 *                                              ratios, formantRatios);
 */
class SignalsmithShifter
{
public:
    /**
     * Process audio with per-sample pitch ratios.
     *
     * @param input            Array of numChannels pointers, each numSamples floats
     * @param numChannels      Number of channels (1 = mono, 2 = stereo, etc.)
     * @param numSamples       Number of samples per channel
     * @param sampleRate       Sample rate in Hz
     * @param ratios           Per-sample pitch ratio (1.0 = no change, 1.122 = +2 semitones)
     * @param formantRatios    Per-sample formant ratio. Empty = preserve formants automatically.
     *                         1.0 = keep at original position, 1.5 = brighter, 0.7 = darker.
     * @param detectedPitchHz  Per-sample detected fundamental frequency in Hz.
     *                         Empty = let the library auto-detect (less accurate).
     *                         Providing this dramatically improves formant preservation
     *                         because it controls the spectral envelope smoothing width.
     * @return                 Vector of numChannels vectors, each exactly numSamples floats.
     */
    static std::vector<std::vector<float>> process (
        const float* const* input,
        int numChannels,
        int numSamples,
        double sampleRate,
        const std::vector<float>& ratios,
        const std::vector<float>& formantRatios = {},
        const std::vector<float>& detectedPitchHz = {});
};
