#pragma once
#include <JuceHeader.h>
#include <mutex>

// Bounded callback capture; all FFT and serialization work belongs to consumers.
class BuiltInSpectrumCapture
{
public:
    static constexpr int size = 2048, bins = size / 2;
    struct Spectrum { std::array<float, bins> pre {}, post {}; bool ready = false; };
    void prepare(double sampleRate) { rate.store(sampleRate); reset(); }
    void reset()
    {
        // reset runs with the producer suspended; never wait for the UI reader.
        generation.fetch_add(1, std::memory_order_release);
        for (auto& slot : slots)
        {
            int state = slot.state.load(std::memory_order_acquire);
            while (state != 3 && !slot.state.compare_exchange_weak(state, 0, std::memory_order_acq_rel)) {}
        }
        writing = -1; offset = remaining = 0; captureBlock = false; demand.store(0);
    }
    void beginBlock(int samples) noexcept
    {
        const int request = demand.exchange(0, std::memory_order_relaxed);
        if (request > 0) remaining = request;
        captureBlock = remaining > 0;
        remaining = juce::jmax(0, remaining - samples);
    }
    void push(float preL, float preR, float postL, float postR) noexcept
    {
        if (!captureBlock) return;
        if (writing < 0)
        {
            for (size_t i = 0; i < slots.size(); ++i)
            {
                int expected = 0;
                if (slots[i].state.compare_exchange_strong(expected, 1, std::memory_order_acquire)) { writing = static_cast<int>(i); offset = 0; break; }
            }
            if (writing < 0) return;
        }
        auto& slot = slots[static_cast<size_t>(writing)];
        const std::array<float, 4> sample { preL, preR, postL, postR };
        for (size_t ch = 0; ch < sample.size(); ++ch) slot.audio[ch][static_cast<size_t>(offset)] = std::isfinite(sample[ch]) ? sample[ch] : 0;
        if (++offset == size) { slot.state.store(2, std::memory_order_release); writing = -1; }
    }
    Spectrum read()
    {
        demand.store(static_cast<int>(rate.load() * .5), std::memory_order_relaxed);
        std::lock_guard<std::mutex> guard(consumerMutex);
        const auto currentGeneration = generation.load(std::memory_order_acquire);
        if (observedGeneration != currentGeneration) { last = {}; observedGeneration = currentGeneration; }
        for (auto& slot : slots)
        {
            int expected = 2;
            if (!slot.state.compare_exchange_strong(expected, 3, std::memory_order_acquire)) continue;
            Spectrum next;
            for (size_t ch = 0; ch < 4; ++ch)
            {
                std::array<float, size * 2> scratch {};
                std::copy(slot.audio[ch].begin(), slot.audio[ch].end(), scratch.begin());
                window.multiplyWithWindowingTable(scratch.data(), size); fft.performFrequencyOnlyForwardTransform(scratch.data());
                auto& target = ch < 2 ? next.pre : next.post;
                for (size_t bin = 0; bin < bins; ++bin)
                {
                    const float amplitude = scratch[bin] * (bin == 0 ? 1.0f : 2.0f) / size;
                    target[bin] += amplitude * amplitude * .5f;
                }
            }
            for (size_t bin = 0; bin < bins; ++bin)
            {
                next.pre[bin] = juce::Decibels::gainToDecibels(std::sqrt(next.pre[bin]), -120.0f);
                next.post[bin] = juce::Decibels::gainToDecibels(std::sqrt(next.post[bin]), -120.0f);
            }
            next.ready = true; last = next; slot.state.store(0, std::memory_order_release);
        }
        return last;
    }
private:
    struct Slot { std::atomic<int> state { 0 }; std::array<std::array<float, size>, 4> audio {}; };
    std::array<Slot, 2> slots;
    std::atomic<int> demand { 0 };
    std::atomic<double> rate { 48000 };
    int writing = -1, offset = 0, remaining = 0;
    bool captureBlock = false;
    std::atomic<unsigned int> generation { 0 };
    unsigned int observedGeneration = 0;
    Spectrum last;
    std::mutex consumerMutex;
    juce::dsp::FFT fft { 11 };
    juce::dsp::WindowingFunction<float> window { size, juce::dsp::WindowingFunction<float>::hann, true };
};
