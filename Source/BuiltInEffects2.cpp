#include "BuiltInEffects2.h"
#include "S13PluginEditors.h"

juce::AudioProcessorEditor* S13Delay::createEditor() { return new S13DelayEditor(*this); }
juce::AudioProcessorEditor* S13Reverb::createEditor() { return new S13ReverbEditor(*this); }
juce::AudioProcessorEditor* S13Chorus::createEditor() { return new S13ChorusEditor(*this); }
juce::AudioProcessorEditor* S13Saturator::createEditor() { return new S13SaturatorEditor(*this); }

// ============================================================================
// Helper: save/load parameters via ValueTree
// ============================================================================
namespace
{
    float builtinNoise(int age, int note)
    {
        const float x = static_cast<float>(age * 1103515245u + note * 12345u);
        return std::sin(x * 0.0000137f) * std::sin(x * 0.000091f);
    }

    float drumBaseFrequency(int note)
    {
        switch (note)
        {
            case 35:
            case 36: return 52.0f;
            case 37:
            case 38:
            case 40: return 190.0f;
            case 41: return 82.0f;
            case 43: return 98.0f;
            case 45: return 123.0f;
            case 47: return 146.0f;
            case 48: return 164.0f;
            case 50: return 196.0f;
            default: return 440.0f;
        }
    }

    float drumDecaySeconds(int note, float pedalClosed)
    {
        switch (note)
        {
            case 35:
            case 36: return 0.42f;
            case 37:
            case 38:
            case 40: return 0.24f;
            case 42: return 0.045f + pedalClosed * 0.03f;
            case 44: return 0.08f;
            case 46: return 0.18f + (1.0f - pedalClosed) * 0.62f;
            case 49:
            case 52:
            case 55:
            case 57: return 1.55f;
            case 51:
            case 53:
            case 59: return 1.15f;
            default: return note >= 41 && note <= 50 ? 0.42f : 0.28f;
        }
    }

    float drumPanPosition(int note)
    {
        switch (note)
        {
            case 35:
            case 36: return 0.0f;
            case 37:
            case 38:
            case 40: return -0.08f;
            case 41: return 0.34f;
            case 43: return 0.22f;
            case 45: return 0.05f;
            case 47:
            case 48:
            case 50: return -0.22f;
            case 42:
            case 44:
            case 46: return 0.46f;
            case 49:
            case 55:
            case 57: return -0.58f;
            case 51:
            case 52:
            case 53:
            case 59: return 0.54f;
            default: return 0.0f;
        }
    }

    void sanitizeBuiltInBuffer(juce::AudioBuffer<float>& buffer, float limit)
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

    struct BuiltInMidiVoiceRef
    {
        size_t channel = 0;
        size_t note = 0;
    };

    constexpr size_t kBuiltInMidiVoiceSlots = 16u * 128u;

    float softLimitInstrumentBus(float value)
    {
        value = juce::jlimit(-4.0f, 4.0f, value);
        return std::tanh(value * 1.05f) * 0.96f;
    }

    float nyquistFade(float frequency, float sampleRate)
    {
        const float fadeStart = sampleRate * 0.38f;
        const float fadeEnd = sampleRate * 0.48f;
        if (frequency <= fadeStart)
            return 1.0f;
        if (frequency >= fadeEnd)
            return 0.0f;

        const float normalized = (frequency - fadeStart) / juce::jmax(1.0f, fadeEnd - fadeStart);
        return 1.0f - normalized;
    }

    void saveParamsToMemory(juce::MemoryBlock& destData,
                           const juce::String& typeName,
                           const std::vector<std::pair<juce::String, float>>& params)
    {
        juce::ValueTree tree(typeName);
        for (const auto& p : params)
            tree.setProperty(p.first, static_cast<double>(p.second), nullptr);

        juce::MemoryOutputStream stream(destData, false);
        tree.writeToStream(stream);
    }

    juce::ValueTree loadParamsFromMemory(const void* data, int sizeInBytes,
                                         const juce::String& typeName)
    {
        juce::MemoryInputStream stream(data, static_cast<size_t>(sizeInBytes), false);
        auto tree = juce::ValueTree::readFromStream(stream);
        if (tree.isValid() && tree.getType() == juce::Identifier(typeName))
            return tree;
        return {};
    }
}

// ============================================================================
//  S13Delay
// ============================================================================

S13Delay::S13Delay()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13Delay::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 1;

    delayLineL.prepare(spec);
    delayLineR.prepare(spec);
    delayLineL.reset();
    delayLineR.reset();

    // Prepare feedback filters
    feedbackLPF_L.reset();
    feedbackLPF_R.reset();
    feedbackHPF_L.reset();
    feedbackHPF_R.reset();

    lastLPFFreq = juce::jlimit(200.0f, 20000.0f, lpfFreq.load());
    auto lpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastLPFFreq);
    feedbackLPF_L.coefficients = lpfCoeffs;
    feedbackLPF_R.coefficients = lpfCoeffs;

    lastHPFFreq = juce::jlimit(20.0f, 2000.0f, hpfFreq.load());
    auto hpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastHPFFreq);
    feedbackHPF_L.coefficients = hpfCoeffs;
    feedbackHPF_R.coefficients = hpfCoeffs;

    feedbackSampleL = 0.0f;
    feedbackSampleR = 0.0f;
    smoothedDelaySamplesL = static_cast<float>(0.25 * cachedSampleRate);
    smoothedDelaySamplesR = static_cast<float>(0.25 * cachedSampleRate);
    duckEnvelope = 0.0f;
    modulationPhase = 0.0f;
}

float S13Delay::syncNoteToMs(float noteIndex, double bpm)
{
    if (bpm <= 0.0)
        bpm = 120.0;

    const float quarterMs = static_cast<float>(60000.0 / bpm);

    // Matches the React schema: 1/1, 1/2, 1/4, 1/8, 1/16, 1/4T, 1/8T, 1/4D, 1/8D
    const int idx = juce::jlimit(0, 8, static_cast<int>(noteIndex));

    static const float baseMultipliers[] = {
        4.0f,         // 1/1
        2.0f,         // 1/2
        1.0f,         // 1/4
        0.5f,         // 1/8
        0.25f,        // 1/16
        2.0f / 3.0f,  // 1/4 triplet
        1.0f / 3.0f,  // 1/8 triplet
        1.5f,         // 1/4 dotted
        0.75f         // 1/8 dotted
    };

    return quarterMs * baseMultipliers[idx];
}

