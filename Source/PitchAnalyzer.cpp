#include "PitchAnalyzer.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <numeric>

namespace
{
constexpr float kPi = 3.14159265358979323846f;

float hzToMidi(float hz)
{
    if (hz <= 0.0f)
        return 0.0f;
    return 69.0f + 12.0f * std::log2(hz / 440.0f);
}

float clamp01(float value)
{
    return juce::jlimit(0.0f, 1.0f, value);
}

float safeLogProbability(float probability)
{
    return std::log(std::max(probability, 1.0e-6f));
}

float parabolicInterpolation(const std::vector<float>& values, int index)
{
    if (index <= 0 || index >= static_cast<int>(values.size()) - 1)
        return static_cast<float>(index);

    const float left = values[static_cast<size_t>(index - 1)];
    const float center = values[static_cast<size_t>(index)];
    const float right = values[static_cast<size_t>(index + 1)];
    const float denominator = 2.0f * (2.0f * center - left - right);

    if (std::abs(denominator) < 1.0e-8f)
        return static_cast<float>(index);

    return static_cast<float>(index) + (right - left) / denominator;
}

bool shouldCompareDirectYin()
{
    return juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_ANALYZER_COMPARE_DIRECT_YIN", {}).trim() == "1";
}

bool shouldUseFftYin()
{
    return juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_ANALYZER_USE_FFT_YIN", {}).trim() == "1";
}

struct PitchCandidate
{
    float frequency = 0.0f;
    float midi = 0.0f;
    float probability = 0.0f;
    float confidence = 0.0f;
    int tau = 0;
    float cmndf = 1.0f;
};

struct FrameObservation
{
    std::vector<PitchCandidate> candidates;
    float voicedProbability = 0.0f;
    float unvoicedProbability = 1.0f;
    float bestCmndf = 1.0f;
    float rmsDB = -100.0f;
};

struct DecodedFrame
{
    float frequency = 0.0f;
    float midi = 0.0f;
    float confidence = 0.0f;
    bool voiced = false;
};

struct DecoderCell
{
    float score = -std::numeric_limits<float>::infinity();
    int previousState = -1;
};
}

PitchAnalyzer::PitchAnalyzer()
    : fft(std::make_unique<juce::dsp::FFT>(analysisFftOrder))
{
    analysisWindow.resize(static_cast<size_t>(analysisFrameSize));
    for (int i = 0; i < analysisFrameSize; ++i)
    {
        analysisWindow[static_cast<size_t>(i)] =
            0.5f * (1.0f - std::cos((2.0f * kPi * static_cast<float>(i)) / static_cast<float>(analysisFrameSize - 1)));
    }

    yinBuffer.assign(static_cast<size_t>(analysisFrameSize / 2), 0.0f);
    differenceBuffer.assign(static_cast<size_t>(analysisFrameSize / 2), 0.0f);
    directDifferenceBuffer.assign(static_cast<size_t>(analysisFrameSize / 2), 0.0f);
    cmndfBuffer.assign(static_cast<size_t>(analysisFrameSize / 2), 1.0f);
    autocorrelationBuffer.assign(static_cast<size_t>(analysisFrameSize), 0.0f);
    prefixEnergyBuffer.assign(static_cast<size_t>(analysisFrameSize + 1), 0.0f);
    windowedFrameBuffer.assign(static_cast<size_t>(analysisFrameSize), 0.0f);
    fftBuffer.assign(static_cast<size_t>(analysisFftSize), {});
}

