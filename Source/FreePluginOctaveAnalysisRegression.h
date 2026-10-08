#pragma once

inline juce::var checkOctaveIRAnalysis()
{
    auto* result=new juce::DynamicObject();juce::Array<juce::var> cases;
    bool bands=true,rejections=true,state=true,audioSame=true;double edgeError=0,peakError=0,decayError=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(size_t band=0;band<10;++band)
    {
        BuiltInOctaveAnalysis filter;const bool usable=filter.prepare(band,rate);
        if(!usable){bands=bands&&filter.high>=rate*.49;continue;}
        edgeError=juce::jmax(edgeError,std::abs(20*std::log10(filter.magnitude(filter.low,rate))+3.01029995664),std::abs(20*std::log10(filter.magnitude(filter.high,rate))+3.01029995664));
        peakError=juce::jmax(peakError,std::abs(filter.magnitude(filter.peakFrequency,rate)-1));
        juce::AudioBuffer<float> response(1,juce::roundToInt(rate*3));
        for(int i=0;i<response.getNumSamples();++i)response.setSample(0,i,static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*filter.centre*i/rate)*std::exp(-6.907755278982137*i/(rate*2))));
        const auto estimate=BuiltInIRDecay::analyzeOctave(response,rate,.2,band);
        bands=bands&&estimate.available;decayError=juce::jmax(decayError,std::abs(estimate.rt60-2));
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("nominalHz",BuiltInOctaveAnalysis::nominal[band]);row->setProperty("rt60",estimate.rt60);row->setProperty("available",estimate.available);row->setProperty("reason",estimate.reason);row->setProperty("ringLimit",estimate.minimumReliableRT60);cases.add(row);
    }
    juce::AudioBuffer<float> silent(1,48000);silent.clear();rejections=rejections&&!BuiltInIRDecay::analyzeOctave(silent,48000,0,5).available;
    silent.setSize(1,512);rejections=rejections&&!BuiltInIRDecay::analyzeOctave(silent,48000,0,5).available;
    silent.setSize(1,48000);for(int i=0;i<silent.getNumSamples();++i)silent.setSample(0,i,static_cast<float>(.1*std::sin(i*.13)));
    rejections=rejections&&!BuiltInIRDecay::analyzeOctave(silent,48000,0,5).available&&!BuiltInIRDecay::analyzeOctave(silent,48000,0,5,[]{return false;}).available;
    auto original=std::make_unique<BuiltInConvolution>();state=state&&original->selectDefault();juce::ValueTree before("IR");original->save(before);
    auto* edit=new juce::DynamicObject();edit->setProperty("octaveAnalysis",true);state=state&&original->edit(edit);juce::ValueTree after("IR");original->save(after);const auto example=original->info();
    state=state&&original->info()["decayEstimate"]["octaves"].size()==10&&before["irData"]==after["irData"];
    auto plain=std::make_unique<BuiltInConvolution>(),analyzed=std::make_unique<BuiltInConvolution>();state=state&&plain->restore(before)&&analyzed->restore(after);plain->prepare(48000,512);analyzed->prepare(48000,512);
    juce::AudioBuffer<float> a(2,512),b(2,512);
    for(int block=0;block<100;++block)
    {
        a.clear();if(block==0)a.setSample(0,0,.2f);b.makeCopyOf(a);plain->process(a,0,20,20000,1,true,false);analyzed->process(b,0,20,20000,1,true,false);
        for(int ch=0;ch<2;++ch)for(int i=0;i<512;++i)audioSame=audioSame&&a.getSample(ch,i)==b.getSample(ch,i);
    }
    auto old=before.createCopy();const auto shapeData=old["irShape"];const auto* bytes=shapeData.getBinaryData();auto oldShape=juce::ValueTree::readFromData(bytes->getData(),bytes->getSize());oldShape.removeProperty("octaveAnalysis",nullptr);juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);oldShape.writeToStream(stream);old.setProperty("irShape",juce::var(oldBytes),nullptr);
    state=state&&original->restore(old)&&!static_cast<bool>(original->info()["shape"]["octaveAnalysis"])&&original->info()["decayEstimate"]["octaves"].isVoid();
    result->setProperty("example",example);result->setProperty("plugin","Frequency-verified octave IR decay diagnostics");result->setProperty("cases",cases);result->setProperty("bandsAvailableWhereSupported",bands);result->setProperty("maximumEdgeErrorDB",edgeError);result->setProperty("maximumPeakGainError",peakError);result->setProperty("maximumKnownDecayErrorSeconds",decayError);result->setProperty("invalidSilenceShortConstantCancellationRejected",rejections);result->setProperty("portableAnalysisAndOldDefaults",state);result->setProperty("analysisAudioExactParity",audioSame);result->setProperty("certification","not_asserted");result->setProperty("acousticMeasurementAccuracy","diagnostic_only");result->setProperty("pass",bands&&rejections&&state&&audioSame&&edgeError<1e-6&&peakError<1e-9&&decayError<.08);return result;
}
