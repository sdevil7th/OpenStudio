#include "PlaybackEngine.h"
#include <algorithm>
#include <cmath>
#include <thread>

namespace
{
constexpr unsigned int kPitchRouteScrubPreview = 1u << 0;
constexpr unsigned int kPitchRouteClipLivePreview = 1u << 1;
constexpr unsigned int kPitchRouteRenderedSegment = 1u << 2;
constexpr unsigned int kPitchRouteCorrectedSource = 1u << 3;

#ifndef OPENSTUDIO_AUDIO_PLAYBACK_DEBUG
 #define OPENSTUDIO_AUDIO_PLAYBACK_DEBUG 0
#endif

#if OPENSTUDIO_AUDIO_PLAYBACK_DEBUG
constexpr bool kAudioPlaybackDebugLogs = true;
static void logAudioPlayback(const juce::String& message)
{
    juce::Logger::writeToLog("[audio.playback] " + message);
}
 #define OPENSTUDIO_LOG_AUDIO_PLAYBACK(message) logAudioPlayback(message)
#else
constexpr bool kAudioPlaybackDebugLogs = false;
 #define OPENSTUDIO_LOG_AUDIO_PLAYBACK(message) do { } while (false)
#endif

class StereoStreamingSourceReader final : public juce::AudioFormatReader
{
public:
    explicit StereoStreamingSourceReader(std::unique_ptr<juce::AudioFormatReader> sourceReader)
        : juce::AudioFormatReader(nullptr, sourceReader->getFormatName()),
          source(std::move(sourceReader))
    {
        sampleRate = source->sampleRate;
        lengthInSamples = source->lengthInSamples;
        numChannels = juce::jmin(static_cast<unsigned int>(2), source->numChannels);
        bitsPerSample = source->bitsPerSample;
        usesFloatingPointData = source->usesFloatingPointData;
        metadataValues = source->metadataValues;
    }

    bool readSamples(int* const* destSamples,
                     int numDestChannels,
                     int startOffsetInDestBuffer,
                     juce::int64 startSampleInFile,
                     int numSamples) override
    {
        int* shiftedDestinations[2] { nullptr, nullptr };
        const int channelsToRead = juce::jlimit(0, 2, numDestChannels);
        for (int channel = 0; channel < channelsToRead; ++channel)
        {
            if (destSamples[channel] != nullptr)
                shiftedDestinations[channel] = destSamples[channel] + startOffsetInDestBuffer;
        }

        return source->read(shiftedDestinations,
                            channelsToRead,
                            startSampleInFile,
                            numSamples,
                            true);
    }

private:
    std::unique_ptr<juce::AudioFormatReader> source;
};

static float peakForBuffer(const juce::AudioBuffer<float>& buffer, int numSamples)
{
    float peak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        auto range = juce::FloatVectorOperations::findMinAndMax(buffer.getReadPointer(ch), numSamples);
        peak = juce::jmax(peak, juce::jmax(std::abs(range.getStart()), std::abs(range.getEnd())));
    }
    return peak;
}

static float getPitchOnlyPreviewTonalityLimitHz (bool downwardShift)
{
    const auto specificName = downwardShift
        ? "OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ_DOWN"
        : "OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ_UP";
    const auto specificValue = juce::SystemStats::getEnvironmentVariable (specificName, {}).trim();
    if (specificValue.isNotEmpty())
        return juce::jlimit (0.0f, 20000.0f, specificValue.getFloatValue());

    const auto value = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ", {}).trim();
    if (value.isEmpty())
        return downwardShift ? 2600.0f : 1050.0f;

    return juce::jlimit (0.0f, 20000.0f, value.getFloatValue());
}

static float sampleLoopBufferLocal (const juce::AudioBuffer<float>& buffer,
                                    int channel,
                                    double position,
                                    int crossfadeSamples)
{
    const int numChannels = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    if (numChannels <= 0 || numSamples <= 1)
        return 0.0f;

    const int safeChannel = juce::jlimit (0, numChannels - 1, channel);
    auto wrapPosition = std::fmod (position, static_cast<double> (numSamples));
    if (wrapPosition < 0.0)
        wrapPosition += static_cast<double> (numSamples);

    const auto sampleAt = [&buffer, safeChannel, numSamples] (double pos)
    {
        auto wrapped = std::fmod (pos, static_cast<double> (numSamples));
        if (wrapped < 0.0)
            wrapped += static_cast<double> (numSamples);
        const int index0 = juce::jlimit (0, numSamples - 1, static_cast<int> (std::floor (wrapped)));
        const int index1 = (index0 + 1) % numSamples;
        const float frac = static_cast<float> (wrapped - static_cast<double> (index0));
        const float s0 = buffer.getSample (safeChannel, index0);
        const float s1 = buffer.getSample (safeChannel, index1);
        return s0 + (s1 - s0) * frac;
    };

    float value = sampleAt (wrapPosition);
    const int safeCrossfade = juce::jlimit (0, numSamples / 3, crossfadeSamples);
    if (safeCrossfade <= 1)
        return value;

    const double crossfadeStart = static_cast<double> (numSamples - safeCrossfade);
    if (wrapPosition >= crossfadeStart)
    {
        const float blend = static_cast<float> ((wrapPosition - crossfadeStart)
            / static_cast<double> (safeCrossfade));
        const float wrappedValue = sampleAt (wrapPosition - static_cast<double> (numSamples));
        value = value * (1.0f - blend) + wrappedValue * blend;
    }

    return value;
}

static float sampleBufferCubic (const juce::AudioBuffer<float>& buffer,
                                int channel,
                                int availableSamples,
                                double position)
{
    if (availableSamples <= 0 || buffer.getNumChannels() <= 0)
        return 0.0f;

    const int safeChannel = juce::jlimit (0, buffer.getNumChannels() - 1, channel);
    if (availableSamples == 1)
        return buffer.getSample (safeChannel, 0);

    const double clampedPosition = juce::jlimit (0.0,
                                                 static_cast<double> (availableSamples - 1),
                                                 position);
    const int i1 = juce::jlimit (0, availableSamples - 1,
                                 static_cast<int> (std::floor (clampedPosition)));
    const int i0 = juce::jlimit (0, availableSamples - 1, i1 - 1);
    const int i2 = juce::jlimit (0, availableSamples - 1, i1 + 1);
    const int i3 = juce::jlimit (0, availableSamples - 1, i1 + 2);
    const float t = static_cast<float> (clampedPosition - static_cast<double> (i1));
    const float t2 = t * t;
    const float t3 = t2 * t;
    const float y0 = buffer.getSample (safeChannel, i0);
    const float y1 = buffer.getSample (safeChannel, i1);
    const float y2 = buffer.getSample (safeChannel, i2);
    const float y3 = buffer.getSample (safeChannel, i3);

    return 0.5f * ((2.0f * y1)
        + (-y0 + y2) * t
        + (2.0f * y0 - 5.0f * y1 + 4.0f * y2 - y3) * t2
        + (-y0 + 3.0f * y1 - 3.0f * y2 + y3) * t3);
}
}

float PlaybackEngine::applyFadeCurve(float t, int curveType)
{
    // t is normalized 0.0 to 1.0
    switch (curveType) {
        case 1: return std::sqrt(t);                                          // equal power
        case 2: return 3.0f * t * t - 2.0f * t * t * t;                      // S-curve (smoothstep)
        case 3: return std::log10(1.0f + 9.0f * t);                           // logarithmic
        case 4: return (std::exp(3.0f * t) - 1.0f) / (std::exp(3.0f) - 1.0f); // exponential
        default: return t;                                                     // linear (0 or unknown)
    }
}

void PlaybackEngine::StreamingContinuityState::reset(
    int channels) noexcept
{
    lastOutput.fill(0.0f);
    concealedOutput.fill(0.0f);
    expectedNextTimelineTime = 0.0;
    recoverySamplesRemaining = 0;
    activeChannels = juce::jlimit(0, 2, channels);
    hasOutputHistory = false;
    hasExpectedTimelineTime = false;
    concealing = false;
}

bool PlaybackEngine::StreamingContinuityState::beginBlock(
    bool sourceReady,
    bool timelineContiguous,
    int channels) noexcept
{
    const int boundedChannels =
        juce::jlimit(0, 2, channels);
    if (! timelineContiguous
        || activeChannels != boundedChannels)
    {
        reset(boundedChannels);
    }

    if (! sourceReady)
    {
        if (! concealing)
        {
            for (int channel = 0;
                 channel < activeChannels;
                 ++channel)
            {
                const float previous =
                    hasOutputHistory
                        && std::isfinite(lastOutput[
                            static_cast<size_t>(channel)])
                            ? lastOutput[
                                static_cast<size_t>(channel)]
                            : 0.0f;
                concealedOutput[
                    static_cast<size_t>(channel)] =
                        previous;
            }
        }

        concealing = true;
        recoverySamplesRemaining = 0;
        return false;
    }

    if (concealing)
    {
        concealing = false;
        recoverySamplesRemaining =
            STREAMING_RECOVERY_SAMPLES;
        return true;
    }

    return false;
}

float PlaybackEngine::StreamingContinuityState::processSample(
    int channel,
    float sourceSample,
    bool sourceReady) noexcept
{
    if (channel < 0 || channel >= activeChannels)
        return sourceReady ? sourceSample : 0.0f;

    const auto index = static_cast<size_t>(channel);
    float output = sourceSample;

    if (! sourceReady)
    {
        concealedOutput[index] =
            std::isfinite(concealedOutput[index])
                ? concealedOutput[index]
                    * STREAMING_CONCEALMENT_DECAY
                : 0.0f;
        output = concealedOutput[index];
    }
    else if (recoverySamplesRemaining > 0)
    {
        concealedOutput[index] =
            std::isfinite(concealedOutput[index])
                ? concealedOutput[index]
                    * STREAMING_CONCEALMENT_DECAY
                : 0.0f;
        const float recoveryProgress =
            static_cast<float>(
                STREAMING_RECOVERY_SAMPLES
                - recoverySamplesRemaining
                + 1)
            / static_cast<float>(
                STREAMING_RECOVERY_SAMPLES);
        output = concealedOutput[index]
            + recoveryProgress
                * (sourceSample
                   - concealedOutput[index]);
    }

    lastOutput[index] =
        std::isfinite(output) ? output : 0.0f;
    return lastOutput[index];
}

void PlaybackEngine::StreamingContinuityState::advanceFrame(
    bool sourceReady) noexcept
{
    if (sourceReady
        && recoverySamplesRemaining > 0)
    {
        --recoverySamplesRemaining;
        if (recoverySamplesRemaining == 0)
            concealedOutput = lastOutput;
    }

    hasOutputHistory = true;
}

PlaybackEngine::StreamingContinuityState&
PlaybackEngine::getTrackPlaybackContinuityState(
    const juce::String& trackId) noexcept
{
    juce::int64 trackKey = trackId.hashCode64();
    if (trackKey == 0)
        trackKey = 1;

    ++trackPlaybackContinuityUseCounter;
    if (trackPlaybackContinuityUseCounter == 0)
        trackPlaybackContinuityUseCounter = 1;

    const auto startIndex =
        static_cast<size_t>(
            static_cast<juce::uint64>(trackKey)
            % TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT);
    size_t emptyIndex =
        TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT;
    size_t oldestIndex = startIndex;
    juce::uint64 oldestUse =
        std::numeric_limits<juce::uint64>::max();

    for (size_t probe = 0;
         probe < TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT;
         ++probe)
    {
        const auto index =
            (startIndex + probe)
            % TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT;
        auto& slot =
            trackPlaybackContinuitySlots[index];
        if (slot.trackKey == trackKey)
        {
            slot.lastUseCounter =
                trackPlaybackContinuityUseCounter;
            return slot.continuity;
        }
        if (slot.trackKey == 0
            && emptyIndex
                == TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT)
        {
            emptyIndex = index;
        }
        if (slot.lastUseCounter < oldestUse)
        {
            oldestUse = slot.lastUseCounter;
            oldestIndex = index;
        }
    }

    const auto selectedIndex =
        emptyIndex
            < TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT
                ? emptyIndex
                : oldestIndex;
    auto& selected =
        trackPlaybackContinuitySlots[
            selectedIndex];
    selected = {};
    selected.trackKey = trackKey;
    selected.lastUseCounter =
        trackPlaybackContinuityUseCounter;
    return selected.continuity;
}