void S13Delay::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    // Update LPF if frequency changed
    const float currentLPFFreq = juce::jlimit(200.0f, 20000.0f, lpfFreq.load());
    if (std::abs(currentLPFFreq - lastLPFFreq) > 1.0f)
    {
        lastLPFFreq = currentLPFFreq;
        auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(cachedSampleRate, currentLPFFreq);
        feedbackLPF_L.coefficients = coeffs;
        feedbackLPF_R.coefficients = coeffs;
    }

    // Update HPF if frequency changed
    const float currentHPFFreq = juce::jlimit(20.0f, 2000.0f, hpfFreq.load());
    if (std::abs(currentHPFFreq - lastHPFFreq) > 1.0f)
    {
        lastHPFFreq = currentHPFFreq;
        auto coeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(cachedSampleRate, currentHPFFreq);
        feedbackHPF_L.coefficients = coeffs;
        feedbackHPF_R.coefficients = coeffs;
    }

    // Get BPM from playhead for tempo sync
    double bpm = 120.0;
    if (auto* ph = getPlayHead())
    {
        auto pos = ph->getPosition();
        if (pos.hasValue())
        {
            if (auto bpmVal = pos->getBpm())
                bpm = *bpmVal;
        }
    }

    // Compute delay times
    const bool isTempSync = tempoSync.load() >= 0.5f;
    float delayMsL, delayMsR;
    if (isTempSync)
    {
        delayMsL = syncNoteToMs(syncNoteL.load(), bpm);
        delayMsR = syncNoteToMs(syncNoteR.load(), bpm);
    }
    else
    {
        delayMsL = juce::jlimit(1.0f, 2000.0f, delayTimeL.load());
        delayMsR = juce::jlimit(1.0f, 2000.0f, delayTimeR.load());
    }

    const float delaySamplesL = static_cast<float>(delayMsL * 0.001 * cachedSampleRate);
    const float delaySamplesR = static_cast<float>(delayMsR * 0.001 * cachedSampleRate);
    const float fb = juce::jlimit(0.0f, 0.95f, feedback.load());
    const float xfeed = juce::jlimit(0.0f, 0.95f, crossFeed.load());
    const float wet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float dry = 1.0f - wet;
    const bool isPingPong = pingPong.load() >= 0.5f;
    const float satAmount = juce::jlimit(0.0f, 1.0f, fbSaturation.load());
    const float widthVal = juce::jlimit(0.0f, 2.0f, stereoWidth.load());
    const int modeVal = juce::jlimit(0, 2, static_cast<int>(delayMode.load()));
    const float duckAmount = juce::jlimit(0.0f, 1.0f, ducking.load());
    const float delaySmoothingCoeff = 1.0f - std::exp(-1.0f / (0.025f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const float duckAttack = 1.0f - std::exp(-1.0f / (0.008f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const float duckRelease = 1.0f - std::exp(-1.0f / (0.180f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const float modulationInc = 0.37f * juce::MathConstants<float>::twoPi / static_cast<float>(juce::jmax(1.0, cachedSampleRate));

    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        const float inL = dataL[i];
        const float inR = dataR ? dataR[i] : inL;
        const float inputLevel = juce::jmax(std::abs(inL), std::abs(inR));
        const float duckCoeff = inputLevel > duckEnvelope ? duckAttack : duckRelease;
        duckEnvelope += (inputLevel - duckEnvelope) * duckCoeff;
        const float duckGain = 1.0f - duckAmount * juce::jlimit(0.0f, 0.82f, duckEnvelope * 1.35f);

        smoothedDelaySamplesL += (delaySamplesL - smoothedDelaySamplesL) * delaySmoothingCoeff;
        smoothedDelaySamplesR += (delaySamplesR - smoothedDelaySamplesR) * delaySmoothingCoeff;
        float modulatedDelayL = smoothedDelaySamplesL;
        float modulatedDelayR = smoothedDelaySamplesR;
        if (modeVal == 1)
        {
            const float wowDepth = static_cast<float>(0.0018 * cachedSampleRate) * (0.25f + satAmount * 0.75f);
            modulatedDelayL += std::sin(modulationPhase) * wowDepth;
            modulatedDelayR += std::sin(modulationPhase + 1.73f) * wowDepth;
            modulationPhase += modulationInc;
            if (modulationPhase >= juce::MathConstants<float>::twoPi)
                modulationPhase -= juce::MathConstants<float>::twoPi;
        }

        // Read from delay lines
        delayLineL.setDelay(juce::jlimit(1.0f, static_cast<float>(maxDelaySamples - 1), modulatedDelayL));
        delayLineR.setDelay(juce::jlimit(1.0f, static_cast<float>(maxDelaySamples - 1), modulatedDelayR));

        const float delayedL = delayLineL.popSample(0);
        const float delayedR = delayLineR.popSample(0);

        // Process feedback through filters (LPF + HPF)
        float fbL = feedbackLPF_L.processSample(feedbackSampleL);
        fbL = feedbackHPF_L.processSample(fbL);
        float fbR = feedbackLPF_R.processSample(feedbackSampleR);
        fbR = feedbackHPF_R.processSample(fbR);

        // Apply feedback saturation
        if (satAmount > 0.001f)
        {
            // Blend between clean and saturated feedback
            float satL = std::tanh(fbL * (1.0f + satAmount * 3.0f));
            float satR = std::tanh(fbR * (1.0f + satAmount * 3.0f));
            fbL = fbL * (1.0f - satAmount) + satL * satAmount;
            fbR = fbR * (1.0f - satAmount) + satR * satAmount;
        }

        // Apply delay mode character
        // Mode 0: Digital (clean), Mode 1: Tape (slight wobble + saturation), Mode 2: Analog (warmth)
        if (modeVal == 1) // Tape
        {
            fbL = std::tanh(fbL * 1.1f) * 0.95f;
            fbR = std::tanh(fbR * 1.1f) * 0.95f;
        }
        else if (modeVal == 2) // Analog
        {
            fbL *= 0.97f;
            fbR *= 0.97f;
        }

        // Cross-feed: blend feedback between channels
        const float fbLMixed = fbL * (1.0f - xfeed) + fbR * xfeed;
        const float fbRMixed = fbR * (1.0f - xfeed) + fbL * xfeed;

        // Write to delay lines
        if (isPingPong)
        {
            delayLineL.pushSample(0, inL + fbRMixed * fb);
            delayLineR.pushSample(0, inR + fbLMixed * fb);
        }
        else
        {
            delayLineL.pushSample(0, inL + fbLMixed * fb);
            delayLineR.pushSample(0, inR + fbRMixed * fb);
        }

        // Store feedback samples
        feedbackSampleL = delayedL;
        feedbackSampleR = delayedR;

        // Apply stereo width to wet signal
        float wetL = delayedL;
        float wetR = delayedR;
        if (dataR && std::abs(widthVal - 1.0f) > 0.01f)
        {
            const float mid = (wetL + wetR) * 0.5f;
            const float side = (wetL - wetR) * 0.5f;
            wetL = mid + side * widthVal;
            wetR = mid - side * widthVal;
        }

        // Mix dry + wet
        dataL[i] = inL * dry + wetL * wet * duckGain;
        if (dataR)
            dataR[i] = inR * dry + wetR * wet * duckGain;
    }
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13Delay::releaseResources()
{
    delayLineL.reset();
    delayLineR.reset();
    feedbackLPF_L.reset();
    feedbackLPF_R.reset();
    feedbackHPF_L.reset();
    feedbackHPF_R.reset();
    feedbackSampleL = 0.0f;
    feedbackSampleR = 0.0f;
    duckEnvelope = 0.0f;
}

void S13Delay::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Delay", {
        { "delayTimeL",   delayTimeL.load() },
        { "delayTimeR",   delayTimeR.load() },
        { "feedback",     feedback.load() },
        { "crossFeed",    crossFeed.load() },
        { "mix",          mix.load() },
        { "pingPong",     pingPong.load() },
        { "tempoSync",    tempoSync.load() },
        { "syncNoteL",    syncNoteL.load() },
        { "syncNoteR",    syncNoteR.load() },
        { "lpfFreq",      lpfFreq.load() },
        { "hpfFreq",      hpfFreq.load() },
        { "fbSaturation", fbSaturation.load() },
        { "stereoWidth",  stereoWidth.load() },
        { "delayMode",    delayMode.load() },
        { "ducking",      ducking.load() }
    });
}

void S13Delay::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Delay");
    if (!tree.isValid())
        return;

    delayTimeL   = static_cast<float>((double)tree.getProperty("delayTimeL", 250.0));
    delayTimeR   = static_cast<float>((double)tree.getProperty("delayTimeR", 250.0));
    feedback     = static_cast<float>((double)tree.getProperty("feedback", 0.4));
    crossFeed    = static_cast<float>((double)tree.getProperty("crossFeed", 0.0));
    mix          = static_cast<float>((double)tree.getProperty("mix", 0.5));
    pingPong     = static_cast<float>((double)tree.getProperty("pingPong", 0.0));
    tempoSync    = static_cast<float>((double)tree.getProperty("tempoSync", 0.0));
    syncNoteL    = static_cast<float>((double)tree.getProperty("syncNoteL", 0.0));
    syncNoteR    = static_cast<float>((double)tree.getProperty("syncNoteR", 0.0));
    lpfFreq      = static_cast<float>((double)tree.getProperty("lpfFreq", 20000.0));
    hpfFreq      = static_cast<float>((double)tree.getProperty("hpfFreq", 20.0));
    fbSaturation = static_cast<float>((double)tree.getProperty("fbSaturation", 0.0));
    stereoWidth  = static_cast<float>((double)tree.getProperty("stereoWidth", 1.0));
    delayMode    = static_cast<float>((double)tree.getProperty("delayMode", 0.0));
    ducking      = static_cast<float>((double)tree.getProperty("ducking", 0.0));
}

bool S13Delay::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}


// ============================================================================
//  S13Reverb
// ============================================================================

S13Reverb::S13Reverb()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13Reverb::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2;

    reverb.prepare(spec);
    reverb.reset();

    // Prepare pre-delay lines
    juce::dsp::ProcessSpec monoSpec;
    monoSpec.sampleRate = sampleRate;
    monoSpec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    monoSpec.numChannels = 1;

    preDelayLineL.prepare(monoSpec);
    preDelayLineR.prepare(monoSpec);
    preDelayLineL.reset();
    preDelayLineR.reset();

    // Prepare wet tone filters
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();

    auto lcCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, 20.0f);
    wetLowCutL.coefficients = lcCoeffs;
    wetLowCutR.coefficients = lcCoeffs;

    auto hcCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, 20000.0f);
    wetHighCutL.coefficients = hcCoeffs;
    wetHighCutR.coefficients = hcCoeffs;
    lastLowCut = 20.0f;
    lastHighCut = 20000.0f;

    const int scratchChannels = juce::jmax(2, getTotalNumOutputChannels());
    const int scratchSamples = juce::jmax(samplesPerBlock, 16384);
    dryBuffer.setSize(scratchChannels, scratchSamples, false, false, true);
    earlyOutputBuffer.setSize(scratchChannels, scratchSamples, false, false, true);
    earlyReflectionBuffer.setSize(2, juce::jmax(samplesPerBlock + 8, static_cast<int>(std::ceil(sampleRate * 0.12))), false, false, true);
    earlyReflectionBuffer.clear();
    earlyReflectionWriteIndex = 0;
    lateTankBuffer.setSize(lateLineCount, juce::jmax(samplesPerBlock + 8, static_cast<int>(std::ceil(sampleRate * 2.5))), false, false, true);
    lateTankBuffer.clear();
    lateTankWriteIndex = 0;
    lateDampingState.fill(0.0f);
    shimmerSmootherL = 0.0f;
    shimmerSmootherR = 0.0f;
    for (size_t line = 0; line < lateModPhase.size(); ++line)
        lateModPhase[line] = static_cast<float>(line) * 0.77f;
}

