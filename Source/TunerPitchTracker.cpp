#include "TunerPitchTracker.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace
{
constexpr double kMinimumFrequencyHz = 27.5;
constexpr double kMaximumFrequencyHz = 1320.0;
constexpr double kTargetAnalysisRate = 12000.0;
constexpr int kAnalysisFrameSize = 2048;
constexpr int kAnalysisHopSize = 384;
constexpr int kAcquisitionFrames = 3;
constexpr int kMaximumLagStorage = 1024;
constexpr int kPitchMedianSize = 5;
constexpr float kSignalThresholdDb = -88.0f;
constexpr float kMinimumClarity = 0.68f;
constexpr double kAverageTimeConstantSeconds = 0.16;
constexpr double kSteadyHoldSeconds = 0.45;
constexpr double kReleaseSeconds = 1.20;
constexpr double kTransitionThresholdCents = 80.0;
constexpr double kCandidateConsistencyCents = 32.0;
constexpr double kMaximumWorkerQueueSeconds = 0.25;
constexpr double kFirstAcquisitionWeight = 0.35;

float safeDecibels(double meanSquare) noexcept
{
    if (! std::isfinite(meanSquare) || meanSquare <= 1.0e-18)
        return -120.0f;

    return static_cast<float>(
        juce::jlimit(-120.0, 6.0, 10.0 * std::log10(meanSquare)));
}

double frequencyToAbsoluteCents(double frequencyHz) noexcept
{
    if (! std::isfinite(frequencyHz) || frequencyHz <= 0.0)
        return 0.0;

    return 6900.0 + 1200.0 * std::log2(frequencyHz / 440.0);
}

float absoluteCentsToFrequency(double absoluteCents) noexcept
{
    return static_cast<float>(
        440.0 * std::exp2((absoluteCents - 6900.0) / 1200.0));
}

int roundedMidiNote(double absoluteCents) noexcept
{
    return juce::jlimit(
        0, 127, juce::roundToInt(absoluteCents / 100.0));
}

double confidenceInfluence(float confidence) noexcept
{
    const double normalized = juce::jlimit(
        0.0,
        1.0,
        (static_cast<double>(confidence)
            - static_cast<double>(kMinimumClarity))
            / (1.0 - static_cast<double>(kMinimumClarity)));
    return 0.20 + 0.80 * normalized * normalized;
}
}

class TunerPitchTracker::AnalysisCore
{
public:
    explicit AnalysisCore(double newSourceSampleRate)
    {
        prepare(newSourceSampleRate);
    }

    void prepare(double newSourceSampleRate) noexcept
    {
        sourceSampleRate = std::isfinite(newSourceSampleRate)
                && newSourceSampleRate >= 8000.0
            ? newSourceSampleRate
            : 48000.0;

        decimationFactor = juce::jlimit(
            1,
            64,
            juce::roundToInt(sourceSampleRate / kTargetAnalysisRate));
        analysisSampleRate =
            sourceSampleRate / static_cast<double>(decimationFactor);

        const double lowPassCutoffHz = juce::jmin(
            3200.0, analysisSampleRate * 0.38);
        lowPassAlpha = static_cast<float>(
            1.0 - std::exp(
                -juce::MathConstants<double>::twoPi
                * lowPassCutoffHz / sourceSampleRate));
        highPassCoefficient = static_cast<float>(
            std::exp(
                -juce::MathConstants<double>::twoPi
                * 10.0 / sourceSampleRate));

        reset();
    }

    void reset() noexcept
    {
        analysisRing.fill(0.0f);
        analysisFrame.fill(0.0f);
        nsdf.fill(0.0f);
        energyPrefix.fill(0.0);
        lowPassStates.fill(0.0f);
        pitchHistory.fill(0.0);

        ringWriteIndex = 0;
        validRingSamples = 0;
        samplesSinceAnalysis = 0;
        decimationPhase = 0;
        inputHighPassX1 = 0.0f;
        inputHighPassY1 = 0.0f;
        levelSquareSum = 0.0;
        levelSampleCount = 0;
        totalAnalysisSamples = 0;
        lastAcceptedAnalysisSample = 0;
        hasAcceptedPitch = false;
        acquisitionCount = 0;
        acquisitionCandidateCents = 0.0;
        acquisitionCandidateWeight = 0.0;
        transitionCount = 0;
        transitionCandidateCents = 0.0;
        pitchHistoryCount = 0;
        pitchHistoryWriteIndex = 0;
        averagedAbsoluteCents = 0.0;
        instantaneousAbsoluteCents = 0.0;
        stableMidiNote = -1;
        pendingMidiNote = -1;
        pendingMidiCount = 0;
        lastConfidence = 0.0f;
        snapshot = {};
    }

    void process(const float* samples, int numSamples) noexcept
    {
        if (samples == nullptr || numSamples <= 0)
            return;

        for (int sampleIndex = 0; sampleIndex < numSamples; ++sampleIndex)
        {
            float input = samples[sampleIndex];
            if (! std::isfinite(input))
                input = 0.0f;

            const float highPassed =
                input - inputHighPassX1
                + highPassCoefficient * inputHighPassY1;
            inputHighPassX1 = input;
            inputHighPassY1 = highPassed;

            levelSquareSum +=
                static_cast<double>(input)
                * static_cast<double>(input);
            ++levelSampleCount;

            float filtered = highPassed;
            for (auto& filterState : lowPassStates)
            {
                filterState += lowPassAlpha * (filtered - filterState);
                filtered = filterState;
            }

            ++decimationPhase;
            if (decimationPhase < decimationFactor)
                continue;

            decimationPhase = 0;
            analysisRing[static_cast<size_t>(ringWriteIndex)] = filtered;
            ringWriteIndex =
                (ringWriteIndex + 1) % kAnalysisFrameSize;
            validRingSamples = juce::jmin(
                kAnalysisFrameSize, validRingSamples + 1);
            ++samplesSinceAnalysis;
            ++totalAnalysisSamples;

            if (samplesSinceAnalysis >= kAnalysisHopSize)
            {
                samplesSinceAnalysis -= kAnalysisHopSize;
                analyseCurrentFrame();
            }
        }
    }

