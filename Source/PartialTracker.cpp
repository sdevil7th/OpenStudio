#include "PartialTracker.h"
#include <cmath>
#include <algorithm>
#include <numeric>

PartialTracker::PartialTracker() = default;

void PartialTracker::ensureWindow (int size)
{
    if (cachedWindowSize_ == size)
        return;
    cachedWindow_.resize (static_cast<size_t> (size));
    for (int i = 0; i < size; ++i)
        cachedWindow_[static_cast<size_t> (i)] = 0.5f * (1.0f - std::cos (
            2.0f * juce::MathConstants<float>::pi * static_cast<float> (i) / static_cast<float> (size)));
    cachedWindowSize_ = size;
}

float PartialTracker::Partial::avgFrequency() const
{
    if (frames.empty()) return 0.0f;
    float sum = 0.0f;
    for (const auto& f : frames) sum += f.frequency;
    return sum / static_cast<float> (frames.size());
}

float PartialTracker::Partial::avgMagnitude() const
{
    if (frames.empty()) return 0.0f;
    float sum = 0.0f;
    for (const auto& f : frames) sum += f.magnitude;
    return sum / static_cast<float> (frames.size());
}

void PartialTracker::setFFTSize (int fftSize)   { fftSize_ = fftSize; }
void PartialTracker::setHopSize (int hopSize)    { hopSize_ = hopSize; }
void PartialTracker::setMinPeakMagnitude (float magDB) { minPeakMagDB_ = magDB; }
void PartialTracker::setMaxPartials (int max)    { maxPartials_ = max; }
void PartialTracker::setFrequencyMatchThreshold (float hz) { freqMatchThreshold_ = hz; }
void PartialTracker::setMinPartialDuration (int frames) { minPartialDuration_ = frames; }

void PartialTracker::parabolicInterp (float alpha, float beta, float gamma,
                                       float& deltaP, float& interpMag)
{
    // Parabolic interpolation: given magnitudes at bins (k-1, k, k+1)
    // alpha=|X[k-1]|, beta=|X[k]|, gamma=|X[k+1]|
    // Returns fractional bin offset deltaP and interpolated magnitude
    float denom = alpha - 2.0f * beta + gamma;
    if (std::abs (denom) < 1e-10f)
    {
        deltaP = 0.0f;
        interpMag = beta;
        return;
    }
    deltaP = 0.5f * (alpha - gamma) / denom;
    interpMag = beta - 0.25f * (alpha - gamma) * deltaP;
}

std::vector<PartialTracker::SpectralPeak>
PartialTracker::detectPeaks (const std::vector<std::complex<float>>& fftFrame,
                              int fftSize, double sampleRate, float minMagDB, int maxPeaks)
{
    int numBins = fftSize / 2 + 1;
    if (static_cast<int> (fftFrame.size()) < numBins)
        return {};

    float minMagLinear = std::pow (10.0f, minMagDB / 20.0f);
    float binToHz = static_cast<float> (sampleRate) / static_cast<float> (fftSize);

    // Compute magnitudes
    std::vector<float> mags (static_cast<size_t> (numBins));
    for (int b = 0; b < numBins; ++b)
        mags[static_cast<size_t> (b)] = std::abs (fftFrame[static_cast<size_t> (b)]);

    // Find local maxima (bins 1 to numBins-2)
    std::vector<SpectralPeak> peaks;
    peaks.reserve (static_cast<size_t> (maxPeaks));

    for (int b = 1; b < numBins - 1; ++b)
    {
        float m = mags[static_cast<size_t> (b)];
        if (m < minMagLinear)
            continue;
        if (m <= mags[static_cast<size_t> (b - 1)] || m <= mags[static_cast<size_t> (b + 1)])
            continue;

        // Parabolic interpolation for sub-bin precision
        float deltaP = 0.0f;
        float interpMag = m;
        parabolicInterp (mags[static_cast<size_t> (b - 1)], m, mags[static_cast<size_t> (b + 1)],
                         deltaP, interpMag);

        SpectralPeak peak;
        peak.bin = b;
        peak.frequency = (static_cast<float> (b) + deltaP) * binToHz;
        peak.magnitude = interpMag;
        peak.phase = std::arg (fftFrame[static_cast<size_t> (b)]);
        peaks.push_back (peak);
    }

    // Sort by magnitude descending and keep top maxPeaks
    std::sort (peaks.begin(), peaks.end(),
               [] (const SpectralPeak& a, const SpectralPeak& b) { return a.magnitude > b.magnitude; });

    if (static_cast<int> (peaks.size()) > maxPeaks)
        peaks.resize (static_cast<size_t> (maxPeaks));

    // Re-sort by frequency for tracking
    std::sort (peaks.begin(), peaks.end(),
               [] (const SpectralPeak& a, const SpectralPeak& b) { return a.frequency < b.frequency; });

    return peaks;
}

