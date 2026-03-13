#include "BuiltInEffects.h"
#include "S13PluginEditors.h"

//==============================================================================
// S13BuiltInEffect -- shared base class
//==============================================================================

S13BuiltInEffect::S13BuiltInEffect()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

bool S13BuiltInEffect::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainIn  = layouts.getMainInputChannelSet();
    const auto& mainOut = layouts.getMainOutputChannelSet();
    if (mainOut != mainIn) return false;
    return mainOut == juce::AudioChannelSet::mono()
        || mainOut == juce::AudioChannelSet::stereo();
}

void S13BuiltInEffect::setOversamplingEnabled(bool enabled)
{
    oversamplingEnabled = enabled;
}

juce::AudioProcessorEditor* S13BuiltInEffect::createEditor()
{
    return nullptr; // Derived classes override this
}

juce::AudioProcessorEditor* S13EQ::createEditor() { return new S13EQEditor(*this); }
juce::AudioProcessorEditor* S13Compressor::createEditor() { return new S13CompressorEditor(*this); }
juce::AudioProcessorEditor* S13Gate::createEditor() { return new S13GateEditor(*this); }
juce::AudioProcessorEditor* S13Limiter::createEditor() { return new S13LimiterEditor(*this); }

//==============================================================================
//  S13EQ -- 8-band parametric EQ
//==============================================================================

S13EQ::S13EQ()
{
    const float defaultFreqs[numBands] = { 30.0f, 100.0f, 250.0f, 500.0f, 1000.0f, 2500.0f, 6000.0f, 12000.0f };
    for (int i = 0; i < numBands; ++i)
    {
        bands[i].freq.store(defaultFreqs[i]);
        bands[i].enabled.store(1.0f);
        bands[i].type.store(static_cast<float>(FilterType::Bell));
        bands[i].gain.store(0.0f);
        bands[i].q.store(1.0f);
        bands[i].slope.store(static_cast<float>(FilterSlope::dB12));
    }
    // First band defaults to low cut (off), last to high cut (off)
    bands[0].type.store(static_cast<float>(FilterType::LowCut));
    bands[0].freq.store(20.0f);
    bands[0].enabled.store(0.0f);
    bands[numBands - 1].type.store(static_cast<float>(FilterType::HighCut));
    bands[numBands - 1].freq.store(20000.0f);
    bands[numBands - 1].enabled.store(0.0f);
}

int S13EQ::getNumStagesForSlope(FilterSlope slope) const
{
    switch (slope)
    {
        case FilterSlope::dB6:  return 1;
        case FilterSlope::dB12: return 1;
        case FilterSlope::dB24: return 2;
        case FilterSlope::dB48: return 4;
        default: return 1;
    }
}

void S13EQ::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2u };

    for (int b = 0; b < numBands; ++b)
        for (int s = 0; s < maxStagesPerBand; ++s)
            bandFilters[b][s].prepare(spec);

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));

    fftWritePos = 0;
    fftBlockCounter = 0;
    updateFilters();
}

void S13EQ::releaseResources()
{
    for (int b = 0; b < numBands; ++b)
        for (int s = 0; s < maxStagesPerBand; ++s)
            bandFilters[b][s].reset();
}

