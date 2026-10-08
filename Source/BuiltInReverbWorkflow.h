#pragma once
#include <JuceHeader.h>
#include <array>
#include <vector>

// Prepared stereo wet-return predelay and linked peak ducking. No callback
// allocation. Capacity is selected and prepared on the serialized control path.
class BuiltInReverbWorkflow
{
    std::array<std::vector<float>,2> delay;
    juce::SmoothedValue<float> delaySamples, syncMix, depth, threshold, release;
    float rate = 48000, envelope = 0, attack = 0, reduction = 0;
    int position = 0, validSamples = 0;
    bool initialized = false;
    float capacityMilliseconds = 6000;
public:
    static constexpr std::array<float,19> beats { .0625f, .083333333f, .125f, .166666667f, .25f, .333333333f, .5f, .75f, 1.0f,
        1.333333333f, 1.5f, 2, 2.666666667f, 3, 4, 6, 8, 12, 16 };
    static float capacitySeconds(float choice) noexcept { return std::array<float,3>{6,24,96}[static_cast<size_t>(std::isfinite(choice) ? juce::jlimit(0,2,juce::roundToInt(choice)) : 0)]; }
    static float milliseconds(float bpm, float division) noexcept
    {
        bpm = std::isfinite(bpm) ? juce::jlimit(10.0f,300.0f,bpm) : 120.0f;
        const int index = std::isfinite(division) ? juce::jlimit(0,18,juce::roundToInt(division)) : 4;
        return 60000.0f / bpm * beats[static_cast<size_t>(index)];
    }
    bool ready() const noexcept { return !delay[0].empty(); }
    void prepare(double sampleRate, float capacityChoice = 0)
    {
        // Allocate a complete replacement before touching the current ring.
        const float seconds = capacitySeconds(capacityChoice);
        std::array<std::vector<float>,2> next;
        for(auto& channel:next)channel.assign(static_cast<size_t>(std::ceil(sampleRate*(seconds+.001)))+4,0.0f);
        delay.swap(next); capacityMilliseconds=seconds*1000;
        rate=static_cast<float>(sampleRate);
        delaySamples.reset(sampleRate,.1);
        for (auto* smoother : {&syncMix,&depth,&threshold,&release}) smoother->reset(sampleRate,.05);
        attack=std::exp(-1.0f/(rate*.005f)); reset();
    }
    void reset() noexcept
    {
        // Invalidate history in O(1); reset may be called from an audio callback.
        validSamples=0; position=0; envelope=0; reduction=0; initialized=false;
    }
    void configure(bool sync,float millisecondsValue,float depthDb,float thresholdDb,float releaseMs) noexcept
    {
        const auto set=[this](auto& smoother,float value) { if(initialized) smoother.setTargetValue(value); else smoother.setCurrentAndTargetValue(value); };
        const auto safe=[](float value,float lo,float hi,float fallback) {return std::isfinite(value)?juce::jlimit(lo,hi,value):fallback;};
        set(delaySamples,static_cast<float>(static_cast<double>(safe(millisecondsValue,0,capacityMilliseconds,0))*static_cast<double>(rate)/1000.0));
        set(syncMix,sync?1.0f:0.0f);set(depth,safe(depthDb,0,24,0));
        set(threshold,safe(thresholdDb,-60,0,-24));set(release,std::exp(-1.0f/(rate*safe(releaseMs,20,2000,250)*.001f)));initialized=true;
    }
    bool active() const noexcept { return syncMix.getCurrentValue()>0 || syncMix.getTargetValue()>0 || depth.getCurrentValue()>0 || depth.getTargetValue()>0; }
    float gainReductionDb() const noexcept { return reduction; }
    std::array<float,2> process(float left,float right,float detector) noexcept
    {
        const float delayTime=delaySamples.getNextValue(), blend=syncMix.getNextValue();
        const int whole=static_cast<int>(delayTime), length=static_cast<int>(delay[0].size());
        const int a=(position+length-whole)%length,b=(a+length-1)%length;
        const float fraction=delayTime-static_cast<float>(whole);
        const float releaseCoefficient=release.getNextValue();
        detector=std::isfinite(detector)?juce::jlimit(0.0f,16.0f,detector):0;
        const float coefficient=detector>envelope?attack:releaseCoefficient;
        envelope=detector+coefficient*(envelope-detector);
        const float over=juce::jmax(0.0f,juce::Decibels::gainToDecibels(envelope,-120.0f)-threshold.getNextValue());
        reduction=depth.getNextValue()*juce::jlimit(0.0f,1.0f,over/12.0f);
        const float gain=juce::Decibels::decibelsToGain(-reduction);
        validSamples=juce::jmin(length,validSamples+1);
        std::array<float,2> result {left,right};
        for(size_t ch=0;ch<2;++ch)
        {
            delay[ch][static_cast<size_t>(position)]=std::isfinite(result[ch])?result[ch]:0;
            const float first=whole<validSamples?delay[ch][static_cast<size_t>(a)]:0;
            const float second=whole+1<validSamples?delay[ch][static_cast<size_t>(b)]:0;
            const float delayed=first+fraction*(second-first);
            result[ch]=(result[ch]+blend*(delayed-result[ch]))*gain;
        }
        if(++position==length)position=0;
        return result;
    }
};