namespace
{
static void applyHannWindow(const float* inputFrame,
                            int frameSize,
                            const std::vector<float>& window,
                            std::vector<float>& outputFrame)
{
    outputFrame.resize(static_cast<size_t>(frameSize));
    for (int i = 0; i < frameSize; ++i)
        outputFrame[static_cast<size_t>(i)] = inputFrame[i] * window[static_cast<size_t>(i)];
}

static void computeDirectDifference(const std::vector<float>& frame,
                                    int frameSize,
                                    std::vector<float>& differenceBuffer)
{
    const int halfSize = frameSize / 2;
    differenceBuffer.assign(static_cast<size_t>(halfSize), 0.0f);

    for (int tau = 1; tau < halfSize; ++tau)
    {
        const int overlap = frameSize - tau;
        float sum = 0.0f;
        for (int j = 0; j < overlap; ++j)
        {
            const float delta = frame[static_cast<size_t>(j)] - frame[static_cast<size_t>(j + tau)];
            sum += delta * delta;
        }
        differenceBuffer[static_cast<size_t>(tau)] = std::max(0.0f, sum);
    }
}

static void computeDifferenceFft(const std::vector<float>& frame,
                                 int frameSize,
                                 juce::dsp::FFT& fft,
                                 std::vector<juce::dsp::Complex<float>>& fftBuffer,
                                 std::vector<float>& autocorrelationBuffer,
                                 std::vector<float>& prefixEnergyBuffer,
                                 std::vector<float>& differenceBuffer)
{
    const int fftSize = static_cast<int>(fftBuffer.size());
    const int halfSize = frameSize / 2;

    std::fill(fftBuffer.begin(), fftBuffer.end(), juce::dsp::Complex<float>(0.0f, 0.0f));
    for (int i = 0; i < frameSize; ++i)
        fftBuffer[static_cast<size_t>(i)] = juce::dsp::Complex<float>(frame[static_cast<size_t>(i)], 0.0f);

    fft.perform(fftBuffer.data(), fftBuffer.data(), false);
    for (int i = 0; i < fftSize; ++i)
        fftBuffer[static_cast<size_t>(i)] *= std::conj(fftBuffer[static_cast<size_t>(i)]);
    fft.perform(fftBuffer.data(), fftBuffer.data(), true);

    autocorrelationBuffer.assign(static_cast<size_t>(frameSize), 0.0f);
    for (int i = 0; i < frameSize; ++i)
        autocorrelationBuffer[static_cast<size_t>(i)] = fftBuffer[static_cast<size_t>(i)].real() / static_cast<float>(fftSize);

    prefixEnergyBuffer.assign(static_cast<size_t>(frameSize + 1), 0.0f);
    for (int i = 0; i < frameSize; ++i)
        prefixEnergyBuffer[static_cast<size_t>(i + 1)] = prefixEnergyBuffer[static_cast<size_t>(i)]
            + frame[static_cast<size_t>(i)] * frame[static_cast<size_t>(i)];

    differenceBuffer.assign(static_cast<size_t>(halfSize), 0.0f);
    for (int tau = 1; tau < halfSize; ++tau)
    {
        const int overlap = frameSize - tau;
        const float energyLeft = prefixEnergyBuffer[static_cast<size_t>(overlap)];
        const float energyRight = prefixEnergyBuffer[static_cast<size_t>(frameSize)] - prefixEnergyBuffer[static_cast<size_t>(tau)];
        const float diff = energyLeft + energyRight - 2.0f * autocorrelationBuffer[static_cast<size_t>(tau)];
        differenceBuffer[static_cast<size_t>(tau)] = std::max(0.0f, diff);
    }
}

static void computeCmndf(const std::vector<float>& differenceBuffer,
                         std::vector<float>& cmndfBuffer)
{
    cmndfBuffer.assign(differenceBuffer.size(), 1.0f);
    if (differenceBuffer.size() <= 1)
        return;

    float runningSum = 0.0f;
    for (size_t tau = 1; tau < differenceBuffer.size(); ++tau)
    {
        runningSum += differenceBuffer[tau];
        cmndfBuffer[tau] = runningSum > 0.0f
            ? differenceBuffer[tau] * static_cast<float>(tau) / runningSum
            : 1.0f;
    }
}

static FrameObservation extractFrameObservation(const std::vector<float>& cmndfBuffer,
                                                int tauMin,
                                                int tauMax,
                                                double sampleRate,
                                                float rmsDB,
                                                float sensitivity)
{
    FrameObservation observation;
    observation.rmsDB = rmsDB;

    if (tauMax <= tauMin || tauMin <= 0 || tauMax >= static_cast<int>(cmndfBuffer.size()))
        return observation;

    int globalBestTau = tauMin;
    float globalBestCmndf = cmndfBuffer[static_cast<size_t>(tauMin)];
    for (int tau = tauMin + 1; tau <= tauMax; ++tau)
    {
        const float value = cmndfBuffer[static_cast<size_t>(tau)];
        if (value < globalBestCmndf)
        {
            globalBestCmndf = value;
            globalBestTau = tau;
        }
    }

    observation.bestCmndf = globalBestCmndf;

    constexpr std::array<float, 5> thresholds { 0.06f, 0.08f, 0.10f, 0.14f, 0.20f };
    std::vector<int> candidateTaus;
    std::vector<int> voteCounts(static_cast<size_t>(cmndfBuffer.size()), 0);

    // pYIN-style threshold voting: each threshold votes for the first dip it would have chosen.
    for (const float threshold : thresholds)
    {
        for (int tau = tauMin; tau <= tauMax; ++tau)
        {
            if (cmndfBuffer[static_cast<size_t>(tau)] >= threshold)
                continue;

            while (tau + 1 <= tauMax
                   && cmndfBuffer[static_cast<size_t>(tau + 1)] < cmndfBuffer[static_cast<size_t>(tau)])
            {
                ++tau;
            }

            ++voteCounts[static_cast<size_t>(tau)];
            break;
        }
    }

    // Keep additional local minima as fallbacks, but threshold-voted minima get priority.
    for (int tau = std::max(tauMin, 2); tau < std::min(tauMax, static_cast<int>(cmndfBuffer.size()) - 1); ++tau)
    {
        const float center = cmndfBuffer[static_cast<size_t>(tau)];
        const float left = cmndfBuffer[static_cast<size_t>(tau - 1)];
        const float right = cmndfBuffer[static_cast<size_t>(tau + 1)];
        const bool localMinimum = center <= left && center <= right;
        if (! localMinimum || center > 0.28f)
            continue;
        candidateTaus.push_back(tau);
    }

    for (int tau = tauMin; tau <= tauMax; ++tau)
    {
        if (voteCounts[static_cast<size_t>(tau)] > 0)
            candidateTaus.push_back(tau);
    }

    if (candidateTaus.empty())
        candidateTaus.push_back(globalBestTau);

    std::sort(candidateTaus.begin(), candidateTaus.end(), [&] (int a, int b)
    {
        const int voteA = voteCounts[static_cast<size_t>(a)];
        const int voteB = voteCounts[static_cast<size_t>(b)];
        if (voteA != voteB)
            return voteA > voteB;
        return cmndfBuffer[static_cast<size_t>(a)] < cmndfBuffer[static_cast<size_t>(b)];
    });
    candidateTaus.erase(std::unique(candidateTaus.begin(), candidateTaus.end()), candidateTaus.end());

    std::vector<float> rawScores;
    rawScores.reserve(candidateTaus.size());

    for (const int tau : candidateTaus)
    {
        const float refinedTau = parabolicInterpolation(cmndfBuffer, tau);
        const float frequency = refinedTau > 0.0f ? static_cast<float>(sampleRate / refinedTau) : 0.0f;
        if (frequency <= 0.0f)
            continue;

        const int thresholdHits = voteCounts[static_cast<size_t>(tau)];
        const float periodicityScore = std::exp(-10.0f * cmndfBuffer[static_cast<size_t>(tau)]);
        const float thresholdScore = 0.15f + 0.85f * (static_cast<float>(thresholdHits) / static_cast<float>(thresholds.size()));
        const float shorterPeriodBias = std::sqrt(static_cast<float>(tauMin) / static_cast<float>(std::max(tau, tauMin)));

        PitchCandidate candidate;
        candidate.frequency = frequency;
        candidate.midi = hzToMidi(frequency);
        candidate.confidence = clamp01((1.0f - cmndfBuffer[static_cast<size_t>(tau)]) * std::max(0.35f, thresholdScore));
        candidate.tau = tau;
        candidate.cmndf = cmndfBuffer[static_cast<size_t>(tau)];
        observation.candidates.push_back(candidate);
        rawScores.push_back(periodicityScore * thresholdScore * shorterPeriodBias);
    }

    if (observation.candidates.empty())
        return observation;

    const float energyProbability = clamp01((rmsDB + 60.0f) / 24.0f);
    float periodicityProbability = clamp01((0.30f - globalBestCmndf) / 0.22f);
    if (globalBestCmndf <= sensitivity)
        periodicityProbability = std::max(periodicityProbability, 0.75f);

    observation.voicedProbability = clamp01(0.45f * energyProbability + 0.55f * periodicityProbability);
    observation.unvoicedProbability = clamp01(1.0f - observation.voicedProbability);

    const float scoreSum = std::accumulate(rawScores.begin(), rawScores.end(), 0.0f);
    if (scoreSum <= 1.0e-6f)
    {
        const float uniformProbability = observation.voicedProbability / static_cast<float>(observation.candidates.size());
        for (auto& candidate : observation.candidates)
            candidate.probability = uniformProbability;
    }
    else
    {
        for (size_t i = 0; i < observation.candidates.size(); ++i)
            observation.candidates[i].probability = observation.voicedProbability * (rawScores[i] / scoreSum);
    }

    constexpr size_t maxCandidates = 5;
    if (observation.candidates.size() > maxCandidates)
        observation.candidates.resize(maxCandidates);

    return observation;
}

static float transitionPenalty(bool previousVoiced,
                               bool currentVoiced,
                               float previousMidi,
                               float currentMidi)
{
    if (! previousVoiced && ! currentVoiced)
        return 0.05f;

    if (previousVoiced != currentVoiced)
        return 0.55f;

    const float semitoneDelta = std::abs(currentMidi - previousMidi);
    float penalty = 0.08f * semitoneDelta;

    if (semitoneDelta > 2.5f)
        penalty += 0.18f * (semitoneDelta - 2.5f);
    if (semitoneDelta > 7.0f)
        penalty += 0.70f + 0.22f * (semitoneDelta - 7.0f);
    if (std::abs(semitoneDelta - 12.0f) < 0.85f)
        penalty += 2.0f;

    return penalty;
}

static std::vector<DecodedFrame> decodePitchTrack(const std::vector<FrameObservation>& observations)
{
    if (observations.empty())
        return {};

    std::vector<std::vector<DecoderCell>> cells(observations.size());
    std::vector<std::vector<bool>> stateVoiced(observations.size());
    std::vector<std::vector<float>> stateMidi(observations.size());
    std::vector<std::vector<float>> stateFrequency(observations.size());
    std::vector<std::vector<float>> stateConfidence(observations.size());

    for (size_t frameIndex = 0; frameIndex < observations.size(); ++frameIndex)
    {
        const auto& observation = observations[frameIndex];
        const size_t stateCount = observation.candidates.size() + 1;
        cells[frameIndex].assign(stateCount, {});
        stateVoiced[frameIndex].assign(stateCount, false);
        stateMidi[frameIndex].assign(stateCount, 0.0f);
        stateFrequency[frameIndex].assign(stateCount, 0.0f);
        stateConfidence[frameIndex].assign(stateCount, 0.0f);

        cells[frameIndex][0].score = safeLogProbability(observation.unvoicedProbability);
        stateVoiced[frameIndex][0] = false;

        for (size_t candidateIndex = 0; candidateIndex < observation.candidates.size(); ++candidateIndex)
        {
            const auto& candidate = observation.candidates[candidateIndex];
            const size_t stateIndex = candidateIndex + 1;
            cells[frameIndex][stateIndex].score = safeLogProbability(candidate.probability);
            stateVoiced[frameIndex][stateIndex] = true;
            stateMidi[frameIndex][stateIndex] = candidate.midi;
            stateFrequency[frameIndex][stateIndex] = candidate.frequency;
            stateConfidence[frameIndex][stateIndex] = clamp01(candidate.confidence * observation.voicedProbability);
        }
    }

    for (size_t frameIndex = 1; frameIndex < observations.size(); ++frameIndex)
    {
        for (size_t stateIndex = 0; stateIndex < cells[frameIndex].size(); ++stateIndex)
        {
            float bestScore = -std::numeric_limits<float>::infinity();
            int bestPreviousState = -1;

            for (size_t previousState = 0; previousState < cells[frameIndex - 1].size(); ++previousState)
            {
                const float penalty = transitionPenalty(stateVoiced[frameIndex - 1][previousState],
                                                        stateVoiced[frameIndex][stateIndex],
                                                        stateMidi[frameIndex - 1][previousState],
                                                        stateMidi[frameIndex][stateIndex]);
                const float score = cells[frameIndex - 1][previousState].score
                    + cells[frameIndex][stateIndex].score
                    - penalty;

                if (score > bestScore)
                {
                    bestScore = score;
                    bestPreviousState = static_cast<int>(previousState);
                }
            }

            cells[frameIndex][stateIndex].score = bestScore;
            cells[frameIndex][stateIndex].previousState = bestPreviousState;
        }
    }

    int bestFinalState = 0;
    float bestFinalScore = cells.back()[0].score;
    for (size_t stateIndex = 1; stateIndex < cells.back().size(); ++stateIndex)
    {
        if (cells.back()[stateIndex].score > bestFinalScore)
        {
            bestFinalScore = cells.back()[stateIndex].score;
            bestFinalState = static_cast<int>(stateIndex);
        }
    }

    std::vector<int> bestStates(observations.size(), 0);
    bestStates.back() = bestFinalState;
    for (size_t frameIndex = observations.size() - 1; frameIndex > 0; --frameIndex)
    {
        const int previousState = cells[frameIndex][static_cast<size_t>(bestStates[frameIndex])].previousState;
        bestStates[frameIndex - 1] = previousState >= 0 ? previousState : 0;
    }

    std::vector<DecodedFrame> decoded(observations.size());
    for (size_t frameIndex = 0; frameIndex < observations.size(); ++frameIndex)
    {
        const int stateIndex = bestStates[frameIndex];
        DecodedFrame frame;
        frame.voiced = stateVoiced[frameIndex][static_cast<size_t>(stateIndex)];
        frame.midi = stateMidi[frameIndex][static_cast<size_t>(stateIndex)];
        frame.frequency = stateFrequency[frameIndex][static_cast<size_t>(stateIndex)];
        frame.confidence = frame.voiced
            ? stateConfidence[frameIndex][static_cast<size_t>(stateIndex)]
            : observations[frameIndex].unvoicedProbability;
        decoded[frameIndex] = frame;
    }

    return decoded;
}
}

