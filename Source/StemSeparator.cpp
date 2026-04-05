#include "StemSeparator.h"

namespace
{
constexpr auto kStemModelName = "BS-Roformer-SW.ckpt";
constexpr auto kPythonHelpUrl = "https://www.python.org/downloads/";
constexpr auto kInstallSourceDownloadedRuntime = "downloadedRuntime";
constexpr auto kInstallSourceExternalPython = "externalPython";
constexpr auto kBuildRuntimeModeDownloadedRuntime = "downloaded-runtime";
constexpr auto kBuildRuntimeModeUnbundledDev = "unbundled-dev";

juce::String makePythonImportCommand()
{
    return "-c \"import audio_separator.separator; print('ok')\"";
}

juce::String quoteCommandPart(const juce::String& value)
{
    return value.quoted();
}

bool isAiToolsTerminalState (const juce::String& state)
{
    return state == "ready"
        || state == "error"
        || state == "cancelled"
        || state == "pythonMissing"
        || state == "runtimeMissing"
        || state == "modelMissing";
}

juce::String sanitiseArchiveEntryName (juce::String name)
{
    name = name.replaceCharacter('\\', '/').trim();
    while (name.startsWithChar('/'))
        name = name.substring(1);
    return name;
}

juce::File getApplicationRuntimeDirectory()
{
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
}
}

StemSeparator::StemSeparator() = default;

StemSeparator::~StemSeparator()
{
    cancel();
    cancelAiToolsInstall();
}

juce::File StemSeparator::getUserDataRoot() const
{
   #if JUCE_WINDOWS
    const auto localAppData = juce::SystemStats::getEnvironmentVariable("LOCALAPPDATA", {});
    if (localAppData.isNotEmpty())
        return juce::File(localAppData).getChildFile("OpenStudio");
   #elif JUCE_MAC
    return juce::File::getSpecialLocation(juce::File::userHomeDirectory)
        .getChildFile("Library")
        .getChildFile("Application Support")
        .getChildFile("OpenStudio");
   #endif

    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio");
}

juce::File StemSeparator::getUserRuntimeRoot() const
{
    return getUserDataRoot().getChildFile("stem-runtime");
}

juce::File StemSeparator::getUserModelsDir() const
{
    return getUserDataRoot().getChildFile("models");
}

juce::File StemSeparator::getAiToolsInstallLogFile() const
{
    return getUserDataRoot().getChildFile("logs").getChildFile("AiToolsInstall.log");
}

juce::File StemSeparator::getAiRuntimeDownloadsDir() const
{
    return getUserDataRoot().getChildFile("runtime-downloads");
}

juce::String StemSeparator::getAiRuntimeManifestUrl() const
{
#if defined(OPENSTUDIO_AI_RUNTIME_MANIFEST_URL)
    return OPENSTUDIO_AI_RUNTIME_MANIFEST_URL;
#else
    return {};
#endif
}

juce::String StemSeparator::getAiRuntimePlatformKey() const
{
#if JUCE_WINDOWS
    return "windows";
#elif JUCE_MAC
    return "macos";
#else
    return "linux";
#endif
}

juce::File StemSeparator::findSystemPython() const
{
#if JUCE_WINDOWS
    juce::ChildProcess where;
    if (where.start("where python") && where.waitForProcessToFinish(3000))
    {
        auto output = where.readAllProcessOutput().trim();
        if (output.isNotEmpty())
        {
            auto firstLine = output.upToFirstOccurrenceOf("\n", false, false).trim();
            juce::File systemPython(firstLine);
            if (systemPython.existsAsFile())
                return systemPython;
        }
    }

    juce::ChildProcess pyLauncher;
    if (pyLauncher.start("py -3 -c \"import sys; print(sys.executable)\"")
        && pyLauncher.waitForProcessToFinish(5000))
    {
        auto output = pyLauncher.readAllProcessOutput().trim();
        if (output.isNotEmpty())
        {
            juce::File systemPython(output);
            if (systemPython.existsAsFile())
                return systemPython;
        }
    }
#elif JUCE_MAC
    juce::ChildProcess which;
    if (which.start("which python3") && which.waitForProcessToFinish(3000))
    {
        auto output = which.readAllProcessOutput().trim();
        if (output.isNotEmpty())
        {
            juce::File systemPython(output);
            if (systemPython.existsAsFile())
                return systemPython;
        }
    }

    for (const auto& path : { "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3" })
    {
        juce::File systemPy(path);
        if (systemPy.existsAsFile())
            return systemPy;
    }
#elif JUCE_LINUX
    juce::File systemPy("/usr/bin/python3");
    if (systemPy.existsAsFile())
        return systemPy;
#endif

    return {};
}

juce::File StemSeparator::findPythonInRuntimeRoot (const juce::File& runtimeRoot) const
{
    if (! runtimeRoot.isDirectory())
        return {};

#if JUCE_WINDOWS
    auto python = runtimeRoot.getChildFile("python.exe");
    if (! python.existsAsFile())
        python = runtimeRoot.getChildFile("Scripts/python.exe");
#else
    auto python = runtimeRoot.getChildFile("python3");
    if (! python.existsAsFile())
        python = runtimeRoot.getChildFile("bin/python3");
    if (! python.existsAsFile())
        python = runtimeRoot.getChildFile("bin/python");
#endif

    if (python.existsAsFile())
        return python;

    return {};
}

juce::File StemSeparator::findPython() const
{
    const auto userRuntime = getUserRuntimeRoot();
    auto python = findPythonInRuntimeRoot(userRuntime);
    if (python.existsAsFile())
        return python;

    return {};
}

juce::File StemSeparator::findScript() const
{
    auto appDir = getApplicationRuntimeDirectory();

    auto script = appDir.getChildFile("../../../tools/stem_separator.py");
    if (script.existsAsFile())
        return script;

    script = appDir.getChildFile("scripts/stem_separator.py");
    if (script.existsAsFile())
        return script;

#if JUCE_MAC
    auto resourcesDir = appDir.getParentDirectory().getChildFile("Resources");
    script = resourcesDir.getChildFile("scripts/stem_separator.py");
    if (script.existsAsFile())
        return script;
#endif

    return {};
}

