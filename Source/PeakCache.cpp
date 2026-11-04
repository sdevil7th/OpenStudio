#include "PeakCache.h"
#include <cmath>
#include <array>

namespace { constexpr juce::int64 maxPeakDataBytes = 256 * 1024 * 1024; }

// Static constexpr definitions (required for ODR-use in C++17)
constexpr int PeakCache::LEVEL_STRIDES[NUM_LEVELS];

PeakCache::PeakCache() {}

PeakCache::~PeakCache()
{
    stopping.store(true);
    completions.invalidate();
    backgroundPool.removeAllJobs(true, -1); // Never destroy data beneath a surviving scan.
}

juce::File PeakCache::getPeakFilePath(const juce::File& audioFile)
{
    return audioFile.getSiblingFile(audioFile.getFileName() + ".ospeaks");
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

    // Validate metadata and its on-disk footprint without allocating.
    juce::FileInputStream fis(peakFile);
    if (!fis.openedOk() || fis.getTotalLength() < (juce::int64)sizeof(PeakFileHeader))
        return false;

    PeakFileHeader header;
    if (fis.read(&header, sizeof(header)) != sizeof(header))
        return false;

    if (header.magic != MAGIC || header.version != VERSION)
        return false;

    if (header.numLevels != NUM_LEVELS || header.numChannels < 1 || header.numChannels > 64
        || header.totalSamples < 1 || header.totalSamples > INT64_MAX - 4096
        || !std::isfinite(header.sampleRate) || header.sampleRate < 8000 || header.sampleRate > 384000
        || fis.getTotalLength() > maxPeakDataBytes + 4096) return false;

    for (int level = 0; level < NUM_LEVELS; ++level)
    {
        int32_t stride = 0, count = 0;
        if (fis.read(&stride, sizeof(stride)) != sizeof(stride) || fis.read(&count, sizeof(count)) != sizeof(count)
            || stride != LEVEL_STRIDES[level] || count < 1 || count != (header.totalSamples + stride - 1) / stride) return false;
        const auto bytes = static_cast<juce::int64>(count) * header.numChannels * 8;
        if (bytes > fis.getTotalLength() - fis.getPosition() || !fis.setPosition(fis.getPosition() + bytes)) return false;
    }
    // Check if source file matches
    if (header.sourceFileSize != audioFile.getSize())
        return false;

    if (header.sourceModTimeMs != audioFile.getLastModificationTime().toMilliseconds())
        return false;

    return true;
}

void PeakCache::invalidate(const juce::File& audioFile)
{
    const auto key = audioFile.getFullPathName();
    {
        const juce::ScopedLock publication(publicationLock);
        {
            const juce::ScopedLock sl(cacheLock);
            ++sourceGenerations[key];
            memoryCache.erase(key);
        }
        {
            const juce::ScopedLock sl(pendingLock);
            pendingGenerations.erase(key);
        }
        auto peakFile = getPeakFilePath(audioFile);
        if (peakFile.existsAsFile()) peakFile.deleteFile();
    }
    {
        const juce::ScopedLock sl(boundaryLock);
        boundaryPeaks.clear();
    }

}

PeakCache::SourceVersion PeakCache::captureSourceVersion(const juce::File& audioFile) const
{
    SourceVersion version;
    version.key = audioFile.getFullPathName();
    {
        const juce::ScopedLock sl(cacheLock);
        version.generation = sourceGenerations[version.key];
    }
    version.size = audioFile.getSize();
    version.modified = audioFile.getLastModificationTime().toMilliseconds();
    return version;
}

bool PeakCache::isGenerationCurrent(const SourceVersion& version) const
{
    const juce::ScopedLock sl(cacheLock);
    const auto found = sourceGenerations.find(version.key);
    const auto generation = found == sourceGenerations.end() ? 0 : found->second;
    return !stopping.load() && generation == version.generation;
}

bool PeakCache::sourceMatches(const juce::File& audioFile, const SourceVersion& version)
{
    return audioFile.existsAsFile() && audioFile.getSize() == version.size
        && audioFile.getLastModificationTime().toMilliseconds() == version.modified;
}

std::shared_ptr<const PeakCache::CacheEntry> PeakCache::publishLoadedEntry(
    const juce::File& audioFile, const SourceVersion& version,
    std::shared_ptr<const CacheEntry> loaded) const
{
    const juce::ScopedLock publication(publicationLock);
    if (!isGenerationCurrent(version) || !sourceMatches(audioFile, version)) return {};
    const juce::ScopedLock sl(cacheLock);
    // invalidate() uses publicationLock first, so generation cannot change
    // between validation and insertion. Prefer a current entry already loaded.
    auto& current = memoryCache[version.key];
    if (!current) current = std::move(loaded);
    return current;
}

