#include "TriggerEngine.h"
#include <cmath>

//==============================================================================
// Construction / Destruction
//==============================================================================

TriggerEngine::TriggerEngine()
{
}

TriggerEngine::~TriggerEngine()
{
}

//==============================================================================
// Grid Management
//==============================================================================

void TriggerEngine::setGridSize(int numTracks, int numSlots)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    numTracks_ = juce::jmax(0, numTracks);
    numSlots_ = juce::jmax(0, numSlots);

    // Pre-allocate: resize outer vector
    grid_.resize(static_cast<size_t>(numTracks_));

    // Pre-allocate: resize each track's slot vector
    for (auto& trackSlots : grid_)
    {
        trackSlots.resize(static_cast<size_t>(numSlots_));
    }

    // Reset the beat tracker since grid topology changed
    previousBeat_ = -1.0;
}

//==============================================================================
// Slot Content Management (message thread)
//==============================================================================

void TriggerEngine::setSlotClip(int trackIndex, int slotIndex,
                                const juce::String& filePath,
                                double duration, double offset)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return;

    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];
    slot.filePath = filePath;
    slot.duration = duration;
    slot.offset = offset;
    slot.startTime = 0.0;
    slot.isPlaying = false;
    slot.isQueued = false;
    slot.isStopQueued = false;
    slot.playPosition = 0.0;
}

void TriggerEngine::clearSlot(int trackIndex, int slotIndex)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return;

    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];

    // Stop if playing
    if (slot.isPlaying)
        stopSlotInternal(trackIndex, slotIndex);

    // Reset all fields
    slot.filePath = juce::String();
    slot.startTime = 0.0;
    slot.duration = 0.0;
    slot.offset = 0.0;
    slot.mode = ClipLaunchMode::OneShot;
    slot.isPlaying = false;
    slot.isQueued = false;
    slot.isStopQueued = false;
    slot.playPosition = 0.0;
    slot.volume = 0.0f;
    slot.followAction = FollowAction::None;
    slot.followActionTime = 0.0;
}

void TriggerEngine::setSlotMode(int trackIndex, int slotIndex, ClipLaunchMode mode)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return;

    grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)].mode = mode;
}

void TriggerEngine::setSlotVolume(int trackIndex, int slotIndex, float volumeDB)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return;

    grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)].volume = volumeDB;
}

void TriggerEngine::setSlotFollowAction(int trackIndex, int slotIndex,
                                        FollowAction action, double timeInBeats)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return;

    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];
    slot.followAction = action;
    slot.followActionTime = timeInBeats;
}

//==============================================================================
// Trigger Control (message thread)
//==============================================================================

void TriggerEngine::triggerSlot(int trackIndex, int slotIndex)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return;

    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];

    if (!slot.hasClip())
        return;

    // For Gate mode: if already playing, re-trigger means stop
    if (slot.mode == ClipLaunchMode::Gate && slot.isPlaying)
    {
        slot.isStopQueued = true;
        slot.isQueued = false;
        return;
    }

    // Stop any currently playing slot on this track (exclusive — only one slot per track)
    for (int s = 0; s < numSlots_; ++s)
    {
        auto& other = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(s)];
        if (other.isPlaying && s != slotIndex)
        {
            other.isStopQueued = true;
        }
        // Cancel any pending queue on other slots
        if (s != slotIndex)
        {
            other.isQueued = false;
        }
    }

    // If quantize is None, start immediately; otherwise queue
    if (quantizeMode_.load() == TriggerQuantizeMode::None)
    {
        // Stop other playing slots immediately
        for (int s = 0; s < numSlots_; ++s)
        {
            auto& other = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(s)];
            if (other.isStopQueued)
            {
                stopSlotInternal(trackIndex, s);
            }
        }
        startSlotInternal(trackIndex, slotIndex);
    }
    else
    {
        slot.isQueued = true;
        slot.isStopQueued = false;
    }
}

void TriggerEngine::stopSlot(int trackIndex, int slotIndex)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return;

    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];

    if (!slot.isPlaying && !slot.isQueued)
        return;

    // Cancel a pending launch queue
    if (slot.isQueued && !slot.isPlaying)
    {
        slot.isQueued = false;
        return;
    }

    // If quantize is None, stop immediately; otherwise queue
    if (quantizeMode_.load() == TriggerQuantizeMode::None)
    {
        stopSlotInternal(trackIndex, slotIndex);
    }
    else
    {
        slot.isStopQueued = true;
    }
}

