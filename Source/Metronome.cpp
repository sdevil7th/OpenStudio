/*
  ==============================================================================

    Metronome.cpp
    Created: 27 Oct 2023 10:00:00am
    Author:  Antigravity

  ==============================================================================
*/

#include "Metronome.h"

#include <limits>

namespace
{
class ScopedClickDataReader final
{
public:
    explicit ScopedClickDataReader(
        std::atomic<std::uint32_t>& readersToUse) noexcept
        : readers(readersToUse)
    {
        readers.fetch_add(1, std::memory_order_seq_cst);
    }

    ~ScopedClickDataReader()
    {
        readers.fetch_sub(1, std::memory_order_seq_cst);
    }

    ScopedClickDataReader(
        const ScopedClickDataReader&) = delete;
    ScopedClickDataReader& operator=(
        const ScopedClickDataReader&) = delete;

private:
    std::atomic<std::uint32_t>& readers;
};
}

Metronome::Metronome()
{
    formatManager.registerBasicFormats();
    auto initialClickData =
        createDefaultClickData(
            sampleRate.load(std::memory_order_relaxed));
    clickDataOwner = initialClickData;
    clickDataForAudio.store(
        initialClickData.get(), std::memory_order_seq_cst);
}

Metronome::~Metronome()
{
    clickDataForAudio.store(
        nullptr, std::memory_order_seq_cst);
    jassert(
        clickDataAudioReaders.load(
            std::memory_order_seq_cst) == 0);

    const juce::ScopedLock publicationGuard(
        clickDataPublicationLock);
    retiredClickDataOwners.clear();
    clickDataOwner.reset();
}

void Metronome::prepareToPlay(double newSampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);

    if (!std::isfinite(newSampleRate)
        || newSampleRate <= 0.0)
    {
        return;
    }

    const juce::ScopedLock mutationGuard(
        clickDataMutationLock);
    const double previousSampleRate =
        sampleRate.exchange(
            newSampleRate,
            std::memory_order_acq_rel);
    if (std::abs(previousSampleRate - newSampleRate) <= 1.0e-9)
        return;

    // Rebuild all buffers off the audio thread. Custom files are reloaded at
    // the new device rate; if a file has disappeared, retain its previous
    // immutable buffer rather than publishing a partial or empty click.
    const auto previousData =
        getClickDataSnapshot();
    auto nextData =
        createDefaultClickData(newSampleRate);
    if (previousData != nullptr)
    {
        nextData->accentBeats =
            previousData->accentBeats;
        nextData->usingCustomClick =
            previousData->usingCustomClick;
        nextData->usingCustomAccent =
            previousData->usingCustomAccent;
        nextData->customClickPath =
            previousData->customClickPath;
        nextData->customAccentPath =
            previousData->customAccentPath;

        if (previousData->usingCustomClick)
        {
            juce::AudioBuffer<float> customClick;
            if (loadSoundFromFile(
                    previousData->customClickPath,
                    newSampleRate,
                    customClick))
            {
                nextData->lowClickBuffer =
                    std::move(customClick);
            }
            else
            {
                nextData->lowClickBuffer =
                    previousData->lowClickBuffer;
            }
        }

        if (previousData->usingCustomAccent)
        {
            juce::AudioBuffer<float> customAccent;
            if (loadSoundFromFile(
                    previousData->customAccentPath,
                    newSampleRate,
                    customAccent))
            {
                nextData->highClickBuffer =
                    std::move(customAccent);
            }
            else
            {
                nextData->highClickBuffer =
                    previousData->highClickBuffer;
            }
        }
    }
    publishClickData(nextData);
}

std::uint64_t Metronome::packTimeSignature(
    int numeratorToPack,
    int denominatorToPack) noexcept
{
    return
        (static_cast<std::uint64_t>(
            static_cast<std::uint32_t>(
                numeratorToPack))
            << 32)
        | static_cast<std::uint64_t>(
            static_cast<std::uint32_t>(
                denominatorToPack));
}

