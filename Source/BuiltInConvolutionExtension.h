#pragma once
#include <JuceHeader.h>
#include <array>
#include <vector>

// Original additive wet-return extension. Three complementary input bands feed
// separate four-line orthogonal feedback networks. It does not infer room modes
// or recreate missing source/IR frequencies. All delay storage is prepared.
class BuiltInConvolutionExtension
{
    struct Line
    {
        std::vector<float> data;int position=0,valid=0;
        juce::SmoothedValue<float> loss;
        void reset() noexcept {position=valid=0;}
        float read() const noexcept {return valid==static_cast<int>(data.size())?data[static_cast<size_t>(position)]:0;}
        void write(float value) noexcept {data[static_cast<size_t>(position)]=value;if(++position==static_cast<int>(data.size()))position=0;valid=juce::jmin(valid+1,static_cast<int>(data.size()));}
    };
    std::array<std::array<Line,4>,3> networks;
    std::array<std::array<float,2>,2> split{};
    juce::SmoothedValue<float> amount,lowPole,highPole,imageWidth;
    double rate=48000;int remaining=0,maximumDrain=0;
    bool initialized=false,empty=true;
public:
    void prepare(double sampleRate)
    {
        rate=sampleRate;constexpr std::array<int,4> delays{1493,2111,2633,3167};
        constexpr std::array<double,3> scales{1.0,1.071,.937};
        for(size_t band=0;band<3;++band)for(size_t i=0;i<4;++i)
        {
            auto& line=networks[band][i];line.data.assign(static_cast<size_t>(juce::jmax(1,juce::roundToInt(delays[i]*scales[band]*rate/48000))),0);line.loss.reset(rate,.05);
        }
        for(auto* smoother:{&amount,&lowPole,&highPole,&imageWidth})smoother->reset(rate,.05);
        reset();
    }
    void reset() noexcept
    {
        for(auto& network:networks)for(auto& line:network)line.reset();split={};remaining=0;initialized=false;empty=true;
    }
    static double tailSeconds(const std::array<float,6>& values) noexcept
    {
        return values[0]<=0?0:2*juce::jlimit(.1,20.0,static_cast<double>(juce::jmax(values[1],values[2],values[3])))+1;
    }
    void configure(std::array<float,6> values,float width=1) noexcept
    {
        const std::array<float,6> defaults{0,2,2,2,250,4000};for(size_t i=0;i<values.size();++i)if(!std::isfinite(values[i]))values[i]=defaults[i];
        values[0]=juce::jlimit(0.0f,1.0f,values[0]);for(size_t i=1;i<=3;++i)values[i]=juce::jlimit(.1f,20.0f,values[i]);
        const float low=juce::jlimit(60.0f,2000.0f,values[4]),high=juce::jmin(static_cast<float>(rate*.45),juce::jmax(low*2,juce::jlimit(1000.0f,16000.0f,values[5])));
        const auto set=[this](auto& smoother,float value){if(initialized)smoother.setTargetValue(value);else smoother.setCurrentAndTargetValue(value);};
        set(imageWidth,std::isfinite(width)?juce::jlimit(0.0f,1.0f,width):1);
        set(amount,values[0]);set(lowPole,static_cast<float>(std::exp(-juce::MathConstants<double>::twoPi*juce::jmin(static_cast<double>(low),rate*.2)/rate)));set(highPole,static_cast<float>(std::exp(-juce::MathConstants<double>::twoPi*high/rate)));
        for(size_t band=0;band<3;++band)for(auto& line:networks[band])set(line.loss,static_cast<float>(std::exp(-std::log(1000.0)*line.data.size()/(rate*values[band+1]))));
        maximumDrain=static_cast<int>(rate*tailSeconds(values));initialized=true;
    }
    bool isDraining() const noexcept {return remaining>0;}
    void process(juce::AudioBuffer<float>& buffer) noexcept
    {
        if(!initialized)return;
        if(!amount.isSmoothing()&&amount.getCurrentValue()==0)
        {
            if(!empty){for(auto& network:networks)for(auto& line:network)line.reset();split={};remaining=0;empty=true;}
            lowPole.skip(buffer.getNumSamples());highPole.skip(buffer.getNumSamples());imageWidth.skip(buffer.getNumSamples());
            for(auto& network:networks)for(auto& line:network)line.loss.skip(buffer.getNumSamples());
            return;
        }
        for(int sample=0;sample<buffer.getNumSamples();++sample)
        {
            const float blend=amount.getNextValue(),lo=lowPole.getNextValue(),hi=highPole.getNextValue(),width=imageWidth.getNextValue();
            if(blend==0)
            {
                if(!empty){for(auto& network:networks)for(auto& line:network)line.reset();split={};remaining=0;empty=true;}
                // Advance controls without touching the audio or delay storage.
                for(auto& network:networks)for(auto& line:network)line.loss.getNextValue();
                continue;
            }
            const std::array<float,2> input{buffer.getSample(0,sample),buffer.getSample(1,sample)};
            const bool excited=std::abs(input[0])>1e-12f||std::abs(input[1])>1e-12f;
            if(excited)remaining=maximumDrain;else if(remaining>0)--remaining;
            if(remaining==0)
            {
                if(!empty){for(auto& network:networks)for(auto& line:network)line.reset();split={};empty=true;}
                for(auto& network:networks)for(auto& line:network)line.loss.getNextValue();
                continue;
            }
            empty=false;std::array<std::array<float,2>,3> bands{};
            for(size_t ch=0;ch<2;++ch)
            {
                split[0][ch]=input[ch]+lo*(split[0][ch]-input[ch]);split[1][ch]=input[ch]+hi*(split[1][ch]-input[ch]);
                bands[0][ch]=split[0][ch];bands[1][ch]=split[1][ch]-split[0][ch];bands[2][ch]=input[ch]-split[1][ch];
            }
            std::array<float,2> extension{};
            for(size_t band=0;band<3;++band)
            {
                auto& network=networks[band];std::array<float,4> y{};for(size_t i=0;i<4;++i)y[i]=network[i].read();
                const std::array<float,4> feedback{.5f*(y[0]+y[1]+y[2]+y[3]),.5f*(y[0]-y[1]+y[2]-y[3]),.5f*(y[0]+y[1]-y[2]-y[3]),.5f*(y[0]-y[1]-y[2]+y[3])};
                const auto& in=bands[band];const std::array<float,4> excitation{.5f*(in[0]+in[1]),.5f*(in[0]-in[1]),.5f*(in[0]+in[1]),.5f*(in[0]-in[1])};
                for(size_t i=0;i<4;++i){const float gain=network[i].loss.getNextValue();network[i].write(gain*feedback[i]+(1-gain)*excitation[i]);}
                extension[0]+=.5f*(y[0]+y[1]+y[2]+y[3]);extension[1]+=.5f*(y[0]-y[1]+y[2]-y[3]);
            }
            const float mid=.5f*(extension[0]+extension[1]),side=.5f*(extension[0]-extension[1])*width;
            buffer.setSample(0,sample,input[0]+blend*(mid+side));buffer.setSample(1,sample,input[1]+blend*(mid-side));
        }
    }
};
