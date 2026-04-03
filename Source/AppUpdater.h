#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <functional>

class AppUpdater
{
public:
    using Completion = std::function<void(const juce::var&)>;
    using StatusCallback = std::function<void(const juce::var&)>;

    AppUpdater();
    ~AppUpdater();

    juce::String getCurrentVersion() const;
    juce::var getLastStatus() const;

    void setStatusCallback(StatusCallback callback);
    void checkForUpdates(bool manual, Completion completion = {});
    void downloadAndInstallUpdate(const juce::String& downloadUrl,
                                  const juce::String& version,
                                  const juce::String& expectedSha256,
                                  const juce::String& releasePageUrl,
                                  const juce::String& installerArguments = {},
                                  juce::int64 expectedSize = 0,
                                  Completion completion = {});

private:
    juce::var performUpdateCheck();
    juce::var performDownloadAndInstall(const juce::String& downloadUrl,
                                        const juce::String& version,
                                        const juce::String& expectedSha256,
                                        const juce::String& releasePageUrl,
                                        const juce::String& installerArguments,
                                        juce::int64 expectedSize) const;

    void publishStatus(const juce::var& status);
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
    static bool downloadToFile(const juce::URL& url, const juce::File& targetFile, juce::String& error);
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
    StatusCallback statusCallback;
    std::atomic<bool> checkInProgress { false };
    std::atomic<bool> installInProgress { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AppUpdater)
};