PlaybackEngine::StreamingContinuityRegressionResult
PlaybackEngine::runStreamingContinuityRegression() noexcept
{
    auto prepareMiss =
        [] (StreamingContinuityState& state)
    {
        state.reset(1);
        state.beginBlock(true, false, 1);
        for (int sample = 0; sample < 16; ++sample)
        {
            state.processSample(
                0, 0.8f, true);
            state.advanceFrame(true);
        }

        const float preMiss =
            state.lastOutput[0];
        state.beginBlock(false, true, 1);
        float firstConcealed = 0.0f;
        for (int sample = 0; sample < 16; ++sample)
        {
            const float concealed =
                state.processSample(
                    0, 0.0f, false);
            if (sample == 0)
                firstConcealed = concealed;
            state.advanceFrame(false);
        }
        return std::pair<float, float>(
            std::abs(firstConcealed - preMiss),
            state.lastOutput[0]);
    };

    StreamingContinuityState fixedState;
    const auto fixedMiss =
        prepareMiss(fixedState);
    std::array<float,
               STREAMING_RECOVERY_SAMPLES>
        fixedRecovery {};
    fixedState.beginBlock(true, true, 1);
    float fixedPrevious = fixedMiss.second;
    float recoveryMaximumStep = 0.0f;
    for (int sample = 0;
         sample < STREAMING_RECOVERY_SAMPLES;
         ++sample)
    {
        const float output =
            fixedState.processSample(
                0, -0.8f, true);
        fixedRecovery[
            static_cast<size_t>(sample)] =
                output;
        recoveryMaximumStep =
            juce::jmax(
                recoveryMaximumStep,
                std::abs(output - fixedPrevious));
        fixedPrevious = output;
        fixedState.advanceFrame(true);
    }

    StreamingContinuityState partitionedState;
    prepareMiss(partitionedState);
    std::array<float,
               STREAMING_RECOVERY_SAMPLES>
        partitionedRecovery {};
    for (int block = 0; block < 4; ++block)
    {
        partitionedState.beginBlock(
            true, true, 1);
        for (int sample = 0; sample < 16; ++sample)
        {
            const auto outputIndex =
                static_cast<size_t>(
                    block * 16 + sample);
            partitionedRecovery[outputIndex] =
                partitionedState.processSample(
                    0, -0.8f, true);
            partitionedState.advanceFrame(true);
        }
    }

    float partitionMaximumDifference = 0.0f;
    for (size_t sample = 0;
         sample < fixedRecovery.size();
         ++sample)
    {
        partitionMaximumDifference =
            juce::jmax(
                partitionMaximumDifference,
                std::abs(
                    fixedRecovery[sample]
                    - partitionedRecovery[sample]));
    }

    StreamingContinuityState fadeState;
    prepareMiss(fadeState);
    float fadeToZeroFinalSample = 0.0f;
    fadeState.beginBlock(false, true, 1);
    for (int sample = 0; sample < 16; ++sample)
    {
        const float rawConcealedSample =
            fadeState.processSample(
                0, 0.0f, false);
        const float currentFadeGain =
            1.0f
            - static_cast<float>(sample + 1)
                / 16.0f;
        fadeToZeroFinalSample =
            rawConcealedSample
            * currentFadeGain;
        fadeState.advanceFrame(false);
    }

    StreamingContinuityRegressionResult result;
    result.concealmentEntryStep =
        fixedMiss.first;
    result.recoveryMaximumStep =
        recoveryMaximumStep;
    result.partitionMaximumDifference =
        partitionMaximumDifference;
    result.recoveredSample =
        fixedRecovery.back();
    result.fadeToZeroFinalSample =
        fadeToZeroFinalSample;
    result.passed =
        result.concealmentEntryStep <= 0.001f
        && result.recoveryMaximumStep <= 0.03f
        && result.partitionMaximumDifference
            <= 1.0e-7f
        && std::abs(
            result.recoveredSample + 0.8f)
            <= 1.0e-6f
        && std::abs(
            result.fadeToZeroFinalSample)
            <= 1.0e-7f;
    return result;
}

PlaybackEngine::OuterLockContinuityRegressionResult
PlaybackEngine::runOuterLockContinuityRegression()
{
    constexpr double fixtureSampleRate = 48000.0;
    constexpr int missSamples = 16;
    constexpr int recoverySamples =
        STREAMING_RECOVERY_SAMPLES;
    const juce::String trackId(
        "outer-lock-continuity-fixture");

    PlaybackEngine probe;
    auto& continuity =
        probe.getTrackPlaybackContinuityState(
            trackId);
    continuity.reset(1);
    continuity.beginBlock(true, false, 1);
    for (int sample = 0;
         sample < missSamples;
         ++sample)
    {
        continuity.processSample(
            0, 0.8f, true);
        continuity.advanceFrame(true);
    }
    continuity.expectedNextTimelineTime = 0.0;
    continuity.hasExpectedTimelineTime = true;
    const float preMissSample =
        continuity.lastOutput[0];

    juce::AudioBuffer<float> concealed(
        1, missSamples);
    concealed.clear();
    {
        const juce::ScopedLock publicationGuard(
            probe.lock);
        std::thread callbackThread(
            [&]
            {
                probe.fillTrackBuffer(
                    trackId,
                    concealed,
                    0.0,
                    missSamples,
                    fixtureSampleRate);
            });
        callbackThread.join();
    }

    juce::AudioBuffer<float> recovered(
        1, recoverySamples);
    recovered.clear();
    probe.fillTrackBuffer(
        trackId,
        recovered,
        static_cast<double>(missSamples)
            / fixtureSampleRate,
        recoverySamples,
        fixtureSampleRate);

    OuterLockContinuityRegressionResult result;
    result.tryLockMisses =
        probe.getTryLockFailureCount();
    result.concealmentEvents =
        probe
            .getOuterLockContinuityConcealmentCount();
    result.recoveryEvents =
        probe
            .getOuterLockContinuityRecoveryCount();
    result.concealmentEntryStep =
        std::abs(
            concealed.getSample(0, 0)
            - preMissSample);
    result.recoveryEntryStep =
        std::abs(
            recovered.getSample(0, 0)
            - concealed.getSample(
                0, missSamples - 1));
    result.recoveredSample =
        recovered.getSample(
            0, recoverySamples - 1);
    result.passed =
        result.tryLockMisses == 1
        && result.concealmentEvents == 1
        && result.recoveryEvents == 1
        && result.concealmentEntryStep
            <= 0.001f
        && result.recoveryEntryStep
            <= 0.02f
        && std::abs(result.recoveredSample)
            <= 1.0e-6f;
    return result;
}

PlaybackEngine::PlaybackEngine()
{
    formatManager.registerBasicFormats();
    streamingReadAheadThread.startThread(juce::Thread::Priority::normal);

    // Pre-allocate pitch-preview channel-pointer vectors (max stereo = 2 channels).
    // Avoids heap allocation inside fillTrackBuffer for every pitch-previewed clip.
    pitchPreviewInPtrs.resize (2);
    pitchPreviewOutPtrs.resize (2);
    reusableChunkBoundaries.reserve (64);
    reusableFileBuffer.setSize(2, 65536, false, true, false);
    reusableTrackPlaybackBuffer.setSize(
        2, 65536, false, true, false);
    pitchShiftWorkBuffer.setSize(2, 65536, false, true, false);
}

PlaybackEngine::~PlaybackEngine()
{
    streamingReadAheadThread.stopThread(2000);
    juce::ScopedLock sl(lock);
    readers.clear();
    streamingContinuityStates.clear();
    refreshStreamingReaderDiagnosticsLocked();
    fullyDecodedSources.clear();
    fullyDecodedSourceAccessTimes.clear();
    fullyDecodedBytesInUse = 0;
    refreshFullyDecodedSourceDiagnosticsLocked();
    clips.clear();
}

void PlaybackEngine::refreshStreamingReaderDiagnosticsLocked() noexcept
{
    juce::int64 capacityBytes = 0;
    constexpr juce::int64 bufferedFramesPerReader =
        static_cast<juce::int64>(STREAMING_READ_AHEAD_SAMPLES) * 2;

    for (const auto& [path, reader] : readers)
    {
        juce::ignoreUnused(path);
        if (reader != nullptr)
        {
            capacityBytes += bufferedFramesPerReader
                * static_cast<juce::int64>(reader->numChannels)
                * static_cast<juce::int64>(sizeof(float));
        }
    }

    cachedReaderCount.store(static_cast<int>(readers.size()), std::memory_order_release);
    cachedStreamingReadAheadCapacityBytes.store(capacityBytes, std::memory_order_release);
}

void PlaybackEngine::refreshFullyDecodedSourceDiagnosticsLocked() noexcept
{
    fullyDecodedSourceCount.store(
        static_cast<int>(fullyDecodedSources.size()),
        std::memory_order_release);
    fullyDecodedSourceBytes.store(
        fullyDecodedBytesInUse,
        std::memory_order_release);
}

void PlaybackEngine::refreshPitchPreviewRoutingDiagnosticsLocked() noexcept
{
    unsigned int flags = 0;
    if (pitchScrubPreview.active || pitchScrubPreview.releasePending)
        flags |= kPitchRouteScrubPreview;
    if (!clipPitchPreviews.empty())
        flags |= kPitchRouteClipLivePreview;
    if (!renderedPreviewSegments.empty())
        flags |= kPitchRouteRenderedSegment;
    if (!pitchCorrectedFiles.empty())
        flags |= kPitchRouteCorrectedSource;

    pitchPreviewRoutingDiagnosticFlags.store(flags, std::memory_order_release);
}

bool PlaybackEngine::primeStreamingReader(juce::BufferingAudioReader& reader,
                                          double offsetSeconds,
                                          int maxWaitMilliseconds)
{
    const int channels = juce::jmax(1, static_cast<int>(reader.numChannels));
    juce::AudioBuffer<float> scratch(channels, 1);
    scratch.clear();
    const auto samplePosition = static_cast<juce::int64>(
        juce::jmax(0.0, offsetSeconds) * reader.sampleRate);
    if (maxWaitMilliseconds > 0)
        reader.setReadTimeout(maxWaitMilliseconds);
    const bool ready = reader.read(&scratch, 0, 1, samplePosition, true, true);
    if (maxWaitMilliseconds > 0)
        reader.setReadTimeout(0);
    return ready;
}

