#include "BuiltInEffects.h"

//==============================================================================
// S13BuiltInEffect — shared base class
//==============================================================================

S13BuiltInEffect::S13BuiltInEffect()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

bool S13BuiltInEffect::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    // Accept stereo or mono — the main requirement is that input and output
    // channel sets match so we can process in-place.
    const auto& mainIn  = layouts.getMainInputChannelSet();
    const auto& mainOut = layouts.getMainOutputChannelSet();

    if (mainOut != mainIn)
        return false;

    // Accept mono or stereo
    if (mainOut != juce::AudioChannelSet::mono() &&
        mainOut != juce::AudioChannelSet::stereo())
        return false;

    return true;
}

void S13BuiltInEffect::setOversamplingEnabled(bool enabled)
{
    oversamplingEnabled = enabled;
    // Oversampler is lazily initialized by derived prepareToPlay() when enabled
}

//==============================================================================
//
//  S13EQ — 4-band parametric EQ with HPF and LPF
//
//==============================================================================

S13EQ::S13EQ()
{
    // Default band frequencies: 100, 500, 2000, 8000 Hz
    bands[0].freq.store(100.0f);
    bands[1].freq.store(500.0f);
    bands[2].freq.store(2000.0f);
    bands[3].freq.store(8000.0f);
}

void S13EQ::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2u;

    hpf.prepare(spec);
    lpf.prepare(spec);
    band1.prepare(spec);
    band2.prepare(spec);
    band3.prepare(spec);
    band4.prepare(spec);

    // Initialize 2x oversampling (Phase 20.12)
    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));

    updateFilters();
}

void S13EQ::releaseResources()
{
    hpf.reset();
    lpf.reset();
    band1.reset();
    band2.reset();
    band3.reset();
    band4.reset();
}

void S13EQ::updateFilters()
{
    const double sr = cachedSampleRate;
    if (sr <= 0.0)
        return;

    // Nyquist safety: clamp all frequencies to below Nyquist
    const float nyquist = static_cast<float>(sr * 0.5) - 1.0f;

    // HPF — 2nd order high-pass
    {
        float freq = juce::jlimit(20.0f, juce::jmin(500.0f, nyquist), hpfFreq.load());
        *hpf.state = *juce::dsp::IIR::Coefficients<float>::makeHighPass(sr, freq);
    }

    // LPF — 2nd order low-pass
    {
        float freq = juce::jlimit(2000.0f, juce::jmin(20000.0f, nyquist), lpfFreq.load());
        *lpf.state = *juce::dsp::IIR::Coefficients<float>::makeLowPass(sr, freq);
    }

    // 4 parametric bands — peak filter
    auto updateBand = [&](StereoIIR& filter, const BandParams& params)
    {
        float freq = juce::jlimit(20.0f, nyquist, params.freq.load());
        float gainDB = juce::jlimit(-24.0f, 24.0f, params.gain.load());
        float q = juce::jlimit(0.1f, 10.0f, params.q.load());

        // Convert dB gain to linear gain factor for makePeakFilter
        float gainFactor = juce::Decibels::decibelsToGain(gainDB);
        *filter.state = *juce::dsp::IIR::Coefficients<float>::makePeakFilter(sr, freq, q, gainFactor);
    };

    updateBand(band1, bands[0]);
    updateBand(band2, bands[1]);
    updateBand(band3, bands[2]);
    updateBand(band4, bands[3]);
}

void S13EQ::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    // Update filter coefficients (cheap — just coefficient assignment)
    updateFilters();

    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);

    hpf.process(context);
    band1.process(context);
    band2.process(context);
    band3.process(context);
    band4.process(context);
    lpf.process(context);
}

void S13EQ::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13EQ");

    state.setProperty("hpfFreq", hpfFreq.load(), nullptr);
    state.setProperty("lpfFreq", lpfFreq.load(), nullptr);

    for (int i = 0; i < 4; ++i)
    {
        juce::String prefix = "band" + juce::String(i) + "_";
        state.setProperty(prefix + "freq", bands[i].freq.load(), nullptr);
        state.setProperty(prefix + "gain", bands[i].gain.load(), nullptr);
        state.setProperty(prefix + "q", bands[i].q.load(), nullptr);
    }

    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13EQ::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13EQ")
        return;

    hpfFreq.store(static_cast<float>(state.getProperty("hpfFreq", 20.0f)));
    lpfFreq.store(static_cast<float>(state.getProperty("lpfFreq", 20000.0f)));

    for (int i = 0; i < 4; ++i)
    {
        juce::String prefix = "band" + juce::String(i) + "_";
        bands[i].freq.store(static_cast<float>(state.getProperty(prefix + "freq", 1000.0f)));
        bands[i].gain.store(static_cast<float>(state.getProperty(prefix + "gain", 0.0f)));
        bands[i].q.store(static_cast<float>(state.getProperty(prefix + "q", 1.0f)));
    }

    updateFilters();
}

//==============================================================================
//
//  S13Compressor — Feed-forward compressor
//
//==============================================================================

S13Compressor::S13Compressor()
{
}

