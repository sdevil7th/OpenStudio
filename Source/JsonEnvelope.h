#pragma once
#include <JuceHeader.h>
#include <array>

// Cheap lexical preflight before JUCE's recursive JSON parser. Not a substitute
// for schema validation; it prevents excessive nesting from exhausting stacks.
inline bool hasBoundedJsonEnvelope(const juce::String& json, size_t maximumBytes = 256 * 1024 * 1024)
{
    if (json.getNumBytesAsUTF8() > maximumBytes) return false;
    std::array<juce::juce_wchar, 64> brackets {};
    size_t depth = 0, tokens = 0;
    bool quoted = false, escaped = false;
    for (const auto character : json)
    {
        if (quoted)
        {
            if (escaped) escaped = false;
            else if (character == '\\') escaped = true;
            else if (character == '"') quoted = false;
            continue;
        }
        if (character == '"') quoted = true;
        else if (character == '{' || character == '[')
        {
            if (depth == brackets.size() || ++tokens > 2000000) return false;
            brackets[depth++] = character;
        }
        else if (character == '}' || character == ']')
        {
            if (depth == 0 || brackets[--depth] != static_cast<juce::juce_wchar>(character == '}' ? '{' : '[')) return false;
        }
        else if (character == ',' && ++tokens > 2000000) return false;
    }
    return depth == 0 && !quoted;
}