void S13EQ::updateBand(int b)
{
    const double sr = cachedSampleRate;
    if (sr <= 0.0) return;

    const float nyquist = static_cast<float>(sr * 0.5) - 1.0f;
    const auto type = static_cast<FilterType>(static_cast<int>(bands[b].type.load()));
    const auto slope = static_cast<FilterSlope>(static_cast<int>(bands[b].slope.load()));
    const float freq = juce::jlimit(20.0f, nyquist, bands[b].freq.load());
    const float gainDB = juce::jlimit(-30.0f, 30.0f, bands[b].gain.load());
    const float q = juce::jlimit(0.1f, 30.0f, bands[b].q.load());
    const float gainFactor = juce::Decibels::decibelsToGain(gainDB);

    int numStages = 1;

    switch (type)
    {
        case FilterType::Bell:
            numStages = 1;
            *bandFilters[b][0].state = *juce::dsp::IIR::Coefficients<float>::makePeakFilter(sr, freq, q, gainFactor);
            break;

        case FilterType::LowShelf:
            numStages = 1;
            *bandFilters[b][0].state = *juce::dsp::IIR::Coefficients<float>::makeLowShelf(sr, freq, q, gainFactor);
            break;

        case FilterType::HighShelf:
            numStages = 1;
            *bandFilters[b][0].state = *juce::dsp::IIR::Coefficients<float>::makeHighShelf(sr, freq, q, gainFactor);
            break;

        case FilterType::LowCut:
            numStages = getNumStagesForSlope(slope);
            if (slope == FilterSlope::dB6)
                *bandFilters[b][0].state = *juce::dsp::IIR::Coefficients<float>::makeFirstOrderHighPass(sr, freq);
            else
                for (int s = 0; s < numStages; ++s)
                    *bandFilters[b][s].state = *juce::dsp::IIR::Coefficients<float>::makeHighPass(sr, freq, 0.707f);
            break;

        case FilterType::HighCut:
            numStages = getNumStagesForSlope(slope);
            if (slope == FilterSlope::dB6)
                *bandFilters[b][0].state = *juce::dsp::IIR::Coefficients<float>::makeFirstOrderLowPass(sr, freq);
            else
                for (int s = 0; s < numStages; ++s)
                    *bandFilters[b][s].state = *juce::dsp::IIR::Coefficients<float>::makeLowPass(sr, freq, 0.707f);
            break;

        case FilterType::Notch:
            numStages = 1;
            *bandFilters[b][0].state = *juce::dsp::IIR::Coefficients<float>::makeNotch(sr, freq, q);
            break;

        case FilterType::BandPass:
            numStages = 1;
            *bandFilters[b][0].state = *juce::dsp::IIR::Coefficients<float>::makeBandPass(sr, freq, q);
            break;
    }
    activeStages[b] = numStages;
}

void S13EQ::updateFilters()
{
    for (int b = 0; b < numBands; ++b)
        updateBand(b);
}

void S13EQ::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;
    updateFilters();

    const int numSamples = buffer.getNumSamples();

    // Capture pre-EQ samples for spectrum
    {
        const float* readPtr = buffer.getReadPointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            preEQBuffer[static_cast<size_t>(fftWritePos)] = readPtr[i];
            fftWritePos = (fftWritePos + 1) % fftSize;
        }
    }

    // Process each enabled band
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);

    for (int b = 0; b < numBands; ++b)
    {
        if (bands[b].enabled.load() < 0.5f)
            continue;
        for (int s = 0; s < activeStages[b]; ++s)
            bandFilters[b][s].process(context);
    }

    // Output gain
    float outGainDB = juce::jlimit(-12.0f, 12.0f, outputGain.load());
    if (std::abs(outGainDB) > 0.01f)
        buffer.applyGain(juce::Decibels::decibelsToGain(outGainDB));

    // Capture post-EQ samples
    {
        const float* readPtr = buffer.getReadPointer(0);
        int writePos = (fftWritePos - numSamples + fftSize) % fftSize;
        for (int i = 0; i < numSamples; ++i)
        {
            postEQBuffer[static_cast<size_t>(writePos)] = readPtr[i];
            writePos = (writePos + 1) % fftSize;
        }
    }

    // Periodic spectrum update
    if (++fftBlockCounter >= fftUpdateInterval)
    {
        fftBlockCounter = 0;
        SpectrumData newData;
        computeSpectrum(preEQBuffer, newData.preEQ);
        computeSpectrum(postEQBuffer, newData.postEQ);
        newData.ready = true;
        const std::lock_guard<std::mutex> lock(spectrumMutex);
        spectrumOutput = newData;
    }
}