    [[nodiscard]] Snapshot getSnapshot() const noexcept
    {
        return snapshot;
    }

private:
    struct PitchCandidate
    {
        bool valid = false;
        float frequencyHz = 0.0f;
        float clarity = 0.0f;
    };

    struct Peak
    {
        int lag = 0;
        float clarity = 0.0f;
    };

    PitchCandidate detectPitch() noexcept
    {
        PitchCandidate result;

        for (int sample = 0; sample < kAnalysisFrameSize; ++sample)
        {
            const int sourceIndex =
                (ringWriteIndex + sample) % kAnalysisFrameSize;
            analysisFrame[static_cast<size_t>(sample)] =
                analysisRing[static_cast<size_t>(sourceIndex)];
        }

        energyPrefix[0] = 0.0;
        for (int sample = 0; sample < kAnalysisFrameSize; ++sample)
        {
            const double value =
                static_cast<double>(
                    analysisFrame[static_cast<size_t>(sample)]);
            energyPrefix[static_cast<size_t>(sample + 1)] =
                energyPrefix[static_cast<size_t>(sample)]
                + value * value;
        }

        const int minimumLag = juce::jmax(
            2,
            static_cast<int>(
                std::floor(
                    analysisSampleRate / kMaximumFrequencyHz)));
        const int maximumLag = juce::jlimit(
            minimumLag + 2,
            kMaximumLagStorage - 2,
            static_cast<int>(
                std::ceil(
                    analysisSampleRate / kMinimumFrequencyHz)));

        nsdf.fill(0.0f);
        for (int lag = 2; lag <= maximumLag + 1; ++lag)
        {
            const int comparedSamples = kAnalysisFrameSize - lag;
            double cross0 = 0.0;
            double cross1 = 0.0;
            double cross2 = 0.0;
            double cross3 = 0.0;
            int sample = 0;
            for (;
                 sample + 3 < comparedSamples;
                 sample += 4)
            {
                cross0 += static_cast<double>(
                    analysisFrame[static_cast<size_t>(sample)])
                    * static_cast<double>(
                        analysisFrame[static_cast<size_t>(
                            sample + lag)]);
                cross1 += static_cast<double>(
                    analysisFrame[static_cast<size_t>(sample + 1)])
                    * static_cast<double>(
                        analysisFrame[static_cast<size_t>(
                            sample + lag + 1)]);
                cross2 += static_cast<double>(
                    analysisFrame[static_cast<size_t>(sample + 2)])
                    * static_cast<double>(
                        analysisFrame[static_cast<size_t>(
                            sample + lag + 2)]);
                cross3 += static_cast<double>(
                    analysisFrame[static_cast<size_t>(sample + 3)])
                    * static_cast<double>(
                        analysisFrame[static_cast<size_t>(
                            sample + lag + 3)]);
            }
            double cross =
                cross0 + cross1 + cross2 + cross3;
            for (; sample < comparedSamples; ++sample)
            {
                cross += static_cast<double>(
                    analysisFrame[static_cast<size_t>(sample)])
                    * static_cast<double>(
                        analysisFrame[static_cast<size_t>(
                            sample + lag)]);
            }

            const double energyA =
                energyPrefix[static_cast<size_t>(comparedSamples)];
            const double energyB =
                energyPrefix[static_cast<size_t>(
                    comparedSamples + lag)]
                - energyPrefix[static_cast<size_t>(lag)];
            const double denominator = energyA + energyB;
            if (denominator > 1.0e-18)
            {
                nsdf[static_cast<size_t>(lag)] =
                    static_cast<float>(
                        juce::jlimit(
                            -1.0,
                            1.0,
                            2.0 * cross / denominator));
            }
        }

        std::array<Peak, kMaximumLagStorage / 2> peaks {};
        int peakCount = 0;
        bool crossedNegative = false;
        for (int lag = 2; lag <= maximumLag; ++lag)
        {
            if (nsdf[static_cast<size_t>(lag)] < 0.0f)
                crossedNegative = true;

            if (! crossedNegative
                || nsdf[static_cast<size_t>(lag)]
                    <= nsdf[static_cast<size_t>(lag - 1)]
                || nsdf[static_cast<size_t>(lag)]
                    < nsdf[static_cast<size_t>(lag + 1)])
            {
                continue;
            }

            if (peakCount < static_cast<int>(peaks.size()))
            {
                peaks[static_cast<size_t>(peakCount)] = {
                    lag, nsdf[static_cast<size_t>(lag)]
                };
                ++peakCount;
            }
        }

        if (peakCount <= 0)
            return result;

        const auto& firstPeak = peaks[0];
        if (firstPeak.lag < minimumLag
            && firstPeak.clarity >= 0.92f)
        {
            return result;
        }

        float strongestAllowedPeak = -1.0f;
        for (int peakIndex = 0; peakIndex < peakCount; ++peakIndex)
        {
            const auto& peak = peaks[static_cast<size_t>(peakIndex)];
            if (peak.lag >= minimumLag
                && peak.lag <= maximumLag)
            {
                strongestAllowedPeak = juce::jmax(
                    strongestAllowedPeak, peak.clarity);
            }
        }

        if (strongestAllowedPeak < kMinimumClarity)
            return result;

        const float relativeThreshold = juce::jmax(
            kMinimumClarity, strongestAllowedPeak * 0.90f);
        int selectedPeakIndex = -1;
        for (int peakIndex = 0; peakIndex < peakCount; ++peakIndex)
        {
            const auto& peak = peaks[static_cast<size_t>(peakIndex)];
            if (peak.lag >= minimumLag
                && peak.lag <= maximumLag
                && peak.clarity >= relativeThreshold)
            {
                selectedPeakIndex = peakIndex;
                break;
            }
        }

        if (selectedPeakIndex < 0)
            return result;

        // If a stronger peak at twice the selected period exists, the first
        // peak was probably a dominant second/fourth harmonic.  Requiring a
        // real clarity improvement avoids turning an actual octave change
        // into a stale lower-octave lock.
        for (int correction = 0; correction < 2; ++correction)
        {
            const auto selected =
                peaks[static_cast<size_t>(selectedPeakIndex)];
            const int doubledLag = selected.lag * 2;
            int improvedPeakIndex = -1;
            for (int peakIndex = selectedPeakIndex + 1;
                 peakIndex < peakCount;
                 ++peakIndex)
            {
                const auto& peak =
                    peaks[static_cast<size_t>(peakIndex)];
                if (peak.lag > doubledLag + 2)
                    break;
                if (std::abs(peak.lag - doubledLag) <= 2
                    && peak.clarity >= selected.clarity + 0.025f)
                {
                    improvedPeakIndex = peakIndex;
                    break;
                }
            }

            if (improvedPeakIndex < 0)
                break;
            selectedPeakIndex = improvedPeakIndex;
        }

        const auto selected =
            peaks[static_cast<size_t>(selectedPeakIndex)];
        const float left =
            nsdf[static_cast<size_t>(selected.lag - 1)];
        const float centre =
            nsdf[static_cast<size_t>(selected.lag)];
        const float right =
            nsdf[static_cast<size_t>(selected.lag + 1)];
        const float denominator =
            left - 2.0f * centre + right;
        float offset = 0.0f;
        if (std::abs(denominator) > 1.0e-9f)
        {
            offset = 0.5f * (left - right) / denominator;
            offset = juce::jlimit(-0.5f, 0.5f, offset);
        }

        const double refinedLag =
            static_cast<double>(selected.lag)
            + static_cast<double>(offset);
        if (! std::isfinite(refinedLag) || refinedLag <= 0.0)
            return result;

        const double frequencyHz =
            analysisSampleRate / refinedLag;
        if (! std::isfinite(frequencyHz)
            || frequencyHz < kMinimumFrequencyHz * 0.995
            || frequencyHz > kMaximumFrequencyHz * 1.005)
        {
            return result;
        }

        result.valid = true;
        result.frequencyHz = static_cast<float>(frequencyHz);
        result.clarity = juce::jlimit(0.0f, 1.0f, centre);
        return result;
    }

