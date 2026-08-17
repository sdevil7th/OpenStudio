#include "PluginManager.h"
#include "S13FXProcessor.h"
#include "CLAPPluginFormat.h"

namespace
{
juce::File getOpenStudioDocumentsDirectory()
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    return documentsDir.getChildFile("OpenStudio");
}

juce::File getLegacyStudio13DocumentsDirectory()
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    return documentsDir.getChildFile("Studio13");
}

constexpr bool shouldIgnorePathCase()
{
   #if JUCE_WINDOWS
    return true;
   #else
    return false;
   #endif
}

juce::String normalisePath(const juce::String& path)
{
    auto cleanedPath = path.trim().unquoted();
    if (cleanedPath.isEmpty())
        return {};

    if (cleanedPath == "~" || cleanedPath.startsWith("~/") || cleanedPath.startsWith("~\\"))
    {
        cleanedPath = juce::File::getSpecialLocation(juce::File::userHomeDirectory).getFullPathName()
                      + cleanedPath.substring(1);
    }

   #if JUCE_WINDOWS
    int variableStart = cleanedPath.indexOfChar('%');
    while (variableStart >= 0)
    {
        const int variableEnd = cleanedPath.indexOfChar(variableStart + 1, '%');
        if (variableEnd < 0)
            break;

        const auto variableName = cleanedPath.substring(variableStart + 1, variableEnd);
        const auto variableValue = juce::SystemStats::getEnvironmentVariable(variableName, {});
        if (variableValue.isEmpty())
            return {};

        cleanedPath = cleanedPath.replaceSection(variableStart,
                                                  variableEnd - variableStart + 1,
                                                  variableValue);
        variableStart = cleanedPath.indexOfChar(variableStart + variableValue.length(), '%');
    }
   #endif

    auto file = juce::File(cleanedPath);
    if (file.isSymbolicLink())
        file = file.getLinkedTarget();

    return file.getFullPathName();
}

juce::String normaliseCandidateIdentifier(const juce::String& identifier)
{
    auto cleanedIdentifier = identifier.trim().unquoted();
    if (cleanedIdentifier.isEmpty())
        return {};

    if (juce::File::isAbsolutePath(cleanedIdentifier))
        return juce::File(cleanedIdentifier).getFullPathName();

    return cleanedIdentifier;
}

bool containsNormalisedPath(const juce::StringArray& values, const juce::String& value)
{
    return values.contains(value, shouldIgnorePathCase());
}

bool candidateIdentifiersEqual(const juce::String& first, const juce::String& second)
{
    const auto normalisedFirst = normaliseCandidateIdentifier(first);
    const auto normalisedSecond = normaliseCandidateIdentifier(second);
    const bool bothAreFilePaths = juce::File::isAbsolutePath(normalisedFirst)
                                  && juce::File::isAbsolutePath(normalisedSecond);

    if (bothAreFilePaths && shouldIgnorePathCase())
        return normalisedFirst.equalsIgnoreCase(normalisedSecond);

    // Non-filesystem identifiers such as LV2 URIs are case-sensitive on every
    // platform, including Windows.
    return normalisedFirst == normalisedSecond;
}

int indexOfCandidateIdentifier(const juce::StringArray& values, const juce::String& value)
{
    for (int i = 0; i < values.size(); ++i)
        if (candidateIdentifiersEqual(values[i], value))
            return i;
    return -1;
}

bool containsCandidateIdentifier(const juce::StringArray& values, const juce::String& value)
{
    return indexOfCandidateIdentifier(values, value) >= 0;
}

void addUniqueCandidateIdentifier(juce::StringArray& values, const juce::String& value)
{
    if (!containsCandidateIdentifier(values, value))
        values.add(value);
}

void addUniquePath(juce::StringArray& paths, const juce::String& path)
{
    auto normalised = normalisePath(path);
    if (normalised.isNotEmpty())
        paths.addIfNotAlreadyThere(normalised, shouldIgnorePathCase());
}

void addUniquePath(juce::StringArray& paths, const juce::File& path)
{
    addUniquePath(paths, path.getFullPathName());
}

void addSearchPath(juce::StringArray& paths, const juce::FileSearchPath& searchPath)
{
    for (int i = 0; i < searchPath.getNumPaths(); ++i)
        addUniquePath(paths, searchPath.getRawString(i));
}

void addEnvironmentSearchPath(juce::StringArray& paths, const juce::String& variableName)
{
    auto value = juce::SystemStats::getEnvironmentVariable(variableName, {});
    if (value.isEmpty())
        return;

    juce::StringArray entries;
   #if JUCE_WINDOWS
    entries.addTokens(value, ";", "\"");
   #else
    entries.addTokens(value, ":", "\"");
   #endif
    entries.trim();
    entries.removeEmptyStrings();

    for (const auto& entry : entries)
        addUniquePath(paths, entry);
}

