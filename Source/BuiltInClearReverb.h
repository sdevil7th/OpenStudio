#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"
#include <array>
#include <vector>

// Original plate, room and randomized room/hall networks. No proprietary
// coefficients, converter emulation or calibrated acoustic model is implied.
class BuiltInClearReverb
{
public:
    struct Settings
    {
        float decay=2,size=.5f,damping=.5f,diffusion=.5f,preDelay=0,lowCut=20,highCut=20000,width=1,early=.5f;
        float inputDiffusion=.65f,onset=40,depth=.25f,speed=.3f,bassRatio=1,bassFrequency=500;
        bool hold=false,holdInput=false;
    };
private:
    struct Delay
    {
        std::vector<float> data;int position=0,valid=0;
        void prepare(int size){data.assign(static_cast<size_t>(size+4),0);reset();}
        void reset() noexcept {position=valid=0;}
        float read(float samples) const noexcept
        {
            samples=juce::jlimit(1.0f,static_cast<float>(data.size()-2),samples);
            const int whole=static_cast<int>(samples),length=static_cast<int>(data.size());
            const int index=(position+length-whole)%length,next=(index+length-1)%length;
            const float a=whole<=valid?data[static_cast<size_t>(index)]:0,b=whole+1<=valid?data[static_cast<size_t>(next)]:0;
            return a+(samples-static_cast<float>(whole))*(b-a);
        }
        void write(float value) noexcept
        {
            data[static_cast<size_t>(position)]=std::isfinite(value)?juce::jlimit(-16.0f,16.0f,value):0;
            valid=juce::jmin(valid+1,static_cast<int>(data.size()));if(++position==static_cast<int>(data.size()))position=0;
        }
        float allpass(float input,float samples,float coefficient) noexcept
        {const float output=read(samples)-coefficient*input;write(input+coefficient*output);return output;}
    };
    struct Line
    {
        Delay delay;float base=0,low=0,damped=0,from=0,to=0;
        double phase=0,oscillatorSine=0,oscillatorCosine=1,rotationSine=0,rotationCosine=1;
        juce::uint32 seed=1;
        juce::SmoothedValue<float> samples,loss,bassLoss;
        std::array<juce::SmoothedValue<float>,4> tapLoss;
        float random() noexcept {seed^=seed<<13;seed^=seed>>17;seed^=seed<<5;return static_cast<float>(seed&0xffffffu)/8388607.5f-1;}
        void reset(size_t index) noexcept
        {delay.reset();low=damped=0;phase=0;seed=81731u+static_cast<juce::uint32>(index)*173891u;from=random();to=random();oscillatorSine=std::sin(static_cast<double>(index)*1.713);oscillatorCosine=std::cos(static_cast<double>(index)*1.713);}
    };
    struct Engine
    {
        std::array<Line,16> lines;std::array<Delay,2> pre,earlyHistory;
        std::array<std::array<Delay,4>,2> inputDiffusers;
        std::array<float,2> lowState{},highState{};
        juce::SmoothedValue<float> scatter,inputCoefficient,onset,depth,preSamples,damping,bassPole,lowPole,highPole,width,earlyLevel,hold,excitation,size;
        Settings settings;double rate=48000;int mode=0,count=16,inputStages=4;
        float normalise=.25f;bool initialized=false;juce::int64 drain=0;juce::uint64 frames=0;
        void prepare(double sampleRate,int topology)
        {
            rate=sampleRate;mode=topology;count=mode==1?8:16;inputStages=mode==0?4:2;normalise=1/std::sqrt(static_cast<float>(count));
            constexpr std::array<float,16> plateTimes{.0173f,.0239f,.0293f,.0371f,.0437f,.0533f,.0613f,.0719f,.0197f,.0269f,.0337f,.0413f,.0479f,.0577f,.0671f,.0797f};
            constexpr std::array<float,8> roomTimes{.0071f,.0113f,.0179f,.0233f,.0097f,.0139f,.0199f,.0317f};
            constexpr std::array<float,16> randomTimes{.0293f,.0377f,.0431f,.0539f,.0611f,.0719f,.0797f,.0899f,.0311f,.0409f,.0479f,.0571f,.0677f,.0739f,.0833f,.0971f};
            for(int i=0;i<count;++i)
            {auto& line=lines[static_cast<size_t>(i)];line.base=mode==0?plateTimes[static_cast<size_t>(i)]:mode==1?roomTimes[static_cast<size_t>(i)]:randomTimes[static_cast<size_t>(i)];line.delay.prepare(static_cast<int>(rate*(line.base*1.5f+.003f)));for(auto* value:{&line.samples,&line.loss,&line.bassLoss})value->reset(rate,.1);for(auto& value:line.tapLoss)value.reset(rate,.1);}
            for(auto& line:pre)line.prepare(static_cast<int>(rate*.501));
            for(auto& line:earlyHistory)line.prepare(static_cast<int>(rate*.111));
            for(auto& channel:inputDiffusers)for(auto& line:channel)line.prepare(static_cast<int>(rate*.121));
            for(auto* value:{&scatter,&inputCoefficient,&onset,&depth,&preSamples,&damping,&bassPole,&lowPole,&highPole,&width,&earlyLevel,&hold,&excitation,&size})value->reset(rate,.05);
            reset();frames=0;
        }
        void reset() noexcept
        {for(size_t i=0;i<lines.size();++i)lines[i].reset(i);for(auto& line:pre)line.reset();for(auto& line:earlyHistory)line.reset();for(auto& channel:inputDiffusers)for(auto& line:channel)line.reset();lowState.fill(0);highState.fill(0);initialized=false;drain=0;}
        double tail() const noexcept {return juce::jmin(120.0,settings.decay*juce::jmax(1.0f,settings.bassRatio)*2.0+2.0+settings.onset*.003+settings.preDelay*.001);}
        void configure(const Settings& next,bool active) noexcept
        {
            if(active)settings=next;
            const auto set=[this](auto& value,float target){if(initialized)value.setTargetValue(target);else value.setCurrentAndTargetValue(target);};
            const float sampleRate=static_cast<float>(rate),scale=.5f+settings.size;
            for(int i=0;i<count;++i)
            {
                auto& line=lines[static_cast<size_t>(i)];const float length=line.base*scale*sampleRate;
                set(line.samples,length);set(line.loss,std::pow(.001f,length/(sampleRate*settings.decay)));set(line.bassLoss,std::pow(.001f,length/(sampleRate*settings.decay*settings.bassRatio)));
                for(size_t tap=0;tap<line.tapLoss.size();++tap)set(line.tapLoss[tap],std::pow(.001f,length*(1-static_cast<float>(tap+1)*.25f)/(sampleRate*settings.decay)));
                const double angle=juce::MathConstants<double>::twoPi*settings.speed*(.73+static_cast<double>(i)*.037)/rate;
                line.rotationSine=std::sin(angle);line.rotationCosine=std::cos(angle);
            }
            const auto pole=[sampleRate](float frequency){return std::exp(-juce::MathConstants<float>::twoPi*juce::jmin(frequency,sampleRate*.45f)/sampleRate);};
            set(scatter,settings.diffusion*.70710678118f);set(inputCoefficient,settings.inputDiffusion*.72f);set(onset,settings.onset*.001f*sampleRate);
            set(depth,settings.depth*sampleRate*.0012f);set(preSamples,settings.preDelay*.001f*sampleRate);set(size,scale);
            set(damping,settings.damping);set(bassPole,pole(settings.bassFrequency));set(lowPole,pole(settings.lowCut));set(highPole,pole(settings.highCut));
            set(width,settings.width);set(earlyLevel,settings.early);const bool held=active&&settings.hold;
            set(hold,held?1.0f:0.0f);set(excitation,held&&!settings.holdInput?0.0f:1.0f);initialized=true;
        }
        std::array<float,2> process(float left,float right,bool active) noexcept
        {
            if(active)drain=static_cast<juce::int64>(rate*tail());else if(drain==0)return {};else if(--drain==0){reset();return {};}
            ++frames;const float held=hold.getNextValue(),inject=excitation.getNextValue(),predelay=preSamples.getNextValue();
            const float inputDiffusion=inputCoefficient.getNextValue(),spread=onset.getNextValue(),scale=size.getNextValue();
            const float motion=depth.getNextValue()*(1-held),damp=damping.getNextValue()*(1-held),bass=bassPole.getNextValue();
            const float sine=scatter.getNextValue(),cosine=std::sqrt(juce::jmax(0.0f,1-sine*sine));
            std::array<float,2> input{active?left*inject:0,active?right*inject:0},early{};
            constexpr std::array<float,4> spreads{.127f,.193f,.283f,.397f};
            constexpr std::array<float,8> reflections{.0037f,.0071f,.0113f,.0179f,.0233f,.0311f,.0437f,.0671f};
            for(size_t ch=0;ch<2;++ch)
            {
                pre[ch].write(input[ch]);input[ch]=pre[ch].read(predelay+1)*inject;earlyHistory[ch].write(input[ch]);
                if(mode==1)for(size_t tap=0;tap<reflections.size();++tap)
                    early[ch]+=earlyHistory[ch].read(reflections[tap]*scale*static_cast<float>(rate)*(ch==0?1.0f:1.071f))*(tap%3==ch?.12f:-.09f);
                float value=input[ch];for(int stage=0;stage<inputStages;++stage)
                    value=inputDiffusers[ch][static_cast<size_t>(stage)].allpass(value,juce::jmax(1.0f,spread*spreads[static_cast<size_t>(stage)]*(ch==0?1.0f:1.079f)),inputDiffusion);
                input[ch]+=(inputDiffusion/.72f)*(value-input[ch]);
            }
            std::array<float,16> feedback{};std::array<float,2> output{};
            for(int i=0;i<count;++i)
            {
                auto& line=lines[static_cast<size_t>(i)];const float length=line.samples.getNextValue(),amount=juce::jmin(motion,length*.2f);
                float delayed;
                if(mode==2)
                {
                    const float phase=static_cast<float>(line.phase),blend=phase*phase*(3-2*phase);
                    delayed=line.delay.read(length+line.from*amount)*(1-blend)+line.delay.read(length+line.to*amount)*blend;
                    line.phase+=settings.speed*(.73+static_cast<double>(i)*.037)/rate;
                    if(line.phase>=1){line.phase-=1;line.from=line.to;line.to=line.random();}
                }
                else
                {
                    delayed=line.delay.read(length+amount*static_cast<float>(line.oscillatorSine));
                    const double nextSine=line.oscillatorSine*line.rotationCosine+line.oscillatorCosine*line.rotationSine;
                    line.oscillatorCosine=line.oscillatorCosine*line.rotationCosine-line.oscillatorSine*line.rotationSine;line.oscillatorSine=nextSine;
                    if((frames&1023u)==0){const double norm=std::hypot(line.oscillatorSine,line.oscillatorCosine);line.oscillatorSine/=norm;line.oscillatorCosine/=norm;}
                }
                const float highLoss=line.loss.getNextValue(),lowLoss=line.bassLoss.getNextValue();
                line.low=delayed+bass*(line.low-delayed);
                float value=delayed*(highLoss+(1-highLoss)*held)+(line.low*(lowLoss-highLoss))*(1-held);
                line.damped=value+.5f*(line.damped-value);value+=damp*(line.damped-value);feedback[static_cast<size_t>(i)]=value;
                float observed=delayed;
                if(mode==0)
                {
                    observed=0;for(int tap=1;tap<=4;++tap){const float fraction=static_cast<float>(tap)*.25f;const float tapLoss=line.tapLoss[static_cast<size_t>(tap-1)].getNextValue();observed+=line.delay.read(length*fraction)*(tapLoss+(1-tapLoss)*held)*.25f;}
                }
                output[0]+=observed*(i%2==0?normalise:-normalise);
                output[1]+=observed*((i/2)%2==0?normalise:-normalise);
            }
            // Cascaded disjoint Givens rotations remain orthogonal throughout
            // smoothing. A fixed permutation avoids isolated comb loops at 0.
            for(int stride=1;stride<count;stride*=2)for(int base=0;base<count;base+=stride*2)for(int offset=0;offset<stride;++offset)
            {const size_t a=static_cast<size_t>(base+offset),b=static_cast<size_t>(base+offset+stride);const float first=feedback[a],second=feedback[b];feedback[a]=cosine*first+sine*second;feedback[b]=-sine*first+cosine*second;}
            for(int i=0;i<count;++i)
            {const float source=((i%2==0?input[0]:-input[0])+((i/2)%2==0?input[1]:-input[1]))*normalise*.5f;lines[static_cast<size_t>(i)].delay.write(feedback[static_cast<size_t>((i*5+1)%count)]+source);}
            const float earlyGain=earlyLevel.getNextValue(),low=lowPole.getNextValue(),high=highPole.getNextValue();
            const float fade=!active&&drain<static_cast<juce::int64>(rate*.05)?static_cast<float>(drain/(rate*.05)):1.0f;
            for(size_t ch=0;ch<2;++ch){output[ch]=(output[ch]*.5f+early[ch]*earlyGain)*fade;lowState[ch]=output[ch]+low*(lowState[ch]-output[ch]);const float value=output[ch]-lowState[ch];highState[ch]=value+high*(highState[ch]-value);output[ch]=highState[ch];}
            const float mid=(output[0]+output[1])*.5f,side=(output[0]-output[1])*.5f*width.getNextValue();return {mid+side,mid-side};
        }
    };
    std::array<Engine,3> engines;std::array<juce::SmoothedValue<float>,3> weights;
    BuiltInReverbSpillover<3> spillWeights;bool prepared=false;
public:
    void prepare(double rate,int selected)
    {for(size_t i=0;i<engines.size();++i){engines[i].prepare(rate,static_cast<int>(i));weights[i].reset(rate,.05);weights[i].setCurrentAndTargetValue(selected==static_cast<int>(i)?1.0f:0.0f);}spillWeights.prepare(rate,selected);prepared=true;}
    void reset() noexcept {for(auto& engine:engines)engine.reset();spillWeights.reset(weights);}
    void configure(int selected,Settings settings,bool spillover) noexcept
    {
        const auto safe=[](float value,float low,float high,float fallback){return std::isfinite(value)?juce::jlimit(low,high,value):fallback;};
        settings.decay=safe(settings.decay,.1f,20,2);settings.size=safe(settings.size,0,1,.5f);settings.damping=safe(settings.damping,0,1,.5f);settings.diffusion=safe(settings.diffusion,0,1,.5f);
        settings.preDelay=safe(settings.preDelay,0,500,0);settings.lowCut=safe(settings.lowCut,20,500,20);settings.highCut=safe(settings.highCut,1000,20000,20000);settings.width=safe(settings.width,0,1,1);settings.early=safe(settings.early,0,1,.5f);
        settings.inputDiffusion=safe(settings.inputDiffusion,0,1,.65f);settings.onset=safe(settings.onset,0,300,40);settings.depth=safe(settings.depth,0,1,.25f);settings.speed=safe(settings.speed,.05f,2,.3f);settings.bassRatio=safe(settings.bassRatio,.25f,4,1);settings.bassFrequency=safe(settings.bassFrequency,100,10000,500);
        for(size_t i=0;i<engines.size();++i){const bool active=selected==static_cast<int>(i);weights[i].setTargetValue(active?1.0f:0.0f);if(active||engines[i].drain>0)engines[i].configure(settings,active);spillWeights.configure(i,active,spillover,engines[i].drain>0);}
    }
    std::array<float,3> process(float left,float right) noexcept
    {if(!prepared)return {};std::array<float,3> result{};for(size_t i=0;i<engines.size();++i){const auto wet=engines[i].process(left,right,weights[i].getTargetValue()>0);const float weight=weights[i].getNextValue(),wetWeight=spillWeights.next(i);result[0]+=wet[0]*wetWeight;result[1]+=wet[1]*wetWeight;result[2]+=weight;}return result;}
    double retiringTailSeconds() const noexcept {double tail=0;for(size_t i=0;i<engines.size();++i)if(spillWeights.audibleRetiring(i))tail=juce::jmax(tail,static_cast<double>(engines[i].drain)/engines[i].rate);return tail;}
    juce::uint64 processingFrames(size_t index) const noexcept{return engines[index].frames;}
};