    void analyseCurrentFrame() noexcept
    {
        ++snapshot.analysisFrameCounter;

        const double meanSquare = levelSampleCount > 0
            ? levelSquareSum
                / static_cast<double>(levelSampleCount)
            : 0.0;
        snapshot.inputLevelDb = safeDecibels(meanSquare);
        snapshot.signalPresent =
            snapshot.inputLevelDb >= kSignalThresholdDb;
        levelSquareSum = 0.0;
        levelSampleCount = 0;

        PitchCandidate candidate;
        if (snapshot.signalPresent
            && validRingSamples >= kAnalysisFrameSize)
        {
            candidate = detectPitch();
        }

        if (candidate.valid)
        {
            handleCandidate(candidate);
        }
        else
        {
            handleMissingCandidate();
        }

        updateSnapshotPitchFields();
    }

    void handleCandidate(const PitchCandidate& candidate) noexcept
    {
        const double candidateCents =
            frequencyToAbsoluteCents(candidate.frequencyHz);
        if (! std::isfinite(candidateCents))
        {
            handleMissingCandidate();
            return;
        }

        if (! hasAcceptedPitch)
        {
            const double candidateWeight =
                confidenceInfluence(candidate.clarity);
            if (acquisitionCount > 0
                && std::abs(
                    candidateCents - acquisitionCandidateCents)
                    <= kCandidateConsistencyCents)
            {
                const double combinedWeight =
                    acquisitionCandidateWeight
                    + candidateWeight;
                if (combinedWeight > 0.0)
                {
                    acquisitionCandidateCents +=
                        (candidateCents
                            - acquisitionCandidateCents)
                        * candidateWeight
                        / combinedWeight;
                }
                acquisitionCandidateWeight =
                    combinedWeight;
                ++acquisitionCount;
            }
            else
            {
                // The first usable analysis window can still contain some
                // pick energy. Let later consistent windows dominate the
                // seed while limiting the extra acquisition cost to one
                // analysis hop.
                acquisitionCandidateCents = candidateCents;
                acquisitionCandidateWeight =
                    candidateWeight
                    * kFirstAcquisitionWeight;
                acquisitionCount = 1;
            }

            snapshot.state = State::acquiring;
            snapshot.confidence = candidate.clarity;
            if (acquisitionCount >= kAcquisitionFrames)
            {
                seedAcceptedPitch(
                    acquisitionCandidateCents,
                    absoluteCentsToFrequency(
                        acquisitionCandidateCents),
                    candidate.clarity);
            }
            return;
        }

        const double distanceFromAverage =
            std::abs(candidateCents - averagedAbsoluteCents);
        if (distanceFromAverage > kTransitionThresholdCents)
        {
            if (transitionCount > 0
                && std::abs(
                    candidateCents - transitionCandidateCents)
                    <= kCandidateConsistencyCents)
            {
                transitionCandidateCents =
                    0.5 * (transitionCandidateCents
                           + candidateCents);
                ++transitionCount;
            }
            else
            {
                transitionCandidateCents = candidateCents;
                transitionCount = 1;
            }

            const int requiredFrames =
                distanceFromAverage >= 700.0 ? 3 : 2;
            if (transitionCount >= requiredFrames)
            {
                seedAcceptedPitch(
                    transitionCandidateCents,
                    candidate.frequencyHz,
                    candidate.clarity);
            }
            return;
        }

        transitionCount = 0;
        acceptTrackedPitch(
            candidateCents,
            candidate.frequencyHz,
            candidate.clarity);
    }