void PlaybackEngine::preloadReader(const juce::File& file,
                                   const juce::String& readerKey,
                                   double initialOffsetSeconds,
                                   int maxWaitMilliseconds)
{
    // Reader construction and full-file decoding happen before taking the clip
    // publication lock. The callback can keep the previously published state.
    const auto filePath = file.getFullPathName();
    const auto cacheKey = readerKey.isNotEmpty() ? readerKey : filePath;
    std::shared_ptr<juce::BufferingAudioReader> existingReader;
    {
        const juce::ScopedLock sl(lock);
        auto decoded = fullyDecodedSources.find(cacheKey);
        if (decoded != fullyDecodedSources.end()
            && decoded->second != nullptr)
        {
            fullyDecodedSourceAccessTimes[cacheKey] =
                juce::Time::currentTimeMillis();
            return;
        }

        auto existing = readers.find(cacheKey);
        if (existing != readers.end() && existing->second != nullptr)
        {
            readerAccessTimes[cacheKey] = juce::Time::currentTimeMillis();
            existingReader = existing->second;
        }
    }
    if (existingReader != nullptr)
    {
        // Published readers always keep timeout=0. This call only moves the
        // background thread's requested position and cannot wait for decoding.
        primeStreamingReader(*existingReader, initialOffsetSeconds, 0);
        return;
    }

    std::unique_ptr<juce::AudioFormatReader> sourceReader(formatManager.createReaderFor(file));
    if (sourceReader == nullptr)
    {
        juce::Logger::writeToLog("PlaybackEngine: Failed to create streaming reader for: " + filePath);
        return;
    }

    const int decodedChannels = juce::jlimit(
        0, 2, static_cast<int>(sourceReader->numChannels));
    const auto sourceLength = sourceReader->lengthInSamples;
    const auto bytesPerFrame =
        static_cast<juce::int64>(decodedChannels)
        * static_cast<juce::int64>(sizeof(float));
    const bool eligibleForFullDecode =
        decodedChannels > 0
        && sourceReader->sampleRate > 0.0
        && sourceLength > 0
        && sourceLength
            <= static_cast<juce::int64>(
                std::numeric_limits<int>::max())
        && bytesPerFrame > 0
        && sourceLength
            <= MAX_FULLY_DECODED_SOURCE_BYTES
                / bytesPerFrame;

    if (eligibleForFullDecode)
    {
        auto decodedSource =
            std::make_unique<FullyDecodedSource>();
        decodedSource->sampleRate = sourceReader->sampleRate;
        decodedSource->lengthInSamples = sourceLength;
        decodedSource->numChannels = decodedChannels;
        decodedSource->decodedBytes =
            sourceLength * bytesPerFrame;
        decodedSource->samples.setSize(
            decodedChannels,
            static_cast<int>(sourceLength),
            false,
            true,
            false);

        const bool decodedCompletely = sourceReader->read(
            &decodedSource->samples,
            0,
            static_cast<int>(sourceLength),
            0,
            true,
            true);
        if (decodedCompletely)
        {
            bool publishedDecodedSource = false;
            bool decodedSourceAlreadyPublished = false;
            std::vector<std::unique_ptr<FullyDecodedSource>>
                retiredSources;
            {
                const juce::ScopedLock sl(lock);
                auto existingDecoded =
                    fullyDecodedSources.find(cacheKey);
                decodedSourceAlreadyPublished =
                    existingDecoded
                        != fullyDecodedSources.end()
                    && existingDecoded->second != nullptr;

                if (! decodedSourceAlreadyPublished
                    && evictFullyDecodedSourcesToFitLocked(
                        decodedSource->decodedBytes,
                        cacheKey,
                        retiredSources))
                {
                    fullyDecodedBytesInUse +=
                        decodedSource->decodedBytes;
                    fullyDecodedSources.emplace(
                        cacheKey,
                        std::move(decodedSource));
                    fullyDecodedSourceAccessTimes[cacheKey] =
                        juce::Time::currentTimeMillis();
                    refreshFullyDecodedSourceDiagnosticsLocked();
                    publishedDecodedSource = true;
                }
                else if (decodedSourceAlreadyPublished)
                {
                    fullyDecodedSourceAccessTimes[cacheKey] =
                        juce::Time::currentTimeMillis();
                }
            }

            // Potentially large sample buffers are destroyed here, after the
            // publication guard has been released.
            retiredSources.clear();

            if (publishedDecodedSource
                || decodedSourceAlreadyPublished)
            {
                juce::Logger::writeToLog(
                    "PlaybackEngine: Prepared fully decoded source ("
                    + juce::String(
                        sourceLength * bytesPerFrame)
                    + " bytes): "
                    + filePath);
                return;
            }

            fullyDecodedSourceBudgetFallbackCount.fetch_add(
                1, std::memory_order_relaxed);
        }
    }

    // Large sources, corrupt/partial decodes, and decoded-cache budget misses
    // retain the bounded streaming path. Its timeout remains zero once
    // published, so the callback reports a cache miss rather than waiting.
    auto stereoReader = std::make_unique<StereoStreamingSourceReader>(std::move(sourceReader));
    auto bufferedReader = std::make_shared<juce::BufferingAudioReader>(
        stereoReader.release(),
        streamingReadAheadThread,
        STREAMING_READ_AHEAD_SAMPLES);
    bufferedReader->setReadTimeout(0);
    primeStreamingReader(*bufferedReader, initialOffsetSeconds, maxWaitMilliseconds);

    std::shared_ptr<juce::BufferingAudioReader> concurrentlyPublishedReader;
    {
        const juce::ScopedLock sl(lock);
        auto [it, inserted] = readers.emplace(cacheKey, bufferedReader);
        if (!inserted && it->second != nullptr)
            concurrentlyPublishedReader = it->second;
        streamingContinuityStates.try_emplace(cacheKey);
        readerAccessTimes[cacheKey] = juce::Time::currentTimeMillis();
        evictOldReaders(cacheKey);
    }
    if (concurrentlyPublishedReader != nullptr)
        primeStreamingReader(*concurrentlyPublishedReader, initialOffsetSeconds, 0);

    juce::Logger::writeToLog("PlaybackEngine: Prepared bounded streaming reader for: " + filePath);
}

juce::int64 PlaybackEngine::getStreamingReadAheadCapacityBytes() const
{
    return cachedStreamingReadAheadCapacityBytes.load(std::memory_order_acquire);
}

void PlaybackEngine::requestReadAheadAtTime(double timelineTimeSeconds)
{
    struct ReadAheadRequest
    {
        std::shared_ptr<juce::BufferingAudioReader> reader;
        double offsetSeconds = 0.0;
    };

    std::vector<ReadAheadRequest> requests;
    {
        const juce::ScopedLock sl(lock);
        requests.reserve(clips.size());
        constexpr double preRollSeconds = 2.0;

        for (const auto& clip : clips)
        {
            if (!clip.isActive
                || timelineTimeSeconds >= clip.startTime + clip.duration
                || timelineTimeSeconds + preRollSeconds < clip.startTime)
            {
                continue;
            }

            const double clipTime = juce::jmax(0.0, timelineTimeSeconds - clip.startTime);
            const juce::String* readerKey = &clip.readerKey;
            double sourceOffset = clip.offset + clipTime;

            auto segmentIt = renderedPreviewSegments.find(clip.clipId);
            if (segmentIt != renderedPreviewSegments.end())
            {
                for (const auto& segment : segmentIt->second)
                {
                    if (clipTime >= segment.startSec && clipTime < segment.endSec)
                    {
                        readerKey = &segment.readerKey;
                        sourceOffset = segment.fileOffsetSec + (clipTime - segment.startSec);
                        break;
                    }
                }
            }

            auto readerIt = readers.find(*readerKey);
            if (readerIt != readers.end() && readerIt->second != nullptr)
                requests.push_back({ readerIt->second, sourceOffset });
        }
    }

    // Published readers permanently use timeout=0. These calls only publish a
    // desired source position to JUCE's time-slice thread and never wait for I/O.
    for (const auto& request : requests)
        primeStreamingReader(*request.reader, request.offsetSeconds, 0);
}

juce::BufferingAudioReader* PlaybackEngine::getCachedReader(const juce::String& readerKey)
{
    auto it = readers.find(readerKey);
    if (it != readers.end() && it->second != nullptr)
        return it->second.get();
    return nullptr;
}

const PlaybackEngine::FullyDecodedSource*
PlaybackEngine::getFullyDecodedSource(
    const juce::String& readerKey) const noexcept
{
    auto it = fullyDecodedSources.find(readerKey);
    if (it != fullyDecodedSources.end()
        && it->second != nullptr)
    {
        return it->second.get();
    }
    return nullptr;
}

bool PlaybackEngine::evictFullyDecodedSourcesToFitLocked(
    juce::int64 requiredBytes,
    const juce::String& protectedKey,
    std::vector<std::unique_ptr<FullyDecodedSource>>& retiredSources)
{
    if (requiredBytes <= 0
        || requiredBytes > MAX_FULLY_DECODED_SOURCE_BYTES
        || requiredBytes > MAX_FULLY_DECODED_CACHE_BYTES)
    {
        return false;
    }

    if (fullyDecodedBytesInUse
            <= MAX_FULLY_DECODED_CACHE_BYTES
                - requiredBytes)
    {
        return true;
    }

    std::vector<juce::String> referencedKeys;
    referencedKeys.reserve(
        clips.size() + renderedPreviewSegments.size());
    for (const auto& clip : clips)
    {
        if (clip.isActive
            && clip.readerKey.isNotEmpty())
        {
            referencedKeys.push_back(clip.readerKey);
        }
    }
    for (const auto& [clipId, segments] :
         renderedPreviewSegments)
    {
        juce::ignoreUnused(clipId);
        for (const auto& segment : segments)
        {
            if (segment.readerKey.isNotEmpty())
                referencedKeys.push_back(
                    segment.readerKey);
        }
    }

    const auto isReferenced =
        [&] (const juce::String& key)
    {
        return key == protectedKey
            || std::find(
                referencedKeys.begin(),
                referencedKeys.end(),
                key) != referencedKeys.end();
    };

    std::vector<
        std::pair<juce::int64, juce::String>>
        candidates;
    candidates.reserve(
        fullyDecodedSourceAccessTimes.size());
    for (const auto& [key, accessTime] :
         fullyDecodedSourceAccessTimes)
    {
        if (! isReferenced(key))
            candidates.push_back(
                { accessTime, key });
    }
    std::sort(candidates.begin(), candidates.end());

    int evicted = 0;
    for (const auto& [accessTime, key] :
         candidates)
    {
        juce::ignoreUnused(accessTime);
        if (fullyDecodedBytesInUse
                <= MAX_FULLY_DECODED_CACHE_BYTES
                    - requiredBytes)
        {
            break;
        }

        auto source = fullyDecodedSources.find(key);
        if (source == fullyDecodedSources.end()
            || source->second == nullptr)
        {
            fullyDecodedSourceAccessTimes.erase(key);
            continue;
        }

        fullyDecodedBytesInUse =
            std::max<juce::int64>(
                0,
                fullyDecodedBytesInUse
                    - source->second->decodedBytes);
        retiredSources.push_back(
            std::move(source->second));
        fullyDecodedSources.erase(source);
        fullyDecodedSourceAccessTimes.erase(key);
        ++evicted;
    }

    if (evicted > 0)
    {
        fullyDecodedSourceEvictionCount.fetch_add(
            evicted, std::memory_order_relaxed);
        refreshFullyDecodedSourceDiagnosticsLocked();
    }

    return fullyDecodedBytesInUse
        <= MAX_FULLY_DECODED_CACHE_BYTES
            - requiredBytes;
}

void PlaybackEngine::evictOldReaders(const juce::String& protectedKey)
{
    if ((int)readers.size() <= MAX_CACHED_READERS)
    {
        refreshStreamingReaderDiagnosticsLocked();
        return;
    }

    std::vector<juce::String> referencedKeys;
    referencedKeys.reserve(clips.size() + renderedPreviewSegments.size());
    for (const auto& clip : clips)
    {
        if (clip.isActive && clip.readerKey.isNotEmpty())
            referencedKeys.push_back(clip.readerKey);
    }
    for (const auto& [clipId, segments] : renderedPreviewSegments)
    {
        juce::ignoreUnused(clipId);
        for (const auto& segment : segments)
        {
            if (segment.readerKey.isNotEmpty())
                referencedKeys.push_back(segment.readerKey);
        }
    }

    const auto isReferenced = [&referencedKeys, &protectedKey](const juce::String& key)
    {
        return key == protectedKey
            || std::find(referencedKeys.begin(), referencedKeys.end(), key) != referencedKeys.end();
    };

    // Collect entries sorted by access time (oldest first)
    std::vector<std::pair<juce::int64, juce::String>> entries;
    for (const auto& [path, accessTime] : readerAccessTimes)
    {
        if (!isReferenced(path))
            entries.push_back({ accessTime, path });
    }

    std::sort(entries.begin(), entries.end());

    const int desiredEvictions = static_cast<int>(readers.size()) - MAX_CACHED_READERS;
    const int numToEvict = juce::jmin(desiredEvictions, static_cast<int>(entries.size()));
    for (int i = 0; i < numToEvict; ++i)
    {
        const auto& path = entries[i].second;
        readers.erase(path);
        streamingContinuityStates.erase(path);
        readerAccessTimes.erase(path);
    }

    if (numToEvict > 0)
        streamingReaderEvictionCount.fetch_add(numToEvict, std::memory_order_relaxed);

    if (static_cast<int>(readers.size()) > MAX_CACHED_READERS)
    {
        streamingReaderBudgetOvercommitCount.fetch_add(1, std::memory_order_relaxed);
        juce::Logger::writeToLog(
            "PlaybackEngine: Read-ahead target overcommitted to preserve active clips; readers="
            + juce::String(static_cast<int>(readers.size())));
    }
    else if (numToEvict > 0)
    {
        juce::Logger::writeToLog("PlaybackEngine: Evicted " + juce::String(numToEvict)
                                 + " inactive streaming readers");
    }

    refreshStreamingReaderDiagnosticsLocked();
}

float PlaybackEngine::interpolateGainEnvelope(const std::vector<GainEnvelopePoint>& points, double time)
{
    if (points.empty())
        return 1.0f;

    // Before first point
    if (time <= points.front().time)
        return points.front().gain;

    // After last point
    if (time >= points.back().time)
        return points.back().gain;

    // Find surrounding points and interpolate linearly
    for (size_t i = 0; i + 1 < points.size(); ++i)
    {
        if (time >= points[i].time && time < points[i + 1].time)
        {
            double t = (time - points[i].time) / (points[i + 1].time - points[i].time);
            return points[i].gain + static_cast<float>(t) * (points[i + 1].gain - points[i].gain);
        }
    }

    return 1.0f;
}

void PlaybackEngine::setClipGainEnvelope(const juce::String& trackId, const juce::String& clipId,
                                          const std::vector<GainEnvelopePoint>& points)
{
    juce::ScopedLock sl(lock);
    juce::String key = trackId + "::" + clipId;
    if (points.empty())
        gainEnvelopes.erase(key);
    else
        gainEnvelopes[key] = points;
}