void S13Reverb::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    const float preDelayMs = juce::jlimit(0.0f, 500.0f, preDelay.load());
    const float preDelaySamples = static_cast<float>(preDelayMs * 0.001 * cachedSampleRate);
    const float lc = juce::jlimit(20.0f, 500.0f, lowCut.load());
    const float hc = juce::jlimit(1000.0f, 20000.0f, highCut.load());
    const float wetLvl = juce::jlimit(0.0f, 1.0f, wetLevel.load());
    const float dryLvl = juce::jlimit(0.0f, 1.0f, dryLevel.load());
    const float earlyLvl = juce::jlimit(0.0f, 1.0f, earlyLevel.load());

    // Update tone filters only when needed.
    if (std::abs(lc - lastLowCut) > 1.0f)
    {
        lastLowCut = lc;
        auto lcCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(cachedSampleRate, lc);
        wetLowCutL.coefficients = lcCoeffs;
        wetLowCutR.coefficients = lcCoeffs;
    }

    if (std::abs(hc - lastHighCut) > 8.0f)
    {
        lastHighCut = hc;
        auto hcCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(cachedSampleRate, hc);
        wetHighCutL.coefficients = hcCoeffs;
        wetHighCutR.coefficients = hcCoeffs;
    }

    // Get algorithm index for parameter adjustments
    const int algo = juce::jlimit(0, 4, static_cast<int>(algorithm.load()));

    // Map algorithm to reverb parameter adjustments
    float roomSizeAdj = juce::jlimit(0.0f, 1.0f, roomSize.load());
    float dampingAdj = juce::jlimit(0.0f, 1.0f, damping.load());
    float widthAdj = juce::jlimit(0.0f, 1.0f, width.load());

    switch (static_cast<Algorithm>(algo))
    {
        case Algorithm::Room:
            // Tight room: reduce room size range, increase damping
            roomSizeAdj *= 0.6f;
            dampingAdj = juce::jlimit(0.0f, 1.0f, dampingAdj + 0.2f);
            break;
        case Algorithm::Hall:
            // Large hall: extend room size, reduce damping
            roomSizeAdj = juce::jlimit(0.0f, 1.0f, roomSizeAdj * 0.5f + 0.5f);
            dampingAdj *= 0.7f;
            break;
        case Algorithm::Plate:
            // Plate: dense, bright
            dampingAdj *= 0.5f;
            widthAdj = juce::jlimit(0.0f, 1.0f, widthAdj * 1.2f);
            break;
        case Algorithm::Chamber:
            // Chamber: balanced
            roomSizeAdj *= 0.8f;
            break;
        case Algorithm::Shimmer:
            // Shimmer: large space with brightness
            roomSizeAdj = juce::jlimit(0.0f, 1.0f, roomSizeAdj * 0.4f + 0.6f);
            dampingAdj *= 0.3f;
            break;
    }

    // Store dry signal in buffers allocated during prepareToPlay; never resize in the audio callback.
    if (dryBuffer.getNumChannels() < numChannels
        || dryBuffer.getNumSamples() < numSamples
        || earlyOutputBuffer.getNumChannels() < numChannels
        || earlyOutputBuffer.getNumSamples() < numSamples)
    {
        buffer.clear();
        return;
    }
    for (int ch = 0; ch < numChannels; ++ch)
        dryBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamples);
    earlyOutputBuffer.clear();

    if (earlyReflectionBuffer.getNumSamples() > 0)
    {
        const int ringSize = earlyReflectionBuffer.getNumSamples();
        const float diffusionValue = juce::jlimit(0.0f, 1.0f, diffusion.load());
        const float tapScale = earlyLvl * (0.18f + diffusionValue * 0.22f);
        const std::array<float, 5> tapMs {
            algo == static_cast<int>(Algorithm::Room) ? 5.7f : 9.3f,
            algo == static_cast<int>(Algorithm::Plate) ? 12.1f : 17.9f,
            algo == static_cast<int>(Algorithm::Chamber) ? 23.7f : 29.1f,
            algo == static_cast<int>(Algorithm::Hall) ? 43.0f : 37.0f,
            algo == static_cast<int>(Algorithm::Shimmer) ? 71.0f : 53.0f
        };
        const std::array<float, 5> tapGain { 0.72f, -0.48f, 0.36f, -0.27f, 0.19f };

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dryBuffer.getSample(0, i);
            const float inR = numChannels >= 2 ? dryBuffer.getSample(1, i) : inL;
            earlyReflectionBuffer.setSample(0, earlyReflectionWriteIndex, inL);
            earlyReflectionBuffer.setSample(1, earlyReflectionWriteIndex, inR);

            float earlyL = 0.0f;
            float earlyR = 0.0f;
            for (size_t tap = 0; tap < tapMs.size(); ++tap)
            {
                int offset = static_cast<int>(std::round(tapMs[tap] * 0.001f * static_cast<float>(cachedSampleRate)));
                offset = juce::jlimit(1, ringSize - 1, offset);
                int readIndex = earlyReflectionWriteIndex - offset;
                if (readIndex < 0)
                    readIndex += ringSize;

                const float gain = tapGain[tap] * tapScale;
                earlyL += earlyReflectionBuffer.getSample(0, readIndex) * gain;
                earlyR += earlyReflectionBuffer.getSample(1, readIndex) * gain * (tap % 2 == 0 ? -0.82f : 0.92f);
            }

            earlyOutputBuffer.setSample(0, i, earlyL);
            if (numChannels >= 2)
                earlyOutputBuffer.setSample(1, i, earlyR);
            earlyReflectionWriteIndex = (earlyReflectionWriteIndex + 1) % ringSize;
        }
    }

    // Apply pre-delay to input
    if (preDelaySamples > 0.5f)
    {
        preDelayLineL.setDelay(preDelaySamples);
        preDelayLineR.setDelay(preDelaySamples);

        auto* pL = buffer.getWritePointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            preDelayLineL.pushSample(0, pL[i]);
            pL[i] = preDelayLineL.popSample(0);
        }

        if (numChannels >= 2)
        {
            auto* pR = buffer.getWritePointer(1);
            for (int i = 0; i < numSamples; ++i)
            {
                preDelayLineR.pushSample(0, pR[i]);
                pR[i] = preDelayLineR.popSample(0);
            }
        }
    }

    // Native late tail: 8-line feedback delay network with algorithm-specific
    // delay spacing and a Householder feedback matrix for dense, stable tails.
    if (lateTankBuffer.getNumSamples() > 0)
    {
        const int ringSize = lateTankBuffer.getNumSamples();
        const bool freeze = freezeMode.load(std::memory_order_relaxed) >= 0.5f;
        const float diffusionValue = juce::jlimit(0.0f, 1.0f, diffusion.load(std::memory_order_relaxed));
        const float decaySeconds = juce::jlimit(0.1f, 20.0f, decayTime.load(std::memory_order_relaxed));
        const float roomScale = 0.72f + roomSizeAdj * 1.35f;
        const float lineFeedback = freeze
            ? 0.997f
            : juce::jlimit(0.35f, 0.965f,
                           std::exp(-3.0f * (0.055f + roomSizeAdj * 0.11f) / decaySeconds));
        const float dampCoeff = juce::jlimit(0.012f, 0.42f, 0.36f - dampingAdj * 0.30f);
        const float inputGain = juce::jlimit(0.06f, 0.42f, 0.16f + diffusionValue * 0.18f);
        const float modDepthSamples = (static_cast<Algorithm>(algo) == Algorithm::Plate ? 1.8f : 4.5f) * (0.2f + diffusionValue * 0.8f);
        const float modRate = (static_cast<Algorithm>(algo) == Algorithm::Plate ? 0.19f : 0.11f)
                            * juce::MathConstants<float>::twoPi / static_cast<float>(juce::jmax(1.0, cachedSampleRate));
        const std::array<float, lateLineCount> baseDelayMs {
            29.7f, 37.1f, 41.9f, 53.3f, 61.7f, 71.9f, 83.9f, 97.1f
        };
        const float algorithmScale = static_cast<Algorithm>(algo) == Algorithm::Room ? 0.58f
                                   : static_cast<Algorithm>(algo) == Algorithm::Hall ? 1.35f
                                   : static_cast<Algorithm>(algo) == Algorithm::Plate ? 0.82f
                                   : static_cast<Algorithm>(algo) == Algorithm::Chamber ? 0.74f
                                   : 1.52f;

        auto readLateLine = [&] (int line, float delaySamplesToRead) -> float
        {
            delaySamplesToRead = juce::jlimit(1.0f, static_cast<float>(ringSize - 2), delaySamplesToRead);
            float readPosition = static_cast<float>(lateTankWriteIndex) - delaySamplesToRead;
            while (readPosition < 0.0f)
                readPosition += static_cast<float>(ringSize);
            const int indexA = static_cast<int>(readPosition) % ringSize;
            const int indexB = (indexA + 1) % ringSize;
            const float frac = readPosition - std::floor(readPosition);
            const float a = lateTankBuffer.getSample(line, indexA);
            const float b = lateTankBuffer.getSample(line, indexB);
            return a + (b - a) * frac;
        };

        auto* outL = buffer.getWritePointer(0);
        auto* outR = numChannels >= 2 ? buffer.getWritePointer(1) : nullptr;
        for (int sample = 0; sample < numSamples; ++sample)
        {
            std::array<float, lateLineCount> tankRead {};
            float readSum = 0.0f;
            for (int line = 0; line < lateLineCount; ++line)
            {
                const float lineDelayMs = baseDelayMs[static_cast<size_t>(line)] * algorithmScale * roomScale;
                const float modulatedSamples = std::sin(lateModPhase[static_cast<size_t>(line)]) * modDepthSamples;
                const float delaySamplesToRead = lineDelayMs * 0.001f * static_cast<float>(cachedSampleRate) + modulatedSamples;
                float read = readLateLine(line, delaySamplesToRead);
                lateDampingState[static_cast<size_t>(line)] += (read - lateDampingState[static_cast<size_t>(line)]) * dampCoeff;
                read = lateDampingState[static_cast<size_t>(line)];
                tankRead[static_cast<size_t>(line)] = read;
                readSum += read;

                lateModPhase[static_cast<size_t>(line)] += modRate * (1.0f + static_cast<float>(line) * 0.07f);
                if (lateModPhase[static_cast<size_t>(line)] >= juce::MathConstants<float>::twoPi)
                    lateModPhase[static_cast<size_t>(line)] -= juce::MathConstants<float>::twoPi;
            }

            const float inL = buffer.getSample(0, sample);
            const float inR = numChannels >= 2 ? buffer.getSample(1, sample) : inL;
            const float monoIn = (inL + inR) * 0.5f;
            shimmerSmootherL += (std::abs(tankRead[2]) - shimmerSmootherL) * 0.018f;
            shimmerSmootherR += (std::abs(tankRead[5]) - shimmerSmootherR) * 0.018f;
            const float shimmerAmount = static_cast<Algorithm>(algo) == Algorithm::Shimmer ? 0.17f : 0.0f;

            for (int line = 0; line < lateLineCount; ++line)
            {
                const float householder = (readSum * (2.0f / static_cast<float>(lateLineCount))) - tankRead[static_cast<size_t>(line)];
                const float lineSign = (line & 1) == 0 ? 1.0f : -1.0f;
                const float shimmer = shimmerAmount * (lineSign > 0.0f ? shimmerSmootherL : shimmerSmootherR);
                const float write = monoIn * inputGain * lineSign + (householder + shimmer) * lineFeedback;
                lateTankBuffer.setSample(line, lateTankWriteIndex, juce::jlimit(-1.8f, 1.8f, write));
            }

            float lateL = tankRead[0] - tankRead[2] + tankRead[4] - tankRead[6]
                        + (tankRead[1] - tankRead[5]) * 0.55f;
            float lateR = tankRead[1] - tankRead[3] + tankRead[5] - tankRead[7]
                        + (tankRead[0] - tankRead[4]) * 0.55f;
            lateL *= 0.22f;
            lateR *= 0.22f;

            const float mid = (lateL + lateR) * 0.5f;
            const float side = (lateL - lateR) * 0.5f * (0.35f + widthAdj * 1.35f);
            outL[sample] = mid + side;
            if (outR != nullptr)
                outR[sample] = mid - side;
            else
                outL[sample] = mid;

            lateTankWriteIndex = (lateTankWriteIndex + 1) % ringSize;
        }
    }

    // Apply tone filters to wet signal
    {
        auto* wL = buffer.getWritePointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            wL[i] = wetLowCutL.processSample(wL[i]);
            wL[i] = wetHighCutL.processSample(wL[i]);
        }
    }
    if (numChannels >= 2)
    {
        auto* wR = buffer.getWritePointer(1);
        for (int i = 0; i < numSamples; ++i)
        {
            wR[i] = wetLowCutR.processSample(wR[i]);
            wR[i] = wetHighCutR.processSample(wR[i]);
        }
    }

    const float lateLevel = wetLvl * (0.55f + juce::jlimit(0.0f, 1.0f, diffusion.load()) * 0.45f);
    const float earlyMixLevel = juce::jlimit(0.0f, 1.0f, earlyLvl);

    // Mix: dry + late tail + independent early reflection taps.
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* out = buffer.getWritePointer(ch);
        const auto* dryData = dryBuffer.getReadPointer(ch);
        const auto* earlyData = earlyOutputBuffer.getReadPointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            out[i] = dryData[i] * dryLvl + out[i] * lateLevel + earlyData[i] * earlyMixLevel;
        }
    }
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13Reverb::releaseResources()
{
    reverb.reset();
    preDelayLineL.reset();
    preDelayLineR.reset();
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();
    earlyReflectionBuffer.clear();
    earlyOutputBuffer.clear();
    earlyReflectionWriteIndex = 0;
    lateTankBuffer.clear();
    lateTankWriteIndex = 0;
    lateDampingState.fill(0.0f);
    shimmerSmootherL = 0.0f;
    shimmerSmootherR = 0.0f;
}

