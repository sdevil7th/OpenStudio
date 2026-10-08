# Exact-context patches for the pinned JUCE revision. Reject unknown or partial rewrites.
function(openstudio_patch_automation relative before after key)
    set(path "${JUCE_SOURCE_DIR}/${relative}")
    file(READ "${path}" content)
    string(FIND "${content}" "${after}" already)
    if(already GREATER_EQUAL 0)
        return()
    endif()
    string(FIND "${content}" "${before}" original)
    if(original LESS 0)
        message(FATAL_ERROR "Pinned JUCE automation context changed at ${key}; refusing an unverified rewrite")
    endif()
    string(REPLACE "${before}" "${after}" content "${content}")
    file(WRITE "${path}" "${content}")
endfunction()

openstudio_patch_automation("modules/juce_audio_processors_headless/processors/juce_AudioProcessorParameter.h" [=[    virtual void setValue (float newValue) = 0;]=] [=[    virtual void setValue (float newValue) = 0;

    // OpenStudio pinned host extension. Called only by the processing thread,
    // immediately before processBlock. Editor writes continue to use setValue.
    virtual bool supportsSampleAccurateAutomation() const noexcept { return false; }
    virtual bool supportsLinearAutomationQueue() const noexcept { return false; }
    virtual bool queueValueAtSampleOffset (float, int) noexcept { return false; }]=] "sample-input-api")

openstudio_patch_automation("modules/juce_audio_processors_headless/processors/juce_AudioProcessorParameter.h" [=[        virtual void parameterValueChanged (int parameterIndex, float newValue) = 0;]=] [=[        virtual void parameterValueChanged (int parameterIndex, float newValue) = 0;
        virtual void parameterValueChangedAtSampleOffset (int parameterIndex, float newValue, int sampleOffset)
        { ignoreUnused (sampleOffset); parameterValueChanged (parameterIndex, newValue); }
        virtual void parameterBeingDeleted() {}]=] "sample-output-listener-api")

openstudio_patch_automation("modules/juce_audio_processors_headless/processors/juce_AudioProcessorParameter.h" [=[    void sendValueChangedMessageToListeners (float newValue);]=] [=[    void sendValueChangedMessageToListeners (float newValue);
    void sendValueChangedMessageToListenersAtSampleOffset (float newValue, int sampleOffset);]=] "sample-output-dispatch-api")

