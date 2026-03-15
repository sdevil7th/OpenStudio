#include "RMVPEPitchDetector.h"
#include <juce_dsp/juce_dsp.h>
#include <cmath>
#include <algorithm>
#include <numeric>

RMVPEPitchDetector::RMVPEPitchDetector() = default;
RMVPEPitchDetector::~RMVPEPitchDetector() = default;

// ===========================================================================
// Model Loading
// ===========================================================================

bool RMVPEPitchDetector::loadModel (const juce::File& onnxModelPath)
{
#if S13_HAS_ONNXRUNTIME
    if (! onnxModelPath.existsAsFile())
    {
        juce::Logger::writeToLog ("RMVPEPitchDetector: model file not found: "
                                   + onnxModelPath.getFullPathName());
        return false;
    }

    try
    {
        ortEnv = std::make_unique<Ort::Env> (ORT_LOGGING_LEVEL_WARNING, "S13RMVPE");

        Ort::SessionOptions sessionOpts;
        sessionOpts.SetIntraOpNumThreads (2);
        sessionOpts.SetGraphOptimizationLevel (GraphOptimizationLevel::ORT_ENABLE_ALL);

#ifdef _WIN32
        ortSession = std::make_unique<Ort::Session> (
            *ortEnv,
            onnxModelPath.getFullPathName().toWideCharPointer(),
            sessionOpts);
#else
        ortSession = std::make_unique<Ort::Session> (
            *ortEnv,
            onnxModelPath.getFullPathName().toRawUTF8(),
            sessionOpts);
#endif

        modelLoaded = true;

        // Query actual tensor names from the model (don't hardcode)
        {
            Ort::AllocatorWithDefaultOptions allocator;
            auto inName = ortSession->GetInputNameAllocated (0, allocator);
            auto outName = ortSession->GetOutputNameAllocated (0, allocator);
            modelInputName = inName.get();
            modelOutputName = outName.get();

            // Log model info for diagnostics
            auto inInfo = ortSession->GetInputTypeInfo (0).GetTensorTypeAndShapeInfo();
            auto outInfo = ortSession->GetOutputTypeInfo (0).GetTensorTypeAndShapeInfo();
            auto inShape = inInfo.GetShape();
            auto outShape = outInfo.GetShape();

            juce::String inShapeStr, outShapeStr;
            for (auto d : inShape) inShapeStr += juce::String (d) + " ";
            for (auto d : outShape) outShapeStr += juce::String (d) + " ";

            juce::Logger::writeToLog ("RMVPEPitchDetector: input='" + juce::String (modelInputName)
                                       + "' shape=[" + inShapeStr.trimEnd() + "]"
                                       + " output='" + juce::String (modelOutputName)
                                       + "' shape=[" + outShapeStr.trimEnd() + "]");
        }

        // Pre-build mel filter bank and Hann window
        buildMelFilterBank();

        // Pre-compute Hann window
        hannWindow.resize (static_cast<size_t> (kNFFT));
        for (int i = 0; i < kNFFT; ++i)
            hannWindow[static_cast<size_t> (i)] =
                0.5f * (1.0f - std::cos (2.0f * juce::MathConstants<float>::pi
                                          * static_cast<float> (i)
                                          / static_cast<float> (kNFFT - 1)));

        juce::Logger::writeToLog ("RMVPEPitchDetector: model loaded successfully from "
                                   + onnxModelPath.getFullPathName());
        return true;
    }
    catch (const Ort::Exception& e)
    {
        juce::Logger::writeToLog ("RMVPEPitchDetector: ONNX error: " + juce::String (e.what()));
        modelLoaded = false;
        return false;
    }
#else
    juce::ignoreUnused (onnxModelPath);
    juce::Logger::writeToLog ("RMVPEPitchDetector: ONNX Runtime not available");
    return false;
#endif
}

// ===========================================================================
// Mel Filter Bank (HTK-style, librosa-compatible)
// ===========================================================================

static float hzToMel (float hz)
{
    return 2595.0f * std::log10 (1.0f + hz / 700.0f);
}

static float melToHz (float mel)
{
    return 700.0f * (std::pow (10.0f, mel / 2595.0f) - 1.0f);
}

