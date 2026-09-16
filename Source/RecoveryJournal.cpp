#include "RecoveryJournal.h"
#include "JsonEnvelope.h"
#include <mutex>
#include <set>

namespace
{
// Read/merge/publish is one transaction. Native AI terminal publication and a
// frontend acknowledgement can otherwise overwrite each other's fields.
std::recursive_mutex journalMutex;
std::set<juce::String> liveJournals;
bool validId(const juce::String& id) { return id.length() == 32 && id.containsOnly("0123456789abcdef"); }
juce::StringArray parts(const juce::String& id)
{
    const auto values = juce::StringArray::fromTokens(id, "/", "");
    return values.size() == 2 && validId(values[0]) && validId(values[1]) ? values : juce::StringArray();
}
juce::var read(const juce::File& file)
{
    if (!file.existsAsFile() || file.getSize() > 2 * 1024 * 1024 || file.isSymbolicLink()) return {};
    const auto text = file.loadFileAsString();
    if (!hasBoundedJsonEnvelope(text, 2 * 1024 * 1024)) return {};
    const auto value = juce::JSON::parse(text);
    const auto kind = value.getProperty("kind", "").toString();
    return value.isObject() && static_cast<int>(value.getProperty("version", 0)) == 1
        && (kind == "recording" || kind == "ai") ? value : juce::var();
}
}

juce::File RecoveryJournal::defaultRoot()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("OpenStudio/WorkRecovery");
}
RecoveryJournal::RecoveryJournal(const juce::File& directory) : root(directory), liveLock("OpenStudio-Work-" + sessionId)
{
    locked = liveLock.enter(0);
    const std::lock_guard<std::recursive_mutex> guard(journalMutex);
    if (locked) liveJournals.insert(sessionId);
}
RecoveryJournal::~RecoveryJournal()
{
    const std::lock_guard<std::recursive_mutex> guard(journalMutex);
    liveJournals.erase(sessionId);
    if (locked) liveLock.exit();
}
juce::File RecoveryJournal::entryFile(const juce::String& id) const
{
    const auto values = parts(id);
    return values.size() == 2 && values[0] == sessionId
        ? root.getChildFile(values[0]).getChildFile(values[1]).getChildFile("job.json") : juce::File();
}
bool RecoveryJournal::write(const juce::File& file, const juce::var& payload)
{
    if (file == juce::File() || !payload.isObject()) return false;
    const auto text = juce::JSON::toString(payload, true);
    if (!hasBoundedJsonEnvelope(text, 2 * 1024 * 1024)) return false;
    const std::lock_guard<std::recursive_mutex> guard(journalMutex);
    if (file.getParentDirectory().createDirectory().failed()) return false;
    juce::TemporaryFile temporary(file, juce::TemporaryFile::useHiddenFile);
    auto output = temporary.getFile().createOutputStream();
    if (!output) return false;
    const bool written = output->write(text.toRawUTF8(), text.getNumBytesAsUTF8());
    output->flush();
    const bool ok = written && output->getStatus().wasOk()
        && output->getPosition() == static_cast<juce::int64>(text.getNumBytesAsUTF8());
    output.reset();
    return ok && temporary.overwriteTargetFileWithTemporary();
}
juce::String RecoveryJournal::create(const juce::String& kind, const juce::var& payload)
{
    if (!locked || !payload.isObject() || (kind != "recording" && kind != "ai")) return {};
    const auto id = sessionId + "/" + juce::Uuid().toString();
    auto data = payload.clone();
    auto* object = data.getDynamicObject();
    object->setProperty("kind", kind); object->setProperty("version", 1); object->setProperty("id", id);
    object->setProperty("createdAt", juce::Time::currentTimeMillis());
    return update(id, data) ? id : juce::String();
}
bool RecoveryJournal::update(const juce::String& id, const juce::var& payload)
{
    const std::lock_guard<std::recursive_mutex> guard(journalMutex);
    if (!locked || !payload.isObject()) return false;
    auto data = read(entryFile(id));
    if (!data.isObject()) data = payload.clone();
    else for (const auto& property : payload.getDynamicObject()->getProperties())
        if (property.name.toString() != "id" && property.name.toString() != "kind" && property.name.toString() != "version" && property.name.toString() != "createdAt")
            data.getDynamicObject()->setProperty(property.name, property.value);
    data.getDynamicObject()->setProperty("id", id);
    data.getDynamicObject()->setProperty("updatedAt", juce::Time::currentTimeMillis());
    return write(entryFile(id), data);
}
void RecoveryJournal::markClean()
{
    const auto session = root.getChildFile(sessionId);
    if (!session.isDirectory()) return;
    // This marker only excludes healthy recording entries. Pending AI requests
    // remain discoverable after a deliberate quit/restart as well as a crash.
    session.getChildFile("clean").replaceWithText("Normal recording shutdown\n");
}
juce::var RecoveryJournal::readInactive(const juce::String& id, const juce::File& directory)
{
    const auto values = parts(id);
    if (values.size() != 2) return {};
    {
        const std::lock_guard<std::recursive_mutex> guard(journalMutex);
        if (liveJournals.count(values[0])) return {};
    }
    const auto session = directory.getChildFile(values[0]);
    const auto entry = session.getChildFile(values[1]);
    if (session.isSymbolicLink() || entry.isSymbolicLink() || entry.getChildFile("dismissed").exists()) return {};
    juce::InterProcessLock probe("OpenStudio-Work-" + values[0]);
    if (!probe.enter(0)) return {};
    const auto value = read(entry.getChildFile("job.json"));
    probe.exit();
    if (value.getProperty("id", "").toString() != id) return {};
    const auto status = value.getProperty("status", "").toString();
    if (status == "cancelled" || status == "imported" || status == "dismissed") return {};
    if (value.getProperty("kind", "").toString() == "recording" && session.getChildFile("clean").exists()
        && static_cast<int>(value.getProperty("writeFault", 0)) == 0) return {};
    return value;
}
juce::var RecoveryJournal::discover(const juce::File& directory)
{
    juce::Array<juce::var> results;
    for (const auto& session : juce::RangedDirectoryIterator(directory, false, "*", juce::File::findDirectories))
    {
        const auto sessionName = session.getFile().getFileName();
        if (!validId(sessionName)) continue;
        for (const auto& entry : juce::RangedDirectoryIterator(session.getFile(), false, "*", juce::File::findDirectories))
        {
            if (results.size() >= 1000) return results;
            const auto value = readInactive(sessionName + "/" + entry.getFile().getFileName(), directory);
            if (value.isObject()) results.add(value);
        }
    }
    return results;
}
bool RecoveryJournal::dismiss(const juce::String& id, const juce::File& directory)
{
    const auto value = readInactive(id, directory);
    if (!value.isObject()) return false;
    const auto values = parts(id);
    const auto file = directory.getChildFile(values[0]).getChildFile(values[1]).getChildFile("dismissed");
    return write(file, value); // Acknowledge only; keep original journal and audio.
}

