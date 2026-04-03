#include "TrackProcessor.h"

// Maximum channel count for the pre-allocated FX processing buffer.
// Must be large enough for multi-output instruments (e.g. Komplete Kontrol = 32 out).
static constexpr int kMaxFXChannels = 64;

// Debug logging — always active for FX diagnostics
static void logToDisk(const juce::String& msg)
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    auto openStudioLog = documentsDir.getChildFile("OpenStudio").getChildFile("debug_log.txt");
    auto legacyLog = documentsDir.getChildFile("Studio13").getChildFile("debug_log.txt");
    auto f = !openStudioLog.existsAsFile() && legacyLog.existsAsFile() ? legacyLog : openStudioLog;
    f.getParentDirectory().createDirectory();
    f.appendText(juce::Time::getCurrentTime().toString(true, true) + ": " + msg + "\n");
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

static void normalizeMonoLikeBufferToDualMono(juce::AudioBuffer<float>& buffer,
                                              int bufferChannels,
                                              int numSamples)
{
    if (bufferChannels < 2 || numSamples <= 0)
        return;

    const auto* left = buffer.getReadPointer(0);
    const auto* right = buffer.getReadPointer(1);

    float peakLeft = 0.0f;
    float peakRight = 0.0f;
    float maxDifference = 0.0f;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float absLeft = std::abs(left[sample]);
        const float absRight = std::abs(right[sample]);
        peakLeft = juce::jmax(peakLeft, absLeft);
        peakRight = juce::jmax(peakRight, absRight);
        maxDifference = juce::jmax(maxDifference, std::abs(left[sample] - right[sample]));
    }

    constexpr float silenceThreshold = 1.0e-5f;
    const float identicalTolerance = juce::jmax(1.0e-4f, juce::jmax(peakLeft, peakRight) * 1.0e-3f);

    const bool leftSilent = peakLeft <= silenceThreshold;
    const bool rightSilent = peakRight <= silenceThreshold;
    const bool nearlyIdentical = maxDifference <= identicalTolerance;

    if (nearlyIdentical)
        return;

    if (!leftSilent && rightSilent)
    {
        buffer.copyFrom(1, 0, buffer, 0, 0, numSamples);
        return;
    }

    if (leftSilent && !rightSilent)
        buffer.copyFrom(0, 0, buffer, 1, 0, numSamples);
}

TrackProcessor::TrackProcessor()
     : AudioProcessor (BusesProperties()
                       .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    publishRealtimeStateSnapshots();
}

TrackProcessor::~TrackProcessor()
{
}

void TrackProcessor::publishRealtimeStateSnapshots()
{
    auto inputSnapshot = std::make_shared<const ProcessorSnapshot>(inputFXPlugins.begin(), inputFXPlugins.end());
    auto trackSnapshot = std::make_shared<const ProcessorSnapshot>(trackFXPlugins.begin(), trackFXPlugins.end());
    auto sidechainSnapshot = std::make_shared<const SidechainSourceSnapshot>(sidechainSources.begin(), sidechainSources.end());
    auto sendSnapshot = std::make_shared<const SendSnapshot>(sends.begin(), sends.end());
    auto inputBypassSnapshot = std::make_shared<const BypassSnapshot>(inputFXBypassedState.begin(), inputFXBypassedState.end());
    auto trackBypassSnapshot = std::make_shared<const BypassSnapshot>(trackFXBypassedState.begin(), trackFXBypassedState.end());
    auto inputPrecisionSnapshot = std::make_shared<const PrecisionOverrideSnapshot>(inputFXForceFloatOverrides.begin(), inputFXForceFloatOverrides.end());
    auto trackPrecisionSnapshot = std::make_shared<const PrecisionOverrideSnapshot>(trackFXForceFloatOverrides.begin(), trackFXForceFloatOverrides.end());
    std::shared_ptr<juce::AudioProcessor> instrumentSnapshot = instrumentPlugin;

    std::atomic_store_explicit(&realtimeInputFXSnapshot, inputSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeTrackFXSnapshot, trackSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeInputFXBypassSnapshot, inputBypassSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeTrackFXBypassSnapshot, trackBypassSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeInputFXPrecisionOverrideSnapshot, inputPrecisionSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeTrackFXPrecisionOverrideSnapshot, trackPrecisionSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeSidechainSnapshot, sidechainSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeSendSnapshot, sendSnapshot, std::memory_order_release);
    std::atomic_store_explicit(&realtimeInstrumentSnapshot, instrumentSnapshot, std::memory_order_release);
}

const juce::String TrackProcessor::getName() const
{
    return "Track Processor";
}

bool TrackProcessor::acceptsMidi() const
{
    auto currentTrackType = trackType.load(std::memory_order_acquire);
    return currentTrackType == TrackType::MIDI || currentTrackType == TrackType::Instrument;
}

bool TrackProcessor::producesMidi() const
{
    auto currentTrackType = trackType.load(std::memory_order_acquire);
    return currentTrackType == TrackType::MIDI || currentTrackType == TrackType::Instrument;
}

bool TrackProcessor::isMidiEffect() const
{
    return false;
}

double TrackProcessor::getTailLengthSeconds() const
{
    return 0.0;
}

int TrackProcessor::getNumPrograms()
{
    return 1;
}

int TrackProcessor::getCurrentProgram()
{
    return 0;
}

void TrackProcessor::setCurrentProgram (int index)
{
    juce::ignoreUnused (index);
}

const juce::String TrackProcessor::getProgramName (int index)
{
    juce::ignoreUnused (index);
    return {};
}

void TrackProcessor::recomputePanGains()
{
    const float currentVolumeDb = trackVolumeDB.load(std::memory_order_relaxed);
    const float currentPan = trackPan.load(std::memory_order_relaxed);
    const float volumeGain = juce::Decibels::decibelsToGain(currentVolumeDb);
    float lGain = 1.0f;
    float rGain = 1.0f;
    computePanLawGains(panLaw, currentPan, volumeGain, lGain, rGain);

    cachedPanL.store(lGain, std::memory_order_relaxed);
    cachedPanR.store(rGain, std::memory_order_relaxed);
}

void TrackProcessor::setVolume(float newVolume)
{
    trackVolumeDB.store(juce::jlimit(-60.0f, 12.0f, newVolume), std::memory_order_relaxed);
    recomputePanGains();
}

void TrackProcessor::setPan(float newPan)
{
    trackPan.store(juce::jlimit(-1.0f, 1.0f, newPan), std::memory_order_relaxed);
    recomputePanGains();
}

void TrackProcessor::setMute(bool shouldMute)
{
    isMuted.store(shouldMute);
}

void TrackProcessor::setSolo(bool shouldSolo)
{
    isSoloed.store(shouldSolo);
}

void TrackProcessor::changeProgramName (int index, const juce::String& newName)
{
    juce::ignoreUnused (index, newName);
}

// Helper: call prepareToPlay on a plugin while preserving its bus layout.
//
// Some plugins (e.g. Amplitube 5) change their bus configuration in response to
// prepareToPlay — for example switching from mono-in/stereo-out (correct for a
// guitar amp) to stereo-in/stereo-out (incorrect: processes L and R independently
// through different cab tuning, producing a "polyphonic/doubled" artefact when
// the same mono signal is duplicated to both channels).
//
// The old code accidentally avoided this because TrackProcessor::prepareToPlay was
// empty, so getSampleRate()/getBlockSize() returned 0/0 and plugins ignored the call.
// Now that we call prepareToPlay with valid values, we must restore the layout.
static void preparePluginPreservingLayout(juce::AudioProcessor* plugin, double sampleRate,
                                          int maxBlock, ProcessingPrecisionMode precisionMode)
{
    const juce::ScopedLock callbackLock(plugin->getCallbackLock());

    if (plugin->supportsDoublePrecisionProcessing())
    {
        plugin->setProcessingPrecision(
            precisionMode == ProcessingPrecisionMode::Hybrid64
                ? juce::AudioProcessor::doublePrecision
                : juce::AudioProcessor::singlePrecision);
    }

    auto savedLayout = plugin->getBusesLayout();
    plugin->prepareToPlay(sampleRate, maxBlock);

    // If prepareToPlay changed the bus layout, restore and re-prepare so the
    // plugin operates with its original (createPluginInstance) channel config.
    if (plugin->getBusesLayout() != savedLayout)
    {
        plugin->setBusesLayout(savedLayout);
        plugin->prepareToPlay(sampleRate, maxBlock);
    }
}

static ProcessingPrecisionMode resolvePluginPrecisionMode(ProcessingPrecisionMode engineMode, bool forceFloat)
{
    return forceFloat ? ProcessingPrecisionMode::Float32 : engineMode;
}

void TrackProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    // Pre-allocate FX processing buffer with enough channels for complex plugins.
    // Use the actual device block size here — the buffer just needs to hold one callback.
    fxProcessBuffer.setSize(kMaxFXChannels, samplesPerBlock);
    fxProcessBufferDouble.setSize(kMaxFXChannels, samplesPerBlock);

    // Prepare PDC delay line
    {
        juce::dsp::ProcessSpec spec;
        spec.sampleRate = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
        spec.numChannels = 2;
        pdcDelayLine.prepare(spec);
        const int preparedPdcDelaySamples = pdcDelaySamples.load(std::memory_order_relaxed);
        if (preparedPdcDelaySamples > 0)
            pdcDelayLine.setDelay(static_cast<float>(preparedPdcDelaySamples));
    }

    // Prepare plugins with the actual device block size so realtime hosting
    // matches the hardware callback configuration.
    int pluginMaxBlock = samplesPerBlock > 0 ? samplesPerBlock : 512;

    // Propagate new sample rate and buffer size to all internal FX plugins,
    // preserving each plugin's bus layout (see preparePluginPreservingLayout).
    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
    {
        auto& plugin = inputFXPlugins[static_cast<size_t>(index)];
        if (plugin)
        {
            preparePluginPreservingLayout(plugin.get(), sampleRate, pluginMaxBlock,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getInputFXPrecisionOverride(index)));
            plugin->reset();
        }
    }

    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
    {
        auto& plugin = trackFXPlugins[static_cast<size_t>(index)];
        if (plugin)
        {
            juce::ignoreUnused (araController, araFXIndex);
            const int pluginBlockSize = pluginMaxBlock;
            preparePluginPreservingLayout(plugin.get(), sampleRate, pluginBlockSize,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getTrackFXPrecisionOverride(index)));
            plugin->reset();
        }
    }

    // Also re-prepare instrument plugin if loaded
    if (instrumentPlugin)
    {
        preparePluginPreservingLayout(instrumentPlugin.get(), sampleRate, pluginMaxBlock,
                                      resolvePluginPrecisionMode(processingPrecisionMode,
                                                                 instrumentForceFloatOverride.load(std::memory_order_acquire)));
        instrumentPlugin->reset();
    }

    // Prepare channel strip EQ
    channelStripEQ.prepareToPlay(sampleRate, samplesPerBlock);

    // Pre-allocate pre-fader buffer for send routing (2-channel stereo)
    preFaderBuffer.setSize(2, samplesPerBlock);
    realtimeFallbackBuffer.setSize(2, samplesPerBlock);
}