void S13Reverb::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Reverb", {
        { "algorithm",  algorithm.load() },
        { "roomSize",   roomSize.load() },
        { "damping",    damping.load() },
        { "wetLevel",   wetLevel.load() },
        { "dryLevel",   dryLevel.load() },
        { "width",      width.load() },
        { "freezeMode", freezeMode.load() },
        { "preDelay",   preDelay.load() },
        { "diffusion",  diffusion.load() },
        { "lowCut",     lowCut.load() },
        { "highCut",    highCut.load() },
        { "earlyLevel", earlyLevel.load() },
        { "decayTime",  decayTime.load() }
    });
}

void S13Reverb::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Reverb");
    if (!tree.isValid())
        return;

    algorithm  = static_cast<float>((double)tree.getProperty("algorithm", 0.0));
    roomSize   = static_cast<float>((double)tree.getProperty("roomSize", 0.5));
    damping    = static_cast<float>((double)tree.getProperty("damping", 0.5));
    wetLevel   = static_cast<float>((double)tree.getProperty("wetLevel", 0.33));
    dryLevel   = static_cast<float>((double)tree.getProperty("dryLevel", 0.7));
    width      = static_cast<float>((double)tree.getProperty("width", 1.0));
    freezeMode = static_cast<float>((double)tree.getProperty("freezeMode", 0.0));
    preDelay   = static_cast<float>((double)tree.getProperty("preDelay", 0.0));
    diffusion  = static_cast<float>((double)tree.getProperty("diffusion", 0.5));
    lowCut     = static_cast<float>((double)tree.getProperty("lowCut", 20.0));
    highCut    = static_cast<float>((double)tree.getProperty("highCut", 20000.0));
    earlyLevel = static_cast<float>((double)tree.getProperty("earlyLevel", 0.5));
    decayTime  = static_cast<float>((double)tree.getProperty("decayTime", 2.0));
}

bool S13Reverb::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}


// ============================================================================
//  S13Chorus
// ============================================================================

S13Chorus::S13Chorus()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    for (int v = 0; v < maxVoices; ++v)
        lfoPhase[v] = static_cast<float>(v) * juce::MathConstants<float>::twoPi / static_cast<float>(maxVoices);
}

void S13Chorus::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 1;

    for (int ch = 0; ch < 2; ++ch)
    {
        for (int v = 0; v < maxVoices; ++v)
        {
            delayLines[ch][v].setMaximumDelayInSamples(maxChorusDelaySamples);
            delayLines[ch][v].prepare(spec);
            delayLines[ch][v].reset();
        }
    }

    // Prepare phaser all-pass filters
    for (int s = 0; s < maxPhaserStages; ++s)
    {
        allpassL[s].reset();
        allpassR[s].reset();
    }

    feedbackState[0] = 0.0f;
    feedbackState[1] = 0.0f;

    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();
    lastLowCut = juce::jlimit(20.0f, 2000.0f, lowCut.load());
    lastHighCut = juce::jlimit(200.0f, 20000.0f, highCut.load());
    auto lowCutCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastLowCut);
    wetLowCutL.coefficients = lowCutCoeffs;
    wetLowCutR.coefficients = lowCutCoeffs;
    auto highCutCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastHighCut);
    wetHighCutL.coefficients = highCutCoeffs;
    wetHighCutR.coefficients = highCutCoeffs;
}

float S13Chorus::getLFOValue(float phase, LFOShape shape) const
{
    switch (shape)
    {
        case LFOShape::Sine:
            return std::sin(phase);

        case LFOShape::Triangle:
        {
            // Normalize to 0-1 range
            float norm = phase / juce::MathConstants<float>::twoPi;
            return 2.0f * std::abs(2.0f * norm - 1.0f) - 1.0f;
        }

        case LFOShape::Square:
            return phase < juce::MathConstants<float>::pi ? 1.0f : -1.0f;

        case LFOShape::SampleAndHold:
        {
            // Use phase to seed a pseudo-random value, changes once per cycle
            auto seed = static_cast<unsigned int>(phase * 1000.0f);
            seed = (seed * 1103515245u + 12345u) & 0x7fffffffu;
            return static_cast<float>(seed) / static_cast<float>(0x7fffffff) * 2.0f - 1.0f;
        }
    }
    return std::sin(phase);
}

void S13Chorus::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    const auto currentMode = static_cast<Mode>(juce::jlimit(0, 2, static_cast<int>(mode.load())));
    const auto currentLFOShape = static_cast<LFOShape>(juce::jlimit(0, 3, static_cast<int>(lfoShape.load())));
    const int characterIndex = juce::jlimit(0, 2, static_cast<int>(std::round(characterMode.load(std::memory_order_relaxed))));
    float lfoRate = juce::jlimit(0.01f, 20.0f, rate.load());
    if (tempoSync.load() >= 0.5f)
    {
        double bpm = 120.0;
        if (auto* ph = getPlayHead())
        {
            auto pos = ph->getPosition();
            if (pos.hasValue())
                if (auto bpmVal = pos->getBpm())
                    bpm = *bpmVal;
        }

        const int syncIndex = juce::jlimit(0, 5, static_cast<int>(std::round(rate.load())));
        const float barsPerCycle[] { 4.0f, 2.0f, 1.0f, 0.5f, 0.25f, 0.125f };
        lfoRate = static_cast<float>((bpm / 60.0) / (barsPerCycle[syncIndex] * 4.0));
    }
    const float lfoDepth = juce::jlimit(0.0f, 1.0f, depth.load());
    const float fb = juce::jlimit(-1.0f, 1.0f, fbAmount.load());
    const float wet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float dry = 1.0f - wet;
    const int baseVoices = juce::jlimit(1, maxVoices, static_cast<int>(voices.load()));
    const int numVoices = characterIndex == 1 && currentMode == Mode::Chorus ? juce::jmax(baseVoices, 4) : baseVoices;
    const float spreadVal = juce::jlimit(0.0f, 1.0f, spread.load());

    const float currentLowCut = juce::jlimit(20.0f, 2000.0f, lowCut.load());
    if (std::abs(currentLowCut - lastLowCut) > 1.0f)
    {
        lastLowCut = currentLowCut;
        auto coeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(cachedSampleRate, currentLowCut);
        wetLowCutL.coefficients = coeffs;
        wetLowCutR.coefficients = coeffs;
    }

    const float requestedHighCut = juce::jlimit(200.0f, 20000.0f, highCut.load());
    const float currentHighCut = characterIndex == 2 ? juce::jmin(requestedHighCut, 7200.0f)
                               : (characterIndex == 1 ? juce::jmin(requestedHighCut, 12000.0f)
                                                       : requestedHighCut);
    if (std::abs(currentHighCut - lastHighCut) > 8.0f)
    {
        lastHighCut = currentHighCut;
        auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(cachedSampleRate, currentHighCut);
        wetHighCutL.coefficients = coeffs;
        wetHighCutR.coefficients = coeffs;
    }

    const float phaseInc = lfoRate * juce::MathConstants<float>::twoPi
                         / static_cast<float>(cachedSampleRate);

    const float voiceGain = 1.0f / static_cast<float>(numVoices);

    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    auto applyCharacter = [&] (float value, int sampleIndex, int channelIndex)
    {
        if (characterIndex == 1)
            return std::tanh(value * 1.05f) * 0.98f;
        if (characterIndex == 2)
            return std::tanh(value * 1.18f) * 0.9f
                 + builtinNoise(sampleIndex, 400 + channelIndex) * 0.0014f;
        return value;
    };

    if (currentMode == Mode::Phaser)
    {
        // Phaser mode: modulated all-pass filters
        const int baseStages = juce::jlimit(2, maxPhaserStages, numVoices * 2);
        const int numStages = characterIndex == 1 ? juce::jmax(baseStages, 8)
                            : (characterIndex == 2 ? juce::jmin(baseStages, 6) : baseStages);
        const float minFreq = characterIndex == 2 ? 120.0f : 200.0f;
        const float maxFreq = characterIndex == 2 ? 2500.0f : 4000.0f;

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dataL[i];
            const float inR = dataR ? dataR[i] : inL;

            // LFO modulates the all-pass center frequency.
            const float lfoVal = getLFOValue(lfoPhase[0], currentLFOShape);
            const float modFreq = minFreq + (maxFreq - minFreq) * (lfoVal * lfoDepth * 0.5f + 0.5f);
            const float warped = std::tan(juce::MathConstants<float>::pi * modFreq / static_cast<float>(cachedSampleRate));
            const float allPassCoeff = (warped - 1.0f) / (warped + 1.0f);

            float procL = inL + feedbackState[0] * fb;
            float procR = inR + feedbackState[1] * fb;

            for (int s = 0; s < numStages; ++s)
            {
                const auto stateIndex = static_cast<size_t>(s);
                const float outL = -allPassCoeff * procL + phaserStateL[stateIndex];
                phaserStateL[stateIndex] = procL + allPassCoeff * outL;
                procL = outL;

                const float outR = -allPassCoeff * procR + phaserStateR[stateIndex];
                phaserStateR[stateIndex] = procR + allPassCoeff * outR;
                procR = outR;
            }

            feedbackState[0] = procL;
            feedbackState[1] = procR;
            procL = applyCharacter(procL, i, 0);
            procR = applyCharacter(procR, i, 1);
            procL = wetHighCutL.processSample(wetLowCutL.processSample(procL));
            procR = wetHighCutR.processSample(wetLowCutR.processSample(procR));

            dataL[i] = inL * dry + procL * wet;
            if (dataR)
                dataR[i] = inR * dry + procR * wet;

            // Advance LFO
            lfoPhase[0] += phaseInc;
            if (lfoPhase[0] >= juce::MathConstants<float>::twoPi)
                lfoPhase[0] -= juce::MathConstants<float>::twoPi;
        }
    }
    else
    {
        // Chorus / Flanger mode
        float centerDelaySamples, depthSamples;
        if (currentMode == Mode::Flanger)
        {
            // Flanger: shorter delay range (0.5ms - 5ms)
            centerDelaySamples = static_cast<float>(0.002 * cachedSampleRate);
            depthSamples = static_cast<float>(0.003 * cachedSampleRate) * lfoDepth;
        }
        else
        {
            // Chorus: longer delay range (7ms - 20ms)
            centerDelaySamples = static_cast<float>(0.007 * cachedSampleRate);
            depthSamples = static_cast<float>(0.013 * cachedSampleRate) * lfoDepth;
        }
        if (characterIndex == 1 && currentMode == Mode::Chorus)
        {
            centerDelaySamples *= 1.22f;
            depthSamples *= 1.18f;
        }
        else if (characterIndex == 2)
        {
            centerDelaySamples *= 1.08f;
            depthSamples *= 0.82f;
        }

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dataL[i];
            const float inR = dataR ? dataR[i] : inL;

            float wetL = 0.0f;
            float wetR = 0.0f;

            for (int v = 0; v < numVoices; ++v)
            {
                const float lfoVal = getLFOValue(lfoPhase[v], currentLFOShape);
                const float ensembleOffset = characterIndex == 1
                    ? std::sin(lfoPhase[v] * 0.37f + static_cast<float>(v) * 1.61f) * 0.18f
                    : 0.0f;
                const float delaySamples = juce::jlimit(1.0f, static_cast<float>(maxChorusDelaySamples - 2),
                                                        centerDelaySamples + depthSamples * (lfoVal + ensembleOffset));

                // Push input + feedback
                delayLines[0][v].pushSample(0, inL + feedbackState[0] * fb);
                if (numChannels >= 2)
                    delayLines[1][v].pushSample(0, inR + feedbackState[1] * fb);

                // Read with modulated delay
                delayLines[0][v].setDelay(delaySamples);
                const float outL = delayLines[0][v].popSample(0);
                wetL += outL;

                if (numChannels >= 2)
                {
                    // Stereo spread: offset phase for right channel
                    const float phaseOffset = juce::MathConstants<float>::pi * spreadVal * static_cast<float>(v % 2);
                    const float lfoValR = getLFOValue(lfoPhase[v] + phaseOffset, currentLFOShape);
                    const float ensembleOffsetR = characterIndex == 1
                        ? std::sin(lfoPhase[v] * 0.41f + static_cast<float>(v) * 1.37f + phaseOffset) * 0.18f
                        : 0.0f;
                    const float delaySamplesR = juce::jlimit(1.0f, static_cast<float>(maxChorusDelaySamples - 2),
                                                             centerDelaySamples + depthSamples * (lfoValR + ensembleOffsetR));
                    delayLines[1][v].setDelay(delaySamplesR);
                    const float outR = delayLines[1][v].popSample(0);
                    wetR += outR;
                }

                // Advance LFO phase
                lfoPhase[v] += phaseInc;
                if (lfoPhase[v] >= juce::MathConstants<float>::twoPi)
                    lfoPhase[v] -= juce::MathConstants<float>::twoPi;
            }

            wetL *= voiceGain;
            wetR *= voiceGain;
            wetL = applyCharacter(wetL, i, 0);
            wetR = applyCharacter(wetR, i, 1);
            wetL = wetHighCutL.processSample(wetLowCutL.processSample(wetL));
            wetR = wetHighCutR.processSample(wetLowCutR.processSample(wetR));

            feedbackState[0] = wetL;
            feedbackState[1] = wetR;

            dataL[i] = inL * dry + wetL * wet;
            if (dataR)
                dataR[i] = inR * dry + wetR * wet;
        }
    }
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13Chorus::releaseResources()
{
    for (int ch = 0; ch < 2; ++ch)
        for (int v = 0; v < maxVoices; ++v)
            delayLines[ch][v].reset();

    for (int s = 0; s < maxPhaserStages; ++s)
    {
        allpassL[s].reset();
        allpassR[s].reset();
    }
    phaserStateL.fill(0.0f);
    phaserStateR.fill(0.0f);
    phaserStateL.fill(0.0f);
    phaserStateR.fill(0.0f);
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();

    feedbackState[0] = 0.0f;
    feedbackState[1] = 0.0f;
}

