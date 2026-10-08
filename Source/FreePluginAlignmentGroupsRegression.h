#pragma once
#include "BuiltInAlignmentGroups.h"

inline juce::var checkAlignmentGroups()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Audio-derived conservative alignment groups");
    constexpr int count=24576;
    std::array<std::vector<float>,8> tracks;std::array<std::vector<float>,3> sources;
    juce::Random random(993817);for(auto& source:sources){source.resize(count+128);for(auto& value:source)value=(random.nextFloat()-.5f)*.2f;}
    for(auto& track:tracks)track.resize(count);
    for(int i=0;i<count;++i)
    {
        tracks[0][static_cast<size_t>(i)]=sources[0][static_cast<size_t>(i+128)];
        tracks[1][static_cast<size_t>(i)]=-.7f*sources[0][static_cast<size_t>(i+109)];
        tracks[2][static_cast<size_t>(i)]=.3f*sources[0][static_cast<size_t>(i+71)];
        tracks[3][static_cast<size_t>(i)]=sources[1][static_cast<size_t>(i+128)];
        tracks[4][static_cast<size_t>(i)]=-.4f*sources[1][static_cast<size_t>(i+81)];
        tracks[5][static_cast<size_t>(i)]=sources[2][static_cast<size_t>(i+128)];
        tracks[7][static_cast<size_t>(i)]=sources[0][static_cast<size_t>(i+128-(i<count/2?37:43))];
    }
    std::vector<std::array<const float*,2>> audio;for(auto& track:tracks)audio.push_back({track.data(),track.data()});
    BuiltInAlignmentGroups::Matrix matrix{};double progress=0;
    bool pass=BuiltInAlignmentGroups::measure(audio,count,true,false,matrix,{},[&](double value){progress=value;});
    const auto groups=BuiltInAlignmentGroups::find(matrix,8,2);
    const auto contains=[](const std::vector<size_t>& values,size_t item){return std::find(values.begin(),values.end(),item)!=values.end();};
    const bool correct=groups.groups.size()==2&&groups.unmatched.size()==3
        &&groups.groups[0].size()==3&&groups.groups[0][0]==2&&contains(groups.groups[0],0)&&contains(groups.groups[0],1)
        &&groups.groups[1].size()==2&&contains(groups.groups[1],3)&&contains(groups.groups[1],4)
        &&contains(groups.unmatched,5)&&contains(groups.unmatched,6)&&contains(groups.unmatched,7)&&progress==1;
    bool disjoint=true;std::array<int,8> seen{};for(const auto& group:groups.groups)for(const auto index:group)++seen[index];for(const auto index:groups.unmatched)++seen[index];for(const int occurrences:seen)disjoint=disjoint&&occurrences==1;
    auto inconsistent=matrix;inconsistent[0][2][0].lag+=4;inconsistent[2][0]=BuiltInAlignmentGroups::reverse(inconsistent[0][2]);
    const bool cycleRejected=!BuiltInAlignmentGroups::compatible({0,1,2},inconsistent);
    inconsistent=matrix;inconsistent[0][2][1].invert=!inconsistent[0][2][1].invert;inconsistent[2][0]=BuiltInAlignmentGroups::reverse(inconsistent[0][2]);
    const bool polarityRejected=!BuiltInAlignmentGroups::compatible({0,1,2},inconsistent);
    inconsistent=matrix;for(auto& channel:inconsistent[0][2])channel.accepted=false;inconsistent[2][0]=BuiltInAlignmentGroups::reverse(inconsistent[0][2]);
    const auto incomplete=BuiltInAlignmentGroups::find(inconsistent,3);const bool weakChainRejected=incomplete.groups.size()==1&&incomplete.groups[0].size()==2&&incomplete.unmatched.size()==1;
    BuiltInAlignmentGroups::Matrix empty{};const auto isolated=BuiltInAlignmentGroups::find(empty,8);const bool isolatedSafe=isolated.groups.empty()&&isolated.unmatched.size()==8;
    int calls=0;const bool cancellation=!BuiltInAlignmentGroups::measure(audio,count,true,false,empty,[&]{return ++calls<3;});
    BuiltInAlignmentGroups::Matrix linked{};const bool linkedPass=BuiltInAlignmentGroups::measure({audio[0],audio[1]},count,true,true,linked)&&BuiltInAlignmentGroups::find(linked,2).groups.size()==1;
    pass=pass&&correct&&disjoint&&cycleRejected&&polarityRejected&&weakChainRejected&&isolatedSafe&&cancellation&&linkedPass;
    result->setProperty("pass",pass);result->setProperty("twoIndependentGroups",correct);result->setProperty("disjointMembership",disjoint);result->setProperty("lagCycleRejected",cycleRejected);result->setProperty("polarityCycleRejected",polarityRejected);result->setProperty("weakTransitiveChainRejected",weakChainRejected);result->setProperty("unrelatedSilenceAndDriftUngrouped",correct&&isolatedSafe);result->setProperty("cancellable",cancellation);result->setProperty("linkedPolicy",linkedPass);
    juce::Array<juce::var> output;for(const auto& group:groups.groups){juce::Array<juce::var> entries;for(const auto index:group)entries.add(static_cast<int>(index));output.add(entries);}result->setProperty("groups",output);result->setProperty("audioQuality","not_asserted");return result;
}
