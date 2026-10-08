#pragma once
#include "JSFXProcessor.h"
#include <atomic>
#include <limits>

// The audio thread alone commits host slider values to YSFX. Parameter reads
// and editor notifications use atomics rather than reading live script memory.
class JSFXSliderParameter final : public juce::HostedAudioProcessorParameter
{
public:
    JSFXProcessor::SliderInfo info {};
    bool exists = false, path = false;
    std::atomic<float> normalized { 0.0f };
    std::atomic<double> pendingValue { 0.0 };
    std::atomic<bool> pending { false };

    float getValue() const override { return normalized.load(std::memory_order_acquire); }
    juce::String getParameterID() const override { return "slider:" + juce::String(getParameterIndex() + 1); }
    double nativeValue() const { return info.min + getValue() * (info.max - info.min); }
    float normalize(double value) const
    {
        return info.max > info.min ? juce::jlimit(0.0f, 1.0f,
            static_cast<float>((value - info.min) / (info.max - info.min))) : 0.0f;
    }
    void setValue(float value) override
    {
        if (!exists || !std::isfinite(value)) return;
        auto raw = info.min + juce::jlimit(0.0f, 1.0f, value) * (info.max - info.min);
        if (info.inc > 0) raw = info.min + std::round((raw - info.min) / info.inc) * info.inc;
        raw = juce::jlimit(info.min, info.max, raw);
        normalized.store(normalize(raw), std::memory_order_release);
        pendingValue.store(raw, std::memory_order_relaxed);
        pending.store(true, std::memory_order_release);
    }
    void publishScriptValue(double value, bool automate)
    {
        if (pending.load(std::memory_order_acquire)) return;
        const auto next = normalize(value);
        normalized.store(next, std::memory_order_release);
        if (automate && isAutomatable()) sendValueChangedMessageToListeners(next);
    }
    float getDefaultValue() const override { return normalize(info.def); }
    juce::String getName(int length) const override { return info.name.substring(0, length); }
    juce::String getLabel() const override { return {}; }
    bool isAutomatable() const override { return exists && !path && info.max > info.min; }
    // Numeric increments quantize a continuous knob; they do not turn its
    // envelope into a choice selector that holds until the next point.
    bool isDiscrete() const override { return info.isEnum; }
    int getNumSteps() const override
    {
        if (!isDiscrete() || info.inc <= 0) return getDefaultNumParameterSteps();
        const auto steps = std::round((info.max - info.min) / info.inc) + 1.0;
        return static_cast<int>(juce::jlimit(2.0, static_cast<double>((std::numeric_limits<int>::max)()), steps));
    }
    juce::String getText(float value, int length) const override
    {
        const auto raw = info.min + value * (info.max - info.min);
        if (info.isEnum && !info.enumNames.isEmpty())
        {
            const int index = juce::jlimit(0, info.enumNames.size() - 1,
                juce::roundToInt((raw - info.min) / juce::jmax(1.0, info.inc)));
            return info.enumNames[index].substring(0, length);
        }
        return juce::String(raw, 3).substring(0, length);
    }
    float getValueForText(const juce::String& text) const override
    {
        const int choice = info.enumNames.indexOf(text);
        return normalize(choice >= 0 ? info.min + choice * juce::jmax(1.0, info.inc) : text.getDoubleValue());
    }
};
