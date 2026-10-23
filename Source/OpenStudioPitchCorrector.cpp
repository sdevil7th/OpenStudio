#include "OpenStudioPitchCorrector.h"
#include "OpenStudioPluginEditors.h"
#include <cmath>
#include <cstring>

OpenStudioPitchCorrector::OpenStudioPitchCorrector()
    : AudioProcessor(BusesProperties()
                        .withInput("Input", juce::AudioChannelSet::stereo(), true)
                        .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void OpenStudioPitchCorrector::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    samplesPerBlock = juce::jmax(1, samplesPerBlock);
    cachedSampleRate = sampleRate;
    activeSignalPath = signalPath.load() >= .5f;

    mapper.setCorrectedNoteMask(signalPath.load() >= .5f);
    detector.setRateNormalized(signalPath.load() >= .5f);
    detector.prepare(sampleRate, samplesPerBlock);
    mapper.prepare(sampleRate);

    // Streaming latency includes both analysis and synthesis, plus the
    // library's split-computation scheduling delay.
    withPitchEngine([&](auto& engine) { engine.presetCheaper(2, static_cast<float>(sampleRate)); });

    // Apply detection params
    detector.setMinFrequency(minFreqParam.load());
    detector.setMaxFrequency(maxFreqParam.load());
    detector.setSensitivity(sensitivity.load());

    setLatencySamples(withPitchEngine([](const auto& engine) { return engine.inputLatency() + engine.outputLatency(); }));
    dryDelay.setSize(2, getLatencySamples() + 1);
    wetMix.reset(sampleRate, 0.010);

    // Pre-allocate per-block scratch buffers so processBlock never heap-allocates.
    // Oversized direct/offline calls are divided into this prepared capacity.
    dryBuffer.setSize (2, samplesPerBlock, false, true, false);
    detectionBuffer.setSize(1, samplesPerBlock, false, true, false);
    stretchOutputBuf.setSize (2, samplesPerBlock, false, true, false);
    inPtrs.resize (2);
    outPtrs.resize (2);
    reset();
}

void OpenStudioPitchCorrector::releaseResources()
{
    reset();
}

void OpenStudioPitchCorrector::reset()
{
    detector.reset();
    const float source = detectionSource.load();
    activeDetectionSource = std::isfinite(source) ? juce::jlimit(0, 2, juce::roundToInt(source)) : 0;
    mapper.reset();
    withPitchEngine([](auto& engine) { engine.reset(); });
    formantSettingsValid = false;
    dryDelay.clear();
    dryDelayPosition = 0;
    dryBuffer.clear();
    stretchOutputBuf.clear();
    wetMix.setCurrentAndTargetValue(bypass.load() > 0.5f ? 0.0f : juce::jlimit(0.0f, 1.0f, mix.load()));
    midiResetPending = currentMidiNote >= 0;
    midiNoteHoldTime = 0.0f;
    lastDetectedHz.store(0.0f);
    lastCorrectedHz.store(0.0f);
    for (auto& frame : pitchHistory)
    {
        frame.generation.fetch_add(1);
        frame.detectedMidi.store(0.0f);
        frame.correctedMidi.store(0.0f);
        frame.confidence.store(0.0f);
        frame.generation.fetch_add(1);
    }
    pitchHistoryWritePos.store(0);
}

void OpenStudioPitchCorrector::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const juce::ScopedNoDenormals noDenormals;
    const int capacity = dryBuffer.getNumSamples();
    const int channels = juce::jmin(2, buffer.getNumChannels());
    if (capacity <= 0 || dryDelay.getNumSamples() <= 0)
    {
        buffer.clear();
        return;
    }
    // Mono/stereo are the only supported layouts. A defensive direct call
    // must not index the two-channel staging buffers through extra channels.
    for (int ch = channels; ch < buffer.getNumChannels(); ++ch)
        buffer.clear(ch, 0, buffer.getNumSamples());
    if (channels == 0) return;
    if (buffer.getNumSamples() <= capacity && buffer.getNumChannels() <= 2)
    {
        processPreparedBlock(buffer, midi, 0);
        return;
    }
    for (int offset = 0; offset < buffer.getNumSamples(); offset += capacity)
    {
        const int count = juce::jmin(capacity, buffer.getNumSamples() - offset);
        float* pointers[2] { buffer.getWritePointer(0, offset),
            channels > 1 ? buffer.getWritePointer(1, offset) : nullptr };
        // JUCE's external-data constructor uses inline channel-pointer storage
        // for this two-channel view; it neither owns nor allocates audio data.
        juce::AudioBuffer<float> part(pointers, channels, count);
        processPreparedBlock(part, midi, offset);
    }
}

