#include "PeakCache.h"

// Static constexpr definitions (required for ODR-use in C++17)
constexpr int PeakCache::LEVEL_STRIDES[NUM_LEVELS];

PeakCache::PeakCache() {}

PeakCache::~PeakCache()
{
    backgroundPool.removeAllJobs(true, 5000);
}

juce::File PeakCache::getPeakFilePath(const juce::File& audioFile)
{
    return audioFile.getSiblingFile(audioFile.getFileName() + ".s13peaks");
}

bool PeakCache::hasCachedPeaks(const juce::File& audioFile) const
{
    // Check memory cache first
    {
        const juce::ScopedLock sl(cacheLock);
        if (memoryCache.count(audioFile.getFullPathName()) > 0)
            return true;
    }

    // Check disk
    auto peakFile = getPeakFilePath(audioFile);
    if (!peakFile.existsAsFile())
        return false;

    // Validate header (quick check: magic, version, source file size/time)
    juce::FileInputStream fis(peakFile);
    if (!fis.openedOk() || fis.getTotalLength() < (juce::int64)sizeof(PeakFileHeader))
        return false;

    PeakFileHeader header;
    if (fis.read(&header, sizeof(header)) != sizeof(header))
        return false;

    if (header.magic != MAGIC || header.version != VERSION)
        return false;

    // Check if source file matches
    if (header.sourceFileSize != audioFile.getSize())
        return false;

    if (header.sourceModTimeMs != audioFile.getLastModificationTime().toMilliseconds())
        return false;

    return true;
}

juce::var PeakCache::getPeaks(const juce::File& audioFile,
                               int samplesPerPixel,
                               int numPixels) const
{
    juce::Array<juce::var> peakData;

    CacheEntry entry;
    bool loaded = false;

    // Try memory cache
    {
        const juce::ScopedLock sl(cacheLock);
        auto it = memoryCache.find(audioFile.getFullPathName());
        if (it != memoryCache.end())
        {
            entry = it->second;
            loaded = true;
        }
    }

    // Try loading from disk
    if (!loaded)
    {
        auto peakFile = getPeakFilePath(audioFile);
        if (peakFile.existsAsFile() && loadFromFile(peakFile, audioFile, entry))
        {
            loaded = true;
            // Store in memory cache for next time
            const juce::ScopedLock sl(cacheLock);
            memoryCache[audioFile.getFullPathName()] = entry;
        }
    }

    if (!loaded || entry.levels.empty())
        return peakData;

    // Find the best mipmap level (closest stride <= samplesPerPixel)
    const MipmapLevel* bestLevel = &entry.levels[0];
    for (const auto& level : entry.levels)
    {
        if (level.stride <= samplesPerPixel)
            bestLevel = &level;
    }

    // Calculate how many source peaks we need per output pixel
    int ratio = samplesPerPixel / bestLevel->stride;
    if (ratio < 1) ratio = 1;

    int numChannels = bestLevel->numChannels;
    int actualPeaks = std::min(numPixels, bestLevel->numPeaks / std::max(1, ratio));

    peakData.ensureStorageAllocated(1 + actualPeaks * numChannels * 2);
    peakData.add(juce::var(numChannels));  // Header

    int stride2 = numChannels * 2;  // Floats per peak entry in the data array

    for (int pixel = 0; pixel < actualPeaks; ++pixel)
    {
        int srcStart = pixel * ratio;
        int srcEnd = std::min(srcStart + ratio, bestLevel->numPeaks);

        for (int ch = 0; ch < numChannels; ++ch)
        {
            float minVal = 0.0f;
            float maxVal = 0.0f;

            for (int s = srcStart; s < srcEnd; ++s)
            {
                int dataIdx = s * stride2 + ch * 2;
                if (dataIdx + 1 < (int)bestLevel->data.size())
                {
                    float mn = bestLevel->data[static_cast<size_t>(dataIdx)];
                    float mx = bestLevel->data[static_cast<size_t>(dataIdx) + 1];
                    if (s == srcStart || mn < minVal) minVal = mn;
                    if (s == srcStart || mx > maxVal) maxVal = mx;
                }
            }

            peakData.add(juce::var(minVal));
            peakData.add(juce::var(maxVal));
        }
    }

    return peakData;
}

