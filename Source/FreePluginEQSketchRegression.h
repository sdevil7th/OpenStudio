juce::var checkEQSketch()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Drawn EQ correction fitting");juce::Array<juce::var> cases;bool bounded=true,retained=true;double worst=0;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        BuiltInEQMatch::Curve flat{};const auto hz=BuiltInEQMatch::frequencies(rate);auto target=BuiltInEQMatch::response({500,6,.7},hz,rate);const auto second=BuiltInEQMatch::response({4000,-4,1.4},hz,rate);for(size_t i=0;i<target.size();++i)target[i]+=second[i];
        const auto fit=BuiltInEQMatch::fit(flat,target,rate,8,false);worst=juce::jmax(worst,fit.after);retained=retained&&fit.removedLevel==0&&fit.target==target&&fit.accepted;
        for(const auto& band:fit.bands)bounded=bounded&&band.frequency>=80&&band.frequency<=16000&&std::abs(band.gain)<=9&&band.q>=.35&&band.q<=3;
        const auto match=BuiltInEQMatch::fit(flat,target,rate,8);double mean=0;for(const auto value:target)mean+=value/target.size();retained=retained&&std::abs(match.removedLevel-mean)<1e-10;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("bands",static_cast<int>(fit.bands.size()));row->setProperty("errorDb",fit.after);row->setProperty("meanKept",mean);cases.add(row);
    }
    BuiltInEQMatch::Curve flat{};const auto noOp=BuiltInEQMatch::fit(flat,flat,48000,8,false);const bool neutral=noOp.accepted&&noOp.bands.empty()&&noOp.after==0;
    result->setProperty("pass",bounded&&retained&&neutral&&worst<.6);result->setProperty("boundedBells",bounded);result->setProperty("drawingLevelKeptAndMatchUnchanged",retained);result->setProperty("neutralNoOp",neutral);result->setProperty("maximumErrorDb",worst);result->setProperty("cases",cases);result->setProperty("curveApproximation","diagnostic_only");result->setProperty("audioQuality","not_asserted");return result;
}