void TriggerEngine::stopTrack(int trackIndex)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (trackIndex < 0 || trackIndex >= numTracks_)
        return;

    for (int s = 0; s < numSlots_; ++s)
    {
        auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(s)];

        slot.isQueued = false;

        if (slot.isPlaying)
        {
            if (quantizeMode_.load() == TriggerQuantizeMode::None)
                stopSlotInternal(trackIndex, s);
            else
                slot.isStopQueued = true;
        }
    }
}

void TriggerEngine::triggerScene(int slotIndex)
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (slotIndex < 0 || slotIndex >= numSlots_)
        return;

    for (int t = 0; t < numTracks_; ++t)
    {
        auto& slot = grid_[static_cast<size_t>(t)][static_cast<size_t>(slotIndex)];

        if (!slot.hasClip())
            continue;

        // Stop other slots on this track
        for (int s = 0; s < numSlots_; ++s)
        {
            if (s == slotIndex)
                continue;

            auto& other = grid_[static_cast<size_t>(t)][static_cast<size_t>(s)];
            other.isQueued = false;

            if (other.isPlaying)
            {
                if (quantizeMode_.load() == TriggerQuantizeMode::None)
                    stopSlotInternal(t, s);
                else
                    other.isStopQueued = true;
            }
        }

        // Queue or start the scene slot
        if (quantizeMode_.load() == TriggerQuantizeMode::None)
        {
            startSlotInternal(t, slotIndex);
        }
        else
        {
            slot.isQueued = true;
            slot.isStopQueued = false;
        }
    }
}

void TriggerEngine::stopAll()
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    for (int t = 0; t < numTracks_; ++t)
    {
        for (int s = 0; s < numSlots_; ++s)
        {
            auto& slot = grid_[static_cast<size_t>(t)][static_cast<size_t>(s)];

            slot.isQueued = false;

            if (slot.isPlaying)
            {
                if (quantizeMode_.load() == TriggerQuantizeMode::None)
                    stopSlotInternal(t, s);
                else
                    slot.isStopQueued = true;
            }
        }
    }
}

//==============================================================================
// Quantize
//==============================================================================

void TriggerEngine::setQuantize(TriggerQuantizeMode mode)
{
    quantizeMode_.store(mode);
}

//==============================================================================
// Audio Thread Processing
//==============================================================================

void TriggerEngine::processBlock(int numSamples, double sampleRate, double bpm, double currentBeat)
{
    const juce::SpinLock::ScopedTryLockType lock(spinLock_);

    if (!lock.isLocked())
        return; // Message thread holds the lock — skip this block (inaudible)

    // Calculate the beat position at the end of this block
    const double secondsPerBeat = (bpm > 0.0) ? (60.0 / bpm) : 0.5;
    const double blockDurationSeconds = (sampleRate > 0.0)
        ? (static_cast<double>(numSamples) / sampleRate)
        : 0.0;
    const double blockDurationBeats = (secondsPerBeat > 0.0)
        ? (blockDurationSeconds / secondsPerBeat)
        : 0.0;

    // Check if we crossed a quantize boundary
    const bool atBoundary = isQuantizeBoundary(currentBeat, bpm);

    // Process queued triggers and stops at quantize boundaries
    if (atBoundary)
    {
        for (int t = 0; t < numTracks_; ++t)
        {
            for (int s = 0; s < numSlots_; ++s)
            {
                auto& slot = grid_[static_cast<size_t>(t)][static_cast<size_t>(s)];

                // Handle queued stops first (so exclusive stop + new start works in one boundary)
                if (slot.isStopQueued)
                {
                    stopSlotInternal(t, s);
                }

                // Handle queued launches
                if (slot.isQueued)
                {
                    startSlotInternal(t, s);
                }
            }
        }
    }

    // Advance play positions for all active slots
    for (int t = 0; t < numTracks_; ++t)
    {
        for (int s = 0; s < numSlots_; ++s)
        {
            auto& slot = grid_[static_cast<size_t>(t)][static_cast<size_t>(s)];

            if (!slot.isPlaying)
                continue;

            // Advance position by block duration
            slot.playPosition += blockDurationSeconds;

            // Check if clip reached its end
            if (slot.playPosition >= slot.duration)
            {
                if (slot.mode == ClipLaunchMode::Loop)
                {
                    // Wrap around for looping
                    while (slot.playPosition >= slot.duration && slot.duration > 0.0)
                        slot.playPosition -= slot.duration;
                }
                else
                {
                    // OneShot or Gate: check for follow action first
                    if (slot.followAction != FollowAction::None && slot.followActionTime > 0.0)
                    {
                        // Follow action time is in beats — check if we've exceeded it
                        const double playedBeats = (secondsPerBeat > 0.0)
                            ? (slot.playPosition / secondsPerBeat)
                            : 0.0;

                        if (playedBeats >= slot.followActionTime)
                        {
                            executeFollowAction(t, s);
                            continue; // slot state changed, skip further processing
                        }
                        // Keep the slot alive until follow action time
                    }
                    else
                    {
                        // No follow action — stop the slot
                        stopSlotInternal(t, s);
                    }
                }
            }
            else if (slot.followAction != FollowAction::None && slot.followActionTime > 0.0)
            {
                // For Loop mode with follow actions, check beat-based follow action time
                const double playedBeats = (secondsPerBeat > 0.0)
                    ? (slot.playPosition / secondsPerBeat)
                    : 0.0;

                if (playedBeats >= slot.followActionTime)
                {
                    executeFollowAction(t, s);
                }
            }
        }
    }

    // Update previous beat for next boundary check
    previousBeat_ = currentBeat + blockDurationBeats;
}

