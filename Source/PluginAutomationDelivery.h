#pragma once
#include "AutomationList.h"
#include "PluginParameterCapture.h"

inline bool deliverPluginAutomationPoints(juce::AudioProcessorParameter* parameter, const AutomationList& list,
                                         double start, double rate, int samples,
                                         const std::shared_ptr<PluginParameterCapture::State>& editorState)
{
    if (!parameter || !parameter->supportsSampleAccurateAutomation() || samples <= 0 || rate <= 0 || !std::isfinite(rate)) return false;
    if (editorState) editorState->hostAutomating.store(true, std::memory_order_release);
    const auto lost = list.deliverSampleAccuratePoints(start, rate, samples, parameter->supportsLinearAutomationQueue(), parameter,
        [](void* context, int offset, float value) {
            return static_cast<juce::AudioProcessorParameter*>(context)->queueValueAtSampleOffset(juce::jlimit(0.0f, 1.0f, value), offset);
        });
    if (lost && editorState) editorState->deliveryDropped.fetch_add(static_cast<uint64_t>(lost));
    return true;
}
