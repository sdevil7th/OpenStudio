BuiltInLinearPhaseEQ::Snapshot OpenStudioEQ::linearSnapshot() const noexcept
{
    BuiltInLinearPhaseEQ::Snapshot snapshot;
    snapshot.bands = bandCount; snapshot.quality = juce::jlimit(0, 2, juce::roundToInt(phaseQuality.load()));
    snapshot.minimumPhase = phaseMode.load() < .5f && minimumPhaseFIR.load() >= .5f;
    snapshot.analogResponse = snapshot.minimumPhase && analogResponse.load() >= .5f;
    if (const auto* draft = draftPreview.preparedPlan(); draft && draft->fingerprint == draftFingerprint()
        && draft->rate == publishedSampleRate.load() && canPreviewDraft())
    { snapshot.draftStages = draft->stages; snapshot.draftCoefficients = draft->coefficients; }
    const bool mono = getMainBusNumInputChannels() == 1;
    snapshot.stereoMode = mono ? 0 : juce::jlimit(0, 2, juce::roundToInt(stereoMode.load()));
    const int audition = juce::jlimit(-1, bandCount - 1, juce::roundToInt(auditionBand.load()) - 1);
    for (int band = 0; band < bandCount; ++band)
    {
        const auto index = static_cast<size_t>(band);
        snapshot.targets[index] = mono ? 0 : juce::jlimit(0, 4, juce::roundToInt(bands[band].target.load()));
        snapshot.stages[index] = buildBandTargets(band,
            audition >= 0 ? band == audition : bands[band].enabled.load() >= .5f, snapshot.coefficients[index], false, snapshot.analogResponse);
        const int shape = bands[band].allPass.load() >= .5f ? static_cast<int>(FilterType::AllPass) : juce::roundToInt(bands[band].type.load());
        if (shape == static_cast<int>(FilterType::AllPass) && !snapshot.minimumPhase) snapshot.stages[index] = 0;
        if ((shape == static_cast<int>(FilterType::LowCut) || shape == static_cast<int>(FilterType::HighCut))
            && (audition >= 0 ? band == audition : bands[band].enabled.load() >= .5f))
        {
            snapshot.cutModes[index] = juce::jlimit(0, 2, juce::roundToInt(bands[band].cutMode.load()));
            if (snapshot.cutModes[index] != 0)
            {
                snapshot.stages[index] = 0; snapshot.highPass[index] = shape == static_cast<int>(FilterType::LowCut);
                snapshot.cutFrequencies[index] = bands[band].freq.load(); snapshot.cutSlopes[index] = bands[band].continuousSlope.load();
            }
        }
        int nonUnity = 0;
        for (int stage = 0; stage < snapshot.stages[index]; ++stage)
        {
            const auto coefficients = snapshot.coefficients[index][static_cast<size_t>(stage)];
            if (coefficients[0] != 1 || coefficients[1] != coefficients[3] || coefficients[2] != coefficients[4])
                snapshot.coefficients[index][static_cast<size_t>(nonUnity++)] = coefficients;
        }
        snapshot.stages[index] = nonUnity;
        for (int stage = nonUnity; stage < maxStagesPerBand; ++stage)
            snapshot.coefficients[index][static_cast<size_t>(stage)] = {1,0,0,0,0};
    }
    return snapshot;
}

bool OpenStudioEQ::setEditorPhaseConfiguration(float mode, float minimumFIR, bool preserveBandDynamics)
{
    // Explicit editor operation only. Old presets keep their stored dynamics
    // option; a user phase transition carries active supported dynamics across.
    if (hasPreparedMIDIPrograms() || !std::isfinite(mode) || !std::isfinite(minimumFIR)
        || !linearPhase || !spectralEQ || !supportsExternalKey()) return false;
    const float nextMode = mode >= .5f ? 1.0f : 0.0f;
    const float nextMinimum = minimumFIR >= .5f ? 1.0f : 0.0f;
    bool activeDynamics = false;
    for (int index = 0; index < bandCount; ++index)
    {
        const auto& band = bands[static_cast<size_t>(index)];
        const int shape = juce::roundToInt(band.type.load());
        activeDynamics = activeDynamics || (band.enabled.load() >= .5f
            && band.dynamicEnabled.load() >= .5f && band.allPass.load() < .5f
            && shape >= 0 && shape <= static_cast<int>(FilterType::HighShelf));
    }
    const float nextDynamics = preserveBandDynamics && activeDynamics && (nextMode >= .5f || nextMinimum >= .5f)
        ? 1.0f : linearBandDynamics.load();
    if (phaseMode.load() == nextMode && minimumPhaseFIR.load() == nextMinimum
        && linearBandDynamics.load() == nextDynamics) return true;
    phaseMode.store(nextMode);
    minimumPhaseFIR.store(nextMinimum);
    linearBandDynamics.store(nextDynamics);
    // Host holds the processor callback lock: prepare the combined state once.
    if (filtersPrepared) { preparePhaseProcessing(); resetWetPathState(); resetDetectorConfiguration(false); updateFilters(true); }
    else setLatencySamples(preparedEQLatency()
        + (frequencyProcessingRequested() ? BuiltInSpectralEQ::latency(juce::roundToInt(phaseQuality.load())) : 0));
    return true;
}