juce::StringArray getSearchPathsForFormat(juce::AudioPluginFormat& format,
                                          const juce::StringArray& customPaths)
{
    juce::StringArray paths;
    addSearchPath(paths, format.getDefaultLocationsToSearch());

    const auto formatName = format.getName();
    const auto executableDirectory = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
                                         .getParentDirectory();

   #if JUCE_WINDOWS
    const auto programFiles = juce::File::getSpecialLocation(juce::File::globalApplicationsDirectory);
    const auto localAppData = juce::File::getSpecialLocation(juce::File::windowsLocalAppData);
    const auto roamingAppData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);

    if (formatName.containsIgnoreCase("VST3"))
    {
        addUniquePath(paths, programFiles.getChildFile("Common Files").getChildFile("VST3"));
        addUniquePath(paths, localAppData.getChildFile("Programs").getChildFile("Common").getChildFile("VST3"));
        addUniquePath(paths, executableDirectory.getChildFile("VST3"));
        addEnvironmentSearchPath(paths, "VST3_PATH");
    }
    else if (formatName.containsIgnoreCase("LV2"))
    {
        addUniquePath(paths, programFiles.getChildFile("Common Files").getChildFile("LV2"));
        addUniquePath(paths, roamingAppData.getChildFile("LV2"));
        addUniquePath(paths, juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile(".lv2"));
        addEnvironmentSearchPath(paths, "LV2_PATH");
    }
    else if (formatName.equalsIgnoreCase("CLAP"))
    {
        addUniquePath(paths, programFiles.getChildFile("Common Files").getChildFile("CLAP"));
        addUniquePath(paths, localAppData.getChildFile("Programs").getChildFile("Common").getChildFile("CLAP"));
        addEnvironmentSearchPath(paths, "CLAP_PATH");
    }
   #elif JUCE_MAC
    const auto userHome = juce::File::getSpecialLocation(juce::File::userHomeDirectory);

    if (formatName.containsIgnoreCase("VST3"))
    {
        addUniquePath(paths, juce::File("/Library/Audio/Plug-Ins/VST3"));
        addUniquePath(paths, userHome.getChildFile("Library/Audio/Plug-Ins/VST3"));
        addUniquePath(paths, executableDirectory.getChildFile("VST3"));
        addEnvironmentSearchPath(paths, "VST3_PATH");
    }
    else if (formatName.containsIgnoreCase("LV2"))
    {
        addUniquePath(paths, juce::File("/Library/Audio/Plug-Ins/LV2"));
        addUniquePath(paths, userHome.getChildFile("Library/Audio/Plug-Ins/LV2"));
        addUniquePath(paths, userHome.getChildFile(".lv2"));
        addEnvironmentSearchPath(paths, "LV2_PATH");
    }
    else if (formatName.equalsIgnoreCase("CLAP"))
    {
        addUniquePath(paths, juce::File("/Library/Audio/Plug-Ins/CLAP"));
        addUniquePath(paths, userHome.getChildFile("Library/Audio/Plug-Ins/CLAP"));
        addEnvironmentSearchPath(paths, "CLAP_PATH");
    }
   #else
    const auto userHome = juce::File::getSpecialLocation(juce::File::userHomeDirectory);

    if (formatName.containsIgnoreCase("VST3"))
    {
        addUniquePath(paths, juce::File("/usr/lib/vst3"));
        addUniquePath(paths, juce::File("/usr/local/lib/vst3"));
        addUniquePath(paths, userHome.getChildFile(".vst3"));
        addUniquePath(paths, executableDirectory.getChildFile("VST3"));
        addEnvironmentSearchPath(paths, "VST3_PATH");
    }
    else if (formatName.containsIgnoreCase("LV2"))
    {
        addUniquePath(paths, juce::File("/usr/lib/lv2"));
        addUniquePath(paths, juce::File("/usr/local/lib/lv2"));
        addUniquePath(paths, userHome.getChildFile(".lv2"));
        addEnvironmentSearchPath(paths, "LV2_PATH");
    }
    else if (formatName.equalsIgnoreCase("CLAP"))
    {
        addUniquePath(paths, juce::File("/usr/lib/clap"));
        addUniquePath(paths, juce::File("/usr/local/lib/clap"));
        addUniquePath(paths, userHome.getChildFile(".clap"));
        addEnvironmentSearchPath(paths, "CLAP_PATH");
    }
   #endif

    for (const auto& customPath : customPaths)
        addUniquePath(paths, customPath);

    return paths;
}

juce::FileSearchPath makeFileSearchPath(const juce::StringArray& paths)
{
    juce::FileSearchPath result;
    for (const auto& path : paths)
        result.add(juce::File(path));
    return result;
}

juce::StringArray getDeduplicatedCandidates(juce::AudioPluginFormat& format,
                                            const juce::StringArray& paths)
{
    auto discovered = format.searchPathsForPlugins(makeFileSearchPath(paths), true, false);
    juce::StringArray result;

    for (const auto& candidate : discovered)
    {
        auto normalised = normaliseCandidateIdentifier(candidate);
        if (normalised.isNotEmpty())
            addUniqueCandidateIdentifier(result, normalised);
    }

    return result;
}

juce::var makeStringArrayVar(const juce::StringArray& values)
{
    juce::Array<juce::var> result;
    result.ensureStorageAllocated(values.size());
    for (const auto& value : values)
        result.add(value);
    return juce::var(std::move(result));
}

void migrateLegacyFile(const juce::File& legacyFile, const juce::File& destinationFile)
{
    if (destinationFile.existsAsFile() || !legacyFile.existsAsFile())
        return;

    destinationFile.getParentDirectory().createDirectory();
    if (legacyFile.copyFileTo(destinationFile))
    {
        juce::Logger::writeToLog("PluginManager: Migrated " + legacyFile.getFullPathName()
                                 + " to " + destinationFile.getFullPathName());
    }
    else
    {
        juce::Logger::writeToLog("PluginManager: Failed to migrate " + legacyFile.getFullPathName()
                                 + " to " + destinationFile.getFullPathName());
    }
}

juce::String getCanonicalPluginIdentifier(const juce::String& identifier)
{
    auto normalised = normaliseCandidateIdentifier(identifier);
    if (!juce::File::isAbsolutePath(normalised))
        return normalised;

    auto current = juce::File(normalised);
    auto canonicalBundle = current;
    bool foundBundle = false;

    for (;;)
    {
        const auto extension = current.getFileExtension();
        if (extension.equalsIgnoreCase(".vst3")
            || extension.equalsIgnoreCase(".lv2")
            || extension.equalsIgnoreCase(".clap"))
        {
            canonicalBundle = current;
            foundBundle = true;
        }

        const auto parent = current.getParentDirectory();
        if (parent == current)
            break;
        current = parent;
    }

    return foundBundle ? canonicalBundle.getFullPathName() : normalised;
}

bool identifiersMatch(const juce::String& first, const juce::String& second)
{
    const auto normalisedFirst = getCanonicalPluginIdentifier(first);
    const auto normalisedSecond = getCanonicalPluginIdentifier(second);
    return candidateIdentifiersEqual(normalisedFirst, normalisedSecond);
}

int indexOfPluginIdentifier(const juce::StringArray& values,
                            const juce::String& value)
{
    for (int i = 0; i < values.size(); ++i)
        if (identifiersMatch(values[i], value))
            return i;
    return -1;
}

bool containsPluginIdentifier(const juce::StringArray& values,
                              const juce::String& value)
{
    return indexOfPluginIdentifier(values, value) >= 0;
}

bool descriptionMatchesCandidate(const juce::PluginDescription& description,
                                 const juce::String& formatName,
                                 const juce::String& candidate)
{
    return description.pluginFormatName.equalsIgnoreCase(formatName)
           && identifiersMatch(description.fileOrIdentifier, candidate);
}

void removeDescriptionsForCandidate(juce::KnownPluginList& list,
                                    const juce::String& formatName,
                                    const juce::String& candidate)
{
    const auto descriptions = list.getTypes();
    for (const auto& description : descriptions)
        if (descriptionMatchesCandidate(description, formatName, candidate))
            list.removeType(description);
}