void RMVPEPitchDetector::buildMelFilterBank()
{
    const int halfFFT = kNFFT / 2 + 1; // 513 bins

    // Compute mel-scale center frequencies for kNMels + 2 points
    float melMin = hzToMel (kFMin);
    float melMax = hzToMel (kFMax);

    std::vector<float> melPoints (static_cast<size_t> (kNMels + 2));
    for (int i = 0; i < kNMels + 2; ++i)
        melPoints[static_cast<size_t> (i)] =
            melMin + static_cast<float> (i) * (melMax - melMin) / static_cast<float> (kNMels + 1);

    // Convert mel points to FFT bin indices
    std::vector<float> binFreqs (static_cast<size_t> (kNMels + 2));
    for (int i = 0; i < kNMels + 2; ++i)
    {
        float hz = melToHz (melPoints[static_cast<size_t> (i)]);
        binFreqs[static_cast<size_t> (i)] =
            hz * static_cast<float> (kNFFT) / static_cast<float> (kModelSampleRate);
    }

    // Build triangular filter bank [kNMels x halfFFT]
    melFilterBank.resize (static_cast<size_t> (kNMels));
    for (int m = 0; m < kNMels; ++m)
    {
        melFilterBank[static_cast<size_t> (m)].resize (static_cast<size_t> (halfFFT), 0.0f);

        float left   = binFreqs[static_cast<size_t> (m)];
        float center = binFreqs[static_cast<size_t> (m + 1)];
        float right  = binFreqs[static_cast<size_t> (m + 2)];

        for (int k = 0; k < halfFFT; ++k)
        {
            float bin = static_cast<float> (k);

            if (bin >= left && bin <= center && center > left)
                melFilterBank[static_cast<size_t> (m)][static_cast<size_t> (k)] =
                    (bin - left) / (center - left);
            else if (bin > center && bin <= right && right > center)
                melFilterBank[static_cast<size_t> (m)][static_cast<size_t> (k)] =
                    (right - bin) / (right - center);
        }
    }

    melFilterBankReady = true;
}

// ===========================================================================
// Resampling to 16 kHz
// ===========================================================================

std::vector<float> RMVPEPitchDetector::resampleTo16k (const float* audio, int numSamples,
                                                        double sourceSampleRate)
{
    if (std::abs (sourceSampleRate - static_cast<double> (kModelSampleRate)) < 1.0)
    {
        // Already at 16 kHz
        return std::vector<float> (audio, audio + numSamples);
    }

    double ratio = static_cast<double> (kModelSampleRate) / sourceSampleRate;
    int outSamples = static_cast<int> (static_cast<double> (numSamples) * ratio);

    std::vector<float> resampled (static_cast<size_t> (outSamples));

    for (int i = 0; i < outSamples; ++i)
    {
        double srcPos = static_cast<double> (i) / ratio;
        int idx = static_cast<int> (srcPos);
        float frac = static_cast<float> (srcPos - static_cast<double> (idx));

        if (idx + 1 < numSamples)
            resampled[static_cast<size_t> (i)] =
                audio[idx] * (1.0f - frac) + audio[idx + 1] * frac;
        else if (idx < numSamples)
            resampled[static_cast<size_t> (i)] = audio[idx];
    }

    return resampled;
}

// ===========================================================================
// Log Mel Spectrogram Computation
// ===========================================================================