float PitchAnalyzer::analyzeFrame(const float* frameData, int frameSize, double sampleRate,
                                  float& outConfidence)
{
    const int tauMin = std::max(2, static_cast<int>(sampleRate / maxFreq));
    const int tauMax = std::min(frameSize / 2 - 1, static_cast<int>(sampleRate / minFreq));
    if (tauMax <= tauMin || frameSize != analysisFrameSize)
    {
        outConfidence = 0.0f;
        return 0.0f;
    }

    float sumSquares = 0.0f;
    for (int i = 0; i < frameSize; ++i)
        sumSquares += frameData[i] * frameData[i];
    const float rms = std::sqrt(sumSquares / static_cast<float>(frameSize));
    const float rmsDB = rms > 0.0f ? 20.0f * std::log10(rms) : -100.0f;

    applyHannWindow(frameData, frameSize, analysisWindow, windowedFrameBuffer);
    const bool useFftYin = shouldUseFftYin();
    if (useFftYin)
        computeDifferenceFft(windowedFrameBuffer, frameSize, *fft, fftBuffer, autocorrelationBuffer, prefixEnergyBuffer, differenceBuffer);
    else
        computeDirectDifference(windowedFrameBuffer, frameSize, differenceBuffer);

    if (useFftYin && shouldCompareDirectYin())
    {
        computeDirectDifference(windowedFrameBuffer, frameSize, directDifferenceBuffer);
        float maxDifference = 0.0f;
        for (size_t i = 1; i < differenceBuffer.size(); ++i)
            maxDifference = std::max(maxDifference, std::abs(differenceBuffer[i] - directDifferenceBuffer[i]));
        juce::Logger::writeToLog("[PitchAnalyzer] FFT/direct YIN difference max=" + juce::String(maxDifference, 6));
    }

    computeCmndf(differenceBuffer, cmndfBuffer);
    yinBuffer = cmndfBuffer;

    const auto observation = extractFrameObservation(cmndfBuffer, tauMin, tauMax, sampleRate, rmsDB, sensitivity);
    if (observation.candidates.empty())
    {
        outConfidence = 0.0f;
        return 0.0f;
    }

    const auto bestIt = std::max_element(observation.candidates.begin(), observation.candidates.end(),
                                         [] (const PitchCandidate& a, const PitchCandidate& b)
                                         {
                                             return a.probability < b.probability;
                                         });
    outConfidence = clamp01(bestIt->confidence * observation.voicedProbability);
    return bestIt->frequency;
}

PitchAnalyzer::AnalysisResult PitchAnalyzer::analyzeClip(const float* audioData, int numSamples,
                                                         double sampleRate, const juce::String& clipId,
                                                         std::function<bool()> shouldCancel)
{
    AnalysisResult result;
    result.clipId = clipId;
    result.sampleRate = sampleRate;

    const double durationSec = static_cast<double>(numSamples) / sampleRate;
    const int hopSize = (durationSec > 120.0)  ? 1024
                        : (durationSec > 30.0) ? 512
                                               : 256;
    result.hopSize = hopSize;

    const int frameSize = analysisFrameSize;
    const int numFrames = (numSamples - frameSize) / hopSize + 1;
    if (numFrames <= 0)
        return result;

    const int tauMin = std::max(2, static_cast<int>(sampleRate / maxFreq));
    const int tauMax = std::min(frameSize / 2 - 1, static_cast<int>(sampleRate / minFreq));

    std::vector<FrameObservation> observations;
    observations.reserve(static_cast<size_t>(numFrames));
    result.frames.reserve(static_cast<size_t>(numFrames));

    for (int frameIndex = 0; frameIndex < numFrames; ++frameIndex)
    {
        if (shouldCancel && shouldCancel())
            return result;

        const int offset = frameIndex * hopSize;
        const float* frame = audioData + offset;

        float sumSquares = 0.0f;
        for (int i = 0; i < frameSize; ++i)
            sumSquares += frame[i] * frame[i];
        const float rms = std::sqrt(sumSquares / static_cast<float>(frameSize));
        const float rmsDB = rms > 0.0f ? 20.0f * std::log10(rms) : -100.0f;

        FrameObservation observation;
        observation.rmsDB = rmsDB;

        if (rmsDB > -60.0f)
        {
            applyHannWindow(frame, frameSize, analysisWindow, windowedFrameBuffer);
            const bool useFftYin = shouldUseFftYin();
            if (useFftYin)
                computeDifferenceFft(windowedFrameBuffer, frameSize, *fft, fftBuffer, autocorrelationBuffer, prefixEnergyBuffer, differenceBuffer);
            else
                computeDirectDifference(windowedFrameBuffer, frameSize, differenceBuffer);

            if (useFftYin && shouldCompareDirectYin())
            {
                computeDirectDifference(windowedFrameBuffer, frameSize, directDifferenceBuffer);
                float maxDifference = 0.0f;
                for (size_t i = 1; i < differenceBuffer.size(); ++i)
                    maxDifference = std::max(maxDifference, std::abs(differenceBuffer[i] - directDifferenceBuffer[i]));
                juce::Logger::writeToLog("[PitchAnalyzer] FFT/direct YIN difference max=" + juce::String(maxDifference, 6)
                                         + " frame=" + juce::String(frameIndex));
            }

            computeCmndf(differenceBuffer, cmndfBuffer);
            observation = extractFrameObservation(cmndfBuffer, tauMin, tauMax, sampleRate, rmsDB, sensitivity);
        }

        observations.push_back(observation);
    }

    if (shouldCancel && shouldCancel())
        return result;

    const auto decodedFrames = decodePitchTrack(observations);
    for (size_t frameIndex = 0; frameIndex < decodedFrames.size(); ++frameIndex)
    {
        const auto& decoded = decodedFrames[frameIndex];
        PitchFrame frame;
        frame.time = static_cast<float>(static_cast<int>(frameIndex) * hopSize) / static_cast<float>(sampleRate);
        frame.frequency = decoded.voiced ? decoded.frequency : 0.0f;
        frame.midiNote = decoded.voiced ? decoded.midi : 0.0f;
        frame.confidence = clamp01(decoded.confidence);
        frame.rmsDB = observations[frameIndex].rmsDB;
        frame.voiced = decoded.voiced;
        result.frames.push_back(frame);
    }

    result.notes = segmentNotes(result.frames, hopSize, sampleRate, &result.boundaryCandidates);
    return result;
}

