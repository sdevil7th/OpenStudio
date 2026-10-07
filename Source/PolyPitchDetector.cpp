#include "PolyPitchDetector.h"
#include <stdexcept>

// Basic-Pitch model constants
static constexpr double kModelSampleRate = 22050.0;
static constexpr int    kHopSize         = 256;    // ~11.6ms at 22050 Hz
static constexpr int    kNoteBins        = 88;     // A0 (MIDI 21) to C8 (MIDI 108)
static constexpr int    kMidiOffset      = 21;     // MIDI note of lowest bin (A0)

#if OPENSTUDIO_HAS_ONNXRUNTIME
static constexpr int kContourBins = 264;    // 88 * 3 (1/3 semitone resolution)

// Fixed waveform contract of the bundled Spotify NMP model.
static constexpr int kWindowSamples = 43844;
static constexpr int kWindowFrames = 172;
static constexpr int kContextFrames = 15;
static constexpr int kKeptFrames = kWindowFrames - 2 * kContextFrames;
// Keep the stride on the 256-sample frame grid so successive windows cannot
// accumulate a timestamp drift. Discard context predictions at both edges.
static constexpr int kWindowStride = kKeptFrames * kHopSize;
#endif

PolyPitchDetector::PolyPitchDetector()
{
}

PolyPitchDetector::~PolyPitchDetector()
{
}

bool PolyPitchDetector::loadModel (const juce::File& onnxModelPath)
{
#if OPENSTUDIO_HAS_ONNXRUNTIME
    if (! onnxModelPath.existsAsFile())
    {
        juce::Logger::writeToLog ("PolyPitchDetector: Model file not found: " + onnxModelPath.getFullPathName());
        return false;
    }

    try
    {
        ortEnv = std::make_unique<Ort::Env> (ORT_LOGGING_LEVEL_WARNING, "OpenStudioPolyPitch");

        Ort::SessionOptions sessionOpts;
        sessionOpts.SetIntraOpNumThreads (2);
        sessionOpts.SetGraphOptimizationLevel (GraphOptimizationLevel::ORT_ENABLE_ALL);

#if JUCE_WINDOWS
        auto widePath = onnxModelPath.getFullPathName().toWideCharPointer();
        ortSession = std::make_unique<Ort::Session> (*ortEnv, widePath, sessionOpts);
#else
        auto utf8Path = onnxModelPath.getFullPathName().toRawUTF8();
        ortSession = std::make_unique<Ort::Session> (*ortEnv, utf8Path, sessionOpts);
#endif

        modelLoaded = true;
        juce::Logger::writeToLog ("PolyPitchDetector: Model loaded successfully");

        // Log model input/output info
        Ort::AllocatorWithDefaultOptions allocator;
        auto numInputs = ortSession->GetInputCount();
        auto numOutputs = ortSession->GetOutputCount();
        juce::Logger::writeToLog ("  Inputs: " + juce::String ((int) numInputs)
                                + "  Outputs: " + juce::String ((int) numOutputs));

        for (size_t i = 0; i < numInputs; ++i)
        {
            auto name = ortSession->GetInputNameAllocated (i, allocator);
            auto typeInfo = ortSession->GetInputTypeInfo (i);
            auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
            auto shape = tensorInfo.GetShape();
            juce::String shapeStr = "[";
            for (size_t d = 0; d < shape.size(); ++d)
            {
                if (d > 0) shapeStr += ", ";
                shapeStr += (shape[d] < 0) ? "?" : juce::String (shape[d]);
            }
            shapeStr += "]";
            juce::Logger::writeToLog ("  Input " + juce::String ((int) i)
                                    + ": " + juce::String (name.get()) + " " + shapeStr);
        }

        for (size_t i = 0; i < numOutputs; ++i)
        {
            auto name = ortSession->GetOutputNameAllocated (i, allocator);
            juce::Logger::writeToLog ("  Output " + juce::String ((int) i)
                                    + ": " + juce::String (name.get()));
        }

        return true;
    }
    catch (const Ort::Exception& e)
    {
        juce::Logger::writeToLog ("PolyPitchDetector: ONNX error: " + juce::String (e.what()));
        modelLoaded = false;
        return false;
    }
#else
    juce::ignoreUnused (onnxModelPath);
    juce::Logger::writeToLog ("PolyPitchDetector: ONNX Runtime not available (compiled without OPENSTUDIO_HAS_ONNXRUNTIME)");
    return false;
#endif
}

