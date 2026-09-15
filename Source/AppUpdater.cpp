#include "AppUpdater.h"
#include "WindowsPackage.h"
#include "UpdateManifest.h"
#include "UpdateInstaller.h"
#include <thread>

namespace
{
#if JUCE_DEBUG
constexpr bool isDevelopmentBuild = true;
#else
constexpr bool isDevelopmentBuild = false;
#endif
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

constexpr juce::int64 kAutomaticUpdateCheckIntervalMs = 24LL * 60LL * 60LL * 1000LL;
}

AppUpdater::AppUpdater() : AppUpdater(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("OpenStudio"), true) {}

AppUpdater::AppUpdater(const juce::File& directory, bool restoreOnStartup) : stateDirectory(directory), trustedPublicKey(UpdateManifest::publicKey())
{
    if (WindowsPackage::isStoreManaged())
    {
        storeUpdater = std::make_unique<StoreUpdater>([this](const juce::var& status) { publishStatus(status); });
        return;
    }
    const auto stateFile = stateDirectory.getChildFile("updater-state.json");
    if (stateFile.existsAsFile())
    {
        auto parsed = juce::JSON::parse(stateFile.loadFileAsString());
        if (parsed.isObject())
            persistedState = parsed;
    }

    publishStatus(makeStatus(isDevelopmentBuild ? "development" : "idle",
                            isDevelopmentBuild ? "Development build: update installers are disabled. Build this checkout to update it." : "Updater ready",
                            {}, {}, {}, {}, {}, {}, {}, 0, {}, getCurrentChannel()));
    if (restoreOnStartup && !isDevelopmentBuild)
    {
        const auto previous = UpdateInstaller::previousResult(stateDirectory);
        if (previous.isNotEmpty()) publishStatus(makeStatus("idle", previous));
    }
    if (restoreOnStartup && !isDevelopmentBuild && persistedState["stagedDownload"].isObject())
    {
        checkInProgress = true;
        publishStatus(makeStatus("checking", "Verifying the previously downloaded update..."));
        jobs.addJob([this, alive = jobs.token()] {
            const auto restored = restoreDownload();
            juce::MessageManager::callAsync([this, alive, restored] {
                if (!MessageThreadLifetime::accepts(alive)) return;
                checkInProgress = false;
                publishStatus(restored.isObject() ? restored : makeStatus("idle", "Check for the latest version of OpenStudio."));
                const auto previous = UpdateInstaller::previousResult(stateDirectory);
                if (previous.isNotEmpty())
                {
                    auto status = getLastStatus().clone();
                    status.getDynamicObject()->setProperty("message", previous);
                    publishStatus(status);
                }
            });
        });
    }
}

AppUpdater::~AppUpdater() { shutdown(); }
void AppUpdater::shutdown()
{
    if (storeUpdater) storeUpdater->shutdown();
    jobs.shutdown();
    // Only the frontend's saved-project quit path may authorise installation.
    // OS shutdown during preparation must not accidentally commit the update.
    if (installQuitAuthorised) UpdateInstaller::commit(installTransaction);
    else UpdateInstaller::cancel(installTransaction);
    installTransaction = juce::File();
    installQuitAuthorised = false;
    setStatusCallback({});
}

void AppUpdater::authorisePreparedInstallForQuit()
{
    const juce::ScopedLock lock(stateLock);
    installQuitAuthorised = installTransaction != juce::File();
}

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

void AppUpdater::cancelDownload()
{
    if (storeUpdater) storeUpdater->cancel();
    else
    {
        cancelRequested = true;
        const juce::ScopedLock lock(stateLock);
        UpdateInstaller::cancel(installTransaction);
        installTransaction = juce::File();
        installQuitAuthorised = false;
    }
}

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
    cancelRequested = false;
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
            const auto finalResult = cancelRequested.load() ? makeStatus("cancelled", "Update installation cancelled.") : result;
            publishStatus(finalResult);
            if (completion) completion(finalResult);
        });
    });
}

