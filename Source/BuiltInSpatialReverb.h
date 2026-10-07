#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"

// Three original spaces: integral-tap room/hall FDNs and an allpass echo loop.
class BuiltInSpatialReverb
{
public:
    struct Settings
    {
        float decay=2,size=.5f,damping=.5f,diffusion=.5f,delayMs=80,feedback=.2f;
        float lowCut=20,highCut=20000,width=1,density=1,modulation=.25f,rate=.4f,amount=1;
        bool freeze=false, infiniteInput=false;
        float lowShelfDb=0;
    };
    static constexpr std::array<float,15> beats{.0625f,.083333333f,.125f,.166666667f,.25f,.333333333f,.5f,.75f,1,1.5f,2,3,4,8,16};
    static float capacitySeconds(float choice) noexcept {return std::array<float,3>{6,24,96}[static_cast<size_t>(juce::jlimit(0,2,juce::roundToInt(choice)))];}
    static float delayMilliseconds(float bpm,float division){return 60000/juce::jlimit(10.0f,300.0f,bpm)*beats[static_cast<size_t>(juce::jlimit(0,14,juce::roundToInt(division)))];}
private:
    struct Delay
    {
        std::vector<float> data;int position=0,valid=0;
        void prepare(int samples){data.assign(static_cast<size_t>(samples+4),0);reset();}
        void reset()noexcept{position=valid=0;}
        float integer(int samples)const noexcept{samples=juce::jlimit(1,static_cast<int>(data.size())-1,samples);return samples<=valid?data[static_cast<size_t>((position+static_cast<int>(data.size())-samples)%static_cast<int>(data.size()))]:0;}
        float read(float samples)const noexcept{samples=juce::jlimit(1.0f,static_cast<float>(data.size()-2),samples);const int whole=static_cast<int>(samples);return integer(whole)+(samples-static_cast<float>(whole))*(integer(whole+1)-integer(whole));}
        void write(float value)noexcept{data[static_cast<size_t>(position)]=std::isfinite(value)?value:0;valid=juce::jmin(valid+1,static_cast<int>(data.size()));if(++position==static_cast<int>(data.size()))position=0;}
    };
    struct Engine
    {
        std::array<Delay,2> pre;
        std::array<Delay,16> lines;
        std::array<std::array<Delay,6>,2> diffusers;
        std::array<float,16> dampState{};
        std::array<float,2> lowState{},highState{},inputLowState{},inputHighState{},inputShelfState{},feedbackShelfState{};
        std::array<juce::SmoothedValue<float>,16> lengths,losses;
        juce::SmoothedValue<float> sizeValue,feedback,damping,diffusion,depth,speed,width,freeze,holdSend,amount,density,lowPole,highPole,lowEnable,highEnable,shelfGain;
        float shelfPole=0;
        Settings settings;double fs=48000,phase=0;float capacity=6;int mode=0,activeDelay=1,targetDelay=1;float delayBlend=1,limiterGain=1;bool initialized=false;
        juce::uint64 frames=0;
        void prepare(double rate,int index,float capacityChoice=0)
        {
            fs=rate;mode=index;capacity=capacitySeconds(capacityChoice);const double shelfG=std::tan(juce::MathConstants<double>::pi*250/fs);shelfPole=static_cast<float>(shelfG/(1+shelfG));for(auto& delay:pre)delay.prepare(static_cast<int>(std::ceil(fs*capacity)));
            if(mode<2)for(auto& line:lines)line.prepare(static_cast<int>(fs*.42));
            else for(auto& channel:diffusers)for(auto& line:channel)line.prepare(static_cast<int>(fs*.12));
            for(auto* value:{&sizeValue,&feedback,&damping,&diffusion,&depth,&speed,&width,&freeze,&holdSend,&amount,&density,&lowPole,&highPole,&lowEnable,&highEnable,&shelfGain})value->reset(fs,.05);
            for(auto& value:lengths)value.reset(fs,.1);
            for(auto& value:losses)value.reset(fs,.1);
            reset();
            frames=0;
        }
        void reset()noexcept
        {
            for(auto& delay:pre)delay.reset();
            for(auto& line:lines)line.reset();
            for(auto& channel:diffusers)for(auto& line:channel)line.reset();
            dampState={};lowState={};highState={};inputLowState={};inputHighState={};inputShelfState={};feedbackShelfState={};phase=0;limiterGain=1;delayBlend=1;initialized=false;
        }
        void configure(Settings next)
        {
            settings=next;const auto set=[&](auto& value,float target){if(initialized)value.setTargetValue(target);else value.setCurrentAndTargetValue(target);};
            const int requested=juce::jlimit(0,static_cast<int>(fs*capacity),juce::roundToInt(settings.delayMs*static_cast<float>(fs)*.001f));
            if(!initialized)activeDelay=targetDelay=requested;
            else if(delayBlend>=1&&requested!=activeDelay){targetDelay=requested;delayBlend=0;}
            set(sizeValue,settings.size);set(feedback,requested==0?0:settings.feedback);set(shelfGain,juce::Decibels::decibelsToGain(settings.lowShelfDb));set(damping,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*(18000-17000*settings.damping)/fs)));
            set(diffusion,.1f+.65f*settings.diffusion);set(depth,settings.modulation*static_cast<float>(fs)*(mode==2?.012f:.003f));set(speed,settings.rate);
            set(width,settings.width);set(freeze,settings.freeze&&mode<2?1.0f:0.0f);set(holdSend,settings.freeze&&mode<2&&!settings.infiniteInput?0.0f:1.0f);set(amount,settings.amount);set(density,settings.density);
            set(lowPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*settings.lowCut/fs)));set(highPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*settings.highCut/fs)));
            set(lowEnable,settings.lowCut>20?1.0f:0.0f);set(highEnable,settings.highCut<20000?1.0f:0.0f);
            constexpr std::array<float,16> times{5.3f,7.1f,11.3f,13.7f,17.9f,19.1f,23.3f,29.7f,37.1f,41.3f,47.9f,53.3f,61.7f,67.9f,73.1f,83.3f};
            for(size_t i=0;i<lengths.size();++i)
            {
                const float seconds=(mode==0?times[i]*(.25f+settings.size*3): (times[i]+30)*(.5f+settings.size*2))*.001f;
                set(lengths[i],seconds*static_cast<float>(fs));set(losses[i],std::exp(-6.907755f*seconds/settings.decay));
            }
            initialized=true;
        }
        std::array<float,2> process(float left,float right,bool active)
        {
            ++frames;const float currentSize=sizeValue.getNextValue();const float fb=feedback.getNextValue(),damp=damping.getNextValue(),diffuse=diffusion.getNextValue(),motion=depth.getNextValue(),frequency=speed.getNextValue();
            const float held=freeze.getNextValue(),excitation=holdSend.getNextValue(),blend=amount.getNextValue(),spread=width.getNextValue(),dense=density.getNextValue();
            const float shelf=shelfGain.getNextValue();
            const auto filterShelf=[&](float x,float& state){const float v=(x-state)*shelfPole;const float lowBand=v+state;state=lowBand+v;return shelf==1?x:x+(shelf-1)*lowBand;};
            const float low=lowPole.getNextValue(),high=highPole.getNextValue(),lowMix=lowEnable.getNextValue(),highMix=highEnable.getNextValue();
            std::array<float,2> input{active?left:0,active?right:0};std::array<float,2> delayed{},space{},loop{};
            for(size_t ch=0;ch<2;++ch)
            {
                input[ch]=filterShelf(input[ch],inputShelfState[ch]);
                inputLowState[ch]+=low*(input[ch]-inputLowState[ch]);const float cut=input[ch]-lowMix*inputLowState[ch];inputHighState[ch]+=high*(cut-inputHighState[ch]);input[ch]=cut+highMix*(inputHighState[ch]-cut);
                const auto tap=[&](int time){return time==0&&fb==0?input[ch]:pre[ch].integer(juce::jmax(1,time));};
                delayed[ch]=tap(activeDelay)+delayBlend*(tap(targetDelay)-tap(activeDelay));
            }
            if(delayBlend<1){delayBlend=juce::jmin(1.0f,delayBlend+static_cast<float>(1/(fs*.05)));if(delayBlend>=1)activeDelay=targetDelay;}
            phase+=frequency/fs;if(phase>=1)phase-=1;
            if(mode==2)
            {
                constexpr std::array<float,6> times{1.7f,3.1f,5.9f,9.7f,17.3f,31.1f};
                for(size_t ch=0;ch<2;++ch)
                {
                    float signal=delayed[ch];
                    for(size_t stage=0;stage<6;++stage)
                    {
                        const float length=times[stage]*(.2f+currentSize*3)*static_cast<float>(fs)*.001f;
                        const float mod=motion*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*(phase+static_cast<double>(stage+ch*6)*.137)));
                        auto& line=diffusers[ch][stage];const float output=line.read(length+mod)-diffuse*signal;line.write(signal+diffuse*output);signal=output;
                    }
                    space[ch]=signal;
                }
                for(size_t ch=0;ch<2;++ch)dampState[ch]+=damp*(space[ch]-dampState[ch]);
                loop={dampState[0]*.8f+dampState[1]*.2f,dampState[1]*.8f+dampState[0]*.2f};
            }
            else
            {
                const int count=mode==0?8:16;const float normal=1/std::sqrt(static_cast<float>(count));std::array<float,16> tank{};
                for(int i=0;i<count;++i)
                {
                    const auto index=static_cast<size_t>(i);const float time=lengths[index].getNextValue();
                    const float mod=motion*(1-held)*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*(phase+static_cast<double>(i)*.173)));
                    const float value=lines[index].read((held>=.99999f?std::round(time):time)+mod);
                    dampState[index]+=(damp+held*(1-damp))*(value-dampState[index]);const float loss=losses[index].getNextValue();tank[index]=dampState[index]*(loss+held*(1-loss));
                    const float early=lines[index].read(time*(mode==0?.27f:.41f));
                    space[0]+=(i%2?-.6f:.6f)*normal*value+(i%3?-.4f:.4f)*normal*early;
                    space[1]+=(i%3?-.6f:.6f)*normal*value+(i%2?-.4f:.4f)*normal*early;
                }
                const float angle=(.12f+.9f*dense)*diffuse;const float cosine=std::cos(angle),sine=std::sin(angle);
                for(int stride=1;stride<count;stride*=2)for(int base=0;base<count;base+=stride*2)for(int offset=0;offset<stride;++offset)
                {
                    const auto a=static_cast<size_t>(base+offset),b=static_cast<size_t>(base+offset+stride);const float first=tank[a],second=tank[b];tank[a]=cosine*first+sine*second;tank[b]=cosine*second-sine*first;
                }
                for(int i=0;i<count;++i)
                {
                    const float sample=tank[static_cast<size_t>((i*5+1)%count)]+(delayed[0]+(i%2?-delayed[1]:delayed[1]))*normal*.35f*excitation;
                    lines[static_cast<size_t>(i)].write(settings.freeze&&settings.infiniteInput?juce::jlimit(-8.0f,8.0f,sample):sample);
                }
                loop=delayed;
            }
            std::array<float,2> write{};
            for(size_t ch=0;ch<2;++ch)
            {
                loop[ch]=filterShelf(loop[ch],feedbackShelfState[ch]);
                lowState[ch]+=low*(loop[ch]-lowState[ch]);const float cut=loop[ch]-lowMix*lowState[ch];highState[ch]+=high*(cut-highState[ch]);loop[ch]=cut+highMix*(highState[ch]-cut);write[ch]=input[ch]+fb*loop[ch];
            }
            const float peak=juce::jmax(std::abs(write[0]),std::abs(write[1])),target=juce::jmin(1.0f,1/juce::jmax(1e-9f,peak));
            const float recovery=static_cast<float>(std::exp(-1/(fs*juce::jlimit(.02,.5,activeDelay/fs))));
            if(target<limiterGain)limiterGain=target;else limiterGain=recovery*limiterGain+(1-recovery)*target;
            for(size_t ch=0;ch<2;++ch){pre[ch].write(write[ch]*limiterGain);space[ch]=delayed[ch]+blend*(space[ch]-delayed[ch]);}
            const float mid=(space[0]+space[1])*.5f,side=(space[0]-space[1])*.5f*spread;return {mid+side,mid-side};
        }
    };
    std::array<Engine,3> engines;
    std::array<juce::SmoothedValue<float>,3> weights;
    std::array<bool,3> running{};
    BuiltInReverbRetirement<3> retirement;
    bool prepared=false;
