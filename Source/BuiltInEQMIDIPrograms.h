#pragma once
#include <JuceHeader.h>
#include <array>
#include <cstring>
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

struct BuiltInEQPreparedPrograms;

struct BuiltInEQMIDIProgramBank
{
    static constexpr size_t valueCount=24*26+6, configurationCount=7;
    struct Entry
    {
        int bank=0,program=0;
        juce::String name;
        std::array<float,valueCount> values{};
        std::array<float,configurationCount> configuration{};
    };
    std::array<Entry,32> entries;
    int count=0,channel=0;
    bool enabled=false;
    juce::uint64 fingerprint=0;
    std::shared_ptr<BuiltInEQPreparedPrograms> prepared;
};
