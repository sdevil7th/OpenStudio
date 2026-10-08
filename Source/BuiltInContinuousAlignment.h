#pragma once
#include "BuiltInAlignmentGroups.h"

// Worker-only bounded summaries. No audio is omitted between analysis windows.
struct BuiltInContinuousAlignment
{
    struct Evidence
    {
        BuiltInAlignmentEstimate combined;
        int windows=0,measurable=0,qualified=0;
        double weight=0,weightedLag=0,minLag=1e10,maxLag=-1e10;
        bool conflict=false,polarity=false;
        void add(const BuiltInAlignmentEstimate& estimate)
        {
            ++windows;if(estimate.referenceRms<1e-4||estimate.targetRms<1e-4)return;
            ++measurable;if(!estimate.accepted)return;
            if(qualified==0){polarity=estimate.invert;combined=estimate;}else conflict=conflict||polarity!=estimate.invert;
            ++qualified;minLag=juce::jmin(minLag,estimate.lag);maxLag=juce::jmax(maxLag,estimate.lag);
            const double strength=estimate.correlation*estimate.correlation;weight+=strength;weightedLag+=strength*estimate.lag;
            combined.correlation=juce::jmin(combined.correlation,estimate.correlation);combined.peakRatio=juce::jmin(combined.peakRatio,estimate.peakRatio);
            combined.referenceRms=juce::jmax(combined.referenceRms,estimate.referenceRms);combined.targetRms=juce::jmax(combined.targetRms,estimate.targetRms);
            combined.phaseResidual=juce::jmax(combined.phaseResidual,estimate.phaseResidual);
        }
        BuiltInAlignmentEstimate finish() const
        {
            auto value=combined;value.lag=weight>0?weightedLag/weight:0;value.invert=polarity;
            value.accepted=qualified>=6&&qualified*4>=measurable*3&&!conflict&&maxLag-minLag<=1;
            value.reason=qualified<6?"Fewer than six qualified continuous windows":qualified*4<measurable*3?"Too many measured windows disagree":conflict?"Continuous windows disagree in polarity":maxLag-minLag>1?"Continuous lags differ by more than one sample":"Continuous timing windows agree";
            return value;
        }
    };
    std::array<std::array<std::array<Evidence,2>,8>,8> evidence{};
    std::vector<std::array<std::vector<float>,2>> chunks,previous;
    std::vector<bool> ready;
    std::vector<int> valid;
    juce::int64 covered=0;int windows=0;
    explicit BuiltInContinuousAlignment(size_t members):chunks(members),previous(members),ready(members,false),valid(members,0){}
    bool consume(const std::vector<BuiltInAlignmentCapture*>& captures,bool weakSignal,const std::function<bool()>& keepRunning={})
    {
        for(size_t index=0;index<captures.size();++index)if(!ready[index])ready[index]=captures[index]->readContinuous(chunks[index],valid[index]);
        if(std::find(ready.begin(),ready.end(),false)!=ready.end())return true;
        for(const auto count:valid)if(count!=valid[0])return false;
        // Keep overlap only on the worker. The last short chunk is analyzed with
        // its preceding samples, so the exact span end is included too.
        std::vector<std::array<std::vector<float>,2>> analysis(chunks.size());
        for(size_t index=0;index<chunks.size();++index)for(size_t channel=0;channel<2;++channel)
        {
            auto& audio=analysis[index][channel];const auto& old=previous[index][channel];
            const size_t retained=juce::jmin(old.size(),static_cast<size_t>(4096));
            audio.insert(audio.end(),old.end()-static_cast<std::ptrdiff_t>(retained),old.end());
            audio.insert(audio.end(),chunks[index][channel].begin(),chunks[index][channel].end());
        }
        const int samples=static_cast<int>(analysis.front()[0].size());
        int order=1;while((1<<order)<samples*2)++order;
        juce::dsp::FFT fft(order);BuiltInAlignmentWorkspace workspace(fft.getSize());
        std::vector<std::array<BuiltInAlignmentSpectrum,2>> spectra(chunks.size());
        for(size_t index=0;index<chunks.size();++index)for(size_t channel=0;channel<2;++channel)
        {
            if(keepRunning&&!keepRunning())return false;
            spectra[index][channel].prepare(analysis[index][channel].data(),samples,fft);
        }
        for(size_t a=0;a<chunks.size();++a)for(size_t b=a+1;b<chunks.size();++b)for(size_t channel=0;channel<2;++channel)
        {
            if(keepRunning&&!keepRunning())return false;
            evidence[a][b][channel].add(estimateBuiltInAlignment(spectra[a][channel],spectra[b][channel],fft,workspace,weakSignal?.15:.55,weakSignal?1.5:1.15));
        }
        covered+=valid[0];++windows;previous.swap(chunks);std::fill(ready.begin(),ready.end(),false);return true;
    }
    BuiltInAlignmentGroups::Matrix matrix(bool linked) const
    {
        BuiltInAlignmentGroups::Matrix result{};
        for(size_t a=0;a<chunks.size();++a)for(size_t b=a+1;b<chunks.size();++b)
        {
            BuiltInAlignmentGroups::Pair pair{evidence[a][b][0].finish(),evidence[a][b][1].finish()};
            if(linked){const auto common=linkBuiltInAlignment(pair);pair={common,common};}
            result[a][b]=pair;result[b][a]=BuiltInAlignmentGroups::reverse(pair);
        }
        return result;
    }
};
