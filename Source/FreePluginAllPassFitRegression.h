#pragma once
inline juce::var checkAllPassFitting()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Bounded automatic all-pass phase fit");
    bool fitted=true,timeOnly=true,rejected=true,linked=true,conflict=true;double worstError=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const int count=juce::jmin(65536,static_cast<int>(rate*.5));std::vector<float> source(static_cast<size_t>(count)),reference(source.size()),target(source.size());
        juce::Random random(7293);double previous=0;
        for(int i=0;i<count;++i){previous=.5*previous+.5*(random.nextFloat()*2-1);source[static_cast<size_t>(i)]=static_cast<float>(previous*.1);target[static_cast<size_t>(i)]=i>=37?source[static_cast<size_t>(i-37)]:0;}
        for(int stages:{1,2})
        {
            BuiltInPhaseAlignment phase;phase.prepare(rate);phase.configure({BuiltInPhaseAlignment::Channel{1,500,static_cast<float>(stages-1)},BuiltInPhaseAlignment::Channel{1,500,static_cast<float>(stages-1)}});
            for(int i=0;i<count;++i)reference[static_cast<size_t>(i)]=phase.process(0,source[static_cast<size_t>(i)]);
            const auto timing=estimateBuiltInAlignment(reference.data(),target.data(),count);
            const auto fit=fitBuiltInAllPass({reference.data(),nullptr},{target.data(),nullptr},1,count,rate,timing);
            fitted=fitted&&timing.accepted&&fit.applied&&fit.after>.98&&fit.after>fit.before+.025&&std::abs(fit.lag-37)<1;
            BuiltInPhaseAlignment fittedPhase;fittedPhase.prepare(rate);fittedPhase.configure({BuiltInPhaseAlignment::Channel{fit.applied?1.0f:0.0f,static_cast<float>(fit.frequency),static_cast<float>(fit.stages-1)},BuiltInPhaseAlignment::Channel{}});
            double error=0,energy=0;for(int i=0;i<count;++i){const double actual=fittedPhase.process(0,source[static_cast<size_t>(i)])*(fit.invert?-1:1);if(i>1024){const double expected=reference[static_cast<size_t>(i)];error+=(actual-expected)*(actual-expected);energy+=expected*expected;}}
            const double relative=std::sqrt(error/juce::jmax(1e-20,energy));worstError=juce::jmax(worstError,relative);
            auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("sourceStages",stages);row->setProperty("sourceFrequency",500);row->setProperty("timeCorrelation",timing.correlation);row->setProperty("timePeakRatio",timing.peakRatio);row->setProperty("timingAccepted",timing.accepted);row->setProperty("timingLag",timing.lag);row->setProperty("applied",fit.applied);row->setProperty("frequency",fit.frequency);row->setProperty("stages",fit.stages);row->setProperty("lag",fit.lag);row->setProperty("invert",fit.invert);row->setProperty("before",fit.before);row->setProperty("after",fit.after);row->setProperty("filterRelativeErrorDiagnostic",relative);row->setProperty("reason",fit.reason);cases.add(row);
            if(rate==48000&&stages==1){const auto common=fitBuiltInAllPass({reference.data(),reference.data()},{target.data(),target.data()},2,count,rate,timing);linked=common.applied&&std::abs(common.lag-fit.lag)<1e-9&&std::abs(common.frequency-fit.frequency)<1e-6;
                const auto disagreement=fitBuiltInAllPass({reference.data(),source.data()},{target.data(),target.data()},2,count,rate,timing);conflict=conflict&&!disagreement.applied;}
        }
        const auto timing=estimateBuiltInAlignment(source.data(),target.data(),count);const auto flat=fitBuiltInAllPass({source.data(),nullptr},{target.data(),nullptr},1,count,rate,timing);timeOnly=timeOnly&&!flat.applied&&flat.lag==timing.lag&&flat.invert==timing.invert;
        for(int i=0;i<count;++i)reference[static_cast<size_t>(i)]=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*1000*i/rate));
        BuiltInAlignmentEstimate forced;forced.accepted=true;const auto narrow=fitBuiltInAllPass({reference.data(),nullptr},{reference.data(),nullptr},1,count,rate,forced);rejected=rejected&&!narrow.applied;
        const auto cancel=fitBuiltInAllPass({source.data(),nullptr},{target.data(),nullptr},1,count,rate,forced,[]{return false;});rejected=rejected&&!cancel.applied;
    }
    result->setProperty("pass",fitted&&timeOnly&&rejected&&linked&&conflict);result->setProperty("knownAllPassRecovered",fitted);result->setProperty("timeOnlyPreserved",timeOnly);result->setProperty("narrowAndCanceledRejected",rejected);result->setProperty("linkedCommonFit",linked);result->setProperty("linkedNoWorsening",conflict);result->setProperty("filterErrorDiagnostic",worstError);result->setProperty("cases",cases);result->setProperty("audioQuality","not_asserted");return result;
}
