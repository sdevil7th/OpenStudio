#pragma once
#include <cstring>
#include <JuceHeader.h>

namespace PluginStateValidation
{
constexpr size_t maximumBytes = 64 * 1024 * 1024;

// JUCE MemoryBlock encoding is NOT RFC 4648 Base64. Its decimal length prefix
// controls allocation, and JUCE itself accepts negative lengths/truncated data.
// Validate before allocation, including canonical padding bits and alphabet.
inline bool decode(const juce::String& encoded, juce::MemoryBlock& destination)
{
    const auto text = encoded.getCharPointer();
    auto cursor = text;
    size_t bytes = 0;
    int digits = 0;
    while (*cursor >= '0' && *cursor <= '9')
    {
        if (++digits > 8) return false;
        bytes = bytes * 10 + static_cast<size_t>(cursor.getAndAdvance() - '0');
        if (bytes > maximumBytes) return false;
    }
    if (digits == 0 || cursor.getAndAdvance() != '.' || (digits > 1 && *text == '0')) return false;
    const size_t expectedCharacters = (bytes * 8 + 5) / 6;
    constexpr const char* alphabet = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+";
    size_t characters = 0;
    int lastValue = 0;
    while (auto character = cursor.getAndAdvance())
    {
        if (++characters > expectedCharacters || character > 127) return false;
        const auto* found = std::strchr(alphabet, static_cast<char>(character));
        if (found == nullptr) return false;
        lastValue = static_cast<int>(found - alphabet);
    }
    if (characters != expectedCharacters) return false;
    const auto finalBits = static_cast<int>((bytes * 8) % 6);
    if (finalBits != 0 && lastValue >= (1 << finalBits)) return false;
    return destination.fromBase64Encoding(encoded) && destination.getSize() == bytes;
}
}