void OpenStudioPitchCorrector::processPreparedBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi, int midiOffset)
{
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples == 0 || numChannels == 0) return;

    const bool bypassed = bypass.load(std::memory_order_relaxed) > 0.5f;
    const float sourceValue = detectionSource.load(std::memory_order_relaxed);
    const int source = std::isfinite(sourceValue) ? juce::jlimit(0, 2, juce::roundToInt(sourceValue)) : 0;
    if (source != activeDetectionSource)
    {
        detector.reset(); mapper.reset(); midiResetPending = currentMidiNote >= 0;
        activeDetectionSource = source;
    }

    const float channelValue = midiOutputChannel.load(std::memory_order_relaxed);
    const int requestedMidiChannel = std::isfinite(channelValue)
        ? static_cast<int>(juce::jlimit(1.0f, 16.0f, channelValue)) : 1;
    const bool generateMidi = !bypassed && midiOutputEnabled.load() > 0.5f;
    if (currentMidiNote >= 0 && (midiResetPending || !generateMidi || requestedMidiChannel != currentMidiChannel))
    {
        midi.addEvent(juce::MidiMessage::noteOff(currentMidiChannel, currentMidiNote), midiOffset);
        midi.addEvent(juce::MidiMessage::pitchWheel(currentMidiChannel, 8192), midiOffset);
        currentMidiNote = -1;
        midiNoteHoldTime = 0.0f;
    }
    midiResetPending = false;
    currentMidiChannel = requestedMidiChannel;

    // Update detection parameters
    detector.setMinFrequency(minFreqParam.load(std::memory_order_relaxed));
    detector.setMaxFrequency(maxFreqParam.load(std::memory_order_relaxed));
    detector.setSensitivity(sensitivity.load(std::memory_order_relaxed));

    // Keep the dry delay warm even at 100% wet and during bypass.
    wetMix.setTargetValue(bypassed ? 0.0f : juce::jlimit(0.0f, 1.0f, mix.load()));
    const int delayLength = dryDelay.getNumSamples();
    int nextPosition = dryDelayPosition;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        float* delayed = dryDelay.getWritePointer(ch);
        float* dry = dryBuffer.getWritePointer(ch);
        const float* input = buffer.getReadPointer(ch);
        nextPosition = dryDelayPosition;
        for (int i = 0; i < numSamples; ++i)
        {
            delayed[nextPosition] = input[i];
            if (++nextPosition == delayLength) nextPosition = 0;
            dry[i] = delayed[nextPosition];
        }
    }
    dryDelayPosition = nextPosition;

    // Detection source is independent of the linked stereo correction path.
    const float* monoInput = buffer.getReadPointer(source == 1 && numChannels > 1 ? 1 : 0);
    if (source == 2 && numChannels > 1)
    {
        float* summed = detectionBuffer.getWritePointer(0);
        const float* left = buffer.getReadPointer(0); const float* right = buffer.getReadPointer(1);
        for (int i = 0; i < numSamples; ++i) summed[i] = (left[i] + right[i]) * .5f;
        monoInput = summed;
    }
    detector.processSamples(monoInput, numSamples);

    // Get detected pitch and compute correction
    float detectedHz = detector.getDetectedFrequency();
    float conf = detector.getConfidence();

    float deltaTime = static_cast<float>(numSamples) / static_cast<float>(cachedSampleRate);
    float correctedHz = mapper.mapPitch(detectedHz, conf, deltaTime);
    if (mapper.getCorrectionStrength() <= 0.0f) correctedHz = detectedHz;

    lastDetectedHz.store(detectedHz, std::memory_order_relaxed);
    lastCorrectedHz.store(correctedHz, std::memory_order_relaxed);

    // Calculate pitch shift ratio
    float ratio = 1.0f;
    if (mapper.getCorrectionStrength() > 0.0f && detectedHz > 0.0f && correctedHz > 0.0f)
    {
        ratio = correctedHz / detectedHz;
        ratio = juce::jlimit(0.25f, 4.0f, ratio);
    }

    // Apply pitch shift via Signalsmith Stretch (real-time, native stereo).
    // Use pre-allocated inPtrs/outPtrs/stretchOutputBuf to avoid heap allocation.
    withPitchEngine([&](auto& engine) {
        engine.setTransposeFactor(ratio);
        // Signalsmith frequencies are cycles per sample, not Hz.
        engine.setFormantBase(detectedHz > 0 ? detectedHz / static_cast<float>(cachedSampleRate) : 0);
        const float shift = mapper.getFormantShift();
        const bool correction = mapper.getFormantCorrection();
        if (!formantSettingsValid || shift != appliedFormantShift || correction != appliedFormantCorrection)
        {
            engine.setFormantSemitones(shift, correction);
            appliedFormantShift = shift;
            appliedFormantCorrection = correction;
            formantSettingsValid = true;
        }
    });

    for (int ch = 0; ch < numChannels; ++ch)
    {
        inPtrs[static_cast<size_t> (ch)]  = buffer.getReadPointer (ch);
        outPtrs[static_cast<size_t> (ch)] = stretchOutputBuf.getWritePointer (ch);
    }

    // The stretcher is prepared for two channels even on a mono bus. Supply
    // both pointers on every callback; otherwise its second input is null on
    // first use or points into a previous (possibly retired) stereo buffer.
    if (numChannels == 1)
    {
        inPtrs[1] = buffer.getReadPointer(0);
        outPtrs[1] = stretchOutputBuf.getWritePointer(1);
    }

    withPitchEngine([&](auto& engine) { engine.process(inPtrs, numSamples, outPtrs, numSamples); });

    // Apply dry/wet mix
    for (int i = 0; i < numSamples; ++i)
    {
        const float mixVal = wetMix.getNextValue();
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float* output = buffer.getWritePointer(ch);
            const float* wet = stretchOutputBuf.getReadPointer(ch);
            const float* dry = dryBuffer.getReadPointer(ch);
            output[i] = dry[i] * (1.0f - mixVal) + wet[i] * mixVal;
        }
    }

    // Store pitch history for UI — lock-free, audio thread is sole writer.
    // Atomic slot fields and the generation check also protect readers when
    // this ring wraps while a UI snapshot is in progress.
    {
        float detMidi = detectedHz > 0.0f ? hzToMidi(detectedHz) : 0.0f;
        float corMidi = correctedHz > 0.0f ? hzToMidi(correctedHz) : 0.0f;

        const int writePos = pitchHistoryWritePos.load (std::memory_order_relaxed);
        auto& frame = pitchHistory[static_cast<size_t>(writePos)];
        frame.generation.fetch_add(1);
        frame.detectedMidi.store(detMidi);
        frame.correctedMidi.store(corMidi);
        frame.confidence.store(conf);
        frame.generation.fetch_add(1);
        pitchHistoryWritePos.store ((writePos + 1) % maxPitchHistory, std::memory_order_release);
    }

    // MIDI output generation
    if (generateMidi)
    {
        const int midiCh = currentMidiChannel - 1;

        if (correctedHz > 0.0f && conf > 0.3f)
        {
            float corMidi = hzToMidi(correctedHz);
            int targetNote = juce::jlimit(0, 127, static_cast<int>(std::round(corMidi)));
            int velocity = juce::jlimit(1, 127, static_cast<int>(conf * 100.0f + 27.0f));

            if (currentMidiNote >= 0 && currentMidiNote != targetNote)
            {
                // Note changed — send note-off for old, note-on for new
                if (midiNoteHoldTime >= midiMinHoldTime)
                {
                    midi.addEvent(juce::MidiMessage::noteOff(midiCh + 1, currentMidiNote), midiOffset);
                    midi.addEvent(juce::MidiMessage::noteOn(midiCh + 1, targetNote, static_cast<juce::uint8>(velocity)), midiOffset);
                    currentMidiNote = targetNote;
                    currentMidiVelocity = velocity;
                    midiNoteHoldTime = 0.0f;
                }
                // If hold time too short, keep current note (prevent flutter)
            }
            else if (currentMidiNote < 0)
            {
                // No note sounding — start new note
                midi.addEvent(juce::MidiMessage::noteOn(midiCh + 1, targetNote, static_cast<juce::uint8>(velocity)), midiOffset);
                currentMidiNote = targetNote;
                currentMidiVelocity = velocity;
                midiNoteHoldTime = 0.0f;
            }

            midiNoteHoldTime += deltaTime;

            // Pitch bend for sub-semitone accuracy (±2 semitone range)
            float bendSemitones = corMidi - static_cast<float>(currentMidiNote);
            int bendValue = 8192 + static_cast<int>(bendSemitones / 2.0f * 8191.0f);
            bendValue = juce::jlimit(0, 16383, bendValue);
            midi.addEvent(juce::MidiMessage::pitchWheel(midiCh + 1, bendValue), midiOffset);
        }
        else if (currentMidiNote >= 0)
        {
            // No pitch detected — send note-off
            midi.addEvent(juce::MidiMessage::noteOff(midiCh + 1, currentMidiNote), midiOffset);
            currentMidiNote = -1;
            midiNoteHoldTime = 0.0f;
        }
    }
}