void PlaybackEngine::addClip(const juce::File& audioFile, double startTime, double duration, const juce::String& trackId,
                              double offset, double volumeDB, double fadeIn, double fadeOut, const juce::String& clipId,
                              const juce::File& sourceAudioFile, double sourceOffset)
{
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine: Cannot add clip - file does not exist: " + audioFile.getFullPathName());
        return;
    }

    juce::File effectiveFile = audioFile;
    double effectiveOffset = offset;
    std::vector<RenderedPreviewSegment> segmentsToPreload;
    {
        const juce::ScopedLock sl(lock);
        const bool hasActivePitchPreview = clipId.isNotEmpty()
            && clipPitchPreviews.find(clipId) != clipPitchPreviews.end();

        if (hasActivePitchPreview && sourceAudioFile.existsAsFile())
        {
            effectiveFile = sourceAudioFile;
            effectiveOffset = sourceOffset >= 0.0 ? sourceOffset : offset;
            juce::Logger::writeToLog("PlaybackEngine: Using original source for live preview clip " + clipId
                                      + " -> " + effectiveFile.getFullPathName());
        }
        else
        {
            auto correctedIt = pitchCorrectedFiles.find(clipId);
            if (correctedIt != pitchCorrectedFiles.end() && correctedIt->second.existsAsFile())
            {
                effectiveFile = correctedIt->second;
                effectiveOffset = 0.0;
                juce::Logger::writeToLog("PlaybackEngine: Using corrected file for clip " + clipId
                                          + " -> " + effectiveFile.getFullPathName());
            }
        }

        if (clipId.isNotEmpty())
        {
            auto segmentIt = renderedPreviewSegments.find(clipId);
            if (segmentIt != renderedPreviewSegments.end())
                segmentsToPreload = segmentIt->second;
        }
    }

    const auto logicalClipId = clipId.isNotEmpty() ? clipId : juce::Uuid().toString();
    const auto clipReaderKey = "clip|" + logicalClipId + "|" + effectiveFile.getFullPathName();

    // Decoder construction and initial read-ahead occur without holding the
    // clip publication lock.
    preloadReader(effectiveFile, clipReaderKey, effectiveOffset);
    for (const auto& segment : segmentsToPreload)
    {
        if (segment.audioFile.existsAsFile())
            preloadReader(segment.audioFile,
                          segment.readerKey,
                          segment.fileOffsetSec);
    }

    ClipInfo clip(effectiveFile, startTime, duration, trackId, effectiveOffset, volumeDB, fadeIn, fadeOut);
    clip.clipId = clipId;
    clip.envelopeKey = trackId + "::" + clipId;  // Pre-compute to avoid string alloc on audio thread
    clip.readerKey = clipReaderKey;
    clip.originalAudioFile = sourceAudioFile.existsAsFile() ? sourceAudioFile : audioFile;
    clip.originalOffset = sourceOffset >= 0.0 ? sourceOffset : offset;
    int totalClipCount = 0;
    {
        const juce::ScopedLock sl(lock);
        clips.push_back(clip);
        totalClipCount = static_cast<int>(clips.size());
    }

    juce::Logger::writeToLog("PlaybackEngine: Added clip - Track " + trackId +
                           ", Start: " + juce::String(startTime) +
                           "s, Duration: " + juce::String(duration) +
                           "s, Offset: " + juce::String(offset) +
                           "s, Volume: " + juce::String(volumeDB) + "dB");
    OPENSTUDIO_LOG_AUDIO_PLAYBACK("addClip track=" + trackId
        + " clipId=" + clipId
        + " file=" + effectiveFile.getFullPathName()
        + " originalFile=" + clip.originalAudioFile.getFullPathName()
        + " start=" + juce::String(startTime, 3)
        + " duration=" + juce::String(duration, 3)
        + " offset=" + juce::String(effectiveOffset, 3)
        + " totalClips=" + juce::String(totalClipCount));
}

void PlaybackEngine::removeClip(const juce::String& trackId, const juce::String& filePath)
{
    juce::ScopedLock sl(lock);
    
    clips.erase(
        std::remove_if(clips.begin(), clips.end(),
            [&trackId, &filePath](const ClipInfo& clip) {
                return clip.trackId == trackId && 
                       clip.audioFile.getFullPathName() == filePath;
            }),
        clips.end()
    );
    
    juce::Logger::writeToLog("PlaybackEngine: Removed clip from track " + trackId);
}

void PlaybackEngine::removeClipById(const juce::String& trackId, const juce::String& clipId)
{
    juce::ScopedLock sl(lock);

    clips.erase(
        std::remove_if(clips.begin(), clips.end(),
            [&trackId, &clipId](const ClipInfo& clip) {
                return clip.trackId == trackId && clip.clipId == clipId;
            }),
        clips.end()
    );
    gainEnvelopes.erase(trackId + "::" + clipId);

    juce::Logger::writeToLog("PlaybackEngine: Removed clip " + clipId + " from track " + trackId);
}

void PlaybackEngine::replaceClipAudioFile(const juce::String& clipId, const juce::File& newFile)
{
    if (!newFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine::replaceClipAudioFile: file does not exist: " + newFile.getFullPathName());
        return;
    }

    const auto newReaderKey = "clip|" + clipId + "|" + newFile.getFullPathName();
    preloadReader(newFile, newReaderKey, 0.0);

    juce::ScopedLock sl(lock);
    for (auto& clip : clips)
    {
        if (clip.clipId == clipId)
        {
            // Swap in the new file. Corrected files start at sample 0, but restoring
            // the original file should also restore the original trim offset.
            const bool restoringOriginal = (newFile == clip.originalAudioFile);
            clip.audioFile = newFile;
            clip.offset = restoringOriginal ? clip.originalOffset : 0.0;
            clip.readerKey = newReaderKey;
            // Clear any active pitch preview — the corrected audio is now baked
            // into the file, so the real-time PitchShifter must not double-shift.
            clipPitchPreviews.erase(clipId);
            if (pitchScrubPreview.clipId == clipId)
            {
                pitchScrubPreview = {};
                pitchScrubPreviewStatus = {};
                pitchScrubStretcherPrepared = false;
            }
            renderedPreviewSegments.erase(clipId);
            auto& renderedGeneration = renderedPreviewSegmentGenerations[clipId];
            ++renderedGeneration;
            if (renderedGeneration <= 0)
                renderedGeneration = 1;
            deferredClipSwaps.erase(clipId);
            // Remember the corrected file so it survives clearAllClips + re-add cycles.
            if (restoringOriginal)
                pitchCorrectedFiles.erase(clipId);
            else
                pitchCorrectedFiles[clipId] = newFile;
            refreshPitchPreviewRoutingDiagnosticsLocked();
            juce::Logger::writeToLog("PlaybackEngine: Replaced audio file for clip " + clipId +
                                     " -> " + newFile.getFullPathName());
            return;
        }
    }
    juce::Logger::writeToLog("PlaybackEngine::replaceClipAudioFile: clip not found: " + clipId);
}

void PlaybackEngine::queueDeferredClipAudioFile(const juce::String& clipId, const juce::File& newFile, bool restoringOriginal)
{
    if (!newFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine::queueDeferredClipAudioFile: file does not exist: " + newFile.getFullPathName());
        return;
    }

    juce::ScopedLock sl(lock);
    deferredClipSwaps[clipId] = { newFile, restoringOriginal };
    juce::Logger::writeToLog("PlaybackEngine: Deferred audio file swap for clip " + clipId
        + " -> " + newFile.getFullPathName());
}

void PlaybackEngine::cancelDeferredClipAudioFile(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    deferredClipSwaps.erase(clipId);
}

bool PlaybackEngine::commitDeferredClipAudioFile(const juce::String& clipId)
{
    juce::File fileToCommit;
    {
        juce::ScopedLock sl(lock);
        auto it = deferredClipSwaps.find(clipId);
        if (it == deferredClipSwaps.end())
            return false;
        fileToCommit = it->second.audioFile;
    }

    replaceClipAudioFile(clipId, fileToCommit);
    return true;
}

int PlaybackEngine::commitAllDeferredClipAudioFiles()
{
    std::vector<juce::String> clipIds;
    {
        juce::ScopedLock sl(lock);
        for (const auto& [clipId, _swap] : deferredClipSwaps)
            clipIds.push_back(clipId);
    }

    int committed = 0;
    for (const auto& clipId : clipIds)
        if (commitDeferredClipAudioFile(clipId))
            ++committed;
    return committed;
}

bool PlaybackEngine::setClipRenderedPreviewSegment(const juce::String& clipId,
                                                   const juce::File& audioFile,
                                                   double startSec,
                                                   double endSec,
                                                   double fileOffsetSec,
                                                   int generation)
{
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine::setClipRenderedPreviewSegment: file does not exist: " + audioFile.getFullPathName());
        return false;
    }

    const auto segmentReaderKey = "segment|" + clipId
        + "|" + juce::String(startSec, 9)
        + "|" + juce::String(endSec, 9)
        + "|" + audioFile.getFullPathName();
    preloadReader(audioFile, segmentReaderKey, fileOffsetSec);

    juce::ScopedLock sl(lock);
    if (pitchCorrectedFiles.find(clipId) != pitchCorrectedFiles.end())
    {
        juce::Logger::writeToLog("PlaybackEngine: Rejected rendered preview segment for corrected-source clip " + clipId);
        return false;
    }

    if (generation > 0)
    {
        const auto genIt = renderedPreviewSegmentGenerations.find(clipId);
        const int currentGeneration = genIt != renderedPreviewSegmentGenerations.end() ? genIt->second : 0;
        if (currentGeneration != generation)
        {
            juce::Logger::writeToLog("PlaybackEngine: Rejected stale rendered preview segment for clip " + clipId
                + " generation=" + juce::String(generation)
                + " current=" + juce::String(currentGeneration));
            return false;
        }
    }

    auto& segments = renderedPreviewSegments[clipId];
    segments.erase(std::remove_if(segments.begin(), segments.end(),
        [startSec, endSec](const RenderedPreviewSegment& segment)
        {
            const bool sameWindow = std::abs(segment.startSec - startSec) < 0.001
                && std::abs(segment.endSec - endSec) < 0.001;
            const bool overlaps = !(segment.endSec <= startSec || segment.startSec >= endSec);
            return sameWindow || overlaps;
        }),
        segments.end());
    segments.push_back({ audioFile, startSec, endSec, fileOffsetSec, segmentReaderKey });
    std::sort(segments.begin(), segments.end(), [] (const RenderedPreviewSegment& a, const RenderedPreviewSegment& b) {
        return a.startSec < b.startSec;
    });
    refreshPitchPreviewRoutingDiagnosticsLocked();
    juce::Logger::writeToLog("PlaybackEngine: Set rendered preview segment for clip " + clipId
        + " [" + juce::String(startSec, 3) + ", " + juce::String(endSec, 3) + "]"
        + " fileOffset=" + juce::String(fileOffsetSec, 3)
        + " generation=" + juce::String(generation)
        + " -> " + audioFile.getFullPathName());
    return true;
}

void PlaybackEngine::beginRenderedPreviewSegmentGeneration(const juce::String& clipId, int generation)
{
    juce::ScopedLock sl(lock);
    renderedPreviewSegments.erase(clipId);
    renderedPreviewSegmentGenerations[clipId] = generation;
    refreshPitchPreviewRoutingDiagnosticsLocked();
    juce::Logger::writeToLog("PlaybackEngine: Began rendered preview generation for clip " + clipId
        + " generation=" + juce::String(generation));
}

void PlaybackEngine::invalidateRenderedPreviewSegments(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;
    refreshPitchPreviewRoutingDiagnosticsLocked();
    juce::Logger::writeToLog("PlaybackEngine: Invalidated rendered preview segments for clip " + clipId
        + " generation=" + juce::String(generation));
}

void PlaybackEngine::clearClipRenderedPreviewSegments(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;
    refreshPitchPreviewRoutingDiagnosticsLocked();
    juce::Logger::writeToLog("PlaybackEngine: Cleared rendered preview segments for clip " + clipId
        + " generation=" + juce::String(generation));
}

void PlaybackEngine::clearAllPitchPreviewRoutes(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    const bool clearAll = clipId.isEmpty();
    if (clearAll)
    {
        clipPitchPreviews.clear();
        renderedPreviewSegments.clear();
        for (auto& [id, generation] : renderedPreviewSegmentGenerations)
        {
            juce::ignoreUnused(id);
            ++generation;
            if (generation <= 0)
                generation = 1;
        }
        pitchScrubPreview = {};
        pitchScrubPreviewStatus = {};
        pitchScrubStretcherPrepared = false;
        refreshPitchPreviewRoutingDiagnosticsLocked();
        juce::Logger::writeToLog("PlaybackEngine: Hard-cleared all pitch preview routes");
        return;
    }

    clipPitchPreviews.erase(clipId);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;

    if (pitchScrubPreview.clipId == clipId)
    {
        pitchScrubPreview = {};
        pitchScrubPreviewStatus = {};
        pitchScrubStretcherPrepared = false;
    }

    refreshPitchPreviewRoutingDiagnosticsLocked();
    juce::Logger::writeToLog("PlaybackEngine: Hard-cleared pitch preview routes for clip " + clipId
        + " generation=" + juce::String(generation));
}