class PluginProbeState final
{
public:
    void setFailure(const juce::String& identifier, const juce::String& reason)
    {
        const auto existingIndex = indexOfCandidateIdentifier(identifiers, identifier);
        if (existingIndex >= 0)
        {
            reasons.set(existingIndex, reason);
            return;
        }

        identifiers.add(identifier);
        reasons.add(reason);
    }

    juce::String getFailure(const juce::String& identifier) const
    {
        const auto index = indexOfCandidateIdentifier(identifiers, identifier);
        return index >= 0 ? reasons[index] : juce::String();
    }

    const juce::StringArray& getIdentifiers() const noexcept
    {
        return identifiers;
    }

    void setInfrastructureFailure(const juce::String& reason)
    {
        if (infrastructureFailure.isEmpty())
            infrastructureFailure = reason;
    }

    bool hadInfrastructureFailure() const noexcept
    {
        return infrastructureFailure.isNotEmpty();
    }

    const juce::String& getInfrastructureFailure() const noexcept
    {
        return infrastructureFailure;
    }

private:
    juce::StringArray identifiers;
    juce::StringArray reasons;
    juce::String infrastructureFailure;
};

class ScopedPluginProbeArtifacts final
{
public:
    ScopedPluginProbeArtifacts()
        : reportFile(juce::File::createTempFile(".openstudio-plugin-scan.xml")),
          logFile(reportFile.withFileExtension("log"))
    {
        reportFile.deleteFile();
        logFile.deleteFile();
    }

    ~ScopedPluginProbeArtifacts()
    {
        reportFile.deleteFile();
        logFile.deleteFile();
    }

    juce::String appendLogTail(const juce::String& reason) const
    {
        auto input = logFile.createInputStream();
        if (input == nullptr)
            return reason;

        constexpr juce::int64 maximumTailBytes = 2048;
        const auto streamLength = input->getTotalLength();
        if (streamLength > maximumTailBytes)
            input->setPosition(streamLength - maximumTailBytes);

        const auto tail = input->readEntireStreamAsString().trim();
        return tail.isEmpty() ? reason : reason + " Probe log tail:\n" + tail;
    }

    juce::File reportFile;
    juce::File logFile;
};

class OutOfProcessPluginScanner final : public juce::KnownPluginList::CustomScanner
{
public:
    OutOfProcessPluginScanner(std::shared_ptr<PluginProbeState> stateToUse,
                              const juce::StringArray& effectiveSearchPaths)
        : state(std::move(stateToUse)),
          searchPathsFile(juce::File::createTempFile(".openstudio-plugin-paths.xml"))
    {
        searchPathsFile.deleteFile();

        juce::XmlElement root("PLUGIN_SEARCH_PATHS");
        for (const auto& path : effectiveSearchPaths)
            root.createNewChildElement("PATH")->setAttribute("value", path);

        if (!root.writeTo(searchPathsFile))
            state->setInfrastructureFailure("The isolated scanner search-path manifest could not be created.");
    }

    ~OutOfProcessPluginScanner() override
    {
        searchPathsFile.deleteFile();
    }

    bool findPluginTypesFor(juce::AudioPluginFormat& format,
                            juce::OwnedArray<juce::PluginDescription>& result,
                            const juce::String& fileOrIdentifier) override
    {
        constexpr int timeoutMs = 20000;
        constexpr int pollIntervalMs = 10;

        if (state->hadInfrastructureFailure())
        {
            state->setFailure(fileOrIdentifier, state->getInfrastructureFailure());
            return false;
        }

        ScopedPluginProbeArtifacts artifacts;

        juce::StringArray arguments;
        arguments.add(juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName());
        arguments.add("--plugin-scan-probe-headless");
        arguments.add(fileOrIdentifier);
        arguments.add("--plugin-format");
        arguments.add(format.getName());
        arguments.add("--plugin-search-paths-file");
        arguments.add(searchPathsFile.getFullPathName());
        arguments.add("--report");
        arguments.add(artifacts.reportFile.getFullPathName());

        juce::ChildProcess process;
        if (!process.start(arguments, 0))
        {
            const auto reason = artifacts.appendLogTail(
                "The isolated plugin scanner process could not be started.");
            state->setFailure(fileOrIdentifier, reason);
            state->setInfrastructureFailure(reason);
            return false;
        }

        int elapsedMs = 0;
        while (process.isRunning() && elapsedMs < timeoutMs && !shouldExit())
        {
            juce::Thread::sleep(pollIntervalMs);
            elapsedMs += pollIntervalMs;
        }

        if (process.isRunning())
        {
            const bool cancelled = shouldExit();
            process.kill();
            process.waitForProcessToFinish(500);
            const auto reason = cancelled
                ? juce::String("The plugin scan was cancelled.")
                : juce::String("The isolated plugin scanner timed out after 20 seconds and was terminated.");
            state->setFailure(fileOrIdentifier, artifacts.appendLogTail(reason));
            return false;
        }

        const auto exitCode = process.getExitCode();
        auto report = juce::parseXML(artifacts.reportFile);

        if (report == nullptr || !report->hasTagName("PLUGIN_SCAN_RESULT"))
        {
            state->setFailure(
                fileOrIdentifier,
                artifacts.appendLogTail(
                    "The isolated plugin scanner exited without a valid report (exit code "
                    + juce::String(static_cast<juce::int64>(exitCode)) + ")."));
            return false;
        }

        const auto status = report->getStringAttribute("status");
        const auto reportedError = report->getStringAttribute("error");
        if (status != "ok")
        {
            const auto reason = reportedError.isNotEmpty()
                ? reportedError
                : "The isolated scanner returned status '" + status + "'.";
            state->setFailure(fileOrIdentifier, artifacts.appendLogTail(reason));
            // The helper completed and returned a valid diagnostic. Treat this
            // as a normal scan failure, rather than a scanner crash blacklist.
            return true;
        }

        if (exitCode != 0)
        {
            state->setFailure(
                fileOrIdentifier,
                artifacts.appendLogTail(
                    "The isolated scanner returned a successful report but exited with code "
                    + juce::String(static_cast<juce::int64>(exitCode)) + "."));
            return false;
        }

        int descriptionCount = 0;
        for (auto* child : report->getChildIterator())
        {
            juce::PluginDescription description;
            if (!description.loadFromXml(*child))
            {
                state->setFailure(
                    fileOrIdentifier,
                    artifacts.appendLogTail(
                        "The isolated scanner returned malformed plugin-description data."));
                result.clear();
                return false;
            }

            result.add(new juce::PluginDescription(description));
            ++descriptionCount;
        }

        if (descriptionCount <= 0
            || descriptionCount != report->getIntAttribute("pluginCount", descriptionCount))
        {
            state->setFailure(
                fileOrIdentifier,
                artifacts.appendLogTail(
                    "The isolated scanner report contained an inconsistent plugin count."));
            result.clear();
            return false;
        }

        return true;
    }

private:
    std::shared_ptr<PluginProbeState> state;
    juce::File searchPathsFile;
};
}

