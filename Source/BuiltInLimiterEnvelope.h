#pragma once
#include <JuceHeader.h>

// Original two-stage limiter control law. No allocation or locking in process.
// Each safety queue retains all peaks whose FIR support can reach the output.
class BuiltInLimiterEnvelope
{
public:
    void prepare(double sampleRate, size_t window)
    {
        rate=sampleRate;
        for(auto& channel:channels){channel.peaks.resize(window);channel.times.resize(window);}
        blend.reset(rate,.01);transientLink.reset(rate,.01);releaseLink.reset(rate,.01);
        for(auto& weight:strategyWeights)weight.reset(rate,.02);
        reset();
    }
    void reset()
    {
        for(auto& channel:channels){channel.fast=channel.safety=1;channel.slow=channel.exposure=0;channel.hold=0;channel.head=channel.count=0;channel.clock=0;}
        blend.setCurrentAndTargetValue(0);transientLink.setCurrentAndTargetValue(1);releaseLink.setCurrentAndTargetValue(1);
        strategies={};strategyAwake=false;for(auto& weight:strategyWeights)weight.setCurrentAndTargetValue(0);
    }
    void configure(int style,float releaseMs,float attackMs,bool automatic,float transients,float release)
    {
        blend.setTargetValue(style>0?1.0f:0.0f);
        transientLink.setTargetValue(juce::jlimit(0.0f,1.0f,transients));releaseLink.setTargetValue(juce::jlimit(0.0f,1.0f,release));
        const int mode=juce::jlimit(1,3,style);const float fastFactor=mode==1?.1f:mode==2?.25f:.5f,slowFactor=mode==1?.5f:mode==2?1.0f:2.0f;
        fastRelease=coefficient(releaseMs*fastFactor);fastLong=coefficient(releaseMs*fastFactor*4);
        slowRelease=coefficient(releaseMs*slowFactor);slowLong=coefficient(releaseMs*slowFactor*4);
        slowAttack=coefficient(attackMs);exposureAttack=coefficient(50);exposureRelease=coefficient(500);
        safetyRelease=coefficient(releaseMs);useAutomatic=automatic;
        for(size_t i=0;i<strategyWeights.size();++i)strategyWeights[i].setTargetValue(style==static_cast<int>(i)+4?1.0f:0.0f);
        rmsFast=coefficient(4);rmsBus=coefficient(10);crestRelease=coefficient(15);
        crestFast=coefficient(releaseMs*.04f);crestSlow=coefficient(releaseMs*.6f);
        busFast=coefficient(releaseMs*.25f);busRelease=coefficient(releaseMs*.8f);busLong=coefficient(releaseMs*3.2f);
        edgeRelease=coefficient(juce::jmax(.5f,releaseMs*.04f));
        gentleFast=coefficient(releaseMs*.6f);gentleAttack=coefficient(attackMs*.5f);
        gentleRelease=coefficient(releaseMs*1.5f);gentleLong=coefficient(releaseMs*3);
    }
    std::array<float,2> process(const std::array<float,2>& detector,const std::array<float,2>& reconstructed,float threshold,int holdSamples,bool truePeak)
    {
        std::array<float,2> fast{},slow{},safety{};
        for(size_t ch=0;ch<2;++ch)
        {
            auto& state=channels[ch];const float requested=juce::jmin(1.0f,threshold/juce::jmax(1.0e-9f,detector[ch]));
            const float reduction=-juce::Decibels::gainToDecibels(requested,-100.0f);
            const float exposureTarget=juce::jlimit(0.0f,1.0f,reduction/12);
            const float exposureCoefficient=exposureTarget>state.exposure?exposureAttack:exposureRelease;
            state.exposure=exposureCoefficient*state.exposure+(1-exposureCoefficient)*exposureTarget;
            const float memory=useAutomatic?state.exposure:0;
            const float fastCoefficient=fastRelease+memory*(fastLong-fastRelease);
            if(requested<=state.fast){state.fast=requested;state.hold=holdSamples;}
            else if(state.hold>0)--state.hold;
            else state.fast=fastCoefficient*state.fast+(1-fastCoefficient)*requested;
            const float slowCoefficient=reduction>state.slow?slowAttack:slowRelease+memory*(slowLong-slowRelease);
            state.slow=slowCoefficient*state.slow+(1-slowCoefficient)*reduction;
            const size_t capacity=state.peaks.size();
            while(state.count>0&&state.times[state.head]+capacity-1<=state.clock){state.head=(state.head+1)%capacity;--state.count;}
            while(state.count>0&&state.peaks[(state.head+state.count-1)%capacity]<=reconstructed[ch])--state.count;
            const size_t tail=(state.head+state.count)%capacity;state.peaks[tail]=reconstructed[ch];state.times[tail]=state.clock++;++state.count;
            const float safetyTarget=juce::jmin(1.0f,threshold*.9440609f/juce::jmax(1.0e-9f,state.peaks[state.head]));
            if(safetyTarget<=state.safety)state.safety=safetyTarget;
            else state.safety=safetyRelease*state.safety+(1-safetyRelease)*safetyTarget;
            fast[ch]=state.fast;slow[ch]=state.slow;safety[ch]=state.safety;
        }
        const float transients=transientLink.getNextValue(),release=releaseLink.getNextValue();
        const float minimumFast=juce::jmin(fast[0],fast[1]),maximumSlow=juce::jmax(slow[0],slow[1]),minimumSafety=juce::jmin(safety[0],safety[1]);
        std::array<float,4> weights{};float strategyMix=0;
        for(size_t i=0;i<weights.size();++i){weights[i]=strategyWeights[i].getNextValue();strategyMix+=weights[i];}
        std::array<std::array<float,2>,4> strategyFast{},strategySlow{};
        if(strategyMix<=0)strategyAwake=false;
        if(strategyMix>0)
        {
            if(!strategyAwake){strategies={};strategyAwake=true;}
            const float thresholdDb=juce::Decibels::gainToDecibels(threshold,-100.0f);
            for(size_t ch=0;ch<2;++ch)
            {
                const float peak=detector[ch],requested=juce::jmin(1.0f,threshold/juce::jmax(1e-9f,peak));
                const float reduction=-juce::Decibels::gainToDecibels(requested,-100.0f);
                for(size_t mode=0;mode<strategies.size();++mode)
                {
                    auto& state=strategies[mode][ch];const float rmsCoefficient=mode==1?rmsBus:rmsFast;
                    state.power=rmsCoefficient*state.power+(1-rmsCoefficient)*peak*peak;
                    state.peak=juce::jmax(peak,crestRelease*state.peak);
                    const float crest=juce::jlimit(0.0f,1.0f,(state.peak/std::sqrt(juce::jmax(1e-12f,state.power))-1)/3);
                    const float memory=useAutomatic?channels[ch].exposure:0;
                    const float fastCoefficient=mode==0?crestSlow+crest*(crestFast-crestSlow):mode==1?busFast:mode==2?edgeRelease:gentleFast;
                    const int hold=mode==2?0:holdSamples;
                    if(requested<=state.fast){state.fast=requested;state.hold=hold;}
                    else if(state.hold>0)--state.hold;
                    else state.fast=fastCoefficient*state.fast+(1-fastCoefficient)*requested;
                    float target=reduction;
                    if(mode==0)target*=1-.65f*crest;
                    if(mode==1)
                    {
                        const float over=juce::Decibels::gainToDecibels(std::sqrt(2*state.power),-100.0f)-thresholdDb;
                        target=over<=-3?0:over<3?.75f*(over+3)*(over+3)/12:.75f*over;
                    }
                    if(mode==2)target=0;
                    const float releaseCoefficient=mode==3?gentleRelease+memory*(gentleLong-gentleRelease):busRelease+memory*(busLong-busRelease);
                    const float attackCoefficient=mode==3?gentleAttack:slowAttack;
                    const float smooth=target>state.slow?attackCoefficient:releaseCoefficient;
                    state.slow=smooth*state.slow+(1-smooth)*target;
                    const float second=state.slow>state.cascade?slowAttack:gentleLong;
                    state.cascade=second*state.cascade+(1-second)*state.slow;
                    strategyFast[mode][ch]=state.fast;
                    strategySlow[mode][ch]=mode==3?juce::jmax(state.slow,state.cascade):state.slow;
                }
            }
        }
        std::array<float,2> gains{};
        for(size_t ch=0;ch<2;++ch)
        {
            const float fastGain=fast[ch]+transients*(minimumFast-fast[ch]);
            const float slowGain=juce::Decibels::decibelsToGain(-(slow[ch]+release*(maximumSlow-slow[ch])));
            gains[ch]=juce::jmin(fastGain,slowGain);
            if(strategyMix>0)
            {
                float selected=gains[ch]*juce::jmax(0.0f,1-strategyMix);
                for(size_t mode=0;mode<weights.size();++mode)
                {
                    const float linkedFast=strategyFast[mode][ch]+transients*(juce::jmin(strategyFast[mode][0],strategyFast[mode][1])-strategyFast[mode][ch]);
                    const float linkedSlow=strategySlow[mode][ch]+release*(juce::jmax(strategySlow[mode][0],strategySlow[mode][1])-strategySlow[mode][ch]);
                    selected+=weights[mode]*juce::jmin(linkedFast,juce::Decibels::decibelsToGain(-linkedSlow));
                }
                gains[ch]=selected/juce::jmax(1.0f,strategyMix);
            }
            if(truePeak)gains[ch]=juce::jmin(gains[ch],safety[ch]+transients*(minimumSafety-safety[ch]));
        }
        return gains;
    }
    float nextBlend() noexcept {return blend.getNextValue();}
private:
    struct Channel {float fast=1,slow=0,exposure=0,safety=1;int hold=0;std::vector<float> peaks;std::vector<juce::uint64> times;size_t head=0,count=0;juce::uint64 clock=0;};
    float coefficient(float ms) const {return static_cast<float>(std::exp(-1/(juce::jmax(.1f,ms)*.001*rate)));}
    std::array<Channel,2> channels;
    double rate=48000;bool useAutomatic=false;
    float fastRelease=0,fastLong=0,slowRelease=0,slowLong=0,slowAttack=0,exposureAttack=0,exposureRelease=0,safetyRelease=0;
    juce::SmoothedValue<float> blend,transientLink,releaseLink;
    struct Strategy {float fast=1,slow=0,cascade=0,power=0,peak=0;int hold=0;};
    std::array<std::array<Strategy,2>,4> strategies;
    bool strategyAwake=false;
    std::array<juce::SmoothedValue<float>,4> strategyWeights;
    float rmsFast=0,rmsBus=0,crestRelease=0,crestFast=0,crestSlow=0,busFast=0,busRelease=0,busLong=0,edgeRelease=0;
    float gentleFast=0,gentleAttack=0,gentleRelease=0,gentleLong=0;
};