openstudio_patch_automation("modules/juce_audio_processors_headless/processors/juce_AudioProcessorParameter.cpp" [=[AudioProcessorParameter::~AudioProcessorParameter()
{]=] [=[AudioProcessorParameter::~AudioProcessorParameter()
{
    const ScopedLock deletionLock (listenerLock);
    for (auto* listener : listeners) if (listener != nullptr) listener->parameterBeingDeleted();
    listeners.clear();]=] "parameter-lifetime-notification")

openstudio_patch_automation("modules/juce_audio_processors_headless/processors/juce_AudioProcessorParameter.cpp" [=[bool AudioProcessorParameter::isOrientationInverted() const                      { return false; }]=] [=[void AudioProcessorParameter::sendValueChangedMessageToListenersAtSampleOffset (float newValue, int sampleOffset)
{
    const ScopedLock lock (listenerLock);
    for (int i = listeners.size(); --i >= 0;)
        if (auto* listener = listeners[i]) listener->parameterValueChangedAtSampleOffset (getParameterIndex(), newValue, sampleOffset);
    if (finalListener != nullptr) finalListener->parameterValueChangedAtSampleOffset (getParameterIndex(), newValue, sampleOffset);
}

bool AudioProcessorParameter::isOrientationInverted() const                      { return false; }]=] "sample-output-dispatch")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h" [=[    tresult PLUGIN_API getPoint (Steinberg::int32 index,
                                 Steinberg::int32& sampleOffset,
                                 Vst::ParamValue& value) override
    {
        if (! isPositiveAndBelow (index, size))
            return kResultFalse;

        sampleOffset = 0;
        value = cachedValue;

        return kResultTrue;
    }

    tresult PLUGIN_API addPoint (Steinberg::int32,
                                 Vst::ParamValue value,
                                 Steinberg::int32& index) override
    {
        index = size++;
        set ((float) value);

        return kResultTrue;
    }

    void set (float valueIn)
    {
        cachedValue = valueIn;
        size = 1;
    }

]=] [=[    tresult PLUGIN_API getPoint (Steinberg::int32 index, Steinberg::int32& sampleOffset, Vst::ParamValue& value) override
    {
        if (! isPositiveAndBelow (index, size)) return kResultFalse;
        const auto& point = points[static_cast<size_t> (index)];
        sampleOffset = point.offset; value = point.value; return kResultTrue;
    }
    tresult PLUGIN_API addPoint (Steinberg::int32 sampleOffset, Vst::ParamValue value, Steinberg::int32& index) override
    {
        if (size >= static_cast<Steinberg::int32> (points.size()) || sampleOffset < 0 || ! std::isfinite (value)) return kResultFalse;
        index = size;
        points[static_cast<size_t> (size++)] = { sampleOffset, static_cast<float> (value) };
        cachedValue = static_cast<float> (value);
        return kResultTrue;
    }
    void set (float valueIn)
    {
        clear(); Steinberg::int32 index{}; addPoint (0, valueIn, index);
    }

]=] "bounded-vst3-output-points")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h" [=[    float cachedValue{};
    Steinberg::int32 size{};]=] [=[    struct Point { Steinberg::int32 offset{}; float value{}; };
    std::array<Point, 128> points {};
    float cachedValue{};
    Steinberg::int32 size{};]=] "bounded-vst3-output-storage")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h" [=[        void setValueWithoutUpdatingProcessor (float newValue)
        {
            if (! exactlyEqual (pluginInstance.cachedParamValues.exchangeWithoutNotifying (vstParamIndex, newValue), newValue))
                sendValueChangedMessageToListeners (newValue);
        }]=] [=[        void setValueWithoutUpdatingProcessor (float newValue, int sampleOffset = -1)
        {
            if (! exactlyEqual (pluginInstance.cachedParamValues.exchangeWithoutNotifying (vstParamIndex, newValue), newValue))
            {
                if (sampleOffset >= 0) sendValueChangedMessageToListenersAtSampleOffset (newValue, sampleOffset);
                else sendValueChangedMessageToListeners (newValue);
            }
        }
        bool supportsSampleAccurateAutomation() const noexcept override { return true; }
        bool supportsLinearAutomationQueue() const noexcept override { return true; }
        bool queueValueAtSampleOffset (float value, int offset) noexcept override
        {
            if (offset < 0 || ! std::isfinite (value) || pluginInstance.pendingAutomationSize >= pluginInstance.pendingAutomation.size()) return false;
            pluginInstance.pendingAutomation[pluginInstance.pendingAutomationSize++] = { cachedInfo.id, offset, value };
            pluginInstance.cachedParamValues.exchangeWithoutNotifying (vstParamIndex, value);
            pluginInstance.parameterDispatcher.push (vstParamIndex, value);
            return true;
        }]=] "vst3-parameter-sample-api")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h" [=[        processor->process (data);

        outputParameterChanges->forEach ([&] (Steinberg::int32 vstParamIndex, Vst::ParamID id, float value)
        {
            // Send the parameter value from the processor to the editor
            parameterDispatcher.push (vstParamIndex, value);

            // Update the host's parameter value
            if (auto* param = getParameterForID (id))
                param->setValueWithoutUpdatingProcessor (value);
        });]=] [=[        for (size_t index = 0; index < pendingAutomationSize; ++index)
        {
            const auto& point = pendingAutomation[index];
            inputParameterChanges->set (point.id, point.value, jlimit (0, jmax (0, numSamples - 1), point.offset));
        }
        pendingAutomationSize = 0;
        processor->process (data);

        for (Steinberg::int32 index = 0; index < outputParameterChanges->getParameterCount(); ++index)
        {
            auto* queue = outputParameterChanges->getParameterData (index);
            if (queue == nullptr) continue;
            for (Steinberg::int32 point = 0; point < queue->getPointCount(); ++point)
            {
                Steinberg::int32 offset{}; Vst::ParamValue value{};
                if (queue->getPoint (point, offset, value) != kResultTrue) continue;
                const auto normalized = static_cast<float> (value);
                parameterDispatcher.push (queue->getParameterIndex(), normalized);
                if (auto* param = getParameterForID (queue->getParameterId()))
                    param->setValueWithoutUpdatingProcessor (normalized, jlimit (0, jmax (0, numSamples - 1), offset));
            }
        }]=] "vst3-process-sample-queues")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h" [=[    CachedParamValues cachedParamValues;]=] [=[    struct AutomationInputPoint { Vst::ParamID id{}; Steinberg::int32 offset{}; float value{}; };
    std::array<AutomationInputPoint, 8192> pendingAutomation {};
    size_t pendingAutomationSize = 0;
    CachedParamValues cachedParamValues;]=] "bounded-vst3-input-storage")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h"