PluginManager::PluginManager()
{
    // Add default formats (VST3, LV2, AU, etc.)
    formatManager.addDefaultFormats();

    // Add CLAP hosting (not built into JUCE — custom format)
    formatManager.addFormat(new CLAPPluginFormat());

    // Debug: Log how many formats were added
    juce::Logger::writeToLog("PluginManager: Constructor - formatManager has " +
                           juce::String(formatManager.getNumFormats()) + " formats");

    for (int i = 0; i < formatManager.getNumFormats(); ++i)
    {
        auto* format = formatManager.getFormat(i);
        juce::Logger::writeToLog("PluginManager: Format " + juce::String(i) + ": " + format->getName());
    }

    const auto openStudioDirectory = getOpenStudioDocumentsDirectory();
    const auto legacyStudio13Directory = getLegacyStudio13DocumentsDirectory();
    openStudioDirectory.createDirectory();

    pluginListFile = openStudioDirectory.getChildFile("PluginList.xml");
    blacklistFile = openStudioDirectory.getChildFile("PluginBlacklist.txt");
    pluginSearchPathsFile = openStudioDirectory.getChildFile("PluginSearchPaths.xml");
    pluginScanDeadMansPedalFile = openStudioDirectory.getChildFile("PluginScanDeadMansPedal.txt");

    // Copy legacy state once, but never continue reading or writing the legacy
    // files. This prevents the old Studio13 location from remaining sticky.
    migrateLegacyFile(legacyStudio13Directory.getChildFile("PluginList.xml"), pluginListFile);
    migrateLegacyFile(legacyStudio13Directory.getChildFile("PluginBlacklist.txt"), blacklistFile);

    if (blacklistFile.existsAsFile())
    {
        blacklistFile.readLines(blacklistedPlugins);
        blacklistedPlugins.trim();
        blacklistedPlugins.removeEmptyStrings();
        juce::StringArray deduplicatedBlacklist;
        for (const auto& pluginId : blacklistedPlugins)
            if (!containsPluginIdentifier(deduplicatedBlacklist, pluginId))
                deduplicatedBlacklist.add(pluginId);
        blacklistedPlugins = std::move(deduplicatedBlacklist);
    }

    loadPluginSearchPaths();

    // Load existing plugin list if available
    loadPluginList();

    // Ensure user effects directory exists
    getUserEffectsDirectory().createDirectory();
}

PluginManager::~PluginManager()
{
    savePluginList();
}