OpenStudioPitchCorrector::PitchData OpenStudioPitchCorrector::getCurrentPitchData() const
{
    PitchData data;
    data.detectedHz = lastDetectedHz.load(std::memory_order_relaxed);
    data.correctedHz = lastCorrectedHz.load(std::memory_order_relaxed);
    data.confidence = detector.getConfidence();

    if (data.detectedHz > 0.0f)
    {
        float midiNote = hzToMidi(data.detectedHz);
        int nearest = static_cast<int>(std::round(midiNote));
        data.centsDeviation = (midiNote - static_cast<float>(nearest)) * 100.0f;
        data.noteName = midiToNoteName(midiNote);
    }

    return data;
}

std::vector<OpenStudioPitchCorrector::PitchHistoryFrame> OpenStudioPitchCorrector::getPitchHistory(int numFrames) const
{
    // Acquire the current write position with acquire semantics so all frame
    // data written before this store (release) is visible to this thread.
    const int wp = pitchHistoryWritePos.load (std::memory_order_acquire);

    int count = juce::jlimit(0, maxPitchHistory, numFrames);
    std::vector<PitchHistoryFrame> result;
    result.reserve(static_cast<size_t>(count));

    for (int i = 0; i < count; ++i)
    {
        int idx = (wp - count + i + maxPitchHistory) % maxPitchHistory;
        const auto& slot = pitchHistory[static_cast<size_t>(idx)];
        const auto generation = slot.generation.load();
        PitchHistoryFrame frame { slot.detectedMidi.load(), slot.correctedMidi.load(), slot.confidence.load() };
        if ((generation & 1u) != 0u || generation != slot.generation.load())
            frame = {};
        result.push_back(frame);
    }
    return result;
}

