#pragma once
#include "BuiltInEQRouting.h"
#include "BuiltInSpectralPhaseCurve.h"
#include "BuiltInMinimumEQDesign.h"
#include <JuceHeader.h>
#include <array>
#include <complex>
#include <memory>
#include <vector>

// Static linear-phase stereo-matrix EQ. Kernel construction and reclamation run
// on a worker (or the non-realtime render thread); the callback owns fixed FFT
// history, consumes fixed snapshots and only exchanges prepared raw pointers.
class BuiltInLinearPhaseEQ final : private juce::Thread
{
public:
    using Coefficients = std::array<float, 5>;
    struct Snapshot
    {
        std::array<std::array<Coefficients, 8>, 24> coefficients {};
        std::array<int, 24> stages {}, targets {};
        std::array<int, 24> cutModes {};
        std::array<bool, 24> highPass {};
        std::array<float, 24> cutFrequencies {}, cutSlopes {};
        std::array<Coefficients, 64> draftCoefficients {};
        int draftStages = 0;
        int bands = 24, stereoMode = 0, quality = 1;
        bool spectralPhase = false, minimumPhase = false, analogResponse = false;
        std::array<BuiltInSpectralPhaseCurve::Curve, 2> phaseCurves {};
        bool operator==(const Snapshot& other) const noexcept
        { return coefficients == other.coefficients && stages == other.stages && targets == other.targets
            && cutModes == other.cutModes && highPass == other.highPass && cutFrequencies == other.cutFrequencies && cutSlopes == other.cutSlopes
            && draftStages == other.draftStages && draftCoefficients == other.draftCoefficients
            && spectralPhase == other.spectralPhase && phaseCurves == other.phaseCurves && minimumPhase == other.minimumPhase && analogResponse == other.analogResponse
            && bands == other.bands && stereoMode == other.stereoMode && quality == other.quality; }
    };
    static constexpr int quantum = 256, fftLength = quantum * 2, maxPartitions = 65;
    static int tapCount(int quality) noexcept { return (quality <= 0 ? 1024 : quality == 1 ? 4096 : 16384) + 1; }
    static int latency(int quality) noexcept { return (tapCount(quality) - 1) / 2 + quantum; }
    static int latency(const Snapshot& snapshot) noexcept { return snapshot.minimumPhase ? quantum + (snapshot.analogResponse ? BuiltInMinimumEQDesign::analogDelay : 0) : latency(snapshot.quality); }
    BuiltInLinearPhaseEQ() : Thread("Linear EQ kernels")
    {
        for (size_t i = 0; i < twiddles.size(); ++i)
            twiddles[i] = std::polar(1.0f, -juce::MathConstants<float>::twoPi * static_cast<float>(i) / fftLength);
    }
    ~BuiltInLinearPhaseEQ() override { stopThread(-1); destroyKernels(); }
    void prepare(double sampleRate, const Snapshot& snapshot, bool nonRealtime)
    {
        stopThread(-1); destroyKernels(); rate = sampleRate; offline = nonRealtime;
        lastRequested = snapshot; requestedGeneration.store(1); appliedGeneration.store(1);
        for (auto& slot : mailbox) slot.state.store(0);
        history.assign(static_cast<size_t>(2 * maxPartitions * fftLength), {});
        dryHistory.assign(static_cast<size_t>(latency(2) + 1), {});
        active = build(snapshot, 1).release(); publishResponse(*active);
        fade.reset(rate, .025); reset();
        if (!offline) startThread();
    }
    void release()
    {
        stopThread(-1); destroyKernels(); history.clear(); dryHistory.clear();
    }
    void reset() noexcept
    {
        input = {}; previousInput = {}; output = {}; position = 0; historyPosition = 0;
        validPartitions = 0; dryPosition = 0; dryValid = 0;
        fade.setCurrentAndTargetValue(1);
        if (fading) { retire(fading); fading = nullptr; }
    }
    bool ready() const noexcept { return active != nullptr && !history.empty(); }
    bool updating() const noexcept { return requestedGeneration.load() != appliedGeneration.load(); }
    float autoGainDB() const noexcept { return publishedAutoGain.load(std::memory_order_relaxed); }
    void request(const Snapshot& snapshot)
    {
        if (snapshot == lastRequested) return;
        if (offline)
        {
            lastRequested = snapshot; const auto generation = requestedGeneration.fetch_add(1) + 1;
            auto kernel = build(snapshot, generation); publishResponse(*kernel);
            delete pending.exchange(kernel.release()); collect(); return;
        }
        for (auto& slot : mailbox)
        {
            int expected = 0;
            if (!slot.state.compare_exchange_strong(expected, 1, std::memory_order_acquire)) continue;
            slot.snapshot = snapshot; slot.generation = requestedGeneration.fetch_add(1) + 1;
            slot.state.store(2, std::memory_order_release); lastRequested = snapshot; return;
        }
        // The next callback retries. Never wait, overwrite a reader, or allocate.
    }
    std::array<float, 4> process(float left, float right) noexcept
    {
        if (!ready()) return {left, right, left, right};
        const auto at = static_cast<size_t>(position);
        const std::array<float, 2> wet { output[0][at], output[1][at] };
        dryHistory[dryPosition] = {left, right};
        const auto delay = static_cast<size_t>(latency(lastRequested));
        const auto dry = dryValid >= delay ? dryHistory[(dryPosition + dryHistory.size() - delay) % dryHistory.size()] : std::array<float, 2>{};
        dryPosition = (dryPosition + 1) % dryHistory.size(); ++dryValid;
        input[0][at] = left; input[1][at] = right;
        if (++position == quantum) { processQuantum(); position = 0; }
        return { wet[0], wet[1], dry[0], dry[1] };
    }
    std::vector<float> response(const std::vector<float>& frequencies, float gainDB = 0, int stereoMode = 0) const
    {
        const auto data = std::atomic_load(&publishedResponse);
        std::vector<float> result(frequencies.size(), 0);
        if (!data) return result;
        for (size_t i = 0; i < frequencies.size(); ++i)
        {
            const double at = juce::jlimit(0.0, static_cast<double>(data->values[0].size() - 1), frequencies[i] * data->fftSize / data->sampleRate);
            const size_t a = static_cast<size_t>(at), b = juce::jmin(a + 1, data->values[0].size() - 1);
            BuiltInEQRouting::Matrix transfer {};
            for (size_t path = 0; path < 4; ++path)
            {
                const auto value = static_cast<std::complex<double>>(data->values[path][a])
                    + (at - static_cast<double>(a)) * static_cast<std::complex<double>>(data->values[path][b] - data->values[path][a]);
                transfer[path] = value;
            }
            const int target = stereoMode == 1 ? 3 : stereoMode == 2 ? 4 : 0;
            transfer = BuiltInEQRouting::multiply(BuiltInEQRouting::band(juce::Decibels::decibelsToGain(static_cast<double>(gainDB)), target), transfer);
            result[i] = static_cast<float>(juce::Decibels::gainToDecibels(BuiltInEQRouting::energy(transfer), -100.0));
        }
        return result;
    }
private:
    using Complex = std::complex<float>;
    struct Response { std::array<std::vector<Complex>, 4> values; double sampleRate = 48000; int fftSize = 4096; };
    struct Kernel
    {
        std::array<std::vector<Complex>, 4> spectra;
        std::array<bool, 4> used {};
        std::shared_ptr<const Response> response;
        int partitions = 0; float autoGain = 0;
        unsigned int generation = 0; Kernel* next = nullptr;
    };
    struct Mailbox { std::atomic<int> state {0}; Snapshot snapshot; unsigned int generation = 0; };
    std::unique_ptr<Kernel> build(const Snapshot& snapshot, unsigned int generation) const
    {
        const int taps = tapCount(snapshot.quality), centre = (taps - 1) / 2;
        const int size = (taps - 1) * 4;
        juce::dsp::FFT designFFT(juce::roundToInt(std::log2(size)));
        auto kernel = std::make_unique<Kernel>(); kernel->generation = generation;
        kernel->partitions = (taps + quantum - 1) / quantum;
        std::array<std::vector<Complex>, 4> transfer;
        for (auto& path : transfer) path.resize(static_cast<size_t>(size));
        if (snapshot.minimumPhase) transfer = BuiltInMinimumEQDesign::build(snapshot, rate, size);
        for (int bin = 0; !snapshot.minimumPhase && bin <= size / 2; ++bin)
        {
            if (snapshot.spectralPhase)
            {
                const double hz = static_cast<double>(bin) * rate / size;
                for (size_t channel = 0; channel < 2; ++channel)
                {
                    const size_t path = channel * 3;
                    const auto value = std::polar(1.0f, static_cast<float>(BuiltInSpectralPhaseCurve::radians(snapshot.phaseCurves[channel], hz, rate)));
                    transfer[path][static_cast<size_t>(bin)] = value;
                    if (bin > 0 && bin < size / 2) transfer[path][static_cast<size_t>(size - bin)] = std::conj(value);
                }
                continue;
            }
            const auto z = std::polar(1.0, -juce::MathConstants<double>::twoPi * bin / size);
            BuiltInEQRouting::Matrix matrix {1,0,0,1};
            for (int band = 0; band < snapshot.bands; ++band)
            {
                const auto index = static_cast<size_t>(band); double h = 1;
                if (snapshot.stages[index] == 0 && snapshot.cutModes[index] == 0) continue;
                if (snapshot.cutModes[index] != 0)
                {
                    const double frequency = static_cast<double>(bin) * rate / size;
                    const double cutoff = juce::jlimit(20.0, rate * .475, static_cast<double>(snapshot.cutFrequencies[index]));
                    if (snapshot.cutModes[index] == 2)
                    {
                        // Integrate the step over the design bin. Fractional cutoff
                        // positions must not jump by an entire FFT bin while editing.
                        const double lowPass = juce::jlimit(0.0, 1.0, .5 + (cutoff - frequency) * size / rate);
                        h = snapshot.highPass[index] ? 1 - lowPass : lowPass;
                    }
                    else if (bin == 0) h = snapshot.highPass[index] ? 0 : 1;
                    else if (bin == size / 2) h = snapshot.highPass[index] ? 1 : 0;
                    else
                    {
                        const double ratio = std::tan(juce::MathConstants<double>::pi * frequency / rate) / std::tan(juce::MathConstants<double>::pi * cutoff / rate);
                        const double exponent = 2 * juce::jlimit(3.0, 96.0, static_cast<double>(snapshot.cutSlopes[index])) / 6
                            * std::log(snapshot.highPass[index] ? 1 / ratio : ratio);
                        h = exponent > 80 ? std::exp(-exponent * .5) : exponent < -80 ? 1 : std::exp(-.5 * std::log1p(std::exp(exponent)));
                    }
                }
                for (int stage = 0; stage < snapshot.stages[index]; ++stage)
                {
                    const auto& c = snapshot.coefficients[index][static_cast<size_t>(stage)];
                    const auto denominator = 1.0 + static_cast<double>(c[3]) * z + static_cast<double>(c[4]) * z * z;
                    if (std::abs(denominator) > 1e-18)
                        h *= std::abs((static_cast<double>(c[0]) + static_cast<double>(c[1]) * z + static_cast<double>(c[2]) * z * z) / denominator);
                }
                const int target = snapshot.stereoMode == 1 ? 3 : snapshot.stereoMode == 2 ? 4 : snapshot.targets[index];
                matrix = BuiltInEQRouting::multiply(BuiltInEQRouting::band(h, target), matrix);
            }
            double draftMagnitude = 1;
            for (int stage = 0; stage < snapshot.draftStages; ++stage)
            {
                const auto& c = snapshot.draftCoefficients[static_cast<size_t>(stage)];
                const auto denominator = 1.0 + static_cast<double>(c[3]) * z + static_cast<double>(c[4]) * z * z;
                if (std::abs(denominator) > 1e-18) draftMagnitude *= std::abs((static_cast<double>(c[0]) + static_cast<double>(c[1]) * z + static_cast<double>(c[2]) * z * z) / denominator);
            }
            for (size_t path = 0; path < 4; ++path)
            {
                const float value = static_cast<float>(juce::jlimit(-1e6, 1e6, matrix[path].real() * draftMagnitude));
                transfer[path][static_cast<size_t>(bin)] = value;
                if (bin > 0 && bin < size / 2) transfer[path][static_cast<size_t>(size - bin)] = value;
            }
        }
        auto responseData = std::make_shared<Response>(); responseData->sampleRate = rate; responseData->fftSize = size;
        std::vector<Complex> transformed(static_cast<size_t>(size)), centred(static_cast<size_t>(size));
        std::vector<float> impulse(static_cast<size_t>(taps));
        juce::dsp::FFT partitionFFT(9);
        std::array<Complex, fftLength> partition {};
        for (size_t path = 0; path < 4; ++path)
        {
            designFFT.perform(transfer[path].data(), transformed.data(), true);
            std::fill(centred.begin(), centred.end(), Complex{});
            for (int i = 0; i < taps; ++i)
            {
                const int relative = snapshot.minimumPhase ? i : i - centre;
                // Symmetric Hann truncation: exact unit delay remains exact.
                const float window = snapshot.minimumPhase
                    ? (i < taps * 3 / 4 ? 1.0f : static_cast<float>(.5 + .5 * std::cos(juce::MathConstants<double>::pi * (i - taps * 3 / 4) / (taps - 1 - taps * 3 / 4))))
                    : static_cast<float>(.5 + .5 * std::cos(juce::MathConstants<double>::pi * relative / centre));
                const int source = relative >= 0 ? relative : size + relative;
                const int mirror = relative <= 0 ? -relative : size - relative;
                const float value = (snapshot.spectralPhase || snapshot.minimumPhase ? transformed[static_cast<size_t>(source)].real() : .5f * (transformed[static_cast<size_t>(source)].real() + transformed[static_cast<size_t>(mirror % size)].real())) * window;
                impulse[static_cast<size_t>(i)] = value;
                centred[static_cast<size_t>(source)] = value;
                kernel->used[path] = kernel->used[path] || std::abs(value) > 1e-12f;
            }
            designFFT.perform(centred.data(), transformed.data(), false);
            auto& responseValues = responseData->values[path]; responseValues.resize(static_cast<size_t>(size / 2 + 1));
            for (int bin = 0; bin <= size / 2; ++bin) responseValues[static_cast<size_t>(bin)] = snapshot.minimumPhase ? transformed[static_cast<size_t>(bin)]
                : Complex{snapshot.spectralPhase ? std::abs(transformed[static_cast<size_t>(bin)]) : transformed[static_cast<size_t>(bin)].real(), 0};
            auto& spectra = kernel->spectra[path]; spectra.resize(static_cast<size_t>(kernel->partitions * fftLength));
            for (int block = 0; block < kernel->partitions; ++block)
            {
                partition.fill({});
                for (int i = 0; i < quantum && block * quantum + i < taps; ++i) partition[static_cast<size_t>(i)] = impulse[static_cast<size_t>(block * quantum + i)];
                partitionFFT.perform(partition.data(), spectra.data() + block * fftLength, false);
            }
        }
        kernel->response = std::move(responseData);
        double gainSum = 0;
        for (int probe = 0; probe < 16; ++probe)
        {
            const double frequency = 31.5 * std::pow(16000.0 / 31.5, probe / 15.0);
            const size_t bin = static_cast<size_t>(juce::jlimit(0, size / 2, juce::roundToInt(frequency * size / rate)));
            double energy = 0; for (const auto& path : kernel->response->values) energy += std::norm(static_cast<std::complex<double>>(path[bin]));
            gainSum += juce::Decibels::gainToDecibels(std::sqrt(energy * .5), -100.0);
        }
        kernel->autoGain = static_cast<float>(juce::jlimit(-9.0, 9.0, -gainSum / 16)); return kernel;
    }
    // Single-owner radix-2 FFT avoids JUCE fallback's internal SpinLock. Twiddle
    // storage is constructed before playback; input/output arrays never alias.
    void fft(const Complex* source, Complex* destination, bool inverse) const noexcept
    {
        unsigned int reversed = 0;
        for (unsigned int i = 0; i < fftLength; ++i)
        {
            destination[reversed] = source[i]; unsigned int bit = fftLength >> 1;
            while (reversed & bit) { reversed ^= bit; bit >>= 1; }
            reversed ^= bit;
        }
        for (int length = 2; length <= fftLength; length *= 2)
        {
            const int half = length / 2, stride = fftLength / length;
            for (int offset = 0; offset < fftLength; offset += length) for (int i = 0; i < half; ++i)
            {
                const auto twiddle = inverse ? std::conj(twiddles[static_cast<size_t>(i * stride)]) : twiddles[static_cast<size_t>(i * stride)];
                const auto a = destination[offset + i], b = destination[offset + i + half] * twiddle;
                destination[offset + i] = a + b; destination[offset + i + half] = a - b;
            }
        }
        if (inverse) for (int i = 0; i < fftLength; ++i) destination[i] /= static_cast<float>(fftLength);
    }
    void convolve(const Kernel& kernel, std::array<std::array<float, quantum>, 2>& result) noexcept
    {
        for (int out = 0; out < 2; ++out)
        {
            accumulator.fill({});
            for (int in = 0; in < 2; ++in)
            {
                const auto path = static_cast<size_t>(out * 2 + in); if (!kernel.used[path]) continue;
                for (int block = 0; block < juce::jmin(kernel.partitions, validPartitions); ++block)
                {
                    const int historyBlock = (historyPosition + maxPartitions - block) % maxPartitions;
                    const auto* x = history.data() + (in * maxPartitions + historyBlock) * fftLength;
                    const auto* h = kernel.spectra[path].data() + block * fftLength;
                    for (int bin = 0; bin <= fftLength / 2; ++bin) accumulator[static_cast<size_t>(bin)] += x[bin] * h[bin];
                }
            }
            for (int bin = 1; bin < fftLength / 2; ++bin) accumulator[static_cast<size_t>(fftLength - bin)] = std::conj(accumulator[static_cast<size_t>(bin)]);
            fft(accumulator.data(), transformedFrame.data(), true);
            for (int i = 0; i < quantum; ++i) result[static_cast<size_t>(out)][static_cast<size_t>(i)] = transformedFrame[static_cast<size_t>(i + quantum)].real();
        }
    }
    void processQuantum() noexcept
    {
        for (int channel = 0; channel < 2; ++channel)
        {
            for (int i = 0; i < quantum; ++i)
            {
                frame[static_cast<size_t>(i)] = previousInput[static_cast<size_t>(channel)][static_cast<size_t>(i)];
                frame[static_cast<size_t>(i + quantum)] = input[static_cast<size_t>(channel)][static_cast<size_t>(i)];
            }
            fft(frame.data(), history.data() + (channel * maxPartitions + historyPosition) * fftLength, false);
            previousInput[static_cast<size_t>(channel)] = input[static_cast<size_t>(channel)];
        }
        validPartitions = juce::jmin(maxPartitions, validPartitions + 1);
        if (!fading) if (auto* next = pending.exchange(nullptr, std::memory_order_acq_rel))
        {
            fading = active; active = next; fade.setCurrentAndTargetValue(0); fade.setTargetValue(1);
            appliedGeneration.store(active->generation, std::memory_order_release);
            publishedAutoGain.store(active->autoGain, std::memory_order_relaxed);
        }
        convolve(*active, output);
        if (fading)
        {
            convolve(*fading, previousOutput);
            for (int i = 0; i < quantum; ++i)
            {
                const float mix = fade.getNextValue();
                for (size_t channel = 0; channel < 2; ++channel)
                    output[channel][static_cast<size_t>(i)] = previousOutput[channel][static_cast<size_t>(i)] * (1 - mix) + output[channel][static_cast<size_t>(i)] * mix;
            }
            if (!fade.isSmoothing()) { retire(fading); fading = nullptr; }
        }
        historyPosition = (historyPosition + 1) % maxPartitions;
    }
    void run() override
    {
        while (!threadShouldExit())
        {
            collect(); Snapshot snapshot; unsigned int generation = 0;
            for (auto& slot : mailbox)
            {
                int expected = 2;
                if (!slot.state.compare_exchange_strong(expected, 3, std::memory_order_acquire)) continue;
                if (slot.generation > generation) { snapshot = slot.snapshot; generation = slot.generation; }
                slot.state.store(0, std::memory_order_release);
            }
            if (generation != 0)
            {
                auto kernel = build(snapshot, generation);
                if (!threadShouldExit() && generation == requestedGeneration.load(std::memory_order_acquire))
                { publishResponse(*kernel); delete pending.exchange(kernel.release(), std::memory_order_acq_rel); }
            }
            wait(5);
        }
        collect();
    }
    void publishResponse(const Kernel& kernel)
    {
        std::atomic_store(&publishedResponse, kernel.response);
        publishedAutoGain.store(kernel.autoGain, std::memory_order_relaxed);
    }
    void retire(Kernel* kernel) noexcept
    {
        auto* head = retired.load(std::memory_order_relaxed);
        do { kernel->next = head; } while (!retired.compare_exchange_weak(head, kernel, std::memory_order_release, std::memory_order_relaxed));
    }
    void collect()
    {
        auto* kernel = retired.exchange(nullptr, std::memory_order_acquire);
        while (kernel) { auto* next = kernel->next; delete kernel; kernel = next; }
    }
    void destroyKernels()
    { delete pending.exchange(nullptr); delete active; active = nullptr; delete fading; fading = nullptr; collect(); }
    double rate = 48000; bool offline = false;
    Snapshot lastRequested;
    std::array<Mailbox, 3> mailbox;
    std::atomic<unsigned int> requestedGeneration {0}, appliedGeneration {0};
    std::atomic<Kernel*> pending {nullptr}, retired {nullptr}; Kernel* active = nullptr; Kernel* fading = nullptr;
    std::shared_ptr<const Response> publishedResponse;
    std::atomic<float> publishedAutoGain {0};
    std::vector<Complex> history;
    std::vector<std::array<float, 2>> dryHistory;
    std::array<Complex, fftLength / 2> twiddles {};
    std::array<Complex, fftLength> frame {}, accumulator {}, transformedFrame {};
    std::array<std::array<float, quantum>, 2> input {}, previousInput {}, output {}, previousOutput {};
    int position = 0, historyPosition = 0, validPartitions = 0;
    size_t dryPosition = 0, dryValid = 0;
    juce::SmoothedValue<float> fade;
};
