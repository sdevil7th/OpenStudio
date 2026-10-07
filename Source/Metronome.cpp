/*
  ==============================================================================

    Metronome.cpp
    Created: 27 Oct 2023 10:00:00am
    Author:  Antigravity

  ==============================================================================
*/

#include "Metronome.h"
#include "MetronomeSounds.h"
#include "AppPaths.h"

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
    // prepareToPlay is called with processing stopped, including same-rate
    // buffer changes. Do not carry a partially played click into a new device.
    resetGeneration.fetch_add(1, std::memory_order_release);
    clickGain.reset(newSampleRate, 0.002);
    clickGain.setCurrentAndTargetValue(volume.load(std::memory_order_relaxed));
    transitionLength = juce::jmax(1, static_cast<int>(newSampleRate * 0.001));
    lastClickOutput = transitionTail = 0.0f;
    transitionSamplesLeft = 0;
    const double previousSampleRate =
        sampleRate.exchange(
            newSampleRate,
            std::memory_order_acq_rel);
    if (std::abs(previousSampleRate - newSampleRate) <= 1.0e-9)
    {
        setPracticePlaybackAvailable(true);
        return;
    }

    // Rebuild from retained prepared audio. A removed source file must not
    // change the click's pitch or attack timing when the device rate changes.
    const auto previousData =
        getClickDataSnapshot();
    auto nextData =
        createDefaultClickData(newSampleRate);
    if (previousData != nullptr)
    {
        nextData->soundRevision = previousData->soundRevision + 1;
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
        nextData->preparedRegular = previousData->preparedRegular;
        nextData->preparedAccent = previousData->preparedAccent;
        nextData->regularInfo = previousData->regularInfo;
        nextData->accentInfo = previousData->accentInfo;

        if (previousData->usingCustomClick)
        {
            nextData->lowClickBuffer = MetronomeSounds::resample(
                previousData->preparedRegular, MetronomeSounds::preparedRate, newSampleRate);
        }
        else if (previousData->customClickPath.isNotEmpty())
            nextData->lowClickBuffer = MetronomeSounds::synthesise(previousData->customClickPath, false, newSampleRate);

        if (previousData->usingCustomAccent)
        {
            nextData->highClickBuffer = MetronomeSounds::resample(
                previousData->preparedAccent, MetronomeSounds::preparedRate, newSampleRate);
        }
        else if (previousData->customAccentPath.isNotEmpty())
            nextData->highClickBuffer = MetronomeSounds::synthesise(previousData->customAccentPath, true, newSampleRate);
    }
    publishClickData(nextData);
    setPracticePlaybackAvailable(true);
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
        // End the finite-length synthesized waveform at zero, rather than
        // truncate the remaining exponential tail at a non-zero sample.
        const double tailGain = juce::jlimit(0.0, 1.0,
            static_cast<double>(samples - 1 - i) / juce::jmax(1.0, safeSampleRate * 0.001));
        const double envelope = std::exp(-50.0 * t) * tailGain;
        
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
    renderBlock(buffer, currentSamplePosition, enabled.load(std::memory_order_acquire), false);
}

bool Metronome::setPracticeEnabled(bool shouldRun)
{
    auto timer = practiceTimerState.load();
    while (!practiceTimerState.compare_exchange_weak(timer, ((timer + 16u) & ~std::uint64_t{15}) | 8u)) {}
    auto previous = practiceState.load(std::memory_order_relaxed);
    for (;;)
    {
        if (shouldRun && (previous & 2u) == 0) return false;
        if (((previous & 1u) != 0) == shouldRun) return true;
        const auto next = ((previous + 4u) & ~std::uint64_t { 1 }) | (shouldRun ? 1u : 0u);
        if (practiceState.compare_exchange_weak(previous, next, std::memory_order_release, std::memory_order_relaxed))
            return true;
    }
}

