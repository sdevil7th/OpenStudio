#include "DDPExporter.h"

DDPExporter::DDPExporter() = default;
DDPExporter::~DDPExporter() = default;

DDPExporter::MSF DDPExporter::framesToMSF(int totalFrames)
{
    MSF msf;
    msf.minutes = totalFrames / (75 * 60);
    msf.seconds = (totalFrames / 75) % 60;
    msf.frames = totalFrames % 75;
    return msf;
}

uint8_t DDPExporter::toBCD(int value)
{
    return (uint8_t)(((value / 10) << 4) | (value % 10));
}

bool DDPExporter::exportDDP(const juce::File& sourceWav,
                             const juce::File& outputDir,
                             const std::vector<CDTrack>& tracks,
                             const juce::String& catalogNumber)
{
    lastError.clear();

    if (!sourceWav.existsAsFile())
    {
        lastError = "Source WAV file not found";
        return false;
    }

    if (tracks.empty())
    {
        lastError = "No CD tracks specified";
        return false;
    }

    // Verify source is 44.1kHz 16-bit stereo
    juce::AudioFormatManager fmgr;
    fmgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(sourceWav));
    if (!reader)
    {
        lastError = "Cannot read source WAV file";
        return false;
    }

    if (std::abs(reader->sampleRate - 44100.0) > 1.0)
    {
        lastError = "Source must be 44100 Hz (Red Book). Current: " +
                    juce::String(reader->sampleRate, 0) + " Hz";
        return false;
    }
    if (reader->bitsPerSample != 16)
    {
        lastError = "Source must be 16-bit (Red Book). Current: " +
                    juce::String(reader->bitsPerSample) + "-bit";
        return false;
    }

    double sampleRate = reader->sampleRate;
    juce::int64 totalSamples = reader->lengthInSamples;
    reader.reset();

    // Create output directory
    outputDir.createDirectory();

    // Write IMAGE.DAT first (raw PCM)
    juce::int64 imageLength = 0;
    if (!writeImageData(outputDir, sourceWav, imageLength))
        return false;

    // Write DDPID
    if (!writeDDPID(outputDir))
        return false;

    // Write DDPMS
    if (!writeDDPMS(outputDir, imageLength, tracks, sampleRate))
        return false;

    // Write SUBCODE.DAT
    if (!writeSubcode(outputDir, tracks, totalSamples, sampleRate, catalogNumber))
        return false;

    juce::Logger::writeToLog("DDP Export: Successfully wrote to " + outputDir.getFullPathName());
    return true;
}

bool DDPExporter::writeDDPID(const juce::File& outputDir)
{
    juce::File ddpid = outputDir.getChildFile("DDPID");
    juce::FileOutputStream out(ddpid);
    if (out.failedToOpen())
    {
        lastError = "Cannot create DDPID file";
        return false;
    }

    // DDP 2.0 ID: 128 bytes
    // Format: "DDP" + version + identifier
    char buf[128];
    std::memset(buf, 0, 128);

    // DDP identifier header
    std::memcpy(buf, "DDP", 3);
    buf[3] = '2';  // Version major
    buf[4] = '.';
    buf[5] = '0';  // Version minor
    buf[6] = '0';

    // Application ID
    const char* appId = "OpenStudio DDP Export";
    std::memcpy(buf + 16, appId, std::min(strlen(appId), (size_t)48));

    out.write(buf, 128);
    return true;
}

bool DDPExporter::writeDDPMS(const juce::File& outputDir, juce::int64 imageLength,
                              const std::vector<CDTrack>& tracks, double sampleRate)
{
    juce::ignoreUnused(sampleRate);
    juce::File ddpms = outputDir.getChildFile("DDPMS");
    juce::FileOutputStream out(ddpms);
    if (out.failedToOpen())
    {
        lastError = "Cannot create DDPMS file";
        return false;
    }

    // DDP Map Stream: describes data streams in the image
    // Each entry: 128 bytes
    // We write one entry for the main audio data stream

    char entry[128];
    std::memset(entry, 0, 128);

    // Stream type: 0x01 = main data
    entry[0] = 0x01;

    // Data type: "CDDA" (CD Digital Audio)
    std::memcpy(entry + 4, "CDDA", 4);

    // File name: IMAGE.DAT
    std::memcpy(entry + 16, "IMAGE.DAT", 9);

    // Data length in bytes (big endian, 8 bytes at offset 64)
    for (int i = 7; i >= 0; --i)
    {
        entry[64 + (7 - i)] = (char)((imageLength >> (i * 8)) & 0xFF);
    }

    // Number of tracks
    entry[80] = (char)tracks.size();

    out.write(entry, 128);

    // Write a subcode map entry
    std::memset(entry, 0, 128);
    entry[0] = 0x02; // Subcode stream
    std::memcpy(entry + 4, "SUBC", 4);
    std::memcpy(entry + 16, "SUBCODE.DAT", 11);
    out.write(entry, 128);

    return true;
}