public:
    void prepare(double rate,int selected,std::array<float,3> capacities={}){for(size_t i=0;i<engines.size();++i){engines[i].prepare(rate,static_cast<int>(i),capacities[i]);weights[i].reset(rate,.05);weights[i].setCurrentAndTargetValue(selected==static_cast<int>(i)?1.0f:0.0f);}prepared=true;running={};retirement.prepare(rate,selected);}
    bool ready() const noexcept{return prepared;}
    void setCapacity(size_t index,float choice)
    {
        if(!prepared||index>=engines.size())return;
        auto replacement=std::make_unique<Engine>();replacement->prepare(engines[index].fs,static_cast<int>(index),choice);
        engines[index]=std::move(*replacement);running[index]=false;
    }
    float preparedCapacity(size_t index) const noexcept{return index<engines.size()&&engines[index].fs>0&&engines[index].pre[0].data.size()>=4?static_cast<float>((engines[index].pre[0].data.size()-4)/engines[index].fs):0;}
    void reset()noexcept{for(auto& engine:engines)engine.reset();running={};retirement.reset(weights);}
    void configure(int selected,Settings settings,bool retainTails=false)
    {
        const auto safe=[](float x,float lo,float hi,float fallback){return std::isfinite(x)?juce::jlimit(lo,hi,x):fallback;};
        settings.decay=safe(settings.decay,.1f,20,2);settings.size=safe(settings.size,0,1,.5f);settings.damping=safe(settings.damping,0,1,.5f);settings.diffusion=safe(settings.diffusion,0,1,.5f);
        settings.delayMs=safe(settings.delayMs,0,96000,80);settings.feedback=safe(settings.feedback,0,1,.2f);settings.lowCut=safe(settings.lowCut,20,500,20);settings.highCut=safe(settings.highCut,1000,20000,20000);
        settings.lowShelfDb=safe(settings.lowShelfDb,-24,0,0);
        settings.width=safe(settings.width,0,1,1);settings.density=safe(settings.density,0,1,1);settings.modulation=safe(settings.modulation,0,1,.25f);settings.rate=safe(settings.rate,.05f,selected==2?20.0f:2.0f,.4f);settings.amount=safe(settings.amount,0,1,1);
        for(size_t i=0;i<engines.size();++i)
        {
            auto bounded=settings;bounded.delayMs=juce::jmin(bounded.delayMs,engines[i].capacity*1000);
            const auto& saved=selected==static_cast<int>(i)?bounded:engines[i].settings;
            const double feedback=saved.delayMs<=0?0:saved.feedback;
            const double loop=saved.delayMs*.001+(i==2?(.2+saved.size*3)*.0688:0);
            const double tail=saved.freeze||feedback>=.9999?120:loop+(feedback>0?loop*std::log(.001)/std::log(feedback):0)+(i<2?saved.decay:3);
            retirement.configure(i,selected==static_cast<int>(i),retainTails,tail);
            weights[i].setTargetValue(selected==static_cast<int>(i)?1.0f:0.0f);
            if(selected==static_cast<int>(i))engines[i].configure(bounded);
            else if(running[i]&&engines[i].settings.freeze){auto retiring=engines[i].settings;retiring.freeze=false;engines[i].configure(retiring);}
        }
    }
    std::array<float,3> process(float left,float right)
    {
        std::array<float,3> result{};if(!prepared)return result;
        left=std::isfinite(left)?juce::jlimit(-16.0f,16.0f,left):0;right=std::isfinite(right)?juce::jlimit(-16.0f,16.0f,right):0;
        for(size_t i=0;i<engines.size();++i)
        {
            const float weight=weights[i].getNextValue(),wetWeight=retirement.next(i);if(wetWeight==0&&weight==0&&weights[i].getTargetValue()==0){if(running[i])engines[i].reset();running[i]=false;continue;}
            running[i]=true;const auto output=engines[i].process(left,right,weights[i].getTargetValue()>0);result[0]+=output[0]*wetWeight;result[1]+=output[1]*wetWeight;result[2]+=weight;
        }
        return result;
    }
    double retiringTailSeconds()const noexcept{return retirement.retiringTailSeconds();}
    std::array<juce::uint64,3> processedFrames()const noexcept{return {engines[0].frames,engines[1].frames,engines[2].frames};}
};