void S13EQ::computeSpectrum(const std::array<float, fftSize>& input, std::array<float, fftSize / 2>& output)
{
    std::array<float, fftSize * 2> fftData {};
    for (int i = 0; i < fftSize; ++i)
        fftData[static_cast<size_t>(i)] = input[static_cast<size_t>(i)];
    window.multiplyWithWindowingTable(fftData.data(), fftSize);
    fft.performFrequencyOnlyForwardTransform(fftData.data());
    for (int i = 0; i < fftSize / 2; ++i)
    {
        float mag = fftData[static_cast<size_t>(i)] / static_cast<float>(fftSize);
        output[static_cast<size_t>(i)] = juce::Decibels::gainToDecibels(mag, -100.0f);
    }
}

S13EQ::SpectrumData S13EQ::getSpectrumData() const
{
    const std::lock_guard<std::mutex> lock(spectrumMutex);
    return spectrumOutput;
}

std::vector<float> S13EQ::getMagnitudeResponse(const std::vector<float>& frequencies) const
{
    std::vector<float> response(frequencies.size(), 0.0f);
    for (int b = 0; b < numBands; ++b)
    {
        if (bands[b].enabled.load() < 0.5f) continue;
        for (int s = 0; s < activeStages[b]; ++s)
        {
            auto coeffs = bandFilters[b][s].state;
            if (coeffs == nullptr) continue;
            std::vector<double> mags(frequencies.size());
            std::vector<double> freqsDouble(frequencies.begin(), frequencies.end());
            coeffs->getMagnitudeForFrequencyArray(freqsDouble.data(), mags.data(),
                                                   freqsDouble.size(), cachedSampleRate);
            for (size_t i = 0; i < frequencies.size(); ++i)
                response[i] += juce::Decibels::gainToDecibels(static_cast<float>(mags[i]));
        }
    }
    float outGainDB = juce::jlimit(-12.0f, 12.0f, outputGain.load());
    for (auto& r : response) r += outGainDB;
    return response;
}

void S13EQ::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13EQ");
    state.setProperty("outputGain", outputGain.load(), nullptr);
    state.setProperty("autoGain", autoGain.load(), nullptr);
    for (int i = 0; i < numBands; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        state.setProperty(p + "enabled", bands[i].enabled.load(), nullptr);
        state.setProperty(p + "type", bands[i].type.load(), nullptr);
        state.setProperty(p + "freq", bands[i].freq.load(), nullptr);
        state.setProperty(p + "gain", bands[i].gain.load(), nullptr);
        state.setProperty(p + "q", bands[i].q.load(), nullptr);
        state.setProperty(p + "slope", bands[i].slope.load(), nullptr);
    }
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13EQ::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13EQ") return;

    outputGain.store(static_cast<float>(state.getProperty("outputGain", 0.0f)));
    autoGain.store(static_cast<float>(state.getProperty("autoGain", 0.0f)));
    for (int i = 0; i < numBands; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        bands[i].enabled.store(static_cast<float>(state.getProperty(p + "enabled", 1.0f)));
        bands[i].type.store(static_cast<float>(state.getProperty(p + "type", 0.0f)));
        bands[i].freq.store(static_cast<float>(state.getProperty(p + "freq", 1000.0f)));
        bands[i].gain.store(static_cast<float>(state.getProperty(p + "gain", 0.0f)));
        bands[i].q.store(static_cast<float>(state.getProperty(p + "q", 1.0f)));
        bands[i].slope.store(static_cast<float>(state.getProperty(p + "slope", 1.0f)));
    }
    updateFilters();
}

//==============================================================================
//  S13Compressor -- Multi-style compressor
//==============================================================================

S13Compressor::S13Compressor() {}