std::vector<float> PolyPitchDetector::resampleTo22050 (const float* audio, int numSamples,
                                                        double sourceSampleRate)
{
    if (std::abs (sourceSampleRate - kModelSampleRate) < 1.0)
    {
        // Already at 22050, just copy
        return std::vector<float> (audio, audio + numSamples);
    }

    double ratio = kModelSampleRate / sourceSampleRate;
    int outputLen = std::max (1, static_cast<int> (std::ceil (numSamples * ratio)));
    std::vector<float> output (static_cast<size_t> (outputLen));

    // Linear interpolation resampling (sufficient for analysis — not audio playback)
    for (int i = 0; i < outputLen; ++i)
    {
        double srcPos = i / ratio;
        int idx = static_cast<int> (srcPos);
        float frac = static_cast<float> (srcPos - idx);

        if (idx + 1 < numSamples)
            output[static_cast<size_t> (i)] = audio[idx] * (1.0f - frac) + audio[idx + 1] * frac;
        else if (idx < numSamples)
            output[static_cast<size_t> (i)] = audio[idx];
        else
            output[static_cast<size_t> (i)] = 0.0f;
    }

    return output;
}

std::vector<PolyPitchDetector::PolyNote>
PolyPitchDetector::extractNotes (const std::vector<std::vector<float>>& noteAct,
                                  const std::vector<std::vector<float>>& onsetAct,
                                  int hopSize, double sampleRate)
{
    std::vector<PolyNote> notes;
    int numFrames = static_cast<int> (noteAct.size());
    if (numFrames == 0) return notes;

    double frameTime = static_cast<double> (hopSize) / sampleRate;
    int mergeGapFrames = static_cast<int> (mergeGapMs / 1000.0 / frameTime);
    int minDurationFrames = static_cast<int> (minNoteDurationMs / 1000.0 / frameTime);

    // For each of the 88 MIDI notes, scan through time to find active regions
    for (int pitch = 0; pitch < kNoteBins; ++pitch)
    {
        int regionStart = -1;
        int gapCount = 0;
        bool hasOnset = false;
        float peakActivation = 0.0f;
        float sumActivation = 0.0f;
        int activeFrameCount = 0;

        for (int t = 0; t <= numFrames; ++t)
        {
            bool active = (t < numFrames) && (noteAct[static_cast<size_t> (t)][static_cast<size_t> (pitch)] > noteThreshold);
            bool onset  = (t < numFrames) && (onsetAct[static_cast<size_t> (t)][static_cast<size_t> (pitch)] > onsetThreshold);

            if (onset) hasOnset = true;

            if (active)
            {
                if (regionStart < 0)
                {
                    regionStart = t;
                    gapCount = 0;
                    hasOnset = onset;
                    peakActivation = 0.0f;
                    sumActivation = 0.0f;
                    activeFrameCount = 0;
                }
                gapCount = 0;
                float act = noteAct[static_cast<size_t> (t)][static_cast<size_t> (pitch)];
                peakActivation = std::max (peakActivation, act);
                sumActivation += act;
                activeFrameCount++;
            }
            else if (regionStart >= 0)
            {
                gapCount++;
                if (gapCount > mergeGapFrames || t == numFrames)
                {
                    // End of region — emit note if valid
                    int regionEnd = t - gapCount + 1;
                    int durationFrames = regionEnd - regionStart;

                    // Accept note if it has an onset OR if it's long enough to be a sustained note.
                    // Vocals and sustained instruments often lack sharp onset transients,
                    // so requiring hasOnset would filter out most notes.
                    int longNoteFrames = static_cast<int> (200.0 / 1000.0 / frameTime); // 200ms
                    bool acceptNote = durationFrames >= minDurationFrames
                                   && (hasOnset || durationFrames >= longNoteFrames);
                    if (acceptNote)
                    {
                        PolyNote note;
                        note.id = juce::Uuid().toString();
                        note.startTime = static_cast<float> (regionStart * frameTime);
                        note.endTime = static_cast<float> (regionEnd * frameTime);
                        note.midiPitch = pitch + kMidiOffset;
                        note.confidence = (activeFrameCount > 0) ? (sumActivation / static_cast<float> (activeFrameCount)) : 0.0f;
                        note.velocity = peakActivation;
                        notes.push_back (note);
                    }

                    regionStart = -1;
                    gapCount = 0;
                    hasOnset = false;
                }
            }
        }
    }

    // Sort by start time, then by pitch
    std::sort (notes.begin(), notes.end(), [] (const PolyNote& a, const PolyNote& b) {
        if (a.startTime == b.startTime)
            return a.midiPitch < b.midiPitch;
        return a.startTime < b.startTime;
    });

    return notes;
}