std::vector<std::vector<float>> RMVPEPitchDetector::computeLogMelSpectrogram (
    const float* audio16k, int numSamples16k)
{
    const int halfFFT = kNFFT / 2 + 1; // 513

    // Number of frames
    int numFrames = std::max (0, (numSamples16k - kNFFT) / kHopLength + 1);
    if (numFrames == 0)
        return {};

    // FFT setup (order 10 = 2^10 = 1024)
    juce::dsp::FFT fft (10);

    // Working buffer for FFT (needs 2 * fftSize for JUCE's real-only FFT)
    std::vector<float> fftBuffer (static_cast<size_t> (kNFFT * 2), 0.0f);

    // Output: [numFrames][kNMels]
    std::vector<std::vector<float>> melSpec (
        static_cast<size_t> (numFrames),
        std::vector<float> (static_cast<size_t> (kNMels), 0.0f));

    // Power spectrum buffer
    std::vector<float> powerSpec (static_cast<size_t> (halfFFT));

    for (int f = 0; f < numFrames; ++f)
    {
        int frameStart = f * kHopLength;

        // Apply Hann window and copy to FFT buffer
        std::fill (fftBuffer.begin(), fftBuffer.end(), 0.0f);
        for (int i = 0; i < kNFFT; ++i)
        {
            int sampleIdx = frameStart + i;
            if (sampleIdx < numSamples16k)
                fftBuffer[static_cast<size_t> (i)] =
                    audio16k[sampleIdx] * hannWindow[static_cast<size_t> (i)];
        }

        // Forward FFT
        fft.performRealOnlyForwardTransform (fftBuffer.data(), true);

        // Compute power spectrum: |FFT|^2
        for (int k = 0; k < halfFFT; ++k)
        {
            float re = fftBuffer[static_cast<size_t> (k * 2)];
            float im = fftBuffer[static_cast<size_t> (k * 2 + 1)];
            powerSpec[static_cast<size_t> (k)] = re * re + im * im;
        }

        // Apply mel filter bank and take log
        for (int m = 0; m < kNMels; ++m)
        {
            float melEnergy = 0.0f;
            for (int k = 0; k < halfFFT; ++k)
                melEnergy += powerSpec[static_cast<size_t> (k)]
                           * melFilterBank[static_cast<size_t> (m)][static_cast<size_t> (k)];

            // Log mel (clamp to avoid log(0))
            melSpec[static_cast<size_t> (f)][static_cast<size_t> (m)] =
                std::log (std::max (melEnergy, 1e-5f));
        }
    }

    return melSpec;
}

// ===========================================================================
// Pitch Bin Decoding
// ===========================================================================

float RMVPEPitchDetector::decodePitchBins (const float* bins, int numBins, float& outConfidence)
{
    // Find argmax
    int bestBin = 0;
    float bestVal = bins[0];
    for (int i = 1; i < numBins; ++i)
    {
        if (bins[i] > bestVal)
        {
            bestVal = bins[i];
            bestBin = i;
        }
    }

    outConfidence = bestVal;

    // Below confidence threshold → unvoiced
    if (bestVal < kConfThreshold)
        return 0.0f;

    // Weighted average around argmax for sub-bin precision
    float refinedBin = static_cast<float> (bestBin);
    if (bestBin > 0 && bestBin < numBins - 1)
    {
        float left   = bins[bestBin - 1];
        float center = bins[bestBin];
        float right  = bins[bestBin + 1];

        float denom = center + 1e-10f;
        refinedBin += 0.5f * (right - left) / denom;
        refinedBin = juce::jlimit (0.0f, static_cast<float> (numBins - 1), refinedBin);
    }

    // Convert bin to Hz: each bin = 20 cents, reference = 10 Hz
    // cents = bin * 20
    // f0 = 10.0 * 2^(cents / 1200)
    float cents = refinedBin * 20.0f;
    float f0 = 10.0f * std::pow (2.0f, cents / 1200.0f);

    return f0;
}

// ===========================================================================
// Main Analysis
// ===========================================================================

