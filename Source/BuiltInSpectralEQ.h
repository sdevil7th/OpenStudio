#pragma once
#include <JuceHeader.h>
#include <array>
#include <complex>
#include <vector>

// Original per-frequency dynamic correction, after the ordinary EQ. All storage
// is prepared on the serialized configuration path. No FFT backend locks/scratch.
class BuiltInSpectralEQ final
{
public:
    static constexpr int bandCount = 24;
    struct Band
    {
        bool active = false, adaptive = false, automatic = false, tilt = true, free = false;
        bool wholeBand = false, gainQ = false;
        int shape = 0, target = 0, source = 0, slope = 1;
        float staticGain = 0;
        float frequency = 1000, q = 1, range = 0, threshold = -24;
        float attack = 10, release = 150, sensitivity = 0, density = .75f;
        float low = 20, high = 20000;
    };
    std::array<Band, bandCount> controls {};
    int listenBand = -1;
    std::array<std::atomic<float>, bandCount> gainDb {}, thresholdDb {};
    static int latency(int quality) noexcept { return 1024 << juce::jlimit(0, 2, quality); }

    void prepare(double sampleRate, int quality, int staticLatency)
    {
        rate = sampleRate; size = latency(quality); hop = size / 4; bins = size / 2 + 1;
        keyDelay = juce::jmax(0, staticLatency);
        for (auto& channel : history) channel.assign(static_cast<size_t>(size), 0);
        for (auto& channel : keyHistory) channel.assign(static_cast<size_t>(keyDelay + 1), 0);
        for (auto& channel : spectra) channel.resize(static_cast<size_t>(size));
        for (auto& channel : correction) channel.assign(static_cast<size_t>(size), 0);
        for (auto& channel : original) channel.resize(static_cast<size_t>(size));
        deque.resize(static_cast<size_t>(bins));
        twiddles.resize(static_cast<size_t>(size / 2)); reverse.resize(static_cast<size_t>(size));
        window.resize(static_cast<size_t>(size)); tiltDb.resize(static_cast<size_t>(bins));
        frequencyZ.resize(static_cast<size_t>(bins));
        detector.resize(static_cast<size_t>(bins)); spread.resize(static_cast<size_t>(bins));
        for (auto& state : states)
        {
            state.envelope.assign(static_cast<size_t>(bins), 0);
            state.average.assign(static_cast<size_t>(bins), 0);
            state.mask.assign(static_cast<size_t>(bins), 0);
            state.radius.assign(static_cast<size_t>(bins), 0);
            state.frequency = -1;
        }
        int bits = 0; for (int n = size; n > 1; n >>= 1) ++bits;
        for (int i = 0; i < size; ++i)
        {
            int reversed = 0, value = i;
            for (int b = 0; b < bits; ++b) { reversed = (reversed << 1) | (value & 1); value >>= 1; }
            reverse[static_cast<size_t>(i)] = reversed;
            window[static_cast<size_t>(i)] = std::sin(juce::MathConstants<float>::pi * static_cast<float>(i) / static_cast<float>(size));
        }
        for (int i = 0; i < size / 2; ++i)
            twiddles[static_cast<size_t>(i)] = std::polar(1.0f, -juce::MathConstants<float>::twoPi * static_cast<float>(i) / static_cast<float>(size));
        float sum = 0; for (float value : window) sum += value;
        amplitudeScale = 2 / sum;
        for (int i = 0; i < bins; ++i)
        {
            tiltDb[static_cast<size_t>(i)] = 3 * std::log2(juce::jmax(20.0f, static_cast<float>(rate * i / size)) / 1000);
            frequencyZ[static_cast<size_t>(i)] = std::polar(1.0, -juce::MathConstants<double>::twoPi * i / size);
        }
        power.reset(rate, .015); reset();
    }
    void release() noexcept { size = 0; }
    bool ready() const noexcept { return size > 0; }
    void reset(bool enabled = true) noexcept
    {
        position = keyPosition = samplesToFrame = 0;
        for (auto& channel : history) std::fill(channel.begin(), channel.end(), 0.0f);
        for (auto& channel : keyHistory) std::fill(channel.begin(), channel.end(), 0.0f);
        for (auto& channel : correction) std::fill(channel.begin(), channel.end(), 0.0f);
        for (auto& state : states)
        {
            std::fill(state.envelope.begin(), state.envelope.end(), 0.0f);
            std::fill(state.average.begin(), state.average.end(), 0.0f);
            state.wasActive = false;
            state.bandEnvelope = state.bandAverage = 0;
        }
        for (auto& gain : gainDb) gain.store(0);
        power.setCurrentAndTargetValue(enabled ? 1.0f : 0.0f);
    }
    void setPower(bool enabled) noexcept { power.setTargetValue(enabled ? 1.0f : 0.0f); }

