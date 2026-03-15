#include "PitchAnalyzer.h"
#include <cmath>
#include <algorithm>
#include <numeric>

PitchAnalyzer::PitchAnalyzer() = default;

static float hzToMidi(float hz)
{
    if (hz <= 0.0f)
        return 0.0f;
    return 69.0f + 12.0f * std::log2(hz / 440.0f);
}

// midiToHz used by PitchResynthesizer, not needed here

float PitchAnalyzer::analyzeFrame(const float *frame, int frameSize, double sr,
                                  float &outConfidence)
{
    const int halfSize = frameSize / 2;
    const int tauMin = static_cast<int>(sr / maxFreq);
    const int tauMax = std::min(halfSize - 1, static_cast<int>(sr / minFreq));

    if (tauMax <= tauMin || tauMax >= halfSize)
    {
        outConfidence = 0.0f;
        return 0.0f;
    }

    yinBuffer.resize(static_cast<size_t>(halfSize));

    // Step 1+2: Difference function + cumulative mean normalization
    yinBuffer[0] = 1.0f;
    float runningSum = 0.0f;

    for (int tau = 1; tau < halfSize; ++tau)
    {
        float sum = 0.0f;
        for (int j = 0; j < halfSize; ++j)
        {
            float delta = frame[j] - frame[j + tau];
            sum += delta * delta;
        }
        runningSum += sum;
        yinBuffer[static_cast<size_t>(tau)] = (runningSum > 0.0f)
                                                  ? sum * static_cast<float>(tau) / runningSum
                                                  : 0.0f;
    }

    // Step 3: Find first dip below threshold
    int bestTau = -1;
    float bestVal = sensitivity;

    for (int tau = tauMin; tau <= tauMax; ++tau)
    {
        if (yinBuffer[static_cast<size_t>(tau)] < bestVal)
        {
            while (tau + 1 <= tauMax && yinBuffer[static_cast<size_t>(tau + 1)] < yinBuffer[static_cast<size_t>(tau)])
                ++tau;
            bestTau = tau;
            bestVal = yinBuffer[static_cast<size_t>(tau)];
            break;
        }
    }

    if (bestTau < 0)
    {
        bestVal = yinBuffer[static_cast<size_t>(tauMin)];
        bestTau = tauMin;
        for (int tau = tauMin + 1; tau <= tauMax; ++tau)
        {
            if (yinBuffer[static_cast<size_t>(tau)] < bestVal)
            {
                bestVal = yinBuffer[static_cast<size_t>(tau)];
                bestTau = tau;
            }
        }
    }

    // Step 4: Parabolic interpolation
    float refinedTau = static_cast<float>(bestTau);
    if (bestTau > 0 && bestTau < halfSize - 1)
    {
        float s0 = yinBuffer[static_cast<size_t>(bestTau - 1)];
        float s1 = yinBuffer[static_cast<size_t>(bestTau)];
        float s2 = yinBuffer[static_cast<size_t>(bestTau + 1)];
        float denom = 2.0f * (2.0f * s1 - s2 - s0);
        if (std::abs(denom) > 1e-10f)
            refinedTau += (s2 - s0) / denom;
    }

    outConfidence = juce::jlimit(0.0f, 1.0f, 1.0f - bestVal);
    float freq = (refinedTau > 0.0f) ? static_cast<float>(sr) / refinedTau : 0.0f;

    if (freq < minFreq || freq > maxFreq)
    {
        outConfidence = 0.0f;
        return 0.0f;
    }

    return freq;
}

