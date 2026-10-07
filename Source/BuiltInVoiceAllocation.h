#pragma once
#include <array>
#include <cstdint>

// Fixed storage, FIFO note-off matching and deterministic oldest-voice stealing.
// MIDI 1.0 has no note instance ID: repeated keys release in arrival order.
struct BuiltInVoiceAllocation
{
    static constexpr size_t voicesPerChannel = 16;
    std::array<std::array<int, 128>, 16> key {};
    std::array<std::array<bool, 128>, 16> held {};
    std::array<std::array<uint64_t, 128>, 16> order {};
    std::array<std::array<unsigned, 128>, 16> stolenNoteOffs {};
    std::array<bool, 16> pedal {};
    std::array<bool,16> sostenutoDown {};
    std::array<std::array<uint16_t,128>,16> sostenutoOwners {};
    uint64_t clock = 0;
    void reset() { *this = {}; }
    template<class Active>
    size_t start(size_t channel, int note, const Active& active, bool oneShot = false)
    {
        size_t slot = 0;
        bool found = false;
        for (size_t i = 0; i < voicesPerChannel; ++i)
            if (!active[channel][i]) { slot = i; found = true; break; }
        if (!found)
        {
            // Prefer a released tail, then the oldest still-held key.
            for (size_t i = 1; i < voicesPerChannel; ++i)
                if ((held[channel][slot] && !held[channel][i])
                    || (held[channel][slot] == held[channel][i] && order[channel][i] < order[channel][slot])) slot = i;
        }
        if (held[channel][slot] && !oneShot)
            ++stolenNoteOffs[channel][static_cast<size_t>(key[channel][slot])];
        key[channel][slot] = note;
        sostenutoOwners[channel][slot] = 0;
        held[channel][slot] = !oneShot;
        order[channel][slot] = ++clock;
        return slot;
    }
    int stop(size_t channel, int note)
    {
        auto& skipped = stolenNoteOffs[channel][static_cast<size_t>(note)];
        if (skipped > 0) { --skipped; return -1; }
        int slot = -1;
        for (size_t i = 0; i < voicesPerChannel; ++i)
            if (held[channel][i] && key[channel][i] == note
                && (slot < 0 || order[channel][i] < order[channel][static_cast<size_t>(slot)])) slot = static_cast<int>(i);
        if (slot >= 0) held[channel][static_cast<size_t>(slot)] = false;
        return slot;
    }
    bool sustained(size_t channel,size_t slot) const noexcept
    { return pedal[channel] || sostenutoOwners[channel][slot] != 0; }
    template<class Affects>
    void setSostenuto(size_t sender,bool down,const Affects& affects) noexcept
    {
        const auto mask=static_cast<uint16_t>(1u<<sender);
        if(down&&!sostenutoDown[sender])
            for(size_t receiver=0;receiver<16;++receiver)if(affects(receiver))
                for(size_t slot=0;slot<voicesPerChannel;++slot)if(held[receiver][slot])sostenutoOwners[receiver][slot]|=mask;
        if(!down)for(auto& channel:sostenutoOwners)for(auto& owners:channel)owners&=static_cast<uint16_t>(~mask);
        sostenutoDown[sender]=down;
    }
    void releaseChannel(size_t channel)
    {
        held[channel].fill(false);
        stolenNoteOffs[channel].fill(0);
    }
};
