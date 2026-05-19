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

static void sanitizeBuiltInBuffer(juce::AudioBuffer<float>& buffer, float limit)
{
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        auto* samples = buffer.getWritePointer(ch);
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
        {
            const float value = samples[sample];
            samples[sample] = std::isfinite(value) ? juce::jlimit(-limit, limit, value) : 0.0f;
        }
    }
}

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
        bands[i].dynamicEnabled.store(0.0f);
        bands[i].dynamicThreshold.store(-24.0f);
        bands[i].dynamicRange.store(0.0f);
        bands[i].dynamicAttack.store(10.0f);
        bands[i].dynamicRelease.store(150.0f);
        dynamicEnvelope[static_cast<size_t>(i)] = 0.0f;
        dynamicGainDB[static_cast<size_t>(i)].store(0.0f);
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

    juce::dsp::ProcessSpec monoSpec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 1u };
    for (int b = 0; b < numBands; ++b)
    {
        for (int s = 0; s < maxStagesPerBand; ++s)
            bandFilters[b][s].prepare(spec);
        for (int ch = 0; ch < 2; ++ch)
        dynamicDetectorFilters[b][ch].prepare(monoSpec);
        dynamicEnvelope[static_cast<size_t>(b)] = 0.0f;
        dynamicGainDB[static_cast<size_t>(b)].store(0.0f, std::memory_order_relaxed);
        cachedBandStates[static_cast<size_t>(b)].valid = false;
        cachedDynamicDetectorStates[static_cast<size_t>(b)].valid = false;
    }

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
    msScratch.setSize(1, samplesPerBlock, false, false, true);
    msScratch.clear();
    lastProcessingMode = 0;

    fftWritePos = 0;
    fftBlockCounter = 0;
    updateFilters();
}

void S13EQ::releaseResources()
{
    for (int b = 0; b < numBands; ++b)
    {
        for (int s = 0; s < maxStagesPerBand; ++s)
            bandFilters[b][s].reset();
        for (int ch = 0; ch < 2; ++ch)
        dynamicDetectorFilters[b][ch].reset();
        dynamicEnvelope[static_cast<size_t>(b)] = 0.0f;
        dynamicGainDB[static_cast<size_t>(b)].store(0.0f, std::memory_order_relaxed);
        cachedBandStates[static_cast<size_t>(b)].valid = false;
        cachedDynamicDetectorStates[static_cast<size_t>(b)].valid = false;
    }
    smoothedAutoGainDB = 0.0f;
    msScratch.setSize(0, 0);
    lastProcessingMode = 0;
}

void S13EQ::updateBand(int b)
{
    const double sr = cachedSampleRate;
    if (sr <= 0.0) return;

    const float nyquist = static_cast<float>(sr * 0.5) - 1.0f;
    const auto type = static_cast<FilterType>(static_cast<int>(bands[b].type.load()));
    const auto slope = static_cast<FilterSlope>(static_cast<int>(bands[b].slope.load()));
    const float freq = juce::jlimit(20.0f, nyquist, bands[b].freq.load());
    const float baseGainDB = bands[b].gain.load(std::memory_order_relaxed);
    const float dynamicDB = dynamicGainDB[static_cast<size_t>(b)].load(std::memory_order_relaxed);
    const float gainDB = juce::jlimit(-30.0f, 30.0f, baseGainDB + dynamicDB);
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
    {
        auto& cached = cachedBandStates[static_cast<size_t>(b)];
        const float enabled = bands[b].enabled.load(std::memory_order_relaxed) >= 0.5f ? 1.0f : 0.0f;
        const int type = static_cast<int>(bands[b].type.load(std::memory_order_relaxed));
        const float freq = bands[b].freq.load(std::memory_order_relaxed);
        const float baseGain = bands[b].gain.load(std::memory_order_relaxed);
        const float dynamicGain = dynamicGainDB[static_cast<size_t>(b)].load(std::memory_order_relaxed);
        const float gain = juce::jlimit(-30.0f, 30.0f, baseGain + dynamicGain);
        const float q = bands[b].q.load(std::memory_order_relaxed);
        const int slope = static_cast<int>(bands[b].slope.load(std::memory_order_relaxed));

        const bool changed = !cached.valid
                          || cached.enabled != enabled
                          || cached.type != type
                          || cached.slope != slope
                          || std::abs(cached.freq - freq) > 0.01f
                          || std::abs(cached.gain - gain) > 0.02f
                          || std::abs(cached.q - q) > 0.001f;
        if (!changed)
            continue;

        updateBand(b);
        cached.valid = true;
        cached.enabled = enabled;
        cached.type = type;
        cached.freq = freq;
        cached.gain = gain;
        cached.q = q;
        cached.slope = slope;
    }
}

