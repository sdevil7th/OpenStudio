#pragma once
#include <JuceHeader.h>

// Original plate input colour and pre/post chorus, with exact neutral paths.
class BuiltInPlateColour
{
public:
    struct Settings {float drive=0,cut=20,chorus=0,post=0,amount=.5f,eq=0,lowFrequency=20,lowGain=0,highFrequency=20000,highGain=0;};
    using Pair=std::array<float,2>;
private:
    using Coefficients=std::array<double,5>;
    struct Filter
    {
        Coefficients current{1,0,0,0,0},target{1,0,0,0,0};std::array<std::array<double,2>,2> history{};
        void set(Coefficients next,bool initial){target=next;if(initial)current=target;}
        void advance(double coefficient){for(size_t i=0;i<5;++i)current[i]+=coefficient*(target[i]-current[i]);}
        float process(float x,size_t ch){auto& h=history[ch];const double y=current[0]*x+h[0];h[0]=current[1]*x-current[3]*y+h[1];h[1]=current[2]*x-current[4]*y;return static_cast<float>(y);}
        void reset(){history={};}
    };
    struct Chorus
    {
        std::array<std::vector<float>,2> data;int position=0,valid=0;double phase=0,rate=48000;
        void prepare(double fs){rate=fs;for(auto& channel:data)channel.assign(static_cast<size_t>(std::ceil(fs*.02))+4,0);reset();}
        void reset(){position=valid=0;phase=0;}
        Pair process(Pair input,float mix,double frequency)
        {
            Pair output=input;const int length=static_cast<int>(data[0].size());
            for(size_t ch=0;ch<2;++ch)
            {
                const double delay=rate*(.012+.003*std::sin(juce::MathConstants<double>::twoPi*(phase+static_cast<double>(ch)*.25)));
                const int whole=static_cast<int>(delay);const float fraction=static_cast<float>(delay-whole);
                const auto tap=[&](int n){return n<=valid?data[ch][static_cast<size_t>((position+length-n)%length)]:0;};
                const float wet=tap(whole)+fraction*(tap(whole+1)-tap(whole));data[ch][static_cast<size_t>(position)]=input[ch];
                output[ch]+=mix*(wet-input[ch]);
            }
            valid=juce::jmin(valid+1,length);if(++position==length)position=0;phase+=frequency/rate;if(phase>=1)phase-=1;return output;
        }
    };
    Filter highpass,lowShelf,highShelf;Chorus before,after;
    juce::SmoothedValue<float> activation,drive,cutMix,chorusPre,chorusPost,eqMix;
    Pair dcInput{},dcOutput{};double rate=48000,smoothing=0,dcPole=0;bool initialized=false,running=false;float active=0;
    static Coefficients shelf(double fs,double frequency,double gain,bool high)
    {
        const double w=juce::MathConstants<double>::twoPi*juce::jlimit(20.0,fs*.45,frequency)/fs,a=std::pow(10.0,gain/40),c=std::cos(w),beta=std::sin(w)*std::sqrt(2*a);
        if(high){const double n=1/((a+1)-(a-1)*c+beta);return {a*((a+1)+(a-1)*c+beta)*n,-2*a*((a-1)+(a+1)*c)*n,a*((a+1)+(a-1)*c-beta)*n,2*((a-1)-(a+1)*c)*n,((a+1)-(a-1)*c-beta)*n};}
        const double n=1/((a+1)+(a-1)*c+beta);return {a*((a+1)-(a-1)*c+beta)*n,2*a*((a-1)-(a+1)*c)*n,a*((a+1)-(a-1)*c-beta)*n,-2*((a-1)+(a+1)*c)*n,((a+1)+(a-1)*c-beta)*n};
    }
public:
    void prepare(double fs){rate=fs;smoothing=1-std::exp(-1/(fs*.025));dcPole=std::exp(-juce::MathConstants<double>::twoPi*5/fs);before.prepare(fs);after.prepare(fs);for(auto* value:{&activation,&drive,&cutMix,&chorusPre,&chorusPost,&eqMix})value->reset(fs,.05);reset();}
    void reset(){highpass.reset();lowShelf.reset();highShelf.reset();before.reset();after.reset();dcInput={};dcOutput={};initialized=running=false;active=0;}
    void configure(Settings settings,bool enabled)
    {
        const auto set=[&](auto& value,float target){if(initialized)value.setTargetValue(target);else value.setCurrentAndTargetValue(target);};
        set(activation,enabled?1.0f:0.0f);set(drive,settings.drive);set(cutMix,settings.cut>20?1.0f:0.0f);
        set(chorusPre,settings.chorus>=.5f&&settings.post<.5f?settings.amount*.5f:0);set(chorusPost,settings.chorus>=.5f&&settings.post>=.5f?settings.amount*.5f:0);set(eqMix,settings.eq>=.5f?1.0f:0);
        const double k=std::tan(juce::MathConstants<double>::pi*settings.cut/rate),n=1/(1+std::sqrt(2.0)*k+k*k);
        highpass.set({n,-2*n,n,2*(k*k-1)*n,(1-std::sqrt(2.0)*k+k*k)*n},!initialized);
        lowShelf.set(shelf(rate,settings.lowFrequency,settings.lowGain,false),!initialized);highShelf.set(shelf(rate,settings.highFrequency,settings.highGain,true),!initialized);initialized=true;
    }
    Pair input(Pair source)
    {
        active=activation.getNextValue();if(active==0&&activation.getTargetValue()==0){if(running){highpass.reset();lowShelf.reset();highShelf.reset();before.reset();after.reset();dcInput={};dcOutput={};}running=false;return source;}running=true;
        highpass.advance(smoothing);const float filterMix=cutMix.getNextValue(),db=drive.getNextValue(),gain=juce::Decibels::decibelsToGain(db),colour=juce::jlimit(0.0f,1.0f,db);
        constexpr float bias=.15f;const float offset=std::tanh(bias),normal=1/(1-offset*offset);Pair result=source;
        for(size_t ch=0;ch<2;++ch){const float filtered=highpass.process(source[ch],ch),x=source[ch]+filterMix*(filtered-source[ch]);const float shaped=(std::tanh(x*gain+bias)-offset)*normal/gain;const float blocked=shaped-dcInput[ch]+static_cast<float>(dcPole)*dcOutput[ch];dcInput[ch]=shaped;dcOutput[ch]=blocked;result[ch]=source[ch]+active*(x+colour*(blocked-x)-source[ch]);}return result;
    }
    Pair pre(Pair source){return running?before.process(source,chorusPre.getNextValue()*active,.43):source;}
    Pair post(Pair source)
    {
        if(!running)return source;source=after.process(source,chorusPost.getNextValue()*active,.61);lowShelf.advance(smoothing);highShelf.advance(smoothing);const float mix=eqMix.getNextValue()*active;
        for(size_t ch=0;ch<2;++ch){const float filtered=highShelf.process(lowShelf.process(source[ch],ch),ch);source[ch]+=mix*(filtered-source[ch]);}return source;
    }
};