void TrackProcessor::releaseResources()
{
}

bool TrackProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    juce::ignoreUnused (layouts);
    return true; // Simplified
}

void TrackProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    processBlockInternal(buffer, midiMessages);
}

bool TrackProcessor::tryProcessBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    processBlockInternal(buffer, midiMessages);
    return true;
}

void TrackProcessor::processBlockInternal (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    const double trackProcessStartMs = juce::Time::getMillisecondCounterHiRes();
    juce::ScopedNoDenormals noDenormals;
    auto totalNumInputChannels  = getTotalNumInputChannels();
    auto totalNumOutputChannels = getTotalNumOutputChannels();
    const auto currentTrackType = trackType.load(std::memory_order_acquire);
    auto inputFXSnapshot = std::atomic_load_explicit(&realtimeInputFXSnapshot, std::memory_order_acquire);
    auto trackFXSnapshot = std::atomic_load_explicit(&realtimeTrackFXSnapshot, std::memory_order_acquire);
    auto inputFXBypassSnapshot = std::atomic_load_explicit(&realtimeInputFXBypassSnapshot, std::memory_order_acquire);
    auto trackFXBypassSnapshot = std::atomic_load_explicit(&realtimeTrackFXBypassSnapshot, std::memory_order_acquire);
    auto inputFXPrecisionOverrideSnapshot = std::atomic_load_explicit(&realtimeInputFXPrecisionOverrideSnapshot, std::memory_order_acquire);
    auto trackFXPrecisionOverrideSnapshot = std::atomic_load_explicit(&realtimeTrackFXPrecisionOverrideSnapshot, std::memory_order_acquire);
    auto instrumentSnapshot = std::atomic_load_explicit(&realtimeInstrumentSnapshot, std::memory_order_acquire);
    auto sidechainSnapshot = std::atomic_load_explicit(&realtimeSidechainSnapshot, std::memory_order_acquire);
    auto sendSnapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    const bool instrumentForceFloat = instrumentForceFloatOverride.load(std::memory_order_acquire);
    const double blockStartTimeSeconds = blockSampleRate > 0.0 ? (blockStartSample / blockSampleRate) : 0.0;

    if (araController != nullptr && araController->isActive())
        araController->updateTransportDebugState(araTransportPlayingDebugState.load(std::memory_order_acquire),
                                                 blockStartTimeSeconds);

    // Safety: only clear channels that actually exist in the buffer
    int bufferChannels = buffer.getNumChannels();
    for (auto i = totalNumInputChannels; i < juce::jmin(totalNumOutputChannels, bufferChannels); ++i)
        buffer.clear (i, 0, buffer.getNumSamples());

    // Apply mute first - if muted, silence and return
    if (isMuted.load())
    {
        buffer.clear();
        currentRMS = 0.0f;
        return;
    }

    // Apply Plugin Delay Compensation (PDC) before FX chains
    if (pdcDelayDirty.exchange(false, std::memory_order_acq_rel))
        pdcDelayLine.setDelay(static_cast<float>(pdcDelaySamples.load(std::memory_order_relaxed)));

    if (pdcDelaySamples.load(std::memory_order_relaxed) > 0)
    {
        juce::dsp::AudioBlock<float> block(buffer);
        juce::dsp::ProcessContextReplacing<float> context(block);
        pdcDelayLine.process(context);
    }

    bool hasAnyFX = (inputFXSnapshot && !inputFXSnapshot->empty())
                 || (trackFXSnapshot && !trackFXSnapshot->empty());

    // One-time diagnostic log on first processBlock call with FX loaded
    // (helps diagnose crashes — last log entry before crash shows where it stopped)
    static bool loggedFirstFXProcess = false;
    if (hasAnyFX && !loggedFirstFXProcess)
    {
        loggedFirstFXProcess = true;
        logToDisk("TrackProcessor::processBlock FIRST CALL WITH FX");
        logToDisk("  buffer channels: " + juce::String(bufferChannels) +
                  " samples: " + juce::String(buffer.getNumSamples()));
        logToDisk("  totalNumInputChannels: " + juce::String(totalNumInputChannels) +
                  " totalNumOutputChannels: " + juce::String(totalNumOutputChannels));
        logToDisk("  inputFX count: " + juce::String(inputFXSnapshot ? (int)inputFXSnapshot->size() : 0) +
                  " trackFX count: " + juce::String(trackFXSnapshot ? (int)trackFXSnapshot->size() : 0));
        logToDisk("  fxProcessBuffer channels: " + juce::String(fxProcessBuffer.getNumChannels()) +
                  " samples: " + juce::String(fxProcessBuffer.getNumSamples()));
        logToDisk("  sampleRate: " + juce::String(getSampleRate()) +
                  " blockSize: " + juce::String(getBlockSize()));

        for (int i = 0; inputFXSnapshot && i < (int)inputFXSnapshot->size(); ++i)
        {
            auto* proc = (*inputFXSnapshot)[i].get();
            if (proc)
            {
                logToDisk("  inputFX[" + juce::String(i) + "]: " + proc->getName() +
                          " inCh=" + juce::String(proc->getTotalNumInputChannels()) +
                          " outCh=" + juce::String(proc->getTotalNumOutputChannels()) +
                          " sr=" + juce::String(proc->getSampleRate()) +
                          " bs=" + juce::String(proc->getBlockSize()));
            }
        }

        for (int i = 0; trackFXSnapshot && i < (int)trackFXSnapshot->size(); ++i)
        {
            auto* proc = (*trackFXSnapshot)[i].get();
            if (proc)
            {
                logToDisk("  trackFX[" + juce::String(i) + "]: " + proc->getName() +
                          " inCh=" + juce::String(proc->getTotalNumInputChannels()) +
                          " outCh=" + juce::String(proc->getTotalNumOutputChannels()) +
                          " sr=" + juce::String(proc->getSampleRate()) +
                          " bs=" + juce::String(proc->getBlockSize()));
            }
        }

        // Log safeProcessFX path decision for first plugin
        if (trackFXSnapshot && !trackFXSnapshot->empty() && (*trackFXSnapshot)[0])
        {
            auto* proc = (*trackFXSnapshot)[0].get();
            int pluginChannels = juce::jmax(proc->getTotalNumInputChannels(),
                                             proc->getTotalNumOutputChannels());
            logToDisk("  safeProcessFX: pluginChannels=" + juce::String(pluginChannels) +
                      " bufferChannels=" + juce::String(bufferChannels) +
                      " path=" + juce::String(pluginChannels == bufferChannels ? "DIRECT" : "EXPANDED"));
        }
    }

    // Channel-safe FX processing helper
    auto safeProcessFX = [&](juce::AudioProcessor* proc, bool forceFloat)
    {
        const double envelopeStartMs = juce::Time::getMillisecondCounterHiRes();
        int pluginChannels = juce::jmax(proc->getTotalNumInputChannels(),
                                         proc->getTotalNumOutputChannels());
        const bool isARAProcessor = araController != nullptr
                                 && araController->isActive()
                                 && araFXIndex >= 0
                                 && trackFXSnapshot
                                 && araFXIndex < static_cast<int>(trackFXSnapshot->size())
                                 && (*trackFXSnapshot)[static_cast<size_t>(araFXIndex)].get() == proc;
        const bool useDoublePrecision =
            processingPrecisionMode == ProcessingPrecisionMode::Hybrid64
            && !forceFloat
            && proc->supportsDoublePrecisionProcessing();
        const int numSamps = buffer.getNumSamples();
        const int expandedCh = useDoublePrecision
            ? juce::jmin(pluginChannels, fxProcessBufferDouble.getNumChannels())
            : juce::jmin(pluginChannels, fxProcessBuffer.getNumChannels());
        double preProcessMs = 0.0;
        double processDurationMs = 0.0;
        auto logARAProcessDuration = [&](double postProcessMs)
        {
            if (!isARAProcessor)
                return;

            const double totalDurationMs = juce::Time::getMillisecondCounterHiRes() - envelopeStartMs;
            if (kEnableARADebugDiagnostics && (processDurationMs > 10.0 || totalDurationMs > 10.0))
            {
                const auto playbackRun = araPlaybackRunCounter.load(std::memory_order_acquire);
                const auto lastSlowRun = araLastSlowLogPlaybackRun.load(std::memory_order_acquire);
                if (lastSlowRun != playbackRun)
                {
                    araLastSlowLogPlaybackRun.store(playbackRun, std::memory_order_release);
                    const auto snapshot = araController->getDebugSnapshot();
                    logToDisk("ARA session slow-block: trackId=" + araDebugTrackId
                        + " fxIndex=" + juce::String(araFXIndex)
                        + " plugin=" + proc->getName()
                        + " callback=" + juce::String(static_cast<juce::int64>(currentARAProcessDebugInfo.callbackCounter))
                        + " firstCallbackAfterTransportStart=" + juce::String(currentARAProcessDebugInfo.firstCallbackAfterTransportStart ? "true" : "false")
                        + " trackBufferChannels=" + juce::String(bufferChannels)
                        + " pluginIn=" + juce::String(proc->getTotalNumInputChannels())
                        + " pluginOut=" + juce::String(proc->getTotalNumOutputChannels())
                        + " pluginSr=" + juce::String(proc->getSampleRate())
                        + " pluginBs=" + juce::String(proc->getBlockSize())
                        + " trackSr=" + juce::String(getSampleRate())
                        + " trackBs=" + juce::String(getBlockSize())
                        + " transportPos=" + juce::String(snapshot.transportPositionSeconds, 3)
                        + " editorAnalysis=" + juce::String(snapshot.analysisProgress, 3)
                        + " analysisRequested=" + juce::String(snapshot.analysisRequested ? "true" : "false")
                        + " analysisStarted=" + juce::String(snapshot.analysisStarted ? "true" : "false")
                        + " analysisComplete=" + juce::String(snapshot.analysisComplete ? "true" : "false")
                        + " editorFocusedAtPlayStart=" + juce::String(araEditorFocusedAtPlaybackStart.load(std::memory_order_acquire) ? "true" : "false")
                        + " playbackRegionCount=" + juce::String(snapshot.playbackRegionCount)
                        + " playbackRendererAttached=" + juce::String(snapshot.playbackRendererAttached ? "true" : "false")
                        + " editorRendererAttached=" + juce::String(snapshot.editorRendererAttached ? "true" : "false")
                        + " audioSourceSamplesAccessEnabled=" + juce::String(snapshot.audioSourceSamplesAccessEnabled ? "true" : "false")
                        + " sourceCount=" + juce::String(snapshot.sourceCount)
                        + " lastOperation=" + snapshot.lastOperation
                        + " lastEditType=" + snapshot.lastEditType
                        + " lastClipId=" + snapshot.lastClipId
                        + " pendingEditSinceLastPlay=" + juce::String(snapshot.hasPendingEditSinceLastPlay ? "true" : "false")
                        + " timeSinceLastPlayStartMs=" + juce::String(snapshot.timeSinceLastPlayStartMs, 2));
                }

                logToDisk("ARA FX processBlock slow: " + proc->getName()
                    + " callback=" + juce::String(static_cast<juce::int64>(currentARAProcessDebugInfo.callbackCounter))
                    + " firstCallbackAfterTransportStart=" + juce::String(currentARAProcessDebugInfo.firstCallbackAfterTransportStart ? "true" : "false")
                    + " preMs=" + juce::String(preProcessMs, 2)
                    + " processMs=" + juce::String(processDurationMs, 2)
                    + " postMs=" + juce::String(postProcessMs, 2)
                    + " totalMs=" + juce::String(totalDurationMs, 2)
                    + " callbackAgeMs=" + juce::String(juce::Time::getMillisecondCounterHiRes() - currentARAProcessDebugInfo.callbackStartWallTimeMs, 2)
                    + " samples=" + juce::String(numSamps));
            }
        };

        if (!useDoublePrecision && pluginChannels == bufferChannels)
        {
            const double processStartMs = juce::Time::getMillisecondCounterHiRes();
            preProcessMs = processStartMs - envelopeStartMs;
            proc->processBlock(buffer, midiMessages);
            processDurationMs = juce::Time::getMillisecondCounterHiRes() - processStartMs;
            // Mono plugin on stereo track: duplicate processed output to all channels
            // (matches Reaper behaviour — avoids dry right channel when plugin is mono out)
            int outCh = proc->getTotalNumOutputChannels();
            if (outCh > 0 && outCh < bufferChannels)
            {
                for (int ch = outCh; ch < bufferChannels; ++ch)
                    buffer.copyFrom (ch, 0, buffer, 0, 0, numSamps);
            }
            logARAProcessDuration(juce::Time::getMillisecondCounterHiRes() - (processStartMs + processDurationMs));
        }
        else
        {
            if (useDoublePrecision)
            {
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    auto* dest = fxProcessBufferDouble.getWritePointer(ch);
                    if (ch < bufferChannels)
                    {
                        auto* src = buffer.getReadPointer(ch);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = static_cast<double>(src[sample]);
                    }
                    else
                    {
                        juce::FloatVectorOperations::clear(dest, numSamps);
                    }
                }

                double* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBufferDouble.getWritePointer(ch);

                juce::AudioBuffer<double> pluginBuffer(channelPtrs, expandedCh, numSamps);
                const double processStartMs = juce::Time::getMillisecondCounterHiRes();
                preProcessMs = processStartMs - envelopeStartMs;
                proc->processBlock(pluginBuffer, midiMessages);
                processDurationMs = juce::Time::getMillisecondCounterHiRes() - processStartMs;

                if (expandedCh == 1 && bufferChannels > 1)
                {
                    auto* mono = pluginBuffer.getReadPointer(0);
                    for (int ch = 0; ch < bufferChannels; ++ch)
                    {
                        auto* dest = buffer.getWritePointer(ch);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = static_cast<float>(mono[sample]);
                    }
                }
                else
                {
                    for (int ch = 0; ch < bufferChannels; ++ch)
                    {
                        auto* dest = buffer.getWritePointer(ch);
                        auto* src = pluginBuffer.getReadPointer(ch < expandedCh ? ch : 0);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = static_cast<float>(src[sample]);
                    }
                }
                logARAProcessDuration(juce::Time::getMillisecondCounterHiRes() - (processStartMs + processDurationMs));
            }
            else
            {
                // Plugin needs more channels — use pre-allocated expanded buffer
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    if (expandedCh == 1 && bufferChannels > 1)
                    {
                        auto* dest = fxProcessBuffer.getWritePointer(ch);
                        auto* left = buffer.getReadPointer(0);
                        auto* right = buffer.getReadPointer(1);
                        for (int sample = 0; sample < numSamps; ++sample)
                            dest[sample] = (left[sample] + right[sample]) * 0.5f;
                    }
                    else if (ch < bufferChannels)
                        fxProcessBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamps);
                    else
                        juce::FloatVectorOperations::clear(fxProcessBuffer.getWritePointer(ch), numSamps);
                }

                float* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBuffer.getWritePointer(ch);

                juce::AudioBuffer<float> pluginBuffer(channelPtrs, expandedCh, numSamps);
                const double processStartMs = juce::Time::getMillisecondCounterHiRes();
                preProcessMs = processStartMs - envelopeStartMs;
                proc->processBlock(pluginBuffer, midiMessages);
                processDurationMs = juce::Time::getMillisecondCounterHiRes() - processStartMs;

                if (expandedCh == 1 && bufferChannels > 1)
                {
                    for (int ch = 0; ch < bufferChannels; ++ch)
                        buffer.copyFrom(ch, 0, pluginBuffer, 0, 0, numSamps);
                }
                else
                {
                    for (int ch = 0; ch < bufferChannels; ++ch)
                        buffer.copyFrom(ch, 0, pluginBuffer, ch < expandedCh ? ch : 0, 0, numSamps);
                }
                logARAProcessDuration(juce::Time::getMillisecondCounterHiRes() - (processStartMs + processDurationMs));
            }
        }
    };

    // Channel strip EQ (processed before plugin FX chains)
    if (channelStripEQEnabled)
    {
        channelStripEQ.processBlock(buffer, midiMessages);
    }

    // Process through input FX chain
    if (inputFXSnapshot)
    {
        for (int pluginIndex = 0; pluginIndex < static_cast<int>(inputFXSnapshot->size()); ++pluginIndex)
        {
            const auto& plugin = (*inputFXSnapshot)[pluginIndex];
            const bool bypassed = inputFXBypassSnapshot != nullptr
                               && inputFXBypassSnapshot->count(pluginIndex) > 0
                               && inputFXBypassSnapshot->at(pluginIndex);
            const bool forceFloat = inputFXPrecisionOverrideSnapshot != nullptr
                                 && inputFXPrecisionOverrideSnapshot->count(pluginIndex) > 0
                                 && inputFXPrecisionOverrideSnapshot->at(pluginIndex);
            if (plugin && !bypassed)
                safeProcessFX(plugin.get(), forceFloat);
        }
    }

    // Instrument processing lives between input FX and track FX so that
    // instrument output can be post-processed by normal track FX.
    if (currentTrackType == TrackType::Instrument && instrumentSnapshot)
        safeProcessFX(instrumentSnapshot.get(), instrumentForceFloat);

    // Process through track FX chain (with sidechain support)
    for (int fxIdx = 0; trackFXSnapshot && fxIdx < (int)trackFXSnapshot->size(); ++fxIdx)
    {
        auto* proc = (*trackFXSnapshot)[fxIdx].get();
        if (!proc) continue;
        if (trackFXBypassSnapshot != nullptr)
        {
            auto bypassIt = trackFXBypassSnapshot->find(fxIdx);
            if (bypassIt != trackFXBypassSnapshot->end() && bypassIt->second)
                continue;
        }
        const bool forceFloat = trackFXPrecisionOverrideSnapshot != nullptr
                             && trackFXPrecisionOverrideSnapshot->count(fxIdx) > 0
                             && trackFXPrecisionOverrideSnapshot->at(fxIdx);

        // Check if this plugin has a sidechain source configured AND
        // the plugin actually supports sidechain input (more than 1 input bus)
        SidechainSourceSnapshot::const_iterator scIt;
        bool hasSidechain = false;
        if (sidechainSnapshot != nullptr)
        {
            scIt = sidechainSnapshot->find(fxIdx);
            hasSidechain = scIt != sidechainSnapshot->end();
        }
        hasSidechain = hasSidechain
                            && sidechainInputBuffer != nullptr
                            && proc->getBusCount(true) > 1;

        if (hasSidechain)
        {
            // Sidechain path: expand buffer to include sidechain channels after
            // the main stereo channels.  The plugin's second input bus receives
            // the sidechain audio.
            int numSamps2 = buffer.getNumSamples();

            // Determine total channel count: main channels + sidechain channels.
            // Most sidechain buses are stereo (2 channels), but query the plugin
            // to be safe.
            int mainCh = juce::jmax(proc->getMainBusNumInputChannels(),
                                     proc->getMainBusNumOutputChannels());
            if (mainCh < bufferChannels) mainCh = bufferChannels;

            // The sidechain bus is the second input bus (index 1).
            int scBusCh = 0;
            if (auto* scBus = proc->getBus(true, 1))
                scBusCh = scBus->getNumberOfChannels();
            if (scBusCh <= 0) scBusCh = 2; // Fallback: stereo sidechain

            int totalCh = mainCh + scBusCh;
            const bool useDoublePrecision =
                processingPrecisionMode == ProcessingPrecisionMode::Hybrid64
                && !forceFloat
                && proc->supportsDoublePrecisionProcessing();
            int expandedCh = useDoublePrecision
                ? juce::jmin(totalCh, fxProcessBufferDouble.getNumChannels())
                : juce::jmin(totalCh, fxProcessBuffer.getNumChannels());

            if (useDoublePrecision)
            {
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    auto* dest = fxProcessBufferDouble.getWritePointer(ch);
                    juce::FloatVectorOperations::clear(dest, numSamps2);
                    if (expandedCh == 1 && bufferChannels > 1)
                    {
                        auto* left = buffer.getReadPointer(0);
                        auto* right = buffer.getReadPointer(1);
                        for (int sample = 0; sample < numSamps2; ++sample)
                            dest[sample] = static_cast<double>((left[sample] + right[sample]) * 0.5f);
                    }
                    else if (ch < bufferChannels)
                    {
                        auto* src = buffer.getReadPointer(ch);
                        for (int sample = 0; sample < numSamps2; ++sample)
                            dest[sample] = static_cast<double>(src[sample]);
                    }
                }

                int scInputCh = sidechainInputBuffer->getNumChannels();
                for (int ch = 0; ch < scBusCh && (mainCh + ch) < expandedCh; ++ch)
                {
                    if (ch < scInputCh)
                    {
                        auto* dest = fxProcessBufferDouble.getWritePointer(mainCh + ch);
                        auto* src = sidechainInputBuffer->getReadPointer(ch);
                        for (int sample = 0; sample < numSamps2; ++sample)
                            dest[sample] = static_cast<double>(src[sample]);
                    }
                }

                double* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBufferDouble.getWritePointer(ch);

                juce::AudioBuffer<double> pluginBuffer(channelPtrs, expandedCh, numSamps2);
                proc->processBlock(pluginBuffer, midiMessages);

                for (int ch = 0; ch < bufferChannels; ++ch)
                {
                    auto* dest = buffer.getWritePointer(ch);
                    auto* src = pluginBuffer.getReadPointer(ch);
                    for (int sample = 0; sample < numSamps2; ++sample)
                        dest[sample] = static_cast<float>(src[sample]);
                }
            }
            else
            {
                // Copy main audio into pre-allocated buffer
                for (int ch = 0; ch < expandedCh; ++ch)
                {
                    if (ch < bufferChannels)
                        fxProcessBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamps2);
                    else
                        juce::FloatVectorOperations::clear(fxProcessBuffer.getWritePointer(ch), numSamps2);
                }

                // Copy sidechain audio into channels after the main channels
                int scInputCh = sidechainInputBuffer->getNumChannels();
                for (int ch = 0; ch < scBusCh && (mainCh + ch) < expandedCh; ++ch)
                {
                    if (ch < scInputCh)
                    {
                        fxProcessBuffer.copyFrom(mainCh + ch, 0,
                                                 *sidechainInputBuffer, ch, 0, numSamps2);
                    }
                }

                float* channelPtrs[kMaxFXChannels];
                for (int ch = 0; ch < expandedCh; ++ch)
                    channelPtrs[ch] = fxProcessBuffer.getWritePointer(ch);

                juce::AudioBuffer<float> pluginBuffer(channelPtrs, expandedCh, numSamps2);
                proc->processBlock(pluginBuffer, midiMessages);

                // Copy processed main channels back
                for (int ch = 0; ch < bufferChannels; ++ch)
                    buffer.copyFrom(ch, 0, pluginBuffer, ch, 0, numSamps2);
            }
        }
        else
        {
            // No sidechain — use normal channel-safe processing
            safeProcessFX(proc, forceFloat);
        }
    }

    const double trackProcessDurationMs = juce::Time::getMillisecondCounterHiRes() - trackProcessStartMs;
    if (kEnableARADebugDiagnostics
        && trackProcessDurationMs > 10.0
        && araController != nullptr
        && araController->isActive())
    {
        logToDisk("ARA track envelope slow: trackId=" + araDebugTrackId
            + " callback=" + juce::String(static_cast<juce::int64>(currentARAProcessDebugInfo.callbackCounter))
            + " firstCallbackAfterTransportStart=" + juce::String(currentARAProcessDebugInfo.firstCallbackAfterTransportStart ? "true" : "false")
            + " totalTrackMs=" + juce::String(trackProcessDurationMs, 2)
            + " blockStartSeconds=" + juce::String(blockStartTimeSeconds, 3)
            + " numSamples=" + juce::String(buffer.getNumSamples()));
    }

    // ===== DC OFFSET REMOVAL (after FX, before gain) =====
    if (dcOffsetRemoval && bufferChannels >= 1)
    {
        double sr = getSampleRate();
        if (sr <= 0) sr = 44100.0;
        float alpha = 1.0f - (2.0f * juce::MathConstants<float>::pi * 5.0f / static_cast<float>(sr));

        // Left channel
        {
            float prevIn = dcPrevInputL;
            float prevOut = dcFilterStateL;
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                float input = buffer.getSample(0, i);
                float output = input - prevIn + alpha * prevOut;
                prevIn = input;
                prevOut = output;
                buffer.setSample(0, i, output);
            }
            dcPrevInputL = prevIn;
            dcFilterStateL = prevOut;
        }

        // Right channel
        if (bufferChannels >= 2)
        {
            float prevIn = dcPrevInputR;
            float prevOut = dcFilterStateR;
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                float input = buffer.getSample(1, i);
                float output = input - prevIn + alpha * prevOut;
                prevIn = input;
                prevOut = output;
                buffer.setSample(1, i, output);
            }
            dcPrevInputR = prevIn;
            dcFilterStateR = prevOut;
        }
    }

    // ===== PHASE INVERT (polarity flip) =====
    if (phaseInverted.load(std::memory_order_relaxed))
    {
        for (int ch = 0; ch < bufferChannels; ++ch)
            juce::FloatVectorOperations::negate(
                buffer.getWritePointer(ch),
                buffer.getReadPointer(ch),
                buffer.getNumSamples());
    }

    // ===== STEREO WIDTH (M/S processing) =====
    float widthVal = stereoWidth.load(std::memory_order_relaxed);
    if (bufferChannels >= 2 && std::abs(widthVal - 100.0f) > 0.01f)
    {
        float w = widthVal / 100.0f;  // 0.0 = mono, 1.0 = normal, 2.0 = extra wide
        float* L = buffer.getWritePointer(0);
        float* R = buffer.getWritePointer(1);
        for (int i = 0; i < buffer.getNumSamples(); ++i)
        {
            float mid  = (L[i] + R[i]) * 0.5f;
            float side = (L[i] - R[i]) * 0.5f;
            L[i] = mid + side * w;
            R[i] = mid - side * w;
        }
    }

    // Mirror effectively mono post-FX output before send taps so pre/post-fader sends,
    // receives, and the track output all hear the same centered mono image.
    normalizeMonoLikeBufferToDualMono(buffer, bufferChannels, buffer.getNumSamples());

    // ===== CAPTURE PRE-FADER BUFFER (for pre-fader sends) =====
    if (sendSnapshot && !sendSnapshot->empty())
    {
        int pfSamples = buffer.getNumSamples();
        if (preFaderBuffer.getNumSamples() < pfSamples)
            preFaderBuffer.setSize(2, pfSamples, false, false, true);
        for (int ch = 0; ch < juce::jmin(2, bufferChannels); ++ch)
            preFaderBuffer.copyFrom(ch, 0, buffer, ch, 0, pfSamples);
    }

    // ===== AUTOMATION-AWARE GAIN APPLICATION =====
    int numSamps = buffer.getNumSamples();
    bool volAutoActive = volumeAutomation.shouldPlayback() && volumeAutomation.getNumPoints() > 0;
    bool panAutoActive = panAutomation.shouldPlayback() && panAutomation.getNumPoints() > 0;

    if (volAutoActive || panAutoActive)
    {
        // Ensure pre-allocated automation buffer is large enough
        if (automationGainBuffer.getNumSamples() < numSamps)
            automationGainBuffer.setSize(2, numSamps, false, false, true);

        // Evaluate volume automation (dB values) per sample, or use static fader value
        float staticVolDB = trackVolumeDB.load(std::memory_order_relaxed);
        float staticPan = trackPan.load(std::memory_order_relaxed);

        for (int i = 0; i < numSamps; ++i)
        {
            double samplePos = blockStartSample + static_cast<double>(i);

            float volDB = volAutoActive ? volumeAutomation.eval(samplePos) : staticVolDB;
            float pan   = panAutoActive ? panAutomation.eval(samplePos)   : staticPan;

            // Clamp to safe ranges
            volDB = juce::jlimit(-60.0f, 12.0f, volDB);
            pan   = juce::jlimit(-1.0f, 1.0f, pan);

            float volumeGain = juce::Decibels::decibelsToGain(volDB);
            float lGain = 1.0f;
            float rGain = 1.0f;
            computePanLawGains(panLaw, pan, volumeGain, lGain, rGain);

            // Apply per-sample gain
            if (bufferChannels >= 1)
                buffer.setSample(0, i, buffer.getSample(0, i) * lGain);
            if (bufferChannels >= 2)
                buffer.setSample(1, i, buffer.getSample(1, i) * rGain);
        }
    }
    else
    {
        // No automation active — use pre-computed cached gains (original fast path)
        float leftGain  = cachedPanL.load(std::memory_order_relaxed);
        float rightGain = cachedPanR.load(std::memory_order_relaxed);

        if (bufferChannels >= 1)
            buffer.applyGain(0, 0, numSamps, leftGain);
        if (bufferChannels >= 2)
            buffer.applyGain(1, 0, numSamps, rightGain);
    }

    // ---- REAPER-style peak metering with decimation ----
    // getMagnitude() uses FloatVectorOperations::findMinAndMax (SIMD, no sqrt),
    // which is much cheaper than getRMSLevel() (which computes sqrt per channel).
    // We accumulate the running peak over METER_UPDATE_SAMPLES then commit it
    // to currentRMS. At 32-sample ASIO blocks this fires ~86 times/sec instead
    // of 1378 times/sec — a 16× reduction in per-track metering overhead.
    float peak = 0.0f;
    for (int ch = 0; ch < bufferChannels; ++ch)
        peak = juce::jmax (peak, buffer.getMagnitude (ch, 0, buffer.getNumSamples()));

    if (peak > 1.0f)
        clipLatched.store(true, std::memory_order_relaxed);

    meterPeakAccum   = juce::jmax (meterPeakAccum, peak);
    meterSampleCount += buffer.getNumSamples();
    if (meterSampleCount >= METER_UPDATE_SAMPLES)
    {
        currentRMS.store (meterPeakAccum, std::memory_order_relaxed);
        meterPeakAccum   = 0.0f;
        meterSampleCount = 0;
    }

    if (realtimeFallbackBuffer.getNumChannels() < bufferChannels
        || realtimeFallbackBuffer.getNumSamples() < buffer.getNumSamples())
    {
        realtimeFallbackBuffer.setSize(bufferChannels, buffer.getNumSamples(), false, false, true);
    }

    for (int ch = 0; ch < bufferChannels; ++ch)
        realtimeFallbackBuffer.copyFrom(ch, 0, buffer, ch, 0, buffer.getNumSamples());
}