bool OpenStudioPitchCorrector::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn = layouts.getMainInputChannelSet();

    if (mainOut != mainIn) return false;
    if (mainOut != juce::AudioChannelSet::mono()
        && mainOut != juce::AudioChannelSet::stereo())
        return false;

    return true;
}

juce::AudioProcessorEditor* OpenStudioPitchCorrector::createEditor()
{
    // Will use the generic OpenStudio built-in editor (sliders)
    // The main UI is in the frontend via bridge functions
    return new juce::GenericAudioProcessorEditor(*this);
}

void OpenStudioPitchCorrector::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("OpenStudioPitchCorrector");

    state.setProperty("signalPath", signalPath.load(), nullptr);
    state.setProperty("key", mapper.getKey(), nullptr);
    state.setProperty("scale", static_cast<int>(mapper.getScale()), nullptr);
    state.setProperty("retuneSpeed", mapper.getRetuneSpeed(), nullptr);
    state.setProperty("humanize", mapper.getHumanize(), nullptr);
    state.setProperty("humanizeMode", static_cast<int>(mapper.getHumanizeMode()), nullptr);
    state.setProperty("transpose", mapper.getTranspose(), nullptr);
    state.setProperty("correctionStrength", mapper.getCorrectionStrength(), nullptr);
    state.setProperty("formantCorrection", mapper.getFormantCorrection(), nullptr);
    state.setProperty("formantShift", mapper.getFormantShift(), nullptr);
    state.setProperty("sensitivity", sensitivity.load(), nullptr);
    state.setProperty("minFreq", minFreqParam.load(), nullptr);
    state.setProperty("maxFreq", maxFreqParam.load(), nullptr);
    state.setProperty("mix", mix.load(), nullptr);
    state.setProperty("bypass", bypass.load(), nullptr);
    state.setProperty("midiOutput", midiOutputEnabled.load(), nullptr);
    state.setProperty("midiChannel", midiOutputChannel.load(), nullptr);
    state.setProperty("detectionSource", detectionSource.load(), nullptr);

    // Note enables
    for (int i = 0; i < 12; ++i)
        state.setProperty("noteEnable_" + juce::String(i), mapper.isNoteEnabled(i), nullptr);

    juce::MemoryOutputStream stream(destData, true);
    state.writeToStream(stream);
}