PitchAnalyzer::AnalysisResult PitchAnalyzer::analyzeClip(
    const float *audioData, int numSamples, double sampleRate, const juce::String &clipId)
{
    AnalysisResult result;
    result.clipId = clipId;
    result.sampleRate = sampleRate;

    // Offline: adaptive hop size based on clip length to keep analysis time reasonable
    constexpr int frameSize = 2048;
    // Short clips (<30s): high res hop=256 (~5.8ms at 44.1kHz)
    // Medium clips (30-120s): hop=512 (~11.6ms)
    // Long clips (>120s): hop=1024 (~23ms) — still good enough for graphical editing
    const double durationSec = static_cast<double>(numSamples) / sampleRate;
    const int hopSize = (durationSec > 120.0)  ? 1024
                        : (durationSec > 30.0) ? 512
                                               : 256;
    result.hopSize = hopSize;

    const int numFrames = (numSamples - frameSize) / hopSize + 1;
    if (numFrames <= 0)
        return result;

    result.frames.reserve(static_cast<size_t>(numFrames));

    for (int i = 0; i < numFrames; ++i)
    {
        int offset = i * hopSize;
        const float *frameData = audioData + offset;

        // RMS
        float sumSq = 0.0f;
        for (int j = 0; j < frameSize; ++j)
            sumSq += frameData[j] * frameData[j];
        float rms = std::sqrt(sumSq / static_cast<float>(frameSize));
        float rmsDB = rms > 0.0f ? 20.0f * std::log10(rms) : -100.0f;

        float conf = 0.0f;
        float freq = 0.0f;

        // Skip analysis for very quiet frames
        if (rmsDB > -60.0f)
            freq = analyzeFrame(frameData, frameSize, sampleRate, conf);

        float midi = (freq > 0.0f && conf > 0.3f) ? hzToMidi(freq) : 0.0f;

        // Voiced/unvoiced classification:
        // - Silence: rmsDB < -55 dB
        // - Unvoiced (sibilant/breath): has energy but low pitch confidence
        // - Voiced: clear pitch detected with good confidence
        bool isVoiced = (midi > 0.0f && conf >= 0.3f && rmsDB > -55.0f);

        PitchFrame pf;
        pf.time = static_cast<float>(offset) / static_cast<float>(sampleRate);
        pf.frequency = freq;
        pf.midiNote = midi;
        pf.confidence = conf;
        pf.rmsDB = rmsDB;
        pf.voiced = isVoiced;
        result.frames.push_back(pf);
    }

    // Segment into notes
    result.notes = segmentNotes(result.frames, hopSize, sampleRate);

    return result;
}