bool Metronome::controlPracticeTimer(const juce::String& action, double duration)
{
    if (action == "start") {
        if ((practiceState.load() & 2u) == 0 || !std::isfinite(duration) || duration < 0 || duration > 86400) return false;
        setPracticeEnabled(false);
        practiceTimerDuration.store(duration);
    }
    auto previous = practiceTimerState.load();
    for (;;) {
        const auto state = previous & 7u;
        std::uint64_t mode = 0;
        if (action == "start") mode = 9u;
        else if (action == "reset") mode = 8u;
        else if (action == "pause" && state == 1u) mode = 2u;
        else if (action == "resume" && state == 2u && (practiceState.load() & 2u) != 0) mode = 1u;
        else return false;
        if (practiceTimerState.compare_exchange_weak(previous, ((previous + 16u) & ~std::uint64_t{15}) | mode)) return true;
    }
}

juce::var Metronome::getPracticeTimer() const
{
    auto* result = new juce::DynamicObject();
    const auto state = practiceTimerState.load();
    const char* names[] { "idle", "running", "paused", "finished", "interrupted" };
    result->setProperty("status", names[juce::jmin(4, static_cast<int>(state & 7u))]);
    result->setProperty("duration", practiceTimerDuration.load());
    result->setProperty("elapsed", (state & 8u) != 0 ? 0.0 : practiceTimerElapsed.load());
    return result;
}

void Metronome::setPracticePlaybackAvailable(bool available)
{
    if (!available) {
        auto timer = practiceTimerState.load();
        while (((timer & 7u) == 1u || (timer & 7u) == 2u)
            && !practiceTimerState.compare_exchange_weak(timer, ((timer + 16u) & ~std::uint64_t{15}) | 4u)) {}
    }
    auto previous = practiceState.load(std::memory_order_relaxed);
    for (;;)
    {
        const auto next = ((previous + 4u) & ~std::uint64_t { 3 }) | (available ? 2u : 0u);
        if (practiceState.compare_exchange_weak(previous, next, std::memory_order_release, std::memory_order_relaxed))
            return;
    }
}

void Metronome::getNextTransportBlock(juce::AudioBuffer<float>& buffer, double position, bool transportRunning)
{
    auto timer = practiceTimerState.load(std::memory_order_acquire);
    const bool timerRestarted = timer != consumedTimerState && (timer & 8u) != 0;
    if (timerRestarted) {
        timerElapsed = 0.0;
        const auto acknowledged = timer & ~std::uint64_t{8};
        if (practiceTimerState.compare_exchange_strong(timer, acknowledged)) timer = acknowledged;
    }
    bool timerRunning = (timer & 7u) == 1u;
    if (transportRunning && ((timer & 7u) == 1u || (timer & 7u) == 2u)) {
        const auto interrupted = ((timer + 16u) & ~std::uint64_t{15}) | 4u;
        practiceTimerState.compare_exchange_strong(timer, interrupted);
        timerRunning = false;
    }
    consumedTimerState = timer;
    const auto duration = practiceTimerDuration.load();
    const auto rate = sampleRate.load();
    int activeSamples = buffer.getNumSamples();
    if (timerRunning && duration > 0 && rate > 0)
        activeSamples = static_cast<int>(juce::jlimit(0.0, static_cast<double>(activeSamples), std::ceil((duration - timerElapsed) * rate - 1.0e-6)));
    const auto practice = practiceState.load(std::memory_order_acquire);
    const bool practiceOn = (practice & 1u) != 0 || timerRunning;
    const bool active = practiceOn || (transportRunning && isEnabled());
    const auto generation = resetGeneration.load(std::memory_order_acquire);
    const bool deviceReset = generation != consumedResetGeneration;
    const bool practiceStarted = practiceOn && (practice != consumedPracticeState || timerRestarted);
    const double currentBpm = getBpm();
    const bool handover = active && (!clockWasRunning || (transportRunning && !clockWasTransport) || deviceReset);
    if (!transportRunning)
    {
        if (practiceStarted || deviceReset || !clockWasRunning)
            freeRunSamplePosition = 0.0;
        else if (freeRunBpm != currentBpm)
            freeRunSamplePosition *= freeRunBpm / currentBpm;
        // A malformed host seek/tempo must not poison the independent clock
        // after transport stops. Re-enter at beat one from an unusable phase.
        if (!std::isfinite(freeRunSamplePosition) || std::abs(freeRunSamplePosition) > 1.0e12)
            freeRunSamplePosition = 0.0;
        position = freeRunSamplePosition;
    }
    renderBlock(buffer, position, active, handover || (practiceStarted && !transportRunning), timerRunning ? activeSamples : -1);
    if (timerRunning && rate > 0) {
        timerElapsed += activeSamples / rate;
        if (duration > 0 && timerElapsed >= duration - 1.0e-9) {
            timerElapsed = duration;
            practiceTimerState.compare_exchange_strong(timer, ((timer + 16u) & ~std::uint64_t{15}) | 3u);
        }
    }
    practiceTimerElapsed.store(timerElapsed);
    if (active) freeRunSamplePosition = position + buffer.getNumSamples();
    freeRunBpm = currentBpm;
    consumedPracticeState = practice;
    clockWasRunning = active;
    clockWasTransport = transportRunning;
}