bool TrackProcessor::hasEditor() const
{
    return false;
}

juce::AudioProcessorEditor* TrackProcessor::createEditor()
{
    return nullptr;
}

void TrackProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::ignoreUnused (destData);
}

void TrackProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    juce::ignoreUnused (data, sizeInBytes);
}

void TrackProcessor::setInputChannels(int startChannel, int numChannels)
{
    inputStartChannel.store(startChannel, std::memory_order_release);
    inputChannelCount.store(numChannels, std::memory_order_release);
    juce::Logger::writeToLog("TrackProcessor: Input channels set to " +
                           juce::String(startChannel) + "-" +
                           juce::String(startChannel + numChannels - 1));
}

//==============================================================================
// FX Chain Management (Phase 3)
// Plugins are stored directly in vectors — no AudioProcessorGraph wrapper.
// This gives us full control over the plugin lifecycle and avoids any graph
// interference (bus layout changes, re-preparation, etc.).

bool TrackProcessor::addInputFX(std::unique_ptr<juce::AudioProcessor> plugin, double callerSampleRate, int callerBlockSize)
{
    if (!plugin)
        return false;

    const juce::ScopedLock callbackLock(getCallbackLock());

    // Only set stereo layout if the plugin has no channels configured
    // (some plugins start at 0-in/0-out and need explicit bus setup).
    // Don't change plugins that already have a valid default layout
    // (e.g. guitar amp sims like Amplitube default to mono-in/stereo-out;
    // forcing stereo-in makes them apply different L/R processing to the
    // duplicated mono signal, producing a "polyphonic" doubled sound).
    if (plugin->getTotalNumInputChannels() == 0 && plugin->getTotalNumOutputChannels() == 0)
    {
        juce::AudioProcessor::BusesLayout stereoLayout;
        stereoLayout.inputBuses.add(juce::AudioChannelSet::stereo());
        stereoLayout.outputBuses.add(juce::AudioChannelSet::stereo());
        plugin->setBusesLayout(stereoLayout);
    }

    // Prefer caller-supplied rate (from AudioEngine), fall back to our own,
    // then to 44100 as last resort. Use the realtime device block size when known.
    double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
    int bs = callerBlockSize > 0 ? callerBlockSize : getBlockSize();
    if (sr <= 0) sr = 44100.0;
    if (bs <= 0) bs = 512;

    // Prepare while preserving bus layout (see preparePluginPreservingLayout).
    preparePluginPreservingLayout(plugin.get(), sr, bs,
                                  resolvePluginPrecisionMode(processingPrecisionMode, false));

    juce::Logger::writeToLog("TrackProcessor: Added Input FX plugin (" + plugin->getName() +
                             ") prepared at " + juce::String(sr) + "Hz / " + juce::String(bs) + " samples" +
                             " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                             " outCh=" + juce::String(plugin->getTotalNumOutputChannels()));

    inputFXPlugins.push_back(std::shared_ptr<juce::AudioProcessor>(std::move(plugin)));
    publishRealtimeStateSnapshots();
    return true;
}

bool TrackProcessor::addTrackFX(std::unique_ptr<juce::AudioProcessor> plugin, double callerSampleRate, int callerBlockSize)
{
    if (!plugin)
        return false;

    const juce::ScopedLock callbackLock(getCallbackLock());

    // Only set stereo layout if the plugin has no channels configured
    // (same rationale as addInputFX — preserve the plugin's default layout).
    if (plugin->getTotalNumInputChannels() == 0 && plugin->getTotalNumOutputChannels() == 0)
    {
        juce::AudioProcessor::BusesLayout stereoLayout;
        stereoLayout.inputBuses.add(juce::AudioChannelSet::stereo());
        stereoLayout.outputBuses.add(juce::AudioChannelSet::stereo());
        plugin->setBusesLayout(stereoLayout);
    }

    // Prefer caller-supplied rate (from AudioEngine), fall back to our own,
    // then to 44100 as last resort. Use the realtime device block size when known.
    double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
    int bs = callerBlockSize > 0 ? callerBlockSize : getBlockSize();
    if (sr <= 0) sr = 44100.0;
    if (bs <= 0) bs = 512;

    // Prepare while preserving bus layout (see preparePluginPreservingLayout).
    preparePluginPreservingLayout(plugin.get(), sr, bs,
                                  resolvePluginPrecisionMode(processingPrecisionMode, false));

    juce::Logger::writeToLog("TrackProcessor: Added Track FX plugin (" + plugin->getName() +
                             ") prepared at " + juce::String(sr) + "Hz / " + juce::String(bs) + " samples" +
                             " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                             " outCh=" + juce::String(plugin->getTotalNumOutputChannels()));

    trackFXPlugins.push_back(std::shared_ptr<juce::AudioProcessor>(std::move(plugin)));
    publishRealtimeStateSnapshots();
    return true;
}

void TrackProcessor::removeInputFX(int index)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (index >= 0 && index < (int)inputFXPlugins.size())
    {
        inputFXPlugins.erase(inputFXPlugins.begin() + index);
        std::map<int, bool> updatedOverrides;
        std::map<int, bool> updatedBypass;
        for (const auto& [fxIndex, forceFloat] : inputFXForceFloatOverrides)
        {
            if (fxIndex == index)
                continue;
            updatedOverrides[fxIndex > index ? fxIndex - 1 : fxIndex] = forceFloat;
        }
        for (const auto& [fxIndex, bypassed] : inputFXBypassedState)
        {
            if (fxIndex == index)
                continue;
            updatedBypass[fxIndex > index ? fxIndex - 1 : fxIndex] = bypassed;
        }
        inputFXForceFloatOverrides = std::move(updatedOverrides);
        inputFXBypassedState = std::move(updatedBypass);
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Removed Input FX at index " + juce::String(index));
    }
}

void TrackProcessor::removeTrackFX(int index)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (index >= 0 && index < (int)trackFXPlugins.size())
    {
        if (index == araFXIndex)
        {
            // Deactivate the plugin BEFORE ARA shutdown to stop its internal
            // threads from calling readAudioSamples on sources we're about to
            // destroy. Without this, the audio thread or plugin analysis thread
            // accesses freed memory → crash.
            if (auto& plugin = trackFXPlugins[static_cast<size_t>(index)])
                plugin->releaseResources();
            shutdownARA();
        }
        else if (index < araFXIndex)
            --araFXIndex;

        trackFXPlugins.erase(trackFXPlugins.begin() + index);
        std::map<int, bool> updatedOverrides;
        std::map<int, bool> updatedBypass;
        for (const auto& [fxIndex, forceFloat] : trackFXForceFloatOverrides)
        {
            if (fxIndex == index)
                continue;
            updatedOverrides[fxIndex > index ? fxIndex - 1 : fxIndex] = forceFloat;
        }
        for (const auto& [fxIndex, bypassed] : trackFXBypassedState)
        {
            if (fxIndex == index)
                continue;
            updatedBypass[fxIndex > index ? fxIndex - 1 : fxIndex] = bypassed;
        }
        trackFXForceFloatOverrides = std::move(updatedOverrides);
        trackFXBypassedState = std::move(updatedBypass);
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Removed Track FX at index " + juce::String(index));
    }
}