//==============================================================================
// State Queries
//==============================================================================

juce::var TriggerEngine::getSlotState(int trackIndex, int slotIndex) const
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    if (!isValidSlot(trackIndex, slotIndex))
        return juce::var();

    const auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];

    auto* obj = new juce::DynamicObject();

    obj->setProperty("trackIndex", trackIndex);
    obj->setProperty("slotIndex", slotIndex);
    obj->setProperty("filePath", slot.filePath);
    obj->setProperty("startTime", slot.startTime);
    obj->setProperty("duration", slot.duration);
    obj->setProperty("offset", slot.offset);
    obj->setProperty("hasClip", slot.hasClip());
    obj->setProperty("isPlaying", slot.isPlaying);
    obj->setProperty("isQueued", slot.isQueued);
    obj->setProperty("isStopQueued", slot.isStopQueued);
    obj->setProperty("playPosition", slot.playPosition);
    obj->setProperty("volume", static_cast<double>(slot.volume));

    // Enum as int for easy JS consumption
    obj->setProperty("mode", static_cast<int>(slot.mode));
    obj->setProperty("followAction", static_cast<int>(slot.followAction));
    obj->setProperty("followActionTime", slot.followActionTime);

    return juce::var(obj);
}

juce::var TriggerEngine::getGridState() const
{
    const juce::SpinLock::ScopedLockType lock(spinLock_);

    auto* root = new juce::DynamicObject();
    root->setProperty("numTracks", numTracks_);
    root->setProperty("numSlots", numSlots_);
    root->setProperty("quantize", static_cast<int>(quantizeMode_.load()));

    juce::Array<juce::var> tracksArray;

    for (int t = 0; t < numTracks_; ++t)
    {
        juce::Array<juce::var> slotsArray;

        for (int s = 0; s < numSlots_; ++s)
        {
            const auto& slot = grid_[static_cast<size_t>(t)][static_cast<size_t>(s)];

            auto* slotObj = new juce::DynamicObject();
            slotObj->setProperty("filePath", slot.filePath);
            slotObj->setProperty("duration", slot.duration);
            slotObj->setProperty("offset", slot.offset);
            slotObj->setProperty("hasClip", slot.hasClip());
            slotObj->setProperty("isPlaying", slot.isPlaying);
            slotObj->setProperty("isQueued", slot.isQueued);
            slotObj->setProperty("isStopQueued", slot.isStopQueued);
            slotObj->setProperty("playPosition", slot.playPosition);
            slotObj->setProperty("volume", static_cast<double>(slot.volume));
            slotObj->setProperty("mode", static_cast<int>(slot.mode));
            slotObj->setProperty("followAction", static_cast<int>(slot.followAction));
            slotObj->setProperty("followActionTime", slot.followActionTime);

            slotsArray.add(juce::var(slotObj));
        }

        tracksArray.add(juce::var(slotsArray));
    }

    root->setProperty("tracks", juce::var(tracksArray));

    return juce::var(root);
}

//==============================================================================
// Internal Helpers
//==============================================================================

bool TriggerEngine::isValidSlot(int trackIndex, int slotIndex) const
{
    return trackIndex >= 0 && trackIndex < numTracks_
        && slotIndex >= 0 && slotIndex < numSlots_;
}

