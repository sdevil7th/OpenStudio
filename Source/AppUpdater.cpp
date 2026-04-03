#include "AppUpdater.h"
#include <thread>

namespace
{
struct ParsedUpdateFeed
{
    juce::String version;
    juce::String downloadUrl;
    juce::String sha256;
    juce::String notes;
    juce::String releasePageUrl;
    juce::String releaseNotesUrl;
    juce::String publishedAt;
    juce::String fileName;
    juce::String channel;
    juce::String minimumSupportedVersion;
    juce::String installerArguments;
    juce::String source;
    juce::int64 expectedSize = 0;
};

juce::String getStringProperty(const juce::var& value, const juce::Identifier& property)
{
    if (auto* obj = value.getDynamicObject())
        return obj->getProperty(property).toString();

    return {};
}

juce::int64 getInt64Property(const juce::var& value, const juce::Identifier& property, juce::int64 fallback = 0)
{
    if (auto* obj = value.getDynamicObject())
    {
        const auto prop = obj->getProperty(property);
        if (prop.isInt() || prop.isInt64() || prop.isDouble())
            return static_cast<juce::int64>(prop);
    }

    return fallback;
}

bool getBoolProperty(const juce::var& value, const juce::Identifier& property, bool fallback = false)
{
    if (auto* obj = value.getDynamicObject())
    {
        const auto prop = obj->getProperty(property);
        if (prop.isBool())
            return static_cast<bool>(prop);
    }

    return fallback;
}

juce::File getOpenStudioAppDataDirectory()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio");
}

juce::File getLegacyStudio13AppDataDirectory()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("Studio13");
}

juce::File getPreferredUpdaterStateFile()
{
    auto openStudioDir = getOpenStudioAppDataDirectory();
    auto legacyStateFile = getLegacyStudio13AppDataDirectory().getChildFile("updater-state.json");
    auto preferredDir = (!openStudioDir.exists() && legacyStateFile.existsAsFile())
        ? getLegacyStudio13AppDataDirectory()
        : openStudioDir;

    return preferredDir.getChildFile("updater-state.json");
}

constexpr juce::int64 kAutomaticUpdateCheckIntervalMs = 24LL * 60LL * 60LL * 1000LL;

bool looksLikeXml(const juce::String& text)
{
    const auto trimmed = text.trimStart();
    return trimmed.startsWithChar('<');
}

bool xmlNameMatches(const juce::String& actualName, const juce::String& expectedLocalName)
{
    return actualName == expectedLocalName || actualName.endsWith(":" + expectedLocalName);
}

juce::String getXmlAttribute(const juce::XmlElement& element, std::initializer_list<const char*> names)
{
    for (const auto* name : names)
    {
        const auto value = element.getStringAttribute(name).trim();
        if (value.isNotEmpty())
            return value;
    }

    return {};
}

juce::String getXmlChildText(const juce::XmlElement& parent, std::initializer_list<const char*> names)
{
    forEachXmlChildElement (parent, child)
    {
        for (const auto* name : names)
        {
            if (xmlNameMatches(child->getTagName(), name))
            {
                const auto value = child->getAllSubText().trim();
                if (value.isNotEmpty())
                    return value;
            }
        }
    }

    return {};
}
}

