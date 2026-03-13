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
}

float S13Delay::syncNoteToMs(float noteIndex, double bpm)
{
    if (bpm <= 0.0)
        bpm = 120.0;

    const float quarterMs = static_cast<float>(60000.0 / bpm);

    // 0=1/4, 1=1/8, 2=1/16, 3=1/4d, 4=1/8d, 5=1/16d, 6=1/4t, 7=1/8t, 8=1/16t
    const int idx = juce::jlimit(0, 8, static_cast<int>(noteIndex));

    static const float baseMultipliers[] = {
        1.0f,         // 1/4
        0.5f,         // 1/8
        0.25f,        // 1/16
        1.5f,         // 1/4 dotted
        0.75f,        // 1/8 dotted
        0.375f,       // 1/16 dotted
        2.0f / 3.0f,  // 1/4 triplet
        1.0f / 3.0f,  // 1/8 triplet
        1.0f / 6.0f   // 1/16 triplet
    };

    return quarterMs * baseMultipliers[idx];
}

void S13Delay::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);

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

    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        const float inL = dataL[i];
        const float inR = dataR ? dataR[i] : inL;

        // Read from delay lines
        delayLineL.setDelay(delaySamplesL);
        delayLineR.setDelay(delaySamplesR);

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
        dataL[i] = inL * dry + wetL * wet;
        if (dataR)
            dataR[i] = inR * dry + wetR * wet;
    }
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
        { "delayMode",    delayMode.load() }
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
}

void S13Reverb::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);

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

    // Update tone filters
    auto lcCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(cachedSampleRate, lc);
    wetLowCutL.coefficients = lcCoeffs;
    wetLowCutR.coefficients = lcCoeffs;

    auto hcCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(cachedSampleRate, hc);
    wetHighCutL.coefficients = hcCoeffs;
    wetHighCutR.coefficients = hcCoeffs;

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

    // Update reverb parameters
    juce::dsp::Reverb::Parameters params;
    params.roomSize   = roomSizeAdj;
    params.damping    = dampingAdj;
    params.wetLevel   = 1.0f; // We handle wet/dry ourselves
    params.dryLevel   = 0.0f;
    params.width      = widthAdj;
    params.freezeMode = freezeMode.load() >= 0.5f ? 1.0f : 0.0f;
    reverb.setParameters(params);

    // Store dry signal
    juce::AudioBuffer<float> dryBuffer(numChannels, numSamples);
    for (int ch = 0; ch < numChannels; ++ch)
        dryBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamples);

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

    // Process reverb (now buffer contains pre-delayed signal -> reverb processes it -> buffer = wet only)
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    reverb.process(context);

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

    // Mix: dry * dryLevel + wet * wetLevel * earlyLevel blend
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* out = buffer.getWritePointer(ch);
        const auto* dryData = dryBuffer.getReadPointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            out[i] = dryData[i] * dryLvl + out[i] * wetLvl * earlyLvl;
        }
    }
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

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    const auto currentMode = static_cast<Mode>(juce::jlimit(0, 2, static_cast<int>(mode.load())));
    const auto currentLFOShape = static_cast<LFOShape>(juce::jlimit(0, 3, static_cast<int>(lfoShape.load())));
    const float lfoRate = juce::jlimit(0.01f, 20.0f, rate.load());
    const float lfoDepth = juce::jlimit(0.0f, 1.0f, depth.load());
    const float fb = juce::jlimit(-1.0f, 1.0f, fbAmount.load());
    const float wet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float dry = 1.0f - wet;
    const int numVoices = juce::jlimit(1, maxVoices, static_cast<int>(voices.load()));
    const float spreadVal = juce::jlimit(0.0f, 1.0f, spread.load());

    const float phaseInc = lfoRate * juce::MathConstants<float>::twoPi
                         / static_cast<float>(cachedSampleRate);

    const float voiceGain = 1.0f / static_cast<float>(numVoices);

    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    if (currentMode == Mode::Phaser)
    {
        // Phaser mode: modulated all-pass filters
        const int numStages = juce::jlimit(2, maxPhaserStages, numVoices * 2);
        const float minFreq = 200.0f;
        const float maxFreq = 4000.0f;

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dataL[i];
            const float inR = dataR ? dataR[i] : inL;

            // LFO modulates the all-pass center frequency
            const float lfoVal = getLFOValue(lfoPhase[0], currentLFOShape);
            const float modFreq = minFreq + (maxFreq - minFreq) * (lfoVal * lfoDepth * 0.5f + 0.5f);

            // Update all-pass coefficients
            auto apCoeffs = juce::dsp::IIR::Coefficients<float>::makeAllPass(cachedSampleRate, modFreq);

            float procL = inL + feedbackState[0] * fb;
            float procR = inR + feedbackState[1] * fb;

            for (int s = 0; s < numStages; ++s)
            {
                allpassL[s].coefficients = apCoeffs;
                allpassR[s].coefficients = apCoeffs;
                procL = allpassL[s].processSample(procL);
                procR = allpassR[s].processSample(procR);
            }

            feedbackState[0] = procL;
            feedbackState[1] = procR;

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

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dataL[i];
            const float inR = dataR ? dataR[i] : inL;

            float wetL = 0.0f;
            float wetR = 0.0f;

            for (int v = 0; v < numVoices; ++v)
            {
                const float lfoVal = getLFOValue(lfoPhase[v], currentLFOShape);
                const float delaySamples = centerDelaySamples + depthSamples * lfoVal;

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
                    const float delaySamplesR = centerDelaySamples + depthSamples * lfoValR;
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

            feedbackState[0] = wetL;
            feedbackState[1] = wetR;

            dataL[i] = inL * dry + wetL * wet;
            if (dataR)
                dataR[i] = inR * dry + wetR * wet;
        }
    }
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
        { "tempoSync", tempoSync.load() }
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
    lastToneFreq = juce::jlimit(200.0f, 20000.0f, toneFreq.load());
    auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastToneFreq);
    toneFilterL.coefficients = coeffs;
    toneFilterR.coefficients = coeffs;

    // Initialize oversampling based on mode
    const int osMode = juce::jlimit(0, 2, static_cast<int>(oversampleMode.load()));
    const int osFactor = (osMode == 0) ? 0 : (osMode == 1 ? 1 : 2); // 0=off, 1=2x, 2=4x
    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, osFactor, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
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
    }

    return std::tanh(x); // fallback
}