void S13Chorus::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Chorus", {
        { "mode",      mode.load() },
        { "rate",      rate.load() },
        { "depth",     depth.load() },
        { "feedback",  fbAmount.load() },
        { "mix",       mix.load() },
        { "voices",    voices.load() },
        { "lfoShape",  lfoShape.load() },
        { "spread",    spread.load() },
        { "highCut",   highCut.load() },
        { "lowCut",    lowCut.load() },
        { "tempoSync", tempoSync.load() },
        { "characterMode", characterMode.load() }
    });
}

void S13Chorus::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Chorus");
    if (!tree.isValid())
        return;

    mode      = static_cast<float>((double)tree.getProperty("mode", 0.0));
    rate      = static_cast<float>((double)tree.getProperty("rate", 1.0));
    depth     = static_cast<float>((double)tree.getProperty("depth", 0.5));
    fbAmount  = static_cast<float>((double)tree.getProperty("feedback", 0.0));
    mix       = static_cast<float>((double)tree.getProperty("mix", 0.5));
    voices    = static_cast<float>((double)tree.getProperty("voices", 2.0));
    lfoShape  = static_cast<float>((double)tree.getProperty("lfoShape", 0.0));
    spread    = static_cast<float>((double)tree.getProperty("spread", 0.5));
    highCut   = static_cast<float>((double)tree.getProperty("highCut", 20000.0));
    lowCut    = static_cast<float>((double)tree.getProperty("lowCut", 20.0));
    tempoSync = static_cast<float>((double)tree.getProperty("tempoSync", 0.0));
    characterMode = static_cast<float>((double)tree.getProperty("characterMode", 0.0));
}

bool S13Chorus::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}


// ============================================================================
//  S13Saturator
// ============================================================================

S13Saturator::S13Saturator()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13Saturator::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    toneFilterL.reset();
    toneFilterR.reset();
    lowCutFilterL.reset();
    lowCutFilterR.reset();
    lastToneFreq = juce::jlimit(200.0f, 20000.0f, toneFreq.load());
    auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastToneFreq);
    toneFilterL.coefficients = coeffs;
    toneFilterR.coefficients = coeffs;
    lastLowCutFreq = juce::jlimit(20.0f, 1000.0f, lowCutFreq.load());
    auto lowCutCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastLowCutFreq);
    lowCutFilterL.coefficients = lowCutCoeffs;
    lowCutFilterR.coefficients = lowCutCoeffs;

    oversampler2x = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler4x = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 2, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler2x->initProcessing(static_cast<size_t>(samplesPerBlock));
    oversampler4x->initProcessing(static_cast<size_t>(samplesPerBlock));

    smoothedDriveGain.reset(sampleRate, 0.02);
    smoothedMix.reset(sampleRate, 0.02);
    smoothedOutputGain.reset(sampleRate, 0.02);
    const float initialDriveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    const float initialAutoCompDB = -initialDriveDB * 0.42f;
    smoothedDriveGain.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(initialDriveDB));
    smoothedMix.setCurrentAndTargetValue(juce::jlimit(0.0f, 1.0f, mix.load()));
    smoothedOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(-12.0f, 0.0f, outputGain.load()) + initialAutoCompDB));
}

float S13Saturator::processSample(float input, float driveLinear, SatType type, float asym) const
{
    // Apply asymmetry shift
    float x = input * driveLinear + asym * 0.1f;

    switch (type)
    {
        case SatType::Tape:
        {
            // Tape saturation: soft, warm compression
            float y = std::tanh(x * 0.8f);
            // Add subtle even harmonics
            y += 0.05f * x * x * (x > 0.0f ? 1.0f : -1.0f);
            return y;
        }

        case SatType::Tube:
        {
            // Tube saturation: asymmetric, rich harmonics
            float y;
            if (x >= 0.0f)
                y = 1.0f - std::exp(-x);
            else
                y = -1.0f + std::exp(x * 0.5f); // Asymmetric negative side
            return y;
        }

        case SatType::Transistor:
        {
            // Transistor: hard clipping with smooth transition
            float y = x;
            if (y > 1.0f)
                y = 2.0f / 3.0f;
            else if (y > 0.0f)
                y = y - (y * y * y) / 3.0f;
            else if (y > -1.0f)
                y = y - (y * y * y) / 3.0f;
            else
                y = -2.0f / 3.0f;
            return y;
        }

        case SatType::Clip:
        {
            // Hard clip
            return juce::jlimit(-1.0f, 1.0f, x);
        }

        case SatType::Crush:
        {
            // Bit crush effect: quantize
            const float bits = 8.0f; // Effective bit depth
            const float levels = std::pow(2.0f, bits);
            float y = std::round(x * levels) / levels;
            return juce::jlimit(-1.0f, 1.0f, y);
        }

        case SatType::Console:
        {
            // Console: subtle soft knee with restrained odd harmonics.
            const float knee = x / (1.0f + 0.28f * std::abs(x));
            return std::tanh(knee * 1.15f) * 0.92f;
        }

        case SatType::Transformer:
        {
            // Transformer: rounded low-mid weight with asymmetric magnetic push.
            const float biased = x + asym * 0.18f;
            const float magnetic = std::tanh(biased * 0.95f) + 0.08f * std::sin(biased * 2.0f);
            return magnetic * 0.9f;
        }

        case SatType::Foldback:
        {
            // Foldback: controlled creative distortion, level bounded for safety.
            float y = x;
            const float threshold = 0.78f;
            if (std::abs(y) > threshold)
                y = std::abs(std::fmod(y - threshold, threshold * 4.0f) - threshold * 2.0f) - threshold;
            return juce::jlimit(-1.0f, 1.0f, y);
        }
    }

    return std::tanh(x); // fallback
}

