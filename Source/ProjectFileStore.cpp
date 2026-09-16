#include "ProjectFileStore.h"
#include "JsonEnvelope.h"
#include "RecoveryJournal.h"
#include <mutex>
#include <set>

namespace
{
std::mutex publicationMutex; // Never acquired by an audio callback.
constexpr juce::int64 maximumProjectBytes = 256 * 1024 * 1024;
std::mutex recoveryMutex;
std::set<juce::String> liveSessions;

bool validRecoveryId(const juce::String& id)
{
    return id.length() == 32 && id.containsOnly("0123456789abcdef");
}

juce::Result checkedReplaceBytes(const juce::File& target, const void* bytes, size_t size)
{
    juce::TemporaryFile temporary(target, juce::TemporaryFile::useHiddenFile);
    auto stream = temporary.getFile().createOutputStream();
    if (!stream) return juce::Result::fail("Cannot create temporary project file.");
    // File::replaceWithText ignores appendText's return value in our JUCE pin.
    // Check the write AND flush before publishing, especially on a full disk.
    const bool written = stream->write(bytes, size);
    stream->flush();
    const auto status = stream->getStatus();
    stream.reset();
    if (!written || status.failed()
        || temporary.getFile().getSize() != static_cast<juce::int64>(size))
        return juce::Result::fail("Project write/flush failed; the previous file was retained.");
    if (!temporary.overwriteTargetFileWithTemporary())
        return juce::Result::fail("Project replacement failed; check the destination and recovery files.");
    return juce::Result::ok();
}

juce::Result checkedReplace(const juce::File& target, const juce::String& text)
{
    return checkedReplaceBytes(target, text.toRawUTF8(), text.getNumBytesAsUTF8());
}

juce::File nextRecovery(const juce::File& target, int maxVersions)
{
    const auto files = ProjectFileStore::recoveryFiles(target, maxVersions);
    auto oldest = files.getFirst();
    for (const auto& file : files)
    {
        if (!file.exists()) return file;
        if (file.getLastModificationTime() < oldest.getLastModificationTime()) oldest = file;
    }
    return oldest;
}
}

namespace ProjectFileStore
{
juce::File RecoverySession::defaultRoot()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio/Recovery");
}

RecoverySession::RecoverySession(const juce::File& rootDirectory)
    : root(rootDirectory), sessionLock("OpenStudio-Recovery-" + sessionId)
{
    lockHeld = sessionLock.enter(0);
    const std::lock_guard<std::mutex> guard(recoveryMutex);
    if (lockHeld) liveSessions.insert(sessionId);
}

RecoverySession::~RecoverySession()
{
    const std::lock_guard<std::mutex> guard(recoveryMutex);
    liveSessions.erase(sessionId);
    if (lockHeld) sessionLock.exit();
}

juce::Result RecoverySession::write(const juce::String& documentId, const juce::String& sourcePath,
                                   const juce::String& json, int maxVersions)
{
    if (!lockHeld || !validRecoveryId(documentId)) return juce::Result::fail("Invalid recovery session identity.");
    if (!hasBoundedJsonEnvelope(json, static_cast<size_t>(maximumProjectBytes)))
        return juce::Result::fail("Recovery document exceeds the size limit.");
    auto document = juce::JSON::parse(json);
    if (!document.isObject() || !document.getProperty("tracks", {}).isArray())
        return juce::Result::fail("Invalid recovery document.");
    auto metadata = std::make_unique<juce::DynamicObject>();
    metadata->setProperty("sourcePath", sourcePath);
    metadata->setProperty("savedAt", juce::Time::currentTimeMillis());
    document.getDynamicObject()->setProperty("_openStudioRecovery", juce::var(metadata.release()));
    const auto directory = root.getChildFile(sessionId).getChildFile(documentId);
    const auto made = directory.createDirectory();
    if (made.failed()) return made;
    const auto result = save(directory.getChildFile("snapshot.osproj"), juce::JSON::toString(document), true, maxVersions);
    if (result.wasOk()) {
        // A later edit after an explicit Save starts a fresh pending recovery.
        const auto marker = directory.getChildFile("dismissed");
        if (marker.exists() && !marker.deleteFile())
            return juce::Result::fail("Recovery written but its pending marker could not be updated.");
    }
    return result;
}

