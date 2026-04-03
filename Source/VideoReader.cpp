#include "VideoReader.h"

VideoReader::VideoReader()
{
    ffmpegExe = findFFmpeg();
}

VideoReader::~VideoReader()
{
    closeFile();
}

juce::File VideoReader::findFFmpeg() const
{
    // Look next to the executable first
    auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
    auto ffmpeg = exeDir.getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile())
        return ffmpeg;

    // Try PATH
    return juce::File("ffmpeg");
}

bool VideoReader::openFile(const juce::String& filePath, const juce::File& audioOutputDir)
{
    closeFile();

    if (!juce::File(filePath).existsAsFile())
        return false;

    if (!parseMetadata(filePath))
        return false;

    info.filePath = filePath;

    // Extract audio to WAV
    juce::String baseName = juce::File(filePath).getFileNameWithoutExtension();
    juce::File audioFile = audioOutputDir.getChildFile(baseName + "_audio.wav");
    audioOutputDir.createDirectory();

    if (extractAudio(filePath, audioFile))
        info.audioPath = audioFile.getFullPathName();

    fileOpen = true;
    juce::Logger::writeToLog("VideoReader: Opened " + filePath +
                             " (" + juce::String(info.width) + "x" + juce::String(info.height) +
                             " @ " + juce::String(info.fps, 2) + "fps, " +
                             juce::String(info.duration, 2) + "s)");
    return true;
}

void VideoReader::closeFile()
{
    info = VideoInfo();
    fileOpen = false;
}

bool VideoReader::parseMetadata(const juce::String& filePath)
{
    if (!ffmpegExe.existsAsFile() && ffmpegExe.getFullPathName() != "ffmpeg")
        return false;

    // Use ffmpeg -i to get metadata (writes to stderr)
    juce::ChildProcess proc;
    juce::String cmd = "\"" + ffmpegExe.getFullPathName() + "\" -i \"" + filePath + "\" -hide_banner";

    if (!proc.start(cmd))
        return false;

    // ffmpeg -i exits with error code 1 but writes metadata to stderr
    proc.waitForProcessToFinish(10000);
    juce::String output = proc.readAllProcessOutput();

    // Parse duration: "Duration: HH:MM:SS.ms"
    int durIdx = output.indexOf("Duration:");
    if (durIdx >= 0)
    {
        juce::String durStr = output.substring(durIdx + 9).trim();
        durStr = durStr.upToFirstOccurrenceOf(",", false, false).trim();
        // Parse HH:MM:SS.ms
        juce::StringArray parts;
        parts.addTokens(durStr, ":", "");
        if (parts.size() >= 3)
        {
            double h = parts[0].getDoubleValue();
            double m = parts[1].getDoubleValue();
            double s = parts[2].getDoubleValue();
            info.duration = h * 3600.0 + m * 60.0 + s;
        }
    }

    // Parse video stream info: "Stream #0:0: Video: ... WxH ... fps"
    int vidIdx = output.indexOf("Video:");
    if (vidIdx >= 0)
    {
        juce::String vidLine = output.substring(vidIdx);
        vidLine = vidLine.upToFirstOccurrenceOf("\n", false, false);

        // Find resolution: look for pattern "NxN"
        juce::StringArray tokens;
        tokens.addTokens(vidLine, " ,", "");
        for (int i = 0; i < tokens.size(); ++i)
        {
            if (tokens[i].containsChar('x') && !tokens[i].startsWith("0x"))
            {
                juce::StringArray dims;
                dims.addTokens(tokens[i], "x", "");
                if (dims.size() >= 2)
                {
                    int w = dims[0].getIntValue();
                    int h = dims[1].getIntValue();
                    if (w > 0 && h > 0 && w < 10000 && h < 10000)
                    {
                        info.width = w;
                        info.height = h;
                        break;
                    }
                }
            }
        }

        // Find FPS: look for "XX fps" or "XX.XX fps"
        for (int i = 0; i < tokens.size(); ++i)
        {
            if (tokens[i] == "fps" && i > 0)
            {
                info.fps = tokens[i - 1].getDoubleValue();
                break;
            }
        }
    }

    return info.duration > 0.0;
}

bool VideoReader::extractAudio(const juce::String& videoPath, const juce::File& outputWav)
{
    if (!ffmpegExe.existsAsFile() && ffmpegExe.getFullPathName() != "ffmpeg")
        return false;

    if (outputWav.existsAsFile())
        outputWav.deleteFile();

    juce::String cmd = "\"" + ffmpegExe.getFullPathName() + "\" -i \"" + videoPath +
                       "\" -vn -acodec pcm_s24le -ar 48000 -y \"" + outputWav.getFullPathName() + "\"";

    juce::ChildProcess proc;
    if (!proc.start(cmd))
        return false;

    proc.waitForProcessToFinish(60000); // Up to 60 seconds
    return outputWav.existsAsFile();
}

juce::String VideoReader::getFrameAtTime(double timeSeconds, int outputWidth, int outputHeight)
{
    if (!fileOpen || info.filePath.isEmpty())
        return {};

    if (!ffmpegExe.existsAsFile() && ffmpegExe.getFullPathName() != "ffmpeg")
        return {};

    // Extract a single frame as JPEG to a temp file
    juce::File tempFile = juce::File::getSpecialLocation(juce::File::tempDirectory)
                              .getChildFile("s13_frame_" + juce::String(juce::Random::getSystemRandom().nextInt()) + ".jpg");

    juce::String timeStr = juce::String(timeSeconds, 3);
    juce::String scaleFilter = "scale=" + juce::String(outputWidth) + ":" + juce::String(outputHeight);

    juce::String cmd = "\"" + ffmpegExe.getFullPathName() + "\" -ss " + timeStr +
                       " -i \"" + info.filePath + "\" -vf \"" + scaleFilter +
                       "\" -frames:v 1 -q:v 2 -y \"" + tempFile.getFullPathName() + "\"";

    juce::ChildProcess proc;
    if (!proc.start(cmd))
        return {};

    proc.waitForProcessToFinish(5000);

    if (!tempFile.existsAsFile())
        return {};

    // Read the JPEG and convert to base64
    juce::MemoryBlock data;
    tempFile.loadFileAsData(data);
    tempFile.deleteFile();

    if (data.getSize() == 0)
        return {};

    return "data:image/jpeg;base64," + juce::Base64::toBase64(data.getData(), data.getSize());
}
