#pragma once

#include <JuceHeader.h>
#include <memory>
#include <atomic>

// Video integration via FFmpeg child process (no linking required)
// Extracts frames and audio from video files for timeline sync.
class VideoReader
{
public:
    VideoReader();
    ~VideoReader();

    struct VideoInfo
    {
        double duration = 0.0;
        int width = 0;
        int height = 0;
        double fps = 0.0;
        juce::String audioPath;  // Extracted audio WAV path
        juce::String filePath;   // Original video path
    };

    // Open a video file. Extracts metadata and audio track.
    // audioOutputDir: where to save the extracted audio WAV
    bool openFile(const juce::String& filePath, const juce::File& audioOutputDir);

    // Close the current video file
    void closeFile();

    bool isFileOpen() const { return fileOpen; }
    const VideoInfo& getInfo() const { return info; }

    // Extract a single frame at the given time as a JPEG base64 string
    // Uses FFmpeg to seek and extract one frame
    juce::String getFrameAtTime(double timeSeconds, int outputWidth = 320, int outputHeight = 180);

    // Set the FFmpeg executable path (defaults to adjacent ffmpeg.exe)
    void setFFmpegPath(const juce::File& path) { ffmpegExe = path; }

private:
    juce::File ffmpegExe;
    VideoInfo info;
    bool fileOpen = false;

    // Find FFmpeg executable
    juce::File findFFmpeg() const;

    // Parse video metadata using ffprobe or ffmpeg -i
    bool parseMetadata(const juce::String& filePath);

    // Extract audio stream from video to WAV
    bool extractAudio(const juce::String& videoPath, const juce::File& outputWav);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(VideoReader)
};
