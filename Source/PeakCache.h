#pragma once

#include <JuceHeader.h>
#include <memory>
#include <map>
#include <set>
#include <functional>

/**
 * PeakCache — REAPER-inspired multi-resolution peak file system.
 *
 * Generates `.ospeaks` sidecar files alongside audio files containing
 * pre-computed min/max peak data at multiple resolution levels (mipmaps).
 * This eliminates the need to read audio files for waveform display —
 * scrolling and zooming are instant regardless of file length.
 *
 * Mipmap levels (samples per peak): 64, 256, 1024, 4096
 * File format: header + flat float arrays per level (memory-mappable).
 */
class PeakCache
{
public:
    PeakCache();
    ~PeakCache();

    /**
     * Get peaks at a given resolution.  Picks the closest mipmap level
     * that is at or finer than the requested samplesPerPixel.
     *
     * Returns a flat juce::var array:
     *   [numChannels, min_ch0_px0, max_ch0_px0, min_ch1_px0, max_ch1_px0, ...]
     *
     * Returns an empty array if no cache exists yet (call generateAsync first).
     */
    /** startSample: first sample of the audio file to include (0 = from beginning).
     *  This enables viewport-based fetching — only return peaks for the visible window. */
    juce::var getPeaks(const juce::File& audioFile,
                       int samplesPerPixel,
                       int startSample,
                       int numPixels) const;

    /** Check if a valid, up-to-date cache exists for this audio file. */
    bool hasCachedPeaks(const juce::File& audioFile) const;

    /**
     * Generate peak cache on a background thread.
     * Calls onComplete (on the message thread) when done.
     * If a cache already exists and is up-to-date, calls onComplete immediately.
     */
    void generateAsync(const juce::File& audioFile,
                       std::function<void()> onComplete = nullptr);

    /**
     * Generate peak cache synchronously (blocks the calling thread).
     * Use this for offline rendering or when you need peaks immediately.
     */
    bool generateSync(const juce::File& audioFile);

private:
    // Mipmap resolution levels (samples per peak)
    static constexpr int NUM_LEVELS = 4;
    static constexpr int LEVEL_STRIDES[NUM_LEVELS] = { 64, 256, 1024, 4096 };

    // Peak file magic number and version
    static constexpr uint32_t MAGIC = 0x53313350;  // "S13P"
    static constexpr uint32_t VERSION = 1;

    // File header structure (written to .ospeaks)
    struct PeakFileHeader
    {
        uint32_t magic;
        uint32_t version;
        int64_t  sourceFileSize;      // For invalidation
        int64_t  sourceModTimeMs;     // For invalidation
        double   sampleRate;
        int32_t  numChannels;
        int64_t  totalSamples;
        int32_t  numLevels;
        // Followed by: for each level: int32_t stride, int32_t numPeaks, then float[numPeaks * numChannels * 2]
    };

    // In-memory representation of a single mipmap level
    struct MipmapLevel
    {
        int stride = 0;      // Samples per peak
        int numPeaks = 0;
        int numChannels = 0;
        std::vector<float> data;  // Flat: [min_ch0, max_ch0, min_ch1, max_ch1, ...] × numPeaks
    };

    // In-memory cache entry for a loaded peak file
    struct CacheEntry
    {
        int numChannels = 0;
        double sampleRate = 0.0;
        juce::int64 totalSamples = 0;
        std::vector<MipmapLevel> levels;
    };

    // Get the .ospeaks file path for an audio file
    static juce::File getPeakFilePath(const juce::File& audioFile);
    static juce::File getLegacyPeakFilePath(const juce::File& audioFile);

    // Load peak data from a peak cache file into memory
    bool loadFromFile(const juce::File& peakFile, const juce::File& audioFile, CacheEntry& entry) const;

    // Write peak data to a peak cache file
    static bool writeToFile(const juce::File& peakFile, const CacheEntry& entry,
                            int64_t sourceFileSize, int64_t sourceModTimeMs);

    // Generate all mipmap levels from an audio file
    static bool buildPeaks(const juce::File& audioFile, CacheEntry& entry);

    // In-memory cache: audioFilePath -> CacheEntry
    mutable std::map<juce::String, CacheEntry> memoryCache;
    mutable juce::CriticalSection cacheLock;

    // Track files currently being generated to prevent duplicate jobs
    std::set<juce::String> pendingGenerations;
    juce::CriticalSection pendingLock;

    // Background thread pool for concurrent peak generation
    juce::ThreadPool backgroundPool { juce::jmax(2, juce::SystemStats::getNumCpus() / 2) };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PeakCache)
};