std::vector<PitchAnalyzer::PitchNote> PitchAnalyzer::segmentNotes(
    const std::vector<PitchFrame> &frames, int /*hopSize*/, double /*sampleRate*/)
{
    std::vector<PitchNote> notes;
    if (frames.empty())
        return notes;

    const float minNoteDuration = 0.05f;     // 50 ms minimum note
    const float pitchJumpThreshold = 2.3f;   // 2.3 semitones — tolerates vibrato (±1-2 sem),
                                             // only splits on genuine melodic note changes
    const float confidenceThreshold = 0.35f; // relaxed from 0.5 — avoids ending a note on a
                                             // momentarily low-confidence frame mid-vibrato
    const float silenceThreshold = -60.0f;   // dB
    const int stableFrames = 3;              // pitch deviation must be sustained this many
                                             // consecutive frames before triggering a split
                                             // (prevents vibrato peaks from splitting notes)

    int noteStartIdx = -1;
    float noteSum = 0.0f;
    int noteCount = 0;
    int noteId = 0;
    int deviationRun = 0; // consecutive frames exceeding pitchJumpThreshold

    auto finalizeNote = [&](int endIdx)
    {
        if (noteStartIdx < 0 || noteCount == 0)
            return;

        float avgMidi = noteSum / static_cast<float>(noteCount);
        float startTime = frames[static_cast<size_t>(noteStartIdx)].time;
        float endTime = frames[static_cast<size_t>(endIdx)].time;
        float duration = endTime - startTime;

        if (duration < minNoteDuration)
            return;

        PitchNote note;
        note.id = "note_" + juce::String(noteId++);
        note.startTime = startTime;
        note.endTime = endTime;
        note.detectedPitch = avgMidi;
        note.correctedPitch = avgMidi; // No auto-tune by default — user applies correction explicitly
        note.driftCorrectionAmount = 0.0f;
        note.vibratoDepth = 1.0f;
        note.vibratoRate = 0.0f;
        note.transitionIn = 0.0f;
        note.transitionOut = 0.0f;
        note.formantShift = 0.0f;
        note.gain = 0.0f;

        // Store per-frame drift (deviation from note center)
        for (int i = noteStartIdx; i <= endIdx && i < static_cast<int>(frames.size()); ++i)
        {
            float midi = frames[static_cast<size_t>(i)].midiNote;
            note.pitchDrift.push_back(midi > 0.0f ? midi - avgMidi : 0.0f);
        }

        notes.push_back(std::move(note));
    };

    for (int i = 0; i < static_cast<int>(frames.size()); ++i)
    {
        const auto &f = frames[static_cast<size_t>(i)];
        bool isVoiced = f.midiNote > 0.0f && f.confidence >= confidenceThreshold && f.rmsDB > silenceThreshold;

        if (!isVoiced)
        {
            // End current note at silence/unvoiced
            if (noteStartIdx >= 0)
            {
                finalizeNote(i - 1);
                noteStartIdx = -1;
                noteSum = 0.0f;
                noteCount = 0;
                deviationRun = 0;
            }
            continue;
        }

        if (noteStartIdx < 0)
        {
            // Start new note
            noteStartIdx = i;
            noteSum = f.midiNote;
            noteCount = 1;
            deviationRun = 0;
        }
        else
        {
            float avgSoFar = noteSum / static_cast<float>(noteCount);
            float deviation = std::abs(f.midiNote - avgSoFar);

            if (deviation > pitchJumpThreshold)
            {
                ++deviationRun;
                if (deviationRun >= stableFrames)
                {
                    // Sustained pitch jump → genuine note change
                    finalizeNote(i - stableFrames);
                    noteStartIdx = i - stableFrames + 1;
                    // Recompute sum for the new note's initial frames
                    noteSum = 0.0f;
                    noteCount = 0;
                    for (int k = noteStartIdx; k <= i; ++k)
                    {
                        noteSum += frames[static_cast<size_t>(k)].midiNote;
                        ++noteCount;
                    }
                    deviationRun = 0;
                }
                // else: don't split yet — might be a vibrato transient
            }
            else
            {
                deviationRun = 0;
                noteSum += f.midiNote;
                ++noteCount;
            }
        }
    }

    // Finalize last note
    if (noteStartIdx >= 0)
        finalizeNote(static_cast<int>(frames.size()) - 1);

    // -------------------------------------------------------------------------
    // Merge pass: collapse adjacent notes that are close in time and pitch.
    // Brief unvoiced gaps (consonants, breath noise) within a phrase often split
    // what should be a single note into two. Re-join them if:
    //   • gap < 150 ms (brief consonant or detection gap, not a real pause)
    //   • pitch centers within 1.5 semitones (same note or tight step)
    // -------------------------------------------------------------------------
    const float mergeGapSec = 0.15f;  // 150 ms
    const float mergePitchSem = 1.5f; // semitones

    bool merged = true;
    while (merged)
    {
        merged = false;
        for (int i = 0; i + 1 < static_cast<int>(notes.size()); ++i)
        {
            auto &a = notes[static_cast<size_t>(i)];
            auto &b = notes[static_cast<size_t>(i + 1)];
            float gap = b.startTime - a.endTime;
            float pitchDiff = std::abs(a.detectedPitch - b.detectedPitch);

            if (gap >= 0.0f && gap < mergeGapSec && pitchDiff < mergePitchSem)
            {
                // Weighted average pitch (by duration as proxy for frame count)
                float aDur = a.endTime - a.startTime;
                float bDur = b.endTime - b.startTime;
                float totalDur = aDur + bDur;
                float newPitch = (totalDur > 0.0f)
                                     ? (a.detectedPitch * aDur + b.detectedPitch * bDur) / totalDur
                                     : a.detectedPitch;

                a.endTime = b.endTime;
                a.detectedPitch = newPitch;
                a.correctedPitch = newPitch;

                // Append drift frames from b
                a.pitchDrift.insert(a.pitchDrift.end(), b.pitchDrift.begin(), b.pitchDrift.end());

                notes.erase(notes.begin() + i + 1);
                merged = true;
                break; // restart scan after any merge
            }
        }
    }

    return notes;
}

