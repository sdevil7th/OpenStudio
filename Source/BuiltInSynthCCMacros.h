#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>

class BuiltInSynthCCMacros
{
public:
    BuiltInSynthCCMacros(){reset();}
    void reset() noexcept
    {
        for(auto& value:overrides)value.store(-1);senders={};clearRequests.store(0);lastEvent.store(0);
    }
    void clear(size_t slot) noexcept { clearRequests.fetch_or(1u<<slot); }
    void configure(const std::array<int,4>& nextCC,const std::array<int,4>& nextChannel) noexcept
    {
        const auto clearMask=clearRequests.exchange(0);
        for(size_t slot=0;slot<4;++slot)
        {
            if(cc[slot]!=nextCC[slot]||channels[slot]!=nextChannel[slot]||(clearMask&(1u<<slot))!=0)overrides[slot].store(-1);
            cc[slot]=nextCC[slot];channels[slot]=nextChannel[slot];
        }
    }
    template<class ResetAffects>
    bool controller(const juce::MidiMessage& message,const ResetAffects& affects) noexcept
    {
        if(!message.isController())return false;
        const int number=message.getControllerNumber(),channel=message.getChannel(),value=message.getControllerValue();bool changed=false;
        if(number<120)
        {
            const uint64_t packet=(static_cast<uint64_t>(++serial)<<18)|(static_cast<uint64_t>(channel-1)<<14)|(static_cast<uint64_t>(number)<<7)|static_cast<uint64_t>(value);
            lastEvent.store(packet,std::memory_order_release);
            for(size_t slot=0;slot<4;++slot)if(cc[slot]==number+1&&(channels[slot]==0||channels[slot]==channel))
            {overrides[slot].store(static_cast<float>(value)/127);senders[slot]=channel;changed=true;}
        }
        else if(number==121)for(size_t slot=0;slot<4;++slot)if(senders[slot]>0&&affects(senders[slot]-1))
        {overrides[slot].store(-1);senders[slot]=0;changed=true;}
        return changed;
    }
    float value(size_t slot,float base) const noexcept { const float overrideValue=overrides[slot].load();return overrideValue>=0?overrideValue:base; }
    juce::var visualization(const std::array<float,4>& base) const
    {
        auto* result=new juce::DynamicObject();juce::Array<juce::var> values,active,event;
        for(size_t slot=0;slot<4;++slot){const float overrideValue=overrides[slot].load();values.add(overrideValue>=0?overrideValue:base[slot]);active.add(overrideValue>=0);}
        const auto packet=lastEvent.load(std::memory_order_acquire);
        if(packet!=0){event.add(static_cast<double>(packet>>18));event.add(static_cast<int>((packet>>7)&127));event.add(static_cast<int>((packet>>14)&15)+1);event.add(static_cast<int>(packet&127));}
        result->setProperty("macroLive",values);result->setProperty("macroActive",active);result->setProperty("midiCCEvent",event);return result;
    }
private:
    std::array<std::atomic<float>,4> overrides;
    std::array<int,4> cc{},channels{},senders{};
    std::atomic<unsigned> clearRequests{0};std::atomic<uint64_t> lastEvent{0};uint32_t serial=0;
};
