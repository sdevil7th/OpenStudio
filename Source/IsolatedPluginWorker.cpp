#include "NativeWindowTheme.h"
#include "IsolatedPlugin.h"
#include "IsolatedPluginProtocol.h"
#include "CLAPPluginFormat.h"
#include "JsonEnvelope.h"
#include "PluginParameterIdentity.h"
#include <thread>
#include <mutex>
#include <limits>
#if JUCE_WINDOWS
#include <windows.h>
#include <avrt.h>
#endif

namespace
{
using namespace IsolatedPluginProtocol;
// Built into the helper only as an explicitly named regression processor; this
// exercises real child access violations/hangs, not a host-thread approximation.
class IsolationProbe final : public juce::AudioPluginInstance
{
public:
    IsolationProbe() : AudioPluginInstance(BusesProperties().withInput("Input", juce::AudioChannelSet::stereo(), true)
        .withOutput("Output", juce::AudioChannelSet::stereo(), true)) { addHostedParameter(std::make_unique<GainParameter>(gain, automation, contractChanged, presentationChanged)); }
    std::atomic<int> mode { 0 };
    std::atomic<float> gain { 1 };
    std::atomic<bool> contractChanged { false };
    std::atomic<bool> presentationChanged { false };
    IsolatedPluginProtocol::ParameterPacket automation;
    struct GainParameter final : public juce::HostedAudioProcessorParameter
    {
        explicit GainParameter(std::atomic<float>& value, IsolatedPluginProtocol::ParameterPacket& points, std::atomic<bool>& changed,
                               std::atomic<bool>& renamed)
            : gain(value), automation(points), contractChanged(changed), presentationChanged(renamed) {}
        std::atomic<float>& gain;
        IsolatedPluginProtocol::ParameterPacket& automation;
        std::atomic<bool>& contractChanged;
        std::atomic<bool>& presentationChanged;
        float getValue() const override { return gain.load(); }
        void setValue(float value) override { gain.store(juce::jlimit(0.0f, 1.0f, value)); }
        bool supportsSampleAccurateAutomation() const noexcept override { return true; }
        bool queueValueAtSampleOffset(float value, int offset) noexcept override
        { return offset >= 0 && automation.add(0, static_cast<uint32_t>(offset), value); }
        float getDefaultValue() const override { return 1; }
        juce::String getName(int) const override { return presentationChanged.load() ? "Mode-specific Gain" : "Gain"; }
        juce::String getLabel() const override { return {}; }
        juce::String getParameterID() const override { return contractChanged.load() ? "gain-reassigned" : "gain"; }
        float getValueForText(const juce::String& text) const override { return juce::jlimit(0.0f, 1.0f, text.getFloatValue()); }
    };
    void fail(int crashMode, int hangMode)
    {
        juce::ignoreUnused(crashMode);
#if JUCE_WINDOWS
        if (mode.load() == crashMode) RaiseException(EXCEPTION_ACCESS_VIOLATION, EXCEPTION_NONCONTINUABLE, 0, nullptr);
#endif
        if (mode.load() == hangMode) for (;;) juce::Thread::sleep(1000);
    }
    void prepareToPlay(double, int) override {}
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        fail(2, 3);
        std::sort(automation.points.begin(), automation.points.begin() + automation.count,
            [](const auto& a, const auto& b) { return a.sample < b.sample; });
        uint32_t next = 0;
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
        {
            while (next < automation.count && automation.points[next].sample <= static_cast<uint32_t>(sample)) gain.store(automation.points[next++].value);
            for (int channel = 0; channel < buffer.getNumChannels(); ++channel) buffer.setSample(channel, sample, buffer.getSample(channel, sample) * gain.load());
        }
        automation.clear();
        if (mode.load() == 8)
        {
            mode.store(0);
            auto* parameter = getParameters()[0];
            for (const auto& point : std::array<std::pair<int, float>, 3> { std::pair { 2, .2f }, { 17, .8f }, { 49, .3f } })
            { gain.store(point.second); parameter->sendValueChangedMessageToListenersAtSampleOffset(point.second, point.first); }
        }
        if (mode.load() == 9 || mode.load() == 10 || mode.load() == 11) {
            if (mode.load() == 9) contractChanged.store(true);
            if (mode.load() == 11) presentationChanged.store(true);
            mode.store(0); updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withParameterInfoChanged(true));
        }
        if (mode.load() == 1) buffer.setSample(0, 0, std::numeric_limits<float>::quiet_NaN());
    }
    const juce::String getName() const override { return "Isolation regression probe"; }
    void fillInPluginDescription(juce::PluginDescription& description) const override { description.name = getName(); }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    double getTailLengthSeconds() const override { return 0; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { fail(6, 7); return new juce::GenericAudioProcessorEditor(*this); }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return "Default"; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock& state) override { fail(4, 5); const auto value = gain.load(); state.replaceAll(&value, sizeof(value)); }
    void setStateInformation(const void* data, int size) override
    {
        fail(4, 5);
        if (size == sizeof(float)) { float value; memcpy(&value, data, sizeof(value)); if (std::isfinite(value)) gain.store(value); }
        updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withParameterInfoChanged(true));
    }
};