void Metronome::retireClick() noexcept
{
    transitionTail = lastClickOutput;
    transitionSamplesLeft = transitionTail == 0.0f ? 0 : transitionLength;
    isClicking = false;
    clickSampleCounter = 0;
}

void Metronome::renderBlock(juce::AudioBuffer<float>& buffer, double currentSamplePosition, bool active, bool resetClock, int activeSamples)
{

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

    if (!std::isfinite(currentSamplePosition)
        || std::abs(currentSamplePosition) > 1.0e12
        || !std::isfinite(blockBpm)
        || !std::isfinite(blockSampleRate)
        || !std::isfinite(blockVolume)
        || blockBpm <= 0.0
        || blockSampleRate <= 0.0
        || blockNumerator <= 0
        || blockDenominator <= 0)
    {
        active = false;
    }

    const double denominatorScale =
        4.0
        / static_cast<double>(
            blockDenominator);
    const double samplesPerBeat =
        (60.0 / blockBpm)
        * blockSampleRate
        * denominatorScale;
    if (!std::isfinite(samplesPerBeat) || samplesPerBeat < 1.0)
        active = false;

    const auto generation = resetGeneration.load(std::memory_order_acquire);
    resetClock = resetClock || generation != consumedResetGeneration;
    consumedResetGeneration = generation;
    const bool discontinuity = resetClock || !renderWasActive
        || std::abs(currentSamplePosition - lastSamplePosition) > 0.5;
    if ((renderWasActive && !active) || (active && discontinuity)) retireClick();
    renderWasActive = active;
    clickGain.setTargetValue(blockVolume);
    if (!active && transitionSamplesLeft == 0)
    {
        lastSamplePosition = -1.0;
        lastClickOutput = 0.0f;
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

    if (renderedSoundRevision != clickData->soundRevision)
    {
        retireClick();
        renderedSoundRevision = clickData->soundRevision;
    }
    if (active && (discontinuity || scheduledSamplesPerBeat != samplesPerBeat))
    {
        // Schedule absolute boundaries once, not two divisions/floors for every
        // sample. Multiplication by the beat index avoids cumulative rounding drift.
        nextBeatIndex = std::floor((currentSamplePosition - 1.0) / samplesPerBeat) + 1.0;
        nextBeatSample = std::ceil(nextBeatIndex * samplesPerBeat);
        scheduledSamplesPerBeat = samplesPerBeat;
    }
    auto* left = buffer.getWritePointer(0);
    auto* right = numSamples > 0 && buffer.getNumChannels() > 1 ? buffer.getWritePointer(1) : nullptr;
    int offset = 0;
    while (offset < numSamples)
    {
        if (active && activeSamples >= 0 && offset >= activeSamples) {
            active = false;
            renderWasActive = false;
            retireClick();
        }
        const double position = currentSamplePosition + offset;
        if (active && nextBeatSample <= position)
        {
            if (isClicking) retireClick(); // Long custom clicks must not suppress later beats.
            const auto beat = static_cast<std::int64_t>(nextBeatIndex);
            const int beatInBar = static_cast<int>((beat % blockNumerator + blockNumerator) % blockNumerator);
            isHighClick = beatInBar < static_cast<int>(clickData->accentBeats.size())
                ? clickData->accentBeats[static_cast<size_t>(beatInBar)] : beatInBar == 0;
            isClicking = true;
            clickSampleCounter = 0;
            nextBeatIndex += 1.0;
            nextBeatSample = std::ceil(nextBeatIndex * samplesPerBeat);
        }
        int span = numSamples - offset;
        if (active && activeSamples >= 0) span = juce::jmin(span, activeSamples - offset);
        if (active && nextBeatSample < currentSamplePosition + numSamples)
            span = juce::jlimit(1, span, static_cast<int>(nextBeatSample - position));
        const auto& source = isHighClick ? clickData->highClickBuffer : clickData->lowClickBuffer;
        if (isClicking && (source.getNumChannels() == 0 || clickSampleCounter >= source.getNumSamples()))
            isClicking = false;
        if (isClicking) span = juce::jmin(span, source.getNumSamples() - clickSampleCounter);

        if (!isClicking && transitionSamplesLeft == 0)
        {
            clickGain.skip(span);
            lastClickOutput = 0.0f;
        }
        else if (isClicking && !clickGain.isSmoothing() && transitionSamplesLeft == 0)
        {
            const auto* samples = source.getReadPointer(0) + clickSampleCounter;
            const float gain = clickGain.getCurrentValue();
            juce::FloatVectorOperations::addWithMultiply(left + offset, samples, gain, span);
            if (right != nullptr) juce::FloatVectorOperations::addWithMultiply(right + offset, samples, gain, span);
            lastClickOutput = samples[span - 1] * gain;
            clickSampleCounter += span;
        }
        else
        {
            for (int index = 0; index < span; ++index)
            {
                const float gain = clickGain.getNextValue();
                float value = isClicking ? source.getSample(0, clickSampleCounter++) * gain : 0.0f;
                if (transitionSamplesLeft > 0)
                    value += transitionTail * static_cast<float>(transitionSamplesLeft--) / static_cast<float>(transitionLength);
                left[offset + index] += value;
                if (right != nullptr) right[offset + index] += value;
                lastClickOutput = value;
            }
        }
        offset += span;
    }
    lastSamplePosition = active ? currentSamplePosition + numSamples : -1.0;
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
            juce::jlimit(0.0f, 1.0f, newVolume),
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
    std::unique_ptr<juce::OutputStream> outputStream = std::make_unique<juce::FileOutputStream>(outputFile);
    if (static_cast<juce::FileOutputStream&>(*outputStream).failedToOpen())
        return false;

    auto writer = wavFormat.createWriterFor(
        outputStream,
        juce::AudioFormatWriterOptions()
            .withSampleRate(renderSampleRate)
            .withNumChannels(2)
            .withBitsPerSample(16));

    if (!writer)
        return false;

    // Offline export must not reset or resume the live/practice clock. Snapshot
    // configuration into a separate generator with independent audio state.
    Metronome renderer;
    renderer.prepareToPlay(renderSampleRate, 512);
    renderer.setBpm(getBpm());
    renderer.packedTimeSignature.store(packedTimeSignature.load(std::memory_order_acquire));
    renderer.setVolume(getVolume());
    renderer.clickGain.setCurrentAndTargetValue(getVolume());
    renderer.publishClickData(getClickDataSnapshot());
    renderer.setEnabled(true);

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
            renderer.getNextAudioBlock(subBuffer, currentPos);
            if (!writer->writeFromAudioSampleBuffer(subBuffer, 0, samplesToProcess)) return false;
        }
        else
        {
            renderer.getNextAudioBlock(buffer, currentPos);
            if (!writer->writeFromAudioSampleBuffer(buffer, 0, samplesToProcess)) return false;
        }

        currentPos += samplesToProcess;
        samplesRemaining -= samplesToProcess;
    }

    return true;
}