int PlaybackEngine::clearPitchPreviewRoutesForCorrectedSources()
{
    juce::ScopedLock sl(lock);
    int cleared = 0;
    for (const auto& [clipId, file] : pitchCorrectedFiles)
    {
        juce::ignoreUnused(file);
        const bool hadLive = clipPitchPreviews.erase(clipId) > 0;
        const bool hadRendered = renderedPreviewSegments.erase(clipId) > 0;
        bool hadScrub = false;
        if (pitchScrubPreview.clipId == clipId)
        {
            pitchScrubPreview = {};
            pitchScrubPreviewStatus = {};
            pitchScrubStretcherPrepared = false;
            hadScrub = true;
        }

        if (hadLive || hadRendered || hadScrub)
        {
            auto& generation = renderedPreviewSegmentGenerations[clipId];
            ++generation;
            if (generation <= 0)
                generation = 1;
            ++cleared;
        }
    }

    if (cleared > 0)
        juce::Logger::writeToLog("PlaybackEngine: Hard-cleared pitch preview routes for "
            + juce::String(cleared) + " corrected-source clip(s)");
    refreshPitchPreviewRoutingDiagnosticsLocked();
    return cleared;
}

std::map<juce::String, std::vector<PlaybackEngine::RenderedPreviewSegment>> PlaybackEngine::getRenderedPreviewSegmentSnapshot() const
{
    juce::ScopedLock sl(lock);
    return renderedPreviewSegments;
}

PlaybackEngine::ClipPlaybackSourceStatus PlaybackEngine::getClipPlaybackSourceAtTime(const juce::String& trackId,
                                                                                      const juce::String& clipId,
                                                                                      double projectTimeSec) const
{
    juce::ScopedLock sl(lock);
    ClipPlaybackSourceStatus status;
    for (const auto& clip : clips)
    {
        if (clip.trackId != trackId || clip.clipId != clipId || !clip.isActive)
            continue;

        const double clipEndTime = clip.startTime + clip.duration;
        if (projectTimeSec < clip.startTime || projectTimeSec >= clipEndTime)
            continue;

        status.clipFound = true;
        status.clipTime = projectTimeSec - clip.startTime;
        status.audioFile = clip.audioFile.getFullPathName();
        status.playbackOffset = clip.offset + status.clipTime;
        status.sourceType = "original";

        auto segmentIt = renderedPreviewSegments.find(clipId);
        if (segmentIt != renderedPreviewSegments.end())
        {
            for (const auto& segment : segmentIt->second)
            {
                if (status.clipTime >= segment.startSec && status.clipTime < segment.endSec)
                {
                    status.renderedSegmentActiveAtTime = true;
                    status.sourceType = "rendered_segment";
                    status.audioFile = segment.audioFile.getFullPathName();
                    status.playbackOffset = segment.fileOffsetSec + (status.clipTime - segment.startSec);
                    return status;
                }
            }
        }

        auto correctedIt = pitchCorrectedFiles.find(clipId);
        if (correctedIt != pitchCorrectedFiles.end()
            && correctedIt->second.existsAsFile()
            && clip.audioFile == correctedIt->second)
        {
            status.correctedSourceActiveAtTime = true;
            status.sourceType = "corrected_source";
            status.audioFile = correctedIt->second.getFullPathName();
        }

        return status;
    }

    return status;
}

void PlaybackEngine::clearPitchCorrectionFile(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    pitchCorrectedFiles.erase(clipId);
    clipPitchPreviews.erase(clipId);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;
    if (pitchScrubPreview.clipId == clipId)
    {
        pitchScrubPreview = {};
        pitchScrubPreviewStatus = {};
        pitchScrubStretcherPrepared = false;
    }
    deferredClipSwaps.erase(clipId);
    refreshPitchPreviewRoutingDiagnosticsLocked();
    juce::Logger::writeToLog("PlaybackEngine: Cleared pitch correction file for clip " + clipId);
}

void PlaybackEngine::clearAllClips()
{
    juce::ScopedLock sl(lock);
#if OPENSTUDIO_AUDIO_PLAYBACK_DEBUG
    const int previousClipCount = static_cast<int>(clips.size());
    const int preservedPreviewCount = static_cast<int>(clipPitchPreviews.size());
    const int preservedCorrectedCount = static_cast<int>(pitchCorrectedFiles.size());
#endif
    clips.clear();
    readers.clear();
    streamingContinuityStates.clear();
    readerAccessTimes.clear();
    refreshStreamingReaderDiagnosticsLocked();
    fullyDecodedSources.clear();
    fullyDecodedSourceAccessTimes.clear();
    fullyDecodedBytesInUse = 0;
    refreshFullyDecodedSourceDiagnosticsLocked();
    // NOTE: clipPitchPreviews is NOT cleared here — it must survive sync cycles.
    // syncClipsWithBackend calls clearAllClips + re-adds clips, and the preview
    // must persist so the user continues hearing edited notes across play cycles.
    // Preview is cleared explicitly by: replaceClipAudioFile (WORLD done),
    // clearClipPitchPreview (editor close), or clearPitchCorrectionFile.
    lagrangeInterpolatorL.reset();
    lagrangeInterpolatorR.reset();
    juce::Logger::writeToLog("PlaybackEngine: Cleared all clips (pitch previews preserved: "
                              + juce::String(static_cast<int>(clipPitchPreviews.size())) + ")");
    OPENSTUDIO_LOG_AUDIO_PLAYBACK("clearAllClips previousClipCount=" + juce::String(previousClipCount)
        + " preservedPreviews=" + juce::String(preservedPreviewCount)
        + " preservedCorrectedFiles=" + juce::String(preservedCorrectedCount));
}

void PlaybackEngine::clearTrackClips(const juce::String& trackId)
{
    juce::ScopedLock sl(lock);

    clips.erase(
        std::remove_if(clips.begin(), clips.end(),
            [&trackId](const ClipInfo& clip) {
                return clip.trackId == trackId;
            }),
        clips.end()
    );

    lagrangeInterpolatorL.reset();
    lagrangeInterpolatorR.reset();

    juce::Logger::writeToLog("PlaybackEngine: Cleared clips for track " + trackId);
}

int PlaybackEngine::getNumClipsForTrack(const juce::String& trackId) const
{
    int count = 0;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId)
            count++;
    }
    return count;
}

std::vector<PlaybackEngine::ClipInfo> PlaybackEngine::getClipSnapshot() const
{
    juce::ScopedLock sl(lock);
    return clips;
}

// ---- Pitch preview methods ----

void PlaybackEngine::setClipPitchPreview (const juce::String& clipId,
                                           const ClipPitchPreviewData& preview)
{
    juce::File originalFileToPreload;
    juce::String originalReaderKey;
    double originalOffsetToPreload = 0.0;
    {
    juce::ScopedLock sl (lock);

    // If the clip currently has a pitch-corrected file baked in, revert to the
    // original audio so the real-time preview applies to the UNCORRECTED audio.
    // Without this, the preview would double-shift: the corrected file already
    // has the old pitch shift baked in, and the preview would add the new ratio
    // on top — always increasing pitch regardless of direction.
    auto corrIt = pitchCorrectedFiles.find (clipId);
    if (corrIt != pitchCorrectedFiles.end() && ! preview.allowReplacingCorrectedSource)
    {
        juce::Logger::writeToLog ("PlaybackEngine: Rejected pitch preview for corrected-source clip " + clipId
            + " because the request did not opt into a new interactive preview generation");
        return;
    }

    for (auto& clip : clips)
    {
        if (clip.clipId == clipId && clip.originalAudioFile.existsAsFile())
        {
            const auto desiredReaderKey = "clip|" + clipId
                + "|" + clip.originalAudioFile.getFullPathName();
            const bool usingOriginalAlready = (clip.audioFile == clip.originalAudioFile)
                && std::abs (clip.offset - clip.originalOffset) < 0.0005;
            if (! usingOriginalAlready)
            {
                clip.audioFile = clip.originalAudioFile;
                clip.offset = clip.originalOffset;
                juce::Logger::writeToLog ("PlaybackEngine: Reverted clip " + clipId
                    + " to original file for preview");
            }
            clip.readerKey = desiredReaderKey;
            originalFileToPreload = clip.originalAudioFile;
            originalReaderKey = desiredReaderKey;
            originalOffsetToPreload = clip.originalOffset;
            break;
        }
    }
    if (corrIt != pitchCorrectedFiles.end())
        pitchCorrectedFiles.erase (corrIt);

    auto it = clipPitchPreviews.find (clipId);
    if (it != clipPitchPreviews.end())
    {
        juce::ScopedLock clipSl (it->second->clipLock);
        it->second->previewData = preview;
        // Do NOT reset prepared/lastPlaybackTime here — the stretcher must stay
        // coherent across rolling 250ms preview refreshes. Resetting it causes
        // the stretcher to emit latency-fill (wrong audio) for ~100ms at every
        // refresh cycle, producing periodic crackle and word-beginning cutoffs.
        // Seek detection (|clipTime - lastPlaybackTime| > 0.1s) in fillTrackBuffer
        // handles genuine playhead jumps without needing a reset here.
    }
    else
    {
        auto state = std::make_unique<ClipPitchPreviewState>();
        state->previewData = preview;
        clipPitchPreviews[clipId] = std::move (state);
    }

    juce::Logger::writeToLog ("PlaybackEngine: Set preview for clip " + clipId
                               + " pitchSegments=" + juce::String ((int) preview.pitchSegments.size())
                               + " globalFormantSt=" + juce::String (preview.globalFormantSemitones, 3)
                               + " liveFormantSuppressed=" + juce::String (std::abs (preview.globalFormantSemitones) > 0.01f ? "yes" : "no")
                               + " window=[" + juce::String (preview.previewStartSec, 3)
                               + "," + juce::String (preview.previewEndSec, 3) + "]");
    refreshPitchPreviewRoutingDiagnosticsLocked();
    }

    if (originalFileToPreload.existsAsFile())
        preloadReader(originalFileToPreload,
                      originalReaderKey,
                      originalOffsetToPreload);
}

void PlaybackEngine::clearClipPitchPreview (const juce::String& clipId)
{
    juce::ScopedLock sl (lock);
    clipPitchPreviews.erase (clipId);
    refreshPitchPreviewRoutingDiagnosticsLocked();
    juce::Logger::writeToLog ("PlaybackEngine: Cleared pitch preview for clip " + clipId);
}

bool PlaybackEngine::hasClipPitchPreview (const juce::String& clipId) const
{
    return clipPitchPreviews.find (clipId) != clipPitchPreviews.end();
}