std::vector<RMVPEPitchDetector::PitchResult> RMVPEPitchDetector::analyze (
    const float* monoData, int numSamples, double sampleRate)
{
#if S13_HAS_ONNXRUNTIME
    if (! modelLoaded || ortSession == nullptr)
        return {};

    // 1. Resample to 16 kHz
    auto audio16k = resampleTo16k (monoData, numSamples, sampleRate);
    int numSamples16k = static_cast<int> (audio16k.size());

    if (numSamples16k < kNFFT)
        return {};

    // 2. Compute log mel spectrogram
    auto melSpec = computeLogMelSpectrogram (audio16k.data(), numSamples16k);
    int numFrames = static_cast<int> (melSpec.size());

    if (numFrames == 0)
        return {};

    // 3. Pad to multiple of kFrameAlignment (32)
    int paddedFrames = kFrameAlignment * ((numFrames - 1) / kFrameAlignment + 1);
    int paddingNeeded = paddedFrames - numFrames;

    // Flatten mel spectrogram to [1, paddedFrames, 128] for ONNX
    std::vector<float> inputData (static_cast<size_t> (paddedFrames * kNMels), 0.0f);

    // Copy actual frames
    for (int f = 0; f < numFrames; ++f)
        for (int m = 0; m < kNMels; ++m)
            inputData[static_cast<size_t> (f * kNMels + m)] =
                melSpec[static_cast<size_t> (f)][static_cast<size_t> (m)];

    // Reflection padding for remaining frames
    for (int p = 0; p < paddingNeeded; ++p)
    {
        int srcFrame = numFrames - 1 - (p % numFrames);
        srcFrame = std::max (0, srcFrame);
        for (int m = 0; m < kNMels; ++m)
            inputData[static_cast<size_t> ((numFrames + p) * kNMels + m)] =
                melSpec[static_cast<size_t> (srcFrame)][static_cast<size_t> (m)];
    }

    // 4. Run ONNX inference
    try
    {
        Ort::MemoryInfo memInfo = Ort::MemoryInfo::CreateCpu (OrtArenaAllocator, OrtMemTypeDefault);

        std::array<int64_t, 3> inputShape = { 1, static_cast<int64_t> (paddedFrames),
                                                static_cast<int64_t> (kNMels) };

        Ort::Value inputTensor = Ort::Value::CreateTensor<float> (
            memInfo,
            inputData.data(),
            inputData.size(),
            inputShape.data(),
            inputShape.size());

        const char* inputNamePtr  = modelInputName.c_str();
        const char* outputNamePtr = modelOutputName.c_str();

        auto outputs = ortSession->Run (
            Ort::RunOptions { nullptr },
            &inputNamePtr,  &inputTensor,  1,
            &outputNamePtr, 1);

        // 5. Parse output: [1, paddedFrames, 360]
        auto& outputTensor = outputs[0];
        auto outputShape = outputTensor.GetTensorTypeAndShapeInfo().GetShape();

        int outFrames = static_cast<int> (outputShape[1]);
        int outBins   = static_cast<int> (outputShape[2]);

        if (outBins != kPitchBins)
        {
            juce::Logger::writeToLog ("RMVPEPitchDetector: unexpected output bins: "
                                       + juce::String (outBins) + " (expected "
                                       + juce::String (kPitchBins) + ")");
            return {};
        }

        const float* outputData = outputTensor.GetTensorData<float>();

        // 5b. Apply sigmoid activation — RMVPE outputs raw logits, not probabilities.
        // sigmoid(x) = 1 / (1 + exp(-x))
        int totalOutputValues = outFrames * outBins;
        std::vector<float> activatedOutput (static_cast<size_t> (totalOutputValues));
        for (int i = 0; i < totalOutputValues; ++i)
        {
            float logit = outputData[i];
            // Clamp to avoid overflow in exp()
            logit = juce::jlimit (-20.0f, 20.0f, logit);
            activatedOutput[static_cast<size_t> (i)] = 1.0f / (1.0f + std::exp (-logit));
        }

        // 6. Decode each frame to F0
        std::vector<PitchResult> results;
        results.reserve (static_cast<size_t> (numFrames));

        float hopSeconds = static_cast<float> (kHopLength) / static_cast<float> (kModelSampleRate);

        for (int f = 0; f < std::min (numFrames, outFrames); ++f)
        {
            const float* frameBins = activatedOutput.data() + f * outBins;

            float confidence = 0.0f;
            float f0 = decodePitchBins (frameBins, outBins, confidence);

            PitchResult result;
            result.time       = static_cast<float> (f) * hopSeconds;
            result.frequency  = f0;
            result.confidence = confidence;

            results.push_back (result);
        }

        // Log result statistics for diagnostics
        int voicedFrames = 0;
        float avgConf = 0.0f;
        for (const auto& r : results)
        {
            if (r.frequency > 0.0f) ++voicedFrames;
            avgConf += r.confidence;
        }
        if (! results.empty())
            avgConf /= static_cast<float> (results.size());

        juce::Logger::writeToLog ("RMVPEPitchDetector: analyzed " + juce::String (numFrames)
                                   + " frames, " + juce::String (voicedFrames) + " voiced"
                                   + ", avg confidence=" + juce::String (avgConf, 3));

        return results;
    }
    catch (const Ort::Exception& e)
    {
        juce::Logger::writeToLog ("RMVPEPitchDetector: inference error: "
                                   + juce::String (e.what()));
        return {};
    }
#else
    juce::ignoreUnused (monoData, numSamples, sampleRate);
    return {};
#endif
}