void S13Saturator::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    // Update tone filter if frequency changed
    const float currentToneFreq = juce::jlimit(200.0f, 20000.0f, toneFreq.load());
    if (std::abs(currentToneFreq - lastToneFreq) > 1.0f)
    {
        lastToneFreq = currentToneFreq;
        auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(cachedSampleRate, currentToneFreq);
        toneFilterL.coefficients = coeffs;
        toneFilterR.coefficients = coeffs;
    }
    const float currentLowCutFreq = juce::jlimit(20.0f, 1000.0f, lowCutFreq.load());
    if (std::abs(currentLowCutFreq - lastLowCutFreq) > 1.0f)
    {
        lastLowCutFreq = currentLowCutFreq;
        auto coeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(cachedSampleRate, currentLowCutFreq);
        lowCutFilterL.coefficients = coeffs;
        lowCutFilterR.coefficients = coeffs;
    }

    const float driveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    const float outGainDB = juce::jlimit(-12.0f, 0.0f, outputGain.load());
    const float autoCompDB = -driveDB * 0.42f;
    smoothedDriveGain.setTargetValue(juce::Decibels::decibelsToGain(driveDB));
    smoothedMix.setTargetValue(juce::jlimit(0.0f, 1.0f, mix.load()));
    smoothedOutputGain.setTargetValue(juce::Decibels::decibelsToGain(outGainDB + autoCompDB));
    const auto type = static_cast<SatType>(juce::jlimit(0, 7, static_cast<int>(satType.load())));
    const float asym = juce::jlimit(-1.0f, 1.0f, asymmetry.load());
    const int osMode = juce::jlimit(0, 2, static_cast<int>(std::round(oversampleMode.load())));

    auto applySaturation = [&](auto& audioBlock)
    {
        const int ns = static_cast<int>(audioBlock.getNumSamples());
        auto* dL = audioBlock.getChannelPointer(0);
        auto* dR = audioBlock.getNumChannels() >= 2 ? audioBlock.getChannelPointer(1) : nullptr;

        for (int i = 0; i < ns; ++i)
        {
            const float driveLinear = smoothedDriveGain.getNextValue();
            const float wet = smoothedMix.getNextValue();
            const float dry = 1.0f - wet;
            const float outGainLinear = smoothedOutputGain.getNextValue();
            const float inL = dL[i];
            float satL = processSample(inL, driveLinear, type, asym);
            satL = toneFilterL.processSample(satL);
            satL = lowCutFilterL.processSample(satL);
            satL *= outGainLinear;
            dL[i] = inL * dry + satL * wet;

            if (dR)
            {
                const float inR = dR[i];
                float satR = processSample(inR, driveLinear, type, asym);
                satR = toneFilterR.processSample(satR);
                satR = lowCutFilterR.processSample(satR);
                satR *= outGainLinear;
                dR[i] = inR * dry + satR * wet;
            }
        }
    };

    // Oversampling path
    if (oversamplingEnabled && osMode == 1 && oversampler2x)
    {
        juce::dsp::AudioBlock<float> block(buffer);
        auto oversampledBlock = oversampler2x->processSamplesUp(block);
        applySaturation(oversampledBlock);
        oversampler2x->processSamplesDown(block);
    }
    else if (oversamplingEnabled && osMode == 2 && oversampler4x)
    {
        juce::dsp::AudioBlock<float> block(buffer);
        auto oversampledBlock = oversampler4x->processSamplesUp(block);
        applySaturation(oversampledBlock);
        oversampler4x->processSamplesDown(block);
    }
    else
    {
        juce::dsp::AudioBlock<float> block(buffer);
        applySaturation(block);
    }
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13Saturator::releaseResources()
{
    toneFilterL.reset();
    toneFilterR.reset();
    lowCutFilterL.reset();
    lowCutFilterR.reset();
    if (oversampler2x)
        oversampler2x->reset();
    if (oversampler4x)
        oversampler4x->reset();
    smoothedDriveGain.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(juce::jlimit(0.0f, 30.0f, drive.load())));
    smoothedMix.setCurrentAndTargetValue(juce::jlimit(0.0f, 1.0f, mix.load()));
    const float driveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    smoothedOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(-12.0f, 0.0f, outputGain.load()) - driveDB * 0.42f));
}

void S13Saturator::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Saturator", {
        { "satType",        satType.load() },
        { "drive",          drive.load() },
        { "mix",            mix.load() },
        { "toneFreq",       toneFreq.load() },
        { "lowCutFreq",     lowCutFreq.load() },
        { "outputGain",     outputGain.load() },
        { "asymmetry",      asymmetry.load() },
        { "oversampleMode", oversampleMode.load() }
    });
}

void S13Saturator::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Saturator");
    if (!tree.isValid())
        return;

    satType        = static_cast<float>((double)tree.getProperty("satType", 0.0));
    drive          = static_cast<float>((double)tree.getProperty("drive", 6.0));
    mix            = static_cast<float>((double)tree.getProperty("mix", 1.0));
    toneFreq       = static_cast<float>((double)tree.getProperty("toneFreq", 20000.0));
    lowCutFreq     = static_cast<float>((double)tree.getProperty("lowCutFreq", 20.0));
    outputGain     = static_cast<float>((double)tree.getProperty("outputGain", 0.0));
    asymmetry      = static_cast<float>((double)tree.getProperty("asymmetry", 0.0));
    oversampleMode = static_cast<float>((double)tree.getProperty("oversampleMode", 1.0));
}

// ============================================================================
//  S13BasicSynthInstrument
// ============================================================================

static float synthPolyBlep(float phase, float phaseDelta)
{
    if (phaseDelta <= 0.0f)
        return 0.0f;

    if (phase < phaseDelta)
    {
        const float t = phase / phaseDelta;
        return t + t - t * t - 1.0f;
    }

    if (phase > 1.0f - phaseDelta)
    {
        const float t = (phase - 1.0f) / phaseDelta;
        return t * t + t + t + 1.0f;
    }

    return 0.0f;
}

static float synthSaw(float phase, float phaseDelta)
{
    return (2.0f * phase - 1.0f) - synthPolyBlep(phase, phaseDelta);
}

static float synthSquare(float phase, float phaseDelta)
{
    float value = phase < 0.5f ? 1.0f : -1.0f;
    value += synthPolyBlep(phase, phaseDelta);
    float fallingPhase = phase - 0.5f;
    if (fallingPhase < 0.0f)
        fallingPhase += 1.0f;
    value -= synthPolyBlep(fallingPhase, phaseDelta);
    return value;
}

S13BasicSynthInstrument::S13BasicSynthInstrument()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13BasicSynthInstrument::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    clearVoices();
}

void S13BasicSynthInstrument::releaseResources()
{
    clearVoices();
}

void S13BasicSynthInstrument::clearVoices()
{
    for (auto& notes : active) notes.fill(false);
    for (auto& notes : releasing) notes.fill(false);
    for (auto& notes : phaseA) notes.fill(0.0f);
    for (auto& notes : phaseB) notes.fill(0.0f);
    for (auto& notes : phaseSub) notes.fill(0.0f);
    for (auto& notes : velocity) notes.fill(0.0f);
    for (auto& notes : envelope) notes.fill(0.0f);
    for (auto& notes : filterState) notes.fill(0.0f);
    for (auto& notes : ageSamples) notes.fill(0);
    pitchBendSemitones.fill(0.0f);
    modWheel.fill(0.0f);
}

void S13BasicSynthInstrument::handleMidi(const juce::MidiMessage& message)
{
    const int channel = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);
    if (message.isPitchWheel())
    {
        const float normalized = (static_cast<float>(message.getPitchWheelValue()) - 8192.0f) / 8192.0f;
        pitchBendSemitones[static_cast<size_t>(channel)] = juce::jlimit(-2.0f, 2.0f, normalized * 2.0f);
        return;
    }
    if (message.isController() && message.getControllerNumber() == 1)
    {
        modWheel[static_cast<size_t>(channel)] = static_cast<float>(message.getControllerValue()) / 127.0f;
        return;
    }

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        active[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
        phaseA[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        phaseB[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.25f;
        phaseSub[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        velocity[static_cast<size_t>(channel)][static_cast<size_t>(note)] = message.getFloatVelocity();
        envelope[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        filterState[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        ageSamples[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0;
    }
    else if (message.isNoteOff())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& notes : releasing[static_cast<size_t>(channel)])
            notes = true;
    }
}

void S13BasicSynthInstrument::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    buffer.clear();
    const float sr = static_cast<float>(juce::jmax(1.0, cachedSampleRate));
    const float attackStep = 1.0f / juce::jmax(1.0f, sr * attackMs.load(std::memory_order_relaxed) * 0.001f);
    const float releaseStep = 1.0f / juce::jmax(1.0f, sr * releaseMs.load(std::memory_order_relaxed) * 0.001f);
    const float bright = juce::jlimit(0.0f, 1.0f, brightness.load(std::memory_order_relaxed));
    const float detune = std::pow(2.0f, juce::jlimit(0.0f, 35.0f, detuneCents.load(std::memory_order_relaxed)) / 1200.0f);
    const float sub = juce::jlimit(0.0f, 0.8f, subLevel.load(std::memory_order_relaxed));
    const float noise = juce::jlimit(0.0f, 0.25f, noiseLevel.load(std::memory_order_relaxed));
    const float outGain = juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, outputGain.load(std::memory_order_relaxed)));
    const float filterCoeff = juce::jlimit(0.015f, 0.55f, 0.04f + bright * bright * 0.46f);
    const float twoPi = juce::MathConstants<float>::twoPi;
    std::array<BuiltInMidiVoiceRef, kBuiltInMidiVoiceSlots> voiceRefs {};

    auto render = [&] (int start, int end)
    {
        int voiceCount = 0;
        for (size_t channel = 0; channel < active.size(); ++channel)
        {
            for (size_t note = 0; note < active[channel].size(); ++note)
            {
                if (active[channel][note] || envelope[channel][note] > 0.0f)
                    voiceRefs[static_cast<size_t>(voiceCount++)] = { channel, note };
            }
        }

        for (int sample = start; sample < end; ++sample)
        {
            float mixed = 0.0f;
            for (int voiceIndex = 0; voiceIndex < voiceCount;)
            {
                const auto voiceRef = voiceRefs[static_cast<size_t>(voiceIndex)];
                const size_t channel = voiceRef.channel;
                const size_t note = voiceRef.note;

                if (!active[channel][note] && envelope[channel][note] <= 0.0f)
                {
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                if (active[channel][note] && !releasing[channel][note])
                    envelope[channel][note] = juce::jmin(1.0f, envelope[channel][note] + attackStep);
                else
                    envelope[channel][note] = juce::jmax(0.0f, envelope[channel][note] - releaseStep);

                if (envelope[channel][note] <= 0.0f)
                {
                    active[channel][note] = false;
                    releasing[channel][note] = false;
                    velocity[channel][note] = 0.0f;
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const float freq = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(static_cast<int>(note)));
                const float bendFactor = std::pow(2.0f, pitchBendSemitones[channel] / 12.0f);
                const float mod = juce::jlimit(0.0f, 1.0f, modWheel[channel]);
                const float vibrato = std::sin(twoPi * (static_cast<float>(ageSamples[channel][note]) / sr) * 5.4f) * mod * 0.018f;
                const float modulatedFreq = freq * bendFactor * (1.0f + vibrato);
                const float deltaA = juce::jmin(0.45f, modulatedFreq / sr / detune);
                const float deltaB = juce::jmin(0.45f, modulatedFreq * detune / sr);
                const float deltaSub = juce::jmin(0.45f, modulatedFreq * 0.5f / sr);
                const float saw = synthSaw(phaseA[channel][note], deltaA);
                const float square = synthSquare(phaseB[channel][note], deltaB);
                const float subOsc = std::sin(twoPi * phaseSub[channel][note]);
                const float transient = builtinNoise(ageSamples[channel][note], static_cast<int>(note))
                    * noise * std::exp(-static_cast<float>(ageSamples[channel][note]) / (sr * 0.25f));
                float voice = saw * 0.58f + square * (0.22f + (bright + mod * 0.25f) * 0.18f) + subOsc * sub + transient;

                filterState[channel][note] += filterCoeff * (voice - filterState[channel][note]);
                voice = filterState[channel][note] * envelope[channel][note] * velocity[channel][note] * outGain;
                mixed += voice;

                phaseA[channel][note] += deltaA;
                phaseB[channel][note] += deltaB;
                phaseSub[channel][note] += deltaSub;
                if (phaseA[channel][note] >= 1.0f) phaseA[channel][note] -= std::floor(phaseA[channel][note]);
                if (phaseB[channel][note] >= 1.0f) phaseB[channel][note] -= std::floor(phaseB[channel][note]);
                if (phaseSub[channel][note] >= 1.0f) phaseSub[channel][note] -= std::floor(phaseSub[channel][note]);
                ++ageSamples[channel][note];
                ++voiceIndex;
            }

            mixed = softLimitInstrumentBus(mixed);
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.addSample(ch, sample, mixed);
        }
    };

    int cursor = 0;
    for (const auto metadata : midi)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        render(cursor, eventSample);
        handleMidi(metadata.getMessage());
        cursor = eventSample;
    }
    render(cursor, numSamples);
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13BasicSynthInstrument::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13BasicSynthInstrument", {
        { "attackMs", attackMs.load() },
        { "releaseMs", releaseMs.load() },
        { "brightness", brightness.load() },
        { "detuneCents", detuneCents.load() },
        { "subLevel", subLevel.load() },
        { "noiseLevel", noiseLevel.load() },
        { "outputGain", outputGain.load() }
    });
}