juce::var PluginManager::scanForPlugins(bool forceRescan)
{
    // Only one background scan may run at a time. The main manager lock is
    // deliberately held only for short snapshots and the final commit so UI
    // calls never wait behind third-party probe timeouts.
    const juce::ScopedLock serialisedScanLock(pluginScanLock);

    juce::StringArray customPathsSnapshot;
    juce::StringArray blacklistSnapshot;
    std::unique_ptr<juce::XmlElement> currentCatalog;
    juce::uint64 stateRevisionAtStart = 0;
    {
        const juce::ScopedLock managerLock(pluginManagerLock);
        customPathsSnapshot = customPluginSearchPaths;
        blacklistSnapshot = blacklistedPlugins;
        currentCatalog = knownPluginList.createXml();
        stateRevisionAtStart = pluginStateRevision;
    }

    juce::AudioPluginFormatManager scanFormatManager;
    scanFormatManager.addDefaultFormats();
    scanFormatManager.addFormat(new CLAPPluginFormat());

    const auto debugLog = getOpenStudioDocumentsDirectory().getChildFile("plugin_scan_debug.txt");
    debugLog.getParentDirectory().createDirectory();
    debugLog.deleteFile();
    debugLog.create();

    const auto writeLog = [&debugLog](const juce::String& message)
    {
        juce::Logger::writeToLog(message);
        debugLog.appendText(message + "\n");
    };

    writeLog("PluginManager: Starting transactional, isolated plugin scan [mode="
             + juce::String(forceRescan ? "deep" : "cached") + "]");
    writeLog("PluginManager: Supported format count: " + juce::String(scanFormatManager.getNumFormats()));

    juce::KnownPluginList scannedPluginList;
    if (currentCatalog != nullptr)
        scannedPluginList.recreateFromXml(*currentCatalog);
    scannedPluginList.clearBlacklistedFiles();

    struct ActiveCandidate
    {
        juce::String format;
        juce::String identifier;
    };

    std::vector<ActiveCandidate> activeCandidates;
    juce::Array<juce::var> formatReports;
    juce::Array<juce::var> failures;
    juce::Array<juce::var> skipped;
    juce::StringArray allSearchPaths;
    int totalCandidateCount = 0;
    int totalFailedCount = 0;
    int totalSkippedCount = 0;
    bool scanInfrastructureHealthy = true;
    juce::String infrastructureError;

    for (int i = 0; i < scanFormatManager.getNumFormats(); ++i)
    {
        auto* format = scanFormatManager.getFormat(i);
        if (format == nullptr)
            continue;

        const auto formatName = format->getName();
        const auto searchPaths = getSearchPathsForFormat(*format, customPathsSnapshot);
        for (const auto& path : searchPaths)
            allSearchPaths.addIfNotAlreadyThere(path, shouldIgnorePathCase());

        writeLog({});
        writeLog("PluginManager: Format: " + formatName);
        for (const auto& path : searchPaths)
        {
            const auto directory = juce::File(path);
            writeLog("PluginManager: Path: " + path
                     + " [" + (directory.isDirectory() ? "available" : "not found") + "]");
        }

        const auto candidates = getDeduplicatedCandidates(*format, searchPaths);
        juce::StringArray allowedCandidates;
        juce::Array<juce::var> formatSkipped;
        for (const auto& candidate : candidates)
        {
            if (containsPluginIdentifier(blacklistSnapshot, candidate))
            {
                const auto reason = "Skipped because this candidate is in the persisted user or legacy plug-in blacklist.";
                auto* skippedCandidate = new juce::DynamicObject();
                skippedCandidate->setProperty("format", formatName);
                skippedCandidate->setProperty("path", candidate);
                skippedCandidate->setProperty("reason", reason);
                const juce::var skippedValue(skippedCandidate);
                formatSkipped.add(skippedValue);
                skipped.add(skippedValue);
                ++totalSkippedCount;
                writeLog("PluginManager: Skipped blacklisted candidate: " + candidate + " - " + reason);
                removeDescriptionsForCandidate(scannedPluginList, formatName, candidate);
                continue;
            }

            allowedCandidates.add(candidate);
            activeCandidates.push_back({ formatName, candidate });
        }

        totalCandidateCount += candidates.size();
        writeLog("PluginManager: Candidate count (deduplicated): " + juce::String(candidates.size()));

        juce::StringArray candidatesNeedingProbe;
        const auto cachedDescriptions = scannedPluginList.getTypes();
        for (const auto& candidate : allowedCandidates)
        {
            bool hasCachedDescription = false;
            bool needsRescan = false;

            for (const auto& description : cachedDescriptions)
            {
                if (!descriptionMatchesCandidate(description, formatName, candidate))
                    continue;

                hasCachedDescription = true;
                if (format->pluginNeedsRescanning(description))
                    needsRescan = true;
            }

            if (forceRescan || !hasCachedDescription || needsRescan)
            {
                removeDescriptionsForCandidate(scannedPluginList, formatName, candidate);
                candidatesNeedingProbe.add(candidate);
            }
        }

        writeLog("PluginManager: Reused unchanged candidates: "
                 + juce::String(allowedCandidates.size() - candidatesNeedingProbe.size()));
        writeLog("PluginManager: Candidates requiring isolated probe: "
                 + juce::String(candidatesNeedingProbe.size()));

        auto probeState = std::make_shared<PluginProbeState>();
        scannedPluginList.setCustomScanner(
            std::make_unique<OutOfProcessPluginScanner>(probeState, searchPaths));

        juce::StringArray scannerFailures;
        {
            // Candidate enumeration was already performed above. Start the JUCE
            // scanner with an empty path and provide the exact canonical list.
            juce::PluginDirectoryScanner scanner(scannedPluginList,
                                                  *format,
                                                  juce::FileSearchPath(),
                                                  true,
                                                  pluginScanDeadMansPedalFile,
                                                  false);
            scanner.setFilesOrIdentifiersToScan(candidatesNeedingProbe);

            if (!candidatesNeedingProbe.isEmpty())
            {
                bool hasMoreFiles = true;
                while (hasMoreFiles)
                {
                    juce::String pluginBeingScanned;
                    hasMoreFiles = scanner.scanNextFile(true, pluginBeingScanned);
                    if (pluginBeingScanned.isNotEmpty())
                        writeLog("PluginManager: Isolated probe completed: " + pluginBeingScanned);
                }
            }

            scannerFailures.addArray(scanner.getFailedFiles());
        }

        juce::StringArray failedCandidates;
        for (const auto& failed : scannerFailures)
            addUniqueCandidateIdentifier(failedCandidates, failed);
        for (const auto& failed : probeState->getIdentifiers())
            addUniqueCandidateIdentifier(failedCandidates, failed);
        for (const auto& candidate : candidatesNeedingProbe)
        {
            if (containsCandidateIdentifier(scannedPluginList.getBlacklistedFiles(), candidate))
                addUniqueCandidateIdentifier(failedCandidates, candidate);
        }

        for (const auto& failedCandidate : failedCandidates)
        {
            removeDescriptionsForCandidate(scannedPluginList, formatName, failedCandidate);

            auto reason = probeState->getFailure(failedCandidate);
            if (reason.isEmpty())
                reason = "A previous scan was interrupted while inspecting this plugin.";

            auto* failure = new juce::DynamicObject();
            failure->setProperty("format", formatName);
            failure->setProperty("path", failedCandidate);
            failure->setProperty("reason", reason);
            failures.add(juce::var(failure));
            writeLog("PluginManager: Failed: " + failedCandidate + " - " + reason);
        }

        int formatPluginCount = 0;
        for (const auto& description : scannedPluginList.getTypes())
        {
            if (!description.pluginFormatName.equalsIgnoreCase(formatName))
                continue;

            for (const auto& candidate : allowedCandidates)
            {
                if (descriptionMatchesCandidate(description, formatName, candidate))
                {
                    ++formatPluginCount;
                    writeLog("PluginManager: Found: " + description.name + " by "
                             + description.manufacturerName + " [" + description.fileOrIdentifier + "]");
                    break;
                }
            }
        }

        const int failedCount = failedCandidates.size();
        const int formatSkippedCount = formatSkipped.size();
        totalFailedCount += failedCount;

        auto* formatReport = new juce::DynamicObject();
        formatReport->setProperty("format", formatName);
        formatReport->setProperty("candidateCount", candidates.size());
        formatReport->setProperty("pluginCount", formatPluginCount);
        formatReport->setProperty("failedCount", failedCount);
        formatReport->setProperty("skippedCount", formatSkippedCount);
        formatReport->setProperty("skipped", juce::var(std::move(formatSkipped)));
        formatReport->setProperty("paths", makeStringArrayVar(searchPaths));
        formatReports.add(juce::var(formatReport));

        writeLog("PluginManager: Format result: " + juce::String(formatPluginCount)
                 + " plugin descriptions, " + juce::String(failedCount) + " failures, "
                 + juce::String(formatSkippedCount) + " skipped");

        // Failure to launch the helper is an infrastructure failure, not a bad
        // plugin. Preserve the existing catalog instead of committing an empty
        // or partial replacement.
        if (probeState->hadInfrastructureFailure())
        {
            scanInfrastructureHealthy = false;
            if (infrastructureError.isEmpty())
                infrastructureError = probeState->getInfrastructureFailure();
        }
    }

    scannedPluginList.setCustomScanner(std::unique_ptr<juce::KnownPluginList::CustomScanner>());

    // Remove stale entries for uninstalled plugins, paths that are no longer
    // configured, unsupported formats, and user-blacklisted candidates.
    const auto scannedDescriptions = scannedPluginList.getTypes();
    for (const auto& description : scannedDescriptions)
    {
        bool isActive = false;
        for (const auto& candidate : activeCandidates)
        {
            if (descriptionMatchesCandidate(description, candidate.format, candidate.identifier))
            {
                isActive = true;
                break;
            }
        }

        if (!isActive)
        {
            writeLog("PluginManager: Pruned stale catalog entry: " + description.name
                     + " [" + description.fileOrIdentifier
                     + "] because its candidate is no longer present in the effective search paths or is blacklisted.");
            scannedPluginList.removeType(description);
        }
    }
    scannedPluginList.clearBlacklistedFiles();

    bool committed = false;
    if (scanInfrastructureHealthy)
    {
        if (auto scannedXml = scannedPluginList.createXml())
        {
            {
                const juce::ScopedLock managerLock(pluginManagerLock);
                if (pluginStateRevision != stateRevisionAtStart)
                {
                    infrastructureError = "Plugin paths, blacklist, or catalog changed while the scan was running; the stale scan was not committed.";
                }
                else
                {
                    auto previousCatalog = knownPluginList.createXml();
                    knownPluginList.recreateFromXml(*scannedXml);
                    if (savePluginList())
                    {
                        ++pluginStateRevision;
                        committed = true;
                    }
                    else
                    {
                        if (previousCatalog != nullptr)
                            knownPluginList.recreateFromXml(*previousCatalog);
                        infrastructureError = "The completed plugin catalog could not be saved.";
                    }
                }
            }
        }
        else
        {
            infrastructureError = "The completed plugin catalog could not be serialised.";
        }
    }

    scanForS13FX();

    int pluginCount = scannedPluginList.getNumTypes();
    if (!committed)
    {
        const juce::ScopedLock managerLock(pluginManagerLock);
        pluginCount = knownPluginList.getNumTypes();
    }
    writeLog({});
    writeLog("PluginManager: Scan " + juce::String(committed ? "committed" : "not committed"));
    writeLog("PluginManager: Plugin descriptions: " + juce::String(pluginCount));
    writeLog("PluginManager: Candidates: " + juce::String(totalCandidateCount));
    writeLog("PluginManager: Failures: " + juce::String(totalFailedCount));
    writeLog("PluginManager: Skipped blacklisted candidates: " + juce::String(totalSkippedCount));
    writeLog("PluginManager: Debug log: " + debugLog.getFullPathName());

    auto* report = new juce::DynamicObject();
    report->setProperty("success", committed);
    report->setProperty("forceRescan", forceRescan);
    if (!committed)
    {
        report->setProperty("error",
                            infrastructureError.isNotEmpty()
                                ? infrastructureError
                                : "The plugin scan could not be committed.");
    }
    report->setProperty("pluginCount", pluginCount);
    report->setProperty("candidateCount", totalCandidateCount);
    report->setProperty("failedCount", totalFailedCount);
    report->setProperty("skippedCount", totalSkippedCount);
    report->setProperty("paths", makeStringArrayVar(allSearchPaths));
    report->setProperty("failures", juce::var(std::move(failures)));
    report->setProperty("skipped", juce::var(std::move(skipped)));
    report->setProperty("formats", juce::var(std::move(formatReports)));
    report->setProperty("debugLogPath", debugLog.getFullPathName());
    return juce::var(report);
}

