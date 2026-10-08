#pragma once
inline juce::var checkMixedEQSketch()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Drawn shelves and cuts");
    bool bounds=true,shapes=true,neutral=true;double worstFit=0,worstGraph=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto hz=BuiltInEQMatch::frequencies(rate);BuiltInEQMatch::Curve flat{};
        const std::array<BuiltInEQMatch::Band,4> targets{{{500,6,.70710678,1,1},{3000,-5,.5,2,1},{250,0,.70710678,3,1},{6000,0,.70710678,4,2}}};
        for(size_t fixture=0;fixture<=targets.size();++fixture)
        {
            BuiltInEQMatch::Curve target{};
            if(fixture<targets.size())target=BuiltInEQMatch::response(targets[fixture],hz,rate);
            else for(const auto& band:{targets[0],targets[2],BuiltInEQMatch::Band{2200,4,1.4,0,1}})
            {const auto curve=BuiltInEQMatch::response(band,hz,rate);for(size_t i=0;i<curve.size();++i)target[i]+=curve[i];}
            const auto fit=BuiltInEQMatch::fit(flat,target,rate,8,false,true);worstFit=juce::jmax(worstFit,fit.after);
            bounds=bounds&&fit.accepted&&fit.bands.size()<=8&&fit.after<=fit.before&&fit.removedLevel==0;
            bool found=false;auto eq=std::make_unique<OpenStudioEQ>(true);for(auto& band:eq->bands)band.enabled.store(0);
            for(size_t i=0;i<fit.bands.size();++i)
            {
                const auto& proposal=fit.bands[i];auto& band=eq->bands[i];
                bounds=bounds&&proposal.type>=0&&proposal.type<=4&&proposal.frequency>=80&&proposal.frequency<=16000&&std::abs(proposal.gain)<=18&&proposal.slope>=0&&proposal.slope<=3;
                found=found||(fixture<targets.size()&&proposal.type==targets[fixture].type);
                band.enabled.store(1);band.type.store(static_cast<float>(proposal.type));band.freq.store(static_cast<float>(proposal.frequency));band.gain.store(static_cast<float>(proposal.gain));band.q.store(static_cast<float>(proposal.q));band.slope.store(static_cast<float>(proposal.slope));
            }
            if(fixture<targets.size())shapes=shapes&&found;
            eq->prepareToPlay(rate,127);std::vector<float> frequencies;for(double f:hz)frequencies.push_back(static_cast<float>(f));const auto graph=eq->getMagnitudeResponse(frequencies);
            for(size_t i=0;i<graph.size();++i)worstGraph=juce::jmax(worstGraph,std::abs(graph[i]-fit.curve[i]));
            auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("fixture",static_cast<int>(fixture));row->setProperty("afterError",fit.after);juce::Array<juce::var> bands;
            for(const auto& band:fit.bands){auto* p=new juce::DynamicObject();p->setProperty("type",band.type);p->setProperty("slope",band.slope);p->setProperty("frequency",band.frequency);p->setProperty("gain",band.gain);p->setProperty("q",band.q);bands.add(p);}row->setProperty("bands",bands);cases.add(row);
        }
        const auto noOp=BuiltInEQMatch::fit(flat,flat,rate,8,false,true);neutral=neutral&&noOp.accepted&&noOp.bands.empty();
    }
    result->setProperty("pass",bounds&&shapes&&neutral&&worstFit<.8&&worstGraph<.05);result->setProperty("bounded",bounds);result->setProperty("shelvesAndCutsSelected",shapes);result->setProperty("neutral",neutral);result->setProperty("maximumFitErrorDB",worstFit);result->setProperty("maximumProductionGraphErrorDB",worstGraph);result->setProperty("cases",cases);result->setProperty("fitError","diagnostic_only");result->setProperty("audioQuality","not_asserted");return result;
}