void TrackProcessor::bypassInputFX(int index, bool bypassed)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (index >= 0 && index < (int)inputFXPlugins.size())
    {
        if (bypassed)
            inputFXBypassedState[index] = true;
        else
            inputFXBypassedState.erase(index);
    }

    publishRealtimeStateSnapshots();
}

void TrackProcessor::bypassTrackFX(int index, bool bypassed)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (index >= 0 && index < (int)trackFXPlugins.size())
    {
        if (bypassed)
            trackFXBypassedState[index] = true;
        else
            trackFXBypassedState.erase(index);
    }

    publishRealtimeStateSnapshots();
}

int TrackProcessor::getNumInputFX() const
{
    return (int)inputFXPlugins.size();
}

int TrackProcessor::getNumTrackFX() const
{
    return (int)trackFXPlugins.size();
}

int TrackProcessor::getNumSends() const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    return snapshot != nullptr ? static_cast<int>(snapshot->size()) : 0;
}

juce::AudioProcessor* TrackProcessor::getInputFXProcessor(int index)
{
    if (index >= 0 && index < (int)inputFXPlugins.size())
        return inputFXPlugins[index].get();
    return nullptr;
}

juce::AudioProcessor* TrackProcessor::getTrackFXProcessor(int index)
{
    if (index >= 0 && index < (int)trackFXPlugins.size())
        return trackFXPlugins[index].get();
    return nullptr;
}

