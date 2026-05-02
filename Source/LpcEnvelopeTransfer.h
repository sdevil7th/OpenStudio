#pragma once

#include <vector>

class LpcEnvelopeTransfer
{
public:
    struct Settings
    {
        int lpcOrder = 16;
        int fftOrder = 9; // 512 samples
        int hopSize = 256;
        float epsilonFloor = 1.0e-3f;
        float maxCorrectionGain = 2.2f;
    };

    static bool applyToBuffer (std::vector<std::vector<float>>& processed,
                               const float* const* original,
                               int numChannels,
                               int numSamples);

    static bool applyToBuffer (std::vector<std::vector<float>>& processed,
                               const float* const* original,
                               int numChannels,
                               int numSamples,
                               const Settings& settings);
};
