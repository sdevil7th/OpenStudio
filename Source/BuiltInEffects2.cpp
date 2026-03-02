#include "BuiltInEffects2.h"

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

    // Prepare feedback LPFs
    feedbackLPF_L.reset();
    feedbackLPF_R.reset();
    lastLPFFreq = lpfFreq.load();
    auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastLPFFreq);
    feedbackLPF_L.coefficients = coeffs;
    feedbackLPF_R.coefficients = coeffs;

    feedbackSampleL = 0.0f;
    feedbackSampleR = 0.0f;
}

float S13Delay::syncNoteToMs(float noteIndex, double bpm)
{
    if (bpm <= 0.0)
        bpm = 120.0;

    // Beat duration in ms for a quarter note
    const float quarterMs = static_cast<float>(60000.0 / bpm);

    // Note value table: base note length in quarter-note multiples
    // 0=1/4, 1=1/8, 2=1/16, 3=1/4d, 4=1/8d, 5=1/16d, 6=1/4t, 7=1/8t, 8=1/16t
    const int idx = juce::jlimit(0, 8, static_cast<int>(noteIndex));

    // Base lengths in quarter-note multiples
    static const float baseMultipliers[] = {
        1.0f,       // 1/4
        0.5f,       // 1/8
        0.25f,      // 1/16
        1.5f,       // 1/4 dotted (1/4 * 1.5)
        0.75f,      // 1/8 dotted (1/8 * 1.5)
        0.375f,     // 1/16 dotted (1/16 * 1.5)
        2.0f / 3.0f,  // 1/4 triplet (1/4 * 2/3)
        1.0f / 3.0f,  // 1/8 triplet (1/8 * 2/3)
        1.0f / 6.0f   // 1/16 triplet (1/16 * 2/3)
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

    // Compute delay times in samples
    const bool isTempSync = tempoSync.load() >= 0.5f;
    float delayMsL = 250.0f;
    float delayMsR = 250.0f;
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
    const float wet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float dry = 1.0f - wet;
    const bool isPingPong = pingPong.load() >= 0.5f;

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

        // Feedback through LPF
        const float fbL = feedbackLPF_L.processSample(feedbackSampleL);
        const float fbR = feedbackLPF_R.processSample(feedbackSampleR);

        // Write to delay lines
        if (isPingPong)
        {
            // Ping-pong: left input + right feedback -> left delay
            //            right input + left feedback -> right delay
            delayLineL.pushSample(0, inL + fbR * fb);
            delayLineR.pushSample(0, inR + fbL * fb);
        }
        else
        {
            // Normal stereo delay
            delayLineL.pushSample(0, inL + fbL * fb);
            delayLineR.pushSample(0, inR + fbR * fb);
        }

        // Store feedback samples for next iteration
        feedbackSampleL = delayedL;
        feedbackSampleR = delayedR;

        // Mix dry + wet
        dataL[i] = inL * dry + delayedL * wet;
        if (dataR)
            dataR[i] = inR * dry + delayedR * wet;
    }
}

void S13Delay::releaseResources()
{
    delayLineL.reset();
    delayLineR.reset();
    feedbackLPF_L.reset();
    feedbackLPF_R.reset();
    feedbackSampleL = 0.0f;
    feedbackSampleR = 0.0f;
}

void S13Delay::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Delay", {
        { "delayTimeL", delayTimeL.load() },
        { "delayTimeR", delayTimeR.load() },
        { "feedback",   feedback.load() },
        { "mix",        mix.load() },
        { "pingPong",   pingPong.load() },
        { "tempoSync",  tempoSync.load() },
        { "syncNoteL",  syncNoteL.load() },
        { "syncNoteR",  syncNoteR.load() },
        { "lpfFreq",    lpfFreq.load() }
    });
}

void S13Delay::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Delay");
    if (!tree.isValid())
        return;

    delayTimeL = static_cast<float>((double)tree.getProperty("delayTimeL", 250.0));
    delayTimeR = static_cast<float>((double)tree.getProperty("delayTimeR", 250.0));
    feedback   = static_cast<float>((double)tree.getProperty("feedback", 0.4));
    mix        = static_cast<float>((double)tree.getProperty("mix", 0.5));
    pingPong   = static_cast<float>((double)tree.getProperty("pingPong", 0.0));
    tempoSync  = static_cast<float>((double)tree.getProperty("tempoSync", 0.0));
    syncNoteL  = static_cast<float>((double)tree.getProperty("syncNoteL", 0.0));
    syncNoteR  = static_cast<float>((double)tree.getProperty("syncNoteR", 0.0));
    lpfFreq    = static_cast<float>((double)tree.getProperty("lpfFreq", 20000.0));
}