float S13Compressor::computeGain(float inputDB) const
{
    const float threshDB = juce::jlimit(-60.0f, 0.0f, threshold.load());
    const float ratioVal = juce::jmax(1.0f, juce::jlimit(1.0f, 20.0f, ratio.load()));
    const float kneeDB = juce::jlimit(0.0f, 24.0f, knee.load());

    if (kneeDB > 0.0f)
    {
        const float halfKnee = kneeDB * 0.5f;
        if (inputDB < threshDB - halfKnee)
            return inputDB;
        else if (inputDB > threshDB + halfKnee)
            return threshDB + (inputDB - threshDB) / ratioVal;
        else
        {
            float x = inputDB - threshDB + halfKnee;
            return inputDB + ((1.0f / ratioVal) - 1.0f) * x * x / (2.0f * kneeDB);
        }
    }
    if (inputDB <= threshDB) return inputDB;
    return threshDB + (inputDB - threshDB) / ratioVal;
}

void S13Compressor::getStyleBallistics(float& atkMs, float& relMs) const
{
    const auto styleVal = static_cast<Style>(static_cast<int>(style.load()));
    float baseAtk = juce::jlimit(0.1f, 100.0f, attack.load());
    float baseRel = juce::jlimit(10.0f, 2000.0f, release.load());

    switch (styleVal)
    {
        case Style::Clean:  atkMs = baseAtk; relMs = baseRel; break;
        case Style::Punch:  atkMs = juce::jmax(baseAtk, 5.0f) * 1.5f; relMs = baseRel * 0.7f; break;
        case Style::Opto:   atkMs = juce::jmax(baseAtk, 10.0f) * 2.0f; relMs = juce::jmax(baseRel, 200.0f) * 2.0f; break;
        case Style::FET:    atkMs = juce::jmin(baseAtk, 1.0f); relMs = juce::jlimit(50.0f, 500.0f, baseRel); break;
        case Style::VCA:    atkMs = baseAtk; relMs = juce::jlimit(30.0f, 300.0f, baseRel); break;
    }
}

void S13Compressor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    envelopeLevel = 0.0f;
    currentGainLin = 1.0f;

    smoothedMakeup.reset(sampleRate, 0.02);
    smoothedMakeup.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(makeupGain.load()));

    lastSCHPFFreq = juce::jlimit(20.0f, 500.0f, sidechainHPF.load());
    auto hpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastSCHPFFreq);
    scHPF_L.coefficients = hpfCoeffs;
    scHPF_R.coefficients = hpfCoeffs;
    scHPF_L.reset();
    scHPF_R.reset();

    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 1 };
    lookaheadDelayL.prepare(spec);
    lookaheadDelayR.prepare(spec);
    lookaheadDelayL.reset();
    lookaheadDelayR.reset();

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
}

void S13Compressor::releaseResources()
{
    envelopeLevel = 0.0f;
    currentGainLin = 1.0f;
}

