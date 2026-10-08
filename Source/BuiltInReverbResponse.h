#pragma once
#include "BuiltInEffects2.h"

// Worker-only diagnostic. A fresh processor owns every buffer; the live
// processor, its history and host state are never used for rendering.
inline juce::var renderBuiltInReverbResponse(const juce::MemoryBlock& state, double rate,
    float tempo, double seconds, int input, const std::function<bool()>& keepRunning = {},
    const std::function<void(int,double)>& progress = {})
{
    const auto fail=[](const juce::String& reason) { auto* r=new juce::DynamicObject();r->setProperty("success",false);r->setProperty("error",reason);return juce::var(r); };
    const auto active=[&]{return !keepRunning||keepRunning();};
    if(!std::isfinite(rate)||rate<8000||rate>192000||!std::isfinite(tempo)||tempo<10||tempo>300
        ||(seconds!=2&&seconds!=5&&seconds!=10)||input<0||input>2||state.getSize()==0)
        return fail("Invalid response duration, input, sample rate or state");
    if(!active())return fail("Response cancelled");
    if(progress)progress(1,0);
    auto copy=std::make_unique<OpenStudioReverb>(true);
    copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
    copy->wetLevel.store(1);copy->dryLevel.store(0);copy->sendMode.store(1);
    copy->workflowTempo.store(tempo);
    constexpr int blockSize=512, binCount=640;
    copy->prepareToPlay(rate,blockSize);
    if(!active())return fail("Response cancelled");
    const double nominalTail=copy->getTailLengthSeconds();
    const double predelay=copy->effectivePredelay();
    const int length=juce::roundToInt(rate*seconds), warmup=juce::roundToInt(rate*.1);
    constexpr float impulse=.2511886432f; // -12 dBFS per excited input.
    juce::AudioBuffer<float> block(2,blockSize);juce::MidiBuffer midi;
    std::array<std::array<double,binCount>,2> peaks{},squares{};
    std::array<int,binCount> counts{};
    std::array<double,2> totalEnergy{},maximum{},lastEnergy{};
    for(int position=-warmup;position<length;)
    {
        if(!active())return fail("Response cancelled");
        const int count=juce::jmin(blockSize,position<0?-position:length-position);
        block.setSize(2,count,false,false,true);block.clear();
        if(position==0){if(input!=1)block.setSample(0,0,impulse);if(input!=0)block.setSample(1,0,impulse);}
        copy->processBlock(block,midi);
        if(position>=0)for(int i=0;i<count;++i)
        {
            const int sample=position+i, bin=juce::jmin(binCount-1,static_cast<int>(static_cast<int64_t>(sample)*binCount/length));
            ++counts[static_cast<size_t>(bin)];
            for(size_t ch=0;ch<2;++ch)
            {
                const double value=block.getSample(static_cast<int>(ch),i);
                if(!std::isfinite(value))return fail("Response produced non-finite audio");
                const double square=value*value;
                peaks[ch][static_cast<size_t>(bin)]=juce::jmax(peaks[ch][static_cast<size_t>(bin)],std::abs(value));
                squares[ch][static_cast<size_t>(bin)]+=square;totalEnergy[ch]+=square;
                maximum[ch]=juce::jmax(maximum[ch],std::abs(value));
                if(sample>=length-juce::roundToInt(rate*.1))lastEnergy[ch]+=square;
            }
        }
        position+=count;if(progress)progress(2,juce::jlimit(0.0,1.0,static_cast<double>(position)/length));
    }
    if(!active())return fail("Response cancelled");
    auto* result=new juce::DynamicObject();result->setProperty("success",true);
    result->setProperty("sampleRate",rate);result->setProperty("tempoBpm",tempo);result->setProperty("seconds",seconds);
    result->setProperty("input",input);result->setProperty("impulseDb",-12);result->setProperty("warmupSeconds",.1);
    result->setProperty("predelayMs",predelay);result->setProperty("nominalTailSeconds",nominalTail);
    result->setProperty("tailBeyondWindow",!std::isfinite(nominalTail)||nominalTail>seconds);
    result->setProperty("nonzero",maximum[0]>0||maximum[1]>0);
    juce::Array<juce::var> channelPeaks,channelRms,channelMaximum,channelEnergy,channelLast;
    for(size_t ch=0;ch<2;++ch)
    {
        juce::Array<juce::var> p,r;
        for(size_t bin=0;bin<binCount;++bin){p.add(peaks[ch][bin]);r.add(std::sqrt(squares[ch][bin]/juce::jmax(1,counts[bin])));}
        channelPeaks.add(p);channelRms.add(r);channelMaximum.add(maximum[ch]);
        channelEnergy.add(totalEnergy[ch]/rate);channelLast.add(std::sqrt(lastEnergy[ch]/juce::roundToInt(rate*.1)));
    }
    result->setProperty("peak",channelPeaks);result->setProperty("rms",channelRms);
    result->setProperty("maximum",channelMaximum);result->setProperty("energy",channelEnergy);result->setProperty("lastRms",channelLast);
    result->setProperty("claimLevel","diagnostic_only");return result;
}
