#pragma once
#include <array>
#include <cstdint>
#include <limits>

// Sender-side ownership; the dispatcher serializes control/worker access. MIDI 1.0 has
// no clip/voice identity; optional merging protects a key until its last off.
class MIDIOutputNotePolicy
{
public:
    void reset(bool merge) noexcept {for(auto& channel:held)channel.fill(0);activeKeys=0;usedChannels=0;merging=merge;}
    template<class Send> void releaseUsedChannels(Send&& send, bool nextMerge)
    {
        for (int channel = 0; channel < 16; ++channel) if ((usedChannels & (1u << channel)) != 0)
            for (int cc : {64, 66, 120, 123})
                send(std::array<std::uint8_t, 3>{static_cast<std::uint8_t>(0xb0 + channel), static_cast<std::uint8_t>(cc), 0});
        reset(nextMerge);
    }
    void updateIdlePolicy(bool requestedMerge) noexcept { if(activeKeys==0)merging=requestedMerge; }
    bool isMerging() const noexcept {return merging;}
    bool isIdle() const noexcept {return activeKeys==0;}
    bool accept(const std::uint8_t* bytes,int size,bool requestedMerge) noexcept
    {
        updateIdlePolicy(requestedMerge);
        if(bytes==nullptr||size<1)return false;
        if(bytes[0]==0xffu){reset(requestedMerge);return true;}
        const unsigned status=bytes[0]&0xf0u,channel=bytes[0]&0x0fu;
        if(status>=0x80u&&status<=0xe0u)usedChannels|=static_cast<std::uint16_t>(1u<<channel);
        if(size<3)return true;
        if(status==0xb0u&&(bytes[1]==120u||bytes[1]>=123u))
        {
            for(auto& count:held[channel])if(count>0){count=0;--activeKeys;}
            updateIdlePolicy(requestedMerge);return true;
        }
        if((status!=0x80u&&status!=0x90u)||bytes[1]>127u)return true;
        auto& count=held[channel][bytes[1]];
        const bool noteOn=status==0x90u&&bytes[2]>0;
        if(noteOn)
        {
            if(count==std::numeric_limits<std::uint32_t>::max())return false;
            const bool first=count++==0;if(first)++activeKeys;
            return !merging||first;
        }
        if(count==0)return !merging;
        if(--count==0){--activeKeys;updateIdlePolicy(requestedMerge);return true;}
        return !merging;
    }
private:
    std::array<std::array<std::uint32_t,128>,16> held{};
    std::uint32_t activeKeys=0;
    bool merging=false;
    std::uint16_t usedChannels=0;
};
