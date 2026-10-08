// Control-thread publication and callback evaluation for destination-bound sends.
void TrackProcessor::prepareSendAutomation(SendConfig& send)
{
    auto& state = sendAutomationStates[send.destTrackId];
    if (!state)
        state = std::make_shared<SendAutomationState>();
    state->level.setDefaultValue(send.level);
    state->pan.setDefaultValue((send.pan + 1.0f) * 0.5f);
    state->mute.setDefaultValue(send.enabled ? 0.0f : 1.0f);
    state->trimDB.store(send.trimDB);
    state->trim.setDefaultValue(send.trimDB);
    send.automation = state;
}

bool TrackProcessor::hasSendAutomation() const
{
    for (const auto& send : sends)
    {
        const auto found = sendAutomationStates.find(send.destTrackId);
        if (found == sendAutomationStates.end())
            continue;
        for (const auto* list : { &found->second->level, &found->second->pan, &found->second->mute, &found->second->trim })
            if (list->hasPlaybackData() && list->shouldPlaybackForRead())
                return true;
    }
    return false;
}

void TrackProcessor::mixAutomatedSend(const RealtimeSendInfo& send,
                                     const juce::AudioBuffer<float>& source,
                                     juce::AudioBuffer<float>& destination, int samples,
                                     double timeSeconds, double sampleRate) const noexcept
{
    const auto* state = send.automation.get();
    const bool readLevel = state && state->level.hasPlaybackData() && shouldApplyAutomation(state->level);
    const bool readPan = state && state->pan.hasPlaybackData() && shouldApplyAutomation(state->pan);
    const bool readMute = state && state->mute.hasPlaybackData() && shouldApplyAutomation(state->mute);
    const bool readTrim = state && state->trim.hasPlaybackData() && shouldApplyAutomation(state->trim);
    const auto manualTrim = state ? state->trimDB.load(std::memory_order_relaxed) : 0.0f;
    if (!readLevel && !readPan && !readMute && !readTrim && manualTrim == 0.0f)
    {
        if (send.enabled && send.level > 0.0f)
            mixSendPair(source, destination, send.sourceChannel, samples, send.leftGain,
                        send.rightGain, send.level * (send.phaseInvert ? -1.0f : 1.0f));
        return;
    }

    samples = juce::jmin(samples, source.getNumSamples(), destination.getNumSamples());
    if (samples <= 0 || sampleRate <= 0.0 || send.sourceChannel < 0
        || send.sourceChannel >= source.getNumChannels() || destination.getNumChannels() < 1)
        return;
    const bool stereo = send.sourceChannel + 1 < source.getNumChannels() && destination.getNumChannels() >= 2;
    if (!stereo && send.sourceChannel != 0)
        return;
    const auto* inLeft = source.getReadPointer(send.sourceChannel);
    const auto* inRight = stereo ? source.getReadPointer(send.sourceChannel + 1) : nullptr;
    auto* outLeft = destination.getWritePointer(0);
    auto* outRight = stereo ? destination.getWritePointer(1) : nullptr;
    const auto phase = send.phaseInvert ? -1.0f : 1.0f;
    std::array<float, 128> levels {}, pans {}, mutes {}, trims {};
    for (int offset = 0; offset < samples; offset += 128)
    {
        const auto count = juce::jmin(128, samples - offset);
        const auto start = timeSeconds + static_cast<double>(offset) / sampleRate;
        if (readLevel) state->level.evalBlock(start, sampleRate, count, levels.data());
        if (readPan) state->pan.evalBlock(start, sampleRate, count, pans.data());
        if (readMute) state->mute.evalBlock(start, sampleRate, count, mutes.data());
        if (readTrim) state->trim.evalBlock(start, sampleRate, count, trims.data());
        for (int i = 0; i < count; ++i)
        {
            const auto muted = readMute ? mutes[static_cast<size_t>(i)] >= 0.5f : !send.enabled;
            if (muted)
                continue;
            const auto trimGain = juce::Decibels::decibelsToGain(juce::jlimit(-60.0f, 12.0f, readTrim ? trims[static_cast<size_t>(i)] : manualTrim));
            const auto gain = phase * juce::jlimit(0.0f, 1.0f, readLevel ? levels[static_cast<size_t>(i)] : send.level) * trimGain;
            const auto pan = readPan ? pans[static_cast<size_t>(i)] : (send.pan + 1.0f) * 0.5f;
            const auto sample = offset + i;
            outLeft[sample] += inLeft[sample] * gain * (stereo ? sendPanGain(1.0f - pan) : 1.0f);
            if (stereo)
                outRight[sample] += inRight[sample] * gain * sendPanGain(pan);
        }
    }
}
