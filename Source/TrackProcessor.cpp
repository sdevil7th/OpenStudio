#include "TrackProcessor.h"

// Debug logging — always active for FX diagnostics
static void logToDisk(const juce::String& msg)
{
    auto f = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
             .getChildFile("Studio13").getChildFile("debug_log.txt");
    f.appendText(juce::Time::getCurrentTime().toString(true, true) + ": " + msg + "\n");
}

TrackProcessor::TrackProcessor()
     : AudioProcessor (BusesProperties()
                       .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
}

TrackProcessor::~TrackProcessor()
{
}

const juce::String TrackProcessor::getName() const
{
    return "Track Processor";
}

bool TrackProcessor::acceptsMidi() const
{
    return trackType == TrackType::MIDI || trackType == TrackType::Instrument;
}

bool TrackProcessor::producesMidi() const
{
    return false;
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
    float volumeGain = juce::Decibels::decibelsToGain(trackVolumeDB);
    float panAngle = (trackPan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;
    cachedPanL.store(std::cos(panAngle) * volumeGain, std::memory_order_relaxed);
    cachedPanR.store(std::sin(panAngle) * volumeGain, std::memory_order_relaxed);
}

void TrackProcessor::setVolume(float newVolume)
{
    trackVolumeDB = juce::jlimit(-60.0f, 6.0f, newVolume);
    recomputePanGains();
}

void TrackProcessor::setPan(float newPan)
{
    trackPan = juce::jlimit(-1.0f, 1.0f, newPan);
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
static void preparePluginPreservingLayout(juce::AudioProcessor* plugin, double sampleRate, int maxBlock)
{
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

void TrackProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    // Pre-allocate FX processing buffer with enough channels for complex plugins.
    // Use the actual device block size here — the buffer just needs to hold one callback.
    fxProcessBuffer.setSize(8, samplesPerBlock);

    // Clamp max-block-size hint to at least 512.  ASIO buffers can be as small as
    // 32 samples; passing that to prepareToPlay forces plugins to resize their internal
    // DSP (FFT, convolution) for tiny blocks, causing crackling/distortion.
    int pluginMaxBlock = juce::jmax(samplesPerBlock, 512);

    // Propagate new sample rate and buffer size to all internal FX plugins,
    // preserving each plugin's bus layout (see preparePluginPreservingLayout).
    for (auto& plugin : inputFXPlugins)
    {
        if (plugin)
        {
            preparePluginPreservingLayout(plugin.get(), sampleRate, pluginMaxBlock);
            plugin->reset();
        }
    }

    for (auto& plugin : trackFXPlugins)
    {
        if (plugin)
        {
            preparePluginPreservingLayout(plugin.get(), sampleRate, pluginMaxBlock);
            plugin->reset();
        }
    }

    // Also re-prepare instrument plugin if loaded
    if (instrumentPlugin)
    {
        preparePluginPreservingLayout(instrumentPlugin.get(), sampleRate, pluginMaxBlock);
        instrumentPlugin->reset();
    }
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
    juce::ScopedNoDenormals noDenormals;
    auto totalNumInputChannels  = getTotalNumInputChannels();
    auto totalNumOutputChannels = getTotalNumOutputChannels();

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

    bool hasAnyFX = !inputFXPlugins.empty() || !trackFXPlugins.empty();

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
        logToDisk("  inputFX count: " + juce::String((int)inputFXPlugins.size()) +
                  " trackFX count: " + juce::String((int)trackFXPlugins.size()));
        logToDisk("  fxProcessBuffer channels: " + juce::String(fxProcessBuffer.getNumChannels()) +
                  " samples: " + juce::String(fxProcessBuffer.getNumSamples()));
        logToDisk("  sampleRate: " + juce::String(getSampleRate()) +
                  " blockSize: " + juce::String(getBlockSize()));

        for (int i = 0; i < (int)inputFXPlugins.size(); ++i)
        {
            auto* proc = inputFXPlugins[i].get();
            if (proc)
            {
                logToDisk("  inputFX[" + juce::String(i) + "]: " + proc->getName() +
                          " inCh=" + juce::String(proc->getTotalNumInputChannels()) +
                          " outCh=" + juce::String(proc->getTotalNumOutputChannels()) +
                          " sr=" + juce::String(proc->getSampleRate()) +
                          " bs=" + juce::String(proc->getBlockSize()));
            }
        }

        for (int i = 0; i < (int)trackFXPlugins.size(); ++i)
        {
            auto* proc = trackFXPlugins[i].get();
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
        if (!trackFXPlugins.empty() && trackFXPlugins[0])
        {
            auto* proc = trackFXPlugins[0].get();
            int pluginChannels = juce::jmax(proc->getTotalNumInputChannels(),
                                             proc->getTotalNumOutputChannels());
            logToDisk("  safeProcessFX: pluginChannels=" + juce::String(pluginChannels) +
                      " bufferChannels=" + juce::String(bufferChannels) +
                      " path=" + juce::String(pluginChannels <= bufferChannels ? "DIRECT" : "EXPANDED"));
        }
    }

    // Channel-safe FX processing helper
    auto safeProcessFX = [&](juce::AudioProcessor* proc)
    {
        int pluginChannels = juce::jmax(proc->getTotalNumInputChannels(),
                                         proc->getTotalNumOutputChannels());

        if (pluginChannels <= bufferChannels)
        {
            proc->processBlock(buffer, midiMessages);
        }
        else
        {
            // Plugin needs more channels — use pre-allocated expanded buffer
            int numSamps = buffer.getNumSamples();
            int expandedCh = juce::jmin(pluginChannels, fxProcessBuffer.getNumChannels());

            for (int ch = 0; ch < expandedCh; ++ch)
            {
                if (ch < bufferChannels)
                    fxProcessBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamps);
                else
                    juce::FloatVectorOperations::clear(fxProcessBuffer.getWritePointer(ch), numSamps);
            }

            float* channelPtrs[8];
            for (int ch = 0; ch < expandedCh; ++ch)
                channelPtrs[ch] = fxProcessBuffer.getWritePointer(ch);

            juce::AudioBuffer<float> pluginBuffer(channelPtrs, expandedCh, numSamps);
            proc->processBlock(pluginBuffer, midiMessages);

            for (int ch = 0; ch < bufferChannels; ++ch)
                buffer.copyFrom(ch, 0, pluginBuffer, ch, 0, numSamps);
        }
    };

    // Process through input FX chain
    for (auto& plugin : inputFXPlugins)
    {
        if (plugin)
            safeProcessFX(plugin.get());
    }

    // Process through track FX chain
    for (auto& plugin : trackFXPlugins)
    {
        if (plugin)
            safeProcessFX(plugin.get());
    }

    // Load pre-computed pan+volume gains (set from message thread, no trig on audio thread)
    float leftGain  = cachedPanL.load(std::memory_order_relaxed);
    float rightGain = cachedPanR.load(std::memory_order_relaxed);

    // Apply gains to channels
    if (bufferChannels >= 1)
        buffer.applyGain(0, 0, buffer.getNumSamples(), leftGain);
    if (bufferChannels >= 2)
        buffer.applyGain(1, 0, buffer.getNumSamples(), rightGain);

    // ---- REAPER-style peak metering with decimation ----
    // getMagnitude() uses FloatVectorOperations::findMinAndMax (SIMD, no sqrt),
    // which is much cheaper than getRMSLevel() (which computes sqrt per channel).
    // We accumulate the running peak over METER_UPDATE_SAMPLES then commit it
    // to currentRMS. At 32-sample ASIO blocks this fires ~86 times/sec instead
    // of 1378 times/sec — a 16× reduction in per-track metering overhead.
    float peak = 0.0f;
    for (int ch = 0; ch < bufferChannels; ++ch)
        peak = juce::jmax (peak, buffer.getMagnitude (ch, 0, buffer.getNumSamples()));

    meterPeakAccum   = juce::jmax (meterPeakAccum, peak);
    meterSampleCount += buffer.getNumSamples();
    if (meterSampleCount >= METER_UPDATE_SAMPLES)
    {
        currentRMS.store (meterPeakAccum, std::memory_order_relaxed);
        meterPeakAccum   = 0.0f;
        meterSampleCount = 0;
    }
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
    inputStartChannel = startChannel;
    inputChannelCount = numChannels;
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
    // then to 44100 as last resort.  Clamp max-block to at least 512.
    double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
    int bs = callerBlockSize > 0 ? callerBlockSize : getBlockSize();
    if (sr <= 0) sr = 44100.0;
    if (bs <= 0) bs = 512;
    bs = juce::jmax(bs, 512);

    // Prepare while preserving bus layout (see preparePluginPreservingLayout).
    preparePluginPreservingLayout(plugin.get(), sr, bs);

    juce::Logger::writeToLog("TrackProcessor: Added Input FX plugin (" + plugin->getName() +
                             ") prepared at " + juce::String(sr) + "Hz / " + juce::String(bs) + " samples" +
                             " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                             " outCh=" + juce::String(plugin->getTotalNumOutputChannels()));

    inputFXPlugins.push_back(std::move(plugin));
    return true;
}

bool TrackProcessor::addTrackFX(std::unique_ptr<juce::AudioProcessor> plugin, double callerSampleRate, int callerBlockSize)
{
    if (!plugin)
        return false;

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
    // then to 44100 as last resort.  Clamp max-block to at least 512.
    double sr = callerSampleRate > 0 ? callerSampleRate : getSampleRate();
    int bs = callerBlockSize > 0 ? callerBlockSize : getBlockSize();
    if (sr <= 0) sr = 44100.0;
    if (bs <= 0) bs = 512;
    bs = juce::jmax(bs, 512);

    // Prepare while preserving bus layout (see preparePluginPreservingLayout).
    preparePluginPreservingLayout(plugin.get(), sr, bs);

    juce::Logger::writeToLog("TrackProcessor: Added Track FX plugin (" + plugin->getName() +
                             ") prepared at " + juce::String(sr) + "Hz / " + juce::String(bs) + " samples" +
                             " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                             " outCh=" + juce::String(plugin->getTotalNumOutputChannels()));

    trackFXPlugins.push_back(std::move(plugin));
    return true;
}

void TrackProcessor::removeInputFX(int index)
{
    if (index >= 0 && index < (int)inputFXPlugins.size())
    {
        inputFXPlugins.erase(inputFXPlugins.begin() + index);
        juce::Logger::writeToLog("TrackProcessor: Removed Input FX at index " + juce::String(index));
    }
}

void TrackProcessor::removeTrackFX(int index)
{
    if (index >= 0 && index < (int)trackFXPlugins.size())
    {
        trackFXPlugins.erase(trackFXPlugins.begin() + index);
        juce::Logger::writeToLog("TrackProcessor: Removed Track FX at index " + juce::String(index));
    }
}

void TrackProcessor::bypassInputFX(int index, bool bypassed)
{
    if (index >= 0 && index < (int)inputFXPlugins.size())
    {
        if (inputFXPlugins[index])
            inputFXPlugins[index]->suspendProcessing(bypassed);
    }
}

void TrackProcessor::bypassTrackFX(int index, bool bypassed)
{
    if (index >= 0 && index < (int)trackFXPlugins.size())
    {
        if (trackFXPlugins[index])
            trackFXPlugins[index]->suspendProcessing(bypassed);
    }
}

int TrackProcessor::getNumInputFX() const
{
    return (int)inputFXPlugins.size();
}

int TrackProcessor::getNumTrackFX() const
{
    return (int)trackFXPlugins.size();
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

bool TrackProcessor::reorderInputFX(int fromIndex, int toIndex)
{
    if (fromIndex < 0 || fromIndex >= (int)inputFXPlugins.size() ||
        toIndex < 0 || toIndex >= (int)inputFXPlugins.size() ||
        fromIndex == toIndex)
        return false;

    auto plugin = std::move(inputFXPlugins[fromIndex]);
    inputFXPlugins.erase(inputFXPlugins.begin() + fromIndex);
    inputFXPlugins.insert(inputFXPlugins.begin() + toIndex, std::move(plugin));

    juce::Logger::writeToLog("TrackProcessor: Reordered input FX from " +
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
}

bool TrackProcessor::reorderTrackFX(int fromIndex, int toIndex)
{
    if (fromIndex < 0 || fromIndex >= (int)trackFXPlugins.size() ||
        toIndex < 0 || toIndex >= (int)trackFXPlugins.size() ||
        fromIndex == toIndex)
        return false;

    auto plugin = std::move(trackFXPlugins[fromIndex]);
    trackFXPlugins.erase(trackFXPlugins.begin() + fromIndex);
    trackFXPlugins.insert(trackFXPlugins.begin() + toIndex, std::move(plugin));

    juce::Logger::writeToLog("TrackProcessor: Reordered track FX from " +
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
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
    juce::Logger::writeToLog("TrackProcessor: Added send to " + destTrackId + " (index " + juce::String(sends.size() - 1) + ")");
    return static_cast<int>(sends.size()) - 1;
}

void TrackProcessor::removeSend(int sendIndex)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends.erase(sends.begin() + sendIndex);
        juce::Logger::writeToLog("TrackProcessor: Removed send at index " + juce::String(sendIndex));
    }
}

void TrackProcessor::setSendLevel(int sendIndex, float level)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].level = juce::jlimit(0.0f, 1.0f, level);
    }
}

void TrackProcessor::setSendPan(int sendIndex, float pan)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].pan = juce::jlimit(-1.0f, 1.0f, pan);
    }
}