[=[        auto node = getNodeFromStorage();
        node.key()]=]
[=[        if (! list.empty() && std::prev (list.end())->second.offset == item.offset)
        { std::prev (list.end())->second = item; return; }
        if (sharedStorage.empty()) return; // OpenStudio: never allocate a queue node in process().
        auto node = getNodeFromStorage();
        node.key()]=] "bounded-unique-vst3-input-offset")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h"
[=[            hostToClientParamQueueStorage = HostToClientParamQueue::makeStorage (1 << 13);

            auto allIds = getAllParamIDs (*editController);]=]
[=[            auto allIds = getAllParamIDs (*editController);
            hostToClientParamQueueStorage = HostToClientParamQueue::makeStorage (allIds.size() + 8192);]=] "vst3-input-budget")

openstudio_patch_automation("modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h" [=[class VST3PluginInstanceHeadless : public AudioPluginInstance]=] [=[#if !defined(JUCE_AUDIO_PROCESSORS_H_INCLUDED)
bool openStudioVST3AutomationQueueSelfTest()
{
    ClientToHostParamQueue output (42, 0);
    bool pass = true;
    for (int index = 0; index < 3; ++index)
    {
        Steinberg::int32 resultIndex = -1;
        pass = pass && output.addPoint (index == 0 ? 2 : index == 1 ? 17 : 49, index == 0 ? .2 : index == 1 ? .8 : .3, resultIndex) == kResultTrue && resultIndex == index;
    }
    for (int index = 0; index < 3; ++index)
    {
        Steinberg::int32 offset = -1; Vst::ParamValue value = -1;
        pass = pass && output.getPoint (index, offset, value) == kResultTrue
            && offset == (index == 0 ? 2 : index == 1 ? 17 : 49)
            && std::abs (value - (index == 0 ? .2 : index == 1 ? .8 : .3)) < 1.0e-6;
    }
    for (int index = 3; index < 128; ++index) { Steinberg::int32 resultIndex{}; pass = pass && output.addPoint (index, .5, resultIndex) == kResultTrue; }
    Steinberg::int32 rejected{}; pass = pass && output.addPoint (129, .5, rejected) == kResultFalse;
    auto storage = HostToClientParamQueue::makeStorage (8);
    ParameterChanges<HostToClientParamQueue> input;
    input.initialise (std::vector<Vst::ParamID> { 42 }, storage);
    input.set (42, .1f, 0); input.set (42, .2f, 0); input.set (42, .8f, 17); input.set (42, .3f, 49);
    auto* queue = input.getParameterData (0);
    pass = pass && queue != nullptr && queue->getPointCount() == 3;
    if (queue != nullptr)
        for (int index = 0; index < 3; ++index)
        {
            Steinberg::int32 offset = -1; Vst::ParamValue value = -1;
            pass = pass && queue->getPoint (index, offset, value) == kResultTrue
                && offset == (index == 0 ? 0 : index == 1 ? 17 : 49)
                && std::abs (value - (index == 0 ? .2 : index == 1 ? .8 : .3)) < 1.0e-6;
        }
    input.clear(); pass = pass && storage.size() == 8;
    return pass;
}
#endif

class VST3PluginInstanceHeadless : public AudioPluginInstance]=] "vst3-sample-queue-regression")