bool S13Delay::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    // Accept stereo or mono
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
    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2;

    reverb.prepare(spec);
    reverb.reset();
}

void S13Reverb::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);

    // Update reverb parameters each block
    juce::dsp::Reverb::Parameters params;
    params.roomSize   = juce::jlimit(0.0f, 1.0f, roomSize.load());
    params.damping    = juce::jlimit(0.0f, 1.0f, damping.load());
    params.wetLevel   = juce::jlimit(0.0f, 1.0f, wetLevel.load());
    params.dryLevel   = juce::jlimit(0.0f, 1.0f, dryLevel.load());
    params.width      = juce::jlimit(0.0f, 1.0f, width.load());
    params.freezeMode = freezeMode.load() >= 0.5f ? 1.0f : 0.0f;
    reverb.setParameters(params);

    // Process as a stereo block via the dsp::AudioBlock interface
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    reverb.process(context);
}

void S13Reverb::releaseResources()
{
    reverb.reset();
}

void S13Reverb::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Reverb", {
        { "roomSize",   roomSize.load() },
        { "damping",    damping.load() },
        { "wetLevel",   wetLevel.load() },
        { "dryLevel",   dryLevel.load() },
        { "width",      width.load() },
        { "freezeMode", freezeMode.load() }
    });
}

void S13Reverb::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Reverb");
    if (!tree.isValid())
        return;

    roomSize   = static_cast<float>((double)tree.getProperty("roomSize", 0.5));
    damping    = static_cast<float>((double)tree.getProperty("damping", 0.5));
    wetLevel   = static_cast<float>((double)tree.getProperty("wetLevel", 0.33));
    dryLevel   = static_cast<float>((double)tree.getProperty("dryLevel", 0.7));
    width      = static_cast<float>((double)tree.getProperty("width", 1.0));
    freezeMode = static_cast<float>((double)tree.getProperty("freezeMode", 0.0));
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
    // Initialize LFO phases with spread across voices
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

    feedbackState[0] = 0.0f;
    feedbackState[1] = 0.0f;
}

void S13Chorus::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    const float lfoRate = juce::jlimit(0.1f, 10.0f, rate.load());
    const float lfoDepth = juce::jlimit(0.0f, 1.0f, depth.load());
    const float fb = juce::jlimit(-1.0f, 1.0f, fbAmount.load());
    const float wet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float dry = 1.0f - wet;
    const int numVoices = juce::jlimit(1, maxVoices, static_cast<int>(voices.load()));

    // LFO phase increment per sample
    const float phaseInc = lfoRate * juce::MathConstants<float>::twoPi
                         / static_cast<float>(cachedSampleRate);

    // Chorus delay center and depth in samples
    // Center delay: 7ms, modulation depth: up to 13ms (7-20ms range)
    const float centerDelaySamples = static_cast<float>(0.007 * cachedSampleRate);
    const float depthSamples = static_cast<float>(0.013 * cachedSampleRate) * lfoDepth;

    const float voiceGain = 1.0f / static_cast<float>(numVoices);

    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        const float inL = dataL[i];
        const float inR = dataR ? dataR[i] : inL;

        float wetL = 0.0f;
        float wetR = 0.0f;

        for (int v = 0; v < numVoices; ++v)
        {
            // LFO value per voice (sine)
            const float lfoVal = std::sin(lfoPhase[v]);
            const float delaySamples = centerDelaySamples + depthSamples * lfoVal;

            // Push input + feedback into delay lines
            delayLines[0][v].pushSample(0, inL + feedbackState[0] * fb);
            if (numChannels >= 2)
                delayLines[1][v].pushSample(0, inR + feedbackState[1] * fb);

            // Read from delay with modulated time
            delayLines[0][v].setDelay(delaySamples);
            const float outL = delayLines[0][v].popSample(0);
            wetL += outL;

            if (numChannels >= 2)
            {
                // Slight stereo spread: invert LFO for right channel on even voices
                const float lfoValR = std::sin(lfoPhase[v] + juce::MathConstants<float>::pi * static_cast<float>(v % 2));
                const float delaySamplesR = centerDelaySamples + depthSamples * lfoValR;
                delayLines[1][v].setDelay(delaySamplesR);
                const float outR = delayLines[1][v].popSample(0);
                wetR += outR;
            }

            // Advance LFO phase for this voice
            lfoPhase[v] += phaseInc;
            if (lfoPhase[v] >= juce::MathConstants<float>::twoPi)
                lfoPhase[v] -= juce::MathConstants<float>::twoPi;
        }

        // Scale by number of voices
        wetL *= voiceGain;
        wetR *= voiceGain;

        // Update feedback state
        feedbackState[0] = wetL;
        feedbackState[1] = wetR;

        // Mix
        dataL[i] = inL * dry + wetL * wet;
        if (dataR)
            dataR[i] = inR * dry + wetR * wet;
    }
}