std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> TrackProcessor::getInputFXSnapshot() const
{
    return std::atomic_load_explicit(&realtimeInputFXSnapshot, std::memory_order_acquire);
}

std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> TrackProcessor::getTrackFXSnapshot() const
{
    return std::atomic_load_explicit(&realtimeTrackFXSnapshot, std::memory_order_acquire);
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getInputFXBypassSnapshot() const
{
    return std::atomic_load_explicit(&realtimeInputFXBypassSnapshot, std::memory_order_acquire);
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getTrackFXBypassSnapshot() const
{
    return std::atomic_load_explicit(&realtimeTrackFXBypassSnapshot, std::memory_order_acquire);
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getInputFXPrecisionOverrideSnapshot() const
{
    return std::atomic_load_explicit(&realtimeInputFXPrecisionOverrideSnapshot, std::memory_order_acquire);
}

std::shared_ptr<const std::map<int, bool>> TrackProcessor::getTrackFXPrecisionOverrideSnapshot() const
{
    return std::atomic_load_explicit(&realtimeTrackFXPrecisionOverrideSnapshot, std::memory_order_acquire);
}

bool TrackProcessor::reorderInputFX(int fromIndex, int toIndex)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (fromIndex < 0 || fromIndex >= (int)inputFXPlugins.size() ||
        toIndex < 0 || toIndex >= (int)inputFXPlugins.size() ||
        fromIndex == toIndex)
        return false;

    auto plugin = std::move(inputFXPlugins[fromIndex]);
    inputFXPlugins.erase(inputFXPlugins.begin() + fromIndex);
    inputFXPlugins.insert(inputFXPlugins.begin() + toIndex, std::move(plugin));
    std::map<int, bool> updatedOverrides;
    std::map<int, bool> updatedBypass;
    for (const auto& [fxIndex, forceFloat] : inputFXForceFloatOverrides)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedOverrides[newIndex] = forceFloat;
    }
    for (const auto& [fxIndex, bypassed] : inputFXBypassedState)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedBypass[newIndex] = bypassed;
    }
    inputFXForceFloatOverrides = std::move(updatedOverrides);
    inputFXBypassedState = std::move(updatedBypass);
    publishRealtimeStateSnapshots();

    juce::Logger::writeToLog("TrackProcessor: Reordered input FX from " +
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
}

bool TrackProcessor::reorderTrackFX(int fromIndex, int toIndex)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (fromIndex < 0 || fromIndex >= (int)trackFXPlugins.size() ||
        toIndex < 0 || toIndex >= (int)trackFXPlugins.size() ||
        fromIndex == toIndex)
        return false;

    auto plugin = std::move(trackFXPlugins[fromIndex]);
    trackFXPlugins.erase(trackFXPlugins.begin() + fromIndex);
    trackFXPlugins.insert(trackFXPlugins.begin() + toIndex, std::move(plugin));
    std::map<int, bool> updatedOverrides;
    std::map<int, bool> updatedBypass;
    for (const auto& [fxIndex, forceFloat] : trackFXForceFloatOverrides)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedOverrides[newIndex] = forceFloat;
    }
    for (const auto& [fxIndex, bypassed] : trackFXBypassedState)
    {
        int newIndex = fxIndex;
        if (fxIndex == fromIndex)
            newIndex = toIndex;
        else if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex)
            newIndex = fxIndex - 1;
        else if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex)
            newIndex = fxIndex + 1;
        updatedBypass[newIndex] = bypassed;
    }
    trackFXForceFloatOverrides = std::move(updatedOverrides);
    trackFXBypassedState = std::move(updatedBypass);
    if (araFXIndex == fromIndex)
        araFXIndex = toIndex;
    else if (fromIndex < toIndex && araFXIndex > fromIndex && araFXIndex <= toIndex)
        --araFXIndex;
    else if (fromIndex > toIndex && araFXIndex >= toIndex && araFXIndex < fromIndex)
        ++araFXIndex;
    publishRealtimeStateSnapshots();

    juce::Logger::writeToLog("TrackProcessor: Reordered track FX from " +
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
}