void S13BasicSynthInstrument::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13BasicSynthInstrument");
    if (!tree.isValid())
        return;

    attackMs    = static_cast<float>((double)tree.getProperty("attackMs", 8.0));
    releaseMs   = static_cast<float>((double)tree.getProperty("releaseMs", 180.0));
    brightness  = static_cast<float>((double)tree.getProperty("brightness", 0.62));
    detuneCents = static_cast<float>((double)tree.getProperty("detuneCents", 7.0));
    subLevel    = static_cast<float>((double)tree.getProperty("subLevel", 0.18));
    noiseLevel  = static_cast<float>((double)tree.getProperty("noiseLevel", 0.015));
    outputGain  = static_cast<float>((double)tree.getProperty("outputGain", -15.0));
}

bool S13BasicSynthInstrument::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    return mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
}

// ============================================================================
//  S13PianoInstrument
// ============================================================================

S13PianoInstrument::S13PianoInstrument()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13PianoInstrument::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    clearVoices();
}

void S13PianoInstrument::releaseResources()
{
    clearVoices();
}

void S13PianoInstrument::clearVoices()
{
    for (auto& notes : active) notes.fill(false);
    for (auto& notes : releasing) notes.fill(false);
    for (auto& notes : sustained) notes.fill(false);
    for (auto& notes : phase) notes.fill(0.0f);
    for (auto& notes : velocity) notes.fill(0.0f);
    for (auto& notes : envelope) notes.fill(0.0f);
    for (auto& notes : ageSamples) notes.fill(0);
    sustainPedal.fill(false);
}

void S13PianoInstrument::handleMidi(const juce::MidiMessage& message)
{
    const int channel = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);
    if (message.isController() && message.getControllerNumber() == 64)
    {
        const bool pedalDown = message.getControllerValue() >= 64;
        sustainPedal[static_cast<size_t>(channel)] = pedalDown;
        if (!pedalDown)
        {
            for (int note = 0; note < 128; ++note)
            {
                if (sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)])
                {
                    sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
                    releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
                }
            }
        }
        return;
    }

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        active[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
        sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
        phase[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        velocity[static_cast<size_t>(channel)][static_cast<size_t>(note)] = message.getFloatVelocity();
        envelope[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        ageSamples[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0;
    }
    else if (message.isNoteOff())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        if (sustainPedal[static_cast<size_t>(channel)])
            sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        else
            releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& notes : releasing[static_cast<size_t>(channel)])
            notes = true;
        for (auto& notes : sustained[static_cast<size_t>(channel)])
            notes = false;
    }
}

void S13PianoInstrument::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    buffer.clear();
    const float toneValue = juce::jlimit(0.0f, 1.0f, tone.load(std::memory_order_relaxed));
    const float bodyValue = juce::jlimit(0.0f, 1.0f, body.load(std::memory_order_relaxed));
    const float hammerValue = juce::jlimit(0.0f, 1.0f, hammer.load(std::memory_order_relaxed));
    const float resonanceValue = juce::jlimit(0.0f, 1.0f, resonance.load(std::memory_order_relaxed));
    const float widthValue = juce::jlimit(0.0f, 1.0f, stereoWidth.load(std::memory_order_relaxed));
    const int modelIndex = juce::jlimit(0, 2, static_cast<int>(std::round(model.load(std::memory_order_relaxed))));
    const float sr = static_cast<float>(juce::jmax(1.0, cachedSampleRate));
    const float attackStep = 1.0f / juce::jmax(1.0f, sr * 0.0038f);
    const float releaseStep = 1.0f / juce::jmax(1.0f, sr * releaseMs.load(std::memory_order_relaxed) * 0.001f);
    const float outGain = juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, outputGain.load(std::memory_order_relaxed))) * 0.78f;
    const float twoPi = juce::MathConstants<float>::twoPi;
    std::array<BuiltInMidiVoiceRef, kBuiltInMidiVoiceSlots> voiceRefs {};

    auto render = [&] (int start, int end)
    {
        int voiceCount = 0;
        for (size_t channel = 0; channel < active.size(); ++channel)
        {
            for (size_t note = 0; note < active[channel].size(); ++note)
            {
                if (active[channel][note] || envelope[channel][note] > 0.0f)
                    voiceRefs[static_cast<size_t>(voiceCount++)] = { channel, note };
            }
        }

        for (int sample = start; sample < end; ++sample)
        {
            float mixedL = 0.0f;
            float mixedR = 0.0f;
            for (int voiceIndex = 0; voiceIndex < voiceCount;)
            {
                const auto voiceRef = voiceRefs[static_cast<size_t>(voiceIndex)];
                const size_t channel = voiceRef.channel;
                const size_t note = voiceRef.note;

                if (!active[channel][note] && envelope[channel][note] <= 0.0f)
                {
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                if (active[channel][note] && !releasing[channel][note])
                    envelope[channel][note] = juce::jmin(1.0f, envelope[channel][note] + attackStep);
                else
                    envelope[channel][note] = juce::jmax(0.0f, envelope[channel][note] - releaseStep);

                if (envelope[channel][note] <= 0.0f)
                {
                    active[channel][note] = false;
                    releasing[channel][note] = false;
                    sustained[channel][note] = false;
                    velocity[channel][note] = 0.0f;
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const float freq = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(static_cast<int>(note)));
                const float ageSec = static_cast<float>(ageSamples[channel][note]) / sr;
                const float noteBright = juce::jlimit(0.35f, 1.35f, 0.72f + (static_cast<float>(note) - 60.0f) * 0.008f);
                const float modelTone = modelIndex == 1 ? 1.22f : (modelIndex == 2 ? 0.72f : 1.0f);
                const float pedalLength = sustainPedal[channel] ? 1.0f + resonanceValue * 0.8f : 1.0f;
                const float decay = std::exp(-ageSec / ((0.85f + bodyValue * 2.6f + (1.0f - noteBright) * 0.4f) * pedalLength));
                const float p = phase[channel][note];
                const float strike = builtinNoise(ageSamples[channel][note], static_cast<int>(note))
                    * std::exp(-ageSec / 0.012f) * (0.012f + hammerValue * 0.045f) * modelTone;
                const float fundamental = std::sin(twoPi * p) * (0.82f + bodyValue * 0.28f);
                const float partial2 = std::sin(twoPi * p * 2.003f) * (0.24f + toneValue * 0.20f * modelTone)
                                     * std::exp(-ageSec / 1.1f) * nyquistFade(freq * 2.003f, sr);
                const float partial3 = std::sin(twoPi * p * 3.011f) * (0.13f + toneValue * 0.15f * modelTone)
                                     * std::exp(-ageSec / 0.74f) * nyquistFade(freq * 3.011f, sr);
                const float partial5 = std::sin(twoPi * p * 5.031f) * (0.04f + toneValue * 0.08f * modelTone)
                                     * std::exp(-ageSec / 0.42f) * nyquistFade(freq * 5.031f, sr);
                const float soundboard = std::sin(twoPi * p * 1.497f + 0.7f) * resonanceValue * 0.09f
                                       * std::exp(-ageSec / 3.8f) * nyquistFade(freq * 1.497f, sr);
                const float feltDamping = modelIndex == 2 ? 0.72f : 1.0f;
                const float voice = (fundamental + partial2 + partial3 + partial5 + soundboard + strike)
                                  * decay * envelope[channel][note] * velocity[channel][note] * outGain * feltDamping;
                const float pan = juce::jlimit(-0.82f, 0.82f, (static_cast<float>(note) - 60.0f) / 36.0f * widthValue);
                const float leftGain = std::sqrt(0.5f * (1.0f - pan));
                const float rightGain = std::sqrt(0.5f * (1.0f + pan));
                mixedL += voice * leftGain;
                mixedR += voice * rightGain;

                phase[channel][note] += freq / sr;
                if (phase[channel][note] >= 1.0f)
                    phase[channel][note] -= std::floor(phase[channel][note]);
                ++ageSamples[channel][note];
                ++voiceIndex;
            }

            mixedL = softLimitInstrumentBus(mixedL);
            mixedR = softLimitInstrumentBus(mixedR);
            if (numChannels == 1)
            {
                buffer.addSample(0, sample, (mixedL + mixedR) * 0.707f);
            }
            else
            {
                buffer.addSample(0, sample, mixedL);
                buffer.addSample(1, sample, mixedR);
                for (int ch = 2; ch < numChannels; ++ch)
                    buffer.addSample(ch, sample, (mixedL + mixedR) * 0.5f);
            }
        }
    };

    int cursor = 0;
    for (const auto metadata : midi)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        render(cursor, eventSample);
        handleMidi(metadata.getMessage());
        cursor = eventSample;
    }
    render(cursor, numSamples);
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13PianoInstrument::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13PianoInstrument", {
        { "tone", tone.load() },
        { "body", body.load() },
        { "hammer", hammer.load() },
        { "releaseMs", releaseMs.load() },
        { "outputGain", outputGain.load() },
        { "resonance", resonance.load() },
        { "stereoWidth", stereoWidth.load() },
        { "model", model.load() }
    });
}

