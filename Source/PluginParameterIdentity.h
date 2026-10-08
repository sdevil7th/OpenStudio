#pragma once
#include <JuceHeader.h>
#include "JSFXSliderParameter.h"
#include "CLAPPluginFormat.h"

// Message-thread metadata only. A normalized curve must not silently acquire a
// different meaning after a script reload or plugin parameter rescan.
inline juce::String pluginParameterMeaning(juce::AudioProcessor* processor, int index)
{
    const auto* parameter = processor && juce::isPositiveAndBelow(index, processor->getParameters().size()) ? processor->getParameters()[index] : nullptr;
    if (parameter == nullptr || !parameter->isAutomatable()) return {};
    juce::String result;
    if (const auto* hosted = dynamic_cast<const juce::HostedAudioProcessorParameter*>(parameter))
        result = hosted->getParameterID();
    else if (const auto* named = dynamic_cast<const juce::AudioProcessorParameterWithID*>(parameter))
        result = named->paramID;
    result += "|" + juce::String(parameter->isDiscrete() ? parameter->getNumSteps() : 0);
    if (const auto* ranged = dynamic_cast<const juce::RangedAudioParameter*>(parameter))
    {
        const auto& range = ranged->getNormalisableRange();
        result += "|range|" + juce::String(range.start, 17) + "|" + juce::String(range.end, 17)
            + "|" + juce::String(range.interval, 17) + "|" + juce::String(range.skew, 17) + "|" + juce::String(range.symmetricSkew ? 1 : 0);
    }
    if (const auto* slider = dynamic_cast<const JSFXSliderParameter*>(parameter))
        result += "|" + slider->info.name + "|" + juce::String(slider->info.min, 17)
            + "|" + juce::String(slider->info.max, 17) + "|" + slider->info.enumNames.joinIntoString("\x1f");
    else
    {
        double minimum = 0.0, maximum = 1.0;
        if (getOpenStudioCLAPParameterRange(processor, index, minimum, maximum))
            result += "|" + juce::String(minimum, 17) + "|" + juce::String(maximum, 17);
        if (parameter->isDiscrete() && parameter->getNumSteps() <= 128)
            for (int step = 0; step < parameter->getNumSteps(); ++step)
                result += "|" + parameter->getText(static_cast<float>(step) / static_cast<float>(juce::jmax(1, parameter->getNumSteps() - 1)), 128);
    }
    return result;
}

inline juce::var pluginParameterCaptureMetadata(juce::AudioProcessor* processor, int index)
{
    if (!processor || !juce::isPositiveAndBelow(index, processor->getParameters().size())) return {};
    auto* parameter = processor->getParameters()[index];
    auto* info = new juce::DynamicObject();
    info->setProperty("index", index); info->setProperty("name", parameter->getName(128));
    info->setProperty("value", parameter->getValue()); info->setProperty("builtIn", false);
    info->setProperty("meaningSignature", pluginParameterMeaning(processor, index));
    uint64_t referenceGeneration = 0;
    if (getOpenStudioCLAPParameterReferenceGeneration(processor, index, referenceGeneration))
        info->setProperty("referenceGeneration", static_cast<juce::int64>(referenceGeneration));
    if (const auto* hosted = dynamic_cast<const juce::HostedAudioProcessorParameter*>(parameter)) info->setProperty("hostParamId", hosted->getParameterID());
    else if (const auto* named = dynamic_cast<const juce::AudioProcessorParameterWithID*>(parameter)) info->setProperty("hostParamId", named->paramID);
    info->setProperty("discrete", parameter->isDiscrete()); info->setProperty("unit", parameter->getLabel());
    info->setProperty("type", parameter->isBoolean() ? "toggle" : parameter->isDiscrete() ? "enum" : "continuous");
    if (parameter->isDiscrete()) info->setProperty("stepCount", parameter->getNumSteps());
    if (const auto* slider = dynamic_cast<const JSFXSliderParameter*>(parameter))
    { info->setProperty("min", slider->info.min); info->setProperty("max", slider->info.max); }
    double minimum = 0, maximum = 1;
    if (getOpenStudioCLAPParameterRange(processor, index, minimum, maximum))
    { info->setProperty("min", minimum); info->setProperty("max", maximum); }
    if (parameter->isDiscrete() && parameter->getNumSteps() > 1 && parameter->getNumSteps() <= 128)
    {
        juce::Array<juce::var> choices;
        for (int step = 0; step < parameter->getNumSteps(); ++step)
        {
            const float value = static_cast<float>(step) / static_cast<float>(parameter->getNumSteps() - 1);
            auto* choice = new juce::DynamicObject(); choice->setProperty("value", value); choice->setProperty("label", parameter->getText(value, 128));
            choices.add(juce::var(choice));
        }
        info->setProperty("enumOptions", choices);
    }
    return juce::var(info);
}