void S13Compressor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2u;

    compressor.prepare(spec);

    // Apply initial parameter values
    compressor.setThreshold(threshold.load());
    compressor.setRatio(juce::jmax(1.0f, ratio.load()));
    compressor.setAttack(juce::jmax(0.1f, attack.load()));
    compressor.setRelease(juce::jmax(10.0f, release.load()));

    smoothedMakeup.reset(sampleRate, 0.02);  // 20ms smoothing
    smoothedMakeup.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(makeupGain.load()));

    // Initialize 2x oversampling (Phase 20.12)
    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
}

void S13Compressor::releaseResources()
{
    compressor.reset();
}

void S13Compressor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    // Update compressor parameters from atomics
    compressor.setThreshold(juce::jlimit(-60.0f, 0.0f, threshold.load()));
    compressor.setRatio(juce::jmax(1.0f, juce::jlimit(1.0f, 20.0f, ratio.load())));
    compressor.setAttack(juce::jmax(0.1f, juce::jlimit(0.1f, 100.0f, attack.load())));
    compressor.setRelease(juce::jmax(10.0f, juce::jlimit(10.0f, 1000.0f, release.load())));

    // Note: The juce::dsp::Compressor does not have a knee parameter.
    // The knee parameter is stored for state save/load but not applied to
    // the JUCE compressor, which uses a hard knee. A future enhancement
    // could implement soft-knee by processing sample-by-sample with a
    // custom gain computer.

    // Process compression
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    compressor.process(context);

    // Apply makeup gain with smoothing
    float targetMakeup = juce::Decibels::decibelsToGain(
        juce::jlimit(0.0f, 30.0f, makeupGain.load()));
    smoothedMakeup.setTargetValue(targetMakeup);

    int numSamples = buffer.getNumSamples();
    int numChannels = buffer.getNumChannels();

    if (smoothedMakeup.isSmoothing())
    {
        for (int i = 0; i < numSamples; ++i)
        {
            float gain = smoothedMakeup.getNextValue();
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.setSample(ch, i, buffer.getSample(ch, i) * gain);
        }
    }
    else
    {
        float gain = smoothedMakeup.getTargetValue();
        if (std::abs(gain - 1.0f) > 0.0001f)
        {
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.applyGain(ch, 0, numSamples, gain);
        }
    }
}

void S13Compressor::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Compressor");

    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("ratio", ratio.load(), nullptr);
    state.setProperty("attack", attack.load(), nullptr);
    state.setProperty("release", release.load(), nullptr);
    state.setProperty("knee", knee.load(), nullptr);
    state.setProperty("makeupGain", makeupGain.load(), nullptr);

    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Compressor::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Compressor")
        return;

    threshold.store(static_cast<float>(state.getProperty("threshold", 0.0f)));
    ratio.store(static_cast<float>(state.getProperty("ratio", 1.0f)));
    attack.store(static_cast<float>(state.getProperty("attack", 10.0f)));
    release.store(static_cast<float>(state.getProperty("release", 100.0f)));
    knee.store(static_cast<float>(state.getProperty("knee", 0.0f)));
    makeupGain.store(static_cast<float>(state.getProperty("makeupGain", 0.0f)));
}

//==============================================================================
//
//  S13Gate — Noise gate with hold and range
//
//==============================================================================

S13Gate::S13Gate()
{
}

void S13Gate::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    // Reset envelope state
    envelopeLevel = 0.0f;
    holdCounter = 0;
    currentGain = 0.0f;

    // Initialize 2x oversampling (Phase 20.12)
    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));

    updateCoefficients();
}

void S13Gate::releaseResources()
{
    envelopeLevel = 0.0f;
    holdCounter = 0;
    currentGain = 0.0f;
}

void S13Gate::updateCoefficients()
{
    const double sr = cachedSampleRate;
    if (sr <= 0.0)
        return;

    const float srf = static_cast<float>(sr);

    // Attack/release: one-pole filter coefficients for gate gain smoothing.
    // Attack = how fast the gate opens, Release = how fast it closes.
    float atkMs = juce::jlimit(0.01f, 50.0f, attackMs.load());
    float relMs = juce::jlimit(5.0f, 500.0f, releaseMs.load());

    attackCoeff  = std::exp(-1.0f / (atkMs * 0.001f * srf));
    releaseCoeff = std::exp(-1.0f / (relMs * 0.001f * srf));

    // Hold time in samples
    float hMs = juce::jlimit(0.0f, 500.0f, holdMs.load());
    holdSamples = static_cast<int>(hMs * 0.001f * srf);

    // Threshold in linear amplitude
    float threshDB = juce::jlimit(-80.0f, 0.0f, threshold.load());
    thresholdLinear = juce::Decibels::decibelsToGain(threshDB);

    // Range: the gain floor when the gate is fully closed
    float rangeDB = juce::jlimit(-80.0f, 0.0f, range.load());
    rangeGain = juce::Decibels::decibelsToGain(rangeDB);
}

