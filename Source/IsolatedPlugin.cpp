#include "IsolatedPlugin.h"
#include "IsolatedPluginProtocol.h"
#include "OwnedChildProcess.h"
#include "JsonEnvelope.h"
#include "CrashDiagnostics.h"
#include <array>
#include <new>
#if JUCE_WINDOWS
#include <windows.h>
#endif

namespace
{
using namespace IsolatedPluginProtocol;
IsolatedPlugin::BusesProperties readBuses(const juce::var& metadata, bool& valid)
{
    IsolatedPlugin::BusesProperties result;
    for (const bool input : { true, false })
    {
        auto value = metadata.getProperty(input ? "inputs" : "outputs", {});
        const auto* buses = value.getArray();
        if (!buses || buses->size() > 16) { valid = false; return {}; }
        int total = 0;
        for (const auto& bus : *buses)
        {
            const auto types = bus.getProperty("channels", {});
            if (!types.isArray() || types.size() > channels) { valid = false; return {}; }
            juce::AudioChannelSet set;
            for (const auto& type : *types.getArray())
            {
                const int channel = static_cast<int>(type);
                if (!type.isInt() || channel <= 0 || channel > 4096 || set.getChannelTypes().contains(static_cast<juce::AudioChannelSet::ChannelType>(channel)))
                { valid = false; return {}; }
                set.addChannel(static_cast<juce::AudioChannelSet::ChannelType>(channel));
            }
            const bool enabled = static_cast<bool>(bus.getProperty("enabled", false));
            if (enabled) total += set.size();
            if (total > channels) { valid = false; return {}; }
            result = input ? result.withInput(bus.getProperty("name", "Input").toString(), set, enabled)
                           : result.withOutput(bus.getProperty("name", "Output").toString(), set, enabled);
        }
    }
    return result;
}
class RemoteParameter final : public juce::HostedAudioProcessorParameter
{
public:
    RemoteParameter(Shared& state, int index, juce::var data) : shared(state), slot(state.params[index]), metadata(std::move(data)) {}
    float getValue() const override
    {
        const auto value = slot.revision.load(std::memory_order_acquire) == slot.acknowledged.load(std::memory_order_acquire)
            ? slot.actual.load() : slot.desired.load();
        return std::isfinite(value) ? juce::jlimit(0.0f, 1.0f, value) : 0.0f;
    }
    void setValue(float value) override
    {
        if (!std::isfinite(value)) return;
        slot.desired.store(juce::jlimit(0.0f, 1.0f, value));
        slot.revision.fetch_add(1, std::memory_order_release);
        shared.parameterChanges.fetch_add(1, std::memory_order_release);
    }
    float getDefaultValue() const override { return juce::jlimit(0.0f, 1.0f, static_cast<float>(metadata.getProperty("default", 0))); }
    juce::String getName(int length) const override { return metadata.getProperty("name", "Parameter").toString().substring(0, length); }
    // Generic proxy controls expose normalized values, not the plugin's unit
    // conversion. The native worker editor retains the exact plugin display.
    juce::String getLabel() const override { return {}; }
    juce::String getParameterID() const override { return metadata.getProperty("id", "").toString(); }
    int getNumSteps() const override { return juce::jmax(2, static_cast<int>(metadata.getProperty("steps", getDefaultNumParameterSteps()))); }
    bool isDiscrete() const override { return static_cast<bool>(metadata.getProperty("discrete", false)); }
    bool isBoolean() const override { return static_cast<bool>(metadata.getProperty("boolean", false)); }
    bool isAutomatable() const override { return static_cast<bool>(metadata.getProperty("automatable", true)); }
    // A normalized fallback is explicit; the real native editor retains the
    // plugin's exact units/value parser rather than inventing a linear mapping.
    juce::String getText(float value, int length) const override { return (juce::String(value * 100.0f, 1) + "%").substring(0, length); }
    float getValueForText(const juce::String& text) const override { return juce::jlimit(0.0f, 1.0f, text.getFloatValue() / 100.0f); }
    void dispatchEditorChanges()
    {
        const auto flags = slot.editorEvents.exchange(0, std::memory_order_acq_rel);
        if ((flags & 1u) && !editorGesture) { beginChangeGesture(); editorGesture = true; }
        if (flags & 2u) sendValueChangedMessageToListeners(slot.editorValue.load());
        if ((flags & 4u) && editorGesture) { endChangeGesture(); editorGesture = false; }
    }
    void discardEditorChanges()
    {
        slot.editorEvents.store(0);
        if (editorGesture) { endChangeGesture(); editorGesture = false; }
    }
private:
    bool editorGesture = false;
    Shared& shared;
    Parameter& slot;
    juce::var metadata;
};
}