std::vector<PartialTracker::SpectralPeak>
PartialTracker::detectPeaksReassigned (
    const std::vector<std::complex<float>>& currentFrame,
    const std::vector<std::complex<float>>& prevFrame,
    int fftSize, int hopSize, double sampleRate, float minMagDB, int maxPeaks)
{
    // Reassigned frequency estimation via phase difference between consecutive frames.
    // Instantaneous frequency = (phase_diff / (2π * hopTime))
    // This gives ~0.1Hz precision at any frequency, vs parabolic's ~5Hz at low f0.

    int numBins = fftSize / 2 + 1;
    if (static_cast<int> (currentFrame.size()) < numBins ||
        static_cast<int> (prevFrame.size()) < numBins)
        return detectPeaks (currentFrame, fftSize, sampleRate, minMagDB, maxPeaks);

    float minMagLinear = std::pow (10.0f, minMagDB / 20.0f);
    float binToHz = static_cast<float> (sampleRate) / static_cast<float> (fftSize);
    float hopTime = static_cast<float> (hopSize) / static_cast<float> (sampleRate);
    const float twoPi = 2.0f * juce::MathConstants<float>::pi;

    // Compute magnitudes
    std::vector<float> mags (static_cast<size_t> (numBins));
    for (int b = 0; b < numBins; ++b)
        mags[static_cast<size_t> (b)] = std::abs (currentFrame[static_cast<size_t> (b)]);

    // Find local maxima
    std::vector<SpectralPeak> peaks;
    peaks.reserve (static_cast<size_t> (maxPeaks));

    for (int b = 1; b < numBins - 1; ++b)
    {
        float m = mags[static_cast<size_t> (b)];
        if (m < minMagLinear)
            continue;
        if (m <= mags[static_cast<size_t> (b - 1)] || m <= mags[static_cast<size_t> (b + 1)])
            continue;

        // Phase difference for instantaneous frequency
        float prevPhase = std::arg (prevFrame[static_cast<size_t> (b)]);
        float currPhase = std::arg (currentFrame[static_cast<size_t> (b)]);

        // Expected phase advance for bin center frequency
        float expectedBinFreq = static_cast<float> (b) * binToHz;
        float expectedPhaseAdv = twoPi * expectedBinFreq * hopTime;

        // Phase deviation from expected = frequency deviation
        float phaseDev = currPhase - prevPhase - expectedPhaseAdv;
        // Wrap to [-pi, pi]
        phaseDev = phaseDev - twoPi * std::round (phaseDev / twoPi);

        // True frequency = bin frequency + deviation
        float trueFreq = expectedBinFreq + phaseDev / (twoPi * hopTime);

        // Sanity check: reassigned freq should be near the bin frequency
        // If it's wildly off (noise), fall back to parabolic
        if (trueFreq < 0.0f || std::abs (trueFreq - expectedBinFreq) > binToHz * 2.0f)
        {
            float deltaP = 0.0f;
            float interpMag = m;
            parabolicInterp (mags[static_cast<size_t> (b - 1)], m, mags[static_cast<size_t> (b + 1)],
                             deltaP, interpMag);
            trueFreq = (static_cast<float> (b) + deltaP) * binToHz;
            m = interpMag;
        }

        SpectralPeak peak;
        peak.bin = b;
        peak.frequency = trueFreq;
        peak.magnitude = m;
        peak.phase = currPhase;
        peaks.push_back (peak);
    }

    // Sort by magnitude descending and keep top maxPeaks
    std::sort (peaks.begin(), peaks.end(),
               [] (const SpectralPeak& a, const SpectralPeak& b) { return a.magnitude > b.magnitude; });

    if (static_cast<int> (peaks.size()) > maxPeaks)
        peaks.resize (static_cast<size_t> (maxPeaks));

    // Re-sort by frequency for tracking
    std::sort (peaks.begin(), peaks.end(),
               [] (const SpectralPeak& a, const SpectralPeak& b) { return a.frequency < b.frequency; });

    return peaks;
}