PolyPitchDetector::PolyAnalysisResult
PolyPitchDetector::analyze (const float* monoAudio, int numSamples,
                             double sourceSampleRate, const juce::String& clipId)
{
    PolyAnalysisResult result;
    result.clipId = clipId;
    result.sampleRate = kModelSampleRate;
    result.hopSize = kHopSize;

    if (monoAudio == nullptr || numSamples <= 0 || ! std::isfinite (sourceSampleRate)
        || sourceSampleRate <= 0.0)
    {
        result.error = "Basic Pitch needs non-empty audio at a valid sample rate.";
        return result;
    }
    for (int i = 0; i < numSamples; ++i)
        if (! std::isfinite (monoAudio[i]))
        {
            result.error = "Basic Pitch cannot analyze non-finite audio samples.";
            return result;
        }
#if OPENSTUDIO_HAS_ONNXRUNTIME
    if (! modelLoaded || ortSession == nullptr)
    {
        result.error = "Basic Pitch model is not loaded.";
        return result;
    }
    try
    {
        const auto resampled = resampleTo22050 (monoAudio, numSamples, sourceSampleRate);
        const auto inputInfo = ortSession->GetInputTypeInfo (0);
        const auto shape = inputInfo.GetTensorTypeAndShapeInfo().GetShape();
        if (shape.size() != 3 || shape[1] != kWindowSamples || shape[2] != 1)
            throw std::runtime_error ("Unsupported Basic Pitch input shape.");

        Ort::AllocatorWithDefaultOptions allocator;
        const auto inputName = ortSession->GetInputNameAllocated (0, allocator);
        const char* inputNames[] = { inputName.get() };
        // Names, not graph output positions, identify the three different heads.
        // Spotify basic_pitch/inference.py specifies these ONNX export names.
        const char* outputNames[] = { "StatefulPartitionedCall:0",
                                     "StatefulPartitionedCall:1",
                                     "StatefulPartitionedCall:2" };
        const std::array<int64_t, 3> inputShape { 1, kWindowSamples, 1 };
        std::vector<float> window (kWindowSamples, 0.0f);
        std::vector<std::vector<float>> onsetActivation;
        const auto frameCount = (resampled.size() + kHopSize - 1) / kHopSize;
        const auto contextSamples = kContextFrames * kHopSize;

        for (size_t firstFrame = 0; firstFrame < frameCount; firstFrame += kKeptFrames)
        {
            std::fill (window.begin(), window.end(), 0.0f);
            const auto start = static_cast<int64_t> (firstFrame / kKeptFrames) * kWindowStride - contextSamples;
            for (int i = 0; i < kWindowSamples; ++i)
            {
                const auto source = start + i;
                if (source >= 0 && source < static_cast<int64_t> (resampled.size()))
                    window[static_cast<size_t> (i)] = resampled[static_cast<size_t> (source)];
            }
            auto input = Ort::Value::CreateTensor<float> (memoryInfo, window.data(), window.size(),
                                                         inputShape.data(), inputShape.size());
            auto outputs = ortSession->Run (Ort::RunOptions { nullptr }, inputNames, &input, 1, outputNames, 3);
            const std::array<int, 3> bins { kContourBins, kNoteBins, kNoteBins };
            const std::array<std::vector<std::vector<float>>*, 3> destinations {
                &result.pitchSalience, &result.noteActivation, &onsetActivation };
            for (size_t head = 0; head < outputs.size(); ++head)
            {
                const auto info = outputs[head].GetTensorTypeAndShapeInfo();
                if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT
                    || info.GetShape() != std::vector<int64_t> { 1, kWindowFrames, bins[head] })
                    throw std::runtime_error ("Unsupported Basic Pitch output shape or type.");
                const auto* data = outputs[head].GetTensorData<float>();
                const auto count = std::min (static_cast<size_t> (kKeptFrames), frameCount - firstFrame);
                for (size_t frame = 0; frame < count; ++frame)
                {
                    const auto* row = data + (frame + kContextFrames) * static_cast<size_t> (bins[head]);
                    if (! std::all_of (row, row + bins[head], [] (float value) { return std::isfinite (value); }))
                        throw std::runtime_error ("Basic Pitch returned non-finite predictions.");
                    destinations[head]->emplace_back (row, row + bins[head]);
                }
            }
        }
        result.notes = extractNotes (result.noteActivation, onsetActivation, kHopSize, kModelSampleRate);
        const auto duration = static_cast<float> (numSamples / sourceSampleRate);
        for (auto& note : result.notes)
            note.endTime = std::min (note.endTime, duration);
        result.notes.erase (std::remove_if (result.notes.begin(), result.notes.end(),
            [] (const PolyNote& note) { return note.endTime <= note.startTime; }), result.notes.end());
        juce::Logger::writeToLog ("PolyPitchDetector: Found " + juce::String ((int) result.notes.size())
                                 + " notes in " + juce::String ((int) result.noteActivation.size()) + " frames");
    }
    catch (const std::exception& e)
    {
        result.error = "Basic Pitch analysis failed: " + juce::String::fromUTF8 (e.what());
        result.notes.clear();
        result.pitchSalience.clear();
        result.noteActivation.clear();
        juce::Logger::writeToLog (result.error);
    }