struct IsolatedPlugin::Impl
{
    juce::PluginDescription description;
    juce::var metadata;
    juce::File directory, stateFile;
    OwnedChildProcess child;
    Shared* shared = nullptr;
#if JUCE_WINDOWS
    HANDLE mapping = nullptr, wake = nullptr;
#endif
    juce::CriticalSection controlLock;
    std::atomic<bool> paused { true };
    std::atomic<int> readers { 0 };
    std::atomic<uint32_t> fault { healthy };
    juce::MemoryBlock acknowledgedState;
    juce::AudioBuffer<float> input, output;
    juce::MidiBuffer returnedMidi;
    MidiPacket inputMidi, outputMidi;
    juce::AudioPlayHead::PositionInfo inputPosition;
    bool hasInputPosition = false, prepared = false;
    uint32_t controlSequence = 0, generation = 0;
    uint64_t sequence = 0;
    int quantum = 512, channelCount = 2, cursor = 0, consecutiveMisses = 0;
    double rate = 44100;
    std::atomic<bool> offline { false };
    std::atomic<bool> resetPending { false };
    int warmup = 2;
    bool loggedFault = false;
    juce::String mappingName;

    ~Impl()
    {
        paused.store(true);
        if (child.isRunning())
        {
            if (shared) { shared->command.store(stop); shared->request.store(++controlSequence, std::memory_order_release); }
            const std::atomic<bool> wait { true };
            if (!child.waitForProcessToFinish(250, wait)) child.kill();
        }
#if JUCE_WINDOWS
        if (shared) UnmapViewOfFile(shared);
        if (mapping) CloseHandle(mapping);
        if (wake) CloseHandle(wake);
#endif
        // Only our one generated state artifact and its now-empty private folder.
        if (stateFile != juce::File()) stateFile.deleteFile();
        if (directory != juce::File()) directory.deleteFile();
    }
    bool transact(uint32_t command, uint32_t argument = 0, int timeoutMs = 10000)
    {
        const juce::ScopedLock lock(controlLock);
        if (!shared || fault.load() != healthy) return false;
        const bool editorOnly = command == showEditor || command == hideEditor;
        const bool wasPaused = editorOnly ? paused.load() : paused.exchange(true, std::memory_order_seq_cst);
        const auto started = juce::Time::getMillisecondCounterHiRes();
        while (!editorOnly && readers.load(std::memory_order_seq_cst) != 0)
        {
            if (juce::Time::getMillisecondCounterHiRes() - started > timeoutMs) { fault.store(deadline); return false; }
            juce::Thread::sleep(1);
        }
        shared->commandArgument = argument;
        shared->success.store(0);
        shared->command.store(command);
        shared->request.store(++controlSequence, std::memory_order_release);
        while (shared->response.load(std::memory_order_acquire) != controlSequence)
        {
            if (!child.isRunning()) { fault.store(childExited); return false; }
            if (juce::Time::getMillisecondCounterHiRes() - started > timeoutMs)
            { fault.store(deadline); child.kill(); return false; }
            juce::Thread::sleep(1);
        }
        if (shared->success.load() != 1 || shared->fault.load() != healthy)
        { fault.store(controlFailure); return false; }
        if (!editorOnly) paused.store(wasPaused, std::memory_order_seq_cst);
        return true;
    }
    bool quiesce()
    {
        paused.store(true, std::memory_order_seq_cst);
        const auto started = juce::Time::getMillisecondCounterHiRes();
        while (readers.load(std::memory_order_seq_cst))
        {
            if (juce::Time::getMillisecondCounterHiRes() - started > 2500) { fault.store(deadline); return false; }
            juce::Thread::sleep(1);
        }
        return true;
    }
    bool launch(double sampleRate, int block, juce::String& error)
    {
#if JUCE_WINDOWS
        rate = sampleRate; quantum = juce::jlimit(128, frames, block);
        if (!shared)
        {
            const auto name = "Local\\OpenStudio-Isolated-" + juce::Uuid().toString();
            mappingName = name;
            mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name.toWideCharPointer());
            wake = CreateEventW(nullptr, FALSE, FALSE, (name + "-wake").toWideCharPointer());
            if (!mapping || !wake) { error = "Cannot allocate isolated plugin transport"; return false; }
            auto* storage = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared));
            if (!storage) { error = "Cannot map isolated plugin transport"; return false; }
            shared = new (storage) Shared();
            directory = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("OpenStudio-Isolated")
                .getChildFile(juce::Uuid().toString().substring(0, 16));
            if (!directory.createDirectory()) { error = "Cannot create isolated plugin state folder"; return false; }
            stateFile = directory.getChildFile("state.bin");
        }
        if (!child.start({ juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName(),
                           "--isolated-plugin-worker", mappingName }, 0))
        { error = "Cannot launch isolated plugin worker"; return false; }
        shared->rate = rate; shared->quantum = static_cast<uint32_t>(quantum);
        auto request = std::make_unique<juce::DynamicObject>();
        request->setProperty("description", description.createXml()->toString());
        request->setProperty("stateFile", stateFile.getFullPathName());
        const auto text = juce::JSON::toString(juce::var(request.release()), true);
        if (text.getNumBytesAsUTF8() >= metadataBytes) { error = "Plugin description is too large"; return false; }
        memcpy(shared->text, text.toRawUTF8(), text.getNumBytesAsUTF8() + 1);
        shared->textBytes = static_cast<uint32_t>(text.getNumBytesAsUTF8());
        if (!transact(initialise, 0, 20000)) { error = "Isolated plugin failed to initialise (no in-process fallback)"; return false; }
        if (shared->textBytes >= metadataBytes) { error = "Invalid isolated metadata size"; return false; }
        const auto response = juce::String::fromUTF8(shared->text, static_cast<int>(shared->textBytes));
        if (!hasBoundedJsonEnvelope(response, metadataBytes)) { error = "Invalid isolated metadata envelope"; return false; }
        metadata = juce::JSON::parse(response);
        const auto params = metadata.getProperty("parameters", {}), programs = metadata.getProperty("programs", {});
        if (!metadata.isObject() || !params.isArray() || params.size() > parameters || !programs.isArray() || programs.size() > 4096)
        { error = "Unsupported isolated parameter/program layout"; return false; }
        return true;