std::vector<PitchAnalyzer::PitchNote> PitchAnalyzer::segmentNotes(const std::vector<PitchFrame>& frames,
                                                                  int /*hopSize*/,
                                                                  double /*sampleRate*/,
                                                                  std::vector<PitchBoundaryCandidate>* boundaryCandidates)
{
    std::vector<PitchNote> notes;
    if (boundaryCandidates != nullptr)
        boundaryCandidates->clear();
    if (frames.empty())
        return notes;

    const float minNoteDuration = 0.05f;
    const float pitchJumpCandidateThreshold = 1.5f;
    const float confidenceThreshold = 0.25f;
    const float silenceThreshold = -50.0f;
    const float energyDipSplitDB = 10.0f;
    const float energyDipSplitSec = 0.030f;
    const float dropoutBridgeSec = 0.080f;
    const float hardUnvoicedGapSec = 0.090f;

    int noteStartIdx = -1;
    float noteSum = 0.0f;
    int noteCount = 0;
    int noteId = 0;
    float runningEnergySum = 0.0f;
    int energyDipRun = 0;
    int inactiveRun = 0;
    int lastVoicedIdx = -1;

    const float frameStepSec = frames.size() >= 2
        ? std::max (0.001f, frames[1].time - frames[0].time)
        : 0.01f;

    auto makeNote = [&](int startIdx, int endIdx) -> PitchNote
    {
        float sum = 0.0f;
        int count = 0;
        for (int i = startIdx; i <= endIdx && i < static_cast<int>(frames.size()); ++i)
        {
            const float midi = frames[static_cast<size_t>(i)].midiNote;
            if (midi > 0.0f)
            {
                sum += midi;
                ++count;
            }
        }

        const float avgMidi = count > 0 ? sum / static_cast<float>(count) : 0.0f;
        const float startTime = frames[static_cast<size_t>(startIdx)].time;
        const float endTime = frames[static_cast<size_t>(endIdx)].time;

        PitchNote note;
        note.id = "note_" + juce::String(noteId++);
        note.startTime = startTime;
        note.endTime = endTime;
        note.effectiveStartTime = startTime;
        note.effectiveEndTime = endTime;
        note.detectedPitch = avgMidi;
        note.correctedPitch = avgMidi;
        note.driftCorrectionAmount = 0.0f;
        note.vibratoDepth = 1.0f;
        note.vibratoRate = 0.0f;
        note.transitionIn = 0.0f;
        note.transitionOut = 0.0f;
        note.formantShift = 0.0f;
        note.gain = 0.0f;
        note.voiced = true;
        note.wordGroupId = {};
        note.entryBoundaryKind = "unknown";
        note.exitBoundaryKind = "unknown";
        note.entryBoundaryReason = {};
        note.exitBoundaryReason = {};
        note.entryBoundaryScore = 0.0f;
        note.exitBoundaryScore = 0.0f;

        for (int i = startIdx; i <= endIdx && i < static_cast<int>(frames.size()); ++i)
        {
            const float midi = frames[static_cast<size_t>(i)].midiNote;
            note.pitchDrift.push_back(midi > 0.0f ? midi - avgMidi : 0.0f);
        }

        return note;
    };

    auto isHardBoundaryFrame = [&](int idx) -> bool
    {
        if (idx < 0 || idx >= static_cast<int>(frames.size()))
            return true;

        const auto& f = frames[static_cast<size_t>(idx)];
        return ! f.voiced
            || f.midiNote <= 0.0f
            || f.confidence < confidenceThreshold * 0.8f
            || f.rmsDB <= silenceThreshold;
    };

    auto hasHardBoundaryNear = [&](int centerIdx) -> bool
    {
        const int radius = std::max(1, static_cast<int>(std::round(0.025f / frameStepSec)));
        for (int i = centerIdx - radius; i <= centerIdx + radius; ++i)
        {
            if (isHardBoundaryFrame(i))
                return true;
        }
        return false;
    };

    const int energyDipMinFrames = std::max(2, static_cast<int>(std::ceil(energyDipSplitSec / frameStepSec)));
    const int hardUnvoicedGapFrames = std::max(1, static_cast<int>(std::ceil(hardUnvoicedGapSec / frameStepSec)));

    auto resetOpenNote = [&]()
    {
        noteStartIdx = -1;
        noteSum = 0.0f;
        noteCount = 0;
        runningEnergySum = 0.0f;
        energyDipRun = 0;
        inactiveRun = 0;
        lastVoicedIdx = -1;
    };

    auto finalizeNote = [&](int endIdx)
    {
        if (noteStartIdx < 0 || noteCount == 0)
            return;

        const float startTime = frames[static_cast<size_t>(noteStartIdx)].time;
        const float endTime = frames[static_cast<size_t>(endIdx)].time;
        const float duration = endTime - startTime;

        if (duration < minNoteDuration)
            return;

        auto note = makeNote(noteStartIdx, endIdx);
        const bool hardEntry = hasHardBoundaryNear(noteStartIdx - 1);
        const bool hardExit = hasHardBoundaryNear(endIdx + 1);
        note.entryBoundaryKind = hardEntry ? "hard_word_like" : "unknown";
        note.entryBoundaryReason = hardEntry ? "voiced_region_start" : "continuous_pitch_segment_start";
        note.entryBoundaryScore = hardEntry ? 1.0f : 0.0f;
        note.exitBoundaryKind = hardExit ? "hard_word_like" : "unknown";
        note.exitBoundaryReason = hardExit ? "voiced_region_end" : "continuous_pitch_segment_end";
        note.exitBoundaryScore = hardExit ? 1.0f : 0.0f;
        notes.push_back(std::move(note));
    };

    for (int i = 0; i < static_cast<int>(frames.size()); ++i)
    {
        const auto& frame = frames[static_cast<size_t>(i)];
        const bool isVoiced = frame.voiced
            && frame.midiNote > 0.0f
            && frame.confidence >= confidenceThreshold
            && frame.rmsDB > silenceThreshold;

        if (! isVoiced)
        {
            if (noteStartIdx >= 0)
            {
                ++inactiveRun;
                if (inactiveRun >= hardUnvoicedGapFrames)
                {
                    finalizeNote(std::max(noteStartIdx, lastVoicedIdx));
                    resetOpenNote();
                }
            }
            continue;
        }

        if (noteStartIdx < 0)
        {
            noteStartIdx = i;
            noteSum = frame.midiNote;
            noteCount = 1;
            runningEnergySum = frame.rmsDB;
            energyDipRun = 0;
            inactiveRun = 0;
            lastVoicedIdx = i;
            continue;
        }

        if (inactiveRun > 0)
        {
            const float inactiveSec = static_cast<float>(inactiveRun) * frameStepSec;
            if (inactiveSec > dropoutBridgeSec)
            {
                finalizeNote(std::max(noteStartIdx, lastVoicedIdx));
                noteStartIdx = i;
                noteSum = frame.midiNote;
                noteCount = 1;
                runningEnergySum = frame.rmsDB;
                energyDipRun = 0;
                inactiveRun = 0;
                lastVoicedIdx = i;
                continue;
            }

            inactiveRun = 0;
            energyDipRun = 0;
        }

        const float avgEnergy = runningEnergySum / static_cast<float>(noteCount);
        const float energyDrop = avgEnergy - frame.rmsDB;

        if (energyDrop > energyDipSplitDB)
        {
            ++energyDipRun;
            if (energyDipRun >= energyDipMinFrames)
            {
                finalizeNote(i - energyDipRun);
                resetOpenNote();
                continue;
            }
        }
        else
        {
            energyDipRun = 0;
        }

        noteSum += frame.midiNote;
        runningEnergySum += frame.rmsDB;
        ++noteCount;
        lastVoicedIdx = i;
    }

    if (noteStartIdx >= 0)
        finalizeNote(std::max(noteStartIdx, lastVoicedIdx));

    std::vector<float> smoothedMidi(frames.size(), 0.0f);
    for (int i = 0; i < static_cast<int>(frames.size()); ++i)
    {
        std::vector<float> local;
        local.reserve(5);
        for (int k = std::max(0, i - 2); k <= std::min(static_cast<int>(frames.size()) - 1, i + 2); ++k)
        {
            const auto& f = frames[static_cast<size_t>(k)];
            if (f.voiced && f.midiNote > 0.0f && f.confidence >= confidenceThreshold && f.rmsDB > silenceThreshold)
                local.push_back(f.midiNote);
        }

        if (! local.empty())
        {
            const auto middle = local.begin() + static_cast<std::ptrdiff_t>(local.size() / 2);
            std::nth_element(local.begin(), middle, local.end());
            smoothedMidi[static_cast<size_t>(i)] = *middle;
        }
    }

    struct CornerCandidate
    {
        int frameIndex = -1;
        juce::String kind = "unknown";
        juce::String reason;
        float score = 0.0f;
        bool destructiveSplitAllowed = false;
    };

    auto noteFrameIndexForTime = [&](float time, bool preferEnd) -> int
    {
        int best = 0;
        float bestDelta = std::numeric_limits<float>::max();
        for (int i = 0; i < static_cast<int>(frames.size()); ++i)
        {
            const float delta = std::abs(frames[static_cast<size_t>(i)].time - time);
            if (delta < bestDelta)
            {
                bestDelta = delta;
                best = i;
            }
        }
        if (preferEnd)
            return std::min(best, static_cast<int>(frames.size()) - 1);
        return std::max(0, best);
    };

    auto averageRange = [&](const std::vector<float>& values, int start, int end, float fallback) -> float
    {
        double sum = 0.0;
        int count = 0;
        for (int i = std::max(0, start); i <= std::min(static_cast<int>(values.size()) - 1, end); ++i)
        {
            const float value = values[static_cast<size_t>(i)];
            if (value > 0.0f)
            {
                sum += value;
                ++count;
            }
        }
        return count > 0 ? static_cast<float>(sum / static_cast<double>(count)) : fallback;
    };

    auto averageEnergy = [&](int start, int end) -> float
    {
        double sum = 0.0;
        int count = 0;
        for (int i = std::max(0, start); i <= std::min(static_cast<int>(frames.size()) - 1, end); ++i)
        {
            sum += frames[static_cast<size_t>(i)].rmsDB;
            ++count;
        }
        return count > 0 ? static_cast<float>(sum / static_cast<double>(count)) : -100.0f;
    };

    auto averageConfidence = [&](int start, int end) -> float
    {
        double sum = 0.0;
        int count = 0;
        for (int i = std::max(0, start); i <= std::min(static_cast<int>(frames.size()) - 1, end); ++i)
        {
            sum += frames[static_cast<size_t>(i)].confidence;
            ++count;
        }
        return count > 0 ? static_cast<float>(sum / static_cast<double>(count)) : 0.0f;
    };

    auto hasNearbyUnvoiced = [&](int center, int radiusFrames) -> bool
    {
        for (int i = std::max(0, center - radiusFrames); i <= std::min(static_cast<int>(frames.size()) - 1, center + radiusFrames); ++i)
        {
            const auto& f = frames[static_cast<size_t>(i)];
            if (! f.voiced || f.confidence < confidenceThreshold || f.rmsDB <= silenceThreshold || f.midiNote <= 0.0f)
                return true;
        }
        return false;
    };

    auto isVibratoLikeCorner = [&](int center, int noteStartFrame, int noteEndFrame) -> bool
    {
        const int radius = std::max(4, static_cast<int>(std::round(0.125f / frameStepSec)));
        const int start = std::max(noteStartFrame, center - radius);
        const int end = std::min(noteEndFrame, center + radius);
        if (end - start < 8)
            return false;

        int reversals = 0;
        int lastSign = 0;
        float minMidi = std::numeric_limits<float>::max();
        float maxMidi = 0.0f;
        float minEnergy = std::numeric_limits<float>::max();
        float maxEnergy = -100.0f;

        for (int i = start + 1; i <= end; ++i)
        {
            const float prev = smoothedMidi[static_cast<size_t>(i - 1)];
            const float here = smoothedMidi[static_cast<size_t>(i)];
            if (prev <= 0.0f || here <= 0.0f)
                continue;

            minMidi = std::min(minMidi, here);
            maxMidi = std::max(maxMidi, here);
            minEnergy = std::min(minEnergy, frames[static_cast<size_t>(i)].rmsDB);
            maxEnergy = std::max(maxEnergy, frames[static_cast<size_t>(i)].rmsDB);

            const float slope = (here - prev) / frameStepSec;
            const int sign = slope > 2.0f ? 1 : (slope < -2.0f ? -1 : 0);
            if (sign == 0)
                continue;
            if (lastSign != 0 && sign != lastSign)
                ++reversals;
            lastSign = sign;
        }

        const float pitchRange = maxMidi > minMidi ? maxMidi - minMidi : 0.0f;
        const float energyRange = maxEnergy > minEnergy ? maxEnergy - minEnergy : 0.0f;
        return reversals >= 3 && pitchRange <= 1.2f && energyRange <= 4.0f;
    };

    auto findCornerCandidatesForNote = [&](const PitchNote& note) -> std::vector<CornerCandidate>
    {
        std::vector<CornerCandidate> candidates;
        const int startFrame = noteFrameIndexForTime(note.startTime, false);
        const int endFrame = noteFrameIndexForTime(note.endTime, true);
        const int minEdgeFrames = std::max(2, static_cast<int>(std::round(0.035f / frameStepSec)));
        const int minSplitSpacingFrames = std::max(4, static_cast<int>(std::round(0.080f / frameStepSec)));
        const int slopeFrames = std::max(3, static_cast<int>(std::round(0.040f / frameStepSec)));
        const int cueFrames = std::max(2, static_cast<int>(std::round(0.020f / frameStepSec)));
        int lastAccepted = -minSplitSpacingFrames * 2;

        for (int i = startFrame + minEdgeFrames; i <= endFrame - minEdgeFrames; ++i)
        {
            if (i - lastAccepted < minSplitSpacingFrames)
                continue;

            const int leftIndex = std::max(startFrame, i - slopeFrames);
            const int rightIndex = std::min(endFrame, i + slopeFrames);
            const float leftMidi = smoothedMidi[static_cast<size_t>(leftIndex)];
            const float centerMidi = smoothedMidi[static_cast<size_t>(i)];
            const float rightMidi = smoothedMidi[static_cast<size_t>(rightIndex)];
            if (leftMidi <= 0.0f || centerMidi <= 0.0f || rightMidi <= 0.0f)
                continue;

            const float leftSlope = (centerMidi - leftMidi) / std::max(frameStepSec, frames[static_cast<size_t>(i)].time - frames[static_cast<size_t>(leftIndex)].time);
            const float rightSlope = (rightMidi - centerMidi) / std::max(frameStepSec, frames[static_cast<size_t>(rightIndex)].time - frames[static_cast<size_t>(i)].time);
            const bool directionFlip = (leftSlope > 5.0f && rightSlope < -5.0f)
                || (leftSlope < -5.0f && rightSlope > 5.0f);
            if (! directionFlip)
                continue;

            const float slopeDelta = std::abs(leftSlope - rightSlope);
            const float leftAvg = averageRange(smoothedMidi, leftIndex, i - 1, leftMidi);
            const float rightAvg = averageRange(smoothedMidi, i + 1, rightIndex, rightMidi);
            const float cornerProminence = std::min(std::abs(centerMidi - leftAvg), std::abs(centerMidi - rightAvg));
            const float sidePitchChange = std::abs(rightAvg - leftAvg);
            if (slopeDelta < 18.0f || cornerProminence < 0.35f)
                continue;

            const float leftEnergy = averageEnergy(leftIndex, i - cueFrames);
            const float rightEnergy = averageEnergy(i + cueFrames, rightIndex);
            const float centerEnergy = averageEnergy(i - cueFrames, i + cueFrames);
            const float energyDip = std::max(leftEnergy, rightEnergy) - centerEnergy;
            const float leftConfidence = averageConfidence(leftIndex, i - cueFrames);
            const float rightConfidence = averageConfidence(i + cueFrames, rightIndex);
            const float centerConfidence = averageConfidence(i - cueFrames, i + cueFrames);
            const float confidenceDip = std::max(leftConfidence, rightConfidence) - centerConfidence;
            const bool nearbyUnvoiced = hasNearbyUnvoiced(i, cueFrames);
            const bool strongPitchCue = cornerProminence >= 0.75f || sidePitchChange >= 0.55f;
            const bool hasCompanionCue = energyDip >= 3.0f || confidenceDip >= 0.12f || nearbyUnvoiced || strongPitchCue;

            if (! hasCompanionCue)
                continue;
            if (isVibratoLikeCorner(i, startFrame, endFrame))
            {
                CornerCandidate candidate;
                candidate.frameIndex = i;
                candidate.kind = "internal_vibrato";
                candidate.reason = "pitch_corner_vibrato_suppressed";
                candidate.score = juce::jlimit(0.0f, 1.0f, 0.18f + std::min(0.42f, slopeDelta / 140.0f));
                candidate.destructiveSplitAllowed = false;
                candidates.push_back(candidate);
                lastAccepted = i;
                continue;
            }

            CornerCandidate candidate;
            candidate.frameIndex = i;
            candidate.score = juce::jlimit(0.0f, 1.0f,
                0.34f * std::min(1.0f, slopeDelta / 42.0f)
                + 0.28f * std::min(1.0f, cornerProminence / 1.2f)
                + 0.18f * std::min(1.0f, energyDip / 8.0f)
                + 0.12f * std::min(1.0f, confidenceDip / 0.35f)
                + (nearbyUnvoiced ? 0.08f : 0.0f));

            if (energyDip >= 3.0f || confidenceDip >= 0.18f || nearbyUnvoiced)
            {
                candidate.kind = "hard_word_like";
                candidate.reason = "pitch_corner_with_energy_or_confidence_cue";
                candidate.destructiveSplitAllowed = candidate.score >= 0.50f
                    && (energyDip >= 6.0f || confidenceDip >= 0.18f || nearbyUnvoiced);
            }
            else
            {
                candidate.kind = "soft_legato";
                candidate.reason = "pitch_corner_continuous_voiced";
                candidate.destructiveSplitAllowed = false;
            }

            candidates.push_back(candidate);
            lastAccepted = i;
        }

        return candidates;
    };

    auto findPitchDeviationCandidatesForNote = [&](const PitchNote& note) -> std::vector<CornerCandidate>
    {
        std::vector<CornerCandidate> candidates;
        const int startFrame = noteFrameIndexForTime(note.startTime, false);
        const int endFrame = noteFrameIndexForTime(note.endTime, true);
        const int minEdgeFrames = std::max(2, static_cast<int>(std::round(0.035f / frameStepSec)));
        const int minRunFrames = std::max(4, static_cast<int>(std::round(0.050f / frameStepSec)));
        const int minSpacingFrames = std::max(6, static_cast<int>(std::round(0.120f / frameStepSec)));
        const int noteSpan = endFrame - startFrame;
        if (noteSpan < minEdgeFrames * 2 + minRunFrames)
            return candidates;

        float dynamicAverage = 0.0f;
        int runStart = -1;
        int runLength = 0;
        float runMaxDeviation = 0.0f;
        float runArea = 0.0f;
        int lastAccepted = -minSpacingFrames * 2;

        auto finishRun = [&](int runEnd)
        {
            if (runStart < 0 || runLength < minRunFrames || runStart - lastAccepted < minSpacingFrames)
                return;
            if (runStart <= startFrame + minEdgeFrames || runEnd >= endFrame - minEdgeFrames)
                return;

            const int center = runStart + std::max(0, (runEnd - runStart) / 2);
            const bool vibratoLike = isVibratoLikeCorner(center, startFrame, endFrame);
            CornerCandidate candidate;
            candidate.frameIndex = center;
            candidate.kind = vibratoLike ? "internal_vibrato" : "internal_bend";
            candidate.reason = vibratoLike ? "pitch_hysteresis_vibrato_suppressed" : "pitch_hysteresis_deviation_internal_bend";
            candidate.score = juce::jlimit(0.0f, 1.0f,
                0.35f * std::min(1.0f, runMaxDeviation / 3.0f)
                + 0.35f * std::min(1.0f, static_cast<float>(runLength) * frameStepSec / 0.180f)
                + 0.30f * std::min(1.0f, runArea / 10.0f));
            candidate.destructiveSplitAllowed = false;
            candidates.push_back(candidate);
            lastAccepted = center;
        };

        for (int i = startFrame; i <= endFrame; ++i)
        {
            const float midi = smoothedMidi[static_cast<size_t>(i)];
            const auto& frame = frames[static_cast<size_t>(i)];
            if (midi <= 0.0f || ! frame.voiced || frame.confidence < confidenceThreshold || frame.rmsDB <= silenceThreshold)
            {
                finishRun(i - 1);
                runStart = -1;
                runLength = 0;
                runMaxDeviation = 0.0f;
                runArea = 0.0f;
                continue;
            }

            if (dynamicAverage <= 0.0f)
            {
                dynamicAverage = midi;
                continue;
            }

            const float deviation = std::abs(midi - dynamicAverage);
            if (deviation > pitchJumpCandidateThreshold)
            {
                if (runStart < 0)
                {
                    runStart = i;
                    runLength = 0;
                    runMaxDeviation = 0.0f;
                    runArea = 0.0f;
                }
                ++runLength;
                runMaxDeviation = std::max(runMaxDeviation, deviation);
                runArea += std::max(0.0f, deviation - pitchJumpCandidateThreshold);
            }
            else
            {
                finishRun(i - 1);
                runStart = -1;
                runLength = 0;
                runMaxDeviation = 0.0f;
                runArea = 0.0f;
                dynamicAverage = 0.985f * dynamicAverage + 0.015f * midi;
            }
        }

        finishRun(endFrame);
        return candidates;
    };

    const bool applyCornerSplits = juce::SystemStats::getEnvironmentVariable(
        "OPENSTUDIO_ANALYZER_APPLY_CORNER_SPLITS", {}).trim() == "1";

    std::vector<PitchNote> cornerSplitNotes;
    cornerSplitNotes.reserve(notes.size());
    for (const auto& note : notes)
    {
        auto candidates = findPitchDeviationCandidatesForNote(note);
        auto cornerCandidates = findCornerCandidatesForNote(note);
        candidates.insert(candidates.end(), cornerCandidates.begin(), cornerCandidates.end());
        std::sort(candidates.begin(), candidates.end(), [](const CornerCandidate& a, const CornerCandidate& b)
        {
            return a.frameIndex < b.frameIndex;
        });

        if (boundaryCandidates != nullptr)
        {
            for (const auto& candidate : candidates)
            {
                PitchBoundaryCandidate publicCandidate;
                publicCandidate.id = "boundary_" + juce::String(static_cast<int>(boundaryCandidates->size()));
                publicCandidate.sourceNoteId = note.id;
                publicCandidate.time = frames[static_cast<size_t>(candidate.frameIndex)].time;
                publicCandidate.kind = candidate.kind;
                publicCandidate.reason = candidate.reason;
                publicCandidate.score = candidate.score;
                publicCandidate.destructiveSplitAllowed = candidate.destructiveSplitAllowed
                    && (candidate.kind == "hard_word_like" || applyCornerSplits);
                boundaryCandidates->push_back(std::move(publicCandidate));
            }
        }

        const bool hasDefaultAcousticSplit = std::any_of(candidates.begin(), candidates.end(), [](const CornerCandidate& candidate)
        {
            return candidate.kind == "hard_word_like" && candidate.destructiveSplitAllowed;
        });

        if (! applyCornerSplits && ! hasDefaultAcousticSplit)
        {
            cornerSplitNotes.push_back(note);
            continue;
        }

        if (candidates.empty())
        {
            cornerSplitNotes.push_back(note);
            continue;
        }

        int segmentStart = noteFrameIndexForTime(note.startTime, false);
        const int noteEnd = noteFrameIndexForTime(note.endTime, true);
        juce::String entryKind = note.entryBoundaryKind;
        juce::String entryReason = note.entryBoundaryReason;
        float entryScore = note.entryBoundaryScore;

        for (const auto& candidate : candidates)
        {
            const bool shouldSplit = candidate.destructiveSplitAllowed
                && (candidate.kind == "hard_word_like" || applyCornerSplits);
            if (! shouldSplit)
                continue;

            const int leftEnd = candidate.frameIndex - 1;
            const float leftDuration = frames[static_cast<size_t>(leftEnd)].time - frames[static_cast<size_t>(segmentStart)].time;
            const float rightDuration = frames[static_cast<size_t>(noteEnd)].time - frames[static_cast<size_t>(candidate.frameIndex)].time;
            if (leftDuration < minNoteDuration || rightDuration < minNoteDuration)
                continue;

            auto left = makeNote(segmentStart, leftEnd);
            left.entryBoundaryKind = entryKind;
            left.entryBoundaryReason = entryReason;
            left.entryBoundaryScore = entryScore;
            left.exitBoundaryKind = candidate.kind;
            left.exitBoundaryReason = candidate.reason;
            left.exitBoundaryScore = candidate.score;
            cornerSplitNotes.push_back(std::move(left));

            segmentStart = candidate.frameIndex;
            entryKind = candidate.kind;
            entryReason = candidate.reason;
            entryScore = candidate.score;
        }

        auto tail = makeNote(segmentStart, noteEnd);
        tail.entryBoundaryKind = entryKind;
        tail.entryBoundaryReason = entryReason;
        tail.entryBoundaryScore = entryScore;
        tail.exitBoundaryKind = note.exitBoundaryKind;
        tail.exitBoundaryReason = note.exitBoundaryReason;
        tail.exitBoundaryScore = note.exitBoundaryScore;
        cornerSplitNotes.push_back(std::move(tail));
    }

    notes = std::move(cornerSplitNotes);

    const float mergeGapSec = 0.04f;
    const float mergePitchSem = 1.0f;
    const float mergeEnergyDipDB = 8.0f;

    bool merged = true;
    while (merged)
    {
        merged = false;
        for (int i = 0; i + 1 < static_cast<int>(notes.size()); ++i)
        {
            auto& a = notes[static_cast<size_t>(i)];
            auto& b = notes[static_cast<size_t>(i + 1)];
            const float gap = b.startTime - a.endTime;
            const float pitchDiff = std::abs(a.detectedPitch - b.detectedPitch);
            const bool boundaryProtected = a.exitBoundaryKind == "hard_word_like"
                && b.entryBoundaryKind == "hard_word_like"
                && a.exitBoundaryScore >= 0.25f
                && b.entryBoundaryScore >= 0.25f;

            if (gap < 0.0f || gap >= mergeGapSec || pitchDiff >= mergePitchSem || boundaryProtected)
                continue;

            bool hasEnergyDip = false;
            for (size_t frameIndex = 0; frameIndex < frames.size(); ++frameIndex)
            {
                if (frames[frameIndex].time < a.endTime || frames[frameIndex].time > b.startTime)
                    continue;

                float leftEnergy = -60.0f;
                float rightEnergy = -60.0f;
                if (frameIndex > 0)
                    leftEnergy = frames[frameIndex - 1].rmsDB;
                if (frameIndex < frames.size())
                    rightEnergy = frames[frameIndex].rmsDB;
                const float referenceEnergy = std::max(leftEnergy, rightEnergy);

                if ((referenceEnergy - frames[frameIndex].rmsDB) > mergeEnergyDipDB)
                {
                    hasEnergyDip = true;
                    break;
                }
            }

            if (hasEnergyDip)
                continue;

            const float aDuration = a.endTime - a.startTime;
            const float bDuration = b.endTime - b.startTime;
            const float totalDuration = aDuration + bDuration;
            const float newPitch = totalDuration > 0.0f
                ? (a.detectedPitch * aDuration + b.detectedPitch * bDuration) / totalDuration
                : a.detectedPitch;

            a.endTime = b.endTime;
            a.effectiveEndTime = b.effectiveEndTime;
            a.detectedPitch = newPitch;
            a.correctedPitch = newPitch;
            a.exitBoundaryKind = b.exitBoundaryKind;
            a.exitBoundaryReason = b.exitBoundaryReason;
            a.exitBoundaryScore = b.exitBoundaryScore;
            a.pitchDrift.insert(a.pitchDrift.end(), b.pitchDrift.begin(), b.pitchDrift.end());

            notes.erase(notes.begin() + i + 1);
            merged = true;
            break;
        }
    }

    int groupId = 0;
    for (int i = 0; i < static_cast<int>(notes.size()); ++i)
    {
        auto& note = notes[static_cast<size_t>(i)];
        note.id = "note_" + juce::String(i);

        bool startsNewGroup = i == 0;
        if (i > 0)
        {
            const auto& previous = notes[static_cast<size_t>(i - 1)];
            const float gap = note.startTime - previous.endTime;
            const float pitchDiff = std::abs(note.detectedPitch - previous.detectedPitch);
            const bool hardBoundary = previous.exitBoundaryKind == "hard_word_like"
                && note.entryBoundaryKind == "hard_word_like"
                && std::max(previous.exitBoundaryScore, note.entryBoundaryScore) >= 0.50f;
            startsNewGroup = gap > 0.04f || hardBoundary || pitchDiff > 1.0f;
        }

        if (startsNewGroup && i > 0)
            ++groupId;

        note.wordGroupId = "word_" + juce::String(groupId);
    }

    if (boundaryCandidates != nullptr)
    {
        for (auto& candidate : *boundaryCandidates)
        {
            for (const auto& note : notes)
            {
                if (candidate.time >= note.startTime && candidate.time <= note.endTime)
                {
                    candidate.sourceNoteId = note.id;
                    break;
                }
            }
        }
    }

    return notes;
}