//==============================================================================
// Sidechain Routing (Phase 4.4)

void TrackProcessor::setSidechainSource(int pluginIndex, const juce::String& sourceTrackId)
{
    sidechainSources[pluginIndex] = sourceTrackId;
    publishRealtimeStateSnapshots();
    juce::Logger::writeToLog("TrackProcessor: Set sidechain source for FX[" +
                             juce::String(pluginIndex) + "] = " + sourceTrackId);
}

void TrackProcessor::clearSidechainSource(int pluginIndex)
{
    sidechainSources.erase(pluginIndex);
    publishRealtimeStateSnapshots();
    juce::Logger::writeToLog("TrackProcessor: Cleared sidechain source for FX[" +
                             juce::String(pluginIndex) + "]");
}

juce::String TrackProcessor::getSidechainSource(int pluginIndex) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSidechainSnapshot, std::memory_order_acquire);
    if (snapshot != nullptr)
    {
        auto it = snapshot->find(pluginIndex);
        if (it != snapshot->end())
            return it->second;
    }
    return {};
}

void TrackProcessor::setSidechainBuffer(const juce::AudioBuffer<float>* buffer)
{
    sidechainInputBuffer = buffer;
}

bool TrackProcessor::hasAnySidechainSources() const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSidechainSnapshot, std::memory_order_acquire);
    return snapshot != nullptr && !snapshot->empty();
}

//==============================================================================
// Send Management (Phase 4 / Phase 11)

int TrackProcessor::addSend(const juce::String& destTrackId)
{
    SendConfig cfg;
    cfg.destTrackId = destTrackId;
    cfg.level = 0.5f;
    cfg.pan = 0.0f;
    cfg.enabled = true;
    cfg.preFader = false;
    sends.push_back(cfg);
    publishRealtimeStateSnapshots();
    juce::Logger::writeToLog("TrackProcessor: Added send to " + destTrackId + " (index " + juce::String(sends.size() - 1) + ")");
    return static_cast<int>(sends.size()) - 1;
}

void TrackProcessor::removeSend(int sendIndex)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends.erase(sends.begin() + sendIndex);
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Removed send at index " + juce::String(sendIndex));
    }
}

void TrackProcessor::setSendLevel(int sendIndex, float level)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].level = juce::jlimit(0.0f, 1.0f, level);
        publishRealtimeStateSnapshots();
    }
}

void TrackProcessor::setSendPan(int sendIndex, float pan)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].pan = juce::jlimit(-1.0f, 1.0f, pan);
        publishRealtimeStateSnapshots();
    }
}

void TrackProcessor::setSendEnabled(int sendIndex, bool enabled)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].enabled = enabled;
        publishRealtimeStateSnapshots();
    }
}

void TrackProcessor::setSendPreFader(int sendIndex, bool preFader)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].preFader = preFader;
        publishRealtimeStateSnapshots();
    }
}

juce::String TrackProcessor::getSendDestination(int sendIndex) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    if (snapshot != nullptr && sendIndex >= 0 && sendIndex < (int)snapshot->size())
        return (*snapshot)[sendIndex].destTrackId;
    return {};
}

float TrackProcessor::getSendLevel(int sendIndex) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    if (snapshot != nullptr && sendIndex >= 0 && sendIndex < (int)snapshot->size())
        return (*snapshot)[sendIndex].level;
    return 0.0f;
}

float TrackProcessor::getSendPan(int sendIndex) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    if (snapshot != nullptr && sendIndex >= 0 && sendIndex < (int)snapshot->size())
        return (*snapshot)[sendIndex].pan;
    return 0.0f;
}

bool TrackProcessor::getSendEnabled(int sendIndex) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    if (snapshot != nullptr && sendIndex >= 0 && sendIndex < (int)snapshot->size())
        return (*snapshot)[sendIndex].enabled;
    return false;
}

bool TrackProcessor::getSendPreFader(int sendIndex) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    if (snapshot != nullptr && sendIndex >= 0 && sendIndex < (int)snapshot->size())
        return (*snapshot)[sendIndex].preFader;
    return false;
}

void TrackProcessor::fillSendBuffer(int sendIndex, const juce::AudioBuffer<float>& preFaderBuf,
                                    const juce::AudioBuffer<float>& postFaderBuf,
                                    juce::AudioBuffer<float>& destBuffer, int numSamples) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    if (snapshot == nullptr || sendIndex < 0 || sendIndex >= (int)snapshot->size()) return;
    const auto& send = (*snapshot)[sendIndex];
    if (!send.enabled || send.level <= 0.0f) return;

    const auto& srcBuf = send.preFader ? preFaderBuf : postFaderBuf;
    const int srcChannels = srcBuf.getNumChannels();
    const int destChannels = destBuffer.getNumChannels();

    // Apply send level, pan, and optional phase invert, mix into dest
    const float level = send.level;
    const float phaseMultiplier = send.phaseInvert ? -1.0f : 1.0f;
    const float pi = juce::MathConstants<float>::pi;
    float panAngle = (send.pan + 1.0f) * pi / 4.0f;
    float leftGain = std::cos(panAngle) * level * phaseMultiplier;
    float rightGain = std::sin(panAngle) * level * phaseMultiplier;

    if (destChannels >= 2 && srcChannels >= 2)
    {
        for (int s = 0; s < numSamples; ++s)
        {
            destBuffer.getWritePointer(0)[s] += srcBuf.getReadPointer(0)[s] * leftGain;
            destBuffer.getWritePointer(1)[s] += srcBuf.getReadPointer(1)[s] * rightGain;
        }
    }
    else if (destChannels >= 1 && srcChannels >= 1)
    {
        for (int s = 0; s < numSamples; ++s)
            destBuffer.getWritePointer(0)[s] += srcBuf.getReadPointer(0)[s] * level;
    }
}

//==============================================================================
// MIDI & Instrument (Phase 2)

void TrackProcessor::setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin,
                                   double callerSampleRate, int callerBlockSize)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (plugin)
    {
        double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
        int bs = callerBlockSize > 0 ? callerBlockSize : getBlockSize();
        if (sr <= 0) sr = 44100.0;
        if (bs <= 0) bs = 512;

        preparePluginPreservingLayout(plugin.get(), sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode,
                                                                 instrumentForceFloatOverride.load(std::memory_order_acquire)));
        instrumentPlugin = std::shared_ptr<juce::AudioPluginInstance>(std::move(plugin));
        publishRealtimeStateSnapshots();
        juce::Logger::writeToLog("TrackProcessor: Instrument plugin loaded");
    }
}

bool TrackProcessor::enqueueMidiMessage(const juce::MidiMessage& message, int sampleOffset)
{
    int writeIndex = midiQueueWriteIndex.load(std::memory_order_relaxed);
    const int nextIndex = (writeIndex + 1) % MIDI_QUEUE_CAPACITY;
    const int readIndex = midiQueueReadIndex.load(std::memory_order_acquire);

    if (nextIndex == readIndex)
    {
        midiQueueOverflowCount.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    pendingMidiQueue[static_cast<size_t>(writeIndex)].message = message;
    pendingMidiQueue[static_cast<size_t>(writeIndex)].sampleOffset = sampleOffset;
    midiQueueWriteIndex.store(nextIndex, std::memory_order_release);
    return true;
}

void TrackProcessor::setScheduledMIDIClips(std::vector<ScheduledMIDIClip> clips)
{
    auto sharedClips = std::make_shared<const std::vector<ScheduledMIDIClip>>(std::move(clips));
    std::atomic_store_explicit(&scheduledMIDIClips, sharedClips, std::memory_order_release);
}

void TrackProcessor::markActiveMIDINoteState(const juce::MidiMessage& message)
{
    if (message.getChannel() <= 0)
        return;

    const int channelIndex = juce::jlimit(0, 15, message.getChannel() - 1);

    if (message.isNoteOn())
    {
        activeMIDINotes[static_cast<size_t>(channelIndex)][static_cast<size_t>(message.getNoteNumber())] = true;
    }
    else if (message.isNoteOff())
    {
        activeMIDINotes[static_cast<size_t>(channelIndex)][static_cast<size_t>(message.getNoteNumber())] = false;
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& noteActive : activeMIDINotes[static_cast<size_t>(channelIndex)])
            noteActive = false;
    }
}

void TrackProcessor::appendScheduledMIDIToBuffer(juce::MidiBuffer& destination,
                                                 double blockStartTimeSeconds,
                                                 int numSamples, double sampleRate) const
{
    auto clips = std::atomic_load_explicit(&scheduledMIDIClips, std::memory_order_acquire);
    if (!clips || clips->empty() || sampleRate <= 0.0)
        return;

    const double blockEndTimeSeconds = blockStartTimeSeconds + (static_cast<double>(numSamples) / sampleRate);

    for (const auto& clip : *clips)
    {
        if (clip.events.empty())
            continue;

        const double clipEndTime = clip.startTime + clip.duration;
        if (clipEndTime <= blockStartTimeSeconds || clip.startTime >= blockEndTimeSeconds)
            continue;

        for (const auto& event : clip.events)
        {
            const double absoluteEventTime = clip.startTime + event.timestampSeconds;
            if (absoluteEventTime < blockStartTimeSeconds || absoluteEventTime >= blockEndTimeSeconds)
                continue;

            int sampleOffset = static_cast<int>(std::floor((absoluteEventTime - blockStartTimeSeconds) * sampleRate));
            sampleOffset = juce::jlimit(0, juce::jmax(0, numSamples - 1), sampleOffset);
            destination.addEvent(event.message, sampleOffset);
        }
    }
}

