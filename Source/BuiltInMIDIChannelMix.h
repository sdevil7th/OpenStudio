#pragma once
#include <JuceHeader.h>
#include <array>

// MIDI-owned performance state: no parameter writes, allocation or callback locks.
class BuiltInMIDIChannelMix
{
public:
    struct Value { float level=1,pan=0; };
    using Frame=std::array<Value,16>;
    BuiltInMIDIChannelMix(){reset(48000);}
    void reset(double rate) noexcept
    {for(size_t ch=0;ch<16;++ch){volume[ch].reset(rate,.005);expression[ch].reset(rate,.005);pan[ch].reset(rate,.005);volume[ch].setCurrentAndTargetValue(1);expression[ch].setCurrentAndTargetValue(1);pan[ch].setCurrentAndTargetValue(0);}}
    template<class ResetAffects> void controller(const juce::MidiMessage& message,const ResetAffects& affects) noexcept
    {
        if(!message.isController())return;
        const size_t ch=static_cast<size_t>(juce::jlimit(1,16,message.getChannel())-1);
        const int cc=message.getControllerNumber(),raw=message.getControllerValue();const float value=static_cast<float>(raw)/127;
        if(cc==7)volume[ch].setTargetValue(value);
        else if(cc==11)expression[ch].setTargetValue(value);
        else if(cc==10)pan[ch].setTargetValue(raw<64?static_cast<float>(raw-64)/64:static_cast<float>(raw-64)/63);
        else if(cc==121)for(size_t receiver=0;receiver<16;++receiver)if(affects(receiver))expression[receiver].setTargetValue(1);
    }
    Frame next() noexcept
    {Frame frame;for(size_t ch=0;ch<16;++ch)frame[ch]={volume[ch].getNextValue()*expression[ch].getNextValue(),pan[ch].getNextValue()};return frame;}
    static float biasPan(float original,float bias) noexcept
    {return bias==0?original:juce::jlimit(-1.0f,1.0f,bias+original*(1-std::abs(bias)));}
private:
    std::array<juce::SmoothedValue<float>,16> volume,expression,pan;
};