void OpenStudioPitchCorrector::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "OpenStudioPitchCorrector") return;
    signalPath.store(static_cast<float>(state.getProperty("signalPath", 0.0f)) >= .5f ? 1.0f : 0.0f);

    const bool changedSignalPath = activeSignalPath != (signalPath.load() >= .5f);
    mapper.setCorrectedNoteMask(signalPath.load() >= .5f);
    mapper.setKey(state.getProperty("key", 0));
    mapper.setScale(static_cast<PitchMapper::Scale>(static_cast<int>(state.getProperty("scale", 0))));
    mapper.setRetuneSpeed(state.getProperty("retuneSpeed", 50.0f));
    mapper.setHumanize(state.getProperty("humanize", 0.0f));
    mapper.setHumanizeMode(static_cast<PitchMapper::HumanizeMode>(static_cast<int>(state.getProperty("humanizeMode", 0))));
    mapper.setTranspose(state.getProperty("transpose", 0));
    mapper.setCorrectionStrength(state.getProperty("correctionStrength", 1.0f));
    mapper.setFormantCorrection(state.getProperty("formantCorrection", false));
    mapper.setFormantShift(state.getProperty("formantShift", 0.0f));
    sensitivity.store(state.getProperty("sensitivity", 0.15f));
    minFreqParam.store(state.getProperty("minFreq", 80.0f));
    maxFreqParam.store(state.getProperty("maxFreq", 1000.0f));
    mix.store(state.getProperty("mix", 1.0f));
    bypass.store(state.getProperty("bypass", 0.0f));
    midiOutputEnabled.store(state.getProperty("midiOutput", 0.0f));
    midiOutputChannel.store(state.getProperty("midiChannel", 1.0f));
    const float source = static_cast<float>(state.getProperty("detectionSource", 0.0f));
    detectionSource.store(std::isfinite(source) ? static_cast<float>(juce::jlimit(0, 2, juce::roundToInt(source))) : 0.0f);

    for (int i = 0; i < 12; ++i)
        mapper.setNoteEnabled(i, state.getProperty("noteEnable_" + juce::String(i), true));
    if (changedSignalPath && dryBuffer.getNumSamples() > 0) prepareToPlay(cachedSampleRate, dryBuffer.getNumSamples());
}

juce::String OpenStudioPitchCorrector::midiToNoteName(float midiNote)
{
    static const char* noteNames[] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
    int nearest = static_cast<int>(std::round(midiNote));
    int noteIdx = ((nearest % 12) + 12) % 12;
    int octave = (nearest / 12) - 1;
    return juce::String(noteNames[noteIdx]) + juce::String(octave);
}

float OpenStudioPitchCorrector::hzToMidi(float hz)
{
    if (hz <= 0.0f) return 0.0f;
    return 69.0f + 12.0f * std::log2(hz / 440.0f);
}

float OpenStudioPitchCorrector::midiToHz(float midi)
{
    return 440.0f * std::pow(2.0f, (midi - 69.0f) / 12.0f);
}