void PlaybackEngine::setPitchScrubPreview (const PitchScrubPreviewData& preview)
{
    juce::ScopedLock sl (lock);
    pitchScrubPreview = preview;
    pitchScrubPreview.active = preview.loopBuffer.getNumSamples() > 8
        && preview.loopBuffer.getNumChannels() > 0
        && preview.pitchRatio > 0.0f;
    pitchScrubPreviewMayRender.store(
        pitchScrubPreview.active,
        std::memory_order_release);
    pitchScrubPreview.readPosition = 0.0;
    pitchScrubPreview.currentGain = 0.0f;
    pitchScrubPreview.targetGain = juce::jlimit (0.0f, 2.0f, preview.gain);
    pitchScrubPreview.releasePending = false;
    pitchScrubPreview.lastPeak = 0.0f;
    pitchScrubPreview.lastRenderWallTimeMs = 0.0;
    pitchScrubPreview.mixedCallbackCount = 0;
    pitchScrubPreview.mixedSampleCount = 0;
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";
    pitchScrubStretcherPrepared = false;
    pitchScrubPreview.loopCrossfadeSamples = juce::jlimit (8,
        std::max (8, preview.loopBuffer.getNumSamples() / 3),
        preview.loopCrossfadeSamples > 0
            ? preview.loopCrossfadeSamples
            : std::max (16, preview.loopBuffer.getNumSamples() / 8));

    pitchScrubPreviewStatus = {};
    pitchScrubPreviewStatus.active = pitchScrubPreview.active;
    pitchScrubPreviewStatus.previewArmed = pitchScrubPreview.active;
    pitchScrubPreviewStatus.trackId = pitchScrubPreview.trackId;
    pitchScrubPreviewStatus.clipId = pitchScrubPreview.clipId;
    pitchScrubPreviewStatus.pitchRatio = pitchScrubPreview.pitchRatio;
    pitchScrubPreviewStatus.basePitchHz = pitchScrubPreview.basePitchHz;
    pitchScrubPreviewStatus.currentGain = pitchScrubPreview.currentGain;
    pitchScrubPreviewStatus.targetGain = pitchScrubPreview.targetGain;
    pitchScrubPreviewStatus.repeatStability = pitchScrubPreview.repeatStability;
    pitchScrubPreviewStatus.loopDurationMs = 1000.0 * std::max (0.0, pitchScrubPreview.loopEndSec - pitchScrubPreview.loopStartSec);
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";

    const int preloadSamples = juce::jmax (512, preview.loopBuffer.getNumSamples());
    pitchScrubInputBuffer.setSize (juce::jmax (1, preview.loopBuffer.getNumChannels()), preloadSamples, false, true, true);
    pitchScrubOutputBuffer.setSize (juce::jmax (1, preview.loopBuffer.getNumChannels()), preloadSamples, false, true, true);

    refreshPitchPreviewRoutingDiagnosticsLocked();
    OPENSTUDIO_LOG_AUDIO_PLAYBACK("setPitchScrubPreview clip=" + preview.clipId
        + " track=" + preview.trackId
        + " samples=" + juce::String (preview.loopBuffer.getNumSamples())
        + " channels=" + juce::String (preview.loopBuffer.getNumChannels())
        + " pitchRatio=" + juce::String (preview.pitchRatio, 3)
        + " basePitchHz=" + juce::String (preview.basePitchHz, 2)
        + " active=" + juce::String (pitchScrubPreview.active ? "true" : "false"));
}

bool PlaybackEngine::updatePitchScrubPreview (const juce::String& clipId, float pitchRatio)
{
    juce::ScopedLock sl (lock);
    if ((! pitchScrubPreview.active && ! pitchScrubPreview.releasePending) || pitchScrubPreview.clipId != clipId)
        return false;

    pitchScrubPreview.pitchRatio = juce::jlimit (0.25f, 4.0f, pitchRatio);
    pitchScrubPreviewStatus.pitchRatio = pitchScrubPreview.pitchRatio;
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";
    return true;
}

void PlaybackEngine::clearPitchScrubPreview (const juce::String& clipId)
{
    juce::ScopedLock sl (lock);
    if (pitchScrubPreview.clipId == clipId && (pitchScrubPreview.active || pitchScrubPreview.releasePending))
    {
        pitchScrubPreview.releasePending = true;
        pitchScrubPreview.targetGain = 0.0f;
        pitchScrubPreviewStatus.releasePending = true;
        refreshPitchPreviewRoutingDiagnosticsLocked();
        OPENSTUDIO_LOG_AUDIO_PLAYBACK("clearPitchScrubPreview clip=" + clipId);
    }
}

bool PlaybackEngine::hasPitchScrubPreview (const juce::String& clipId) const
{
    const juce::ScopedLock sl (lock);
    return (pitchScrubPreview.active || pitchScrubPreview.releasePending) && pitchScrubPreview.clipId == clipId;
}

#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456)
#endif
void PlaybackEngine::renderPitchScrubPreview (juce::AudioBuffer<float>& buffer, double sampleRate)
{
    const juce::ScopedTryLock sl (lock);
    if (! sl.isLocked())
        return;

    if ((! pitchScrubPreview.active && ! pitchScrubPreview.releasePending)
        || pitchScrubPreview.loopBuffer.getNumSamples() <= 8
        || pitchScrubPreview.loopBuffer.getNumChannels() <= 0
        || sampleRate <= 0.0)
    {
        pitchScrubPreviewMayRender.store(false, std::memory_order_release);
        return;
    }

    const auto playbackRatio = (pitchScrubPreview.sourceSampleRate > 0.0)
        ? (pitchScrubPreview.sourceSampleRate / sampleRate)
        : 1.0;
    const double readIncrement = playbackRatio;
    const int loopChannels = pitchScrubPreview.loopBuffer.getNumChannels();
    const int outputChannels = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    if (pitchScrubInputBuffer.getNumChannels() < loopChannels
        || pitchScrubInputBuffer.getNumSamples() < numSamples)
    {
        pitchScrubInputBuffer.setSize (loopChannels, numSamples, false, true, true);
    }
    if (pitchScrubOutputBuffer.getNumChannels() < loopChannels
        || pitchScrubOutputBuffer.getNumSamples() < numSamples)
    {
        pitchScrubOutputBuffer.setSize (loopChannels, numSamples, false, true, true);
    }
    pitchScrubInputBuffer.clear (0, numSamples);
    pitchScrubOutputBuffer.clear (0, numSamples);

    const float startStep = pitchScrubPreview.targetGain
        / static_cast<float> (std::max (1, static_cast<int> (std::round (sampleRate * pitchScrubPreview.startRampMs * 0.001))));
    const float stopStep = std::max (pitchScrubPreview.gain, 0.001f)
        / static_cast<float> (std::max (1, static_cast<int> (std::round (sampleRate * pitchScrubPreview.stopRampMs * 0.001))));

    for (int i = 0; i < numSamples; ++i)
    {
        for (int ch = 0; ch < loopChannels; ++ch)
        {
            pitchScrubInputBuffer.setSample (ch, i, sampleLoopBufferLocal (pitchScrubPreview.loopBuffer,
                                                                           ch,
                                                                           pitchScrubPreview.readPosition,
                                                                           pitchScrubPreview.loopCrossfadeSamples));
        }

        pitchScrubPreview.readPosition += readIncrement;
        const double loopLength = static_cast<double> (pitchScrubPreview.loopBuffer.getNumSamples());
        if (loopLength > 0.0 && pitchScrubPreview.readPosition >= loopLength)
            pitchScrubPreview.readPosition = std::fmod (pitchScrubPreview.readPosition, loopLength);
    }

    if (! pitchScrubStretcherPrepared)
    {
        pitchScrubStretcher.presetCheaper (loopChannels, static_cast<float> (sampleRate));
        pitchScrubStretcherPrepared = true;
    }

    const float pitchRatio = juce::jlimit (0.25f, 4.0f, pitchScrubPreview.pitchRatio);
    const float tonalityLimitNorm = static_cast<float> (
        sampleRate > 0.0
            ? getPitchOnlyPreviewTonalityLimitHz (pitchRatio < 1.0f) / sampleRate
            : 0.0);
    pitchScrubStretcher.setTransposeFactor (pitchRatio, tonalityLimitNorm);
    pitchScrubStretcher.setFormantFactor (1.0f, true);

    if (static_cast<int> (pitchPreviewInPtrs.size()) < loopChannels)
    {
        pitchPreviewInPtrs.resize (static_cast<size_t> (loopChannels));
        pitchPreviewOutPtrs.resize (static_cast<size_t> (loopChannels));
    }
    for (int ch = 0; ch < loopChannels; ++ch)
    {
        pitchPreviewInPtrs[static_cast<size_t> (ch)] = pitchScrubInputBuffer.getReadPointer (ch);
        pitchPreviewOutPtrs[static_cast<size_t> (ch)] = pitchScrubOutputBuffer.getWritePointer (ch);
    }
    pitchScrubStretcher.process (pitchPreviewInPtrs, numSamples, pitchPreviewOutPtrs, numSamples);

    float peak = 0.0f;
    for (int i = 0; i < numSamples; ++i)
    {
        if (pitchScrubPreview.releasePending)
            pitchScrubPreview.currentGain = std::max (0.0f, pitchScrubPreview.currentGain - stopStep);
        else
            pitchScrubPreview.currentGain = std::min (pitchScrubPreview.targetGain, pitchScrubPreview.currentGain + startStep);

        for (int ch = 0; ch < outputChannels; ++ch)
        {
            const int loopChannel = juce::jmin (ch, loopChannels - 1);
            const float sample = pitchScrubOutputBuffer.getSample (loopChannel, i) * pitchScrubPreview.currentGain;
            buffer.addSample (ch, i, sample);
            peak = juce::jmax (peak, std::abs (sample));
        }
    }

    pitchScrubPreview.lastPeak = peak;
    pitchScrubPreview.lastRenderWallTimeMs = juce::Time::getMillisecondCounterHiRes();
    pitchScrubPreview.mixedCallbackCount += 1;
    pitchScrubPreview.mixedSampleCount += numSamples;
    pitchScrubPreview.firstCallbackServiced = true;

    pitchScrubPreviewStatus.active = pitchScrubPreview.active;
    pitchScrubPreviewStatus.releasePending = pitchScrubPreview.releasePending;
    pitchScrubPreviewStatus.audible = pitchScrubPreview.currentGain > 0.0001f && peak > 1.0e-4f;
    pitchScrubPreview.firstDragAudible = pitchScrubPreview.firstDragAudible || pitchScrubPreviewStatus.audible;
    pitchScrubPreviewStatus.previewArmed = pitchScrubPreview.active || pitchScrubPreview.releasePending;
    pitchScrubPreviewStatus.firstCallbackServiced = pitchScrubPreview.firstCallbackServiced;
    pitchScrubPreviewStatus.firstDragAudible = pitchScrubPreview.firstDragAudible;
    pitchScrubPreviewStatus.trackId = pitchScrubPreview.trackId;
    pitchScrubPreviewStatus.clipId = pitchScrubPreview.clipId;
    pitchScrubPreviewStatus.pitchRatio = pitchScrubPreview.pitchRatio;
    pitchScrubPreviewStatus.basePitchHz = pitchScrubPreview.basePitchHz;
    pitchScrubPreviewStatus.currentGain = pitchScrubPreview.currentGain;
    pitchScrubPreviewStatus.targetGain = pitchScrubPreview.targetGain;
    pitchScrubPreviewStatus.repeatStability = pitchScrubPreview.repeatStability;
    pitchScrubPreviewStatus.lastPeak = peak;
    pitchScrubPreviewStatus.loopDurationMs = 1000.0 * std::max (0.0, pitchScrubPreview.loopEndSec - pitchScrubPreview.loopStartSec);
    pitchScrubPreviewStatus.lastRenderWallTimeMs = pitchScrubPreview.lastRenderWallTimeMs;
    pitchScrubPreviewStatus.mixedCallbackCount = pitchScrubPreview.mixedCallbackCount;
    pitchScrubPreviewStatus.mixedSampleCount = pitchScrubPreview.mixedSampleCount;
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";

    if (pitchScrubPreview.releasePending && pitchScrubPreview.currentGain <= 1.0e-5f)
    {
        pitchScrubPreview.active = false;
        pitchScrubPreview.releasePending = false;
        pitchScrubPreview.currentGain = 0.0f;
        pitchScrubPreview.targetGain = 0.0f;
        pitchScrubPreviewStatus.active = false;
        pitchScrubPreviewStatus.releasePending = false;
        pitchScrubPreviewStatus.previewArmed = false;
        pitchScrubStretcherPrepared = false;
        pitchScrubPreviewMayRender.store(false, std::memory_order_release);
        refreshPitchPreviewRoutingDiagnosticsLocked();
    }
}
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif

PlaybackEngine::PitchScrubPreviewStatus PlaybackEngine::getPitchScrubPreviewStatus (const juce::String& clipId) const
{
    const juce::ScopedLock sl (lock);
    if (clipId.isNotEmpty() && pitchScrubPreviewStatus.clipId != clipId)
        return {};
    return pitchScrubPreviewStatus;
}

PlaybackEngine::PitchPreviewRoutingStatus PlaybackEngine::getPitchPreviewRoutingStatus (const juce::String& clipId) const
{
    if (clipId.isEmpty())
    {
        const auto diagnostic = getPitchPreviewRoutingDiagnosticStatus();
        PitchPreviewRoutingStatus status;
        status.scrubPreviewActive = diagnostic.scrubPreviewActive;
        status.clipLivePreviewActive = diagnostic.clipLivePreviewActive;
        status.renderedSegmentActive = diagnostic.renderedSegmentActive;
        status.correctedSourceActive = diagnostic.correctedSourceActive;

        if (status.renderedSegmentActive)
            status.monitorMode = "rendered_segment";
        else if (status.scrubPreviewActive)
            status.monitorMode = "scrub";
        else if (status.clipLivePreviewActive)
            status.monitorMode = "clip_live_preview";
        else if (status.correctedSourceActive)
            status.monitorMode = "corrected_source";
        else
            status.monitorMode = "none";

        return status;
    }

    const juce::ScopedLock sl (lock);
    PitchPreviewRoutingStatus status;
    status.scrubPreviewActive = (pitchScrubPreview.active || pitchScrubPreview.releasePending)
        && pitchScrubPreview.clipId == clipId;
    status.clipLivePreviewActive = clipPitchPreviews.find (clipId) != clipPitchPreviews.end();
    status.renderedSegmentActive = renderedPreviewSegments.find (clipId) != renderedPreviewSegments.end();
    status.correctedSourceActive = pitchCorrectedFiles.find (clipId) != pitchCorrectedFiles.end();

    if (status.renderedSegmentActive)
        status.monitorMode = "rendered_segment";
    else if (status.scrubPreviewActive)
        status.monitorMode = "scrub";
    else if (status.clipLivePreviewActive)
        status.monitorMode = "clip_live_preview";
    else if (status.correctedSourceActive)
        status.monitorMode = "corrected_source";
    else
        status.monitorMode = "none";

    return status;
}

