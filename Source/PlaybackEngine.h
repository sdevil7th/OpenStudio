#pragma once

#include <JuceHeader.h>
#include <memory>
#include <vector>
#include <map>

/**
 * PlaybackEngine manages audio clip playback for the DAW.
 * Handles reading audio files, scheduling clips based on timeline position,
 * and mixing multiple clips playing simultaneously.
 */
class PlaybackEngine
{
public:
    PlaybackEngine();
    ~PlaybackEngine();
    
    // Clip information structure
    struct ClipInfo
    {
        juce::File audioFile;
        double startTime;      // When clip starts on timeline (seconds)
        double duration;       // Clip duration (seconds)
        double offset;         // Offset into audio file (for trimming, seconds)
        double volumeDB;       // Per-clip gain (-60 to +12 dB)
        double fadeIn;         // Fade in length (seconds)
        double fadeOut;        // Fade out length (seconds)
        juce::String trackId;        // Which track this clip belongs to
        bool isActive;         // Whether clip is currently loaded
        
        ClipInfo(const juce::File& file, double start, double dur, const juce::String& track, double off = 0.0,
                 double volDB = 0.0, double fIn = 0.0, double fOut = 0.0)
            : audioFile(file), startTime(start), duration(dur), offset(off),
              volumeDB(volDB), fadeIn(fIn), fadeOut(fOut),
              trackId(track), isActive(true) {}
    };
    
    // Clip management
    void addClip(const juce::File& audioFile, double startTime, double duration, const juce::String& trackId, 
                 double offset = 0.0, double volumeDB = 0.0, double fadeIn = 0.0, double fadeOut = 0.0);
    void removeClip(const juce::String& trackId, const juce::String& filePath);
    void clearAllClips();
    void clearTrackClips(const juce::String& trackId);
    
    // Called from audio callback to fill track buffer with playback audio
    // Called from audio callback to fill track buffer with playback audio
    void fillTrackBuffer(const juce::String& trackId,
                        juce::AudioBuffer<float>& buffer,
                        double currentTime,
                        int numSamples,
                        double sampleRate);
    
    // Utility
    int getNumClips() const { return (int)clips.size(); }
    int getNumClipsForTrack(const juce::String& trackId) const;
    
private:
    std::vector<ClipInfo> clips;
    std::map<juce::String, std::unique_ptr<juce::AudioFormatReader>> readers;
    juce::AudioFormatManager formatManager;
    juce::CriticalSection lock;
    
    // Get or create audio format reader for a file
    juce::AudioFormatReader* getReader(const juce::File& file);
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PlaybackEngine)
};