int Metronome::unpackNumerator(
    std::uint64_t timeSignature) noexcept
{
    return static_cast<int>(
        static_cast<std::uint32_t>(
            timeSignature >> 32));
}

int Metronome::unpackDenominator(
    std::uint64_t timeSignature) noexcept
{
    return static_cast<int>(
        static_cast<std::uint32_t>(
            timeSignature & 0xffffffffULL));
}

void Metronome::generateDefaultClickSounds(
    double targetSampleRate,
    juce::AudioBuffer<float>& highClick,
    juce::AudioBuffer<float>& lowClick)
{
    const double safeSampleRate =
        std::isfinite(targetSampleRate)
            && targetSampleRate > 0.0
        ? targetSampleRate
        : 44100.0;
    const int samples = juce::jmax(
        1,
        static_cast<int>(
            safeSampleRate * 0.05));
    highClick.setSize(1, samples);
    lowClick.setSize(1, samples);
    
    highClick.clear();
    lowClick.clear();
    
    auto* highWrite = highClick.getWritePointer(0);
    auto* lowWrite = lowClick.getWritePointer(0);
    
    // High click: 1500Hz sine wave with exponential decay
    // Low click: 800Hz sine wave with exponential decay
    
    constexpr double highFreq = 1500.0;
    constexpr double lowFreq = 800.0;
    
    for (int i = 0; i < samples; ++i)
    {
        const double t =
            static_cast<double>(i)
            / safeSampleRate;
        const double envelope =
            std::exp(-50.0 * t);
        
        highWrite[i] = static_cast<float>(
            std::sin(
                2.0
                * juce::MathConstants<double>::pi
                * highFreq
                * t)
            * envelope);
        lowWrite[i] = static_cast<float>(
            std::sin(
                2.0
                * juce::MathConstants<double>::pi
                * lowFreq
                * t)
            * envelope);
    }
}

std::shared_ptr<Metronome::ClickData>
Metronome::createDefaultClickData(
    double targetSampleRate) const
{
    auto clickData =
        std::make_shared<ClickData>();
    generateDefaultClickSounds(
        targetSampleRate,
        clickData->highClickBuffer,
        clickData->lowClickBuffer);
    return clickData;
}

std::shared_ptr<const Metronome::ClickData>
Metronome::getClickDataSnapshot() const
{
    const juce::ScopedLock publicationGuard(
        clickDataPublicationLock);
    return clickDataOwner;
}

void Metronome::publishClickData(
    std::shared_ptr<const ClickData> nextData)
{
    if (nextData == nullptr)
        return;

    std::vector<std::shared_ptr<const ClickData>>
        ownersToReclaim;
    {
        const juce::ScopedLock publicationGuard(
            clickDataPublicationLock);
        if (clickDataAudioReaders.load(
                std::memory_order_seq_cst) == 0)
        {
            ownersToReclaim.swap(
                retiredClickDataOwners);
        }

        const auto previousData =
            clickDataOwner;
        clickDataOwner = nextData;
        clickDataForAudio.store(
            nextData.get(),
            std::memory_order_seq_cst);
        if (previousData != nullptr
            && previousData.get()
                != nextData.get())
        {
            retiredClickDataOwners.push_back(
                previousData);
        }
    }
    // ownersToReclaim destructs here, outside the publication lock and away
    // from the audio callback.
}