// =============================================================================
// Phase 9C: Custom Click Sounds
// =============================================================================

bool Metronome::loadSoundFromFile(
    const juce::String& filePath, double targetSampleRate,
    juce::AudioBuffer<float>& targetBuffer, juce::var& info)
{
    auto* status = new juce::DynamicObject();
    info = juce::var(status);
    const auto fail = [&] (const juce::String& message)
    {
        status->setProperty("error", message);
        return false;
    };
    if (!juce::File::isAbsolutePath(filePath)) return fail("Choose a local audio file.");
    const juce::File audioFile(filePath);
    if (!audioFile.existsAsFile()) return fail("This audio file is missing. Choose it again or select a built-in sound.");
    if (audioFile.getSize() > 64 * 1024 * 1024) return fail("This file is too large. Export a short click sample under 64 MB.");
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (!reader) return fail("Could not read this file. Choose WAV, AIFF, FLAC or Ogg audio.");
    if (!std::isfinite(reader->sampleRate) || reader->sampleRate < 8000.0 || reader->sampleRate > 384000.0
        || reader->numChannels < 1 || reader->numChannels > 8)
        return fail("Use 1-8 channels and a sample rate from 8 to 384 kHz.");
    const int count = static_cast<int>(juce::jmin(reader->lengthInSamples,
        static_cast<juce::int64>(reader->sampleRate * 2.0)));
    if (count < 8) return fail("This audio file is empty or too short.");
    juce::AudioBuffer<float> source(static_cast<int>(reader->numChannels), count);
    if (!reader->read(&source, 0, count, 0, true, true)) return fail("Could not decode this audio sample.");
    const auto cacheDirectory = AppPaths::applicationData().getChildFile("MetronomeSounds");
    const bool cachedInput = audioFile.getParentDirectory() == cacheDirectory;
    auto prepared = MetronomeSounds::PreparedClick();
    if (cachedInput)
    {
        const float peak = source.getMagnitude(0, count);
        if (reader->sampleRate != MetronomeSounds::preparedRate || reader->numChannels != 1
            || count > MetronomeSounds::preparedRate * MetronomeSounds::maximumClickSeconds
            || !std::isfinite(peak) || peak < 0.001f || peak > 0.81f)
            return fail("This prepared click is damaged. Choose the original sample again.");
        for (int sample = 0; sample < count; ++sample)
            if (!std::isfinite(source.getSample(0, sample)))
                return fail("This prepared click is damaged. Choose the original sample again.");
        prepared.audio = source;
    }
    else prepared = MetronomeSounds::prepare(source, reader->sampleRate);
    if (prepared.error.isNotEmpty()) return fail(prepared.error);
    targetBuffer = std::move(prepared.audio);

    // Cache the usable click, not a fragile reference to a Downloads/removable file.
    // Content addressing lets Regular and Accent share an identical prepared sample.
    const auto hash = juce::SHA256(targetBuffer.getReadPointer(0),
        static_cast<size_t>(targetBuffer.getNumSamples()) * sizeof(float)).toHexString();
    const auto cached = cachedInput ? audioFile : cacheDirectory.getChildFile(hash + ".wav");
    if (!cached.existsAsFile())
    {
        if (!cacheDirectory.createDirectory()) return fail("Could not save the prepared click. Check your app-data folder permissions.");
        juce::TemporaryFile temporary(cached);
        std::unique_ptr<juce::OutputStream> stream(temporary.getFile().createOutputStream());
        juce::WavAudioFormat format;
        auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
            .withSampleRate(MetronomeSounds::preparedRate).withNumChannels(1).withBitsPerSample(24));
        if (!writer || !writer->writeFromAudioSampleBuffer(targetBuffer, 0, targetBuffer.getNumSamples()))
            return fail("Could not save the prepared click sample.");
        writer.reset();
        if (!temporary.overwriteTargetFileWithTemporary()) return fail("Could not publish the prepared click sample.");
    }
    status->setProperty("selection", cached.getFullPathName());
    status->setProperty("name", audioFile.getFileName());
    status->setProperty("removedLeadMs", prepared.removedLeadMs);
    status->setProperty("peakMs", MetronomeSounds::peakTimeSeconds * 1000.0);
    status->setProperty("durationMs", targetBuffer.getNumSamples() * 1000.0 / MetronomeSounds::preparedRate);
    status->setProperty("monoChannel", prepared.selectedChannel + 1);
    status->setProperty("sourceChannels", static_cast<int>(reader->numChannels));
    status->setProperty("shortened", prepared.shortened || reader->lengthInSamples > count);
    const auto metadataFile = juce::File(cached.getFullPathName() + ".json");
    if (cachedInput)
    {
        const auto metadata = juce::JSON::parse(metadataFile);
        if (const auto* details = metadata.getDynamicObject())
            status->getProperties() = details->getProperties();
        status->setProperty("selection", cached.getFullPathName());
    }
    else if (!metadataFile.existsAsFile())
        (void) metadataFile.replaceWithText(juce::JSON::toString(info));
    juce::ignoreUnused(targetSampleRate);
    return true;
}

