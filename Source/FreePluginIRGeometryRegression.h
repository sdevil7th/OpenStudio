#pragma once

inline juce::var checkIRDirectGeometry()
{
    auto* result=new juce::DynamicObject();bool identity=true,tail=true,finite=true,validation=true,portable=true;double gainError=0,arrivalError=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int order:{0,1})
    {
        const int length=juce::roundToInt(rate*.08),direct=juce::roundToInt(rate*.001),reflection=juce::roundToInt(rate*.05);
        juce::AudioBuffer<float> response(4,length),original;response.clear();
        for(int ch=0;ch<4;++ch){response.setSample(ch,direct,static_cast<float>(.1*(ch+1)));response.setSample(ch,reflection,.07f);}
        original.makeCopyOf(response);BuiltInIRGeometry::Settings settings;settings.geometryEnabled=true;
        identity=identity&&BuiltInIRGeometry::apply(response,rate,.005,order,settings);
        for(int ch=0;ch<4;++ch)for(int i=0;i<length;++i)identity=identity&&response.getSample(ch,i)==original.getSample(ch,i);
        settings.geometryPoints[4]={-2,3};settings.geometryPoints[5]={1.5,1};const auto plan=BuiltInIRGeometry::plan(settings,rate);
        validation=validation&&BuiltInIRGeometry::apply(response,rate,.005,order,settings)&&plan.commonDelaySeconds>0;
        for(size_t path=0;path<4;++path)
        {
            const int ch=order==0?static_cast<int>(path):path==1?2:path==2?1:static_cast<int>(path);
            double sum=0,moment=0;for(int i=0;i<reflection;++i){const double value=response.getSample(ch,i);sum+=value;moment+=value*i;finite=finite&&std::isfinite(value);}
            const double expected=original.getSample(ch,direct)*plan.gain[path];gainError=juce::jmax(gainError,std::abs(sum-expected));arrivalError=juce::jmax(arrivalError,std::abs(moment/sum-direct-plan.delaySeconds[path]*rate));
            for(int i=reflection;i<length;++i)tail=tail&&response.getSample(ch,i)==original.getSample(ch,i);
        }
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("order",order);row->setProperty("commonCausalDelayMs",plan.commonDelaySeconds*1000);cases.add(row);
        settings.geometryPoints[4]=settings.geometryPoints[2];validation=validation&&!BuiltInIRGeometry::valid(settings);
    }
    const auto file=juce::File::getCurrentWorkingDirectory().getChildFile("output/ir-geometry-source.wav");juce::AudioBuffer<float> source(4,4800);source.clear();for(int ch=0;ch<4;++ch){source.setSample(ch,48,.1f*(ch+1));source.setSample(ch,2400,.07f);}writeProbeWave(file,source,48000);
    auto convolver=std::make_unique<BuiltInConvolution>();portable=portable&&convolver->loadFile(file);
    auto* edit=new juce::DynamicObject();edit->setProperty("geometryEnabled",true);edit->setProperty("geometryTargetLX",-2);edit->setProperty("geometryTargetLY",3);edit->setProperty("normalise",false);portable=portable&&convolver->edit(edit);
    juce::ValueTree saved("IR");convolver->save(saved);const auto example=convolver->info();auto clone=std::make_unique<BuiltInConvolution>();portable=portable&&clone->restore(saved);juce::ValueTree again("IR");clone->save(again);portable=portable&&saved.isEquivalentTo(again);
    auto* invalid=new juce::DynamicObject();const juce::var invalidValue(invalid);invalid->setProperty("reverse",true);validation=validation&&!convolver->edit(invalidValue);invalid->setProperty("reverse",false);invalid->setProperty("size",.5);validation=validation&&!convolver->edit(invalidValue);juce::ValueTree unchanged("IR");convolver->save(unchanged);validation=validation&&unchanged.isEquivalentTo(saved);
    const auto shapeData=saved["irShape"];const auto* bytes=shapeData.getBinaryData();auto shape=juce::ValueTree::readFromData(bytes->getData(),bytes->getSize());shape.removeProperty("geometryEnabled",nullptr);for(const auto* id:BuiltInIRGeometry::ids)shape.removeProperty(id,nullptr);
    juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);shape.writeToStream(stream);auto old=saved.createCopy();old.setProperty("irShape",juce::var(oldBytes),nullptr);portable=portable&&clone->restore(old)&&!static_cast<bool>(clone->info()["shape"]["geometryEnabled"]);
    result->setProperty("plugin","Declared-geometry direct-path convolution placement");result->setProperty("cases",cases);result->setProperty("identityAudioExact",identity);result->setProperty("measuredLateSamplesUnchanged",tail);result->setProperty("finite",finite);result->setProperty("maximumDirectGainError",gainError);result->setProperty("maximumArrivalErrorSamples",arrivalError);result->setProperty("invalidGeometryAndIncompatibleEditsRejected",validation);result->setProperty("portableAndOldDefaults",portable);result->setProperty("example",example);result->setProperty("acousticPositionAccuracy","not_asserted");result->setProperty("pass",identity&&tail&&finite&&validation&&portable&&gainError<1e-6&&arrivalError<.02);return result;
}