juce::File StemSeparator::findInstallerScript() const
{
    auto appDir = getApplicationRuntimeDirectory();

    auto script = appDir.getChildFile("../../../tools/install_ai_tools.py");
    if (script.existsAsFile())
        return script;

    script = appDir.getChildFile("scripts/install_ai_tools.py");
    if (script.existsAsFile())
        return script;

#if JUCE_MAC
    auto resourcesDir = appDir.getParentDirectory().getChildFile("Resources");
    script = resourcesDir.getChildFile("scripts/install_ai_tools.py");
    if (script.existsAsFile())
        return script;
#endif

    return {};
}

juce::File StemSeparator::findModelsDir() const
{
    const auto userModelsDir = getUserModelsDir();
    if (hasRequiredModel(userModelsDir))
        return userModelsDir;

    auto appDir = getApplicationRuntimeDirectory();

    auto modelsDir = appDir.getChildFile("../../../resources/models");
    if (hasRequiredModel(modelsDir))
        return modelsDir;

    modelsDir = appDir.getChildFile("models");
    if (hasRequiredModel(modelsDir))
        return modelsDir;

#if JUCE_MAC
    auto resourcesDir = appDir.getParentDirectory().getChildFile("Resources");
    modelsDir = resourcesDir.getChildFile("models");
    if (hasRequiredModel(modelsDir))
        return modelsDir;
#endif

    userModelsDir.createDirectory();
    return userModelsDir;
}

bool StemSeparator::canImportAudioSeparator(const juce::File& python) const
{
    if (! python.existsAsFile())
        return false;

    juce::ChildProcess check;
    const auto cmd = quoteCommandPart(python.getFullPathName()) + " " + makePythonImportCommand();

    if (check.start(cmd) && check.waitForProcessToFinish(15000))
        return check.readAllProcessOutput().trim().contains("ok");

    return false;
}

bool StemSeparator::hasRequiredModel(const juce::File& modelsDir) const
{
    return modelsDir.isDirectory() && modelsDir.getChildFile(kStemModelName).existsAsFile();
}

bool StemSeparator::isExternalPythonFallbackEnabled() const
{
#if OPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK
    return true;
#else
    return false;
#endif
}

StemSeparator::AiToolsStatus StemSeparator::buildAiToolsStatus (const juce::File& systemPython,
                                                                const juce::File& script,
                                                                const juce::File& installerScript,
                                                                bool runtimeInstalled,
                                                                bool modelInstalled) const
{
    auto status = getCachedAiToolsStatusSnapshot();
    const auto devFallbackEnabled = isExternalPythonFallbackEnabled();
    const auto manifestUrl = getAiRuntimeManifestUrl().trim();

    status.pythonDetected = systemPython.existsAsFile();
    status.scriptAvailable = script.existsAsFile();
    status.installerAvailable = installerScript.existsAsFile();
    status.runtimeInstalled = runtimeInstalled;
    status.modelInstalled = modelInstalled;
    status.buildRuntimeMode = devFallbackEnabled ? kBuildRuntimeModeUnbundledDev : kBuildRuntimeModeDownloadedRuntime;
    status.requiresExternalPython = devFallbackEnabled;
    status.installSource = devFallbackEnabled ? juce::String(kInstallSourceExternalPython)
                                              : juce::String(kInstallSourceDownloadedRuntime);
    status.helpUrl = status.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
    status.detailLogPath = getAiToolsInstallLogFile().getFullPathName();

    if (status.installInProgress)
        return status;

    status.available = status.scriptAvailable && status.runtimeInstalled && status.modelInstalled;

    if (status.available)
    {
        status.state = "ready";
        status.progress = 1.0f;
        status.error.clear();
        status.errorCode.clear();
        status.message = "AI tools are ready.";
        return status;
    }

    if (! status.installerAvailable)
    {
        status.state = "error";
        status.progress = 0.0f;
        status.message = "The AI tools installer is unavailable in this build.";
        status.error = "AI tools installer script not found.";
        status.errorCode = "installer_unavailable";
        return status;
    }

    if (! devFallbackEnabled && manifestUrl.isEmpty())
    {
        status.state = "error";
        status.progress = 0.0f;
        status.message = "This release is missing its AI runtime download configuration. Reinstall OpenStudio or contact support.";
        status.error = "OpenStudio could not find the compiled AI runtime manifest URL for this installed build.";
        status.errorCode = "runtime_manifest_missing";
        return status;
    }

    if (! status.runtimeInstalled)
    {
        if (status.requiresExternalPython && ! status.pythonDetected)
        {
            status.state = "pythonMissing";
            status.progress = 0.0f;
            status.message = "Python 3.10 through 3.13 is required for this dev build before AI tools can be installed.";
            status.error.clear();
            status.errorCode = "python_missing";
            return status;
        }

        status.state = "runtimeMissing";
        status.progress = 0.0f;
        status.message = status.requiresExternalPython
            ? "Install AI Tools to create the local stem-separation runtime."
            : "Install AI Tools to download the managed OpenStudio AI runtime.";
        status.error.clear();
        status.errorCode.clear();
        return status;
    }

    status.state = "modelMissing";
    status.progress = 0.0f;
    status.message = "Install AI Tools to download the stem separation model.";
    status.error.clear();
    status.errorCode.clear();
    return status;
}

StemSeparator::AiToolsStatus StemSeparator::buildInitialAiToolsStatus() const
{
    AiToolsStatus status;
    const auto devFallbackEnabled = isExternalPythonFallbackEnabled();
    status.buildRuntimeMode = devFallbackEnabled ? kBuildRuntimeModeUnbundledDev : kBuildRuntimeModeDownloadedRuntime;
    status.requiresExternalPython = devFallbackEnabled;
    status.installSource = devFallbackEnabled ? kInstallSourceExternalPython : kInstallSourceDownloadedRuntime;
    status.helpUrl = status.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
    status.state = "checking";
    status.progress = 0.0f;
    status.available = false;
    status.pythonDetected = false;
    status.scriptAvailable = findScript().existsAsFile();
    status.installerAvailable = findInstallerScript().existsAsFile();
    status.runtimeInstalled = false;
    status.modelInstalled = hasRequiredModel(getUserModelsDir());
    status.installInProgress = aiToolsInstallWorkInProgress.load();
    status.message = status.installInProgress ? "Installing AI tools..." : "Checking AI tools...";
    status.error.clear();
    status.errorCode.clear();
    status.detailLogPath = getAiToolsInstallLogFile().getFullPathName();
    return status;
}

