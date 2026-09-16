#pragma once

#include <JuceHeader.h>
#include "CrashDiagnostics.h"
#include <atomic>
#include <cmath>
#include <limits>
#include <type_traits>
#if JUCE_INTEL
#include <emmintrin.h>
#endif

// Owned with an immutable graph slot, not by the editor or the audio callback.
// A fault latches until an explicit control-thread reset/reload. C++ exceptions
// are recoverable here; access violations and corrupt heaps are NOT intercepted.
struct ProcessorSafety
{
    enum class Failure { none, exception, nonFinite, bufferContract, remoteProcess };
    const std::atomic<uint32_t>* remoteFailure = nullptr; // Bound once with the owning graph slot.
    std::atomic<Failure> failure { Failure::none };
    std::atomic<bool> reportPending { false };
    std::atomic<Failure> lastFailure { Failure::none };
    inline static std::atomic<uint64_t> changeGeneration { 0 };

    template <typename Sample, bool RequireFloatRange = false>
    static bool isFinite(const juce::AudioBuffer<Sample>& buffer) noexcept
    {
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        {
            const auto* samples = buffer.getReadPointer(channel);
            int sample = 0;
#if JUCE_INTEL
            // SSE2 is baseline on our x64 targets. Inspect four floats/two
            // doubles at a time; no RMS, allocations, oversampling or logging.
            if constexpr (std::is_same_v<Sample, float>)
            {
                const auto mask = _mm_castsi128_ps(_mm_set1_epi32(0x7fffffff));
                const auto limit = _mm_set1_ps(std::numeric_limits<float>::max());
                for (; sample + 4 <= buffer.getNumSamples(); sample += 4)
                    if (_mm_movemask_ps(_mm_cmple_ps(_mm_and_ps(_mm_loadu_ps(samples + sample), mask), limit)) != 15)
                        return false;
            }
            else if constexpr (std::is_same_v<Sample, double>)
            {
                const auto mask = _mm_castsi128_pd(_mm_set1_epi64x(0x7fffffffffffffffLL));
                const auto limit = _mm_set1_pd(RequireFloatRange
                    ? static_cast<double>(std::numeric_limits<float>::max()) : std::numeric_limits<double>::max());
                for (; sample + 2 <= buffer.getNumSamples(); sample += 2)
                    if (_mm_movemask_pd(_mm_cmple_pd(_mm_and_pd(_mm_loadu_pd(samples + sample), mask), limit)) != 3)
                        return false;
            }
#endif
            for (; sample < buffer.getNumSamples(); ++sample)
                if (!std::isfinite(samples[sample]) || (RequireFloatRange
                    && std::abs(samples[sample]) > static_cast<Sample>(std::numeric_limits<float>::max())))
                    return false;
        }
        return true;
    }

    void reset() noexcept
    {
        if (failure.exchange(Failure::none, std::memory_order_acq_rel) != Failure::none)
            changeGeneration.fetch_add(1, std::memory_order_release);
    }
    void refreshRemoteFailure() noexcept
    {
        if (!remoteFailure) return;
        if (remoteFailure->load(std::memory_order_acquire) != 0) markFailure(Failure::remoteProcess);
        else if (failure.load(std::memory_order_acquire) == Failure::remoteProcess)
            reset(); // The remote flag only clears after an explicit worker restart.
    }
    void markFailure(Failure cause) noexcept
    {
        auto expected = Failure::none;
        if (!failure.compare_exchange_strong(expected, cause, std::memory_order_acq_rel)) return;
        lastFailure.store(cause, std::memory_order_relaxed);
        reportPending.store(true, std::memory_order_release);
        changeGeneration.fetch_add(1, std::memory_order_release);
        OpenStudioCrashDiagnostics::recordRealtimeFault(
            cause == Failure::exception ? OpenStudioCrashDiagnostics::RealtimeFault::processorException
            : cause == Failure::remoteProcess ? OpenStudioCrashDiagnostics::RealtimeFault::processorRemote
            : cause == Failure::nonFinite ? OpenStudioCrashDiagnostics::RealtimeFault::processorNonFinite
            : OpenStudioCrashDiagnostics::RealtimeFault::pluginBufferContract);
    }

    template <typename Sample>
    bool process(juce::AudioProcessor& processor, juce::AudioBuffer<Sample>& buffer,
                 juce::MidiBuffer& midi)
    {
        refreshRemoteFailure();
        if (failure.load(std::memory_order_acquire) != Failure::none)
        {
            buffer.clear();
            return false;
        }
        auto cause = Failure::none;
        try
        {
            processor.processBlock(buffer, midi);
            refreshRemoteFailure();
            if (failure.load(std::memory_order_acquire) == Failure::remoteProcess) { buffer.clear(); midi.clear(); return false; }
            // Every hosted path eventually returns to float device/track audio.
            // A finite double above FLT_MAX would otherwise become Infinity there.
            if (isFinite<Sample, true>(buffer))
                return true;
            cause = Failure::nonFinite;
        }
        catch (...)
        {
            cause = Failure::exception;
        }
        buffer.clear();
        markFailure(cause);
        return false;
    }
};