void S13Gate::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    // Update coefficients from atomic params
    updateCoefficients();

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();

    // Fast envelope follower coefficient (~0.3ms at 44.1kHz)
    // Used only for level detection, not for gate gain shaping.
    const float envAttack  = 0.9995f;
    const float envRelease = 0.9999f;

    for (int i = 0; i < numSamples; ++i)
    {
        // Stereo-linked detection: use the louder channel's absolute value
        float inputLevel = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
            inputLevel = juce::jmax(inputLevel, std::abs(buffer.getSample(ch, i)));

        // Envelope follower (peak detector with fast ballistics for detection)
        if (inputLevel > envelopeLevel)
            envelopeLevel = envAttack * envelopeLevel + (1.0f - envAttack) * inputLevel;
        else
            envelopeLevel = envRelease * envelopeLevel + (1.0f - envRelease) * inputLevel;

        // Gate logic with hold — determine target gain
        float targetGain;
        if (envelopeLevel >= thresholdLinear)
        {
            // Above threshold — gate open
            targetGain = 1.0f;
            holdCounter = holdSamples;
        }
        else if (holdCounter > 0)
        {
            // Below threshold but in hold phase — gate stays open
            targetGain = 1.0f;
            --holdCounter;
        }
        else
        {
            // Below threshold, hold expired — gate closed (apply range)
            targetGain = rangeGain;
        }

        // Smooth the gain change using attack/release coefficients
        // Attack: how fast the gate opens; Release: how fast it closes
        if (targetGain > currentGain)
            currentGain = attackCoeff * currentGain + (1.0f - attackCoeff) * targetGain;
        else
            currentGain = releaseCoeff * currentGain + (1.0f - releaseCoeff) * targetGain;

        // Apply gain to all channels
        for (int ch = 0; ch < numChannels; ++ch)
            buffer.setSample(ch, i, buffer.getSample(ch, i) * currentGain);
    }
}

void S13Gate::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Gate");

    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("attack", attackMs.load(), nullptr);
    state.setProperty("hold", holdMs.load(), nullptr);
    state.setProperty("release", releaseMs.load(), nullptr);
    state.setProperty("range", range.load(), nullptr);

    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Gate::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Gate")
        return;

    threshold.store(static_cast<float>(state.getProperty("threshold", -40.0f)));
    attackMs.store(static_cast<float>(state.getProperty("attack", 1.0f)));
    holdMs.store(static_cast<float>(state.getProperty("hold", 50.0f)));
    releaseMs.store(static_cast<float>(state.getProperty("release", 50.0f)));
    range.store(static_cast<float>(state.getProperty("range", -80.0f)));

    updateCoefficients();
}

//==============================================================================
//
//  S13Limiter — Brickwall limiter with ceiling
//
//==============================================================================

S13Limiter::S13Limiter()
{
}

void S13Limiter::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2u;

    limiter.prepare(spec);
    limiter.setThreshold(threshold.load());
    limiter.setRelease(juce::jmax(10.0f, releaseMs.load()));

    smoothedCeiling.reset(sampleRate, 0.02);  // 20ms smoothing
    smoothedCeiling.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(ceiling.load()));

    // Initialize 2x oversampling (Phase 20.12)
    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
}

void S13Limiter::releaseResources()
{
    limiter.reset();
}

void S13Limiter::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    // Update limiter parameters from atomics
    limiter.setThreshold(juce::jlimit(-20.0f, 0.0f, threshold.load()));
    limiter.setRelease(juce::jmax(10.0f, juce::jlimit(10.0f, 500.0f, releaseMs.load())));

    // Process through the limiter
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    limiter.process(context);

    // Apply ceiling gain with smoothing
    // Ceiling: the maximum output level (e.g., -0.3 dB for broadcast safety)
    float ceilingDB = juce::jlimit(-3.0f, 0.0f, ceiling.load());
    float targetCeiling = juce::Decibels::decibelsToGain(ceilingDB);
    smoothedCeiling.setTargetValue(targetCeiling);

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();

    if (smoothedCeiling.isSmoothing())
    {
        for (int i = 0; i < numSamples; ++i)
        {
            float gain = smoothedCeiling.getNextValue();
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.setSample(ch, i, buffer.getSample(ch, i) * gain);
        }
    }
    else
    {
        float gain = smoothedCeiling.getTargetValue();
        if (std::abs(gain - 1.0f) > 0.0001f)
        {
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.applyGain(ch, 0, numSamples, gain);
        }
    }

    // Hard clip at ceiling level to guarantee true peak limiting
    float clipLevel = targetCeiling;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        float* channelData = buffer.getWritePointer(ch);
        juce::FloatVectorOperations::clip(channelData, channelData,
                                          -clipLevel, clipLevel, numSamples);
    }
}

void S13Limiter::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Limiter");

    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("release", releaseMs.load(), nullptr);
    state.setProperty("ceiling", ceiling.load(), nullptr);

    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Limiter::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Limiter")
        return;

    threshold.store(static_cast<float>(state.getProperty("threshold", -1.0f)));
    releaseMs.store(static_cast<float>(state.getProperty("release", 100.0f)));
    ceiling.store(static_cast<float>(state.getProperty("ceiling", 0.0f)));
}