bool Metronome::setSound(const juce::String& selection, bool accent)
{
    const juce::ScopedLock mutationGuard(clickDataMutationLock);
    const int slot = accent ? 1 : 0;
    soundErrors[slot].clear();
    const double rate = sampleRate.load(std::memory_order_relaxed);
    juce::AudioBuffer<float> replacement, prepared;
    juce::var info;
    const bool builtIn = MetronomeSounds::isBuiltIn(selection);
    juce::String acceptedSelection = selection;
    if (selection.isEmpty())
    {
        juce::AudioBuffer<float> unused;
        if (accent) generateDefaultClickSounds(rate, replacement, unused);
        else generateDefaultClickSounds(rate, unused, replacement);
    }
    else if (builtIn) replacement = MetronomeSounds::synthesise(selection, accent, rate);
    else
    {
        if (selection.startsWith("builtin:"))
        {
            soundErrors[slot] = "Unknown built-in click sound.";
            return false;
        }
        if (!loadSoundFromFile(selection, rate, prepared, info))
        {
            soundErrors[slot] = info["error"].toString();
            return false;
        }
        acceptedSelection = info["selection"].toString();
        replacement = MetronomeSounds::resample(prepared, MetronomeSounds::preparedRate, rate);
    }
    const auto current = getClickDataSnapshot();
    auto next = current != nullptr ? std::make_shared<ClickData>(*current) : createDefaultClickData(rate);
    if (accent)
    {
        next->highClickBuffer = std::move(replacement);
        next->preparedAccent = std::move(prepared);
        next->usingCustomAccent = !builtIn;
        next->customAccentPath = acceptedSelection;
        next->accentInfo = info;
    }
    else
    {
        next->lowClickBuffer = std::move(replacement);
        next->preparedRegular = std::move(prepared);
        next->usingCustomClick = !builtIn;
        next->customClickPath = acceptedSelection;
        next->regularInfo = info;
    }
    ++next->soundRevision;
    publishClickData(next);
    return true;
}