juce::Array<juce::PluginDescription> PluginManager::getAvailablePlugins() const
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    juce::Array<juce::PluginDescription> plugins;
    
    for (const auto& type : knownPluginList.getTypes())
    {
        plugins.add(type);
    }
    
    return plugins;
}

std::vector<S13FXInfo> PluginManager::getAvailableS13FX() const
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    return s13fxList;
}

std::unique_ptr<juce::AudioProcessor> PluginManager::loadPlugin(const juce::PluginDescription& description,
                                                               double sampleRate, int blockSize)
{
    const juce::ScopedLock managerLock(pluginManagerLock);

    // Refuse to load blacklisted plugins (previously crashed)
    if (isPluginBlacklisted(description.fileOrIdentifier))
    {
        juce::Logger::writeToLog("PluginManager: Refusing to load blacklisted plugin: " + description.name);
        return nullptr;
    }

    if (liveLv2PathsNeedPriming && description.pluginFormatName.containsIgnoreCase("LV2"))
    {
        for (int i = 0; i < formatManager.getNumFormats(); ++i)
        {
            auto* format = formatManager.getFormat(i);
            if (format != nullptr && format->getName().equalsIgnoreCase(description.pluginFormatName))
            {
                const auto lv2Paths = getSearchPathsForFormat(*format, customPluginSearchPaths);
                format->searchPathsForPlugins(makeFileSearchPath(lv2Paths), true, false);
                liveLv2PathsNeedPriming = false;
                break;
            }
        }
    }

    juce::String errorMessage;

    // Clamp block size to at least 512 — ASIO buffers can be as small as 32 samples,
    // but createPluginInstance uses this to initialise the plugin's internal DSP sizing.
    int safeBlockSize = juce::jmax(blockSize, 512);
    auto plugin = formatManager.createPluginInstance(description, sampleRate, safeBlockSize, errorMessage);

    if (plugin == nullptr)
    {
        juce::Logger::writeToLog("PluginManager: Failed to load plugin: " + errorMessage);
    }
    else
    {
        // Don't force a bus layout here — let the plugin use its default
        // (e.g. mono-in/stereo-out for guitar amp sims like Amplitube).
        // The TrackProcessor::safeProcessFX wrapper handles any channel mismatch.
        juce::Logger::writeToLog("PluginManager: Successfully loaded: " + description.name +
                                 " (inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                                 " outCh=" + juce::String(plugin->getTotalNumOutputChannels()) + ")");
    }

    return plugin;
}