juce::var PitchAnalyzer::resultToJSON(const AnalysisResult& result)
{
    juce::DynamicObject::Ptr root = new juce::DynamicObject();
    root->setProperty("clipId", result.clipId);
    root->setProperty("sampleRate", result.sampleRate);
    root->setProperty("hopSize", result.hopSize);

    juce::Array<juce::var> frameTimes, frameMidi, frameConf, frameRms, frameVoiced;
    frameTimes.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameMidi.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameConf.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameRms.ensureStorageAllocated(static_cast<int>(result.frames.size()));
    frameVoiced.ensureStorageAllocated(static_cast<int>(result.frames.size()));

    for (const auto& frame : result.frames)
    {
        frameTimes.add(static_cast<double>(frame.time));
        frameMidi.add(static_cast<double>(frame.midiNote));
        frameConf.add(static_cast<double>(frame.confidence));
        frameRms.add(static_cast<double>(frame.rmsDB));
        frameVoiced.add(frame.voiced);
    }

    juce::DynamicObject::Ptr framesObject = new juce::DynamicObject();
    framesObject->setProperty("times", frameTimes);
    framesObject->setProperty("midi", frameMidi);
    framesObject->setProperty("confidence", frameConf);
    framesObject->setProperty("rms", frameRms);
    framesObject->setProperty("voiced", frameVoiced);
    root->setProperty("frames", juce::var(framesObject.get()));

    juce::Array<juce::var> notesList;
    for (const auto& note : result.notes)
    {
        juce::DynamicObject::Ptr noteObject = new juce::DynamicObject();
        noteObject->setProperty("id", note.id);
        noteObject->setProperty("startTime", static_cast<double>(note.startTime));
        noteObject->setProperty("endTime", static_cast<double>(note.endTime));
        noteObject->setProperty("effectiveStartTime", static_cast<double>(note.effectiveStartTime));
        noteObject->setProperty("effectiveEndTime", static_cast<double>(note.effectiveEndTime));
        noteObject->setProperty("detectedPitch", static_cast<double>(note.detectedPitch));
        noteObject->setProperty("correctedPitch", static_cast<double>(note.correctedPitch));
        noteObject->setProperty("driftCorrectionAmount", static_cast<double>(note.driftCorrectionAmount));
        noteObject->setProperty("vibratoDepth", static_cast<double>(note.vibratoDepth));
        noteObject->setProperty("vibratoRate", static_cast<double>(note.vibratoRate));
        noteObject->setProperty("transitionIn", static_cast<double>(note.transitionIn));
        noteObject->setProperty("transitionOut", static_cast<double>(note.transitionOut));
        noteObject->setProperty("formantShift", static_cast<double>(note.formantShift));
        noteObject->setProperty("gain", static_cast<double>(note.gain));
        noteObject->setProperty("voiced", note.voiced);
        noteObject->setProperty("wordGroupId", note.wordGroupId.isEmpty() ? note.id : note.wordGroupId);
        noteObject->setProperty("entryBoundaryKind", note.entryBoundaryKind.isEmpty() ? "unknown" : note.entryBoundaryKind);
        noteObject->setProperty("exitBoundaryKind", note.exitBoundaryKind.isEmpty() ? "unknown" : note.exitBoundaryKind);
        noteObject->setProperty("entryBoundaryReason", note.entryBoundaryReason);
        noteObject->setProperty("exitBoundaryReason", note.exitBoundaryReason);
        noteObject->setProperty("entryBoundaryScore", static_cast<double>(note.entryBoundaryScore));
        noteObject->setProperty("exitBoundaryScore", static_cast<double>(note.exitBoundaryScore));

        juce::Array<juce::var> drift;
        const int maxDriftPoints = 50;
        const int driftSize = static_cast<int>(note.pitchDrift.size());
        if (driftSize <= maxDriftPoints)
        {
            for (const float value : note.pitchDrift)
                drift.add(static_cast<double>(value));
        }
        else
        {
            const float step = static_cast<float>(driftSize) / static_cast<float>(maxDriftPoints);
            for (int driftIndex = 0; driftIndex < maxDriftPoints; ++driftIndex)
            {
                const int sourceIndex = static_cast<int>(static_cast<float>(driftIndex) * step);
                drift.add(static_cast<double>(note.pitchDrift[static_cast<size_t>(sourceIndex)]));
            }
        }
        noteObject->setProperty("pitchDrift", drift);

        notesList.add(juce::var(noteObject.get()));
    }
    root->setProperty("notes", notesList);

    juce::Array<juce::var> boundaryList;
    for (const auto& candidate : result.boundaryCandidates)
    {
        juce::DynamicObject::Ptr candidateObject = new juce::DynamicObject();
        candidateObject->setProperty("id", candidate.id);
        candidateObject->setProperty("sourceNoteId", candidate.sourceNoteId);
        candidateObject->setProperty("time", static_cast<double>(candidate.time));
        candidateObject->setProperty("kind", candidate.kind.isEmpty() ? "unknown" : candidate.kind);
        candidateObject->setProperty("reason", candidate.reason);
        candidateObject->setProperty("score", static_cast<double>(candidate.score));
        candidateObject->setProperty("destructiveSplitAllowed", candidate.destructiveSplitAllowed);
        boundaryList.add(juce::var(candidateObject.get()));
    }
    root->setProperty("boundaryCandidates", boundaryList);

    return juce::var(root.get());
}