bool Metronome::setClickSound(const juce::String& selection) { return setSound(selection, false); }
bool Metronome::setAccentSound(const juce::String& selection) { return setSound(selection, true); }

juce::var Metronome::getSoundInfo(bool accent) const
{
    const juce::ScopedLock mutationGuard(clickDataMutationLock);
    const auto snapshot = getClickDataSnapshot();
    auto* status = new juce::DynamicObject();
    if (snapshot != nullptr)
    {
        const auto details = accent ? snapshot->accentInfo : snapshot->regularInfo;
        if (const auto* object = details.getDynamicObject()) status->getProperties() = object->getProperties();
        status->setProperty("selection", accent ? snapshot->customAccentPath : snapshot->customClickPath);
    }
    status->setProperty("error", soundErrors[accent ? 1 : 0]);
    return juce::var(status);
}

void Metronome::resetToDefaultSounds()
{
    const juce::ScopedLock mutationGuard(
        clickDataMutationLock);
    soundErrors[0].clear();
    soundErrors[1].clear();
    auto nextData =
        createDefaultClickData(
            sampleRate.load(
                std::memory_order_relaxed));
    const auto currentData =
        getClickDataSnapshot();
    if (currentData != nullptr) nextData->soundRevision = currentData->soundRevision + 1;
    if (currentData != nullptr)
    {
        nextData->accentBeats =
            currentData->accentBeats;
    }
    publishClickData(nextData);
}