juce::var PeakCache::getPeaks(const juce::File& audioFile,
                               int samplesPerPixel, int startSample, int numPixels,
                               juce::int64 sourceRangeStartSample,
                               juce::int64 sourceRangeEndSample) const
{
    if (samplesPerPixel < 1 || startSample < 0 || numPixels < 1 || numPixels > 32768)
        return juce::var(juce::Array<juce::var>());

    std::shared_ptr<const CacheEntry> entry;
    SourceVersion sourceVersion;
    sourceVersion.key = audioFile.getFullPathName();
    {
        const juce::ScopedLock sl(cacheLock);
        sourceVersion.generation = sourceGenerations[sourceVersion.key];
        const auto found = memoryCache.find(sourceVersion.key);
        if (found != memoryCache.end()) entry = found->second;
    }
    if (entry == nullptr)
    {
        auto loaded = std::make_shared<CacheEntry>();
        sourceVersion.size = audioFile.getSize();
        sourceVersion.modified = audioFile.getLastModificationTime().toMilliseconds();
        if (!loadFromFile(getPeakFilePath(audioFile), audioFile, *loaded))
            return juce::var(juce::Array<juce::var>());
        entry = publishLoadedEntry(audioFile, sourceVersion, std::move(loaded));
        if (!entry) return juce::var(juce::Array<juce::var>());
    }
    juce::Array<juce::var> peaks;
    if (entry->levels.empty()) return juce::var(peaks);
    const auto rangeStart = juce::jlimit<juce::int64>(0, entry->totalSamples, sourceRangeStartSample);
    const auto rangeEnd = sourceRangeEndSample < 0 ? entry->totalSamples
        : juce::jlimit<juce::int64>(rangeStart, entry->totalSamples, sourceRangeEndSample);
    if (startSample >= rangeEnd || rangeStart >= rangeEnd) return juce::var(peaks);
    const MipmapLevel* level = &entry->levels.front();
    for (const auto& candidate : entry->levels)
        if (candidate.stride <= samplesPerPixel) level = &candidate;
    const auto pixelCount = juce::jmin<juce::int64>(numPixels,
        (rangeEnd - startSample + samplesPerPixel - 1) / samplesPerPixel);
    const int channels = entry->numChannels;
    peaks.ensureStorageAllocated(1 + static_cast<int>(pixelCount) * channels * 2);
    peaks.add(channels);

    // A trim can bisect a cached bucket. Decode only that bounded bucket on
    // the worker and cache its retained aggregate; never include removed audio.
    const auto clippedBucket = [&](juce::int64 first, juce::int64 last)
    {
        const auto key = audioFile.getFullPathName() + ":" + juce::String(sourceVersion.generation)
            + ":" + juce::String(audioFile.getLastModificationTime().toMilliseconds())
            + ":" + juce::String(first) + ":" + juce::String(last);
        {
            const juce::ScopedLock sl(boundaryLock);
            const auto found = boundaryPeaks.find(key);
            if (found != boundaryPeaks.end()) return found->second;
        }
        std::vector<float> result(static_cast<size_t>(channels * 2), 0.0f);
        juce::AudioFormatManager manager;
        manager.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader(manager.createReaderFor(audioFile));
        const int count = static_cast<int>(last - first); // at most one mip bucket
        juce::AudioBuffer<float> samples(channels, count);
        if (reader == nullptr || !reader->read(&samples, 0, count, first, true, true))
            return std::vector<float>();
        for (int channel = 0; channel < channels; ++channel)
        {
            const auto extrema = samples.findMinMax(channel, 0, count);
            result[static_cast<size_t>(channel * 2)] = extrema.getStart();
            result[static_cast<size_t>(channel * 2 + 1)] = extrema.getEnd();
        }
        const juce::ScopedLock sl(boundaryLock);
        if (boundaryPeaks.size() >= 256) boundaryPeaks.erase(boundaryPeaks.begin());
        boundaryPeaks[key] = result;
        return result;
    };
    std::map<int, std::vector<float>> edges;
    for (juce::int64 pixel = 0; pixel < pixelCount; ++pixel)
    {
        const auto pixelStart = static_cast<juce::int64>(startSample) + pixel * samplesPerPixel;
        const auto first = juce::jmax(pixelStart, rangeStart);
        const auto last = juce::jmin(pixelStart + samplesPerPixel, rangeEnd);
        const int firstBucket = static_cast<int>(first / level->stride);
        const int lastBucket = static_cast<int>((last + level->stride - 1) / level->stride);
        std::array<float, 128> result {};
        bool hasValues = false;
        for (int bucket = firstBucket; first < last && bucket < lastBucket && bucket < level->numPeaks; ++bucket)
        {
            const auto bucketFirst = static_cast<juce::int64>(bucket) * level->stride;
            const auto bucketLast = juce::jmin(bucketFirst + level->stride, entry->totalSamples);
            const auto retainedFirst = juce::jmax(bucketFirst, rangeStart);
            const auto retainedLast = juce::jmin(bucketLast, rangeEnd);
            const float* values = level->data.data() + static_cast<size_t>(bucket) * channels * 2;
            if (retainedFirst != bucketFirst || retainedLast != bucketLast)
            {
                auto found = edges.find(bucket);
                if (found == edges.end()) found = edges.emplace(bucket, clippedBucket(retainedFirst, retainedLast)).first;
                if (found->second.empty()) return juce::var(juce::Array<juce::var>());
                values = found->second.data();
            }
            for (int channel = 0; channel < channels; ++channel)
            {
                const auto index = static_cast<size_t>(channel * 2);
                result[index] = hasValues ? juce::jmin(result[index], values[index]) : values[index];
                result[index + 1] = hasValues ? juce::jmax(result[index + 1], values[index + 1]) : values[index + 1];
            }
            hasValues = true;
        }
        for (int value = 0; value < channels * 2; ++value) peaks.add(result[static_cast<size_t>(value)]);
    }
    return juce::var(peaks);
}