void TrackProcessor::setSendEnabled(int sendIndex, bool enabled)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].enabled = enabled;
    }
}

void TrackProcessor::setSendPreFader(int sendIndex, bool preFader)
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
    {
        sends[sendIndex].preFader = preFader;
    }
}

juce::String TrackProcessor::getSendDestination(int sendIndex) const
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
        return sends[sendIndex].destTrackId;
    return {};
}

float TrackProcessor::getSendLevel(int sendIndex) const
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
        return sends[sendIndex].level;
    return 0.0f;
}

float TrackProcessor::getSendPan(int sendIndex) const
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
        return sends[sendIndex].pan;
    return 0.0f;
}

bool TrackProcessor::getSendEnabled(int sendIndex) const
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
        return sends[sendIndex].enabled;
    return false;
}

bool TrackProcessor::getSendPreFader(int sendIndex) const
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
        return sends[sendIndex].preFader;
    return false;
}

void TrackProcessor::fillSendBuffer(int sendIndex, const juce::AudioBuffer<float>& preFaderBuf,
                                    const juce::AudioBuffer<float>& postFaderBuf,
                                    juce::AudioBuffer<float>& destBuffer, int numSamples) const
{
    if (sendIndex < 0 || sendIndex >= (int)sends.size()) return;
    const auto& send = sends[sendIndex];
    if (!send.enabled || send.level <= 0.0f) return;

    const auto& srcBuf = send.preFader ? preFaderBuf : postFaderBuf;
    const int srcChannels = srcBuf.getNumChannels();
    const int destChannels = destBuffer.getNumChannels();

    // Apply send level and pan, mix into dest
    const float level = send.level;
    const float pi = juce::MathConstants<float>::pi;
    float panAngle = (send.pan + 1.0f) * pi / 4.0f;
    float leftGain = std::cos(panAngle) * level;
    float rightGain = std::sin(panAngle) * level;

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

void TrackProcessor::setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin)
{
    if (plugin)
    {
        preparePluginPreservingLayout(plugin.get(), getSampleRate(), juce::jmax(getBlockSize(), 512));
        instrumentPlugin = std::move(plugin);
        juce::Logger::writeToLog("TrackProcessor: Instrument plugin loaded");
    }
}