void RecoveryJournal::acknowledgeSavedProject(const juce::var& document, const juce::File& directory)
{
    const auto tracks = document.getProperty("tracks", {});
    const auto* trackList = tracks.getArray();
    if (trackList == nullptr) return;
    std::set<juce::String> ids;
    for (const auto& track : *trackList)
    {
        const auto clips = track.getProperty("clips", {});
        if (const auto* clipList = clips.getArray())
            for (const auto& clip : *clipList)
                if (const auto id = clip.getProperty("recoveryJobId", "").toString(); parts(id).size() == 2)
                    ids.insert(id);
    }
    const std::lock_guard<std::recursive_mutex> guard(journalMutex);
    for (const auto& id : ids)
    {
        const auto values = parts(id);
        const auto session = directory.getChildFile(values[0]);
        const auto entry = session.getChildFile(values[1]);
        if (session.isSymbolicLink() || entry.isSymbolicLink()) continue;
        // Our own live jobs can be acknowledged; another app's live session cannot.
        juce::InterProcessLock probe("OpenStudio-Work-" + values[0]);
        const bool local = liveJournals.count(values[0]) != 0;
        if (!local && !probe.enter(0)) continue;
        const auto data = read(entry.getChildFile("job.json"));
        if (data.getProperty("id", "").toString() == id)
            // A separate marker survives a concurrent terminal-status update.
            // Failure leaves a duplicate reminder, never makes a saved project fail.
            write(entry.getChildFile("dismissed"), data);
        if (!local) probe.exit();
    }
}

bool RecoveryJournal::updateOwnedAI(const juce::String& id, const juce::var& fields, const juce::File& directory)
{
    const std::lock_guard<std::recursive_mutex> transaction(journalMutex);
    const auto values = parts(id);
    if (values.size() != 2 || !fields.isObject()) return false;
    {
        const std::lock_guard<std::recursive_mutex> guard(journalMutex);
        if (!liveJournals.count(values[0])) return false;
    }
    const auto file = directory.getChildFile(values[0]).getChildFile(values[1]).getChildFile("job.json");
    auto data = read(file);
    if (data.getProperty("kind", "").toString() != "ai" || data.getProperty("id", "").toString() != id) return false;
    for (const auto& property : fields.getDynamicObject()->getProperties())
        if (property.name.toString() != "id" && property.name.toString() != "kind" && property.name.toString() != "version")
            data.getDynamicObject()->setProperty(property.name, property.value);
    data.getDynamicObject()->setProperty("updatedAt", juce::Time::currentTimeMillis());
    return write(file, data);
}
