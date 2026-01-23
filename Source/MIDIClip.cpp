#include "MIDIClip.h"

MIDIClip::MIDIClip()
    : name("MIDI Clip"), startTime(0.0), duration(0.0)
{
}

MIDIClip::MIDIClip(const juce::String& clipName, double start, double dur)
    : name(clipName), startTime(start), duration(dur)
{
}

MIDIClip::~MIDIClip()
{
}

void MIDIClip::addEvent(const MIDIEvent& event)
{
    events.push_back(event);
    
    // Keep events sorted by timestamp
    std::sort(events.begin(), events.end(),
        [](const MIDIEvent& a, const MIDIEvent& b) {
            return a.timestamp < b.timestamp;
        });
}

void MIDIClip::removeEvent(int index)
{
    if (index >= 0 && index < static_cast<int>(events.size()))
    {
        events.erase(events.begin() + index);
    }
}

void MIDIClip::clearEvents()
{
    events.clear();
}

std::vector<MIDIEvent> MIDIClip::getEventsInRange(double start, double end) const
{
    std::vector<MIDIEvent> result;
    
    for (const auto& event : events)
    {
        if (event.timestamp >= start && event.timestamp < end)
        {
            result.push_back(event);
        }
    }
    
    return result;
}

void MIDIClip::calculateDurationFromEvents()
{
    if (events.empty())
    {
        duration = 0.0;
        return;
    }
    
    double maxTime = 0.0;
    for (const auto& event : events)
    {
        if (event.timestamp > maxTime)
            maxTime = event.timestamp;
    }
    
    duration = maxTime + 1.0; // Add 1 second buffer
}

bool MIDIClip::importFromMidiFile(const juce::File& file)
{
    if (!file.existsAsFile())
    {
        juce::Logger::writeToLog("MIDIClip: File does not exist: " + file.getFullPathName());
        return false;
    }
    
    juce::FileInputStream fileStream(file);
    if (fileStream.failedToOpen())
    {
        juce::Logger::writeToLog("MIDIClip: Failed to open file: " + file.getFullPathName());
        return false;
    }
    
    juce::MidiFile midiFile;
    if (!midiFile.readFrom(fileStream))
    {
        juce::Logger::writeToLog("MIDIClip: Failed to read MIDI file: " + file.getFullPathName());
        return false;
    }
    
    clearEvents();
    
    // Convert MIDI file to events
    // Use first track for now (can be extended to handle multiple tracks)
    if (midiFile.getNumTracks() > 0)
    {
        const juce::MidiMessageSequence* track = midiFile.getTrack(0);
        
        for (int i = 0; i < track->getNumEvents(); ++i)
        {
            const juce::MidiMessageSequence::MidiEventHolder* holder = track->getEventPointer(i);
            MIDIEvent event(holder->message.getTimeStamp(), holder->message);
            addEvent(event);
        }
    }
    
    calculateDurationFromEvents();
    
    juce::Logger::writeToLog("MIDIClip: Imported " + juce::String(events.size()) + " events from " + file.getFileName());
    return true;
}

bool MIDIClip::exportToMidiFile(const juce::File& file, double tempo) const
{
    juce::MidiFile midiFile;
    midiFile.setTicksPerQuarterNote(480);
    
    juce::MidiMessageSequence sequence;
    
    // Add tempo event
    sequence.addEvent(juce::MidiMessage::tempoMetaEvent(static_cast<int>(60000000.0 / tempo)), 0.0);
    
    // Add all MIDI events
    for (const auto& event : events)
    {
        sequence.addEvent(event.message, event.timestamp);
    }
    
    midiFile.addTrack(sequence);
    
    // Write to file
    juce::FileOutputStream outputStream(file);
    if (outputStream.failedToOpen())
    {
        juce::Logger::writeToLog("MIDIClip: Failed to create output file: " + file.getFullPathName());
        return false;
    }
    
    midiFile.writeTo(outputStream);
    
    juce::Logger::writeToLog("MIDIClip: Exported " + juce::String(events.size()) + " events to " + file.getFileName());
    return true;
}

void MIDIClip::quantize(double gridSize)
{
    for (auto& event : events)
    {
        double quantized = std::round(event.timestamp / gridSize) * gridSize;
        event.timestamp = quantized;
    }
    
    // Re-sort after quantization
    std::sort(events.begin(), events.end(),
        [](const MIDIEvent& a, const MIDIEvent& b) {
            return a.timestamp < b.timestamp;
        });
}