void S13EQ::updateDynamicBands(const juce::AudioBuffer<float>& buffer)
{
    const int numSamples = buffer.getNumSamples();
    const int numChannels = juce::jmin(2, buffer.getNumChannels());
    const double sr = cachedSampleRate > 0.0 ? cachedSampleRate : 44100.0;

    if (numSamples <= 0 || numChannels <= 0)
        return;

    const float nyquist = static_cast<float>(sr * 0.5) - 1.0f;
    for (int b = 0; b < numBands; ++b)
    {
        const size_t bandIndex = static_cast<size_t>(b);
        const float rangeDB = juce::jlimit(-24.0f, 24.0f, bands[b].dynamicRange.load(std::memory_order_relaxed));
        const bool dynamicOn = bands[b].dynamicEnabled.load(std::memory_order_relaxed) >= 0.5f && std::abs(rangeDB) > 0.01f;
        if (!dynamicOn)
        {
            dynamicEnvelope[bandIndex] *= 0.85f;
            const float current = dynamicGainDB[bandIndex].load(std::memory_order_relaxed);
            dynamicGainDB[bandIndex].store(current * 0.85f, std::memory_order_relaxed);
            continue;
        }

        const float freq = juce::jlimit(20.0f, nyquist, bands[b].freq.load(std::memory_order_relaxed));
        const float q = juce::jlimit(0.1f, 30.0f, bands[b].q.load(std::memory_order_relaxed));
        auto& detectorCache = cachedDynamicDetectorStates[bandIndex];
        const bool detectorChanged = !detectorCache.valid
                                  || std::abs(detectorCache.freq - freq) > 0.01f
                                  || std::abs(detectorCache.q - q) > 0.001f;
        if (detectorChanged)
        {
            auto detectorCoeffs = juce::dsp::IIR::Coefficients<float>::makeBandPass(sr, freq, q);
            for (int ch = 0; ch < 2; ++ch)
                dynamicDetectorFilters[b][ch].coefficients = detectorCoeffs;
            detectorCache.valid = true;
            detectorCache.freq = freq;
            detectorCache.q = q;
        }

        float sumSquares = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            for (int ch = 0; ch < numChannels; ++ch)
            {
                const float filtered = dynamicDetectorFilters[b][ch].processSample(buffer.getSample(ch, i));
                sumSquares += filtered * filtered;
            }
        }

        const float blockLevel = std::sqrt(sumSquares / static_cast<float>(numSamples * numChannels));
        const float attackMs = juce::jlimit(0.2f, 250.0f, bands[b].dynamicAttack.load(std::memory_order_relaxed));
        const float releaseMs = juce::jlimit(5.0f, 2000.0f, bands[b].dynamicRelease.load(std::memory_order_relaxed));
        const float attackCoeff = std::exp(-static_cast<float>(numSamples) / (attackMs * 0.001f * static_cast<float>(sr)));
        const float releaseCoeff = std::exp(-static_cast<float>(numSamples) / (releaseMs * 0.001f * static_cast<float>(sr)));
        const float levelCoeff = blockLevel > dynamicEnvelope[bandIndex] ? attackCoeff : releaseCoeff;
        dynamicEnvelope[bandIndex] = levelCoeff * dynamicEnvelope[bandIndex] + (1.0f - levelCoeff) * blockLevel;

        const float levelDB = juce::Decibels::gainToDecibels(dynamicEnvelope[bandIndex], -100.0f);
        const float thresholdDB = juce::jlimit(-80.0f, 0.0f, bands[b].dynamicThreshold.load(std::memory_order_relaxed));
        const float activity = juce::jlimit(0.0f, 1.0f, (levelDB - thresholdDB) / 18.0f);
        const float targetDynamicDB = rangeDB * activity;
        const float currentDynamicDB = dynamicGainDB[bandIndex].load(std::memory_order_relaxed);
        const float gainCoeff = std::abs(targetDynamicDB) > std::abs(currentDynamicDB) ? attackCoeff : releaseCoeff;
        const float nextDynamicDB = gainCoeff * currentDynamicDB + (1.0f - gainCoeff) * targetDynamicDB;
        dynamicGainDB[bandIndex].store(juce::jlimit(-24.0f, 24.0f, nextDynamicDB), std::memory_order_relaxed);
    }
}