std::unique_ptr<juce::AudioProcessor> PluginManager::loadPluginFromFile(const juce::String& filePath,
                                                                       double sampleRate, int blockSize)
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    juce::Logger::writeToLog("PluginManager: Loading plugin from: " + filePath);

    // A JUCE identifier string selects an exact class, including bundles that
    // expose multiple plugin classes from one filesystem module.
    if (auto exactDescription = knownPluginList.getTypeForIdentifierString(filePath))
    {
        juce::Logger::writeToLog("PluginManager: Exact catalog identifier found");
        return loadPlugin(*exactDescription, sampleRate, blockSize);
    }

    // Retain backwards compatibility with projects that stored a module path.
    for (const auto& desc : knownPluginList.getTypes())
    {
        const bool isExactPath = shouldIgnorePathCase()
            ? desc.fileOrIdentifier.equalsIgnoreCase(filePath)
            : desc.fileOrIdentifier == filePath;
        if (isExactPath)
        {
            juce::Logger::writeToLog("PluginManager: Exact match found in known list");
            return loadPlugin(desc, sampleRate, blockSize);
        }
    }

    // Older projects may contain the inner binary path while the catalog stores
    // the outer bundle. Compare canonical bundle boundaries, not substrings.
    for (const auto& desc : knownPluginList.getTypes())
    {
        if (identifiersMatch(filePath, desc.fileOrIdentifier))
        {
            juce::Logger::writeToLog("PluginManager: Canonical bundle match found: " + desc.fileOrIdentifier);
            return loadPlugin(desc, sampleRate, blockSize);
        }
    }

    // Unknown paths are metadata-scanned in a disposable helper process.
    const auto candidate = getCanonicalPluginIdentifier(filePath);

    for (int i = 0; i < formatManager.getNumFormats(); ++i)
    {
        auto* format = formatManager.getFormat(i);
        if (format->fileMightContainThisPluginType(candidate))
        {
            auto probeState = std::make_shared<PluginProbeState>();
            OutOfProcessPluginScanner scanner(
                probeState,
                getSearchPathsForFormat(*format, customPluginSearchPaths));
            juce::OwnedArray<juce::PluginDescription> descriptions;
            const bool probeCompleted = scanner.findPluginTypesFor(*format, descriptions, candidate);
            if (!probeCompleted)
            {
                juce::Logger::writeToLog("PluginManager: Isolated direct scan failed: "
                                         + probeState->getFailure(candidate));
                return nullptr;
            }

            if (descriptions.size() > 0)
            {
                juce::Logger::writeToLog("PluginManager: Direct scan found: " + descriptions[0]->name);
                auto previousCatalog = knownPluginList.createXml();
                for (const auto* description : descriptions)
                    if (description != nullptr)
                        knownPluginList.addType(*description);

                if (savePluginList())
                {
                    ++pluginStateRevision;
                }
                else if (previousCatalog != nullptr)
                {
                    knownPluginList.recreateFromXml(*previousCatalog);
                }
                return loadPlugin(*descriptions[0], sampleRate, blockSize);
            }

            const auto reason = probeState->getFailure(candidate);
            if (reason.isNotEmpty())
                juce::Logger::writeToLog("PluginManager: Isolated direct scan rejected the candidate: " + reason);
        }
    }

    juce::Logger::writeToLog("PluginManager: Plugin not found: " + filePath);
    return nullptr;
}

bool PluginManager::savePluginList()
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    if (auto xml = knownPluginList.createXml())
    {
        pluginListFile.getParentDirectory().createDirectory();
        juce::TemporaryFile temporaryFile(pluginListFile);

        if (xml->writeTo(temporaryFile.getFile())
            && temporaryFile.overwriteTargetFileWithTemporary())
        {
            juce::Logger::writeToLog("PluginManager: Saved plugin list to " + pluginListFile.getFullPathName());
            return true;
        }
        else
        {
            juce::Logger::writeToLog("PluginManager: Failed to save plugin list to "
                                     + pluginListFile.getFullPathName());
        }
    }

    return false;
}

void PluginManager::loadPluginList()
{
    if (pluginListFile.existsAsFile())
    {
        if (auto xml = juce::parseXML(pluginListFile))
        {
            knownPluginList.recreateFromXml(*xml);
            juce::Logger::writeToLog("PluginManager: Loaded " + juce::String(knownPluginList.getNumTypes()) +
                                   " plugins from " + pluginListFile.getFullPathName());
        }
    }
    else
    {
        juce::Logger::writeToLog("PluginManager: No existing plugin list found");
    }
}

bool PluginManager::savePluginSearchPaths() const
{
    pluginSearchPathsFile.getParentDirectory().createDirectory();

    juce::XmlElement root("PLUGIN_SEARCH_PATHS");
    root.setAttribute("version", 1);
    for (const auto& path : customPluginSearchPaths)
    {
        auto* child = root.createNewChildElement("PATH");
        child->setAttribute("value", path);
    }

    juce::TemporaryFile temporaryFile(pluginSearchPathsFile);
    if (!root.writeTo(temporaryFile.getFile()))
        return false;

    return temporaryFile.overwriteTargetFileWithTemporary();
}

void PluginManager::loadPluginSearchPaths()
{
    customPluginSearchPaths.clear();
    if (!pluginSearchPathsFile.existsAsFile())
        return;

    auto xml = juce::parseXML(pluginSearchPathsFile);
    if (xml == nullptr || !xml->hasTagName("PLUGIN_SEARCH_PATHS"))
    {
        juce::Logger::writeToLog("PluginManager: Ignoring malformed plugin search-path file: "
                                 + pluginSearchPathsFile.getFullPathName());
        return;
    }

    for (auto* child : xml->getChildIterator())
    {
        if (!child->hasTagName("PATH"))
            continue;

        addUniquePath(customPluginSearchPaths, child->getStringAttribute("value"));
    }
}

juce::var PluginManager::getPluginScanConfiguration() const
{
    const juce::ScopedLock managerLock(pluginManagerLock);

    juce::StringArray supportedFormats;
    juce::Array<juce::var> effectivePaths;

    for (int i = 0; i < formatManager.getNumFormats(); ++i)
    {
        auto* format = formatManager.getFormat(i);
        if (format == nullptr)
            continue;

        const auto formatName = format->getName();
        supportedFormats.addIfNotAlreadyThere(formatName, true);
        const auto paths = getSearchPathsForFormat(*format, customPluginSearchPaths);
        for (const auto& path : paths)
        {
            auto* pathInfo = new juce::DynamicObject();
            pathInfo->setProperty("format", formatName);
            pathInfo->setProperty("path", path);
            pathInfo->setProperty("exists", juce::File(path).isDirectory());
            pathInfo->setProperty("custom", containsNormalisedPath(customPluginSearchPaths, normalisePath(path)));
            effectivePaths.add(juce::var(pathInfo));
        }
    }

    juce::StringArray unsupportedFormats;
    unsupportedFormats.add("VST2");
    unsupportedFormats.add("AAX");
    unsupportedFormats.add("32-bit plug-ins in this 64-bit build");
    unsupportedFormats.add("Standalone applications");
   #if !JUCE_MAC
    unsupportedFormats.add("Audio Unit (AU/AUv3)");
   #endif

    auto* configuration = new juce::DynamicObject();
    configuration->setProperty("customPaths", makeStringArrayVar(customPluginSearchPaths));
    configuration->setProperty("blacklistedPlugins", makeStringArrayVar(blacklistedPlugins));
    configuration->setProperty("effectivePaths", juce::var(std::move(effectivePaths)));
    configuration->setProperty("supportedFormats", makeStringArrayVar(supportedFormats));
    configuration->setProperty("unsupportedFormats", makeStringArrayVar(unsupportedFormats));
    configuration->setProperty(
        "contentLibraryNote",
        "Kontakt, Reaktor, and NKS sound libraries or presets load inside their host plug-in and are not scanned as separate plug-ins. S13FX/JSFX scripts use the separate OpenStudio Effects content library.");
    return juce::var(configuration);
}