bool OpenStudioEQ::setPhaseConfiguration(float mode, float quality)
{
    if(hasPreparedMIDIPrograms())return false;
    if (!std::isfinite(mode) || !std::isfinite(quality)) return false;
    if (!linearPhase) return mode < .5f;
    const float nextMode = mode >= .5f ? 1.0f : 0.0f;
    const float nextQuality = static_cast<float>(juce::jlimit(0, 2, juce::roundToInt(quality)));
    if (phaseMode.load() == nextMode && phaseQuality.load() == nextQuality) return true;
    const float previousMode = phaseMode.load();
    phaseMode.store(nextMode); phaseQuality.store(nextQuality);
    if (previousMode < .5f && nextMode < .5f && minimumPhaseFIR.load() < .5f && spectralProcessing.load() < .5f) return true;
    if (filtersPrepared)
    {
        // Non-automatable configuration path; the host holds the callback lock.
        // Device/offline prepare likewise serializes this work against playback.
        preparePhaseProcessing(); resetWetPathState(); resetDetectorConfiguration(false); updateFilters(true);
    }
    else setLatencySamples(preparedEQLatency()
        + (frequencyProcessingRequested() ? BuiltInSpectralEQ::latency(static_cast<int>(nextQuality)) : 0));
    return true;
}

bool OpenStudioEQ::setSpectralConfiguration(float enabled)
{
    if(hasPreparedMIDIPrograms())return false;
    if (!std::isfinite(enabled) || !spectralEQ) return false;
    const float next = enabled >= .5f ? 1.0f : 0.0f;
    if (spectralProcessing.load() == next) return true;
    spectralProcessing.store(next);
    if (filtersPrepared)
    {
        preparePhaseProcessing(); resetWetPathState(); resetDetectorConfiguration(false); updateFilters(true);
    }
    else setLatencySamples(preparedEQLatency()
        + (frequencyProcessingRequested() ? BuiltInSpectralEQ::latency(juce::roundToInt(phaseQuality.load())) : 0));
    return true;
}

bool OpenStudioEQ::setLinearDynamicsConfiguration(float enabled)
{
    if(hasPreparedMIDIPrograms())return false;
    if (!std::isfinite(enabled) || !spectralEQ) return false;
    const float next = enabled >= .5f ? 1.0f : 0.0f;
    if (linearBandDynamics.load() == next) return true;
    linearBandDynamics.store(next);
    if (!usesPreparedEQ()) return true;
    if (filtersPrepared) { preparePhaseProcessing(); resetWetPathState(); resetDetectorConfiguration(false); updateFilters(true); }
    else setLatencySamples(preparedEQLatency()
        + (frequencyProcessingRequested() ? BuiltInSpectralEQ::latency(juce::roundToInt(phaseQuality.load())) : 0));
    return true;
}

bool OpenStudioEQ::setMinimumPhaseFIR(float enabled)
{
    if(hasPreparedMIDIPrograms())return false;
    if (!std::isfinite(enabled) || !linearPhase || !supportsExternalKey()) return false;
    const float next = enabled >= .5f ? 1.0f : 0.0f;
    if (minimumPhaseFIR.load() == next) return true;
    minimumPhaseFIR.store(next);
    if (phaseMode.load() >= .5f) return true; // Retained option applies only to Minimum phase.
    if (filtersPrepared) { preparePhaseProcessing(); resetWetPathState(); resetDetectorConfiguration(false); updateFilters(true); }
    else setLatencySamples(preparedEQLatency() + (frequencyProcessingRequested() ? BuiltInSpectralEQ::latency(juce::roundToInt(phaseQuality.load())) : 0));
    return true;
}

bool OpenStudioEQ::setAnalogResponse(float enabled)
{
    if(hasPreparedMIDIPrograms())return false;
    if (!std::isfinite(enabled) || !linearPhase || !supportsExternalKey()) return false;
    const float next = enabled >= .5f ? 1.0f : 0.0f;
    if (analogResponse.load() == next) return true;
    analogResponse.store(next);
    if (phaseMode.load() >= .5f || minimumPhaseFIR.load() < .5f) return true;
    if (filtersPrepared) { preparePhaseProcessing(); resetWetPathState(); resetDetectorConfiguration(false); updateFilters(true); }
    else setLatencySamples(preparedEQLatency() + (frequencyProcessingRequested() ? BuiltInSpectralEQ::latency(juce::roundToInt(phaseQuality.load())) : 0));
    return true;
}