// ============================================================================
// JSON serialization
// ============================================================================

juce::var PitchAnalyzer::resultToJSON(const AnalysisResult &result)
{
    juce::DynamicObject::Ptr root = new juce::DynamicObject();
    root->setProperty("clipId", result.clipId);
    root->setProperty("sampleRate", result.sampleRate);
    root->setProperty("hopSize", result.hopSize);

    // Frames — send as flat arrays for efficiency
    juce::Array<juce::var> frameTimes, frameMidi, frameConf, frameRms, frameVoiced;
    frameTimes.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameMidi.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameConf.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameRms.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameVoiced.ensureStorageAllocated(static_cast<int>(result.frames.size()));

    for (const auto &f : result.frames)
    {
        frameTimes.add(static_cast<double>(f.time));
        frameMidi.add(static_cast<double>(f.midiNote));
        frameConf.add(static_cast<double>(f.confidence));
        frameRms.add(static_cast<double>(f.rmsDB));
        frameVoiced.add(f.voiced);
    }

    juce::DynamicObject::Ptr framesObj = new juce::DynamicObject();
    framesObj->setProperty("times", frameTimes);
    framesObj->setProperty("midi", frameMidi);
    framesObj->setProperty("confidence", frameConf);
    framesObj->setProperty("rms", frameRms);
    framesObj->setProperty("voiced", frameVoiced);
    root->setProperty("frames", juce::var(framesObj.get()));

    // Notes
    juce::Array<juce::var> notesList;
    for (const auto &n : result.notes)
    {
        juce::DynamicObject::Ptr noteObj = new juce::DynamicObject();
        noteObj->setProperty("id", n.id);
        noteObj->setProperty("startTime", static_cast<double>(n.startTime));
        noteObj->setProperty("endTime", static_cast<double>(n.endTime));
        noteObj->setProperty("detectedPitch", static_cast<double>(n.detectedPitch));
        noteObj->setProperty("correctedPitch", static_cast<double>(n.correctedPitch));
        noteObj->setProperty("driftCorrectionAmount", static_cast<double>(n.driftCorrectionAmount));
        noteObj->setProperty("vibratoDepth", static_cast<double>(n.vibratoDepth));
        noteObj->setProperty("vibratoRate", static_cast<double>(n.vibratoRate));
        noteObj->setProperty("transitionIn", static_cast<double>(n.transitionIn));
        noteObj->setProperty("transitionOut", static_cast<double>(n.transitionOut));
        noteObj->setProperty("formantShift", static_cast<double>(n.formantShift));
        noteObj->setProperty("gain", static_cast<double>(n.gain));
        noteObj->setProperty("voiced", n.voiced);

        // Downsample drift to max ~50 points per note for efficient rendering
        juce::Array<juce::var> drift;
        const int maxDriftPoints = 50;
        const int driftSize = static_cast<int>(n.pitchDrift.size());
        if (driftSize <= maxDriftPoints)
        {
            for (float d : n.pitchDrift)
                drift.add(static_cast<double>(d));
        }
        else
        {
            const float step = static_cast<float>(driftSize) / static_cast<float>(maxDriftPoints);
            for (int di = 0; di < maxDriftPoints; ++di)
            {
                int idx = static_cast<int>(static_cast<float>(di) * step);
                drift.add(static_cast<double>(n.pitchDrift[static_cast<size_t>(idx)]));
            }
        }
        noteObj->setProperty("pitchDrift", drift);

        notesList.add(juce::var(noteObj.get()));
    }
    root->setProperty("notes", notesList);

    return juce::var(root.get());
}