bool PeakCache::loadFromFile(const juce::File& peakFile, const juce::File& audioFile, CacheEntry& entry) const
{
    if (peakFile.getSize() > maxPeakDataBytes + 4096) return false;
    juce::FileInputStream fis(peakFile);
    if (!fis.openedOk())
        return false;

    PeakFileHeader header;
    if (fis.read(&header, sizeof(header)) != sizeof(header))
        return false;

    if (header.magic != MAGIC || header.version != VERSION)
        return false;

    if (header.numLevels != NUM_LEVELS || header.numChannels < 1 || header.numChannels > 64
        || header.totalSamples < 1 || header.totalSamples > INT64_MAX - 4096
        || !std::isfinite(header.sampleRate) || header.sampleRate < 8000 || header.sampleRate > 384000) return false;
    juce::int64 accumulatedBytes = 0;

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
        if (stride != LEVEL_STRIDES[i] || numPeaks < 1
            || numPeaks != (header.totalSamples + stride - 1) / stride) return false;
        const auto byteCount = static_cast<juce::int64>(numPeaks) * header.numChannels * 2 * static_cast<juce::int64>(sizeof(float));
        accumulatedBytes += byteCount;
        if (accumulatedBytes > maxPeakDataBytes || byteCount > fis.getTotalLength() - fis.getPosition()) return false;

        auto& level = entry.levels[static_cast<size_t>(i)];
        level.stride = stride;
        level.numPeaks = numPeaks;
        level.numChannels = header.numChannels;

        size_t floatCount = static_cast<size_t>(numPeaks) * static_cast<size_t>(header.numChannels) * 2;
        level.data.resize(floatCount);

        size_t bytesToRead = floatCount * sizeof(float);
        if (fis.read(level.data.data(), static_cast<int>(bytesToRead)) != static_cast<int>(bytesToRead))
            return false;
        for (const auto value : level.data) if (!std::isfinite(value)) return false;
    }

    return true;
}

bool PeakCache::writeToFile(const juce::File& peakFile, const CacheEntry& entry,
                             int64_t sourceFileSize, int64_t sourceModTimeMs)
{
    juce::TemporaryFile temporary(peakFile);
    return writeStagedFile(temporary.getFile(), entry, sourceFileSize, sourceModTimeMs)
        && temporary.overwriteTargetFileWithTemporary();
}

