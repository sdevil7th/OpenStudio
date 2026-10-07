#pragma once
inline juce::var checkNonlinearMotion()
{
    auto* result = new juce::DynamicObject();
    bool influence = true, finite = true, recall = true, retirement = true;
    double zeroError = 0, partition = 0; juce::Array<juce::var> cases;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        // Independent fixed-delay legacy equation, including damping/Householder feedback.
        BuiltInNonlinearTail tail; tail.prepare(rate); tail.configure(2, .5f);
        constexpr std::array<float,8> seconds {.0299f,.0371f,.0437f,.0539f,.0593f,.0677f,.0791f,.0899f};
        std::array<std::vector<float>,8> rings; std::array<size_t,8> positions{};
        std::array<float,8> damping{}, gain{};
        for(size_t i=0;i<8;++i){rings[i].assign(static_cast<size_t>(static_cast<float>(rate)*seconds[i])+1,0);gain[i]=std::pow(.001f,static_cast<float>(rings[i].size())/(static_cast<float>(rate)*2));}
        for(int sample=0;sample<static_cast<int>(rate*.4);++sample)
        {
            const std::array<float,2> input {sample==0?.2f:0,sample==13?-.1f:0};
            const auto actual=tail.process(input);std::array<float,8> taps{};float sum=0;std::array<float,2> expected{};
            for(size_t i=0;i<8;++i){taps[i]=rings[i][positions[i]];sum+=taps[i];}
            for(size_t i=0;i<8;++i){const float reflection=taps[i]-.25f*sum;damping[i]+=(.95f-.5f*.9f)*(reflection-damping[i]);rings[i][positions[i]]=input[i%2]*.22f+damping[i]*gain[i];positions[i]=(positions[i]+1)%rings[i].size();expected[i%2]+=taps[i]*(i<4?.35f:-.35f);}
            for(size_t ch=0;ch<2;++ch)zeroError=juce::jmax(zeroError,std::abs(static_cast<double>(actual[ch]-expected[ch])));
        }
        const auto render=[rate](float depth,float speed,float late,int blockSize,bool switchAway=false,float outgoingChange=0)
        {
            BuiltInAdditionalReverbs engine;engine.prepare(rate,6);
            BuiltInAdditionalReverbs::Settings settings{.3f,.5f,.2f,.5f,0,20,20000,0,1};
            settings.nonlinearModulation=depth;settings.nonlinearRate=speed;settings.lateLevel=late;settings.lateDecay=2;settings.nonlinearFeedback=.95f;settings.nonlinearDiffusion=.5f;
            const int count=static_cast<int>(rate*1.3);std::vector<float> output(static_cast<size_t>(count)*2);
            int start=0;while(start<count){const int size=juce::jmin(blockSize,count-start);auto current=settings;const bool changed=switchAway&&start>=static_cast<int>(rate*.2);if(changed){current.nonlinearModulation=outgoingChange;current.nonlinearRate=8;}engine.configure(changed?0:6,current,switchAway);
                for(int j=0;j<size;++j){const int sample=start+j;const float signal=sample<static_cast<int>(rate*.08)?static_cast<float>(.1*std::sin(sample*.13)):0;const auto wet=engine.process(signal,signal*.6f);output[static_cast<size_t>(sample)*2]=wet[0];output[static_cast<size_t>(sample)*2+1]=wet[1];}start+=size;}
            return output;
        };
        const auto difference=[](const auto& a,const auto& b){double energy=0;for(size_t i=0;i<a.size();++i){const double d=a[i]-b[i];energy+=d*d;}return energy;};
        const auto base=render(0,.7f,0,127), early=render(.8f,.7f,0,127), faster=render(.8f,3,0,127), otherBlock=render(.8f,.7f,0,511);
        const double earlyDelta=difference(base,early),rateDelta=difference(early,faster);
        influence=influence&&earlyDelta>1e-5&&rateDelta>1e-5&&difference(base,render(0,8,0,127))==0;
        for(size_t i=0;i<early.size();++i){partition=juce::jmax(partition,std::abs(static_cast<double>(early[i]-otherBlock[i])));finite=finite&&std::isfinite(early[i])&&std::abs(early[i])<8;}
        // Isolate late-network modulation from the moving generator.
        BuiltInNonlinearTail still,moving;still.prepare(rate);moving.prepare(rate);still.configure(2,.2f);moving.configure(2,.2f);double lateDelta=0;
        for(int i=0;i<static_cast<int>(rate*.6);++i){const std::array<float,2> input{i==0?.2f:0,i==10?.1f:0};const double angle=juce::MathConstants<double>::twoPi*.7*i/rate;const auto a=still.process(input),b=moving.process(input,static_cast<float>(rate*.0016),static_cast<float>(std::sin(angle)),static_cast<float>(std::cos(angle)));for(size_t ch=0;ch<2;++ch){lateDelta+=std::abs(a[ch]-b[ch]);finite=finite&&std::isfinite(b[ch]);}}
        influence=influence&&lateDelta>1e-3;
        retirement=retirement&&difference(render(.8f,.7f,1,127,true,0),render(.8f,.7f,1,127,true,1))==0;
        const auto combined=render(1,8,1,127);for(float sample:combined)finite=finite&&std::isfinite(sample)&&std::abs(sample)<8;
        auto* row=new juce::DynamicObject();row->setProperty("rate",rate);row->setProperty("earlyDifferenceEnergy",earlyDelta);row->setProperty("rateDifferenceEnergy",rateDelta);row->setProperty("lateDifference",lateDelta);cases.add(row);
    }
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);source->selectAlgorithm(6);
    recall=setFreePluginParamForRegression(*source,"nonlinearModulation",.8f)&&setFreePluginParamForRegression(*source,"nonlinearRate",3);
    juce::MemoryBlock bytes,again;source->getStateInformation(bytes);copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));copy->getStateInformation(again);recall=recall&&bytes==again&&copy->nonlinearModulation.load()==.8f&&copy->nonlinearRate.load()==3;
    auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());tree.removeProperty("nonlinearModulation",nullptr);tree.removeProperty("nonlinearRate",nullptr);bytes.reset();{juce::MemoryOutputStream stream(bytes,false);tree.writeToStream(stream);}copy->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));recall=recall&&copy->nonlinearModulation.load()==0&&copy->nonlinearRate.load()==.7f;
    const auto schema=describeFreePluginForRegression(*source);recall=recall&&schema["parameters"][1077]["id"].toString()=="nonlinearModulation"&&schema["parameters"][1078]["id"].toString()=="nonlinearRate";
    result->setProperty("plugin","Nonlinear reflection and late-network modulation");result->setProperty("cases",cases);result->setProperty("zeroDepthLegacyTailError",zeroError);result->setProperty("partitionError",partition);result->setProperty("independentEarlyLateAndRateInfluence",influence);result->setProperty("finiteHighFeedback",finite);result->setProperty("retiringSettingsRetained",retirement);result->setProperty("stateDefaultsAppend",recall);result->setProperty("schema",schema);result->setProperty("referenceSound","not_asserted");result->setProperty("pass",zeroError==0&&partition==0&&influence&&finite&&recall&&retirement);return result;
}
