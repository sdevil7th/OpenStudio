#pragma once
#include <JuceHeader.h>
#include <array>

// Original wet-return conversion; the reverb tank itself remains at host rate.
// All FIR storage and coefficients are prepared before audio processing.
class BuiltInVintageConverter
{
    struct FIR
    {
        static constexpr int maximum=1025;
        std::array<float,maximum*2> data{};
        int position=0,filled=0;
        void reset() noexcept {position=filled=0;}
        float process(float input,const std::array<float,maximum>& coefficients,int length) noexcept
        {
            data[static_cast<size_t>(position)]=data[static_cast<size_t>(position+length)]=input;
            filled=juce::jmin(filled+1,length);const int missing=length-filled;
            const auto* samples=data.data()+position+1+missing;const auto* taps=coefficients.data()+missing;
            float a=0,b=0,c=0,d=0;int i=0;
            for(;i+3<filled;i+=4){a+=samples[i]*taps[i];b+=samples[i+1]*taps[i+1];c+=samples[i+2]*taps[i+2];d+=samples[i+3]*taps[i+3];}
            float output=(a+b)+(c+d);for(;i<filled;++i)output+=samples[i]*taps[i];
            if(++position==length)position=0;return output;
        }
    };
public:
    struct Bank
    {
        std::array<FIR,2> inputFilter,outputFilter;
        std::array<float,FIR::maximum> coefficients{};
        std::array<float,2> lastInput{},previousOutput{},currentOutput{};
        int length=1;double step=1,phase=0;float quantization=2048;
        juce::uint64 ticks=0;
        void prepare(double rate,double targetRate,int bits)
        {
            step=juce::jmin(1.0,targetRate/rate);quantization=static_cast<float>(1<<(bits-1));
            length=step>=1?1:juce::jlimit(3,FIR::maximum,static_cast<int>(std::ceil(rate*.0015))|1);
            const int centre=(length-1)/2;const double cutoff=.375*targetRate/rate;double sum=0;
            for(int i=0;i<length;++i)
            {
                const double distance=i-centre;
                const double sinc=distance==0?2*cutoff:std::sin(juce::MathConstants<double>::twoPi*cutoff*distance)/(juce::MathConstants<double>::pi*distance);
                const double window=length==1?1:.42-.5*std::cos(juce::MathConstants<double>::twoPi*i/(length-1))+.08*std::cos(2*juce::MathConstants<double>::twoPi*i/(length-1));
                coefficients[static_cast<size_t>(i)]=static_cast<float>(length==1?1:sinc*window);sum+=coefficients[static_cast<size_t>(i)];
            }
            for(int i=0;i<length;++i)coefficients[static_cast<size_t>(i)]/=static_cast<float>(sum);reset();
        }
        void reset() noexcept {for(auto& filter:inputFilter)filter.reset();for(auto& filter:outputFilter)filter.reset();lastInput={};previousOutput={};currentOutput={};phase=0;ticks=0;}
        float quantize(float input) const noexcept
        {
            const float safe=std::isfinite(input)?juce::jlimit(-16.0f,16.0f,input):0;
            const float compressed=safe/(1+std::abs(safe));const float rounded=std::round(compressed*quantization)/quantization;
            return rounded/juce::jmax(.01f,1-std::abs(rounded));
        }
        template <typename Processor>
        std::array<float,2> processThrough(std::array<float,2> input, Processor&& processor) noexcept
        {
            if(step>=1){++ticks;return processor(input);}
            for(size_t ch=0;ch<2;++ch)input[ch]=inputFilter[ch].process(std::isfinite(input[ch])?input[ch]:0,coefficients,length);
            const double before=phase;phase+=step;
            if(phase>=1)
            {
                const float fraction=static_cast<float>((1-before)/step);phase-=1;++ticks;
                previousOutput=currentOutput;
                std::array<float,2> sampled{};
                for(size_t ch=0;ch<2;++ch)sampled[ch]=lastInput[ch]+fraction*(input[ch]-lastInput[ch]);
                currentOutput=processor(sampled);
            }
            lastInput=input;std::array<float,2> output{};
            for(size_t ch=0;ch<2;++ch)output[ch]=outputFilter[ch].process(previousOutput[ch]+static_cast<float>(phase)*(currentOutput[ch]-previousOutput[ch]),coefficients,length);
            return output;
        }
        std::array<float,2> process(std::array<float,2> input) noexcept
        {
            return processThrough(input,[this](const auto& sampled) noexcept {return std::array<float,2>{quantize(sampled[0]),quantize(sampled[1])};});
        }
    };
private:
    std::array<Bank,2> banks;
    std::array<juce::SmoothedValue<float>,3> weights;
    std::array<bool,2> running{};
    bool initialized=false;
public:
    void prepare(double rate)
    {
        banks[0].prepare(rate,24000,12);banks[1].prepare(rate,48000,16);
        for(auto& weight:weights)weight.reset(rate,.05);reset();
    }
    void reset() noexcept {for(auto& bank:banks)bank.reset();running={};initialized=false;}
    void configure(bool enabled,int colour) noexcept
    {
        const int selected=enabled&&colour<2?juce::jlimit(0,1,colour)+1:0;
        for(size_t i=0;i<weights.size();++i){const float target=static_cast<int>(i)==selected?1.0f:0.0f;if(initialized)weights[i].setTargetValue(target);else weights[i].setCurrentAndTargetValue(target);}
        initialized=true;
    }
    std::array<float,2> process(std::array<float,2> raw,std::array<float,2> legacy) noexcept
    {
        const float old=weights[0].getNextValue();std::array<float,2> output{legacy[0]*old,legacy[1]*old};
        for(size_t i=0;i<banks.size();++i)
        {
            const float weight=weights[i+1].getNextValue();
            if(weight>0||weights[i+1].getTargetValue()>0){const auto converted=banks[i].process(raw);for(size_t ch=0;ch<2;++ch)output[ch]+=converted[ch]*weight;running[i]=true;}
            else if(running[i]){banks[i].reset();running[i]=false;}
        }
        return output;
    }
};