void TrackProcessor::appendQueuedMIDIToBuffer(juce::MidiBuffer& destination, int numSamples)
{
    int readIndex = midiQueueReadIndex.load(std::memory_order_relaxed);
    const int writeIndex = midiQueueWriteIndex.load(std::memory_order_acquire);

    while (readIndex != writeIndex)
    {
        auto& queuedEvent = pendingMidiQueue[static_cast<size_t>(readIndex)];
        int sampleOffset = juce::jlimit(0, juce::jmax(0, numSamples - 1), queuedEvent.sampleOffset);
        destination.addEvent(queuedEvent.message, sampleOffset);

        readIndex = (readIndex + 1) % MIDI_QUEUE_CAPACITY;
        midiQueueReadIndex.store(readIndex, std::memory_order_release);
    }
}

bool TrackProcessor::hasQueuedMIDI() const
{
    return midiQueueReadIndex.load(std::memory_order_acquire) != midiQueueWriteIndex.load(std::memory_order_acquire);
}

bool TrackProcessor::hasScheduledMIDIInBlock(double blockStartTimeSeconds, int numSamples, double sampleRate) const
{
    auto clips = std::atomic_load_explicit(&scheduledMIDIClips, std::memory_order_acquire);
    if (!clips || clips->empty() || sampleRate <= 0.0)
        return false;

    const double blockEndTimeSeconds = blockStartTimeSeconds + (static_cast<double>(numSamples) / sampleRate);
    for (const auto& clip : *clips)
    {
        if (clip.events.empty())
            continue;

        const double clipEndTime = clip.startTime + clip.duration;
        if (clipEndTime <= blockStartTimeSeconds || clip.startTime >= blockEndTimeSeconds)
            continue;

        for (const auto& event : clip.events)
        {
            const double absoluteEventTime = clip.startTime + event.timestampSeconds;
            if (absoluteEventTime >= blockStartTimeSeconds && absoluteEventTime < blockEndTimeSeconds)
                return true;
        }
    }

    return false;
}

void TrackProcessor::buildMidiBuffer(juce::MidiBuffer& destination, double blockStartTimeSeconds,
                                     int numSamples, double sampleRate, bool playing)
{
    destination.clear();

    if (playing)
        appendScheduledMIDIToBuffer(destination, blockStartTimeSeconds, numSamples, sampleRate);

    appendQueuedMIDIToBuffer(destination, numSamples);

    lastBuiltMidiEventCount.store(destination.getNumEvents(), std::memory_order_relaxed);
    int prevMax = maxBuiltMidiEventCount.load(std::memory_order_relaxed);
    while (destination.getNumEvents() > prevMax
           && !maxBuiltMidiEventCount.compare_exchange_weak(prevMax, destination.getNumEvents(),
                                                            std::memory_order_relaxed))
    {
    }

    for (const auto metadata : destination)
        markActiveMIDINoteState(metadata.getMessage());
}

bool TrackProcessor::needsProcessing(double blockStartTimeSeconds, int numSamples,
                                     double sampleRate, bool playing) const
{
    // Instrument tracks must always be processed so they can respond to
    // live MIDI input and produce sustain / reverb tails after note-off.
    if (trackType.load(std::memory_order_acquire) == TrackType::Instrument
        && std::atomic_load_explicit(&realtimeInstrumentSnapshot, std::memory_order_acquire) != nullptr)
        return true;

    if (hasQueuedMIDI())
        return true;

    if (playing && hasScheduledMIDIInBlock(blockStartTimeSeconds, numSamples, sampleRate))
        return true;

    return false;
}

void TrackProcessor::queueAllNotesOff()
{
    for (size_t channel = 0; channel < activeMIDINotes.size(); ++channel)
    {
        for (size_t note = 0; note < activeMIDINotes[channel].size(); ++note)
        {
            if (!activeMIDINotes[channel][note])
                continue;

            enqueueMidiMessage(juce::MidiMessage::noteOff(static_cast<int>(channel) + 1,
                                                          static_cast<int>(note)));
            activeMIDINotes[channel][note] = false;
        }

        enqueueMidiMessage(juce::MidiMessage::allNotesOff(static_cast<int>(channel) + 1));
    }
}

std::vector<juce::String> TrackProcessor::getSidechainSourceSnapshot() const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSidechainSnapshot, std::memory_order_acquire);
    std::vector<juce::String> sourceIds;
    if (snapshot == nullptr)
        return sourceIds;

    sourceIds.reserve(snapshot->size());
    for (const auto& entry : *snapshot)
    {
        if (entry.second.isNotEmpty())
            sourceIds.push_back(entry.second);
    }
    return sourceIds;
}

std::vector<TrackProcessor::RealtimeSendInfo> TrackProcessor::getRealtimeSendSnapshot() const
{
    auto snapshotData = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    std::vector<RealtimeSendInfo> snapshot;
    if (snapshotData == nullptr)
        return snapshot;

    snapshot.reserve(snapshotData->size());
    for (const auto& send : *snapshotData)
    {
        RealtimeSendInfo info;
        info.destTrackId = send.destTrackId;
        info.level = send.level;
        info.pan = send.pan;
        info.enabled = send.enabled;
        info.preFader = send.preFader;
        info.phaseInvert = send.phaseInvert;
        snapshot.push_back(std::move(info));
    }
    return snapshot;
}

void TrackProcessor::setInputFXPrecisionOverride(int index, bool forceFloat)
{
    const juce::ScopedLock callbackGuard(getCallbackLock());
    if (index < 0 || index >= static_cast<int>(inputFXPlugins.size()))
        return;

    inputFXForceFloatOverrides[index] = forceFloat;
    if (auto* plugin = inputFXPlugins[static_cast<size_t>(index)].get())
    {
        double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
        int bs = getBlockSize() > 0 ? getBlockSize() : 512;
        preparePluginPreservingLayout(plugin, sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode, forceFloat));
    }
    publishRealtimeStateSnapshots();
}

void TrackProcessor::setTrackFXPrecisionOverride(int index, bool forceFloat)
{
    const juce::ScopedLock callbackGuard(getCallbackLock());
    if (index < 0 || index >= static_cast<int>(trackFXPlugins.size()))
        return;

    trackFXForceFloatOverrides[index] = forceFloat;
    if (auto* plugin = trackFXPlugins[static_cast<size_t>(index)].get())
    {
        double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
        int bs = getBlockSize() > 0 ? getBlockSize() : 512;
        preparePluginPreservingLayout(plugin, sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode, forceFloat));
    }
    publishRealtimeStateSnapshots();
}

void TrackProcessor::setInstrumentPrecisionOverride(bool forceFloat)
{
    const juce::ScopedLock callbackGuard(getCallbackLock());
    instrumentForceFloatOverride.store(forceFloat, std::memory_order_release);
    if (instrumentPlugin)
    {
        double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
        int bs = getBlockSize() > 0 ? getBlockSize() : 512;
        preparePluginPreservingLayout(instrumentPlugin.get(), sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode, forceFloat));
    }
}

bool TrackProcessor::getInputFXPrecisionOverride(int index) const
{
    auto it = inputFXForceFloatOverrides.find(index);
    return it != inputFXForceFloatOverrides.end() && it->second;
}

bool TrackProcessor::getTrackFXPrecisionOverride(int index) const
{
    auto it = trackFXForceFloatOverrides.find(index);
    return it != trackFXForceFloatOverrides.end() && it->second;
}

bool TrackProcessor::getInputFXBypassed(int index) const
{
    auto it = inputFXBypassedState.find(index);
    return it != inputFXBypassedState.end() && it->second;
}

bool TrackProcessor::getTrackFXBypassed(int index) const
{
    auto it = trackFXBypassedState.find(index);
    return it != trackFXBypassedState.end() && it->second;
}

void TrackProcessor::setProcessingPrecisionMode(ProcessingPrecisionMode mode)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (processingPrecisionMode == mode)
        return;

    processingPrecisionMode = mode;

    double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
    int bs = getBlockSize() > 0 ? getBlockSize() : 512;

    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
        if (auto* plugin = inputFXPlugins[static_cast<size_t>(index)].get())
            preparePluginPreservingLayout(plugin, sr, bs,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getInputFXPrecisionOverride(index)));

    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
        if (auto* plugin = trackFXPlugins[static_cast<size_t>(index)].get())
            preparePluginPreservingLayout(plugin, sr, bs,
                                          resolvePluginPrecisionMode(processingPrecisionMode,
                                                                     getTrackFXPrecisionOverride(index)));

    if (instrumentPlugin)
        preparePluginPreservingLayout(instrumentPlugin.get(), sr, bs,
                                      resolvePluginPrecisionMode(processingPrecisionMode,
                                                                 instrumentForceFloatOverride.load(std::memory_order_acquire)));
}

//==============================================================================
// Plugin Delay Compensation (PDC)

int TrackProcessor::getChainLatency() const
{
    int totalLatency = 0;
    for (int index = 0; index < static_cast<int>(inputFXPlugins.size()); ++index)
    {
        const auto& plugin = inputFXPlugins[static_cast<size_t>(index)];
        if (plugin && !getInputFXBypassed(index))
            totalLatency += plugin->getLatencySamples();
    }
    for (int index = 0; index < static_cast<int>(trackFXPlugins.size()); ++index)
    {
        const auto& plugin = trackFXPlugins[static_cast<size_t>(index)];
        if (plugin && !getTrackFXBypassed(index))
            totalLatency += plugin->getLatencySamples();
    }
    return totalLatency;
}

void TrackProcessor::setPDCDelay(int delaySamples)
{
    pdcDelaySamples.store(delaySamples, std::memory_order_relaxed);
    pdcDelayDirty.store(true, std::memory_order_release);
}

void TrackProcessor::setChannelStripEQParam(int paramIndex, float value)
{
    const auto& params = channelStripEQ.getParameters();
    if (paramIndex >= 0 && paramIndex < params.size())
    {
        auto* p = dynamic_cast<juce::RangedAudioParameter*>(params[paramIndex]);
        if (p != nullptr)
            p->setValueNotifyingHost(p->convertTo0to1(value));
    }
}