bool PeakCache::writeStagedFile(const juce::File& stagingFile, const CacheEntry& entry,
                                int64_t sourceFileSize, int64_t sourceModTimeMs)
{
    juce::FileOutputStream fos(stagingFile);
    if (!fos.openedOk())
        return false;

    fos.setPosition(0);
    fos.truncate();

    PeakFileHeader header {};
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
    return fos.getStatus().wasOk();
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
    if (stopping.load() || numChannels < 1 || numChannels > 64 || totalSamples < 1 || totalSamples > INT64_MAX - 4096
        || !std::isfinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) return false;
    juce::int64 peakBytes = 0;
    for (const auto stride : LEVEL_STRIDES)
    {
        const auto peaks = (totalSamples + stride - 1) / stride;
        if (peaks > maxPeakDataBytes / (numChannels * 2 * static_cast<int>(sizeof(float)))) return false;
        peakBytes += peaks * numChannels * 2 * sizeof(float);
    }
    if (peakBytes > maxPeakDataBytes) return false;

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
        if (stopping.load()) return false;
        int samplesToRead = static_cast<int>(std::min(static_cast<juce::int64>(CHUNK_SIZE),
                                                       totalSamples - samplesRead));
        readBuffer.clear();
        if (!reader->read(&readBuffer, 0, samplesToRead, samplesRead, true, true)) return false;

        // Process each sample
        for (int s = 0; s < samplesToRead; ++s)
        {
            if (fineSampleCount == 0)
            {
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    const float val = readBuffer.getSample(ch, s);
                    if (!std::isfinite(val)) return false;
                    chMin[static_cast<size_t>(ch)] = val;
                    chMax[static_cast<size_t>(ch)] = val;
                }
            }
            else
            {
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    const float val = readBuffer.getSample(ch, s);
                    if (!std::isfinite(val)) return false;
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
            if ((peak & 4095) == 0 && stopping.load()) return false;
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
    return generateSyncForVersion(audioFile, captureSourceVersion(audioFile));
}

bool PeakCache::generateSyncForVersion(const juce::File& audioFile, const SourceVersion& version)
{
    if (!isGenerationCurrent(version) || !sourceMatches(audioFile, version)) return false;
    CacheEntry entry;
    if (!buildPeaks(audioFile, entry) || stopping.load())
        return false;
    if (!isGenerationCurrent(version) || !sourceMatches(audioFile, version)) return false;
    juce::TemporaryFile temporary(getPeakFilePath(audioFile));
    const bool staged = writeStagedFile(temporary.getFile(), entry, version.size, version.modified);
    const bool written = publishGeneratedEntry(audioFile, version,
        std::make_shared<CacheEntry>(std::move(entry)), temporary, staged);
    if (written)
        juce::Logger::writeToLog("PeakCache: Generated peaks for " + audioFile.getFileName());

    return written;
}

bool PeakCache::publishGeneratedEntry(const juce::File& audioFile, const SourceVersion& version,
    std::shared_ptr<const CacheEntry> entry, juce::TemporaryFile& temporary, bool stagedReady)
{
    const juce::ScopedLock publication(publicationLock);
    if (!isGenerationCurrent(version) || !sourceMatches(audioFile, version)) return false;
    const bool written = stagedReady && temporary.overwriteTargetFileWithTemporary();
    {
        const juce::ScopedLock sl(cacheLock);
        memoryCache[version.key] = std::move(entry);
    }
    return written;
}

bool PeakCache::claimPendingGeneration(const SourceVersion& version)
{
    // Validate and claim as one publication transaction. An old request that
    // paused before enqueue must not replace a newer generation's ownership.
    const juce::ScopedLock publication(publicationLock);
    if (!isGenerationCurrent(version)) return false;
    const juce::ScopedLock sl(pendingLock);
    const auto found = pendingGenerations.find(version.key);
    if (found != pendingGenerations.end() && found->second == version.generation) return false;
    pendingGenerations[version.key] = version.generation;
    return true;
}

void PeakCache::finishPendingGeneration(const SourceVersion& version)
{
    const juce::ScopedLock sl(pendingLock);
    const auto found = pendingGenerations.find(version.key);
    if (found != pendingGenerations.end() && found->second == version.generation)
        pendingGenerations.erase(found);
}

void PeakCache::generateAsync(const juce::File& audioFile, std::function<void()> onComplete)
{
    if (stopping.load()) return;
    const auto version = captureSourceVersion(audioFile);
    const auto complete = [this, alive = completions.token(), version, onComplete] {
        if (MessageThreadLifetime::accepts(alive) && isGenerationCurrent(version) && onComplete) onComplete();
    };
    // If already cached, call completion immediately
    if (hasCachedPeaks(audioFile))
    {
        if (onComplete)
            juce::MessageManager::callAsync(complete);
        return;
    }

    if (!claimPendingGeneration(version)) return;

    // Queue background generation
    backgroundPool.addJob([this, audioFile, version, complete]()
    {
        generateSyncForVersion(audioFile, version);

        finishPendingGeneration(version);

        juce::MessageManager::callAsync(complete);
    });
}
