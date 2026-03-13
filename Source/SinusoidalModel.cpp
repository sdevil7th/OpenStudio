#include "SinusoidalModel.h"
#include <cmath>
#include <algorithm>
#include <set>
#include <numeric>
#include <complex>


SinusoidalModel::SinusoidalModel() = default;

float SinusoidalModel::hzToMidi (float hz)
{
    if (hz <= 0.0f) return 0.0f;
    return 69.0f + 12.0f * std::log2 (hz / 440.0f);
}

bool SinusoidalModel::isHarmonic (float freq, float f0, int maxHarmonic,
                                   float toleranceCents, int& harmonicNum)
{
    if (f0 <= 0.0f || freq <= 0.0f)
        return false;

    float ratio = freq / f0;
    int nearest = std::max (1, static_cast<int> (std::round (ratio)));
    if (nearest > maxHarmonic)
        return false;

    float expectedFreq = f0 * static_cast<float> (nearest);
    float centsOff = 1200.0f * std::log2 (freq / expectedFreq);

    if (std::abs (centsOff) <= toleranceCents)
    {
        harmonicNum = nearest;
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Harmonic grouping (unchanged from original)
// ---------------------------------------------------------------------------

std::vector<SinusoidalModel::HarmonicGroup>
SinusoidalModel::groupPartials (const PartialTracker::AnalysisResult& analysis)
{
    nextNoteId_ = 0;
    std::vector<HarmonicGroup> groups;

    if (analysis.partials.empty())
        return groups;

    std::vector<size_t> sortedIndices (analysis.partials.size());
    std::iota (sortedIndices.begin(), sortedIndices.end(), 0);
    std::sort (sortedIndices.begin(), sortedIndices.end(),
               [&] (size_t a, size_t b) {
                   return analysis.partials[a].avgMagnitude() > analysis.partials[b].avgMagnitude();
               });

    std::set<int> assignedPartialIds;

    for (size_t si = 0; si < sortedIndices.size(); ++si)
    {
        const auto& candidate = analysis.partials[sortedIndices[si]];

        if (assignedPartialIds.count (candidate.id))
            continue;

        float f0 = candidate.avgFrequency();
        if (f0 < 30.0f || f0 > 5000.0f)
            continue;

        HarmonicGroup group;
        group.noteId = nextNoteId_++;
        group.fundamentalFreq = f0;
        group.midiPitch = hzToMidi (f0);
        group.startFrame = candidate.birthFrame;
        group.endFrame = candidate.deathFrame >= 0 ? candidate.deathFrame : analysis.numFrames;
        group.partialIds.push_back (candidate.id);
        assignedPartialIds.insert (candidate.id);

        float magSum = candidate.avgMagnitude();
        int magCount = 1;

        for (const auto& other : analysis.partials)
        {
            if (assignedPartialIds.count (other.id))
                continue;

            float otherFreq = other.avgFrequency();
            int harmonicNum = 0;
            if (isHarmonic (otherFreq, f0, maxHarmonics_, groupingTolerance_, harmonicNum))
            {
                int otherStart = other.birthFrame;
                int otherEnd = other.deathFrame >= 0 ? other.deathFrame : analysis.numFrames;

                int overlapStart = std::max (group.startFrame, otherStart);
                int overlapEnd = std::min (group.endFrame, otherEnd);

                if (overlapEnd > overlapStart)
                {
                    group.partialIds.push_back (other.id);
                    assignedPartialIds.insert (other.id);
                    group.startFrame = std::min (group.startFrame, otherStart);
                    group.endFrame = std::max (group.endFrame, otherEnd);
                    magSum += other.avgMagnitude();
                    ++magCount;
                }
            }
        }

        group.avgMagnitude = magSum / static_cast<float> (magCount);

        int durationFrames = group.endFrame - group.startFrame;
        if (durationFrames >= minNoteDuration_ && group.partialIds.size() >= 2)
            groups.push_back (std::move (group));
        else
        {
            for (int pid : group.partialIds)
                assignedPartialIds.erase (pid);
        }
    }

    std::sort (groups.begin(), groups.end(),
               [] (const HarmonicGroup& a, const HarmonicGroup& b) {
                   return a.startFrame < b.startFrame;
               });

    juce::Logger::writeToLog ("SinusoidalModel: Grouped " +
                               juce::String (static_cast<int> (analysis.partials.size())) +
                               " partials into " + juce::String (static_cast<int> (groups.size())) + " notes");

    return groups;
}

// ---------------------------------------------------------------------------
// LPC Spectral Envelope Estimation
// ---------------------------------------------------------------------------

std::vector<float> SinusoidalModel::estimateLPCEnvelope (
    const std::vector<float>& magnitudes, int numBins,
    double sampleRate, int lpcOrder)
{
    juce::ignoreUnused (lpcOrder);

    // Estimate spectral envelope via Gaussian smoothing of the log-magnitude spectrum.
    // This correctly captures the broad formant envelope without being disrupted by the
    // fine harmonic structure that makes direct LPC-on-spectrum unreliable.
    // Smooth half-bandwidth: ~300 Hz (wider than a harmonic, narrower than a formant).
    const float binToHz = static_cast<float> (sampleRate) / static_cast<float> (2 * (numBins - 1));
    const int smoothHalf = std::max (2, static_cast<int> (300.0f / binToHz));
    const float sigma = static_cast<float> (smoothHalf) / 2.5f;
    const float invTwoSigmaSq = 1.0f / (2.0f * sigma * sigma);

    std::vector<float> logMag (static_cast<size_t> (numBins));
    for (int i = 0; i < numBins; ++i)
        logMag[static_cast<size_t> (i)] = std::log (magnitudes[static_cast<size_t> (i)] + 1e-10f);

    std::vector<float> envelope (static_cast<size_t> (numBins));
    for (int i = 0; i < numBins; ++i)
    {
        float wSum = 0.0f, wTotal = 0.0f;
        int lo = std::max (0, i - smoothHalf);
        int hi = std::min (numBins - 1, i + smoothHalf);
        for (int j = lo; j <= hi; ++j)
        {
            float d = static_cast<float> (j - i);
            float w = std::exp (-d * d * invTwoSigmaSq);
            wSum += logMag[static_cast<size_t> (j)] * w;
            wTotal += w;
        }
        envelope[static_cast<size_t> (i)] = std::exp (wTotal > 0.0f ? wSum / wTotal
                                                                      : logMag[static_cast<size_t> (i)]);
    }

    return envelope;
}

// ---------------------------------------------------------------------------
// Formant Tracking — extract F1-F4 from LPC roots, track across frames
// ---------------------------------------------------------------------------

std::vector<SinusoidalModel::FormantFrame> SinusoidalModel::extractFormantTracks (
    const PartialTracker::AnalysisResult& analysis, double sampleRate) const
{
    int numFrames = static_cast<int> (analysis.stftFrames.size());
    int numBins = analysis.fftSize / 2 + 1;

    std::vector<FormantFrame> tracks (static_cast<size_t> (numFrames));

    if (numFrames == 0 || analysis.stftFrames.empty())
        return tracks;

    const int lpcOrder = 14;
    const float nyquist = static_cast<float> (sampleRate) / 2.0f;

    for (int frame = 0; frame < numFrames; ++frame)
    {
        // Extract magnitudes from STFT frame
        const auto& stftFrame = analysis.stftFrames[static_cast<size_t> (frame)];
        std::vector<float> mags (static_cast<size_t> (numBins));
        for (int b = 0; b < numBins; ++b)
            mags[static_cast<size_t> (b)] = std::abs (stftFrame[static_cast<size_t> (b)]);

        // Compute LPC coefficients via autocorrelation + Levinson-Durbin
        // (same approach as estimateLPCEnvelope but we need the raw coefficients for root finding)
        int n = numBins;
        std::vector<float> powerSpec (static_cast<size_t> (n));
        for (int i = 0; i < n; ++i)
            powerSpec[static_cast<size_t> (i)] = mags[static_cast<size_t> (i)] * mags[static_cast<size_t> (i)];

        int order = std::min (lpcOrder, n - 1);
        std::vector<double> autocorr (static_cast<size_t> (order + 1), 0.0);
        for (int k = 0; k <= order; ++k)
            for (int i = 0; i < n - k; ++i)
                autocorr[static_cast<size_t> (k)] += static_cast<double> (powerSpec[static_cast<size_t> (i)]
                                                                           * powerSpec[static_cast<size_t> (i + k)]);

        std::vector<double> lpc (static_cast<size_t> (order + 1), 0.0);
        std::vector<double> prevLpc (static_cast<size_t> (order + 1), 0.0);
        double errVal = autocorr[0] + 1e-10;

        for (int i = 1; i <= order; ++i)
        {
            double lambda = 0.0;
            for (int j = 1; j < i; ++j)
                lambda += prevLpc[static_cast<size_t> (j)] * autocorr[static_cast<size_t> (i - j)];
            lambda = (autocorr[static_cast<size_t> (i)] - lambda) / errVal;
            lpc[static_cast<size_t> (i)] = lambda;
            for (int j = 1; j < i; ++j)
                lpc[static_cast<size_t> (j)] = prevLpc[static_cast<size_t> (j)]
                    - lambda * prevLpc[static_cast<size_t> (i - j)];
            errVal *= (1.0 - lambda * lambda);
            if (errVal < 1e-10) errVal = 1e-10;
            prevLpc = lpc;
        }

        // Find formants by evaluating |1/A(e^jw)|^2 on a fine grid and picking peaks
        // This is more robust than polynomial root-finding for our use case
        const int evalPoints = 512;
        std::vector<float> envelope (static_cast<size_t> (evalPoints));
        for (int i = 0; i < evalPoints; ++i)
        {
            float omega = juce::MathConstants<float>::pi * static_cast<float> (i) / static_cast<float> (evalPoints - 1);
            float realPart = 1.0f;
            float imagPart = 0.0f;
            for (int k = 1; k <= order; ++k)
            {
                float angle = static_cast<float> (k) * omega;
                realPart -= static_cast<float> (lpc[static_cast<size_t> (k)]) * std::cos (angle);
                imagPart += static_cast<float> (lpc[static_cast<size_t> (k)]) * std::sin (angle);
            }
            float magA = realPart * realPart + imagPart * imagPart;
            envelope[static_cast<size_t> (i)] = (magA > 1e-20f) ? 1.0f / magA : 0.0f;
        }

        // Find peaks in the LPC envelope — these are the formants
        struct FormantCandidate { float freq; float magnitude; float bandwidth; };
        std::vector<FormantCandidate> candidates;

        for (int i = 2; i < evalPoints - 2; ++i)
        {
            float val = envelope[static_cast<size_t> (i)];
            if (val > envelope[static_cast<size_t> (i - 1)] && val > envelope[static_cast<size_t> (i + 1)]
                && val > envelope[static_cast<size_t> (i - 2)] && val > envelope[static_cast<size_t> (i + 2)])
            {
                float freq = nyquist * static_cast<float> (i) / static_cast<float> (evalPoints - 1);
                if (freq < 100.0f || freq > 5500.0f) continue; // skip out-of-range

                // Estimate bandwidth: -3dB width around peak
                float halfPower = val * 0.5f;
                int lo = i, hi = i;
                while (lo > 0 && envelope[static_cast<size_t> (lo)] > halfPower) --lo;
                while (hi < evalPoints - 1 && envelope[static_cast<size_t> (hi)] > halfPower) ++hi;
                float bw = nyquist * static_cast<float> (hi - lo) / static_cast<float> (evalPoints - 1);

                // Skip very narrow or very wide peaks (noise or not formants)
                if (bw > 30.0f && bw < 800.0f)
                    candidates.push_back ({ freq, val, bw });
            }
        }

        // Sort by frequency and assign F1-F4
        std::sort (candidates.begin(), candidates.end(),
                   [] (const FormantCandidate& a, const FormantCandidate& b) { return a.freq < b.freq; });

        auto& ff = tracks[static_cast<size_t> (frame)];
        if (candidates.size() >= 1) { ff.f1 = candidates[0].freq; ff.bw1 = candidates[0].bandwidth; }
        if (candidates.size() >= 2) { ff.f2 = candidates[1].freq; ff.bw2 = candidates[1].bandwidth; }
        if (candidates.size() >= 3) { ff.f3 = candidates[2].freq; ff.bw3 = candidates[2].bandwidth; }
        if (candidates.size() >= 4) { ff.f4 = candidates[3].freq; ff.bw4 = candidates[3].bandwidth; }
    }

    // Smooth formant tracks with 5ms Gaussian (prevents frame-to-frame jitter)
    float hopTimeSec = static_cast<float> (analysis.hopSize) / static_cast<float> (sampleRate);
    int halfWin = std::max (1, static_cast<int> (0.005f / hopTimeSec * 0.5f));
    float sigma = static_cast<float> (halfWin) / 2.5f;
    float invTwoSigmaSq = 1.0f / (2.0f * sigma * sigma);

    auto smoothTrack = [&] (std::vector<float>& track)
    {
        std::vector<float> smoothed (track.size());
        int sz = static_cast<int> (track.size());
        for (int i = 0; i < sz; ++i)
        {
            if (track[static_cast<size_t> (i)] <= 0.0f) { smoothed[static_cast<size_t> (i)] = 0.0f; continue; }
            float wSum = 0.0f, wTotal = 0.0f;
            int lo = std::max (0, i - halfWin);
            int hi = std::min (sz - 1, i + halfWin);
            for (int j = lo; j <= hi; ++j)
            {
                if (track[static_cast<size_t> (j)] <= 0.0f) continue;
                float d = static_cast<float> (j - i);
                float w = std::exp (-d * d * invTwoSigmaSq);
                wSum += track[static_cast<size_t> (j)] * w;
                wTotal += w;
            }
            smoothed[static_cast<size_t> (i)] = (wTotal > 0.0f) ? wSum / wTotal : track[static_cast<size_t> (i)];
        }
        track = smoothed;
    };

    // Extract per-formant arrays for smoothing
    std::vector<float> f1s (static_cast<size_t> (numFrames)), f2s (static_cast<size_t> (numFrames)),
                        f3s (static_cast<size_t> (numFrames)), f4s (static_cast<size_t> (numFrames));
    for (int f = 0; f < numFrames; ++f)
    {
        f1s[static_cast<size_t> (f)] = tracks[static_cast<size_t> (f)].f1;
        f2s[static_cast<size_t> (f)] = tracks[static_cast<size_t> (f)].f2;
        f3s[static_cast<size_t> (f)] = tracks[static_cast<size_t> (f)].f3;
        f4s[static_cast<size_t> (f)] = tracks[static_cast<size_t> (f)].f4;
    }
    smoothTrack (f1s); smoothTrack (f2s); smoothTrack (f3s); smoothTrack (f4s);
    for (int f = 0; f < numFrames; ++f)
    {
        tracks[static_cast<size_t> (f)].f1 = f1s[static_cast<size_t> (f)];
        tracks[static_cast<size_t> (f)].f2 = f2s[static_cast<size_t> (f)];
        tracks[static_cast<size_t> (f)].f3 = f3s[static_cast<size_t> (f)];
        tracks[static_cast<size_t> (f)].f4 = f4s[static_cast<size_t> (f)];
    }

    juce::Logger::writeToLog ("SinusoidalModel: Extracted formant tracks for " + juce::String (numFrames) + " frames");

    return tracks;
}

// ---------------------------------------------------------------------------
// analyze() — Full pipeline
// ---------------------------------------------------------------------------

// Quick f0 estimation using autocorrelation on a short segment.
// Returns median f0 in Hz, or 0 if no clear pitch found.
static float quickEstimateF0 (const float* audio, int numSamples, double sampleRate)
{
    // Analyze up to 3 segments of ~50ms each from the start, middle, end
    int segmentLen = std::min (static_cast<int> (sampleRate * 0.05), numSamples);
    if (segmentLen < 256)
        return 0.0f;

    std::vector<float> f0Candidates;
    int positions[] = { 0,
                        std::max (0, numSamples / 2 - segmentLen / 2),
                        std::max (0, numSamples - segmentLen) };

    for (int p : positions)
    {
        if (p + segmentLen > numSamples) continue;

        // Simple autocorrelation pitch detection
        int minLag = static_cast<int> (sampleRate / 1000.0); // up to 1000Hz
        int maxLag = static_cast<int> (sampleRate / 60.0);   // down to 60Hz
        maxLag = std::min (maxLag, segmentLen / 2);
        if (minLag >= maxLag) continue;

        float bestCorr = -1.0f;
        int bestLag = minLag;

        for (int lag = minLag; lag <= maxLag; ++lag)
        {
            float sum = 0.0f;
            float normA = 0.0f;
            float normB = 0.0f;
            int len = segmentLen - lag;
            for (int i = 0; i < len; ++i)
            {
                float a = audio[p + i];
                float b = audio[p + i + lag];
                sum += a * b;
                normA += a * a;
                normB += b * b;
            }
            float denom = std::sqrt (normA * normB);
            float corr = (denom > 1e-10f) ? sum / denom : 0.0f;

            if (corr > bestCorr)
            {
                bestCorr = corr;
                bestLag = lag;
            }
        }

        if (bestCorr > 0.5f && bestLag > 0)
            f0Candidates.push_back (static_cast<float> (sampleRate) / static_cast<float> (bestLag));
    }

    if (f0Candidates.empty())
        return 0.0f;

    // Return median
    std::sort (f0Candidates.begin(), f0Candidates.end());
    return f0Candidates[f0Candidates.size() / 2];
}

SinusoidalModel::ProcessResult
SinusoidalModel::analyze (const float* audio, int numSamples, double sampleRate)
{
    ProcessResult result;
    result.numSamples = numSamples;
    result.sampleRate = sampleRate;

    // Step 0: Adaptive FFT size based on estimated f0
    // Male bass (~80Hz) needs FFT 8192+ for resolution, soprano (~1000Hz) needs 2048 for time resolution
    float estimatedF0 = quickEstimateF0 (audio, numSamples, sampleRate);
    if (estimatedF0 > 20.0f)
    {
        // Ensure at least 8 bins per fundamental period
        int idealFFT = static_cast<int> (sampleRate / estimatedF0 * 8.0f);

        // Round up to next power of 2, clamp to [2048, 8192]
        int fftSize = 2048;
        while (fftSize < idealFFT && fftSize < 8192)
            fftSize *= 2;

        tracker_.setFFTSize (fftSize);
        tracker_.setHopSize (fftSize / 8); // 87.5% overlap for smooth OLA

        juce::Logger::writeToLog ("SinusoidalModel: Adaptive FFT size = " + juce::String (fftSize)
                                   + " (estimated f0 = " + juce::String (estimatedF0, 1) + " Hz)");
    }
    else
    {
        // No clear pitch detected — use default 4096
        tracker_.setFFTSize (4096);
        tracker_.setHopSize (512);
    }

    // Step 1: Track partials (with STFT frame storage)
    lastAnalysis_ = tracker_.analyze (audio, numSamples, sampleRate);

    // Step 2: Group into harmonic sets (notes)
    lastGroups_ = groupPartials (lastAnalysis_);

    // No synthesis needed at analysis time — audio is empty
    result.audio = {};

    result.notes = lastGroups_;

    juce::Logger::writeToLog ("SinusoidalModel: Analysis complete — " +
                               juce::String (static_cast<int> (lastGroups_.size())) + " notes, " +
                               juce::String (static_cast<int> (lastAnalysis_.partials.size())) + " partials");

    return result;
}