void OpenStudioEQ::preparePhaseProcessing()
{
    if (linearPhase && usesPreparedEQ())
    {
        const auto snapshot = linearSnapshot();
        linearPhase->prepare(cachedSampleRate, snapshot, isNonRealtime());
        setLatencySamples(BuiltInLinearPhaseEQ::latency(snapshot));
    }
    else
    {
        if (linearPhase) linearPhase->release();
        setLatencySamples(0);
    }
    if (spectralEQ && frequencyProcessingRequested())
    {
        spectralEQ->prepare(cachedSampleRate, juce::roundToInt(phaseQuality.load()), getLatencySamples());
        spectralEQ->reset(powerEnabled.load() && editorBypass.load() < .5f && detectorListenBand.load() < .5f && auditionBand.load() < .5f);
        setLatencySamples(getLatencySamples() + BuiltInSpectralEQ::latency(juce::roundToInt(phaseQuality.load())));
    }
    else if (spectralEQ) spectralEQ->release();
}

double OpenStudioEQ::getTailLengthSeconds() const
{
    if(hasPreparedMIDIPrograms())return preparedMIDITail.load();
    const int quality = juce::roundToInt(phaseQuality.load());
    const int staticTail = usesPreparedEQ() ? BuiltInLinearPhaseEQ::tapCount(quality) + BuiltInLinearPhaseEQ::quantum : 0;
    const int spectralTail = frequencyProcessingRequested() ? BuiltInSpectralEQ::latency(quality) * 2 : 0;
    return static_cast<double>(staticTail + spectralTail) / juce::jmax(1.0, publishedSampleRate.load());
}

void OpenStudioEQ::processLinearPhase(juce::AudioBuffer<float>& buffer, bool spectrumRequested, const juce::AudioBuffer<float>& fullBuffer)
{
    const int count = buffer.getNumSamples(), channels = buffer.getNumChannels();
    if (!linearPhase->ready() || dryScratch.getNumSamples() < count) { buffer.clear(); return; }
    draftPreview.advancePrepared(count);
    if (spectrumRequested) for (int channel = 0; channel < channels; ++channel) dryScratch.copyFrom(channel, 0, buffer, channel, 0, count);
    linearPhase->request(linearSnapshot());
    const float power = powerEnabled.load(std::memory_order_acquire) && editorBypass.load() < .5f ? 1.0f : 0.0f;
    smoothedPowerMix.setTargetValue(power);
    const float gain = juce::jlimit(-18.0f, 18.0f, juce::jlimit(-12.0f, 12.0f, outputGain.load())
        + (autoGain.load() >= .5f ? linearPhase->autoGainDB() : 0.0f));
    smoothedOutputGain.setTargetValue(juce::Decibels::decibelsToGain(gain));
    const int mode = juce::jlimit(0, 2, juce::roundToInt(stereoMode.load()));
    for (auto& dynamic : dynamicGainDB) dynamic.store(0, std::memory_order_relaxed);
    for (int i = 0; i < count; ++i)
    {
        const float left = buffer.getSample(0, i), right = channels > 1 ? buffer.getSample(1, i) : left;
        const auto sample = linearPhase->process(left, right);
        float wetL = sample[0], wetR = sample[1]; const float level = smoothedOutputGain.getNextValue();
        if (mode > 0 && channels > 1)
        {
            float mid = (wetL + wetR) * .5f, side = (wetL - wetR) * .5f;
            if (mode == 1) mid *= level; else side *= level;
            wetL = mid + side; wetR = mid - side;
        }
        else { wetL *= level; wetR *= level; }
        wetL = std::isfinite(wetL) ? juce::jlimit(-2.5f, 2.5f, wetL) : 0;
        wetR = std::isfinite(wetR) ? juce::jlimit(-2.5f, 2.5f, wetR) : 0;
        const float mix = smoothedPowerMix.getNextValue();
        buffer.setSample(0, i, wetL * mix + sample[2] * (1 - mix));
        if (channels > 1) buffer.setSample(1, i, wetR * mix + sample[3] * (1 - mix));
    }
    publishOutputPeaks(buffer);
    if (spectrumRequested) captureSpectrumBlock(dryScratch, buffer, fullBuffer);
}


