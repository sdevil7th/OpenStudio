#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <functional>
#include "OwnedBackgroundTasks.h"
#include "StoreUpdater.h"

class AppUpdater
{
public:
    using Completion = std::function<void(const juce::var&)>;
    using StatusCallback = std::function<void(const juce::var&)>;

    AppUpdater();
    ~AppUpdater();
    void shutdown();

    juce::String getCurrentVersion() const;
    juce::var getLastStatus() const;

    void setStatusCallback(StatusCallback callback);
    void checkForUpdates(bool manual, Completion completion = {});
    void downloadUpdate(Completion completion = {});
    void cancelDownload();
    void installDownloadedUpdate(Completion completion = {});

private:
    friend class RuntimeSafetyRegression;
    juce::var performUpdateCheck();
    juce::var performDownload(const juce::var& offer);
    juce::var performInstall();
    static bool validateUpdateDownload(const juce::String& url, const juce::String& sha256,
                                       juce::int64 size, juce::String& error);

    void publishStatus(const juce::var& status);
    bool rejectDevelopmentUpdate(const Completion& completion);
    bool shouldSkipAutomaticCheck() const;
    void recordSuccessfulCheck(const juce::String& latestVersion, const juce::String& publishedAt);
    void savePersistedState() const;

    static juce::String getManifestUrl();
    static juce::String getAppcastUrl();
    static juce::String getFallbackReleasesPageUrl();
    static juce::String getPlatformKey();
    static juce::String getCurrentChannel();
    static int compareVersions(const juce::String& lhs, const juce::String& rhs);
    static juce::StringArray tokenizeVersion(const juce::String& version);
    static juce::String getDownloadFileName(const juce::URL& url, const juce::String& version);
    static bool downloadToFile(const juce::URL& url, const juce::File& targetFile, juce::String& error,
                               const MessageThreadLifetime::Token& alive,
                               const std::atomic<bool>* cancelled = nullptr,
                               std::function<void(juce::int64)> progress = {});
    static bool verifyDownloadedFileSize(const juce::File& targetFile, juce::int64 expectedSize, juce::String& error);
    static bool verifyDownloadedFileSha256(const juce::File& targetFile, const juce::String& expectedSha256, juce::String& error);
    static bool launchDownloadedInstaller(const juce::File& installerFile,
                                          const juce::String& installerArguments,
                                          juce::String& error);
    static juce::var makeStatus(const juce::String& status,
                                const juce::String& message,
                                const juce::String& version = {},
                                const juce::String& downloadUrl = {},
                                const juce::String& sha256 = {},
                                const juce::String& notes = {},
                                const juce::String& releasePageUrl = {},
                                const juce::String& releaseNotesUrl = {},
                                const juce::String& publishedAt = {},
                                juce::int64 expectedSize = 0,
                                const juce::String& fileName = {},
                                const juce::String& channel = {},
                                bool mandatory = false,
                                const juce::String& installerArguments = {},
                                const juce::String& updateSource = {});

    mutable juce::CriticalSection stateLock;
    juce::var lastStatus;
    juce::var persistedState;
    juce::var availableUpdate;
    juce::var downloadedUpdate;
    juce::File downloadedInstaller;
    StatusCallback statusCallback;
    std::atomic<bool> checkInProgress { false };
    std::atomic<bool> installInProgress { false };
    std::atomic<bool> cancelRequested { false };
    OwnedBackgroundTasks jobs;
    std::unique_ptr<StoreUpdater> storeUpdater;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AppUpdater)
};
