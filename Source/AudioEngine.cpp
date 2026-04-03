#include "AudioEngine.h"
#include "S13FXProcessor.h"
#include "BuiltInEffects.h"
#include "BuiltInEffects2.h"
#include "S13PitchCorrector.h"
#include "PitchAnalyzer.h"
#include "PitchResynthesizer.h"

namespace
{
juce::File getOpenStudioDocumentsDirectory()
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    return documentsDir.getChildFile("OpenStudio");
}

juce::File getLegacyStudio13DocumentsDirectory()
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    return documentsDir.getChildFile("Studio13");
}

juce::File getOpenStudioApplicationDataDirectory()
{
    auto appDataDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
    return appDataDir.getChildFile("OpenStudio");
}

juce::File getLegacyStudio13ApplicationDataDirectory()
{
    auto appDataDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
    return appDataDir.getChildFile("Studio13");
}

juce::File getPreferredAppDataDirectory()
{
    auto openStudioDir = getOpenStudioDocumentsDirectory();
    auto legacyDir = getLegacyStudio13DocumentsDirectory();

    if (!openStudioDir.exists() && legacyDir.exists())
        return legacyDir;

    return openStudioDir;
}

juce::File getPreferredApplicationDataDirectory()
{
    auto openStudioDir = getOpenStudioApplicationDataDirectory();
    auto legacyDir = getLegacyStudio13ApplicationDataDirectory();

    if (!openStudioDir.exists() && legacyDir.exists())
        return legacyDir;

    return openStudioDir;
}
}

// Debug logging — always active for FX diagnostics
static void logToDisk(const juce::String& msg)
{
    auto f = getPreferredAppDataDirectory().getChildFile("debug_log.txt");
    f.getParentDirectory().createDirectory();
    f.appendText(juce::Time::getCurrentTime().toString(true, true) + ": " + msg + "\n");
}

#if JUCE_DEBUG
static constexpr bool kPitchEditorFormantDebugLogs = true;
#else
static constexpr bool kPitchEditorFormantDebugLogs = false;
#endif

static void logPitchEditorFormant(const juce::String& msg)
{
    if (kPitchEditorFormantDebugLogs)
        juce::Logger::writeToLog("[pitchEditor.formant] " + msg);
}

#if JUCE_DEBUG
static constexpr bool kAudioPathDebugLogs = true;
#else
static constexpr bool kAudioPathDebugLogs = false;
#endif

static void logAudioTransport(const juce::String& msg)
{
    if (kAudioPathDebugLogs)
        juce::Logger::writeToLog("[audio.transport] " + msg);
}

static void logAudioPlayback(const juce::String& msg)
{
    if (kAudioPathDebugLogs)
        juce::Logger::writeToLog("[audio.playback] " + msg);
}

static void logAudioRecord(const juce::String& msg)
{
    if (kAudioPathDebugLogs)
        juce::Logger::writeToLog("[audio.record] " + msg);
}

static void logAudioDevice(const juce::String& msg)
{
    if (kAudioPathDebugLogs)
        juce::Logger::writeToLog("[audio.device] " + msg);
}

static float peakFromFloatChannels(const float* const* channelData, int numChannels, int numSamples)
{
    float peak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        if (channelData[ch] == nullptr)
            continue;

        auto range = juce::FloatVectorOperations::findMinAndMax(channelData[ch], numSamples);
        peak = juce::jmax(peak, juce::jmax(std::abs(range.getStart()), std::abs(range.getEnd())));
    }
    return peak;
}

static float peakFromFloatBuffer(const juce::AudioBuffer<float>& buffer, int numSamples)
{
    float peak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        auto range = juce::FloatVectorOperations::findMinAndMax(buffer.getReadPointer(ch), numSamples);
        peak = juce::jmax(peak, juce::jmax(std::abs(range.getStart()), std::abs(range.getEnd())));
    }
    return peak;
}

static float peakFromDoubleBuffer(const juce::AudioBuffer<double>& buffer, int numChannels, int numSamples)
{
    float peak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        const auto* data = buffer.getReadPointer(ch);
        double localPeak = 0.0;
        for (int sample = 0; sample < numSamples; ++sample)
            localPeak = juce::jmax(localPeak, std::abs(data[sample]));
        peak = juce::jmax(peak, static_cast<float>(localPeak));
    }
    return peak;
}

static std::unique_ptr<juce::AudioProcessor> createBuiltInEffect(const juce::String& name);

static void prepareHostedProcessorForPrecision(juce::AudioProcessor* proc, double sampleRate,
                                               int blockSize, ProcessingPrecisionMode precisionMode)
{
    if (proc == nullptr)
        return;

    const juce::ScopedLock callbackLock(proc->getCallbackLock());

    if (proc->supportsDoublePrecisionProcessing())
    {
        proc->setProcessingPrecision(
            precisionMode == ProcessingPrecisionMode::Hybrid64
                ? juce::AudioProcessor::doublePrecision
                : juce::AudioProcessor::singlePrecision);
    }

    proc->prepareToPlay(sampleRate, blockSize);
}

static void prepareHostedProcessorPreservingLayout(juce::AudioProcessor* proc, double sampleRate,
                                                   int blockSize, ProcessingPrecisionMode precisionMode)
{
    if (proc == nullptr)
        return;

    const juce::ScopedLock callbackLock(proc->getCallbackLock());

    if (proc->supportsDoublePrecisionProcessing())
    {
        proc->setProcessingPrecision(
            precisionMode == ProcessingPrecisionMode::Hybrid64
                ? juce::AudioProcessor::doublePrecision
                : juce::AudioProcessor::singlePrecision);
    }

    auto savedLayout = proc->getBusesLayout();
    proc->prepareToPlay(sampleRate, blockSize);

    if (proc->getBusesLayout() != savedLayout)
    {
        proc->setBusesLayout(savedLayout);
        proc->prepareToPlay(sampleRate, blockSize);
    }
}

static void prepareHostedProcessorForPrecisionOverride(juce::AudioProcessor* proc, double sampleRate,
                                                       int blockSize, ProcessingPrecisionMode precisionMode,
                                                       bool forceFloat)
{
    prepareHostedProcessorForPrecision(proc, sampleRate, blockSize,
                                       forceFloat ? ProcessingPrecisionMode::Float32 : precisionMode);
}

static void copyFloatBufferToDoubleBuffer(const juce::AudioBuffer<float>& source,
                                          juce::AudioBuffer<double>& destination,
                                          int numChannels, int numSamples)
{
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* dest = destination.getWritePointer(ch);
        auto* src = source.getReadPointer(ch);
        for (int sample = 0; sample < numSamples; ++sample)
            dest[sample] = static_cast<double>(src[sample]);
    }
}

static void copyDoubleBufferToFloatBuffer(const juce::AudioBuffer<double>& source,
                                          juce::AudioBuffer<float>& destination,
                                          int numChannels, int numSamples)
{
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* dest = destination.getWritePointer(ch);
        auto* src = source.getReadPointer(ch);
        for (int sample = 0; sample < numSamples; ++sample)
            dest[sample] = static_cast<float>(src[sample]);
    }
}

static void copyDoubleBufferToOutput(const juce::AudioBuffer<double>& source,
                                     float* const* outputChannelData,
                                     int numChannels, int numSamples)
{
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* src = source.getReadPointer(ch);
        auto* dest = outputChannelData[ch];
        for (int sample = 0; sample < numSamples; ++sample)
            dest[sample] = static_cast<float>(src[sample]);
    }
}

static void computePanLawGains(PanLaw panLaw, float pan, float volumeGain,
                               float& leftGain, float& rightGain)
{
    const float clampedPan = juce::jlimit(-1.0f, 1.0f, pan);
    const float normalizedPan = (clampedPan + 1.0f) * 0.5f;
    const float panAngle = (clampedPan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;

    switch (panLaw)
    {
        case PanLaw::Minus4_5dB:
        {
            const float cpL = std::cos(panAngle);
            const float cpR = std::sin(panAngle);
            const float linL = 1.0f - normalizedPan;
            const float linR = normalizedPan;
            leftGain = (cpL + linL) * 0.5f * volumeGain;
            rightGain = (cpR + linR) * 0.5f * volumeGain;
            break;
        }
        case PanLaw::Minus6dB:
        {
            leftGain = (1.0f - normalizedPan) * volumeGain;
            rightGain = normalizedPan * volumeGain;
            break;
        }
        case PanLaw::Linear:
        {
            leftGain = juce::jmin(1.0f, 1.0f - clampedPan) * volumeGain;
            rightGain = juce::jmin(1.0f, 1.0f + clampedPan) * volumeGain;
            break;
        }
        case PanLaw::ConstantPower:
        default:
        {
            leftGain = std::cos(panAngle) * volumeGain;
            rightGain = std::sin(panAngle) * volumeGain;
            break;
        }
    }
}

static void applyGainToDoubleBuffer(juce::AudioBuffer<double>& buffer,
                                    int numChannels, int numSamples, double gain)
{
    if (gain == 1.0)
        return;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* data = buffer.getWritePointer(ch);
        for (int sample = 0; sample < numSamples; ++sample)
            data[sample] *= gain;
    }
}

static void applyStereoPanToDoubleBuffer(juce::AudioBuffer<double>& buffer, int numSamples,
                                         double leftGain, double rightGain)
{
    if (buffer.getNumChannels() < 2)
        return;

    auto* left = buffer.getWritePointer(0);
    auto* right = buffer.getWritePointer(1);
    for (int sample = 0; sample < numSamples; ++sample)
    {
        left[sample] *= leftGain;
        right[sample] *= rightGain;
    }
}

static void downmixDoubleBufferToMono(juce::AudioBuffer<double>& buffer, int numSamples)
{
    if (buffer.getNumChannels() < 2)
        return;

    auto* left = buffer.getWritePointer(0);
    auto* right = buffer.getWritePointer(1);
    for (int sample = 0; sample < numSamples; ++sample)
    {
        const double mono = (left[sample] + right[sample]) * 0.5;
        left[sample] = mono;
        right[sample] = mono;
    }
}

static float findPeakInDoubleBuffer(const juce::AudioBuffer<double>& buffer, int numChannels, int numSamples)
{
    double peak = 0.0;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* data = buffer.getReadPointer(ch);
        for (int sample = 0; sample < numSamples; ++sample)
            peak = juce::jmax(peak, std::abs(data[sample]));
    }

    return static_cast<float>(peak);
}

AudioEngine::AudioEngine()
{
    // Initialize graphs and managers BEFORE opening the audio device.
    // addAudioCallback() (below) triggers audioDeviceAboutToStart() synchronously
    // on an already-running device. audioDeviceAboutToStart() checks
    // `if (mainProcessorGraph)` before doing any setup, so the graph must exist
    // by the time addAudioCallback() is called — otherwise the null check
    // short-circuits and reusableTrackBuffer/metronome/IO nodes are never set up.
    mainProcessorGraph = std::make_unique<juce::AudioProcessorGraph>();

    // Initialize MIDI Manager (Phase 2)
    midiManager = std::make_unique<MIDIManager>();
    midiManager->setMessageCallback([this](const juce::String& deviceName, int channel, const juce::MidiMessage& message) {
        handleMIDIMessage(deviceName, channel, message);
    });

    // Initialize Control Surface Manager (Phase 3.10)
    controlSurfaceManager.setCallback(this);

    // Now open the audio device and register the callback. This is done last so
    // that all members above are valid when audioDeviceAboutToStart() fires.
    loadDeviceSettings();
    deviceManager.addAudioCallback (this);

    // Initialize Lua scripting engine (runs on message thread only)
    scriptEngine.registerAPI(*this);

    realtimeTrackSnapshot = std::make_shared<const RealtimeTrackSnapshot>();
    realtimeMasterFXSnapshot = std::make_shared<const ActiveFXStage>();
    realtimeMonitoringFXSnapshot = std::make_shared<const ActiveFXStage>();

    juce::Logger::writeToLog("AudioEngine: MIDI Manager initialized");
    juce::Logger::writeToLog("AudioEngine: Lua ScriptEngine initialized");
}

AudioEngine::~AudioEngine()
{
    deviceManager.removeAudioCallback (this);
}

juce::String AudioEngine::serialiseProcessorStateToBase64(juce::AudioProcessor* processor) const
{
    if (processor == nullptr)
        return {};

    juce::MemoryBlock stateData;
    {
        const juce::ScopedLock processorLock(processor->getCallbackLock());
        processor->getStateInformation(stateData);
    }
    return stateData.toBase64Encoding();
}

bool AudioEngine::applyBase64StateToProcessor(juce::AudioProcessor* processor, const juce::String& base64State) const
{
    if (processor == nullptr || base64State.isEmpty())
        return processor != nullptr;

    juce::MemoryBlock stateData;
    if (!stateData.fromBase64Encoding(base64State))
        return false;

    processor->setStateInformation(stateData.getData(), static_cast<int>(stateData.getSize()));
    return true;
}

AudioEngine::ActiveFXStageSlot* AudioEngine::findActiveStageSlot(std::shared_ptr<ActiveFXStage>& stage, int slotId)
{
    if (!stage)
        return nullptr;

    for (auto& slot : stage->slots)
        if (slot.slotId == slotId)
            return &slot;

    return nullptr;
}

const AudioEngine::ActiveFXStageSlot* AudioEngine::findActiveStageSlot(const std::shared_ptr<const ActiveFXStage>& stage, int slotId) const
{
    if (!stage)
        return nullptr;

    for (const auto& slot : stage->slots)
        if (slot.slotId == slotId)
            return &slot;

    return nullptr;
}

const AudioEngine::DesiredFXStageSlot* AudioEngine::findDesiredStageSlot(const DesiredFXStageSpec& spec, int index) const
{
    if (index < 0 || index >= static_cast<int>(spec.slots.size()))
        return nullptr;

    return &spec.slots[static_cast<size_t>(index)];
}

AudioEngine::DesiredFXStageSlot* AudioEngine::findDesiredStageSlot(DesiredFXStageSpec& spec, int index)
{
    if (index < 0 || index >= static_cast<int>(spec.slots.size()))
        return nullptr;

    return &spec.slots[static_cast<size_t>(index)];
}

void AudioEngine::syncStageSpecStateFromActive(DesiredFXStageSpec& spec, const std::shared_ptr<const ActiveFXStage>& activeStage)
{
    if (!activeStage)
        return;

    for (auto& slot : spec.slots)
    {
        if (const auto* activeSlot = findActiveStageSlot(activeStage, slot.slotId))
        {
            if (activeSlot->processor)
                slot.serializedState = serialiseProcessorStateToBase64(activeSlot->processor.get());
        }
    }
}

std::unique_ptr<juce::AudioProcessor> AudioEngine::createProcessorForStageSlot(const DesiredFXStageSlot& slot,
                                                                                double sampleRate,
                                                                                int preparedBlockSize,
                                                                                ProcessingPrecisionMode precisionMode,
                                                                                juce::String& errorMessage)
{
    std::unique_ptr<juce::AudioProcessor> processor;

    if (slot.type == "builtin")
    {
        processor = createBuiltInEffect(slot.name);
    }
    else if (slot.type == "s13fx")
    {
        auto s13fx = std::make_unique<S13FXProcessor>();
        if (!s13fx->loadScript(slot.pluginPath))
        {
            errorMessage = "Failed to load S13FX script: " + slot.pluginPath;
            return nullptr;
        }
        processor = std::move(s13fx);
    }
    else
    {
        processor = pluginManager.loadPluginFromFile(slot.pluginPath, sampleRate, preparedBlockSize);
    }

    if (!processor)
    {
        if (errorMessage.isEmpty())
            errorMessage = "Failed to create processor for slot: " + slot.name;
        return nullptr;
    }

    processor->setPlayHead(this);
    prepareHostedProcessorForPrecisionOverride(processor.get(), sampleRate, preparedBlockSize,
                                               precisionMode, slot.forceFloat);

    if (!slot.serializedState.isEmpty() && !applyBase64StateToProcessor(processor.get(), slot.serializedState))
    {
        errorMessage = "Failed to restore processor state for slot: " + slot.name;
        return nullptr;
    }

    processor->reset();
    return processor;
}

std::shared_ptr<AudioEngine::ActiveFXStage> AudioEngine::buildActiveFXStage(const DesiredFXStageSpec& spec,
                                                                            double sampleRate,
                                                                            int preparedBlockSize,
                                                                            ProcessingPrecisionMode precisionMode,
                                                                            bool monitoringStage,
                                                                            juce::String& errorMessage)
{
    juce::ignoreUnused(monitoringStage);
    auto stage = std::make_shared<ActiveFXStage>();
    stage->sampleRate = sampleRate;
    stage->preparedBlockSize = preparedBlockSize;
    stage->precisionMode = precisionMode;
    stage->slots.reserve(spec.slots.size());

    for (const auto& desiredSlot : spec.slots)
    {
        auto processor = createProcessorForStageSlot(desiredSlot, sampleRate, preparedBlockSize, precisionMode, errorMessage);
        if (!processor)
            return nullptr;

        ActiveFXStageSlot activeSlot;
        activeSlot.slotId = desiredSlot.slotId;
        activeSlot.name = desiredSlot.name;
        activeSlot.type = desiredSlot.type;
        activeSlot.pluginPath = desiredSlot.pluginPath;
        activeSlot.pluginFormat = desiredSlot.pluginFormat;
        activeSlot.bypassed = desiredSlot.bypassed;
        activeSlot.forceFloat = desiredSlot.forceFloat;
        activeSlot.supportsDouble = processor->supportsDoublePrecisionProcessing();
        activeSlot.processor = std::shared_ptr<juce::AudioProcessor>(std::move(processor));
        stage->slots.push_back(std::move(activeSlot));
    }

    return stage;
}

void AudioEngine::rebindStageEditors(const std::shared_ptr<const ActiveFXStage>& oldStage,
                                     const std::shared_ptr<const ActiveFXStage>& newStage,
                                     bool monitoringStage)
{
    if (!oldStage)
        return;

    struct EditorRebindRequest
    {
        juce::AudioProcessor* oldProcessor = nullptr;
        juce::AudioProcessor* newProcessor = nullptr;
        juce::String title;
        int slotId = 0;
    };

    std::vector<EditorRebindRequest> requests;
    for (const auto& oldSlot : oldStage->slots)
    {
        if (!oldSlot.processor || !pluginWindowManager.isEditorOpen(oldSlot.processor.get()))
            continue;

        EditorRebindRequest request;
        request.oldProcessor = oldSlot.processor.get();
        if (const auto* newSlot = findActiveStageSlot(newStage, oldSlot.slotId))
        {
            if (newSlot->processor)
            {
                request.newProcessor = newSlot->processor.get();
                request.title = newSlot->name;
                request.slotId = newSlot->slotId;
            }
        }
        requests.push_back(std::move(request));
    }

    if (requests.empty())
        return;

    // Capture oldStage by value to keep old processors alive until the async lambda runs.
    // Without this, raw AudioProcessor* pointers in 'requests' could dangle if the old
    // stage's shared_ptr drops before the lambda executes.
    juce::MessageManager::callAsync([this, requests = std::move(requests), monitoringStage,
                                     keepAlive = oldStage]() mutable
    {
        for (const auto& request : requests)
        {
            pluginWindowManager.closeEditor(request.oldProcessor);
            if (request.newProcessor != nullptr)
            {
                PluginWindowManager::PluginEditorTarget target;
                target.scope = monitoringStage
                    ? PluginWindowManager::PluginEditorTarget::Scope::MonitoringFX
                    : PluginWindowManager::PluginEditorTarget::Scope::MasterFX;
                const DesiredFXStageSpec& desiredSpec = monitoringStage ? desiredMonitoringStageSpec
                                                                        : desiredMasterStageSpec;
                for (int i = 0; i < static_cast<int>(desiredSpec.slots.size()); ++i)
                {
                    if (desiredSpec.slots[static_cast<size_t>(i)].slotId == request.slotId)
                    {
                        target.fxIndex = i;
                        break;
                    }
                }
                pluginWindowManager.openEditor(request.newProcessor, request.title, target);
            }
        }
    });
}

bool AudioEngine::publishMasterStageSpec(const DesiredFXStageSpec& spec)
{
    const double sr = currentSampleRate > 0.0 ? currentSampleRate : 44100.0;
    const int preparedBlockSize = currentBlockSize > 0 ? currentBlockSize : 512;
    const double buildStart = juce::Time::getMillisecondCounterHiRes();
    juce::String errorMessage;
    auto stage = buildActiveFXStage(spec, sr, preparedBlockSize, processingPrecisionMode, false, errorMessage);
    masterStageLastBuildMs.store(juce::Time::getMillisecondCounterHiRes() - buildStart, std::memory_order_release);

    if (!stage)
    {
        masterStageBuildFailureCount.fetch_add(1, std::memory_order_relaxed);
        juce::Logger::writeToLog("AudioEngine: Failed to publish master stage: " + errorMessage);
        return false;
    }

    stage->generation = masterStageGeneration.fetch_add(1, std::memory_order_relaxed) + 1;
    auto oldStage = std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire);

    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        desiredMasterStageSpec = spec;
        std::atomic_store_explicit(&realtimeMasterFXSnapshot,
                                   std::static_pointer_cast<const ActiveFXStage>(stage),
                                   std::memory_order_release);
    }

    rebindStageEditors(oldStage, std::static_pointer_cast<const ActiveFXStage>(stage), false);
    return true;
}

bool AudioEngine::publishMonitoringStageSpec(const DesiredFXStageSpec& spec)
{
    const double sr = currentSampleRate > 0.0 ? currentSampleRate : 44100.0;
    const int preparedBlockSize = currentBlockSize > 0 ? currentBlockSize : 512;
    const double buildStart = juce::Time::getMillisecondCounterHiRes();
    juce::String errorMessage;
    auto stage = buildActiveFXStage(spec, sr, preparedBlockSize, processingPrecisionMode, true, errorMessage);
    monitoringStageLastBuildMs.store(juce::Time::getMillisecondCounterHiRes() - buildStart, std::memory_order_release);

    if (!stage)
    {
        monitoringStageBuildFailureCount.fetch_add(1, std::memory_order_relaxed);
        juce::Logger::writeToLog("AudioEngine: Failed to publish monitoring stage: " + errorMessage);
        return false;
    }

    stage->generation = monitoringStageGeneration.fetch_add(1, std::memory_order_relaxed) + 1;
    auto oldStage = std::atomic_load_explicit(&realtimeMonitoringFXSnapshot, std::memory_order_acquire);

    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        desiredMonitoringStageSpec = spec;
        std::atomic_store_explicit(&realtimeMonitoringFXSnapshot,
                                   std::static_pointer_cast<const ActiveFXStage>(stage),
                                   std::memory_order_release);
    }

    rebindStageEditors(oldStage, std::static_pointer_cast<const ActiveFXStage>(stage), true);
    return true;
}

void AudioEngine::rebuildRealtimeProcessingSnapshots()
{
    RealtimeTrackSnapshot trackSnapshot;
    trackSnapshot.reserve(trackOrder.size());

    for (const auto& trackId : trackOrder)
    {
        auto nodeIt = trackNodeMap.find(trackId);
        if (nodeIt == trackNodeMap.end() || !nodeIt->second)
            continue;

        RealtimeTrackEntry entry;
        entry.id = trackId;
        entry.node = nodeIt->second;

        auto sidechainIt = sidechainOutputBuffers.find(trackId);
        if (sidechainIt != sidechainOutputBuffers.end())
            entry.sidechainOutputBuffer = sidechainIt->second;

        auto sendIt = sendAccumBuffers.find(trackId);
        if (sendIt != sendAccumBuffers.end())
            entry.sendAccumBuffer = sendIt->second;

        if (auto* track = dynamic_cast<TrackProcessor*>(entry.node->getProcessor()))
        {
            entry.sidechainSourceIds = track->getSidechainSourceSnapshot();
            entry.sends = track->getRealtimeSendSnapshot();
        }

        trackSnapshot.push_back(std::move(entry));
    }

    std::atomic_store_explicit(&realtimeTrackSnapshot,
                               std::make_shared<const RealtimeTrackSnapshot>(std::move(trackSnapshot)),
                               std::memory_order_release);
}

juce::File AudioEngine::getDeviceSettingsFile() const
{
    return getPreferredApplicationDataDirectory().getChildFile("audio_device_settings.xml");
}

void AudioEngine::saveDeviceSettings()
{
    auto xml = deviceManager.createStateXml();
    if (xml)
    {
        auto settingsFile = getDeviceSettingsFile();
        settingsFile.getParentDirectory().createDirectory();
        xml->writeTo(settingsFile);
        juce::Logger::writeToLog("AudioEngine: Device settings saved to " + settingsFile.getFullPathName());
    }
}

void AudioEngine::loadDeviceSettings()
{
    auto settingsFile = getDeviceSettingsFile();
    if (settingsFile.existsAsFile())
    {
        auto xml = juce::XmlDocument::parse(settingsFile);
        if (xml)
        {
            auto error = deviceManager.initialise(2, 2, xml.get(), true);
            if (error.isEmpty())
            {
                // Patch: expand active channels to all available.
                // Existing XML may have been saved with only 2 channels active.
                // JUCE caps the bitmask at the device's actual channel count.
                juce::AudioDeviceManager::AudioDeviceSetup patchSetup;
                deviceManager.getAudioDeviceSetup (patchSetup);
                patchSetup.useDefaultInputChannels = false;
                patchSetup.inputChannels.setRange (0, 32, true);
                patchSetup.useDefaultOutputChannels = false;
                patchSetup.outputChannels.setRange (0, 32, true);
                deviceManager.setAudioDeviceSetup (patchSetup, true);
                juce::Logger::writeToLog("AudioEngine: Restored device settings from " + settingsFile.getFullPathName());
                return;
            }
            juce::Logger::writeToLog("AudioEngine: Failed to restore settings: " + error + " - using defaults");
        }
    }

    // No saved settings or failed to load - use defaults
    deviceManager.initialiseWithDefaultDevices(2, 2);
    // Patch: activate all channels on the default device too
    {
        juce::AudioDeviceManager::AudioDeviceSetup patchSetup;
        deviceManager.getAudioDeviceSetup (patchSetup);
        patchSetup.useDefaultInputChannels = false;
        patchSetup.inputChannels.setRange (0, 32, true);
        patchSetup.useDefaultOutputChannels = false;
        patchSetup.outputChannels.setRange (0, 32, true);
        deviceManager.setAudioDeviceSetup (patchSetup, true);
    }
}

void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    logToDisk("AudioEngine: Device About To Start");
    if (device == nullptr)
    {
        juce::Logger::writeToLog("AudioEngine ERROR: audioDeviceAboutToStart called with nullptr device!");
        return;
    }
    currentSampleRate = device->getCurrentSampleRate();
    currentBlockSize = device->getCurrentBufferSizeSamples();
    inputLatencySamples = device->getInputLatencyInSamples();
    lastActiveOutputChannels.store(device->getActiveOutputChannels().countNumberOfSetBits(), std::memory_order_relaxed);
    logToDisk("Input latency: " + juce::String(inputLatencySamples) + " samples ("
              + juce::String(inputLatencySamples / currentSampleRate * 1000.0, 1) + " ms)");
    logAudioDevice("audioDeviceAboutToStart device=" + device->getName()
        + " sampleRate=" + juce::String(currentSampleRate, 2)
        + " blockSize=" + juce::String(currentBlockSize)
        + " activeInputs=" + juce::String(device->getActiveInputChannels().countNumberOfSetBits())
        + " activeOutputs=" + juce::String(device->getActiveOutputChannels().countNumberOfSetBits()));
    if (mainProcessorGraph)
    {
        // ... (keep existing config logic)
        mainProcessorGraph->setPlayConfigDetails (device->getActiveInputChannels().countNumberOfSetBits(),
                                                  device->getActiveOutputChannels().countNumberOfSetBits(),
                                                  device->getCurrentSampleRate(),
                                                  device->getCurrentBufferSizeSamples());
        mainProcessorGraph->prepareToPlay (device->getCurrentSampleRate(),
                                           device->getCurrentBufferSizeSamples());

        // Pre-allocate reusable buffers (avoids malloc on audio thread)
        reusableTrackBuffer.setSize (2, device->getCurrentBufferSizeSamples());
        reusableMasterBuffer.setSize (device->getActiveOutputChannels().countNumberOfSetBits(),
                                      device->getCurrentBufferSizeSamples());
        reusableMasterBufferDouble.setSize (device->getActiveOutputChannels().countNumberOfSetBits(),
                                            device->getCurrentBufferSizeSamples());
        masterFXFallbackBuffer.setSize(device->getActiveOutputChannels().countNumberOfSetBits(),
                                       device->getCurrentBufferSizeSamples());
        monitoringFXFallbackBuffer.setSize(device->getActiveOutputChannels().countNumberOfSetBits(),
                                           device->getCurrentBufferSizeSamples());

        // Pre-allocate sidechain output buffers for all existing tracks
        for (const auto& id : trackOrder)
        {
            auto& buffer = sidechainOutputBuffers[id];
            if (buffer == nullptr)
                buffer = std::make_shared<juce::AudioBuffer<float>>();
            buffer->setSize(2, device->getCurrentBufferSizeSamples());
        }

        // Pre-allocate send accumulation buffers for all existing tracks
        for (const auto& id : trackOrder)
        {
            auto& buffer = sendAccumBuffers[id];
            if (buffer == nullptr)
                buffer = std::make_shared<juce::AudioBuffer<float>>();
            buffer->setSize(2, device->getCurrentBufferSizeSamples());
        }

        // Metronome Init
        metronome.prepareToPlay(device->getCurrentSampleRate(), device->getCurrentBufferSizeSamples());
        metronome.setBpm(tempo);
        metronome.setTimeSignature(timeSigNumerator, timeSigDenominator);
                                           
        // Propagate this AudioEngine as the AudioPlayHead to all existing plugins
        // so they receive tempo/position during processBlock.
        for (const auto& id : trackOrder)
        {
            auto it = trackMap.find (id);
            if (it != trackMap.end())
                propagatePlayHead (it->second);
        }
        rebuildRealtimeProcessingSnapshots();
        publishMasterStageSpec(desiredMasterStageSpec);
        publishMonitoringStageSpec(desiredMonitoringStageSpec);

        // mainProcessorGraph->clear(); // COMMENTED OUT TO DEBUG - This wipes tracks!

        // Add IO Nodes only if missing
        if (!audioInputNode) {
            logToDisk("Adding IO Nodes...");
            audioInputNode = mainProcessorGraph->addNode (std::make_unique<juce::AudioProcessorGraph::AudioGraphIOProcessor> (juce::AudioProcessorGraph::AudioGraphIOProcessor::audioInputNode));
            audioOutputNode = mainProcessorGraph->addNode (std::make_unique<juce::AudioProcessorGraph::AudioGraphIOProcessor> (juce::AudioProcessorGraph::AudioGraphIOProcessor::audioOutputNode));
            
            // Connect any existing tracks that were added before device init
            if (audioOutputNode) {
                logToDisk("Connecting existing tracks to output...");
                int connectedCount = 0;
                
                for (auto* node : mainProcessorGraph->getNodes()) {
                    // Skip IO nodes
                    if (node == audioInputNode.get() || node == audioOutputNode.get())
                        continue;
                    
                    // Check if this is a TrackProcessor
                    if (dynamic_cast<TrackProcessor*>(node->getProcessor())) {
                        // Connect stereo channels
                        mainProcessorGraph->addConnection ({ { node->nodeID, 0 }, { audioOutputNode->nodeID, 0 } });
                        mainProcessorGraph->addConnection ({ { node->nodeID, 1 }, { audioOutputNode->nodeID, 1 } });
                        connectedCount++;
                    }
                }
                
                logToDisk("Connected " + juce::String(connectedCount) + " existing tracks.");
            }
        }
    }
}

void AudioEngine::audioDeviceStopped()
{
    logToDisk("AudioEngine: Device Stopped");
    lastAudioBlockWallTimeMs.store(0.0, std::memory_order_release);
    lastAudioBlockDurationMs.store(0.0, std::memory_order_release);
    if (mainProcessorGraph)
    {
        mainProcessorGraph->releaseResources();
        // Do NOT call clear() — that deletes all track nodes and orphans trackMap.
        // Only null IO node pointers so audioDeviceAboutToStart() re-creates them.
        audioInputNode = nullptr;
        audioOutputNode = nullptr;
    }
}

// ===========================================================================
// Audio callback helpers — extracted from audioDeviceIOCallbackWithContext
// ===========================================================================

void AudioEngine::updateMasterMetering (const float* const* outputChannelData,
                                        int numOutputChannels, int numSamples)
{
    float peakL = 0.0f;
    float peakR = 0.0f;
    if (numOutputChannels >= 1)
    {
        auto r = juce::FloatVectorOperations::findMinAndMax (outputChannelData[0], numSamples);
        peakL = juce::jmax (-r.getStart(), r.getEnd());
    }
    if (numOutputChannels >= 2)
    {
        auto r = juce::FloatVectorOperations::findMinAndMax (outputChannelData[1], numSamples);
        peakR = juce::jmax (-r.getStart(), r.getEnd());
    }

    const float masterPeak = juce::jmax (peakL, peakR);
    if (masterPeak > 1.0f)
        masterClipLatched.store (true, std::memory_order_relaxed);

    masterMeterPeakAccum = juce::jmax (masterMeterPeakAccum, masterPeak);
    masterMeterSampleCount += numSamples;
    if (masterMeterSampleCount >= MASTER_METER_UPDATE_SAMPLES)
    {
        masterOutputLevel.store (masterMeterPeakAccum, std::memory_order_relaxed);
        masterMeterPeakAccum = 0.0f;
        masterMeterSampleCount = 0;
    }
}

void AudioEngine::updatePhaseCorrelation (const float* const* outputChannelData,
                                          int numOutputChannels, int numSamples)
{
    if (numOutputChannels < 2)
        return;

    for (int i = 0; i < numSamples; ++i)
    {
        double l = static_cast<double> (outputChannelData[0][i]);
        double r = static_cast<double> (outputChannelData[1][i]);
        phaseCorr_sumLR += l * r;
        phaseCorr_sumLL += l * l;
        phaseCorr_sumRR += r * r;
    }
    phaseCorrSampleCount += numSamples;

    if (phaseCorrSampleCount >= PHASE_CORR_UPDATE_SAMPLES)
    {
        double denom = std::sqrt (phaseCorr_sumLL * phaseCorr_sumRR);
        float corr = (denom > 1e-20) ? static_cast<float> (phaseCorr_sumLR / denom) : 0.0f;
        corr = juce::jlimit (-1.0f, 1.0f, corr);
        phaseCorrelationValue.store (corr, std::memory_order_relaxed);

        phaseCorr_sumLR = 0.0;
        phaseCorr_sumLL = 0.0;
        phaseCorr_sumRR = 0.0;
        phaseCorrSampleCount = 0;
    }
}

void AudioEngine::updateSpectrumAnalyzer (const float* const* outputChannelData,
                                          int numOutputChannels, int numSamples)
{
    for (int i = 0; i < numSamples; ++i)
    {
        float monoSample = 0.0f;
        for (int ch = 0; ch < numOutputChannels; ++ch)
            monoSample += outputChannelData[ch][i];
        if (numOutputChannels > 1)
            monoSample /= static_cast<float> (numOutputChannels);

        spectrumInputBuffer[spectrumWritePos] = monoSample;
        spectrumWritePos++;

        if (spectrumWritePos >= FFT_SIZE)
        {
            spectrumWritePos = 0;

            float fftData[FFT_SIZE * 2] = {};
            std::memcpy (fftData, spectrumInputBuffer, sizeof (float) * static_cast<size_t> (FFT_SIZE));
            spectrumWindow.multiplyWithWindowingTable (fftData, static_cast<size_t> (FFT_SIZE));
            spectrumFFT.performFrequencyOnlyForwardTransform (fftData);

            {
                const juce::ScopedLock specLock (spectrumLock);
                std::memcpy (spectrumOutputBuffer, fftData, sizeof (float) * static_cast<size_t> (FFT_SIZE));
                spectrumReady = true;
            }
        }
    }
}

void AudioEngine::processMasterFXChain (const std::shared_ptr<const ActiveFXStage>& rtMasterFX,
                                        float* const* outputChannelData, int numOutputChannels,
                                        int numSamples, bool useHybrid64Summing)
{
    if (rtMasterFX == nullptr || rtMasterFX->slots.empty())
        return;

    const int masterChans = juce::jmin (numOutputChannels, reusableMasterBuffer.getNumChannels());
    juce::AudioBuffer<float> masterBuffer (reusableMasterBuffer.getArrayOfWritePointers(), masterChans, numSamples);
    juce::AudioBuffer<double> masterBufferDouble (
        reusableMasterBufferDouble.getArrayOfWritePointers(),
        juce::jmin (numOutputChannels, reusableMasterBufferDouble.getNumChannels()),
        numSamples);

    if (!useHybrid64Summing)
    {
        for (int ch = 0; ch < masterChans; ++ch)
            masterBuffer.copyFrom (ch, 0, outputChannelData[ch], numSamples);
    }

    juce::MidiBuffer dummyMidi;
    for (const auto& slot : rtMasterFX->slots)
    {
        if (slot.bypassed || !slot.processor)
            continue;

        auto* proc = slot.processor.get();
        const bool canProcessDouble = useHybrid64Summing
                                   && !slot.forceFloat
                                   && slot.supportsDouble
                                   && proc->getTotalNumInputChannels() <= masterBufferDouble.getNumChannels()
                                   && proc->getTotalNumOutputChannels() <= masterBufferDouble.getNumChannels();

        if (canProcessDouble)
        {
            proc->processBlock (masterBufferDouble, dummyMidi);
        }
        else
        {
            if (useHybrid64Summing)
            {
                for (int ch = 0; ch < masterChans; ++ch)
                {
                    auto* src = masterBufferDouble.getReadPointer (ch);
                    auto* dest = masterBuffer.getWritePointer (ch);
                    for (int sample = 0; sample < numSamples; ++sample)
                        dest[sample] = static_cast<float> (src[sample]);
                }
            }

            proc->processBlock (masterBuffer, dummyMidi);

            if (useHybrid64Summing)
            {
                for (int ch = 0; ch < masterChans; ++ch)
                {
                    auto* src = masterBuffer.getReadPointer (ch);
                    auto* dest = masterBufferDouble.getWritePointer (ch);
                    for (int sample = 0; sample < numSamples; ++sample)
                        dest[sample] = static_cast<double> (src[sample]);
                }
            }
        }
    }

    if (masterFXFallbackBuffer.getNumChannels() < masterChans || masterFXFallbackBuffer.getNumSamples() < numSamples)
        masterFXFallbackBuffer.setSize (masterChans, numSamples, false, false, true);

    if (!useHybrid64Summing)
    {
        for (int ch = 0; ch < masterChans; ++ch)
        {
            juce::FloatVectorOperations::copy (outputChannelData[ch], masterBuffer.getReadPointer (ch), numSamples);
            masterFXFallbackBuffer.copyFrom (ch, 0, masterBuffer, ch, 0, numSamples);
        }
    }
    else
    {
        for (int ch = 0; ch < masterChans; ++ch)
        {
            auto* src = masterBufferDouble.getReadPointer (ch);
            auto* dest = masterFXFallbackBuffer.getWritePointer (ch);
            for (int sample = 0; sample < numSamples; ++sample)
                dest[sample] = static_cast<float> (src[sample]);
        }
    }
}

void AudioEngine::processMonitoringFXChain (const std::shared_ptr<const ActiveFXStage>& rtMonitoringFX,
                                             float* const* outputChannelData, int numOutputChannels,
                                             int numSamples, bool hybrid64PostChainActive)
{
    if (rtMonitoringFX == nullptr || rtMonitoringFX->slots.empty() || isRendering.load())
        return;

    const int monChans = juce::jmin (numOutputChannels, reusableMasterBuffer.getNumChannels());
    juce::AudioBuffer<float> monBuffer (reusableMasterBuffer.getArrayOfWritePointers(), monChans, numSamples);
    juce::AudioBuffer<double> monBufferDouble (
        reusableMasterBufferDouble.getArrayOfWritePointers(),
        juce::jmin (numOutputChannels, reusableMasterBufferDouble.getNumChannels()),
        numSamples);

    if (!hybrid64PostChainActive)
    {
        for (int ch = 0; ch < monChans; ++ch)
            monBuffer.copyFrom (ch, 0, outputChannelData[ch], numSamples);
    }

    juce::MidiBuffer dummyMidi;
    for (const auto& slot : rtMonitoringFX->slots)
    {
        if (slot.bypassed || !slot.processor)
            continue;

        auto* proc = slot.processor.get();
        const bool canProcessDouble = hybrid64PostChainActive
                                   && !slot.forceFloat
                                   && slot.supportsDouble
                                   && proc->getTotalNumInputChannels() <= monBufferDouble.getNumChannels()
                                   && proc->getTotalNumOutputChannels() <= monBufferDouble.getNumChannels();

        if (canProcessDouble)
        {
            proc->processBlock (monBufferDouble, dummyMidi);
        }
        else
        {
            if (hybrid64PostChainActive)
                copyDoubleBufferToFloatBuffer (monBufferDouble, monBuffer, monChans, numSamples);

            proc->processBlock (monBuffer, dummyMidi);

            if (hybrid64PostChainActive)
                copyFloatBufferToDoubleBuffer (monBuffer, monBufferDouble, monChans, numSamples);
        }
    }

    if (monitoringFXFallbackBuffer.getNumChannels() < monChans || monitoringFXFallbackBuffer.getNumSamples() < numSamples)
        monitoringFXFallbackBuffer.setSize (monChans, numSamples, false, false, true);

    if (hybrid64PostChainActive)
    {
        copyDoubleBufferToFloatBuffer (monBufferDouble, monitoringFXFallbackBuffer, monChans, numSamples);
    }
    else
    {
        for (int ch = 0; ch < monChans; ++ch)
        {
            juce::FloatVectorOperations::copy (outputChannelData[ch], monBuffer.getReadPointer (ch), numSamples);
            monitoringFXFallbackBuffer.copyFrom (ch, 0, monBuffer, ch, 0, numSamples);
        }
    }
}

void AudioEngine::applyMasterGainPanMono (float* const* outputChannelData,
                                          int numOutputChannels, int numSamples,
                                          double samplePosition, bool hybrid64PostChainActive)
{
    // Master Pan (with automation)
    if (numOutputChannels >= 2)
    {
        float leftGain  = cachedMasterPanL.load (std::memory_order_relaxed);
        float rightGain = cachedMasterPanR.load (std::memory_order_relaxed);

        if (masterPanAutomation.shouldPlayback())
        {
            float autoPan = masterPanAutomation.eval (samplePosition);
            computePanLawGains (currentPanLaw, autoPan, 1.0f, leftGain, rightGain);
        }

        if (hybrid64PostChainActive)
            applyStereoPanToDoubleBuffer (reusableMasterBufferDouble, numSamples, leftGain, rightGain);
        else
        {
            juce::FloatVectorOperations::multiply (outputChannelData[0], leftGain, numSamples);
            juce::FloatVectorOperations::multiply (outputChannelData[1], rightGain, numSamples);
        }
    }

    // Master Volume (with automation)
    {
        float effectiveMasterVol = masterVolume;
        if (masterVolumeAutomation.shouldPlayback())
        {
            float autoDb = masterVolumeAutomation.eval (samplePosition);
            effectiveMasterVol = (autoDb <= -60.0f) ? 0.0f : std::pow (10.0f, autoDb / 20.0f);
        }
        if (hybrid64PostChainActive)
            applyGainToDoubleBuffer (reusableMasterBufferDouble, numOutputChannels, numSamples, effectiveMasterVol);
        else
        {
            for (int ch = 0; ch < numOutputChannels; ++ch)
                juce::FloatVectorOperations::multiply (outputChannelData[ch], effectiveMasterVol, numSamples);
        }
    }

    // Mono downmix
    if (masterMono.load (std::memory_order_relaxed) && numOutputChannels >= 2)
    {
        if (hybrid64PostChainActive)
            downmixDoubleBufferToMono (reusableMasterBufferDouble, numSamples);
        else
        {
            for (int i = 0; i < numSamples; ++i)
            {
                float mono = (outputChannelData[0][i] + outputChannelData[1][i]) * 0.5f;
                outputChannelData[0][i] = mono;
                outputChannelData[1][i] = mono;
            }
        }
    }

    // Copy 64-bit buffer back to hardware output
    if (hybrid64PostChainActive)
        copyDoubleBufferToOutput (reusableMasterBufferDouble, outputChannelData, numOutputChannels, numSamples);
}

void AudioEngine::buildSidechainProcessingOrder (const std::vector<RealtimeTrackEntry>& rtTracks,
                                                  int processedOrder[], int& orderCount, int maxTracks)
{
    bool trackProcessed[64];
    int numTracks = juce::jmin (static_cast<int> (rtTracks.size()), maxTracks);
    orderCount = 0;

    for (int t = 0; t < numTracks; ++t)
        trackProcessed[t] = false;

    // Fast path: skip sorting if no track has sidechain routing
    bool anySidechainRouting = false;
    for (int t = 0; t < numTracks && !anySidechainRouting; ++t)
    {
        if (!rtTracks[static_cast<size_t> (t)].sidechainSourceIds.empty())
            anySidechainRouting = true;
    }

    if (anySidechainRouting)
    {
        int maxPasses = numTracks + 1;
        for (int pass = 0; pass < maxPasses && orderCount < numTracks; ++pass)
        {
            for (int t = 0; t < numTracks; ++t)
            {
                if (trackProcessed[t]) continue;

                const auto& entry = rtTracks[static_cast<size_t> (t)];
                auto* trk = dynamic_cast<TrackProcessor*> (entry.node != nullptr ? entry.node->getProcessor() : nullptr);
                if (trk == nullptr)
                {
                    trackProcessed[t] = true;
                    processedOrder[orderCount++] = t;
                    continue;
                }

                bool depsReady = true;
                for (const auto& srcId : entry.sidechainSourceIds)
                {
                    if (srcId.isEmpty())
                        continue;

                    for (int s = 0; s < numTracks; ++s)
                    {
                        if (rtTracks[static_cast<size_t> (s)].id == srcId)
                        {
                            if (!trackProcessed[s])
                                depsReady = false;
                            break;
                        }
                    }
                }

                if (depsReady)
                {
                    trackProcessed[t] = true;
                    processedOrder[orderCount++] = t;
                }
            }
        }

        // Remaining tracks (circular deps) — add at end
        for (int t = 0; t < numTracks; ++t)
        {
            if (!trackProcessed[t])
                processedOrder[orderCount++] = t;
        }
    }
    else
    {
        for (int t = 0; t < numTracks; ++t)
            processedOrder[t] = t;
        orderCount = numTracks;
    }
}

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                                    int numInputChannels,
                                                    float* const* outputChannelData,
                                                    int numOutputChannels,
                                                    int numSamples,
                                                    const juce::AudioIODeviceCallbackContext& context)
{
    juce::ignoreUnused(context);
    const uint64 callbackCounter = audioCallbackCounter.fetch_add(1, std::memory_order_acq_rel) + 1;
    lastAudioCallbackCounter.store(callbackCounter, std::memory_order_relaxed);
    const bool firstCallbackAfterTransportStart = firstCallbackAfterTransportStartPending.exchange(false, std::memory_order_acq_rel);
    const double callbackStartWallTimeMs = juce::Time::getMillisecondCounterHiRes();
    lastAudioBlockWallTimeMs.store(callbackStartWallTimeMs, std::memory_order_release);
    lastCallbackInputChannels.store(numInputChannels, std::memory_order_relaxed);
    lastCallbackOutputChannels.store(numOutputChannels, std::memory_order_relaxed);
    lastActiveOutputChannels.store(numOutputChannels, std::memory_order_relaxed);
    if (currentSampleRate > 0.0)
        lastAudioBlockDurationMs.store((static_cast<double>(numSamples) / currentSampleRate) * 1000.0,
                                       std::memory_order_release);

    // Clear outputs first
    for (int i = 0; i < numOutputChannels; ++i)
        juce::FloatVectorOperations::clear (outputChannelData[i], numSamples);

    // During offline rendering, skip ALL processing to avoid sharing FX plugin
    // instances between the audio callback and the render thread
    if (isRendering.load())
        return;

    auto rtTracks = std::atomic_load_explicit(&realtimeTrackSnapshot, std::memory_order_acquire);
    auto rtMasterFX = std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire);
    auto rtMonitoringFX = std::atomic_load_explicit(&realtimeMonitoringFXSnapshot, std::memory_order_acquire);
    const bool shouldLogCallbackSummary = kAudioPathDebugLogs
        && (((callbackCounter % 50) == 1) || ((isPlaying || isRecordMode) && firstCallbackAfterTransportStart));
    float postTrackPlaybackPeak = 0.0f;
    float postMonitoringInputPeak = 0.0f;
    const float preTrackPeak = peakFromFloatChannels(outputChannelData, numOutputChannels, numSamples);
    if (shouldLogCallbackSummary)
    {
        logAudioPlayback("callback start #" + juce::String(static_cast<juce::int64>(callbackCounter))
            + " isPlaying=" + juce::String(isPlaying.load() ? "true" : "false")
            + " isRecordMode=" + juce::String(isRecordMode.load() ? "true" : "false")
            + " inputChannels=" + juce::String(numInputChannels)
            + " outputChannels=" + juce::String(numOutputChannels)
            + " sampleRate=" + juce::String(currentSampleRate, 2)
            + " blockSize=" + juce::String(numSamples)
            + " masterVolume=" + juce::String(masterVolume, 3)
            + " masterPan=" + juce::String(masterPan, 3)
            + " masterMono=" + juce::String(masterMono.load(std::memory_order_relaxed) ? "true" : "false")
            + " preTrackPeak=" + juce::String(preTrackPeak, 4));
    }

    // NOTE: currentSamplePosition is advanced AFTER all processing (metronome,
    // playback, recording) so that everything in this callback uses the correct
    // position for the samples being output right now.  The increment is at the
    // very end of the callback (search "Advance transport position").

    // Update metronome BPM from tempo map at current position
    {
        double currentBpm = getTempoAtTime(currentSamplePosition / currentSampleRate);
        metronome.setBpm(currentBpm);
    }

    // Mix Metronome (if enabled and transport is running)
    if (isPlaying || isRecordMode)
    {
        juce::AudioBuffer<float> outputBuffer(const_cast<float**>(outputChannelData), numOutputChannels, numSamples);
        metronome.getNextAudioBlock(outputBuffer, currentSamplePosition);
    }

    const bool useHybrid64Summing = processingPrecisionMode == ProcessingPrecisionMode::Hybrid64
                                 && reusableMasterBufferDouble.getNumChannels() >= numOutputChannels
                                 && reusableMasterBufferDouble.getNumSamples() >= numSamples;
    bool hybrid64PostChainActive = useHybrid64Summing;
    if (useHybrid64Summing)
    {
        for (int ch = 0; ch < numOutputChannels; ++ch)
        {
            auto* dest = reusableMasterBufferDouble.getWritePointer(ch);
            for (int sample = 0; sample < numSamples; ++sample)
                dest[sample] = static_cast<double>(outputChannelData[ch][sample]);

            juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
        }
    }

    if (pendingRecordStartCapture.exchange(false, std::memory_order_acq_rel))
    {
        double latencyComp = inputLatencySamples / currentSampleRate;
        double startPos = (currentSamplePosition / currentSampleRate) - latencyComp;
        if (startPos < 0.0) startPos = 0.0;

        for (const auto& entry : *rtTracks)
        {
            auto* recTrack = dynamic_cast<TrackProcessor*>(entry.node != nullptr ? entry.node->getProcessor() : nullptr);
            if (recTrack == nullptr)
                continue;

            const auto& recId = entry.id;
            if (audioRecorder.isRecording(recId))
                audioRecorder.setRecordingStartTime(recId, startPos);
            if (midiRecorder.isRecording(recId))
                midiRecorder.setRecordingStartTime(recId, startPos);
        }
    }

    // Use cached solo state (updated when solo changes, avoids scanning every callback)
    bool anySoloed = cachedAnySoloed.load();

    // ========== Determine sidechain-aware processing order ==========
    constexpr int MAX_TRACKS = 64;
    int processedOrder[MAX_TRACKS];
    int orderCount = 0;
    buildSidechainProcessingOrder (*rtTracks, processedOrder, orderCount, MAX_TRACKS);

    // Process each track in sidechain-aware order
    bool anyActiveARAInCallback = false;
    for (int orderIdx = 0; orderIdx < orderCount; ++orderIdx)
    {
        int trackIdx = processedOrder[orderIdx];
        const auto& trackEntry = (*rtTracks)[static_cast<size_t>(trackIdx)];
        const auto& trackId = trackEntry.id;
        auto* track = dynamic_cast<TrackProcessor*>(trackEntry.node != nullptr ? trackEntry.node->getProcessor() : nullptr);
        if (!track)
            continue;

        track->setCurrentAudioCallbackDebugInfo({ callbackCounter, firstCallbackAfterTransportStart, callbackStartWallTimeMs });
        if (track->hasActiveARA())
            anyActiveARAInCallback = true;

        // Solo logic: if any track is soloed, skip non-soloed tracks entirely
        // (recording still works because record-armed tracks should also be soloed,
        //  and in practice users don't solo-off a track they're actively recording)
        if (anySoloed && !track->getSolo())
        {
            track->resetRMS();
            continue;
        }

        const bool isMidiTrack = track->getTrackType() == TrackType::MIDI
                              || track->getTrackType() == TrackType::Instrument;
        const bool shouldReadHardwareInput = !isMidiTrack
                                          && !track->getMute()
                                          && (track->getRecordArmed()
                                              || track->getInputMonitoring()
                                              || audioRecorder.isRecording(trackId));
        const double blockStartTimeSeconds = currentSamplePosition / currentSampleRate;
        const bool shouldProcessMidi = track->needsProcessing(blockStartTimeSeconds, numSamples,
                                                              currentSampleRate, isPlaying.load());

        // Get track's input configuration
        int startChan = track->getInputStartChannel();
        int numChans = track->getInputChannelCount();

        if (shouldReadHardwareInput)
        {
            // Safety check
            if (startChan < 0 || startChan >= numInputChannels)
                continue;
        }

        // Skip this track if it's not playing clips and not eligible for live input.
        // Armed audio tracks should still be processed while stopped so hardware
        // monitoring works before recording starts.
        if (!isPlaying && !shouldReadHardwareInput && !shouldProcessMidi)
        {
            track->resetRMS();  // Clear meter so it drops to zero when idle
            continue;
        }

        // Non-owning view of the pre-allocated buffer — avoids heap alloc on audio thread.
        // ALWAYS 2 channels (stereo) for proper pan support.
        //
        // IMPORTANT: getWritePointer() is used (not getArrayOfWritePointers()) because
        // it sets isClear=false on reusableTrackBuffer as a side effect. Without this,
        // JUCE 8's isClear optimisation makes clear() a no-op when a previous iteration
        // left isClear=true, and makes applyGain/getRMSLevel skip processing (they also
        // guard on isClear), causing stale signal to accumulate across track iterations.
        //
        // Emergency guard: if the pre-allocated buffer is somehow undersized (shouldn't
        // happen on ASIO but guards against unusual driver behaviour), resize it here.
        // This heap-allocates only in that exceptional case.
        if (reusableTrackBuffer.getNumSamples() < numSamples || reusableTrackBuffer.getNumChannels() < 2)
            reusableTrackBuffer.setSize (2, numSamples, false, true);

        float* trackChans[2] = { reusableTrackBuffer.getWritePointer (0),
                                  reusableTrackBuffer.getWritePointer (1) };
        juce::AudioBuffer<float> trackBuffer (trackChans, 2, numSamples);
        trackBuffer.clear();

        // ========== MIX IN ACCUMULATED SENDS from other tracks ==========
        if (trackEntry.sendAccumBuffer != nullptr && trackEntry.sendAccumBuffer->getNumSamples() >= numSamples)
        {
            auto& accumBuf = *trackEntry.sendAccumBuffer;
            for (int ch = 0; ch < juce::jmin(2, accumBuf.getNumChannels()); ++ch)
                juce::FloatVectorOperations::add(
                    trackBuffer.getWritePointer(ch),
                    accumBuf.getReadPointer(ch),
                    numSamples);
            accumBuf.clear();
        }

        // PLAYBACK MODE: Read from clips if transport is playing.
        // Skip for tracks with an active ARA plugin — the ARA playback renderer
        // reads audio directly from its audio source via readAudioSamples().
        // PlaybackEngine output would be overwritten by the plugin anyway, and
        // the redundant disk I/O causes severe contention (~300ms per block).
        if (isPlaying && !track->hasActiveARA())
        {
            // Apply per-track playback offset (ms → seconds)
            double trackOffsetSec = track->getPlaybackOffset() / 1000.0;
            double adjustedTime = (currentSamplePosition / currentSampleRate) - trackOffsetSec;

            // Fill buffer with playback audio from clips
            playbackEngine.fillTrackBuffer(
                trackId,
                trackBuffer,
                adjustedTime,
                numSamples,
                currentSampleRate
            );
            postTrackPlaybackPeak = juce::jmax(postTrackPlaybackPeak, peakFromFloatBuffer(trackBuffer, numSamples));
        }

        // MONITORING/RECORDING MODE: Mix in input audio if monitoring
        if (shouldReadHardwareInput)
        {
            // Copy hardware inputs to track buffer (mix with playback if both active).
            // Preserve mono input as mono here and let the plugin chain widen it if needed.
            for (int ch = 0; ch < numChans && (startChan + ch) < numInputChannels; ++ch)
            {
                if (isPlaying)
                {
                    // Mix input with playback (overdub mode)
                    juce::FloatVectorOperations::add(
                        trackBuffer.getWritePointer(ch),
                        inputChannelData[startChan + ch],
                        numSamples
                    );
                }
                else
                {
                    // Just copy input (monitoring only)
                    trackBuffer.copyFrom(ch, 0, inputChannelData[startChan + ch], numSamples);
                }
            }

            postMonitoringInputPeak = juce::jmax(postMonitoringInputPeak, peakFromFloatBuffer(trackBuffer, numSamples));
        }

        // ========== RECORD RAW AUDIO (BEFORE FX) ==========
        // Write to recorder if transport is playing AND in record mode
        // This captures the raw input BEFORE any FX processing
        if (isPlaying && isRecordMode && audioRecorder.isRecording(trackId))
        {
            // Punch recording: only write audio within punch range
            bool shouldWrite = true;
            if (punchEnabled.load(std::memory_order_acquire))
            {
                double posSeconds = currentSamplePosition / currentSampleRate;
                double punchStart = punchStartTime.load(std::memory_order_relaxed);
                double punchEnd = punchEndTime.load(std::memory_order_relaxed);
                shouldWrite = (posSeconds >= punchStart && posSeconds < punchEnd);
            }

            if (shouldWrite)
                audioRecorder.writeBlock(trackId, trackBuffer, numSamples);
        }

        // Tell the track where we are on the timeline so automation can evaluate
        track->setCurrentBlockPosition(currentSamplePosition, currentSampleRate);

        // ========== SIDECHAIN: provide source track's output to this track ==========
        // If this track has any sidechain-routed FX plugins, find the first sidechain
        // source track and point the track's sidechainInputBuffer to its stored output.
        if (!trackEntry.sidechainSourceIds.empty())
        {
            // Find the first sidechain source track ID (all SC FX on this track
            // share the same sidechain input buffer for simplicity — the source is
            // determined by the first configured sidechain FX)
            const juce::AudioBuffer<float>* scBuffer = nullptr;
            for (const auto& srcId : trackEntry.sidechainSourceIds)
            {
                if (srcId.isNotEmpty())
                {
                    for (const auto& candidate : *rtTracks)
                    {
                        if (candidate.id == srcId && candidate.sidechainOutputBuffer != nullptr)
                        {
                            scBuffer = candidate.sidechainOutputBuffer.get();
                            break;
                        }
                    }
                    if (scBuffer != nullptr)
                        break;
                }
            }
            track->setSidechainBuffer(scBuffer);
        }
        else
        {
            track->setSidechainBuffer(nullptr);
        }

        // Process through track (applies volume, pan, FX, automation)
        juce::MidiBuffer midiMessages = buildTrackMidiBlock(trackId, blockStartTimeSeconds,
                                                            numSamples, currentSampleRate,
                                                            isPlaying.load());
        int prevMidiMax = midiMaxEventsPerBlock.load(std::memory_order_relaxed);
        while (midiMessages.getNumEvents() > prevMidiMax
               && !midiMaxEventsPerBlock.compare_exchange_weak(prevMidiMax, midiMessages.getNumEvents(),
                                                               std::memory_order_relaxed))
        {
        }
        if (!track->tryProcessBlock(trackBuffer, midiMessages))
        {
            track->resetRMS();
            continue;
        }
        const float trackBufferPeak = peakFromFloatBuffer(trackBuffer, numSamples);
        if (shouldLogCallbackSummary && isPlaying.load())
        {
            logAudioPlayback("track stage track=" + trackId
                + " muted=" + juce::String(track->getMute() ? "true" : "false")
                + " solo=" + juce::String(track->getSolo() ? "true" : "false")
                + " masterSend=" + juce::String(track->getMasterSendEnabled() ? "true" : "false")
                + " shouldReadHardwareInput=" + juce::String(shouldReadHardwareInput ? "true" : "false")
                + " clipPlaybackRequested=" + juce::String((isPlaying && !track->hasActiveARA()) ? "true" : "false")
                + " trackBufferPeak=" + juce::String(trackBufferPeak, 4));
        }

        // ========== SIDECHAIN: store this track's output for downstream tracks ==========
        // Copy the processed output into the pre-allocated sidechain buffer so that
        // tracks processed later can use it as sidechain input.
        if (trackEntry.sidechainOutputBuffer != nullptr)
        {
            auto& scOut = *trackEntry.sidechainOutputBuffer;
            if (scOut.getNumSamples() < numSamples)
                scOut.setSize(2, numSamples, false, false, true);

            for (int ch = 0; ch < juce::jmin(2, trackBuffer.getNumChannels()); ++ch)
                scOut.copyFrom(ch, 0, trackBuffer, ch, 0, numSamples);
        }

        // ========== SEND MIXING: fill destination track send accum buffers ==========
        if (!trackEntry.sends.empty())
        {
            const auto& preFaderBuffer = track->getPreFaderBuffer();
            for (const auto& send : trackEntry.sends)
            {
                if (!send.enabled || send.level <= 0.0f || send.destTrackId.isEmpty())
                    continue;

                for (const auto& destEntry : *rtTracks)
                {
                    if (destEntry.id != send.destTrackId || destEntry.sendAccumBuffer == nullptr)
                        continue;

                    auto& destBuf = *destEntry.sendAccumBuffer;
                    if (destBuf.getNumSamples() >= numSamples)
                    {
                        const auto& srcBuf = send.preFader ? preFaderBuffer : trackBuffer;
                        const int srcChannels = srcBuf.getNumChannels();
                        const int destChannels = destBuf.getNumChannels();
                        const float level = send.level;
                        const float phaseMultiplier = send.phaseInvert ? -1.0f : 1.0f;
                        const float panAngle = (send.pan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;
                        const float leftGain = std::cos(panAngle) * level * phaseMultiplier;
                        const float rightGain = std::sin(panAngle) * level * phaseMultiplier;

                        if (destChannels >= 2 && srcChannels >= 2)
                        {
                            for (int sample = 0; sample < numSamples; ++sample)
                            {
                                destBuf.getWritePointer(0)[sample] += srcBuf.getReadPointer(0)[sample] * leftGain;
                                destBuf.getWritePointer(1)[sample] += srcBuf.getReadPointer(1)[sample] * rightGain;
                            }
                        }
                        else if (destChannels >= 1 && srcChannels >= 1)
                        {
                            for (int sample = 0; sample < numSamples; ++sample)
                                destBuf.getWritePointer(0)[sample] += srcBuf.getReadPointer(0)[sample] * level;
                        }
                    }

                    break;
                }
            }
        }

        // ========== MIDI OUTPUT: route MIDI to hardware output ==========
        if (!midiMessages.isEmpty() && track->getMIDIOutputDeviceName().isNotEmpty())
            track->sendMIDIToOutput(midiMessages);

        // Mix track output to device outputs (only if master send is enabled)
        if (track->getMasterSendEnabled())
        {
            int outStart = track->getOutputStartChannel();
            int outCount = track->getOutputChannelCount();
            for (int ch = 0; ch < std::min(trackBuffer.getNumChannels(), outCount); ++ch)
            {
                int destCh = outStart + ch;
                if (destCh < numOutputChannels)
                {
                    if (useHybrid64Summing)
                    {
                        auto* dest = reusableMasterBufferDouble.getWritePointer(destCh);
                        auto* src = trackBuffer.getReadPointer(ch);
                        for (int sample = 0; sample < numSamples; ++sample)
                            dest[sample] += static_cast<double>(src[sample]);
                    }
                    else
                    {
                        juce::FloatVectorOperations::add(
                            outputChannelData[destCh],
                            trackBuffer.getReadPointer(ch),
                            numSamples
                        );
                    }
                }
            }
        }
    }

    // ========== FX Chains (extracted helpers) ==========
    lastPostTrackPlaybackPeak.store(postTrackPlaybackPeak, std::memory_order_relaxed);
    lastPostMonitoringInputPeak.store(postMonitoringInputPeak, std::memory_order_relaxed);
    processMasterFXChain (rtMasterFX, outputChannelData, numOutputChannels, numSamples, useHybrid64Summing);
    const float postMasterFxPeak = hybrid64PostChainActive
        ? peakFromDoubleBuffer(reusableMasterBufferDouble, numOutputChannels, numSamples)
        : peakFromFloatChannels(outputChannelData, numOutputChannels, numSamples);
    lastPostMasterFXPeak.store(postMasterFxPeak, std::memory_order_relaxed);
    processMonitoringFXChain (rtMonitoringFX, outputChannelData, numOutputChannels, numSamples, hybrid64PostChainActive);
    const float postMonitoringFxPeak = hybrid64PostChainActive
        ? peakFromDoubleBuffer(reusableMasterBufferDouble, numOutputChannels, numSamples)
        : peakFromFloatChannels(outputChannelData, numOutputChannels, numSamples);
    lastPostMonitoringFXPeak.store(postMonitoringFxPeak, std::memory_order_relaxed);

    // ========== Master Gain, Pan, Mono, and Precision Conversion ==========
    applyMasterGainPanMono (outputChannelData, numOutputChannels, numSamples,
                            currentSamplePosition, hybrid64PostChainActive);
    const float finalOutputPeak = peakFromFloatChannels(outputChannelData, numOutputChannels, numSamples);
    lastFinalOutputPeak.store(finalOutputPeak, std::memory_order_relaxed);
    if (shouldLogCallbackSummary || (((isPlaying || isRecordMode) && finalOutputPeak <= 0.0001f)
        && ((callbackCounter % 15) == 1)))
    {
        logAudioPlayback("callback peaks #" + juce::String(static_cast<juce::int64>(callbackCounter))
            + " preTrackPeak=" + juce::String(preTrackPeak, 4)
            + " postTrackPlaybackPeak=" + juce::String(postTrackPlaybackPeak, 4)
            + " postMonitoringInputPeak=" + juce::String(postMonitoringInputPeak, 4)
            + " postMasterFXPeak=" + juce::String(postMasterFxPeak, 4)
            + " postMonitoringFXPeak=" + juce::String(postMonitoringFxPeak, 4)
            + " finalOutputPeak=" + juce::String(finalOutputPeak, 4));
    }

    // ========== Metering & Analysis (extracted helpers) ==========
    updateMasterMetering (outputChannelData, numOutputChannels, numSamples);
    updatePhaseCorrelation (outputChannelData, numOutputChannels, numSamples);
    updateSpectrumAnalyzer (outputChannelData, numOutputChannels, numSamples);

    // ========== Timecode / Sync Output (Phase 3.9) ==========
    timecodeSyncManager.processBlock(numSamples, currentSampleRate, tempo,
                                      currentSamplePosition / currentSampleRate,
                                      isPlaying.load());

    // ========== Clip Launch / Trigger Engine (Phase 4.1) ==========
    {
        double currentBeat = (currentSamplePosition / currentSampleRate) * (tempo / 60.0);
        triggerEngine.processBlock(numSamples, currentSampleRate, tempo, currentBeat);
    }

    // ========== Advance transport position ==========
    // IMPORTANT: This is intentionally AFTER all processing (metronome, playback,
    // recording) so they use the position corresponding to the samples being
    // output in this callback.  Previously this was at the top of the callback,
    // causing a systematic one-buffer-length delay.
    if (isPlaying)
    {
        // Loop recording detection (Phase 3.2): if position jumped backward
        // (frontend wrapped the loop), finalize current takes and start new ones.
        // setTransportPosition() may have been called from the message thread
        // between callbacks, causing currentSamplePosition to jump backward.
        if (isRecordMode && isLooping && currentSamplePosition < prevSamplePosition - numSamples)
        {
            // Position jumped backward — loop wrap detected
            loopTakeCounter++;
            queueAllNotesOffForAllTracks();

            // Finalize current audio recordings and start new takes
            auto completedTakes = audioRecorder.stopAllRecordings(currentSampleRate);
            for (auto& take : completedTakes)
                lastCompletedClips.push_back(std::move(take));

            // Finalize MIDI recordings
            auto completedMIDITakes = midiRecorder.stopAllRecordings(projectAudioFolder, tempo);
            for (auto& take : completedMIDITakes)
                lastCompletedMIDIClips.push_back(std::move(take));

            // Start new recordings for next loop pass
            for (auto const& [tId, tTrack] : trackMap)
            {
                if (!tTrack || !tTrack->getRecordArmed()) continue;

                auto trackType = tTrack->getTrackType();
                if (trackType == TrackType::MIDI || trackType == TrackType::Instrument)
                {
                    midiRecorder.startRecording(tId, currentSampleRate);
                    midiRecorder.setRecordingStartTime(tId, currentSamplePosition / currentSampleRate);
                }
                else
                {
                    auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
                    auto filename = "Track_" + tId + "_Take_" + juce::String(timestamp) +
                                    "_L" + juce::String(loopTakeCounter) + ".wav";
                    auto outputFile = projectAudioFolder.getChildFile(filename);
                    audioRecorder.startRecording(tId, outputFile, currentSampleRate, tTrack->getInputChannelCount());
                    audioRecorder.setRecordingStartTime(tId, currentSamplePosition / currentSampleRate);
                }
            }
        }

        prevSamplePosition = currentSamplePosition;
        currentSamplePosition += numSamples;
    }

    const double callbackDurationMs = juce::Time::getMillisecondCounterHiRes() - callbackStartWallTimeMs;
    if (kEnableARADebugDiagnostics && anyActiveARAInCallback && callbackDurationMs > 10.0)
    {
        logToDisk("Audio callback slow: callback=" + juce::String(static_cast<juce::int64>(callbackCounter))
            + " firstCallbackAfterTransportStart=" + juce::String(firstCallbackAfterTransportStart ? "true" : "false")
            + " totalMs=" + juce::String(callbackDurationMs, 2)
            + " tracksProcessed=" + juce::String(orderCount)
            + " numSamples=" + juce::String(numSamples)
            + " transportPlaying=" + juce::String(isPlaying.load() ? "true" : "false")
            + " currentPositionSeconds=" + juce::String(currentSampleRate > 0.0 ? currentSamplePosition / currentSampleRate : 0.0, 3));
    }
}

juce::String AudioEngine::addTrack(const juce::String& explicitId)
{
    logToDisk("AudioEngine: Adding Track...");

    if (! mainProcessorGraph)
        return "";
        
    // In a real app, use a proper lock
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());

    // Guard: if an explicit ID is provided and already exists, return it without
    // creating a duplicate.  Duplicate IDs in trackOrder cause the same
    // TrackProcessor to be iterated (and its FX plugins called) twice per audio
    // callback, producing severe distortion from the second processing pass.
    if (explicitId.isNotEmpty() && trackMap.count(explicitId) > 0)
    {
        logToDisk("WARNING: addTrack called with already-existing ID " + explicitId + " — ignoring duplicate.");
        return explicitId;
    }

    auto newTrack = std::make_unique<TrackProcessor>();
    auto* rawTrackPtr = newTrack.get(); // Keep raw pointer for metering (owned by graph)
    rawTrackPtr->setARAPlaybackRequestHandlers({
        [this]()
        {
            if (!isPlaying.load())
                setTransportPlaying(true);
        },
        [this]()
        {
            if (isPlaying.load())
                setTransportPlaying(false);
        },
        [this](double timePositionSeconds)
        {
            setTransportPosition(timePositionSeconds);
        },
        [this](double startTimeSeconds, double durationSeconds)
        {
            juce::ignoreUnused(startTimeSeconds, durationSeconds);
            setLoopMode(durationSeconds > 0.0);
        },
        [this](bool enable)
        {
            setLoopMode(enable);
        }
    });

    // Prepare the TrackProcessor with the current device parameters before handing
    // it to the graph. AudioProcessorGraph::addNode() does NOT call prepareToPlay()
    // on newly-added nodes when the graph is already running, so we must do it here.
    // Use jmax(currentBlockSize, 512) as the block-size hint — same rationale as
    // for FX plugins (ASIO can use blocks as small as 32; preparing at that size
    // forces plugins to resize convolution/FFT for tiny blocks → crackling).
    if (currentSampleRate > 0 && currentBlockSize > 0)
        rawTrackPtr->prepareToPlay (currentSampleRate, currentBlockSize);
    rawTrackPtr->setProcessingPrecisionMode(processingPrecisionMode);

    auto trackNode = mainProcessorGraph->addNode (std::move (newTrack));

    if (trackNode)
    {
        juce::String trackId = explicitId.isNotEmpty() ? explicitId : juce::Uuid().toString();

        trackMap[trackId] = rawTrackPtr;
        trackNodeMap[trackId] = trackNode;
        trackOrder.push_back(trackId);

        // Pre-allocate sidechain output buffer for this track (avoids heap alloc on audio thread)
        int scBlockSize = currentBlockSize > 0 ? currentBlockSize : 512;
        auto sidechainBuffer = std::make_shared<juce::AudioBuffer<float>>();
        sidechainBuffer->setSize(2, scBlockSize);
        sidechainOutputBuffers[trackId] = sidechainBuffer;

        // Pre-allocate send accumulation buffer for this track
        auto sendBuffer = std::make_shared<juce::AudioBuffer<float>>();
        sendBuffer->setSize(2, scBlockSize);
        sendAccumBuffers[trackId] = sendBuffer;

        rebuildRealtimeProcessingSnapshots();

        logToDisk("Track added. ID: " + trackId + " Total: " + juce::String((int)trackOrder.size()));

        if (audioOutputNode)
        {
             mainProcessorGraph->addConnection ({ { trackNode->nodeID, 0 }, { audioOutputNode->nodeID, 0 } });
             mainProcessorGraph->addConnection ({ { trackNode->nodeID, 1 }, { audioOutputNode->nodeID, 1 } });
             logToDisk("Connected track to output.");
        }
        else
        {
             logToDisk("WARNING: audioOutputNode is null. Track not connected.");
        }
        return trackId;
    }
    else
    {
        logToDisk("ERROR: Failed to add track node to graph.");
        return "";
    }
}

bool AudioEngine::removeTrack(const juce::String& trackId)
{
    // --- Phase 1: Close all plugin editor windows for this track BEFORE
    //     acquiring the callback lock.  Window destruction must happen on
    //     the message thread and must complete before the TrackProcessor
    //     (and its owned plugins) are deleted by removeNode().
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end()) return false;

        auto* track = it->second;
        if (track)
        {
            std::vector<juce::AudioProcessor*> processors;
            for (int i = 0; i < track->getNumInputFX(); ++i)
                if (auto* p = track->getInputFXProcessor(i))
                    processors.push_back(p);
            for (int i = 0; i < track->getNumTrackFX(); ++i)
                if (auto* p = track->getTrackFXProcessor(i))
                    processors.push_back(p);
            if (auto* inst = track->getInstrument())
                processors.push_back(inst);

            if (!processors.empty())
                pluginWindowManager.closeEditorsForTrack(processors);
        }
    }

    // --- Phase 2: Acquire lock and remove the track from the graph.
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());

    auto it = trackMap.find(trackId);
    if (it == trackMap.end()) return false;

    auto nodeIt = trackNodeMap.find(trackId);
    if (nodeIt != trackNodeMap.end() && nodeIt->second)
        mainProcessorGraph->removeNode(nodeIt->second->nodeID);

    trackMap.erase(it);
    trackNodeMap.erase(trackId);
    trackOrder.erase(std::remove(trackOrder.begin(), trackOrder.end(), trackId), trackOrder.end());
    sidechainOutputBuffers.erase(trackId);
    sendAccumBuffers.erase(trackId);
    rebuildRealtimeProcessingSnapshots();

    return true;
}

bool AudioEngine::reorderTrack(const juce::String& trackId, int newPosition)
{
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());
    
    auto it = std::find(trackOrder.begin(), trackOrder.end(), trackId);
    if (it == trackOrder.end()) return false;
    
    // Clamp new position
    if (newPosition < 0) newPosition = 0;
    if (newPosition >= (int)trackOrder.size()) newPosition = (int)trackOrder.size() - 1;
    
    if (std::distance(trackOrder.begin(), it) == newPosition) return true;
    
    trackOrder.erase(it);
    trackOrder.insert(trackOrder.begin() + newPosition, trackId);
    rebuildRealtimeProcessingSnapshots();
    
    return true;
}

int AudioEngine::getTrackIndex(const juce::String& trackId) const
{
    auto it = std::find(trackOrder.begin(), trackOrder.end(), trackId);
    if (it != trackOrder.end())
        return (int)std::distance(trackOrder.begin(), it);
    return -1;
}

juce::var AudioEngine::getMeterLevels()
{
    // Return an object with track IDs as keys for robust matching
    juce::DynamicObject::Ptr meterObj (new juce::DynamicObject());

    for (const auto& trackId : trackOrder)
    {
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
            meterObj->setProperty(juce::Identifier(trackId), it->second->getRMSLevel());
    }

    return juce::var (meterObj.get());
}

juce::var AudioEngine::getMeterClipStates()
{
    juce::DynamicObject::Ptr clipObj(new juce::DynamicObject());

    for (const auto& trackId : trackOrder)
    {
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
            clipObj->setProperty(juce::Identifier(trackId), it->second->isClipLatched());
    }

    return juce::var(clipObj.get());
}

juce::var AudioEngine::getMeteringData()
{
    // Return an array with one entry per track (used by ScriptEngine for track count etc.)
    juce::Array<juce::var> result;
    for (const auto& trackId : trackOrder)
    {
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            juce::DynamicObject::Ptr obj (new juce::DynamicObject());
            obj->setProperty("id", trackId);
            obj->setProperty("rms", it->second->getRMSLevel());
            result.add(juce::var(obj.get()));
        }
    }
    return juce::var(result);
}

//==============================================================================
// MIDI Device Management (Phase 2)

juce::var AudioEngine::getMIDIInputDevices()
{
    if (!midiManager)
        return juce::var();
    
    auto devices = midiManager->getAvailableDevices();
    juce::var result;
    juce::Array<juce::var> deviceArray;
    
    for (const auto& device : devices)
    {
        deviceArray.add(device);
    }
    
    result = deviceArray;
    return result;
}

juce::var AudioEngine::getMIDIOutputDevices()
{
    juce::Array<juce::var> deviceArray;
    for (const auto& device : juce::MidiOutput::getAvailableDevices())
        deviceArray.add(device.name);
    return deviceArray;
}

bool AudioEngine::openMIDIDevice(const juce::String& deviceName)
{
    if (!midiManager)
        return false;
    
    bool success = midiManager->openDevice(deviceName);
    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Opened MIDI device: " + deviceName);
    }
    return success;
}

void AudioEngine::closeMIDIDevice(const juce::String& deviceName)
{
    if (midiManager)
    {
        midiManager->closeDevice(deviceName);
        juce::Logger::writeToLog("AudioEngine: Closed MIDI device: " + deviceName);
    }
}

juce::var AudioEngine::getOpenMIDIDevices()
{
    if (!midiManager)
        return juce::var();
    
    auto devices = midiManager->getOpenDevices();
    juce::var result;
    juce::Array<juce::var> deviceArray;
    
    for (const auto& device : devices)
    {
        deviceArray.add(device);
    }
    
    result = deviceArray;
    return result;
}

//==============================================================================
// Track Type Management (Phase 2)

void AudioEngine::setTrackType(const juce::String& trackId, const juce::String& type)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    TrackType trackType = TrackType::Audio;
    
    if (type == "midi")
        trackType = TrackType::MIDI;
    else if (type == "instrument")
        trackType = TrackType::Instrument;
    
    trackMap[trackId]->setTrackType(trackType);
    juce::Logger::writeToLog("AudioEngine: Track " + trackId + " type set to: " + type);
}

void AudioEngine::setTrackMIDIInput(const juce::String& trackId, const juce::String& deviceName, int channel)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    trackMap[trackId]->setMIDIInputDevice(deviceName);
    trackMap[trackId]->setMIDIChannel(channel);
    
    juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                           " MIDI input: " + deviceName + 
                           " channel: " + juce::String(channel));
}

void AudioEngine::setTrackMIDIClips(const juce::String& trackId, const juce::String& clipsJSON)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return;

    std::vector<TrackProcessor::ScheduledMIDIClip> clips;
    auto parsed = juce::JSON::parse(clipsJSON);
    if (auto* clipsArray = parsed.getArray())
    {
        clips.reserve(static_cast<size_t>(clipsArray->size()));
        for (const auto& clipVar : *clipsArray)
        {
            auto* clipObj = clipVar.getDynamicObject();
            if (!clipObj)
                continue;

            TrackProcessor::ScheduledMIDIClip clip;
            clip.clipId = clipObj->getProperty("id").toString();
            clip.startTime = static_cast<double>(clipObj->getProperty("startTime"));
            clip.duration = static_cast<double>(clipObj->getProperty("duration"));

            if (auto* eventsArray = clipObj->getProperty("events").getArray())
            {
                clip.events.reserve(static_cast<size_t>(eventsArray->size()));
                for (const auto& eventVar : *eventsArray)
                {
                    auto* eventObj = eventVar.getDynamicObject();
                    if (!eventObj)
                        continue;

                    const juce::String eventType = eventObj->getProperty("type").toString();
                    const double timestamp = static_cast<double>(eventObj->getProperty("timestamp"));
                    const int channel = eventObj->hasProperty("channel")
                        ? juce::jlimit(1, 16, static_cast<int>(eventObj->getProperty("channel")))
                        : 1;

                    juce::MidiMessage message;
                    if (eventType == "noteOn")
                    {
                        const int note = static_cast<int>(eventObj->getProperty("note"));
                        const int velocity = static_cast<int>(eventObj->getProperty("velocity"));
                        message = juce::MidiMessage::noteOn(channel, note,
                                                            static_cast<juce::uint8>(juce::jlimit(0, 127, velocity)));
                    }
                    else if (eventType == "noteOff")
                    {
                        const int note = static_cast<int>(eventObj->getProperty("note"));
                        message = juce::MidiMessage::noteOff(channel, note);
                    }
                    else if (eventType == "cc")
                    {
                        const int controller = static_cast<int>(eventObj->getProperty("controller"));
                        const int value = static_cast<int>(eventObj->getProperty("value"));
                        message = juce::MidiMessage::controllerEvent(channel, controller,
                                                                     juce::jlimit(0, 127, value));
                    }
                    else if (eventType == "pitchBend")
                    {
                        const int value = eventObj->hasProperty("value")
                            ? static_cast<int>(eventObj->getProperty("value"))
                            : 8192;
                        message = juce::MidiMessage::pitchWheel(channel, juce::jlimit(0, 16383, value));
                    }
                    else
                    {
                        continue;
                    }

                    TrackProcessor::ScheduledMIDIEvent scheduledEvent;
                    scheduledEvent.timestampSeconds = timestamp;
                    scheduledEvent.message = message;
                    clip.events.push_back(std::move(scheduledEvent));
                }
            }

            std::sort(clip.events.begin(), clip.events.end(),
                      [] (const auto& a, const auto& b) { return a.timestampSeconds < b.timestampSeconds; });
            clips.push_back(std::move(clip));
        }
    }

    it->second->setScheduledMIDIClips(std::move(clips));
}

bool AudioEngine::sendMidiNote(const juce::String& trackId, int note, int velocity, bool isNoteOn)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    auto* track = it->second;
    const int channel = track->getMIDIChannel() > 0 ? track->getMIDIChannel() : 1;
    int sampleOffset = 0;
    if (currentSampleRate > 0.0 && currentBlockSize > 0)
    {
        const double blockStartMs = lastAudioBlockWallTimeMs.load(std::memory_order_acquire);
        const double blockDurationMs = lastAudioBlockDurationMs.load(std::memory_order_acquire);
        if (blockStartMs > 0.0 && blockDurationMs > 0.0)
        {
            double elapsedMs = juce::Time::getMillisecondCounterHiRes() - blockStartMs;
            if (elapsedMs < 0.0)
                elapsedMs = 0.0;
            if (elapsedMs > blockDurationMs)
            {
                midiLateEventCount.fetch_add(1, std::memory_order_relaxed);
                elapsedMs = blockDurationMs;
            }

            sampleOffset = juce::jlimit(
                0,
                juce::jmax(0, currentBlockSize - 1),
                static_cast<int>(std::round((elapsedMs / 1000.0) * currentSampleRate)));
            midiLastComputedSampleOffset.store(sampleOffset, std::memory_order_relaxed);
        }
    }

    juce::MidiMessage message = isNoteOn
        ? juce::MidiMessage::noteOn(channel, note, static_cast<juce::uint8>(juce::jlimit(0, 127, velocity)))
        : juce::MidiMessage::noteOff(channel, note);

    const bool queued = track->enqueueMidiMessage(message, sampleOffset);
    if (queued && isPlaying && isRecordMode && track->getRecordArmed())
        midiRecorder.recordEvent(trackId, currentSamplePosition / currentSampleRate, message);

    return queued;
}

bool AudioEngine::loadInstrument(const juce::String& trackId, const juce::String& vstPath)
{
    if (trackMap.find(trackId) == trackMap.end())
        return false;
    
    // Load the VST instrument using PluginManager with actual device rate
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(vstPath, sr, bs);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load instrument: " + vstPath);
        return false;
    }
    
    // Cast to AudioPluginInstance
    auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(plugin.get());
    if (!pluginInstance)
    {
        juce::Logger::writeToLog("AudioEngine: Plugin is not an AudioPluginInstance: " + vstPath);
        return false;
    }
    
    // Create a unique_ptr with the correct type
    std::unique_ptr<juce::AudioPluginInstance> instrumentPtr(pluginInstance);
    plugin.release(); // Release ownership from the AudioProcessor unique_ptr

      // Provide tempo/position info to the instrument plugin
    instrumentPtr->setPlayHead (this);

    // Set the instrument on the track
    trackMap[trackId]->setInstrument(std::move(instrumentPtr), sr, bs);
    trackMap[trackId]->setTrackType(TrackType::Instrument);
    
    juce::Logger::writeToLog("AudioEngine: Loaded instrument on track " + trackId + ": " + vstPath);
    return true;
}

//==============================================================================
// MIDI Message Routing (Phase 2)

void AudioEngine::handleMIDIMessage(const juce::String& deviceName, int channel, const juce::MidiMessage& message)
{
    // MIDI Learn: if active and we receive a CC, create a mapping
    if (midiLearnActive.load() && message.isController())
    {
        const juce::ScopedLock sl(midiLearnLock);
        int ccNum = message.getControllerNumber();

        // Remove existing mapping for this CC
        midiLearnMappings.erase(
            std::remove_if(midiLearnMappings.begin(), midiLearnMappings.end(),
                            [ccNum](const MIDILearnMapping& m) { return m.ccNumber == ccNum; }),
            midiLearnMappings.end());

        MIDILearnMapping mapping;
        mapping.ccNumber = ccNum;
        mapping.trackId = midiLearnTrackId;
        mapping.pluginIndex = midiLearnPluginIndex;
        mapping.paramIndex = midiLearnParamIndex;
        midiLearnMappings.push_back(mapping);

        midiLearnActive.store(false);
        juce::Logger::writeToLog("MIDI Learn: Mapped CC " + juce::String(ccNum) +
                                 " -> track=" + mapping.trackId +
                                 " plugin=" + juce::String(mapping.pluginIndex) +
                                 " param=" + juce::String(mapping.paramIndex));
    }

    // Apply MIDI CC mappings: route incoming CC values to mapped plugin parameters
    if (message.isController())
    {
        const juce::ScopedLock sl(midiLearnLock);
        int ccNum = message.getControllerNumber();
        float normalizedValue = message.getControllerValue() / 127.0f;

        for (const auto& mapping : midiLearnMappings)
        {
            if (mapping.ccNumber == ccNum)
            {
                auto it = trackMap.find(mapping.trackId);
                if (it != trackMap.end() && it->second)
                {
                    auto* processor = it->second->getTrackFXProcessor(mapping.pluginIndex);
                    if (processor)
                    {
                        const auto& params = processor->getParameters();
                        if (params.size() > mapping.paramIndex)
                            params[mapping.paramIndex]->setValueNotifyingHost(normalizedValue);
                    }
                }
            }
        }
    }

    int sampleOffset = 0;
    if (currentSampleRate > 0.0 && currentBlockSize > 0)
    {
        const double blockStartMs = lastAudioBlockWallTimeMs.load(std::memory_order_acquire);
        const double blockDurationMs = lastAudioBlockDurationMs.load(std::memory_order_acquire);
        if (blockStartMs > 0.0 && blockDurationMs > 0.0)
        {
            double elapsedMs = juce::Time::getMillisecondCounterHiRes() - blockStartMs;
            if (elapsedMs < 0.0)
                elapsedMs = 0.0;
            if (elapsedMs > blockDurationMs)
            {
                midiLateEventCount.fetch_add(1, std::memory_order_relaxed);
                elapsedMs = blockDurationMs;
            }

            sampleOffset = juce::jlimit(
                0,
                juce::jmax(0, currentBlockSize - 1),
                static_cast<int>(std::round((elapsedMs / 1000.0) * currentSampleRate)));
            midiLastComputedSampleOffset.store(sampleOffset, std::memory_order_relaxed);
        }
    }

    // Route MIDI to appropriate tracks
    for (auto const& [id, track] : trackMap)
    {
        if (!track) continue;
        
        // Check if track accepts MIDI
        if (track->getTrackType() != TrackType::MIDI && track->getTrackType() != TrackType::Instrument)
            continue;
        
        // Check if track is listening to this device.
        // Instrument tracks with no explicit device accept MIDI from any device
        // (omni mode) so the user gets sound immediately after loading an instrument.
        const auto trackDevice = track->getMIDIInputDevice();
        if (!trackDevice.isEmpty() && trackDevice != deviceName)
            continue;

        // Check channel filtering (0 = all channels, 1-16 = specific channel)
        int trackChannel = track->getMIDIChannel();
        if (trackChannel != 0 && trackChannel != channel)
            continue;

        // Instrument tracks always accept live MIDI (they exist to be played).
        // Audio/MIDI tracks require explicit input monitoring toggle.
        if (track->getInputMonitoring()
            || track->getTrackType() == TrackType::Instrument)
            track->enqueueMidiMessage(message, sampleOffset);
        
        // Record MIDI event if armed and in record mode
        if (isPlaying && isRecordMode && track->getRecordArmed())
        {
            double timestamp = currentSamplePosition / currentSampleRate;
            midiRecorder.recordEvent(id, timestamp, message);
        }
    }
}

juce::MidiBuffer AudioEngine::buildTrackMidiBlock(const juce::String& trackId, double blockStartTimeSeconds,
                                                  int numSamples, double sampleRate, bool playing)
{
    juce::MidiBuffer midiMessages;
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->buildMidiBuffer(midiMessages, blockStartTimeSeconds, numSamples, sampleRate, playing);
    return midiMessages;
}

void AudioEngine::queueAllNotesOffForTrack(TrackProcessor& track)
{
    if (track.getTrackType() == TrackType::MIDI || track.getTrackType() == TrackType::Instrument)
        track.queueAllNotesOff();
}

void AudioEngine::queueAllNotesOffForAllTracks()
{
    for (const auto& [trackId, track] : trackMap)
    {
        juce::ignoreUnused(trackId);
        if (track)
            queueAllNotesOffForTrack(*track);
    }
}

void AudioEngine::applyProcessingPrecisionToTrack(TrackProcessor& track)
{
    track.setProcessingPrecisionMode(processingPrecisionMode);
}

float AudioEngine::getMasterLevel() const
{
    // Use the actual measured output level (computed in the audio callback after FX and pan)
    return masterOutputLevel.load();
}

bool AudioEngine::getMasterClipLatched() const
{
    return masterClipLatched.load(std::memory_order_relaxed);
}

void AudioEngine::resetMeterClip(const juce::String& trackId)
{
    if (trackId == "master")
    {
        masterClipLatched.store(false, std::memory_order_relaxed);
        return;
    }

    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second != nullptr)
        it->second->resetClipLatch();
}




juce::var AudioEngine::getAudioDeviceSetup()
{
    juce::Logger::writeToLog("AudioEngine: getAudioDeviceSetup() called");
    
    juce::DynamicObject* data = new juce::DynamicObject();

    // 1. Current Setup
    auto* currentSetup = new juce::DynamicObject();
    auto currentDeviceType = deviceManager.getCurrentAudioDeviceType();
    
    juce::Logger::writeToLog("AudioEngine: Current device type: " + currentDeviceType);
    
    // Handle case where no device is open yet
    auto* device = deviceManager.getCurrentAudioDevice();
    
    currentSetup->setProperty("audioDeviceType", currentDeviceType);
    if (device)
    {
        juce::Logger::writeToLog("AudioEngine: Current device: " + device->getName());
        currentSetup->setProperty("inputDevice", device->getName());
        currentSetup->setProperty("outputDevice", device->getName()); // Basic assumption for now
        currentSetup->setProperty("sampleRate", device->getCurrentSampleRate());
        currentSetup->setProperty("bufferSize", device->getCurrentBufferSizeSamples());
        
        // Get ALL channel names from the device (not just active)
        juce::StringArray inputNames = device->getInputChannelNames();
        juce::StringArray outputNames = device->getOutputChannelNames();
        
        // Total available channels (this is what matters for routing selection)
        int numTotalInputs = inputNames.size();
        int numTotalOutputs = outputNames.size();
        
        juce::Logger::writeToLog("AudioEngine: Device has " + juce::String(numTotalInputs) + " total input channels");
        
        currentSetup->setProperty("numInputChannels", numTotalInputs);
        currentSetup->setProperty("numOutputChannels", numTotalOutputs);
        
        // Build input channel names array (ALL channels)
        juce::Array<juce::var> inputChannelNamesArray;
        for (int i = 0; i < inputNames.size(); ++i)
        {
            inputChannelNamesArray.add(inputNames[i]);
            juce::Logger::writeToLog("AudioEngine: Input channel " + juce::String(i) + ": " + inputNames[i]);
        }
        currentSetup->setProperty("inputChannelNames", inputChannelNamesArray);
        
        // Build output channel names array (ALL channels)
        juce::Array<juce::var> outputChannelNamesArray;
        for (int i = 0; i < outputNames.size(); ++i)
        {
            outputChannelNamesArray.add(outputNames[i]);
        }
        currentSetup->setProperty("outputChannelNames", outputChannelNamesArray);
        
        // Also provide active channel info separately (can be used for metering, etc)
        currentSetup->setProperty("numActiveInputChannels", device->getActiveInputChannels().countNumberOfSetBits());
        currentSetup->setProperty("numActiveOutputChannels", device->getActiveOutputChannels().countNumberOfSetBits());
    }
    else
    {
        juce::Logger::writeToLog("AudioEngine: WARNING - No audio device currently active!");
        // Provide defaults
        currentSetup->setProperty("inputDevice", "");
        currentSetup->setProperty("outputDevice", "");
        currentSetup->setProperty("sampleRate", 44100.0);
        currentSetup->setProperty("bufferSize", 512);
        currentSetup->setProperty("numInputChannels", 2);
        currentSetup->setProperty("numOutputChannels", 2);
        currentSetup->setProperty("inputChannelNames", juce::Array<juce::var>());
        currentSetup->setProperty("outputChannelNames", juce::Array<juce::var>());
    }
    
    data->setProperty("current", currentSetup);

    // 2. Available Device Types
    juce::Array<juce::var> types;
    for (auto& type : deviceManager.getAvailableDeviceTypes())
    {
        auto typeName = type->getTypeName();
        types.add(typeName);
        juce::Logger::writeToLog("AudioEngine: Available type: " + typeName);
    }
    data->setProperty("availableTypes", types);
    
    // 3. Available Devices for Current Type
    juce::Array<juce::var> inputList;
    juce::Array<juce::var> outputList;
    
    if (auto* type = deviceManager.getCurrentDeviceTypeObject())
    {
        juce::Logger::writeToLog("AudioEngine: Enumerating devices for type: " + type->getTypeName());
        
        for (auto& name : type->getDeviceNames(true)) // Inputs
        {
            inputList.add(name);
            juce::Logger::writeToLog("AudioEngine: Input device: " + name);
        }
        
        for (auto& name : type->getDeviceNames(false)) // Outputs
        {
            outputList.add(name);
            juce::Logger::writeToLog("AudioEngine: Output device: " + name);
        }
    }
    data->setProperty("inputs", inputList);
    data->setProperty("outputs", outputList);
    
    
    // 4. Sample Rates & 5. Buffer Sizes
    juce::Array<juce::var> rates;
    juce::Array<juce::var> buffers;
    
    if (device)
    {
        // Device is open - get its actual capabilities
        for (auto sr : device->getAvailableSampleRates())
            rates.add(sr);
        for (auto bs : device->getAvailableBufferSizes())
            buffers.add(bs);
        juce::Logger::writeToLog("AudioEngine: Got " + juce::String(rates.size()) + " sample rates from open device");
    }
    else
    {
        // No device open - provide common professional audio defaults
        // These work with most ASIO/WASAPI devices
        juce::Logger::writeToLog("AudioEngine: No device open, using default capabilities");
        
        rates.add(44100.0);
        rates.add(48000.0);
        rates.add(88200.0);
        rates.add(96000.0);
        rates.add(176400.0);
        rates.add(192000.0);
        
        buffers.add(32);
        buffers.add(64);
        buffers.add(128);
        buffers.add(256);
        buffers.add(512);
        buffers.add(1024);
        buffers.add(2048);
    }
    
    data->setProperty("sampleRates", rates);
    data->setProperty("bufferSizes", buffers);

    juce::Logger::writeToLog("AudioEngine: getAudioDeviceSetup() returning data");
    return data;
}

void AudioEngine::setAudioDeviceSetup(const juce::String& type, const juce::String& input, const juce::String& output, double sampleRate, int bufferSize)
{
    juce::Logger::writeToLog("AudioEngine: Setting Audio Device...");
    
    // 1. Change Type if needed
    if (deviceManager.getCurrentAudioDeviceType() != type)
    {
        deviceManager.setCurrentAudioDeviceType(type, true);
    }
    
    // 2. Setup Config
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager.getAudioDeviceSetup(setup);
    
    setup.inputDeviceName = input;
    setup.outputDeviceName = output;
    setup.sampleRate = sampleRate;
    setup.bufferSize = bufferSize;
    // Activate all channels the device supports (not just the default 2).
    // JUCE caps this bitmask at the device's actual channel count.
    setup.useDefaultInputChannels = false;
    setup.inputChannels.setRange (0, 32, true);
    setup.useDefaultOutputChannels = false;
    setup.outputChannels.setRange (0, 32, true);

    // Apply (treat errors softly by logging)
    auto error = deviceManager.setAudioDeviceSetup(setup, true);
    if (error.isNotEmpty())
        juce::Logger::writeToLog("AudioEngine: Error setting device: " + error);
    else
        saveDeviceSettings();
}

//==============================================================================
// Track Control (Phase 1)

void AudioEngine::setTrackRecordArm(const juce::String& trackId, bool armed)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setRecordArmed(armed);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " record arm: " + (armed ? "ON" : "OFF"));
        }
    }
}

void AudioEngine::setTrackInputMonitoring(const juce::String& trackId, bool enabled)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            if (!enabled)
            {
                const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
                queueAllNotesOffForTrack(*track);
            }
            track->setInputMonitoring(enabled);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " monitoring: " + (enabled ? "ON" : "OFF"));
        }
    }
}

void AudioEngine::setTrackInputChannels(const juce::String& trackId, int startChannel, int numChannels)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setInputChannels(startChannel, numChannels);
        }
    }
}

//==============================================================================
// Volume/Pan/Mute/Solo (Phase 1)

void AudioEngine::setTrackVolume(const juce::String& trackId, float volumeDB)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setVolume(volumeDB);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " volume: " + juce::String(volumeDB) + " dB");
        }
    }
}

void AudioEngine::setTrackPan(const juce::String& trackId, float pan)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setPan(pan);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " pan: " + juce::String(pan));
        }
    }
}

void AudioEngine::setTrackMute(const juce::String& trackId, bool muted)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            if (muted)
            {
                const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
                queueAllNotesOffForTrack(*track);
            }
            track->setMute(muted);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " mute: " + (muted ? "ON" : "OFF"));
        }
    }
}

void AudioEngine::setTrackSolo(const juce::String& trackId, bool soloed)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setSolo(soloed);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId +
                                   " solo: " + (soloed ? "ON" : "OFF"));

            // Update cached solo state so audio thread doesn't need to scan
            bool anyNowSoloed = false;
            for (const auto& pair : trackMap)
                if (pair.second && pair.second->getSolo()) { anyNowSoloed = true; break; }
            cachedAnySoloed.store(anyNowSoloed);

            if (anyNowSoloed)
            {
                const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
                for (const auto& pair : trackMap)
                {
                    if (pair.second && !pair.second->getSolo())
                        queueAllNotesOffForTrack(*pair.second);
                }
            }
        }
    }
}

//==============================================================================
// Punch In/Out (Phase 3.1)

void AudioEngine::setPunchRange(double startTime, double endTime, bool enabled)
{
    punchStartTime.store(startTime, std::memory_order_relaxed);
    punchEndTime.store(endTime, std::memory_order_relaxed);
    punchEnabled.store(enabled, std::memory_order_release);
    juce::Logger::writeToLog("AudioEngine: Punch range " + juce::String(enabled ? "enabled" : "disabled") +
                             " [" + juce::String(startTime, 3) + "s - " + juce::String(endTime, 3) + "s]");
}

//==============================================================================
// Record-Safe (Phase 3.3)

void AudioEngine::setTrackRecordSafe(const juce::String& trackId, bool safe)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setRecordSafe(safe);
        juce::Logger::writeToLog("AudioEngine: Track " + trackId + " record-safe: " + (safe ? "ON" : "OFF"));
    }
}

bool AudioEngine::getTrackRecordSafe(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getRecordSafe();
    return false;
}

//==============================================================================
// Transport Control (Phase 2)

void AudioEngine::setTransportPlaying(bool playing)
{
    logToDisk("setTransportPlaying(" + juce::String(playing ? "true" : "false") + ") called. Current: " + juce::String(isPlaying ? "true" : "false"));
    logAudioTransport("setTransportPlaying playing=" + juce::String(playing ? "true" : "false")
        + " current=" + juce::String(isPlaying.load() ? "true" : "false")
        + " clipCount=" + juce::String(playbackEngine.getNumClips())
        + " activeOutputs=" + juce::String(lastActiveOutputChannels.load(std::memory_order_relaxed)));
    
    if (isPlaying == playing)
        return; // No change
        
    isPlaying = playing;
    
    if (playing)
    {
        playbackEngine.commitAllDeferredClipAudioFiles();
        // Update sample rate from device
        auto* device = deviceManager.getCurrentAudioDevice();
        if (device)
            currentSampleRate = device->getCurrentSampleRate();

        firstCallbackAfterTransportStartPending.store(true, std::memory_order_release);
            
        logToDisk("Transport PLAY. SampleRate: " + juce::String(currentSampleRate) + 
                 " Position: " + juce::String(currentSamplePosition / currentSampleRate) + "s");
        logAudioTransport("playback snapshot totalClips=" + juce::String(playbackEngine.getNumClips())
            + " sampleRate=" + juce::String(currentSampleRate, 2)
            + " blockSize=" + juce::String(currentBlockSize)
            + " activeOutputs=" + juce::String(lastActiveOutputChannels.load(std::memory_order_relaxed)));
    }
    else
    {
        logToDisk("Transport STOP at position: " + juce::String(currentSamplePosition / currentSampleRate) + "s");
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        queueAllNotesOffForAllTracks();
        playbackEngine.commitAllDeferredClipAudioFiles();
        // Don't reset position here - let the stop() action control that
    }

    const double currentPositionSeconds = currentSampleRate > 0.0
        ? (currentSamplePosition / currentSampleRate)
        : 0.0;
    const auto focusedEditorTarget = pluginWindowManager.getFocusedEditorTarget();
    for (auto const& [trackId, track] : trackMap)
    {
        if (track != nullptr)
        {
            bool editorFocusedAtPlayStart = false;
            if (playing && focusedEditorTarget.has_value())
            {
                editorFocusedAtPlayStart =
                    focusedEditorTarget->scope == PluginWindowManager::PluginEditorTarget::Scope::TrackFX
                    && focusedEditorTarget->trackId == trackId
                    && focusedEditorTarget->fxIndex == track->getARAFXIndex();
            }

            track->noteARATransportPlaybackStateChanged(trackId, playing, currentPositionSeconds,
                                                        editorFocusedAtPlayStart);
        }
    }
}

void AudioEngine::setTransportPosition(double seconds)
{
    logToDisk("setTransportPosition(" + juce::String(seconds) + ") called. Current="
        + juce::String(currentSampleRate > 0.0 ? currentSamplePosition / currentSampleRate : 0.0)
        + "s isPlaying=" + juce::String(isPlaying.load() ? "true" : "false"));
    logAudioTransport("setTransportPosition seconds=" + juce::String(seconds, 3)
        + " isPlaying=" + juce::String(isPlaying.load() ? "true" : "false"));
    playbackEngine.commitAllDeferredClipAudioFiles();
    currentSamplePosition = seconds * currentSampleRate;

    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    queueAllNotesOffForAllTracks();
}

bool AudioEngine::hasAnyActiveARA() const
{
    for (auto const& [id, track] : trackMap)
        if (track != nullptr && track->hasActiveARA())
            return true;
    return false;
}

void AudioEngine::setTransportRecording(bool recording)
{
    logToDisk("setTransportRecording(" + juce::String(recording ? "true" : "false") + ") called. Current: " + juce::String(isRecordMode ? "true" : "false"));
    logAudioRecord("setTransportRecording recording=" + juce::String(recording ? "true" : "false")
        + " current=" + juce::String(isRecordMode.load() ? "true" : "false"));
    
    if (isRecordMode == recording)
        return; // No change
        
    isRecordMode = recording;

    if (recording)
    {
        loopTakeCounter = 0;  // Reset loop take counter for new recording session
        prevSamplePosition = currentSamplePosition;  // Initialize prev position tracking

        projectAudioFolder = getPreferredAppDataDirectory().getChildFile("Audio");
        
        logToDisk("Target Audio Folder: " + projectAudioFolder.getFullPathName());
        
        if (!projectAudioFolder.exists())
        {
            bool created = projectAudioFolder.createDirectory();
            logToDisk("Folder created status: " + juce::String(created ? "SUCCESS" : "FAIL"));
        }
        
        // Start recording for each armed track
        logToDisk("Checking " + juce::String((int)trackMap.size()) + " tracks for arming...");
        juce::StringArray armedTrackIds;

        bool anyAudioStarted = false;
        for (auto const& [trackId, track] : trackMap)
        {
            if (!track) continue;

            bool isArmed = track->getRecordArmed();

            if (isArmed)
            {
                armedTrackIds.add(trackId);
                auto trackType = track->getTrackType();

                if (trackType == TrackType::MIDI || trackType == TrackType::Instrument)
                {
                    // MIDI recording — in-memory accumulation
                    logToDisk("Track " + trackId + " IS ARMED (MIDI). Starting MIDI record...");
                    midiRecorder.startRecording(trackId, currentSampleRate);
                    anyAudioStarted = true;  // Reuse flag for pending start capture
                }
                else
                {
                    // Audio recording — disk I/O via ThreadedWriter
                    logToDisk("Track " + trackId + " IS ARMED. Starting record...");

                    auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
                    auto filename = "Track_" + trackId + "_Take_" + juce::String(timestamp) + ".wav";
                    auto outputFile = projectAudioFolder.getChildFile(filename);

                    logToDisk("Recording at sample rate: " + juce::String(currentSampleRate) + " Hz");

                    int numChannels = track->getInputChannelCount();
                    bool started = audioRecorder.startRecording(trackId, outputFile, currentSampleRate, numChannels);

                    if (started)
                        anyAudioStarted = true;

                    logToDisk("Start Recording Track " + trackId + " -> " + (started ? "SUCCESS" : "FAIL to " + outputFile.getFullPathName()));
                }
            }
        }
        logAudioRecord("record start armedTracks=" + armedTrackIds.joinIntoString(",")
            + " anyStarted=" + juce::String(anyAudioStarted ? "true" : "false"));

        if (anyAudioStarted)
        {
            // Defer start-time capture to the audio thread to avoid race
            // conditions — the message thread's view of currentSamplePosition
            // may be stale by the time the audio callback processes the first
            // buffer.  The audio thread sets the correct start time (with
            // input latency compensation) on the first write.
            pendingRecordStartCapture.store(true, std::memory_order_release);
        }
    }
    else
    {
        // Stop all recordings and collect clip info
        logToDisk("Record mode OFF - stopping recordings");
        lastCompletedClips = audioRecorder.stopAllRecordings(currentSampleRate);
        logToDisk("Recordings stopped. Completed " + juce::String(lastCompletedClips.size()) + " audio clips.");

        // Stop MIDI recordings
        lastCompletedMIDIClips = midiRecorder.stopAllRecordings(projectAudioFolder, tempo);
        logToDisk("MIDI recordings stopped. Completed " + juce::String(lastCompletedMIDIClips.size()) + " MIDI clips.");

        // Generate peak caches for recorded audio files in background (REAPER-style).
        // The onComplete callback fires on the message thread; MainComponent uses
        // it to emit a "peaksReady" JS event so the Timeline refreshes waveforms.
        for (const auto& clip : lastCompletedClips)
        {
            juce::String filePath = clip.file.getFullPathName();
            peakCache.generateAsync(clip.file, [this, filePath]()
            {
                if (onPeaksReady)
                    onPeaksReady(filePath);
            });
        }
        logAudioRecord("record stop completedAudio=" + juce::String(static_cast<int>(lastCompletedClips.size()))
            + " completedMidi=" + juce::String(static_cast<int>(lastCompletedMIDIClips.size())));
    }
}


//==============================================================================
// FX Management (Phase 3)

void AudioEngine::scanForPlugins()
{
    juce::Logger::writeToLog("AudioEngine: Scanning for plugins...");
    pluginManager.scanForPlugins();
}

juce::var AudioEngine::getAvailablePlugins()
{
    auto plugins = pluginManager.getAvailablePlugins();

    juce::Array<juce::var> pluginList;
    for (const auto& plugin : plugins)
    {
        auto* pluginObj = new juce::DynamicObject();
        pluginObj->setProperty("name", plugin.name);
        pluginObj->setProperty("manufacturer", plugin.manufacturerName);
        pluginObj->setProperty("category", plugin.category);
        pluginObj->setProperty("fileOrIdentifier", plugin.fileOrIdentifier);
        pluginObj->setProperty("isInstrument", plugin.isInstrument);
        pluginObj->setProperty("hasARA", plugin.hasARAExtension);
        pluginObj->setProperty("pluginFormatName", plugin.pluginFormatName);
        pluginObj->setProperty("pluginFormat", plugin.pluginFormatName.toLowerCase());
        pluginObj->setProperty("producesMidi", false);
        pluginObj->setProperty("supportsDoublePrecision", false);

        // VST3 Snapshot lookup: check bundle for Contents/Resources/Snapshots/*.png
        juce::File pluginPath(plugin.fileOrIdentifier);
        if (pluginPath.isDirectory() && pluginPath.getFileExtension() == ".vst3")
        {
            juce::File snapshotsDir = pluginPath.getChildFile("Contents")
                                                .getChildFile("Resources")
                                                .getChildFile("Snapshots");
            if (snapshotsDir.isDirectory())
            {
                juce::Array<juce::File> pngFiles;
                snapshotsDir.findChildFiles(pngFiles, juce::File::findFiles, false, "*.png");
                if (pngFiles.size() > 0)
                {
                    juce::MemoryBlock imageData;
                    if (pngFiles[0].loadFileAsData(imageData))
                    {
                        juce::String base64 = juce::Base64::toBase64(imageData.getData(),
                                                                      imageData.getSize());
                        pluginObj->setProperty("snapshot",
                            juce::String("data:image/png;base64,") + base64);
                    }
                }
            }
        }

        pluginList.add(juce::var(pluginObj));
    }

    juce::Logger::writeToLog("AudioEngine: Returning " + juce::String(pluginList.size()) + " plugins");
    return pluginList;
}

juce::var AudioEngine::getPluginCapabilities(const juce::String& pluginPath)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("fileOrIdentifier", pluginPath);

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
    {
        obj->setProperty("success", false);
        return juce::var(obj);
    }

    obj->setProperty("success", true);
    obj->setProperty("name", plugin->getName());
    obj->setProperty("acceptsMidi", plugin->acceptsMidi());
    obj->setProperty("producesMidi", plugin->producesMidi());
    obj->setProperty("isMidiEffect", plugin->isMidiEffect());
    obj->setProperty("supportsDoublePrecision", plugin->supportsDoublePrecisionProcessing());
    obj->setProperty("inputChannels", plugin->getTotalNumInputChannels());
    obj->setProperty("outputChannels", plugin->getTotalNumOutputChannels());
    obj->setProperty("inputBuses", plugin->getBusCount(true));
    obj->setProperty("outputBuses", plugin->getBusCount(false));

    if (auto* instance = dynamic_cast<juce::AudioPluginInstance*>(plugin.get()))
    {
        juce::PluginDescription desc;
        instance->fillInPluginDescription(desc);
        obj->setProperty("pluginFormat", desc.pluginFormatName.toLowerCase());
        obj->setProperty("isInstrument", desc.isInstrument);
    }
    else
    {
        obj->setProperty("pluginFormat", juce::String());
        obj->setProperty("isInstrument", false);
    }

    return juce::var(obj);
}

juce::var AudioEngine::getPluginCompatibilityMatrix()
{
    juce::Array<juce::var> rows;
    auto plugins = pluginManager.getAvailablePlugins();

    for (const auto& plugin : plugins)
    {
        auto caps = getPluginCapabilities(plugin.fileOrIdentifier);
        if (auto* obj = caps.getDynamicObject())
        {
            obj->setProperty("scanName", plugin.name);
            obj->setProperty("scanManufacturer", plugin.manufacturerName);
            obj->setProperty("scanCategory", plugin.category);
            obj->setProperty("scanHasARA", plugin.hasARAExtension);
        }
        rows.add(caps);
    }

    auto* root = new juce::DynamicObject();
    root->setProperty("plugins", rows);
    root->setProperty("processingPrecision", getProcessingPrecision());
    root->setProperty("count", rows.size());
    root->setProperty("hasMidiDiagnostics", true);
    root->setProperty("hasBenchmarks", true);
    root->setProperty("hybrid64Enabled", processingPrecisionMode == ProcessingPrecisionMode::Hybrid64);
    return juce::var(root);
}

juce::var AudioEngine::runEngineBenchmarks()
{
    auto* root = new juce::DynamicObject();

    struct PluginStateBackup
    {
        juce::AudioProcessor* processor = nullptr;
        juce::MemoryBlock state;
    };

    std::vector<PluginStateBackup> backups;
    auto backupProcessor = [&backups](juce::AudioProcessor* proc)
    {
        if (proc == nullptr)
            return;

        PluginStateBackup backup;
        backup.processor = proc;
        {
            const juce::ScopedLock processorLock(proc->getCallbackLock());
            proc->getStateInformation(backup.state);
        }
        backups.push_back(std::move(backup));
    };

    const juce::String originalPrecision = getProcessingPrecision();
    const double sr = currentSampleRate > 0.0 ? currentSampleRate : 44100.0;
    const std::array<int, 3> benchmarkBlockSizes { 32, 64, 256 };
    const int iterations = 16;
    DesiredFXStageSpec masterSpec;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        for (const auto& [trackId, track] : trackMap)
        {
            juce::ignoreUnused(trackId);
            if (!track)
                continue;

            for (int fx = 0; fx < track->getNumInputFX(); ++fx)
                backupProcessor(track->getInputFXProcessor(fx));
            for (int fx = 0; fx < track->getNumTrackFX(); ++fx)
                backupProcessor(track->getTrackFXProcessor(fx));
            backupProcessor(track->getInstrument());
        }

        masterSpec = desiredMasterStageSpec;
    }
    syncStageSpecStateFromActive(masterSpec, std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire));

    auto runMode = [&](const juce::String& mode) -> juce::var
    {
        setProcessingPrecision(mode);
        auto* result = new juce::DynamicObject();
        result->setProperty("mode", mode);
        result->setProperty("sampleRate", sr);
        result->setProperty("trackCount", static_cast<int>(trackOrder.size()));
        result->setProperty("masterFxCount", static_cast<int>(masterSpec.slots.size()));
        result->setProperty("iterationsPerRun", iterations);

        juce::Array<juce::var> runResults;
        double totalElapsedMs = 0.0;

        for (int benchmarkBlockSize : benchmarkBlockSizes)
        {
            const int preparedBlockSize = juce::jmax(benchmarkBlockSize, 512);
            for (const auto& [trackId, track] : trackMap)
            {
                juce::ignoreUnused(trackId);
                if (track != nullptr)
                    track->prepareToPlay(sr, preparedBlockSize);
            }

            juce::String stageError;
            auto benchmarkMasterStage = buildActiveFXStage(masterSpec, sr, preparedBlockSize, processingPrecisionMode, false, stageError);
            if (!benchmarkMasterStage)
            {
                result->setProperty("stageBuildError", stageError);
                break;
            }

            juce::AudioBuffer<float> trackBuffer(2, benchmarkBlockSize);
            juce::AudioBuffer<float> masterBuffer(2, benchmarkBlockSize);
            juce::AudioBuffer<double> masterBufferDouble(2, benchmarkBlockSize);
            juce::MidiBuffer midi;
            const bool benchmarkHybrid64 = processingPrecisionMode == ProcessingPrecisionMode::Hybrid64;

            auto start = juce::Time::getMillisecondCounterHiRes();
            for (int iteration = 0; iteration < iterations; ++iteration)
            {
                masterBuffer.clear();
                masterBufferDouble.clear();

                for (const auto& trackId : trackOrder)
                {
                    auto it = trackMap.find(trackId);
                    if (it == trackMap.end() || !it->second)
                        continue;

                    auto* track = it->second;
                    trackBuffer.clear();
                    midi.clear();
                    track->setCurrentBlockPosition(static_cast<double>(iteration * benchmarkBlockSize), sr);
                    track->buildMidiBuffer(midi, 0.0, benchmarkBlockSize, sr, false);
                    track->processBlock(trackBuffer, midi);
                    if (benchmarkHybrid64)
                    {
                        for (int ch = 0; ch < 2; ++ch)
                        {
                            auto* dest = masterBufferDouble.getWritePointer(ch);
                            auto* src = trackBuffer.getReadPointer(ch);
                            for (int sample = 0; sample < benchmarkBlockSize; ++sample)
                                dest[sample] += static_cast<double>(src[sample]);
                        }
                    }
                    else
                    {
                        masterBuffer.addFrom(0, 0, trackBuffer, 0, 0, benchmarkBlockSize);
                        masterBuffer.addFrom(1, 0, trackBuffer, 1, 0, benchmarkBlockSize);
                    }
                }

                juce::MidiBuffer dummyMidi;
                for (const auto& slot : benchmarkMasterStage->slots)
                {
                    if (!slot.processor || slot.bypassed)
                        continue;

                    auto* proc = slot.processor.get();
                    const bool useDoublePrecision = benchmarkHybrid64
                                                 && !slot.forceFloat
                                                 && slot.supportsDouble
                                                 && proc->getTotalNumInputChannels() <= masterBufferDouble.getNumChannels()
                                                 && proc->getTotalNumOutputChannels() <= masterBufferDouble.getNumChannels();

                    if (useDoublePrecision)
                    {
                        proc->processBlock(masterBufferDouble, dummyMidi);
                    }
                    else
                    {
                        if (benchmarkHybrid64)
                            copyDoubleBufferToFloatBuffer(masterBufferDouble, masterBuffer, 2, benchmarkBlockSize);

                        proc->processBlock(masterBuffer, dummyMidi);

                        if (benchmarkHybrid64)
                            copyFloatBufferToDoubleBuffer(masterBuffer, masterBufferDouble, 2, benchmarkBlockSize);
                    }
                }
            }
            auto elapsedMs = juce::Time::getMillisecondCounterHiRes() - start;
            totalElapsedMs += elapsedMs;

            auto* run = new juce::DynamicObject();
            run->setProperty("blockSize", benchmarkBlockSize);
            run->setProperty("preparedBlockSize", preparedBlockSize);
            run->setProperty("elapsedMs", elapsedMs);
            run->setProperty("avgMsPerBlock", elapsedMs / static_cast<double>(iterations));
            run->setProperty("peakMagnitude", benchmarkHybrid64
                ? findPeakInDoubleBuffer(masterBufferDouble, 2, benchmarkBlockSize)
                : juce::jmax(masterBuffer.getMagnitude(0, 0, benchmarkBlockSize),
                             masterBuffer.getMagnitude(1, 0, benchmarkBlockSize)));
            runResults.add(juce::var(run));
        }

        result->setProperty("runs", runResults);
        result->setProperty("elapsedMs", totalElapsedMs);
        result->setProperty("avgMsPerBlock", totalElapsedMs / static_cast<double>(iterations * benchmarkBlockSizes.size()));
        return juce::var(result);
    };

    juce::Array<juce::var> results;
    results.add(runMode("float32"));
    results.add(runMode("hybrid64"));

    for (auto& backup : backups)
    {
        if (backup.processor)
        {
            const juce::ScopedLock processorLock(backup.processor->getCallbackLock());
            backup.processor->setStateInformation(backup.state.getData(),
                                                  static_cast<int>(backup.state.getSize()));
            backup.processor->reset();
        }
    }

    setProcessingPrecision(originalPrecision);

    root->setProperty("results", results);
    root->setProperty("pluginCount", static_cast<int>(pluginManager.getAvailablePlugins().size()));
    root->setProperty("processingPrecision", getProcessingPrecision());
    root->setProperty("midiLateEventCount", midiLateEventCount.load(std::memory_order_relaxed));
    root->setProperty("midiMaxEventsPerBlock", midiMaxEventsPerBlock.load(std::memory_order_relaxed));
    return juce::var(root);
}

void AudioEngine::setProcessingPrecision(const juce::String& precisionModeString)
{
    ProcessingPrecisionMode newMode = precisionModeString == "hybrid64"
        ? ProcessingPrecisionMode::Hybrid64
        : ProcessingPrecisionMode::Float32;

    processingPrecisionMode = newMode;

    for (const auto& [trackId, track] : trackMap)
    {
        juce::ignoreUnused(trackId);
        if (track != nullptr)
            applyProcessingPrecisionToTrack(*track);
    }

    publishMasterStageSpec(desiredMasterStageSpec);
    publishMonitoringStageSpec(desiredMonitoringStageSpec);
}

juce::String AudioEngine::getProcessingPrecision() const
{
    return processingPrecisionMode == ProcessingPrecisionMode::Hybrid64 ? "hybrid64" : "float32";
}

bool AudioEngine::setTrackPluginPrecisionOverride(const juce::String& trackId, int fxIndex, bool isInputFX, const juce::String& mode)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    const bool forceFloat = mode == "float32";
    if (isInputFX)
        it->second->setInputFXPrecisionOverride(fxIndex, forceFloat);
    else
        it->second->setTrackFXPrecisionOverride(fxIndex, forceFloat);
    return true;
}

bool AudioEngine::setInstrumentPrecisionOverride(const juce::String& trackId, const juce::String& mode)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    it->second->setInstrumentPrecisionOverride(mode == "float32");
    return true;
}

bool AudioEngine::setMasterFXPrecisionOverride(int fxIndex, const juce::String& mode)
{
    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMasterStageSpec;
    }

    syncStageSpecStateFromActive(specCopy, std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire));
    auto* slot = findDesiredStageSlot(specCopy, fxIndex);
    if (slot == nullptr)
        return false;

    slot->forceFloat = (mode == "float32");
    return publishMasterStageSpec(specCopy);
}

bool AudioEngine::setMonitoringFXPrecisionOverride(int fxIndex, const juce::String& mode)
{
    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMonitoringStageSpec;
    }

    syncStageSpecStateFromActive(specCopy, std::atomic_load_explicit(&realtimeMonitoringFXSnapshot, std::memory_order_acquire));
    auto* slot = findDesiredStageSlot(specCopy, fxIndex);
    if (slot == nullptr)
        return false;

    slot->forceFloat = (mode == "float32");
    return publishMonitoringStageSpec(specCopy);
}

juce::var AudioEngine::runReleaseGuardrails()
{
    auto midiDiagnostics = getMidiDiagnostics();
    auto compatibility = getPluginCompatibilityMatrix();
    auto benchmarks = runEngineBenchmarks();

    auto* root = new juce::DynamicObject();
    juce::Array<juce::var> checks;
    bool overallPass = true;

    auto addCheck = [&checks, &overallPass](const juce::String& id, bool pass, const juce::String& detail)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("id", id);
        obj->setProperty("pass", pass);
        obj->setProperty("detail", detail);
        checks.add(juce::var(obj));
        if (!pass)
            overallPass = false;
    };

    if (auto* midiObj = midiDiagnostics.getDynamicObject())
    {
        const int lateEvents = static_cast<int>(midiObj->getProperty("lateEventCount"));
        const int maxEvents = static_cast<int>(midiObj->getProperty("maxEventsPerBlock"));
        const int masterFallbacks = static_cast<int>(midiObj->getProperty("masterFXFallbackReuseCount"));
        const int monitoringFallbacks = static_cast<int>(midiObj->getProperty("monitoringFXFallbackReuseCount"));
        const int masterBusySkips = static_cast<int>(midiObj->getProperty("masterFXBusySkipCount"));
        const int monitoringBusySkips = static_cast<int>(midiObj->getProperty("monitoringFXBusySkipCount"));
        int trackFallbacks = 0;
        int trackCount = 0;
        if (auto tracks = midiObj->getProperty("tracks"); tracks.isArray())
        {
            trackCount = tracks.getArray()->size();
            for (const auto& track : *tracks.getArray())
            {
                if (auto* trackObj = track.getDynamicObject())
                    trackFallbacks += static_cast<int>(trackObj->getProperty("realtimeFallbackReuseCount"));
            }
        }
        addCheck("midi_diagnostics_available", true, "MIDI diagnostics API returned data");
        addCheck("midi_late_events_clear", lateEvents == 0,
                 "lateEventCount=" + juce::String(lateEvents) + ", maxEventsPerBlock=" + juce::String(maxEvents));
        addCheck("realtime_track_fallbacks_clear", trackFallbacks == 0,
                 "trackFallbackReuseCount=" + juce::String(trackFallbacks) + ", trackCount=" + juce::String(trackCount));
        addCheck("realtime_master_fallbacks_clear", masterFallbacks == 0,
                 "masterFXFallbackReuseCount=" + juce::String(masterFallbacks));
        addCheck("realtime_monitoring_fallbacks_clear", monitoringFallbacks == 0,
                 "monitoringFXFallbackReuseCount=" + juce::String(monitoringFallbacks));
        addCheck("realtime_master_busy_skips_clear", masterBusySkips == 0,
                 "masterFXBusySkipCount=" + juce::String(masterBusySkips));
        addCheck("realtime_monitoring_busy_skips_clear", monitoringBusySkips == 0,
                 "monitoringFXBusySkipCount=" + juce::String(monitoringBusySkips));
    }
    else
    {
        addCheck("midi_diagnostics_available", false, "MIDI diagnostics payload missing");
    }

    if (auto* compatObj = compatibility.getDynamicObject())
    {
        auto plugins = compatObj->getProperty("plugins");
        int pluginCount = plugins.isArray() ? plugins.getArray()->size() : 0;
        addCheck("compatibility_matrix_available", pluginCount >= 0,
                 "pluginCount=" + juce::String(pluginCount));
        bool capabilityFieldsPresent = true;
        if (plugins.isArray())
        {
            for (const auto& plugin : *plugins.getArray())
            {
                auto* pluginObj = plugin.getDynamicObject();
                if (pluginObj == nullptr
                    || !pluginObj->hasProperty("pluginFormat")
                    || !pluginObj->hasProperty("supportsDoublePrecision")
                    || !pluginObj->hasProperty("isInstrument")
                    || !pluginObj->hasProperty("producesMidi"))
                {
                    capabilityFieldsPresent = false;
                    break;
                }
            }
        }
        addCheck("compatibility_capabilities_complete", capabilityFieldsPresent,
                 "pluginsChecked=" + juce::String(pluginCount));
    }
    else
    {
        addCheck("compatibility_matrix_available", false, "Compatibility matrix payload missing");
        addCheck("compatibility_capabilities_complete", false, "Compatibility matrix payload missing");
    }

    if (auto* benchObj = benchmarks.getDynamicObject())
    {
        auto results = benchObj->getProperty("results");
        int resultCount = results.isArray() ? results.getArray()->size() : 0;
        addCheck("benchmark_matrix_available", resultCount >= 2,
                 "modeCount=" + juce::String(resultCount));
        bool benchmarkBlockCoverage = true;
        bool benchmarkValuesFinite = true;
        if (results.isArray())
        {
            for (const auto& result : *results.getArray())
            {
                auto* resultObj = result.getDynamicObject();
                if (resultObj == nullptr)
                {
                    benchmarkBlockCoverage = false;
                    benchmarkValuesFinite = false;
                    continue;
                }

                bool has32 = false;
                bool has64 = false;
                bool has256 = false;
                auto runs = resultObj->getProperty("runs");
                if (!runs.isArray())
                {
                    benchmarkBlockCoverage = false;
                    benchmarkValuesFinite = false;
                    continue;
                }

                for (const auto& run : *runs.getArray())
                {
                    auto* runObj = run.getDynamicObject();
                    if (runObj == nullptr)
                    {
                        benchmarkValuesFinite = false;
                        continue;
                    }

                    const int blockSize = static_cast<int>(runObj->getProperty("blockSize"));
                    const double avgMs = static_cast<double>(runObj->getProperty("avgMsPerBlock"));
                    const double peakMagnitude = static_cast<double>(runObj->getProperty("peakMagnitude"));
                    has32 = has32 || blockSize == 32;
                    has64 = has64 || blockSize == 64;
                    has256 = has256 || blockSize == 256;
                    if (!std::isfinite(avgMs) || avgMs < 0.0 || !std::isfinite(peakMagnitude))
                        benchmarkValuesFinite = false;
                }

                benchmarkBlockCoverage = benchmarkBlockCoverage && has32 && has64 && has256;
            }
        }
        addCheck("benchmark_block_coverage_complete", benchmarkBlockCoverage,
                 "expectedBlockSizes=32,64,256");
        addCheck("benchmark_values_finite", benchmarkValuesFinite,
                 "checkedModeCount=" + juce::String(resultCount));
    }
    else
    {
        addCheck("benchmark_matrix_available", false, "Benchmark payload missing");
        addCheck("benchmark_block_coverage_complete", false, "Benchmark payload missing");
        addCheck("benchmark_values_finite", false, "Benchmark payload missing");
    }

    root->setProperty("overallPass", overallPass);
    root->setProperty("processingPrecision", getProcessingPrecision());
    root->setProperty("checks", checks);
    root->setProperty("midiDiagnostics", midiDiagnostics);
    root->setProperty("compatibility", compatibility);
    root->setProperty("benchmarks", benchmarks);
    return juce::var(root);
}

juce::var AudioEngine::runAutomatedRegressionSuite()
{
    auto releaseGuardrails = runReleaseGuardrails();
    auto* root = new juce::DynamicObject();
    juce::Array<juce::var> suites;
    bool overallPass = true;

    auto addSuite = [&suites, &overallPass](const juce::String& id, bool pass, const juce::String& detail)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("id", id);
        obj->setProperty("pass", pass);
        obj->setProperty("detail", detail);
        suites.add(juce::var(obj));
        if (!pass)
            overallPass = false;
    };

    if (auto* guardrailObj = releaseGuardrails.getDynamicObject())
    {
        const bool guardrailsPass = static_cast<bool>(guardrailObj->getProperty("overallPass"));
        addSuite("release_guardrails", guardrailsPass,
                 "overallPass=" + juce::String(guardrailsPass ? "true" : "false"));

        auto benchmarks = guardrailObj->getProperty("benchmarks");
        if (auto* benchObj = benchmarks.getDynamicObject())
        {
            auto results = benchObj->getProperty("results");
            bool modesComparable = true;
            double floatAvg = -1.0;
            double hybridAvg = -1.0;
            if (results.isArray())
            {
                for (const auto& result : *results.getArray())
                {
                    auto* resultObj = result.getDynamicObject();
                    if (resultObj == nullptr)
                    {
                        modesComparable = false;
                        continue;
                    }

                    const juce::String mode = resultObj->getProperty("mode").toString();
                    const double avgMs = static_cast<double>(resultObj->getProperty("avgMsPerBlock"));
                    if (!std::isfinite(avgMs) || avgMs < 0.0)
                    {
                        modesComparable = false;
                        continue;
                    }

                    if (mode == "float32")
                        floatAvg = avgMs;
                    else if (mode == "hybrid64")
                        hybridAvg = avgMs;
                }
            }
            else
            {
                modesComparable = false;
            }

            modesComparable = modesComparable && floatAvg >= 0.0 && hybridAvg >= 0.0;
            addSuite("precision_benchmark_matrix", modesComparable,
                     "float32AvgMs=" + juce::String(floatAvg) + ", hybrid64AvgMs=" + juce::String(hybridAvg));
        }
        else
        {
            addSuite("precision_benchmark_matrix", false, "Benchmark payload missing");
        }

        auto compatibility = guardrailObj->getProperty("compatibility");
        if (auto* compatObj = compatibility.getDynamicObject())
        {
            auto plugins = compatObj->getProperty("plugins");
            bool metadataConsistent = true;
            int pluginCount = 0;
            int doubleCapableCount = 0;
            if (plugins.isArray())
            {
                pluginCount = plugins.getArray()->size();
                for (const auto& plugin : *plugins.getArray())
                {
                    auto* pluginObj = plugin.getDynamicObject();
                    if (pluginObj == nullptr)
                    {
                        metadataConsistent = false;
                        continue;
                    }

                    const bool supportsDouble = static_cast<bool>(pluginObj->getProperty("supportsDoublePrecision"));
                    const juce::String pluginFormat = pluginObj->getProperty("pluginFormat").toString();
                    if (pluginFormat.isEmpty())
                        metadataConsistent = false;
                    if (supportsDouble)
                        ++doubleCapableCount;
                }
            }
            else
            {
                metadataConsistent = false;
            }

            addSuite("plugin_capability_matrix", metadataConsistent,
                     "pluginCount=" + juce::String(pluginCount)
                         + ", doubleCapable=" + juce::String(doubleCapableCount));
        }
        else
        {
            addSuite("plugin_capability_matrix", false, "Compatibility payload missing");
        }
    }
    else
    {
        addSuite("release_guardrails", false, "Guardrail payload missing");
        addSuite("precision_benchmark_matrix", false, "Guardrail payload missing");
        addSuite("plugin_capability_matrix", false, "Guardrail payload missing");
    }

    root->setProperty("overallPass", overallPass);
    root->setProperty("processingPrecision", getProcessingPrecision());
    root->setProperty("suites", suites);
    root->setProperty("releaseGuardrails", releaseGuardrails);
    return juce::var(root);
}

bool AudioEngine::addTrackInputFX(const juce::String& trackId, const juce::String& pluginPath, bool openEditor)
{
    // Load plugin BEFORE acquiring the lock (can take hundreds of ms).
    // Use actual device sample rate so the plugin initialises at the correct rate.
    // IMPORTANT: Use at least 512 for the max-block-size hint — ASIO buffers can be
    // as small as 32 samples, but prepareToPlay(sr, 32) forces plugins like Amplitube
    // to resize their internal DSP (FFT/convolution/cab sim) for tiny blocks, producing
    // crackling and distortion.  The plugin can still process 32-sample blocks fine when
    // prepared with a larger maximumExpectedSamplesPerBlock.
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
        return false;

    // Provide tempo/position info to the plugin
    plugin->setPlayHead (this);

    bool success = false;
    int fxIndex = -1;
    {
        // Hold the callback lock while modifying the FX node vectors
        // (audio thread iterates these in processBlock)
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            success = it->second->addInputFX(std::move(plugin), sr, bs);
            if (success)
                fxIndex = it->second->getNumInputFX() - 1;
        }
    }

    if (success && fxIndex >= 0)
    {
        if (openEditor)
            openPluginEditor(trackId, fxIndex, true);
        juce::Logger::writeToLog("AudioEngine: Added input FX" + juce::String(openEditor ? " and opened editor" : ""));
        recalculatePDC();
    }
    return success;
}

bool AudioEngine::addTrackFX(const juce::String& trackId, const juce::String& pluginPath, bool openEditor)
{
    // Load plugin BEFORE acquiring the lock (can take hundreds of ms).
    // Use actual device sample rate so the plugin initialises at the correct rate.
    // IMPORTANT: Clamp max-block-size to at least 512 — same rationale as addTrackInputFX.
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;

    logToDisk("AudioEngine::addTrackFX DIAGNOSTIC");
    logToDisk("  currentSampleRate=" + juce::String(currentSampleRate) +
              " currentBlockSize=" + juce::String(currentBlockSize));
    logToDisk("  creating plugin at sr=" + juce::String(sr) + " bs=" + juce::String(bs));

    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
        return false;

    logToDisk("  plugin created: " + plugin->getName() +
              " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
              " outCh=" + juce::String(plugin->getTotalNumOutputChannels()) +
              " pluginSr=" + juce::String(plugin->getSampleRate()) +
              " pluginBs=" + juce::String(plugin->getBlockSize()));

    // Provide tempo/position info to the plugin
    plugin->setPlayHead (this);

    bool success = false;
    int fxIndex = -1;
    {
        // Hold the callback lock while modifying the FX node vectors
        // (audio thread iterates these in processBlock)
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            success = it->second->addTrackFX(std::move(plugin), sr, bs);
            if (success)
                fxIndex = it->second->getNumTrackFX() - 1;
        }
    }

    if (success && fxIndex >= 0)
    {
        recalculatePDC();

        // Try ARA initialization for any VST3 plugin. ARA factory creation
        // succeeds for ARA plugins and fails gracefully for non-ARA ones.
        // Don't rely on hasARAExtension — cached scan data may lack the flag.
        //
        // IMPORTANT: For ARA plugins, do NOT open the editor here.
        // The frontend must add clips to the ARA document BEFORE the editor opens,
        // otherwise the editor launches with an empty document and won't show notes.
        // Non-ARA plugins open the editor immediately via the callback.
        auto trackIdCopy = trackId;
        int fxIndexCopy = fxIndex;
        bool openEditorCopy = openEditor;

        auto it2 = trackMap.find(trackId);
        if (it2 != trackMap.end() && it2->second)
        {
            logToDisk("  Trying ARA init for plugin at index " + juce::String(fxIndex));
            it2->second->initializeARA(fxIndex, currentSampleRate > 0 ? currentSampleRate : 44100.0,
                currentBlockSize > 0 ? currentBlockSize : 512,
                [this, trackIdCopy, fxIndexCopy, openEditorCopy] (bool araSuccess, bool pluginSupportsARA, const juce::String& errorMessage) {
                    if (araSuccess)
                    {
                        logToDisk("  ARA initialized OK for FX " + juce::String(fxIndexCopy)
                            + " — editor will be opened by frontend");
                        // Re-propagate AudioEngine playhead to all plugins on this track.
                        // ARA init may have changed the plugin's playhead reference;
                        // ensure all plugins use AudioEngine's full-featured playhead.
                        auto araIt = trackMap.find(trackIdCopy);
                        if (araIt != trackMap.end())
                            propagatePlayHead(araIt->second);
                    }
                    else
                    {
                        logToDisk("  ARA init result for FX " + juce::String(fxIndexCopy)
                            + " supportsARA=" + juce::String(pluginSupportsARA ? 1 : 0)
                            + " error=" + errorMessage);
                        if (openEditorCopy && !pluginSupportsARA)
                        {
                            juce::MessageManager::callAsync([this, trackIdCopy, fxIndexCopy] {
                                openPluginEditor(trackIdCopy, fxIndexCopy, false);
                            });
                        }
                    }
                });
        }
        else
        {
            logToDisk("  Track not found for ARA check, opening editor directly");
            if (openEditor)
                openPluginEditor(trackId, fxIndex, false);
        }

        logToDisk("  addTrackFX complete (ARA check pending)");
    }
    return success;
}

//==============================================================================
// Built-in Effects (Phase 4.3)

static std::unique_ptr<juce::AudioProcessor> createBuiltInEffect(const juce::String& name)
{
    if (name == "S13 EQ" || name == "OpenStudio EQ")                   return std::make_unique<S13EQ>();
    if (name == "S13 Compressor" || name == "OpenStudio Compressor")   return std::make_unique<S13Compressor>();
    if (name == "S13 Gate" || name == "OpenStudio Gate")               return std::make_unique<S13Gate>();
    if (name == "S13 Limiter" || name == "OpenStudio Limiter")         return std::make_unique<S13Limiter>();
    if (name == "S13 Delay" || name == "OpenStudio Delay")             return std::make_unique<S13Delay>();
    if (name == "S13 Reverb" || name == "OpenStudio Reverb")           return std::make_unique<S13Reverb>();
    if (name == "S13 Chorus" || name == "OpenStudio Chorus")           return std::make_unique<S13Chorus>();
    if (name == "S13 Saturator" || name == "OpenStudio Saturator")     return std::make_unique<S13Saturator>();
    if (name == "S13 Pitch Correct" || name == "OpenStudio Pitch Correct") return std::make_unique<S13PitchCorrector>();
    return nullptr;
}

bool AudioEngine::addTrackBuiltInFX(const juce::String& trackId, const juce::String& effectName, bool isInputFX)
{
    auto plugin = createBuiltInEffect(effectName);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Unknown built-in effect: " + effectName);
        return false;
    }

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    plugin->setPlayHead(this);
    prepareHostedProcessorForPrecision(plugin.get(), sr, bs, processingPrecisionMode);

    bool success = false;
    int fxIndex = -1;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            if (isInputFX)
            {
                success = it->second->addInputFX(std::move(plugin), sr, bs);
                if (success)
                    fxIndex = it->second->getNumInputFX() - 1;
            }
            else
            {
                success = it->second->addTrackFX(std::move(plugin), sr, bs);
                if (success)
                    fxIndex = it->second->getNumTrackFX() - 1;
            }
        }
    }

    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Added built-in FX '" + effectName + "' to track " + trackId);
        recalculatePDC();
    }
    return success;
}

bool AudioEngine::addMasterBuiltInFX(const juce::String& effectName)
{
    auto plugin = createBuiltInEffect(effectName);
    if (!plugin)
        return false;

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    plugin->setPlayHead(this);
    prepareHostedProcessorForPrecision(plugin.get(), sr, bs, processingPrecisionMode);

    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMasterStageSpec;
    }

    DesiredFXStageSlot slot;
    slot.slotId = nextMasterStageSlotId++;
    slot.name = plugin->getName();
    slot.type = "builtin";
    slot.pluginFormat = "Built-in";
    slot.serializedState = serialiseProcessorStateToBase64(plugin.get());
    specCopy.slots.push_back(std::move(slot));

    if (!publishMasterStageSpec(specCopy))
        return false;

    juce::Logger::writeToLog("AudioEngine: Added built-in master FX '" + effectName + "'");
    return true;
}

juce::var AudioEngine::getAvailableBuiltInFX()
{
    juce::Array<juce::var> list;
    const char* names[] = { "OpenStudio EQ", "OpenStudio Compressor", "OpenStudio Gate", "OpenStudio Limiter",
                            "OpenStudio Delay", "OpenStudio Reverb", "OpenStudio Chorus", "OpenStudio Saturator",
                            "OpenStudio Pitch Correct" };
    for (auto& n : names)
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty("name", juce::String(n));
        obj->setProperty("category", "Built-in");
        list.add(juce::var(obj.get()));
    }
    return juce::var(list);
}

//==============================================================================
// S13FX (JSFX) Management

bool AudioEngine::addTrackS13FX(const juce::String& trackId, const juce::String& scriptPath, bool isInputFX)
{
    // Create S13FXProcessor and load script BEFORE acquiring the lock
    auto s13fx = std::make_unique<S13FXProcessor>();
    if (!s13fx->loadScript(scriptPath))
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load S13FX script: " + scriptPath);
        return false;
    }

    // Provide tempo/position info
    s13fx->setPlayHead(this);

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;

    bool success = false;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            if (isInputFX)
                success = it->second->addInputFX(std::move(s13fx), sr, bs);
            else
                success = it->second->addTrackFX(std::move(s13fx), sr, bs);
        }
    }

    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Added S13FX to " + juce::String(isInputFX ? "input" : "track") + " chain: " + scriptPath);
        recalculatePDC();
    }

    return success;
}

bool AudioEngine::addMasterS13FX(const juce::String& scriptPath)
{
    auto s13fx = std::make_unique<S13FXProcessor>();
    if (!s13fx->loadScript(scriptPath))
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load S13FX for master: " + scriptPath);
        return false;
    }

    s13fx->setPlayHead(this);

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;

    prepareHostedProcessorForPrecision(s13fx.get(), sr, bs, processingPrecisionMode);

    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMasterStageSpec;
    }

    DesiredFXStageSlot slot;
    slot.slotId = nextMasterStageSlotId++;
    slot.name = s13fx->getName();
    slot.type = "s13fx";
    slot.pluginPath = scriptPath;
    slot.pluginFormat = "S13FX";
    slot.serializedState = serialiseProcessorStateToBase64(s13fx.get());
    specCopy.slots.push_back(std::move(slot));

    if (!publishMasterStageSpec(specCopy))
        return false;

    juce::Logger::writeToLog("AudioEngine: Added S13FX to master chain: " + scriptPath);
    return true;
}

juce::var AudioEngine::getS13FXSliders(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    juce::Array<juce::var> sliderList;

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return sliderList;

    auto* track = it->second;
    juce::AudioProcessor* proc = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return sliderList;

    auto* s13fx = dynamic_cast<S13FXProcessor*>(proc);
    if (!s13fx)
        return sliderList;

    auto sliders = s13fx->getSliders();
    for (const auto& s : sliders)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("index", static_cast<int>(s.index));
        obj->setProperty("name", s.name);
        obj->setProperty("min", s.min);
        obj->setProperty("max", s.max);
        obj->setProperty("def", s.def);
        obj->setProperty("inc", s.inc);
        obj->setProperty("value", s.value);
        obj->setProperty("isEnum", s.isEnum);

        if (s.isEnum)
        {
            juce::Array<juce::var> names;
            for (const auto& n : s.enumNames)
                names.add(n);
            obj->setProperty("enumNames", names);
        }

        sliderList.add(juce::var(obj));
    }

    return sliderList;
}

bool AudioEngine::setS13FXSlider(const juce::String& trackId, int fxIndex, bool isInputFX, int sliderIndex, double value)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    auto* track = it->second;
    juce::AudioProcessor* proc = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return false;

    auto* s13fx = dynamic_cast<S13FXProcessor*>(proc);
    if (!s13fx)
        return false;

    return s13fx->setSliderValue(static_cast<uint32_t>(sliderIndex), value);
}

bool AudioEngine::reloadS13FX(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    auto* track = it->second;
    juce::AudioProcessor* proc = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return false;

    auto* s13fx = dynamic_cast<S13FXProcessor*>(proc);
    if (!s13fx)
        return false;

    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    return s13fx->reloadScript();
}

juce::var AudioEngine::getAvailableS13FX()
{
    pluginManager.scanForS13FX();

    juce::Array<juce::var> list;
    for (const auto& info : pluginManager.getAvailableS13FX())
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("name", info.name);
        obj->setProperty("filePath", info.filePath);
        obj->setProperty("author", info.author);
        obj->setProperty("isStock", info.isStock);
        obj->setProperty("type", "s13fx");

        juce::Array<juce::var> tags;
        for (const auto& tag : info.tags)
            tags.add(tag);
        obj->setProperty("tags", tags);

        list.add(juce::var(obj));
    }

    return list;
}

//==============================================================================
// Lua Scripting (S13Script)

juce::var AudioEngine::runScript(const juce::String& scriptPath)
{
    auto* result = new juce::DynamicObject();
    bool success = scriptEngine.loadAndRun(scriptPath);
    result->setProperty("success", success);
    result->setProperty("output", scriptEngine.getLastOutput());
    if (!success)
        result->setProperty("error", scriptEngine.getLastError());

    // Start defer timer if script registered a deferred callback
    if (scriptEngine.hasDeferredCallback() && !isTimerRunning())
        startTimerHz(30);

    return juce::var(result);
}

juce::var AudioEngine::runScriptCode(const juce::String& luaCode)
{
    auto* result = new juce::DynamicObject();
    bool success = scriptEngine.executeString(luaCode);
    result->setProperty("success", success);
    result->setProperty("output", scriptEngine.getLastOutput());
    if (!success)
        result->setProperty("error", scriptEngine.getLastError());

    // Start defer timer if script registered a deferred callback
    if (scriptEngine.hasDeferredCallback() && !isTimerRunning())
        startTimerHz(30);

    return juce::var(result);
}

void AudioEngine::timerCallback()
{
    if (!scriptEngine.runDeferredCallback())
    {
        // No more deferred callbacks — stop the timer
        stopTimer();
    }
}

juce::String AudioEngine::getScriptDirectory()
{
    return ScriptEngine::getUserScriptsDirectory().getFullPathName();
}

juce::var AudioEngine::listScripts()
{
    auto scripts = scriptEngine.listAvailableScripts();
    juce::Array<juce::var> list;

    for (const auto& info : scripts)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("name", info.name);
        obj->setProperty("filePath", info.filePath);
        obj->setProperty("description", info.description);
        obj->setProperty("isStock", info.isStock);
        list.add(juce::var(obj));
    }

    return list;
}

//==============================================================================
// Plugin Editor Windows (Phase 3)

void AudioEngine::setPluginWindowOwnerComponent(juce::Component* component)
{
    pluginWindowManager.setMainWindowComponent(component);
}

void AudioEngine::setPluginWindowShortcutForwardCallback(PluginWindowManager::ShortcutForwardCallback callback)
{
    pluginWindowManager.setShortcutForwardCallback(std::move(callback));
}

void AudioEngine::openPluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    auto* track = trackMap[trackId];
    if (!track)
        return;
    
    juce::AudioProcessor* processor = nullptr;
    juce::String windowTitle;
    
    // Calculate display index (1-based)
    int displayIndex = getTrackIndex(trackId) + 1;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
        {
            processor = track->getInputFXProcessor(fxIndex);
            windowTitle = "Track " + juce::String(displayIndex) + " - " + processor->getName();
        }
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
        {
            processor = track->getTrackFXProcessor(fxIndex);
            windowTitle = "Track " + juce::String(displayIndex) + " - " + processor->getName();
        }
    }

    if (processor)
    {
        // Defer window creation to next message-loop cycle — creating a native
        // DocumentWindow from inside a WebView2 NativeFunction callback can cause
        // re-entrancy crashes with the Windows message pump.
        PluginWindowManager::PluginEditorTarget target;
        target.scope = isInputFX
            ? PluginWindowManager::PluginEditorTarget::Scope::TrackInputFX
            : PluginWindowManager::PluginEditorTarget::Scope::TrackFX;
        target.trackId = trackId;
        target.fxIndex = fxIndex;
        auto* proc = processor;
        auto title = windowTitle;
        juce::MessageManager::callAsync([this, proc, title, target]()
        {
            pluginWindowManager.openEditor(proc, title, target);
        });
    }
    else
    {
        juce::Logger::writeToLog("AudioEngine::openPluginEditor - No processor found for track " + trackId
                                 + " fxIndex=" + juce::String(fxIndex) + " isInputFX=" + juce::String(isInputFX ? "true" : "false"));
    }
}

void AudioEngine::openInstrumentEditor(const juce::String& trackId)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;

    auto* track = trackMap[trackId];
    if (!track)
        return;

    auto* instrument = track->getInstrument();
    if (instrument)
    {
        int displayIndex = getTrackIndex(trackId) + 1;
        juce::String windowTitle = "Track " + juce::String(displayIndex) + " - " + instrument->getName();
        auto* proc = instrument;
        auto title = windowTitle;
        PluginWindowManager::PluginEditorTarget target;
        target.scope = PluginWindowManager::PluginEditorTarget::Scope::Instrument;
        target.trackId = trackId;
        juce::MessageManager::callAsync([this, proc, title, target]()
        {
            pluginWindowManager.openEditor(proc, title, target);
        });
    }
}

void AudioEngine::closePluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    auto* track = trackMap[trackId];
    if (!track)
        return;
    
    juce::AudioProcessor* processor = nullptr;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }
    
    if (processor)
    {
        pluginWindowManager.closeEditor(processor);
        juce::Logger::writeToLog("AudioEngine: Closed plugin editor");
    }
}

void AudioEngine::closeAllPluginWindows()
{
    pluginWindowManager.closeAllEditorsSync();
}

//==============================================================================
// Built-in FX Preset System

static juce::File getPresetsDir(const juce::String& pluginName)
{
    auto appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
    return appDir.getChildFile("presets").getChildFile(pluginName.replace(" ", "_"));
}

juce::var AudioEngine::getBuiltInFXPresets(const juce::String& pluginName)
{
    juce::Array<juce::var> presetList;

    auto dir = getPresetsDir(pluginName);
    if (!dir.exists())
        return presetList;

    auto files = dir.findChildFiles(juce::File::findFiles, false, "*.ospreset");
    files.addArray(dir.findChildFiles(juce::File::findFiles, false, "*.s13preset"));
    files.sort();

    for (auto& file : files)
    {
        juce::DynamicObject::Ptr preset = new juce::DynamicObject();
        preset->setProperty("name", file.getFileNameWithoutExtension());
        preset->setProperty("path", file.getFullPathName());
        presetList.add(juce::var(preset.get()));
    }

    return presetList;
}

bool AudioEngine::saveBuiltInFXPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                       const juce::String& presetName, bool isFactory)
{
    juce::ignoreUnused(isFactory);

    // Find the processor
    if (trackMap.find(trackId) == trackMap.end())
        return false;

    auto* track = trackMap[trackId];
    if (!track)
        return false;

    juce::AudioProcessor* processor = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!processor)
        return false;

    // Get state information
    juce::MemoryBlock stateData;
    processor->getStateInformation(stateData);

    // Save to file
    auto dir = getPresetsDir(processor->getName());
    dir.createDirectory();

    auto file = dir.getChildFile(presetName + ".ospreset");
    return file.replaceWithData(stateData.getData(), stateData.getSize());
}

bool AudioEngine::loadBuiltInFXPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                       const juce::String& presetName)
{
    if (trackMap.find(trackId) == trackMap.end())
        return false;

    auto* track = trackMap[trackId];
    if (!track)
        return false;

    juce::AudioProcessor* processor = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!processor)
        return false;

    auto dir = getPresetsDir(processor->getName());
    auto file = dir.getChildFile(presetName + ".ospreset");
    if (!file.existsAsFile())
        file = dir.getChildFile(presetName + ".s13preset");

    if (!file.existsAsFile())
        return false;

    juce::MemoryBlock stateData;
    if (!file.loadFileAsData(stateData))
        return false;

    processor->setStateInformation(stateData.getData(), static_cast<int>(stateData.getSize()));
    return true;
}

bool AudioEngine::deleteBuiltInFXPreset(const juce::String& pluginName, const juce::String& presetName)
{
    auto dir = getPresetsDir(pluginName);
    auto file = dir.getChildFile(presetName + ".ospreset");
    if (!file.existsAsFile())
        file = dir.getChildFile(presetName + ".s13preset");

    if (file.existsAsFile())
        return file.deleteFile();

    return false;
}

//==============================================================================
// Get loaded plugins info

juce::var AudioEngine::getTrackInputFX(const juce::String& trackId)
{
    juce::Array<juce::var> fxList;

    if (trackMap.find(trackId) == trackMap.end())
        return fxList;

    auto* track = trackMap[trackId];
    if (!track)
        return fxList;

    auto processors = track->getInputFXSnapshot();
    auto bypassSnapshot = track->getInputFXBypassSnapshot();
    auto precisionSnapshot = track->getInputFXPrecisionOverrideSnapshot();
    if (!processors)
        return fxList;

    for (int i = 0; i < static_cast<int>(processors->size()); ++i)
    {
        auto processor = processors->at(static_cast<size_t>(i));
        if (processor)
        {
            juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
            fxInfo->setProperty("index", i);
            fxInfo->setProperty("name", processor->getName());
            const bool bypassed = bypassSnapshot != nullptr && bypassSnapshot->count(i) > 0 && bypassSnapshot->at(i);
            const bool forceFloat = precisionSnapshot != nullptr && precisionSnapshot->count(i) > 0 && precisionSnapshot->at(i);
            fxInfo->setProperty("bypassed", bypassed);
            fxInfo->setProperty("precisionOverride", forceFloat ? "float32" : "auto");

            // Check type: built-in > S13FX > VST3
            auto* processorPtr = processor.get();
            if (dynamic_cast<S13BuiltInEffect*>(processorPtr)
                || dynamic_cast<S13Delay*>(processorPtr)
                || dynamic_cast<S13Reverb*>(processorPtr)
                || dynamic_cast<S13Chorus*>(processorPtr)
                || dynamic_cast<S13Saturator*>(processorPtr)
                || dynamic_cast<S13PitchCorrector*>(processorPtr))
            {
                fxInfo->setProperty("type", "builtin");
            }
            else if (auto* s13fx = dynamic_cast<S13FXProcessor*>(processorPtr))
            {
                fxInfo->setProperty("type", "s13fx");
                fxInfo->setProperty("pluginPath", s13fx->getScriptPath());
            }
            else if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(processorPtr))
            {
                auto desc = pluginInstance->getPluginDescription();
                fxInfo->setProperty("type", desc.pluginFormatName == "CLAP" ? "clap" : "vst3");
                fxInfo->setProperty("pluginPath", desc.fileOrIdentifier);
            }
            fxList.add(juce::var(fxInfo.get()));
        }
    }

    return fxList;
}

juce::var AudioEngine::getTrackFX(const juce::String& trackId)
{
    juce::Array<juce::var> fxList;

    if (trackMap.find(trackId) == trackMap.end())
        return fxList;

    auto* track = trackMap[trackId];
    if (!track)
        return fxList;

    auto processors = track->getTrackFXSnapshot();
    auto bypassSnapshot = track->getTrackFXBypassSnapshot();
    auto precisionSnapshot = track->getTrackFXPrecisionOverrideSnapshot();
    if (!processors)
        return fxList;

    for (int i = 0; i < static_cast<int>(processors->size()); ++i)
    {
        auto processor = processors->at(static_cast<size_t>(i));
        if (processor)
        {
            juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
            fxInfo->setProperty("index", i);
            fxInfo->setProperty("name", processor->getName());
            const bool bypassed = bypassSnapshot != nullptr && bypassSnapshot->count(i) > 0 && bypassSnapshot->at(i);
            const bool forceFloat = precisionSnapshot != nullptr && precisionSnapshot->count(i) > 0 && precisionSnapshot->at(i);
            fxInfo->setProperty("bypassed", bypassed);
            fxInfo->setProperty("precisionOverride", forceFloat ? "float32" : "auto");

            // Check type: built-in > S13FX > VST3
            auto* processorPtr = processor.get();
            if (dynamic_cast<S13BuiltInEffect*>(processorPtr)
                || dynamic_cast<S13Delay*>(processorPtr)
                || dynamic_cast<S13Reverb*>(processorPtr)
                || dynamic_cast<S13Chorus*>(processorPtr)
                || dynamic_cast<S13Saturator*>(processorPtr)
                || dynamic_cast<S13PitchCorrector*>(processorPtr))
            {
                fxInfo->setProperty("type", "builtin");
            }
            else if (auto* s13fx = dynamic_cast<S13FXProcessor*>(processorPtr))
            {
                fxInfo->setProperty("type", "s13fx");
                fxInfo->setProperty("pluginPath", s13fx->getScriptPath());
            }
            else if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(processorPtr))
            {
                auto desc = pluginInstance->getPluginDescription();
                fxInfo->setProperty("type", desc.pluginFormatName == "CLAP" ? "clap" : "vst3");
                fxInfo->setProperty("pluginPath", desc.fileOrIdentifier);
            }
            fxList.add(juce::var(fxInfo.get()));
        }
    }

    return fxList;
}

juce::var AudioEngine::getPluginParameters(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    juce::Array<juce::var> paramList;

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return paramList;

    auto* track = it->second;
    juce::AudioProcessor* processor = nullptr;

    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }

    if (!processor)
        return paramList;

    // Use the modern JUCE parameter API — skip internal MIDI CC parameters
    // (plugins like Amplitube expose CC 0-127 x 16 channels = 2048 internal params)
    const juce::ScopedLock processorLock(processor->getCallbackLock());
    const auto& params = processor->getParameters();
    for (int i = 0; i < params.size(); ++i)
    {
        auto* param = params[i];
        auto name = param->getName(128);

        // Filter out MIDI CC / internal mapping parameters (Reaper hides these too)
        auto nameLower = name.toLowerCase();
        if (nameLower.startsWith("midi cc") || nameLower.startsWith("cc #")
            || nameLower.contains("midi cc ") || nameLower.contains("midi ch"))
            continue;

        juce::DynamicObject::Ptr paramInfo = new juce::DynamicObject();
        paramInfo->setProperty("index", i);
        paramInfo->setProperty("name", name);
        paramInfo->setProperty("value", param->getValue());
        paramInfo->setProperty("text", param->getCurrentValueAsText());
        paramList.add(juce::var(paramInfo.get()));
    }

    return paramList;
}

void AudioEngine::removeTrackInputFX(const juce::String& trackId, int fxIndex)
{
    // Phase 1: Close editor window and release resources BEFORE acquiring lock.
    {
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            if (auto* proc = it->second->getInputFXProcessor(fxIndex))
            {
                pluginWindowManager.closeEditorSync(proc);
                proc->releaseResources();
            }
        }
    }

    // Phase 2: Acquire lock and remove.
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->removeInputFX(fxIndex);
        juce::Logger::writeToLog("AudioEngine: Removed input FX " + juce::String(fxIndex) + " from track " + trackId);
    }
    recalculatePDC();
}

void AudioEngine::removeTrackFX(const juce::String& trackId, int fxIndex)
{
    // Phase 1: Close editor window and release resources BEFORE acquiring lock.
    // Must happen outside the callback lock on the message thread to avoid deadlock
    // if the plugin's release path posts to the message thread.
    {
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            if (auto* proc = it->second->getTrackFXProcessor(fxIndex))
            {
                pluginWindowManager.closeEditorSync(proc);
                proc->releaseResources();
            }
        }
    }

    // Phase 2: Acquire lock and remove the plugin from the chain.
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->removeTrackFX(fxIndex);
        juce::Logger::writeToLog("AudioEngine: Removed track FX " + juce::String(fxIndex) + " from track " + trackId);
    }
    recalculatePDC();
}

void AudioEngine::bypassTrackInputFX(const juce::String& trackId, int fxIndex, bool bypassed)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->bypassInputFX(fxIndex, bypassed);
        juce::Logger::writeToLog("AudioEngine: " + juce::String(bypassed ? "Bypassed" : "Unbypassed") +
                               " input FX " + juce::String(fxIndex) + " on track " + trackId);
    }
    recalculatePDC();
}

void AudioEngine::bypassTrackFX(const juce::String& trackId, int fxIndex, bool bypassed)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->bypassTrackFX(fxIndex, bypassed);
        juce::Logger::writeToLog("AudioEngine: " + juce::String(bypassed ? "Bypassed" : "Unbypassed") +
                               " track FX " + juce::String(fxIndex) + " on track " + trackId);
    }
    recalculatePDC();
}

bool AudioEngine::reorderTrackInputFX(const juce::String& trackId, int fromIndex, int toIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    bool success = it->second->reorderInputFX(fromIndex, toIndex);
    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Reordered input FX on track " + trackId +
                               " from " + juce::String(fromIndex) + " to " + juce::String(toIndex));
    }
    return success;
}

bool AudioEngine::reorderTrackFX(const juce::String& trackId, int fromIndex, int toIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    bool success = it->second->reorderTrackFX(fromIndex, toIndex);
    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Reordered track FX on track " + trackId +
                               " from " + juce::String(fromIndex) + " to " + juce::String(toIndex));
    }
    return success;
}

//==============================================================================
// Master FX Management

bool AudioEngine::addMasterFX(const juce::String& pluginPath)
{
    juce::Logger::writeToLog("AudioEngine: addMasterFX called with: " + pluginPath);
    
    // Load the plugin with actual device sample rate & block size
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load plugin for master FX");
        return false;
    }

    // Provide tempo/position info to the plugin
    plugin->setPlayHead (this);

    // Plugin was already created at the correct rate by loadPluginFromFile,
    // but re-prepare in case the device has changed since then.
    // Clamp max-block-size to at least 512 (same rationale as track FX).
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device)
    {
        prepareHostedProcessorForPrecision(
            plugin.get(),
            device->getCurrentSampleRate(),
            device->getCurrentBufferSizeSamples(),
            processingPrecisionMode);
    }

    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock lockSl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMasterStageSpec;
    }

    DesiredFXStageSlot slot;
    slot.slotId = nextMasterStageSlotId++;
    slot.name = plugin->getName();
    if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(plugin.get()))
    {
        auto desc = pluginInstance->getPluginDescription();
        slot.type = desc.pluginFormatName == "CLAP" ? "clap" : "vst3";
        slot.pluginPath = desc.fileOrIdentifier;
        slot.pluginFormat = desc.pluginFormatName;
    }
    else
    {
        slot.type = "plugin";
        slot.pluginPath = pluginPath;
        slot.pluginFormat = "Plugin";
    }
    slot.serializedState = serialiseProcessorStateToBase64(plugin.get());
    specCopy.slots.push_back(std::move(slot));

    if (!publishMasterStageSpec(specCopy))
    {
        juce::Logger::writeToLog("AudioEngine: Failed to publish master stage after adding plugin");
        return false;
    }

    juce::Logger::writeToLog("AudioEngine: Added plugin to master FX chain (total: " + juce::String((int)specCopy.slots.size()) + ")");
    return true;
}

juce::var AudioEngine::getMasterFX()
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    juce::Array<juce::var> fxList;
    for (int i = 0; i < static_cast<int>(desiredMasterStageSpec.slots.size()); ++i)
    {
        const auto& slot = desiredMasterStageSpec.slots[static_cast<size_t>(i)];
        juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
        fxInfo->setProperty("index", i);
        fxInfo->setProperty("name", slot.name);
        fxInfo->setProperty("bypassed", slot.bypassed);
        fxInfo->setProperty("precisionOverride", slot.forceFloat ? "float32" : "auto");
        fxInfo->setProperty("type", slot.type);
        if (!slot.pluginPath.isEmpty())
            fxInfo->setProperty("pluginPath", slot.pluginPath);
        fxList.add(juce::var(fxInfo.get()));
    }
    return fxList;
}

void AudioEngine::removeMasterFX(int fxIndex)
{
    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMasterStageSpec;
    }

    if (fxIndex < 0 || fxIndex >= static_cast<int>(specCopy.slots.size()))
        return;

    // Close editor for the processor being removed BEFORE publishing new spec.
    {
        int slotId = specCopy.slots[static_cast<size_t>(fxIndex)].slotId;
        auto activeStage = std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire);
        if (activeStage)
        {
            if (const auto* activeSlot = findActiveStageSlot(activeStage, slotId))
            {
                if (activeSlot->processor)
                {
                    pluginWindowManager.closeEditorSync(activeSlot->processor.get());
                    activeSlot->processor->releaseResources();
                }
            }
        }
    }

    syncStageSpecStateFromActive(specCopy, std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire));
    specCopy.slots.erase(specCopy.slots.begin() + fxIndex);
    if (publishMasterStageSpec(specCopy))
        juce::Logger::writeToLog("AudioEngine: Removed master FX " + juce::String(fxIndex));
}

void AudioEngine::openMasterFXEditor(int fxIndex)
{
    int slotId = 0;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        if (const auto* slot = findDesiredStageSlot(desiredMasterStageSpec, fxIndex))
            slotId = slot->slotId;
    }

    if (slotId == 0)
        return;

    auto activeStage = std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire);
    if (const auto* activeSlot = findActiveStageSlot(activeStage, slotId))
    {
        if (activeSlot->processor)
        {
            auto processor = activeSlot->processor;
            auto title = activeSlot->name;
            PluginWindowManager::PluginEditorTarget target;
            target.scope = PluginWindowManager::PluginEditorTarget::Scope::MasterFX;
            target.fxIndex = fxIndex;
            juce::MessageManager::callAsync([this, processor, title, target]()
            {
                if (processor)
                    pluginWindowManager.openEditor(processor.get(), title, target);
            });
        }
    }
}

void AudioEngine::bypassMasterFX(int fxIndex, bool bypassed)
{
    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMasterStageSpec;
    }

    syncStageSpecStateFromActive(specCopy, std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire));
    if (auto* slot = findDesiredStageSlot(specCopy, fxIndex))
    {
        slot->bypassed = bypassed;
        if (publishMasterStageSpec(specCopy))
        {
            juce::Logger::writeToLog("AudioEngine: Master FX " + juce::String(fxIndex) +
                                     (bypassed ? " bypassed" : " enabled"));
        }
    }
}

void AudioEngine::setMasterVolume(float volume)
{
    masterVolume = juce::jlimit(0.0f, juce::Decibels::decibelsToGain(12.0f), volume);
    juce::Logger::writeToLog("Master volume set to: " + juce::String(volume));
}

void AudioEngine::setMasterPan(float pan)
{
    masterPan = juce::jlimit(-1.0f, 1.0f, pan);

    float leftGain = 1.0f;
    float rightGain = 1.0f;
    computePanLawGains(currentPanLaw, masterPan, 1.0f, leftGain, rightGain);
    cachedMasterPanL.store(leftGain, std::memory_order_relaxed);
    cachedMasterPanR.store(rightGain, std::memory_order_relaxed);
}

bool AudioEngine::addMonitoringFX(const juce::String& pluginPath)
{
    juce::Logger::writeToLog("AudioEngine: addMonitoringFX called with: " + pluginPath);

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load plugin for monitoring FX");
        return false;
    }

    plugin->setPlayHead(this);

    auto* device = deviceManager.getCurrentAudioDevice();
    if (device)
    {
        prepareHostedProcessorForPrecision(
            plugin.get(),
            device->getCurrentSampleRate(),
            device->getCurrentBufferSizeSamples(),
            processingPrecisionMode);
    }

    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock lockSl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMonitoringStageSpec;
    }

    DesiredFXStageSlot slot;
    slot.slotId = nextMonitoringStageSlotId++;
    slot.name = plugin->getName();
    if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(plugin.get()))
    {
        auto desc = pluginInstance->getPluginDescription();
        slot.type = desc.pluginFormatName == "CLAP" ? "clap" : "vst3";
        slot.pluginPath = desc.fileOrIdentifier;
        slot.pluginFormat = desc.pluginFormatName;
    }
    else
    {
        slot.type = "plugin";
        slot.pluginPath = pluginPath;
        slot.pluginFormat = "Plugin";
    }
    slot.serializedState = serialiseProcessorStateToBase64(plugin.get());
    specCopy.slots.push_back(std::move(slot));

    if (!publishMonitoringStageSpec(specCopy))
    {
        juce::Logger::writeToLog("AudioEngine: Failed to publish monitoring stage after adding plugin");
        return false;
    }

    juce::Logger::writeToLog("AudioEngine: Added plugin to monitoring FX chain (total: " +
                             juce::String((int)specCopy.slots.size()) + ")");
    return true;
}

juce::var AudioEngine::getMonitoringFX()
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    juce::Array<juce::var> fxList;
    for (int i = 0; i < static_cast<int>(desiredMonitoringStageSpec.slots.size()); ++i)
    {
        const auto& slot = desiredMonitoringStageSpec.slots[static_cast<size_t>(i)];
        juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
        fxInfo->setProperty("index", i);
        fxInfo->setProperty("name", slot.name);
        fxInfo->setProperty("bypassed", slot.bypassed);
        fxInfo->setProperty("precisionOverride", slot.forceFloat ? "float32" : "auto");
        fxInfo->setProperty("type", slot.type);
        if (!slot.pluginPath.isEmpty())
            fxInfo->setProperty("pluginPath", slot.pluginPath);
        fxList.add(juce::var(fxInfo.get()));
    }
    return fxList;
}

void AudioEngine::removeMonitoringFX(int fxIndex)
{
    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMonitoringStageSpec;
    }

    if (fxIndex < 0 || fxIndex >= static_cast<int>(specCopy.slots.size()))
        return;

    // Close editor for the processor being removed BEFORE publishing new spec.
    {
        int slotId = specCopy.slots[static_cast<size_t>(fxIndex)].slotId;
        auto activeStage = std::atomic_load_explicit(&realtimeMonitoringFXSnapshot, std::memory_order_acquire);
        if (activeStage)
        {
            if (const auto* activeSlot = findActiveStageSlot(activeStage, slotId))
            {
                if (activeSlot->processor)
                {
                    pluginWindowManager.closeEditorSync(activeSlot->processor.get());
                    activeSlot->processor->releaseResources();
                }
            }
        }
    }

    syncStageSpecStateFromActive(specCopy, std::atomic_load_explicit(&realtimeMonitoringFXSnapshot, std::memory_order_acquire));
    specCopy.slots.erase(specCopy.slots.begin() + fxIndex);
    if (publishMonitoringStageSpec(specCopy))
        juce::Logger::writeToLog("AudioEngine: Removed monitoring FX " + juce::String(fxIndex));
}

void AudioEngine::openMonitoringFXEditor(int fxIndex)
{
    int slotId = 0;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        if (const auto* slot = findDesiredStageSlot(desiredMonitoringStageSpec, fxIndex))
            slotId = slot->slotId;
    }

    if (slotId == 0)
        return;

    auto activeStage = std::atomic_load_explicit(&realtimeMonitoringFXSnapshot, std::memory_order_acquire);
    if (const auto* activeSlot = findActiveStageSlot(activeStage, slotId))
    {
        if (activeSlot->processor)
        {
            auto processor = activeSlot->processor;
            auto title = activeSlot->name;
            PluginWindowManager::PluginEditorTarget target;
            target.scope = PluginWindowManager::PluginEditorTarget::Scope::MonitoringFX;
            target.fxIndex = fxIndex;
            juce::MessageManager::callAsync([this, processor, title, target]()
            {
                if (processor)
                    pluginWindowManager.openEditor(processor.get(), title, target);
            });
        }
    }
}

void AudioEngine::bypassMonitoringFX(int fxIndex, bool bypassed)
{
    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMonitoringStageSpec;
    }

    syncStageSpecStateFromActive(specCopy, std::atomic_load_explicit(&realtimeMonitoringFXSnapshot, std::memory_order_acquire));
    if (auto* slot = findDesiredStageSlot(specCopy, fxIndex))
    {
        slot->bypassed = bypassed;
        if (publishMonitoringStageSpec(specCopy))
        {
            juce::Logger::writeToLog("AudioEngine: Monitoring FX " + juce::String(fxIndex) +
                                     (bypassed ? " bypassed" : " enabled"));
        }
    }
}

std::vector<AudioRecorder::CompletedRecording> AudioEngine::getLastCompletedClips()
{
    auto clips = lastCompletedClips;
    lastReturnedRecordingClipCount.store(static_cast<int>(clips.size()), std::memory_order_relaxed);
    logAudioRecord("getLastCompletedClips returning count=" + juce::String(static_cast<int>(clips.size())));
    for (const auto& clip : clips)
    {
        logAudioRecord("getLastCompletedClips clip track=" + clip.trackId
            + " file=" + clip.file.getFullPathName()
            + " startTime=" + juce::String(clip.startTime, 3)
            + " duration=" + juce::String(clip.duration, 3));
    }
    lastCompletedClips.clear();  // Clear after reading
    return clips;
}

std::vector<MIDIRecorder::CompletedMIDIRecording> AudioEngine::getLastCompletedMIDIClips()
{
    auto clips = std::move(lastCompletedMIDIClips);
    lastCompletedMIDIClips.clear();
    return clips;
}

juce::var AudioEngine::getActiveRecordingMIDIPreviews(const juce::var& requests)
{
    std::vector<MIDIRecorder::LivePreviewRequest> parsedRequests;

    if (auto* requestArray = requests.getArray())
    {
        parsedRequests.reserve(static_cast<size_t>(requestArray->size()));
        for (const auto& requestVar : *requestArray)
        {
            auto* requestObj = requestVar.getDynamicObject();
            if (requestObj == nullptr)
                continue;

            const juce::String trackId = requestObj->getProperty("trackId").toString();
            if (trackId.isEmpty())
                continue;

            MIDIRecorder::LivePreviewRequest request;
            request.trackId = trackId;
            const auto generationVar = requestObj->getProperty("generation");
            request.generation = generationVar.isVoid()
                ? 0
                : static_cast<uint64_t>(static_cast<int64>(generationVar));
            request.knownEventCount = static_cast<int>(requestObj->getProperty("knownEventCount"));
            parsedRequests.push_back(std::move(request));
        }
    }

    auto snapshots = midiRecorder.getLivePreviewSnapshots(parsedRequests);
    juce::Array<juce::var> snapshotArray;

    for (const auto& snapshot : snapshots)
    {
        auto* snapshotObj = new juce::DynamicObject();
        snapshotObj->setProperty("trackId", snapshot.trackId);
        snapshotObj->setProperty("generation", static_cast<int64>(snapshot.generation));
        snapshotObj->setProperty("recordingStartTime", snapshot.recordingStartTime);
        snapshotObj->setProperty("totalEventCount", snapshot.totalEventCount);

        juce::Array<juce::var> eventsArray;
        for (const auto& evt : snapshot.deltaEvents)
        {
            if (!evt.message.isNoteOn() && !evt.message.isNoteOff())
                continue;

            auto* evtObj = new juce::DynamicObject();
            evtObj->setProperty("timestamp", evt.timestamp);
            evtObj->setProperty("type", evt.message.isNoteOn() ? "noteOn" : "noteOff");
            evtObj->setProperty("note", evt.message.getNoteNumber());
            evtObj->setProperty("velocity", evt.message.isNoteOn() ? evt.message.getVelocity() : 0);
            evtObj->setProperty("channel", evt.message.getChannel());
            eventsArray.add(evtObj);
        }
        snapshotObj->setProperty("deltaEvents", eventsArray);

        juce::Array<juce::var> activeNotesArray;
        for (const auto& activeNote : snapshot.activeNotes)
        {
            auto* activeNoteObj = new juce::DynamicObject();
            activeNoteObj->setProperty("note", activeNote.note);
            activeNoteObj->setProperty("startTimestamp", activeNote.startTimestamp);
            activeNotesArray.add(activeNoteObj);
        }
        snapshotObj->setProperty("activeNotes", activeNotesArray);

        snapshotArray.add(snapshotObj);
    }

    return snapshotArray;
}

//==============================================================================
// Playback Clip Management

// Playback Clip Management

void AudioEngine::addPlaybackClip(const juce::String& trackId, const juce::String& filePath, double startTime, double duration,
                                   double offset, double volumeDB, double fadeIn, double fadeOut, const juce::String& clipId,
                                   const juce::String& pitchCorrectionSourceFilePath, double pitchCorrectionSourceOffset)
{
    juce::File audioFile(filePath);
    juce::File sourceAudioFile(pitchCorrectionSourceFilePath);
    playbackEngine.addClip(audioFile, startTime, duration, trackId, offset, volumeDB, fadeIn, fadeOut, clipId,
                           sourceAudioFile, pitchCorrectionSourceOffset);
    juce::Logger::writeToLog("AudioEngine: Added playback clip to track " + trackId +
                           " (offset=" + juce::String(offset) + "s, vol=" + juce::String(volumeDB) + "dB)");
    logAudioPlayback("addPlaybackClip track=" + trackId
        + " clipId=" + clipId
        + " file=" + filePath
        + " start=" + juce::String(startTime, 3)
        + " duration=" + juce::String(duration, 3)
        + " offset=" + juce::String(offset, 3)
        + " totalClips=" + juce::String(playbackEngine.getNumClips()));
}

void AudioEngine::addPlaybackClipsBatch(const juce::String& clipsJSON)
{
    auto parsed = juce::JSON::parse (clipsJSON);
    if (auto* arr = parsed.getArray())
    {
        logAudioPlayback("addPlaybackClipsBatch incomingCount=" + juce::String(static_cast<int>(arr->size())));
        for (const auto& item : *arr)
        {
            juce::String trackId = item["trackId"].toString();
            juce::String fp      = item["filePath"].toString();
            juce::String cId     = item.hasProperty ("clipId") ? item["clipId"].toString() : juce::String();
            double startTime     = static_cast<double> (item["startTime"]);
            double dur           = static_cast<double> (item["duration"]);
            double off           = item.hasProperty ("offset")   ? static_cast<double> (item["offset"])   : 0.0;
            double vol           = item.hasProperty ("volumeDB") ? static_cast<double> (item["volumeDB"]) : 0.0;
            double fi            = item.hasProperty ("fadeIn")   ? static_cast<double> (item["fadeIn"])    : 0.0;
            double fo            = item.hasProperty ("fadeOut")  ? static_cast<double> (item["fadeOut"])   : 0.0;
            juce::String sourcePath = item.hasProperty ("pitchCorrectionSourceFilePath")
                ? item["pitchCorrectionSourceFilePath"].toString()
                : juce::String();
            double sourceOffset = item.hasProperty ("pitchCorrectionSourceOffset")
                ? static_cast<double> (item["pitchCorrectionSourceOffset"])
                : -1.0;

            juce::File audioFile (fp);
            juce::File sourceAudioFile (sourcePath);
            playbackEngine.addClip (audioFile, startTime, dur, trackId, off, vol, fi, fo, cId,
                                    sourceAudioFile, sourceOffset);
            logAudioPlayback("addPlaybackClipsBatch clip track=" + trackId
                + " clipId=" + cId
                + " file=" + fp
                + " start=" + juce::String(startTime, 3)
                + " duration=" + juce::String(dur, 3)
                + " offset=" + juce::String(off, 3));
        }
        juce::Logger::writeToLog ("AudioEngine: Batch-added " + juce::String (arr->size()) + " playback clips");
        logAudioPlayback("addPlaybackClipsBatch totalClipsAfter=" + juce::String(playbackEngine.getNumClips()));
    }
}

void AudioEngine::removePlaybackClip(const juce::String& trackId, const juce::String& filePath)
{
    playbackEngine.removeClip(trackId, filePath);
    juce::Logger::writeToLog("AudioEngine: Removed playback clip from track " + trackId);
}

void AudioEngine::clearPlaybackClips()
{
    playbackEngine.clearAllClips();
    juce::Logger::writeToLog("AudioEngine: Cleared all playback clips");
    logAudioPlayback("clearPlaybackClips totalClipsAfter=" + juce::String(playbackEngine.getNumClips()));
}

void AudioEngine::clearTrackPlaybackClips(const juce::String& trackId)
{
    playbackEngine.clearTrackClips(trackId);
    juce::Logger::writeToLog("AudioEngine: Cleared clips for track " + trackId);
}



juce::var AudioEngine::getWaveformPeaks(const juce::String& filePath, int samplesPerPixel, int startSample, int numPixels)
{
    // REAPER-inspired: read from pre-computed peak cache (.s13peaks) instead of audio file.
    // If cache doesn't exist, kick off async generation and return empty.
    // Frontend will re-request on next render after cache is ready.
    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("getWaveformPeaks: File not found: " + filePath);
        return juce::Array<juce::var>();
    }

    // Generate peak cache if it doesn't exist — async to avoid blocking the UI thread.
    // Returns empty array now; emits peaksReady event when generation completes so
    // the frontend Timeline can re-fetch waveform data.
    if (!peakCache.hasCachedPeaks(audioFile))
    {
        juce::Logger::writeToLog("getWaveformPeaks: Generating peak cache (async) for: " + audioFile.getFileName());
        peakCache.generateAsync(audioFile, [this, filePath]() {
            juce::Logger::writeToLog("getWaveformPeaks: Peak cache ready for: " + filePath);
            if (onPeaksReady)
                onPeaksReady(filePath);
        });
        return juce::Array<juce::var>();
    }

    // Read from peak cache (instant — memory-cached mipmap lookup)
    return peakCache.getPeaks(audioFile, samplesPerPixel, startSample, numPixels);
}

juce::var AudioEngine::getRecordingPeaks(const juce::String& trackId, int samplesPerPixel, int numPixels)
{
    logAudioRecord("getRecordingPeaks track=" + trackId
        + " samplesPerPixel=" + juce::String(samplesPerPixel)
        + " numPixels=" + juce::String(numPixels));
    return audioRecorder.getRecordingPeaks(trackId, samplesPerPixel, numPixels);
}

//==============================================================================
// Metronome & Transport Control (Phase 3)

void AudioEngine::setTempo(double bpm)
{
    tempo = bpm;
    metronome.setBpm(bpm);
}

void AudioEngine::setMetronomeEnabled(bool enabled)
{
    metronome.setEnabled(enabled);
}

void AudioEngine::setMetronomeVolume(float volume)
{
    metronome.setVolume(volume);
}

bool AudioEngine::isMetronomeEnabled() const
{
    return metronome.isEnabled();
}

void AudioEngine::setMetronomeAccentBeats(const std::vector<bool>& accents)
{
    metronome.setAccentBeats(accents);
}

void AudioEngine::setTimeSignature(int numerator, int denominator)
{
    timeSigNumerator = numerator;
    timeSigDenominator = denominator;
    metronome.setTimeSignature(numerator, denominator);
}

void AudioEngine::getTimeSignature(int& numerator, int& denominator) const
{
    numerator = timeSigNumerator;
    denominator = timeSigDenominator;
}

//==============================================================================
// AudioPlayHead — provides tempo/position info to hosted VST3 plugins

juce::Optional<juce::AudioPlayHead::PositionInfo> AudioEngine::getPosition() const
{
    PositionInfo info;

    double timeInSeconds = (currentSampleRate > 0)
                           ? currentSamplePosition / currentSampleRate
                           : 0.0;

    // Use tempo map if available, otherwise fall back to global BPM
    double currentBpm = getTempoAtTime(timeInSeconds);
    info.setBpm (currentBpm);

    juce::AudioPlayHead::TimeSignature timeSig;
    timeSig.numerator   = timeSigNumerator;
    timeSig.denominator = timeSigDenominator;
    info.setTimeSignature (timeSig);
    info.setIsPlaying (isPlaying.load());
    info.setIsRecording (isRecordMode.load());
    info.setIsLooping (isLooping);

    info.setTimeInSamples (static_cast<juce::int64> (currentSamplePosition));
    info.setTimeInSeconds (timeInSeconds);

    // PPQ = position in quarter notes = seconds * (BPM / 60)
    // NOTE: With a tempo map, PPQ should integrate over tempo changes.
    // For now, use instantaneous BPM (acceptable for step-wise tempo map).
    double ppqPosition = timeInSeconds * (currentBpm / 60.0);
    info.setPpqPosition (ppqPosition);

    // Bar start in PPQ: quarter notes per bar depends on time signature
    double quarterNotesPerBar = timeSigNumerator * (4.0 / timeSigDenominator);
    if (quarterNotesPerBar > 0.0)
        info.setPpqPositionOfLastBarStart (std::floor (ppqPosition / quarterNotesPerBar) * quarterNotesPerBar);

    return info;
}

void AudioEngine::propagatePlayHead (TrackProcessor* track)
{
    if (!track) return;

    for (int i = 0; i < track->getNumInputFX(); ++i)
        if (auto* proc = track->getInputFXProcessor (i))
            proc->setPlayHead (this);

    for (int i = 0; i < track->getNumTrackFX(); ++i)
        if (auto* proc = track->getTrackFXProcessor (i))
            proc->setPlayHead (this);

    if (auto* inst = track->getInstrument())
        inst->setPlayHead (this);
}

// Custom metronome sounds (Phase 9C)
bool AudioEngine::setMetronomeClickSound(const juce::String& filePath)
{
    return metronome.setClickSound(filePath);
}

bool AudioEngine::setMetronomeAccentSound(const juce::String& filePath)
{
    return metronome.setAccentSound(filePath);
}

void AudioEngine::resetMetronomeSounds()
{
    metronome.resetToDefaultSounds();
}

//==============================================================================
// Plugin Delay Compensation (PDC)

void AudioEngine::recalculatePDC()
{
    // Find maximum chain latency across all tracks
    int maxLatency = 0;
    for (const auto& id : trackOrder)
    {
        auto it = trackMap.find(id);
        if (it != trackMap.end() && it->second)
        {
            int lat = it->second->getChainLatency();
            if (lat > maxLatency)
                maxLatency = lat;
        }
    }

    // Set PDC delay for each track: maxLatency - trackLatency
    for (const auto& id : trackOrder)
    {
        auto it = trackMap.find(id);
        if (it != trackMap.end() && it->second)
        {
            int trackLat = it->second->getChainLatency();
            int delay = maxLatency - trackLat;
            it->second->setPDCDelay(delay);
        }
    }

    juce::Logger::writeToLog("AudioEngine: PDC recalculated - maxLatency=" + juce::String(maxLatency) + " samples");
}

//==============================================================================
// Pan Law

void AudioEngine::setPanLaw(const juce::String& law)
{
    PanLaw newLaw = PanLaw::Linear;
    if (law == "constant_power" || law == "minus3dB")
        newLaw = PanLaw::ConstantPower;
    else if (law == "minus4_5dB")
        newLaw = PanLaw::Minus4_5dB;
    else if (law == "minus6dB")
        newLaw = PanLaw::Minus6dB;
    else if (law == "linear")
        newLaw = PanLaw::Linear;

    currentPanLaw = newLaw;

    // Apply to all tracks
    for (const auto& id : trackOrder)
    {
        auto it = trackMap.find(id);
        if (it != trackMap.end() && it->second)
            it->second->setPanLaw(newLaw);
    }

    setMasterPan(masterPan);

    juce::Logger::writeToLog("AudioEngine: Pan law set to " + law);
}

juce::String AudioEngine::getPanLaw() const
{
    switch (currentPanLaw)
    {
        case PanLaw::ConstantPower: return "constant_power";
        case PanLaw::Minus4_5dB:    return "minus4_5dB";
        case PanLaw::Minus6dB:      return "minus6dB";
        case PanLaw::Linear:        return "linear";
        default:                    return "constant_power";
    }
}

//==============================================================================
// DC Offset per track

void AudioEngine::setTrackDCOffset(const juce::String& trackId, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setDCOffsetRemoval(enabled);
        juce::Logger::writeToLog("AudioEngine: DC offset removal " +
                                 juce::String(enabled ? "enabled" : "disabled") +
                                 " on track " + trackId);
    }
}

//==============================================================================
// Sidechain Routing (Phase 4.4)

void AudioEngine::setSidechainSource(const juce::String& destTrackId, int pluginIndex, const juce::String& sourceTrackId)
{
    auto it = trackMap.find(destTrackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setSidechainSource(pluginIndex, sourceTrackId);
        rebuildRealtimeProcessingSnapshots();
        juce::Logger::writeToLog("AudioEngine: Set sidechain for track " + destTrackId +
                                 " FX[" + juce::String(pluginIndex) + "] = " + sourceTrackId);
    }
}

void AudioEngine::clearSidechainSource(const juce::String& destTrackId, int pluginIndex)
{
    auto it = trackMap.find(destTrackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->clearSidechainSource(pluginIndex);
        rebuildRealtimeProcessingSnapshots();
        juce::Logger::writeToLog("AudioEngine: Cleared sidechain for track " + destTrackId +
                                 " FX[" + juce::String(pluginIndex) + "]");
    }
}

juce::String AudioEngine::getSidechainSource(const juce::String& destTrackId, int pluginIndex)
{
    auto it = trackMap.find(destTrackId);
    if (it != trackMap.end() && it->second)
        return it->second->getSidechainSource(pluginIndex);
    return {};
}

//==============================================================================
// Send/Bus Routing (Phase 11)

int AudioEngine::addTrackSend(const juce::String& sourceTrackId, const juce::String& destTrackId)
{
    if (trackMap.find(sourceTrackId) == trackMap.end()) return -1;
    int sendIndex = trackMap[sourceTrackId]->addSend(destTrackId);
    rebuildRealtimeProcessingSnapshots();
    return sendIndex;
}

void AudioEngine::removeTrackSend(const juce::String& sourceTrackId, int sendIndex)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
    {
        trackMap[sourceTrackId]->removeSend(sendIndex);
        rebuildRealtimeProcessingSnapshots();
    }
}

void AudioEngine::setTrackSendLevel(const juce::String& sourceTrackId, int sendIndex, float level)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
    {
        trackMap[sourceTrackId]->setSendLevel(sendIndex, level);
        rebuildRealtimeProcessingSnapshots();
    }
}

void AudioEngine::setTrackSendPan(const juce::String& sourceTrackId, int sendIndex, float pan)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
    {
        trackMap[sourceTrackId]->setSendPan(sendIndex, pan);
        rebuildRealtimeProcessingSnapshots();
    }
}

void AudioEngine::setTrackSendEnabled(const juce::String& sourceTrackId, int sendIndex, bool enabled)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
    {
        trackMap[sourceTrackId]->setSendEnabled(sendIndex, enabled);
        rebuildRealtimeProcessingSnapshots();
    }
}

void AudioEngine::setTrackSendPreFader(const juce::String& sourceTrackId, int sendIndex, bool preFader)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
    {
        trackMap[sourceTrackId]->setSendPreFader(sendIndex, preFader);
        rebuildRealtimeProcessingSnapshots();
    }
}

void AudioEngine::setTrackSendPhaseInvert(const juce::String& sourceTrackId, int sendIndex, bool invert)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
    {
        trackMap[sourceTrackId]->setSendPhaseInvert(sendIndex, invert);
        rebuildRealtimeProcessingSnapshots();
    }
}

juce::var AudioEngine::getTrackSends(const juce::String& trackId)
{
    juce::Array<juce::var> result;
    if (trackMap.find(trackId) == trackMap.end()) return result;

    auto* track = trackMap[trackId];
    for (int i = 0; i < track->getNumSends(); ++i)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("destTrackId", track->getSendDestination(i));
        obj->setProperty("level", track->getSendLevel(i));
        obj->setProperty("pan", track->getSendPan(i));
        obj->setProperty("enabled", track->getSendEnabled(i));
        obj->setProperty("preFader", track->getSendPreFader(i));
        obj->setProperty("phaseInvert", track->getSendPhaseInvert(i));
        result.add(obj);
    }
    return result;
}

//==============================================================================
// Track Routing Features

void AudioEngine::setTrackPhaseInvert(const juce::String& trackId, bool invert)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setPhaseInvert(invert);
}

bool AudioEngine::getTrackPhaseInvert(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getPhaseInvert() : false;
}

void AudioEngine::setTrackStereoWidth(const juce::String& trackId, float widthPercent)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setStereoWidth(widthPercent);
}

float AudioEngine::getTrackStereoWidth(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getStereoWidth() : 100.0f;
}

void AudioEngine::setTrackMasterSendEnabled(const juce::String& trackId, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setMasterSendEnabled(enabled);
}

bool AudioEngine::getTrackMasterSendEnabled(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getMasterSendEnabled() : true;
}

void AudioEngine::setTrackOutputChannels(const juce::String& trackId, int startChannel, int numChannels)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setOutputChannels(startChannel, numChannels);
}

void AudioEngine::setTrackPlaybackOffset(const juce::String& trackId, double offsetMs)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setPlaybackOffset(offsetMs);
}

double AudioEngine::getTrackPlaybackOffset(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getPlaybackOffset() : 0.0;
}

void AudioEngine::setTrackChannelCount(const juce::String& trackId, int numChannels)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setTrackChannelCount(numChannels);
}

int AudioEngine::getTrackChannelCount(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getTrackChannelCount() : 2;
}

void AudioEngine::setTrackMIDIOutput(const juce::String& trackId, const juce::String& deviceName)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setMIDIOutputDevice(deviceName);
}

juce::String AudioEngine::getTrackMIDIOutput(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getMIDIOutputDeviceName() : juce::String();
}

juce::var AudioEngine::getTrackRoutingInfo(const juce::String& trackId)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end()) return juce::var();

    auto* track = it->second;
    auto* obj = new juce::DynamicObject();

    obj->setProperty("phaseInverted", track->getPhaseInvert());
    obj->setProperty("stereoWidth", track->getStereoWidth());
    obj->setProperty("masterSendEnabled", track->getMasterSendEnabled());
    obj->setProperty("outputStartChannel", track->getOutputStartChannel());
    obj->setProperty("outputChannelCount", track->getOutputChannelCount());
    obj->setProperty("playbackOffsetMs", track->getPlaybackOffset());
    obj->setProperty("trackChannelCount", track->getTrackChannelCount());
    obj->setProperty("midiOutputDevice", track->getMIDIOutputDeviceName());

    return juce::var(obj);
}

juce::var AudioEngine::getMidiDiagnostics() const
{
    juce::Array<juce::var> tracksArray;
    for (const auto& [trackId, track] : trackMap)
    {
        if (!track)
            continue;

        auto* trackObj = new juce::DynamicObject();
        trackObj->setProperty("trackId", trackId);
        trackObj->setProperty("trackType", track->getTrackType() == TrackType::Instrument
            ? "instrument"
            : (track->getTrackType() == TrackType::MIDI ? "midi" : "audio"));
        trackObj->setProperty("midiOverflowCount", track->getMidiOverflowCount());
        trackObj->setProperty("lastBuiltMidiEventCount", track->getLastBuiltMidiEventCount());
        trackObj->setProperty("maxBuiltMidiEventCount", track->getMaxBuiltMidiEventCount());
        trackObj->setProperty("realtimeFallbackReuseCount", track->getRealtimeFallbackReuseCount());
        trackObj->setProperty("monitoring", track->getInputMonitoring());
        trackObj->setProperty("recordArmed", track->getRecordArmed());
        tracksArray.add(juce::var(trackObj));
    }

    auto* root = new juce::DynamicObject();
    root->setProperty("tracks", tracksArray);
    root->setProperty("bufferSize", currentBlockSize);
    root->setProperty("sampleRate", currentSampleRate);
    root->setProperty("lateEventCount", midiLateEventCount.load(std::memory_order_relaxed));
    root->setProperty("maxEventsPerBlock", midiMaxEventsPerBlock.load(std::memory_order_relaxed));
    root->setProperty("lastComputedSampleOffset", midiLastComputedSampleOffset.load(std::memory_order_relaxed));
    root->setProperty("masterFXFallbackReuseCount", masterFXFallbackReuseCount.load(std::memory_order_relaxed));
    root->setProperty("monitoringFXFallbackReuseCount", monitoringFXFallbackReuseCount.load(std::memory_order_relaxed));
    root->setProperty("masterFXBusySkipCount", masterFXBusySkipCount.load(std::memory_order_relaxed));
    root->setProperty("monitoringFXBusySkipCount", monitoringFXBusySkipCount.load(std::memory_order_relaxed));
    root->setProperty("masterStageGeneration", static_cast<int64>(masterStageGeneration.load(std::memory_order_relaxed)));
    root->setProperty("monitoringStageGeneration", static_cast<int64>(monitoringStageGeneration.load(std::memory_order_relaxed)));
    root->setProperty("masterStageBuildFailureCount", masterStageBuildFailureCount.load(std::memory_order_relaxed));
    root->setProperty("monitoringStageBuildFailureCount", monitoringStageBuildFailureCount.load(std::memory_order_relaxed));
    root->setProperty("masterStageLastBuildMs", masterStageLastBuildMs.load(std::memory_order_relaxed));
    root->setProperty("monitoringStageLastBuildMs", monitoringStageLastBuildMs.load(std::memory_order_relaxed));
    root->setProperty("processingPrecision", getProcessingPrecision());
    return juce::var(root);
}

juce::var AudioEngine::getAudioDebugSnapshot() const
{
    juce::Array<juce::var> playbackTracks;
    for (const auto& [trackId, track] : trackMap)
    {
        juce::ignoreUnused(track);
        auto* trackObj = new juce::DynamicObject();
        trackObj->setProperty("trackId", trackId);
        trackObj->setProperty("clipCount", playbackEngine.getNumClipsForTrack(trackId));
        playbackTracks.add(juce::var(trackObj));
    }

    auto* root = new juce::DynamicObject();
    root->setProperty("transportPlaying", isPlaying.load());
    root->setProperty("transportRecording", isRecordMode.load());
    root->setProperty("transportPosition", getTransportPosition());
    root->setProperty("sampleRate", currentSampleRate);
    root->setProperty("blockSize", currentBlockSize);
    root->setProperty("playbackClipCount", playbackEngine.getNumClips());
    root->setProperty("activeOutputChannels", lastActiveOutputChannels.load(std::memory_order_relaxed));
    root->setProperty("callbackInputChannels", lastCallbackInputChannels.load(std::memory_order_relaxed));
    root->setProperty("callbackOutputChannels", lastCallbackOutputChannels.load(std::memory_order_relaxed));
    root->setProperty("lastCallbackCounter", static_cast<int64>(lastAudioCallbackCounter.load(std::memory_order_relaxed)));
    root->setProperty("postTrackPlaybackPeak", lastPostTrackPlaybackPeak.load(std::memory_order_relaxed));
    root->setProperty("postMonitoringInputPeak", lastPostMonitoringInputPeak.load(std::memory_order_relaxed));
    root->setProperty("postMasterFxPeak", lastPostMasterFXPeak.load(std::memory_order_relaxed));
    root->setProperty("postMonitoringFxPeak", lastPostMonitoringFXPeak.load(std::memory_order_relaxed));
    root->setProperty("finalOutputPeak", lastFinalOutputPeak.load(std::memory_order_relaxed));
    root->setProperty("lastRecordingClipCountReturned", lastReturnedRecordingClipCount.load(std::memory_order_relaxed));
    root->setProperty("playbackTryLockFailureCount", playbackEngine.getTryLockFailureCount());
    root->setProperty("playbackMissingReaderCount", playbackEngine.getMissingReaderCount());
    root->setProperty("lastOverlappingClipCount", playbackEngine.getLastOverlappingClipCount());
    root->setProperty("lastMixedClipCount", playbackEngine.getLastMixedClipCount());
    root->setProperty("lastTrackPlaybackPeak", playbackEngine.getLastTrackPlaybackPeak());
    root->setProperty("playbackTracks", playbackTracks);
    return juce::var(root);
}

juce::String AudioEngine::renderMetronomeToFile(double startTime, double endTime)
{
    // Create output file in the preferred OpenStudio audio directory, while
    // still following the legacy Studio13 location if an existing install uses it.
    auto audioFolder = getPreferredAppDataDirectory().getChildFile("Audio");

    if (!audioFolder.exists())
        audioFolder.createDirectory();

    auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
    auto filename = "Metronome_" + juce::String(timestamp) + ".wav";
    auto outputFile = audioFolder.getChildFile(filename);

    // Create a dedicated Metronome instance for offline rendering
    // (to avoid interfering with the real-time metronome)
    Metronome renderMetronome;
    renderMetronome.prepareToPlay(currentSampleRate, 512);
    renderMetronome.setBpm(tempo);
    renderMetronome.setTimeSignature(timeSigNumerator, timeSigDenominator);
    renderMetronome.setVolume(metronome.getVolume());
    renderMetronome.setAccentBeats(metronome.getAccentBeats());

    bool success = renderMetronome.renderToFile(outputFile, startTime, endTime);

    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Rendered metronome to: " + outputFile.getFullPathName());
        return outputFile.getFullPathName();
    }

    juce::Logger::writeToLog("AudioEngine: Failed to render metronome");
    return {};
}

//==============================================================================
// Plugin State Serialization (F2 - Project Save/Load)

juce::String AudioEngine::getPluginState(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    if (trackMap.find(trackId) == trackMap.end())
        return {};
    
    auto* track = trackMap[trackId];
    if (!track)
        return {};
    
    juce::AudioProcessor* processor = nullptr;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }
    
    if (!processor)
        return {};
    
    // Get plugin state as memory block
    juce::MemoryBlock stateData;
    {
        const juce::ScopedLock processorLock(processor->getCallbackLock());
        processor->getStateInformation(stateData);
    }
    
    // Convert to Base64 string
    return stateData.toBase64Encoding();
}

bool AudioEngine::setPluginState(const juce::String& trackId, int fxIndex, bool isInputFX, const juce::String& base64State)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    if (trackMap.find(trackId) == trackMap.end())
        return false;
    
    auto* track = trackMap[trackId];
    if (!track)
        return false;
    
    juce::AudioProcessor* processor = nullptr;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }
    
    if (!processor)
        return false;
    
    // Decode Base64 to memory block
    juce::MemoryBlock stateData;
    if (!stateData.fromBase64Encoding(base64State))
        return false;
    
    // Set plugin state
    {
        const juce::ScopedLock processorLock(processor->getCallbackLock());
        processor->setStateInformation(stateData.getData(), static_cast<int>(stateData.getSize()));
    }
    
    juce::Logger::writeToLog("AudioEngine: Restored plugin state for track " + trackId + 
                             " FX " + juce::String(fxIndex) + " (isInput: " + (isInputFX ? "true" : "false") + ")");
    return true;
}

juce::String AudioEngine::getMasterPluginState(int fxIndex)
{
    int slotId = 0;
    juce::String cachedState;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        if (const auto* slot = findDesiredStageSlot(desiredMasterStageSpec, fxIndex))
        {
            slotId = slot->slotId;
            cachedState = slot->serializedState;
        }
    }

    if (slotId == 0)
        return {};

    auto activeStage = std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire);
    if (const auto* activeSlot = findActiveStageSlot(activeStage, slotId))
        return serialiseProcessorStateToBase64(activeSlot->processor.get());

    return cachedState;
}

bool AudioEngine::setMasterPluginState(int fxIndex, const juce::String& base64State)
{
    juce::MemoryBlock stateData;
    if (!stateData.fromBase64Encoding(base64State))
        return false;

    DesiredFXStageSpec specCopy;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        specCopy = desiredMasterStageSpec;
    }

    syncStageSpecStateFromActive(specCopy, std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire));
    auto* slot = findDesiredStageSlot(specCopy, fxIndex);
    if (slot == nullptr)
        return false;

    slot->serializedState = base64State;

    if (!publishMasterStageSpec(specCopy))
        return false;

    juce::Logger::writeToLog("AudioEngine: Restored master plugin state for FX " + juce::String(fxIndex));
    return true;
}

//==============================================================================
// FFmpeg Helpers

juce::File AudioEngine::findFFmpegExe() const
{
    // Search for ffmpeg.exe in common locations relative to the executable
    auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();

    // 1. Same directory as executable
    auto ffmpeg = exeDir.getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 2. tools/ subdirectory
    ffmpeg = exeDir.getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 3. ../tools/ (one level up)
    ffmpeg = exeDir.getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 4. ../../tools/ (two levels up, for build/Studio13_artefacts/Release/)
    ffmpeg = exeDir.getParentDirectory().getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 5. ../../../tools/ (three levels up, for deeper build paths)
    ffmpeg = exeDir.getParentDirectory().getParentDirectory().getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    return juce::File(); // Not found
}

bool AudioEngine::convertWithFFmpeg(const juce::File& inputFile, const juce::File& outputFile,
                                     const juce::String& format, double targetSampleRate, int quality) const
{
    auto ffmpeg = findFFmpegExe();
    if (!ffmpeg.existsAsFile())
    {
        logToDisk("convertWithFFmpeg: FAIL - ffmpeg.exe not found");
        return false;
    }

    // Build ffmpeg command
    juce::StringArray args;
    args.add(ffmpeg.getFullPathName());
    args.add("-y");                                // Overwrite output
    args.add("-i");
    args.add(inputFile.getFullPathName());         // Input file

    // Sample rate conversion (if target differs from source)
    if (targetSampleRate > 0)
    {
        args.add("-ar");
        args.add(juce::String((int)targetSampleRate));
    }

    juce::String formatLower = format.toLowerCase();

    if (formatLower == "mp3")
    {
        args.add("-codec:a");
        args.add("libmp3lame");
        // quality = bitrate in kbps (128, 192, 256, 320)
        int bitrate = (quality > 0) ? quality : 320;
        args.add("-b:a");
        args.add(juce::String(bitrate) + "k");
    }
    else if (formatLower == "ogg")
    {
        args.add("-codec:a");
        args.add("libvorbis");
        // quality = vorbis quality level (0-10, default 6)
        int q = (quality > 0) ? quality : 6;
        args.add("-q:a");
        args.add(juce::String(q));
    }
    else
    {
        // WAV/AIFF/FLAC sample rate conversion only — keep format as-is
        // ffmpeg auto-detects output format from extension
    }

    args.add(outputFile.getFullPathName());        // Output file

    logToDisk("convertWithFFmpeg: Running: " + args.joinIntoString(" "));

    // Run ffmpeg as child process
    juce::ChildProcess process;
    if (!process.start(args))
    {
        logToDisk("convertWithFFmpeg: FAIL - could not start ffmpeg process");
        return false;
    }

    // Wait for completion (up to 5 minutes for large files)
    if (!process.waitForProcessToFinish(300000))
    {
        logToDisk("convertWithFFmpeg: FAIL - ffmpeg timed out after 5 minutes");
        process.kill();
        return false;
    }

    int exitCode = process.getExitCode();
    if (exitCode != 0)
    {
        juce::String errOutput = process.readAllProcessOutput();
        logToDisk("convertWithFFmpeg: FAIL - ffmpeg exit code " + juce::String(exitCode) + " output: " + errOutput);
        return false;
    }

    if (!outputFile.existsAsFile())
    {
        logToDisk("convertWithFFmpeg: FAIL - output file not created");
        return false;
    }

    logToDisk("convertWithFFmpeg: SUCCESS - " + outputFile.getFullPathName() +
              " (" + juce::String(outputFile.getSize() / 1024) + " KB)");
    return true;
}

//==============================================================================
// Offline Render/Export

bool AudioEngine::renderProject(const juce::String& source, double startTime, double endTime,
                                const juce::String& filePath, const juce::String& format,
                                double renderSampleRate, int bitDepth, int numChannels,
                                bool normalize, bool addTail, double tailLengthMs)
{
    logToDisk("renderProject: START - file=" + filePath + " format=" + format +
              " range=" + juce::String(startTime) + "-" + juce::String(endTime) +
              " sr=" + juce::String(renderSampleRate) + " bits=" + juce::String(bitDepth) +
              " ch=" + juce::String(numChannels) +
              " normalize=" + juce::String(normalize ? "true" : "false") +
              " addTail=" + juce::String(addTail ? "true" : "false") +
              " tailMs=" + juce::String(tailLengthMs));

    // ========== 1. Validate inputs ==========
    if (endTime <= startTime)
    {
        logToDisk("renderProject: FAIL - endTime (" + juce::String(endTime) +
                  ") <= startTime (" + juce::String(startTime) + ")");
        return false;
    }
    // Use requested sample rate for render if provided, otherwise fall back to device rate.
    // PlaybackEngine::fillTrackBuffer() handles per-file SR conversion automatically,
    // so rendering at a different rate than the device is fully supported.
    double actualSampleRate = (renderSampleRate > 0) ? renderSampleRate : currentSampleRate;
    if (actualSampleRate <= 0) actualSampleRate = 44100.0;
    if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32) bitDepth = 24;
    if (numChannels < 1 || numChannels > 2) numChannels = 2;

    // Determine if we need post-processing (lossy encoding only — SR conversion
    // is now handled natively by rendering at the target rate)
    juce::String formatLower = format.toLowerCase();
    bool isLossyFormat = (formatLower == "mp3" || formatLower == "ogg");
    bool needsFFmpegPostProcess = isLossyFormat;

    // For lossy formats, bitDepth holds codec quality:
    //   MP3: bitrate in kbps (128, 192, 256, 320)
    //   OGG: quality level (1-10)
    int codecQuality = isLossyFormat ? bitDepth : 0;
    if (isLossyFormat) bitDepth = 24; // Render intermediate WAV at 24-bit

    // Parse stem track filter from source (e.g., "stem:trackId123")
    juce::String stemTrackId;
    bool isStemRender = source.startsWith("stem:");
    if (isStemRender)
        stemTrackId = source.substring(5); // After "stem:"

    logToDisk("renderProject: Using actualSampleRate=" + juce::String(actualSampleRate) +
              (actualSampleRate != currentSampleRate ? " (differs from device rate " + juce::String(currentSampleRate) + ")" : " (device rate)"));
    if (isLossyFormat)
        logToDisk("renderProject: Lossy format=" + formatLower + " codecQuality=" + juce::String(codecQuality));
    if (isStemRender)
        logToDisk("renderProject: Stem render for trackId=" + stemTrackId);

    // ========== 2. Stop real-time playback and block audio callback ==========
    bool wasPlaying = isPlaying.load();
    bool wasRecording = isRecordMode.load();
    if (wasPlaying) isPlaying = false;
    if (wasRecording) isRecordMode = false;
    isRendering = true;  // Block audio callback from processing FX plugins
    juce::Thread::sleep(100); // Let audio callback finish current block

    // ========== 3. Snapshot clip data ==========
    auto clipSnapshot = playbackEngine.getClipSnapshot();
    logToDisk("renderProject: Clip snapshot has " + juce::String((int)clipSnapshot.size()) + " clips");

    if (clipSnapshot.empty())
    {
        logToDisk("renderProject: WARNING - No clips in playback engine! Render will be silent.");
    }

    // Log each clip for debugging
    for (size_t i = 0; i < clipSnapshot.size(); ++i)
    {
        const auto& clip = clipSnapshot[i];
        logToDisk("  Clip " + juce::String((int)i) + ": track=" + clip.trackId +
                  " file=" + clip.audioFile.getFileName() +
                  " start=" + juce::String(clip.startTime) +
                  " dur=" + juce::String(clip.duration) +
                  " offset=" + juce::String(clip.offset) +
                  " active=" + juce::String(clip.isActive ? "true" : "false"));
    }

    // ========== 4. Snapshot track params ==========
    struct TrackSnapshot {
        juce::String id;
        float volumeDB;
        float pan;
        bool muted;
        bool soloed;
    };
    std::vector<TrackSnapshot> trackSnapshots;
    bool anySoloed = false;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        for (const auto& trackId : trackOrder)
        {
            auto it = trackMap.find(trackId);
            if (it == trackMap.end() || !it->second) continue;
            auto* track = it->second;
            TrackSnapshot snap;
            snap.id = trackId;
            snap.volumeDB = track->getVolume();
            snap.pan = track->getPan();
            snap.muted = track->getMute();
            snap.soloed = track->getSolo();
            if (snap.soloed) anySoloed = true;
            trackSnapshots.push_back(snap);
            logToDisk("  Track " + trackId + ": vol=" + juce::String(snap.volumeDB) +
                      "dB pan=" + juce::String(snap.pan) +
                      " mute=" + juce::String(snap.muted ? "true" : "false") +
                      " solo=" + juce::String(snap.soloed ? "true" : "false"));
        }
    }

    logToDisk("renderProject: " + juce::String((int)trackSnapshots.size()) + " tracks, anySoloed=" + juce::String(anySoloed ? "true" : "false"));

    // ========== 5. Create format writer ==========
    // For lossy formats (mp3/ogg) or sample rate conversion, render to temp WAV first
    juce::File outputFile(filePath);
    juce::File renderFile = outputFile; // File we actually write to (may be temp WAV)

    if (needsFFmpegPostProcess)
    {
        // Create temp WAV file next to the output
        renderFile = outputFile.getParentDirectory().getChildFile(
            outputFile.getFileNameWithoutExtension() + "_temp_render.wav");
    }

    std::unique_ptr<juce::AudioFormat> audioFormat;
    juce::String renderFormatLower = needsFFmpegPostProcess ? "wav" : formatLower;

    if (renderFormatLower == "wav")
        audioFormat = std::make_unique<juce::WavAudioFormat>();
    else if (renderFormatLower == "aiff" || renderFormatLower == "aif")
        audioFormat = std::make_unique<juce::AiffAudioFormat>();
    else if (renderFormatLower == "flac")
    {
        audioFormat = std::make_unique<juce::FlacAudioFormat>();
        if (bitDepth > 24) bitDepth = 24; // FLAC max 24-bit
    }
    else
    {
        logToDisk("renderProject: FAIL - unsupported format: " + format);
        isRendering = false;
        return false;
    }

    renderFile.getParentDirectory().createDirectory();
    if (renderFile.existsAsFile())
        renderFile.deleteFile();
    if (outputFile.existsAsFile())
        outputFile.deleteFile();

    auto fileStream = std::make_unique<juce::FileOutputStream>(renderFile);
    if (fileStream->failedToOpen())
    {
        logToDisk("renderProject: FAIL - could not open output file: " + renderFile.getFullPathName());
        isRendering = false;
        return false;
    }

    // Determine writer channels (always render in stereo internally, downmix to mono if needed)
    int writerChannels = numChannels;

    std::unique_ptr<juce::AudioFormatWriter> writer(
        audioFormat->createWriterFor(fileStream.get(),
                                     actualSampleRate,
                                     writerChannels,
                                     bitDepth,
                                     {}, // metadata
                                     0)); // quality
    if (!writer)
    {
        logToDisk("renderProject: FAIL - could not create writer (sr=" +
                  juce::String(actualSampleRate) + " bits=" + juce::String(bitDepth) +
                  " ch=" + juce::String(writerChannels) + ")");
        isRendering = false;
        return false;
    }
    fileStream.release(); // Writer owns the stream now

    // ========== 6. Calculate total samples ==========
    double tailSeconds = addTail ? (tailLengthMs / 1000.0) : 0.0;
    double totalDuration = (endTime - startTime) + tailSeconds;
    juce::int64 totalSamples = (juce::int64)(totalDuration * actualSampleRate);
    const int blockSize = 2048;  // Larger block size for faster offline rendering

    logToDisk("renderProject: totalDuration=" + juce::String(totalDuration) +
              "s totalSamples=" + juce::String(totalSamples) +
              " blockSize=" + juce::String(blockSize));

    // ========== 6b. Save plugin state & prepare plugins for offline rendering ==========
    // Plugins were prepared for the device's buffer size (e.g. 128/256). The render
    // uses 512-sample blocks. We must re-prepare all FX plugins with the render block
    // size, otherwise plugins like Amplitube overflow internal buffers → noise/crash.
    // We also reset() to clear stale state from real-time playback.

    // Collect all FX processors that will be used during render
    struct PluginStateBackup {
        juce::AudioProcessor* processor;
        juce::MemoryBlock savedState;
    };
    std::vector<PluginStateBackup> pluginBackups;

    // Lambda to save state, prepare, and reset a processor for render
    auto prepareProcessorForRender = [&](juce::AudioProcessor* proc) {
        if (!proc) return;
        // Save current state
        PluginStateBackup backup;
        backup.processor = proc;
        proc->getStateInformation(backup.savedState);
        pluginBackups.push_back(std::move(backup));
        // Re-prepare for render block size
        prepareHostedProcessorForPrecision(proc, actualSampleRate, blockSize, processingPrecisionMode);
        proc->reset();
    };

    // Prepare track FX plugins
    for (const auto& snap : trackSnapshots)
    {
        auto it = trackMap.find(snap.id);
        if (it == trackMap.end() || !it->second) continue;
        auto* track = it->second;
        for (int fx = 0; fx < track->getNumInputFX(); ++fx)
            prepareProcessorForRender(track->getInputFXProcessor(fx));
        for (int fx = 0; fx < track->getNumTrackFX(); ++fx)
            prepareProcessorForRender(track->getTrackFXProcessor(fx));
    }

    DesiredFXStageSpec renderMasterSpec;
    {
        const juce::ScopedLock stageLock(mainProcessorGraph->getCallbackLock());
        renderMasterSpec = desiredMasterStageSpec;
    }
    syncStageSpecStateFromActive(renderMasterSpec, std::atomic_load_explicit(&realtimeMasterFXSnapshot, std::memory_order_acquire));

    juce::String renderStageError;
    auto renderMasterStage = buildActiveFXStage(renderMasterSpec, actualSampleRate, blockSize, processingPrecisionMode, false, renderStageError);
    if (!renderMasterStage && !renderMasterSpec.slots.empty())
    {
        logToDisk("renderProject: FAIL - could not build master stage: " + renderStageError);
        isRendering = false;
        return false;
    }

    if (renderMasterStage)
    {
        for (const auto& slot : renderMasterStage->slots)
            prepareProcessorForRender(slot.processor.get());
    }

    logToDisk("renderProject: Saved & prepared " + juce::String((int)pluginBackups.size()) + " FX plugins for render");

    // ========== 7 & 8. Render loop (with optional 2-pass normalization) ==========
    int numPasses = normalize ? 2 : 1;
    float normGain = 1.0f;
    float peakLevel = 0.0f;

    // Dither state (0 = off, 1 = TPDF, 2 = noise-shaped)
    int ditherMode = pendingDitherMode_.load();
    pendingDitherMode_ = 0; // Reset for next render call
    juce::Random ditherRng;
    float ditherErrorState[2] = { 0.0f, 0.0f }; // Per-channel error feedback for noise shaping

    // Check if metronome was enabled for render
    bool renderMetronomeAudio = metronome.isEnabled();

    for (int pass = 0; pass < numPasses; ++pass)
    {
        logToDisk("renderProject: Pass " + juce::String(pass + 1) + " of " + juce::String(numPasses));

        // Reset all FX plugins at the start of each pass so they begin from a clean state.
        // This is critical for 2-pass normalization: pass 2 must produce identical output
        // to pass 1, which requires identical initial plugin state.
        for (auto& backup : pluginBackups)
        {
            if (backup.processor)
            {
                backup.processor->setStateInformation(backup.savedState.getData(),
                                                       (int)backup.savedState.getSize());
                backup.processor->reset();
            }
        }

        // Create fresh offline playback engine for each pass (deterministic reads)
        PlaybackEngine passPlayback;
        passPlayback.setRenderMode(true);  // Use Lagrange interpolation for high-quality resampling
        for (const auto& clip : clipSnapshot)
        {
            passPlayback.addClip(clip.audioFile, clip.startTime, clip.duration,
                                 clip.trackId, clip.offset, clip.volumeDB,
                                 clip.fadeIn, clip.fadeOut);
        }

        // Create fresh metronome for each pass
        Metronome renderMet;
        if (renderMetronomeAudio)
        {
            renderMet.prepareToPlay(actualSampleRate, blockSize);
            renderMet.setBpm(tempo);
            renderMet.setTimeSignature(timeSigNumerator, timeSigDenominator);
            renderMet.setVolume(metronome.getVolume());
            renderMet.setAccentBeats(metronome.getAccentBeats());
            renderMet.setEnabled(true);
        }

        if (pass == 1)
        {
            // Second pass: calculate normalization gain
            if (peakLevel > 0.0f)
                normGain = 1.0f / peakLevel;
            else
                normGain = 1.0f;
            logToDisk("renderProject: Normalize gain = " + juce::String(normGain) +
                      " (peak was " + juce::String(peakLevel) + ")");
        }

        juce::int64 samplesRemaining = totalSamples;
        double currentTimeSeconds = startTime;
        double samplePositionForMetronome = startTime * actualSampleRate;
        float passPeak = 0.0f; // Track peak for this pass

        while (samplesRemaining > 0)
        {
            int samplesThisBlock = (int)std::min((juce::int64)blockSize, samplesRemaining);

            // Master buffer (always stereo internally)
            juce::AudioBuffer<float> masterBuffer(2, samplesThisBlock);
            masterBuffer.clear();
            juce::AudioBuffer<double> masterBufferDouble(2, samplesThisBlock);
            masterBufferDouble.clear();
            const bool renderHybrid64 = processingPrecisionMode == ProcessingPrecisionMode::Hybrid64;

            // Add metronome if enabled
            if (renderMetronomeAudio)
            {
                renderMet.getNextAudioBlock(masterBuffer, samplePositionForMetronome);
                if (renderHybrid64)
                {
                    for (int ch = 0; ch < 2; ++ch)
                    {
                        auto* src = masterBuffer.getReadPointer(ch);
                        auto* dest = masterBufferDouble.getWritePointer(ch);
                        for (int sample = 0; sample < samplesThisBlock; ++sample)
                            dest[sample] = static_cast<double>(src[sample]);
                    }
                }
            }

            // Process each track
            for (const auto& snap : trackSnapshots)
            {
                // Stem rendering: only process the specified track
                if (isStemRender && snap.id != stemTrackId) continue;

                // Skip muted tracks (unless stem render — always render the target track)
                if (!isStemRender && snap.muted) continue;
                // If any track is soloed, skip non-soloed tracks (unless stem render)
                if (!isStemRender && anySoloed && !snap.soloed) continue;

                // Fill track buffer from clips
                juce::AudioBuffer<float> trackBuffer(2, samplesThisBlock);
                trackBuffer.clear();
                passPlayback.fillTrackBuffer(snap.id, trackBuffer, currentTimeSeconds,
                                             samplesThisBlock, actualSampleRate);

                // Process track FX chain BEFORE volume/pan (matches real-time signal flow)
                // Channel-safe: expand buffer if plugin needs more channels than our stereo buffer
                {
                    auto it = trackMap.find(snap.id);
                    if (it != trackMap.end() && it->second)
                    {
                        auto* track = it->second;
                        juce::MidiBuffer midiMessages = buildTrackMidiBlock(snap.id, currentTimeSeconds,
                                                                            samplesThisBlock, actualSampleRate, true);
                        if (auto* instrument = track->getInstrument())
                            instrument->setPlayHead(this);
                        int numInputFX = track->getNumInputFX();
                        int numTrackFX = track->getNumTrackFX();
                        const bool hasInstrument = track->getTrackType() == TrackType::Instrument
                                                && track->getInstrument() != nullptr;
                        if (numInputFX > 0 || numTrackFX > 0 || hasInstrument)
                        {
                            auto safeRenderFX = [&](juce::AudioProcessor* proc) {
                                int pluginCh = juce::jmax(proc->getTotalNumInputChannels(),
                                                          proc->getTotalNumOutputChannels());
                                const bool useDoublePrecision = renderHybrid64
                                                             && proc->supportsDoublePrecisionProcessing();
                                if (useDoublePrecision)
                                {
                                    juce::AudioBuffer<double> doubleBuffer(pluginCh, samplesThisBlock);
                                    doubleBuffer.clear();
                                    for (int ch = 0; ch < juce::jmin(trackBuffer.getNumChannels(), pluginCh); ++ch)
                                    {
                                        auto* src = trackBuffer.getReadPointer(ch);
                                        auto* dest = doubleBuffer.getWritePointer(ch);
                                        for (int sample = 0; sample < samplesThisBlock; ++sample)
                                            dest[sample] = static_cast<double>(src[sample]);
                                    }

                                    proc->processBlock(doubleBuffer, midiMessages);

                                    const int availableDoubleChannels = juce::jmax(1, pluginCh);
                                    for (int ch = 0; ch < trackBuffer.getNumChannels(); ++ch)
                                    {
                                        auto* dest = trackBuffer.getWritePointer(ch);
                                        auto* src = doubleBuffer.getReadPointer(juce::jmin(ch, availableDoubleChannels - 1));
                                        for (int sample = 0; sample < samplesThisBlock; ++sample)
                                            dest[sample] = static_cast<float>(src[sample]);
                                    }
                                }
                                else if (pluginCh <= trackBuffer.getNumChannels())
                                {
                                    proc->processBlock(trackBuffer, midiMessages);
                                    // Mono plugin on stereo track: duplicate output to all channels
                                    int outCh = proc->getTotalNumOutputChannels();
                                    if (outCh > 0 && outCh < trackBuffer.getNumChannels())
                                    {
                                        for (int ch = outCh; ch < trackBuffer.getNumChannels(); ++ch)
                                            trackBuffer.copyFrom (ch, 0, trackBuffer, 0, 0, samplesThisBlock);
                                    }
                                }
                                else
                                {
                                    // Expand buffer for this plugin (render thread — allocation OK)
                                    juce::AudioBuffer<float> expanded(pluginCh, samplesThisBlock);
                                    expanded.clear();
                                    for (int ch = 0; ch < trackBuffer.getNumChannels(); ++ch)
                                        expanded.copyFrom(ch, 0, trackBuffer, ch, 0, samplesThisBlock);
                                    proc->processBlock(expanded, midiMessages);
                                    for (int ch = 0; ch < trackBuffer.getNumChannels(); ++ch)
                                        trackBuffer.copyFrom(ch, 0, expanded, ch, 0, samplesThisBlock);
                                }
                            };
                            for (int fx = 0; fx < numInputFX; ++fx)
                            {
                                auto* proc = track->getInputFXProcessor(fx);
                                if (proc) safeRenderFX(proc);
                            }
                            if (hasInstrument)
                                safeRenderFX(track->getInstrument());
                            for (int fx = 0; fx < numTrackFX; ++fx)
                            {
                                auto* proc = track->getTrackFXProcessor(fx);
                                if (proc) safeRenderFX(proc);
                            }
                        }
                    }
                }

                // Apply per-track volume/pan AFTER FX (matches real-time signal flow)
                float volumeGain = juce::Decibels::decibelsToGain(snap.volumeDB);
                float leftGain = 1.0f;
                float rightGain = 1.0f;
                computePanLawGains(currentPanLaw, snap.pan, volumeGain, leftGain, rightGain);

                juce::FloatVectorOperations::multiply(trackBuffer.getWritePointer(0), leftGain, samplesThisBlock);
                juce::FloatVectorOperations::multiply(trackBuffer.getWritePointer(1), rightGain, samplesThisBlock);

                // Mix into master buffer
                for (int ch = 0; ch < 2; ++ch)
                {
                    if (renderHybrid64)
                    {
                        auto* dest = masterBufferDouble.getWritePointer(ch);
                        auto* src = trackBuffer.getReadPointer(ch);
                        for (int sample = 0; sample < samplesThisBlock; ++sample)
                            dest[sample] += static_cast<double>(src[sample]);
                    }
                    else
                    {
                        masterBuffer.addFrom(ch, 0, trackBuffer, ch, 0, samplesThisBlock);
                    }
                }
            }

            // Process master FX chain (channel-safe, render thread — allocation OK)
            // Skip master FX for stem renders (export raw track output)
            if (!isStemRender && renderMasterStage && !renderMasterStage->slots.empty())
            {
                juce::MidiBuffer dummyMidi;
                for (const auto& slot : renderMasterStage->slots)
                {
                    if (!slot.processor || slot.bypassed)
                        continue;

                    auto* proc = slot.processor.get();
                    int pluginCh = juce::jmax(proc->getTotalNumInputChannels(),
                                               proc->getTotalNumOutputChannels());
                    const bool useDoublePrecision = renderHybrid64
                                                 && !slot.forceFloat
                                                 && slot.supportsDouble;
                    if (useDoublePrecision)
                    {
                        juce::AudioBuffer<double> expanded(juce::jmax(2, pluginCh), samplesThisBlock);
                        expanded.clear();
                        for (int ch = 0; ch < juce::jmin(masterBufferDouble.getNumChannels(), expanded.getNumChannels()); ++ch)
                        {
                            auto* src = masterBufferDouble.getReadPointer(ch);
                            auto* dest = expanded.getWritePointer(ch);
                            for (int sample = 0; sample < samplesThisBlock; ++sample)
                                dest[sample] = src[sample];
                        }

                        proc->processBlock(expanded, dummyMidi);

                        for (int ch = 0; ch < masterBufferDouble.getNumChannels(); ++ch)
                        {
                            auto* dest = masterBufferDouble.getWritePointer(ch);
                            auto* src = expanded.getReadPointer(juce::jmin(ch, expanded.getNumChannels() - 1));
                            for (int sample = 0; sample < samplesThisBlock; ++sample)
                                dest[sample] = src[sample];
                        }
                    }
                    else if (pluginCh <= masterBuffer.getNumChannels())
                    {
                        if (renderHybrid64)
                            copyDoubleBufferToFloatBuffer(masterBufferDouble, masterBuffer, masterBuffer.getNumChannels(), samplesThisBlock);
                        proc->processBlock(masterBuffer, dummyMidi);
                        if (renderHybrid64)
                            copyFloatBufferToDoubleBuffer(masterBuffer, masterBufferDouble, masterBuffer.getNumChannels(), samplesThisBlock);
                    }
                    else
                    {
                        if (renderHybrid64)
                            copyDoubleBufferToFloatBuffer(masterBufferDouble, masterBuffer, masterBuffer.getNumChannels(), samplesThisBlock);
                        juce::AudioBuffer<float> expanded(pluginCh, samplesThisBlock);
                        expanded.clear();
                        for (int ch = 0; ch < masterBuffer.getNumChannels(); ++ch)
                            expanded.copyFrom(ch, 0, masterBuffer, ch, 0, samplesThisBlock);
                        proc->processBlock(expanded, dummyMidi);
                        for (int ch = 0; ch < masterBuffer.getNumChannels(); ++ch)
                            masterBuffer.copyFrom(ch, 0, expanded, ch, 0, samplesThisBlock);
                        if (renderHybrid64)
                            copyFloatBufferToDoubleBuffer(masterBuffer, masterBufferDouble, masterBuffer.getNumChannels(), samplesThisBlock);
                    }
                }
            }

            // Apply master pan (constant power law) — skip for stem renders
            if (!isStemRender)
            {
                float leftGain = 1.0f;
                float rightGain = 1.0f;
                computePanLawGains(currentPanLaw, masterPan, 1.0f, leftGain, rightGain);

                if (renderHybrid64)
                    applyStereoPanToDoubleBuffer(masterBufferDouble, samplesThisBlock, leftGain, rightGain);
                else
                {
                    juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(0), leftGain, samplesThisBlock);
                    juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(1), rightGain, samplesThisBlock);
                }
            }

            // Apply master volume — skip for stem renders
            if (!isStemRender)
            {
                if (renderHybrid64)
                {
                    applyGainToDoubleBuffer(masterBufferDouble, 2, samplesThisBlock, masterVolume);
                }
                else
                {
                    for (int ch = 0; ch < 2; ++ch)
                        juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(ch), masterVolume, samplesThisBlock);
                }
            }

            // Apply normalization gain (pass 2 only)
            if (pass == 1 && normGain != 1.0f)
            {
                if (renderHybrid64)
                {
                    applyGainToDoubleBuffer(masterBufferDouble, 2, samplesThisBlock, normGain);
                }
                else
                {
                    for (int ch = 0; ch < 2; ++ch)
                        juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(ch), normGain, samplesThisBlock);
                }
            }

            if (!isStemRender && masterMono.load(std::memory_order_relaxed))
            {
                if (renderHybrid64)
                    downmixDoubleBufferToMono(masterBufferDouble, samplesThisBlock);
                else
                {
                    for (int sample = 0; sample < samplesThisBlock; ++sample)
                    {
                        float mono = (masterBuffer.getSample(0, sample) + masterBuffer.getSample(1, sample)) * 0.5f;
                        masterBuffer.setSample(0, sample, mono);
                        masterBuffer.setSample(1, sample, mono);
                    }
                }
            }

            // Measure peak level
            if (renderHybrid64)
            {
                passPeak = juce::jmax(passPeak, findPeakInDoubleBuffer(masterBufferDouble, 2, samplesThisBlock));
            }
            else
            {
                for (int ch = 0; ch < 2; ++ch)
                {
                    auto range = masterBuffer.findMinMax(ch, 0, samplesThisBlock);
                    float chPeak = std::max(std::abs(range.getStart()), std::abs(range.getEnd()));
                    if (chPeak > passPeak) passPeak = chPeak;
                }
            }

            if (pass == 0 && normalize)
            {
                // Pass 1: accumulate peak for normalization
                if (passPeak > peakLevel) peakLevel = passPeak;
            }

            // Write to file (final pass only)
            bool isFinalPass = (pass == numPasses - 1);
            if (isFinalPass)
            {
                if (renderHybrid64)
                    copyDoubleBufferToFloatBuffer(masterBufferDouble, masterBuffer, 2, samplesThisBlock);

                // Apply dither if requested (before bit-depth truncation by the writer)
                if (ditherMode > 0 && bitDepth < 32)
                {
                    // ditherMode 1 = TPDF, 2 = noise-shaped (first-order high-pass)
                    float ditherAmp = 1.0f / static_cast<float>(1 << (bitDepth - 1)); // 1 LSB
                    for (int ch = 0; ch < masterBuffer.getNumChannels(); ++ch)
                    {
                        float* data = masterBuffer.getWritePointer(ch);
                        for (int s = 0; s < samplesThisBlock; ++s)
                        {
                            // TPDF: two uniform randoms → triangular PDF
                            float r1 = (ditherRng.nextFloat() * 2.0f - 1.0f) * ditherAmp;
                            float r2 = (ditherRng.nextFloat() * 2.0f - 1.0f) * ditherAmp;
                            float noise = r1 + r2;

                            if (ditherMode == 2)
                            {
                                // First-order noise shaping: subtract previous quantization error
                                float shaped = noise - ditherErrorState[ch];
                                float original = data[s];
                                data[s] = original + shaped;
                                // Quantize to calculate error for next sample
                                float scale = static_cast<float>(1 << (bitDepth - 1));
                                float quantized = std::round(data[s] * scale) / scale;
                                ditherErrorState[ch] = quantized - original;
                            }
                            else
                            {
                                data[s] += noise;
                            }
                        }
                    }
                }

                if (numChannels == 1)
                {
                    // Mono downmix: average L+R
                    juce::AudioBuffer<float> monoBuffer(1, samplesThisBlock);
                    monoBuffer.clear();
                    monoBuffer.addFrom(0, 0, masterBuffer, 0, 0, samplesThisBlock, 0.5f);
                    monoBuffer.addFrom(0, 0, masterBuffer, 1, 0, samplesThisBlock, 0.5f);
                    writer->writeFromAudioSampleBuffer(monoBuffer, 0, samplesThisBlock);
                }
                else
                {
                    writer->writeFromAudioSampleBuffer(masterBuffer, 0, samplesThisBlock);
                }
            }

            currentTimeSeconds += (double)samplesThisBlock / actualSampleRate;
            samplePositionForMetronome += samplesThisBlock;
            samplesRemaining -= samplesThisBlock;
        }

        logToDisk("renderProject: Pass " + juce::String(pass + 1) + " complete. Peak level: " + juce::String(passPeak));
    }

    // Flush and close
    writer.reset();

    // ========== 9. FFmpeg post-processing (lossy encoding only) ==========
    if (needsFFmpegPostProcess)
    {
        logToDisk("renderProject: Starting FFmpeg post-processing (lossy encoding)...");
        // SR conversion is already handled natively — no need to pass targetSR here
        bool ffmpegOk = convertWithFFmpeg(renderFile, outputFile, formatLower, 0, codecQuality);

        // Clean up temp file
        renderFile.deleteFile();

        if (!ffmpegOk)
        {
            logToDisk("renderProject: FAIL - FFmpeg post-processing failed");
            // Restore plugins before returning (clamp max-block to at least 512)
            for (auto& backup : pluginBackups)
            {
                if (backup.processor)
                {
                    backup.processor->prepareToPlay(currentSampleRate, juce::jmax(currentBlockSize, 512));
                    backup.processor->setStateInformation(backup.savedState.getData(),
                                                           (int)backup.savedState.getSize());
                    backup.processor->reset();
                }
            }
            isRendering = false;
            return false;
        }
    }

    // ========== 10. Restore plugin state for real-time playback ==========
    // Re-prepare all FX plugins for the device's buffer size and restore their
    // saved state so real-time playback continues as if render never happened.
    // Clamp max-block to at least 512 (same rationale as track FX preparation).
    for (auto& backup : pluginBackups)
    {
        if (backup.processor)
        {
            backup.processor->prepareToPlay(currentSampleRate, juce::jmax(currentBlockSize, 512));
            backup.processor->setStateInformation(backup.savedState.getData(),
                                                   (int)backup.savedState.getSize());
            backup.processor->reset();
        }
    }
    logToDisk("renderProject: Restored " + juce::String((int)pluginBackups.size()) + " FX plugins for real-time");

    // Re-enable audio callback
    isRendering = false;

    logToDisk("renderProject: SUCCESS - " + outputFile.getFullPathName() +
              " (" + juce::String(outputFile.getSize() / 1024) + " KB)");

    return true;
}

bool AudioEngine::renderProjectWithDither(const juce::String& source, double startTime, double endTime,
                                          const juce::String& filePath, const juce::String& format,
                                          double renderSampleRate, int bitDepth, int numChannels,
                                          bool normalize, bool addTail, double tailLengthMs,
                                          const juce::String& ditherType)
{
    // Map dither type string to mode: "tpdf" → 1, "shaped" → 2, else → 0
    if (ditherType == "tpdf")
        pendingDitherMode_ = 1;
    else if (ditherType == "shaped")
        pendingDitherMode_ = 2;
    else
        pendingDitherMode_ = 0;

    return renderProject(source, startTime, endTime, filePath, format,
                         renderSampleRate, bitDepth, numChannels,
                         normalize, addTail, tailLengthMs);
}

//==============================================================================
// Automation (Phase 1.1)

static AutomationList* getAutomationListForParam(TrackProcessor* track, const juce::String& parameterId)
{
    if (parameterId == "volume")
        return &track->getVolumeAutomation();
    if (parameterId == "pan")
        return &track->getPanAutomation();
    // Future: plugin parameter automation would go here
    return nullptr;
}

static AutomationMode parseAutomationMode(const juce::String& modeStr)
{
    if (modeStr == "read")  return AutomationMode::Read;
    if (modeStr == "write") return AutomationMode::Write;
    if (modeStr == "touch") return AutomationMode::Touch;
    if (modeStr == "latch") return AutomationMode::Latch;
    return AutomationMode::Off;
}

static juce::String automationModeToString(AutomationMode mode)
{
    switch (mode)
    {
        case AutomationMode::Read:  return "read";
        case AutomationMode::Write: return "write";
        case AutomationMode::Touch: return "touch";
        case AutomationMode::Latch: return "latch";
        case AutomationMode::Off:
        default:                    return "off";
    }
}

void AudioEngine::setAutomationPoints(const juce::String& trackId, const juce::String& parameterId,
                                       const juce::String& pointsJSON)
{
    // Master automation special case
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
        if (!list) return;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second)
            return;
        list = getAutomationListForParam(it->second, parameterId);
        if (!list)
            return;
    }

    // Parse JSON array of { time: <seconds>, value: <float> }
    auto parsed = juce::JSON::parse(pointsJSON);
    if (!parsed.isArray())
        return;

    auto* arr = parsed.getArray();
    std::vector<AutomationPoint> points;
    points.reserve(static_cast<size_t>(arr->size()));

    for (const auto& item : *arr)
    {
        double timeSec = item.getProperty("time", 0.0);
        float value = static_cast<float>(static_cast<double>(item.getProperty("value", 0.0)));
        // Convert seconds to samples for the audio thread
        double timeSamples = timeSec * currentSampleRate;
        points.push_back({ timeSamples, value });
    }

    list->setPoints(std::move(points));

    juce::Logger::writeToLog("AudioEngine: Set " + juce::String(static_cast<int>(points.size())) +
                             " automation points for track " + trackId + " param " + parameterId);
}

void AudioEngine::setAutomationMode(const juce::String& trackId, const juce::String& parameterId,
                                     const juce::String& modeStr)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
        if (!list) return;

        auto mode = parseAutomationMode(modeStr);
        list->setMode(mode);

        if (mode != AutomationMode::Off)
        {
            if (parameterId == "volume")
                list->setDefaultValue(masterVolume);
            else if (parameterId == "pan")
                list->setDefaultValue(masterPan);
        }
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second)
            return;

        list = getAutomationListForParam(it->second, parameterId);
        if (!list)
            return;

        auto mode = parseAutomationMode(modeStr);
        list->setMode(mode);

        if (mode != AutomationMode::Off)
        {
            if (parameterId == "volume")
                list->setDefaultValue(it->second->getVolume());
            else if (parameterId == "pan")
                list->setDefaultValue(it->second->getPan());
        }
    }

    juce::Logger::writeToLog("AudioEngine: Set automation mode for track " + trackId +
                             " param " + parameterId + " = " + modeStr);
}

juce::String AudioEngine::getAutomationMode(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second)
            return "off";
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (!list)
        return "off";

    return automationModeToString(list->getMode());
}

void AudioEngine::clearAutomation(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second) return;
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (list)
        list->clear();
}

void AudioEngine::beginTouchAutomation(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second) return;
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (list)
        list->beginTouch();
}

void AudioEngine::endTouchAutomation(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second) return;
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (list)
        list->endTouch();
}

//==============================================================================
// Tempo Map (Phase 1.2)

void AudioEngine::setTempoMarkers(const juce::String& markersJSON)
{
    auto parsed = juce::JSON::parse(markersJSON);
    if (!parsed.isArray())
        return;

    std::vector<TempoMarker> newMarkers;
    auto* arr = parsed.getArray();
    for (const auto& item : *arr)
    {
        if (auto* obj = item.getDynamicObject())
        {
            double t = obj->getProperty("time");
            double b = obj->getProperty("tempo");
            if (b > 0.0)
                newMarkers.push_back({ t, b });
        }
    }

    // Sort by time
    std::sort(newMarkers.begin(), newMarkers.end(),
              [](const TempoMarker& a, const TempoMarker& b) { return a.timeSeconds < b.timeSeconds; });

    {
        const juce::ScopedLock sl(tempoMapLock);
        tempoMarkers = std::move(newMarkers);
    }
}

double AudioEngine::getTempoAtTime(double timeSeconds) const
{
    const juce::ScopedTryLock stl(tempoMapLock);
    if (!stl.isLocked() || tempoMarkers.empty())
        return tempo;  // Fallback to global BPM

    // Binary search for the last marker at or before timeSeconds
    // std::upper_bound gives first marker AFTER timeSeconds, so decrement by 1
    auto it = std::upper_bound(tempoMarkers.begin(), tempoMarkers.end(), timeSeconds,
                               [](double t, const TempoMarker& m) { return t < m.timeSeconds; });

    if (it == tempoMarkers.begin())
        return tempo;  // Before first marker — use global BPM

    --it;
    return it->bpm;
}

void AudioEngine::clearTempoMarkers()
{
    const juce::ScopedLock sl(tempoMapLock);
    tempoMarkers.clear();
}

//==============================================================================
// Control Surface Callbacks (Phase 3.10)

void AudioEngine::onControlSurfaceTrackVolume(const juce::String& trackId, float value01)
{
    // Convert 0..1 to dB: -60 to +6 dB range
    float db = (value01 <= 0.0f) ? -60.0f : (value01 * 66.0f - 60.0f);
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setVolume(db);
}

void AudioEngine::onControlSurfaceTrackPan(const juce::String& trackId, float valueMinus1To1)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setPan(valueMinus1To1);
}

void AudioEngine::onControlSurfaceTrackMute(const juce::String& trackId, bool muted)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setMute(muted);
}

void AudioEngine::onControlSurfaceTrackSolo(const juce::String& trackId, bool soloed)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setSolo(soloed);
        // Recalculate cachedAnySoloed
        bool anySoloed = false;
        for (const auto& pair : trackMap)
            if (pair.second && pair.second->getSolo()) anySoloed = true;
        cachedAnySoloed = anySoloed;
    }
}

void AudioEngine::onControlSurfaceTrackRecordArm(const juce::String& trackId, bool armed)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setRecordArmed(armed);
}

void AudioEngine::onControlSurfaceTransportPlay()
{
    isPlaying = true;
}

void AudioEngine::onControlSurfaceTransportStop()
{
    isPlaying = false;
}

void AudioEngine::onControlSurfaceTransportRecord()
{
    isRecordMode = !isRecordMode.load();
}

void AudioEngine::onControlSurfaceMasterVolume(float value01)
{
    float db = (value01 <= 0.0f) ? -60.0f : (value01 * 66.0f - 60.0f);
    masterVolume = juce::Decibels::decibelsToGain(db);
}

float AudioEngine::getTrackVolume01(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        float db = it->second->getVolume();
        return (db + 60.0f) / 66.0f; // Map -60..+6 to 0..1
    }
    return 0.0f;
}

float AudioEngine::getTrackPan(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getPan();
    return 0.0f;
}

bool AudioEngine::getTrackMuted(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getMute();
    return false;
}

bool AudioEngine::getTrackSoloed(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getSolo();
    return false;
}

std::vector<juce::String> AudioEngine::getTrackIds() const
{
    return trackOrder;
}

//==============================================================================
// Phase 3.12: Strip Silence
//==============================================================================

juce::var AudioEngine::detectSilentRegions(const juce::String& filePath, double thresholdDb,
                                            double minSilenceMs, double minSoundMs,
                                            double preAttackMs, double postReleaseMs)
{
    auto regions = audioAnalyzer.detectSilentRegions(filePath, thresholdDb,
                                                      minSilenceMs, minSoundMs,
                                                      preAttackMs, postReleaseMs);

    // Get sample rate for time conversion
    std::unique_ptr<juce::AudioFormatReader> reader(
        juce::AudioFormatManager().createReaderFor(juce::File(filePath)));

    // Need a fresh format manager for this
    juce::AudioFormatManager fmgr;
    fmgr.registerBasicFormats();
    reader.reset(fmgr.createReaderFor(juce::File(filePath)));

    double sr = reader ? reader->sampleRate : 44100.0;

    juce::Array<juce::var> result;
    for (const auto& r : regions)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("startTime", r.startSample / sr);
        obj->setProperty("endTime", r.endSample / sr);
        obj->setProperty("startSample", (juce::int64)r.startSample);
        obj->setProperty("endSample", (juce::int64)r.endSample);
        result.add(juce::var(obj));
    }
    return juce::var(result);
}

//==============================================================================
// Phase 3.13: Freeze Track
//==============================================================================

juce::var AudioEngine::freezeTrack(const juce::String& trackId)
{
    auto* resultObj = new juce::DynamicObject();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Track not found");
        return juce::var(resultObj);
    }

    TrackProcessor* track = it->second;

    // Use the playback engine's clips for this track to determine the range
    double startTime = 0.0;
    double endTime = 0.0;
    auto allClips = playbackEngine.getClipSnapshot();
    std::vector<PlaybackEngine::ClipInfo> clipList;
    for (const auto& c : allClips)
        if (c.trackId == trackId)
            clipList.push_back(c);
    if (clipList.empty())
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "No clips on track");
        return juce::var(resultObj);
    }

    // Find the time range of all clips on this track
    startTime = std::numeric_limits<double>::max();
    endTime = 0.0;
    for (const auto& clip : clipList)
    {
        startTime = std::min(startTime, clip.startTime);
        endTime = std::max(endTime, clip.startTime + clip.duration);
    }

    // Add tail for FX (reverb, delay)
    double tailMs = 2000.0; // 2 seconds of tail
    endTime += tailMs / 1000.0;

    // Create freeze file in project audio folder
    juce::File freezeDir = projectAudioFolder.isDirectory()
        ? projectAudioFolder
        : juce::File::getSpecialLocation(juce::File::tempDirectory);
    freezeDir.createDirectory();

    juce::String freezeFileName = "freeze_" + trackId + "_" + juce::String(juce::Time::currentTimeMillis()) + ".wav";
    juce::File freezeFile = freezeDir.getChildFile(freezeFileName);

    // Render this single track offline
    double renderRate = currentSampleRate;
    int renderBlockSize = 512;
    juce::int64 totalSamples = (juce::int64)((endTime - startTime) * renderRate);

    if (totalSamples <= 0)
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Empty render range");
        return juce::var(resultObj);
    }

    // Prepare the track's FX for offline rendering
    track->prepareToPlay(renderRate, renderBlockSize);

    // Create output file
    juce::WavAudioFormat wavFormat;
    auto outputStream = std::make_unique<juce::FileOutputStream>(freezeFile);
    if (outputStream->failedToOpen())
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Failed to create freeze file");
        return juce::var(resultObj);
    }

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(outputStream.get(), renderRate, 2, 24, {}, 0));
    if (!writer)
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Failed to create WAV writer");
        return juce::var(resultObj);
    }
    outputStream.release(); // writer owns it now

    // Render loop
    juce::AudioBuffer<float> renderBuffer(2, renderBlockSize);
    juce::AudioBuffer<float> trackBuffer(2, renderBlockSize);
    juce::int64 samplesRendered = 0;
    double samplePos = startTime * renderRate;

    while (samplesRendered < totalSamples)
    {
        int blockSamples = (int)std::min((juce::int64)renderBlockSize, totalSamples - samplesRendered);
        renderBuffer.clear();
        trackBuffer.clear();

        // Fill track buffer from playback engine
        playbackEngine.fillTrackBuffer(trackId, trackBuffer, samplePos / renderRate, blockSamples, renderRate);

        // Process through FX chain
        track->setCurrentBlockPosition(samplePos, renderRate);
        juce::MidiBuffer midiMessages = buildTrackMidiBlock(trackId, samplePos / renderRate,
                                                            blockSamples, renderRate, true);
        juce::AudioBuffer<float> fxBuffer(trackBuffer.getArrayOfWritePointers(), 2, blockSamples);
        track->processBlock(fxBuffer, midiMessages);

        // Write to output
        writer->writeFromAudioSampleBuffer(fxBuffer, 0, blockSamples);

        samplePos += blockSamples;
        samplesRendered += blockSamples;
    }

    writer.reset(); // Flush

    // Re-prepare track for live playback
    track->prepareToPlay(currentSampleRate, currentBlockSize);

    double duration = endTime - startTime;

    resultObj->setProperty("success", true);
    resultObj->setProperty("filePath", freezeFile.getFullPathName());
    resultObj->setProperty("duration", duration);
    resultObj->setProperty("sampleRate", renderRate);
    resultObj->setProperty("startTime", startTime);

    juce::Logger::writeToLog("FreezeTrack: " + trackId + " -> " + freezeFile.getFullPathName() +
                             " (" + juce::String(duration, 2) + "s)");
    return juce::var(resultObj);
}

bool AudioEngine::unfreezeTrack(const juce::String& trackId)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    // Re-prepare track FX for live playback (in case they were in frozen bypass state)
    it->second->prepareToPlay(currentSampleRate, currentBlockSize);

    juce::Logger::writeToLog("UnfreezeTrack: " + trackId);
    return true;
}

// =============================================================================
// Phase 18.10: Clip Gain Envelope
// =============================================================================

void AudioEngine::setClipGainEnvelope(const juce::String& trackId, const juce::String& clipId,
                                       const juce::String& pointsJSON)
{
    // Parse JSON array of {time, gain} points
    auto parsed = juce::JSON::parse(pointsJSON);
    std::vector<PlaybackEngine::GainEnvelopePoint> points;

    if (auto* arr = parsed.getArray())
    {
        for (const auto& item : *arr)
        {
            if (auto* obj = item.getDynamicObject())
            {
                PlaybackEngine::GainEnvelopePoint pt;
                pt.time = static_cast<double>(obj->getProperty("time"));
                pt.gain = static_cast<float>(static_cast<double>(obj->getProperty("gain")));
                points.push_back(pt);
            }
        }
    }

    // Sort by time
    std::sort(points.begin(), points.end(),
              [](const PlaybackEngine::GainEnvelopePoint& a, const PlaybackEngine::GainEnvelopePoint& b) {
                  return a.time < b.time;
              });

    playbackEngine.setClipGainEnvelope(trackId, clipId, points);
    juce::Logger::writeToLog("setClipGainEnvelope: track=" + trackId + " clip=" + clipId +
                             " points=" + juce::String(static_cast<int>(points.size())));
}

// =============================================================================
// Phase 19.7: MIDI Learn
// =============================================================================

void AudioEngine::startMIDILearnForPlugin(const juce::String& trackId, int pluginIndex, int paramIndex)
{
    const juce::ScopedLock sl(midiLearnLock);
    midiLearnTrackId = trackId;
    midiLearnPluginIndex = pluginIndex;
    midiLearnParamIndex = paramIndex;
    midiLearnActive.store(true);
    juce::Logger::writeToLog("MIDI Learn: Started for track=" + trackId +
                             " plugin=" + juce::String(pluginIndex) +
                             " param=" + juce::String(paramIndex));
}

void AudioEngine::stopMIDILearnMode()
{
    midiLearnActive.store(false);
    juce::Logger::writeToLog("MIDI Learn: Stopped");
}

void AudioEngine::clearMIDILearnMapping(int ccNumber)
{
    const juce::ScopedLock sl(midiLearnLock);
    midiLearnMappings.erase(
        std::remove_if(midiLearnMappings.begin(), midiLearnMappings.end(),
                        [ccNumber](const MIDILearnMapping& m) { return m.ccNumber == ccNumber; }),
        midiLearnMappings.end());
    juce::Logger::writeToLog("MIDI Learn: Cleared mapping for CC " + juce::String(ccNumber));
}

juce::var AudioEngine::getMIDILearnMappings()
{
    const juce::ScopedLock sl(midiLearnLock);
    juce::Array<juce::var> result;

    for (const auto& m : midiLearnMappings)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("ccNumber", m.ccNumber);
        obj->setProperty("trackId", m.trackId);
        obj->setProperty("pluginIndex", m.pluginIndex);
        obj->setProperty("paramIndex", m.paramIndex);
        result.add(juce::var(obj));
    }

    return juce::var(result);
}

// =============================================================================
// Phase 19.9: MIDI Import/Export
// =============================================================================

juce::var AudioEngine::importMIDIFile(const juce::String& filePath)
{
    juce::File file(filePath);
    if (!file.existsAsFile())
        return juce::var();

    juce::FileInputStream stream(file);
    if (stream.failedToOpen())
        return juce::var();

    juce::MidiFile midiFile;
    if (!midiFile.readFrom(stream))
        return juce::var();

    // Convert to tick-based time, then convert to seconds
    midiFile.convertTimestampTicksToSeconds();

    auto* result = new juce::DynamicObject();
    result->setProperty("numTracks", midiFile.getNumTracks());
    result->setProperty("ticksPerQuarterNote", midiFile.getTimeFormat());

    juce::Array<juce::var> tracksArray;

    for (int t = 0; t < midiFile.getNumTracks(); ++t)
    {
        const auto* midiTrack = midiFile.getTrack(t);
        if (!midiTrack) continue;

        auto* trackObj = new juce::DynamicObject();
        juce::Array<juce::var> eventsArray;

        for (int i = 0; i < midiTrack->getNumEvents(); ++i)
        {
            const auto* holder = midiTrack->getEventPointer(i);
            const auto& msg = holder->message;

            auto* evtObj = new juce::DynamicObject();
            evtObj->setProperty("timestamp", msg.getTimeStamp());

            if (msg.isNoteOn())
            {
                evtObj->setProperty("type", "noteOn");
                evtObj->setProperty("note", msg.getNoteNumber());
                evtObj->setProperty("velocity", msg.getVelocity());
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isNoteOff())
            {
                evtObj->setProperty("type", "noteOff");
                evtObj->setProperty("note", msg.getNoteNumber());
                evtObj->setProperty("velocity", 0);
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isController())
            {
                evtObj->setProperty("type", "cc");
                evtObj->setProperty("controller", msg.getControllerNumber());
                evtObj->setProperty("value", msg.getControllerValue());
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isPitchWheel())
            {
                evtObj->setProperty("type", "pitchBend");
                evtObj->setProperty("value", msg.getPitchWheelValue());
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isTempoMetaEvent())
            {
                evtObj->setProperty("type", "tempo");
                evtObj->setProperty("bpm", 60000000.0 / msg.getTempoSecondsPerQuarterNote() / 1000000.0);
            }
            else
            {
                continue;
            }

            eventsArray.add(juce::var(evtObj));
        }

        trackObj->setProperty("events", eventsArray);
        tracksArray.add(juce::var(trackObj));
    }

    result->setProperty("tracks", tracksArray);
    juce::Logger::writeToLog("importMIDIFile: " + filePath + " - " +
                             juce::String(midiFile.getNumTracks()) + " tracks");
    return juce::var(result);
}

bool AudioEngine::exportMIDIFile(const juce::String& trackId, const juce::String& clipId,
                                  const juce::String& eventsJSON, const juce::String& outputPath,
                                  double clipTempo)
{
    juce::ignoreUnused(trackId, clipId);

    if (clipTempo <= 0.0) clipTempo = 120.0;

    juce::MidiFile midiFile;
    midiFile.setTicksPerQuarterNote(480);

    juce::MidiMessageSequence sequence;

    // Add tempo event
    sequence.addEvent(juce::MidiMessage::tempoMetaEvent(
        static_cast<int>(60000000.0 / clipTempo)), 0.0);

    // Parse events JSON
    auto parsed = juce::JSON::parse(eventsJSON);
    if (auto* arr = parsed.getArray())
    {
        for (const auto& item : *arr)
        {
            auto* obj = item.getDynamicObject();
            if (!obj) continue;

            juce::String eventType = obj->getProperty("type").toString();
            double timestamp = static_cast<double>(obj->getProperty("timestamp"));
            // Convert seconds to ticks: ticks = seconds * (BPM / 60) * ticksPerQN
            double ticks = timestamp * (clipTempo / 60.0) * 480.0;

            if (eventType == "noteOn")
            {
                int note = static_cast<int>(obj->getProperty("note"));
                int velocity = static_cast<int>(obj->getProperty("velocity"));
                int channel = obj->hasProperty("channel") ? static_cast<int>(obj->getProperty("channel")) : 1;
                sequence.addEvent(juce::MidiMessage::noteOn(channel, note, static_cast<juce::uint8>(velocity)), ticks);
            }
            else if (eventType == "noteOff")
            {
                int note = static_cast<int>(obj->getProperty("note"));
                int channel = obj->hasProperty("channel") ? static_cast<int>(obj->getProperty("channel")) : 1;
                sequence.addEvent(juce::MidiMessage::noteOff(channel, note), ticks);
            }
            else if (eventType == "cc")
            {
                int controller = static_cast<int>(obj->getProperty("controller"));
                int value = static_cast<int>(obj->getProperty("value"));
                int channel = obj->hasProperty("channel") ? static_cast<int>(obj->getProperty("channel")) : 1;
                sequence.addEvent(juce::MidiMessage::controllerEvent(channel, controller, value), ticks);
            }
        }
    }

    sequence.updateMatchedPairs();
    midiFile.addTrack(sequence);

    juce::File outFile(outputPath);
    outFile.deleteFile();
    std::unique_ptr<juce::FileOutputStream> outputStream(outFile.createOutputStream());
    if (!outputStream)
        return false;

    bool success = midiFile.writeTo(*outputStream);
    juce::Logger::writeToLog("exportMIDIFile: " + outputPath + " success=" + juce::String(success ? "true" : "false"));
    return success;
}

// =============================================================================
// Phase 19.14: Plugin Presets
// =============================================================================

juce::var AudioEngine::getPluginPresets(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    juce::ignoreUnused(trackId, fxIndex, isInputFX);

    // List preset files from the presets directory
    juce::File presetsDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                                .getChildFile("OpenStudio").getChildFile("Presets");

    juce::Array<juce::var> result;
    if (presetsDir.isDirectory())
    {
        auto files = presetsDir.findChildFiles(juce::File::findFiles, true, "*.ospreset");
        files.addArray(presetsDir.findChildFiles(juce::File::findFiles, true, "*.s13preset"));
        for (const auto& file : files)
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("name", file.getFileNameWithoutExtension());
            obj->setProperty("path", file.getFullPathName());
            result.add(juce::var(obj));
        }
    }

    return juce::var(result);
}

bool AudioEngine::loadPluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                    const juce::String& presetPath)
{
    juce::File presetFile(presetPath);
    if (!presetFile.existsAsFile())
        return false;

    auto xml = juce::XmlDocument::parse(presetFile);
    if (!xml)
        return false;

    juce::String base64State = xml->getStringAttribute("state");
    if (base64State.isEmpty())
        return false;

    return setPluginState(trackId, fxIndex, isInputFX, base64State);
}

bool AudioEngine::savePluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                    const juce::String& presetPath, const juce::String& presetName)
{
    juce::String base64State = getPluginState(trackId, fxIndex, isInputFX);
    if (base64State.isEmpty())
        return false;

    // Create XML structure
    juce::XmlElement xml("S13Preset");
    xml.setAttribute("name", presetName);
    xml.setAttribute("state", base64State);
    xml.setAttribute("version", "1.0");

    juce::File outFile(presetPath);
    outFile.getParentDirectory().createDirectory();

    bool success = xml.writeTo(outFile);
    juce::Logger::writeToLog("savePluginPreset: " + presetPath + " success=" + juce::String(success ? "true" : "false"));
    return success;
}

// =============================================================================
// Phase 19.16: A/B Comparison
// =============================================================================

bool AudioEngine::storePluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                                      const juce::String& slot)
{
    juce::String base64State = getPluginState(trackId, fxIndex, isInputFX);
    if (base64State.isEmpty())
        return false;

    juce::String key = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0) + ":" + slot;
    pluginABStates[key] = base64State;

    juce::String slotKey = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0);
    pluginActiveSlots[slotKey] = slot;

    juce::Logger::writeToLog("storePluginABState: " + key);
    return true;
}

bool AudioEngine::loadPluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                                     const juce::String& slot)
{
    juce::String key = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0) + ":" + slot;
    auto it = pluginABStates.find(key);
    if (it == pluginABStates.end())
        return false;

    bool ok = setPluginState(trackId, fxIndex, isInputFX, it->second);
    if (ok)
    {
        juce::String slotKey = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0);
        pluginActiveSlots[slotKey] = slot;
    }

    juce::Logger::writeToLog("loadPluginABState: " + key + " ok=" + juce::String(ok ? "true" : "false"));
    return ok;
}

juce::String AudioEngine::getPluginActiveSlot(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    juce::String slotKey = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0);
    auto it = pluginActiveSlots.find(slotKey);
    return (it != pluginActiveSlots.end()) ? it->second : juce::String("A");
}

// =============================================================================
// Phase 20.5: Session Archive
// =============================================================================

bool AudioEngine::archiveSession(const juce::String& projectJsonPath, const juce::String& outputZipPath)
{
    juce::File projectFile(projectJsonPath);
    if (!projectFile.existsAsFile())
        return false;

    juce::File zipFile(outputZipPath);
    zipFile.deleteFile();

    auto outputStream = std::make_unique<juce::FileOutputStream>(zipFile);
    if (outputStream->failedToOpen())
        return false;

    juce::ZipFile::Builder builder;

    // Add the project JSON file
    builder.addFile(projectFile, 9, projectFile.getFileName());

    // Parse project JSON to find referenced media files
    juce::String jsonContent = projectFile.loadFileAsString();
    auto projectData = juce::JSON::parse(jsonContent);

    // Collect all file paths from clip data
    std::set<juce::String> mediaFiles;
    if (auto* tracksArr = projectData.getProperty("tracks", juce::var()).getArray())
    {
        for (const auto& trackVar : *tracksArr)
        {
            if (auto* clipsArr = trackVar.getProperty("clips", juce::var()).getArray())
            {
                for (const auto& clipVar : *clipsArr)
                {
                    juce::String fp = clipVar.getProperty("filePath", "").toString();
                    if (fp.isNotEmpty())
                        mediaFiles.insert(fp);
                }
            }
        }
    }

    // Add media files to archive
    juce::File projectDir = projectFile.getParentDirectory();
    for (const auto& mediaPath : mediaFiles)
    {
        juce::File mediaFile(mediaPath);
        if (mediaFile.existsAsFile())
        {
            // Store relative to project directory if possible
            juce::String relativePath = mediaFile.getRelativePathFrom(projectDir);
            builder.addFile(mediaFile, 9, "media/" + relativePath);
        }
    }

    bool success = builder.writeToStream(*outputStream, nullptr);
    outputStream.reset();

    juce::Logger::writeToLog("archiveSession: " + outputZipPath +
                             " success=" + juce::String(success ? "true" : "false") +
                             " files=" + juce::String(static_cast<int>(mediaFiles.size()) + 1));
    return success;
}

bool AudioEngine::unarchiveSession(const juce::String& zipPath, const juce::String& outputDir)
{
    juce::File zipFile(zipPath);
    if (!zipFile.existsAsFile())
        return false;

    juce::File outDir(outputDir);
    outDir.createDirectory();

    juce::ZipFile zip(zipFile);
    if (zip.getNumEntries() == 0)
        return false;

    auto result = zip.uncompressTo(outDir);
    bool success = (result.wasOk());

    juce::Logger::writeToLog("unarchiveSession: " + zipPath + " -> " + outputDir +
                             " entries=" + juce::String(zip.getNumEntries()) +
                             " success=" + juce::String(success ? "true" : "false"));
    return success;
}

// =============================================================================
// Phase 20.11: Spectrum Analyzer
// =============================================================================

juce::var AudioEngine::getSpectrumData()
{
    const juce::ScopedLock sl(spectrumLock);

    juce::Array<juce::var> result;
    if (!spectrumReady)
        return juce::var(result);

    // Return first half of FFT (positive frequencies only): FFT_SIZE/2 + 1 bins
    int numBins = FFT_SIZE / 2 + 1;
    for (int i = 0; i < numBins; ++i)
        result.add(static_cast<double>(spectrumOutputBuffer[i]));

    return juce::var(result);
}

// =============================================================================
// Phase 20.12: Built-in FX Oversampling
// =============================================================================

bool AudioEngine::setBuiltInFXOversampling(const juce::String& trackId, int fxIndex, bool isInputFX, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end())
        return false;

    auto* track = it->second;
    juce::AudioProcessor* proc = nullptr;

    if (isInputFX)
        proc = track->getInputFXProcessor(fxIndex);
    else
        proc = track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return false;

    // Check if it's a built-in effect that inherits from S13BuiltInEffect
    if (auto* builtIn = dynamic_cast<S13BuiltInEffect*>(proc))
    {
        builtIn->setOversamplingEnabled(enabled);
        juce::Logger::writeToLog("setBuiltInFXOversampling: " + trackId + " fx=" + juce::String(fxIndex)
                                 + " isInput=" + juce::String(isInputFX ? "true" : "false")
                                 + " enabled=" + juce::String(enabled ? "true" : "false"));
        return true;
    }

    // Check if it's an S13Saturator (doesn't inherit from S13BuiltInEffect)
    if (auto* saturator = dynamic_cast<S13Saturator*>(proc))
    {
        saturator->setOversamplingEnabled(enabled);
        juce::Logger::writeToLog("setBuiltInFXOversampling (Saturator): " + trackId + " fx=" + juce::String(fxIndex)
                                 + " enabled=" + juce::String(enabled ? "true" : "false"));
        return true;
    }

    return false;
}

// ========== Channel Strip EQ (Phase 19.18) ==========

void AudioEngine::setChannelStripEQEnabled(const juce::String& trackId, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setChannelStripEQEnabled(enabled);
}

void AudioEngine::setChannelStripEQParam(const juce::String& trackId, int paramIndex, float value)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setChannelStripEQParam(paramIndex, value);
}

float AudioEngine::getChannelStripEQParam(const juce::String& trackId, int paramIndex)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getChannelStripEQParam(paramIndex);
    return 0.0f;
}

// ============================================================================
// Pitch Corrector bridge methods
// ============================================================================

// (findPitchCorrector defined inline in methods below using trackMap)

juce::var AudioEngine::getPitchCorrectorData(const juce::String& trackId, int fxIndex)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second) return juce::var();
    juce::AudioProcessor* proc = (fxIndex >= 0 && fxIndex < it->second->getNumTrackFX())
                                  ? it->second->getTrackFXProcessor(fxIndex) : nullptr;
    auto* pc = dynamic_cast<S13PitchCorrector*>(proc);
    if (!pc) return juce::var();

    auto data = pc->getCurrentPitchData();
    auto& mapper = pc->getMapper();

    juce::DynamicObject::Ptr obj = new juce::DynamicObject();
    obj->setProperty("detectedPitch", static_cast<double>(data.detectedHz));
    obj->setProperty("correctedPitch", static_cast<double>(data.correctedHz));
    obj->setProperty("confidence", static_cast<double>(data.confidence));
    obj->setProperty("centsDeviation", static_cast<double>(data.centsDeviation));
    obj->setProperty("noteName", data.noteName);

    // Include current parameter values for UI sync
    obj->setProperty("key", mapper.getKey());
    obj->setProperty("scale", static_cast<int>(mapper.getScale()));
    obj->setProperty("retuneSpeed", static_cast<double>(mapper.getRetuneSpeed()));
    obj->setProperty("humanize", static_cast<double>(mapper.getHumanize()));
    obj->setProperty("transpose", mapper.getTranspose());
    obj->setProperty("correctionStrength", static_cast<double>(mapper.getCorrectionStrength()));
    obj->setProperty("formantCorrection", mapper.getFormantCorrection());
    obj->setProperty("formantShift", static_cast<double>(mapper.getFormantShift()));
    obj->setProperty("mix", static_cast<double>(pc->mix.load()));
    obj->setProperty("midiOutput", pc->midiOutputEnabled.load() > 0.5f);
    obj->setProperty("midiChannel", static_cast<int>(pc->midiOutputChannel.load()));

    // Note enables
    juce::Array<juce::var> noteEnables;
    for (int i = 0; i < 12; ++i)
        noteEnables.add(mapper.isNoteEnabled(i));
    obj->setProperty("noteEnables", noteEnables);

    return juce::var(obj.get());
}

void AudioEngine::setPitchCorrectorParam(const juce::String& trackId, int fxIndex,
                                          const juce::String& param, float value)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second) return;
    juce::AudioProcessor* proc = (fxIndex >= 0 && fxIndex < it->second->getNumTrackFX())
                                  ? it->second->getTrackFXProcessor(fxIndex) : nullptr;
    auto* pc = dynamic_cast<S13PitchCorrector*>(proc);
    if (!pc) return;

    auto& mapper = pc->getMapper();

    if (param == "key")              mapper.setKey(static_cast<int>(value));
    else if (param == "scale")       mapper.setScale(static_cast<PitchMapper::Scale>(static_cast<int>(value)));
    else if (param == "retuneSpeed") mapper.setRetuneSpeed(value);
    else if (param == "humanize")    mapper.setHumanize(value);
    else if (param == "transpose")   mapper.setTranspose(static_cast<int>(value));
    else if (param == "correctionStrength") mapper.setCorrectionStrength(value);
    else if (param == "formantCorrection")  mapper.setFormantCorrection(value > 0.5f);
    else if (param == "formantShift")       mapper.setFormantShift(value);
    else if (param == "mix")         pc->mix.store(juce::jlimit(0.0f, 1.0f, value));
    else if (param == "bypass")      pc->bypass.store(value > 0.5f ? 1.0f : 0.0f);
    else if (param == "sensitivity") pc->sensitivity.store(value);
    else if (param == "midiOutput")  pc->midiOutputEnabled.store(value > 0.5f ? 1.0f : 0.0f);
    else if (param == "midiChannel") pc->midiOutputChannel.store(juce::jlimit(1.0f, 16.0f, value));
    else if (param.startsWith("noteEnable_"))
    {
        int noteIdx = param.substring(11).getIntValue();
        mapper.setNoteEnabled(noteIdx, value > 0.5f);
    }
}

juce::var AudioEngine::getPitchHistory(const juce::String& trackId, int fxIndex, int numFrames)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second) return juce::Array<juce::var>();
    juce::AudioProcessor* proc = (fxIndex >= 0 && fxIndex < it->second->getNumTrackFX())
                                  ? it->second->getTrackFXProcessor(fxIndex) : nullptr;
    auto* pc = dynamic_cast<S13PitchCorrector*>(proc);
    if (!pc) return juce::Array<juce::var>();

    auto frames = pc->getPitchHistory(numFrames);

    juce::Array<juce::var> result;
    for (const auto& f : frames)
    {
        juce::DynamicObject::Ptr frame = new juce::DynamicObject();
        frame->setProperty("detected", static_cast<double>(f.detectedMidi));
        frame->setProperty("corrected", static_cast<double>(f.correctedMidi));
        frame->setProperty("confidence", static_cast<double>(f.confidence));
        result.add(juce::var(frame.get()));
    }
    return result;
}

// ============================================================================
// Pitch Corrector — Graphical Mode bridge methods
// ============================================================================

juce::var AudioEngine::analyzePitchContour(const juce::String& trackId, const juce::String& clipId)
{
    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;

    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }

    if (!foundClip || !foundClip->audioFile.existsAsFile())
        return juce::var();

    // Read audio file
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (!reader) return juce::var();

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return juce::var();

    // Read and mix to mono
    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    // Run analysis
    PitchAnalyzer analyzer;
    auto result = analyzer.analyzeClip(mono.getReadPointer(0), numSamples,
                                        reader->sampleRate, clipId);

    return PitchAnalyzer::resultToJSON(result);
}

juce::var AudioEngine::analyzePitchContourDirect(const juce::String& filePath, double offset, double duration, const juce::String& clipId)
{
    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("analyzePitchContourDirect: File not found: " + filePath);
        return juce::var();
    }

    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(audioFile));
    if (!reader) return juce::var();

    int startSample = static_cast<int>(offset * reader->sampleRate);
    int numSamples = static_cast<int>(duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return juce::var();

    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    PitchAnalyzer analyzer;
    auto result = analyzer.analyzeClip(mono.getReadPointer(0), numSamples,
                                        reader->sampleRate, clipId);

    return PitchAnalyzer::resultToJSON(result);
}

juce::var AudioEngine::applyPitchCorrection(const juce::String& trackId, const juce::String& clipId,
                                              const juce::var& notesJson, const juce::var& framesJson,
                                              float globalFormantSemitones,
                                              std::optional<double> windowStartSecOverride,
                                              std::optional<double> windowEndSecOverride,
                                              const juce::String& renderMode,
                                              std::function<bool()> shouldCancel)
{
    logPitchEditorFormant("AudioEngine::applyPitchCorrection begin clip=" + clipId
        + " track=" + trackId
        + " globalFormantSt=" + juce::String(globalFormantSemitones, 3)
        + " renderMode=" + renderMode
        + " windowStartOverride=" + juce::String(windowStartSecOverride.has_value() ? *windowStartSecOverride : -1.0, 3)
        + " windowEndOverride=" + juce::String(windowEndSecOverride.has_value() ? *windowEndSecOverride : -1.0, 3));
    auto buildCancelledResult = [&clipId, &renderMode]() {
        juce::DynamicObject::Ptr resultObj = new juce::DynamicObject();
        resultObj->setProperty("success", false);
        resultObj->setProperty("cancelled", true);
        resultObj->setProperty("clipId", clipId);
        resultObj->setProperty("renderMode", renderMode);
        return juce::var(resultObj.get());
    };
    if (shouldCancel && shouldCancel())
        return buildCancelledResult();
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }
    if (!foundClip)
    {
        logPitchEditorFormant("clip not found in playback engine clip=" + clipId);
        juce::Logger::writeToLog("applyPitchCorrection: clip not found in playback engine for clipId=" + clipId);
        return false;
    }

    // Always read from the ORIGINAL audio file so successive edits don't compound.
    // originalAudioFile is set once in addClip and never changed by replaceClipAudioFile.
    juce::File sourceFile = foundClip->originalAudioFile.existsAsFile()
                          ? foundClip->originalAudioFile
                          : foundClip->audioFile;

    if (!sourceFile.existsAsFile())
    {
        logPitchEditorFormant("source file missing clip=" + clipId + " path=" + sourceFile.getFullPathName());
        juce::Logger::writeToLog("applyPitchCorrection: source file not found: " + sourceFile.getFullPathName());
        return false;
    }

    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(sourceFile));
    if (!reader)
    {
        logPitchEditorFormant("failed to create reader clip=" + clipId + " path=" + sourceFile.getFullPathName());
        return false;
    }

    // Use originalOffset (not offset) when reading from the original file.
    // After replaceClipAudioFile, offset is reset to 0 (for the corrected file),
    // but originalOffset preserves where the clip data starts in the original file.
    double effectiveOffset = (sourceFile == foundClip->originalAudioFile)
        ? foundClip->originalOffset
        : foundClip->offset;
    int clipStartSample = static_cast<int>(effectiveOffset * reader->sampleRate);
    int clipNumSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    clipNumSamples = std::min(clipNumSamples, static_cast<int>(reader->lengthInSamples) - clipStartSample);
    if (clipNumSamples <= 0)
    {
        logPitchEditorFormant("clip had no readable samples clip=" + clipId);
        return false;
    }

    const double sr = reader->sampleRate;
    const double clipDuration = static_cast<double>(clipNumSamples) / sr;
    const bool hasGlobalFormant = std::abs(globalFormantSemitones) > 0.01f;

    // Parse notes first so we can limit processing to only the edited region.
    auto editedNotes = PitchAnalyzer::notesFromJSON(notesJson);

    // Find the time range covered by ACTUALLY EDITED notes only (correctedPitch != detectedPitch).
    // WORLD vocoder is NOT transparent at ratio=1.0 — it degrades audio quality even when
    // no pitch change is requested.  By limiting the window to edited notes only, we avoid
    // resynthesizing the entire clip through WORLD when only one note was changed.
    const float editThreshold = 0.01f; // semitones
    double notesStartSec = clipDuration;
    double notesEndSec   = 0.0;
    bool anyNoteEdited = false;
    int pitchEditCount = 0;
    int noteFormantEditCount = 0;
    int gainEditCount = 0;
    int driftEditCount = 0;
    int vibratoEditCount = 0;
    for (const auto& n : editedNotes)
    {
        const bool pitchEdited = std::abs(n.correctedPitch - n.detectedPitch) > editThreshold;
        const bool gainEdited = std::abs(n.gain) > 0.01f;
        const bool noteFormantEdited = std::abs(n.formantShift) > 0.01f;
        const bool driftEdited = n.driftCorrectionAmount > 0.01f;
        const bool vibratoEdited = std::abs(n.vibratoDepth - 1.0f) > 0.01f;

        if (pitchEdited) ++pitchEditCount;
        if (gainEdited) ++gainEditCount;
        if (noteFormantEdited) ++noteFormantEditCount;
        if (driftEdited) ++driftEditCount;
        if (vibratoEdited) ++vibratoEditCount;

        if (pitchEdited || gainEdited || noteFormantEdited || driftEdited || vibratoEdited)
        {
            notesStartSec = std::min(notesStartSec, static_cast<double>(n.startTime));
            notesEndSec   = std::max(notesEndSec,   static_cast<double>(n.endTime));
            anyNoteEdited = true;
        }
    }
    const bool anyEdited = anyNoteEdited || hasGlobalFormant;
    juce::String requestMode = "none";
    const bool hasPitchEdits = pitchEditCount > 0;
    const bool hasNoteFormantEdits = noteFormantEditCount > 0;
    const bool hasOtherEdits = gainEditCount > 0 || driftEditCount > 0 || vibratoEditCount > 0;
    if (hasPitchEdits && !hasGlobalFormant && !hasNoteFormantEdits && !hasOtherEdits)
        requestMode = "pitch-only";
    else if (!hasPitchEdits && (hasGlobalFormant || hasNoteFormantEdits) && !hasOtherEdits)
        requestMode = "formant-only";
    else if (anyEdited)
        requestMode = "mixed";

    logPitchEditorFormant("request summary clip=" + clipId
        + " noteCount=" + juce::String(static_cast<int>(editedNotes.size()))
        + " pitchEdits=" + juce::String(pitchEditCount)
        + " noteFormantEdits=" + juce::String(noteFormantEditCount)
        + " gainEdits=" + juce::String(gainEditCount)
        + " driftEdits=" + juce::String(driftEditCount)
        + " vibratoEdits=" + juce::String(vibratoEditCount)
        + " globalFormant=" + juce::String(hasGlobalFormant ? "true" : "false")
        + " mode=" + requestMode);

    // If no notes were actually edited, restore the original audio file
    // (in case a previous correction was applied and the user moved notes back).
    if (!anyEdited)
    {
        logPitchEditorFormant("no edits remain, restoring original clip=" + clipId);
        if (foundClip->originalAudioFile.existsAsFile()
            && foundClip->audioFile != foundClip->originalAudioFile)
        {
            playbackEngine.replaceClipAudioFile(clipId, foundClip->originalAudioFile);
        }
        juce::DynamicObject::Ptr resultObj = new juce::DynamicObject();
        resultObj->setProperty("outputFile", foundClip->originalAudioFile.getFullPathName());
        resultObj->setProperty("success", true);
        resultObj->setProperty("restored", true);
        return juce::var(resultObj.get());
    }

    logPitchEditorFormant("source selection clip=" + clipId
        + " sourceFile=" + sourceFile.getFullPathName()
        + " originalFile=" + foundClip->originalAudioFile.getFullPathName()
        + " clipSamples=" + juce::String(clipNumSamples)
        + " clipDuration=" + juce::String(clipDuration, 3));

    const int numChannels = static_cast<int>(reader->numChannels);

    // Read the FULL clip (all channels) — we will stitch the corrected window back in-place.
    juce::AudioBuffer<float> clipBuffer(numChannels, clipNumSamples);
    reader->read(&clipBuffer, 0, clipNumSamples, static_cast<juce::int64>(clipStartSample), true, true);
    if (shouldCancel && shouldCancel())
        return buildCancelledResult();

    // Use frontend analysis frames if provided (eliminates re-analysis mismatch).
    // Fall back to local analysis only if frames weren't sent.
    PitchAnalyzer::AnalysisResult analysis;
    analysis.clipId = clipId;
    analysis.sampleRate = sr;

    if (framesJson.getDynamicObject() != nullptr)
    {
        analysis.frames = PitchAnalyzer::framesFromJSON(framesJson);
        // Frontend frames use clip-relative times. Adjust to window-relative below.
        // The hopSize isn't critical here — estimate from frame spacing.
        if (analysis.frames.size() >= 2)
            analysis.hopSize = static_cast<int>((analysis.frames[1].time - analysis.frames[0].time) * sr);
        else
            analysis.hopSize = 512;
        logPitchEditorFormant("using frontend analysis frames count=" + juce::String(static_cast<int>(analysis.frames.size()))
            + " clip=" + clipId);
    }
    else
    {
        // Fallback: create mono mix and re-analyze (legacy path)
        juce::AudioBuffer<float> monoBuffer(1, clipNumSamples);
        monoBuffer.clear();
        for (int ch = 0; ch < numChannels; ++ch)
            monoBuffer.addFrom(0, 0, clipBuffer, ch, 0, clipNumSamples, 1.0f / static_cast<float>(numChannels));

        PitchAnalyzer analyzer;
        analysis = analyzer.analyzeClip(monoBuffer.getReadPointer(0),
                                        clipNumSamples, sr, clipId);
        logPitchEditorFormant("no frontend frames supplied, re-analyzed locally clip=" + clipId);
    }

    juce::AudioBuffer<float> renderedOutputBuffer (clipBuffer);
    int renderedOutputSamples = clipNumSamples;
    double previewCoverageStartSec = 0.0;
    double previewCoverageEndSec = clipDuration;
    bool previewSegmentRender = false;
    bool fullClipHQRender = false;
    bool swapDeferred = false;

    // Process only the EDITED WINDOW (with padding), or a whole-clip render for explicit formants.
    {
        // Build window bounds around the edited region.
        const bool hasWindowOverride = windowStartSecOverride.has_value() && windowEndSecOverride.has_value();
        const bool hasAnyFormantEdits = hasGlobalFormant || hasNoteFormantEdits;
        previewSegmentRender = renderMode == "preview_segment";
        fullClipHQRender = renderMode == "full_clip_hq";
        const bool processFullClip = hasAnyFormantEdits && !previewSegmentRender;
        // Preview segments must sound like the final formant result, not like a
        // watered-down proxy. Using the HQ formant path on 10-second staged
        // renders keeps preview character aligned with the final clip while
        // still avoiding a full-clip wait.
        const auto renderQuality = PitchResynthesizer::RenderQuality::FinalHQ;
        const double kPaddingSec = previewSegmentRender ? 0.75 : 1.0;
        double requestedWindowStartSec = processFullClip ? 0.0 : std::max (0.0, notesStartSec - kPaddingSec);
        double requestedWindowEndSec   = processFullClip ? clipDuration : std::min (clipDuration, notesEndSec + kPaddingSec);
        double windowStartSec = processFullClip ? 0.0 : requestedWindowStartSec;
        double windowEndSec   = processFullClip ? clipDuration : requestedWindowEndSec;
        if (hasWindowOverride && processFullClip)
        {
            logPitchEditorFormant ("ignoring window override because explicit formant edits require full-clip render clip="
                + clipId);
        }
        if (hasWindowOverride && ! processFullClip)
        {
            requestedWindowStartSec = juce::jlimit (0.0, clipDuration, *windowStartSecOverride);
            requestedWindowEndSec   = juce::jlimit (requestedWindowStartSec, clipDuration, *windowEndSecOverride);
            windowStartSec = previewSegmentRender
                ? std::max (0.0, requestedWindowStartSec - kPaddingSec)
                : requestedWindowStartSec;
            windowEndSec   = previewSegmentRender
                ? std::min (clipDuration, requestedWindowEndSec + kPaddingSec)
                : requestedWindowEndSec;
        }
        int windowStartSample = static_cast<int> (windowStartSec * sr);
        int windowNumSamples  = std::min (clipNumSamples - windowStartSample,
                                          static_cast<int> ((windowEndSec - windowStartSec) * sr));
        previewCoverageStartSec = requestedWindowStartSec;
        previewCoverageEndSec = requestedWindowEndSec;

        logPitchEditorFormant (juce::String("processing scope=")
            + (processFullClip ? "full-clip" : (previewSegmentRender ? "preview-segment" : (hasWindowOverride ? "playhead-window" : "edited-window")))
            + " clip=" + clipId
            + " renderMode=" + renderMode
            + " requested=[" + juce::String (requestedWindowStartSec, 3) + "s - " + juce::String (requestedWindowEndSec, 3) + "s]"
            + " window=[" + juce::String (windowStartSec, 3) + "s - " + juce::String (windowEndSec, 3) + "s]"
            + " windowSamples=" + juce::String (windowNumSamples));
        juce::Logger::writeToLog ("applyPitchCorrection: window ["
            + juce::String (windowStartSec, 3) + "s - " + juce::String (windowEndSec, 3) + "s], "
            + juce::String (windowNumSamples) + " samples (clip=" + juce::String (clipNumSamples) + ")");

        if (windowNumSamples > 256)
        {
            // Extract the window into its own buffer.
            juce::AudioBuffer<float> windowBuffer (numChannels, windowNumSamples);
            for (int ch = 0; ch < numChannels; ++ch)
                windowBuffer.copyFrom (ch, 0, clipBuffer, ch, windowStartSample, windowNumSamples);

            // Filter analysis frames to the window and shift their times to window-relative.
            PitchAnalyzer::AnalysisResult windowAnalysis = analysis;
            windowAnalysis.frames.clear();
            for (const auto& f : analysis.frames)
            {
                double ft = static_cast<double> (f.time);
                if (ft >= windowStartSec - 0.5 && ft <= windowEndSec + 0.5)
                {
                    auto wf = f;
                    wf.time = static_cast<float> (ft - windowStartSec);
                    windowAnalysis.frames.push_back (wf);
                }
            }

            // Shift note times to window-relative.
            auto windowNotes = editedNotes;
            for (auto& n : windowNotes)
            {
                n.startTime = static_cast<float> (static_cast<double> (n.startTime) - windowStartSec);
                n.endTime   = static_cast<float> (static_cast<double> (n.endTime)   - windowStartSec);
            }

            PitchResynthesizer resynth;
            std::vector<const float*> channelPtrs (static_cast<size_t> (numChannels));
            for (int ch = 0; ch < numChannels; ++ch)
                channelPtrs[static_cast<size_t> (ch)] = windowBuffer.getReadPointer (ch);

            auto correctedWindow = resynth.processMultiChannel (
                channelPtrs.data(), numChannels, windowNumSamples, sr,
                windowAnalysis.frames, windowNotes,
                PitchResynthesizer::PitchEngine::Signalsmith,
                globalFormantSemitones,
                renderQuality,
                shouldCancel);
            if (shouldCancel && shouldCancel())
                return buildCancelledResult();

            logPitchEditorFormant ("resynth complete clip=" + clipId
                + " correctedSamples=" + juce::String (correctedWindow.empty() ? 0 : static_cast<int> (correctedWindow[0].size()))
                + " windowSamples=" + juce::String (windowNumSamples));
            juce::Logger::writeToLog ("applyPitchCorrection: processMultiChannel returned "
                + juce::String (correctedWindow.empty() ? 0 : static_cast<int> (correctedWindow[0].size()))
                + " samples (window=" + juce::String (windowNumSamples) + ")");

            // RMS comparison: log input vs output amplitude to diagnose any scaling issues
            if (!correctedWindow.empty() && windowNumSamples > 0)
            {
                float inputRMS = 0.0f, outputRMS = 0.0f, outputPeak = 0.0f;
                int ch0Samples = std::min (windowNumSamples, static_cast<int> (correctedWindow[0].size()));
                for (int i = 0; i < windowNumSamples; ++i)
                    inputRMS += windowBuffer.getSample (0, i) * windowBuffer.getSample (0, i);
                for (int i = 0; i < ch0Samples; ++i)
                {
                    float s = correctedWindow[0][static_cast<size_t> (i)];
                    outputRMS += s * s;
                    outputPeak = std::max (outputPeak, std::abs (s));
                }
                inputRMS  = std::sqrt (inputRMS  / static_cast<float> (windowNumSamples));
                outputRMS = std::sqrt (outputRMS / static_cast<float> (ch0Samples));
                juce::Logger::writeToLog ("applyPitchCorrection: window RMS in="
                    + juce::String (inputRMS, 4) + " out=" + juce::String (outputRMS, 4)
                    + " outPeak=" + juce::String (outputPeak, 4)
                    + " ratio=" + juce::String (inputRMS > 1e-8f ? outputRMS / inputRMS : 0.0f, 3));
            }

            if (previewSegmentRender)
            {
                const int trimStart = juce::jlimit (0, windowNumSamples,
                    static_cast<int> ((requestedWindowStartSec - windowStartSec) * sr));
                const int segmentSamples = std::max (0, std::min (
                    static_cast<int> ((requestedWindowEndSec - requestedWindowStartSec) * sr),
                    windowNumSamples - trimStart));
                renderedOutputBuffer.setSize (numChannels, segmentSamples);
                renderedOutputSamples = segmentSamples;
                const int xfadeLen = std::min (384, segmentSamples / 6);
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    if (static_cast<size_t> (ch) >= correctedWindow.size()) continue;
                    const auto& corrected = correctedWindow[static_cast<size_t> (ch)];
                    for (int i = 0; i < segmentSamples; ++i)
                    {
                        const int sourceIndex = trimStart + i;
                        float blend = 1.0f;
                        if (xfadeLen > 0 && i < xfadeLen)
                            blend = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                                * static_cast<float> (i) / static_cast<float> (xfadeLen)));
                        const int distFromEnd = segmentSamples - 1 - i;
                        if (xfadeLen > 0 && distFromEnd < xfadeLen)
                        {
                            float fadeOutBlend = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                                * static_cast<float> (distFromEnd) / static_cast<float> (xfadeLen)));
                            blend = std::min (blend, fadeOutBlend);
                        }
                        const float orig = windowBuffer.getSample (ch, sourceIndex);
                        const float corr = sourceIndex < static_cast<int> (corrected.size())
                            ? corrected[static_cast<size_t> (sourceIndex)]
                            : orig;
                        renderedOutputBuffer.setSample (ch, i, orig * (1.0f - blend) + corr * blend);
                    }
                }
            }
            else
            {
                // Blend corrected window into full clip buffer with cosine crossfade at splice points.
                const int xfadeLen = std::min (512, windowNumSamples / 4);
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    if (static_cast<size_t> (ch) >= correctedWindow.size()) continue;
                    const auto& corrected = correctedWindow[static_cast<size_t> (ch)];
                    int copyLen = std::min (windowNumSamples, static_cast<int> (corrected.size()));
                    for (int i = 0; i < copyLen; ++i)
                    {
                        float blend = 1.0f;
                        if (i < xfadeLen && windowStartSample > 0)
                            blend = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                                                               * static_cast<float> (i) / static_cast<float> (xfadeLen)));
                        int distFromEnd = copyLen - 1 - i;
                        if (distFromEnd < xfadeLen && (windowStartSample + copyLen) < clipNumSamples)
                        {
                            float fo = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                                * static_cast<float> (distFromEnd) / static_cast<float> (xfadeLen)));
                            blend = std::min (blend, fo);
                        }
                        float orig = clipBuffer.getSample (ch, windowStartSample + i);
                        float corr = corrected[static_cast<size_t> (i)];
                        clipBuffer.setSample (ch, windowStartSample + i, orig * (1.0f - blend) + corr * blend);
                    }
                }
                renderedOutputBuffer = clipBuffer;
                renderedOutputSamples = clipNumSamples;
            }
        }
    }

    // Write the FULL clip (with corrected window stitched in) to a unique output file.
    // Using a fixed name caused the playback engine's reader to read from a file being
    // truncated by a concurrent job — producing garbled audio.
    // A monotonic counter ensures each job writes to a different file slot.
    static std::atomic<int> s_pitchCorrSeq { 0 };
    int seq = s_pitchCorrSeq.fetch_add(1) & 0x1F; // 32 rotating slots
    juce::File outputFile = sourceFile.getSiblingFile(
        sourceFile.getFileNameWithoutExtension()
            + (renderMode == "preview_segment" ? "_pcseg" : renderMode == "full_clip_hq" ? "_pcfinal" : "_pc")
            + juce::String(seq) + ".wav");

    // Delete the old file first to prevent stale data if the write partially fails.
    // Without this, createOutputStream may fail to fully overwrite on some OS/filesystem combos.
    if (outputFile.existsAsFile())
        outputFile.deleteFile();

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> fileStream(outputFile.createOutputStream());
    if (!fileStream)
    {
        logPitchEditorFormant("failed to open output stream clip=" + clipId + " outputFile=" + outputFile.getFullPathName());
        return false;
    }

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(fileStream.get(), reader->sampleRate,
                                   static_cast<unsigned int>(numChannels), 32, {}, 0));
    if (!writer)
    {
        logPitchEditorFormant("failed to create wav writer clip=" + clipId + " outputFile=" + outputFile.getFullPathName());
        return false;
    }
    fileStream.release(); // writer takes ownership

    writer->writeFromAudioSampleBuffer(renderedOutputBuffer, 0, renderedOutputSamples);
    writer.reset();
    if (shouldCancel && shouldCancel())
        return buildCancelledResult();

    if (previewSegmentRender)
    {
        playbackEngine.setClipRenderedPreviewSegment(clipId, outputFile, previewCoverageStartSec, previewCoverageEndSec);
    }
    else if (fullClipHQRender && isPlaying.load())
    {
        playbackEngine.queueDeferredClipAudioFile(clipId, outputFile, false);
        swapDeferred = true;
    }
    else
    {
        playbackEngine.replaceClipAudioFile(clipId, outputFile);
    }
    logPitchEditorFormant("wrote corrected file clip=" + clipId
        + " outputFile=" + outputFile.getFullPathName()
        + " swapDeferred=" + juce::String (swapDeferred ? "true" : "false"));

    juce::DynamicObject::Ptr resultObj = new juce::DynamicObject();
    resultObj->setProperty("outputFile", outputFile.getFullPathName());
    resultObj->setProperty("success", true);
    resultObj->setProperty("renderMode", renderMode);
    resultObj->setProperty("swapDeferred", swapDeferred);
    return juce::var(resultObj.get());
}

juce::var AudioEngine::previewPitchCorrection(const juce::String& trackId, const juce::String& clipId,
                                                const juce::var& notesJson)
{
    return applyPitchCorrection(trackId, clipId, notesJson, juce::var(), 0.0f);
}

// =============================================================================
// Phase 6: Polyphonic Pitch Detection
// =============================================================================

bool AudioEngine::isPolyphonicDetectionAvailable() const
{
#if S13_HAS_ONNXRUNTIME
    return true;
#else
    return false;
#endif
}

juce::var AudioEngine::analyzePolyphonic(const juce::String& trackId, const juce::String& clipId)
{
    // Lazy-load the ONNX model on first use
    if (! polyModelLoadAttempted)
    {
        polyModelLoadAttempted = true;
        auto exeDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
        auto modelFile = exeDir.getChildFile("models").getChildFile("basic_pitch_nmp.onnx");
        if (! modelFile.existsAsFile())
        {
            juce::Logger::writeToLog("analyzePolyphonic: Model not found at " + modelFile.getFullPathName());
            // Try alternative location
            modelFile = exeDir.getChildFile("basic_pitch_nmp.onnx");
        }
        polyPitchDetector.loadModel(modelFile);
    }

    if (! polyPitchDetector.isModelLoaded())
    {
        auto errObj = std::make_unique<juce::DynamicObject>();
        errObj->setProperty("error", "Polyphonic model not loaded. Place basic_pitch_nmp.onnx in the models/ directory.");
        errObj->setProperty("clipId", clipId);
        errObj->setProperty("notes", juce::Array<juce::var>());
        return juce::var(errObj.release());
    }

    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }

    if (! foundClip || ! foundClip->audioFile.existsAsFile())
        return juce::var();

    // Read audio file
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (! reader) return juce::var();

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return juce::var();

    // Read and mix to mono
    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    // Run polyphonic analysis
    auto result = polyPitchDetector.analyze(mono.getReadPointer(0), numSamples,
                                             reader->sampleRate, clipId);

    // Cache result for reuse in polyphonic editing
    polyAnalysisCache[clipId] = result;

    return PolyPitchDetector::resultToJSON(result);
}

juce::var AudioEngine::extractMidiFromAudio(const juce::String& trackId, const juce::String& clipId)
{
    // First run polyphonic analysis
    auto analysisJson = analyzePolyphonic(trackId, clipId);
    if (! analysisJson.isObject())
        return juce::var();

    // Return the analysis result — the frontend will create the MIDI track/clip
    // from the note data (since track creation is a frontend-managed operation)
    return analysisJson;
}

// =============================================================================
// Phase 7: Polyphonic Pitch Editing
// =============================================================================

juce::var AudioEngine::applyPolyPitchCorrection(const juce::String& trackId,
                                                  const juce::String& clipId,
                                                  const juce::var& editedNotesJson)
{
    // Check if we have a cached analysis for this clip
    auto cacheIt = polyAnalysisCache.find(clipId);
    if (cacheIt == polyAnalysisCache.end())
    {
        // Need to run analysis first
        analyzePolyphonic(trackId, clipId);
        cacheIt = polyAnalysisCache.find(clipId);
        if (cacheIt == polyAnalysisCache.end())
            return PolyResynthesizer::resultToJSON("", false);
    }

    const auto& analysisResult = cacheIt->second;

    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }
    if (!foundClip || !foundClip->audioFile.existsAsFile())
        return PolyResynthesizer::resultToJSON("", false);

    // Read audio
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (!reader) return PolyResynthesizer::resultToJSON("", false);

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return PolyResynthesizer::resultToJSON("", false);

    // Read and mix to mono
    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    // Parse edited notes from JSON
    std::vector<PolyResynthesizer::EditedNote> editedNotes;
    if (auto* arr = editedNotesJson.getArray())
    {
        for (const auto& noteVar : *arr)
        {
            PolyResynthesizer::EditedNote edit;
            edit.id = noteVar.getProperty("id", "").toString();
            edit.originalPitch = static_cast<float>(static_cast<double>(noteVar.getProperty("originalPitch", 0.0)));
            edit.correctedPitch = static_cast<float>(static_cast<double>(noteVar.getProperty("correctedPitch", 0.0)));
            edit.formantShift = static_cast<float>(static_cast<double>(noteVar.getProperty("formantShift", 0.0)));
            edit.gain = static_cast<float>(static_cast<double>(noteVar.getProperty("gain", 0.0)));
            editedNotes.push_back(edit);
        }
    }

    // Run polyphonic resynthesis
    auto corrected = polyResynthesizer.process(
        mono.getReadPointer(0), numSamples, reader->sampleRate,
        analysisResult.notes, editedNotes);

    if (corrected.empty())
        return PolyResynthesizer::resultToJSON("", false);

    // Write corrected audio to a new file
    juce::File outputFile = foundClip->audioFile.getSiblingFile(
        foundClip->audioFile.getFileNameWithoutExtension() + "_polycorrected.wav");

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> fileStream(outputFile.createOutputStream());
    if (!fileStream) return PolyResynthesizer::resultToJSON("", false);

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(fileStream.get(), reader->sampleRate, 1, 32, {}, 0));
    if (!writer) return PolyResynthesizer::resultToJSON("", false);
    fileStream.release(); // writer takes ownership

    juce::AudioBuffer<float> outBuffer(1, numSamples);
    outBuffer.copyFrom(0, 0, corrected.data(), numSamples);
    writer->writeFromAudioSampleBuffer(outBuffer, 0, numSamples);
    writer.reset();

    return PolyResynthesizer::resultToJSON(outputFile.getFullPathName(), true);
}

juce::var AudioEngine::soloPolyNote(const juce::String& trackId,
                                     const juce::String& clipId,
                                     const juce::String& noteId)
{
    // Check cache
    auto cacheIt = polyAnalysisCache.find(clipId);
    if (cacheIt == polyAnalysisCache.end())
    {
        analyzePolyphonic(trackId, clipId);
        cacheIt = polyAnalysisCache.find(clipId);
        if (cacheIt == polyAnalysisCache.end())
            return PolyResynthesizer::resultToJSON("", false);
    }

    const auto& analysisResult = cacheIt->second;

    // Find clip audio
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }
    if (!foundClip || !foundClip->audioFile.existsAsFile())
        return PolyResynthesizer::resultToJSON("", false);

    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (!reader) return PolyResynthesizer::resultToJSON("", false);

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return PolyResynthesizer::resultToJSON("", false);

    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    auto soloAudio = polyResynthesizer.soloNote(
        mono.getReadPointer(0), numSamples, reader->sampleRate,
        analysisResult.notes, noteId);

    if (soloAudio.empty())
        return PolyResynthesizer::resultToJSON("", false);

    // Write solo audio to temp file
    juce::File outputFile = foundClip->audioFile.getSiblingFile(
        foundClip->audioFile.getFileNameWithoutExtension() + "_solo_" + noteId.substring(0, 8) + ".wav");

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> fileStream(outputFile.createOutputStream());
    if (!fileStream) return PolyResynthesizer::resultToJSON("", false);

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(fileStream.get(), reader->sampleRate, 1, 32, {}, 0));
    if (!writer) return PolyResynthesizer::resultToJSON("", false);
    fileStream.release();

    juce::AudioBuffer<float> outBuffer(1, numSamples);
    outBuffer.copyFrom(0, 0, soloAudio.data(), numSamples);
    writer->writeFromAudioSampleBuffer(outBuffer, 0, numSamples);
    writer.reset();

    return PolyResynthesizer::resultToJSON(outputFile.getFullPathName(), true);
}

// =============================================================================
// Phase 8: Source Separation
// =============================================================================

bool AudioEngine::isStemSeparationAvailable() const
{
    return stemSeparator.isAvailable();
}

juce::var AudioEngine::getAiToolsStatus()
{
    return stemSeparator.getAiToolsStatus();
}

juce::var AudioEngine::installAiTools()
{
    return stemSeparator.installAiTools();
}

juce::var AudioEngine::separateStems(const juce::String& trackId, const juce::String& clipId)
{
    juce::ignoreUnused (trackId, clipId);
    // Synchronous separation removed — use separateStemsAsync() instead
    return StemSeparator::resultToJSON ({}, false, "Use async separation.");
}

// =============================================================================
// Phase 10: Async Stem Separation + Progress
// =============================================================================

juce::var AudioEngine::separateStemsAsync(const juce::String& trackId, const juce::String& clipId,
                                           const juce::String& optionsJSON)
{
    juce::ignoreUnused (clipId);
    auto result = std::make_unique<juce::DynamicObject>();

    auto aiToolsStatus = stemSeparator.getAiToolsStatus();
    if (auto* aiToolsStatusObject = aiToolsStatus.getDynamicObject())
    {
        const auto available = static_cast<bool>(aiToolsStatusObject->getProperty("available"));
        if (! available)
        {
            const auto statusMessage = aiToolsStatusObject->getProperty("message").toString();
            const auto errorMessage = aiToolsStatusObject->getProperty("error").toString();
            result->setProperty("started", false);
            result->setProperty("error", errorMessage.isNotEmpty() ? errorMessage : statusMessage);
            return juce::var(result.release());
        }
    }

    // If already running, ignore
    if (stemSeparator.isRunning())
    {
        result->setProperty("started", false);
        result->setProperty("error", "Separation already in progress.");
        return juce::var(result.release());
    }

    // Parse options
    auto options = juce::JSON::parse(optionsJSON);
    juce::StringArray requestedStems;
    if (auto* stemsArray = options.getProperty("stems", {}).getArray())
        for (const auto& s : *stemsArray)
            requestedStems.add(s.toString());

    if (requestedStems.isEmpty())
        requestedStems = StemSeparator::getAllStemNames();

    bool useGPU = options.getProperty("gpu", false);

    // Find audio file — prefer filePath from options (frontend knows the clip's file),
    // fall back to searching PlaybackEngine clips by trackId
    juce::File audioFile;
    juce::String filePathFromOptions = options.getProperty("filePath", "").toString();

    if (filePathFromOptions.isNotEmpty())
    {
        audioFile = juce::File(filePathFromOptions);
    }
    else
    {
        // Legacy fallback: search PlaybackEngine clips
        auto clips = playbackEngine.getClipSnapshot();
        for (const auto& clip : clips)
        {
            if (clip.trackId == trackId)
            {
                audioFile = clip.audioFile;
                break;
            }
        }
    }

    if (! audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("StemSeparator: Audio file not found: " + audioFile.getFullPathName());
        result->setProperty("started", false);
        result->setProperty("error", "Audio file not found: " + audioFile.getFullPathName());
        return juce::var(result.release());
    }

    // Cache check
    juce::String cacheKey = audioFile.getFullPathName();
    auto cacheIt = stemFileCache.find(cacheKey);
    if (cacheIt != stemFileCache.end())
    {
        bool allExist = true;
        for (const auto& key : cacheIt->second.getAllKeys())
            if (! juce::File(cacheIt->second[key]).existsAsFile()) { allExist = false; break; }

        if (allExist)
        {
            // Already separated — no need to re-run
            juce::Logger::writeToLog("StemSeparator: Using cached stems.");
            result->setProperty("started", false);
            result->setProperty("cached", true);
            return juce::var(result.release());
        }
        stemFileCache.erase(cacheIt);
    }

    // Create output directory alongside the audio file
    auto outputDir = audioFile.getParentDirectory()
        .getChildFile(audioFile.getFileNameWithoutExtension() + "_stems");

    // Start Python subprocess
    if (! stemSeparator.startSeparation(audioFile, outputDir, requestedStems, useGPU))
    {
        juce::Logger::writeToLog("StemSeparator: Failed to start separation.");
        result->setProperty("started", false);
        result->setProperty("error", "Failed to start Python process. Check that Python and audio-separator are installed.");
        return juce::var(result.release());
    }

    result->setProperty("started", true);
    return juce::var(result.release());
}

juce::var AudioEngine::getStemSeparationProgress()
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto progress = stemSeparator.pollProgress();

    obj->setProperty("state", progress.state);
    obj->setProperty("progress", static_cast<double>(progress.progress));

    if (progress.state == "done" && progress.stemFiles.size() > 0)
    {
        juce::Array<juce::var> stems;
        for (const auto& key : progress.stemFiles.getAllKeys())
        {
            auto stemObj = std::make_unique<juce::DynamicObject>();
            stemObj->setProperty("name", key);
            stemObj->setProperty("filePath", progress.stemFiles[key]);
            stems.add(juce::var(stemObj.release()));
        }
        obj->setProperty("stemFiles", stems);

        // Generate peak caches for stem files
        for (const auto& key : progress.stemFiles.getAllKeys())
        {
            juce::File stemFile(progress.stemFiles[key]);
            if (stemFile.existsAsFile())
            {
                peakCache.generateAsync(stemFile, [stemFile]() {
                    juce::Logger::writeToLog("PeakCache: Generated peaks for stem " + stemFile.getFileName());
                });
            }
        }
    }

    if (progress.state == "error")
        obj->setProperty("error", progress.error);

    return juce::var(obj.release());
}

void AudioEngine::cancelStemSeparation()
{
    stemSeparator.cancel();
}

void AudioEngine::cancelAiToolsInstall()
{
    stemSeparator.cancelAiToolsInstall();
}

// =============================================================================
// Phase 9: ARA Plugin Hosting
// =============================================================================

juce::var AudioEngine::initializeARAForTrack(const juce::String& trackId, int fxIndex)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end())
    {
        obj->setProperty("success", false);
        obj->setProperty("error", "Track not found: " + trackId);
        return juce::var(obj.release());
    }

    auto* track = it->second;
    bool success = track->initializeARA(fxIndex, currentSampleRate, currentBlockSize);

    obj->setProperty("success", success);
    if (!success)
        obj->setProperty("error", "Failed to initialize ARA. Plugin may not support ARA.");

    return juce::var(obj.release());
}

juce::var AudioEngine::addARAClip(const juce::String& trackId, const juce::String& clipId)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second->hasActiveARA())
    {
        obj->setProperty("success", false);
        obj->setProperty("error", "Track not found or ARA not active.");
        return juce::var(obj.release());
    }

    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }

    if (!foundClip || !foundClip->audioFile.existsAsFile())
    {
        obj->setProperty("success", false);
        obj->setProperty("error", "Clip audio file not found.");
        return juce::var(obj.release());
    }

    logToDisk("addARAClip: file=" + foundClip->audioFile.getFullPathName()
        + " exists=" + juce::String(foundClip->audioFile.existsAsFile() ? 1 : 0)
        + " start=" + juce::String(foundClip->startTime)
        + " dur=" + juce::String(foundClip->duration)
        + " offset=" + juce::String(foundClip->offset));

    auto* ara = it->second->getARAController();

    // Deactivate the plugin while holding the callback lock.
    // ARA requires the plugin to be in an unprepared state when adding
    // PlaybackRegions to renderers. Without the lock, releaseResources()
    // triggers an audio device restart cascade.
    int araFxIdx = it->second->getARAFXIndex();
    auto* araPlugin = (araFxIdx >= 0) ? it->second->getTrackFXProcessor(araFxIdx) : nullptr;

    if (araPlugin != nullptr)
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        araPlugin->releaseResources();
        logToDisk("addARAClip: plugin deactivated (releaseResources)");
    }

    auto sourceId = ara->addAudioSource(foundClip->audioFile, clipId,
                                         foundClip->startTime, foundClip->duration,
                                         foundClip->offset);

    // Reactivate the plugin after regions are added
    if (araPlugin != nullptr)
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
        int bs = currentBlockSize > 0 ? currentBlockSize : 512;
        const bool forceFloat = it->second->getTrackFXPrecisionOverride(araFxIdx);
        prepareHostedProcessorPreservingLayout(araPlugin, sr, bs,
            forceFloat ? ProcessingPrecisionMode::Float32 : processingPrecisionMode);
        logToDisk("addARAClip: plugin reactivated (prepareToPlay sr=" + juce::String(sr) + " bs=" + juce::String(bs) + ")");

        // Warmup: call processBlock with isPlaying=true to initialize the ARA
        // renderer's internal state. Without this, editing notes before the first
        // play causes ~300ms/block because the renderer hasn't been initialized.
        {
            struct WarmupPlayHead : juce::AudioPlayHead
            {
                double sr = 44100.0;
                double pos = 0.0;
                int blockSz = 512;

                juce::Optional<PositionInfo> getPosition() const override
                {
                    PositionInfo info;
                    info.setIsPlaying (true);
                    info.setTimeInSeconds (pos);
                    info.setTimeInSamples (static_cast<juce::int64> (pos * sr));
                    info.setBpm (120.0);
                    juce::AudioPlayHead::TimeSignature ts;
                    ts.numerator = 4;
                    ts.denominator = 4;
                    info.setTimeSignature (ts);
                    return info;
                }
            };

            WarmupPlayHead warmupHead;
            warmupHead.sr = sr;
            warmupHead.blockSz = bs;

            araPlugin->setPlayHead (&warmupHead);

            juce::AudioBuffer<float> warmupBuf (2, bs);
            juce::MidiBuffer warmupMidi;
            constexpr int warmupBlocks = 8;

            for (int i = 0; i < warmupBlocks; ++i)
            {
                warmupBuf.clear();
                araPlugin->processBlock (warmupBuf, warmupMidi);
                warmupHead.pos += static_cast<double> (bs) / sr;
            }

            // Restore AudioEngine as playhead
            araPlugin->setPlayHead (this);
            logToDisk ("addARAClip: renderer warmup complete (" + juce::String (warmupBlocks) + " blocks)");
        }
    }

    logToDisk("addARAClip: result=" + juce::String(sourceId.isNotEmpty() ? "OK" : "FAILED"));

    obj->setProperty("success", sourceId.isNotEmpty());
    if (sourceId.isEmpty())
        obj->setProperty("error", "Failed to add audio source to ARA document. Only WAV files are supported.");

    return juce::var(obj.release());
}

juce::var AudioEngine::removeARAClip(const juce::String& trackId, const juce::String& clipId)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second->hasActiveARA())
    {
        obj->setProperty("success", false);
        return juce::var(obj.release());
    }

    it->second->getARAController()->removeAudioSource(clipId);
    obj->setProperty("success", true);
    return juce::var(obj.release());
}

juce::var AudioEngine::getARAStatusForTrack(const juce::String& trackId) const
{
    auto obj = std::make_unique<juce::DynamicObject>();
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || it->second == nullptr)
    {
        obj->setProperty("active", false);
        obj->setProperty("activeFxIndex", -1);
        obj->setProperty("lastAttemptFxIndex", -1);
        obj->setProperty("lastAttemptComplete", false);
        obj->setProperty("lastAttemptWasARAPlugin", false);
        obj->setProperty("lastAttemptSucceeded", false);
        obj->setProperty("error", "Track not found.");
        return juce::var(obj.release());
    }

    auto* track = it->second;
    obj->setProperty("active", track->hasActiveARA());
    obj->setProperty("activeFxIndex", track->getARAFXIndex());
    obj->setProperty("lastAttemptFxIndex", track->getARALastAttemptFXIndex());
    obj->setProperty("lastAttemptComplete", track->isARALastAttemptComplete());
    obj->setProperty("lastAttemptWasARAPlugin", track->wasARALastAttemptForARAPlugin());
    obj->setProperty("lastAttemptSucceeded", track->didARALastAttemptSucceed());
    const auto debugSnapshot = track->getARADebugSnapshot();
    obj->setProperty("analysisProgress", debugSnapshot.analysisProgress);
    obj->setProperty("analysisComplete", debugSnapshot.analysisComplete);
    obj->setProperty("analysisRequested", debugSnapshot.analysisRequested);
    obj->setProperty("analysisStarted", debugSnapshot.analysisStarted);
    obj->setProperty("lastAnalysisProgressValue", debugSnapshot.lastAnalysisProgressValue);
    obj->setProperty("sourceCount", debugSnapshot.sourceCount);
    obj->setProperty("playbackRegionCount", debugSnapshot.playbackRegionCount);
    obj->setProperty("audioSourceSamplesAccessEnabled", debugSnapshot.audioSourceSamplesAccessEnabled);
    obj->setProperty("editorRendererAttached", debugSnapshot.editorRendererAttached);
    obj->setProperty("playbackRendererAttached", debugSnapshot.playbackRendererAttached);
    obj->setProperty("error", track->getARALastAttemptError());
    return juce::var(obj.release());
}

juce::var AudioEngine::shutdownARAForTrack(const juce::String& trackId)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end())
    {
        obj->setProperty("success", false);
        return juce::var(obj.release());
    }

    it->second->shutdownARA();
    obj->setProperty("success", true);
    return juce::var(obj.release());
}

bool AudioEngine::isARAActiveForTrack(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;
    return it->second->hasActiveARA();
}