// Wrap phase difference into [-pi, pi]
static float wrapPhase (float phase)
{
    const float twoPi = 2.0f * juce::MathConstants<float>::pi;
    while (phase > juce::MathConstants<float>::pi) phase -= twoPi;
    while (phase < -juce::MathConstants<float>::pi) phase += twoPi;
    return phase;
}

void PartialTracker::matchPeaks (const std::vector<SpectralPeak>& peaks,
                                  std::vector<Partial>& activePartials,
                                  std::vector<Partial>& completedPartials,
                                  int currentFrame,
                                  double sampleRate)
{
    // Phase-coherent multi-feature matching (improved McAulay-Quatieri).
    // Cost = w_freq * |freq_diff / threshold| + w_phase * |phase_diff / pi| + w_mag * |mag_ratio|
    // Phase prediction: expected_phase = last_phase + 2π * last_freq * hop_time
    // This is the strongest continuity cue — if phase matches, it's the same partial.

    const float wFreq  = 1.0f;
    const float wPhase = 0.5f;
    const float wMag   = 0.3f;
    const float twoPi  = 2.0f * juce::MathConstants<float>::pi;
    const float hopTime = static_cast<float> (hopSize_) / static_cast<float> (sampleRate);

    std::vector<bool> peakMatched (peaks.size(), false);
    std::vector<bool> partialMatched (activePartials.size(), false);

    struct Match
    {
        int partialIdx;
        int peakIdx;
        float cost;
    };

    std::vector<Match> candidates;
    candidates.reserve (activePartials.size() * peaks.size());

    for (size_t p = 0; p < activePartials.size(); ++p)
    {
        const auto& lastFrame = activePartials[p].frames.back();
        float lastFreq = lastFrame.frequency;
        float lastPhase = lastFrame.phase;
        float lastMag = lastFrame.magnitude;

        // Predicted phase for this hop
        float expectedPhase = lastPhase + twoPi * lastFreq * hopTime;

        for (size_t pk = 0; pk < peaks.size(); ++pk)
        {
            float freqDist = std::abs (peaks[pk].frequency - lastFreq);
            if (freqDist > freqMatchThreshold_)
                continue;

            // Frequency cost: normalized by threshold
            float freqCost = freqDist / freqMatchThreshold_;

            // Phase cost: difference between measured and expected phase, normalized to [0, 1]
            float phaseDiff = std::abs (wrapPhase (peaks[pk].phase - expectedPhase));
            float phaseCost = phaseDiff / juce::MathConstants<float>::pi;

            // Magnitude cost: log ratio (0 = same magnitude)
            float magRatio = (lastMag > 1e-10f)
                ? std::abs (std::log (std::max (peaks[pk].magnitude, 1e-10f) / lastMag))
                : 0.0f;
            float magCost = std::min (magRatio, 3.0f) / 3.0f; // normalize to [0, 1]

            float totalCost = wFreq * freqCost + wPhase * phaseCost + wMag * magCost;
            candidates.push_back ({ static_cast<int> (p), static_cast<int> (pk), totalCost });
        }
    }

    // Sort by cost (greedy matching — lowest cost first)
    std::sort (candidates.begin(), candidates.end(),
               [] (const Match& a, const Match& b) { return a.cost < b.cost; });

    // Assign matches greedily
    for (const auto& m : candidates)
    {
        if (partialMatched[static_cast<size_t> (m.partialIdx)] ||
            peakMatched[static_cast<size_t> (m.peakIdx)])
            continue;

        partialMatched[static_cast<size_t> (m.partialIdx)] = true;
        peakMatched[static_cast<size_t> (m.peakIdx)] = true;

        const auto& pk = peaks[static_cast<size_t> (m.peakIdx)];
        PartialFrame frame;
        frame.frequency = pk.frequency;
        frame.magnitude = pk.magnitude;
        frame.phase = pk.phase;
        activePartials[static_cast<size_t> (m.partialIdx)].frames.push_back (frame);
    }

    // Kill unmatched partials (death)
    for (int p = static_cast<int> (activePartials.size()) - 1; p >= 0; --p)
    {
        if (! partialMatched[static_cast<size_t> (p)])
        {
            activePartials[static_cast<size_t> (p)].deathFrame = currentFrame;
            completedPartials.push_back (std::move (activePartials[static_cast<size_t> (p)]));
            activePartials.erase (activePartials.begin() + p);
        }
    }

    // Birth new partials for unmatched peaks
    for (size_t pk = 0; pk < peaks.size(); ++pk)
    {
        if (peakMatched[pk])
            continue;

        Partial newPartial;
        newPartial.id = nextPartialId_++;
        newPartial.birthFrame = currentFrame;

        PartialFrame frame;
        frame.frequency = peaks[pk].frequency;
        frame.magnitude = peaks[pk].magnitude;
        frame.phase = peaks[pk].phase;
        newPartial.frames.push_back (frame);

        activePartials.push_back (std::move (newPartial));
    }
}

