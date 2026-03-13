#include "PolyPitchDetector.h"

// Basic-Pitch model constants
static constexpr double kModelSampleRate = 22050.0;
static constexpr int    kHopSize         = 256;    // ~11.6ms at 22050 Hz
static constexpr int    kNoteBins        = 88;     // A0 (MIDI 21) to C8 (MIDI 108)
static constexpr int    kContourBins     = 264;    // 88 * 3 (1/3 semitone resolution)
static constexpr int    kMidiOffset      = 21;     // MIDI note of lowest bin (A0)

// Maximum chunk size for inference (in samples at 22050 Hz).
// Basic-Pitch processes audio in ~5-second chunks.
static constexpr int kMaxChunkSamples = 22050 * 5;

PolyPitchDetector::PolyPitchDetector()
{
}

PolyPitchDetector::~PolyPitchDetector()
{
}

bool PolyPitchDetector::loadModel (const juce::File& onnxModelPath)
{
#if S13_HAS_ONNXRUNTIME
    if (! onnxModelPath.existsAsFile())
    {
        juce::Logger::writeToLog ("PolyPitchDetector: Model file not found: " + onnxModelPath.getFullPathName());
        return false;
    }

    try
    {
        ortEnv = std::make_unique<Ort::Env> (ORT_LOGGING_LEVEL_WARNING, "S13PolyPitch");

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
    juce::Logger::writeToLog ("PolyPitchDetector: ONNX Runtime not available (compiled without S13_HAS_ONNXRUNTIME)");
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
    int outputLen = static_cast<int> (numSamples * ratio) + 1;
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
                    int regionEnd = t - gapCount;
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
        if (std::abs (a.startTime - b.startTime) < 0.001f)
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

#if S13_HAS_ONNXRUNTIME
    if (! modelLoaded || ortSession == nullptr)
    {
        juce::Logger::writeToLog ("PolyPitchDetector::analyze: Model not loaded");
        return result;
    }

    // Step 1: Resample to 22050 Hz
    auto resampled = resampleTo22050 (monoAudio, numSamples, sourceSampleRate);
    int totalSamples = static_cast<int> (resampled.size());

    juce::Logger::writeToLog ("PolyPitchDetector: Analyzing " + juce::String (totalSamples)
                            + " samples (" + juce::String (totalSamples / kModelSampleRate, 1) + "s)");

    // Step 2: Run inference in chunks
    // The model accepts variable-length audio. We'll process in ~5s chunks
    // and concatenate outputs.
    Ort::AllocatorWithDefaultOptions allocator;

    // Get input/output names
    auto inputName = ortSession->GetInputNameAllocated (0, allocator);
    auto numOutputs = ortSession->GetOutputCount();

    std::vector<std::string> outputNameStrs;
    std::vector<const char*> outputNamePtrs;
    for (size_t i = 0; i < numOutputs; ++i)
    {
        auto name = ortSession->GetOutputNameAllocated (i, allocator);
        outputNameStrs.push_back (name.get());
    }
    for (const auto& s : outputNameStrs)
        outputNamePtrs.push_back (s.c_str());

    const char* inputNames[] = { inputName.get() };

    // Process all audio at once (Basic-Pitch handles variable length)
    // Input shape: [1, N_samples, 1] — raw audio waveform
    std::vector<int64_t> inputShape = { 1, static_cast<int64_t> (totalSamples), 1 };

    auto inputTensor = Ort::Value::CreateTensor<float> (
        memoryInfo, resampled.data(), resampled.size(),
        inputShape.data(), inputShape.size());

    try
    {
        auto outputs = ortSession->Run (
            Ort::RunOptions { nullptr },
            inputNames, &inputTensor, 1,
            outputNamePtrs.data(), outputNamePtrs.size());

        // Parse outputs
        // Output order depends on model version; typically:
        //   0: contour [1, T, 264]
        //   1: note    [1, T, 88]
        //   2: onset   [1, T, 88]

        auto parseOutput = [&] (size_t idx, int expectedBins) -> std::vector<std::vector<float>> {
            std::vector<std::vector<float>> matrix;
            if (idx >= outputs.size()) return matrix;

            auto& tensor = outputs[idx];
            auto shape = tensor.GetTensorTypeAndShapeInfo().GetShape();
            if (shape.size() < 2) return matrix;

            int T = static_cast<int> (shape.size() == 3 ? shape[1] : shape[0]);
            int bins = static_cast<int> (shape.size() == 3 ? shape[2] : shape[1]);
            juce::ignoreUnused (expectedBins);

            const float* data = tensor.GetTensorData<float>();
            matrix.resize (static_cast<size_t> (T));
            for (int t = 0; t < T; ++t)
            {
                matrix[static_cast<size_t> (t)].assign (
                    data + t * bins,
                    data + t * bins + bins);
            }
            return matrix;
        };

        result.pitchSalience = parseOutput (0, kContourBins);

        std::vector<std::vector<float>> noteAct;
        std::vector<std::vector<float>> onsetAct;

        if (numOutputs >= 3)
        {
            noteAct  = parseOutput (1, kNoteBins);
            onsetAct = parseOutput (2, kNoteBins);
        }
        else if (numOutputs == 2)
        {
            // Some model versions combine note+onset
            noteAct = parseOutput (1, kNoteBins);
            // Synthesize onsets from note activation derivative
            onsetAct.resize (noteAct.size());
            for (size_t t = 0; t < noteAct.size(); ++t)
            {
                onsetAct[t].resize (static_cast<size_t> (kNoteBins), 0.0f);
                if (t == 0)
                {
                    onsetAct[t] = noteAct[t]; // first frame = onset
                }
                else
                {
                    for (int p = 0; p < kNoteBins; ++p)
                    {
                        float diff = noteAct[t][static_cast<size_t> (p)]
                                   - noteAct[t - 1][static_cast<size_t> (p)];
                        onsetAct[t][static_cast<size_t> (p)] = std::max (0.0f, diff);
                    }
                }
            }
        }

        result.noteActivation = noteAct;

        // Diagnostic: log max activations so we can see if model output is valid
        float maxNote = 0.0f, maxOnset = 0.0f;
        for (const auto& row : noteAct)
            for (float v : row) maxNote = std::max (maxNote, v);
        for (const auto& row : onsetAct)
            for (float v : row) maxOnset = std::max (maxOnset, v);
        juce::Logger::writeToLog ("PolyPitchDetector: maxNoteAct=" + juce::String (maxNote, 3)
                                + " maxOnsetAct=" + juce::String (maxOnset, 3)
                                + " frames=" + juce::String ((int) noteAct.size())
                                + " noteThresh=" + juce::String (noteThreshold, 2)
                                + " onsetThresh=" + juce::String (onsetThreshold, 2));

        // Step 3: Post-process into discrete notes
        result.notes = extractNotes (noteAct, onsetAct, kHopSize, kModelSampleRate);

        juce::Logger::writeToLog ("PolyPitchDetector: Found " + juce::String ((int) result.notes.size())
                                + " notes in " + juce::String ((int) result.pitchSalience.size()) + " frames");
    }
    catch (const Ort::Exception& e)
    {
        juce::Logger::writeToLog ("PolyPitchDetector: Inference error: " + juce::String (e.what()));
    }

#else
    juce::ignoreUnused (monoAudio, numSamples, sourceSampleRate, clipId);
    juce::Logger::writeToLog ("PolyPitchDetector: ONNX Runtime not available");
#endif

    return result;
}

juce::var PolyPitchDetector::resultToJSON (const PolyAnalysisResult& result)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty ("clipId", result.clipId);
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