bool PeakCache::loadFromFile(const juce::File& peakFile, const juce::File& audioFile, CacheEntry& entry) const
{
    juce::FileInputStream fis(peakFile);
    if (!fis.openedOk())
        return false;

    PeakFileHeader header;
    if (fis.read(&header, sizeof(header)) != sizeof(header))
        return false;

    if (header.magic != MAGIC || header.version != VERSION)
        return false;

    // Validate source file hasn't changed
    if (header.sourceFileSize != audioFile.getSize() ||
        header.sourceModTimeMs != audioFile.getLastModificationTime().toMilliseconds())
        return false;

    entry.numChannels = header.numChannels;
    entry.sampleRate = header.sampleRate;
    entry.totalSamples = header.totalSamples;
    entry.levels.resize(static_cast<size_t>(header.numLevels));

    for (int i = 0; i < header.numLevels; ++i)
    {
        int32_t stride = 0, numPeaks = 0;
        if (fis.read(&stride, sizeof(stride)) != sizeof(stride)) return false;
        if (fis.read(&numPeaks, sizeof(numPeaks)) != sizeof(numPeaks)) return false;

        auto& level = entry.levels[static_cast<size_t>(i)];
        level.stride = stride;
        level.numPeaks = numPeaks;
        level.numChannels = header.numChannels;

        size_t floatCount = static_cast<size_t>(numPeaks) * static_cast<size_t>(header.numChannels) * 2;
        level.data.resize(floatCount);

        size_t bytesToRead = floatCount * sizeof(float);
        if (fis.read(level.data.data(), static_cast<int>(bytesToRead)) != static_cast<int>(bytesToRead))
            return false;
    }

    return true;
}

bool PeakCache::writeToFile(const juce::File& peakFile, const CacheEntry& entry,
                             int64_t sourceFileSize, int64_t sourceModTimeMs)
{
    juce::FileOutputStream fos(peakFile);
    if (!fos.openedOk())
        return false;

    fos.setPosition(0);
    fos.truncate();

    PeakFileHeader header;
    header.magic = MAGIC;
    header.version = VERSION;
    header.sourceFileSize = sourceFileSize;
    header.sourceModTimeMs = sourceModTimeMs;
    header.sampleRate = entry.sampleRate;
    header.numChannels = entry.numChannels;
    header.totalSamples = entry.totalSamples;
    header.numLevels = static_cast<int32_t>(entry.levels.size());

    fos.write(&header, sizeof(header));

    for (const auto& level : entry.levels)
    {
        int32_t stride = level.stride;
        int32_t numPeaks = level.numPeaks;
        fos.write(&stride, sizeof(stride));
        fos.write(&numPeaks, sizeof(numPeaks));
        fos.write(level.data.data(), level.data.size() * sizeof(float));
    }

    fos.flush();
    return true;
}