std::vector<PitchAnalyzer::PitchNote> PitchAnalyzer::notesFromJSON(const juce::var& json)
{
    std::vector<PitchNote> notes;

    if (auto* array = json.getArray())
    {
        for (const auto& item : *array)
        {
            if (auto* object = item.getDynamicObject())
            {
                PitchNote note;
                note.id = object->getProperty("id").toString();
                note.startTime = static_cast<float>(static_cast<double>(object->getProperty("startTime")));
                note.endTime = static_cast<float>(static_cast<double>(object->getProperty("endTime")));
                note.effectiveStartTime = object->hasProperty("effectiveStartTime")
                    ? static_cast<float>(static_cast<double>(object->getProperty("effectiveStartTime")))
                    : note.startTime;
                note.effectiveEndTime = object->hasProperty("effectiveEndTime")
                    ? static_cast<float>(static_cast<double>(object->getProperty("effectiveEndTime")))
                    : note.endTime;
                note.detectedPitch = static_cast<float>(static_cast<double>(object->getProperty("detectedPitch")));
                note.correctedPitch = static_cast<float>(static_cast<double>(object->getProperty("correctedPitch")));
                note.driftCorrectionAmount = static_cast<float>(static_cast<double>(object->getProperty("driftCorrectionAmount")));
                note.vibratoDepth = static_cast<float>(static_cast<double>(object->getProperty("vibratoDepth")));
                note.vibratoRate = static_cast<float>(static_cast<double>(object->getProperty("vibratoRate")));
                note.transitionIn = static_cast<float>(static_cast<double>(object->getProperty("transitionIn")));
                note.transitionOut = static_cast<float>(static_cast<double>(object->getProperty("transitionOut")));
                note.formantShift = static_cast<float>(static_cast<double>(object->getProperty("formantShift")));
                note.gain = static_cast<float>(static_cast<double>(object->getProperty("gain")));
                note.voiced = object->hasProperty("voiced") ? static_cast<bool>(object->getProperty("voiced")) : true;
                note.wordGroupId = object->hasProperty("wordGroupId")
                    ? object->getProperty("wordGroupId").toString()
                    : note.id;
                note.entryBoundaryKind = object->hasProperty("entryBoundaryKind")
                    ? object->getProperty("entryBoundaryKind").toString()
                    : "unknown";
                note.exitBoundaryKind = object->hasProperty("exitBoundaryKind")
                    ? object->getProperty("exitBoundaryKind").toString()
                    : "unknown";
                note.entryBoundaryReason = object->hasProperty("entryBoundaryReason")
                    ? object->getProperty("entryBoundaryReason").toString()
                    : juce::String();
                note.exitBoundaryReason = object->hasProperty("exitBoundaryReason")
                    ? object->getProperty("exitBoundaryReason").toString()
                    : juce::String();
                note.entryBoundaryScore = object->hasProperty("entryBoundaryScore")
                    ? static_cast<float>(static_cast<double>(object->getProperty("entryBoundaryScore")))
                    : 0.0f;
                note.exitBoundaryScore = object->hasProperty("exitBoundaryScore")
                    ? static_cast<float>(static_cast<double>(object->getProperty("exitBoundaryScore")))
                    : 0.0f;

                if (auto* driftArray = object->getProperty("pitchDrift").getArray())
                {
                    for (const auto& value : *driftArray)
                        note.pitchDrift.push_back(static_cast<float>(static_cast<double>(value)));
                }

                notes.push_back(std::move(note));
            }
        }
    }

    return notes;
}

