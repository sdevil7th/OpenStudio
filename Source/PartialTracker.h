#pragma once

#include <JuceHeader.h>
#include <vector>
#include <complex>

/**
 * PartialTracker — Sinusoidal peak detection and partial tracking across STFT frames.
 *
 * Implements the McAulay-Quatieri algorithm for tracking spectral peaks (partials)
 * across consecutive STFT frames by frequency proximity matching. This is the
 * foundation of Spectral Modeling Synthesis (SMS) used in Melodyne DNA.
 *
 * Pipeline:
 *   1. Peak detection: find local maxima in magnitude spectrum
 *   2. Parabolic interpolation: refine peak frequency and magnitude
 *   3. Frame-to-frame matching: connect peaks into continuous partials
 *   4. Birth/death logic: create new partials, terminate lost ones
 */
class PartialTracker
{
public:
    PartialTracker();

    struct SpectralPeak
    {
        float frequency = 0.0f;   // Hz (parabolic-interpolated)
        float magnitude = 0.0f;   // Linear magnitude
        float phase     = 0.0f;   // Radians
        int   bin       = 0;      // Original FFT bin index
    };

    struct PartialFrame
    {
        float frequency = 0.0f;   // Hz
        float magnitude = 0.0f;   // Linear
        float phase     = 0.0f;   // Radians
    };

    struct Partial
    {
        int id = 0;                            // Unique partial ID
        int birthFrame = 0;                    // Frame where partial was born
        int deathFrame = -1;                   // Frame where partial died (-1 = still alive)
        std::vector<PartialFrame> frames;      // Per-frame data (indexed by frame number relative to birth)

        bool isAlive() const { return deathFrame < 0; }
        int  lifespan() const { return static_cast<int> (frames.size()); }
        float avgFrequency() const;
        float avgMagnitude() const;
    };

    struct AnalysisResult
    {
        std::vector<Partial> partials;
        int numFrames = 0;
        int fftSize   = 0;
        int hopSize   = 0;
        double sampleRate = 0.0;

        // Stored STFT frames for spectral residual extraction
        std::vector<std::vector<std::complex<float>>> stftFrames; // [frame][bin]
    };

    // Configure analysis parameters
    void setFFTSize (int fftSize);
    void setHopSize (int hopSize);
    void setMinPeakMagnitude (float magDB);     // Threshold in dB (default -80)
    void setMaxPartials (int max);               // Max simultaneous partials per frame
    void setFrequencyMatchThreshold (float hz);  // Max Hz difference for matching (default 50)
    void setMinPartialDuration (int frames);     // Min frames for a partial to be kept (default 3)

    // Analyze audio and return tracked partials
    AnalysisResult analyze (const float* audio, int numSamples, double sampleRate);

    // Extract peaks from a single STFT frame (parabolic interpolation)
    static std::vector<SpectralPeak> detectPeaks (
        const std::vector<std::complex<float>>& fftFrame,
        int fftSize, double sampleRate, float minMagDB, int maxPeaks);

    // Extract peaks using reassigned frequency estimation (phase difference between frames)
    // Provides ~0.1Hz precision regardless of FFT size, vs ~5Hz for parabolic at low f0
    static std::vector<SpectralPeak> detectPeaksReassigned (
        const std::vector<std::complex<float>>& currentFrame,
        const std::vector<std::complex<float>>& prevFrame,
        int fftSize, int hopSize, double sampleRate, float minMagDB, int maxPeaks);

private:
    int fftSize_   = 4096;
    int hopSize_   = 512;
    float minPeakMagDB_   = -80.0f;
    int maxPartials_      = 100;
    float freqMatchThreshold_ = 50.0f; // Hz
    int minPartialDuration_   = 3;     // frames

    int nextPartialId_ = 0;

    // 10.4: Pre-computed Hann window (regenerated when FFT size changes)
    std::vector<float> cachedWindow_;
    int cachedWindowSize_ = 0;
    void ensureWindow (int size);

    // Track peaks across frames: match current peaks to active partials
    void matchPeaks (
        const std::vector<SpectralPeak>& peaks,
        std::vector<Partial>& activePartials,
        std::vector<Partial>& completedPartials,
        int currentFrame,
        double sampleRate);

    // Parabolic interpolation around a peak bin
    static void parabolicInterp (float alpha, float beta, float gamma,
                                 float& deltaP, float& interpMag);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PartialTracker)
};
