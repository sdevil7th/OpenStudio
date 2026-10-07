#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"
#include "BuiltInVintageConverter.h"
#include <array>
#include <vector>

// Original digital spaces. These are declared network designs, not recovered
// coefficients or models of a commercial processor. All memory is prepared.
class BuiltInRetroReverb
{
public:
    static constexpr size_t count=14, controlCount=9;
    static constexpr std::array<const char*,count> names {"Radiant hall","Diffuse plate","Compact room","Cross chamber","Ensemble space","Reflection field","Vault","Grain hall","Grain plate","Shaped reflections","Long nave","Grand gallery","Aperture chamber","Aperture hall"};
    static constexpr std::array<const char*,controlCount> ids {"retroDecay","retroAttack","retroEarlyDiffusion","retroDepth","retroRate","retroEra","retroBassRatio","retroBassFrequency","retroAperture"};
    static constexpr std::array<const char*,controlCount> labels {"Decay","Attack","Early diffusion","Motion depth","Motion rate","Era","Bass decay","Bass crossover","Loop aperture"};
    static constexpr std::array<float,controlCount> minima {.1f,0,0,0,.05f,0,.25f,100,0}, maxima {70,1,1,1,8,2,4,10000,1}, defaults {2,.25f,.65f,.25f,.3f,2,1,500,.25f};
    struct Settings
    {
        float size=.5f,damping=.5f,diffusion=.5f,preDelay=0,lowCut=20,highCut=20000,width=1,early=.5f;
        float decay=2,attack=.25f,inputDiffusion=.65f,depth=.25f,speed=.3f,era=2,bassRatio=1,bassFrequency=500,aperture=.25f;
        bool hold=false,holdInput=false;
    };
    // Counts, topology, delay scale, input stages and ensemble voice count are
    // structural differences. Attack controls early/tail balance in Reflection
    // field and a finite envelope in Shaped reflections; elsewhere it spreads onset.
    struct Profile {int lines,core,matrix,stages,voices;float time,early,spread;bool grain,aperture;};
    static constexpr std::array<Profile,count> profiles {{
        {16,0,0,4,1,1.10f,.15f,.18f,false,false},
        {16,0,1,4,1,.62f,.05f,.10f,false,false},
        {8,0,2,2,1,.28f,.85f,.04f,false,false},
        {6,1,0,3,1,.60f,.35f,.08f,false,false},
        {16,0,2,4,3,.90f,.10f,.16f,false,false},
        {8,0,1,1,1,.38f,1.0f,.06f,false,false},
        {16,0,0,4,1,1.55f,.25f,.35f,false,false},
        {8,0,0,3,1,1.05f,.25f,.18f,true,false},
        {6,1,0,3,1,.65f,.10f,.09f,true,false},
        {0,2,0,0,1,1.0f,1.0f,0,false,false},
        {16,0,2,4,2,2.10f,.45f,.55f,false,false},
        {16,0,1,4,2,1.35f,.75f,.40f,false,false},
        {6,1,0,3,1,.72f,.45f,.12f,false,true},
        {16,0,2,4,2,1.18f,.30f,.24f,false,true}
    }};
private:
    struct Delay
    {
        std::vector<float> data;int position=0,valid=0;
        void prepare(int length){data.assign(static_cast<size_t>(length+4),0);reset();}
        void reset() noexcept {position=valid=0;}
        float read(float samples) const noexcept
        {
            samples=juce::jlimit(1.0f,static_cast<float>(data.size()-2),samples);
            const int n=static_cast<int>(samples),length=static_cast<int>(data.size());
            const auto a=(position+length-n)%length,b=(a+length-1)%length;
            const float first=n<=valid?data[static_cast<size_t>(a)]:0,second=n+1<=valid?data[static_cast<size_t>(b)]:0;
            return first+(samples-static_cast<float>(n))*(second-first);
        }
        void write(float value) noexcept {data[static_cast<size_t>(position)]=std::isfinite(value)?juce::jlimit(-16.0f,16.0f,value):0;valid=juce::jmin(valid+1,static_cast<int>(data.size()));if(++position==static_cast<int>(data.size()))position=0;}
        float allpass(float input,float length,float coefficient) noexcept {const float out=read(length)-coefficient*input;write(input+coefficient*out);return out;}
    };
    struct Line
    {
        Delay delay,inner;float base=0,low=0,damped=0;std::array<float,8> apertureHistory{};size_t aperturePosition=0;
        double sine=0,cosine=1,rotateSine=0,rotateCosine=1;
        juce::SmoothedValue<float> length,loss,bassLoss;
        void reset(size_t index) noexcept {delay.reset();inner.reset();low=damped=0;apertureHistory.fill(0);aperturePosition=0;sine=std::sin(static_cast<double>(index)*1.719);cosine=std::cos(static_cast<double>(index)*1.719);}
    };
    struct Engine
    {
        std::array<Line,16> lines;std::array<Delay,2> pre,reflections,loop;
        std::array<std::array<Delay,4>,2> diffusers;
        std::array<float,2> outputLow{},outputHigh{},loopLow{},loopDamped{};
        std::array<std::array<float,64>,2> reflectionTimes{},reflectionGains{};
        juce::SmoothedValue<float> size,preSamples,earlyDiffusion,lateDiffusion,onset,attack,depth,damping,bassPole,lowPole,highPole,width,earlyLevel,hold,excitation,aperture,loopGain,loopBassGain;
        Settings settings;Profile profile{};double rate=48000;int kind=0,era=2;bool initialized=false;juce::int64 drain=0;juce::uint64 frames=0;
        void prepare(double sampleRate,int index,int colour)
        {
            rate=sampleRate;kind=index;era=colour;profile=profiles[static_cast<size_t>(kind)];
            constexpr std::array<float,16> seconds {.0173f,.0239f,.0311f,.0413f,.0533f,.0671f,.0797f,.0971f,.0197f,.0293f,.0377f,.0479f,.0613f,.0719f,.0899f,.1039f};
            for(size_t i=0;i<lines.size();++i)
            {
                auto& line=lines[i];line.base=seconds[(i*5+static_cast<size_t>(kind))%seconds.size()]*profile.time;
                // Only a topology's used lines need sample storage.
                line.delay.prepare(i<static_cast<size_t>(profile.lines)?static_cast<int>(rate*(line.base*1.5f+.015f)):1);
                line.inner.prepare(profile.core==1&&i<6?static_cast<int>(rate*(line.base*.51f+.015f)):1);
                for(auto* value:{&line.length,&line.loss,&line.bassLoss})value->reset(rate,.1);
            }
            for(auto& value:pre)value.prepare(static_cast<int>(rate*.501));
            for(auto& value:reflections)value.prepare(static_cast<int>(rate*(profile.core==2?2.01:.75)));
            for(auto& value:loop)value.prepare(profile.core==1?static_cast<int>(rate*.15):1);
            for(auto& channel:diffusers)for(auto& value:channel)value.prepare(static_cast<int>(rate*(profile.spread*.65f+.002f)));
            for(auto* value:{&size,&preSamples,&earlyDiffusion,&lateDiffusion,&onset,&attack,&depth,&damping,&bassPole,&lowPole,&highPole,&width,&earlyLevel,&hold,&excitation,&aperture,&loopGain,&loopBassGain})value->reset(rate,.05);
            // Deterministic, nonuniform stereo reflection pattern, prepared once.
            juce::uint32 seed=73823u+static_cast<juce::uint32>(kind)*17137u;
            for(size_t ch=0;ch<2;++ch)for(size_t tap=0;tap<64;++tap)
            {seed^=seed<<13;seed^=seed>>17;seed^=seed<<5;const float jitter=static_cast<float>(seed&65535u)/65535;reflectionTimes[ch][tap]=(static_cast<float>(tap)+.15f+.7f*jitter)/64;reflectionGains[ch][tap]=(seed&65536u?1.0f:-1.0f)*(.7f+.3f*jitter)/8;}
            reset();frames=0;
        }
        void reset() noexcept
        {for(size_t i=0;i<lines.size();++i)lines[i].reset(i);for(auto& v:pre)v.reset();for(auto& v:reflections)v.reset();for(auto& v:loop)v.reset();for(auto& ch:diffusers)for(auto& v:ch)v.reset();outputLow={};outputHigh={};loopLow={};loopDamped={};initialized=false;drain=0;frames=0;}
        double tail() const noexcept {return profile.core==2?2.05+settings.preDelay*.001:juce::jmin(120.0,settings.decay*juce::jmax(1.0f,settings.bassRatio)*2+2+settings.preDelay*.001+profile.spread);}
        void configure(const Settings& next,bool active) noexcept
        {
            if(active)settings=next;
            const auto set=[this](auto& v,float target){if(initialized)v.setTargetValue(target);else v.setCurrentAndTargetValue(target);};
            const float sr=static_cast<float>(rate),scale=.5f+settings.size;
            const auto pole=[sr](float hz){return std::exp(-juce::MathConstants<float>::twoPi*juce::jmin(hz,sr*.45f)/sr);};
            for(int i=0;i<profile.lines;++i)
            {
                auto& line=lines[static_cast<size_t>(i)];const float length=line.base*scale*sr;
                set(line.length,length);set(line.loss,std::pow(.001f,length/(sr*settings.decay)));set(line.bassLoss,std::pow(.001f,length/(sr*settings.decay*settings.bassRatio)));
                const double angle=juce::MathConstants<double>::twoPi*settings.speed*(.71+.043*i)/rate;
                line.rotateSine=std::sin(angle);line.rotateCosine=std::cos(angle);
            }
            set(size,scale);set(preSamples,settings.preDelay*.001f*sr);set(earlyDiffusion,settings.inputDiffusion*.72f);set(lateDiffusion,settings.diffusion*.70f);
            set(attack,settings.attack);set(onset,settings.attack*profile.spread*sr);set(depth,settings.depth*sr*.0025f);set(damping,settings.damping);
            set(bassPole,pole(settings.bassFrequency));set(lowPole,pole(settings.lowCut));set(highPole,pole(juce::jmin(settings.highCut,era==0?7500.0f:era==1?12000.0f:20000.0f)));
            set(width,settings.width);set(earlyLevel,settings.early);set(aperture,settings.aperture);
            // Nested allpasses are lossless; their mean group delay is included
            // in this declared nominal loop length, not claimed as calibrated RT60.
            const float nominal=.065f+profile.time*.26f;
            set(loopGain,std::pow(.001f,nominal*scale/settings.decay));set(loopBassGain,std::pow(.001f,nominal*scale/(settings.decay*settings.bassRatio)));
            const bool held=active&&settings.hold&&profile.core!=2;set(hold,held?1.0f:0.0f);set(excitation,held&&!settings.holdInput?0.0f:1.0f);initialized=true;
        }
        float readLine(Line& line,float length,float amount) noexcept
        {
            float value=line.delay.read(length+amount*static_cast<float>(line.sine));
            if(profile.voices>=2)value=(value+line.delay.read(length+amount*static_cast<float>(-.5*line.sine+.8660254*line.cosine)))*.5f;
            if(profile.voices==3)value=(value*2+line.delay.read(length+amount*static_cast<float>(-.5*line.sine-.8660254*line.cosine)))/3;
            const double next=line.sine*line.rotateCosine+line.cosine*line.rotateSine;line.cosine=line.cosine*line.rotateCosine-line.sine*line.rotateSine;line.sine=next;
            if((frames&1023u)==0){const double norm=std::hypot(line.sine,line.cosine);line.sine/=norm;line.cosine/=norm;}
            return value;
        }
        float colour(float input,int bits) const noexcept
        {
            if(!profile.grain&&era==2)return input;
            const float scale=static_cast<float>(1<<bits);
            // Truncation towards zero is dissipative and cannot sustain a
            // rounding limit cycle in a decaying feedback path.
            return std::trunc(input*scale)/scale;
        }
        std::array<float,2> process(std::array<float,2> input,bool active) noexcept
        {
            if(active)drain=static_cast<juce::int64>(rate*tail());else if(drain==0)return {};else if(--drain==0){reset();return {};}
            ++frames;const float held=hold.getNextValue(),inject=excitation.getNextValue(),scale=size.getNextValue(),predelay=preSamples.getNextValue();
            const float earlyCoefficient=earlyDiffusion.getNextValue(),lateCoefficient=lateDiffusion.getNextValue(),spread=onset.getNextValue(),attackValue=attack.getNextValue();
            const float motion=depth.getNextValue()*(1-held),damp=damping.getNextValue()*(1-held),bass=bassPole.getNextValue(),apertureAmount=aperture.getNextValue()*(1-held);
            const float earlyGain=earlyLevel.getNextValue();std::array<float,2> early{},output{};
            for(size_t ch=0;ch<2;++ch)
            {
                pre[ch].write(active?input[ch]*inject:0);input[ch]=pre[ch].read(predelay+1)*inject;reflections[ch].write(input[ch]);
                const float duration=profile.core==2?.025f+1.975f*(scale-.5f):(.02f+profile.time*.12f)*scale;
                for(size_t tap=0;tap<64;++tap)
                {
                    const float relative=reflectionTimes[ch][tap];float envelope=1-relative*.7f;
                    if(profile.core==2){const float a=attackValue;envelope=a<=.5f?1-(1-2*a)*relative:1-(2*a-1)*(1-relative);}
                    early[ch]+=reflections[ch].read(1+relative*duration*static_cast<float>(rate))*reflectionGains[ch][tap]*envelope;
                }
                float diffused=input[ch];constexpr std::array<float,4> fractions{.127f,.193f,.283f,.397f};
                for(int stage=0;stage<profile.stages;++stage)diffused=diffusers[ch][static_cast<size_t>(stage)].allpass(diffused,1+spread*fractions[static_cast<size_t>(stage)]*(ch==0?1.0f:1.071f),earlyCoefficient);
                input[ch]+=(earlyCoefficient/.72f)*(diffused-input[ch]);
            }
            const int bits=profile.grain?(era==0?9:era==1?11:13):(era==0?12:16);
            if(profile.core==0)
            {
                std::array<float,16> feedback{};const float norm=1/std::sqrt(static_cast<float>(profile.lines));
                for(int i=0;i<profile.lines;++i)
                {
                    auto& line=lines[static_cast<size_t>(i)];const float length=line.length.getNextValue(),delayed=readLine(line,length,juce::jmin(motion,length*.15f));
                    const float loss=line.loss.getNextValue(),lowLoss=line.bassLoss.getNextValue();line.low=delayed+bass*(line.low-delayed);
                    float value=delayed*(loss+(1-loss)*held)+line.low*(lowLoss-loss)*(1-held);line.damped=value+.55f*(line.damped-value);value+=damp*(line.damped-value);
                    if(profile.aperture){line.apertureHistory[line.aperturePosition]=value;line.aperturePosition=(line.aperturePosition+1)%8;float mean=0;for(float sample:line.apertureHistory)mean+=sample*.125f;value+=apertureAmount*(mean-value);}
                    feedback[static_cast<size_t>(i)]=held>.999f?value:colour(value,bits);
                    output[0]+=delayed*(i%2==0?norm:-norm);output[1]+=delayed*((i/2)%2==0?norm:-norm);
                }
                if(profile.matrix==0)
                {float mean=0;for(int i=0;i<profile.lines;++i)mean+=feedback[static_cast<size_t>(i)]*2/static_cast<float>(profile.lines);for(int i=0;i<profile.lines;++i)feedback[static_cast<size_t>(i)]=mean-feedback[static_cast<size_t>(i)];}
                else
                {
                    const float sine=profile.matrix==1?.70710678f:lateCoefficient,cosine=std::sqrt(juce::jmax(0.0f,1-sine*sine));
                    for(int stride=1;stride<profile.lines;stride*=2)for(int base=0;base<profile.lines;base+=stride*2)for(int offset=0;offset<stride;++offset)
                    {const size_t a=static_cast<size_t>(base+offset),b=static_cast<size_t>(base+offset+stride);const float first=feedback[a],second=feedback[b];feedback[a]=cosine*first+sine*second;feedback[b]=-sine*first+cosine*second;}
                }
                // Householder/Hadamard use an additional variable orthogonal
                // rotation so late diffusion is effective for every FDN profile.
                if(profile.matrix!=2)for(int i=0;i<profile.lines;i+=2){const size_t a=static_cast<size_t>(i),b=a+1;const float sine=lateCoefficient,cosine=std::sqrt(1-sine*sine),first=feedback[a],second=feedback[b];feedback[a]=cosine*first+sine*second;feedback[b]=-sine*first+cosine*second;}
                for(int i=0;i<profile.lines;++i){const float source=((i%2==0?input[0]:-input[0])+((i/2)%2==0?input[1]:-input[1]))*norm*.5f;lines[static_cast<size_t>(i)].delay.write(feedback[static_cast<size_t>((i*5+1)%profile.lines)]+source);}
                for(auto& value:output)value*=.5f;
            }
            else if(profile.core==1)
            {
                const float gain=loopGain.getNextValue(),bassGain=loopBassGain.getNextValue();std::array<float,2> returned{};
                for(size_t ch=0;ch<2;++ch)
                {
                    float value=loop[ch].read(static_cast<float>(rate)*(ch==0?.053f:.071f)*scale);
                    loopLow[ch]=value+bass*(loopLow[ch]-value);value=value*(gain+(1-gain)*held)+loopLow[ch]*(bassGain-gain)*(1-held);
                    loopDamped[ch]=value+.55f*(loopDamped[ch]-value);returned[ch]=held>.999f?value:colour(value+damp*(loopDamped[ch]-value),bits);
                }
                for(size_t ch=0;ch<2;++ch)
                {
                    float value=input[ch]*.35f+(ch==0?(returned[0]+returned[1]):(returned[0]-returned[1]))*.70710678f;
                    for(size_t stage=0;stage<3;++stage)
                    {
                        auto& line=lines[ch*3+stage];const float length=line.length.getNextValue();line.loss.getNextValue();line.bassLoss.getNextValue();
                        float delayed=readLine(line,length,juce::jmin(motion,length*.15f));
                        if(profile.aperture){line.apertureHistory[line.aperturePosition]=delayed;line.aperturePosition=(line.aperturePosition+1)%8;float mean=0;for(float sample:line.apertureHistory)mean+=sample*.125f;delayed+=apertureAmount*(mean-delayed);}
                        const float out=delayed-lateCoefficient*value;const float innerInput=value+lateCoefficient*out;
                        line.delay.write(line.inner.allpass(innerInput,length*.31f,lateCoefficient*.83f));value=out;
                        output[ch]+=out/3;
                    }
                    loop[ch].write(value);
                }
            }
            if(profile.core==2)output=early;
            else if(kind==5)for(size_t ch=0;ch<2;++ch)output[ch]=early[ch]*(1-attackValue)+output[ch]*attackValue;
            else for(size_t ch=0;ch<2;++ch)output[ch]+=early[ch]*earlyGain*profile.early;
            const float low=lowPole.getNextValue(),high=highPole.getNextValue();const float fade=!active&&drain<static_cast<juce::int64>(rate*.05)?static_cast<float>(drain/(rate*.05)):1;
            for(size_t ch=0;ch<2;++ch){output[ch]*=fade;outputLow[ch]=output[ch]+low*(outputLow[ch]-output[ch]);const float value=output[ch]-outputLow[ch];outputHigh[ch]=value+high*(outputHigh[ch]-value);output[ch]=outputHigh[ch];}
            const float mid=(output[0]+output[1])*.5f,side=(output[0]-output[1])*.5f*width.getNextValue();return {mid+side,mid-side};
        }
    };
    struct RateEngine
    {
        std::array<Engine,3> engines;std::array<BuiltInVintageConverter::Bank,3> converters;
        std::array<juce::SmoothedValue<float>,3> weights;BuiltInReverbSpillover<3> spills;std::array<bool,3> converterRunning{};double rate=48000;
        void prepare(double sr,int kind){rate=sr;constexpr std::array<double,3> rates{24000,32000,48000};for(size_t i=0;i<3;++i){const double target=juce::jmin(sr,rates[i]);engines[i].prepare(target,kind,static_cast<int>(i));converters[i].prepare(sr,target,16);weights[i].reset(sr,.05);weights[i].setCurrentAndTargetValue(0);}spills.prepare(sr,-1);}
        void reset() noexcept {for(auto& engine:engines)engine.reset();for(auto& converter:converters)converter.reset();converterRunning.fill(false);for(auto& weight:weights)weight.setCurrentAndTargetValue(weight.getTargetValue());spills.reset(weights);}
        void configure(Settings settings,bool active,bool spillover) noexcept
        {const int selected=active?juce::jlimit(0,2,juce::roundToInt(settings.era)):-1;for(size_t i=0;i<3;++i){const bool enabled=selected==static_cast<int>(i);weights[i].setTargetValue(enabled?1.0f:0.0f);if(enabled||engines[i].drain>0)engines[i].configure(settings,enabled);spills.configure(i,enabled,spillover,engines[i].drain>0);}}
        std::array<float,2> process(float left,float right) noexcept
        {std::array<float,2> output{};for(size_t i=0;i<3;++i){const bool active=weights[i].getTargetValue()>0;weights[i].getNextValue();const float wet=spills.next(i);if(!active&&wet<=0&&engines[i].drain>0)engines[i].reset();if(active||engines[i].drain>0){converterRunning[i]=true;const auto value=converters[i].processThrough({active?left:0,active?right:0},[&](const auto& input) noexcept{return engines[i].process(input,active);});for(size_t ch=0;ch<2;++ch)output[ch]+=value[ch]*wet;}else if(converterRunning[i]){converters[i].reset();converterRunning[i]=false;}}return output;}
        double tail() const noexcept {double result=0;for(size_t i=0;i<3;++i)if(spills.audibleRetiring(i))result=juce::jmax(result,static_cast<double>(engines[i].drain)/engines[i].rate);return result;}
        bool running() const noexcept {for(const auto& engine:engines)if(engine.drain>0)return true;return false;}
    };
    std::array<RateEngine,count> engines;std::array<juce::SmoothedValue<float>,count> weights;
    BuiltInReverbSpillover<count> spills;bool prepared=false;
public:
    void prepare(double rate,int selected){for(size_t i=0;i<count;++i){engines[i].prepare(rate,static_cast<int>(i));weights[i].reset(rate,.05);weights[i].setCurrentAndTargetValue(selected==static_cast<int>(i)?1.0f:0.0f);}spills.prepare(rate,selected);prepared=true;}
    void reset() noexcept {for(auto& engine:engines)engine.reset();for(auto& weight:weights)weight.setCurrentAndTargetValue(weight.getTargetValue());spills.reset(weights);}
    void configure(int selected,Settings settings,bool spillover) noexcept
    {
        const auto safe=[](float value,float low,float high,float fallback){return std::isfinite(value)?juce::jlimit(low,high,value):fallback;};
        settings.size=safe(settings.size,0,1,.5f);settings.damping=safe(settings.damping,0,1,.5f);settings.diffusion=safe(settings.diffusion,0,1,.5f);settings.preDelay=safe(settings.preDelay,0,500,0);settings.lowCut=safe(settings.lowCut,20,500,20);settings.highCut=safe(settings.highCut,1000,20000,20000);settings.width=safe(settings.width,0,1,1);settings.early=safe(settings.early,0,1,.5f);
        settings.decay=safe(settings.decay,.1f,70,2);settings.attack=safe(settings.attack,0,1,.25f);settings.inputDiffusion=safe(settings.inputDiffusion,0,1,.65f);settings.depth=safe(settings.depth,0,1,.25f);settings.speed=safe(settings.speed,.05f,8,.3f);settings.era=safe(settings.era,0,2,2);settings.bassRatio=safe(settings.bassRatio,.25f,4,1);settings.bassFrequency=safe(settings.bassFrequency,100,10000,500);settings.aperture=safe(settings.aperture,0,1,.25f);
        for(size_t i=0;i<count;++i){const bool active=selected==static_cast<int>(i);weights[i].setTargetValue(active?1.0f:0.0f);engines[i].configure(settings,active,spillover);spills.configure(i,active,spillover,engines[i].running());}
    }
    std::array<float,3> process(float left,float right) noexcept
    {if(!prepared)return {};std::array<float,3> result{};for(size_t i=0;i<count;++i){const auto wet=engines[i].process(left,right);const float selection=weights[i].getNextValue(),weight=spills.next(i);result[0]+=wet[0]*weight;result[1]+=wet[1]*weight;result[2]+=selection;}return result;}
    double retiringTailSeconds() const noexcept {double result=0;for(const auto& engine:engines)result=juce::jmax(result,engine.tail());return result;}
    juce::uint64 processingFrames(size_t kind,size_t era) const noexcept{return engines[kind].engines[era].frames;}
};