PartialTracker::AnalysisResult
PartialTracker::analyze (const float* audio, int numSamples, double sampleRate)
{
    nextPartialId_ = 0;

    AnalysisResult result;
    result.fftSize = fftSize_;
    result.hopSize = hopSize_;
    result.sampleRate = sampleRate;

    int numBins = fftSize_ / 2 + 1;
    juce::ignoreUnused (numBins);

    // 10.4: Use pre-computed Hann window (cached across analyze() calls)
    ensureWindow (fftSize_);
    const auto& window = cachedWindow_;

    // JUCE FFT (expects interleaved real/imag array of size fftSize*2)
    juce::dsp::FFT fft (static_cast<int> (std::log2 (fftSize_)));
    std::vector<float> fftWorkspace (static_cast<size_t> (fftSize_ * 2), 0.0f);

    std::vector<Partial> activePartials;
    std::vector<Partial> completedPartials;

    // Pre-estimate frame count for STFT storage
    int estimatedFrames = (numSamples - fftSize_) / hopSize_ + 1;
    if (estimatedFrames > 0)
        result.stftFrames.reserve (static_cast<size_t> (estimatedFrames));

    int numFrames = 0;
    for (int pos = 0; pos + fftSize_ <= numSamples; pos += hopSize_)
    {
        // Window the input — pack real samples into positions 0..N-1 as required by
        // performRealOnlyForwardTransform (reads d[0..N-1] as N real samples, NOT interleaved)
        for (int i = 0; i < fftSize_; ++i)
            fftWorkspace[static_cast<size_t> (i)] = audio[pos + i] * window[static_cast<size_t> (i)];

        // Forward FFT
        fft.performRealOnlyForwardTransform (fftWorkspace.data(), true);

        // Convert to complex for peak detection and store for residual extraction
        int nb = fftSize_ / 2 + 1;
        std::vector<std::complex<float>> complexFrame (static_cast<size_t> (nb));
        for (int b = 0; b < nb; ++b)
        {
            complexFrame[static_cast<size_t> (b)] = {
                fftWorkspace[static_cast<size_t> (b * 2)],
                fftWorkspace[static_cast<size_t> (b * 2 + 1)]
            };
        }

        // Store STFT frame for spectral residual extraction later
        result.stftFrames.push_back (complexFrame);

        // Detect peaks — use reassigned frequency if previous frame available
        std::vector<SpectralPeak> peaks;
        if (result.stftFrames.size() >= 2)
        {
            const auto& prevFrame = result.stftFrames[result.stftFrames.size() - 2];
            peaks = detectPeaksReassigned (complexFrame, prevFrame,
                                            fftSize_, hopSize_, sampleRate, minPeakMagDB_, maxPartials_);
        }
        else
        {
            peaks = detectPeaks (complexFrame, fftSize_, sampleRate, minPeakMagDB_, maxPartials_);
        }

        // Track partials (phase-coherent matching)
        matchPeaks (peaks, activePartials, completedPartials, numFrames, sampleRate);

        ++numFrames;
    }

    // Close all remaining active partials
    for (auto& p : activePartials)
    {
        p.deathFrame = numFrames;
        completedPartials.push_back (std::move (p));
    }
    activePartials.clear();

    // Filter out short-lived partials (noise)
    result.partials.reserve (completedPartials.size());
    for (auto& p : completedPartials)
    {
        if (p.lifespan() >= minPartialDuration_)
            result.partials.push_back (std::move (p));
    }

    result.numFrames = numFrames;

    juce::Logger::writeToLog ("PartialTracker: Analyzed " + juce::String (numSamples) +
                               " samples, " + juce::String (numFrames) + " frames, " +
                               juce::String (static_cast<int> (result.partials.size())) + " partials tracked");

    return result;
}
