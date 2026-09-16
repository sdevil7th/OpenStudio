#pragma once
#include <JuceHeader.h>
#include <set>

// Control thread only; iterative traversal cannot overflow on a deep graph.
template <typename Successors>
bool sendWouldCreateCycle(const juce::String& source, const juce::String& destination, Successors successors)
{
    juce::StringArray pending { destination };
    std::set<juce::String> visited;
    while (!pending.isEmpty())
    {
        const auto current = pending[pending.size() - 1];
        pending.remove(pending.size() - 1);
        if (current == source) return true;
        if (!visited.insert(current).second) continue;
        for (const auto& next : successors(current)) pending.add(next);
    }
    return false;
}