void S13Saturator::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);

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

    const float driveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    const float driveLinear = juce::Decibels::decibelsToGain(driveDB);
    const float wet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float dry = 1.0f - wet;
    const float outGainDB = juce::jlimit(-12.0f, 0.0f, outputGain.load());
    const float outGainLinear = juce::Decibels::decibelsToGain(outGainDB);
    const auto type = static_cast<SatType>(juce::jlimit(0, 4, static_cast<int>(satType.load())));
    const float asym = juce::jlimit(-1.0f, 1.0f, asymmetry.load());

    auto applySaturation = [&](juce::AudioBuffer<float>& buf)
    {
        const int ns = buf.getNumSamples();
        auto* dL = buf.getWritePointer(0);
        auto* dR = (buf.getNumChannels() >= 2) ? buf.getWritePointer(1) : nullptr;

        for (int i = 0; i < ns; ++i)
        {
            const float inL = dL[i];
            float satL = processSample(inL, driveLinear, type, asym);
            satL = toneFilterL.processSample(satL);
            satL *= outGainLinear;
            dL[i] = inL * dry + satL * wet;

            if (dR)
            {
                const float inR = dR[i];
                float satR = processSample(inR, driveLinear, type, asym);
                satR = toneFilterR.processSample(satR);
                satR *= outGainLinear;
                dR[i] = inR * dry + satR * wet;
            }
        }
    };

    // Oversampling path
    if (oversamplingEnabled && oversampler)
    {
        juce::dsp::AudioBlock<float> block(buffer);
        auto oversampledBlock = oversampler->processSamplesUp(block);

        juce::AudioBuffer<float> osBuffer(static_cast<int>(oversampledBlock.getNumChannels()),
                                           static_cast<int>(oversampledBlock.getNumSamples()));
        for (int ch = 0; ch < static_cast<int>(oversampledBlock.getNumChannels()); ++ch)
            osBuffer.copyFrom(ch, 0, oversampledBlock.getChannelPointer(static_cast<size_t>(ch)),
                              static_cast<int>(oversampledBlock.getNumSamples()));

        applySaturation(osBuffer);

        for (int ch = 0; ch < static_cast<int>(oversampledBlock.getNumChannels()); ++ch)
            juce::FloatVectorOperations::copy(oversampledBlock.getChannelPointer(static_cast<size_t>(ch)),
                                              osBuffer.getReadPointer(ch),
                                              static_cast<int>(oversampledBlock.getNumSamples()));

        oversampler->processSamplesDown(block);
    }
    else
    {
        applySaturation(buffer);
    }
}

void S13Saturator::releaseResources()
{
    toneFilterL.reset();
    toneFilterR.reset();
}

void S13Saturator::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Saturator", {
        { "satType",        satType.load() },
        { "drive",          drive.load() },
        { "mix",            mix.load() },
        { "toneFreq",       toneFreq.load() },
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
    outputGain     = static_cast<float>((double)tree.getProperty("outputGain", 0.0));
    asymmetry      = static_cast<float>((double)tree.getProperty("asymmetry", 0.0));
    oversampleMode = static_cast<float>((double)tree.getProperty("oversampleMode", 1.0));
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
