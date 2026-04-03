#include "S13PitchCorrector.h"
#include "S13PluginEditors.h"
#include <cmath>
#include <cstring>

S13PitchCorrector::S13PitchCorrector()
    : AudioProcessor(BusesProperties()
                        .withInput("Input", juce::AudioChannelSet::stereo(), true)
                        .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    pitchHistory.resize(static_cast<size_t>(maxPitchHistory));
}

void S13PitchCorrector::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    detector.prepare(sampleRate, samplesPerBlock);
    mapper.prepare(sampleRate);

    // presetCheaper: block=40ms, interval=10ms → ~441 samples interval at 44100Hz
    // This gives ~10ms latency which is acceptable for real-time pitch correction.
    stretcher.presetCheaper (2, static_cast<float> (sampleRate));

    // Apply detection params
    detector.setMinFrequency(minFreqParam.load());
    detector.setMaxFrequency(maxFreqParam.load());
    detector.setSensitivity(sensitivity.load());

    setLatencySamples (stretcher.outputLatency());
}

void S13PitchCorrector::releaseResources()
{
    detector.reset();
    mapper.reset();
}

void S13PitchCorrector::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples == 0 || numChannels == 0) return;

    // Bypass
    if (bypass.load(std::memory_order_relaxed) > 0.5f)
        return;

    // Update detection parameters
    detector.setMinFrequency(minFreqParam.load(std::memory_order_relaxed));
    detector.setMaxFrequency(maxFreqParam.load(std::memory_order_relaxed));
    detector.setSensitivity(sensitivity.load(std::memory_order_relaxed));

    // Save dry signal for mix
    juce::AudioBuffer<float> dryBuffer;
    float mixVal = mix.load(std::memory_order_relaxed);
    if (mixVal < 0.999f)
    {
        dryBuffer.makeCopyOf(buffer);
    }

    // Pitch detection on mono sum (L channel or mono mix)
    const float* monoInput = buffer.getReadPointer(0);
    detector.processSamples(monoInput, numSamples);

    // Get detected pitch and compute correction
    float detectedHz = detector.getDetectedFrequency();
    float conf = detector.getConfidence();

    float deltaTime = static_cast<float>(numSamples) / static_cast<float>(cachedSampleRate);
    float correctedHz = mapper.mapPitch(detectedHz, conf, deltaTime);

    lastDetectedHz = detectedHz;
    lastCorrectedHz = correctedHz;

    // Calculate pitch shift ratio
    float ratio = 1.0f;
    if (detectedHz > 0.0f && correctedHz > 0.0f)
    {
        ratio = correctedHz / detectedHz;
        ratio = juce::jlimit(0.25f, 4.0f, ratio);
    }

    // Apply pitch shift via Signalsmith Stretch (real-time, native stereo)
    stretcher.setTransposeFactor (ratio);
    stretcher.setFormantBase (detectedHz > 0.0f ? detectedHz : 0.0f); // help formant estimation
    stretcher.setFormantFactor (1.0f, true); // preserve formants via library's exact freq map

    {
        std::vector<const float*> inPtrs  (static_cast<size_t> (numChannels));
        std::vector<float*>       outPtrs (static_cast<size_t> (numChannels));
        std::vector<std::vector<float>> tempOut (static_cast<size_t> (numChannels),
                                                  std::vector<float> (static_cast<size_t> (numSamples)));

        for (int ch = 0; ch < numChannels; ++ch)
        {
            inPtrs[static_cast<size_t> (ch)]  = buffer.getReadPointer (ch);
            outPtrs[static_cast<size_t> (ch)] = tempOut[static_cast<size_t> (ch)].data();
        }

        stretcher.process (inPtrs, numSamples, outPtrs, numSamples);

        for (int ch = 0; ch < numChannels; ++ch)
            std::memcpy (buffer.getWritePointer (ch), tempOut[static_cast<size_t> (ch)].data(),
                         static_cast<size_t> (numSamples) * sizeof (float));
    }

    // Apply dry/wet mix
    if (mixVal < 0.999f)
    {
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float* wet = buffer.getWritePointer(ch);
            const float* dry = dryBuffer.getReadPointer(ch);
            for (int i = 0; i < numSamples; ++i)
            {
                wet[i] = dry[i] * (1.0f - mixVal) + wet[i] * mixVal;
            }
        }
    }

    // Store pitch history for UI
    {
        float detMidi = detectedHz > 0.0f ? hzToMidi(detectedHz) : 0.0f;
        float corMidi = correctedHz > 0.0f ? hzToMidi(correctedHz) : 0.0f;

        const std::lock_guard<std::mutex> lock(pitchHistoryMutex);
        pitchHistory[static_cast<size_t>(pitchHistoryWritePos)] = { detMidi, corMidi, conf };
        pitchHistoryWritePos = (pitchHistoryWritePos + 1) % maxPitchHistory;
    }

    // MIDI output generation
    if (midiOutputEnabled.load(std::memory_order_relaxed) > 0.5f)
    {
        int midiCh = juce::jlimit(1, 16, static_cast<int>(midiOutputChannel.load(std::memory_order_relaxed))) - 1;

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
                    midi.addEvent(juce::MidiMessage::noteOff(midiCh + 1, currentMidiNote), 0);
                    midi.addEvent(juce::MidiMessage::noteOn(midiCh + 1, targetNote, static_cast<juce::uint8>(velocity)), 0);
                    currentMidiNote = targetNote;
                    currentMidiVelocity = velocity;
                    midiNoteHoldTime = 0.0f;
                }
                // If hold time too short, keep current note (prevent flutter)
            }
            else if (currentMidiNote < 0)
            {
                // No note sounding — start new note
                midi.addEvent(juce::MidiMessage::noteOn(midiCh + 1, targetNote, static_cast<juce::uint8>(velocity)), 0);
                currentMidiNote = targetNote;
                currentMidiVelocity = velocity;
                midiNoteHoldTime = 0.0f;
            }

            midiNoteHoldTime += deltaTime;

            // Pitch bend for sub-semitone accuracy (±2 semitone range)
            float bendSemitones = corMidi - static_cast<float>(targetNote);
            int bendValue = 8192 + static_cast<int>(bendSemitones / 2.0f * 8191.0f);
            bendValue = juce::jlimit(0, 16383, bendValue);
            midi.addEvent(juce::MidiMessage::pitchWheel(midiCh + 1, bendValue), 0);
        }
        else if (currentMidiNote >= 0)
        {
            // No pitch detected — send note-off
            midi.addEvent(juce::MidiMessage::noteOff(midiCh + 1, currentMidiNote), 0);
            currentMidiNote = -1;
            midiNoteHoldTime = 0.0f;
        }
    }
}

