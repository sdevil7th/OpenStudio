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
    return audioFile.getSiblingFile(audioFile.getFileName() + ".ospeaks");
}

juce::File PeakCache::getLegacyPeakFilePath(const juce::File& audioFile)
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
        peakFile = getLegacyPeakFilePath(audioFile);

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
                               int startSample,
                               int numPixels) const
{
    auto buildResult = [samplesPerPixel, startSample, numPixels](const CacheEntry& entry)
    {
        juce::Array<juce::var> peakData;
        if (entry.levels.empty())
            return juce::var(peakData);

        // Find the best mipmap level (closest stride <= samplesPerPixel)
        const MipmapLevel* bestLevel = &entry.levels[0];
        for (const auto& level : entry.levels)
        {
            if (level.stride <= samplesPerPixel)
                bestLevel = &level;
        }

        int ratio = samplesPerPixel / bestLevel->stride;
        if (ratio < 1) ratio = 1;

        const int numChannels = bestLevel->numChannels;
        const int startPeak = (startSample > 0) ? std::min(startSample / bestLevel->stride, bestLevel->numPeaks - 1) : 0;
        const int remainingMipmapPeaks = std::max(0, bestLevel->numPeaks - startPeak);
        const int actualPeaks = std::min(numPixels, remainingMipmapPeaks / std::max(1, ratio));

        peakData.ensureStorageAllocated(1 + actualPeaks * numChannels * 2);
        peakData.add(juce::var(numChannels));

        const int stride2 = numChannels * 2;
        for (int pixel = 0; pixel < actualPeaks; ++pixel)
        {
            const int srcStart = startPeak + pixel * ratio;
            const int srcEnd = std::min(srcStart + ratio, bestLevel->numPeaks);

            for (int ch = 0; ch < numChannels; ++ch)
            {
                float minVal = 0.0f;
                float maxVal = 0.0f;

                for (int s = srcStart; s < srcEnd; ++s)
                {
                    const int dataIdx = s * stride2 + ch * 2;
                    if (dataIdx + 1 < static_cast<int>(bestLevel->data.size()))
                    {
                        const float mn = bestLevel->data[static_cast<size_t>(dataIdx)];
                        const float mx = bestLevel->data[static_cast<size_t>(dataIdx) + 1];
                        if (s == srcStart || mn < minVal) minVal = mn;
                        if (s == srcStart || mx > maxVal) maxVal = mx;
                    }
                }

                peakData.add(juce::var(minVal));
                peakData.add(juce::var(maxVal));
            }
        }

        return juce::var(peakData);
    };

    {
        const juce::ScopedLock sl(cacheLock);
        auto it = memoryCache.find(audioFile.getFullPathName());
        if (it != memoryCache.end())
            return buildResult(it->second);
    }

    CacheEntry entry;
    auto peakFile = getPeakFilePath(audioFile);
    if (!peakFile.existsAsFile())
        peakFile = getLegacyPeakFilePath(audioFile);

    if (!peakFile.existsAsFile() || !loadFromFile(peakFile, audioFile, entry))
        return juce::var(juce::Array<juce::var>());

    auto result = buildResult(entry);
    {
        const juce::ScopedLock sl(cacheLock);
        memoryCache[audioFile.getFullPathName()] = std::move(entry);
    }
    return result;
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

    // Build the finest level once, then derive coarser levels from it.  The old
    // path updated every mip level for every decoded sample, multiplying import
    // peak-build CPU by NUM_LEVELS.
    const int CHUNK_SIZE = 65536;  // Read 64K samples at a time
    juce::AudioBuffer<float> readBuffer(numChannels, CHUNK_SIZE);

    for (int lvl = 0; lvl < NUM_LEVELS; ++lvl)
    {
        auto& level = entry.levels[static_cast<size_t>(lvl)];
        level.stride = LEVEL_STRIDES[lvl];
        level.numChannels = numChannels;
        level.numPeaks = static_cast<int>((totalSamples + LEVEL_STRIDES[lvl] - 1) / LEVEL_STRIDES[lvl]);
        level.data.resize(static_cast<size_t>(level.numPeaks) * static_cast<size_t>(numChannels) * 2, 0.0f);
    }

    auto& fineLevel = entry.levels[0];
    juce::int64 samplesRead = 0;
    int fineSampleCount = 0;
    int finePeakIndex = 0;
    std::vector<float> chMin(static_cast<size_t>(numChannels), 0.0f);
    std::vector<float> chMax(static_cast<size_t>(numChannels), 0.0f);

    auto flushFinePeak = [&]()
    {
        if (finePeakIndex >= fineLevel.numPeaks)
            return;

        const int dataIdx = finePeakIndex * numChannels * 2;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            fineLevel.data[static_cast<size_t>(dataIdx + ch * 2)] = chMin[static_cast<size_t>(ch)];
            fineLevel.data[static_cast<size_t>(dataIdx + ch * 2 + 1)] = chMax[static_cast<size_t>(ch)];
        }
        ++finePeakIndex;
        fineSampleCount = 0;
    };

    while (samplesRead < totalSamples)
    {
        int samplesToRead = static_cast<int>(std::min(static_cast<juce::int64>(CHUNK_SIZE),
                                                       totalSamples - samplesRead));
        readBuffer.clear();
        reader->read(&readBuffer, 0, samplesToRead, samplesRead, true, true);

        // Process each sample
        for (int s = 0; s < samplesToRead; ++s)
        {
            if (fineSampleCount == 0)
            {
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    const float val = readBuffer.getSample(ch, s);
                    chMin[static_cast<size_t>(ch)] = val;
                    chMax[static_cast<size_t>(ch)] = val;
                }
            }
            else
            {
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    const float val = readBuffer.getSample(ch, s);
                    if (val < chMin[static_cast<size_t>(ch)]) chMin[static_cast<size_t>(ch)] = val;
                    if (val > chMax[static_cast<size_t>(ch)]) chMax[static_cast<size_t>(ch)] = val;
                }
            }

            ++fineSampleCount;
            if (fineSampleCount >= fineLevel.stride)
                flushFinePeak();
        }

        samplesRead += samplesToRead;
    }

    if (fineSampleCount > 0)
        flushFinePeak();

    for (int lvl = 1; lvl < NUM_LEVELS; ++lvl)
    {
        auto& level = entry.levels[static_cast<size_t>(lvl)];
        const int finePeaksPerCoarsePeak = juce::jmax(1, level.stride / fineLevel.stride);

        for (int peak = 0; peak < level.numPeaks; ++peak)
        {
            const int fineStart = peak * finePeaksPerCoarsePeak;
            const int fineEnd = juce::jmin(fineStart + finePeaksPerCoarsePeak, fineLevel.numPeaks);
            if (fineStart >= fineEnd)
                break;

            const int dataIdx = peak * numChannels * 2;
            for (int ch = 0; ch < numChannels; ++ch)
            {
                float minVal = 0.0f;
                float maxVal = 0.0f;
                for (int finePeak = fineStart; finePeak < fineEnd; ++finePeak)
                {
                    const int fineDataIdx = finePeak * numChannels * 2 + ch * 2;
                    const float mn = fineLevel.data[static_cast<size_t>(fineDataIdx)];
                    const float mx = fineLevel.data[static_cast<size_t>(fineDataIdx + 1)];
                    if (finePeak == fineStart || mn < minVal) minVal = mn;
                    if (finePeak == fineStart || mx > maxVal) maxVal = mx;
                }

                level.data[static_cast<size_t>(dataIdx + ch * 2)] = minVal;
                level.data[static_cast<size_t>(dataIdx + ch * 2 + 1)] = maxVal;
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

    // Guard: don't queue duplicate generation jobs for the same file
    {
        const juce::ScopedLock sl (pendingLock);
        auto key = audioFile.getFullPathName();
        if (pendingGenerations.count(key) > 0)
            return;  // Already being generated
        pendingGenerations.insert(key);
    }

    // Queue background generation
    backgroundPool.addJob([this, audioFile, onComplete]()
    {
        generateSync(audioFile);

        {
            const juce::ScopedLock sl (pendingLock);
            pendingGenerations.erase(audioFile.getFullPathName());
        }

        if (onComplete)
            juce::MessageManager::callAsync(onComplete);
    });
}