float S13EQ::estimateAutoGainCompensationDB() const
{
    static constexpr int probeCount = 16;
    const std::array<double, probeCount> probeFrequencies {
        31.5, 45.0, 63.0, 90.0, 125.0, 180.0, 250.0, 355.0,
        500.0, 710.0, 1000.0, 1400.0, 2000.0, 4000.0, 8000.0, 16000.0
    };

    std::array<float, probeCount> responseDB {};
    const int auditionIndex = juce::jlimit(-1, numBands - 1,
                                           static_cast<int>(std::round(auditionBand.load(std::memory_order_relaxed))) - 1);
    for (int b = 0; b < numBands; ++b)
    {
        if (auditionIndex >= 0 && b != auditionIndex)
            continue;
        if (auditionIndex < 0 && bands[b].enabled.load(std::memory_order_relaxed) < 0.5f)
            continue;

        for (int stage = 0; stage < activeStages[b]; ++stage)
        {
            auto coeffs = bandFilters[b][stage].state;
            if (coeffs == nullptr)
                continue;

            std::array<double, probeCount> magnitudes {};
            coeffs->getMagnitudeForFrequencyArray(probeFrequencies.data(),
                                                   magnitudes.data(),
                                                   probeFrequencies.size(),
                                                   cachedSampleRate);
            for (int i = 0; i < probeCount; ++i)
                responseDB[static_cast<size_t>(i)] += juce::Decibels::gainToDecibels(static_cast<float>(magnitudes[static_cast<size_t>(i)]), -48.0f);
        }
    }

    float weightedSum = 0.0f;
    float weightTotal = 0.0f;
    for (int i = 0; i < probeCount; ++i)
    {
        const float frequency = static_cast<float>(probeFrequencies[static_cast<size_t>(i)]);
        const float presenceWeight = frequency >= 125.0f && frequency <= 8000.0f ? 1.0f : 0.45f;
        weightedSum += responseDB[static_cast<size_t>(i)] * presenceWeight;
        weightTotal += presenceWeight;
    }

    if (weightTotal <= 0.0f)
        return 0.0f;

    return juce::jlimit(-9.0f, 9.0f, -weightedSum / weightTotal);
}

