#include "AppUpdater.h"
#include "WindowsPackage.h"
#include <thread>

namespace
{
#if JUCE_DEBUG
constexpr bool isDevelopmentBuild = true;
#else
constexpr bool isDevelopmentBuild = false;
#endif
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

juce::File getPreferredUpdaterStateFile()
{
    return getOpenStudioAppDataDirectory().getChildFile("updater-state.json");
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
    for (auto* child = parent.getFirstChildElement(); child != nullptr; child = child->getNextElement())
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
    if (WindowsPackage::isStoreManaged())
    {
        storeUpdater = std::make_unique<StoreUpdater>([this](const juce::var& status) { publishStatus(status); });
        return;
    }
    const auto stateFile = getPreferredUpdaterStateFile();
    if (stateFile.existsAsFile())
    {
        auto parsed = juce::JSON::parse(stateFile.loadFileAsString());
        if (parsed.isObject())
            persistedState = parsed;
    }

    publishStatus(makeStatus(isDevelopmentBuild ? "development" : "idle",
                            isDevelopmentBuild ? "Development build: update installers are disabled. Build this checkout to update it." : "Updater ready",
                            {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel()));
}

AppUpdater::~AppUpdater() { shutdown(); }
void AppUpdater::shutdown() { if (storeUpdater) storeUpdater->shutdown(); jobs.shutdown(); setStatusCallback({}); }

bool AppUpdater::rejectDevelopmentUpdate(const Completion& completion)
{
    if (!isDevelopmentBuild) return false;
    const auto result = makeStatus("development",
        "Development build: update installers are disabled. Build this checkout to update it.");
    publishStatus(result);
    if (completion) completion(result);
    return true;
}

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
    if (!MessageThreadLifetime::accepts(jobs.token())) return;
    if (storeUpdater) { storeUpdater->check(manual, std::move(completion)); return; }
    if (rejectDevelopmentUpdate(completion)) return;
    if (installInProgress.load() || getStringProperty(getLastStatus(), "status") == "download-ready")
    {
        if (completion) completion(getLastStatus());
        return;
    }
    if (checkInProgress.exchange(true))
    {
        auto busy = makeStatus("busy", "An update check is already running.", {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel());

        if (completion)
            juce::MessageManager::callAsync([completion, busy, alive = jobs.token()]() { if (MessageThreadLifetime::accepts(alive)) completion(busy); });

        return;
    }

    if (!manual && shouldSkipAutomaticCheck())
    {
        checkInProgress = false;
        auto skipped = makeStatus("skipped",
                                  "Automatic update check skipped until the next scheduled window.",
                                  {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel());

        if (completion)
            juce::MessageManager::callAsync([completion, skipped, alive = jobs.token()]() { if (MessageThreadLifetime::accepts(alive)) completion(skipped); });

        return;
    }

    publishStatus(makeStatus("checking",
                             manual ? "Checking for updates..." : "Checking for updates in the background...",
                             {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel()));

    jobs.addJob([this, alive = jobs.token(), completion = std::move(completion)]() mutable
    {
        auto result = performUpdateCheck();
        juce::MessageManager::callAsync([this, alive, completion = std::move(completion), result]() mutable
        {
            if (!MessageThreadLifetime::accepts(alive)) return;
            checkInProgress = false;
            {
                const juce::ScopedLock lock(stateLock);
                if (getStringProperty(result, "status") == "update-available") availableUpdate = result.clone();
                else availableUpdate = juce::var();
            }
            publishStatus(result);
            if (completion)
                completion(result);
        });
    });
}

void AppUpdater::downloadUpdate(Completion completion)
{
    if (!MessageThreadLifetime::accepts(jobs.token())) return;
    if (storeUpdater) { storeUpdater->download(std::move(completion)); return; }
    if (rejectDevelopmentUpdate(completion)) return;
    if (checkInProgress.load() || installInProgress.exchange(true))
    {
        if (completion) completion(getLastStatus());
        return;
    }
    juce::var offer;
    {
        const juce::ScopedLock lock(stateLock);
        offer = availableUpdate.clone();
    }
    cancelRequested = false;
    auto starting = offer.isObject() ? offer.clone() : makeStatus("downloading", "Downloading update...");
    starting.getDynamicObject()->setProperty("status", "downloading");
    starting.getDynamicObject()->setProperty("message", "Downloading update...");
    publishStatus(starting);
    jobs.addJob([this, alive = jobs.token(), offer, completion = std::move(completion)]() mutable
    {
        auto result = performDownload(offer);
        juce::MessageManager::callAsync([this, alive, completion = std::move(completion), result]() mutable
        {
            if (!MessageThreadLifetime::accepts(alive)) return;
            installInProgress = false;
            publishStatus(result);
            if (completion) completion(result);
        });
    });
}

void AppUpdater::cancelDownload() { if (storeUpdater) storeUpdater->cancel(); else cancelRequested = true; }

void AppUpdater::installDownloadedUpdate(Completion completion)
{
    if (!MessageThreadLifetime::accepts(jobs.token())) return;
    if (storeUpdater) { storeUpdater->install(std::move(completion)); return; }
    if (rejectDevelopmentUpdate(completion)) return;
    if (checkInProgress.load() || installInProgress.exchange(true))
    {
        if (completion) completion(getLastStatus());
        return;
    }
    auto status = getLastStatus().clone();
    status.getDynamicObject()->setProperty("status", "installing");
    status.getDynamicObject()->setProperty("message", "Verifying update before opening...");
    publishStatus(status);
    jobs.addJob([this, alive = jobs.token(), completion = std::move(completion)]() mutable
    {
        const auto result = performInstall();
        juce::MessageManager::callAsync([this, alive, completion = std::move(completion), result]() mutable
        {
            if (!MessageThreadLifetime::accepts(alive)) return;
            installInProgress = false;
            publishStatus(result);
            if (completion) completion(result);
        });
    });
}

juce::var AppUpdater::performUpdateCheck()
{
    if (WindowsPackage::isStoreManaged()) return makeStatus("error", "This installation uses Microsoft Store package updates.");
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

        juce::String downloadError;
        if (!validateUpdateDownload(feed.downloadUrl, feed.sha256, feed.expectedSize, downloadError))
            return makeStatus("error", downloadError, latestVersion, {}, {}, {}, releasePageUrl);
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
        for (auto* child = channel->getFirstChildElement(); child != nullptr; child = child->getNextElement())
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
        if (juce::URL(trimmedUrl).getScheme().toLowerCase() != "https")
            return makeStatus("error", "The update feed must use HTTPS.");

        if (!MessageThreadLifetime::accepts(jobs.token())) return makeStatus("cancelled", "Update check cancelled during shutdown");
        auto stream = juce::URL(trimmedUrl).createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(5000).withNumRedirectsToFollow(5));
        juce::MemoryOutputStream feed;
        char chunk[8192];
        while (stream && !stream->isExhausted() && MessageThreadLifetime::accepts(jobs.token()) && feed.getDataSize() < 2 * 1024 * 1024)
        {
            const auto bytes = stream->read(chunk, sizeof(chunk));
            if (bytes <= 0) break;
            feed.write(chunk, static_cast<size_t>(bytes));
        }
        auto feedText = feed.getDataSize() >= 2 * 1024 * 1024 ? juce::String() : feed.toUTF8().trim();
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

    // GitHub release metadata remains available if the website deployment is down.
    if (currentChannel == "stable")
    {
        auto fallback = tryFeedUrl("https://github.com/sdevil7th/OpenStudio/releases/latest/download/OpenStudio-release-stable-latest.json", false);
        if (getStringProperty(fallback, "status") != "error") return fallback;
    }
    return lastFailure;
}

bool AppUpdater::validateUpdateDownload(const juce::String& downloadUrl, const juce::String& sha256,
                                        juce::int64 size, juce::String& error)
{
    const juce::URL url(downloadUrl);
    if (url.getScheme().toLowerCase() != "https" || url.getDomain().isEmpty())
        error = "The update download must use HTTPS.";
    else if (sha256.length() != 64 || !sha256.containsOnly("0123456789abcdefABCDEF"))
        error = "The update feed must include a valid SHA-256 checksum.";
    else if (size <= 0 || size > 2LL * 1024 * 1024 * 1024)
        error = "The update feed must include a valid download size.";
    else
        return true;
    return false;
}

juce::var AppUpdater::performDownload(const juce::var& offer)
{
    if (WindowsPackage::isStoreManaged()) return makeStatus("error", "This installation uses Microsoft Store package updates.");
    auto result = offer.isObject() ? offer.clone() : makeStatus("error", "Check for updates before downloading.");
    auto finish = [&](const juce::String& status, const juce::String& message)
    {
        result.getDynamicObject()->setProperty("status", status);
        result.getDynamicObject()->setProperty("message", message);
        return result;
    };
    if (!offer.isObject()) return result;
    const auto downloadUrl = getStringProperty(offer, "downloadUrl");
    const auto version = getStringProperty(offer, "version");
    if (compareVersions(version, getCurrentVersion()) <= 0)
        return finish("up-to-date", "OpenStudio is already up to date.");
    const auto sha256 = getStringProperty(offer, "sha256");
    const auto size = getInt64Property(offer, "size");
    juce::String error;
    if (!validateUpdateDownload(downloadUrl, sha256, size, error)) return finish("error", error);
    const juce::URL url(downloadUrl);
    const auto installerFile = getOpenStudioAppDataDirectory().getChildFile("updates")
        .getChildFile(juce::Uuid().toString()).getChildFile(getDownloadFileName(url, version));
    if (installerFile.getParentDirectory().createDirectory().failed())
        return finish("error", "Could not create the update download folder.");
    auto progress = [this, alive = jobs.token(), offer, size](juce::int64 bytes)
    {
        auto status = offer.clone();
        auto* obj = status.getDynamicObject();
        obj->setProperty("status", "downloading");
        obj->setProperty("message", "Downloading update...");
        obj->setProperty("downloadedBytes", bytes);
        obj->setProperty("progress", juce::jlimit(0.0, 1.0, static_cast<double>(bytes) / static_cast<double>(size)));
        juce::MessageManager::callAsync([this, alive, status]()
        {
            if (MessageThreadLifetime::accepts(alive)) publishStatus(status);
        });
    };
    if (!downloadToFile(url, installerFile, error, jobs.token(), &cancelRequested, progress)
        || !verifyDownloadedFileSize(installerFile, size, error)
        || !verifyDownloadedFileSha256(installerFile, sha256, error)
        || cancelRequested.load() || !MessageThreadLifetime::accepts(jobs.token()))
    {
        installerFile.deleteFile();
        installerFile.getParentDirectory().deleteFile(); // Only the empty folder created for this download.
        return finish(cancelRequested.load() ? "cancelled" : "error", cancelRequested.load() ? "Download cancelled. You can try again later." : error);
    }
    {
        const juce::ScopedLock lock(stateLock);
        if (downloadedInstaller.existsAsFile()) downloadedInstaller.deleteFile();
        downloadedInstaller = installerFile;
        downloadedUpdate = offer.clone();
    }
    return finish("download-ready", "Update downloaded and verified. Install it when you are ready.");
}

juce::var AppUpdater::performInstall()
{
    if (WindowsPackage::isStoreManaged()) return makeStatus("error", "This installation uses Microsoft Store package updates.");
    juce::File installer;
    juce::var offer;
    {
        const juce::ScopedLock lock(stateLock);
        installer = downloadedInstaller;
        offer = downloadedUpdate.clone();
    }
    if (!offer.isObject()) return makeStatus("error", "Download the update before installing it.");
    if (compareVersions(getStringProperty(offer, "version"), getCurrentVersion()) <= 0)
        return makeStatus("up-to-date", "OpenStudio is already up to date.");
    auto result = offer.clone();
    juce::String error;
    if (!verifyDownloadedFileSize(installer, getInt64Property(offer, "size"), error)
        || !verifyDownloadedFileSha256(installer, getStringProperty(offer, "sha256"), error))
    {
        result.getDynamicObject()->setProperty("status", "error");
        result.getDynamicObject()->setProperty("message", error);
        return result;
    }
    if (!MessageThreadLifetime::accepts(jobs.token())) return makeStatus("cancelled", "Update cancelled during shutdown.");
   #if JUCE_LINUX
    // Keep the verified AppImage in a stable user-writable location. The user
    // chooses where their portable app lives; never replace a package-manager installation.
    if (!installer.setExecutePermission(true)) error = "Could not make the downloaded AppImage executable.";
    else installer.revealToUser();
    const auto successMessage = "The verified AppImage is ready in the opened folder. Replace your previous AppImage, then launch it.";
   #else
    // The Windows installer must not forcibly close a session that changed while
    // verification was running. The frontend uses the normal saved-project quit path.
    const auto arguments = getPlatformKey() == "windows" ? "/SP- /NOICONS /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS" : "";
    launchDownloadedInstaller(installer, arguments, error);
    const auto successMessage = getPlatformKey() == "macos"
        ? "The update DMG is open. Quit OpenStudio and drag the new app into Applications, then reopen it."
        : "The installer is open. Follow its steps to update and reopen OpenStudio.";
   #endif
    result.getDynamicObject()->setProperty("status", error.isEmpty() ? "install-started" : "error");
    result.getDynamicObject()->setProperty("message", error.isEmpty() ? successMessage : error);
    return result;
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
   #elif JUCE_LINUX
    return "linux";
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
    if (compareVersions(getStringProperty(persistedState, "lastSeenVersion"), getCurrentVersion()) > 0)
        return false; // Re-offer an update after relaunch even if it was checked today.

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
        return juce::File::createLegalFileName(candidate);

   #if JUCE_WINDOWS
    return "OpenStudio-" + version + "-Setup.exe";
   #elif JUCE_MAC
    return "OpenStudio-" + version + ".dmg";
   #else
    return "OpenStudio-" + version;
   #endif
}

bool AppUpdater::downloadToFile(const juce::URL& url, const juce::File& targetFile, juce::String& error,
                                const MessageThreadLifetime::Token& alive,
                                const std::atomic<bool>* cancelled,
                                std::function<void(juce::int64)> progress)
{
    juce::TemporaryFile temporary(targetFile);

    auto input = url.createInputStream(
        juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(5000)
            .withNumRedirectsToFollow(5));

    if (input == nullptr)
    {
        error = "Could not connect to the update download URL.";
        return false;
    }

    auto output = temporary.getFile().createOutputStream();
    if (!output)
    {
        error = "Could not create a temporary installer file.";
        return false;
    }

    const auto started = juce::Time::getMillisecondCounterHiRes();
    auto lastProgressAt = started - 250.0;
    char chunk[65536];
    while (!input->isExhausted())
    {
        if (!MessageThreadLifetime::accepts(alive) || (cancelled != nullptr && cancelled->load())
            || juce::Time::getMillisecondCounterHiRes() - started > 600000)
        { error = "Update download cancelled or timed out."; return false; }
        const auto bytes = input->read(chunk, sizeof(chunk));
        if (bytes <= 0 || output->getPosition() + bytes > 2LL * 1024 * 1024 * 1024
            || !output->write(chunk, static_cast<size_t>(bytes)))
        { error = "Update download was incomplete, too large, or could not be written."; return false; }
        const auto now = juce::Time::getMillisecondCounterHiRes();
        if (progress && now - lastProgressAt >= 150.0)
        {
            progress(output->getPosition());
            lastProgressAt = now;
        }
    }
    output->flush();
    if (output->getPosition() <= 0 || output->getStatus().failed() || !MessageThreadLifetime::accepts(alive)
        || (cancelled != nullptr && cancelled->load()))
    { error = "The installer download was not finalized."; return false; }
    output.reset();
    if (!temporary.overwriteTargetFileWithTemporary())
    {
        error = "Could not move the downloaded installer into place.";
        return false;
    }

    return true;
}

bool AppUpdater::verifyDownloadedFileSize(const juce::File& targetFile, juce::int64 expectedSize, juce::String& error)
{
    if (expectedSize <= 0)
    {
        error = "The update is missing its published size.";
        return false;
    }

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
    if (normalizedExpected.length() != 64 || !normalizedExpected.containsOnly("0123456789abcdef"))
    {
        error = "The update is missing a valid SHA-256 checksum.";
        return false;
    }

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