    void seedAcceptedPitch(double candidateCents,
                           float frequencyHz,
                           float confidence) noexcept
    {
        pitchHistory.fill(candidateCents);
        pitchHistoryCount = 1;
        pitchHistoryWriteIndex = 1;
        averagedAbsoluteCents = candidateCents;
        instantaneousAbsoluteCents = candidateCents;
        stableMidiNote = roundedMidiNote(candidateCents);
        pendingMidiNote = -1;
        pendingMidiCount = 0;
        acquisitionCount = 0;
        acquisitionCandidateWeight = 0.0;
        transitionCount = 0;
        hasAcceptedPitch = true;
        lastAcceptedAnalysisSample = totalAnalysisSamples;
        lastConfidence = confidence;

        snapshot.state = State::tracking;
        snapshot.pitchLocked = true;
        snapshot.instantaneousFrequencyHz = frequencyHz;
        snapshot.confidence = confidence;
        ++snapshot.pitchUpdateCounter;
    }

    void acceptTrackedPitch(double candidateCents,
                            float frequencyHz,
                            float confidence) noexcept
    {
        pitchHistory[
            static_cast<size_t>(pitchHistoryWriteIndex)] =
            candidateCents;
        pitchHistoryWriteIndex =
            (pitchHistoryWriteIndex + 1) % kPitchMedianSize;
        pitchHistoryCount = juce::jmin(
            kPitchMedianSize, pitchHistoryCount + 1);

        std::array<double, kPitchMedianSize> sorted {};
        for (int index = 0; index < pitchHistoryCount; ++index)
            sorted[static_cast<size_t>(index)] =
                pitchHistory[static_cast<size_t>(index)];
        std::sort(
            sorted.begin(),
            sorted.begin() + pitchHistoryCount);
        const double medianCents =
            sorted[static_cast<size_t>(pitchHistoryCount / 2)];

        const double hopSeconds =
            static_cast<double>(kAnalysisHopSize)
            / analysisSampleRate;
        const double alpha = juce::jlimit(
            0.02,
            1.0,
            1.0 - std::exp(
                -hopSeconds
                    * confidenceInfluence(confidence)
                    / kAverageTimeConstantSeconds));
        averagedAbsoluteCents +=
            (medianCents - averagedAbsoluteCents) * alpha;
        instantaneousAbsoluteCents = candidateCents;
        updateMidiHysteresis();

        lastAcceptedAnalysisSample = totalAnalysisSamples;
        lastConfidence = confidence;
        snapshot.state = State::tracking;
        snapshot.pitchLocked = true;
        snapshot.instantaneousFrequencyHz = frequencyHz;
        snapshot.confidence = confidence;
        ++snapshot.pitchUpdateCounter;
    }

    void updateMidiHysteresis() noexcept
    {
        if (stableMidiNote < 0)
        {
            stableMidiNote =
                roundedMidiNote(averagedAbsoluteCents);
            return;
        }

        const int targetMidi =
            roundedMidiNote(averagedAbsoluteCents);
        if (targetMidi == stableMidiNote)
        {
            pendingMidiNote = -1;
            pendingMidiCount = 0;
            return;
        }

        const double centsFromStableCentre =
            std::abs(
                averagedAbsoluteCents
                - static_cast<double>(stableMidiNote) * 100.0);
        if (centsFromStableCentre < 58.0)
        {
            pendingMidiNote = -1;
            pendingMidiCount = 0;
            return;
        }

        if (pendingMidiNote == targetMidi)
        {
            ++pendingMidiCount;
        }
        else
        {
            pendingMidiNote = targetMidi;
            pendingMidiCount = 1;
        }

        if (pendingMidiCount >= 2)
        {
            stableMidiNote = targetMidi;
            pendingMidiNote = -1;
            pendingMidiCount = 0;
        }
    }

    void handleMissingCandidate() noexcept
    {
        acquisitionCount = 0;
        acquisitionCandidateWeight = 0.0;
        transitionCount = 0;

        if (! hasAcceptedPitch)
        {
            snapshot.state = snapshot.signalPresent
                ? State::acquiring
                : State::idle;
            snapshot.pitchLocked = false;
            snapshot.confidence = 0.0f;
            return;
        }

        const double ageSeconds =
            static_cast<double>(
                totalAnalysisSamples
                - lastAcceptedAnalysisSample)
            / analysisSampleRate;
        if (ageSeconds >= kReleaseSeconds)
        {
            clearAcceptedPitch();
            return;
        }

        snapshot.state = State::holding;
        snapshot.pitchLocked = true;
        if (ageSeconds <= kSteadyHoldSeconds)
        {
            snapshot.confidence = lastConfidence;
        }
        else
        {
            const double fadeProgress = juce::jlimit(
                0.0,
                1.0,
                (ageSeconds - kSteadyHoldSeconds)
                    / (kReleaseSeconds
                        - kSteadyHoldSeconds));
            snapshot.confidence =
                lastConfidence
                * static_cast<float>(
                    1.0 - fadeProgress);
        }
    }

    void clearAcceptedPitch() noexcept
    {
        hasAcceptedPitch = false;
        pitchHistoryCount = 0;
        pitchHistoryWriteIndex = 0;
        averagedAbsoluteCents = 0.0;
        instantaneousAbsoluteCents = 0.0;
        stableMidiNote = -1;
        pendingMidiNote = -1;
        pendingMidiCount = 0;
        lastConfidence = 0.0f;
        snapshot.state = State::idle;
        snapshot.pitchLocked = false;
        snapshot.instantaneousFrequencyHz = 0.0f;
        snapshot.averageFrequencyHz = 0.0f;
        snapshot.instantaneousCents = 0.0f;
        snapshot.averageCents = 0.0f;
        snapshot.varianceCents = 0.0f;
        snapshot.confidence = 0.0f;
        snapshot.midiNote = -1;
        snapshot.ageMs = 0.0;
    }

