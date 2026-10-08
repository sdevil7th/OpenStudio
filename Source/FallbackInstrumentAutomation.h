#pragma once
#include "BuiltInParameterSupport.h"
#include <array>

struct FallbackInstrumentAutomationControl
{
    const char* id;
    float minimum, maximum;
    bool discrete = false;
};

inline constexpr std::array<FallbackInstrumentAutomationControl, 12> fallbackAutomationControls {{
    { "attackMs", 0.5f, 2000.0f }, { "releaseMs", 5.0f, 5000.0f },
    { "brightness", 0.0f, 1.0f }, { "detuneCents", 0.0f, 35.0f },
    { "subLevel", 0.0f, 0.8f }, { "noiseLevel", 0.0f, 0.25f },
    { "pianoTone", 0.0f, 1.0f }, { "pianoBody", 0.0f, 1.0f },
    { "drumKit", 0.0f, 2.0f, true }, { "drumTuning", -12.0f, 12.0f },
    { "drumAmbience", 0.0f, 1.0f }, { "outputGainDb", -36.0f, 0.0f }
}};
