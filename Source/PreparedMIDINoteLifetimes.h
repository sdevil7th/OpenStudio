#pragma once
#include <array>
#include <limits>
#include <vector>

// Control-thread preparation only. Intrusive index lists keep FIFO matching and
// pedal scans proportional to the events/currently sounding notes. Published
// entries are immutable; the audio callback needs no per-note scratch storage.
template<class Entries, class MessageAt>
void prepareMIDINoteLifetimes(Entries& events, MessageAt messageAt)
{
    constexpr auto none = std::numeric_limits<size_t>::max();
    std::array<std::array<size_t,128>,16> first {}, last {};
    for(auto& channel:first)channel.fill(none); for(auto& channel:last)channel.fill(none);
    std::array<size_t,16> sounding {}; sounding.fill(none);
    std::array<bool,16> sustain {}, sostenuto {};
    std::vector<size_t> nextKey(events.size(),none), next(events.size(),none), previous(events.size(),none);
    std::vector<bool> released(events.size(),false), captured(events.size(),false);
    const auto finish = [&](size_t index,size_t channel,double time)
    {
        events[index].soundingEndTime=time;
        if(previous[index]!=none)next[previous[index]]=next[index];else sounding[channel]=next[index];
        if(next[index]!=none)previous[next[index]]=previous[index];
    };
    for(size_t index=0;index<events.size();++index)
    {
        auto& event=events[index];const auto& message=messageAt(event);
        if(message.getChannel()<1||message.getChannel()>16)continue;
        const auto channel=static_cast<size_t>(message.getChannel()-1);
        if(message.isNoteOn())
        {
            const auto note=static_cast<size_t>(message.getNoteNumber());
            if(last[channel][note]!=none)nextKey[last[channel][note]]=index;else first[channel][note]=index;
            last[channel][note]=index;
            next[index]=sounding[channel];if(next[index]!=none)previous[next[index]]=index;sounding[channel]=index;
        }
        else if(message.isNoteOff())
        {
            const auto note=static_cast<size_t>(message.getNoteNumber()), voice=first[channel][note];
            if(voice==none)continue;
            first[channel][note]=nextKey[voice];if(first[channel][note]==none)last[channel][note]=none;
            events[voice].noteOffTime=event.time;events[voice].noteOffEvent=index;released[voice]=true;
            if(!sustain[channel]&&!captured[voice])finish(voice,channel,event.time);
        }
        else if(message.isController())
        {
            const int controller=message.getControllerNumber();const bool down=message.getControllerValue()>=64;
            if(controller==64)sustain[channel]=down;
            const bool capture=controller==66&&down&&!sostenuto[channel];
            if(controller==66)sostenuto[channel]=down;
            if(controller==121){sustain[channel]=false;sostenuto[channel]=false;}
            const bool kill=controller==120, allOff=controller==123||controller>=124;
            if(controller!=64&&controller!=66&&controller!=121&&!kill&&!allOff)continue;
            if(kill||allOff){first[channel].fill(none);last[channel].fill(none);}
            for(size_t voice=sounding[channel];voice!=none;)
            {
                const size_t following=next[voice];
                if(capture)captured[voice]=!released[voice];
                if((controller==66&&!down)||controller==121)captured[voice]=false;
                if((kill||allOff)&&!released[voice])
                {events[voice].noteOffTime=event.time;events[voice].noteOffEvent=index;released[voice]=true;}
                if(kill||(released[voice]&&!sustain[channel]&&!captured[voice]))finish(voice,channel,event.time);
                voice=following;
            }
        }
    }
}