juce::var AppUpdater::statusFromEnvelope(const juce::var& envelope) const
{
    juce::String error;
    const auto manifest = UpdateManifest::verify(envelope, trustedPublicKey, error);
    if (!manifest.isObject()) return makeStatus("error", error);
    const auto version = manifest["version"].toString();
    if (!UpdateManifest::numericVersion(version) || manifest["channel"].toString() != getCurrentChannel())
        return makeStatus("error", "The signed update version or channel is invalid.");
    const auto platform = manifest["platforms"][juce::Identifier(getPlatformKey())];
    const auto releasePage = manifest["releasePageUrl"].toString();
    if (!UpdateManifest::compatible(platform, UpdateManifest::architecture(), UpdateManifest::systemVersion(), UpdateManifest::libcVersion(), error))
        return makeStatus("incompatible", error, version, {}, {}, {}, releasePage);
    const auto url = platform["url"].toString();
    const auto hash = platform["sha256"].toString();
    const auto size = getInt64Property(platform, "size");
    if (!validateUpdateDownload(url, hash, size, error)) return makeStatus("error", error);
    const auto suffix = getPlatformKey() == "windows" ? ".exe" : getPlatformKey() == "macos" ? ".dmg" : ".AppImage";
    const auto name = getDownloadFileName(juce::URL(url), version);
    if (!name.endsWith(suffix)) return makeStatus("error", "The signed update package has the wrong file type.");
    const bool newer = compareVersions(version, getCurrentVersion()) > 0;
    auto result = makeStatus(newer ? "update-available" : "up-to-date",
        newer ? "OpenStudio " + version + " is available." : "OpenStudio is already up to date.",
        version, url, hash, manifest["notes"].toString(), releasePage, manifest["fullReleaseNotesUrl"].toString(),
        manifest["publishedAt"].toString(), size, name, getCurrentChannel(), false, {}, "signed-manifest");
    result.getDynamicObject()->setProperty("signedEnvelope", envelope);
    return result;
}

juce::var AppUpdater::performUpdateCheck()
{
    if (WindowsPackage::isStoreManaged()) return makeStatus("error", "This installation uses Microsoft Store package updates.");
    // GitHub is authoritative. A healthy but stale website must never suppress
    // the newer release. The website is a signed fallback for GitHub outages.
    juce::StringArray feeds;
    if (getCurrentChannel() == "stable")
        feeds.add("https://github.com/sdevil7th/OpenStudio/releases/latest/download/OpenStudio-release-stable-latest.json");
    if (getManifestUrl().isNotEmpty()) feeds.addIfNotAlreadyThere(getManifestUrl());
    auto failure = makeStatus("error", "Could not reach a signed update feed. Please try again later.");
    const auto readUrl = [&](const juce::String& url, const juce::String& acceptHeader = juce::String())
    {
        int httpStatus = 0;
        const auto requestUrl = juce::URL(url).withParameter("check", juce::String(juce::Time::currentTimeMillis()));
        auto stream = requestUrl.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(5000).withNumRedirectsToFollow(5).withStatusCode(&httpStatus)
            .withExtraHeaders("Cache-Control: no-cache\r\nUser-Agent: OpenStudio-Updater\r\n" + acceptHeader));
        juce::MemoryOutputStream buffer;
        char chunk[8192];
        while (stream && httpStatus == 200 && !stream->isExhausted() && MessageThreadLifetime::accepts(jobs.token())
               && buffer.getDataSize() < 2 * 1024 * 1024)
        {
            const auto bytes = stream->read(chunk, sizeof(chunk));
            if (bytes <= 0) break;
            buffer.write(chunk, static_cast<size_t>(bytes));
        }
        return buffer.getDataSize() < 2 * 1024 * 1024 ? buffer.toUTF8() : juce::String();
    };
    for (const auto& url : feeds)
    {
        if (!MessageThreadLifetime::accepts(jobs.token())) return makeStatus("cancelled", "Update check cancelled.");
        if (juce::URL(url).getScheme() != "https") continue;
        juce::String contents;
        if (feedReader) contents = feedReader(url); // Deterministic headless regression injection.
        else
        {
            if (url.startsWith("https://github.com/sdevil7th/OpenStudio/"))
            {
                // Resolve the asset's immutable ID. GitHub's human download URL
                // can keep redirecting to a deleted old asset after a metadata repair.
                const auto release = juce::JSON::parse(readUrl("https://api.github.com/repos/sdevil7th/OpenStudio/releases/latest"));
                const auto assets = release["assets"];
                if (auto* entries = assets.getArray())
                    for (const auto& asset : *entries)
                        if (asset["name"].toString() == "OpenStudio-release-stable-latest.json")
                        {
                            const auto id = asset["id"].toString();
                            if (id.isNotEmpty() && id.length() <= 20 && id.containsOnly("0123456789"))
                                contents = readUrl("https://api.github.com/repos/sdevil7th/OpenStudio/releases/assets/" + id,
                                                   "Accept: application/octet-stream\r\n");
                            break;
                        }
            }
            else contents = readUrl(url);
        }
        if (contents.isEmpty()) continue;
        const auto status = statusFromEnvelope(juce::JSON::parse(contents));
        if (status["status"].toString() != "error")
        {
            recordSuccessfulCheck(status["version"].toString(), status["publishedAt"].toString());
            return status;
        }
        failure = status;
    }
    return failure;
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