#else
    result.error = "Basic Pitch requires ONNX Runtime support in this build.";
#endif

    return result;
}

juce::var PolyPitchDetector::resultToJSON (const PolyAnalysisResult& result)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty ("clipId", result.clipId);
    if (result.error.isNotEmpty())
        obj->setProperty ("error", result.error);
    obj->setProperty ("sampleRate", result.sampleRate);
    obj->setProperty ("hopSize", result.hopSize);

    // Notes array
    juce::Array<juce::var> notesArr;
    for (const auto& note : result.notes)
    {
        auto noteObj = std::make_unique<juce::DynamicObject>();
        noteObj->setProperty ("id", note.id);
        noteObj->setProperty ("startTime", static_cast<double> (note.startTime));
        noteObj->setProperty ("endTime", static_cast<double> (note.endTime));
        noteObj->setProperty ("midiPitch", note.midiPitch);
        noteObj->setProperty ("confidence", static_cast<double> (note.confidence));
        noteObj->setProperty ("velocity", static_cast<double> (note.velocity));
        noteObj->setProperty ("correctedPitch", note.midiPitch); // initially same as detected
        noteObj->setProperty ("formantShift", 0.0);
        noteObj->setProperty ("gain", 0.0);
        notesArr.add (juce::var (noteObj.release()));
    }
    obj->setProperty ("notes", notesArr);

    // Pitch salience (sparse — only include frames with significant energy to reduce JSON size)
    // For now, include a downsampled version for visualization
    int salienceFrames = static_cast<int> (result.pitchSalience.size());
    int downsampleFactor = std::max (1, salienceFrames / 500); // limit to ~500 frames max
    juce::Array<juce::var> salienceArr;
    for (int t = 0; t < salienceFrames; t += downsampleFactor)
    {
        juce::Array<juce::var> frameArr;
        const auto& frame = result.pitchSalience[static_cast<size_t> (t)];
        // Find max for normalization
        float maxVal = 0.001f;
        for (float v : frame) maxVal = std::max (maxVal, v);
        // Store as uint8 scaled values (compact)
        for (float v : frame)
            frameArr.add (static_cast<int> (std::min (255.0f, v / maxVal * 255.0f)));
        salienceArr.add (frameArr);
    }
    obj->setProperty ("pitchSalience", salienceArr);
    obj->setProperty ("salienceDownsampleFactor", downsampleFactor);

    return juce::var (obj.release());
}