AppUpdater::AppUpdater()
{
    const auto stateFile = getPreferredUpdaterStateFile();
    if (stateFile.existsAsFile())
    {
        auto parsed = juce::JSON::parse(stateFile.loadFileAsString());
        if (parsed.isObject())
            persistedState = parsed;
    }

    publishStatus(makeStatus("idle", "Updater ready", {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel()));
}

AppUpdater::~AppUpdater() = default;

juce::String AppUpdater::getCurrentVersion() const
{
    return ProjectInfo::versionString;
}

juce::var AppUpdater::getLastStatus() const
{
    const juce::ScopedLock lock(stateLock);
    return lastStatus;
}

void AppUpdater::setStatusCallback(StatusCallback callback)
{
    const juce::ScopedLock lock(stateLock);
    statusCallback = std::move(callback);
}

void AppUpdater::checkForUpdates(bool manual, Completion completion)
{
    if (checkInProgress.exchange(true))
    {
        auto busy = makeStatus("busy", "An update check is already running.", {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel());
        publishStatus(busy);

        if (completion)
            juce::MessageManager::callAsync([completion, busy]() { completion(busy); });

        return;
    }

    if (!manual && shouldSkipAutomaticCheck())
    {
        checkInProgress = false;
        auto skipped = makeStatus("skipped",
                                  "Automatic update check skipped until the next scheduled window.",
                                  {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel());
        publishStatus(skipped);

        if (completion)
            juce::MessageManager::callAsync([completion, skipped]() { completion(skipped); });

        return;
    }

    publishStatus(makeStatus("checking",
                             manual ? "Checking for updates..." : "Checking for updates in the background...",
                             {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel()));

    std::thread([this, completion = std::move(completion)]() mutable
    {
        auto result = performUpdateCheck();
        checkInProgress = false;

        juce::MessageManager::callAsync([this, completion = std::move(completion), result]() mutable
        {
            publishStatus(result);
            if (completion)
                completion(result);
        });
    }).detach();
}

void AppUpdater::downloadAndInstallUpdate(const juce::String& downloadUrl,
                                          const juce::String& version,
                                          const juce::String& expectedSha256,
                                          const juce::String& releasePageUrl,
                                          const juce::String& installerArguments,
                                          juce::int64 expectedSize,
                                          Completion completion)
{
    if (installInProgress.exchange(true))
    {
        auto busy = makeStatus("busy", "An update download is already running.", version, downloadUrl, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, {}, getCurrentChannel(), false, installerArguments);
        publishStatus(busy);

        if (completion)
            juce::MessageManager::callAsync([completion, busy]() { completion(busy); });

        return;
    }

    publishStatus(makeStatus("downloading", "Downloading update...", version, downloadUrl, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, {}, getCurrentChannel(), false, installerArguments));

    std::thread([this, completion = std::move(completion), downloadUrl, version, expectedSha256, releasePageUrl, installerArguments, expectedSize]() mutable
    {
        auto result = performDownloadAndInstall(downloadUrl, version, expectedSha256, releasePageUrl, installerArguments, expectedSize);
        installInProgress = false;

        juce::MessageManager::callAsync([this, completion = std::move(completion), result]() mutable
        {
            publishStatus(result);
            if (completion)
                completion(result);
        });
    }).detach();
}

juce::var AppUpdater::performUpdateCheck()
{
    const auto manifestUrl = getManifestUrl().trim();
    const auto appcastUrl = getAppcastUrl().trim();
    const auto currentChannel = getCurrentChannel();

    if (manifestUrl.isEmpty() && appcastUrl.isEmpty())
        return makeStatus("error", "No update feed URL is configured.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

    auto buildStatusFromFeed = [this, currentChannel](const ParsedUpdateFeed& feed, const juce::String& invalidFeedMessage)
    {
        const auto latestVersion = feed.version.trim();
        if (latestVersion.isEmpty())
            return makeStatus("error", invalidFeedMessage, {}, {}, {}, {}, feed.releasePageUrl, feed.releaseNotesUrl, feed.publishedAt, 0, {}, currentChannel, false, {}, feed.source);

        const auto feedChannel = feed.channel.trim().isNotEmpty() ? feed.channel.trim() : currentChannel;
        auto releasePageUrl = feed.releasePageUrl.trim();
        if (releasePageUrl.isEmpty())
            releasePageUrl = getFallbackReleasesPageUrl();

        const auto isMandatory = feed.minimumSupportedVersion.isNotEmpty()
            && compareVersions(getCurrentVersion(), feed.minimumSupportedVersion) < 0;

        if (feedChannel != currentChannel)
            return makeStatus("error",
                              "The update feed channel does not match this build.",
                              latestVersion, {}, feed.sha256, feed.notes, releasePageUrl, feed.releaseNotesUrl, feed.publishedAt,
                              feed.expectedSize, feed.fileName, feedChannel, isMandatory, feed.installerArguments, feed.source);

        if (feed.downloadUrl.trim().isEmpty())
            return makeStatus("error",
                              "The update feed does not include a download for this platform.",
                              latestVersion, {}, feed.sha256, feed.notes, releasePageUrl, feed.releaseNotesUrl, feed.publishedAt,
                              feed.expectedSize, feed.fileName, feedChannel, isMandatory, feed.installerArguments, feed.source);

        recordSuccessfulCheck(latestVersion, feed.publishedAt);

        if (compareVersions(latestVersion, getCurrentVersion()) <= 0)
            return makeStatus("up-to-date", "OpenStudio is already up to date.",
                              latestVersion, feed.downloadUrl, feed.sha256, feed.notes, releasePageUrl, feed.releaseNotesUrl, feed.publishedAt,
                              feed.expectedSize, feed.fileName, feedChannel, isMandatory, feed.installerArguments, feed.source);

        return makeStatus("update-available",
                          isMandatory
                              ? "A required OpenStudio update is available."
                              : "OpenStudio " + latestVersion + " is available.",
                          latestVersion, feed.downloadUrl, feed.sha256, feed.notes, releasePageUrl, feed.releaseNotesUrl, feed.publishedAt,
                          feed.expectedSize, feed.fileName, feedChannel, isMandatory, feed.installerArguments, feed.source);
    };

    auto parseJsonManifest = [this, currentChannel, &buildStatusFromFeed](const juce::String& manifestText)
    {
        auto parsed = juce::JSON::parse(manifestText);
        if (!parsed.isObject())
            return makeStatus("error", "The update manifest is invalid JSON.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        const auto schemaVersion = getInt64Property(parsed, "schemaVersion", 1);
        if (schemaVersion > 1)
            return makeStatus("error", "This OpenStudio build cannot read the published update manifest format yet.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        ParsedUpdateFeed feed;
        feed.source = "json-manifest";
        feed.version = getStringProperty(parsed, "version").trim();
        feed.notes = getStringProperty(parsed, "notes");
        feed.publishedAt = getStringProperty(parsed, "publishedAt");
        feed.releasePageUrl = getStringProperty(parsed, "releasePageUrl").trim();
        feed.releaseNotesUrl = getStringProperty(parsed, "fullReleaseNotesUrl").trim();
        feed.channel = getStringProperty(parsed, "channel").trim();
        feed.minimumSupportedVersion = getStringProperty(parsed, "minimumSupportedVersion").trim();

        const auto platformKey = getPlatformKey();
        juce::var platformNode;

        if (auto* manifestObj = parsed.getDynamicObject())
        {
            auto platforms = manifestObj->getProperty("platforms");
            if (auto* platformsObj = platforms.getDynamicObject())
                platformNode = platformsObj->getProperty(platformKey);

            if (platformNode.isVoid())
                platformNode = manifestObj->getProperty(platformKey);
        }

        feed.downloadUrl = getStringProperty(platformNode, "url").trim();
        feed.sha256 = getStringProperty(platformNode, "sha256").trim();
        feed.fileName = getStringProperty(platformNode, "fileName").trim();
        feed.expectedSize = getInt64Property(platformNode, "size", 0);
        feed.installerArguments = getStringProperty(platformNode, "installerArguments").trim();

        return buildStatusFromFeed(feed, "The update manifest does not include a version.");
    };

    auto parseAppcast = [this, currentChannel, &buildStatusFromFeed](const juce::String& xmlText)
    {
        std::unique_ptr<juce::XmlElement> xml(juce::XmlDocument::parse(xmlText));
        if (xml == nullptr)
            return makeStatus("error", "The update appcast is invalid XML.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        juce::XmlElement* channel = nullptr;
        if (xmlNameMatches(xml->getTagName(), "rss"))
            channel = xml->getChildByName("channel");
        else if (xmlNameMatches(xml->getTagName(), "channel"))
            channel = xml.get();

        if (channel == nullptr)
            return makeStatus("error", "The update appcast does not contain a channel.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        juce::XmlElement* item = nullptr;
        forEachXmlChildElement (*channel, child)
        {
            if (xmlNameMatches(child->getTagName(), "item"))
            {
                item = child;
                break;
            }
        }

        if (item == nullptr)
            return makeStatus("error", "The update appcast does not contain a release item.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        auto* enclosure = item->getChildByName("enclosure");
        if (enclosure == nullptr)
            return makeStatus("error", "The update appcast does not contain a downloadable enclosure.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        ParsedUpdateFeed feed;
        feed.source = "appcast";
        feed.version = getXmlAttribute(*enclosure, { "sparkle:shortVersionString", "sparkle:version", "version" }).trim();
        feed.downloadUrl = getXmlAttribute(*enclosure, { "url" }).trim();
        feed.sha256 = getXmlAttribute(*enclosure, { "openstudio:sha256", "sha256" }).trim();
        feed.fileName = getXmlAttribute(*enclosure, { "openstudio:fileName", "fileName" }).trim();
        feed.channel = getXmlAttribute(*enclosure, { "openstudio:channel", "channel" }).trim();
        feed.minimumSupportedVersion = getXmlAttribute(*enclosure, { "openstudio:minimumSupportedVersion", "minimumSupportedVersion" }).trim();
        feed.installerArguments = getXmlAttribute(*enclosure, { "sparkle:installerArguments", "openstudio:installerArguments", "installerArguments" }).trim();
        feed.expectedSize = getXmlAttribute(*enclosure, { "length" }).getLargeIntValue();
        feed.notes = getXmlChildText(*item, { "description" });
        feed.releasePageUrl = getXmlChildText(*channel, { "link" }).trim();
        feed.releaseNotesUrl = getXmlChildText(*item, { "releaseNotesLink" }).trim();
        feed.publishedAt = getXmlChildText(*item, { "pubDate" }).trim();

        if (feed.fileName.isEmpty() && feed.downloadUrl.isNotEmpty())
            feed.fileName = getDownloadFileName(juce::URL(feed.downloadUrl), feed.version);

        return buildStatusFromFeed(feed, "The update appcast does not include a version.");
    };

    auto tryFeedUrl = [&](const juce::String& feedUrl, bool forceXml)
    {
        const auto trimmedUrl = feedUrl.trim();
        if (trimmedUrl.isEmpty())
            return makeStatus("error", "No update feed URL is configured.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        auto feedText = juce::URL(trimmedUrl).readEntireTextStream(false).trim();
        if (feedText.isEmpty())
            return makeStatus("error", "Could not reach the update server.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

        if (forceXml || looksLikeXml(feedText))
            return parseAppcast(feedText);

        return parseJsonManifest(feedText);
    };

    juce::var lastFailure = makeStatus("error", "Could not reach the update server.", {}, {}, {}, {}, {}, {}, {}, 0, {}, currentChannel);

    if (manifestUrl.isNotEmpty())
    {
        auto manifestResult = tryFeedUrl(manifestUrl, false);
        if (getStringProperty(manifestResult, "status") != "error")
            return manifestResult;
        lastFailure = manifestResult;
    }

    if (appcastUrl.isNotEmpty() && appcastUrl != manifestUrl)
    {
        auto appcastResult = tryFeedUrl(appcastUrl, true);
        if (getStringProperty(appcastResult, "status") != "error")
            return appcastResult;
        lastFailure = appcastResult;
    }

    return lastFailure;
}

juce::var AppUpdater::performDownloadAndInstall(const juce::String& downloadUrl,
                                                const juce::String& version,
                                                const juce::String& expectedSha256,
                                                const juce::String& releasePageUrl,
                                                const juce::String& installerArguments,
                                                juce::int64 expectedSize) const
{
    const auto currentChannel = getCurrentChannel();

    if (downloadUrl.trim().isEmpty())
    {
        if (releasePageUrl.isNotEmpty())
        {
            juce::URL(releasePageUrl).launchInDefaultBrowser();
            return makeStatus("release-page-opened",
                              "Opened the release page in your browser.",
                              version, {}, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, {}, currentChannel, false, installerArguments);
        }

        return makeStatus("error", "No download URL was provided for this update.", version, {}, expectedSha256, {}, {}, {}, {}, expectedSize, {}, currentChannel, false, installerArguments);
    }

    const juce::URL url(downloadUrl);
    const auto fileName = getDownloadFileName(url, version);
    auto updateDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("OpenStudio")
                         .getChildFile("updates");
    updateDir.createDirectory();

    const auto installerFile = updateDir.getChildFile(fileName);
    juce::String error;

    if (!downloadToFile(url, installerFile, error))
    {
        if (releasePageUrl.isNotEmpty())
            juce::URL(releasePageUrl).launchInDefaultBrowser();

        return makeStatus("error",
                          error.isNotEmpty() ? error : "The update download failed.",
                          version, downloadUrl, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, installerFile.getFileName(), currentChannel, false, installerArguments);
    }

    if (!verifyDownloadedFileSize(installerFile, expectedSize, error))
        return makeStatus("error",
                          error.isNotEmpty() ? error : "The downloaded update did not match the published size.",
                          version, downloadUrl, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, installerFile.getFileName(), currentChannel, false, installerArguments);

    if (!verifyDownloadedFileSha256(installerFile, expectedSha256, error))
        return makeStatus("error",
                          error.isNotEmpty() ? error : "The downloaded update did not match the published checksum.",
                          version, downloadUrl, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, installerFile.getFileName(), currentChannel, false, installerArguments);

    if (!launchDownloadedInstaller(installerFile, installerArguments, error))
        return makeStatus("error",
                          error.isNotEmpty() ? error : "The update downloaded, but the installer could not be opened.",
                          version, downloadUrl, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, installerFile.getFileName(), currentChannel, false, installerArguments);

   #if JUCE_MAC
    const auto successMessage = "The update DMG has been opened. Drag OpenStudio to Applications, then use right-click > Open if macOS warns about an unidentified developer.";
   #elif JUCE_WINDOWS
    const auto successMessage = "The update installer has been opened.";
   #else
    const auto successMessage = "The update package has been opened.";
   #endif

    return makeStatus("install-started",
                      successMessage,
                      version, downloadUrl, expectedSha256, {}, releasePageUrl, {}, {}, expectedSize, installerFile.getFileName(), currentChannel, false, installerArguments);
}

void AppUpdater::publishStatus(const juce::var& status)
{
    StatusCallback callbackCopy;

    {
        const juce::ScopedLock lock(stateLock);
        lastStatus = status;
        callbackCopy = statusCallback;
    }

    if (callbackCopy)
        callbackCopy(status);
}

juce::String AppUpdater::getManifestUrl()
{
   #ifdef OPENSTUDIO_UPDATE_MANIFEST_URL
    return juce::String(OPENSTUDIO_UPDATE_MANIFEST_URL);
   #else
    return {};
   #endif
}

juce::String AppUpdater::getAppcastUrl()
{
   #ifdef OPENSTUDIO_UPDATE_APPCAST_URL
    return juce::String(OPENSTUDIO_UPDATE_APPCAST_URL);
   #else
    return {};
   #endif
}

juce::String AppUpdater::getFallbackReleasesPageUrl()
{
   #ifdef OPENSTUDIO_RELEASES_PAGE_URL
    return juce::String(OPENSTUDIO_RELEASES_PAGE_URL);
   #else
    return {};
   #endif
}

juce::String AppUpdater::getPlatformKey()
{
   #if JUCE_WINDOWS
    return "windows";
   #elif JUCE_MAC
    return "macos";
   #else
    return "unsupported";
   #endif
}

juce::String AppUpdater::getCurrentChannel()
{
   #ifdef OPENSTUDIO_UPDATE_CHANNEL
    return juce::String(OPENSTUDIO_UPDATE_CHANNEL);
   #else
    return "stable";
   #endif
}

bool AppUpdater::shouldSkipAutomaticCheck() const
{
    const juce::ScopedLock lock(stateLock);
    const auto lastSuccessfulCheckAtMs = getInt64Property(persistedState, "lastSuccessfulCheckAtMs", 0);

    if (lastSuccessfulCheckAtMs <= 0)
        return false;

    const auto elapsedMs = juce::Time::getCurrentTime().toMilliseconds() - lastSuccessfulCheckAtMs;
    return elapsedMs >= 0 && elapsedMs < kAutomaticUpdateCheckIntervalMs;
}

void AppUpdater::recordSuccessfulCheck(const juce::String& latestVersion, const juce::String& publishedAt)
{
    const juce::ScopedLock lock(stateLock);

    auto* stateObject = persistedState.getDynamicObject();
    if (stateObject == nullptr)
    {
        persistedState = juce::var(new juce::DynamicObject());
        stateObject = persistedState.getDynamicObject();
    }

    stateObject->setProperty("lastSuccessfulCheckAtMs", juce::Time::getCurrentTime().toMilliseconds());
    stateObject->setProperty("lastSeenVersion", latestVersion);
    stateObject->setProperty("lastPublishedAt", publishedAt);
    stateObject->setProperty("channel", getCurrentChannel());
    savePersistedState();
}

void AppUpdater::savePersistedState() const
{
    const auto stateFile = getPreferredUpdaterStateFile();
    stateFile.getParentDirectory().createDirectory();
    stateFile.replaceWithText(juce::JSON::toString(persistedState));
}

int AppUpdater::compareVersions(const juce::String& lhs, const juce::String& rhs)
{
    const auto left = tokenizeVersion(lhs);
    const auto right = tokenizeVersion(rhs);
    const auto count = juce::jmax(left.size(), right.size());

    for (int i = 0; i < count; ++i)
    {
        const auto leftValue = i < left.size() ? left[i].getIntValue() : 0;
        const auto rightValue = i < right.size() ? right[i].getIntValue() : 0;

        if (leftValue < rightValue)
            return -1;
        if (leftValue > rightValue)
            return 1;
    }

    return 0;
}

juce::StringArray AppUpdater::tokenizeVersion(const juce::String& version)
{
    auto cleaned = version.retainCharacters("0123456789.");
    if (cleaned.isEmpty())
        cleaned = "0";

    juce::StringArray tokens;
    tokens.addTokens(cleaned, ".", {});
    tokens.removeEmptyStrings();

    if (tokens.isEmpty())
        tokens.add("0");

    return tokens;
}

juce::String AppUpdater::getDownloadFileName(const juce::URL& url, const juce::String& version)
{
    auto path = url.toString(false);
    auto slash = path.lastIndexOfChar('/');
    auto candidate = slash >= 0 ? path.substring(slash + 1) : path;

    if (candidate.containsChar('?'))
        candidate = candidate.upToFirstOccurrenceOf("?", false, false);

    if (candidate.isNotEmpty())
        return candidate;

   #if JUCE_WINDOWS
    return "OpenStudio-" + version + "-Setup.exe";
   #elif JUCE_MAC
    return "OpenStudio-" + version + ".dmg";
   #else
    return "OpenStudio-" + version;
   #endif
}

bool AppUpdater::downloadToFile(const juce::URL& url, const juce::File& targetFile, juce::String& error)
{
    const auto tempFile = targetFile.getSiblingFile(targetFile.getFileName() + ".download");
    tempFile.deleteFile();

    auto input = url.createInputStream(
        juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(15000)
            .withNumRedirectsToFollow(5));

    if (input == nullptr)
    {
        error = "Could not connect to the update download URL.";
        return false;
    }

    juce::FileOutputStream output(tempFile);
    if (!output.openedOk())
    {
        error = "Could not create a temporary installer file.";
        return false;
    }

    if (output.writeFromInputStream(*input, -1) <= 0)
    {
        error = "The installer download was incomplete.";
        tempFile.deleteFile();
        return false;
    }

    output.flush();

    if (targetFile.existsAsFile() && !targetFile.deleteFile())
    {
        error = "Could not replace the previous downloaded installer.";
        tempFile.deleteFile();
        return false;
    }

    if (!tempFile.moveFileTo(targetFile))
    {
        error = "Could not move the downloaded installer into place.";
        tempFile.deleteFile();
        return false;
    }

    return true;
}

bool AppUpdater::verifyDownloadedFileSize(const juce::File& targetFile, juce::int64 expectedSize, juce::String& error)
{
    if (expectedSize <= 0)
        return true;

    if (!targetFile.existsAsFile())
    {
        error = "The downloaded installer file could not be found for size verification.";
        return false;
    }

    if (targetFile.getSize() == expectedSize)
        return true;

    error = "The downloaded update failed size verification.";
    return false;
}

bool AppUpdater::verifyDownloadedFileSha256(const juce::File& targetFile, const juce::String& expectedSha256, juce::String& error)
{
    const auto normalizedExpected = expectedSha256.trim().toLowerCase();
    if (normalizedExpected.isEmpty())
        return true;

    if (!targetFile.existsAsFile())
    {
        error = "The downloaded installer file could not be found for checksum verification.";
        return false;
    }

    juce::FileInputStream input(targetFile);
    if (!input.openedOk())
    {
        error = "OpenStudio could not read the downloaded update to verify it.";
        return false;
    }

    const auto actual = juce::SHA256(input).toHexString().toLowerCase();
    if (actual == normalizedExpected)
        return true;

    error = "The downloaded update failed checksum verification.";
    return false;
}

bool AppUpdater::launchDownloadedInstaller(const juce::File& installerFile,
                                           const juce::String& installerArguments,
                                           juce::String& error)
{
    if (!installerFile.existsAsFile())
    {
        error = "The downloaded installer file could not be found.";
        return false;
    }

    if (installerFile.startAsProcess(installerArguments.trim()))
        return true;

    if (juce::URL(installerFile).launchInDefaultBrowser())
        return true;

    error = "The update was downloaded, but OpenStudio could not open it automatically.";
    return false;
}

juce::var AppUpdater::makeStatus(const juce::String& status,
                                 const juce::String& message,
                                 const juce::String& version,
                                 const juce::String& downloadUrl,
                                 const juce::String& sha256,
                                 const juce::String& notes,
                                 const juce::String& releasePageUrl,
                                 const juce::String& releaseNotesUrl,
                                 const juce::String& publishedAt,
                                 juce::int64 expectedSize,
                                 const juce::String& fileName,
                                 const juce::String& channel,
                                 bool mandatory,
                                 const juce::String& installerArguments,
                                 const juce::String& updateSource)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("status", status);
    obj->setProperty("message", message);
    obj->setProperty("version", version);
    obj->setProperty("downloadUrl", downloadUrl);
    obj->setProperty("sha256", sha256);
    obj->setProperty("notes", notes);
    obj->setProperty("releasePageUrl", releasePageUrl);
    obj->setProperty("releaseNotesUrl", releaseNotesUrl);
    obj->setProperty("publishedAt", publishedAt);
    obj->setProperty("size", expectedSize);
    obj->setProperty("fileName", fileName);
    obj->setProperty("channel", channel.isNotEmpty() ? channel : getCurrentChannel());
    obj->setProperty("mandatory", mandatory);
    obj->setProperty("installerArguments", installerArguments);
    obj->setProperty("updateSource", updateSource);
    obj->setProperty("currentVersion", ProjectInfo::versionString);
    obj->setProperty("platform", getPlatformKey());
    return juce::var(obj);
}