PlaybackEngine::PitchPreviewRoutingDiagnosticStatus
PlaybackEngine::getPitchPreviewRoutingDiagnosticStatus() const noexcept
{
    const auto flags = pitchPreviewRoutingDiagnosticFlags.load(std::memory_order_acquire);
    PitchPreviewRoutingDiagnosticStatus status;
    status.scrubPreviewActive = (flags & kPitchRouteScrubPreview) != 0;
    status.clipLivePreviewActive = (flags & kPitchRouteClipLivePreview) != 0;
    status.renderedSegmentActive = (flags & kPitchRouteRenderedSegment) != 0;
    status.correctedSourceActive = (flags & kPitchRouteCorrectedSource) != 0;
    return status;
}

float PlaybackEngine::lookupPitchRatio (const std::vector<PitchCorrectionSegment>& segments, double timeInClip)
{
    // Binary search could be used for large segment lists, but linear is fine for typical note counts
    for (const auto& seg : segments)
    {
        if (timeInClip >= seg.startTime && timeInClip < seg.endTime)
            return seg.pitchRatio;
    }
    return 1.0f; // No correction at this time position
}

#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456 4702)
#endif
void PlaybackEngine::fillTrackBuffer(const juce::String& trackId,
                                     juce::AudioBuffer<float>& buffer,
                                     double currentTime,
                                     int numSamples,
                                     double sampleRate)
{
    if (numSamples <= 0
        || sampleRate <= 0.0
        || buffer.getNumChannels() <= 0)
    {
        return;
    }

    const int playbackOutputChannels =
        juce::jmin(
            buffer.getNumChannels(),
            reusableTrackPlaybackBuffer
                .getNumChannels());
    auto& trackContinuity =
        getTrackPlaybackContinuityState(trackId);
    const double continuityTolerance =
        2.0 / sampleRate;
    const bool timelineContiguous =
        trackContinuity.hasExpectedTimelineTime
        && std::abs(
            currentTime
            - trackContinuity
                .expectedNextTimelineTime)
            <= continuityTolerance;

    // Never wait behind clip/edit/pitch publication. On contention, conceal
    // only the missing playback contribution; sends and live input already in
    // the destination remain untouched.
    const juce::ScopedTryLock sl(lock);
    if (!sl.isLocked())
    {
        const int tryLockMiss =
            tryLockFailureCount.fetch_add(
                1, std::memory_order_relaxed)
            + 1;
        trackContinuity.beginBlock(
            false,
            timelineContiguous,
            playbackOutputChannels);
        float concealedPeak = 0.0f;
        for (int sample = 0;
             sample < numSamples;
             ++sample)
        {
            for (int channel = 0;
                 channel < playbackOutputChannels;
                 ++channel)
            {
                const float concealed =
                    trackContinuity.processSample(
                        channel, 0.0f, false);
                buffer.addSample(
                    channel, sample, concealed);
                concealedPeak =
                    juce::jmax(
                        concealedPeak,
                        std::abs(concealed));
            }
            trackContinuity.advanceFrame(false);
        }
        trackContinuity.expectedNextTimelineTime =
            currentTime
            + static_cast<double>(numSamples)
                / sampleRate;
        trackContinuity.hasExpectedTimelineTime =
            true;
        outerLockContinuityConcealmentCount
            .fetch_add(
                1, std::memory_order_relaxed);
        outerLockContinuityConcealedSampleCount
            .fetch_add(
                static_cast<juce::int64>(
                    numSamples)
                    * static_cast<juce::int64>(
                        playbackOutputChannels),
                std::memory_order_relaxed);
        lastTrackPlaybackPeak.store(
            concealedPeak,
            std::memory_order_relaxed);
        if ((tryLockMiss % 20) == 1)
            OPENSTUDIO_LOG_AUDIO_PLAYBACK("fillTrackBuffer lock miss track=" + trackId
                + " currentTime=" + juce::String(currentTime, 3)
                + " count=" + juce::String(tryLockMiss));
        return;
    }

    if (playbackOutputChannels <= 0
        || reusableTrackPlaybackBuffer
                .getNumSamples()
            < numSamples)
    {
        // The callback cannot resize this scratch safely. The normal device
        // maximum is far below the 65536-frame prepared capacity.
        fileBufferResizeCount.fetch_add(
            1, std::memory_order_relaxed);
        return;
    }
    reusableTrackPlaybackBuffer.clear(
        0, numSamples);
    auto& playbackMix =
        reusableTrackPlaybackBuffer;

    int overlappingClipCount = 0;
    int mixedClipCount = 0;
    static std::atomic<int> fillTrackBufferCallCounter { 0 };
    const int fillCall = fillTrackBufferCallCounter.fetch_add(1, std::memory_order_relaxed) + 1;
    const bool shouldLogDetailed = kAudioPlaybackDebugLogs && (fillCall % 50) == 1;

    double windowEnd = currentTime + (numSamples / sampleRate);

    // Find and mix all clips that should be playing at current time
    for (const auto& clip : clips)
    {
        if (clip.trackId != trackId || !clip.isActive)
            continue;

        double clipEndTime = clip.startTime + clip.duration;

        // Check if clip overlaps with current time window
        if (currentTime >= clipEndTime || windowEnd <= clip.startTime)
            continue;  // Clip not active in this window
        ++overlappingClipCount;

        {
        const int clipOutputStart = juce::jlimit (0, numSamples,
            static_cast<int> (std::ceil ((clip.startTime - currentTime) * sampleRate - 1.0e-9)));
        const int clipOutputEnd = juce::jlimit (clipOutputStart, numSamples,
            static_cast<int> (std::ceil ((clipEndTime - currentTime) * sampleRate - 1.0e-9)));
        if (clipOutputEnd <= clipOutputStart)
            continue;

        const std::vector<RenderedPreviewSegment>* renderedSegmentsForClip = nullptr;
        if (clip.clipId.isNotEmpty())
        {
            auto segmentIt = renderedPreviewSegments.find (clip.clipId);
            if (segmentIt != renderedPreviewSegments.end() && ! segmentIt->second.empty())
                renderedSegmentsForClip = &segmentIt->second;
        }

        auto& chunkBoundaries = reusableChunkBoundaries;
        chunkBoundaries.clear();
        const auto requiredBoundaryCapacity = renderedSegmentsForClip != nullptr ? renderedSegmentsForClip->size() * 2 + 2 : 2;
        if (chunkBoundaries.capacity() < requiredBoundaryCapacity)
        {
            chunkBoundaries.reserve (requiredBoundaryCapacity);
            chunkBoundaryReserveCount.fetch_add (1, std::memory_order_relaxed);
        }
        chunkBoundaries.push_back (clipOutputStart);
        chunkBoundaries.push_back (clipOutputEnd);
        if (renderedSegmentsForClip != nullptr)
        {
            for (const auto& segment : *renderedSegmentsForClip)
            {
                const int segmentStart = juce::jlimit (clipOutputStart, clipOutputEnd,
                    static_cast<int> (std::ceil ((clip.startTime + segment.startSec - currentTime) * sampleRate - 1.0e-9)));
                const int segmentEnd = juce::jlimit (clipOutputStart, clipOutputEnd,
                    static_cast<int> (std::ceil ((clip.startTime + segment.endSec - currentTime) * sampleRate - 1.0e-9)));
                if (segmentStart > clipOutputStart && segmentStart < clipOutputEnd)
                    chunkBoundaries.push_back (segmentStart);
                if (segmentEnd > clipOutputStart && segmentEnd < clipOutputEnd)
                    chunkBoundaries.push_back (segmentEnd);
            }
        }
        std::sort (chunkBoundaries.begin(), chunkBoundaries.end());
        chunkBoundaries.erase (std::unique (chunkBoundaries.begin(), chunkBoundaries.end()), chunkBoundaries.end());

        const float clipGain = juce::Decibels::decibelsToGain (static_cast<float> (clip.volumeDB));
        const std::vector<GainEnvelopePoint>* envPoints = nullptr;
        if (clip.clipId.isNotEmpty())
        {
            auto envIt = gainEnvelopes.find (clip.envelopeKey);
            if (envIt != gainEnvelopes.end() && ! envIt->second.empty())
                envPoints = &envIt->second;
        }

        auto mixChunk = [&] (int outputStart, int requestedOutputSamples,
                            const juce::File& playbackFile,
                            const juce::String& readerKey,
                            double playbackOffset,
                            bool usingRenderedPreviewSegment, bool usingCorrectedSource)
        {
            juce::ignoreUnused(playbackFile);
            if (requestedOutputSamples <= 0)
                return false;

            const auto* decodedSource =
                getFullyDecodedSource(readerKey);
            auto* reader = decodedSource == nullptr
                ? getCachedReader(readerKey)
                : nullptr;
            StreamingContinuityState*
                streamingContinuity = nullptr;
            if (reader != nullptr)
            {
                auto continuity =
                    streamingContinuityStates.find(
                        readerKey);
                if (continuity
                    != streamingContinuityStates.end())
                {
                    streamingContinuity =
                        &continuity->second;
                }
            }
            if (decodedSource == nullptr
                && reader == nullptr)
            {
                const int missingReaders = missingReaderCount.fetch_add (1, std::memory_order_relaxed) + 1;
                OPENSTUDIO_LOG_AUDIO_PLAYBACK("fillTrackBuffer missingStreamingReader track=" + trackId
                    + " clipId=" + clip.clipId
                    + " file=" + playbackFile.getFullPathName()
                    + " currentTime=" + juce::String (currentTime, 3)
                    + " missingReaderCount=" + juce::String (missingReaders));
                juce::ignoreUnused (missingReaders);
                return false;
            }

            const double fileSampleRate =
                decodedSource != nullptr
                    ? decodedSource->sampleRate
                    : reader->sampleRate;
            const double ratio = fileSampleRate / sampleRate;
            double exactFileStart = juce::jmax (0.0, playbackOffset) * fileSampleRate;
            const double roundedFileStart = std::round (exactFileStart);
            if (std::abs (exactFileStart - roundedFileStart) < 1.0e-6)
                exactFileStart = roundedFileStart;

            const juce::int64 fileStartSample = static_cast<juce::int64> (std::floor (exactFileStart));
            const juce::int64 readStartSample = fileStartSample > 0 ? fileStartSample - 1 : fileStartSample;
            const int readStartOffset = static_cast<int> (fileStartSample - readStartSample);
            const double fileStartFraction = exactFileStart - static_cast<double> (fileStartSample);
            const double bufferStartPosition = static_cast<double> (readStartOffset) + fileStartFraction;
            int outputSamples = requestedOutputSamples;
            int fileSamplesToRead = static_cast<int> (std::ceil (bufferStartPosition + outputSamples * ratio)) + 3;
            const juce::int64 sourceLengthInSamples =
                decodedSource != nullptr
                    ? decodedSource->lengthInSamples
                    : reader->lengthInSamples;
            const juce::int64 fileSamplesAvailable = sourceLengthInSamples - readStartSample;
            if (fileSamplesAvailable <= 0)
                return false;
            if (fileSamplesAvailable < fileSamplesToRead)
            {
                fileSamplesToRead = static_cast<int> (fileSamplesAvailable);
                outputSamples = static_cast<int> (std::floor (
                    (static_cast<double> (fileSamplesToRead - 1) - bufferStartPosition) / ratio));
            }
            if (outputSamples <= 0 || fileSamplesToRead <= 0)
                return false;

            const int readerChannels =
                decodedSource != nullptr
                    ? decodedSource->numChannels
                    : static_cast<int>(reader->numChannels);
            if (reusableFileBuffer.getNumChannels() < readerChannels
                || reusableFileBuffer.getNumSamples() < fileSamplesToRead)
            {
                reusableFileBuffer.setSize (juce::jmax (readerChannels, reusableFileBuffer.getNumChannels()),
                                            juce::jmax (fileSamplesToRead, reusableFileBuffer.getNumSamples()));
                fileBufferResizeCount.fetch_add (1, std::memory_order_relaxed);
            }
            reusableFileBuffer.clear (0, fileSamplesToRead);
            bool allReadAheadReady = true;
            if (decodedSource != nullptr)
            {
                const int decodedStartSample =
                    static_cast<int>(readStartSample);
                for (int channel = 0;
                     channel < readerChannels;
                     ++channel)
                {
                    reusableFileBuffer.copyFrom(
                        channel,
                        0,
                        decodedSource->samples,
                        channel,
                        decodedStartSample,
                        fileSamplesToRead);
                }
            }
            else
            {
                allReadAheadReady = reader->read(
                    &reusableFileBuffer,
                    0,
                    fileSamplesToRead,
                    readStartSample,
                    true,
                    true);
            }
            const double outputTimelineStart =
                currentTime
                + static_cast<double>(outputStart)
                    / sampleRate;
            if (streamingContinuity != nullptr)
            {
                const double continuityTolerance =
                    2.0 / sampleRate;
                const bool timelineContiguous =
                    streamingContinuity
                        ->hasExpectedTimelineTime
                    && std::abs(
                        outputTimelineStart
                        - streamingContinuity
                            ->expectedNextTimelineTime)
                        <= continuityTolerance;
                const bool startedRecovery =
                    streamingContinuity->beginBlock(
                        allReadAheadReady,
                        timelineContiguous,
                        readerChannels);
                if (startedRecovery)
                {
                    streamingContinuityRecoveryCount
                        .fetch_add(
                            1,
                            std::memory_order_relaxed);
                }
            }
            if (! allReadAheadReady)
            {
                audioDataCacheMissCount.fetch_add(1, std::memory_order_relaxed);
                streamingContinuityConcealmentCount
                    .fetch_add(
                        1,
                        std::memory_order_relaxed);
                streamingContinuityConcealedSampleCount
                    .fetch_add(
                        static_cast<juce::int64>(
                            outputSamples)
                            * static_cast<juce::int64>(
                                juce::jmin(
                                    playbackOutputChannels,
                                    readerChannels)),
                        std::memory_order_relaxed);
            }

            const bool allowLivePitchPreviewForChunk = ! usingRenderedPreviewSegment && ! usingCorrectedSource;
            const double chunkClipStart = currentTime + (static_cast<double> (outputStart) / sampleRate) - clip.startTime;

            if (allReadAheadReady
                && clip.clipId.isNotEmpty())
            {
                auto previewIt = clipPitchPreviews.find (clip.clipId);
                if (previewIt != clipPitchPreviews.end() && previewIt->second != nullptr)
                {
                    const juce::ScopedTryLock clipSl(previewIt->second->clipLock);
                    if (clipSl.isLocked())
                    {
                        auto& preview = *previewIt->second;
                        const auto& previewData = preview.previewData;
                        const double blockMidTime = chunkClipStart + (outputSamples * 0.5 / sampleRate);
                        const bool withinPreviewWindow = blockMidTime >= previewData.previewStartSec
                            && blockMidTime <= previewData.previewEndSec;
                        const float pitchRatio = lookupPitchRatio (previewData.pitchSegments, blockMidTime);
                        const bool pitchPreviewActive = allowLivePitchPreviewForChunk
                            && withinPreviewWindow
                            && std::abs (pitchRatio - 1.0f) > 0.001f;

                        if (! pitchPreviewActive)
                        {
                            preview.lastPlaybackTime = -1.0;
                        }
                        else
                        {
                            if (! preview.prepared)
                            {
                                preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                                preview.prepared = true;
                            }
                            if (preview.lastPlaybackTime < 0.0
                                || std::abs (chunkClipStart - preview.lastPlaybackTime) > 0.1)
                            {
                                preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                            }
                            preview.lastPlaybackTime = chunkClipStart + (outputSamples / sampleRate);

                            const float tonalityLimitNorm = static_cast<float> (
                                fileSampleRate > 0.0
                                    ? getPitchOnlyPreviewTonalityLimitHz (pitchRatio < 1.0f) / fileSampleRate
                                    : 0.0);
                            preview.stretcher.setTransposeFactor (pitchRatio, tonalityLimitNorm);
                            preview.stretcher.setFormantFactor (1.0f, true);

                            if (pitchShiftWorkBuffer.getNumSamples() < fileSamplesToRead)
                            {
                                pitchShiftWorkBuffer.setSize (readerChannels, fileSamplesToRead);
                                pitchShiftWorkBufferResizeCount.fetch_add (1, std::memory_order_relaxed);
                            }
                            for (int ch = 0; ch < readerChannels; ++ch)
                            {
                                pitchPreviewInPtrs[static_cast<size_t> (ch)] = reusableFileBuffer.getReadPointer (ch);
                                pitchPreviewOutPtrs[static_cast<size_t> (ch)] = pitchShiftWorkBuffer.getWritePointer (ch);
                            }
                            preview.stretcher.process (pitchPreviewInPtrs, fileSamplesToRead, pitchPreviewOutPtrs, fileSamplesToRead);
                            for (int ch = 0; ch < readerChannels; ++ch)
                                reusableFileBuffer.copyFrom (ch, 0, pitchShiftWorkBuffer, ch, 0, fileSamplesToRead);
                        }
                    }
                }
            }

            const int outChannels =
                playbackOutputChannels;
            const int channelsToProcess = std::min (outChannels, readerChannels);
            for (int i = 0; i < outputSamples; ++i)
            {
                const double filePos = bufferStartPosition + i * ratio;
                const double sampleTimeInClip = chunkClipStart + (i / sampleRate);
                float fadeGain = 1.0f;
                if (clip.fadeIn > 0.0 && sampleTimeInClip < clip.fadeIn)
                    fadeGain *= applyFadeCurve (static_cast<float> (sampleTimeInClip / clip.fadeIn), clip.fadeInCurve);
                const double timeFromEnd = clip.duration - sampleTimeInClip;
                if (clip.fadeOut > 0.0 && timeFromEnd < clip.fadeOut)
                    fadeGain *= applyFadeCurve (static_cast<float> (timeFromEnd / clip.fadeOut), clip.fadeOutCurve);
                const float envGain = envPoints ? interpolateGainEnvelope (*envPoints, sampleTimeInClip) : 1.0f;
                const float totalGain = clipGain * fadeGain * envGain;

                for (int ch = 0; ch < channelsToProcess; ++ch)
                {
                    const float sourceSample =
                        allReadAheadReady
                            ? sampleBufferCubic(
                                reusableFileBuffer,
                                ch,
                                fileSamplesToRead,
                                filePos)
                            : 0.0f;
                    const float continuitySample =
                        streamingContinuity != nullptr
                            ? streamingContinuity
                                ->processSample(
                                    ch,
                                    sourceSample,
                                    allReadAheadReady)
                            : sourceSample;
                    const float mixedSample =
                        continuitySample * totalGain;
                    playbackMix.addSample(
                        ch,
                        outputStart + i,
                        mixedSample);
                }
                if (streamingContinuity != nullptr)
                    streamingContinuity->advanceFrame(
                        allReadAheadReady);
            }
            if (streamingContinuity != nullptr)
            {
                streamingContinuity
                    ->expectedNextTimelineTime =
                        outputTimelineStart
                        + static_cast<double>(
                            outputSamples)
                            / sampleRate;
                streamingContinuity
                    ->hasExpectedTimelineTime = true;
            }

            if (shouldLogDetailed)
            {
                OPENSTUDIO_LOG_AUDIO_PLAYBACK("fillTrackBuffer chunk track=" + trackId
                    + " clipId=" + clip.clipId
                    + " out=[" + juce::String (outputStart) + "," + juce::String (outputStart + outputSamples) + "]"
                    + " clipStart=" + juce::String (chunkClipStart, 4)
                    + " sourceType=" + juce::String (usingRenderedPreviewSegment ? "rendered_segment"
                        : (usingCorrectedSource ? "corrected_source" : "original"))
                    + " fileOffset=" + juce::String (playbackOffset, 4)
                    + " src=shared_cubic_fractional");
            }
            return true;
        };

        bool mixedAnyChunk = false;
        for (size_t boundaryIndex = 0; boundaryIndex + 1 < chunkBoundaries.size(); ++boundaryIndex)
        {
            const int chunkStart = chunkBoundaries[boundaryIndex];
            const int chunkEnd = chunkBoundaries[boundaryIndex + 1];
            if (chunkEnd <= chunkStart)
                continue;

            const double chunkClipMid = currentTime
                + ((static_cast<double> (chunkStart + chunkEnd) * 0.5) / sampleRate)
                - clip.startTime;
            const RenderedPreviewSegment* activeSegment = nullptr;
            if (renderedSegmentsForClip != nullptr)
            {
                for (const auto& segment : *renderedSegmentsForClip)
                {
                    if (chunkClipMid >= segment.startSec && chunkClipMid < segment.endSec)
                    {
                        activeSegment = &segment;
                        break;
                    }
                }
            }

            const double chunkClipStart = currentTime + (static_cast<double> (chunkStart) / sampleRate) - clip.startTime;
            juce::File playbackFile = clip.audioFile;
            double playbackOffset = clip.offset + chunkClipStart;
            bool usingRenderedPreviewSegment = false;
            bool usingCorrectedSource = false;
            const juce::String* readerKey = &clip.readerKey;

            if (activeSegment != nullptr)
            {
                playbackFile = activeSegment->audioFile;
                playbackOffset = activeSegment->fileOffsetSec + (chunkClipStart - activeSegment->startSec);
                usingRenderedPreviewSegment = true;
                readerKey = &activeSegment->readerKey;
            }
            else if (clip.clipId.isNotEmpty())
            {
                auto correctedIt = pitchCorrectedFiles.find (clip.clipId);
                usingCorrectedSource = correctedIt != pitchCorrectedFiles.end()
                    && correctedIt->second.existsAsFile()
                    && playbackFile == correctedIt->second;
            }

            mixedAnyChunk = mixChunk (chunkStart, chunkEnd - chunkStart, playbackFile,
                                      *readerKey, playbackOffset,
                                      usingRenderedPreviewSegment, usingCorrectedSource)
                || mixedAnyChunk;
        }
        if (mixedAnyChunk)
            ++mixedClipCount;
        }
    }

    const bool startedOuterRecovery =
        trackContinuity.beginBlock(
            true,
            timelineContiguous,
            playbackOutputChannels);
    if (startedOuterRecovery)
    {
        outerLockContinuityRecoveryCount.fetch_add(
            1, std::memory_order_relaxed);
    }
    for (int sample = 0;
         sample < numSamples;
         ++sample)
    {
        for (int channel = 0;
             channel < playbackOutputChannels;
             ++channel)
        {
            const float continuousSample =
                trackContinuity.processSample(
                    channel,
                    playbackMix.getSample(
                        channel, sample),
                    true);
            playbackMix.setSample(
                channel,
                sample,
                continuousSample);
            buffer.addSample(
                channel,
                sample,
                continuousSample);
        }
        trackContinuity.advanceFrame(true);
    }
    trackContinuity.expectedNextTimelineTime =
        currentTime
        + static_cast<double>(numSamples)
            / sampleRate;
    trackContinuity.hasExpectedTimelineTime =
        true;

    const bool shouldUpdatePlaybackPeak = mixedClipCount > 0 && ((fillCall & 15) == 0 || shouldLogDetailed);
    const float playbackPeak = mixedClipCount == 0
        ? 0.0f
        : (shouldUpdatePlaybackPeak
            ? peakForBuffer(
                playbackMix, numSamples)
            : lastTrackPlaybackPeak.load(std::memory_order_relaxed));
    lastOverlappingClipCount.store(overlappingClipCount, std::memory_order_relaxed);
    lastMixedClipCount.store(mixedClipCount, std::memory_order_relaxed);
    if (shouldUpdatePlaybackPeak || mixedClipCount == 0)
        lastTrackPlaybackPeak.store(playbackPeak, std::memory_order_relaxed);
    if (shouldLogDetailed || (overlappingClipCount > 0 && mixedClipCount == 0))
    {
        OPENSTUDIO_LOG_AUDIO_PLAYBACK("fillTrackBuffer summary track=" + trackId
            + " overlapping=" + juce::String(overlappingClipCount)
            + " mixed=" + juce::String(mixedClipCount)
            + " peak=" + juce::String(playbackPeak, 4)
            + (overlappingClipCount == 0 ? " noOverlappingClips" : "")
            + (overlappingClipCount > 0 && mixedClipCount == 0 ? " WARNING_noMixedClips" : ""));
    }
}
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif
#undef OPENSTUDIO_LOG_AUDIO_PLAYBACK