std::vector<PitchAnalyzer::PitchNote> PitchAnalyzer::notesFromJSON(const juce::var &json)
{
    std::vector<PitchNote> notes;

    if (auto *arr = json.getArray())
    {
        for (const auto &item : *arr)
        {
            if (auto *obj = item.getDynamicObject())
            {
                PitchNote n;
                n.id = obj->getProperty("id").toString();
                n.startTime = static_cast<float>(static_cast<double>(obj->getProperty("startTime")));
                n.endTime = static_cast<float>(static_cast<double>(obj->getProperty("endTime")));
                n.detectedPitch = static_cast<float>(static_cast<double>(obj->getProperty("detectedPitch")));
                n.correctedPitch = static_cast<float>(static_cast<double>(obj->getProperty("correctedPitch")));
                n.driftCorrectionAmount = static_cast<float>(static_cast<double>(obj->getProperty("driftCorrectionAmount")));
                n.vibratoDepth = static_cast<float>(static_cast<double>(obj->getProperty("vibratoDepth")));
                n.vibratoRate = static_cast<float>(static_cast<double>(obj->getProperty("vibratoRate")));
                n.transitionIn = static_cast<float>(static_cast<double>(obj->getProperty("transitionIn")));
                n.transitionOut = static_cast<float>(static_cast<double>(obj->getProperty("transitionOut")));
                n.formantShift = static_cast<float>(static_cast<double>(obj->getProperty("formantShift")));
                n.gain = static_cast<float>(static_cast<double>(obj->getProperty("gain")));
                n.voiced = obj->hasProperty("voiced") ? static_cast<bool>(obj->getProperty("voiced")) : true;

                if (auto *driftArr = obj->getProperty("pitchDrift").getArray())
                {
                    for (const auto &d : *driftArr)
                        n.pitchDrift.push_back(static_cast<float>(static_cast<double>(d)));
                }

                notes.push_back(std::move(n));
            }
        }
    }

    return notes;
}

std::vector<PitchAnalyzer::PitchFrame> PitchAnalyzer::framesFromJSON(const juce::var &json)
{
    std::vector<PitchFrame> frames;

    if (auto *obj = json.getDynamicObject())
    {
        auto *times = obj->getProperty("times").getArray();
        auto *midi = obj->getProperty("midi").getArray();
        auto *conf = obj->getProperty("confidence").getArray();
        auto *rms = obj->getProperty("rms").getArray();
        auto *voiced = obj->getProperty("voiced").getArray();

        if (times == nullptr || midi == nullptr)
            return frames;

        const int count = times->size();
        frames.reserve(static_cast<size_t>(count));

        for (int i = 0; i < count; ++i)
        {
            PitchFrame f;
            f.time = static_cast<float>(static_cast<double>((*times)[i]));
            f.midiNote = static_cast<float>(static_cast<double>((*midi)[i]));
            f.frequency = (f.midiNote > 0.0f) ? 440.0f * std::pow(2.0f, (f.midiNote - 69.0f) / 12.0f) : 0.0f;
            f.confidence = (conf != nullptr && i < conf->size())
                               ? static_cast<float>(static_cast<double>((*conf)[i]))
                               : 0.5f;
            f.rmsDB = (rms != nullptr && i < rms->size())
                          ? static_cast<float>(static_cast<double>((*rms)[i]))
                          : -60.0f;
            f.voiced = (voiced != nullptr && i < voiced->size())
                           ? static_cast<bool>((*voiced)[i])
                           : true;
            frames.push_back(f);
        }
    }

    return frames;
}
