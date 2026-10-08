#pragma once

inline juce::var checkPitchBoundedLagParity()
{
    // Preserve the old full-lag YIN calculation as an oracle for the optimization.
    const auto original=[](const float* frame,double rate,float minimum,float maximum)
    {
        std::array<float,1024> yin{};yin[0]=1;float running=0;
        const int low=static_cast<int>(rate/maximum),high=juce::jmin(1023,static_cast<int>(rate/minimum));
        if(high<=low)return std::array<float,2>{0,0};
        for(int lag=1;lag<1024;++lag){float sum=0;for(int j=0;j<1024;++j){const float delta=frame[j]-frame[j+lag];sum+=delta*delta;}running+=sum;yin[static_cast<size_t>(lag)]=running>0?sum*static_cast<float>(lag)/running:0;}
        int selected=-1;float best=.15f;
        for(int lag=low;lag<=high;++lag)if(yin[static_cast<size_t>(lag)]<best){while(lag+1<=high&&yin[static_cast<size_t>(lag+1)]<yin[static_cast<size_t>(lag)])++lag;selected=lag;best=yin[static_cast<size_t>(lag)];break;}
        if(selected<0){selected=low;best=yin[static_cast<size_t>(low)];for(int lag=low+1;lag<=high;++lag)if(yin[static_cast<size_t>(lag)]<best){selected=lag;best=yin[static_cast<size_t>(lag)];}}
        float refined=static_cast<float>(selected);
        if(selected>0&&selected<1023){const float a=yin[static_cast<size_t>(selected-1)],b=yin[static_cast<size_t>(selected)],c=yin[static_cast<size_t>(selected+1)],denominator=2*(2*b-c-a);if(std::abs(denominator)>=1e-10f)refined+=(c-a)/denominator;}
        float frequency=refined>0?static_cast<float>(rate)/refined:0,confidence=juce::jlimit(0.0f,1.0f,1-best);
        if(frequency<minimum||frequency>maximum){frequency=0;confidence=0;}return std::array<float,2>{frequency,confidence};
    };
    bool pass=true;int cases=0;double error=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(float minimum:{40.0f,80.0f,220.0f})for(double frequency:{82.0,220.0,440.0,997.0})
    {
        PitchDetector detector;detector.prepare(rate,128);detector.setMinFrequency(minimum);detector.setMaxFrequency(1200);
        std::array<float,2048> frame{};for(size_t i=0;i<frame.size();++i)frame[i]=static_cast<float>(.15*std::sin(juce::MathConstants<double>::twoPi*frequency*i/rate)+.02*std::sin(.723*i));
        detector.processSamples(frame.data(),static_cast<int>(frame.size()));const auto expected=original(frame.data(),rate,minimum,1200);
        error=juce::jmax<double>(error,std::abs(detector.getDetectedFrequency()-expected[0]),std::abs(detector.getConfidence()-expected[1]));
        pass=pass&&detector.getDetectedFrequency()==expected[0]&&detector.getConfidence()==expected[1];++cases;
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","YIN bounded-lag optimization parity");result->setProperty("cases",cases);result->setProperty("maximumError",error);result->setProperty("pass",pass);result->setProperty("audioQuality","not_asserted");return result;
}
