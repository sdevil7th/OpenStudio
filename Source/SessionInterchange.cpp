#include "SessionInterchange.h"

SessionInterchange::SessionInterchange() = default;
SessionInterchange::~SessionInterchange() = default;

// ═════════════════════════════════════════════════════════════════════
// AAF Import (stub — requires libaaf for full support)
// ═════════════════════════════════════════════════════════════════════

SessionData SessionInterchange::importAAF(const juce::File& aafFile)
{
    SessionData result;

    if (!aafFile.existsAsFile())
    {
        result.error = "AAF file not found: " + aafFile.getFullPathName();
        return result;
    }

    // Log the attempt
    DBG("SessionInterchange::importAAF — Attempted to import: " + aafFile.getFullPathName());

    // Check the file extension
    if (aafFile.getFileExtension().toLowerCase() != ".aaf")
    {
        result.error = "File does not have .aaf extension: " + aafFile.getFileName();
        return result;
    }

    // Check file size — AAF files are structured binary (Microsoft COM/OLE2)
    auto fileSize = aafFile.getSize();
    if (fileSize < 512)
    {
        result.error = "File is too small to be a valid AAF file (" +
                       juce::String(fileSize) + " bytes)";
        return result;
    }

    // Read the first few bytes to check for OLE2 magic number (D0 CF 11 E0)
    juce::FileInputStream stream(aafFile);
    if (!stream.openedOk())
    {
        result.error = "Cannot open AAF file for reading";
        return result;
    }

    uint8_t magic[4] = {};
    stream.read(magic, 4);

    bool isOLE2 = (magic[0] == 0xD0 && magic[1] == 0xCF &&
                   magic[2] == 0x11 && magic[3] == 0xE0);

    if (!isOLE2)
    {
        result.error = "File does not appear to be a valid AAF/OLE2 file. "
                       "AAF import requires the libaaf library which is not currently integrated. "
                       "Consider exporting from your source DAW as RPP (REAPER) or EDL format instead.";
        return result;
    }

    // The file looks like a valid OLE2/AAF container, but we cannot parse it
    result.error = "AAF format detected but full parsing is not supported. "
                   "AAF import requires the libaaf library which is complex to integrate. "
                   "Workaround: open this session in REAPER, save as .rpp, then import the RPP file. "
                   "File: " + aafFile.getFileName() +
                   " (" + juce::String(fileSize / 1024) + " KB)";

    DBG("SessionInterchange::importAAF — " + result.error);
    return result;
}

// ═════════════════════════════════════════════════════════════════════
// RPP Import
// ═════════════════════════════════════════════════════════════════════