    void updateSnapshotPitchFields() noexcept
    {
        if (! hasAcceptedPitch)
            return;

        snapshot.pitchLocked =
            snapshot.state == State::tracking
            || snapshot.state == State::holding;
        snapshot.averageFrequencyHz =
            absoluteCentsToFrequency(
                averagedAbsoluteCents);
        snapshot.midiNote = stableMidiNote;
        snapshot.instantaneousCents =
            static_cast<float>(
                instantaneousAbsoluteCents
                - static_cast<double>(stableMidiNote) * 100.0);
        snapshot.averageCents =
            static_cast<float>(
                averagedAbsoluteCents
                - static_cast<double>(stableMidiNote) * 100.0);

        double variance = 0.0;
        if (pitchHistoryCount > 1)
        {
            double mean = 0.0;
            for (int index = 0;
                 index < pitchHistoryCount;
                 ++index)
            {
                mean += pitchHistory[static_cast<size_t>(index)];
            }
            mean /= static_cast<double>(pitchHistoryCount);

            for (int index = 0;
                 index < pitchHistoryCount;
                 ++index)
            {
                const double difference =
                    pitchHistory[static_cast<size_t>(index)]
                    - mean;
                variance += difference * difference;
            }
            variance /= static_cast<double>(pitchHistoryCount);
        }
        snapshot.varianceCents =
            static_cast<float>(std::sqrt(variance));
        snapshot.ageMs =
            1000.0
            * static_cast<double>(
                totalAnalysisSamples
                - lastAcceptedAnalysisSample)
            / analysisSampleRate;
    }

    double sourceSampleRate = 48000.0;
    double analysisSampleRate = 12000.0;
    int decimationFactor = 4;
    int decimationPhase = 0;
    float lowPassAlpha = 0.25f;
    float highPassCoefficient = 0.998f;
    float inputHighPassX1 = 0.0f;
    float inputHighPassY1 = 0.0f;
    std::array<float, 4> lowPassStates {};

    std::array<float, kAnalysisFrameSize> analysisRing {};
    std::array<float, kAnalysisFrameSize> analysisFrame {};
    std::array<float, kMaximumLagStorage> nsdf {};
    std::array<double, kAnalysisFrameSize + 1> energyPrefix {};
    int ringWriteIndex = 0;
    int validRingSamples = 0;
    int samplesSinceAnalysis = 0;
    std::uint64_t totalAnalysisSamples = 0;

    double levelSquareSum = 0.0;
    int levelSampleCount = 0;
    std::uint64_t lastAcceptedAnalysisSample = 0;
    bool hasAcceptedPitch = false;

    int acquisitionCount = 0;
    double acquisitionCandidateCents = 0.0;
    double acquisitionCandidateWeight = 0.0;
    int transitionCount = 0;
    double transitionCandidateCents = 0.0;

    std::array<double, kPitchMedianSize> pitchHistory {};
    int pitchHistoryCount = 0;
    int pitchHistoryWriteIndex = 0;
    double averagedAbsoluteCents = 0.0;
    double instantaneousAbsoluteCents = 0.0;
    int stableMidiNote = -1;
    int pendingMidiNote = -1;
    int pendingMidiCount = 0;
    float lastConfidence = 0.0f;
    Snapshot snapshot;
};

TunerPitchTracker::TunerPitchTracker()
    : juce::Thread("NAM tuner pitch analysis"),
      fifo(std::make_unique<
           std::array<FifoSample, fifoCapacity>>())
{
}

TunerPitchTracker::~TunerPitchTracker()
{
    stopWorker();
}

void TunerPitchTracker::prepare(double sourceSampleRate,
                                int maximumBlockSize)
{
    const bool wasEnabled =
        enabled.exchange(false, std::memory_order_acq_rel);
    stopWorker();

    testingMode.store(false, std::memory_order_release);
    preparedSampleRate =
        std::isfinite(sourceSampleRate)
            && sourceSampleRate >= 8000.0
        ? sourceSampleRate
        : 48000.0;
    preparedMaximumBlockSize =
        juce::jmax(1, maximumBlockSize);
    juce::ignoreUnused(preparedMaximumBlockSize);
    const int decimationFactor = juce::jlimit(
        1,
        64,
        juce::roundToInt(
            preparedSampleRate / kTargetAnalysisRate));
    const int firstCompleteAnalysisFrame =
        ((kAnalysisFrameSize + kAnalysisHopSize - 1)
            / kAnalysisHopSize)
        * kAnalysisHopSize;
    const auto minimumFreshWindowSamples =
        static_cast<std::uint32_t>(
            (firstCompleteAnalysisFrame
                + (kAcquisitionFrames - 1)
                    * kAnalysisHopSize)
            * decimationFactor);
    const auto latencyWindowSamples =
        static_cast<std::uint32_t>(
            juce::roundToInt(
                preparedSampleRate
                * kMaximumWorkerQueueSeconds));
    maximumQueuedSamples = juce::jlimit(
        1u,
        fifoCapacity,
        juce::jmax(
            minimumFreshWindowSamples,
            latencyWindowSamples));
    analysisCore =
        std::make_unique<AnalysisCore>(preparedSampleRate);

    fifoReadCounter.store(0, std::memory_order_relaxed);
    fifoWriteCounter.store(0, std::memory_order_relaxed);
    droppedFifoSamples.store(0, std::memory_order_relaxed);
    producerOverflowed.store(false, std::memory_order_relaxed);
    resetProducerSelection();
    const auto generation =
        routeGeneration.fetch_add(
            1, std::memory_order_acq_rel) + 1;
    publishSnapshot({}, generation);

    startThread(juce::Thread::Priority::low);
    enabled.store(wasEnabled, std::memory_order_release);
    if (wasEnabled)
        notify();
}