void StemSeparator::updateCachedAiToolsStatus (const std::function<void (AiToolsStatus&)>& updater)
{
    const juce::ScopedLock lock (aiToolsStatusLock);
    updater (lastAiToolsStatus);
}

StemSeparator::AiToolsStatus StemSeparator::getCachedAiToolsStatusSnapshot() const
{
    const juce::ScopedLock lock (aiToolsStatusLock);
    auto status = lastAiToolsStatus;
    status.installInProgress = aiToolsInstallWorkInProgress.load();

    if (status.installInProgress)
    {
        status.available = false;

        if (status.state.isEmpty() || status.state == "idle")
            status.state = "installing";

        if (status.message.isEmpty())
            status.message = "Installing AI tools...";
    }

    if (status.requiresExternalPython && status.helpUrl.isEmpty())
        status.helpUrl = kPythonHelpUrl;
    return status;
}

void StemSeparator::scheduleStatusRefresh()
{
    bool shouldLaunch = false;

    {
        const juce::ScopedLock lock (aiToolsStatusLock);

        if (aiToolsInstallWorkInProgress.load())
            return;

        if (! initialStatusPrepared)
        {
            lastAiToolsStatus = buildInitialAiToolsStatus();
            initialStatusPrepared = true;
        }

        if (! statusRefreshInFlight)
        {
            statusRefreshInFlight = true;
            shouldLaunch = true;
        }
    }

    if (! shouldLaunch)
        return;

    std::thread ([this]
    {
        auto installedPython = findPython();
        auto systemPython = findSystemPython();
        auto script = findScript();
        auto installerScript = findInstallerScript();
        const auto modelInstalled = hasRequiredModel(getUserModelsDir());
        const auto runtimeInstalled = installedPython.existsAsFile() && canImportAudioSeparator (installedPython);
        auto refreshedStatus = buildAiToolsStatus (systemPython, script, installerScript, runtimeInstalled, modelInstalled);

        {
            const juce::ScopedLock lock (aiToolsStatusLock);
            lastAiToolsStatus = refreshedStatus;
            statusRefreshInFlight = false;
            initialStatusPrepared = true;
        }
    }).detach();
}

void StemSeparator::appendAiToolsLogLine (const juce::String& line) const
{
    const auto logFile = getAiToolsInstallLogFile();
    logFile.getParentDirectory().createDirectory();
    logFile.appendText(line + juce::newLine, false, false, "\n");
}

bool StemSeparator::downloadFileWithProgress (const juce::URL& url,
                                              const juce::File& targetFile,
                                              const std::function<void (float, juce::int64, juce::int64)>& progressCallback,
                                              juce::String& error) const
{
    int statusCode = 0;
    juce::StringPairArray responseHeaders;
    auto input = url.createInputStream(
        juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(30000)
            .withNumRedirectsToFollow(5)
            .withStatusCode(&statusCode)
            .withResponseHeaders(&responseHeaders));

    if (! input)
    {
        error = "Could not reach the AI runtime download server.";
        return false;
    }

    if (statusCode >= 400)
    {
        error = "The AI runtime download server returned HTTP " + juce::String(statusCode) + ".";
        return false;
    }

    targetFile.getParentDirectory().createDirectory();
    const auto tempFile = targetFile.getSiblingFile(targetFile.getFileName() + ".part");
    tempFile.deleteFile();

    const auto totalLength = input->getTotalLength();
    juce::HeapBlock<char> buffer(64 * 1024);
    juce::int64 downloaded = 0;

    {
        juce::FileOutputStream output(tempFile);
        if (! output.openedOk())
        {
            error = "Could not create the AI runtime download file.";
            return false;
        }

        while (! input->isExhausted())
        {
            if (aiToolsCancelRequested.load())
            {
                error = "AI tools installation was cancelled.";
                output.flush();
                tempFile.deleteFile();
                return false;
            }

            const auto bytesRead = input->read(buffer.getData(), 64 * 1024);
            if (bytesRead <= 0)
                break;

            output.write(buffer.getData(), bytesRead);
            downloaded += static_cast<juce::int64>(bytesRead);

            float progress = 0.0f;
            if (totalLength > 0)
                progress = juce::jlimit(0.0f, 1.0f, static_cast<float>(downloaded) / static_cast<float>(totalLength));

            progressCallback(progress, downloaded, totalLength);
        }

        output.flush();
    }

    if (targetFile.existsAsFile() && ! targetFile.deleteFile())
    {
        error = "OpenStudio could not replace the previous AI runtime download.";
        tempFile.deleteFile();
        return false;
    }

    if (! tempFile.moveFileTo(targetFile))
    {
        error = "Could not move the downloaded AI runtime into place.";
        tempFile.deleteFile();
        return false;
    }

    progressCallback(1.0f, downloaded, totalLength);
    return true;
}

bool StemSeparator::verifyFileSha256 (const juce::File& file, const juce::String& expectedSha256, juce::String& error) const
{
    if (! file.existsAsFile())
    {
        error = "The AI runtime archive was not found after download.";
        return false;
    }

    juce::FileInputStream input(file);
    if (! input.openedOk())
    {
        error = "Could not read the AI runtime archive for verification.";
        return false;
    }

    const auto actual = juce::SHA256(input).toHexString().toLowerCase();
    const auto expected = expectedSha256.trim().toLowerCase();

    if (expected.isEmpty())
    {
        error = "The AI runtime manifest is missing a checksum.";
        return false;
    }

    if (actual != expected)
    {
        error = "The downloaded AI runtime did not match the published checksum.";
        return false;
    }

    return true;
}