void S13Compressor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0) return;

    // Update sidechain HPF
    const float scFreq = juce::jlimit(20.0f, 500.0f, sidechainHPF.load());
    if (std::abs(scFreq - lastSCHPFFreq) > 1.0f)
    {
        lastSCHPFFreq = scFreq;
        auto coeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(cachedSampleRate, scFreq);
        scHPF_L.coefficients = coeffs;
        scHPF_R.coefficients = coeffs;
    }

    float atkMs, relMs;
    getStyleBallistics(atkMs, relMs);
    const float srf = static_cast<float>(cachedSampleRate);
    const float attackCoeff = std::exp(-1.0f / (atkMs * 0.001f * srf));
    const float releaseCoeff = std::exp(-1.0f / (relMs * 0.001f * srf));

    const float mixWet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float mixDry = 1.0f - mixWet;

    const float laSamples = juce::jlimit(0.0f, 20.0f, lookaheadMs.load()) * 0.001f * srf;
    lookaheadDelayL.setDelay(laSamples);
    lookaheadDelayR.setDelay(laSamples);

    float inputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        inputPeak = juce::jmax(inputPeak, buffer.getMagnitude(ch, 0, numSamples));
    inputLevelDB.store(juce::Decibels::gainToDecibels(inputPeak, -100.0f));

    float peakGR = 0.0f;
    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        const float dryL = dataL[i];
        const float dryR = dataR ? dataR[i] : dryL;

        float scL = scHPF_L.processSample(dryL);
        float scR = dataR ? scHPF_R.processSample(dryR) : scL;
        float scLevel = juce::jmax(std::abs(scL), std::abs(scR));

        if (scLevel > envelopeLevel)
            envelopeLevel = attackCoeff * envelopeLevel + (1.0f - attackCoeff) * scLevel;
        else
            envelopeLevel = releaseCoeff * envelopeLevel + (1.0f - releaseCoeff) * scLevel;

        float envDB = juce::Decibels::gainToDecibels(envelopeLevel, -100.0f);
        float targetDB = computeGain(envDB);
        float gr = targetDB - envDB;
        float gainLin = juce::Decibels::decibelsToGain(gr);
        peakGR = juce::jmin(peakGR, gr);

        float delayedL = lookaheadDelayL.popSample(0);
        float delayedR = dataR ? lookaheadDelayR.popSample(0) : delayedL;
        lookaheadDelayL.pushSample(0, dryL);
        if (dataR) lookaheadDelayR.pushSample(0, dryR);

        float mkLin = smoothedMakeup.getNextValue();
        float wetL = delayedL * gainLin * mkLin;
        float wetR = delayedR * gainLin * mkLin;

        dataL[i] = dryL * mixDry + wetL * mixWet;
        if (dataR) dataR[i] = dryR * mixDry + wetR * mixWet;
    }

    smoothedMakeup.setTargetValue(juce::Decibels::decibelsToGain(juce::jlimit(0.0f, 36.0f, makeupGain.load())));
    gainReductionDB.store(peakGR);

    float outputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        outputPeak = juce::jmax(outputPeak, buffer.getMagnitude(ch, 0, numSamples));
    outputLevelDB.store(juce::Decibels::gainToDecibels(outputPeak, -100.0f));
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
    state.setProperty("mix", mix.load(), nullptr);
    state.setProperty("style", style.load(), nullptr);
    state.setProperty("autoMakeup", autoMakeup.load(), nullptr);
    state.setProperty("autoRelease", autoRelease.load(), nullptr);
    state.setProperty("sidechainHPF", sidechainHPF.load(), nullptr);
    state.setProperty("lookahead", lookaheadMs.load(), nullptr);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Compressor::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Compressor") return;

    threshold.store(static_cast<float>(state.getProperty("threshold", 0.0f)));
    ratio.store(static_cast<float>(state.getProperty("ratio", 1.0f)));
    attack.store(static_cast<float>(state.getProperty("attack", 10.0f)));
    release.store(static_cast<float>(state.getProperty("release", 100.0f)));
    knee.store(static_cast<float>(state.getProperty("knee", 0.0f)));
    makeupGain.store(static_cast<float>(state.getProperty("makeupGain", 0.0f)));
    mix.store(static_cast<float>(state.getProperty("mix", 1.0f)));
    style.store(static_cast<float>(state.getProperty("style", 0.0f)));
    autoMakeup.store(static_cast<float>(state.getProperty("autoMakeup", 0.0f)));
    autoRelease.store(static_cast<float>(state.getProperty("autoRelease", 0.0f)));
    sidechainHPF.store(static_cast<float>(state.getProperty("sidechainHPF", 20.0f)));
    lookaheadMs.store(static_cast<float>(state.getProperty("lookahead", 0.0f)));
}

//==============================================================================
//  S13Gate -- Noise gate with hysteresis and sidechain filter
//==============================================================================

S13Gate::S13Gate() {}

