#pragma once

#include <JuceHeader.h>
#include <vector>

/**
 * Represents a single MIDI event with timestamp.
 */
struct MIDIEvent
{
    double timestamp;           // Time in seconds from clip start
    juce::MidiMessage message;  // The MIDI message
    
    MIDIEvent(double time, const juce::MidiMessage& msg)
        : timestamp(time), message(msg) {}
};

/**
 * MIDIClip stores MIDI events for recording and playback.
 * Can import/export standard MIDI files.
 */
class MIDIClip
{
public:
    MIDIClip();
    MIDIClip(const juce::String& name, double startTime, double duration);
    ~MIDIClip();
    
    // Event management
    void addEvent(const MIDIEvent& event);
    void removeEvent(int index);
    void clearEvents();
    
    // Get events in time range
    std::vector<MIDIEvent> getEventsInRange(double startTime, double endTime) const;
    
    // Get all events
    const std::vector<MIDIEvent>& getAllEvents() const { return events; }
    
    // Clip properties
    void setName(const juce::String& newName) { name = newName; }
    juce::String getName() const { return name; }
    
    void setStartTime(double time) { startTime = time; }
    double getStartTime() const { return startTime; }
    
    void setDuration(double dur) { duration = dur; }
    double getDuration() const { return duration; }
    
    // Calculate duration from events
    void calculateDurationFromEvents();
    
    // MIDI file I/O
    bool importFromMidiFile(const juce::File& file);
    bool exportToMidiFile(const juce::File& file, double tempo = 120.0) const;
    
    // Quantize events to grid
    void quantize(double gridSize);
    
private:
    juce::String name;
    double startTime;
    double duration;
    std::vector<MIDIEvent> events;
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MIDIClip)
};
