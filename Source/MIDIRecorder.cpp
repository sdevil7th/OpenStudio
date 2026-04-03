#include "MIDIRecorder.h"

void MIDIRecorder::startRecording(const juce::String& trackId, double sampleRate)
{
    const juce::ScopedLock sl(recLock);

    // Stop any existing recording for this track
    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end())
    {
        it->second.isActive = false;
        activeRecordings.erase(it);
    }

    ActiveMIDIRecording& state = activeRecordings[trackId];
    state.trackId = trackId;
    state.events.clear();
    state.events.reserve(1024);  // Pre-allocate for typical session
    state.previewNoteEvents.clear();
    state.previewNoteEvents.reserve(1024);
    state.activeHeldNotes.clear();
    state.startTime = 0.0;
    state.sampleRate = sampleRate;
    state.generation = nextPreviewGeneration.fetch_add(1, std::memory_order_relaxed);
    state.isActive = true;

    juce::Logger::writeToLog("MIDIRecorder: Started recording track " + trackId);
}

void MIDIRecorder::recordEvent(const juce::String& trackId, double timeInSeconds, const juce::MidiMessage& message)
{
    // Use TryLock — drop events if map is being modified (start/stop).
    // This is extremely rare and losing a single event during start/stop is acceptable.
    const juce::ScopedTryLock stl(recLock);
    if (!stl.isLocked())
        return;

    auto it = activeRecordings.find(trackId);
    if (it == activeRecordings.end() || !it->second.isActive.load())
        return;

    auto& state = it->second;

    // Convert absolute time to time relative to recording start
    double relativeTime = timeInSeconds - state.startTime;
    if (relativeTime < 0.0)
        relativeTime = 0.0;

    state.events.emplace_back(relativeTime, message);

    if (message.isNoteOn())
    {
        state.previewNoteEvents.emplace_back(relativeTime, message);
        state.activeHeldNotes.push_back(HeldPreviewNote {
            message.getNoteNumber(),
            juce::jlimit(1, 16, message.getChannel()),
            relativeTime,
        });
    }
    else if (message.isNoteOff())
    {
        state.previewNoteEvents.emplace_back(relativeTime, message);

        for (auto itHeld = state.activeHeldNotes.rbegin(); itHeld != state.activeHeldNotes.rend(); ++itHeld)
        {
            if (itHeld->note == message.getNoteNumber()
                && itHeld->channel == juce::jlimit(1, 16, message.getChannel()))
            {
                state.activeHeldNotes.erase(std::next(itHeld).base());
                break;
            }
        }
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        const int channel = juce::jlimit(1, 16, message.getChannel());
        state.activeHeldNotes.erase(
            std::remove_if(state.activeHeldNotes.begin(), state.activeHeldNotes.end(),
                [channel](const HeldPreviewNote& heldNote)
                {
                    return heldNote.channel == channel;
                }),
            state.activeHeldNotes.end());
    }
}

void MIDIRecorder::setRecordingStartTime(const juce::String& trackId, double timeInSeconds)
{
    const juce::ScopedTryLock stl(recLock);
    if (!stl.isLocked())
        return;

    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end())
    {
        it->second.startTime = timeInSeconds;
    }
}

bool MIDIRecorder::isRecording(const juce::String& trackId) const
{
    const juce::ScopedTryLock stl(recLock);
    if (!stl.isLocked())
        return false;

    auto it = activeRecordings.find(trackId);
    return it != activeRecordings.end() && it->second.isActive.load();
}

std::vector<MIDIRecorder::CompletedMIDIRecording> MIDIRecorder::stopAllRecordings(const juce::File& outputFolder, double tempo)
{
    std::vector<CompletedMIDIRecording> completed;

    const juce::ScopedLock sl(recLock);

    for (auto& [trackId, state] : activeRecordings)
    {
        state.isActive = false;

        if (state.events.empty())
            continue;

        // Sort events by timestamp
        std::sort(state.events.begin(), state.events.end(),
            [](const MIDIEvent& a, const MIDIEvent& b) { return a.timestamp < b.timestamp; });

        // Calculate duration from last event
        double duration = 0.0;
        for (const auto& evt : state.events)
        {
            if (evt.timestamp > duration)
                duration = evt.timestamp;
        }
        duration += 0.5;  // Add 500ms buffer after last event

        CompletedMIDIRecording clip;
        clip.trackId = trackId;
        clip.startTime = state.startTime;
        clip.duration = duration;
        clip.events = std::move(state.events);

        // Export to .mid file for persistence
        if (outputFolder.exists() || outputFolder.createDirectory())
        {
            auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
            auto filename = "Track_" + trackId + "_MIDI_" + juce::String(timestamp) + ".mid";
            auto midiFile = outputFolder.getChildFile(filename);

            MIDIClip tempClip("Recording", 0.0, duration);
            for (const auto& evt : clip.events)
            {
                tempClip.addEvent(evt);
            }

            if (tempClip.exportToMidiFile(midiFile, tempo))
            {
                clip.midiFile = midiFile;
                juce::Logger::writeToLog("MIDIRecorder: Exported " + juce::String(clip.events.size()) +
                                         " events to " + midiFile.getFullPathName());
            }
        }

        completed.push_back(std::move(clip));
    }

    activeRecordings.clear();

    juce::Logger::writeToLog("MIDIRecorder: Stopped all recordings. Completed " +
                             juce::String(completed.size()) + " MIDI clips.");

    return completed;
}

std::vector<MIDIRecorder::LivePreviewSnapshot> MIDIRecorder::getLivePreviewSnapshots(
    const std::vector<LivePreviewRequest>& requests) const
{
    std::vector<LivePreviewSnapshot> snapshots;

    const juce::ScopedTryLock stl(recLock);
    if (!stl.isLocked())
        return snapshots;

    snapshots.reserve(requests.size());

    for (const auto& request : requests)
    {
        auto it = activeRecordings.find(request.trackId);
        if (it == activeRecordings.end() || !it->second.isActive.load())
            continue;

        const auto& state = it->second;
        LivePreviewSnapshot snapshot;
        snapshot.trackId = request.trackId;
        snapshot.generation = state.generation;
        snapshot.recordingStartTime = state.startTime;
        snapshot.totalEventCount = static_cast<int>(state.previewNoteEvents.size());

        int copyStartIndex = 0;
        if (request.generation == state.generation)
            copyStartIndex = juce::jlimit(0, snapshot.totalEventCount, request.knownEventCount);

        snapshot.deltaEvents.reserve(static_cast<size_t>(juce::jmax(0, snapshot.totalEventCount - copyStartIndex)));
        for (int eventIndex = copyStartIndex; eventIndex < snapshot.totalEventCount; ++eventIndex)
            snapshot.deltaEvents.push_back(state.previewNoteEvents[static_cast<size_t>(eventIndex)]);

        snapshot.activeNotes.reserve(state.activeHeldNotes.size());
        for (const auto& heldNote : state.activeHeldNotes)
        {
            snapshot.activeNotes.push_back(LivePreviewActiveNote {
                heldNote.note,
                heldNote.startTimestamp,
            });
        }

        snapshots.push_back(std::move(snapshot));
    }

    return snapshots;
}

void MIDIRecorder::stopRecording(const juce::String& trackId)
{
    const juce::ScopedLock sl(recLock);

    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end())
    {
        it->second.isActive = false;
        activeRecordings.erase(it);
        juce::Logger::writeToLog("MIDIRecorder: Stopped recording track " + trackId);
    }
}