void Metronome::getNextAudioBlock(juce::AudioBuffer<float>& buffer, double currentSamplePosition)
{
    if (! enabled.load(std::memory_order_acquire))
        return;

    const int numSamples =
        buffer.getNumSamples();
    if (numSamples <= 0
        || buffer.getNumChannels() <= 0)
    {
        return;
    }

    const double blockBpm =
        bpm.load(std::memory_order_relaxed);
    const double blockSampleRate =
        sampleRate.load(std::memory_order_relaxed);
    const float blockVolume =
        volume.load(std::memory_order_relaxed);
    const auto blockTimeSignature =
        packedTimeSignature.load(
            std::memory_order_acquire);
    const int blockNumerator =
        unpackNumerator(blockTimeSignature);
    const int blockDenominator =
        unpackDenominator(blockTimeSignature);

    if (!std::isfinite(blockBpm)
        || !std::isfinite(blockSampleRate)
        || !std::isfinite(blockVolume)
        || blockBpm <= 0.0
        || blockSampleRate <= 0.0
        || blockNumerator <= 0
        || blockDenominator <= 0)
    {
        return;
    }

    const double denominatorScale =
        4.0
        / static_cast<double>(
            blockDenominator);
    const double samplesPerBeat =
        (60.0 / blockBpm)
        * blockSampleRate
        * denominatorScale;
    if (!std::isfinite(samplesPerBeat)
        || samplesPerBeat <= 0.0)
    {
        return;
    }

    // The immutable click owner is reclaimed only after every callback reader
    // has left. This path performs no shared_ptr atomic operation, lock,
    // allocation, or logging.
    const ScopedClickDataReader clickDataReadGuard(
        clickDataAudioReaders);
    const auto* const clickData =
        clickDataForAudio.load(
            std::memory_order_seq_cst);
    if (clickData == nullptr)
        return;

    auto* leftConfig = buffer.getWritePointer(0);
    auto* rightConfig = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1) : nullptr;

    const bool transportDiscontinuity = lastSamplePosition < 0.0
                                      || std::abs(currentSamplePosition - lastSamplePosition) > 1.0;
    if (transportDiscontinuity)
    {
        isClicking = false;
        clickSampleCounter = 0;
        isHighClick = false;
    }

    for (int i = 0; i < numSamples; ++i)
    {
        double currentPos = currentSamplePosition + i;

        // Use floating-point beat detection to avoid cumulative drift from
        // integer truncation.  A beat boundary occurs when the beat number
        // (currentPos / samplesPerBeat) crosses an integer.  We detect this by
        // comparing the beat index of the current sample with the previous one.
        double beatPos = currentPos / samplesPerBeat;
        double prevBeatPos = (currentPos - 1.0) / samplesPerBeat;
        int currentBeatIdx = static_cast<int>(std::floor(beatPos));
        int prevBeatIdx    = static_cast<int>(std::floor(prevBeatPos));
        bool isBeatStart = currentBeatIdx > prevBeatIdx;

        if (isBeatStart && !isClicking)
        {
            // Beat detected
            const int beatInBar =
                ((currentBeatIdx % blockNumerator)
                    + blockNumerator)
                % blockNumerator;
            
            isClicking = true;
            clickSampleCounter = 0;
            // Use accent array to determine if this beat should be high-pitched
            if (beatInBar
                < static_cast<int>(
                    clickData->accentBeats.size()))
            {
                isHighClick =
                    clickData->accentBeats[
                        static_cast<size_t>(
                            beatInBar)];
            }
            else
            {
                // Fallback: only accent beat 0 if array doesn't cover this beat
                isHighClick = (beatInBar == 0);
            }
        }
        
        // Mix click if active
        if (isClicking)
        {
            float clickValue = 0.0f;
            const auto& sourceBuffer =
                isHighClick
                    ? clickData->highClickBuffer
                    : clickData->lowClickBuffer;
            
            if (sourceBuffer.getNumChannels() > 0
                && clickSampleCounter
                    < sourceBuffer.getNumSamples())
            {
                clickValue =
                    sourceBuffer.getReadPointer(0)[
                        clickSampleCounter]
                    * blockVolume;
                clickSampleCounter++;
            }
            else
            {
                isClicking = false; // Click finished
            }
            
            // Add to output
            leftConfig[i] += clickValue;
            if (rightConfig) rightConfig[i] += clickValue;
        }
    }
    
    // Update last position for restart detection
    lastSamplePosition = currentSamplePosition + numSamples;
}

