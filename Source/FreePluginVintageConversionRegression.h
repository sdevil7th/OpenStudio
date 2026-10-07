#pragma once
inline juce::var checkVintageConversion()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Prepared Vintage wet-return converter");
    bool conversion=true,finite=true,legacy=true,clock=true,reset=true,dry=true,wetChanged=true,recall=true;double partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,double target,int bits,double hz,int blockSize)
    {
        BuiltInVintageConverter::Bank bank;bank.prepare(rate,target,bits);const int count=static_cast<int>(rate*.3);std::vector<float> output(static_cast<size_t>(count));
        for(int start=0;start<count;start+=blockSize)for(int i=start;i<juce::jmin(count,start+blockSize);++i){const float value=static_cast<float>(.25*std::sin(juce::MathConstants<double>::twoPi*hz*i/rate));output[static_cast<size_t>(i)]=bank.process({value,-value})[0];}return output;
    };
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    for(const auto& format:std::array<std::pair<double,int>,2>{{{24000,12},{48000,16}}})
    {
        const auto targetRate=format.first;const int bits=format.second;const bool stopAvailable=rate>targetRate;
        const auto pass=render(rate,targetRate,bits,997,127),stop=render(rate,targetRate,bits,targetRate==24000?20000:30000,127),changedBlock=render(rate,targetRate,bits,997,511);
        double passEnergy=0,stopEnergy=0;const int skip=static_cast<int>(rate*.1);
        for(size_t i=0;i<pass.size();++i){finite=finite&&std::isfinite(pass[i])&&std::isfinite(stop[i]);partition=juce::jmax(partition,std::abs(static_cast<double>(pass[i]-changedBlock[i])));if(static_cast<int>(i)>=skip){passEnergy+=pass[i]*pass[i];stopEnergy+=stop[i]*stop[i];}}
        const double passRms=std::sqrt(passEnergy/(pass.size()-static_cast<size_t>(skip))),stopRms=std::sqrt(stopEnergy/(stop.size()-static_cast<size_t>(skip)));
        conversion=conversion&&passRms>.16&&passRms<.19&&(!stopAvailable||stopRms<.001);
        BuiltInVintageConverter::Bank bank;bank.prepare(rate,targetRate,bits);for(int i=0;i<static_cast<int>(rate);++i)bank.process({.123f,-.123f});clock=clock&&std::abs(static_cast<double>(bank.ticks)-juce::jmin(rate,targetRate))<=1;const auto dc=bank.process({.123f,-.123f});conversion=conversion&&std::abs(dc[0]-bank.quantize(.123f))<1e-5&&dc[0]==-dc[1];bank.reset();for(int i=0;i<static_cast<int>(rate*.01);++i)reset=reset&&bank.process({0,0})==std::array<float,2>{};
        BuiltInVintageConverter processor;processor.prepare(rate);processor.configure(false,0);for(int i=0;i<1000;++i){const std::array<float,2> original{static_cast<float>(i)*.00001f,-static_cast<float>(i)*.00002f};legacy=legacy&&processor.process({.5f,.1f},original)==original;}processor.reset();processor.configure(true,2);legacy=legacy&&processor.process({.5f,.1f},{.125f,-.25f})==std::array<float,2>{.125f,-.25f};
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("targetRate",targetRate);row->setProperty("compandedBits",bits);row->setProperty("stopProbeAvailable",stopAvailable);row->setProperty("passbandRms",passRms);row->setProperty("stopbandRms",stopRms);row->setProperty("stopRelativeDbDiagnostic",stopAvailable&&stopRms>0?juce::var(20*std::log10(stopRms/.176776695)):juce::var());row->setProperty("stopProbeQuantizedToZero",stopAvailable&&stopRms==0);cases.add(row);
    }
    for(int type:{10,11})
    {
        auto a=std::make_unique<OpenStudioReverb>(true),b=std::make_unique<OpenStudioReverb>(true);a->selectAlgorithm(type);b->selectAlgorithm(type);a->wetLevel.store(0);b->wetLevel.store(0);a->dryLevel.store(1);b->dryLevel.store(1);b->vintageConversion[b->vintageSlot()].store(1);a->prepareToPlay(48000,127);b->prepareToPlay(48000,127);juce::AudioBuffer<float> left(2,127),right(2,127);juce::MidiBuffer midi;
        for(int block=0;block<100;++block){for(int i=0;i<127;++i)for(int ch=0;ch<2;++ch)left.setSample(ch,i,static_cast<float>(.1*std::sin((block*127+i)*.13)));right.makeCopyOf(left,true);a->processBlock(left,midi);b->processBlock(right,midi);for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)dry=dry&&left.getSample(ch,i)==right.getSample(ch,i);}
        a->wetLevel.store(1);b->wetLevel.store(1);a->dryLevel.store(0);b->dryLevel.store(0);double difference=0;
        for(int block=100;block<200;++block){for(int i=0;i<127;++i)for(int ch=0;ch<2;++ch)left.setSample(ch,i,static_cast<float>(.1*std::sin((block*127+i)*.13)));right.makeCopyOf(left,true);a->processBlock(left,midi);b->processBlock(right,midi);for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i){difference+=std::abs(left.getSample(ch,i)-right.getSample(ch,i));finite=finite&&std::isfinite(right.getSample(ch,i));}}wetChanged=wetChanged&&difference>.01;
    }
    auto original=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);original->selectAlgorithm(10);const bool setters=setFreePluginParamForRegression(*original,"vintageConversion",1)&&setFreePluginParamForRegression(*original,"vintage1.conversion",1);juce::MemoryBlock state,again;original->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);recall=state==again&&copy->vintageConversion[0].load()==1&&copy->vintageConversion[1].load()==1;
    auto tree=juce::ValueTree::readFromData(state.getData(),static_cast<int>(state.getSize()));tree.removeProperty("vintage0Conversion",nullptr);tree.removeProperty("vintage1Conversion",nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->vintageConversion[0].load()==0&&copy->vintageConversion[1].load()==0;
    const auto schema=describeFreePluginForRegression(*original);const bool appended=schema["parameters"].size()>=521&&schema["parameters"][518]["id"].toString()=="vintageConversion"&&schema["parameters"][520]["id"].toString()=="vintage1.conversion";
    result->setProperty("pass",conversion&&finite&&legacy&&clock&&reset&&dry&&wetChanged&&recall&&setters&&appended&&partition==0);result->setProperty("conversionResponse",conversion);result->setProperty("finite",finite);result->setProperty("legacyAndModernExact",legacy);result->setProperty("converterClock",clock);result->setProperty("resetSilence",reset);result->setProperty("dryParity",dry);result->setProperty("wetPathChanged",wetChanged);result->setProperty("stateLegacyDefaults",recall);result->setProperty("setters",setters);result->setProperty("appendedDescriptors",appended);result->setProperty("partitionError",partition);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