void TunerPitchTracker::setEnabled(bool shouldBeEnabled) noexcept
{
    if (testingMode.load(std::memory_order_acquire))
    {
        enabled.store(shouldBeEnabled, std::memory_order_release);
        if (! shouldBeEnabled && analysisCore != nullptr)
        {
            analysisCore->reset();
            const auto generation =
                routeGeneration.fetch_add(
                    1, std::memory_order_acq_rel) + 1;
            publishSnapshot({}, generation);
        }
        return;
    }

    const bool previous =
        enabled.exchange(
            shouldBeEnabled, std::memory_order_acq_rel);
    if (previous == shouldBeEnabled)
        return;

    routeGeneration.fetch_add(
        1, std::memory_order_acq_rel);
    notify();
}

bool TunerPitchTracker::isEnabled() const noexcept
{
    return enabled.load(std::memory_order_acquire);
}

std::uint32_t
TunerPitchTracker::resetForRouteChange() noexcept
{
    selectedChannel.store(-1, std::memory_order_relaxed);
    const auto generation =
        routeGeneration.fetch_add(
            1, std::memory_order_acq_rel) + 1;

    if (testingMode.load(std::memory_order_acquire)
        && analysisCore != nullptr)
    {
        analysisCore->reset();
        publishSnapshot({}, generation);
        return generation;
    }

    notify();
    return generation;
}

std::uint32_t
TunerPitchTracker::getGenerationToken() const noexcept
{
    return routeGeneration.load(std::memory_order_acquire);
}

void TunerPitchTracker::pushAudio(const float* const* channels,
                                  int numChannels,
                                  int numSamples,
                                  std::uint32_t expectedGeneration) noexcept
{
    if (! enabled.load(std::memory_order_relaxed)
        || testingMode.load(std::memory_order_relaxed)
        || numSamples <= 0)
    {
        return;
    }

    const auto currentGeneration =
        routeGeneration.load(std::memory_order_acquire);
    const auto generation =
        expectedGeneration != 0
            ? expectedGeneration
            : currentGeneration;
    if (generation != currentGeneration)
        return;

    if (producerGeneration != generation)
    {
        producerSelectedChannel = -1;
        producerGeneration = generation;
    }

    if (channels == nullptr || numChannels <= 0)
    {
        selectedChannel.store(-1, std::memory_order_relaxed);
        writeToFifo(nullptr, numSamples, generation);
        return;
    }

    const int channel =
        chooseStrongestChannel(
            channels, numChannels, numSamples);
    if (channel < 0 || channels[channel] == nullptr)
    {
        selectedChannel.store(-1, std::memory_order_relaxed);
        writeToFifo(nullptr, numSamples, generation);
        return;
    }

    writeToFifo(
        channels[channel], numSamples, generation);
    if (routeGeneration.load(std::memory_order_relaxed)
        == generation)
    {
        selectedChannel.store(
            channel, std::memory_order_relaxed);
    }
}

void TunerPitchTracker::pushSilence(
    int numSamples,
    std::uint32_t expectedGeneration) noexcept
{
    if (! enabled.load(std::memory_order_relaxed)
        || testingMode.load(std::memory_order_relaxed)
        || numSamples <= 0)
    {
        return;
    }

    const auto currentGeneration =
        routeGeneration.load(std::memory_order_acquire);
    const auto generation =
        expectedGeneration != 0
            ? expectedGeneration
            : currentGeneration;
    if (generation != currentGeneration)
        return;

    if (producerGeneration != generation)
    {
        producerSelectedChannel = -1;
        producerGeneration = generation;
    }
    selectedChannel.store(-1, std::memory_order_relaxed);
    writeToFifo(nullptr, numSamples, generation);
}

void TunerPitchTracker::writeToFifo(
    const float* source,
    int numSamples,
    std::uint32_t generation) noexcept
{
    const auto write =
        fifoWriteCounter.load(std::memory_order_relaxed);
    const auto read =
        fifoReadCounter.load(std::memory_order_acquire);
    const auto used = write - read;
    const auto requested =
        static_cast<std::uint32_t>(numSamples);
    if (used > fifoCapacity
        || requested > fifoCapacity - used)
    {
        droppedFifoSamples.fetch_add(
            requested, std::memory_order_relaxed);
        producerOverflowed.store(
            true, std::memory_order_release);
        return;
    }

    for (std::uint32_t sample = 0;
         sample < requested;
         ++sample)
    {
        const float value =
            source != nullptr ? source[sample] : 0.0f;
        (*fifo)[static_cast<size_t>(
            (write + sample) & fifoMask)] = {
                std::isfinite(value) ? value : 0.0f,
                generation
            };
    }

    fifoWriteCounter.store(
        write + requested, std::memory_order_release);
}

TunerPitchTracker::Snapshot
TunerPitchTracker::getSnapshot() const noexcept
{
    Snapshot result;
    result.enabled =
        enabled.load(std::memory_order_acquire);
    if (! result.enabled)
        return result;

    std::uint32_t publishedGeneration = 0;
    bool coherent = false;
    for (int attempt = 0; attempt < 12; ++attempt)
    {
        const auto sequenceBefore =
            published.sequence.load(std::memory_order_acquire);
        if ((sequenceBefore & 1u) != 0u)
            continue;

        publishedGeneration =
            published.generation.load(std::memory_order_relaxed);
        result.state = static_cast<State>(
            published.state.load(std::memory_order_relaxed));
        result.signalPresent =
            published.signalPresent.load(std::memory_order_relaxed);
        result.pitchLocked =
            published.pitchLocked.load(std::memory_order_relaxed);
        result.instantaneousFrequencyHz =
            published.instantaneousFrequencyHz.load(
                std::memory_order_relaxed);
        result.averageFrequencyHz =
            published.averageFrequencyHz.load(
                std::memory_order_relaxed);
        result.instantaneousCents =
            published.instantaneousCents.load(
                std::memory_order_relaxed);
        result.averageCents =
            published.averageCents.load(
                std::memory_order_relaxed);
        result.varianceCents =
            published.varianceCents.load(
                std::memory_order_relaxed);
        result.confidence =
            published.confidence.load(
                std::memory_order_relaxed);
        result.inputLevelDb =
            published.inputLevelDb.load(
                std::memory_order_relaxed);
        result.midiNote =
            published.midiNote.load(std::memory_order_relaxed);
        result.selectedChannel =
            published.selectedChannel.load(
                std::memory_order_relaxed);
        result.pitchUpdateCounter =
            published.pitchUpdateCounter.load(
                std::memory_order_relaxed);
        result.analysisFrameCounter =
            published.analysisFrameCounter.load(
                std::memory_order_relaxed);
        result.droppedFifoSamples =
            published.droppedFifoSamples.load(
                std::memory_order_relaxed);
        result.ageMs =
            published.ageMs.load(std::memory_order_relaxed);

        const auto sequenceAfter =
            published.sequence.load(std::memory_order_acquire);
        if (sequenceBefore == sequenceAfter
            && (sequenceAfter & 1u) == 0u)
        {
            coherent = true;
            break;
        }
    }

    const auto currentGeneration =
        routeGeneration.load(std::memory_order_acquire);
    if (! coherent
        || publishedGeneration != currentGeneration)
    {
        Snapshot idle;
        idle.enabled = true;
        idle.selectedChannel =
            selectedChannel.load(std::memory_order_relaxed);
        idle.droppedFifoSamples =
            droppedFifoSamples.load(std::memory_order_relaxed);
        return idle;
    }

    return result;
}

