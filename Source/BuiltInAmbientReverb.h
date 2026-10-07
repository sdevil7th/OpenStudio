#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"

// Four original ambient networks with independent excitation and hold policies.
class BuiltInAmbientReverb
{
public:
    using Pair=std::array<float,2>;
    struct Settings {float decay=4,size=.5f,damping=.5f,diffusion=.5f,predelay=0,lowCut=20,highCut=20000,width=1,rise=.5f,swellMode=0,length=.8f,feedback=.3f,depth=.3f,rate=.2f,vowel=0,resonance=1,hold=0,bass=1;};
private:
    struct Line
    {
        std::vector<float> data;int position=0,valid=0;
        void prepare(int samples){data.assign(static_cast<size_t>(samples+4),0);reset();}
        void reset(){position=valid=0;}
        float read(float delay)const
        {
            delay=juce::jlimit(1.0f,static_cast<float>(data.size()-2),delay);const int whole=static_cast<int>(delay),length=static_cast<int>(data.size());const float fraction=delay-static_cast<float>(whole);
            const auto tap=[&](int n){return n<=valid?data[static_cast<size_t>((position+length-n)%length)]:0;};return tap(whole)+fraction*(tap(whole+1)-tap(whole));
        }
        void write(float value){data[static_cast<size_t>(position)]=value;valid=juce::jmin(valid+1,static_cast<int>(data.size()));if(++position==static_cast<int>(data.size()))position=0;}
        float allpass(float input,float delay,float coefficient){const float previous=read(delay),output=previous-coefficient*input;write(input+coefficient*output);return output;}
    };
    struct Engine
    {
        std::array<Line,16> tank;std::array<std::array<Line,8>,2> diffusers;std::array<Line,2> pre;
        std::array<juce::SmoothedValue<float>,16> lengths,losses,bassLosses;
        juce::SmoothedValue<float> decay,dampPole,dampMix,diffusion,preTime,width,rise,length,bloomFeedback,depth,speed,hold,send,lowPole,highPole,lowMix,highMix,drySwell;
        std::array<float,16> dampState{},bassState{};Pair bloomMemory{},lowState{},highState{};
        std::array<std::array<std::array<double,2>,3>,2> formantState{};
        std::array<double,3> formantG{},formantK{},targetG{},targetK{};double fs=48000,phase=0,formantSmoothing=0;float ramp=0,rampGain=0,bassPole=0,rampPole=0;int silence=0,mode=0,formantCountdown=0,vowelA=0,vowelB=1;juce::uint32 random=1;bool initialized=false,triggered=false,started=false,formantInitialized=false;Settings settings;juce::uint64 frames=0;
        void prepare(double rate,int selected)
        {
            fs=rate;mode=selected;bassPole=static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*250/fs));rampPole=static_cast<float>(1-std::exp(-1/(fs*.003)));formantSmoothing=1-std::exp(-1/(fs*.02));for(auto& line:tank)line.prepare(static_cast<int>(fs*.45));for(auto& channel:diffusers)for(auto& line:channel)line.prepare(static_cast<int>(fs*.45));for(auto& line:pre)line.prepare(static_cast<int>(fs*.51));
            for(auto* value:{&decay,&dampPole,&dampMix,&diffusion,&preTime,&width,&rise,&length,&bloomFeedback,&depth,&speed,&hold,&send,&lowPole,&highPole,&lowMix,&highMix,&drySwell})value->reset(fs,.05);
            for(auto* values:{&lengths,&losses,&bassLosses})for(auto& value:*values)value.reset(fs,.1);
            reset();
            frames=0;
        }
        void reset(){for(auto& line:tank)line.reset();for(auto& channel:diffusers)for(auto& line:channel)line.reset();for(auto& line:pre)line.reset();dampState={};bassState={};bloomMemory={};lowState={};highState={};formantState={};phase=0;ramp=rampGain=0;silence=0;triggered=started=formantInitialized=false;initialized=false;formantCountdown=0;random=1;vowelA=0;vowelB=1;}
        void configure(Settings next)
        {
            settings=next;const auto set=[&](auto& value,float target){if(initialized)value.setTargetValue(target);else value.setCurrentAndTargetValue(target);};
            set(decay,settings.decay);set(dampPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*(18000*std::pow(1.0/36,settings.damping))/fs)));set(dampMix,settings.damping>0?1.0f:0);set(diffusion,settings.diffusion);set(preTime,static_cast<float>(settings.predelay*.001*fs));set(width,settings.width);set(rise,settings.rise);set(length,settings.length);set(bloomFeedback,settings.feedback);set(depth,settings.depth);set(speed,settings.rate);set(hold,settings.hold>=.5f?1.0f:0);set(send,settings.hold>=1.5f?0.0f:1.0f);set(drySwell,mode==0&&settings.swellMode>=.5f?1.0f:0);
            set(lowPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*settings.lowCut/fs)));set(highPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*settings.highCut/fs)));set(lowMix,settings.lowCut>20?1.0f:0);set(highMix,settings.highCut<20000?1.0f:0);
            constexpr std::array<float,16> times{29.7f,31.1f,37.1f,41.3f,43.7f,47.9f,53.3f,59.3f,61.7f,67.9f,73.1f,79.7f,83.3f,89.9f,97.1f,103.3f};
            for(size_t i=0;i<16;++i){const float scale=mode==0?.65f:mode==1?1.25f:mode==2?1.8f:.8f;const float samples=static_cast<float>(juce::roundToInt(times[i]*(.5f+settings.size*1.5f)*scale*.001*fs));set(lengths[i],samples);set(losses[i],std::exp(-6.907755f*samples/static_cast<float>(fs)/settings.decay));set(bassLosses[i],std::exp(-6.907755f*samples/static_cast<float>(fs)/(settings.decay*settings.bass)));}
            initialized=true;
        }
        Pair vowels(Pair input,float motion)
        {
            if(--formantCountdown<=0)
            {
                formantCountdown=32;constexpr std::array<std::array<double,3>,3> targets{{{800,1150,2900},{450,800,2830},{325,700,2530}}};
                const int choice=juce::jlimit(0,6,juce::roundToInt(settings.vowel));int a=juce::jmin(choice,2),b=a;double blend=0;
                if(choice>=3){if(choice==3){a=0;b=1;}if(choice==4){a=1;b=2;}if(choice==5){a=0;b=2;}if(choice==6){a=vowelA;b=vowelB;}blend=choice==6?phase*phase*(3-2*phase):.5-.5*std::cos(juce::MathConstants<double>::twoPi*phase);}
                const double q=settings.resonance<.5f?2:settings.resonance<1.5f?4:8;
                for(size_t band=0;band<3;++band){const double frequency=(targets[static_cast<size_t>(a)][band]+blend*(targets[static_cast<size_t>(b)][band]-targets[static_cast<size_t>(a)][band]))*(1+.015*motion*std::sin(juce::MathConstants<double>::twoPi*(phase+band*.27)));const double target=std::tan(juce::MathConstants<double>::pi*frequency/fs);targetG[band]=target;targetK[band]=1/q;if(!formantInitialized){formantG[band]=targetG[band];formantK[band]=targetK[band];}}
            }
            formantInitialized=true;for(size_t band=0;band<3;++band){formantG[band]+=formantSmoothing*(targetG[band]-formantG[band]);formantK[band]+=formantSmoothing*(targetK[band]-formantK[band]);}
            Pair output{};constexpr std::array<double,3> levels{.7,.25,.1};
            for(size_t ch=0;ch<2;++ch)for(size_t band=0;band<3;++band){auto& state=formantState[ch][band];const double g=formantG[band],k=formantK[band],h=1/(1+g*(g+k)),v1=h*(state[0]+g*(input[ch]-state[1])),v2=state[1]+g*v1;state[0]=2*v1-state[0];state[1]=2*v2-state[1];output[ch]+=static_cast<float>(v1*k*levels[band]*1.5);}
            return output;
        }
        std::array<float,4> process(Pair source,bool active)
        {
            ++frames;const float held=hold.getNextValue(),excitation=send.getNextValue(),diff=diffusion.getNextValue(),motion=depth.getNextValue()*(1-held),frequency=speed.getNextValue(),build=length.getNextValue(),fb=bloomFeedback.getNextValue(),predelay=preTime.getNextValue(),riseTime=rise.getNextValue(),inputSwell=drySwell.getNextValue();
            decay.skip(1);const float envelope=juce::jmax(std::abs(source[0]),std::abs(source[1]));
            if(mode==0&&settings.hold<1.5f){if(envelope<.0005f){silence=juce::jmin(silence+1,static_cast<int>(fs));if(silence>static_cast<int>(fs*.05))triggered=false;}else{silence=0;if(envelope>.001f&&!triggered){triggered=started=true;ramp=0;}}if(started)ramp=juce::jmin(1.0f,ramp+static_cast<float>(1/(fs*riseTime)));}
            else if(mode!=0)ramp=1;
            rampGain+=rampPole*(ramp-rampGain);
            Pair input{};for(size_t ch=0;ch<2;++ch){const float x=active?source[ch]*(1+inputSwell*(rampGain-1))*excitation:0;input[ch]=predelay<1?x:pre[ch].read(predelay);pre[ch].write(x);}
            constexpr std::array<float,8> diffuserTimes{.019f,.031f,.043f,.061f,.079f,.101f,.127f,.173f};
            const int stages=mode==1||mode==2?8:4;
            for(size_t ch=0;ch<2;++ch)
            {
                float signal=input[ch]+(mode==1?bloomMemory[ch]*fb:0);
                for(int stage=0;stage<stages;++stage){const size_t index=static_cast<size_t>(stage);const float scale=mode==1?build:mode==2?.6f+settings.size*1.2f:.25f;const float base=static_cast<float>(fs)*diffuserTimes[index]*scale;const float mod=juce::jmin(base*.45f,motion*static_cast<float>(fs)*.004f)*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*(phase+stage*.173+ch*.25)));const float delayed=diffusers[ch][index].allpass(signal,base+mod,-.6f);signal+=diff*(delayed-signal);}
                bloomMemory[ch]=juce::jlimit(-2.0f,2.0f,signal);input[ch]=signal*excitation;
            }
            std::array<float,16> values{};Pair output{};const float damp=dampPole.getNextValue(),dampAmount=dampMix.getNextValue()*(1-held);
            for(size_t i=0;i<16;++i)
            {
                const float delay=lengths[i].getNextValue(),mod=mode==2?0:motion*static_cast<float>(fs)*.002f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*(phase+i*.137)));
                const float sample=tank[i].read((held>=.99999f?std::round(delay):delay)+mod);dampState[i]+=damp*(sample-dampState[i]);const float filtered=sample+dampAmount*(dampState[i]-sample);bassState[i]+=bassPole*(filtered-bassState[i]);const float mainLoss=losses[i].getNextValue(),lowLoss=bassLosses[i].getNextValue();values[i]=(filtered-bassState[i])*(mainLoss+held*(1-mainLoss))+bassState[i]*(lowLoss+held*(1-lowLoss));
                output[0]+=sample*(i%2?-.15f:.15f);output[1]+=sample*(i%3?-.15f:.15f);
            }
            for(size_t stride=1;stride<16;stride*=2)for(size_t base=0;base<16;base+=stride*2)for(size_t offset=0;offset<stride;++offset){const size_t a=base+offset,b=a+stride;const float first=values[a],second=values[b];values[a]=first+second;values[b]=first-second;}
            for(size_t i=0;i<16;++i)tank[i].write(juce::jlimit(-2.0f,2.0f,values[(i*5+1)%16]*.25f+(input[0]+(i%2?-input[1]:input[1]))*.0875f));
            phase+=frequency/fs;if(phase>=1){phase-=1;vowelA=vowelB;random=random*1664525u+1013904223u;vowelB=static_cast<int>((random>>16)%3);}
            if(mode==3)output=vowels(output,motion);
            const float lp=highPole.getNextValue(),hp=lowPole.getNextValue(),loMix=lowMix.getNextValue(),hiMix=highMix.getNextValue();
            for(size_t ch=0;ch<2;++ch){lowState[ch]+=hp*(output[ch]-lowState[ch]);output[ch]-=loMix*lowState[ch];highState[ch]+=lp*(output[ch]-highState[ch]);output[ch]+=hiMix*(highState[ch]-output[ch]);if(mode==0)output[ch]*=1+(1-inputSwell)*(rampGain-1);}
            const float mid=(output[0]+output[1])*.5f,side=(output[0]-output[1])*.5f*width.getNextValue();return {mid+side,mid-side,source[0]*(1+inputSwell*(rampGain-1)),source[1]*(1+inputSwell*(rampGain-1))};
        }
    };
    std::array<Engine,4> engines;std::array<juce::SmoothedValue<float>,4> weights;std::array<bool,4> running{};BuiltInReverbRetirement<4> retirement;bool prepared=false;