bool StemSeparator::extractRuntimeArchive (const juce::File& archiveFile, const juce::File& destinationRoot, juce::String& error) const
{
    if (! archiveFile.existsAsFile())
    {
        error = "The AI runtime archive was not found for extraction.";
        return false;
    }

    const auto extractionRoot = destinationRoot.getSiblingFile(destinationRoot.getFileName() + "-extract");
    extractionRoot.deleteRecursively();
    extractionRoot.createDirectory();

    juce::ZipFile zip(archiveFile);
    if (auto result = zip.uncompressTo(extractionRoot); result.failed())
    {
        error = result.getErrorMessage();
        extractionRoot.deleteRecursively();
        return false;
    }

    juce::File sourceRoot = extractionRoot;
    if (! findPythonInRuntimeRoot(sourceRoot).existsAsFile())
    {
        juce::Array<juce::File> childDirs;
        for (const auto entry : juce::RangedDirectoryIterator(extractionRoot, false, "*", juce::File::findDirectories))
            childDirs.add(entry.getFile());

        if (childDirs.size() == 1 && findPythonInRuntimeRoot(childDirs.getReference(0)).existsAsFile())
            sourceRoot = childDirs.getReference(0);
    }

    if (! findPythonInRuntimeRoot(sourceRoot).existsAsFile())
    {
        error = "OpenStudio could not find a usable Python runtime inside the downloaded archive.";
        extractionRoot.deleteRecursively();
        return false;
    }

    destinationRoot.deleteRecursively();
    destinationRoot.createDirectory();
    if (! sourceRoot.copyDirectoryTo(destinationRoot))
    {
        error = "OpenStudio could not copy the extracted AI runtime into your user profile.";
        extractionRoot.deleteRecursively();
        return false;
    }

    extractionRoot.deleteRecursively();
    return true;
}

juce::var StemSeparator::aiToolsStatusToVar(const AiToolsStatus& status)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty("state", status.state);
    obj->setProperty("progress", static_cast<double>(status.progress));
    obj->setProperty("available", status.available);
    obj->setProperty("installerAvailable", status.installerAvailable);
    obj->setProperty("pythonDetected", status.pythonDetected);
    obj->setProperty("scriptAvailable", status.scriptAvailable);
    obj->setProperty("runtimeInstalled", status.runtimeInstalled);
    obj->setProperty("modelInstalled", status.modelInstalled);
    obj->setProperty("installInProgress", status.installInProgress);
    obj->setProperty("requiresExternalPython", status.requiresExternalPython);
    obj->setProperty("message", status.message);
    obj->setProperty("error", status.error);
    obj->setProperty("errorCode", status.errorCode);
    obj->setProperty("detailLogPath", status.detailLogPath);
    obj->setProperty("helpUrl", status.helpUrl);
    obj->setProperty("installSource", status.installSource);
    obj->setProperty("buildRuntimeMode", status.buildRuntimeMode);
    return juce::var(obj.release());
}

juce::var StemSeparator::getAiToolsStatus()
{
    pollInstallProgress();

    {
        const juce::ScopedLock lock (aiToolsStatusLock);
        if (! initialStatusPrepared)
        {
            lastAiToolsStatus = buildInitialAiToolsStatus();
            initialStatusPrepared = true;
        }
    }

    return aiToolsStatusToVar(getCachedAiToolsStatusSnapshot());
}

juce::var StemSeparator::refreshAiToolsStatus()
{
    pollInstallProgress();
    scheduleStatusRefresh();
    return aiToolsStatusToVar(getCachedAiToolsStatusSnapshot());
}

