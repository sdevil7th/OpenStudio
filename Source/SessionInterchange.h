#pragma once

#include <JuceHeader.h>
#include <vector>

/**
 * SessionInterchange — Import/export DAW sessions in multiple formats.
 *
 * Supported formats:
 *   - RPP (REAPER Project) — full import and export of tracks, clips, volume, pan, mute, solo
 *   - AAF (Advanced Authoring Format) — stub import (returns error; full AAF requires libaaf)
 *   - EDL (CMX 3600 Edit Decision List) — export only, simple text format for Pro Tools interop
 *
 * Usage:
 *   SessionInterchange interchange;
 *   auto session = interchange.importRPP(rppFile);
 *   if (session.error.isEmpty()) { ... use session.tracks ... }
 *
 *   interchange.exportRPP(outputFile, session);
 *   interchange.exportEDL(outputFile, session);
 */

/** A single clip (audio item) within a track. */
struct SessionClip
{
    juce::String filePath;       // Absolute or relative path to source audio file
    double position = 0.0;       // Position on timeline in seconds
    double length = 0.0;         // Duration in seconds
    double offset = 0.0;         // Offset into the source audio file in seconds
    float volumeDB = 0.0f;       // Clip volume in dB
};

/** A track containing clips and mix properties. */
struct SessionTrack
{
    juce::String name;
    float volumeDB = 0.0f;
    float pan = 0.0f;            // -1.0 (left) to +1.0 (right)
    bool muted = false;
    bool soloed = false;
    std::vector<SessionClip> clips;
};

/** Complete session data — the result of an import or input to an export. */
struct SessionData
{
    double sampleRate = 44100.0;
    double tempo = 120.0;
    std::vector<SessionTrack> tracks;
    juce::String error;          // Non-empty if import failed
};

class SessionInterchange
{
public:
    SessionInterchange();
    ~SessionInterchange();

    // ── Import ──────────────────────────────────────────────────────

    /**
     * Import a REAPER project (.rpp) file.
     * Parses tracks, clips, volume, pan, mute, solo, tempo, and sample rate.
     * Returns SessionData with error set on failure.
     */
    SessionData importRPP(const juce::File& rppFile);

    /**
     * Import an AAF file.
     * This is a stub — full AAF parsing requires libaaf which is not integrated.
     * Always returns SessionData with a descriptive error string.
     */
    SessionData importAAF(const juce::File& aafFile);

    // ── Export ──────────────────────────────────────────────────────

    /**
     * Export session as a REAPER project (.rpp) file.
     * Writes a valid RPP with tracks, audio items, volume, pan, mute, solo.
     * Returns true on success.
     */
    bool exportRPP(const juce::File& outputFile, const SessionData& session);

    /**
     * Export session as a CMX 3600 Edit Decision List (.edl).
     * Simple text format compatible with Pro Tools and other DAWs.
     * Returns true on success.
     */
    bool exportEDL(const juce::File& outputFile, const SessionData& session);

    /** Returns the last error message from an export operation. */
    juce::String getLastError() const { return lastError; }

private:
    juce::String lastError;

    // ── RPP parsing helpers ─────────────────────────────────────────

    /** Parse a single <TRACK ...> block from RPP text. */
    SessionTrack parseRPPTrack(const juce::StringArray& lines, int& index);

    /** Parse a single <ITEM ...> block from RPP text. */
    SessionClip parseRPPItem(const juce::StringArray& lines, int& index);

    /** Parse a <SOURCE ...> block and return the file path. */
    juce::String parseRPPSource(const juce::StringArray& lines, int& index);

    // ── EDL helpers ─────────────────────────────────────────────────

    /** Convert seconds to SMPTE timecode string (HH:MM:SS:FF at 30fps). */
    static juce::String secondsToTimecode(double seconds, double fps = 30.0);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SessionInterchange)
};
