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
    float p = (trackPan + 1.0f) * 0.5f;  // Normalize pan to 0..1 (0=left, 0.5=center, 1=right)
    float panAngle = (trackPan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;
    float lGain, rGain;

    switch (panLaw)
    {
        case PanLaw::Minus4_5dB:
        {
            // Blend between constant power (-3dB) and linear (-6dB)
            float cpL = std::cos(panAngle);
            float cpR = std::sin(panAngle);
            float linL = 1.0f - p;
            float linR = p;
            lGain = (cpL + linL) * 0.5f * volumeGain;
            rGain = (cpR + linR) * 0.5f * volumeGain;
            break;
        }
        case PanLaw::Minus6dB:
        {
            // Linear law: -6dB at center
            lGain = (1.0f - p) * volumeGain;
            rGain = p * volumeGain;
            break;
        }
        case PanLaw::Linear:
        {
            // 0dB at center: no center attenuation
            lGain = std::min(1.0f, 2.0f * (1.0f - p)) * volumeGain;
            rGain = std::min(1.0f, 2.0f * p) * volumeGain;
            break;
        }
        case PanLaw::ConstantPower:
        default:
        {
            // Constant power (-3dB at center): cos/sin
            lGain = std::cos(panAngle) * volumeGain;
            rGain = std::sin(panAngle) * volumeGain;
            break;
        }
    }

    cachedPanL.store(lGain, std::memory_order_relaxed);
    cachedPanR.store(rGain, std::memory_order_relaxed);
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

    // Prepare PDC delay line
    {
        juce::dsp::ProcessSpec spec;
        spec.sampleRate = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
        spec.numChannels = 2;
        pdcDelayLine.prepare(spec);
        if (pdcDelaySamples > 0)
            pdcDelayLine.setDelay(static_cast<float>(pdcDelaySamples));
    }

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

    // Prepare channel strip EQ
    channelStripEQ.prepareToPlay(sampleRate, samplesPerBlock);

    // Pre-allocate pre-fader buffer for send routing (2-channel stereo)
    preFaderBuffer.setSize(2, samplesPerBlock);
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

    // Apply Plugin Delay Compensation (PDC) before FX chains
    if (pdcDelaySamples > 0)
    {
        juce::dsp::AudioBlock<float> block(buffer);
        juce::dsp::ProcessContextReplacing<float> context(block);
        pdcDelayLine.process(context);
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

    // Channel strip EQ (processed before plugin FX chains)
    if (channelStripEQEnabled)
    {
        channelStripEQ.processBlock(buffer, midiMessages);
    }

    // Process through input FX chain
    for (auto& plugin : inputFXPlugins)
    {
        if (plugin)
            safeProcessFX(plugin.get());
    }

    // Process through track FX chain (with sidechain support)
    for (int fxIdx = 0; fxIdx < (int)trackFXPlugins.size(); ++fxIdx)
    {
        auto* proc = trackFXPlugins[fxIdx].get();
        if (!proc) continue;

        // Check if this plugin has a sidechain source configured AND
        // the plugin actually supports sidechain input (more than 1 input bus)
        auto scIt = sidechainSources.find(fxIdx);
        bool hasSidechain = (scIt != sidechainSources.end())
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
            int expandedCh = juce::jmin(totalCh, fxProcessBuffer.getNumChannels());

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
                // else: already cleared above
            }

            float* channelPtrs[8];
            for (int ch = 0; ch < expandedCh; ++ch)
                channelPtrs[ch] = fxProcessBuffer.getWritePointer(ch);

            juce::AudioBuffer<float> pluginBuffer(channelPtrs, expandedCh, numSamps2);
            proc->processBlock(pluginBuffer, midiMessages);

            // Copy processed main channels back
            for (int ch = 0; ch < bufferChannels; ++ch)
                buffer.copyFrom(ch, 0, pluginBuffer, ch, 0, numSamps2);
        }
        else
        {
            // No sidechain — use normal channel-safe processing
            safeProcessFX(proc);
        }
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

    // ===== CAPTURE PRE-FADER BUFFER (for pre-fader sends) =====
    if (!sends.empty())
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
        float staticVolDB = trackVolumeDB;
        float staticPan = trackPan;

        for (int i = 0; i < numSamps; ++i)
        {
            double samplePos = blockStartSample + static_cast<double>(i);

            float volDB = volAutoActive ? volumeAutomation.eval(samplePos) : staticVolDB;
            float pan   = panAutoActive ? panAutomation.eval(samplePos)   : staticPan;

            // Clamp to safe ranges
            volDB = juce::jlimit(-60.0f, 6.0f, volDB);
            pan   = juce::jlimit(-1.0f, 1.0f, pan);

            // Compute gain (same constant-power formula as recomputePanGains)
            float volumeGain = juce::Decibels::decibelsToGain(volDB);
            float panAngle = (pan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;
            float lGain = std::cos(panAngle) * volumeGain;
            float rGain = std::sin(panAngle) * volumeGain;

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
// Sidechain Routing (Phase 4.4)

void TrackProcessor::setSidechainSource(int pluginIndex, const juce::String& sourceTrackId)
{
    sidechainSources[pluginIndex] = sourceTrackId;
    juce::Logger::writeToLog("TrackProcessor: Set sidechain source for FX[" +
                             juce::String(pluginIndex) + "] = " + sourceTrackId);
}

void TrackProcessor::clearSidechainSource(int pluginIndex)
{
    sidechainSources.erase(pluginIndex);
    juce::Logger::writeToLog("TrackProcessor: Cleared sidechain source for FX[" +
                             juce::String(pluginIndex) + "]");
}

juce::String TrackProcessor::getSidechainSource(int pluginIndex) const
{
    auto it = sidechainSources.find(pluginIndex);
    if (it != sidechainSources.end())
        return it->second;
    return {};
}

void TrackProcessor::setSidechainBuffer(const juce::AudioBuffer<float>* buffer)
{
    sidechainInputBuffer = buffer;
}

bool TrackProcessor::hasAnySidechainSources() const
{
    return !sidechainSources.empty();
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

void TrackProcessor::setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin)
{
    if (plugin)
    {
        preparePluginPreservingLayout(plugin.get(), getSampleRate(), juce::jmax(getBlockSize(), 512));
        instrumentPlugin = std::move(plugin);
        juce::Logger::writeToLog("TrackProcessor: Instrument plugin loaded");
    }
}

//==============================================================================
// Plugin Delay Compensation (PDC)

int TrackProcessor::getChainLatency() const
{
    int totalLatency = 0;
    for (const auto& plugin : inputFXPlugins)
    {
        if (plugin && !plugin->isSuspended())
            totalLatency += plugin->getLatencySamples();
    }
    for (const auto& plugin : trackFXPlugins)
    {
        if (plugin && !plugin->isSuspended())
            totalLatency += plugin->getLatencySamples();
    }
    return totalLatency;
}

void TrackProcessor::setPDCDelay(int delaySamples)
{
    pdcDelaySamples = delaySamples;
    pdcDelayLine.setDelay(static_cast<float>(delaySamples));
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
        sends[sendIndex].phaseInvert = invert;
}

bool TrackProcessor::getSendPhaseInvert(int sendIndex) const
{
    if (sendIndex >= 0 && sendIndex < (int)sends.size())
        return sends[sendIndex].phaseInvert;
    return false;
}

//==============================================================================
// Output Channel Routing

void TrackProcessor::setOutputChannels(int startChannel, int numChannels)
{
    outputStartChannel = juce::jmax(0, startChannel);
    outputChannelCount = juce::jlimit(1, 8, numChannels);
}

//==============================================================================
// Per-track MIDI Output

void TrackProcessor::setMIDIOutputDevice(const juce::String& deviceName)
{
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

bool TrackProcessor::initializeARA(int fxIndex, double sampleRate, int araBlockSize)
{
#if S13_HAS_ARA
    // Get the plugin at the specified FX index
    if (fxIndex < 0 || fxIndex >= static_cast<int>(trackFXPlugins.size()))
        return false;

    auto* plugin = dynamic_cast<juce::AudioPluginInstance*>(trackFXPlugins[static_cast<size_t>(fxIndex)].get());
    if (!plugin)
    {
        juce::Logger::writeToLog("TrackProcessor::initializeARA: Plugin at index "
            + juce::String(fxIndex) + " is not an AudioPluginInstance.");
        return false;
    }

    // Shutdown any existing ARA session
    shutdownARA();

    araController = std::make_unique<ARAHostController>();

    // ARA initialization is async — createARAFactoryAsync callback will complete it.
    // We start it and return true optimistically; the callback will set araActive.
    araFXIndex = fxIndex;
    araController->initializeForPlugin(plugin, sampleRate, araBlockSize,
        [this, fxIndex] (bool success) {
            if (success)
            {
                juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA initialized at FX index "
                    + juce::String(fxIndex));
            }
            else
            {
                juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA initialization failed for FX index "
                    + juce::String(fxIndex));
                araController.reset();
                araFXIndex = -1;
            }
        });

    return true;  // Async — actual result reported via callback
#else
    juce::ignoreUnused(fxIndex, sampleRate, araBlockSize);
    juce::Logger::writeToLog("TrackProcessor::initializeARA: ARA support not compiled in.");
    return false;
#endif
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
}