juce::var StemSeparator::installAiTools()
{
    pollInstallProgress();
    scheduleStatusRefresh();

    auto cachedStatus = getCachedAiToolsStatusSnapshot();

    auto result = std::make_unique<juce::DynamicObject>();
    if (cachedStatus.available)
    {
        result->setProperty("started", false);
        result->setProperty("message", "AI tools are already installed.");
        result->setProperty("status", aiToolsStatusToVar(cachedStatus));
        return juce::var(result.release());
    }

    if (cachedStatus.installInProgress)
    {
        result->setProperty("started", false);
        result->setProperty("error", "AI tools installation is already running.");
        result->setProperty("status", aiToolsStatusToVar(cachedStatus));
        return juce::var(result.release());
    }

    const auto devFallbackEnabled = isExternalPythonFallbackEnabled();
    aiToolsCancelRequested = false;
    aiToolsInstallWorkInProgress = true;

    updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
    {
        status.buildRuntimeMode = devFallbackEnabled ? kBuildRuntimeModeUnbundledDev : kBuildRuntimeModeDownloadedRuntime;
        status.requiresExternalPython = devFallbackEnabled;
        status.installSource = devFallbackEnabled ? juce::String(kInstallSourceExternalPython)
                                                  : juce::String(kInstallSourceDownloadedRuntime);
        status.state = devFallbackEnabled ? "checking" : "fetching_runtime_manifest";
        status.progress = 0.0f;
        status.available = false;
        status.installInProgress = true;
        status.message = devFallbackEnabled
            ? "Preparing AI tools installation..."
            : "Checking OpenStudio AI runtime downloads...";
        status.error.clear();
        status.errorCode.clear();
        status.detailLogPath = getAiToolsInstallLogFile().getFullPathName();
        status.helpUrl = status.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
    });

    std::thread ([this, devFallbackEnabled]
    {
        const auto installerScript = findInstallerScript();
        const auto systemPython = findSystemPython();
        const auto logFile = getAiToolsInstallLogFile();
        const auto runtimeRoot = getUserRuntimeRoot();
        const auto modelsDir = getUserModelsDir();
        const auto downloadsDir = getAiRuntimeDownloadsDir();
        const auto manifestUrl = getAiRuntimeManifestUrl().trim();

        auto finishWithStatus = [this] (const juce::String& state,
                                        float progress,
                                        const juce::String& message,
                                        const juce::String& error,
                                        const juce::String& errorCode,
                                        bool pythonDetected,
                                        bool runtimeInstalled,
                                        bool modelInstalled,
                                        bool requiresExternalPython,
                                        const juce::String& installSource,
                                        const juce::String& buildRuntimeMode)
        {
            aiToolsInstallWorkInProgress = false;
            updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
            {
                status.state = state;
                status.progress = progress;
                status.available = false;
                status.installInProgress = false;
                status.pythonDetected = pythonDetected;
                status.runtimeInstalled = runtimeInstalled;
                status.modelInstalled = modelInstalled;
                status.message = message;
                status.error = error;
                status.errorCode = errorCode;
                status.detailLogPath = getAiToolsInstallLogFile().getFullPathName();
                status.buildRuntimeMode = buildRuntimeMode;
                status.requiresExternalPython = requiresExternalPython;
                status.installSource = installSource;
                status.helpUrl = requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
            });
        };

        auto finishCancelled = [&]
        {
            finishWithStatus("cancelled",
                             0.0f,
                             "AI tools installation was cancelled.",
                             {},
                             "cancelled",
                             systemPython.existsAsFile(),
                             false,
                             false,
                             devFallbackEnabled,
                             devFallbackEnabled ? juce::String(kInstallSourceExternalPython) : juce::String(kInstallSourceDownloadedRuntime),
                             devFallbackEnabled ? juce::String(kBuildRuntimeModeUnbundledDev) : juce::String(kBuildRuntimeModeDownloadedRuntime));
        };

        auto updateStep = [this, &logFile, devFallbackEnabled] (const juce::String& state,
                                                                 float progress,
                                                                 const juce::String& message,
                                                                 const juce::String& installSource)
        {
            appendAiToolsLogLine(message);
            updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
            {
                status.state = state;
                status.progress = progress;
                status.available = false;
                status.installInProgress = true;
                status.message = message;
                status.error.clear();
                status.errorCode.clear();
                status.detailLogPath = logFile.getFullPathName();
                status.buildRuntimeMode = devFallbackEnabled ? kBuildRuntimeModeUnbundledDev : kBuildRuntimeModeDownloadedRuntime;
                status.requiresExternalPython = devFallbackEnabled;
                status.installSource = installSource;
                status.helpUrl = devFallbackEnabled ? juce::String(kPythonHelpUrl) : juce::String();
            });
        };

        runtimeRoot.getParentDirectory().createDirectory();
        modelsDir.createDirectory();
        downloadsDir.createDirectory();
        logFile.getParentDirectory().createDirectory();
        logFile.replaceWithText({}, false, false, "\n");

        appendAiToolsLogLine("OpenStudio AI tools installer started");
        appendAiToolsLogLine("buildRuntimeMode=" + juce::String(devFallbackEnabled ? kBuildRuntimeModeUnbundledDev : kBuildRuntimeModeDownloadedRuntime));
        appendAiToolsLogLine("systemPython=" + systemPython.getFullPathName());
        appendAiToolsLogLine("runtimeRoot=" + runtimeRoot.getFullPathName());
        appendAiToolsLogLine("modelsDir=" + modelsDir.getFullPathName());

        if (! installerScript.existsAsFile())
        {
            finishWithStatus("error", 0.0f,
                             "The AI tools installer is unavailable in this build.",
                             "AI tools installer script not found.",
                             "installer_unavailable",
                             systemPython.existsAsFile(),
                             false,
                             false,
                             devFallbackEnabled,
                             devFallbackEnabled ? juce::String(kInstallSourceExternalPython) : juce::String(kInstallSourceDownloadedRuntime),
                             devFallbackEnabled ? juce::String(kBuildRuntimeModeUnbundledDev) : juce::String(kBuildRuntimeModeDownloadedRuntime));
            return;
        }

        juce::File launcherPython;
        juce::String launchMode;

        if (devFallbackEnabled)
        {
            if (! systemPython.existsAsFile())
            {
                finishWithStatus("pythonMissing", 0.0f,
                                 "Python 3.10 through 3.13 is required for this dev build before AI Tools can be installed.",
                                 {},
                                 "python_missing",
                                 false,
                                 false,
                                 false,
                                 true,
                                 kInstallSourceExternalPython,
                                 kBuildRuntimeModeUnbundledDev);
                return;
            }

            launcherPython = systemPython;
            launchMode = " --bootstrap-with " + quoteCommandPart(systemPython.getFullPathName());
            updateStep("checking", 0.05f, "Using the system Python fallback for this dev build", kInstallSourceExternalPython);
        }
        else
        {
            if (manifestUrl.isEmpty())
            {
                finishWithStatus("error", 0.0f,
                                 "This release is missing its AI runtime download configuration.",
                                 "OpenStudio could not find the AI runtime manifest URL compiled into this build.",
                                 "runtime_manifest_missing",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            updateStep("fetching_runtime_manifest", 0.05f, "Checking the OpenStudio AI runtime manifest", kInstallSourceDownloadedRuntime);
            appendAiToolsLogLine("manifestUrl=" + manifestUrl);

            const auto manifestText = juce::URL(manifestUrl).readEntireTextStream(false).trim();
            if (aiToolsCancelRequested.load())
            {
                finishCancelled();
                return;
            }

            if (manifestText.isEmpty())
            {
                finishWithStatus("error", 0.05f,
                                 "OpenStudio could not reach the AI runtime service.",
                                 "The AI runtime manifest could not be downloaded.",
                                 "runtime_manifest_unavailable",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            const auto manifest = juce::JSON::parse(manifestText);
            if (! manifest.isObject())
            {
                finishWithStatus("error", 0.05f,
                                 "OpenStudio received invalid AI runtime metadata.",
                                 "The AI runtime manifest was not valid JSON.",
                                 "runtime_manifest_invalid",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            juce::var platformNode;
            if (auto* manifestObject = manifest.getDynamicObject())
            {
                auto platforms = manifestObject->getProperty("platforms");
                if (auto* platformsObject = platforms.getDynamicObject())
                    platformNode = platformsObject->getProperty(getAiRuntimePlatformKey());
            }

            auto getProperty = [] (const juce::var& value, const juce::Identifier& property) -> juce::String
            {
                if (auto* obj = value.getDynamicObject())
                    return obj->getProperty(property).toString();
                return {};
            };

            const auto runtimeUrl = getProperty(platformNode, "url").trim();
            const auto runtimeSha256 = getProperty(platformNode, "sha256").trim();
            auto runtimeFileName = getProperty(platformNode, "fileName").trim();
            const auto runtimeVersion = getProperty(manifest, "runtimeVersion").trim();

            if (runtimeFileName.isEmpty())
                runtimeFileName = juce::URL(runtimeUrl).getFileName();

            if (runtimeUrl.isEmpty() || runtimeSha256.isEmpty() || runtimeFileName.isEmpty())
            {
                finishWithStatus("error", 0.05f,
                                 "OpenStudio received incomplete AI runtime metadata.",
                                 "The AI runtime manifest did not include the current platform archive details.",
                                 "runtime_manifest_invalid",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            const auto runtimeArchive = downloadsDir.getChildFile(runtimeFileName);
            appendAiToolsLogLine("runtimeArchive=" + runtimeArchive.getFullPathName());
            appendAiToolsLogLine("runtimeVersion=" + runtimeVersion);

            updateStep("downloading_runtime", 0.1f, "Downloading the OpenStudio AI runtime", kInstallSourceDownloadedRuntime);
            juce::String downloadError;
            if (! downloadFileWithProgress(juce::URL(runtimeUrl), runtimeArchive,
                                           [this, &logFile] (float progress, juce::int64 downloaded, juce::int64 total)
                                           {
                                               updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
                                               {
                                                   status.state = "downloading_runtime";
                                                   status.progress = juce::jmap(progress, 0.1f, 0.55f);
                                                   status.available = false;
                                                   status.installInProgress = true;
                                                   status.message = total > 0
                                                       ? "Downloading the OpenStudio AI runtime (" + juce::String(downloaded / (1024 * 1024)) + " / " + juce::String(total / (1024 * 1024)) + " MB)"
                                                       : "Downloading the OpenStudio AI runtime";
                                                   status.detailLogPath = logFile.getFullPathName();
                                                   status.buildRuntimeMode = kBuildRuntimeModeDownloadedRuntime;
                                                   status.requiresExternalPython = false;
                                                   status.installSource = kInstallSourceDownloadedRuntime;
                                                   status.helpUrl.clear();
                                               });
                                           }, downloadError))
            {
                if (aiToolsCancelRequested.load())
                {
                    finishCancelled();
                    return;
                }

                finishWithStatus("error", 0.1f,
                                 "OpenStudio could not download the AI runtime.",
                                 downloadError,
                                 "runtime_download_failed",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            updateStep("verifying_runtime_archive", 0.6f, "Verifying the downloaded AI runtime", kInstallSourceDownloadedRuntime);
            juce::String hashError;
            if (! verifyFileSha256(runtimeArchive, runtimeSha256, hashError))
            {
                finishWithStatus("error", 0.6f,
                                 "OpenStudio could not verify the AI runtime download.",
                                 hashError,
                                 "runtime_checksum_failed",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            if (aiToolsCancelRequested.load())
            {
                finishCancelled();
                return;
            }

            updateStep("extracting_runtime", 0.7f, "Extracting the OpenStudio AI runtime", kInstallSourceDownloadedRuntime);
            juce::String extractionError;
            if (! extractRuntimeArchive(runtimeArchive, runtimeRoot, extractionError))
            {
                finishWithStatus("error", 0.7f,
                                 "OpenStudio could not prepare the AI runtime on this machine.",
                                 extractionError,
                                 "runtime_extraction_failed",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            launcherPython = findPythonInRuntimeRoot(runtimeRoot);
            if (! launcherPython.existsAsFile())
            {
                finishWithStatus("error", 0.75f,
                                 "OpenStudio could not verify the downloaded AI runtime.",
                                 "The extracted AI runtime did not contain a usable Python executable.",
                                 "runtime_verification_failed",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            launchMode = " --verify-existing-runtime";
            updateStep("verifying_runtime", 0.8f, "Verifying the downloaded AI runtime", kInstallSourceDownloadedRuntime);
        }

        auto cmd = quoteCommandPart(launcherPython.getFullPathName())
            + " " + quoteCommandPart(installerScript.getFullPathName())
            + " --runtime-root " + quoteCommandPart(runtimeRoot.getFullPathName())
            + " --models-dir " + quoteCommandPart(modelsDir.getFullPathName())
            + " --model " + quoteCommandPart(kStemModelName)
            + " --log-path " + quoteCommandPart(logFile.getFullPathName())
            + launchMode;

        auto nextInstallProcess = std::make_unique<juce::ChildProcess>();
        if (! nextInstallProcess->start(cmd))
        {
            finishWithStatus("error", 0.0f,
                             "Failed to start the AI tools installer.",
                             "Could not start the AI tools installer process.",
                             "installer_launch_failed",
                             systemPython.existsAsFile(),
                             false,
                             false,
                             devFallbackEnabled,
                             devFallbackEnabled ? juce::String(kInstallSourceExternalPython) : juce::String(kInstallSourceDownloadedRuntime),
                             devFallbackEnabled ? juce::String(kBuildRuntimeModeUnbundledDev) : juce::String(kBuildRuntimeModeDownloadedRuntime));
            return;
        }

        {
            const juce::ScopedLock lock (aiToolsStatusLock);
            installOutputBuffer.clear();
            installProcess = std::move(nextInstallProcess);
            lastAiToolsStatus.state = devFallbackEnabled ? "creating_venv" : "verifying_runtime";
            lastAiToolsStatus.progress = devFallbackEnabled ? 0.1f : 0.8f;
            lastAiToolsStatus.available = false;
            lastAiToolsStatus.installInProgress = true;
            lastAiToolsStatus.pythonDetected = systemPython.existsAsFile();
            lastAiToolsStatus.installerAvailable = true;
            lastAiToolsStatus.buildRuntimeMode = devFallbackEnabled ? kBuildRuntimeModeUnbundledDev : kBuildRuntimeModeDownloadedRuntime;
            lastAiToolsStatus.requiresExternalPython = devFallbackEnabled;
            lastAiToolsStatus.installSource = devFallbackEnabled ? juce::String(kInstallSourceExternalPython)
                                                                 : juce::String(kInstallSourceDownloadedRuntime);
            lastAiToolsStatus.detailLogPath = logFile.getFullPathName();
            lastAiToolsStatus.message = devFallbackEnabled
                ? "Starting AI tools installation..."
                : "Finishing AI runtime verification and model setup...";
            lastAiToolsStatus.error.clear();
            lastAiToolsStatus.errorCode.clear();
            lastAiToolsStatus.helpUrl = devFallbackEnabled ? juce::String(kPythonHelpUrl) : juce::String();
        }
    }).detach();

    result->setProperty("started", true);
    result->setProperty("status", aiToolsStatusToVar(getCachedAiToolsStatusSnapshot()));
    return juce::var(result.release());
}

void StemSeparator::pollInstallProgress()
{
    bool shouldRefreshAfterExit = false;

    {
        const juce::ScopedLock lock (aiToolsStatusLock);
        if (! installProcess)
            return;

        char buffer[4096];
        while (installProcess->isRunning())
        {
            auto bytesRead = installProcess->readProcessOutput(buffer, sizeof(buffer) - 1);
            if (bytesRead <= 0)
                break;

            buffer[bytesRead] = '\0';
            installOutputBuffer += juce::String::fromUTF8(buffer, static_cast<int>(bytesRead));
        }

        if (! installProcess->isRunning())
        {
            for (;;)
            {
                auto bytesRead = installProcess->readProcessOutput(buffer, sizeof(buffer) - 1);
                if (bytesRead <= 0)
                    break;

                buffer[bytesRead] = '\0';
                installOutputBuffer += juce::String::fromUTF8(buffer, static_cast<int>(bytesRead));
            }
        }

        while (installOutputBuffer.contains("\n"))
        {
            const auto lineEnd = installOutputBuffer.indexOfChar('\n');
            const auto line = installOutputBuffer.substring(0, lineEnd).trim();
            installOutputBuffer = installOutputBuffer.substring(lineEnd + 1);

            if (line.startsWith("{"))
                lastAiToolsStatus = parseInstallJsonLine(line);
        }

        if (! installProcess->isRunning())
        {
            const auto exitCode = installProcess->getExitCode();
            if (installOutputBuffer.trim().startsWith("{"))
                lastAiToolsStatus = parseInstallJsonLine(installOutputBuffer.trim());

            if (exitCode != 0 && lastAiToolsStatus.state != "error" && lastAiToolsStatus.state != "cancelled")
            {
                lastAiToolsStatus.state = "error";
                lastAiToolsStatus.progress = 0.0f;
                lastAiToolsStatus.error = "AI tools installer exited with code " + juce::String(exitCode) + ".";
                lastAiToolsStatus.errorCode = "installer_exit_nonzero";
                lastAiToolsStatus.message = "AI tools installation failed.";
            }

            if (lastAiToolsStatus.state != "error" && lastAiToolsStatus.state != "cancelled")
            {
                lastAiToolsStatus.state = "checking";
                lastAiToolsStatus.message = "Verifying AI tools installation...";
            }

            lastAiToolsStatus.installInProgress = false;
            aiToolsInstallWorkInProgress = false;
            installProcess.reset();
            installOutputBuffer.clear();
            shouldRefreshAfterExit = true;
        }
    }

    if (shouldRefreshAfterExit)
        scheduleStatusRefresh();
}

StemSeparator::AiToolsStatus StemSeparator::parseInstallJsonLine(const juce::String& line) const
{
    auto status = getCachedAiToolsStatusSnapshot();
    const auto json = juce::JSON::parse(line);
    if (! json.isObject())
        return status;

    if (json.hasProperty("state"))
        status.state = json["state"].toString();
    if (json.hasProperty("progress"))
        status.progress = static_cast<float>(static_cast<double>(json["progress"]));
    if (json.hasProperty("message"))
        status.message = json["message"].toString();
    if (json.hasProperty("error"))
        status.error = json["error"].toString();
    if (json.hasProperty("errorCode"))
        status.errorCode = json["errorCode"].toString();
    if (json.hasProperty("detailLogPath"))
        status.detailLogPath = json["detailLogPath"].toString();
    if (json.hasProperty("installSource"))
        status.installSource = json["installSource"].toString();
    if (json.hasProperty("buildRuntimeMode"))
        status.buildRuntimeMode = json["buildRuntimeMode"].toString();
    if (json.hasProperty("requiresExternalPython"))
        status.requiresExternalPython = static_cast<bool>(json["requiresExternalPython"]);
    if (json.hasProperty("pythonDetected"))
        status.pythonDetected = static_cast<bool>(json["pythonDetected"]);
    if (json.hasProperty("runtimeInstalled"))
        status.runtimeInstalled = static_cast<bool>(json["runtimeInstalled"]);
    if (json.hasProperty("modelInstalled"))
        status.modelInstalled = static_cast<bool>(json["modelInstalled"]);
    if (json.hasProperty("available"))
        status.available = static_cast<bool>(json["available"]);

    status.installInProgress = ! isAiToolsTerminalState(status.state);
    if (status.requiresExternalPython && status.helpUrl.isEmpty())
        status.helpUrl = kPythonHelpUrl;
    else if (! status.requiresExternalPython)
        status.helpUrl.clear();

    if (status.buildRuntimeMode.isEmpty())
        status.buildRuntimeMode = isExternalPythonFallbackEnabled() ? kBuildRuntimeModeUnbundledDev : kBuildRuntimeModeDownloadedRuntime;
    return status;
}

bool StemSeparator::isAvailable() const
{
    return getCachedAiToolsStatusSnapshot().available;
}

bool StemSeparator::startSeparation(const juce::File& inputFile,
                                    const juce::File& outputDir,
                                    const juce::StringArray& stemNames,
                                    bool useGPU,
                                    const juce::String& modelName)
{
    if (isRunning())
    {
        juce::Logger::writeToLog("StemSeparator: Already running.");
        return false;
    }

    auto status = getCachedAiToolsStatusSnapshot();
    if (! status.available)
    {
        juce::String errorMessage = status.message;
        if (status.state == "pythonMissing")
            errorMessage = "Python 3.10 through 3.13 is required before installing AI Tools in this dev build.";
        else if (status.state == "runtimeMissing" || status.state == "modelMissing")
            errorMessage = "Install AI Tools before using stem separation.";
        else if (status.state == "error" && status.error.isNotEmpty())
            errorMessage = status.error;

        lastProgress = { "error", 0.0f, {}, errorMessage };
        return false;
    }

    auto python = findPython();
    auto script = findScript();
    auto modelsDir = findModelsDir();

    if (! python.existsAsFile())
    {
        lastProgress = { "error", 0.0f, {}, "Python not found. Install AI Tools first." };
        juce::Logger::writeToLog("StemSeparator: Python not found.");
        return false;
    }

    if (! script.existsAsFile())
    {
        lastProgress = { "error", 0.0f, {}, "stem_separator.py not found." };
        juce::Logger::writeToLog("StemSeparator: Script not found.");
        return false;
    }

    outputDir.createDirectory();

    juce::String cmd = quoteCommandPart(python.getFullPathName())
        + " " + quoteCommandPart(script.getFullPathName())
        + " --input " + quoteCommandPart(inputFile.getFullPathName())
        + " --output-dir " + quoteCommandPart(outputDir.getFullPathName())
        + " --model " + quoteCommandPart(modelName)
        + " --models-dir " + quoteCommandPart(modelsDir.getFullPathName())
        + " --stems " + stemNames.joinIntoString(",")
        + (useGPU ? " --gpu" : "");

    juce::Logger::writeToLog("StemSeparator: Starting: " + cmd);

    outputBuffer.clear();
    lastProgress = { "loading", 0.0f, {}, {} };

    childProcess = std::make_unique<juce::ChildProcess>();
    if (! childProcess->start(cmd))
    {
        lastProgress = { "error", 0.0f, {}, "Failed to start Python process." };
        childProcess.reset();
        return false;
    }

    return true;
}

StemSeparator::SeparationProgress StemSeparator::pollProgress()
{
    if (! childProcess)
        return lastProgress;

    char buffer[4096];
    while (childProcess->isRunning())
    {
        auto bytesRead = childProcess->readProcessOutput(buffer, sizeof(buffer) - 1);
        if (bytesRead <= 0)
            break;

        buffer[bytesRead] = '\0';
        outputBuffer += juce::String::fromUTF8(buffer, static_cast<int>(bytesRead));
    }

    if (! childProcess->isRunning())
    {
        for (;;)
        {
            auto bytesRead = childProcess->readProcessOutput(buffer, sizeof(buffer) - 1);
            if (bytesRead <= 0)
                break;
            buffer[bytesRead] = '\0';
            outputBuffer += juce::String::fromUTF8(buffer, static_cast<int>(bytesRead));
        }
    }

    while (outputBuffer.contains("\n"))
    {
        auto lineEnd = outputBuffer.indexOfChar('\n');
        auto line = outputBuffer.substring(0, lineEnd).trim();
        outputBuffer = outputBuffer.substring(lineEnd + 1);

        if (line.startsWith("{"))
            lastProgress = parseJsonLine(line);
    }

    if (! childProcess->isRunning() && lastProgress.state != "done" && lastProgress.state != "error")
    {
        auto exitCode = childProcess->getExitCode();
        if (exitCode != 0)
        {
            lastProgress.state = "error";
            lastProgress.error = "Python process exited with code " + juce::String(exitCode);

            if (outputBuffer.trim().startsWith("{"))
            {
                auto parsed = parseJsonLine(outputBuffer.trim());
                if (parsed.state == "error")
                    lastProgress = parsed;
            }
        }
    }

    return lastProgress;
}

StemSeparator::SeparationProgress StemSeparator::parseJsonLine(const juce::String& line) const
{
    SeparationProgress result = lastProgress;

    auto json = juce::JSON::parse(line);
    if (! json.isObject())
        return result;

    if (json.hasProperty("state"))
        result.state = json["state"].toString();

    if (json.hasProperty("progress"))
        result.progress = static_cast<float>(static_cast<double>(json["progress"]));

    if (json.hasProperty("error"))
        result.error = json["error"].toString();

    if (json.hasProperty("stems"))
    {
        result.stemFiles = {};
        if (auto* stemsObj = json["stems"].getDynamicObject())
        {
            for (const auto& prop : stemsObj->getProperties())
                result.stemFiles.set(prop.name.toString(), prop.value.toString());
        }
    }

    return result;
}

void StemSeparator::cancel()
{
    if (childProcess && childProcess->isRunning())
    {
        childProcess->kill();
        juce::Logger::writeToLog("StemSeparator: Cancelled.");
    }
    childProcess.reset();
    lastProgress = { "idle", 0.0f, {}, {} };
    outputBuffer.clear();
}

void StemSeparator::cancelAiToolsInstall()
{
    aiToolsCancelRequested = true;

    {
        const juce::ScopedLock lock (aiToolsStatusLock);
        if (installProcess && installProcess->isRunning())
        {
            installProcess->kill();
            juce::Logger::writeToLog("StemSeparator: AI tools install cancelled.");
        }
        installProcess.reset();
        installOutputBuffer.clear();
    }

    aiToolsInstallWorkInProgress = false;

    updateCachedAiToolsStatus ([] (AiToolsStatus& status)
    {
        status.state = "cancelled";
        status.progress = 0.0f;
        status.available = false;
        status.installInProgress = false;
        status.message = "AI tools installation was cancelled.";
        status.error.clear();
        status.errorCode.clear();
        if (status.requiresExternalPython)
            status.helpUrl = kPythonHelpUrl;
        else
            status.helpUrl.clear();
    });
}

bool StemSeparator::isRunning() const
{
    return childProcess && childProcess->isRunning();
}

juce::var StemSeparator::resultToJSON(const juce::StringPairArray& stemFiles, bool success,
                                      const juce::String& errorMsg)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty("success", success);

    if (errorMsg.isNotEmpty())
        obj->setProperty("error", errorMsg);

    juce::Array<juce::var> stems;
    for (const auto& key : stemFiles.getAllKeys())
    {
        auto stemObj = std::make_unique<juce::DynamicObject>();
        stemObj->setProperty("name", key);
        stemObj->setProperty("filePath", stemFiles[key]);
        stems.add(juce::var(stemObj.release()));
    }
    obj->setProperty("stems", stems);

    return juce::var(obj.release());
}
