#pragma once
#include "PlaybackEngine.h"
#include <optional>
#include <cmath>

// Worker-thread source access never publishes the descriptor to realtime playback.
inline std::optional<PlaybackEngine::ClipInfo> resolveReadOnlyClipSource(
    const PlaybackEngine& playback, const juce::String& trackId, const juce::String& clipId,
    const juce::var& source)
{
    if (source.isVoid())
    {
        for (const auto& clip : playback.getClipSnapshot())
            if (clip.trackId == trackId && clip.clipId == clipId) return clip;
        return std::nullopt;
    }
    if (!source.isObject() || !source["filePath"].isString()
        || !juce::File::isAbsolutePath(source["filePath"].toString())) return std::nullopt;
    const auto number = [&](const char* name, double minimum, double maximum) {
        const auto value = source[name];
        return (value.isDouble() || value.isInt() || value.isInt64())
            && std::isfinite(static_cast<double>(value))
            && static_cast<double>(value) >= minimum && static_cast<double>(value) <= maximum;
    };
    if (!number("startTime", 0, 1e9) || !number("duration", 1e-9, 1e9) || !number("offset", 0, 1e9)
        || !number("volumeDB", -144, 24) || !number("fadeIn", 0, 1e9) || !number("fadeOut", 0, 1e9)
        || !number("fadeInCurve", 0, 4) || !number("fadeOutCurve", 0, 4)) return std::nullopt;
    PlaybackEngine::ClipInfo clip(juce::File(source["filePath"].toString()), source["startTime"], source["duration"],
        trackId, source["offset"], source["volumeDB"], source["fadeIn"], source["fadeOut"], source["fadeInCurve"], source["fadeOutCurve"]);
    clip.clipId = clipId;
    clip.originalAudioFile = clip.audioFile;
    clip.originalOffset = clip.offset;
    const auto* points = source["gainEnvelope"].getArray();
    if (points == nullptr || points->size() > 16384) return std::nullopt;
    double previousTime = -1.0;
    for (const auto& point : *points)
    {
        const auto time = point["time"], gain = point["gain"];
        if (!(time.isDouble() || time.isInt() || time.isInt64()) || !(gain.isDouble() || gain.isInt() || gain.isInt64()))
            return std::nullopt;
        const double t = time, g = gain;
        if (!std::isfinite(t) || !std::isfinite(g) || t < 0 || t <= previousTime || t > 1e9 || g < 0 || g > 2)
            return std::nullopt;
        clip.gainEnvelope.push_back({ t, static_cast<float>(g) });
        previousTime = t;
    }
    return clip;
}