SessionData SessionInterchange::importRPP(const juce::File& rppFile)
{
    SessionData result;

    if (!rppFile.existsAsFile())
    {
        result.error = "RPP file not found: " + rppFile.getFullPathName();
        return result;
    }

    auto content = rppFile.loadFileAsString();
    if (content.isEmpty())
    {
        result.error = "RPP file is empty";
        return result;
    }

    // RPP files start with <REAPER_PROJECT
    if (!content.trimStart().startsWith("<REAPER_PROJECT"))
    {
        result.error = "File does not appear to be a valid REAPER project (missing <REAPER_PROJECT header)";
        return result;
    }

    // Split into lines for parsing
    juce::StringArray lines;
    lines.addTokens(content, "\n", "");

    // Remove carriage returns (Windows line endings)
    for (int i = 0; i < lines.size(); ++i)
        lines.set(i, lines[i].trimEnd());

    // Parse top-level project properties
    for (int i = 0; i < lines.size(); ++i)
    {
        auto line = lines[i].trim();

        // TEMPO <bpm> <num> <denom>
        if (line.startsWith("TEMPO "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
                result.tempo = tokens[1].getDoubleValue();
        }
        // SAMPLERATE <rate> <ignored> <ignored>
        else if (line.startsWith("SAMPLERATE "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
                result.sampleRate = tokens[1].getDoubleValue();
        }
        // Track blocks
        else if (line.startsWith("<TRACK"))
        {
            auto track = parseRPPTrack(lines, i);
            result.tracks.push_back(std::move(track));
        }
    }

    DBG("SessionInterchange::importRPP — Imported " + juce::String((int)result.tracks.size()) +
        " tracks from " + rppFile.getFileName());

    return result;
}

SessionTrack SessionInterchange::parseRPPTrack(const juce::StringArray& lines, int& index)
{
    SessionTrack track;
    int depth = 1;  // We've already seen the opening <TRACK

    ++index;  // Move past <TRACK line

    while (index < lines.size() && depth > 0)
    {
        auto line = lines[index].trim();

        if (line.startsWith(">") || line == ">")
        {
            --depth;
            if (depth == 0) break;
        }

        if (line.startsWith("<"))
        {
            // Nested block
            if (line.startsWith("<ITEM"))
            {
                auto clip = parseRPPItem(lines, index);
                track.clips.push_back(std::move(clip));
                continue;  // parseRPPItem advances index to the closing >
            }
            else
            {
                // Skip other nested blocks we don't care about
                ++depth;
            }
        }
        // NAME "track name" or NAME track_name
        else if (line.startsWith("NAME "))
        {
            track.name = line.fromFirstOccurrenceOf("NAME ", false, false)
                             .unquoted();
        }
        // VOLPAN <volume_linear> <pan> <ignored...>
        else if (line.startsWith("VOLPAN "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
            {
                float volLinear = tokens[1].getFloatValue();
                // Convert linear volume to dB
                if (volLinear > 0.0f)
                    track.volumeDB = 20.0f * std::log10(volLinear);
                else
                    track.volumeDB = -144.0f;
            }
            if (tokens.size() >= 3)
                track.pan = tokens[2].getFloatValue();
        }
        // MUTESOLO <mute_flags> <solo_flags> <ignored>
        else if (line.startsWith("MUTESOLO "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
                track.muted = (tokens[1].getIntValue() != 0);
            if (tokens.size() >= 3)
                track.soloed = (tokens[2].getIntValue() != 0);
        }

        ++index;
    }

    return track;
}

SessionClip SessionInterchange::parseRPPItem(const juce::StringArray& lines, int& index)
{
    SessionClip clip;
    int depth = 1;  // We've already seen the opening <ITEM

    ++index;  // Move past <ITEM line

    while (index < lines.size() && depth > 0)
    {
        auto line = lines[index].trim();

        if (line.startsWith(">") || line == ">")
        {
            --depth;
            if (depth == 0) break;
        }

        if (line.startsWith("<"))
        {
            if (line.startsWith("<SOURCE"))
            {
                clip.filePath = parseRPPSource(lines, index);
                continue;  // parseRPPSource advances index
            }
            else
            {
                ++depth;
            }
        }
        // POSITION <seconds>
        else if (line.startsWith("POSITION "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
                clip.position = tokens[1].getDoubleValue();
        }
        // LENGTH <seconds>
        else if (line.startsWith("LENGTH "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
                clip.length = tokens[1].getDoubleValue();
        }
        // SOFFS <seconds> (source offset)
        else if (line.startsWith("SOFFS "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
                clip.offset = tokens[1].getDoubleValue();
        }
        // VOLPAN <volume_linear> <pan> (item level)
        else if (line.startsWith("VOLPAN "))
        {
            auto tokens = juce::StringArray::fromTokens(line, " ", "");
            if (tokens.size() >= 2)
            {
                float volLinear = tokens[1].getFloatValue();
                if (volLinear > 0.0f)
                    clip.volumeDB = 20.0f * std::log10(volLinear);
                else
                    clip.volumeDB = -144.0f;
            }
        }

        ++index;
    }

    return clip;
}

juce::String SessionInterchange::parseRPPSource(const juce::StringArray& lines, int& index)
{
    juce::String filePath;
    int depth = 1;

    ++index;  // Move past <SOURCE line

    while (index < lines.size() && depth > 0)
    {
        auto line = lines[index].trim();

        if (line.startsWith(">") || line == ">")
        {
            --depth;
            if (depth == 0) break;
        }

        if (line.startsWith("<"))
        {
            ++depth;
        }
        // FILE "path/to/audio.wav" <ignored>
        else if (line.startsWith("FILE "))
        {
            filePath = line.fromFirstOccurrenceOf("FILE ", false, false);
            // Remove any trailing parameters after the path
            // Path may be quoted
            if (filePath.startsWithChar('"'))
            {
                filePath = filePath.fromFirstOccurrenceOf("\"", false, false)
                                   .upToFirstOccurrenceOf("\"", false, false);
            }
            else
            {
                // Unquoted — take the first token
                filePath = filePath.upToFirstOccurrenceOf(" ", false, false);
            }
        }

        ++index;
    }

    return filePath;
}

// ═════════════════════════════════════════════════════════════════════
// RPP Export
// ═════════════════════════════════════════════════════════════════════

bool SessionInterchange::exportRPP(const juce::File& outputFile, const SessionData& session)
{
    lastError.clear();

    juce::String rpp;
    rpp << "<REAPER_PROJECT 0.1 \"7.0\" 1\n";

    // Project-level properties
    rpp << "  SAMPLERATE " << juce::String(session.sampleRate, 0) << " 0 0\n";
    rpp << "  TEMPO " << juce::String(session.tempo, 6) << " 4 4\n";

    // Write each track
    for (const auto& track : session.tracks)
    {
        rpp << "  <TRACK\n";

        // Track name
        rpp << "    NAME \"" << track.name.replace("\"", "'") << "\"\n";

        // Volume (convert dB to linear) and pan
        float volLinear = std::pow(10.0f, track.volumeDB / 20.0f);
        rpp << "    VOLPAN " << juce::String(volLinear, 8)
            << " " << juce::String(track.pan, 6)
            << " -1 -1 1\n";

        // Mute and solo
        int muteFlag = track.muted ? 1 : 0;
        int soloFlag = track.soloed ? 1 : 0;
        rpp << "    MUTESOLO " << muteFlag << " " << soloFlag << " 0\n";

        // Track FX chain placeholder (empty)
        rpp << "    IPHASE 0\n";
        rpp << "    ISBUS 0 0\n";
        rpp << "    BUSCOMP 0 0 0 0 0\n";
        rpp << "    SHOWINMIX 1 0.6667 0.5 1 0.5 0 0 0\n";
        rpp << "    REC 0 0 0 0 0 0 0 0\n";
        rpp << "    TRACKHEIGHT 0 0 0 0 0 0\n";

        // Write each clip as an ITEM
        for (const auto& clip : track.clips)
        {
            rpp << "    <ITEM\n";
            rpp << "      POSITION " << juce::String(clip.position, 10) << "\n";
            rpp << "      LENGTH " << juce::String(clip.length, 10) << "\n";

            if (clip.offset > 0.0)
                rpp << "      SOFFS " << juce::String(clip.offset, 10) << "\n";

            // Item volume
            float itemVol = std::pow(10.0f, clip.volumeDB / 20.0f);
            rpp << "      VOLPAN " << juce::String(itemVol, 8) << " 0 1 1\n";

            rpp << "      FADEIN 1 0 0 1 0 0 0\n";
            rpp << "      FADEOUT 1 0 0 1 0 0 0\n";
            rpp << "      MUTE 0 0\n";
            rpp << "      LOOP 0\n";
            rpp << "      PLAYRATE 1 1 0 -1 0 0.0025\n";
            rpp << "      CHANMODE 0\n";

            // Determine source type from file extension
            juce::File sourceFile(clip.filePath);
            juce::String ext = sourceFile.getFileExtension().toLowerCase();
            juce::String sourceType = "WAVE";
            if (ext == ".mp3")
                sourceType = "MP3";
            else if (ext == ".ogg")
                sourceType = "VORBIS";
            else if (ext == ".flac")
                sourceType = "FLAC";

            rpp << "      <SOURCE " << sourceType << "\n";
            rpp << "        FILE \"" << clip.filePath.replace("\"", "'") << "\"\n";
            rpp << "      >\n";

            rpp << "    >\n";  // Close ITEM
        }

        rpp << "  >\n";  // Close TRACK
    }

    rpp << ">\n";  // Close REAPER_PROJECT

    // Write to file
    if (!outputFile.getParentDirectory().exists())
        outputFile.getParentDirectory().createDirectory();

    if (!outputFile.replaceWithText(rpp))
    {
        lastError = "Failed to write RPP file: " + outputFile.getFullPathName();
        return false;
    }

    DBG("SessionInterchange::exportRPP — Exported " + juce::String((int)session.tracks.size()) +
        " tracks to " + outputFile.getFileName());

    return true;
}

// ═════════════════════════════════════════════════════════════════════
// EDL Export (CMX 3600)
// ═════════════════════════════════════════════════════════════════════

juce::String SessionInterchange::secondsToTimecode(double seconds, double fps)
{
    if (seconds < 0.0)
        seconds = 0.0;

    int totalFrames = (int)(seconds * fps);
    int framesPerSec = (int)fps;

    int ff = totalFrames % framesPerSec;
    int totalSecs = totalFrames / framesPerSec;
    int ss = totalSecs % 60;
    int totalMins = totalSecs / 60;
    int mm = totalMins % 60;
    int hh = totalMins / 60;

    return juce::String::formatted("%02d:%02d:%02d:%02d", hh, mm, ss, ff);
}

bool SessionInterchange::exportEDL(const juce::File& outputFile, const SessionData& session)
{
    lastError.clear();

    constexpr double fps = 30.0;

    juce::String edl;

    // EDL header
    edl << "TITLE: " << outputFile.getFileNameWithoutExtension() << "\n";
    edl << "FCM: NON-DROP FRAME\n";
    edl << "\n";

    int eventNumber = 1;

    for (const auto& track : session.tracks)
    {
        for (const auto& clip : track.clips)
        {
            // Derive reel name from filename (max 8 chars, uppercase, no spaces)
            juce::File sourceFile(clip.filePath);
            juce::String reelName = sourceFile.getFileNameWithoutExtension()
                                        .toUpperCase()
                                        .replaceCharacters(" .-_", "XXXX")
                                        .substring(0, 8);

            // Pad reel name to at least 3 chars
            while (reelName.length() < 3)
                reelName += "X";

            // Source timecodes (in/out within the source file)
            double srcIn = clip.offset;
            double srcOut = clip.offset + clip.length;

            // Record timecodes (in/out on the timeline)
            double recIn = clip.position;
            double recOut = clip.position + clip.length;

            // Format: EVENT# REEL CHANNEL EDIT_TYPE SOURCE_IN SOURCE_OUT RECORD_IN RECORD_OUT
            // Channel: AA = audio both channels, V = video
            edl << juce::String::formatted("%03d", eventNumber) << "  ";
            edl << reelName.paddedRight(' ', 8) << " ";
            edl << "AA    ";  // Audio, both channels
            edl << "C        ";  // Cut edit
            edl << secondsToTimecode(srcIn, fps) << " ";
            edl << secondsToTimecode(srcOut, fps) << " ";
            edl << secondsToTimecode(recIn, fps) << " ";
            edl << secondsToTimecode(recOut, fps) << "\n";

            // Optional: add source file name as a comment
            edl << "* FROM CLIP NAME: " << sourceFile.getFileName() << "\n";

            // Optional: add track name as a comment
            if (track.name.isNotEmpty())
                edl << "* TRACK: " << track.name << "\n";

            edl << "\n";
            ++eventNumber;
        }
    }

    // Write to file
    if (!outputFile.getParentDirectory().exists())
        outputFile.getParentDirectory().createDirectory();

    if (!outputFile.replaceWithText(edl))
    {
        lastError = "Failed to write EDL file: " + outputFile.getFullPathName();
        return false;
    }

    DBG("SessionInterchange::exportEDL — Exported " + juce::String(eventNumber - 1) +
        " events to " + outputFile.getFileName());

    return true;
}