bool PeakCache::buildPeaks(const juce::File& audioFile, CacheEntry& entry)
{
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (!reader)
        return false;

    int numChannels = static_cast<int>(reader->numChannels);
    juce::int64 totalSamples = reader->lengthInSamples;
    double sampleRate = reader->sampleRate;

    entry.numChannels = numChannels;
    entry.sampleRate = sampleRate;
    entry.totalSamples = totalSamples;
    entry.levels.resize(NUM_LEVELS);

    // Build finest level (stride 64) first by reading the entire file in chunks
    const int CHUNK_SIZE = 65536;  // Read 64K samples at a time
    juce::AudioBuffer<float> readBuffer(numChannels, CHUNK_SIZE);

    // Pre-allocate all levels
    for (int lvl = 0; lvl < NUM_LEVELS; ++lvl)
    {
        auto& level = entry.levels[static_cast<size_t>(lvl)];
        level.stride = LEVEL_STRIDES[lvl];
        level.numChannels = numChannels;
        level.numPeaks = static_cast<int>((totalSamples + LEVEL_STRIDES[lvl] - 1) / LEVEL_STRIDES[lvl]);
        level.data.resize(static_cast<size_t>(level.numPeaks) * static_cast<size_t>(numChannels) * 2, 0.0f);
    }

    // Single pass through the file: compute all mipmap levels simultaneously
    juce::int64 samplesRead = 0;

    // Per-level accumulators
    struct LevelAcc
    {
        int sampleCount = 0;
        int peakIndex = 0;
        std::vector<float> chMin;
        std::vector<float> chMax;
    };
    std::vector<LevelAcc> accs(NUM_LEVELS);
    for (int lvl = 0; lvl < NUM_LEVELS; ++lvl)
    {
        accs[static_cast<size_t>(lvl)].chMin.assign(static_cast<size_t>(numChannels), 0.0f);
        accs[static_cast<size_t>(lvl)].chMax.assign(static_cast<size_t>(numChannels), 0.0f);
    }

    while (samplesRead < totalSamples)
    {
        int samplesToRead = static_cast<int>(std::min(static_cast<juce::int64>(CHUNK_SIZE),
                                                       totalSamples - samplesRead));
        readBuffer.clear();
        reader->read(&readBuffer, 0, samplesToRead, samplesRead, true, true);

        // Process each sample
        for (int s = 0; s < samplesToRead; ++s)
        {
            for (int lvl = 0; lvl < NUM_LEVELS; ++lvl)
            {
                auto& acc = accs[static_cast<size_t>(lvl)];
                auto& level = entry.levels[static_cast<size_t>(lvl)];

                // Initialize min/max on first sample of each peak window
                if (acc.sampleCount == 0)
                {
                    for (int ch = 0; ch < numChannels; ++ch)
                    {
                        float val = readBuffer.getSample(ch, s);
                        acc.chMin[static_cast<size_t>(ch)] = val;
                        acc.chMax[static_cast<size_t>(ch)] = val;
                    }
                }
                else
                {
                    for (int ch = 0; ch < numChannels; ++ch)
                    {
                        float val = readBuffer.getSample(ch, s);
                        if (val < acc.chMin[static_cast<size_t>(ch)]) acc.chMin[static_cast<size_t>(ch)] = val;
                        if (val > acc.chMax[static_cast<size_t>(ch)]) acc.chMax[static_cast<size_t>(ch)] = val;
                    }
                }

                acc.sampleCount++;

                // Flush peak when stride reached
                if (acc.sampleCount >= LEVEL_STRIDES[lvl])
                {
                    if (acc.peakIndex < level.numPeaks)
                    {
                        int dataIdx = acc.peakIndex * numChannels * 2;
                        for (int ch = 0; ch < numChannels; ++ch)
                        {
                            level.data[static_cast<size_t>(dataIdx + ch * 2)] = acc.chMin[static_cast<size_t>(ch)];
                            level.data[static_cast<size_t>(dataIdx + ch * 2 + 1)] = acc.chMax[static_cast<size_t>(ch)];
                        }
                    }
                    acc.peakIndex++;
                    acc.sampleCount = 0;
                }
            }
        }

        samplesRead += samplesToRead;
    }

    // Flush any remaining partial windows
    for (int lvl = 0; lvl < NUM_LEVELS; ++lvl)
    {
        auto& acc = accs[static_cast<size_t>(lvl)];
        auto& level = entry.levels[static_cast<size_t>(lvl)];

        if (acc.sampleCount > 0 && acc.peakIndex < level.numPeaks)
        {
            int dataIdx = acc.peakIndex * numChannels * 2;
            for (int ch = 0; ch < numChannels; ++ch)
            {
                level.data[static_cast<size_t>(dataIdx + ch * 2)] = acc.chMin[static_cast<size_t>(ch)];
                level.data[static_cast<size_t>(dataIdx + ch * 2 + 1)] = acc.chMax[static_cast<size_t>(ch)];
            }
        }
    }

    return true;
}

bool PeakCache::generateSync(const juce::File& audioFile)
{
    CacheEntry entry;
    if (!buildPeaks(audioFile, entry))
        return false;

    // Write to disk
    auto peakFile = getPeakFilePath(audioFile);
    bool written = writeToFile(peakFile, entry,
                                audioFile.getSize(),
                                audioFile.getLastModificationTime().toMilliseconds());

    // Store in memory cache
    {
        const juce::ScopedLock sl(cacheLock);
        memoryCache[audioFile.getFullPathName()] = std::move(entry);
    }

    if (written)
        juce::Logger::writeToLog("PeakCache: Generated peaks for " + audioFile.getFileName());

    return written;
}

void PeakCache::generateAsync(const juce::File& audioFile, std::function<void()> onComplete)
{
    // If already cached, call completion immediately
    if (hasCachedPeaks(audioFile))
    {
        if (onComplete)
            juce::MessageManager::callAsync(onComplete);
        return;
    }

    // Queue background generation
    backgroundPool.addJob([this, audioFile, onComplete]()
    {
        generateSync(audioFile);

        if (onComplete)
            juce::MessageManager::callAsync(onComplete);
    });
}
