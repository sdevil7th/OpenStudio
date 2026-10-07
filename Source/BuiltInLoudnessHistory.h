#pragma once
#include <JuceHeader.h>
#include <mutex>

// Bounded loudness history. The producer deposits complete energy windows at
// 10 Hz; only the consumer scans/gates the 0.01 LU histogram. Bin sums retain
// exact energies; gate-boundary and percentile positions are quantized.
class BuiltInLoudnessHistory
{
public:
    struct Reading
    {
        float integrated=-100,lra=0,maximumMomentary=-100,maximumShortTerm=-100;
        double seconds=0;bool integratedReady=false,lraReady=false,provisional=true,running=true;
    };
    std::atomic<bool> running { true };
    void prepare(double sampleRate)
    {
        rate=sampleRate;hop=juce::jmax(1,juce::roundToInt(rate*.1));momentarySamples=juce::jmax(1,juce::roundToInt(rate*.4));shortSamples=juce::jmax(1,juce::roundToInt(rate*3));
        if(!histograms)histograms=std::make_unique<Histograms>();reset();
    }
    void requestReset() noexcept { resetRequest.fetch_add(1,std::memory_order_release); }
    void reset() noexcept
    {
        version.fetch_add(1,std::memory_order_acq_rel);++producerEpoch;epoch.store(producerEpoch,std::memory_order_release);
        warmSamples=measuredSamples=0;untilHop=hop;active=running.load();maximumM.store(-100);maximumS.store(-100);seconds.store(0);
        appliedReset.store(resetRequest.load(std::memory_order_acquire),std::memory_order_release);version.fetch_add(1,std::memory_order_release);
    }
    bool beginBlock() noexcept
    {
        if(appliedReset.load(std::memory_order_acquire)!=resetRequest.load(std::memory_order_acquire)){reset();return true;}
        const bool next=running.load(std::memory_order_relaxed);if(next!=active){active=next;warmSamples=0;untilHop=hop;}
        return false;
    }
    void sample(double momentaryPower,double shortPower) noexcept
    {
        if(!active||!histograms)return;
        ++warmSamples;++measuredSamples;if(--untilHop>0)return;untilHop=hop;
        version.fetch_add(1,std::memory_order_acq_rel);
        if(warmSamples>=momentarySamples){deposit(histograms->momentary,momentaryPower);maximumM.store(juce::jmax(maximumM.load(),loudness(momentaryPower)));}
        if(warmSamples>=shortSamples){deposit(histograms->shortTerm,shortPower);maximumS.store(juce::jmax(maximumS.load(),loudness(shortPower)));}
        seconds.store(static_cast<double>(measuredSamples)/rate,std::memory_order_relaxed);version.fetch_add(1,std::memory_order_release);
    }
    Reading read()
    {
        std::lock_guard<std::mutex> guard(consumerMutex);
        if(!histograms||appliedReset.load()!=resetRequest.load()){Reading empty;empty.running=running.load();return empty;}
        for(int attempt=0;attempt<2;++attempt)
        {
            const auto before=version.load(std::memory_order_acquire);if(before&1)continue;
            if(before==cachedVersion){cached.running=running.load();return cached;}
            const auto generation=epoch.load(std::memory_order_acquire);Reading next;next.running=running.load();next.seconds=seconds.load();next.provisional=next.seconds<60;
            next.maximumMomentary=maximumM.load();next.maximumShortTerm=maximumS.load();
            const auto integrated=mean(histograms->momentary,generation,-70);
            if(integrated.count>0)
            {
                const auto gated=mean(histograms->momentary,generation,juce::jmax(-70.0f,loudness(integrated.power/integrated.count)-10));
                if(gated.count>0){next.integrated=loudness(gated.power/gated.count);next.integratedReady=true;}
            }
            const auto shortMean=mean(histograms->shortTerm,generation,-70);
            if(shortMean.count>0)
            {
                const float gate=juce::jmax(-70.0f,loudness(shortMean.power/shortMean.count)-20);
                const auto gated=mean(histograms->shortTerm,generation,gate);
                if(gated.count>0){next.lra=percentile(histograms->shortTerm,generation,gate,gated.count,.95)-percentile(histograms->shortTerm,generation,gate,gated.count,.10);next.lraReady=true;}
            }
            if(before==version.load(std::memory_order_acquire)){cached=next;cachedVersion=before;return next;}
        }
        cached.running=running.load();return cached;
    }
private:
    static constexpr size_t binCount=10001; // -70 through +30 LUFS
    struct Bin {std::atomic<juce::uint64> generation {0},count {0};std::atomic<double> power {0};};
    using Histogram=std::array<Bin,binCount>;
    struct Histograms {Histogram momentary,shortTerm;};
    struct Total {double power=0,count=0;};
    static float loudness(double power) noexcept {return power>1e-12&&std::isfinite(power)?static_cast<float>(-.691+10*std::log10(power)):-100.0f;}
    void deposit(Histogram& histogram,double power) noexcept
    {
        const float db=loudness(power);if(db < -70)return;
        const size_t index=static_cast<size_t>(juce::jlimit(0,static_cast<int>(binCount)-1,juce::roundToInt((db+70)*100)));
        auto& bin=histogram[index];if(bin.generation.load(std::memory_order_relaxed)!=producerEpoch){bin.count.store(0,std::memory_order_relaxed);bin.power.store(0,std::memory_order_relaxed);bin.generation.store(producerEpoch,std::memory_order_relaxed);}
        bin.count.store(bin.count.load(std::memory_order_relaxed)+1,std::memory_order_relaxed);bin.power.store(bin.power.load(std::memory_order_relaxed)+power,std::memory_order_relaxed);
    }
    static Total mean(const Histogram& histogram,juce::uint64 generation,float gate)
    {
        Total total;
        for(size_t i=0;i<binCount;++i)if(-70+static_cast<double>(i)*.01>=gate)
        {
            const auto& bin=histogram[i];if(bin.generation.load(std::memory_order_relaxed)==generation){total.count+=static_cast<double>(bin.count.load(std::memory_order_relaxed));total.power+=bin.power.load(std::memory_order_relaxed);}
        }
        return total;
    }
    static float percentile(const Histogram& histogram,juce::uint64 generation,float gate,double count,double fraction)
    {
        const double rank=std::floor((count-1)*fraction+.5);double accumulated=0;
        for(size_t i=0;i<binCount;++i)if(-70+static_cast<double>(i)*.01>=gate)
        {
            const auto& bin=histogram[i];if(bin.generation.load(std::memory_order_relaxed)==generation)accumulated+=static_cast<double>(bin.count.load(std::memory_order_relaxed));
            if(accumulated>rank)return static_cast<float>(-70+static_cast<double>(i)*.01);
        }
        return 30;
    }
    std::unique_ptr<Histograms> histograms;
    std::atomic<juce::uint64> epoch {0},version {0},resetRequest {0},appliedReset {0};
    juce::uint64 producerEpoch=0,cachedVersion=~juce::uint64{0};
    juce::int64 warmSamples=0,measuredSamples=0;
    double rate=48000;int hop=4800,untilHop=4800,momentarySamples=19200,shortSamples=144000;bool active=true;
    std::atomic<double> seconds {0};std::atomic<float> maximumM {-100},maximumS {-100};
    Reading cached;std::mutex consumerMutex;
};