void Metronome::setBpm(double newBpm)
{
    if (std::isfinite(newBpm)
        && newBpm > 0.0)
    {
        bpm.store(
            newBpm,
            std::memory_order_relaxed);
    }
}

void Metronome::setTimeSignature(int newNumerator, int newDenominator)
{
    const auto previous =
        packedTimeSignature.load(
            std::memory_order_acquire);
    const int safeNumerator =
        newNumerator > 0
            ? newNumerator
            : unpackNumerator(previous);
    const int safeDenominator =
        newDenominator > 0
            ? newDenominator
            : unpackDenominator(previous);
    packedTimeSignature.store(
        packTimeSignature(
            safeNumerator,
            safeDenominator),
        std::memory_order_release);
}

void Metronome::setVolume(float newVolume)
{
    if (std::isfinite(newVolume))
    {
        volume.store(
            newVolume,
            std::memory_order_relaxed);
    }
}

void Metronome::setEnabled(bool shouldBeEnabled)
{
    enabled.store(
        shouldBeEnabled,
        std::memory_order_release);
}

void Metronome::setAccentBeats(const std::vector<bool>& accents)
{
    std::vector<bool> safeAccents =
        accents;
    if (safeAccents.empty())
    {
        safeAccents.resize(
            static_cast<size_t>(
                juce::jmax(
                    1,
                    getNumerator())),
            false);
    }
    safeAccents[0] = true;

    const juce::ScopedLock mutationGuard(
        clickDataMutationLock);
    const auto currentData =
        getClickDataSnapshot();
    auto nextData =
        currentData != nullptr
            ? std::make_shared<ClickData>(
                *currentData)
            : createDefaultClickData(
                sampleRate.load(
                    std::memory_order_relaxed));
    nextData->accentBeats =
        std::move(safeAccents);
    publishClickData(nextData);
}

std::vector<bool> Metronome::getAccentBeats() const
{
    const auto clickData =
        getClickDataSnapshot();
    if (clickData != nullptr)
        return clickData->accentBeats;

    return { true };
}

int Metronome::getNumerator() const
{
    return unpackNumerator(
        packedTimeSignature.load(
            std::memory_order_acquire));
}

int Metronome::getDenominator() const
{
    return unpackDenominator(
        packedTimeSignature.load(
            std::memory_order_acquire));
}