bool PluginManager::addPluginSearchPath(const juce::String& directoryPath)
{
    const juce::ScopedLock managerLock(pluginManagerLock);

    const auto path = normalisePath(directoryPath);
    if (path.isEmpty() || !juce::File(path).isDirectory())
        return false;

    if (containsNormalisedPath(customPluginSearchPaths, path))
        return true;

    customPluginSearchPaths.add(path);
    if (savePluginSearchPaths())
    {
        liveLv2PathsNeedPriming = true;
        ++pluginStateRevision;
        return true;
    }

    customPluginSearchPaths.removeString(path, shouldIgnorePathCase());
    return false;
}

bool PluginManager::removePluginSearchPath(const juce::String& directoryPath)
{
    const juce::ScopedLock managerLock(pluginManagerLock);

    const auto path = normalisePath(directoryPath);
    const int index = customPluginSearchPaths.indexOf(path, shouldIgnorePathCase());
    if (index < 0)
        return false;

    const auto removedPath = customPluginSearchPaths[index];
    customPluginSearchPaths.remove(index);
    if (savePluginSearchPaths())
    {
        liveLv2PathsNeedPriming = true;
        ++pluginStateRevision;
        return true;
    }

    customPluginSearchPaths.insert(index, removedPath);
    return false;
}

// ---- S13FX / JSFX scanning ----

juce::File PluginManager::getUserEffectsDirectory()
{
    auto openStudioDir = getOpenStudioDocumentsDirectory().getChildFile("Effects");
    auto legacyDir = getLegacyStudio13DocumentsDirectory().getChildFile("Effects");

    if (!openStudioDir.isDirectory() && legacyDir.isDirectory())
        return legacyDir;

    return openStudioDir;
}

juce::File PluginManager::getStockEffectsDirectory()
{
    auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getParentDirectory();

   #if JUCE_MAC
    auto bundleResources = exeDir.getParentDirectory().getChildFile("Resources").getChildFile("effects");
    if (bundleResources.isDirectory())
        return bundleResources;
   #endif

    return exeDir.getChildFile("effects");
}

void PluginManager::scanForS13FX()
{
    std::vector<S13FXInfo> discoveredEffects;

    // Scan stock effects (bundled with app)
    auto stockDir = getStockEffectsDirectory();
    if (stockDir.isDirectory())
        scanDirectory(stockDir, true, discoveredEffects);

    // Scan user effects
    auto userDir = getUserEffectsDirectory();
    if (userDir.isDirectory())
        scanDirectory(userDir, false, discoveredEffects);

    const auto discoveredCount = discoveredEffects.size();
    {
        const juce::ScopedLock managerLock(pluginManagerLock);
        s13fxList = std::move(discoveredEffects);
    }

    juce::Logger::writeToLog("PluginManager: Found " + juce::String(discoveredCount) + " S13FX/JSFX scripts");
}

void PluginManager::scanDirectory(const juce::File& dir,
                                  bool isStock,
                                  std::vector<S13FXInfo>& destination)
{
    juce::Array<juce::File> files;
    dir.findChildFiles(files, juce::File::findFiles, true, "*.jsfx;*.s13fx");

    for (const auto& file : files)
    {
        S13FXInfo info;
        info.filePath = file.getFullPathName();
        info.isStock = isStock;

        // Try to extract metadata by loading the script header (first 50 lines)
        juce::StringArray lines;
        file.readLines(lines);

        info.name = file.getFileNameWithoutExtension();

        for (int i = 0; i < juce::jmin(lines.size(), 50); ++i)
        {
            auto line = lines[i].trim();

            if (line.startsWith("desc:"))
                info.name = line.fromFirstOccurrenceOf("desc:", false, false).trim();
            else if (line.startsWith("author:"))
                info.author = line.fromFirstOccurrenceOf("author:", false, false).trim();
            else if (line.startsWith("tags:"))
            {
                auto tagStr = line.fromFirstOccurrenceOf("tags:", false, false).trim();
                info.tags.addTokens(tagStr, " ", "");
            }
        }

        juce::Logger::writeToLog("PluginManager: Found S13FX: " + info.name +
                                 (isStock ? " (stock)" : " (user)"));
        destination.push_back(std::move(info));
    }
}

// ---- Plugin crash isolation (blacklist) ----

bool PluginManager::isPluginBlacklisted(const juce::String& pluginId) const
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    return containsPluginIdentifier(blacklistedPlugins, pluginId);
}

void PluginManager::blacklistPlugin(const juce::String& pluginId)
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    const auto normalisedPluginId = normaliseCandidateIdentifier(pluginId);
    if (normalisedPluginId.isNotEmpty()
        && !containsPluginIdentifier(blacklistedPlugins, normalisedPluginId))
    {
        blacklistedPlugins.add(normalisedPluginId);
        blacklistFile.getParentDirectory().createDirectory();
        blacklistFile.replaceWithText(blacklistedPlugins.joinIntoString("\n"));
        ++pluginStateRevision;
        juce::Logger::writeToLog("PluginManager: Blacklisted plugin: " + normalisedPluginId);
    }
}

bool PluginManager::removeFromBlacklist(const juce::String& pluginId)
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    const auto normalisedPluginId = normaliseCandidateIdentifier(pluginId);
    int idx = indexOfPluginIdentifier(blacklistedPlugins, normalisedPluginId);
    if (idx >= 0)
    {
        const auto removedPluginId = blacklistedPlugins[idx];
        blacklistedPlugins.remove(idx);
        if (blacklistFile.replaceWithText(blacklistedPlugins.joinIntoString("\n")))
        {
            ++pluginStateRevision;
            juce::Logger::writeToLog("PluginManager: Removed from blacklist for retry: " + pluginId);
            return true;
        }

        blacklistedPlugins.insert(idx, removedPluginId);
    }

    return false;
}

juce::StringArray PluginManager::getBlacklistedPlugins() const
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    return blacklistedPlugins;
}

bool PluginManager::isARAPlugin(const juce::PluginDescription& description) const
{
    // ARA plugins are VST3 or AU plugins that expose an ARA factory.
    // We detect this by loading the plugin and checking for ARA support.
    // For efficiency, we check the description's hasARAExtension flag
    // (available since JUCE 7 for scanned plugins).
    return description.hasARAExtension;
}

juce::Array<juce::PluginDescription> PluginManager::getARAPlugins() const
{
    const juce::ScopedLock managerLock(pluginManagerLock);
    juce::Array<juce::PluginDescription> araPlugins;
    for (const auto& desc : knownPluginList.getTypes())
    {
        if (desc.hasARAExtension)
            araPlugins.add(desc);
    }
    return araPlugins;
}