void S13Gate::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    envelopeLevel = 0.0f;
    holdCounter = 0;
    currentGain = 0.0f;

    auto hpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, 20.0f);
    scHPF_L.coefficients = hpfCoeffs;  scHPF_R.coefficients = hpfCoeffs;
    scHPF_L.reset(); scHPF_R.reset();

    auto lpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, 20000.0f);
    scLPF_L.coefficients = lpfCoeffs;  scLPF_R.coefficients = lpfCoeffs;
    scLPF_L.reset(); scLPF_R.reset();

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
    if (sr <= 0.0) return;
    const float srf = static_cast<float>(sr);

    attackCoeff  = std::exp(-1.0f / (juce::jlimit(0.01f, 50.0f, attackMs.load()) * 0.001f * srf));
    releaseCoeff = std::exp(-1.0f / (juce::jlimit(5.0f, 2000.0f, releaseMs.load()) * 0.001f * srf));
    holdSamples  = static_cast<int>(juce::jlimit(0.0f, 500.0f, holdMs.load()) * 0.001f * srf);

    float threshDB = juce::jlimit(-80.0f, 0.0f, threshold.load());
    thresholdLinear = juce::Decibels::decibelsToGain(threshDB);
    closeThresholdLinear = juce::Decibels::decibelsToGain(threshDB - juce::jlimit(0.0f, 20.0f, hysteresis.load()));
    rangeGain = juce::Decibels::decibelsToGain(juce::jlimit(-80.0f, 0.0f, range.load()));

    float hpfFreq = juce::jlimit(20.0f, 2000.0f, sidechainHPF.load());
    scHPF_L.coefficients = juce::dsp::IIR::Coefficients<float>::makeHighPass(sr, hpfFreq);
    scHPF_R.coefficients = scHPF_L.coefficients;

    float lpfFreq = juce::jlimit(200.0f, 20000.0f, sidechainLPF.load());
    scLPF_L.coefficients = juce::dsp::IIR::Coefficients<float>::makeLowPass(sr, lpfFreq);
    scLPF_R.coefficients = scLPF_L.coefficients;
}

void S13Gate::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;
    updateCoefficients();

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    const float mixWet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float mixDry = 1.0f - mixWet;

    const float envAttack  = 0.9995f;
    const float envRelease = 0.9999f;
    float peakGR = 0.0f;

    for (int i = 0; i < numSamples; ++i)
    {
        float inputLevel = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float s = buffer.getSample(ch, i);
            s = (ch == 0) ? scLPF_L.processSample(scHPF_L.processSample(s))
                          : scLPF_R.processSample(scHPF_R.processSample(s));
            inputLevel = juce::jmax(inputLevel, std::abs(s));
        }

        if (inputLevel > envelopeLevel)
            envelopeLevel = envAttack * envelopeLevel + (1.0f - envAttack) * inputLevel;
        else
            envelopeLevel = envRelease * envelopeLevel + (1.0f - envRelease) * inputLevel;

        float targetGain;
        if (gateOpen.load())
        {
            if (envelopeLevel >= closeThresholdLinear) { targetGain = 1.0f; holdCounter = holdSamples; }
            else if (holdCounter > 0) { targetGain = 1.0f; --holdCounter; }
            else { targetGain = rangeGain; gateOpen.store(false); }
        }
        else
        {
            if (envelopeLevel >= thresholdLinear) { targetGain = 1.0f; holdCounter = holdSamples; gateOpen.store(true); }
            else targetGain = rangeGain;
        }

        if (targetGain > currentGain)
            currentGain = attackCoeff * currentGain + (1.0f - attackCoeff) * targetGain;
        else
            currentGain = releaseCoeff * currentGain + (1.0f - releaseCoeff) * targetGain;

        peakGR = juce::jmin(peakGR, juce::Decibels::gainToDecibels(currentGain, -100.0f));

        for (int ch = 0; ch < numChannels; ++ch)
        {
            float d = buffer.getSample(ch, i);
            buffer.setSample(ch, i, d * mixDry + d * currentGain * mixWet);
        }
    }
    gainReductionDB.store(peakGR);
}

