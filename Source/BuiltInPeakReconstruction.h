#pragma once
#include <array>
#include <cmath>
#include <algorithm>

// Streaming, unity-DC, 8-phase windowed-sinc peak detector. The 48-tap
// reconstruction is delayed by 24 input samples. It allocates nothing while
// processing. This is not a loudness meter or a BS.1770 conformance claim.
class BuiltInPeakReconstruction
{
public:
    static constexpr int taps = 48;
    BuiltInPeakReconstruction()
    {
        constexpr double pi = 3.14159265358979323846;
        for (int phase = 0; phase < 8; ++phase)
        {
            double sum = 0;
            for (int k = 0; k < taps; ++k)
            {
                const double x = k - 24.0 + phase / 8.0;
                const double window = 0.42 + 0.5 * std::cos(pi * x / 24.0)
                    + 0.08 * std::cos(2.0 * pi * x / 24.0);
                const double coefficient = std::abs(x) < 1.0e-12 ? 1.0 : std::sin(pi * x) / (pi * x) * window;
                coefficients[static_cast<size_t>(phase)][static_cast<size_t>(k)] = static_cast<float>(coefficient);
                sum += coefficient;
            }
            for (auto& coefficient : coefficients[static_cast<size_t>(phase)]) coefficient /= static_cast<float>(sum);
        }
    }
    void reset() { for (auto& channel : history) channel.fill(0); position = 0; }
    float push(float left, float right)
    {
        const auto peaks=pushChannels(left,right);return std::max(peaks[0],peaks[1]);
    }
    std::array<float,2> pushChannels(float left,float right)
    {
        history[0][static_cast<size_t>(position)] = left;
        history[1][static_cast<size_t>(position)] = right;
        std::array<float,2> peaks {std::abs(left),std::abs(right)};
        for (size_t ch=0;ch<history.size();++ch)
            for (const auto& phase : coefficients)
            {
                float value = 0;
                for (int k = 0; k < taps; ++k)
                    value += history[ch][static_cast<size_t>((position - k + taps) % taps)] * phase[static_cast<size_t>(k)];
                peaks[ch] = std::max(peaks[ch], std::abs(value));
            }
        position = (position + 1) % taps;
        return peaks;
    }
private:
    std::array<std::array<float, taps>, 8> coefficients {};
    std::array<std::array<float, taps>, 2> history {};
    int position = 0;
};