void S13PianoInstrument::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13PianoInstrument");
    if (!tree.isValid())
        return;

    tone       = static_cast<float>((double)tree.getProperty("tone", 0.58));
    body       = static_cast<float>((double)tree.getProperty("body", 0.72));
    hammer     = static_cast<float>((double)tree.getProperty("hammer", 0.42));
    releaseMs  = static_cast<float>((double)tree.getProperty("releaseMs", 950.0));
    outputGain = static_cast<float>((double)tree.getProperty("outputGain", -15.0));
    resonance  = static_cast<float>((double)tree.getProperty("resonance", 0.38));
    stereoWidth = static_cast<float>((double)tree.getProperty("stereoWidth", 0.62));
    model      = static_cast<float>((double)tree.getProperty("model", 0.0));
}

bool S13PianoInstrument::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    return mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
}

// ============================================================================
//  S13DrumInstrument
// ============================================================================

S13DrumInstrument::S13DrumInstrument()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    hihatPedal.fill(0.65f);
}

void S13DrumInstrument::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    clearVoices();
}

void S13DrumInstrument::releaseResources()
{
    clearVoices();
}

void S13DrumInstrument::clearVoices()
{
    for (auto& notes : active) notes.fill(false);
    for (auto& notes : phase) notes.fill(0.0f);
    for (auto& notes : velocity) notes.fill(0.0f);
    for (auto& notes : ageSamples) notes.fill(0);
}

int S13DrumInstrument::mapIncomingNote(int note) const
{
    const int preset = juce::jlimit(0, 1, static_cast<int>(std::round(mapPreset.load(std::memory_order_relaxed))));
    if (preset == 0)
        return note;

    switch (note)
    {
        case 22: return 42; // TD closed hi-hat edge
        case 26: return 46; // TD open hi-hat edge
        case 47: return 45; // mid tom rim -> mid tom
        case 50: return 48; // high tom rim -> high tom
        case 58: return 43; // low tom rim -> floor tom
        case 55: return 49; // crash edge -> crash
        case 52: return 57; // second crash/china edge -> crash 2
        case 59: return 51; // ride edge -> ride
        case 53: return 51; // ride bell -> ride family voice
        default: return note;
    }
}

void S13DrumInstrument::handleMidi(const juce::MidiMessage& message)
{
    const int channel = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);
    if (message.isController() && message.getControllerNumber() == 4)
    {
        hihatPedal[static_cast<size_t>(channel)] = static_cast<float>(message.getControllerValue()) / 127.0f;
        return;
    }

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, mapIncomingNote(message.getNoteNumber()));
        const float curve = juce::jlimit(-1.0f, 1.0f, velocityCurve.load(std::memory_order_relaxed));
        const float exponent = juce::jmap(curve, -1.0f, 1.0f, 1.65f, 0.62f);
        const float curvedVelocity = std::pow(juce::jlimit(0.0f, 1.0f, message.getFloatVelocity()), exponent);
        active[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        phase[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        velocity[static_cast<size_t>(channel)][static_cast<size_t>(note)] = curvedVelocity;
        ageSamples[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0;

        if (note == 42 || note == 44)
            active[static_cast<size_t>(channel)][46] = false;
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        active[static_cast<size_t>(channel)].fill(false);
    }
}

void S13DrumInstrument::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    buffer.clear();
    const int kitIndex = juce::jlimit(0, 2, static_cast<int>(std::round(kit.load(std::memory_order_relaxed))));
    const float tune = std::pow(2.0f, juce::jlimit(-12.0f, 12.0f, tuning.load(std::memory_order_relaxed)) / 12.0f);
    const float room = juce::jlimit(0.0f, 1.0f, ambience.load(std::memory_order_relaxed));
    const float tightness = juce::jlimit(0.0f, 1.0f, hihatTightness.load(std::memory_order_relaxed));
    const float punchValue = juce::jlimit(0.0f, 1.0f, punch.load(std::memory_order_relaxed));
    const float widthValue = juce::jlimit(0.0f, 1.0f, stereoWidth.load(std::memory_order_relaxed));
    const float gain = juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, outputGain.load(std::memory_order_relaxed)));
    const float twoPi = juce::MathConstants<float>::twoPi;
    std::array<BuiltInMidiVoiceRef, kBuiltInMidiVoiceSlots> voiceRefs {};

    auto render = [&] (int start, int end)
    {
        int voiceCount = 0;
        for (size_t channel = 0; channel < active.size(); ++channel)
        {
            for (size_t note = 0; note < active[channel].size(); ++note)
            {
                if (active[channel][note])
                    voiceRefs[static_cast<size_t>(voiceCount++)] = { channel, note };
            }
        }

        for (int sample = start; sample < end; ++sample)
        {
            float mixedL = 0.0f;
            float mixedR = 0.0f;
            for (int voiceIndex = 0; voiceIndex < voiceCount;)
            {
                const auto voiceRef = voiceRefs[static_cast<size_t>(voiceIndex)];
                const size_t channel = voiceRef.channel;
                const size_t note = voiceRef.note;
                const float pedalClosed = juce::jlimit(0.0f, 1.0f, hihatPedal[channel] * tightness);

                if (!active[channel][note])
                {
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const int midiNote = static_cast<int>(note);
                const float ageSec = static_cast<float>(ageSamples[channel][note]) / static_cast<float>(cachedSampleRate);
                const float velocityValue = velocity[channel][note];
                const float decay = drumDecaySeconds(midiNote, pedalClosed) * (0.82f + velocityValue * 0.42f);
                const float env = std::exp(-ageSec / decay);
                if (env < 0.0002f)
                {
                    active[channel][note] = false;
                    velocity[channel][note] = 0.0f;
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const float noise = builtinNoise(ageSamples[channel][note], midiNote);
                const float sweep = (midiNote == 35 || midiNote == 36) ? std::exp(-ageSec / 0.035f) * 72.0f : 0.0f;
                const float freq = juce::jlimit(20.0f, 8000.0f, drumBaseFrequency(midiNote) * tune + sweep);
                phase[channel][note] += freq / static_cast<float>(cachedSampleRate);
                if (phase[channel][note] >= 1.0f)
                    phase[channel][note] -= std::floor(phase[channel][note]);

                float drum = 0.0f;
                if (midiNote == 35 || midiNote == 36)
                {
                    const float body = std::sin(twoPi * phase[channel][note]) * std::exp(-ageSec / (kitIndex == 1 ? 0.52f : 0.36f));
                    const float click = noise * std::exp(-ageSec / 0.012f) * (kitIndex == 2 ? 0.38f : 0.18f) * (0.7f + punchValue * 0.8f);
                    drum = body * 1.18f + click;
                }
                else if (midiNote == 37 || midiNote == 38 || midiNote == 40)
                {
                    const float snap = noise * std::exp(-ageSec / (kitIndex == 1 ? 0.22f : 0.16f));
                    const float body = std::sin(twoPi * phase[channel][note]) * std::exp(-ageSec / 0.12f);
                    drum = snap * (kitIndex == 2 ? 0.95f : 0.72f) * (0.75f + punchValue * 0.65f) + body * 0.34f;
                }
                else if (midiNote == 42 || midiNote == 44 || midiNote == 46 || midiNote == 22 || midiNote == 26)
                {
                    const float metal = std::sin(twoPi * phase[channel][note] * 7.1f) * 0.24f
                                      + std::sin(twoPi * phase[channel][note] * 11.7f) * 0.18f;
                    drum = (noise * 0.78f + metal) * env;
                }
                else if (midiNote == 49 || midiNote == 51 || midiNote == 52 || midiNote == 53
                         || midiNote == 55 || midiNote == 57 || midiNote == 59)
                {
                    const float shimmer = std::sin(twoPi * phase[channel][note] * 5.3f) * 0.15f
                                        + std::sin(twoPi * phase[channel][note] * 9.7f) * 0.12f;
                    drum = (noise * 0.64f + shimmer) * env;
                }
                else
                {
                    const float body = std::sin(twoPi * phase[channel][note]) * env;
                    drum = body * 0.9f + noise * 0.08f * std::exp(-ageSec / 0.04f);
                }

                const float roomTail = std::sin(twoPi * phase[channel][note] * 0.37f + static_cast<float>(midiNote))
                    * room * 0.08f * std::exp(-ageSec / 0.9f);
                const float voice = (drum + roomTail) * velocityValue * gain * 0.85f;
                const float pan = drumPanPosition(midiNote) * widthValue;
                const float leftGain = std::sqrt(0.5f * (1.0f - pan));
                const float rightGain = std::sqrt(0.5f * (1.0f + pan));
                mixedL += voice * leftGain;
                mixedR += voice * rightGain;
                ++ageSamples[channel][note];
                ++voiceIndex;
            }

            mixedL = softLimitInstrumentBus(mixedL);
            mixedR = softLimitInstrumentBus(mixedR);
            if (numChannels == 1)
            {
                buffer.addSample(0, sample, (mixedL + mixedR) * 0.707f);
            }
            else
            {
                buffer.addSample(0, sample, mixedL);
                buffer.addSample(1, sample, mixedR);
                for (int ch = 2; ch < numChannels; ++ch)
                    buffer.addSample(ch, sample, (mixedL + mixedR) * 0.5f);
            }
        }
    };

    int cursor = 0;
    for (const auto metadata : midi)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        render(cursor, eventSample);
        handleMidi(metadata.getMessage());
        cursor = eventSample;
    }
    render(cursor, numSamples);
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13DrumInstrument::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13DrumInstrument", {
        { "kit", kit.load() },
        { "tuning", tuning.load() },
        { "ambience", ambience.load() },
        { "outputGain", outputGain.load() },
        { "hihatTightness", hihatTightness.load() },
        { "mapPreset", mapPreset.load() },
        { "punch", punch.load() },
        { "stereoWidth", stereoWidth.load() },
        { "velocityCurve", velocityCurve.load() }
    });
}

void S13DrumInstrument::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13DrumInstrument");
    if (!tree.isValid())
        return;

    kit            = static_cast<float>((double)tree.getProperty("kit", 0.0));
    tuning         = static_cast<float>((double)tree.getProperty("tuning", 0.0));
    ambience       = static_cast<float>((double)tree.getProperty("ambience", 0.18));
    outputGain     = static_cast<float>((double)tree.getProperty("outputGain", -10.0));
    hihatTightness = static_cast<float>((double)tree.getProperty("hihatTightness", 0.65));
    mapPreset      = static_cast<float>((double)tree.getProperty("mapPreset", 0.0));
    punch          = static_cast<float>((double)tree.getProperty("punch", 0.55));
    stereoWidth    = static_cast<float>((double)tree.getProperty("stereoWidth", 0.7));
    velocityCurve  = static_cast<float>((double)tree.getProperty("velocityCurve", 0.0));
}

bool S13DrumInstrument::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    return mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
}

bool S13Saturator::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}