#else
        juce::ignoreUnused(sampleRate, block); error = "Isolated hosting is currently supported on Windows only"; return false;
#endif
    }
    bool waitForSlot(Slot& slot)
    {
        if (!offline.load()) return slot.state.load(std::memory_order_acquire) == 3;
        // ONLY offline render/test threads can wait. Realtime never enters here.
        const auto started = juce::Time::getMillisecondCounterHiRes();
        while (slot.state.load(std::memory_order_acquire) != 3)
        {
            if (shared->fault.load() != healthy || !child.isRunning()) { fault.store(childExited); return false; }
            if (juce::Time::getMillisecondCounterHiRes() - started > 2000) { fault.store(deadline); return false; }
            juce::Thread::sleep(1);
        }
        return true;
    }
    void beginQuantum()
    {
        output.clear(); outputMidi.clear();
        if (warmup > 0) { --warmup; return; }
        const auto wanted = sequence - 2;
        auto& slot = shared->packets[wanted % slots];
        if (waitForSlot(slot) && slot.sequence == wanted && slot.generation == generation)
        {
            if (!slot.midi.valid(quantum)) { fault.store(invalidPacket); return; }
            for (int channel = 0; channel < channelCount; ++channel)
            {
                const auto* source = slot.audio[channel];
                for (int i = 0; i < quantum; ++i)
                    if (!std::isfinite(source[i])) { fault.store(invalidAudio); return; }
                output.copyFrom(channel, 0, source, quantum);
            }
            outputMidi = slot.midi;
            slot.state.store(0, std::memory_order_release);
            consecutiveMisses = 0;
        }
        else if (++consecutiveMisses >= 8) fault.store(deadline);
    }
    void submitQuantum()
    {
        auto& slot = shared->packets[sequence % slots];
        auto state = slot.state.load(std::memory_order_acquire);
        // A completed late packet may be discarded, never an in-flight packet.
        if (state == 3 && slot.sequence < sequence) { slot.state.store(0); state = 0; }
        if (state != 0) { if (++consecutiveMisses >= 8) fault.store(deadline); return; }
        slot.sequence = sequence; slot.generation = generation;
        slot.hasPosition = hasInputPosition; slot.position = inputPosition;
        slot.midi = inputMidi;
        for (int channel = 0; channel < channelCount; ++channel)
            memcpy(slot.audio[channel], input.getReadPointer(channel), static_cast<size_t>(quantum) * sizeof(float));
        slot.state.store(1, std::memory_order_release);
#if JUCE_WINDOWS
        SetEvent(wake); // Signal only; no wait, mutex, pipe or file access on RT.
#endif
    }
};