juce::File AppUpdater::stagedFile(const juce::File& root, const juce::String& relativePath)
{
    const auto parts = juce::StringArray::fromTokens(relativePath.replaceCharacter('\\', '/'), "/", "");
    if (parts.size() != 2 || parts[0].length() != 32 || !parts[0].containsOnly("0123456789abcdef")
        || parts[1].isEmpty() || parts[1] == "." || parts[1] == ".."
        || juce::File::createLegalFileName(parts[1]) != parts[1] || root.isSymbolicLink()) return {};
    const auto directory = root.getChildFile(parts[0]);
    const auto file = directory.getChildFile(parts[1]);
    if (directory.isSymbolicLink() || file.isSymbolicLink() || !file.isAChildOf(root)) return {};
    return file;
}

juce::var AppUpdater::restoreDownload()
{
    juce::var staged;
    { const juce::ScopedLock lock(stateLock); staged = persistedState["stagedDownload"].clone(); }
    if (!staged.isObject()) return {};
    const auto file = stagedFile(stateDirectory.getChildFile("updates"), staged["relativePath"].toString());
    auto offer = statusFromEnvelope(staged["signedEnvelope"]);
    juce::String error;
    if (file != juce::File() && offer["status"].toString() == "update-available"
        && file.getFileName() == offer["fileName"].toString()
        && verifyDownloadedFileSize(file, getInt64Property(offer, "size"), error)
        && verifyDownloadedFileSha256(file, offer["sha256"].toString(), error))
    {
        const juce::ScopedLock lock(stateLock);
        downloadedInstaller = file;
        availableUpdate = downloadedUpdate = offer.clone();
        offer.getDynamicObject()->setProperty("status", "download-ready");
        offer.getDynamicObject()->setProperty("message", "Your downloaded update has been verified and is ready to install.");
        return offer;
    }
    // Only delete the exact updater-owned file, never recurse or follow links.
    bool runningPackage = false;
   #if JUCE_LINUX
    const auto appImagePath = juce::SystemStats::getEnvironmentVariable("APPIMAGE", {});
    runningPackage = appImagePath.isNotEmpty() && file == juce::File(appImagePath);
   #endif
    if (file != juce::File() && !runningPackage) { file.deleteFile(); file.getParentDirectory().deleteFile(); }
    const juce::ScopedLock lock(stateLock);
    persistedState.getDynamicObject()->removeProperty("stagedDownload");
    savePersistedState();
    return {};
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
    const auto authenticated = statusFromEnvelope(offer["signedEnvelope"]);
    if (authenticated["status"].toString() != "update-available") return authenticated;
    if (authenticated["downloadUrl"] != offer["downloadUrl"] || authenticated["sha256"] != offer["sha256"]
        || authenticated["size"] != offer["size"] || authenticated["version"] != offer["version"])
        return finish("error", "The staged update does not match its signed manifest.");
    if (!validateUpdateDownload(downloadUrl, sha256, size, error)) return finish("error", error);
    const juce::URL url(downloadUrl);
    const auto installerFile = stateDirectory.getChildFile("updates")
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
        if (downloadedInstaller.existsAsFile())
        {
            downloadedInstaller.deleteFile();
            downloadedInstaller.getParentDirectory().deleteFile(); // Empty updater-owned directory only.
        }
        downloadedInstaller = installerFile;
        downloadedUpdate = offer.clone();
        if (!persistedState.isObject()) persistedState = juce::var(new juce::DynamicObject());
        auto* staged = new juce::DynamicObject();
        staged->setProperty("relativePath", installerFile.getRelativePathFrom(stateDirectory.getChildFile("updates")));
        staged->setProperty("signedEnvelope", offer["signedEnvelope"]);
        persistedState.getDynamicObject()->setProperty("stagedDownload", juce::var(staged));
        if (!savePersistedState()) return finish("error", "Could not save the downloaded update for later. Check available disk space.");
    }
    return finish("download-ready", "Update downloaded and verified. Install it when you are ready.");
}