void S13EQ::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;
    updateDynamicBands(buffer);
    updateFilters();

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    const int requestedMode = juce::jlimit(0, 2, static_cast<int>(std::round(stereoMode.load(std::memory_order_relaxed))));
    const bool useMidSideMode = requestedMode > 0
                             && numChannels >= 2
                             && msScratch.getNumSamples() >= numSamples;
    if (requestedMode != lastProcessingMode)
    {
        for (int b = 0; b < numBands; ++b)
            for (int s = 0; s < maxStagesPerBand; ++s)
                bandFilters[b][s].reset();
        lastProcessingMode = requestedMode;
    }

    // Capture pre-EQ samples for spectrum
    {
        const float* readPtr = buffer.getReadPointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            preEQBuffer[static_cast<size_t>(fftWritePos)] = readPtr[i];
            fftWritePos = (fftWritePos + 1) % fftSize;
        }
    }

    if (useMidSideMode)
    {
        auto* left = buffer.getWritePointer(0);
        auto* right = buffer.getWritePointer(1);
        auto* scratch = msScratch.getWritePointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            const float mid = (left[i] + right[i]) * 0.5f;
            const float side = (left[i] - right[i]) * 0.5f;
            if (requestedMode == 1)
            {
                left[i] = mid;
                scratch[i] = side;
            }
            else
            {
                left[i] = side;
                scratch[i] = mid;
            }
        }
    }

    // Process each enabled band
    juce::dsp::AudioBlock<float> block(buffer);
    auto processingBlock = useMidSideMode ? block.getSingleChannelBlock(0) : block;
    juce::dsp::ProcessContextReplacing<float> context(processingBlock);
    const int auditionIndex = juce::jlimit(-1, numBands - 1,
                                           static_cast<int>(std::round(auditionBand.load(std::memory_order_relaxed))) - 1);

    for (int b = 0; b < numBands; ++b)
    {
        if (auditionIndex >= 0 && b != auditionIndex)
            continue;
        if (auditionIndex < 0 && bands[b].enabled.load() < 0.5f)
            continue;
        for (int s = 0; s < activeStages[b]; ++s)
            bandFilters[b][s].process(context);
    }

    // Output gain
    float outGainDB = juce::jlimit(-12.0f, 12.0f, outputGain.load());
    if (autoGain.load(std::memory_order_relaxed) >= 0.5f)
    {
        const float targetAutoGainDB = estimateAutoGainCompensationDB();
        smoothedAutoGainDB += (targetAutoGainDB - smoothedAutoGainDB) * 0.08f;
        outGainDB += smoothedAutoGainDB;
    }
    else
    {
        smoothedAutoGainDB *= 0.92f;
        outGainDB += smoothedAutoGainDB;
    }
    outGainDB = juce::jlimit(-18.0f, 18.0f, outGainDB);
    if (std::abs(outGainDB) > 0.01f)
    {
        const float outGain = juce::Decibels::decibelsToGain(outGainDB);
        if (useMidSideMode)
            buffer.applyGain(0, 0, numSamples, outGain);
        else
            buffer.applyGain(outGain);
    }

    if (useMidSideMode)
    {
        auto* left = buffer.getWritePointer(0);
        auto* right = buffer.getWritePointer(1);
        auto* scratch = msScratch.getWritePointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            const float target = left[i];
            const float stored = scratch[i];
            const float mid = requestedMode == 1 ? target : stored;
            const float side = requestedMode == 1 ? stored : target;
            left[i] = mid + side;
            right[i] = mid - side;
        }
    }
    sanitizeBuiltInBuffer(buffer, 2.5f);

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
    const int auditionIndex = juce::jlimit(-1, numBands - 1,
                                           static_cast<int>(std::round(auditionBand.load(std::memory_order_relaxed))) - 1);
    for (int b = 0; b < numBands; ++b)
    {
        if (auditionIndex >= 0 && b != auditionIndex) continue;
        if (auditionIndex < 0 && bands[b].enabled.load() < 0.5f) continue;
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

float S13EQ::getBandDynamicGainDB(int bandIndex) const
{
    if (bandIndex < 0 || bandIndex >= numBands)
        return 0.0f;
    return dynamicGainDB[static_cast<size_t>(bandIndex)].load(std::memory_order_relaxed);
}

void S13EQ::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13EQ");
    state.setProperty("outputGain", outputGain.load(), nullptr);
    state.setProperty("autoGain", autoGain.load(), nullptr);
    state.setProperty("auditionBand", auditionBand.load(), nullptr);
    state.setProperty("stereoMode", stereoMode.load(), nullptr);
    for (int i = 0; i < numBands; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        state.setProperty(p + "enabled", bands[i].enabled.load(), nullptr);
        state.setProperty(p + "type", bands[i].type.load(), nullptr);
        state.setProperty(p + "freq", bands[i].freq.load(), nullptr);
        state.setProperty(p + "gain", bands[i].gain.load(), nullptr);
        state.setProperty(p + "q", bands[i].q.load(), nullptr);
        state.setProperty(p + "slope", bands[i].slope.load(), nullptr);
        state.setProperty(p + "dynamicEnabled", bands[i].dynamicEnabled.load(), nullptr);
        state.setProperty(p + "dynamicThreshold", bands[i].dynamicThreshold.load(), nullptr);
        state.setProperty(p + "dynamicRange", bands[i].dynamicRange.load(), nullptr);
        state.setProperty(p + "dynamicAttack", bands[i].dynamicAttack.load(), nullptr);
        state.setProperty(p + "dynamicRelease", bands[i].dynamicRelease.load(), nullptr);
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
    auditionBand.store(static_cast<float>(state.getProperty("auditionBand", 0.0f)));
    stereoMode.store(static_cast<float>(state.getProperty("stereoMode", 0.0f)));
    for (int i = 0; i < numBands; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        bands[i].enabled.store(static_cast<float>(state.getProperty(p + "enabled", 1.0f)));
        bands[i].type.store(static_cast<float>(state.getProperty(p + "type", 0.0f)));
        bands[i].freq.store(static_cast<float>(state.getProperty(p + "freq", 1000.0f)));
        bands[i].gain.store(static_cast<float>(state.getProperty(p + "gain", 0.0f)));
        bands[i].q.store(static_cast<float>(state.getProperty(p + "q", 1.0f)));
        bands[i].slope.store(static_cast<float>(state.getProperty(p + "slope", 1.0f)));
        bands[i].dynamicEnabled.store(static_cast<float>(state.getProperty(p + "dynamicEnabled", 0.0f)));
        bands[i].dynamicThreshold.store(static_cast<float>(state.getProperty(p + "dynamicThreshold", -24.0f)));
        bands[i].dynamicRange.store(static_cast<float>(state.getProperty(p + "dynamicRange", 0.0f)));
        bands[i].dynamicAttack.store(static_cast<float>(state.getProperty(p + "dynamicAttack", 10.0f)));
        bands[i].dynamicRelease.store(static_cast<float>(state.getProperty(p + "dynamicRelease", 150.0f)));
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
    rmsEnvelopeLevel = 0.0f;
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
    rmsEnvelopeLevel = 0.0f;
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
    const float releaseScale = autoRelease.load(std::memory_order_relaxed) >= 0.5f
        ? juce::jlimit(0.65f, 3.5f, 1.0f + std::abs(gainReductionDB.load(std::memory_order_relaxed)) / 12.0f)
        : 1.0f;
    const float releaseCoeff = std::exp(-1.0f / (relMs * releaseScale * 0.001f * srf));
    const float rmsCoeff = std::exp(-1.0f / (0.025f * srf));
    const int detector = juce::jlimit(0, 2, static_cast<int>(std::round(detectorMode.load(std::memory_order_relaxed))));
    const float link = juce::jlimit(0.0f, 1.0f, stereoLink.load(std::memory_order_relaxed));

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
        const float linkedPeak = juce::jmax(std::abs(scL), std::abs(scR));
        const float averagePeak = (std::abs(scL) + std::abs(scR)) * 0.5f;
        const float peakLevel = averagePeak + (linkedPeak - averagePeak) * link;
        const float rmsInput = dataR ? (scL * scL + scR * scR) * 0.5f : scL * scL;
        rmsEnvelopeLevel = rmsCoeff * rmsEnvelopeLevel + (1.0f - rmsCoeff) * rmsInput;
        const float rmsLevel = std::sqrt(juce::jmax(0.0f, rmsEnvelopeLevel));
        const float scLevel = detector == 1
            ? rmsLevel
            : (detector == 2 ? juce::jmax(rmsLevel, peakLevel * 0.72f) : peakLevel);

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

    const float targetMakeupDB = autoMakeup.load(std::memory_order_relaxed) >= 0.5f
        ? juce::jlimit(0.0f, 18.0f, std::abs(peakGR) * 0.5f)
        : juce::jlimit(0.0f, 36.0f, makeupGain.load(std::memory_order_relaxed));
    smoothedMakeup.setTargetValue(juce::Decibels::decibelsToGain(targetMakeupDB));
    gainReductionDB.store(peakGR);
    sanitizeBuiltInBuffer(buffer, 2.5f);

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
    state.setProperty("detectorMode", detectorMode.load(), nullptr);
    state.setProperty("stereoLink", stereoLink.load(), nullptr);
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
    detectorMode.store(static_cast<float>(state.getProperty("detectorMode", 0.0f)));
    stereoLink.store(static_cast<float>(state.getProperty("stereoLink", 1.0f)));
}

//==============================================================================
//  S13Gate -- Noise gate with hysteresis and sidechain filter
//==============================================================================

S13Gate::S13Gate() {}

void S13Gate::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    envelopeLevel = 0.0f;
    rmsEnvelopeLevel = 0.0f;
    holdCounter = 0;
    currentGain = 0.0f;
    lastSidechainHPF = -1.0f;
    lastSidechainLPF = -1.0f;

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
    rmsEnvelopeLevel = 0.0f;
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
    if (lastSidechainHPF < 0.0f || std::abs(hpfFreq - lastSidechainHPF) > 1.0f)
    {
        lastSidechainHPF = hpfFreq;
        scHPF_L.coefficients = juce::dsp::IIR::Coefficients<float>::makeHighPass(sr, hpfFreq);
        scHPF_R.coefficients = scHPF_L.coefficients;
    }

    float lpfFreq = juce::jlimit(200.0f, 20000.0f, sidechainLPF.load());
    if (lastSidechainLPF < 0.0f || std::abs(lpfFreq - lastSidechainLPF) > 8.0f)
    {
        lastSidechainLPF = lpfFreq;
        scLPF_L.coefficients = juce::dsp::IIR::Coefficients<float>::makeLowPass(sr, lpfFreq);
        scLPF_R.coefficients = scLPF_L.coefficients;
    }
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
    const float rmsCoeff = std::exp(-1.0f / (0.018f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const int detector = juce::jlimit(0, 2, static_cast<int>(std::round(detectorMode.load(std::memory_order_relaxed))));
    float peakGR = 0.0f;

    for (int i = 0; i < numSamples; ++i)
    {
        float peakLevel = 0.0f;
        float rmsSum = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float s = buffer.getSample(ch, i);
            s = (ch == 0) ? scLPF_L.processSample(scHPF_L.processSample(s))
                          : scLPF_R.processSample(scHPF_R.processSample(s));
            peakLevel = juce::jmax(peakLevel, std::abs(s));
            rmsSum += s * s;
        }
        rmsEnvelopeLevel = rmsCoeff * rmsEnvelopeLevel
                         + (1.0f - rmsCoeff) * (rmsSum / static_cast<float>(juce::jmax(1, numChannels)));
        const float rmsLevel = std::sqrt(juce::jmax(0.0f, rmsEnvelopeLevel));
        const float inputLevel = detector == 1
            ? rmsLevel
            : (detector == 2 ? juce::jmax(rmsLevel, peakLevel * 0.7f) : peakLevel);

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
    sanitizeBuiltInBuffer(buffer, 2.5f);
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
    state.setProperty("detectorMode", detectorMode.load(), nullptr);
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
    detectorMode.store(static_cast<float>(state.getProperty("detectorMode", 0.0f)));
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

    const int maxLookaheadSamples = static_cast<int>(std::ceil(sampleRate * 0.02)) + juce::jmax(samplesPerBlock, 1) + 8;
    lookaheadBuffer.setSize(2, juce::jmax(16, maxLookaheadSamples), false, false, true);
    truePeakScratch.setSize(2, juce::jmax(1, samplesPerBlock), false, false, true);
    lookaheadBuffer.clear();
    truePeakScratch.clear();
    lookaheadWriteIndex = 0;
    gainEnvelope = 1.0f;
    previousDetectorSample.fill(0.0f);

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 2, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
}

void S13Limiter::releaseResources()
{
    limiter.reset();
    lookaheadBuffer.clear();
    truePeakScratch.clear();
    lookaheadWriteIndex = 0;
    gainEnvelope = 1.0f;
    previousDetectorSample.fill(0.0f);
}

void S13Limiter::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    float inputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        inputPeak = juce::jmax(inputPeak, buffer.getMagnitude(ch, 0, numSamples));
    float truePeakScale = 1.0f;
    if (oversampler != nullptr
        && numChannels <= truePeakScratch.getNumChannels()
        && numSamples <= truePeakScratch.getNumSamples())
    {
        truePeakScratch.clear();
        for (int ch = 0; ch < numChannels; ++ch)
            truePeakScratch.copyFrom(ch, 0, buffer, ch, 0, numSamples);

        juce::dsp::AudioBlock<float> scratchBlock(truePeakScratch);
        auto blockToScan = scratchBlock.getSubBlock(0, static_cast<size_t>(numSamples));
        auto oversampledBlock = oversampler->processSamplesUp(blockToScan);
        float oversampledPeak = 0.0f;
        for (size_t ch = 0; ch < oversampledBlock.getNumChannels(); ++ch)
        {
            auto* channelData = oversampledBlock.getChannelPointer(ch);
            for (size_t sample = 0; sample < oversampledBlock.getNumSamples(); ++sample)
                oversampledPeak = juce::jmax(oversampledPeak, std::abs(channelData[sample]));
        }
        oversampler->processSamplesDown(blockToScan);
        if (inputPeak > 1.0e-6f && oversampledPeak > inputPeak)
            truePeakScale = juce::jlimit(1.0f, 3.0f, oversampledPeak / inputPeak);
    }

    const float srf = static_cast<float>(juce::jmax(1.0, cachedSampleRate));
    const float thresholdGain = juce::Decibels::decibelsToGain(juce::jlimit(-20.0f, 0.0f, threshold.load(std::memory_order_relaxed)));
    const float ceilingDB = juce::jlimit(-3.0f, 0.0f, ceiling.load(std::memory_order_relaxed));
    const float targetCeiling = juce::Decibels::decibelsToGain(ceilingDB);
    const float limitGain = juce::jmin(thresholdGain, targetCeiling);
    const float releaseCoeff = std::exp(-1.0f / (juce::jlimit(10.0f, 500.0f, releaseMs.load(std::memory_order_relaxed)) * 0.001f * srf));
    const int ringSize = lookaheadBuffer.getNumSamples();
    const int delaySamples = juce::jlimit(0, ringSize > 1 ? ringSize - 1 : 0,
                                         static_cast<int>(std::round(juce::jlimit(0.0f, 20.0f, lookaheadMs.load(std::memory_order_relaxed)) * 0.001f * srf)));
    smoothedCeiling.setTargetValue(targetCeiling);

    float peakGain = 1.0f;
    for (int i = 0; i < numSamples; ++i)
    {
        float detectorPeak = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const float sample = buffer.getSample(ch, i);
            const int detectorChannel = juce::jmin(ch, static_cast<int>(previousDetectorSample.size()) - 1);
            const float previous = previousDetectorSample[static_cast<size_t>(detectorChannel)];
            const float midpointEstimate = std::abs((sample + previous) * 0.5f) + std::abs(sample - previous) * 0.25f;
            detectorPeak = juce::jmax(detectorPeak, std::abs(sample), midpointEstimate);
            previousDetectorSample[static_cast<size_t>(detectorChannel)] = sample;
        }
        detectorPeak *= truePeakScale;

        const float targetGain = detectorPeak > limitGain && detectorPeak > 1.0e-8f
            ? juce::jlimit(0.0f, 1.0f, limitGain / detectorPeak)
            : 1.0f;

        if (targetGain < gainEnvelope)
            gainEnvelope = targetGain;
        else
            gainEnvelope = releaseCoeff * gainEnvelope + (1.0f - releaseCoeff) * targetGain;
        peakGain = juce::jmin(peakGain, gainEnvelope);

        for (int ch = 0; ch < numChannels; ++ch)
            lookaheadBuffer.setSample(ch, lookaheadWriteIndex, buffer.getSample(ch, i));

        int readIndex = lookaheadWriteIndex - delaySamples;
        if (readIndex < 0)
            readIndex += ringSize;

        const float ceilingForSample = smoothedCeiling.getNextValue();
        const float ceilingScale = gainEnvelope < 0.9999f
            ? ceilingForSample / juce::jmax(1.0e-6f, limitGain)
            : 1.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float limited = lookaheadBuffer.getSample(ch, readIndex) * gainEnvelope * ceilingScale;
            const float absLimited = std::abs(limited);
            const float kneeStart = ceilingForSample * 0.98f;
            if (absLimited > kneeStart)
            {
                const float sign = limited >= 0.0f ? 1.0f : -1.0f;
                const float kneeWidth = juce::jmax(ceilingForSample - kneeStart, 1.0e-6f);
                const float x = juce::jmax(0.0f, (absLimited - kneeStart) / kneeWidth);
                const float curved = kneeStart + kneeWidth * (1.0f - 1.0f / (1.0f + x));
                limited = sign * juce::jmin(ceilingForSample, curved);
            }
            buffer.setSample(ch, i, limited);
        }

        lookaheadWriteIndex = (lookaheadWriteIndex + 1) % ringSize;
    }

    // GR metering
    sanitizeBuiltInBuffer(buffer, 1.25f);
    float outputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        outputPeak = juce::jmax(outputPeak, buffer.getMagnitude(ch, 0, numSamples));
    float inDB = juce::Decibels::gainToDecibels(inputPeak, -100.0f);
    float outDB = juce::Decibels::gainToDecibels(outputPeak, -100.0f);
    gainReductionDB.store(juce::jmin(outDB - inDB, juce::Decibels::gainToDecibels(peakGain, -100.0f)));
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