void S13Gate::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Gate");
    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("attack", attackMs.load(), nullptr);
    state.setProperty("hold", holdMs.load(), nullptr);
    state.setProperty("release", releaseMs.load(), nullptr);
    state.setProperty("range", range.load(), nullptr);
    state.setProperty("hysteresis", hysteresis.load(), nullptr);
    state.setProperty("sidechainHPF", sidechainHPF.load(), nullptr);
    state.setProperty("sidechainLPF", sidechainLPF.load(), nullptr);
    state.setProperty("mix", mix.load(), nullptr);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Gate::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Gate") return;

    threshold.store(static_cast<float>(state.getProperty("threshold", -40.0f)));
    attackMs.store(static_cast<float>(state.getProperty("attack", 1.0f)));
    holdMs.store(static_cast<float>(state.getProperty("hold", 50.0f)));
    releaseMs.store(static_cast<float>(state.getProperty("release", 50.0f)));
    range.store(static_cast<float>(state.getProperty("range", -80.0f)));
    hysteresis.store(static_cast<float>(state.getProperty("hysteresis", 0.0f)));
    sidechainHPF.store(static_cast<float>(state.getProperty("sidechainHPF", 20.0f)));
    sidechainLPF.store(static_cast<float>(state.getProperty("sidechainLPF", 20000.0f)));
    mix.store(static_cast<float>(state.getProperty("mix", 1.0f)));
    updateCoefficients();
}

//==============================================================================
//  S13Limiter -- Brickwall limiter with ceiling
//==============================================================================

S13Limiter::S13Limiter() {}

void S13Limiter::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2u };

    limiter.prepare(spec);
    limiter.setThreshold(threshold.load());
    limiter.setRelease(juce::jmax(10.0f, releaseMs.load()));

    smoothedCeiling.reset(sampleRate, 0.02);
    smoothedCeiling.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(ceiling.load()));

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
}

void S13Limiter::releaseResources() { limiter.reset(); }

void S13Limiter::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    float inputPeak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        inputPeak = juce::jmax(inputPeak, buffer.getMagnitude(ch, 0, buffer.getNumSamples()));

    limiter.setThreshold(juce::jlimit(-20.0f, 0.0f, threshold.load()));
    limiter.setRelease(juce::jlimit(10.0f, 500.0f, releaseMs.load()));

    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    limiter.process(context);

    float ceilingDB = juce::jlimit(-3.0f, 0.0f, ceiling.load());
    float targetCeiling = juce::Decibels::decibelsToGain(ceilingDB);
    smoothedCeiling.setTargetValue(targetCeiling);

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();

    if (smoothedCeiling.isSmoothing())
    {
        for (int i = 0; i < numSamples; ++i)
        {
            float g = smoothedCeiling.getNextValue();
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.setSample(ch, i, buffer.getSample(ch, i) * g);
        }
    }
    else
    {
        float g = smoothedCeiling.getTargetValue();
        if (std::abs(g - 1.0f) > 0.0001f)
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.applyGain(ch, 0, numSamples, g);
    }

    // Hard clip
    for (int ch = 0; ch < numChannels; ++ch)
    {
        float* d = buffer.getWritePointer(ch);
        juce::FloatVectorOperations::clip(d, d, -targetCeiling, targetCeiling, numSamples);
    }

    // GR metering
    float outputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        outputPeak = juce::jmax(outputPeak, buffer.getMagnitude(ch, 0, numSamples));
    float inDB = juce::Decibels::gainToDecibels(inputPeak, -100.0f);
    float outDB = juce::Decibels::gainToDecibels(outputPeak, -100.0f);
    gainReductionDB.store(outDB - inDB);
}

void S13Limiter::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Limiter");
    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("release", releaseMs.load(), nullptr);
    state.setProperty("ceiling", ceiling.load(), nullptr);
    state.setProperty("lookahead", lookaheadMs.load(), nullptr);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Limiter::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Limiter") return;

    threshold.store(static_cast<float>(state.getProperty("threshold", -1.0f)));
    releaseMs.store(static_cast<float>(state.getProperty("release", 100.0f)));
    ceiling.store(static_cast<float>(state.getProperty("ceiling", 0.0f)));
    lookaheadMs.store(static_cast<float>(state.getProperty("lookahead", 5.0f)));
}