#if JUCE_WINDOWS
thread_local bool currentKeyRepeat = false;
LRESULT CALLBACK observeRemoteKey(int code, WPARAM key, LPARAM flags)
{
    if (code >= 0 && (flags & (static_cast<LPARAM>(1) << 31)) == 0)
        currentKeyRepeat = (flags & (static_cast<LPARAM>(1) << 30)) != 0;
    return CallNextHookEx(nullptr, code, key, flags);
}
juce::var layoutMetadata(juce::AudioProcessor& processor, bool input)
{
    juce::Array<juce::var> buses;
    for (int i = 0; i < processor.getBusCount(input); ++i)
    {
        auto* bus = processor.getBus(input, i);
        auto object = std::make_unique<juce::DynamicObject>();
        object->setProperty("name", bus->getName());
        object->setProperty("enabled", bus->isEnabled());
        juce::Array<juce::var> types;
        const auto layout = bus->getLastEnabledLayout();
        for (int channel = 0; channel < layout.size(); ++channel) types.add(static_cast<int>(layout.getTypeOfChannel(channel)));
        object->setProperty("channels", types);
        buses.add(juce::var(object.release()));
    }
    return buses;
}
class WorkerPlayHead final : public juce::AudioPlayHead
{
public:
    juce::Optional<PositionInfo> value;
    juce::Optional<PositionInfo> getPosition() const override { return value; }
};
class RemoteWindow final : public juce::DocumentWindow
{
public:
    RemoteWindow(juce::AudioPluginInstance& plugin, Shared& sharedState)
        : DocumentWindow(plugin.getName() + " — Isolated", juce::Colour(0xff191b20), allButtons), state(sharedState)
    {
        setUsingNativeTitleBar(true);
        applyNativeWindowTheme(*this);
        setContentOwned(plugin.createEditorAndMakeActive(), true);
        centreWithSize(juce::jmax(300, getWidth()), juce::jmax(180, getHeight()));
    }
    ~RemoteWindow() override
    {
        if (auto* editor = dynamic_cast<juce::AudioProcessorEditor*>(getContentComponent()))
            editor->getAudioProcessor()->editorBeingDeleted(editor);
        clearContentComponent();
    }
    void closeButtonPressed() override { setVisible(false); state.editorVisible.store(0); state.editorFocused.store(0); }
    void activeWindowStatusChanged() override { state.focusGeneration.fetch_add(1); state.editorFocused.store(isActiveWindow() ? 1u : 0u); }
    bool keyPressed(const juce::KeyPress& key) override
    {
        // The remote editor gets first refusal. Never forward its local history
        // to the invisible DAW. Only unconsumed eligible keys can reach the host.
        const auto mods = key.getModifiers();
        if ((mods.isCtrlDown() || mods.isCommandDown()) && (key.getKeyCode() == 'Z' || key.getKeyCode() == 'Y')) return true;
        if (DocumentWindow::keyPressed(key)) return true;
        const auto write = state.keyWrite.load(), read = state.keyRead.load(std::memory_order_acquire);
        if (write - read >= 16) return true; // Bounded queue; never block the plugin UI.
        state.keys[write % 16] = { key.getKeyCode(), mods.getRawFlags(), static_cast<uint32_t>(key.getTextCharacter()),
            state.focusGeneration.load(), GetTickCount64(), currentKeyRepeat };
        state.keyWrite.store(write + 1, std::memory_order_release);
        return true;
    }
private:
    Shared& state;
};

