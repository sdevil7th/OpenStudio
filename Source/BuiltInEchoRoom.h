#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"

// Original multi-head echo and finite image-source room. No sampled room/tape model.
class BuiltInEchoRoom
{
public:
    using Pair=std::array<float,2>;
    struct Settings {float size=.5f,damping=.5f,diffusion=.5f,predelay=0,lowCut=20,highCut=20000,width=1,time=600,heads=1,spacing=0,feedback=.35f,motion=.1f,shape=0,x=.5f,y=.5f;bool hold=false,acceptsInput=false;};
private:
    struct Delay
    {
        std::vector<Pair> data;int position=0,valid=0;
        void prepare(int length){data.assign(static_cast<size_t>(length+4),{});reset();}
        void reset(){position=valid=0;}
        float read(float delay,size_t ch)const
        {
            delay=juce::jlimit(1.0f,static_cast<float>(data.size()-2),delay);const int whole=static_cast<int>(delay),length=static_cast<int>(data.size());const float fraction=delay-static_cast<float>(whole);
            const auto tap=[&](int n){return n<=valid?data[static_cast<size_t>((position+length-n)%length)][ch]:0;};return tap(whole)+fraction*(tap(whole+1)-tap(whole));
        }
        void write(Pair value){data[static_cast<size_t>(position)]=value;valid=juce::jmin(valid+1,static_cast<int>(data.size()));if(++position==static_cast<int>(data.size()))position=0;}
    };
    struct Engine
    {
        Delay input,echo;std::array<Delay,2> diffusers;
        std::array<Pair,124> delays{},gains{},targetDelays{},targetGains{};
        juce::SmoothedValue<float> pre,time,feedback,diffusion,motion,lowPole,highPole,dampPole,dampMix,lowMix,highMix,width,panLeft,panRight,holdWeight,inputGate;
        std::array<juce::SmoothedValue<float>,6> headPositions,headLevels,feedbackLevels;
        Pair lowState{},highState{},dampState{},loopDamp{},loopLow{},loopHigh{};Settings settings;double rate=48000,phase=0,flutterPhase=0;int mode=0,geometryRemaining=0;float roomPeriod=1;bool initialized=false;juce::uint64 frames=0;
        void prepare(double fs,int index)
        {
            rate=fs;mode=index;input.prepare(static_cast<int>(fs*.51));echo.prepare(static_cast<int>(fs*(index==0?1.55:.5)));for(size_t i=0;i<diffusers.size();++i)diffusers[i].prepare(static_cast<int>(fs*.03));
            for(auto* value:{&pre,&time,&feedback,&diffusion,&motion,&lowPole,&highPole,&dampPole,&dampMix,&lowMix,&highMix,&width,&panLeft,&panRight,&holdWeight,&inputGate})value->reset(fs,.05);
            for(auto& value:headPositions)value.reset(fs,.1);for(auto& value:headLevels)value.reset(fs,.05);for(auto& value:feedbackLevels)value.reset(fs,.05);reset();frames=0;
        }
        void reset(){input.reset();echo.reset();for(auto& line:diffusers)line.reset();lowState={};highState={};dampState={};loopDamp={};loopLow={};loopHigh={};phase=flutterPhase=0;initialized=false;geometryRemaining=0;}
        void configure(Settings next)
        {
            if(next.hold&&initialized)
            {
                if(mode==0){next.time=settings.time;next.heads=settings.heads;next.spacing=settings.spacing;}
                else{next.size=settings.size;next.shape=settings.shape;next.x=settings.x;next.y=settings.y;next.damping=settings.damping;}
            }
            const bool geometryChanged=!initialized||next.size!=settings.size||next.shape!=settings.shape||next.x!=settings.x||next.y!=settings.y||next.damping!=settings.damping;
            settings=next;const auto set=[&](auto& value,float target){if(initialized)value.setTargetValue(target);else value.setCurrentAndTargetValue(target);};
            set(pre,settings.predelay*.001f*static_cast<float>(rate));set(time,static_cast<float>(settings.time*.001*rate));set(feedback,settings.hold?1.0f:settings.feedback);set(diffusion,settings.diffusion);set(motion,settings.hold?0.0f:settings.motion);
            set(holdWeight,settings.hold?1.0f:0.0f);set(inputGate,settings.hold&&!settings.acceptsInput?0.0f:1.0f);set(width,settings.width);
            set(lowPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*settings.lowCut/rate)));set(highPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*settings.highCut/rate)));
            set(dampMix,settings.damping>0?1.0f:0);set(dampPole,static_cast<float>(1-std::exp(-juce::MathConstants<double>::twoPi*(18000*std::pow(1.0/36,settings.damping))/rate)));set(lowMix,settings.lowCut>20?1.0f:0);set(highMix,settings.highCut<20000?1.0f:0);
            if(mode==0)
            {
                constexpr std::array<int,3> counts{3,4,6};const int count=counts[static_cast<size_t>(juce::jlimit(0,2,juce::roundToInt(settings.heads)))];
                for(size_t i=0;i<6;++i){const float fraction=static_cast<float>(juce::jmin(static_cast<int>(i)+1,count))/static_cast<float>(count);set(headPositions[i],settings.spacing>=.5f?std::pow(fraction,1.37f):fraction);set(headLevels[i],static_cast<int>(i)<count?1.0f/static_cast<float>(count):0);set(feedbackLevels[i],settings.spacing>=.5f?(static_cast<int>(i)>=count-2&&static_cast<int>(i)<count?.5f:0):(static_cast<int>(i)==count-1?1.0f:0));}
                set(panLeft,1);set(panRight,1);
            }
            else if(geometryChanged)
            {
                roomPeriod=1;
                const double area=9.3+83.6*settings.size,aspect=settings.shape<.5f?1:settings.shape<1.5f?1.618:1/1.618,w=std::sqrt(area*aspect),length=area/w,height=2.8;
                const auto image=[](int index,double span,double source){return index*span+(std::abs(index)%2?span-source:source);};
                size_t tap=0;for(int nx=-2;nx<=2;++nx)for(int ny=-2;ny<=2;++ny)for(int nz=-2;nz<=2;++nz)
                {
                    if(nx==0&&ny==0&&nz==0)continue;const int order=std::abs(nx)+std::abs(ny)+std::abs(nz);
                    for(size_t ch=0;ch<2;++ch)
                    {
                        const double sign=ch==0?-1:1,sx=(.1+.8*settings.x)*w+sign*.15,sy=(.1+.8*settings.y)*length;
                        const double dx=image(nx,w,sx)-(.5*w+sign*.09),dy=image(ny,length,sy)-.1*length,dz=image(nz,height,1.4)-1.4,distance=std::sqrt(dx*dx+dy*dy+dz*dz);
                        targetDelays[tap][ch]=static_cast<float>(distance/343*rate);roomPeriod=juce::jmax(roomPeriod,std::ceil(targetDelays[tap][ch]));targetGains[tap][ch]=static_cast<float>(.65*std::pow(.85-.35*settings.damping,order)/juce::jmax(1.0,distance));
                    }
                    ++tap;
                }
                const double dx=(settings.x-.5)*w,dy=.8*settings.y*length,distance=std::sqrt(dx*dx+dy*dy),direct=1/(1+.15*distance);
                set(panLeft,static_cast<float>(std::sqrt(2.0)*std::cos(settings.x*juce::MathConstants<double>::halfPi)*direct));set(panRight,static_cast<float>(std::sqrt(2.0)*std::sin(settings.x*juce::MathConstants<double>::halfPi)*direct));
                if(!initialized){delays=targetDelays;gains=targetGains;}else geometryRemaining=static_cast<int>(rate*.1);
            }
            initialized=true;
        }
        std::array<float,4> process(Pair source,bool active)
        {
            ++frames;const float predelay=pre.getNextValue(),gate=inputGate.getNextValue(),held=holdWeight.getNextValue();Pair delayed{},wet{};const Pair excitation=active?Pair{source[0]*gate,source[1]*gate}:Pair{};
            for(size_t ch=0;ch<2;++ch)delayed[ch]=(predelay<1?excitation[ch]:input.read(predelay,ch))*gate;input.write(excitation);
            const float lp=highPole.getNextValue(),hp=lowPole.getNextValue(),damp=dampPole.getNextValue(),loMix=lowMix.getNextValue(),hiMix=highMix.getNextValue(),dampAmount=dampMix.getNextValue();
            if(mode==0)
            {
                const float samples=time.getNextValue(),fb=feedback.getNextValue(),smear=diffusion.getNextValue(),wow=motion.getNextValue();Pair repeat{};
                for(size_t head=0;head<6;++head)
                {
                    const float position=headPositions[head].getNextValue(),level=headLevels[head].getNextValue(),loopLevel=feedbackLevels[head].getNextValue();
                    for(size_t ch=0;ch<2;++ch){const float movement=wow*static_cast<float>(rate)*(.002f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*(phase+ch*.25)))+.0002f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*(flutterPhase+head*.13))));const float sample=echo.read(samples*position+movement,ch);wet[ch]+=sample*level;repeat[ch]+=sample*loopLevel;}
                }
                phase+=.31/rate;if(phase>=1)phase-=1;flutterPhase+=6.7/rate;if(flutterPhase>=1)flutterPhase-=1;Pair next{};
                for(size_t ch=0;ch<2;++ch){loopDamp[ch]+=damp*(repeat[ch]-loopDamp[ch]);float filtered=repeat[ch]+dampAmount*(loopDamp[ch]-repeat[ch]);loopLow[ch]+=hp*(filtered-loopLow[ch]);filtered-=loMix*loopLow[ch];loopHigh[ch]+=lp*(filtered-loopHigh[ch]);filtered+=hiMix*(loopHigh[ch]-filtered);const float heldReturn=echo.read(std::round(samples),ch);if(held>=1)filtered=heldReturn;else if(held>0)filtered+=held*(heldReturn-filtered);next[ch]=juce::jlimit(-2.0f,2.0f,delayed[ch]+fb*filtered);}
                echo.write(next);
                for(size_t stage=0;stage<2;++stage){Pair write{},output{};const float length=static_cast<float>(rate)*(stage==0?.0071f:.0113f);for(size_t ch=0;ch<2;++ch){const float value=diffusers[stage].read(length,ch);output[ch]=value-.6f*wet[ch];write[ch]=wet[ch]+.6f*output[ch];}diffusers[stage].write(write);for(size_t ch=0;ch<2;++ch)wet[ch]+=smear*(output[ch]-wet[ch]);}
            }
            else
            {
                for(size_t tap=0;tap<delays.size();++tap)for(size_t ch=0;ch<2;++ch){if(geometryRemaining>0){delays[tap][ch]+=(targetDelays[tap][ch]-delays[tap][ch])/static_cast<float>(geometryRemaining);gains[tap][ch]+=(targetGains[tap][ch]-gains[tap][ch])/static_cast<float>(geometryRemaining);}wet[ch]+=echo.read(delays[tap][ch],ch)*gains[tap][ch];}
                if(geometryRemaining>0)--geometryRemaining;
                if(held>0)for(size_t ch=0;ch<2;++ch)delayed[ch]=juce::jlimit(-2.0f,2.0f,delayed[ch]+held*echo.read(roomPeriod,ch));
                echo.write(delayed);
            }
            for(size_t ch=0;ch<2;++ch){dampState[ch]+=damp*(wet[ch]-dampState[ch]);wet[ch]+=dampAmount*(dampState[ch]-wet[ch]);lowState[ch]+=hp*(wet[ch]-lowState[ch]);wet[ch]-=loMix*lowState[ch];highState[ch]+=lp*(wet[ch]-highState[ch]);wet[ch]+=hiMix*(highState[ch]-wet[ch]);}
            const float mid=(wet[0]+wet[1])*.5f,side=(wet[0]-wet[1])*.5f*width.getNextValue();return {mid+side,mid-side,source[0]*panLeft.getNextValue(),source[1]*panRight.getNextValue()};
        }
    };
    std::array<Engine,2> engines;std::array<juce::SmoothedValue<float>,2> weights;std::array<bool,2> running{};BuiltInReverbRetirement<2> retirement;bool prepared=false;