juce::var RecoverySession::discover() const
{
    juce::Array<juce::var> candidates;
    for (const auto& session : root.findChildFiles(juce::File::findDirectories, false))
    {
        const auto id = session.getFileName();
        if (!validRecoveryId(id) || session.getChildFile("clean").exists()) continue;
        {
            const std::lock_guard<std::mutex> guard(recoveryMutex);
            if (liveSessions.count(id) != 0) continue;
        }
        juce::InterProcessLock probe("OpenStudio-Recovery-" + id);
        if (!probe.enter(0)) continue;
        for (const auto& document : session.findChildFiles(juce::File::findDirectories, false))
        {
            if (!validRecoveryId(document.getFileName()) || document.getChildFile("dismissed").exists()) continue;
            juce::File latest;
            juce::var latestData;
            for (const auto& file : recoveryFiles(document.getChildFile("snapshot.osproj"), 20))
            {
                if (!file.existsAsFile() || file.getSize() > maximumProjectBytes) continue;
                const auto json = file.loadFileAsString();
                if (!hasBoundedJsonEnvelope(json)) continue;
                const auto data = juce::JSON::parse(json);
                if (!data.isObject() || !data.getProperty("tracks", {}).isArray()
                    || !data.getProperty("_openStudioRecovery", {}).isObject()) continue;
                if (latest == juce::File() || file.getLastModificationTime() >= latest.getLastModificationTime())
                { latest = file; latestData = data; }
            }
            if (latest == juce::File()) continue;
            const auto meta = latestData.getProperty("_openStudioRecovery", {});
            auto item = std::make_unique<juce::DynamicObject>();
            item->setProperty("id", id + "/" + document.getFileName());
            item->setProperty("path", latest.getFullPathName());
            item->setProperty("projectName", latestData.getProperty("projectName", "Untitled Project"));
            item->setProperty("sourcePath", meta.getProperty("sourcePath", ""));
            item->setProperty("savedAt", meta.getProperty("savedAt", juce::int64(0)));
            candidates.add(juce::var(item.release()));
        }
        probe.exit();
    }
    return candidates;
}

juce::Result RecoverySession::dismiss(const juce::String& candidateId)
{
    const auto parts = juce::StringArray::fromTokens(candidateId, "/", "");
    if (parts.size() != 2 || !validRecoveryId(parts[0]) || !validRecoveryId(parts[1]))
        return juce::Result::fail("Invalid recovery candidate.");
    if (parts[0] != sessionId) {
        // Only previously discovered, inactive candidates may be dismissed.
        bool found = false;
        const auto entries = discover();
        if (const auto* list = entries.getArray())
            for (const auto& entry : *list) found = found || entry.getProperty("id", "").toString() == candidateId;
        if (!found) return juce::Result::fail("Recovery is unavailable or belongs to a live session.");
    }
    const auto directory = root.getChildFile(parts[0]).getChildFile(parts[1]);
    if (!directory.isDirectory()) return juce::Result::ok();
    const std::lock_guard<std::mutex> guard(publicationMutex);
    return checkedReplace(directory.getChildFile("dismissed"), "Acknowledged; snapshot files retained.\n");
}

juce::Result RecoverySession::retireDocument(const juce::String& documentId)
{
    return dismiss(sessionId + "/" + documentId);
}

juce::Result RecoverySession::markClean()
{
    const auto directory = root.getChildFile(sessionId);
    if (!directory.isDirectory()) return juce::Result::ok();
    const std::lock_guard<std::mutex> guard(publicationMutex);
    return checkedReplace(directory.getChildFile("clean"), "Normal shutdown; snapshot files retained.\n");
}

juce::Array<juce::File> recoveryFiles(const juce::File& target, int maxVersions)
{
    juce::Array<juce::File> files;
    for (int index = 1; index <= juce::jlimit(1, 20, maxVersions); ++index)
        files.add(target.getSiblingFile(target.getFileName() + ".recovery-" + juce::String(index) + ".osproj"));
    return files;
}

juce::Result save(const juce::File& target, const juce::String& json, bool recoveryOnly, int maxVersions,
                  const juce::File& workRecoveryRoot)
{
    const std::lock_guard<std::mutex> guard(publicationMutex);
    if (!hasBoundedJsonEnvelope(json, static_cast<size_t>(maximumProjectBytes)))
        return juce::Result::fail("Project exceeds the safe file-size limit.");
    const auto document = juce::JSON::parse(json);
    if (!document.isObject() || !document.getProperty("tracks", {}).isArray())
        return juce::Result::fail("Invalid project document; no file was replaced.");
    if (!target.getParentDirectory().isDirectory() || target.isDirectory())
        return juce::Result::fail("Project destination is not a writable file location.");
    if (recoveryOnly) return checkedReplace(nextRecovery(target, maxVersions), json);
    if (target.existsAsFile())
    {
        if (target.getSize() > maximumProjectBytes)
            return juce::Result::fail("Existing project exceeds the safe backup-size limit.");
        juce::MemoryBlock previous;
        if (!target.loadFileAsData(previous))
            return juce::Result::fail("Cannot read the existing project for recovery.");
        const auto backup = checkedReplaceBytes(nextRecovery(target, maxVersions), previous.getData(), previous.getSize());
        if (backup.failed()) return backup;
    }
    const auto result = checkedReplace(target, json);
    if (result.wasOk())
        RecoveryJournal::acknowledgeSavedProject(document, workRecoveryRoot == juce::File()
            ? RecoveryJournal::defaultRoot() : workRecoveryRoot);
    return result;
}
}