void OpenStudioEQ::processSpectral(juce::AudioBuffer<float>& buffer, bool spectrumRequested, const juce::AudioBuffer<float>& fullBuffer)
{
    if (!spectralEQ || !spectralEQ->ready()) { buffer.clear(); return; }
    const int channels = buffer.getNumChannels(), count = buffer.getNumSamples();
    const bool listening = detectorListenBand.load() >= .5f || auditionBand.load() >= .5f;
    const bool linear = usesPreparedEQ();
    spectralEQ->listenBand = linear ? juce::jlimit(-1, bandCount - 1, juce::roundToInt(detectorListenBand.load()) - 1) : -1;
    spectralEQ->setPower(powerEnabled.load() && editorBypass.load() < .5f && (!listening || spectralEQ->listenBand >= 0));
    const int globalTarget = channels == 1 ? 0 : juce::jlimit(0, 2, juce::roundToInt(stereoMode.load()));
    const auto safe = [](float value, float fallback, float low, float high) { return std::isfinite(value) ? juce::jlimit(low, high, value) : fallback; };
    for (int b = 0; b < bandCount; ++b)
    {
        const auto& source = bands[b]; auto& band = spectralEQ->controls[static_cast<size_t>(b)];
        band.shape = juce::jlimit(0, 9, juce::roundToInt(source.type.load()));
        band.wholeBand = linear && linearBandDynamics.load() >= .5f && !(spectralProcessing.load() >= .5f && source.spectralEnabled.load() >= .5f);
        band.staticGain = safe(source.gain.load(), 0, -30, 30); band.slope = juce::jlimit(0, 5, juce::roundToInt(source.slope.load()));
        band.gainQ = source.gainQInteraction.load() >= .5f;
        band.active = source.enabled.load() >= .5f && (band.wholeBand || (spectralProcessing.load() >= .5f && source.spectralEnabled.load() >= .5f))
            && source.dynamicEnabled.load() >= .5f && source.allPass.load() < .5f && band.shape <= 2;
        band.range = safe(source.dynamicRange.load(), 0, -30, 30);
        band.active = band.active && std::abs(band.range) > .0001f;
        band.target = channels == 1 ? 0 : globalTarget == 1 ? 3 : globalTarget == 2 ? 4 : juce::jlimit(0, 4, juce::roundToInt(source.target.load()));
        band.source = juce::jlimit(0, 2, juce::roundToInt(source.detectorSource.load()));
        if (band.source == 0) band.source = externalDetector.load() >= .5f ? 2 : 1;
        band.frequency = safe(source.freq.load(), 1000, 10, static_cast<float>(band.wholeBand ? cachedSampleRate * .5 - 1 : cachedSampleRate * .475));
        band.q = safe(source.q.load(), 1, .1f, 30);
        band.threshold = safe(source.dynamicThreshold.load(), -24, -80, 0);
        band.attack = safe(source.dynamicAttack.load(), 10, .1f, 200);
        band.release = safe(source.dynamicRelease.load(), 150, 1, 3000);
        band.adaptive = source.dynamicThresholdMode.load() >= .5f;
        band.automatic = source.dynamicTimingMode.load() >= .5f;
        band.sensitivity = safe(source.dynamicSensitivity.load(), 0, -12, 12);
        band.density = safe(source.spectralDensity.load(), .75f, 0, 1);
        band.tilt = source.spectralTilt.load() >= .5f;
        band.free = source.detectorMode.load() >= .5f;
        band.low = safe(source.detectorLowCut.load(), 20, 20, 19000);
        band.high = safe(source.detectorHighCut.load(), 20000, band.low * 1.05f, 20000);
    }
    for (int i = 0; i < count; ++i)
    {
        const std::array<float, 4> keys {detectorKey.rawSample(false, 0, i), detectorKey.rawSample(false, 1, i),
            detectorKey.rawSample(true, 0, i), detectorKey.rawSample(true, 1, i)};
        const auto output = spectralEQ->process(buffer.getSample(0, i), buffer.getSample(channels > 1 ? 1 : 0, i), keys);
        for (int ch = 0; ch < channels; ++ch) buffer.setSample(ch, i, output[static_cast<size_t>(ch)]);
    }
    for (int b = 0; b < bandCount; ++b)
    {
        if (!usesSpectralBand(b)) continue;
        const auto index = static_cast<size_t>(b); const auto& band = spectralEQ->controls[index];
        effectiveDynamicControls[index][0].store(band.adaptive ? spectralEQ->thresholdDb[index].load() : band.threshold);
        effectiveDynamicControls[index][1].store(band.automatic ? juce::jlimit(.2f, 80.0f, 2000 / band.frequency) : band.attack);
        effectiveDynamicControls[index][2].store(band.automatic ? juce::jlimit(40.0f, 1000.0f, 10000 / band.frequency + 80 + 8 * std::abs(band.range)) : band.release);
    }
    publishOutputPeaks(buffer);
    if (spectrumRequested && spectralPreScratch.getNumSamples() >= count) captureSpectrumBlock(spectralPreScratch, buffer, fullBuffer);
}