public:
    void prepare(double fs,int selected){for(size_t i=0;i<2;++i){engines[i].prepare(fs,static_cast<int>(i));weights[i].reset(fs,.05);weights[i].setCurrentAndTargetValue(selected==static_cast<int>(i)?1.0f:0);}running={};prepared=true;retirement.prepare(fs,selected);}
    void reset(){for(auto& engine:engines)engine.reset();running={};retirement.reset(weights);}
    void configure(int selected,Settings settings,bool retainTails=false){
        const auto safe=[](float value,float lo,float hi,float fallback){return std::isfinite(value)?juce::jlimit(lo,hi,value):fallback;};
        settings.size=safe(settings.size,0,1,.5f);settings.damping=safe(settings.damping,0,1,.5f);settings.diffusion=safe(settings.diffusion,0,1,.5f);settings.predelay=safe(settings.predelay,0,500,0);settings.lowCut=safe(settings.lowCut,20,500,20);settings.highCut=safe(settings.highCut,1000,20000,20000);settings.width=safe(settings.width,0,1,1);settings.time=safe(settings.time,200,1500,600);settings.heads=safe(settings.heads,0,2,1);settings.spacing=safe(settings.spacing,0,1,0);settings.feedback=safe(settings.feedback,0,.98f,.35f);settings.motion=safe(settings.motion,0,1,.1f);settings.shape=safe(settings.shape,0,2,0);settings.x=safe(settings.x,0,1,.5f);settings.y=safe(settings.y,0,1,.5f);
        for(size_t i=0;i<2;++i)
        {
            const double time=settings.time*.001,feedback=settings.feedback;const double tail=(i==1?.6:time+(feedback>0?time*std::log(.001)/std::log(feedback):0)+.2)+settings.predelay*.001;
            retirement.configure(i,selected==static_cast<int>(i),retainTails,tail);
            weights[i].setTargetValue(selected==static_cast<int>(i)?1.0f:0);
            if(selected==static_cast<int>(i))engines[i].configure(settings);
            else if(engines[i].initialized&&engines[i].settings.hold){auto outgoing=engines[i].settings;outgoing.hold=false;engines[i].configure(outgoing);}

        }}
    std::array<float,5> process(float left,float right)
    {
        std::array<float,5> result{};if(!prepared)return result;const auto safe=[](float x){return std::isfinite(x)?juce::jlimit(-16.0f,16.0f,x):0;};
        for(size_t i=0;i<2;++i){const float weight=weights[i].getNextValue(),wetWeight=retirement.next(i);if(wetWeight==0&&weight==0&&weights[i].getTargetValue()==0){if(running[i])engines[i].reset();running[i]=false;continue;}running[i]=true;const auto output=engines[i].process({safe(left),safe(right)},weights[i].getTargetValue()>0);result[0]+=wetWeight*output[0];result[1]+=wetWeight*output[1];result[2]+=weight;result[3]+=weight*output[2];result[4]+=weight*output[3];}return result;
    }
    double retiringTailSeconds()const noexcept{return retirement.retiringTailSeconds();}
    std::array<juce::uint64,2> processedFrames()const{return {engines[0].frames,engines[1].frames};}
};