bool DDPExporter::writeImageData(const juce::File& outputDir, const juce::File& sourceWav,
                                  juce::int64& outLength)
{
    juce::File imageFile = outputDir.getChildFile("IMAGE.DAT");

    juce::AudioFormatManager fmgr;
    fmgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(sourceWav));
    if (!reader)
    {
        lastError = "Cannot read source WAV for IMAGE.DAT";
        return false;
    }

    juce::FileOutputStream out(imageFile);
    if (out.failedToOpen())
    {
        lastError = "Cannot create IMAGE.DAT";
        return false;
    }

    // Write raw 16-bit PCM interleaved (little-endian, CD standard)
    const int blockSize = 8192;
    juce::AudioBuffer<float> buffer(2, blockSize);
    juce::int64 totalSamples = reader->lengthInSamples;
    int numChannels = juce::jmin((int)reader->numChannels, 2);

    outLength = 0;

    for (juce::int64 pos = 0; pos < totalSamples; pos += blockSize)
    {
        int samplesToRead = (int)std::min((juce::int64)blockSize, totalSamples - pos);
        buffer.clear();
        reader->read(&buffer, 0, samplesToRead, pos, true, numChannels > 1);

        // Write interleaved 16-bit samples
        for (int i = 0; i < samplesToRead; ++i)
        {
            for (int ch = 0; ch < 2; ++ch)
            {
                float sample = (ch < numChannels) ? buffer.getSample(ch, i) : buffer.getSample(0, i);
                int16_t pcm = (int16_t)juce::jlimit(-32768, 32767, (int)(sample * 32767.0f));
                out.writeShort(pcm);
                outLength += 2;
            }
        }
    }

    return true;
}

bool DDPExporter::writeSubcode(const juce::File& outputDir, const std::vector<CDTrack>& tracks,
                                juce::int64 totalSamples, double sampleRate,
                                const juce::String& catalogNumber)
{
    juce::ignoreUnused(catalogNumber, sampleRate);

    juce::File subcodeFile = outputDir.getChildFile("SUBCODE.DAT");
    juce::FileOutputStream out(subcodeFile);
    if (out.failedToOpen())
    {
        lastError = "Cannot create SUBCODE.DAT";
        return false;
    }

    // CD subcode: 96 bytes per frame (98 channel bits × 8 channels / 8)
    // We only populate P and Q channels (the main two)
    // 1 CD frame = 588 samples at 44100 Hz (1/75 second)

    int totalCDFrames = (int)(totalSamples / 588);

    for (int frame = 0; frame < totalCDFrames; ++frame)
    {
        uint8_t subcode[96];
        std::memset(subcode, 0, 96);

        double frameTime = frame / 75.0;

        // Find which track this frame belongs to
        int trackNum = 0;
        bool inPause = false;
        for (int t = 0; t < (int)tracks.size(); ++t)
        {
            if (frameTime >= tracks[t].startTime && frameTime < tracks[t].endTime)
            {
                trackNum = t + 1;
                break;
            }
            // Check for gap/pause between tracks
            if (t > 0 && frameTime >= tracks[t - 1].endTime && frameTime < tracks[t].startTime)
            {
                trackNum = t + 1;
                inPause = true;
                break;
            }
        }

        if (trackNum == 0 && !tracks.empty())
            trackNum = (int)tracks.size(); // Default to last track

        // P channel: 0 during audio, 1 during pause/lead-in/lead-out
        subcode[0] = inPause ? 0xFF : 0x00;

        // Q channel (bytes 1-11): Mode 1 (position data)
        // Byte 1: Control/ADR (0x01 = audio, no pre-emphasis, mode 1)
        subcode[1] = 0x01;

        // Byte 2: Track number (BCD)
        subcode[2] = toBCD(trackNum);

        // Byte 3: Index (01 for main, 00 for pause)
        subcode[3] = inPause ? 0x00 : 0x01;

        // Bytes 4-6: Track-relative MSF
        double trackStartTime = (trackNum > 0 && trackNum <= (int)tracks.size())
            ? tracks[trackNum - 1].startTime : 0.0;
        int relativeFrame = secondsToCDFrames(frameTime - trackStartTime);
        MSF relMSF = framesToMSF(std::max(0, relativeFrame));
        subcode[4] = toBCD(relMSF.minutes);
        subcode[5] = toBCD(relMSF.seconds);
        subcode[6] = toBCD(relMSF.frames);

        // Byte 7: zero (separator)
        subcode[7] = 0x00;

        // Bytes 8-10: Absolute MSF
        MSF absMSF = framesToMSF(frame);
        subcode[8] = toBCD(absMSF.minutes);
        subcode[9] = toBCD(absMSF.seconds);
        subcode[10] = toBCD(absMSF.frames);

        // Byte 11: CRC (simplified — write 0 for now; professional tools recalculate)
        subcode[11] = 0x00;

        out.write(subcode, 96);
    }

    return true;
}