    std::array<float, 2> process(float left, float right, const std::array<float, 4>& keys) noexcept
    {
        if (!ready()) return {left, right};
        const auto p = static_cast<size_t>(position);
        const float wet = power.getNextValue();
        std::array<float, 2> output {history[0][p] + correction[0][p] * wet, history[1][p] + correction[1][p] * wet};
        correction[0][p] = correction[1][p] = 0;
        history[0][p] = finite(left); history[1][p] = finite(right);
        for (size_t channel = 0; channel < keys.size(); ++channel)
        {
            keyHistory[channel][static_cast<size_t>(keyPosition)] = finite(keys[channel]);
            const int read = (keyPosition + 1) % (keyDelay + 1);
            history[channel + 2][p] = keyHistory[channel][static_cast<size_t>(read)];
        }
        keyPosition = (keyPosition + 1) % (keyDelay + 1);
        position = (position + 1) % size;
        if (++samplesToFrame == hop) { samplesToFrame = 0; processFrame(); }
        for (auto& sample : output) sample = finite(sample);
        return output;
    }

private:
    using Complex = std::complex<float>;
    struct State
    {
        std::vector<float> envelope, average, mask;
        std::vector<int> radius;
        float frequency = -1, q = -1, density = -1;
        int shape = -1;
        bool wasActive = false;
        bool wasWhole = false;
        float bandEnvelope = 0, bandAverage = 0;
    };
    std::array<State, bandCount> states;
    std::array<std::vector<float>, 6> history;
    std::array<std::vector<float>, 4> keyHistory;
    std::array<std::vector<float>, 2> correction;
    std::array<std::vector<Complex>, 6> spectra;
    std::array<std::vector<Complex>, 2> original;
    std::vector<Complex> twiddles;
    std::vector<std::complex<double>> frequencyZ;
    std::vector<int> deque;
    std::vector<int> reverse;
    std::vector<float> window, tiltDb, detector, spread;
    juce::SmoothedValue<float> power;
    int size = 0, hop = 0, bins = 0, position = 0, keyDelay = 0, keyPosition = 0, samplesToFrame = 0;
    double rate = 48000;
    float amplitudeScale = 1;
    static float finite(float value) noexcept { return std::isfinite(value) ? value : 0; }
    using Coefficients = std::array<float, 6>;
    static double magnitude(const Coefficients& c, std::complex<double> z) noexcept
    {
        return std::abs((static_cast<double>(c[0]) + static_cast<double>(c[1]) * z + static_cast<double>(c[2]) * z * z)
            / (static_cast<double>(c[3]) + static_cast<double>(c[4]) * z + static_cast<double>(c[5]) * z * z));
    }
    Coefficients responseCoefficients(const Band& band, float gain, int stages) const noexcept
    {
        using C = juce::dsp::IIR::ArrayCoefficients<float>;
        float q = band.q; gain = juce::jlimit(-30.0f, 30.0f, gain);
        if (band.shape == 0 && band.gainQ)
        {
            q = juce::jlimit(.1f, 30.0f, q * (1 + .02f * std::abs(gain)));
            gain = juce::jlimit(-30.0f, 30.0f, gain * (1 + .04f * juce::jmax(0.0f, std::log2(band.q))));
        }
        const float factor = juce::Decibels::decibelsToGain(gain / static_cast<float>(stages));
        if (band.shape == 0) return C::makePeakFilter(rate, band.frequency, q, factor);
        if (band.slope == 0) q = .5f;
        return band.shape == 1 ? C::makeLowShelf(rate, band.frequency, q, factor) : C::makeHighShelf(rate, band.frequency, q, factor);
    }
    double detectorMagnitude(const Band& band, int bin, const Coefficients& centre, const Coefficients& low, const Coefficients& high) const noexcept
    {
        const auto z = frequencyZ[static_cast<size_t>(bin)];
        return band.free ? magnitude(low, z) * magnitude(high, z) : magnitude(centre, z);
    }
    void applyGain(int bin, int target, float gain) noexcept
    {
        if (gain == 1) return;
        auto& l = spectra[0][static_cast<size_t>(bin)]; auto& r = spectra[1][static_cast<size_t>(bin)];
        if (target == 1) l *= gain;
        else if (target == 2) r *= gain;
        else if (target >= 3)
        {
            auto mid = (l + r) * .5f, side = (l - r) * .5f;
            if (target == 3) mid *= gain; else side *= gain;
            l = mid + side; r = mid - side;
        }
        else { l *= gain; r *= gain; }
    }
    void processWholeBand(size_t b, bool listen) noexcept
    {
        const auto& band = controls[b]; auto& state = states[b];
        using C = juce::dsp::IIR::ArrayCoefficients<float>;
        const auto centre = C::makeBandPass(rate, band.frequency, band.q);
        const auto low = C::makeHighPass(rate, juce::jlimit(10.0f, static_cast<float>(rate * .45), band.low));
        const auto high = C::makeLowPass(rate, juce::jlimit(20.0f, static_cast<float>(rate * .475), band.high));
        const size_t source = band.source == 2 ? 4 : 2;
        double energy = 0;
        for (int bin = 0; bin < bins; ++bin)
        {
            const auto k = static_cast<size_t>(bin); const auto l = spectra[source][k], r = spectra[source + 1][k];
            const double weight = detectorMagnitude(band, bin, centre, low, high);
            const double powerValue = band.target == 1 ? std::norm(l) : band.target == 2 ? std::norm(r)
                : band.target == 3 ? std::norm((l + r) * .5f) : band.target == 4 ? std::norm((l - r) * .5f)
                : .5 * (std::norm(l) + std::norm(r));
            energy += (bin == 0 || bin == size / 2 ? 1 : 2) * powerValue * weight * weight;
            if (listen)
            {
                auto left = l, right = r;
                if (band.target == 1) right = left;
                else if (band.target == 2) left = right;
                else if (band.target == 3) left = right = (l + r) * .5f;
                else if (band.target == 4) { left = (l - r) * .5f; right = -left; }
                spectra[0][k] = left * static_cast<float>(weight); spectra[1][k] = right * static_cast<float>(weight);
            }
        }
        if (listen) { gainDb[b].store(0); return; }
        // Parseval normalization: sqrt-Hann window power sum is N/2.
        const float level = juce::Decibels::gainToDecibels(static_cast<float>(std::sqrt(energy * 2 / (static_cast<double>(size) * size))), -120.0f);
        if (!state.wasActive || !state.wasWhole) { state.bandAverage = level; state.bandEnvelope = 0; }
        state.bandAverage += (1 - std::exp(-static_cast<float>(hop / rate))) * (level - state.bandAverage);
        const float threshold = band.adaptive ? juce::jlimit(-100.0f, 0.0f, state.bandAverage + 6 - band.sensitivity) : band.threshold;
        const float request = juce::jlimit(0.0f, 1.0f, (level - threshold) / 18);
        const float attack = band.automatic ? juce::jlimit(.2f, 80.0f, 2000 / band.frequency) : band.attack;
        const float release = band.automatic ? juce::jlimit(40.0f, 1000.0f, 10000 / band.frequency + 80 + 8 * std::abs(band.range)) : band.release;
        const float step = 1 - std::exp(-static_cast<float>(hop / rate) / (.001f * (request > state.bandEnvelope ? attack : release)));
        state.bandEnvelope += step * (request - state.bandEnvelope);
        const float delta = juce::jlimit(-30.0f, 30.0f, band.staticGain + band.range * state.bandEnvelope) - band.staticGain;
        const int stages = band.shape == 0 ? 1 : std::array<int, 6>{1, 1, 2, 4, 6, 8}[static_cast<size_t>(juce::jlimit(0, 5, band.slope))];
        const auto before = responseCoefficients(band, band.staticGain, stages), after = responseCoefficients(band, band.staticGain + delta, stages);
        for (int bin = 0; bin < bins; ++bin)
        {
            const auto z = frequencyZ[static_cast<size_t>(bin)];
            const double ratio = magnitude(after, z) / juce::jmax(1e-12, magnitude(before, z));
            applyGain(bin, band.target, static_cast<float>(std::pow(ratio, stages)));
        }
        state.wasActive = state.wasWhole = true; gainDb[b].store(delta); thresholdDb[b].store(threshold);
    }
    void transform(std::vector<Complex>& data, bool inverse) noexcept
    {
        for (int i = 0; i < size; ++i)
            if (i < reverse[static_cast<size_t>(i)]) std::swap(data[static_cast<size_t>(i)], data[static_cast<size_t>(reverse[static_cast<size_t>(i)])]);
        for (int length = 2; length <= size; length *= 2)
            for (int start = 0; start < size; start += length)
                for (int i = 0; i < length / 2; ++i)
                {
                    const auto root = twiddles[static_cast<size_t>(i * (size / length))];
                    const auto even = data[static_cast<size_t>(start + i)];
                    const auto odd = data[static_cast<size_t>(start + i + length / 2)] * (inverse ? std::conj(root) : root);
                    data[static_cast<size_t>(start + i)] = even + odd;
                    data[static_cast<size_t>(start + i + length / 2)] = even - odd;
                }
        if (inverse) for (auto& value : data) value /= static_cast<float>(size);
    }
    void updateMask(State& state, const Band& band) noexcept
    {
        if (state.frequency == band.frequency && state.q == band.q && state.shape == band.shape && state.density == band.density) return;
        state.frequency = band.frequency; state.q = band.q; state.shape = band.shape; state.density = band.density;
        const float width = std::pow(2.0f, (1 - band.density) * .5f) - 1;
        for (int bin = 0; bin < bins; ++bin)
        {
            const auto k = static_cast<size_t>(bin);
            const float frequency = juce::jmax(1.0f, static_cast<float>(rate * bin / size));
            const float ratio = frequency / band.frequency;
            const float distance = std::log2(ratio) * band.q;
            state.mask[k] = band.shape == 0 ? std::exp(-.5f * distance * distance)
                : band.shape == 1 ? 1 / (1 + ratio * ratio) : ratio * ratio / (1 + ratio * ratio);
            state.radius[k] = juce::jlimit(0, bins - 1, juce::roundToInt(static_cast<float>(bin) * width));
        }
    }
    void processFrame() noexcept
    {
        const bool listening = listenBand >= 0 && listenBand < bandCount;
        bool any = listening;
        for (const auto& band : controls) any = any || band.active;
        if (!any)
        {
            for (size_t b = 0; b < states.size(); ++b) { states[b].wasActive = false; gainDb[b].store(0, std::memory_order_relaxed); }
            return;
        }
        for (size_t channel = 0; channel < spectra.size(); ++channel)
        {
            auto& frame = spectra[channel];
            for (int i = 0; i < size; ++i) frame[static_cast<size_t>(i)] = history[channel][static_cast<size_t>((position + i) % size)] * window[static_cast<size_t>(i)];
            transform(frame, false);
        }
        // Start with program spectra; accumulate the delta only, so unity has
        // exact delay parity instead of an FFT-rounding residual.
        std::array<std::vector<Complex>*, 2> program {&spectra[0], &spectra[1]};
        for (size_t channel = 0; channel < 2; ++channel) std::copy(spectra[channel].begin(), spectra[channel].end(), original[channel].begin());
        if (listening) processWholeBand(static_cast<size_t>(listenBand), true);
        for (size_t b = 0; b < controls.size(); ++b)
        {
            const auto& band = controls[b]; auto& state = states[b];
            if (listening || !band.active) { state.wasActive = false; gainDb[b].store(0, std::memory_order_relaxed); continue; }
            if (band.wholeBand) { processWholeBand(b, false); continue; }
            if (state.wasWhole) { state.wasActive = false; state.wasWhole = false; }
            updateMask(state, band);
            if (!state.wasActive)
            {
                std::fill(state.envelope.begin(), state.envelope.end(), 0.0f);
                std::fill(state.average.begin(), state.average.end(), 0.0f);
            }
            const size_t source = band.source == 2 ? 4 : 2;
            for (int bin = 0; bin < bins; ++bin)
            {
                const auto k = static_cast<size_t>(bin);
                const auto l = spectra[source][k], r = spectra[source + 1][k];
                const float magnitude = band.target == 1 ? std::abs(l) : band.target == 2 ? std::abs(r)
                    : band.target == 3 ? std::abs((l + r) * .5f) : band.target == 4 ? std::abs((l - r) * .5f)
                    : std::max(std::abs(l), std::abs(r));
                const float frequency = static_cast<float>(rate * bin / size);
                detector[k] = band.free && (frequency < band.low || frequency > band.high) ? -120.0f : juce::Decibels::gainToDecibels(magnitude * amplitudeScale, -120.0f) + (band.tilt ? tiltDb[k] : 0);
            }
            // Density uses a bounded log-frequency neighbourhood maximum. A
            // broad setting extends detection around peaks; 100% is per-bin.
            // Monotonic frequency radii allow a linear-time sliding max deque.
            int head = 0, tail = 0, next = 0;
            for (int bin = 0; bin < bins; ++bin)
            {
                const auto k = static_cast<size_t>(bin);
                const int low = juce::jmax(0, bin - state.radius[k]), high = juce::jmin(bins - 1, bin + state.radius[k]);
                while (next <= high)
                {
                    while (tail > head && detector[static_cast<size_t>(deque[static_cast<size_t>(tail - 1)])] <= detector[static_cast<size_t>(next)]) --tail;
                    deque[static_cast<size_t>(tail++)] = next++;
                }
                while (head < tail && deque[static_cast<size_t>(head)] < low) ++head;
                spread[k] = detector[static_cast<size_t>(deque[static_cast<size_t>(head)])];
            }
            float peakGain = 0, sumThreshold = 0, totalMask = 0;
            const float attack = band.automatic ? juce::jlimit(.2f, 80.0f, 2000 / band.frequency) : band.attack;
            const float release = band.automatic ? juce::jlimit(40.0f, 1000.0f, 10000 / band.frequency + 80 + 8 * std::abs(band.range)) : band.release;
            const float rise = 1 - std::exp(-static_cast<float>(hop) / static_cast<float>(rate * attack * .001));
            const float fall = 1 - std::exp(-static_cast<float>(hop) / static_cast<float>(rate * release * .001));
            const float averageStep = 1 - std::exp(-static_cast<float>(hop) / static_cast<float>(rate * 1.0));
            for (int bin = 0; bin < bins; ++bin)
            {
                const auto k = static_cast<size_t>(bin);
                if (!state.wasActive) state.average[k] = spread[k];
                state.average[k] += averageStep * (spread[k] - state.average[k]);
                const float threshold = band.adaptive ? juce::jlimit(-100.0f, 0.0f, state.average[k] + 6 - band.sensitivity) : band.threshold;
                const float frequency = static_cast<float>(rate * bin / size);
                const bool admitted = !band.free || (frequency >= band.low && frequency <= band.high);
                const float requested = admitted ? juce::jlimit(0.0f, 1.0f, (spread[k] - threshold) / 12) : 0;
                state.envelope[k] += (requested > state.envelope[k] ? rise : fall) * (requested - state.envelope[k]);
                const float db = band.range * state.envelope[k] * state.mask[k];
                if (std::abs(db) > std::abs(peakGain)) peakGain = db;
                sumThreshold += threshold * state.mask[k]; totalMask += state.mask[k];
                const float gain = juce::Decibels::decibelsToGain(db);
                if (gain == 1) continue;
                auto& l = (*program[0])[k]; auto& r = (*program[1])[k];
                if (band.target == 1) l *= gain;
                else if (band.target == 2) r *= gain;
                else if (band.target >= 3)
                {
                    auto mid = (l + r) * .5f, side = (l - r) * .5f;
                    if (band.target == 3) mid *= gain; else side *= gain;
                    l = mid + side; r = mid - side;
                }
                else { l *= gain; r *= gain; }
            }
            state.wasActive = true;
            gainDb[b].store(peakGain, std::memory_order_relaxed);
            thresholdDb[b].store(sumThreshold / juce::jmax(1e-12f, totalMask), std::memory_order_relaxed);
        }
        for (size_t channel = 0; channel < 2; ++channel)
        {
            auto& frame = spectra[channel];
            for (int bin = 0; bin < bins; ++bin)
            {
                const auto k = static_cast<size_t>(bin); frame[k] -= original[channel][k];
                if (bin > 0 && bin < size / 2) frame[static_cast<size_t>(size - bin)] = std::conj(frame[k]);
            }
            transform(frame, true);
            for (int i = 0; i < size; ++i)
                correction[channel][static_cast<size_t>((position + i) % size)] += frame[static_cast<size_t>(i)].real() * window[static_cast<size_t>(i)] * .5f;
        }
    }
};
