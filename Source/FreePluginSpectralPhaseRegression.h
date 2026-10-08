#pragma once
#include "BuiltInSpectralPhaseFit.h"

inline juce::var checkSpectralPhaseAlignment()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Saved spectral phase FIR alignment");
    bool neutral = true, recall = true, partition = true, finite = true, fitted = true, rejected = true;
    double magnitudeError = 0, phaseError = 0; juce::Array<juce::var> cases;
    const auto render = [](OpenStudioUtilityEffect& processor, int blockSize)
    {
        constexpr int length = 8192; juce::AudioBuffer<float> audio(2,length), block(2,blockSize); juce::MidiBuffer midi;
        for(int start=0;start<length;start+=blockSize)
        {
            const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);block.clear();
            if(start==0){block.setSample(0,0,1);block.setSample(1,0,1);}
            processor.processBlock(block,midi);for(int ch=0;ch<2;++ch)audio.copyFrom(ch,start,block,ch,0,count);
        }
        return audio;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        auto processor=std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::GainPhase);processor->setNonRealtime(true);
        processor->setControl("spectralPhaseEnabled",1);processor->prepareToPlay(rate,512);
        const auto unity=render(*processor,127);const int latency=processor->getLatencySamples();
        neutral=neutral&&latency==2304;
        for(int i=0;i<unity.getNumSamples();++i)neutral=neutral&&std::abs(unity.getSample(0,i)-(i==latency?1.0f:0))<1e-6f;
        for(size_t point=0;point<BuiltInSpectralPhaseCurve::points;++point)
        {
            const double hz=BuiltInSpectralPhaseCurve::frequency(point);
            const float phase=static_cast<float>(75*std::sin(std::log(hz/20)/std::log(1000.0)*juce::MathConstants<double>::pi));
            processor->setControl("spectralPhaseL"+juce::String(static_cast<int>(point)),phase);
            processor->setControl("spectralPhaseR"+juce::String(static_cast<int>(point)),-phase);
        }
        processor->prepareToPlay(rate,512);const auto shaped=render(*processor,127);
        processor->prepareToPlay(rate,512);const auto whole=render(*processor,512);
        for(int ch=0;ch<2;++ch)for(int i=0;i<shaped.getNumSamples();++i)
        {finite=finite&&std::isfinite(shaped.getSample(ch,i));partition=partition&&shaped.getSample(ch,i)==whole.getSample(ch,i);}
        const auto snapshot=processor->spectralSnapshot();
        for(double hz:{300.0,1000.0,3000.0,10000.0})for(size_t ch=0;ch<2;++ch)
        {
            const double omega=juce::MathConstants<double>::twoPi*hz/rate;const auto z=std::polar(1.0,-omega);std::complex<double> sum{},osc=1;
            for(int i=0;i<shaped.getNumSamples();++i){sum+=osc*static_cast<double>(shaped.getSample(static_cast<int>(ch),i));osc*=z;}
            sum*=std::polar(1.0,omega*latency);
            magnitudeError=juce::jmax(magnitudeError,std::abs(juce::Decibels::gainToDecibels(std::abs(sum),-120.0)));
            phaseError=juce::jmax(phaseError,std::abs(std::remainder(std::arg(sum)-BuiltInSpectralPhaseCurve::radians(snapshot.phaseCurves[ch],hz,rate),juce::MathConstants<double>::twoPi)));
        }
        juce::MemoryBlock state;processor->getStateInformation(state);
        auto restored=std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::GainPhase);restored->setNonRealtime(true);restored->prepareToPlay(rate,512);restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
        const auto restoredAudio=render(*restored,127);recall=recall&&restored->getLatencySamples()==2304;
        for(int ch=0;ch<2;++ch)for(int i=0;i<shaped.getNumSamples();++i)recall=recall&&shaped.getSample(ch,i)==restoredAudio.getSample(ch,i);
        restored->setControl("bypass",1);restored->prepareToPlay(rate,512);const auto bypass=render(*restored,127);
        for(int i=0;i<bypass.getNumSamples();++i)neutral=neutral&&bypass.getSample(0,i)==(i==latency?1.0f:0);
        juce::ValueTree legacy("OpenStudioGainPhase");legacy.setProperty("gain",0,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);legacy.writeToStream(stream);
        restored->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&restored->getLatencySamples()==0&&restored->values[14].load()==0;
        const int count=static_cast<int>(rate*.5);std::vector<float> source(static_cast<size_t>(count)),reference(source.size()),target(source.size());juce::Random random(71718);
        BuiltInPhaseAlignment a,b;a.prepare(rate);b.prepare(rate);
        a.configure({BuiltInPhaseAlignment::Channel{1,350,0},BuiltInPhaseAlignment::Channel{}});b.configure({BuiltInPhaseAlignment::Channel{1,2300,0},BuiltInPhaseAlignment::Channel{}});
        for(int i=0;i<count;++i){source[static_cast<size_t>(i)]=(random.nextFloat()*2-1)*.1f;reference[static_cast<size_t>(i)]=b.process(0,a.process(0,source[static_cast<size_t>(i)]));target[static_cast<size_t>(i)]=i>=37?source[static_cast<size_t>(i-37)]:0;}
        const auto timing=estimateBuiltInAlignment(reference.data(),target.data(),count);
        const auto fit=fitBuiltInSpectralPhase({reference.data(),nullptr},{target.data(),nullptr},1,count,rate,timing);
        fitted=fitted&&fit.applied&&fit.after>.95;
        const auto flat=fitBuiltInSpectralPhase({source.data(),nullptr},{target.data(),nullptr},1,count,rate,estimateBuiltInAlignment(source.data(),target.data(),count));rejected=rejected&&!flat.applied;
        const auto conflict=fitBuiltInSpectralPhase({reference.data(),source.data()},{target.data(),target.data()},2,count,rate,timing);rejected=rejected&&!conflict.applied;
        const auto cancel=fitBuiltInSpectralPhase({reference.data(),nullptr},{target.data(),nullptr},1,count,rate,timing,[]{return false;});rejected=rejected&&!cancel.applied;
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("timingAccepted",timing.accepted);row->setProperty("timingLag",timing.lag);row->setProperty("applied",fit.applied);row->setProperty("before",fit.before);row->setProperty("after",fit.after);row->setProperty("rippleDB",fit.maximumRippleDB);row->setProperty("reason",fit.reason);cases.add(row);
    }
    result->setProperty("pass",neutral&&recall&&partition&&finite&&fitted&&rejected&&magnitudeError<.2&&phaseError<.03);
    result->setProperty("neutralAndBypassLatency",neutral);result->setProperty("stateAndLegacy",recall);result->setProperty("partitionExact",partition);result->setProperty("finite",finite);result->setProperty("knownTwoCornerPhaseRecovered",fitted);result->setProperty("flatConflictCanceledRejected",rejected);result->setProperty("maximumMagnitudeErrorDB",magnitudeError);result->setProperty("maximumPhaseErrorRadians",phaseError);result->setProperty("cases",cases);result->setProperty("phaseAgreement","diagnostic_only");result->setProperty("audioQuality","not_asserted");return result;
}