class Worker final : private juce::AudioProcessorParameter::Listener, private juce::AudioProcessorListener
{
public:
    Worker(Shared& sharedState, HANDLE signal) : shared(sharedState), wake(signal)
    {
        midi.ensureSize(16384);
        keyboardHook = SetWindowsHookExW(WH_KEYBOARD, observeRemoteKey, nullptr, GetCurrentThreadId());
    }
    ~Worker()
    {
        if (keyboardHook) UnhookWindowsHookEx(keyboardHook);
        quitting.store(true);
        SetEvent(wake);
        if (audioThread.joinable()) audioThread.join(); // Parent enforces child deadline if native DSP is stuck.
        window.reset();
        if (plugin) { plugin->removeListener(this); for (auto* parameter : plugin->getParameters()) parameter->removeListener(this); }
    }
    void run()
    {
        uint32_t observedRequest = 0;
        while (!quitting.load())
        {
            const auto requested = shared.request.load(std::memory_order_acquire);
            if (requested != observedRequest)
            {
                observedRequest = requested;
                bool result = false;
                try { result = control(shared.command.load()); }
                catch (...) { shared.fault.store(controlFailure); }
                shared.success.store(result ? 1u : 0u);
                shared.response.store(requested, std::memory_order_release);
            }
            if (!juce::MessageManager::getInstance()->runDispatchLoopUntil(2)) break;
            if (metadataPending.load(std::memory_order_acquire)) {
                const std::lock_guard<std::mutex> lock(processorMutex);
                validateParameterContract();
                SetEvent(wake);
            }
        }
    }
private:
    Shared& shared;
    HANDLE wake;
    HHOOK keyboardHook = nullptr;
    juce::AudioPluginFormatManager formats;
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    std::unique_ptr<RemoteWindow> window;
    std::thread audioThread;
    std::mutex processorMutex; // Only inside disposable child; parent RT never locks/waits.
    std::atomic<bool> quitting { false };
    std::atomic<bool> metadataPending { false };
    std::vector<juce::String> parameterContracts;
    std::vector<juce::String> parameterPresentations;
    bool prepared = false;
    int quantum = 512, channelCount = 2;
    uint32_t generation = 0, observedParameters = 0;
    juce::MidiBuffer midi;
    juce::AudioBuffer<float> audio;
    WorkerPlayHead playhead;
    juce::File stateFile;