void S13Chorus::releaseResources()
{
    for (int ch = 0; ch < 2; ++ch)
        for (int v = 0; v < maxVoices; ++v)
            delayLines[ch][v].reset();

    feedbackState[0] = 0.0f;
    feedbackState[1] = 0.0f;
}

void S13Chorus::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Chorus", {
        { "rate",     rate.load() },
        { "depth",    depth.load() },
        { "feedback", fbAmount.load() },
        { "mix",      mix.load() },
        { "voices",   voices.load() }
    });
}

void S13Chorus::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Chorus");
    if (!tree.isValid())
        return;

    rate     = static_cast<float>((double)tree.getProperty("rate", 1.0));
    depth    = static_cast<float>((double)tree.getProperty("depth", 0.5));
    fbAmount = static_cast<float>((double)tree.getProperty("feedback", 0.0));
    mix      = static_cast<float>((double)tree.getProperty("mix", 0.5));
    voices   = static_cast<float>((double)tree.getProperty("voices", 2.0));
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

    // Initialize 2x oversampling (Phase 20.12)
    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
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

    // Convert parameters to linear
    const float driveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    const float driveLinear = juce::Decibels::decibelsToGain(driveDB);
    const float wet = juce::jlimit(0.0f, 1.0f, mix.load());
    const float dry = 1.0f - wet;
    const float outGainDB = juce::jlimit(-12.0f, 0.0f, outputGain.load());
    const float outGainLinear = juce::Decibels::decibelsToGain(outGainDB);

    // Lambda for the saturation core — used in both normal and oversampled paths
    auto applySaturation = [&] (juce::AudioBuffer<float>& buf)
    {
        const int ns = buf.getNumSamples();
        auto* dL = buf.getWritePointer(0);
        auto* dR = (buf.getNumChannels() >= 2) ? buf.getWritePointer(1) : nullptr;

        for (int i = 0; i < ns; ++i)
        {
            const float inL = dL[i];
            float satL = std::tanh(inL * driveLinear);
            satL = toneFilterL.processSample(satL);
            satL *= outGainLinear;
            dL[i] = inL * dry + satL * wet;

            if (dR)
            {
                const float inR = dR[i];
                float satR = std::tanh(inR * driveLinear);
                satR = toneFilterR.processSample(satR);
                satR *= outGainLinear;
                dR[i] = inR * dry + satR * wet;
            }
        }
    };

    // 2x oversampling path (Phase 20.12)
    if (oversamplingEnabled && oversampler)
    {
        juce::dsp::AudioBlock<float> block(buffer);
        auto oversampledBlock = oversampler->processSamplesUp(block);

        // Process the oversampled data through a temporary buffer
        juce::AudioBuffer<float> osBuffer(static_cast<int>(oversampledBlock.getNumChannels()),
                                           static_cast<int>(oversampledBlock.getNumSamples()));
        for (int ch = 0; ch < static_cast<int>(oversampledBlock.getNumChannels()); ++ch)
            osBuffer.copyFrom(ch, 0, oversampledBlock.getChannelPointer(static_cast<size_t>(ch)),
                              static_cast<int>(oversampledBlock.getNumSamples()));

        applySaturation(osBuffer);

        // Copy back to oversampled block
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
        { "drive",      drive.load() },
        { "mix",        mix.load() },
        { "toneFreq",   toneFreq.load() },
        { "outputGain", outputGain.load() }
    });
}

void S13Saturator::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Saturator");
    if (!tree.isValid())
        return;

    drive      = static_cast<float>((double)tree.getProperty("drive", 6.0));
    mix        = static_cast<float>((double)tree.getProperty("mix", 1.0));
    toneFreq   = static_cast<float>((double)tree.getProperty("toneFreq", 20000.0));
    outputGain = static_cast<float>((double)tree.getProperty("outputGain", 0.0));
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
