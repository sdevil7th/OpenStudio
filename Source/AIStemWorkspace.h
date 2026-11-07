#pragma once
#include <JuceHeader.h>
#include <algorithm>

// Called only after the owned worker tree has retired. Never trust a worker's
// reported path as permission to delete: derive names from the parent's nonce.
namespace AIStemWorkspace
{
inline bool cleanup(const juce::File& output, const juce::String& job, unsigned long pid, bool discardResult)
{
    if (job.length() != 32 || ! job.containsOnly("0123456789abcdef") || pid == 0) return false;
    bool success = true;
    for (const auto& directory : output.findChildFiles(juce::File::findDirectories, false))
    {
        const auto name = directory.getFileName();
        const bool scratch = name.startsWith(".openstudio-stem-" + job + "-");
        const bool result = discardResult && name == "stems-" + job;
        if (! scratch && ! result) continue;
        if (directory.isSymbolicLink() || directory.getParentDirectory() != output) { success = false; continue; }
        const auto marker = directory.getChildFile(".openstudio-owner.json");
        if (marker.isSymbolicLink() || marker.getSize() > 2048) { success = false; continue; }
        const auto owner = juce::JSON::parse(marker);
        if (owner.getProperty("kind", "").toString() != "openstudio-stem-workspace-v1"
            || owner.getProperty("job", "").toString() != job
            || static_cast<juce::int64>(owner.getProperty("pid", 0)) != static_cast<juce::int64>(pid))
        { success = false; continue; }
        int entries = 0;
        juce::Array<juce::File> files, folders;
        bool safe = true;
        for (const auto& entry : juce::RangedDirectoryIterator(directory, true, "*", juce::File::findFilesAndDirectories,
                                                               juce::File::FollowSymlinks::no))
        {
            if (++entries > 512 || entry.getFile().isSymbolicLink() || ! entry.getFile().isAChildOf(directory))
            { safe = false; break; }
            if (entry.getFile().isDirectory()) folders.add(entry.getFile());
            else if (entry.getFile() != marker) files.add(entry.getFile());
        }
        if (! safe) { success = false; continue; }
        bool removed = true;
        for (const auto& file : files) if (! file.deleteFile()) removed = false;
        // Keep the root ownership proof until all data and nested directories
        // are gone. A transient file lock must not make a retry unauthorised.
        std::sort(folders.begin(), folders.end(), [] (const auto& first, const auto& second)
        { return first.getFullPathName().length() > second.getFullPathName().length(); });
        for (const auto& folder : folders) if (! folder.deleteFile()) removed = false;
        if (! removed) { success = false; continue; }
        if (! marker.deleteFile() || ! directory.deleteFile())
        {
            if (directory.isDirectory()) marker.replaceWithText(juce::JSON::toString(owner));
            success = false;
        }
    }
    return success;
}
}