void TunerPitchTracker::prepareForTesting(double sourceSampleRate)
{
    enabled.store(false, std::memory_order_release);
    stopWorker();

    testingMode.store(true, std::memory_order_release);
    preparedSampleRate =
        std::isfinite(sourceSampleRate)
            && sourceSampleRate >= 8000.0
        ? sourceSampleRate
        : 48000.0;
    analysisCore =
        std::make_unique<AnalysisCore>(preparedSampleRate);
    droppedFifoSamples.store(0, std::memory_order_relaxed);
    producerOverflowed.store(false, std::memory_order_relaxed);
    resetProducerSelection();
    const auto generation =
        routeGeneration.fetch_add(
            1, std::memory_order_acq_rel) + 1;
    enabled.store(true, std::memory_order_release);
    publishSnapshot({}, generation);
}

void TunerPitchTracker::processAudioForTesting(
    const float* const* channels,
    int numChannels,
    int numSamples) noexcept
{
    if (! testingMode.load(std::memory_order_acquire)
        || ! enabled.load(std::memory_order_acquire)
        || analysisCore == nullptr
        || channels == nullptr
        || numChannels <= 0
        || numSamples <= 0)
    {
        return;
    }

    const auto generation =
        routeGeneration.load(std::memory_order_relaxed);
    if (producerGeneration != generation)
    {
        producerSelectedChannel = -1;
        producerGeneration = generation;
    }

    const int channel =
        chooseStrongestChannel(
            channels, numChannels, numSamples);
    if (channel < 0 || channels[channel] == nullptr)
        return;

    selectedChannel.store(
        channel, std::memory_order_relaxed);
    analysisCore->process(channels[channel], numSamples);
    auto result = analysisCore->getSnapshot();
    result.enabled = true;
    result.selectedChannel = channel;
    result.droppedFifoSamples = 0;
    publishSnapshot(
        result,
        routeGeneration.load(std::memory_order_acquire));
}

void TunerPitchTracker::processMonoForTesting(
    const float* samples,
    int numSamples) noexcept
{
    const float* channels[] { samples };
    processAudioForTesting(channels, 1, numSamples);
}

void TunerPitchTracker::run()
{
    std::uint32_t workerGeneration = 0;

    while (! threadShouldExit())
    {
        if (! enabled.load(std::memory_order_acquire))
        {
            wait(-1.0);
            continue;
        }

        const auto currentGeneration =
            routeGeneration.load(std::memory_order_acquire);
        if (workerGeneration != currentGeneration)
        {
            workerGeneration = currentGeneration;
            const auto write =
                fifoWriteCounter.load(std::memory_order_acquire);
            fifoReadCounter.store(write, std::memory_order_release);
            if (analysisCore != nullptr)
            {
                analysisCore->reset();
                auto resetSnapshot =
                    analysisCore->getSnapshot();
                resetSnapshot.enabled = true;
                resetSnapshot.selectedChannel =
                    selectedChannel.load(
                        std::memory_order_relaxed);
                resetSnapshot.droppedFifoSamples =
                    droppedFifoSamples.load(
                        std::memory_order_relaxed);
                publishSnapshot(
                    resetSnapshot, workerGeneration);
            }
        }

        if (producerOverflowed.exchange(
                false, std::memory_order_acq_rel))
        {
            // Once incoming callbacks have been dropped, the remaining FIFO
            // no longer represents the newest live audio. Discard it rather
            // than displaying a pitch from several seconds in the past.
            const auto write =
                fifoWriteCounter.load(std::memory_order_acquire);
            fifoReadCounter.store(
                write, std::memory_order_release);
            if (analysisCore != nullptr)
            {
                analysisCore->reset();
                auto resetSnapshot =
                    analysisCore->getSnapshot();
                resetSnapshot.enabled = true;
                resetSnapshot.selectedChannel =
                    selectedChannel.load(
                        std::memory_order_relaxed);
                resetSnapshot.droppedFifoSamples =
                    droppedFifoSamples.load(
                        std::memory_order_relaxed);
                publishSnapshot(
                    resetSnapshot, workerGeneration);
            }
            continue;
        }

        auto read =
            fifoReadCounter.load(std::memory_order_relaxed);
        const auto write =
            fifoWriteCounter.load(std::memory_order_acquire);
        auto available = write - read;
        if (available == 0)
        {
            wait(4);
            continue;
        }

        if (available > maximumQueuedSamples)
        {
            const auto staleSamples =
                available - maximumQueuedSamples;
            read += staleSamples;
            available -= staleSamples;
            fifoReadCounter.store(
                read, std::memory_order_release);
            droppedFifoSamples.fetch_add(
                staleSamples, std::memory_order_relaxed);

            // Keeping the old temporal state after fast-forwarding would
            // combine a stale pitch with the newest audio. Reacquire from
            // the retained recent window instead.
            if (analysisCore != nullptr)
            {
                analysisCore->reset();
                auto resetSnapshot =
                    analysisCore->getSnapshot();
                resetSnapshot.enabled = true;
                resetSnapshot.selectedChannel =
                    selectedChannel.load(
                        std::memory_order_relaxed);
                resetSnapshot.droppedFifoSamples =
                    droppedFifoSamples.load(
                        std::memory_order_relaxed);
                publishSnapshot(
                    resetSnapshot, workerGeneration);
            }
        }

        const auto toRead = juce::jmin(
            available,
            static_cast<std::uint32_t>(
                workerScratchCapacity));
        int matchingSamples = 0;
        for (std::uint32_t sample = 0;
             sample < toRead;
             ++sample)
        {
            const auto& fifoSample =
                (*fifo)[static_cast<size_t>(
                    (read + sample) & fifoMask)];
            if (fifoSample.generation
                == workerGeneration)
            {
                workerScratch[static_cast<size_t>(
                    matchingSamples)] =
                    fifoSample.value;
                ++matchingSamples;
            }
        }
        fifoReadCounter.store(
            read + toRead, std::memory_order_release);

        if (analysisCore == nullptr
            || matchingSamples <= 0)
            continue;

        analysisCore->process(
            workerScratch.data(),
            matchingSamples);

        if (! enabled.load(std::memory_order_acquire)
            || routeGeneration.load(std::memory_order_acquire)
                != workerGeneration)
        {
            continue;
        }

        auto result = analysisCore->getSnapshot();
        result.enabled = true;
        result.selectedChannel =
            selectedChannel.load(std::memory_order_relaxed);
        result.droppedFifoSamples =
            droppedFifoSamples.load(std::memory_order_relaxed);
        publishSnapshot(result, workerGeneration);
    }
}