std::unique_ptr<IsolatedPlugin> IsolatedPlugin::create(const juce::PluginDescription& description, double rate, int block, juce::String& error)
{
    if (!std::isfinite(rate) || rate < 8000 || rate > 384000 || block <= 0 || block > frames)
    { error = "Unsupported isolated sample rate/block size"; return {}; }
    auto state = std::make_unique<Impl>();
    state->description = description;
    if (!state->launch(rate, block, error)) return {};
    bool valid = true;
    const auto buses = readBuses(state->metadata, valid);
    if (!valid) { error = "Unsupported isolated bus layout (maximum 32 active channels)"; return {}; }
    auto result = std::unique_ptr<IsolatedPlugin>(new IsolatedPlugin(std::move(state), buses));
    result->prepareToPlay(rate, block);
    if (!result->isHealthy()) { error = result->failureDescription(); return {}; }
    return result;
}
IsolatedPlugin::IsolatedPlugin(std::unique_ptr<Impl> state, const BusesProperties& buses)
    : AudioPluginInstance(buses), impl(std::move(state))
{
    impl->channelCount = juce::jmax(isMidiEffect() ? 2 : 1, getTotalNumInputChannels(), getTotalNumOutputChannels());
    const auto params = impl->metadata.getProperty("parameters", {});
    for (int i = 0; i < params.size(); ++i) addHostedParameter(std::make_unique<RemoteParameter>(*impl->shared, i, params[i]));
    impl->returnedMidi.ensureSize(32768);
    startTimer(100);
}
IsolatedPlugin::~IsolatedPlugin() { stopTimer(); }
const juce::String IsolatedPlugin::getName() const { return impl->description.name; }
void IsolatedPlugin::fillInPluginDescription(juce::PluginDescription& value) const { value = impl->description; value.hasARAExtension = false; }
bool IsolatedPlugin::acceptsMidi() const { return static_cast<bool>(impl->metadata.getProperty("acceptsMidi", false)); }
bool IsolatedPlugin::producesMidi() const { return static_cast<bool>(impl->metadata.getProperty("producesMidi", false)); }
bool IsolatedPlugin::isMidiEffect() const { return static_cast<bool>(impl->metadata.getProperty("midiEffect", false)); }
double IsolatedPlugin::getTailLengthSeconds() const
{ const auto value = static_cast<double>(impl->metadata.getProperty("tail", 0)); return std::isfinite(value) ? juce::jlimit(0.0, 3600.0, value) : 0; }
bool IsolatedPlugin::isBusesLayoutSupported(const BusesLayout& layout) const { return layout == getBusesLayout(); }
bool IsolatedPlugin::isHealthy() const noexcept { return impl->fault.load() == healthy && impl->shared->fault.load() == healthy; }
const std::atomic<uint32_t>* IsolatedPlugin::faultFlag() const noexcept { return &impl->fault; }
int IsolatedPlugin::transportLatencySamples() const noexcept { return 2 * impl->quantum; }
uint32_t IsolatedPlugin::processId() const { return static_cast<uint32_t>(impl->child.getProcessId()); }
juce::String IsolatedPlugin::failureDescription() const
{
    auto fault = impl->fault.load();
    if (fault == healthy) fault = impl->shared->fault.load();
    switch (fault)
    {
        case healthy: return "Worker running";
        case childExited: return "The isolated plugin process exited. Other plugins remain hosted separately.";
        case deadline: return "The isolated plugin missed its processing/control deadline and was quarantined.";
        case invalidAudio: return "The isolated plugin produced non-finite audio and was quarantined.";
        case invalidPacket: return "The isolated plugin exceeded its audio/MIDI transport contract.";
        default: return "The isolated plugin failed a control or compatibility operation.";
    }
}
void IsolatedPlugin::prepareToPlay(double sampleRate, int block)
{
    const juce::ScopedLock lock(impl->controlLock);
    if (!std::isfinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || block <= 0 || block > frames)
    { impl->fault.store(incompatible); return; }
    if (!impl->quiesce()) return;
    if (!isHealthy()) return;
    impl->rate = sampleRate; impl->quantum = juce::jlimit(128, frames, block);
    impl->shared->rate = sampleRate; impl->shared->quantum = static_cast<uint32_t>(impl->quantum);
    impl->shared->generation = ++impl->generation;
    impl->shared->nonRealtime = isNonRealtime() ? 1u : 0u;
    impl->offline.store(isNonRealtime());
    if (!impl->transact(prepare)) return;
    impl->input.setSize(impl->channelCount, impl->quantum); impl->input.clear();
    impl->output.setSize(impl->channelCount, impl->quantum); impl->output.clear();
    impl->inputMidi.clear(); impl->outputMidi.clear();
    impl->cursor = 0; impl->sequence = 0; impl->consecutiveMisses = 0;
    impl->warmup = 2; impl->resetPending.store(false);
    impl->prepared = true;
    setRateAndBufferSizeDetails(sampleRate, block);
    setLatencySamples(transportLatencySamples() + juce::jlimit(0, 3840000, impl->shared->latency.load()));
    impl->paused.store(false, std::memory_order_seq_cst);
}
void IsolatedPlugin::releaseResources()
{ const juce::ScopedLock lock(impl->controlLock); impl->paused.store(true); impl->transact(release); impl->prepared = false; }
void IsolatedPlugin::reset() { impl->resetPending.store(true, std::memory_order_release); }
void IsolatedPlugin::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    impl->readers.fetch_add(1, std::memory_order_seq_cst);
    struct Leave { std::atomic<int>& readers; ~Leave() { readers.fetch_sub(1, std::memory_order_seq_cst); } } leave { impl->readers };
    if (impl->paused.load(std::memory_order_seq_cst) || !isHealthy() || !impl->prepared)
    {
        if (impl->fault.load() == healthy && impl->shared->fault.load() != healthy) impl->fault.store(impl->shared->fault.load());
        buffer.clear(); midi.clear(); return;
    }
    if (impl->resetPending.exchange(false, std::memory_order_acq_rel))
    {
        ++impl->generation; impl->cursor = 0; impl->warmup = 2;
        impl->input.clear(); impl->output.clear(); impl->inputMidi.clear(); impl->outputMidi.clear();
    }
    impl->returnedMidi.clear();
    const auto count = buffer.getNumSamples();
    if (count > impl->quantum || buffer.getNumChannels() < impl->channelCount)
    { impl->fault.store(invalidPacket); buffer.clear(); midi.clear(); return; }
    // Caller storage is preallocated in the engine; a bounded output packet is
    // copied back without swapping away the caller's reserved MIDI capacity.
    int start = 0;
    while (start < count && isHealthy())
    {
        if (impl->cursor == 0)
        {
            impl->beginQuantum(); impl->inputMidi.clear();
            const auto position = getPlayHead() ? getPlayHead()->getPosition() : juce::nullopt;
            impl->hasInputPosition = position.hasValue();
            if (position) {
                impl->inputPosition = *position;
                if (const auto samples = position->getTimeInSamples()) impl->inputPosition.setTimeInSamples(*samples + start);
                if (const auto seconds = position->getTimeInSeconds()) impl->inputPosition.setTimeInSeconds(*seconds + start / impl->rate);
                if (const auto ppq = position->getPpqPosition())
                    if (const auto bpm = position->getBpm()) impl->inputPosition.setPpqPosition(*ppq + start / impl->rate * *bpm / 60.0);
            }
        }
        const auto amount = juce::jmin(count - start, impl->quantum - impl->cursor);
        for (const auto event : midi)
            if (event.samplePosition >= start && event.samplePosition < start + amount
                && !impl->inputMidi.add(event.data, event.numBytes, impl->cursor + event.samplePosition - start))
                impl->fault.store(invalidPacket);
        for (uint32_t i = 0; i < impl->outputMidi.count; ++i)
        {
            const auto& event = impl->outputMidi.events[i];
            if (event.sample >= static_cast<uint32_t>(impl->cursor) && event.sample < static_cast<uint32_t>(impl->cursor + amount))
                impl->returnedMidi.addEvent(impl->outputMidi.data.data() + event.offset, static_cast<int>(event.size),
                    start + static_cast<int>(event.sample) - impl->cursor);
        }
        for (int ch = 0; ch < impl->channelCount; ++ch)
        {
            if (ch < buffer.getNumChannels()) impl->input.copyFrom(ch, impl->cursor, buffer, ch, start, amount);
            else impl->input.clear(ch, impl->cursor, amount);
        }
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            if (ch < impl->channelCount) buffer.copyFrom(ch, start, impl->output, ch, impl->cursor, amount);
            else buffer.clear(ch, start, amount);
        }
        impl->cursor += amount; start += amount;
        if (impl->cursor == impl->quantum)
        { impl->submitQuantum(); ++impl->sequence; impl->cursor = 0; }
    }
    midi.clear();
    if (!isHealthy())
    {
        if (impl->fault.load() == healthy) impl->fault.store(impl->shared->fault.load());
        buffer.clear(); return;
    }
    midi.addEvents(impl->returnedMidi, 0, count, 0);
}
int IsolatedPlugin::getNumPrograms() { return impl->metadata.getProperty("programs", {}).size(); }
int IsolatedPlugin::getCurrentProgram() { return juce::jlimit(0, juce::jmax(0, getNumPrograms() - 1), impl->shared->currentProgram.load()); }
void IsolatedPlugin::setCurrentProgram(int index) { if (index >= 0 && index < getNumPrograms()) impl->transact(program, static_cast<uint32_t>(index)); }
const juce::String IsolatedPlugin::getProgramName(int index) { return impl->metadata.getProperty("programs", {})[index].toString(); }
void IsolatedPlugin::getStateInformation(juce::MemoryBlock& state)
{
    const juce::ScopedLock lock(impl->controlLock);
    if (impl->transact(getState) && impl->stateFile.getSize() <= maxStateBytes)
    {
        juce::MemoryBlock value;
        if (impl->stateFile.loadFileAsData(value)) impl->acknowledgedState = std::move(value);
    }
    state = impl->acknowledgedState; // Never replace a saved state with an empty failed RPC.
}
void IsolatedPlugin::setStateInformation(const void* data, int size)
{
    const juce::ScopedLock lock(impl->controlLock);
    if (size < 0 || size > maxStateBytes || (size && !data)) { impl->fault.store(invalidPacket); return; }
    juce::TemporaryFile temporary(impl->stateFile);
    if (!temporary.getFile().replaceWithData(data, static_cast<size_t>(size)) || !temporary.overwriteTargetFileWithTemporary())
    { impl->fault.store(controlFailure); return; }
    if (impl->transact(setState)) impl->acknowledgedState.replaceAll(data, static_cast<size_t>(size));
}
bool IsolatedPlugin::openRemoteEditor()
{
#if JUCE_WINDOWS
    AllowSetForegroundWindow(processId());
#endif
    return impl->transact(showEditor);
}
void IsolatedPlugin::closeRemoteEditor() { impl->transact(hideEditor, 0, 2000); }
bool IsolatedPlugin::remoteEditorIsOpen() const { return isHealthy() && impl->shared->editorVisible.load() != 0; }
bool IsolatedPlugin::remoteEditorHasFocus() const
{
#if JUCE_WINDOWS
    DWORD foreground = 0; GetWindowThreadProcessId(GetForegroundWindow(), &foreground);
    return remoteEditorIsOpen() && foreground == processId();
#else
    return false;
#endif
}
bool IsolatedPlugin::setTestFailure(int value) { return impl->transact(testFailure, static_cast<uint32_t>(value)); }
bool IsolatedPlugin::sendTestParameterGesture() { return impl->transact(testParameterGesture); }
bool IsolatedPlugin::takeUnhandledKey(juce::KeyPress& key, bool& repeat)
{
    auto& shared = *impl->shared;
    const auto read = shared.keyRead.load(), write = shared.keyWrite.load(std::memory_order_acquire);
    if (read == write) return false;
    if (write - read > 16) { shared.keyRead.store(write); return false; }
    const auto value = shared.keys[read % 16];
    shared.keyRead.store(read + 1, std::memory_order_release);
    if (!remoteEditorHasFocus() || value.code <= 0 || value.code > 0x40000 || value.character > 0x10ffff) return false;
#if JUCE_WINDOWS
    if (value.focusGeneration != shared.focusGeneration.load() || GetTickCount64() - value.ticks > 250) return false;
#endif
    key = juce::KeyPress(value.code, juce::ModifierKeys(value.modifiers & juce::ModifierKeys::allKeyboardModifiers), static_cast<juce::juce_wchar>(value.character));
    repeat = value.repeat;
    return true;
}
void IsolatedPlugin::timerCallback()
{
    if (impl->fault.load() == healthy && !impl->child.isRunning()) impl->fault.store(childExited);
    if (!isHealthy())
    {
        if (!impl->loggedFault)
        {
            impl->loggedFault = true;
            OpenStudioCrashDiagnostics::recordBreadcrumb("isolated_plugin_fault", getName() + ": " + failureDescription());
        }
        impl->child.kill();
        return;
    }
    const auto latency = impl->shared->latency.load();
    for (auto* parameter : getParameters())
        if (auto* remote = dynamic_cast<RemoteParameter*>(parameter)) remote->dispatchEditorChanges();
    if (latency < 0 || latency > 3840000) { impl->fault.store(invalidPacket); return; }
    const auto total = transportLatencySamples() + latency;
    if (getLatencySamples() != total) setLatencySamples(total);
}
bool IsolatedPlugin::restart()
{
    const juce::ScopedLock lock(impl->controlLock);
    if (!impl->quiesce()) return false;
    impl->child.kill();
    const std::atomic<bool> wait { true };
    if (!impl->child.waitForProcessToFinish(2000, wait)) return false;
    const auto oldMetadata = impl->metadata;
    const auto state = impl->acknowledgedState;
    impl->fault.store(healthy); impl->shared->fault.store(healthy);
    impl->shared->request.store(0); impl->shared->response.store(0); impl->shared->command.store(idle);
    impl->shared->editorVisible.store(0); impl->shared->editorFocused.store(0);
    impl->shared->keyRead.store(0); impl->shared->keyWrite.store(0);
    impl->shared->parameterChanges.store(0); impl->shared->resetRequested.store(0);
    for (auto* parameter : getParameters())
        if (auto* remote = dynamic_cast<RemoteParameter*>(parameter)) remote->discardEditorChanges();
    for (auto& slot : impl->shared->packets) slot.state.store(0);
    for (auto& parameter : impl->shared->params) { parameter.revision.store(0); parameter.acknowledged.store(0); }
    impl->controlSequence = 0; impl->loggedFault = false;
    juce::String error;
    if (!impl->launch(impl->rate, impl->quantum, error)) { impl->fault.store(controlFailure); return false; }
    // Existing automation parameters hold references to this mapping. Never
    // replace their identity/layout beneath live graph readers after an update.
    for (const auto* key : { "parameters", "inputs", "outputs" })
        if (juce::JSON::toString(oldMetadata.getProperty(key, {})) != juce::JSON::toString(impl->metadata.getProperty(key, {})))
        { impl->fault.store(incompatible); return false; }
    prepareToPlay(impl->rate, impl->quantum);
    if (state.getSize()) setStateInformation(state.getData(), static_cast<int>(state.getSize()));
    return isHealthy();
}