S13PitchCorrector::PitchData S13PitchCorrector::getCurrentPitchData() const
{
    PitchData data;
    data.detectedHz = lastDetectedHz;
    data.correctedHz = lastCorrectedHz;
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

std::vector<S13PitchCorrector::PitchHistoryFrame> S13PitchCorrector::getPitchHistory(int numFrames) const
{
    const std::lock_guard<std::mutex> lock(pitchHistoryMutex);

    int count = std::min(numFrames, maxPitchHistory);
    std::vector<PitchHistoryFrame> result;
    result.reserve(static_cast<size_t>(count));

    for (int i = 0; i < count; ++i)
    {
        int idx = (pitchHistoryWritePos - count + i + maxPitchHistory) % maxPitchHistory;
        result.push_back(pitchHistory[static_cast<size_t>(idx)]);
    }
    return result;
}

bool S13PitchCorrector::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn = layouts.getMainInputChannelSet();

    if (mainOut != mainIn) return false;
    if (mainOut != juce::AudioChannelSet::mono()
        && mainOut != juce::AudioChannelSet::stereo())
        return false;

    return true;
}

juce::AudioProcessorEditor* S13PitchCorrector::createEditor()
{
    // Will use the generic S13 built-in editor (sliders)
    // The main UI is in the frontend via bridge functions
    return new juce::GenericAudioProcessorEditor(*this);
}

void S13PitchCorrector::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13PitchCorrector");

    state.setProperty("key", mapper.getKey(), nullptr);
    state.setProperty("scale", static_cast<int>(mapper.getScale()), nullptr);
    state.setProperty("retuneSpeed", mapper.getRetuneSpeed(), nullptr);
    state.setProperty("humanize", mapper.getHumanize(), nullptr);
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

    // Note enables
    for (int i = 0; i < 12; ++i)
        state.setProperty("noteEnable_" + juce::String(i), mapper.isNoteEnabled(i), nullptr);

    juce::MemoryOutputStream stream(destData, true);
    state.writeToStream(stream);
}

void S13PitchCorrector::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid()) return;

    mapper.setKey(state.getProperty("key", 0));
    mapper.setScale(static_cast<PitchMapper::Scale>(static_cast<int>(state.getProperty("scale", 0))));
    mapper.setRetuneSpeed(state.getProperty("retuneSpeed", 50.0f));
    mapper.setHumanize(state.getProperty("humanize", 0.0f));
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

    for (int i = 0; i < 12; ++i)
        mapper.setNoteEnabled(i, state.getProperty("noteEnable_" + juce::String(i), true));
}

juce::String S13PitchCorrector::midiToNoteName(float midiNote)
{
    static const char* noteNames[] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
    int nearest = static_cast<int>(std::round(midiNote));
    int noteIdx = ((nearest % 12) + 12) % 12;
    int octave = (nearest / 12) - 1;
    return juce::String(noteNames[noteIdx]) + juce::String(octave);
}

float S13PitchCorrector::hzToMidi(float hz)
{
    if (hz <= 0.0f) return 0.0f;
    return 69.0f + 12.0f * std::log2(hz / 440.0f);
}

float S13PitchCorrector::midiToHz(float midi)
{
    return 440.0f * std::pow(2.0f, (midi - 69.0f) / 12.0f);
}