juce::var AppUpdater::performInstall()
{
    if (cancelRequested.load()) return makeStatus("cancelled", "Update installation cancelled.");
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
    const auto authenticated = statusFromEnvelope(offer["signedEnvelope"]);
    if (authenticated["status"].toString() != "update-available") return authenticated;
    offer = authenticated;
    auto result = offer.clone();
    juce::String error;
    if (!verifyDownloadedFileSize(installer, getInt64Property(offer, "size"), error)
        || !verifyDownloadedFileSha256(installer, getStringProperty(offer, "sha256"), error))
    {
        result.getDynamicObject()->setProperty("status", "error");
        result.getDynamicObject()->setProperty("message", error);
        return result;
    }
    if (cancelRequested.load() || !MessageThreadLifetime::accepts(jobs.token()))
        return makeStatus("cancelled", "Update installation cancelled.");
   #if JUCE_LINUX || JUCE_MAC
    juce::File transaction;
    bool executableReady = true;
   #if JUCE_LINUX
    // The verified package remains usable for manual fallback in locations
    // where automatic replacement is intentionally refused.
    executableReady = installer.setExecutePermission(true);
    if (!executableReady) error = "Could not make the verified AppImage executable.";
   #endif
    const bool prepared = executableReady && UpdateInstaller::prepare(installer, offer["signedEnvelope"], stateDirectory, transaction, error,
        [this] { return cancelRequested.load() || !MessageThreadLifetime::accepts(jobs.token()); });
    {
        const juce::ScopedLock lock(stateLock);
        if (prepared && !cancelRequested.load() && MessageThreadLifetime::accepts(jobs.token()))
        {
            installTransaction = transaction;
            installQuitAuthorised = false;
        }
        else
        {
            UpdateInstaller::cancel(transaction);
            if (cancelRequested.load() || !MessageThreadLifetime::accepts(jobs.token()))
                return makeStatus("cancelled", "Update installation cancelled.");
            if (error.isEmpty()) error = "Could not prepare the update.";
        }
    }
    const auto successMessage = "Update prepared. OpenStudio will close, install the update and restart. The previous version will be retained for recovery.";
   #else
    // The Windows installer must not forcibly close a session that changed while
    // verification was running. The frontend uses the normal saved-project quit path.
    const auto arguments = getPlatformKey() == "windows" ? "/SP- /NOICONS /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS" : "";
    launchDownloadedInstaller(installer, arguments, error);
    const auto successMessage = "The installer is open. Follow its steps to update and reopen OpenStudio.";
   #endif
    result.getDynamicObject()->setProperty("downloadPath", installer.getFullPathName());
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

bool AppUpdater::savePersistedState() const
{
    const auto stateFile = stateDirectory.getChildFile("updater-state.json");
    stateFile.getParentDirectory().createDirectory();
    return stateFile.replaceWithText(juce::JSON::toString(persistedState));
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
