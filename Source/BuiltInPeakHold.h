#pragma once
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>

// One audio-thread writer; UI only requests reset and reads published maxima.
class BuiltInPeakHold
{
public:
    void reset() noexcept
    {
        maximum.fill(-100.0f);
        for(auto& value:published)value.store(-100.0f,std::memory_order_relaxed);
        pending.store(false,std::memory_order_relaxed);
    }
    void requestReset() noexcept { pending.store(true,std::memory_order_release); }
    bool resetPending() const noexcept { return pending.load(std::memory_order_acquire); }
    void beginBlock() noexcept
    {
        if(pending.exchange(false,std::memory_order_acq_rel))
        {
            maximum.fill(-100.0f);
            for(auto& value:published)value.store(-100.0f,std::memory_order_relaxed);
        }
    }
    void add(bool output,std::size_t channel,float db) noexcept
    {
        const auto index=(output?2U:0U)+channel;
        if(index>=maximum.size()||!std::isfinite(db))return;
        if(db>maximum[index])maximum[index]=db;
        published[index].store(maximum[index],std::memory_order_relaxed);
    }
    float read(bool output,std::size_t channel) const noexcept
    { return published[(output?2U:0U)+channel].load(std::memory_order_relaxed); }
private:
    std::array<float,4> maximum{{-100,-100,-100,-100}};
    std::array<std::atomic<float>,4> published{{-100,-100,-100,-100}};
    std::atomic<bool> pending{false};
};