public:
    void prepare(double fs,int selected){for(size_t i=0;i<4;++i){engines[i].prepare(fs,static_cast<int>(i));weights[i].reset(fs,.05);weights[i].setCurrentAndTargetValue(selected==static_cast<int>(i)?1.0f:0);}running={};prepared=true;retirement.prepare(fs,selected);}
    void reset(){for(auto& engine:engines)engine.reset();running={};retirement.reset(weights);}
    void configure(int selected,Settings settings,bool retainTails=false)
    {
        const auto safe=[](float x,float lo,float hi,float fallback){return std::isfinite(x)?juce::jlimit(lo,hi,x):fallback;};
        settings.decay=safe(settings.decay,.1f,50,4);settings.size=safe(settings.size,0,1,.5f);settings.damping=safe(settings.damping,0,1,.5f);settings.diffusion=safe(settings.diffusion,0,1,.5f);settings.predelay=safe(settings.predelay,0,500,0);settings.lowCut=safe(settings.lowCut,20,500,20);settings.highCut=safe(settings.highCut,1000,20000,20000);settings.width=safe(settings.width,0,1,1);settings.rise=safe(settings.rise,.01f,5,.5f);settings.swellMode=safe(settings.swellMode,0,1,0);settings.length=safe(settings.length,.02f,2,.8f);settings.feedback=safe(settings.feedback,0,.95f,.3f);settings.depth=safe(settings.depth,0,1,.3f);settings.rate=safe(settings.rate,.05f,2,.2f);settings.vowel=safe(settings.vowel,0,6,0);settings.resonance=safe(settings.resonance,0,2,1);settings.hold=safe(settings.hold,0,2,0);settings.bass=safe(settings.bass,.5f,2,1);
        for(size_t i=0;i<4;++i)
        {
            const double build=i==1?.634*settings.length*(1+(settings.feedback>0?std::log(.001)/std::log(settings.feedback):0)):i==2?3.0:0;const double tail=settings.hold>=.5f?120:settings.decay*juce::jmax(1.0f,settings.bass)*1.5+2+build+settings.predelay*.001;
            retirement.configure(i,selected==static_cast<int>(i),retainTails,tail);
            weights[i].setTargetValue(selected==static_cast<int>(i)?1.0f:0);
            if(selected==static_cast<int>(i))engines[i].configure(settings);
            else if(retainTails&&running[i]&&engines[i].settings.hold>=.5f){auto retiring=engines[i].settings;retiring.hold=0;engines[i].configure(retiring);}
        }
    }
    std::array<float,5> process(float left,float right)
    {
        std::array<float,5> result{};if(!prepared)return result;const auto safe=[](float x){return std::isfinite(x)?juce::jlimit(-16.0f,16.0f,x):0;};
        for(size_t i=0;i<4;++i){const float weight=weights[i].getNextValue(),wetWeight=retirement.next(i);if(wetWeight==0&&weight==0&&weights[i].getTargetValue()==0){if(running[i])engines[i].reset();running[i]=false;continue;}running[i]=true;const auto output=engines[i].process({safe(left),safe(right)},weights[i].getTargetValue()>0);result[0]+=wetWeight*output[0];result[1]+=wetWeight*output[1];result[2]+=weight;result[3]+=weight*output[2];result[4]+=weight*output[3];}return result;
    }
    double retiringTailSeconds()const noexcept{return retirement.retiringTailSeconds();}
    std::array<juce::uint64,4> processedFrames()const{return {engines[0].frames,engines[1].frames,engines[2].frames,engines[3].frames};}
};
