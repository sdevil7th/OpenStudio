#pragma once
#include <JuceHeader.h>
#include "BuiltInVintageConverter.h"
#include "BuiltInReverbSpillover.h"
#include <array>
#include <vector>
#include <algorithm>

// Original simply-supported rectangular tensioned plate. Each (m,n) mode obeys
// omega^2 = c^2*k^2 + kappa^2*k^4. Two mirrored force exciters and independent
// point pickups use sin(m*pi*x)*sin(n*pi*y). This finite bank is deliberately
// not a calibrated metal plate, FEM mesh, or vendor algorithm.
class BuiltInModalPlate
{
public:
    static constexpr size_t controlCount = 11;
    inline static constexpr std::array<float,controlCount> defaults {1.4f,1.55f,100,3,1,.31f,.43f,.23f,.61f,.73f,.29f};
    inline static constexpr std::array<float,controlCount> minima {.5f,1,20,.5f,0,.02f,.02f,.02f,.02f,.02f,.02f};
    inline static constexpr std::array<float,controlCount> maxima {3,2.5f,300,12,2,.98f,.98f,.98f,.98f,.98f,.98f};
    inline static constexpr std::array<const char*,controlCount> ids {"modalLength","modalAspect","modalTension","modalRigidity","modalModes","modalExciterX","modalExciterY","modalLeftX","modalLeftY","modalRightX","modalRightY"};
    inline static constexpr std::array<const char*,controlCount> names {"Length","Aspect ratio","Tension speed","Bending coefficient","Mode budget","Exciter X","Exciter Y","Left pickup X","Left pickup Y","Right pickup X","Right pickup Y"};
    static constexpr size_t materialCount=7;
    using Material=std::array<float,materialCount>;
    inline static constexpr Material materialDefaults{0,200,7850,.3f,.5f,0,0};
    inline static constexpr Material materialMinima{0,1,500,0,.05f,0,0},materialMaxima{1,400,25000,.49f,5,100,100};
    inline static constexpr std::array<const char*,materialCount> materialIds{"modalMaterial","modalYoung","modalDensity","modalPoisson","modalThickness","modalExciterRadius","modalPickupRadius"};
    inline static constexpr std::array<const char*,materialCount> materialNames{"Material bending","Young modulus","Density","Poisson ratio","Thickness","Exciter radius","Pickup radius"};
    struct Settings {float decay=2,damping=.5f,predelay=0,lowCut=20,highCut=20000,width=1;bool freeze=false,infiniteInput=false;};
private:
    struct Mode
    {
        double frequency=0, cosine=1,sine=0,radius=0,targetRadius=0,radiusStep=0,real=0,imaginary=0;
        std::array<double,2> excitation{},pickup{};
    };
    std::vector<Mode> modes;
    BuiltInVintageConverter::Bank converter;
    std::vector<std::array<float,2>> predelay;
    int delayPosition=0,delayValid=0,coefficientRamp=0;
    std::array<float,2> hp{},lp{};
    double hostRate=0,rate=24000,bending=3;
    Settings settings;
    juce::SmoothedValue<float> send,width,delaySamples,lowPole,highPole;
    std::array<juce::SmoothedValue<float>,1> selection;
    BuiltInReverbRetirement<1> retirement;
    bool initialized=false,running=false,selected=false;
    static float safe(float v,float lo,float hi,float fallback) noexcept {return std::isfinite(v)?juce::jlimit(lo,hi,v):fallback;}
    void clearHistory() noexcept
    {
        for(auto& mode:modes){mode.real=mode.imaginary=0;}
        converter.reset();delayPosition=delayValid=0;hp={};lp={};running=false;
    }
    std::array<float,2> processModes(std::array<float,2> input) noexcept
    {
        const float amount=send.getNextValue();for(auto& v:input)v*=amount;
        predelay[static_cast<size_t>(delayPosition)]=input;
        const float delay=delaySamples.getNextValue();const int whole=static_cast<int>(delay);const float fraction=delay-static_cast<float>(whole);
        const int size=static_cast<int>(predelay.size());
        const auto a=whole<=delayValid?predelay[static_cast<size_t>((delayPosition+size-whole)%size)]:std::array<float,2>{};
        const auto b=whole+1<=delayValid?predelay[static_cast<size_t>((delayPosition+size-whole-1)%size)]:std::array<float,2>{};
        for(size_t ch=0;ch<2;++ch)input[ch]=a[ch]+fraction*(b[ch]-a[ch]);
        delayValid=juce::jmin(delayValid+1,size-1);if(++delayPosition==size)delayPosition=0;
        std::array<double,2> output{};
        for(auto& mode:modes)
        {
            if(coefficientRamp>0)mode.radius+=mode.radiusStep;
            const double driven=mode.real+input[0]*mode.excitation[0]+input[1]*mode.excitation[1];
            const double real=mode.radius*(mode.cosine*driven-mode.sine*mode.imaginary);
            const double imaginary=mode.radius*(mode.sine*driven+mode.cosine*mode.imaginary);
            // Infinite accepts new energy; bound only that deliberately nonlinear hold.
            mode.real=settings.freeze&&settings.infiniteInput?juce::jlimit(-16.0,16.0,real):real;
            mode.imaginary=settings.freeze&&settings.infiniteInput?juce::jlimit(-16.0,16.0,imaginary):imaginary;
            for(size_t ch=0;ch<2;++ch)output[ch]+=mode.real*mode.pickup[ch];
        }
        if(coefficientRamp>0&&--coefficientRamp==0)for(auto& mode:modes)mode.radius=mode.targetRadius;
        const float low=lowPole.getNextValue(),high=highPole.getNextValue();std::array<float,2> filtered{};
        for(size_t ch=0;ch<2;++ch){const float value=static_cast<float>(output[ch]);hp[ch]=value+low*(hp[ch]-value);lp[ch]=(value-hp[ch])+high*(lp[ch]-(value-hp[ch]));filtered[ch]=lp[ch];}
        const float mid=(filtered[0]+filtered[1])*.5f,side=(filtered[0]-filtered[1])*.5f*width.getNextValue();return {mid+side,mid-side};
    }
public:
    // Called only on the serialized control/preparation path. Replacing geometry
    // resets this model's tail; other reverb engines retain their own history.
    void prepare(double sampleRate,std::array<float,controlCount> controls,bool active,Material material=materialDefaults)
    {
        for(size_t i=0;i<controls.size();++i)controls[i]=safe(controls[i],minima[i],maxima[i],defaults[i]);
        for(size_t i=0;i<material.size();++i)material[i]=safe(material[i],materialMinima[i],materialMaxima[i],materialDefaults[i]);
        // Kirchhoff-Love rigidity D/(rho*h), retaining independently specified
        // membrane-wave speed. Excitation is normalized, not calibrated in N.
        const double poisson=material[3];
        bending=material[0]>=.5f?material[4]*.001*std::sqrt(material[1]*1e9/(12.0*material[2]*(1-poisson*poisson))):controls[3];
        const double nextRate=juce::jmin(24000.0,sampleRate),length=controls[0],breadth=length/controls[1],tension=controls[2],rigidity=bending;
        const int budget=std::array<int,3>{256,512,1024}[static_cast<size_t>(juce::roundToInt(controls[4]))];
        struct Candidate {int m,n;double frequency;};std::vector<Candidate> candidates;candidates.reserve(4096);
        for(int m=1;m<=64;++m)for(int n=1;n<=64;++n)
        {
            const double kx=m*juce::MathConstants<double>::pi/length,ky=n*juce::MathConstants<double>::pi/breadth,k2=kx*kx+ky*ky;
            const double frequency=std::sqrt(tension*tension*k2+rigidity*rigidity*k2*k2)/juce::MathConstants<double>::twoPi;
            if(frequency<nextRate*.45)candidates.push_back({m,n,frequency});
        }
        std::stable_sort(candidates.begin(),candidates.end(),[](const auto& a,const auto& b){return a.frequency<b.frequency;});
        if(candidates.size()>static_cast<size_t>(budget))candidates.resize(static_cast<size_t>(budget));
        std::vector<Mode> prepared;prepared.reserve(candidates.size());const double gain=.12/std::sqrt(static_cast<double>(juce::jmax(size_t{1},candidates.size())));
        for(const auto& candidate:candidates)
        {
            const auto shape=[&](double x,double y){return std::sin(candidate.m*juce::MathConstants<double>::pi*x)*std::sin(candidate.n*juce::MathConstants<double>::pi*y);};
            Mode mode;mode.frequency=candidate.frequency;const double omega=juce::MathConstants<double>::twoPi*mode.frequency/nextRate;mode.cosine=std::cos(omega);mode.sine=std::sin(omega);
            mode.excitation={gain*shape(controls[5],controls[6]),gain*shape(1-controls[5],controls[6])};mode.pickup={shape(controls[7],controls[8]),shape(controls[9],controls[10])};
            // Gaussian spatial footprints attenuate short-wavelength modes;
            // sigma=0 is the exact prior point-exciter/pickup path.
            const double k2=std::pow(candidate.m*juce::MathConstants<double>::pi/length,2)+std::pow(candidate.n*juce::MathConstants<double>::pi/breadth,2);
            if(material[5]>0)for(auto& weight:mode.excitation)weight*=std::exp(-.5*std::pow(material[5]*.001,2)*k2);
            if(material[6]>0)for(auto& weight:mode.pickup)weight*=std::exp(-.5*std::pow(material[6]*.001,2)*k2);
            prepared.push_back(mode);
        }
        std::vector<std::array<float,2>> delay(static_cast<size_t>(std::ceil(nextRate*.501))+2);
        converter.prepare(sampleRate,nextRate,16);modes.swap(prepared);predelay.swap(delay);hostRate=sampleRate;rate=nextRate;
        for(auto* smoother:{&send,&width,&delaySamples,&lowPole,&highPole})smoother->reset(rate,.05);
        selection[0].reset(hostRate,.05);selection[0].setCurrentAndTargetValue(active?1.0f:0.0f);retirement.prepare(hostRate,active?0:-1);
        initialized=false;selected=active;coefficientRamp=0;clearHistory();
    }
    bool ready() const noexcept{return hostRate>0;}
    void reset() noexcept{clearHistory();initialized=false;coefficientRamp=0;retirement.reset(selection);}
    void configure(bool active,Settings next,bool spillover) noexcept
    {
        if(!ready())return;
        next.decay=safe(next.decay,.1f,20,2);next.damping=safe(next.damping,0,1,.5f);next.predelay=safe(next.predelay,0,500,0);
        next.lowCut=safe(next.lowCut,20,500,20);next.highCut=safe(next.highCut,1000,20000,20000);next.width=safe(next.width,0,1,1);
        if(!active){next=settings;next.freeze=false;next.infiniteInput=false;}
        const bool changed=!initialized||next.decay!=settings.decay||next.damping!=settings.damping||next.freeze!=settings.freeze;
        settings=next;selected=active;selection[0].setTargetValue(active?1.0f:0.0f);retirement.configure(0,active,spillover,settings.decay*2+settings.predelay*.001+2);
        if(changed)
        {
            coefficientRamp=initialized?juce::jmax(1,juce::roundToInt(rate*.05)):0;
            for(auto& mode:modes)
            {
                const double loss=1+6*settings.damping*std::pow(mode.frequency/6000,2);
                mode.targetRadius=settings.freeze?1:std::exp(-std::log(1000.0)*loss/(rate*settings.decay));
                if(coefficientRamp>0)mode.radiusStep=(mode.targetRadius-mode.radius)/coefficientRamp;else mode.radius=mode.targetRadius;
            }
        }
        const auto set=[this](auto& smoother,float value){if(initialized)smoother.setTargetValue(value);else smoother.setCurrentAndTargetValue(value);};
        set(send,active&&(!settings.freeze||settings.infiniteInput)?1.0f:0.0f);set(width,settings.width);set(delaySamples,settings.predelay*.001f*static_cast<float>(rate));
        set(lowPole,std::exp(-juce::MathConstants<float>::twoPi*settings.lowCut/static_cast<float>(rate)));set(highPole,std::exp(-juce::MathConstants<float>::twoPi*juce::jmin(static_cast<float>(rate)*.45f,settings.highCut)/static_cast<float>(rate)));initialized=true;
    }
    std::array<float,3> process(float left,float right) noexcept
    {
        if(!ready())return {};const float weight=selection[0].getNextValue(),wet=retirement.next(0);
        if(wet<=0&&!selected){if(running)clearHistory();return {0,0,weight};}
        running=true;const auto output=converter.processThrough({safe(left,-16,16,0),safe(right,-16,16,0)},[this](auto input) noexcept{return processModes(input);});return {output[0]*wet,output[1]*wet,weight};
    }
    double retiringTailSeconds() const noexcept{return retirement.retiringTailSeconds();}
    size_t modeCount() const noexcept{return modes.size();}
    double modeFrequency(size_t index) const noexcept{return index<modes.size()?modes[index].frequency:0;}
    double bendingCoefficient() const noexcept{return bending;}
    double excitationWeight(size_t index,size_t channel) const noexcept{return index<modes.size()&&channel<2?modes[index].excitation[channel]:0;}
    double pickupWeight(size_t index,size_t channel) const noexcept{return index<modes.size()&&channel<2?modes[index].pickup[channel]:0;}
    double processingRate() const noexcept{return rate;}
    juce::uint64 processingFrames() const noexcept{return converter.ticks;}
};
