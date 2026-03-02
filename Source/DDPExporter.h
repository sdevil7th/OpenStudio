#pragma once

#include <JuceHeader.h>
#include <vector>

// DDP 2.0 format exporter for CD replication
// Creates DDPID, DDPMS, IMAGE.DAT, and SUBCODE.DAT files
class DDPExporter
{
public:
    DDPExporter();
    ~DDPExporter();

    // CD track marker (from frontend markers)
    struct CDTrack
    {
        double startTime;      // Seconds
        double endTime;        // Seconds
        juce::String title;    // Track title
        juce::String isrc;     // ISRC code (12 chars, e.g., "USABC1234567")
    };

    // Export DDP image from rendered WAV file
    // sourceWav: 44.1kHz 16-bit stereo WAV (Red Book compliant)
    // outputDir: directory where DDP files will be written
    // tracks: list of CD track markers
    // catalogNumber: UPC/EAN barcode (optional, 13 digits)
    bool exportDDP(const juce::File& sourceWav,
                   const juce::File& outputDir,
                   const std::vector<CDTrack>& tracks,
                   const juce::String& catalogNumber = "");

    juce::String getLastError() const { return lastError; }

private:
    juce::String lastError;

    // Write the DDPID file (identification)
    bool writeDDPID(const juce::File& outputDir);

    // Write the DDPMS file (map stream — describes the DDP image)
    bool writeDDPMS(const juce::File& outputDir, juce::int64 imageLength,
                    const std::vector<CDTrack>& tracks, double sampleRate);

    // Write IMAGE.DAT (raw PCM audio data)
    bool writeImageData(const juce::File& outputDir, const juce::File& sourceWav,
                        juce::int64& outLength);

    // Write SUBCODE.DAT (P and Q subcode channels)
    bool writeSubcode(const juce::File& outputDir, const std::vector<CDTrack>& tracks,
                      juce::int64 totalSamples, double sampleRate,
                      const juce::String& catalogNumber);

    // Convert time in seconds to CD frames (1 frame = 1/75 sec = 588 samples at 44100)
    static int secondsToCDFrames(double seconds) { return (int)(seconds * 75.0); }

    // Convert CD frames to MSF (minutes:seconds:frames)
    struct MSF { int minutes; int seconds; int frames; };
    static MSF framesToMSF(int totalFrames);

    // Encode BCD (binary coded decimal) for subcode
    static uint8_t toBCD(int value);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(DDPExporter)
};