std::vector<PitchAnalyzer::PitchFrame> PitchAnalyzer::framesFromJSON(const juce::var& json)
{
    std::vector<PitchFrame> frames;

    if (auto* object = json.getDynamicObject())
    {
        const auto timesVar = object->getProperty("times");
        const auto midiVar = object->getProperty("midi");
        const auto confidenceVar = object->getProperty("confidence");
        const auto rmsVar = object->getProperty("rms");
        const auto voicedVar = object->getProperty("voiced");

        auto* timesArray = timesVar.getArray();
        auto* midiArray = midiVar.getArray();
        auto* confidenceArray = confidenceVar.getArray();
        auto* rmsArray = rmsVar.getArray();
        auto* voicedArray = voicedVar.getArray();

        if (timesArray && midiArray && confidenceArray && rmsArray)
        {
            const int frameCount = std::min({ timesArray->size(), midiArray->size(), confidenceArray->size(), rmsArray->size() });
            frames.reserve(static_cast<size_t>(frameCount));

            for (int index = 0; index < frameCount; ++index)
            {
                PitchFrame frame;
                frame.time = static_cast<float>(static_cast<double>((*timesArray)[index]));
                frame.midiNote = static_cast<float>(static_cast<double>((*midiArray)[index]));
                frame.frequency = frame.midiNote > 0.0f
                    ? 440.0f * std::pow(2.0f, (frame.midiNote - 69.0f) / 12.0f)
                    : 0.0f;
                frame.confidence = static_cast<float>(static_cast<double>((*confidenceArray)[index]));
                frame.rmsDB = static_cast<float>(static_cast<double>((*rmsArray)[index]));
                frame.voiced = voicedArray && index < voicedArray->size()
                    ? static_cast<bool>((*voicedArray)[index])
                    : (frame.midiNote > 0.0f && frame.confidence >= 0.25f);
                frames.push_back(frame);
            }
        }
    }

    return frames;
}
