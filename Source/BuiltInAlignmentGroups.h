#pragma once
#include "BuiltInAlignmentCapture.h"
#include <algorithm>
#include <functional>

// Worker-only complete-link clustering. Strong A-B and B-C relationships do
// not imply an A-C relationship: every edge and every phase/delay cycle must
// independently agree. The conservative output is a proposal, never an edit.
namespace BuiltInAlignmentGroups
{
using Pair = std::array<BuiltInAlignmentEstimate,2>;
using Matrix = std::array<std::array<Pair,8>,8>;
struct Result { std::vector<std::vector<size_t>> groups;std::vector<size_t> unmatched; };

inline Pair reverse(Pair pair)
{
    for(auto& channel:pair){channel.lag=-channel.lag;std::swap(channel.referenceRms,channel.targetRms);}return pair;
}

inline bool measure(const std::vector<std::array<const float*,2>>& audio,int samples,bool sections,bool linked,
                    Matrix& matrix,const std::function<bool()>& keepRunning={},
                    const std::function<void(double)>& progress={},bool projectSpan=false,bool weakSignal=false)
{
    if(audio.size()<2||audio.size()>8||samples<4096)return false;
    const size_t total=audio.size()*(audio.size()-1)/2;size_t complete=0;
    for(size_t a=0;a<audio.size();++a)for(size_t b=a+1;b<audio.size();++b)
    {
        Pair pair;
        for(size_t ch=0;ch<2;++ch)
        {
            if(keepRunning&&!keepRunning())return false;
            if(!audio[a][ch]||!audio[b][ch])return false;
            pair[ch]=projectSpan?estimateBuiltInAlignmentSpan(audio[a][ch],audio[b][ch],samples,weakSignal).combined
                             :sections?estimateBuiltInAlignmentSections(audio[a][ch],audio[b][ch],samples).combined
                             :estimateBuiltInAlignment(audio[a][ch],audio[b][ch],samples);
        }
        if(linked){const auto common=linkBuiltInAlignment(pair);pair={common,common};}
        matrix[a][b]=pair;matrix[b][a]=reverse(pair);++complete;
        if(progress)progress(static_cast<double>(complete)/static_cast<double>(total));
    }
    return !(keepRunning&&!keepRunning());
}

inline bool compatible(const std::vector<size_t>& group,const Matrix& matrix)
{
    if(group.empty())return false;
    const size_t reference=group.front();
    for(const auto a:group)for(const auto b:group)if(a!=b)
        for(size_t ch=0;ch<2;++ch)
        {
            const auto& edge=matrix[a][b][ch];const auto& first=matrix[reference][a][ch];const auto& second=matrix[reference][b][ch];
            if(!edge.accepted||!std::isfinite(edge.lag)||!std::isfinite(edge.correlation)
                ||std::abs(edge.lag-(second.lag-first.lag))>1.0
                ||edge.invert!=(first.invert!=second.invert))return false;
        }
    return true;
}

inline Result find(const Matrix& matrix,size_t count,size_t preferredReference=0)
{
    Result result;if(count>8)return result;
    std::vector<std::vector<size_t>> clusters;for(size_t i=0;i<count;++i)clusters.push_back({i});
    for(;;)
    {
        size_t bestA=count,bestB=count;double best=-1;
        for(size_t a=0;a<clusters.size();++a)for(size_t b=a+1;b<clusters.size();++b)
        {
            auto merged=clusters[a];merged.insert(merged.end(),clusters[b].begin(),clusters[b].end());
            if(!compatible(merged,matrix))continue;
            double score=1;for(const auto left:clusters[a])for(const auto right:clusters[b])
                for(size_t ch=0;ch<2;++ch)score=juce::jmin(score,matrix[left][right][ch].correlation);
            if(score>best){best=score;bestA=a;bestB=b;}
        }
        if(best<0)break;
        clusters[bestA].insert(clusters[bestA].end(),clusters[bestB].begin(),clusters[bestB].end());
        std::sort(clusters[bestA].begin(),clusters[bestA].end());clusters.erase(clusters.begin()+static_cast<std::ptrdiff_t>(bestB));
    }
    for(auto& group:clusters)
    {
        if(group.size()<2){result.unmatched.push_back(group.front());continue;}
        size_t reference=group.front();double strongest=-1;
        for(const auto candidate:group)
        {
            double score=0;for(const auto other:group)if(other!=candidate)score+=juce::jmin(matrix[candidate][other][0].correlation,matrix[candidate][other][1].correlation);
            if(score>strongest){strongest=score;reference=candidate;}
        }
        if(std::find(group.begin(),group.end(),preferredReference)!=group.end())reference=preferredReference;
        const auto selected=std::find(group.begin(),group.end(),reference);std::rotate(group.begin(),selected,selected+1);
        result.groups.push_back(std::move(group));
    }
    return result;
}
}