bool Metronome::renderToFile(const juce::File& outputFile, double startTimeSeconds, double endTimeSeconds)
{
    const double renderSampleRate =
        sampleRate.load(std::memory_order_relaxed);
    if (!std::isfinite(renderSampleRate)
        || renderSampleRate <= 0.0
        || !std::isfinite(startTimeSeconds)
        || !std::isfinite(endTimeSeconds))
    {
        return false;
    }

    // Calculate total samples
    const double requestedSamples =
        (endTimeSeconds - startTimeSeconds)
        * renderSampleRate;
    if (!std::isfinite(requestedSamples)
        || requestedSamples <= 0.0
        || requestedSamples
            > static_cast<double>(
                std::numeric_limits<int>::max()))
    {
        return false;
    }

    const int totalSamples =
        static_cast<int>(requestedSamples);
    if (totalSamples <= 0)
        return false;

    // Create WAV writer
    if (outputFile.existsAsFile())
        outputFile.deleteFile();

    juce::WavAudioFormat wavFormat;
    auto outputStream = std::make_unique<juce::FileOutputStream>(outputFile);
    if (outputStream->failedToOpen())
        return false;

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(
            outputStream.get(),
            renderSampleRate,
            2,  // stereo
            16, // bit depth
            {}, // metadata
            0   // quality
        )
    );

    if (!writer)
        return false;

    outputStream.release(); // Writer takes ownership of the stream

    // Save and reset playback state for clean offline render
    int savedClickCounter = clickSampleCounter;
    bool savedIsClicking = isClicking;
    bool savedIsHighClick = isHighClick;
    double savedLastPos = lastSamplePosition;
    const bool savedEnabled =
        enabled.load(std::memory_order_acquire);

    clickSampleCounter = 0;
    isClicking = false;
    isHighClick = false;
    lastSamplePosition = -1.0;
    enabled.store(
        true,
        std::memory_order_release); // Force enabled for rendering

    // Process in blocks
    const int blockSize = 512;
    juce::AudioBuffer<float> buffer(2, blockSize);
    double currentPos =
        startTimeSeconds * renderSampleRate;
    int samplesRemaining = totalSamples;

    while (samplesRemaining > 0)
    {
        int samplesToProcess = std::min(blockSize, samplesRemaining);
        buffer.clear();

        // Use a sub-region of the buffer if less than blockSize
        if (samplesToProcess < blockSize)
        {
            juce::AudioBuffer<float> subBuffer(buffer.getArrayOfWritePointers(), 2, samplesToProcess);
            getNextAudioBlock(subBuffer, currentPos);
            writer->writeFromAudioSampleBuffer(subBuffer, 0, samplesToProcess);
        }
        else
        {
            getNextAudioBlock(buffer, currentPos);
            writer->writeFromAudioSampleBuffer(buffer, 0, samplesToProcess);
        }

        currentPos += samplesToProcess;
        samplesRemaining -= samplesToProcess;
    }

    // Restore playback state
    clickSampleCounter = savedClickCounter;
    isClicking = savedIsClicking;
    isHighClick = savedIsHighClick;
    lastSamplePosition = savedLastPos;
    enabled.store(
        savedEnabled,
        std::memory_order_release);

    return true;
}

// =============================================================================
// Phase 9C: Custom Click Sounds
// =============================================================================

bool Metronome::loadSoundFromFile(
    const juce::String& filePath,
    double targetSampleRate,
    juce::AudioBuffer<float>& targetBuffer)
{
    if (!std::isfinite(targetSampleRate)
        || targetSampleRate <= 0.0)
    {
        return false;
    }

    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
        return false;

    std::unique_ptr<juce::AudioFormatReader> reader(
        formatManager.createReaderFor(audioFile));
    if (!reader)
        return false;

    if (!std::isfinite(reader->sampleRate)
        || reader->sampleRate <= 0.0
        || reader->numChannels == 0)
    {
        return false;
    }

    // Limit click sample to 2 seconds max
    const auto maxSamples =
        static_cast<juce::int64>(
            reader->sampleRate * 2.0);
    const auto samplesToRead =
        std::min(
            reader->lengthInSamples,
            maxSamples);

    if (samplesToRead <= 0
        || samplesToRead
            > static_cast<juce::int64>(
                std::numeric_limits<int>::max()))
        return false;

    // Read into a temp buffer at the file's native sample rate
    juce::AudioBuffer<float> fileBuffer(
        static_cast<int>(reader->numChannels),
        static_cast<int>(samplesToRead));
    if (!reader->read(
            &fileBuffer,
            0,
            static_cast<int>(samplesToRead),
            0,
            true,
            true))
    {
        return false;
    }

    // Mix to mono if multi-channel
    int outSamples =
        static_cast<int>(samplesToRead);
    // If sample rate differs, resample to match metronome's sample rate
    if (std::abs(
            reader->sampleRate
            - targetSampleRate) > 1.0)
    {
        const double ratio =
            targetSampleRate
            / reader->sampleRate;
        const double outputLength =
            static_cast<double>(samplesToRead)
            * ratio;
        if (!std::isfinite(outputLength)
            || outputLength <= 0.0
            || outputLength
                > static_cast<double>(
                    std::numeric_limits<int>::max()))
        {
            return false;
        }
        outSamples =
            juce::jmax(
                1,
                static_cast<int>(outputLength));
    }

    targetBuffer.setSize(1, outSamples);
    targetBuffer.clear();

    auto* outWrite = targetBuffer.getWritePointer(0);

    if (std::abs(
            reader->sampleRate
            - targetSampleRate) > 1.0)
    {
        // Simple linear interpolation resample
        double ratio =
            reader->sampleRate
            / targetSampleRate;
        for (int i = 0; i < outSamples; ++i)
        {
            double srcPos = i * ratio;
            int idx0 = (int)srcPos;
            int idx1 = idx0 + 1;
            double frac = srcPos - idx0;

            float val = 0.0f;
            for (int ch = 0; ch < (int)reader->numChannels; ++ch)
            {
                const float* chData = fileBuffer.getReadPointer(ch);
                float s0 = (idx0 < (int)samplesToRead) ? chData[idx0] : 0.0f;
                float s1 = (idx1 < (int)samplesToRead) ? chData[idx1] : 0.0f;
                val += (float)(s0 + (s1 - s0) * frac);
            }
            outWrite[i] = val / reader->numChannels;
        }
    }
    else
    {
        // Same sample rate — just mix to mono
        for (int i = 0; i < outSamples; ++i)
        {
            float val = 0.0f;
            for (int ch = 0; ch < (int)reader->numChannels; ++ch)
                val += fileBuffer.getReadPointer(ch)[i];
            outWrite[i] = val / reader->numChannels;
        }
    }

    return true;
}

