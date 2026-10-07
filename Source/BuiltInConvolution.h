#pragma once
#include "BuiltInIRColour.h"
#include "BuiltInIRDecay.h"
#include "BuiltInIRPreparation.h"
#include "BuiltInIRBrightness.h"
#include "BuiltInIRSourceBlend.h"
#include "BuiltInIRGeometry.h"

// Source/shape edits run on the bridge's state-mutation worker. Complete FFT
// engines are prepared before atomic publication; the callback only swaps,
// crossfades and retires them. All original IR samples remain portable.
class BuiltInConvolution
{
public:
    struct Shape : BuiltInIRColour::Settings, BuiltInIRGeometry::Settings
    {
        double start = 0, end = 0, attack = 0, size = 1;
        double directDb = 0, earlyDb = 0, tailDb = 0;
        double directEnd = .005, earlyEnd = .08;
        bool reverse = false, normalise = true, octaveAnalysis = false;
        int outputLayout = 0; // 0: stereo sum; 1: diagonal main pair + cross-path auxiliary pair.
        int channelOrder = 0; // 0: LL LR RL RR; 1: LL RL LR RR. First letter is input.
        double crossTerms = 1;
        double brightness = 0;
        double sourceBlendLeft = 0, sourceBlendRight = 1;
    };
    BuiltInConvolution() = default;
    ~BuiltInConvolution() { delete pendingEq.exchange(nullptr);delete pending.exchange(nullptr); delete active; delete fading; collect(); }
    bool loadFile(const juce::File& file, double seconds = 0, BuiltInIRPreparation* progress=nullptr)
    {
        if(progress&&!progress->advance(BuiltInIRPreparation::reading))return false;
        juce::AudioFormatManager formats; formats.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
        if (!reader || reader->sampleRate < 8000 || reader->sampleRate > 384000
            || reader->lengthInSamples < 1 || reader->lengthInSamples > reader->sampleRate * 10
            || (reader->numChannels != 1 && reader->numChannels != 2 && reader->numChannels != 4)) return false;
        juce::AudioBuffer<float> samples(static_cast<int>(reader->numChannels), static_cast<int>(reader->lengthInSamples));
        // The AudioBuffer overload only handles the first stereo pair.
        for(int start=0;start<samples.getNumSamples();start+=65536)
        {
            if(progress&&progress->isCancelled())return false;
            std::array<float*,4> pointers{};for(int ch=0;ch<samples.getNumChannels();++ch)pointers[static_cast<size_t>(ch)]=samples.getWritePointer(ch,start);
            if(!reader->read(pointers.data(),samples.getNumChannels(),start,juce::jmin(65536,samples.getNumSamples()-start)))return false;
        }
        Shape next; next.end = seconds;
        return publish(std::move(samples), reader->sampleRate, file.getFileName(), next, progress);
    }
    bool restore(const juce::var& data, const juce::String& name, double seconds)
    {
        Shape next; next.end = seconds; return restore(data, name, next);
    }
    bool restore(const juce::ValueTree& tree)
    {
        Shape next;
        next.end = static_cast<double>(tree.getProperty("irTrimSeconds",0.0));
        if (!readShape(tree.getProperty("irShape"),next)) return false;
        return restore(tree.getProperty("irData"),tree.getProperty("irName").toString(),next);
    }
    bool edit(const juce::var& values, BuiltInIRPreparation* progress=nullptr)
    {
        juce::MemoryBlock bytes; juce::String name; Shape next;
        { const juce::ScopedLock lock(controlLock); bytes=sourceBytes; name=sourceName; next=shape; }
        if (!readShape(values,next)) return false;
        return restore(juce::var(bytes),name,next,progress);
    }
    bool trim(double seconds)
    {
        juce::DynamicObject::Ptr editObject=new juce::DynamicObject(); editObject->setProperty("end",seconds); return edit(juce::var(editObject.get()));
    }
    void save(juce::ValueTree& state)
    {
        const juce::ScopedLock lock(controlLock);
        state.setProperty("irData",juce::var(sourceBytes),nullptr); state.setProperty("irName",sourceName,nullptr);
        state.setProperty("irTrimSeconds",shape.end,nullptr);
        // Nested binary ValueTree preserves exact doubles; JSON decimal rounding can
        // otherwise move crop endpoints on full-state recall.
        juce::ValueTree settings("IRShape");
        const auto values=shapeObject(shape);
        for(const auto& property:values.getDynamicObject()->getProperties())settings.setProperty(property.name,property.value,nullptr);
        juce::MemoryBlock settingsBytes;{juce::MemoryOutputStream stream(settingsBytes,false);settings.writeToStream(stream);}
        state.setProperty("irShape",juce::var(settingsBytes),nullptr);
    }
    juce::var info()
    {
        const juce::ScopedLock lock(controlLock);
        auto* result=new juce::DynamicObject(); result->setProperty("name",sourceName); result->setProperty("duration",duration);
        result->setProperty("trimSeconds",shape.end); result->setProperty("processedDuration",processedDuration);
        result->setProperty("decayEstimate",decayEstimate.toVar());
        result->setProperty("geometry",BuiltInIRGeometry::describe(shape,geometrySourceRate));
        result->setProperty("eqResponse",eqResponse); result->setProperty("eqSampleRate",eqSampleRate);
        result->setProperty("channels",sourceChannels); result->setProperty("embedded",true); result->setProperty("shape",shapeObject(shape));
        juce::Array<juce::var> envelope; for(float value:waveform)envelope.add(value);result->setProperty("waveform",envelope);
        return result;
    }
    bool selectDefault(BuiltInIRPreparation* progress=nullptr)
    {
        if(progress&&!progress->advance(BuiltInIRPreparation::reading))return false;
        constexpr double sourceRate=48000;
        juce::AudioBuffer<float> samples(2,57600);samples.clear();juce::Random random(0x4f534952);float filtered[2] {};
        for(int i=0;i<samples.getNumSamples();++i)for(int ch=0;ch<2;++ch)
        {
            filtered[ch]+=.35f*((random.nextFloat()*2-1)-filtered[ch]);
            samples.setSample(ch,i,i>=480?filtered[ch]*.025f*std::exp(-6.9f*static_cast<float>(i)/57600.0f):0);
        }
        samples.setSample(0,480,.45f);samples.setSample(1,617,.4f);
        return publish(std::move(samples),sourceRate,"Studio room (generated)",Shape{},progress);
    }
    void prepare(double sampleRate,int block)
    {
        // Host prepare is serialized against the callback. Rebuild deterministically
        // at device/offline rate; no asynchronous first-block fallback response.
        const juce::ScopedLock preparationGuard(preparationLock);
        renderRate=sampleRate;maximumBlock=juce::jmax(1,block);
        delete pending.exchange(nullptr);delete active;active=nullptr;delete fading;fading=nullptr;collect();
        juce::MemoryBlock bytes;Shape settings;
        {const juce::ScopedLock lock(controlLock);bytes=sourceBytes;settings=shape;}
        targetCrossTerms.store(static_cast<float>(settings.crossTerms));
        juce::AudioBuffer<float> samples;double sourceRate=0;
        if(decode(juce::var(bytes),samples,sourceRate))active=build(samples,sourceRate,settings).release();
        delete pendingEq.exchange(nullptr);equalizer.prepare(settings,sampleRate);previousEqualizer=equalizer;
        eqFade.reset(sampleRate,.05);eqFade.setCurrentAndTargetValue(1);
        {const juce::ScopedLock lock(controlLock);eqResponse=equalizer.response();eqSampleRate=sampleRate;tailSeconds.store(processedDuration+equalizer.tail);}
        rate=static_cast<float>(sampleRate);pre.assign(static_cast<size_t>(rate*.51f)+2,{});
        preDelay.reset(sampleRate,.05);fade.reset(sampleRate,.05);fade.setCurrentAndTargetValue(1);
        reset();
    }
    void reset()
    {
        if(active)active->reset();if(fading)fading->reset();equalizer.reset();previousEqualizer.reset();eqFade.setCurrentAndTargetValue(1);
        validPre=0;position=0;low={};high={};initialized=false;
        drainRemaining=0;processedFrames=0;
    }
    void process(juce::AudioBuffer<float>& buffer,float delayMs,float lowCut,float highCut,float width,bool selected,bool applyOuterFilters=true)
    {
        if(!fading)if(auto* next=pending.exchange(nullptr))
        {
            if(drainRemaining==0)
            {
                // A dormant kernel has no audible history. Publish the prepared
                // replacement immediately and defer destruction to the worker.
                if(active)retire(active);
                active=next;fade.setCurrentAndTargetValue(1);
            }
            else {fading=active;active=next;fade.setCurrentAndTargetValue(0);fade.setTargetValue(1);}
        }
        if(!active){buffer.clear();return;}
        // Consume prepared EQ even while dormant. Otherwise an edit made while
        // another reverb type is selected could remain pending indefinitely.
        if(!eqFade.isSmoothing())if(auto* update=pendingEq.exchange(nullptr))
        {
            previousEqualizer=equalizer;equalizer=update->eq;
            eqFade.setCurrentAndTargetValue(drainRemaining>0&&(previousEqualizer.isActive()||equalizer.isActive())?0.0f:1.0f);eqFade.setTargetValue(1);
            auto* head=retiredEq.load();do{update->next=head;}while(!retiredEq.compare_exchange_weak(head,update));
        }
        if(selected)
        {
            // Retain a longer preceding IR's horizon across live replacements.
            // Include maximum manual predelay, filter settling and FFT blocks.
            const auto horizon=static_cast<juce::int64>(std::ceil((tail()+1.5)*rate))+4*static_cast<juce::int64>(maximumBlock);
            drainRemaining=juce::jmax(drainRemaining,horizon);
        }
        if(drainRemaining==0&&!fading&&!eqFade.isSmoothing())
        {
            buffer.clear();return;
        }
        processedFrames+=static_cast<juce::uint64>(buffer.getNumSamples());
        const float target=juce::jlimit(0.0f,rate*.5f,delayMs*.001f*rate);
        if(!initialized)preDelay.setCurrentAndTargetValue(target);else preDelay.setTargetValue(target);initialized=true;
        for(int i=0;i<buffer.getNumSamples();++i)
        {
            const float delay=preDelay.getNextValue();const size_t whole=static_cast<size_t>(delay);const float fraction=delay-static_cast<float>(whole);
            validPre=juce::jmin(pre.size(),validPre+1);
            for(int ch=0;ch<2;++ch)
            {
                const float input=buffer.getSample(ch,i);const auto channel=static_cast<size_t>(ch);
                pre[position][channel]=selected&&std::isfinite(input)?juce::jlimit(-16.0f,16.0f,input):0;
                const auto a=(position+pre.size()-whole)%pre.size(),b=(a+pre.size()-1)%pre.size();
                const float first=whole<validPre?pre[a][channel]:0,second=whole+1<validPre?pre[b][channel]:0;
                buffer.setSample(ch,i,first+fraction*(second-first));
            }
            position=(position+1)%pre.size();
        }
        for(int start=0;start<buffer.getNumSamples();start+=maximumBlock)
        {
            const int count=juce::jmin(maximumBlock,buffer.getNumSamples()-start);
            const float crossTerms=targetCrossTerms.load(std::memory_order_relaxed);
            active->process(buffer,start,count,crossTerms);if(fading)fading->process(buffer,start,count,crossTerms);
            for(int i=0;i<count;++i)
            {
                const float amount=fade.getNextValue();
                for(int ch=0;ch<juce::jmin(4,buffer.getNumChannels());++ch){const float wet=active->output.getSample(ch,i);buffer.setSample(ch,start+i,fading?fading->output.getSample(ch,i)*(1-amount)+wet*amount:wet);}
            }
            if(fading&&!fade.isSmoothing()){retire(fading);fading=nullptr;}
        }
        // EQ edits retain convolution history and crossfade prepared filters.
        if(eqFade.isSmoothing())for(int i=0;i<buffer.getNumSamples();++i)
        {
            const float amount=eqFade.getNextValue();
            for(int ch=0;ch<juce::jmin(4,buffer.getNumChannels());++ch){const float input=buffer.getSample(ch,i);const auto channel=static_cast<size_t>(ch);buffer.setSample(ch,i,previousEqualizer.sample(input,channel)*(1-amount)+equalizer.sample(input,channel)*amount);}
        }
        else equalizer.process(buffer,buffer.getNumSamples());
        if(applyOuterFilters)
        {
        const float lp=1-std::exp(-juce::MathConstants<float>::twoPi*juce::jlimit(1000.0f,rate*.45f,highCut)/rate);
        const float hp=1-std::exp(-juce::MathConstants<float>::twoPi*juce::jlimit(20.0f,500.0f,lowCut)/rate);
        for(int i=0;i<buffer.getNumSamples();++i)
        {
            for(int pair=0;pair+1<juce::jmin(4,buffer.getNumChannels());pair+=2)
            {
                std::array<float,2> wet{};
                for(size_t ch=0;ch<2;++ch){const auto index=static_cast<size_t>(pair)+ch;low[index]+=lp*(buffer.getSample(static_cast<int>(index),i)-low[index]);high[index]+=hp*(low[index]-high[index]);wet[ch]=low[index]-high[index];}
                const float mid=.5f*(wet[0]+wet[1]),side=.5f*(wet[0]-wet[1])*juce::jlimit(0.0f,1.0f,width);
                buffer.setSample(pair,i,mid+side);buffer.setSample(pair+1,i,mid-side);
            }
        }
        }
        drainRemaining=juce::jmax(juce::int64{0},drainRemaining-buffer.getNumSamples());
        if(drainRemaining==0&&!fading&&!eqFade.isSmoothing())
        {
            // FIR history has been clocked out. Clear only small filter state;
            // never call the convolution engine's large-buffer reset here.
            validPre=0;position=0;low={};high={};initialized=false;
            equalizer.reset();previousEqualizer.reset();
        }
    }
    double tail() const { return tailSeconds.load(); }
    // Audio-thread-owned diagnostics; read only with processing stopped.
    juce::uint64 processingFrames() const noexcept { return processedFrames; }
    bool isDormant() const noexcept { return drainRemaining==0&&!fading&&!eqFade.isSmoothing(); }
private:
    struct Kernel
    {
        // A short zero-latency head retains sample timing; larger tail partitions
        // avoid processing the entire long IR at every small device block.
        juce::dsp::Convolution diagonal{juce::dsp::Convolution::NonUniform{512}};
        juce::dsp::Convolution cross{juce::dsp::Convolution::NonUniform{512}};
        juce::AudioBuffer<float> output,crossBuffer;
        juce::SmoothedValue<float> crossGain;
        bool matrix=false,splitOutputs=false;Kernel* next=nullptr;
        // Offset the cross engine's internal partition clock by half a tail
        // partition. Priming with silence changes no causal output or latency,
        // but avoids running all four long-tail FFT accumulations in one small
        // callback. Storage is prepared; this also keeps reset allocation-free.
        void primeCross()
        {
            crossBuffer.clear();
            for(int remaining=256;remaining>0;)
            {
                const int count=juce::jmin(remaining,crossBuffer.getNumSamples());
                auto block=juce::dsp::AudioBlock<float>(crossBuffer).getSubBlock(0,static_cast<size_t>(count));
                cross.process(juce::dsp::ProcessContextReplacing<float>(block));remaining-=count;
            }
        }
        void reset(){diagonal.reset();if(matrix){cross.reset();primeCross();}crossGain.setCurrentAndTargetValue(crossGain.getTargetValue());}
        void process(const juce::AudioBuffer<float>& input,int start,int count,float crossTerms)
        {
            for(int ch=0;ch<2;++ch){output.copyFrom(ch,0,input,ch,start,count);if(matrix)crossBuffer.copyFrom(ch,0,input,1-ch,start,count);}
            auto block=juce::dsp::AudioBlock<float>(output).getSubsetChannelBlock(0,2).getSubBlock(0,static_cast<size_t>(count));diagonal.process(juce::dsp::ProcessContextReplacing<float>(block));
            if(matrix)
            {
                crossGain.setTargetValue(crossTerms);
                auto crossBlock=juce::dsp::AudioBlock<float>(crossBuffer).getSubBlock(0,static_cast<size_t>(count));cross.process(juce::dsp::ProcessContextReplacing<float>(crossBlock));
                if(splitOutputs)
                {
                    for(int i=0;i<count;++i){const float gain=crossGain.getNextValue();for(int ch=0;ch<2;++ch)output.setSample(ch+2,i,crossBuffer.getSample(ch,i)*gain);}
                }
                else if(!crossGain.isSmoothing()&&crossGain.getCurrentValue()==1)
                    for(int ch=0;ch<2;++ch)output.addFrom(ch,0,crossBuffer,ch,0,count);
                else for(int i=0;i<count;++i){const float gain=crossGain.getNextValue();for(int ch=0;ch<2;++ch)output.addSample(ch,i,crossBuffer.getSample(ch,i)*gain);}
            }
        }
    };
    struct EqUpdate { BuiltInIRColour::Eq eq;EqUpdate* next=nullptr; };
    std::atomic<EqUpdate*> pendingEq{nullptr},retiredEq{nullptr};
    BuiltInIRColour::Eq equalizer,previousEqualizer;juce::SmoothedValue<float> eqFade;
    Kernel* active=nullptr;Kernel* fading=nullptr;
    std::atomic<Kernel*> pending{nullptr},retired{nullptr};
    // Neither lock is acquired by audio process/reset/retire. Schema reads only
    // take the short metadata lock, never the expensive FFT preparation lock.
    juce::CriticalSection preparationLock,controlLock;
    juce::MemoryBlock sourceBytes;juce::String sourceName;Shape shape;
    BuiltInIRDecay decayEstimate;
    double geometrySourceRate=48000;
    double duration=0,processedDuration=0,renderRate=0;int maximumBlock=1,sourceChannels=2;
    std::array<float,96> waveform{};std::atomic<double> tailSeconds{1.2};
    juce::var eqResponse;double eqSampleRate=48000;
    std::vector<std::array<float,2>> pre;std::array<float,4> low{},high{};
    juce::SmoothedValue<float> preDelay,fade;size_t position=0,validPre=0;float rate=48000;bool initialized=false;
    juce::int64 drainRemaining=0;
    juce::uint64 processedFrames=0;
    std::atomic<float> targetCrossTerms{1};
    void retire(Kernel* item) noexcept {auto* head=retired.load();do{item->next=head;}while(!retired.compare_exchange_weak(head,item));}
    void collect(){auto* item=retired.exchange(nullptr);while(item){auto* next=item->next;delete item;item=next;}
        auto* eq=retiredEq.exchange(nullptr);while(eq){auto* next=eq->next;delete eq;eq=next;}}
    static bool sameImpulse(const Shape& a,const Shape& b)
    {
        // Ignore only decimal transport round-off, so an EQ Apply cannot turn
        // an unchanged non-terminating crop endpoint into an IR rebuild.
        const auto equal=[](double x,double y){return std::abs(x-y)<=1e-12*juce::jmax(1.0,std::abs(x),std::abs(y));};
        return a.geometryEnabled==b.geometryEnabled&&(!a.geometryEnabled||a.geometryPoints==b.geometryPoints)&&equal(a.start,b.start)&&equal(a.end,b.end)&&equal(a.attack,b.attack)&&equal(a.size,b.size)&&a.reverse==b.reverse&&a.normalise==b.normalise&&a.channelOrder==b.channelOrder&&a.outputLayout==b.outputLayout
            &&equal(a.sourceBlendLeft,b.sourceBlendLeft)&&equal(a.sourceBlendRight,b.sourceBlendRight)&&equal(a.brightness,b.brightness)&&equal(a.directDb,b.directDb)&&equal(a.earlyDb,b.earlyDb)&&equal(a.tailDb,b.tailDb)&&equal(a.directEnd,b.directEnd)&&equal(a.earlyEnd,b.earlyEnd)
            &&equal(a.lowDecay,b.lowDecay)&&equal(a.midDecay,b.midDecay)&&equal(a.highDecay,b.highDecay)&&equal(a.lowCrossover,b.lowCrossover)&&equal(a.highCrossover,b.highCrossover);
    }
    static bool sameEq(const Shape& a,const Shape& b)
    { return a.eqEnabled==b.eqEnabled&&a.eqFrequency==b.eqFrequency&&a.eqGain==b.eqGain&&a.eqQ==b.eqQ; }
    static juce::var shapeObject(const Shape& value)
    {
        auto* object=new juce::DynamicObject();
        object->setProperty("geometryEnabled",value.geometryEnabled);
        for(size_t i=0;i<BuiltInIRGeometry::ids.size();++i)object->setProperty(BuiltInIRGeometry::ids[i],value.geometryPoints[i/2][i%2]);
        object->setProperty("start",value.start);object->setProperty("end",value.end);object->setProperty("attack",value.attack);object->setProperty("size",value.size);
        object->setProperty("directDb",value.directDb);object->setProperty("earlyDb",value.earlyDb);object->setProperty("tailDb",value.tailDb);
        object->setProperty("directEnd",value.directEnd);object->setProperty("earlyEnd",value.earlyEnd);
        object->setProperty("octaveAnalysis",value.octaveAnalysis);object->setProperty("reverse",value.reverse);object->setProperty("normalise",value.normalise);object->setProperty("channelOrder",value.channelOrder);object->setProperty("outputLayout",value.outputLayout);
        object->setProperty("crossTerms",value.crossTerms);object->setProperty("brightness",value.brightness);object->setProperty("sourceBlendLeft",value.sourceBlendLeft);object->setProperty("sourceBlendRight",value.sourceBlendRight);
        object->setProperty("lowDecay",value.lowDecay);object->setProperty("midDecay",value.midDecay);object->setProperty("highDecay",value.highDecay);
        object->setProperty("lowCrossover",value.lowCrossover);object->setProperty("highCrossover",value.highCrossover);object->setProperty("eqEnabled",value.eqEnabled);
        for(size_t band=0;band<4;++band){const auto prefix="eq"+juce::String(static_cast<int>(band));object->setProperty(prefix+"Frequency",value.eqFrequency[band]);object->setProperty(prefix+"Gain",value.eqGain[band]);object->setProperty(prefix+"Q",value.eqQ[band]);}
        return object;
    }
    static bool readShape(juce::var data,Shape& value)
    {
        if(data.isVoid())return true;
        if(const auto* bytes=data.getBinaryData()){const auto settings=juce::ValueTree::readFromData(bytes->getData(),bytes->getSize());if(!settings.hasType("IRShape"))return false;auto* object=new juce::DynamicObject();for(int i=0;i<settings.getNumProperties();++i){const auto name=settings.getPropertyName(i);object->setProperty(name,settings.getProperty(name));}data=juce::var(object);}
        if(data.isString())data=juce::JSON::parse(data.toString());
        const auto* object=data.getDynamicObject();if(!object)return false;
        const auto number=[object](const char* id,double& target,double lo,double hi){if(!object->hasProperty(id))return true;const auto raw=object->getProperty(id);if(!raw.isDouble()&&!raw.isInt()&&!raw.isInt64())return false;const double v=static_cast<double>(raw);if(!std::isfinite(v)||v<lo||v>hi)return false;target=v;return true;};
        for(size_t i=0;i<BuiltInIRGeometry::ids.size();++i)if(!number(BuiltInIRGeometry::ids[i],value.geometryPoints[i/2][i%2],-50,50))return false;
        if(!number("sourceBlendLeft",value.sourceBlendLeft,0,1)||!number("sourceBlendRight",value.sourceBlendRight,0,1)||!number("brightness",value.brightness,0,1)||!number("crossTerms",value.crossTerms,0,1)||!number("start",value.start,0,10)||!number("end",value.end,0,10)||!number("attack",value.attack,0,2)||!number("size",value.size,.5,2)
            ||!number("directDb",value.directDb,-60,12)||!number("earlyDb",value.earlyDb,-60,12)||!number("tailDb",value.tailDb,-60,12)
            ||!number("directEnd",value.directEnd,0,1)||!number("earlyEnd",value.earlyEnd,0,10))return false;
        if(!number("lowDecay",value.lowDecay,0,20)||!number("midDecay",value.midDecay,0,20)||!number("highDecay",value.highDecay,0,20)
            ||!number("lowCrossover",value.lowCrossover,60,2000)||!number("highCrossover",value.highCrossover,1000,16000))return false;
        for(double decay:{value.lowDecay,value.midDecay,value.highDecay})if(decay!=0&&decay<.1)return false;
        if(value.highCrossover<value.lowCrossover*2)return false;
        for(size_t band=0;band<4;++band){const auto prefix="eq"+juce::String(static_cast<int>(band));
            if(!number((prefix+"Frequency").toRawUTF8(),value.eqFrequency[band],20,20000)||!number((prefix+"Gain").toRawUTF8(),value.eqGain[band],-12,12)||!number((prefix+"Q").toRawUTF8(),value.eqQ[band],.3,6))return false;}
        for(const char* id:{"reverse","normalise","eqEnabled","octaveAnalysis","geometryEnabled"})if(object->hasProperty(id)&&!object->getProperty(id).isBool())return false;
        if(object->hasProperty("geometryEnabled"))value.geometryEnabled=static_cast<bool>(object->getProperty("geometryEnabled"));
        if(object->hasProperty("octaveAnalysis"))value.octaveAnalysis=static_cast<bool>(object->getProperty("octaveAnalysis"));
        if(object->hasProperty("eqEnabled"))value.eqEnabled=static_cast<bool>(object->getProperty("eqEnabled"));
        if(object->hasProperty("reverse"))value.reverse=static_cast<bool>(object->getProperty("reverse"));
        if(object->hasProperty("normalise"))value.normalise=static_cast<bool>(object->getProperty("normalise"));
        if(object->hasProperty("outputLayout")){const auto raw=object->getProperty("outputLayout");if(!raw.isInt()||static_cast<int>(raw)<0||static_cast<int>(raw)>1)return false;value.outputLayout=static_cast<int>(raw);}
        if(object->hasProperty("channelOrder")){const auto raw=object->getProperty("channelOrder");if(!raw.isInt()||static_cast<int>(raw)<0||static_cast<int>(raw)>1)return false;value.channelOrder=static_cast<int>(raw);}
        return value.directEnd<=value.earlyEnd&&BuiltInIRGeometry::valid(value)&&(!value.geometryEnabled||(!value.reverse&&value.size==1));
    }
    static bool decode(const juce::var& data,juce::AudioBuffer<float>& samples,double& sourceRate)
    {
        const auto* bytes=data.getBinaryData();if(!bytes||bytes->getSize()>64*1024*1024||bytes->getSize()<20)return false;
        juce::MemoryInputStream stream(*bytes,false);if(stream.readInt()!=0x4f534952)return false;
        sourceRate=stream.readDouble();const int channels=stream.readInt(),count=stream.readInt();
        if(!std::isfinite(sourceRate)||sourceRate<8000||sourceRate>384000||(channels!=1&&channels!=2&&channels!=4)||count<1||count>sourceRate*10
            ||bytes->getSize()!=20u+static_cast<size_t>(channels)*static_cast<size_t>(count)*4u)return false;
        samples.setSize(channels,count);for(int ch=0;ch<channels;++ch)for(int i=0;i<count;++i)samples.setSample(ch,i,stream.readFloat());return true;
    }
    bool restore(const juce::var& data,const juce::String& name,const Shape& next,BuiltInIRPreparation* progress=nullptr)
    {
        if(progress&&!progress->advance(BuiltInIRPreparation::reading))return false;
        juce::AudioBuffer<float> samples;double sourceRate=0;if(!decode(data,samples,sourceRate))return false;
        return publish(std::move(samples),sourceRate,name,next,progress);
    }
    static juce::AudioBuffer<float> shaped(const juce::AudioBuffer<float>& source,double sourceRate,const Shape& values,BuiltInIRPreparation* progress=nullptr)
    {
        // Bridge JSON can round an exact sample boundary down by a few ulps.
        // Keep floor semantics for genuine fractional positions without losing
        // a complete sample on an unchanged start/end sent back by the editor.
        const auto frame=[sourceRate](double seconds){return static_cast<int>(std::floor(seconds*sourceRate+1e-7));};
        const int start=juce::jmin(source.getNumSamples()-1,frame(values.start));
        const int end=values.end==0?source.getNumSamples():juce::jlimit(start+1,source.getNumSamples(),frame(values.end));
        const int length=end-start;juce::AudioBuffer<float> cropped(source.getNumChannels(),length);
        for(int ch=0;ch<source.getNumChannels();++ch)
        {
            cropped.copyFrom(ch,0,source,ch,start,length);
            // Keep the previous end-trim envelope bit-identical.
            if(end<source.getNumSamples()){const int fadeLength=juce::jmin(length,static_cast<int>(sourceRate*.01));cropped.applyGainRamp(ch,length-fadeLength,fadeLength,1,0);}
            if(values.reverse)std::reverse(cropped.getWritePointer(ch),cropped.getWritePointer(ch)+length);
        }
        juce::AudioBuffer<float> result;
        if(values.size==1)result=std::move(cropped);
        else
        {
            // 64-tap Blackman-windowed sinc, 1024 phases. Down-sizing reduces
            // cutoff before resampling. No added latency; zero outside the IR.
            constexpr int taps=64,phases=1024;std::vector<float> coefficients(static_cast<size_t>(taps*phases));
            const double cutoff=juce::jmin(1.0,values.size)*.94;
            for(int phase=0;phase<phases;++phase)
            {
                double sum=0;for(int tap=0;tap<taps;++tap){const double x=static_cast<double>(tap-31)-static_cast<double>(phase)/phases;
                    const double sinc=std::abs(x)<1e-12?cutoff:std::sin(juce::MathConstants<double>::pi*cutoff*x)/(juce::MathConstants<double>::pi*x);
                    const double window=.42+.5*std::cos(juce::MathConstants<double>::pi*x/32)+.08*std::cos(juce::MathConstants<double>::twoPi*x/32);
                    const float c=static_cast<float>(sinc*window);coefficients[static_cast<size_t>(phase*taps+tap)]=c;sum+=c;}
                for(int tap=0;tap<taps;++tap)coefficients[static_cast<size_t>(phase*taps+tap)]/=static_cast<float>(sum);
            }
            const int outputLength=juce::jmax(1,juce::roundToInt(length*values.size));result.setSize(source.getNumChannels(),outputLength);result.clear();
            for(int i=0;i<outputLength;++i){if((i&4095)==0&&progress&&progress->isCancelled())return {};const double at=i/values.size;const int whole=static_cast<int>(at),phase=juce::jmin(phases-1,static_cast<int>((at-whole)*phases));
                for(int ch=0;ch<source.getNumChannels();++ch){double sum=0;for(int tap=0;tap<taps;++tap){const int index=whole+tap-31;if(index>=0&&index<length)sum+=cropped.getSample(ch,index)*coefficients[static_cast<size_t>(phase*taps+tap)];}result.setSample(ch,i,static_cast<float>(sum));}}
        }
        BuiltInIRColour::damp(result,sourceRate,values,values.earlyEnd*values.size);
        const bool sectionGains=values.directDb!=0||values.earlyDb!=0||values.tailDb!=0;
        if(sectionGains||values.attack>0)for(int i=0;i<result.getNumSamples();++i)
        {
            const double time=i/sourceRate;const auto transition=[](double t,double boundary){return juce::jlimit(0.0,1.0,(t-boundary)/.002+.5);};
            const double first=transition(time,values.directEnd*values.size),second=transition(time,values.earlyEnd*values.size);
            const auto gain=[](double db){return db<=-60?0.0:std::pow(10.0,db/20);};
            const double balance=gain(values.directDb)*(1-first)+gain(values.earlyDb)*(first-second)+gain(values.tailDb)*second;
            const double attack=values.attack>0?juce::jlimit(0.0,1.0,time/values.attack):1;
            for(int ch=0;ch<result.getNumChannels();++ch)result.setSample(ch,i,result.getSample(ch,i)*static_cast<float>(balance*attack));
        }
        if(values.geometryEnabled){if(!BuiltInIRGeometry::apply(result,sourceRate,values.directEnd,values.channelOrder,values,progress))return {};}
        else BuiltInIRSourceBlend::apply(result,values.channelOrder,values.sourceBlendLeft,values.sourceBlendRight);
        if(!BuiltInIRBrightness::apply(result,sourceRate,values.brightness,values.directEnd*values.size,progress))return {};
        return result;
    }
    std::unique_ptr<Kernel> build(const juce::AudioBuffer<float>& source,double sourceRate,const Shape& values)
    {
        return buildShaped(shaped(source,sourceRate,values),sourceRate,values);
    }
    std::unique_ptr<Kernel> buildShaped(juce::AudioBuffer<float> samples,double sourceRate,const Shape& values)
    {
        auto kernel=std::make_unique<Kernel>();kernel->matrix=samples.getNumChannels()==4;kernel->splitOutputs=values.outputLayout==1;
        kernel->crossGain.reset(renderRate,.05);kernel->crossGain.setCurrentAndTargetValue(static_cast<float>(values.crossTerms));
        kernel->output.setSize(4,maximumBlock);kernel->output.clear();const auto normalise=values.normalise?juce::dsp::Convolution::Normalise::yes:juce::dsp::Convolution::Normalise::no;
        if(!kernel->matrix)kernel->diagonal.loadImpulseResponse(std::move(samples),sourceRate,juce::dsp::Convolution::Stereo::yes,juce::dsp::Convolution::Trim::no,normalise);
        else
        {
            // One gain for all four paths preserves measured cross-channel ratios.
            if(values.normalise){double left=0,right=0;const int lr=values.channelOrder==0?1:2,rl=values.channelOrder==0?2:1;
                for(int i=0;i<samples.getNumSamples();++i){left+=std::pow(samples.getSample(0,i),2)+std::pow(samples.getSample(rl,i),2);right+=std::pow(samples.getSample(lr,i),2)+std::pow(samples.getSample(3,i),2);}
                const double energy=juce::jmax(left,right);if(energy>1e-16)samples.applyGain(static_cast<float>(.125/std::sqrt(energy)));}
            juce::AudioBuffer<float> diagonal(2,samples.getNumSamples()),cross(2,samples.getNumSamples());
            diagonal.copyFrom(0,0,samples,0,0,samples.getNumSamples());diagonal.copyFrom(1,0,samples,3,0,samples.getNumSamples());
            cross.copyFrom(0,0,samples,values.channelOrder==0?2:1,0,samples.getNumSamples());cross.copyFrom(1,0,samples,values.channelOrder==0?1:2,0,samples.getNumSamples());
            kernel->diagonal.loadImpulseResponse(std::move(diagonal),sourceRate,juce::dsp::Convolution::Stereo::yes,juce::dsp::Convolution::Trim::no,juce::dsp::Convolution::Normalise::no);
            kernel->cross.loadImpulseResponse(std::move(cross),sourceRate,juce::dsp::Convolution::Stereo::yes,juce::dsp::Convolution::Trim::no,juce::dsp::Convolution::Normalise::no);
            kernel->crossBuffer.setSize(2,maximumBlock);kernel->cross.prepare({renderRate,static_cast<juce::uint32>(maximumBlock),2});kernel->primeCross();
        }
        kernel->diagonal.prepare({renderRate,static_cast<juce::uint32>(maximumBlock),2});return kernel;
    }
    bool publish(juce::AudioBuffer<float>&& samples,double sourceRate,const juce::String& name,Shape next,BuiltInIRPreparation* progress=nullptr)
    {
        if(progress&&!progress->advance(BuiltInIRPreparation::validating))return false;
        if(next.outputLayout==1&&samples.getNumChannels()!=4)return false;
        if(next.geometryEnabled&&(samples.getNumChannels()!=4||next.reverse||next.size!=1||!BuiltInIRGeometry::valid(next)))return false;
        const double fullDuration=samples.getNumSamples()/sourceRate;
        if(!std::isfinite(next.end)||next.end<0||next.end>10||next.start>=fullDuration||next.start<0)return false;
        next.end=next.end==0?fullDuration:juce::jmin(next.end,fullDuration);if(next.end<=next.start)return false;
        float peak=0;for(int ch=0;ch<samples.getNumChannels();++ch)for(int i=0;i<samples.getNumSamples();++i){if((i&4095)==0&&progress&&progress->isCancelled())return false;const float v=samples.getSample(ch,i);if(!std::isfinite(v)||std::abs(v)>16)return false;peak=juce::jmax(peak,std::abs(v));}if(peak<1e-9f)return false;
        juce::MemoryBlock bytes;juce::MemoryOutputStream stream(bytes,false);stream.writeInt(0x4f534952);stream.writeDouble(sourceRate);stream.writeInt(samples.getNumChannels());stream.writeInt(samples.getNumSamples());
        for(int ch=0;ch<samples.getNumChannels();++ch)for(int i=0;i<samples.getNumSamples();++i)stream.writeFloat(samples.getSample(ch,i));stream.flush();
        if(progress&&!progress->advance(BuiltInIRPreparation::shaping))return false;
        const juce::ScopedLock preparationGuard(preparationLock);collect();
        bool unchangedIR=false,unchangedEq=false,unchangedAnalysis=false;BuiltInIRDecay nextDecay;double nextDuration=0;std::array<float,96> envelope{};
        {const juce::ScopedLock lock(controlLock);unchangedIR=sourceBytes==bytes&&sameImpulse(shape,next);unchangedEq=sameEq(shape,next);unchangedAnalysis=shape.octaveAnalysis==next.octaveAnalysis;nextDuration=processedDuration;envelope=waveform;nextDecay=decayEstimate;}
        juce::AudioBuffer<float> processed;
        if(!unchangedIR||!unchangedAnalysis)
        {
            processed=shaped(samples,sourceRate,next,progress);if(progress&&progress->isCancelled())return false;envelope={};float shapedPeak=0;
            for(int ch=0;ch<processed.getNumChannels();++ch)shapedPeak=juce::jmax(shapedPeak,processed.getMagnitude(ch,0,processed.getNumSamples()));
            for(int ch=0;ch<processed.getNumChannels();++ch)for(int i=0;i<processed.getNumSamples();++i){const size_t bin=juce::jmin(size_t{95},static_cast<size_t>(i)*96/static_cast<size_t>(processed.getNumSamples()));envelope[bin]=juce::jmax(envelope[bin],std::abs(processed.getSample(ch,i))/juce::jmax(shapedPeak,1e-9f));}
            nextDuration=processed.getNumSamples()/sourceRate;
            if(progress&&!progress->advance(BuiltInIRPreparation::analysing))return false;
            nextDecay=BuiltInIRDecay::analyzeBands(processed,sourceRate,next.earlyEnd,next.lowCrossover,next.highCrossover);
            if(next.octaveAnalysis)nextDecay.addOctaves(processed,sourceRate,next.earlyEnd,[&]{return !progress||!progress->isCancelled();});
        }
        if(progress&&!progress->advance(BuiltInIRPreparation::preparing))return false;
        BuiltInIRColour::Eq eq;eq.prepare(next,renderRate>0?renderRate:48000);const auto nextResponse=eq.response();
        std::unique_ptr<Kernel> kernel;if(renderRate>0&&!unchangedIR)kernel=buildShaped(std::move(processed),sourceRate,next);
        std::unique_ptr<EqUpdate> update;if(renderRate>0&&!unchangedEq){update=std::make_unique<EqUpdate>();update->eq=eq;}
        // The previous unpublished engine is destroyed after metadata unlock.
        std::unique_ptr<Kernel> replaced;std::unique_ptr<EqUpdate> replacedEq;
        if(progress&&!progress->publish())return false;
        const juce::ScopedLock metadataGuard(controlLock);
        if(kernel)replaced.reset(pending.exchange(kernel.release()));
        if(update)replacedEq.reset(pendingEq.exchange(update.release()));
        sourceBytes=std::move(bytes);sourceName=name;sourceChannels=samples.getNumChannels();geometrySourceRate=sourceRate;duration=fullDuration;shape=next;
        targetCrossTerms.store(static_cast<float>(next.crossTerms),std::memory_order_relaxed);
        decayEstimate=std::move(nextDecay);processedDuration=nextDuration;waveform=envelope;eqResponse=nextResponse;eqSampleRate=eq.rate;tailSeconds.store(processedDuration+eq.tail);return true;
    }
};