namespace
{
class IsolationStatusEditor final : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit IsolationStatusEditor(IsolatedPlugin& processor) : AudioProcessorEditor(processor), plugin(processor)
    {
        addAndMakeVisible(status); addAndMakeVisible(open); addAndMakeVisible(retry);
        status.setJustificationType(juce::Justification::centredLeft);
        open.setButtonText("Open isolated native editor");
        open.onClick = [this] { plugin.openRemoteEditor(); refresh(); };
        retry.setButtonText("Restart worker");
        retry.onClick = [this] { plugin.restart(); refresh(); };
        setSize(500, 190); refresh(); startTimer(250);
    }
    ~IsolationStatusEditor() override { stopTimer(); plugin.closeRemoteEditor(); }
    void paint(juce::Graphics& graphics) override { graphics.fillAll(juce::Colour(0xff1b1d22)); }
    void resized() override { auto area = getLocalBounds().reduced(16); auto row = area.removeFromBottom(32); retry.setBounds(row.removeFromRight(140)); row.removeFromRight(8); open.setBounds(row); status.setBounds(area.reduced(0, 4)); }
private:
    IsolatedPlugin& plugin;
    juce::Label status;
    juce::TextButton open, retry;
    void refresh()
    {
        status.setText(plugin.failureDescription() + "\nTransport latency: " + juce::String(plugin.transportLatencySamples())
            + " samples.\nRestart restores the last acknowledged state, not unacknowledged editor changes.", juce::dontSendNotification);
        open.setEnabled(plugin.isHealthy());
        retry.setEnabled(!plugin.isHealthy());
    }
    void timerCallback() override { refresh(); }
};
}
juce::AudioProcessorEditor* IsolatedPlugin::createEditor() { return new IsolationStatusEditor(*this); }