double TriggerEngine::getBeatsPerQuantize() const
{
    switch (quantizeMode_.load())
    {
        case TriggerQuantizeMode::None:     return 0.0;
        case TriggerQuantizeMode::Quarter:  return 1.0;
        case TriggerQuantizeMode::Half:     return 2.0;
        case TriggerQuantizeMode::Bar:      return 4.0;   // Assumes 4/4 time
        case TriggerQuantizeMode::TwoBar:   return 8.0;
        case TriggerQuantizeMode::FourBar:  return 16.0;
        default:                            return 4.0;
    }
}

bool TriggerEngine::isQuantizeBoundary(double currentBeat, double bpm) const
{
    juce::ignoreUnused(bpm);

    const auto mode = quantizeMode_.load();

    if (mode == TriggerQuantizeMode::None)
        return true; // Always at boundary — triggers are immediate

    const double beatsPerQ = getBeatsPerQuantize();

    if (beatsPerQ <= 0.0)
        return true;

    // First call — no previous beat to compare against
    if (previousBeat_ < 0.0)
        return false;

    // Check if the quantize boundary index changed between previousBeat and currentBeat
    // Using floor division: boundary N is at beat N * beatsPerQ
    const auto prevBoundary = static_cast<long long>(std::floor(previousBeat_ / beatsPerQ));
    const auto currBoundary = static_cast<long long>(std::floor(currentBeat / beatsPerQ));

    return currBoundary > prevBoundary;
}

void TriggerEngine::startSlotInternal(int trackIndex, int slotIndex)
{
    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];

    slot.isQueued = false;
    slot.isPlaying = true;
    slot.playPosition = 0.0;

    // Notify (deferred to message thread)
    if (onSlotStarted)
    {
        const int t = trackIndex;
        const int s = slotIndex;
        auto callback = onSlotStarted;
        juce::MessageManager::callAsync([callback, t, s]() { callback(t, s); });
    }
}

void TriggerEngine::stopSlotInternal(int trackIndex, int slotIndex)
{
    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];

    const bool wasPlaying = slot.isPlaying;

    slot.isPlaying = false;
    slot.isQueued = false;
    slot.isStopQueued = false;
    slot.playPosition = 0.0;

    // Notify (deferred to message thread)
    if (wasPlaying && onSlotStopped)
    {
        const int t = trackIndex;
        const int s = slotIndex;
        auto callback = onSlotStopped;
        juce::MessageManager::callAsync([callback, t, s]() { callback(t, s); });
    }
}

void TriggerEngine::executeFollowAction(int trackIndex, int slotIndex)
{
    auto& slot = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(slotIndex)];

    switch (slot.followAction)
    {
        case FollowAction::None:
            // Shouldn't reach here, but handle gracefully
            stopSlotInternal(trackIndex, slotIndex);
            break;

        case FollowAction::Next:
        {
            stopSlotInternal(trackIndex, slotIndex);

            // Find next slot with a clip
            for (int offset = 1; offset < numSlots_; ++offset)
            {
                const int nextSlot = (slotIndex + offset) % numSlots_;
                auto& next = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(nextSlot)];

                if (next.hasClip())
                {
                    startSlotInternal(trackIndex, nextSlot);
                    break;
                }
            }
            break;
        }

        case FollowAction::Previous:
        {
            stopSlotInternal(trackIndex, slotIndex);

            // Find previous slot with a clip
            for (int offset = 1; offset < numSlots_; ++offset)
            {
                const int prevSlot = ((slotIndex - offset) % numSlots_ + numSlots_) % numSlots_;
                auto& prev = grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(prevSlot)];

                if (prev.hasClip())
                {
                    startSlotInternal(trackIndex, prevSlot);
                    break;
                }
            }
            break;
        }

        case FollowAction::Random:
        {
            stopSlotInternal(trackIndex, slotIndex);

            // Collect all slots with clips (excluding current)
            // Use a fixed-size array to avoid heap allocation
            int candidates[256];
            int numCandidates = 0;

            for (int s = 0; s < numSlots_ && numCandidates < 256; ++s)
            {
                if (s == slotIndex)
                    continue;

                if (grid_[static_cast<size_t>(trackIndex)][static_cast<size_t>(s)].hasClip())
                {
                    candidates[numCandidates++] = s;
                }
            }

            if (numCandidates > 0)
            {
                // Simple pseudo-random using JUCE's Random (audio-thread safe, no heap)
                const int pick = juce::Random::getSystemRandom().nextInt(numCandidates);
                startSlotInternal(trackIndex, candidates[pick]);
            }
            break;
        }

        case FollowAction::Stop:
            stopSlotInternal(trackIndex, slotIndex);
            break;
    }
}