bool Metronome::setClickSound(const juce::String& filePath)
{
    const juce::ScopedLock mutationGuard(
        clickDataMutationLock);
    const double targetSampleRate =
        sampleRate.load(std::memory_order_relaxed);
    juce::AudioBuffer<float> replacementBuffer;

    if (filePath.isEmpty())
    {
        juce::AudioBuffer<float> unusedHighClick;
        generateDefaultClickSounds(
            targetSampleRate,
            unusedHighClick,
            replacementBuffer);
    }
    else if (!loadSoundFromFile(
                 filePath,
                 targetSampleRate,
                 replacementBuffer))
    {
        return false;
    }

    const auto currentData =
        getClickDataSnapshot();
    auto nextData =
        currentData != nullptr
            ? std::make_shared<ClickData>(
                *currentData)
            : createDefaultClickData(
                targetSampleRate);
    nextData->lowClickBuffer =
        std::move(replacementBuffer);
    nextData->usingCustomClick =
        filePath.isNotEmpty();
    nextData->customClickPath =
        filePath;
    publishClickData(nextData);
    return true;
}

bool Metronome::setAccentSound(const juce::String& filePath)
{
    const juce::ScopedLock mutationGuard(
        clickDataMutationLock);
    const double targetSampleRate =
        sampleRate.load(std::memory_order_relaxed);
    juce::AudioBuffer<float> replacementBuffer;

    if (filePath.isEmpty())
    {
        juce::AudioBuffer<float> unusedLowClick;
        generateDefaultClickSounds(
            targetSampleRate,
            replacementBuffer,
            unusedLowClick);
    }
    else if (!loadSoundFromFile(
                 filePath,
                 targetSampleRate,
                 replacementBuffer))
    {
        return false;
    }

    const auto currentData =
        getClickDataSnapshot();
    auto nextData =
        currentData != nullptr
            ? std::make_shared<ClickData>(
                *currentData)
            : createDefaultClickData(
                targetSampleRate);
    nextData->highClickBuffer =
        std::move(replacementBuffer);
    nextData->usingCustomAccent =
        filePath.isNotEmpty();
    nextData->customAccentPath =
        filePath;
    publishClickData(nextData);
    return true;
}

void Metronome::resetToDefaultSounds()
{
    const juce::ScopedLock mutationGuard(
        clickDataMutationLock);
    auto nextData =
        createDefaultClickData(
            sampleRate.load(
                std::memory_order_relaxed));
    const auto currentData =
        getClickDataSnapshot();
    if (currentData != nullptr)
    {
        nextData->accentBeats =
            currentData->accentBeats;
    }
    publishClickData(nextData);
}