float TrackProcessor::getChannelStripEQParam(int paramIndex) const
{
    const auto& params = channelStripEQ.getParameters();
    if (paramIndex >= 0 && paramIndex < params.size())
    {
        auto* p = dynamic_cast<juce::RangedAudioParameter*>(params[paramIndex]);
        if (p != nullptr)
            return p->convertFrom0to1(p->getValue());
    }
    return 0.0f;
}

//==============================================================================
// Send Phase Invert

void TrackProcessor::setSendPhaseInvert(int sendIndex, bool invert)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].phaseInvert = invert;
        publishRealtimeStateSnapshots();
    }
}

bool TrackProcessor::getSendPhaseInvert(int sendIndex) const
{
    auto snapshot = std::atomic_load_explicit(&realtimeSendSnapshot, std::memory_order_acquire);
    if (snapshot != nullptr && sendIndex >= 0 && sendIndex < (int)snapshot->size())
        return (*snapshot)[sendIndex].phaseInvert;
    return false;
}

//==============================================================================
// Output Channel Routing

void TrackProcessor::setOutputChannels(int startChannel, int numChannels)
{
    outputStartChannel.store(juce::jmax(0, startChannel), std::memory_order_release);
    outputChannelCount.store(juce::jlimit(1, 8, numChannels), std::memory_order_release);
}

//==============================================================================
// Per-track MIDI Output

void TrackProcessor::setMIDIOutputDevice(const juce::String& deviceName)
{
    const juce::ScopedLock callbackLock(getCallbackLock());
    if (deviceName == midiOutputDeviceName)
        return;

    midiOutputDeviceName = deviceName;
    midiOutputDevice.reset();

    if (deviceName.isNotEmpty())
    {
        for (const auto& d : juce::MidiOutput::getAvailableDevices())
        {
            if (d.name == deviceName)
            {
                midiOutputDevice = juce::MidiOutput::openDevice(d.identifier);
                if (midiOutputDevice)
                    juce::Logger::writeToLog("TrackProcessor: MIDI output connected: " + deviceName);
                break;
            }
        }
    }
}

void TrackProcessor::sendMIDIToOutput(const juce::MidiBuffer& buffer)
{
    if (midiOutputDevice == nullptr || buffer.isEmpty())
        return;

    for (const auto metadata : buffer)
        midiOutputDevice->sendMessageNow(metadata.getMessage());
}

// =============================================================================
// ARA Plugin Hosting (Phase 9)
// =============================================================================

bool TrackProcessor::initializeARA(int fxIndex, double sampleRate, int araBlockSize,
                                    std::function<void(bool, bool, const juce::String&)> onComplete)
{
#if S13_HAS_ARA
    if (fxIndex < 0 || fxIndex >= static_cast<int>(trackFXPlugins.size()))
    {
        updateARAAttemptStatus(fxIndex, true, false, false, "Invalid FX index.");
        if (onComplete) onComplete(false, false, "Invalid FX index.");
        return false;
    }

    auto* plugin = dynamic_cast<juce::AudioPluginInstance*>(trackFXPlugins[static_cast<size_t>(fxIndex)].get());
    if (!plugin)
    {
        juce::Logger::writeToLog("TrackProcessor::initializeARA: Plugin at index "
            + juce::String(fxIndex) + " is not an AudioPluginInstance.");
        updateARAAttemptStatus(fxIndex, true, false, false, "Plugin is not an AudioPluginInstance.");
        if (onComplete) onComplete(false, false, "Plugin is not an AudioPluginInstance.");
        return false;
    }

    updateARAAttemptStatus(fxIndex, false, false, false, {});

    if (araController && araController->isActive())
    {
        if (araFXIndex == fxIndex)
        {
            updateARAAttemptStatus(fxIndex, true, true, true, {});
            if (onComplete) onComplete(true, true, {});
            return true;
        }

        juce::createARAFactoryAsync(*plugin, [this, fxIndex, onComplete] (juce::ARAFactoryWrapper factory)
        {
            if (!factory.get())
            {
                updateARAAttemptStatus(fxIndex, true, false, false, {});
                if (onComplete) onComplete(false, false, {});
                return;
            }

            juce::String errorMessage = "Another ARA plugin is already active on this track.";
            updateARAAttemptStatus(fxIndex, true, true, false, errorMessage);
            if (onComplete) onComplete(false, true, errorMessage);
        });
        return true;
    }

    shutdownARA();

    araController = std::make_unique<ARAHostController>();
    araController->setPlaybackRequestHandlers(araPlaybackRequestHandlers);

    araFXIndex = fxIndex;
    araController->initializeForPlugin(plugin, sampleRate, araBlockSize,
        [this, fxIndex, onComplete] (bool success, bool pluginSupportsARA, const juce::String& errorMessage) {
            if (success)
            {
                juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA initialized at FX index "
                    + juce::String(fxIndex));
                updateARAAttemptStatus(fxIndex, true, true, true, {});
            }
            else
            {
                juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA initialization failed for FX index "
                    + juce::String(fxIndex));
                updateARAAttemptStatus(fxIndex, true, pluginSupportsARA, false, errorMessage);
                araController.reset();
                araFXIndex = -1;
            }
            if (onComplete) onComplete(success, pluginSupportsARA, errorMessage);
        });

    return true;
#else
    juce::ignoreUnused(fxIndex, sampleRate, araBlockSize, onComplete);
    juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA support not compiled in.");
    updateARAAttemptStatus(fxIndex, true, false, false, "ARA support not compiled in.");
    if (onComplete) onComplete(false, false, "ARA support not compiled in.");
    return false;
#endif
}

void TrackProcessor::setARAPlaybackRequestHandlers(ARAHostController::PlaybackRequestHandlers handlers)
{
    araPlaybackRequestHandlers = std::move(handlers);
    if (araController)
        araController->setPlaybackRequestHandlers(araPlaybackRequestHandlers);
}

void TrackProcessor::setCurrentAudioCallbackDebugInfo(const ARAProcessDebugInfo& info)
{
    currentARAProcessDebugInfo = info;
}

void TrackProcessor::noteARATransportPlaybackStateChanged(const juce::String& trackId, bool playing, double positionSeconds,
                                                          bool editorFocusedAtPlayStart)
{
    araDebugTrackId = trackId;
    araTransportPlayingDebugState.store(playing, std::memory_order_release);

    if (!araController || !araController->isActive())
        return;

    araController->updateTransportDebugState(playing, positionSeconds);

    if (playing)
    {
        araEditorFocusedAtPlaybackStart.store(editorFocusedAtPlayStart, std::memory_order_release);
        const auto snapshotBeforeStart = araController->getDebugSnapshot();
        const uint64 playbackRun = araPlaybackRunCounter.fetch_add(1, std::memory_order_acq_rel) + 1;
        araStructuredPlaySessionLogged.store(true, std::memory_order_release);
        if (kEnableARADebugDiagnostics)
        {
            logToDisk("ARA session start: trackId=" + trackId
                + " fxIndex=" + juce::String(araFXIndex)
                + " plugin=" + juce::String((araFXIndex >= 0 && araFXIndex < static_cast<int>(trackFXPlugins.size()) && trackFXPlugins[static_cast<size_t>(araFXIndex)] != nullptr)
                    ? trackFXPlugins[static_cast<size_t>(araFXIndex)]->getName() : juce::String("<none>"))
                + " playbackRun=" + juce::String(static_cast<juce::int64>(playbackRun))
                + " positionSeconds=" + juce::String(positionSeconds, 3)
                + " pendingEditSinceLastPlay=" + juce::String(snapshotBeforeStart.hasPendingEditSinceLastPlay ? "true" : "false")
                + " lastEditType=" + snapshotBeforeStart.lastEditType
                + " lastOperation=" + snapshotBeforeStart.lastOperation
                + " lastClipId=" + snapshotBeforeStart.lastClipId
                + " analysisRequested=" + juce::String(snapshotBeforeStart.analysisRequested ? "true" : "false")
                + " analysisStarted=" + juce::String(snapshotBeforeStart.analysisStarted ? "true" : "false")
                + " analysisProgress=" + juce::String(snapshotBeforeStart.analysisProgress, 3)
                + " analysisComplete=" + juce::String(snapshotBeforeStart.analysisComplete ? "true" : "false")
                + " editorFocusedAtPlayStart=" + juce::String(editorFocusedAtPlayStart ? "true" : "false")
                + " sourceCount=" + juce::String(snapshotBeforeStart.sourceCount)
                + " playbackRegionCount=" + juce::String(snapshotBeforeStart.playbackRegionCount)
                + " playbackRendererAttached=" + juce::String(snapshotBeforeStart.playbackRendererAttached ? "true" : "false")
                + " editorRendererAttached=" + juce::String(snapshotBeforeStart.editorRendererAttached ? "true" : "false")
                + " audioSourceSamplesAccessEnabled=" + juce::String(snapshotBeforeStart.audioSourceSamplesAccessEnabled ? "true" : "false"));
        }

        araController->notePlaybackStart(positionSeconds);
    }
    else
    {
        araEditorFocusedAtPlaybackStart.store(false, std::memory_order_release);
        araController->notePlaybackStop(positionSeconds);
    }
}

float TrackProcessor::getARAAnalysisProgress() const
{
    return araController ? araController->getAnalysisProgress() : 0.0f;
}

bool TrackProcessor::isARAAnalysisComplete() const
{
    return araController ? araController->isAnalysisComplete() : false;
}

ARAHostController::DebugSnapshot TrackProcessor::getARADebugSnapshot() const
{
    return araController ? araController->getDebugSnapshot() : ARAHostController::DebugSnapshot{};
}

juce::String TrackProcessor::getARALastAttemptError() const
{
    const juce::ScopedLock sl(araStatusLock);
    return araLastAttemptError;
}

void TrackProcessor::shutdownARA()
{
#if S13_HAS_ARA
    if (araController)
    {
        araController->shutdown();
        araController.reset();
        araFXIndex = -1;
    }
#endif
    updateARAAttemptStatus(-1, true, false, false, {});
}

void TrackProcessor::updateARAAttemptStatus(int fxIndex, bool completed, bool wasARAPlugin,
                                            bool succeeded, const juce::String& errorMessage)
{
    araLastAttemptFXIndex.store(fxIndex, std::memory_order_release);
    araLastAttemptComplete.store(completed, std::memory_order_release);
    araLastAttemptWasARAPlugin.store(wasARAPlugin, std::memory_order_release);
    araLastAttemptSucceeded.store(succeeded, std::memory_order_release);
    const juce::ScopedLock sl(araStatusLock);
    araLastAttemptError = errorMessage;
}