    inline static thread_local bool applyingHostState = false;
    inline static thread_local std::array<bool, parameters> hostAutomated {};
    void publishEditorEvent(int index, unsigned phase, float value) noexcept
    {
        PluginAutomationCapturedEvent event; event.parameter = index; event.phase = phase; event.value = value;
        event.ticks = juce::Time::getHighResolutionTicks();
        const auto context = pluginAutomationProcessingContext;
        event.timed = (context.processing && context.epoch != 0) || shared.captureClock.ticks.load(std::memory_order_acquire) != 0;
        if (context.processing)
        {
            event.time = context.position + static_cast<double>(juce::jmax(0, context.offset)) / juce::jmax(1.0, context.sampleRate);
            event.epoch = context.epoch; event.rolling = context.rolling; event.timing = context.offset >= 0 ? 2 : 1;
        }
        else
        {
            event.time = shared.captureClock.estimate(event.ticks); event.epoch = shared.captureClock.epoch.load();
            event.rolling = shared.captureClock.rolling.load(); event.timing = 0;
        }
        if (!shared.editorQueue.push(event))
        {
            shared.editorDropped.fetch_add(1);
            shared.params[index].editorValue.store(value);
            shared.params[index].editorEvents.fetch_or(phase, std::memory_order_release);
        }
    }
    void parameterBeingDeleted() override { shared.fault.store(incompatible); }
    void audioProcessorParameterChanged(juce::AudioProcessor*, int, float) override {}
    void audioProcessorChanged(juce::AudioProcessor*, const juce::AudioProcessorListener::ChangeDetails& details) override
    { if (details.parameterInfoChanged) metadataPending.store(true, std::memory_order_release); }
    juce::String parameterContract(int index) const
    {
        auto* parameter = plugin->getParameters()[index];
        // Vendor controls can rename themselves when another control changes
        // mode (for example Predelay/Numerator or Saturation/Quality). Stable
        // SDK identity and normalized semantics still own the automation queue.
        return pluginParameterMeaning(plugin.get(), index)
            + "|" + juce::String(parameter->isAutomatable() ? 1 : 0) + "|" + juce::String(static_cast<int>(parameter->getCategory()))
            + "|" + juce::String(parameter->isBoolean() ? 1 : 0) + "|" + juce::String(parameter->getNumSteps())
            + "|" + juce::String(parameter->supportsSampleAccurateAutomation() ? 1 : 0)
            + "|" + juce::String(parameter->supportsLinearAutomationQueue() ? 1 : 0);
    }
    juce::String parameterPresentation(int index) const
    {
        auto* parameter = plugin->getParameters()[index];
        return parameter->getName(256) + "|" + parameter->getLabel()
            + "|" + juce::String(parameter->getDefaultValue(), 17);
    }
    // Message thread, with processorMutex held. An INFO notification is not
    // itself a new contract: several VST3 plugins send it on every state recall.
    bool validateParameterContract()
    {
        if (!metadataPending.exchange(false, std::memory_order_acq_rel)) return shared.fault.load() == healthy;
        if (!plugin || plugin->getParameters().size() != static_cast<int>(parameterContracts.size())) {
            shared.fault.store(incompatible); return false;
        }
        bool presentationChanged = false;
        for (int index = 0; index < plugin->getParameters().size(); ++index)
        {
            if (parameterContracts[static_cast<size_t>(index)] != parameterContract(index)) {
                shared.fault.store(incompatible); return false;
            }
            const auto presentation = parameterPresentation(index);
            auto& previous = parameterPresentations[static_cast<size_t>(index)];
            if (previous != presentation) { previous = presentation; presentationChanged = true; }
        }
        if (presentationChanged) shared.parameterPresentationRevision.fetch_add(1, std::memory_order_release);
        return shared.fault.load() == healthy;
    }
    void parameterValueChangedAtSampleOffset(int index, float value, int offset) override
    { const ScopedPluginAutomationSampleOffset sample(offset); parameterValueChanged(index, value); }
    void parameterValueChanged(int index, float value) override
    {
        if (index < 0 || index >= parameters || !std::isfinite(value)) return;
        auto& parameter = shared.params[index];
        parameter.actual.store(juce::jlimit(0.0f, 1.0f, value));
        if (!applyingHostState && !(pluginAutomationProcessingContext.processing && hostAutomated[static_cast<size_t>(index)]))
            publishEditorEvent(index, 2u, value);
    }
    void parameterGestureChanged(int index, bool starting) override
    {
        if (!applyingHostState && index >= 0 && index < parameters)
            publishEditorEvent(index, starting ? 1u : 4u, shared.params[index].actual.load());
    }
    bool textResult(const juce::var& value)
    {
        const auto text = juce::JSON::toString(value, true);
        const auto bytes = text.getNumBytesAsUTF8();
        if (bytes >= metadataBytes) return false;
        memcpy(shared.text, text.toRawUTF8(), bytes + 1);
        shared.textBytes = static_cast<uint32_t>(bytes);
        return true;
    }
    juce::String requestText() const
    { return shared.textBytes < metadataBytes ? juce::String::fromUTF8(shared.text, static_cast<int>(shared.textBytes)) : juce::String(); }
    // Both callers hold processorMutex; state snapshots must include writes
    // even when no audio packet is scheduled (bypass or closed device).
    bool applyPendingParameters()
    {
        const auto changes = shared.parameterChanges.load(std::memory_order_acquire);
        if (changes != observedParameters)
        {
            observedParameters = changes;
            for (int i = 0; i < plugin->getParameters().size(); ++i)
            {
                auto& parameter = shared.params[i];
                const auto revision = parameter.revision.load(std::memory_order_acquire);
                if (revision == parameter.acknowledged.load()) continue;
                const auto value = parameter.desired.load();
                if (!std::isfinite(value) || value < 0 || value > 1) { shared.fault.store(invalidPacket); return false; }
                const juce::ScopedValueSetter<bool> hostWrite(applyingHostState, true);
                plugin->getParameters()[i]->setValueNotifyingHost(value);
                parameter.actual.store(value);
                parameter.acknowledged.store(revision, std::memory_order_release);
            }
        }
        return shared.fault.load() == healthy;
    }
    bool control(uint32_t command)
    {
        // Native editors normally coexist with processing. Do not suspend DSP
        // while opening/closing a window; state/layout operations still exclude it.
        std::unique_lock<std::mutex> lock(processorMutex, std::defer_lock);
        if (command != showEditor && command != hideEditor) lock.lock();
        if (command == stop) { quitting.store(true); return true; }
        if (command == initialise)
        {
            const auto text = requestText();
            if (!hasBoundedJsonEnvelope(text, metadataBytes)) return false;
            const auto request = juce::JSON::parse(text);
            const auto statePath = request.getProperty("stateFile", "").toString();
            if (!juce::File::isAbsolutePath(statePath)) return false;
            stateFile = juce::File(statePath);
            auto xml = juce::parseXML(request.getProperty("description", "").toString());
            juce::PluginDescription description;
            if (!xml || !description.loadFromXml(*xml)) return false;
            if (description.pluginFormatName == "OpenStudioIsolationProbe" && description.fileOrIdentifier == "openstudio-isolation-regression")
                plugin = std::make_unique<IsolationProbe>();
            else
            {
                juce::addDefaultFormatsToManager(formats);
                formats.addFormat(std::make_unique<CLAPPluginFormat>());
                // LV2 discovery primes the child-local world; never dlopen here in the parent.
                if (description.pluginFormatName.containsIgnoreCase("LV2"))
                    for (int i = 0; i < formats.getNumFormats(); ++i)
                        if (formats.getFormat(i)->getName() == description.pluginFormatName)
                            formats.getFormat(i)->searchPathsForPlugins(
                                juce::FileSearchPath(juce::File(description.fileOrIdentifier).getParentDirectory().getFullPathName()), true, false);
                juce::String error;
                plugin = formats.createPluginInstance(description, shared.rate, static_cast<int>(shared.quantum), error);
                if (!plugin) { textResult(error); return false; }
            }
            channelCount = juce::jmax(plugin->isMidiEffect() ? 2 : 1, plugin->getTotalNumInputChannels(), plugin->getTotalNumOutputChannels());
            if (channelCount > channels || plugin->getParameters().size() > parameters
                || plugin->getBusCount(true) > 16 || plugin->getBusCount(false) > 16)
            {
                auto* failure = new juce::DynamicObject();
                failure->setProperty("error", "Unsupported isolated layout: " + juce::String(channelCount) + " audio channels, "
                    + juce::String(plugin->getBusCount(true)) + " input buses, " + juce::String(plugin->getBusCount(false))
                    + " output buses, " + juce::String(plugin->getParameters().size()) + " parameters (limits: 32 channels, 16 buses per direction, 8192 parameters)");
                textResult(juce::var(failure));
                return false;
            }
            plugin->setPlayHead(&playhead);
            auto metadata = std::make_unique<juce::DynamicObject>();
            metadata->setProperty("inputs", layoutMetadata(*plugin, true));
            metadata->setProperty("outputs", layoutMetadata(*plugin, false));
            metadata->setProperty("acceptsMidi", plugin->acceptsMidi());
            metadata->setProperty("producesMidi", plugin->producesMidi());
            metadata->setProperty("midiEffect", plugin->isMidiEffect());
            metadata->setProperty("hasEditor", plugin->hasEditor());
            metadata->setProperty("tail", plugin->getTailLengthSeconds());
            juce::Array<juce::var> paramMetadata, programs;
            const auto& params = plugin->getParameters();
            shared.parameterCount = static_cast<uint32_t>(params.size());
            int choiceBudget = 4096;
            for (int i = 0; i < params.size(); ++i)
            {
                auto* parameter = params[i];
                const auto initial = parameter->getValue();
                if (!std::isfinite(initial)) return false;
                shared.params[i].actual.store(initial);
                shared.params[i].desired.store(initial);
                auto data = std::make_unique<juce::DynamicObject>();
                data->setProperty("id", plugin->getHostedParameter(i)->getParameterID());
                data->setProperty("name", parameter->getName(256));
                data->setProperty("label", parameter->getLabel());
                data->setProperty("default", parameter->getDefaultValue());
                data->setProperty("steps", parameter->getNumSteps());
                data->setProperty("discrete", parameter->isDiscrete());
                data->setProperty("boolean", parameter->isBoolean());
                data->setProperty("automatable", parameter->isAutomatable());
                data->setProperty("category", static_cast<int>(parameter->getCategory()));
                const int steps = parameter->getNumSteps();
                if (parameter->isDiscrete() && steps > 1 && steps <= 128 && steps <= choiceBudget)
                {
                    juce::Array<juce::var> choices;
                    for (int choice = 0; choice < steps; ++choice) choices.add(parameter->getText(static_cast<float>(choice) / static_cast<float>(steps - 1), 128));
                    data->setProperty("enumLabels", juce::var(choices)); choiceBudget -= steps;
                }
                data->setProperty("sampleAccurate", parameter->supportsSampleAccurateAutomation());
                data->setProperty("linearQueue", parameter->supportsLinearAutomationQueue());
                paramMetadata.add(juce::var(data.release()));
                parameterContracts.push_back(parameterContract(i));
                parameterPresentations.push_back(parameterPresentation(i));
                parameter->addListener(this);
            }
            const auto count = plugin->getNumPrograms();
            if (count < 0 || count > 4096) return false;
            for (int i = 0; i < count; ++i) programs.add(plugin->getProgramName(i));
            metadata->setProperty("parameters", paramMetadata);
            plugin->addListener(this);
            metadata->setProperty("programs", programs);
            shared.currentProgram.store(plugin->getCurrentProgram());
            if (!textResult(juce::var(metadata.release()))) return false;
            audioThread = std::thread([this] { process(); });
            return true;
        }
        if (!plugin) return false;
        if (plugin->getParameters().size() != static_cast<int>(shared.parameterCount))
        { shared.fault.store(incompatible); return false; }
        if (command == testParameterGesture)
        {
            if (dynamic_cast<IsolationProbe*>(plugin.get()) == nullptr) return false;
            auto* parameter = plugin->getParameters()[0];
            parameter->beginChangeGesture();
            for (const float value : { .1f, .8f, .42f }) parameter->setValueNotifyingHost(value);
            parameter->endChangeGesture();
            return true;
        }
        if (command == getParameterPresentation)
        {
            if (!validateParameterContract()) return false;
            auto* result = new juce::DynamicObject();
            juce::Array<juce::var> items;
            for (int index = 0; index < plugin->getParameters().size(); ++index)
            {
                auto* parameter = plugin->getParameters()[index];
                auto* item = new juce::DynamicObject();
                item->setProperty("id", plugin->getHostedParameter(index)->getParameterID());
                item->setProperty("name", parameter->getName(256));
                item->setProperty("label", parameter->getLabel());
                item->setProperty("default", parameter->getDefaultValue());
                items.add(juce::var(item));
            }
            result->setProperty("parameters", items);
            result->setProperty("revision", static_cast<juce::int64>(shared.parameterPresentationRevision.load()));
            return textResult(juce::var(result));
        }
        if (command == testFailure)
        {
            if (auto* probe = dynamic_cast<IsolationProbe*>(plugin.get()))
            { probe->mode.store(static_cast<int>(shared.commandArgument)); return true; }
            return false;
        }
        if (command == prepare)
        {
            if (!std::isfinite(shared.rate) || shared.rate < 8000 || shared.rate > 384000
                || shared.quantum < 128 || shared.quantum > frames) return false;
            prepared = false;
            quantum = static_cast<int>(shared.quantum);
            const auto layout = plugin->getBusesLayout();
            plugin->setNonRealtime(shared.nonRealtime != 0);
            plugin->setRateAndBufferSizeDetails(shared.rate, quantum);
            plugin->prepareToPlay(shared.rate, quantum);
            if (plugin->getBusesLayout() != layout)
            {
                if (!plugin->setBusesLayout(layout)) return false;
                plugin->prepareToPlay(shared.rate, quantum);
                if (plugin->getBusesLayout() != layout) return false;
            }
            plugin->reset();
            generation = shared.generation;
            for (auto& slot : shared.packets) slot.state.store(0);
            midi.clear();
            audio.setSize(channelCount, quantum);
            shared.latency.store(plugin->getLatencySamples());
            prepared = true;
            return true;
        }
        if (command == release) { prepared = false; plugin->releaseResources(); return true; }
        if (command == getState)
        {
            if (!applyPendingParameters()) return false;
            juce::MemoryBlock state;
            plugin->getStateInformation(state);
            if (state.getSize() > maxStateBytes) return false;
            juce::TemporaryFile temporary(stateFile);
            return temporary.getFile().replaceWithData(state.getData(), state.getSize())
                && temporary.overwriteTargetFileWithTemporary();
        }
        if (command == setState)
        {
            const juce::ScopedValueSetter<bool> hostWrite(applyingHostState, true);
            if (!stateFile.existsAsFile() || stateFile.getSize() > maxStateBytes || stateFile.isSymbolicLink()) return false;
            juce::MemoryBlock state;
            if (!stateFile.loadFileAsData(state)) return false;
            const auto layout = plugin->getBusesLayout();
            plugin->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            if (plugin->getBusesLayout() != layout && !plugin->setBusesLayout(layout)) return false;
            if (plugin->getParameters().size() != static_cast<int>(shared.parameterCount)) {
                shared.fault.store(incompatible); return false;
            }
            if (!validateParameterContract()) return false;
            for (int i = 0; i < plugin->getParameters().size(); ++i)
            {
                const auto value = plugin->getParameters()[i]->getValue();
                if (!std::isfinite(value)) return false;
                parameterValueChanged(i, value);
                shared.params[i].desired.store(value);
                const auto revision = shared.params[i].revision.fetch_add(1) + 1;
                shared.params[i].acknowledged.store(revision, std::memory_order_release);
            }
            shared.currentProgram.store(plugin->getCurrentProgram());
            return validateParameterContract();
        }
        if (command == program)
        {
            if (shared.commandArgument >= static_cast<uint32_t>(plugin->getNumPrograms())) return false;
            plugin->setCurrentProgram(static_cast<int>(shared.commandArgument));
            shared.currentProgram.store(plugin->getCurrentProgram());
            return true;
        }
        if (command == showEditor)
        {
            if (!window) window = std::make_unique<RemoteWindow>(*plugin, shared);
            if (!window->getContentComponent()) return false;
            window->setVisible(true); window->toFront(true);
            shared.editorVisible.store(1);
            return true;
        }
        if (command == hideEditor) { window.reset(); shared.editorVisible.store(0); shared.editorFocused.store(0); return true; }
        return false;
    }
    void process()
    {
        juce::Thread::setCurrentThreadName("Isolated plugin DSP");
        DWORD taskIndex = 0;
        const auto scheduling = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
        const juce::ScopedNoDenormals noDenormals;
        while (!quitting.load())
        {
            WaitForSingleObject(wake, 10);
            for (;;)
            {
                const std::lock_guard<std::mutex> lock(processorMutex);
                if (!prepared || shared.fault.load() != healthy || metadataPending.load(std::memory_order_acquire)) break;
                Slot* next = nullptr;
                for (auto& slot : shared.packets)
                    if (slot.state.load(std::memory_order_acquire) == 1 && (!next || slot.sequence < next->sequence)) next = &slot;
                if (!next) break;
                next->state.store(2, std::memory_order_release);
                if (!next->midi.valid(quantum) || !next->automation.valid(static_cast<uint32_t>(quantum), shared.parameterCount)
                    || plugin->getParameters().size() != static_cast<int>(shared.parameterCount)) { shared.fault.store(invalidPacket); break; }
                if (next->generation != generation) { plugin->reset(); generation = next->generation; }
                if (shared.resetRequested.exchange(0)) plugin->reset();
                if (!applyPendingParameters()) break;
                hostAutomated.fill(false);
                {
                    const juce::ScopedValueSetter<bool> hostWrite(applyingHostState, true);
                    bool accepted = true;
                    for (uint32_t i = 0; i < next->automation.count; ++i)
                    {
                        const auto& event = next->automation.points[i];
                        auto* parameter = plugin->getParameters()[static_cast<int>(event.index)];
                        if (!parameter->isAutomatable() || !parameter->queueValueAtSampleOffset(event.value, static_cast<int>(event.sample))) { accepted = false; break; }
                        hostAutomated[event.index] = true;
                    }
                    if (!accepted) { shared.fault.store(invalidPacket); break; }
                }
                midi.clear();
                for (uint32_t i = 0; i < next->midi.count; ++i)
                {
                    const auto& event = next->midi.events[i];
                    midi.addEvent(next->midi.data.data() + event.offset, static_cast<int>(event.size), static_cast<int>(event.sample));
                }
                playhead.value = next->hasPosition ? juce::makeOptional(next->position) : juce::nullopt;
                for (int ch = 0; ch < channelCount; ++ch) audio.copyFrom(ch, 0, next->audio[ch], quantum);
                try {
                    const auto& context = next->automationContext;
                    const ScopedPluginAutomationProcessing processing(context.position, context.sampleRate, context.epoch, context.rolling);
                    plugin->processBlock(audio, midi);
                }
                catch (...) { shared.fault.store(controlFailure); break; }
                bool finite = true;
                for (int ch = 0; ch < channelCount && finite; ++ch)
                    for (int s = 0; s < quantum; ++s)
                        if (!std::isfinite(audio.getSample(ch, s))) { finite = false; break; }
                if (!finite) { shared.fault.store(invalidAudio); break; }
                for (int ch = 0; ch < channelCount; ++ch) memcpy(next->audio[ch], audio.getReadPointer(ch), static_cast<size_t>(quantum) * sizeof(float));
                next->midi.clear();
                for (const auto event : midi)
                    if (event.samplePosition < 0 || event.samplePosition >= quantum
                        || !next->midi.add(event.data, event.numBytes, event.samplePosition)) { shared.fault.store(invalidPacket); break; }
                shared.latency.store(plugin->getLatencySamples());
                shared.currentProgram.store(plugin->getCurrentProgram());
                for (int index = 0; index < plugin->getParameters().size(); ++index)
                    if (hostAutomated[static_cast<size_t>(index)]) shared.params[index].actual.store(plugin->getParameters()[index]->getValue());
                shared.completedBlocks.fetch_add(1);
                next->state.store(3, std::memory_order_release);
            }
        }
        if (scheduling) AvRevertMmThreadCharacteristics(scheduling);
    }
};
#endif
}

int runIsolatedPluginWorker(const juce::String& mappingName)
{
#if JUCE_WINDOWS
    if (!mappingName.startsWith("Local\\OpenStudio-Isolated-") || mappingName.length() > 100) return 2;
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    const auto mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName.toWideCharPointer());
    const auto wake = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, (mappingName + "-wake").toWideCharPointer());
    if (!mapping || !wake) { if (mapping) CloseHandle(mapping); if (wake) CloseHandle(wake); return 3; }
    auto* shared = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
    if (!shared || shared->magicValue != magic || shared->protocolVersion != version) return 4;
    { Worker worker(*shared, wake); worker.run(); }
    UnmapViewOfFile(shared); CloseHandle(mapping); CloseHandle(wake);
    return 0;
#else
    juce::ignoreUnused(mappingName); return 2;
#endif
}