void TunerPitchTracker::stopWorker() noexcept
{
    if (! isThreadRunning())
        return;

    signalThreadShouldExit();
    notify();
    stopThread(2000);
}

void TunerPitchTracker::publishSnapshot(
    const Snapshot& snapshot,
    std::uint32_t generation) noexcept
{
    published.sequence.fetch_add(
        1, std::memory_order_acq_rel);
    published.generation.store(
        generation, std::memory_order_relaxed);
    published.state.store(
        static_cast<int>(snapshot.state),
        std::memory_order_relaxed);
    published.signalPresent.store(
        snapshot.signalPresent, std::memory_order_relaxed);
    published.pitchLocked.store(
        snapshot.pitchLocked, std::memory_order_relaxed);
    published.instantaneousFrequencyHz.store(
        snapshot.instantaneousFrequencyHz,
        std::memory_order_relaxed);
    published.averageFrequencyHz.store(
        snapshot.averageFrequencyHz,
        std::memory_order_relaxed);
    published.instantaneousCents.store(
        snapshot.instantaneousCents,
        std::memory_order_relaxed);
    published.averageCents.store(
        snapshot.averageCents,
        std::memory_order_relaxed);
    published.varianceCents.store(
        snapshot.varianceCents,
        std::memory_order_relaxed);
    published.confidence.store(
        snapshot.confidence, std::memory_order_relaxed);
    published.inputLevelDb.store(
        snapshot.inputLevelDb, std::memory_order_relaxed);
    published.midiNote.store(
        snapshot.midiNote, std::memory_order_relaxed);
    published.selectedChannel.store(
        snapshot.selectedChannel, std::memory_order_relaxed);
    published.pitchUpdateCounter.store(
        snapshot.pitchUpdateCounter,
        std::memory_order_relaxed);
    published.analysisFrameCounter.store(
        snapshot.analysisFrameCounter,
        std::memory_order_relaxed);
    published.droppedFifoSamples.store(
        snapshot.droppedFifoSamples,
        std::memory_order_relaxed);
    published.ageMs.store(
        snapshot.ageMs, std::memory_order_relaxed);
    published.sequence.fetch_add(
        1, std::memory_order_release);
}

void TunerPitchTracker::resetProducerSelection() noexcept
{
    producerSelectedChannel = -1;
    producerGeneration =
        routeGeneration.load(std::memory_order_relaxed);
    selectedChannel.store(-1, std::memory_order_relaxed);
}

int TunerPitchTracker::chooseStrongestChannel(
    const float* const* channels,
    int numChannels,
    int numSamples) noexcept
{
    if (channels == nullptr
        || numChannels <= 0
        || numSamples <= 0)
    {
        return -1;
    }

    constexpr int maximumScannedChannels = 8;
    const int scannedChannels = juce::jmin(
        numChannels, maximumScannedChannels);
    int strongestChannel = -1;
    double strongestEnergy = -1.0;
    double currentEnergy = -1.0;

    for (int channel = 0;
         channel < scannedChannels;
         ++channel)
    {
        const auto* source = channels[channel];
        if (source == nullptr)
            continue;

        double energy = 0.0;
        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float value = source[sample];
            if (std::isfinite(value))
            {
                energy +=
                    static_cast<double>(value)
                    * static_cast<double>(value);
            }
        }

        if (channel == producerSelectedChannel)
            currentEnergy = energy;
        if (energy > strongestEnergy)
        {
            strongestEnergy = energy;
            strongestChannel = channel;
        }
    }

    if (producerSelectedChannel >= 0
        && producerSelectedChannel < scannedChannels
        && channels[producerSelectedChannel] != nullptr
        && currentEnergy >= 0.0
        && (strongestEnergy <= 0.0
            || currentEnergy >= strongestEnergy * 0.65))
    {
        strongestChannel = producerSelectedChannel;
    }

    producerSelectedChannel = strongestChannel;
    return strongestChannel;
}
