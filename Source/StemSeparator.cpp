#include "StemSeparator.h"

namespace
{
constexpr auto kStemModelName = "BS-Roformer-SW.ckpt";
constexpr auto kPythonHelpUrl = "https://www.python.org/downloads/";
constexpr auto kInstallSourceDownloadedRuntime = "downloadedRuntime";
constexpr auto kInstallSourceExternalPython = "externalPython";
constexpr auto kBuildRuntimeModeDownloadedRuntime = "downloaded-runtime";
constexpr auto kBuildRuntimeModeUnbundledDev = "unbundled-dev";
constexpr double kInstallerOutputTimeoutMs = 20000.0;

struct RuntimeDownloadCandidate
{
    juce::String key;
    juce::String displayName;
    juce::String selectionReason;
    juce::var manifestNode;
};

juce::String makePythonImportCommand()
{
    return "-c \"import audio_separator.separator; print('ok')\"";
}

juce::String quoteCommandPart(const juce::String& value)
{
    return value.quoted();
}

juce::String getPropertyString (const juce::var& value, const juce::Identifier& property)
{
    if (auto* obj = value.getDynamicObject())
        return obj->getProperty(property).toString();
    return {};
}

juce::StringArray varToStringArray (const juce::var& value)
{
    juce::StringArray result;
    if (auto* array = value.getArray())
    {
        for (const auto& item : *array)
            result.add(item.toString());
    }
    return result;
}

juce::String summariseDiagnosticLines (const juce::StringArray& lines)
{
    if (lines.isEmpty())
        return {};

    auto joined = lines.joinIntoString(" | ");
    constexpr int maxLength = 280;
    if (joined.length() > maxLength)
        joined = joined.substring(0, maxLength - 3) + "...";
    return joined;
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

bool isInstallerTerminalFailureCode (const juce::String& errorCode)
{
    return errorCode == "installer_exited_incomplete"
        || errorCode == "installer_output_timeout";
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

juce::String makeIsoTimestamp()
{
    return juce::Time::getCurrentTime().toISO8601(true);
}

juce::String makeAiLogEvent (const juce::String& component,
                             const juce::String& phase,
                             const juce::String& event,
                             const juce::String& sessionId,
                             const std::function<void (juce::DynamicObject&)>& extraFields = {})
{
    auto payload = std::make_unique<juce::DynamicObject>();
    payload->setProperty("timestamp", makeIsoTimestamp());
    payload->setProperty("component", component);
    payload->setProperty("phase", phase);
    payload->setProperty("event", event);
    if (sessionId.isNotEmpty())
        payload->setProperty("sessionId", sessionId);
    if (extraFields)
        extraFields(*payload);
    return juce::JSON::toString(juce::var(payload.release()), true);
}

bool isLikelyNvidiaWindowsMachine()
{
#if JUCE_WINDOWS
    juce::ChildProcess probe;
    const auto command = "powershell -NoProfile -Command \"try { (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '\\n' } catch { '' }\"";
    if (probe.start(command) && probe.waitForProcessToFinish(8000))
        return probe.readAllProcessOutput().containsIgnoreCase("nvidia");
#endif
    return false;
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

juce::String StemSeparator::getAiRuntimeArchitectureKey() const
{
#if JUCE_WINDOWS
    return "x64";
#elif JUCE_MAC
   #if defined(__aarch64__) || defined(__arm64__) || defined(JUCE_ARM)
    return "arm64";
   #else
    return "x64";
   #endif
#else
    return {};
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
        python = runtimeRoot.getChildFile("python/python.exe");
    if (! python.existsAsFile())
        python = runtimeRoot.getChildFile("Scripts/python.exe");
#else
    auto python = runtimeRoot.getChildFile("python3");
    if (! python.existsAsFile())
        python = runtimeRoot.getChildFile("python/bin/python3");
    if (! python.existsAsFile())
        python = runtimeRoot.getChildFile("bin/python3");
    if (! python.existsAsFile())
        python = runtimeRoot.getChildFile("python/bin/python");
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

juce::File StemSeparator::findRuntimeProbeScript() const
{
    auto appDir = getApplicationRuntimeDirectory();

    auto script = appDir.getChildFile("../../../tools/ai_runtime_probe.py");
    if (script.existsAsFile())
        return script;

    script = appDir.getChildFile("scripts/ai_runtime_probe.py");
    if (script.existsAsFile())
        return script;

#if JUCE_MAC
    auto resourcesDir = appDir.getParentDirectory().getChildFile("Resources");
    script = resourcesDir.getChildFile("scripts/ai_runtime_probe.py");
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

StemSeparator::RuntimeCapabilities StemSeparator::probeRuntimeCapabilities (const juce::File& python,
                                                                            const juce::File& modelsDir,
                                                                            const juce::String& modelName,
                                                                            const juce::String& accelerationMode) const
{
    RuntimeCapabilities capabilities;

    if (! python.existsAsFile())
        return capabilities;

    const auto probeScript = findRuntimeProbeScript();
    if (! probeScript.existsAsFile())
        return capabilities;

    juce::ChildProcess probe;
    const auto command = quoteCommandPart(python.getFullPathName())
        + " " + quoteCommandPart(probeScript.getFullPathName())
        + " --models-dir " + quoteCommandPart(modelsDir.getFullPathName())
        + " --model " + quoteCommandPart(modelName)
        + " --acceleration-mode " + quoteCommandPart(accelerationMode);

    if (! probe.start(command) || ! probe.waitForProcessToFinish(15000))
        return capabilities;

    auto output = probe.readAllProcessOutput().trim();
    if (probe.getExitCode() != 0 || output.isEmpty())
        return capabilities;

    const auto lastLine = output.fromLastOccurrenceOf("\n", false, false).trim();
    const auto json = juce::JSON::parse(lastLine.isNotEmpty() ? lastLine : output);
    if (! json.isObject())
        return capabilities;

    if (auto* obj = json.getDynamicObject())
    {
        capabilities.runtimeReady = static_cast<bool>(obj->getProperty("runtimeReady"));
        capabilities.modelInstalled = static_cast<bool>(obj->getProperty("modelInstalled"));
        capabilities.supportedBackends = varToStringArray(obj->getProperty("supportedBackends"));
        capabilities.selectedBackend = obj->getProperty("selectedBackend").toString();
        capabilities.runtimeVersion = obj->getProperty("runtimeVersion").toString();
        capabilities.modelVersion = obj->getProperty("modelVersion").toString();
        capabilities.restartRequired = static_cast<bool>(obj->getProperty("restartRequired"));
    }

    if (capabilities.supportedBackends.isEmpty())
        capabilities.supportedBackends.add("cpu");
    if (capabilities.selectedBackend.isEmpty())
        capabilities.selectedBackend = "cpu";
    if (capabilities.modelVersion.isEmpty())
        capabilities.modelVersion = modelName;

    return capabilities;
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
        status.terminalReason.clear();
        status.lastPhase = "ready";
        status.message = "AI tools are ready.";
        return status;
    }

    if (status.state == "error" && isInstallerTerminalFailureCode(status.errorCode))
    {
        status.available = false;
        status.installInProgress = false;
        status.terminalReason = status.errorCode;

        if (status.message.isEmpty())
            status.message = "OpenStudio could not confirm that AI Tools finished installing.";

        return status;
    }

    if (! status.installerAvailable)
    {
        status.state = "error";
        status.progress = 0.0f;
        status.message = "The AI tools installer is unavailable in this build.";
        status.error = "AI tools installer script not found.";
        status.errorCode = "installer_unavailable";
        status.lastPhase = "installer_unavailable";
        status.terminalReason = status.errorCode;
        return status;
    }

    if (! devFallbackEnabled && manifestUrl.isEmpty())
    {
        status.state = "error";
        status.progress = 0.0f;
        status.message = "This release is missing its AI runtime download configuration. Reinstall OpenStudio or contact support.";
        status.error = "OpenStudio could not find the compiled AI runtime manifest URL for this installed build.";
        status.errorCode = "runtime_manifest_missing";
        status.lastPhase = "fetching_runtime_manifest";
        status.terminalReason = status.errorCode;
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
            status.lastPhase = "pythonMissing";
            status.terminalReason.clear();
            return status;
        }

        status.state = "runtimeMissing";
        status.progress = 0.0f;
        status.message = status.requiresExternalPython
            ? "Install AI Tools to create the local stem-separation runtime."
            : "Install AI Tools to download the managed OpenStudio AI runtime.";
        status.error.clear();
        status.errorCode.clear();
        status.lastPhase = "runtimeMissing";
        status.terminalReason.clear();
        return status;
    }

    status.state = "modelMissing";
    status.progress = 0.0f;
    status.message = "Install AI Tools to download the stem separation model.";
    status.error.clear();
    status.errorCode.clear();
    status.lastPhase = "modelMissing";
    status.terminalReason.clear();
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
    status.lastPhase = status.state;
    status.supportedBackends.add("cpu");
    status.selectedBackend = "cpu";
    status.modelVersion = kStemModelName;
    status.fallbackAttempted = false;
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
    if (status.supportedBackends.isEmpty())
        status.supportedBackends.add("cpu");
    if (status.selectedBackend.isEmpty())
        status.selectedBackend = "cpu";
    if (status.modelVersion.isEmpty())
        status.modelVersion = kStemModelName;
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
        const auto previousStatus = getCachedAiToolsStatusSnapshot();
        auto installedPython = findPython();
        auto systemPython = findSystemPython();
        auto script = findScript();
        auto installerScript = findInstallerScript();
        const auto modelsDir = getUserModelsDir();
        auto runtimeCapabilities = installedPython.existsAsFile()
            ? probeRuntimeCapabilities(installedPython, modelsDir, kStemModelName, "auto")
            : RuntimeCapabilities{};
        const auto modelInstalled = runtimeCapabilities.modelInstalled || hasRequiredModel(modelsDir);
        const auto runtimeInstalled = runtimeCapabilities.runtimeReady;
        auto refreshedStatus = buildAiToolsStatus (systemPython, script, installerScript, runtimeInstalled, modelInstalled);
        refreshedStatus.supportedBackends = runtimeCapabilities.supportedBackends;
        refreshedStatus.selectedBackend = runtimeCapabilities.selectedBackend;
        refreshedStatus.runtimeVersion = runtimeCapabilities.runtimeVersion;
        refreshedStatus.modelVersion = runtimeCapabilities.modelVersion;
        refreshedStatus.restartRequired = runtimeCapabilities.restartRequired;

        if (isInstallerTerminalFailureCode(previousStatus.errorCode))
        {
            appendAiToolsLogLine(makeAiLogEvent("host",
                                                "refresh",
                                                "post_exit_refresh_result",
                                                previousStatus.installSessionId,
                                                [&] (juce::DynamicObject& obj)
                                                {
                                                    obj.setProperty("runtimeCandidate", previousStatus.runtimeCandidate);
                                                    obj.setProperty("previousErrorCode", previousStatus.errorCode);
                                                    obj.setProperty("lastPhase", previousStatus.lastPhase);
                                                    obj.setProperty("refreshedState", refreshedStatus.state);
                                                    obj.setProperty("runtimeInstalled", refreshedStatus.runtimeInstalled);
                                                    obj.setProperty("modelInstalled", refreshedStatus.modelInstalled);
                                                    obj.setProperty("available", refreshedStatus.available);
                                                }));
        }

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

bool StemSeparator::extractRuntimeArchive (const juce::File& archiveFile,
                                           const juce::File& destinationRoot,
                                           juce::String& error,
                                           juce::String& errorCode) const
{
    if (! archiveFile.existsAsFile())
    {
        error = "The AI runtime archive was not found for extraction.";
        errorCode = "runtime_extraction_failed";
        return false;
    }

    const auto extractionRoot = destinationRoot.getSiblingFile(destinationRoot.getFileName() + "-extract");
    extractionRoot.deleteRecursively();
    extractionRoot.createDirectory();

    juce::ZipFile zip(archiveFile);
    if (auto result = zip.uncompressTo(extractionRoot); result.failed())
    {
        error = result.getErrorMessage();
        errorCode = "runtime_extraction_failed";
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
        errorCode = "runtime_extraction_failed";
        extractionRoot.deleteRecursively();
        return false;
    }

    if (sourceRoot.getChildFile("pyvenv.cfg").existsAsFile())
    {
        error = "The downloaded AI runtime still contains pyvenv.cfg and is not relocatable.";
        errorCode = "runtime_not_relocatable";
        extractionRoot.deleteRecursively();
        return false;
    }

    if (! sourceRoot.getChildFile(".openstudio-ai-runtime.json").existsAsFile())
    {
        error = "The downloaded AI runtime is missing OpenStudio runtime metadata.";
        errorCode = "runtime_validation_failed";
        extractionRoot.deleteRecursively();
        return false;
    }

    destinationRoot.deleteRecursively();
    destinationRoot.createDirectory();
    if (! sourceRoot.copyDirectoryTo(destinationRoot))
    {
        error = "OpenStudio could not copy the extracted AI runtime into your user profile.";
        errorCode = "runtime_extraction_failed";
        extractionRoot.deleteRecursively();
        return false;
    }

    extractionRoot.deleteRecursively();
    return true;
}

juce::var StemSeparator::aiToolsStatusToVar(const AiToolsStatus& status)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    juce::Array<juce::var> supportedBackends;
    for (const auto& backend : status.supportedBackends)
        supportedBackends.add(backend);
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
    obj->setProperty("supportedBackends", supportedBackends);
    obj->setProperty("selectedBackend", status.selectedBackend);
    obj->setProperty("runtimeVersion", status.runtimeVersion);
    obj->setProperty("modelVersion", status.modelVersion);
    obj->setProperty("verificationMode", status.verificationMode);
    obj->setProperty("runtimeCandidate", status.runtimeCandidate);
    obj->setProperty("installSessionId", status.installSessionId);
    obj->setProperty("lastPhase", status.lastPhase);
    obj->setProperty("terminalReason", status.terminalReason);
    obj->setProperty("fallbackAttempted", status.fallbackAttempted);
    obj->setProperty("restartRequired", status.restartRequired);
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
        const auto sessionId = juce::Uuid().toString();
        juce::String selectedRuntimeCandidate;
        bool fallbackAttempted = false;

        auto finishWithStatus = [this, &selectedRuntimeCandidate, &sessionId, &fallbackAttempted] (const juce::String& state,
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
                status.runtimeCandidate = selectedRuntimeCandidate;
                status.installSessionId = sessionId;
                status.lastPhase = state;
                status.terminalReason = state == "error" ? errorCode : juce::String();
                status.fallbackAttempted = fallbackAttempted;
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

        auto updateStep = [this, &logFile, devFallbackEnabled, &selectedRuntimeCandidate, &sessionId, &fallbackAttempted] (const juce::String& state,
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
                status.runtimeCandidate = selectedRuntimeCandidate;
                status.installSessionId = sessionId;
                status.lastPhase = state;
                status.terminalReason.clear();
                status.fallbackAttempted = fallbackAttempted;
            });
        };

        runtimeRoot.getParentDirectory().createDirectory();
        modelsDir.createDirectory();
        downloadsDir.createDirectory();
        logFile.getParentDirectory().createDirectory();
        logFile.replaceWithText({}, false, false, "\n");

        appendAiToolsLogLine("OpenStudio AI tools installer started");
        appendAiToolsLogLine(makeAiLogEvent("installer", "startup", "installer_started", sessionId));
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
            selectedRuntimeCandidate = "external-python";
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

            auto buildCandidateFromNode = [] (const juce::String& key,
                                              const juce::String& displayName,
                                              const juce::String& selectionReason,
                                              const juce::var& node)
            {
                RuntimeDownloadCandidate candidate;
                candidate.key = key;
                candidate.displayName = displayName;
                candidate.selectionReason = selectionReason;
                candidate.manifestNode = node;
                return candidate;
            };

            juce::Array<RuntimeDownloadCandidate> runtimeCandidates;
            juce::String runtimeVersion;

            if (auto* manifestObject = manifest.getDynamicObject())
            {
                runtimeVersion = manifestObject->getProperty("runtimeVersion").toString().trim();
                auto platforms = manifestObject->getProperty("platforms");
                if (auto* platformsObject = platforms.getDynamicObject())
                {
                    auto platformNode = platformsObject->getProperty(getAiRuntimePlatformKey());

#if JUCE_MAC
                    if (auto* macPlatformObject = platformNode.getDynamicObject())
                    {
                        const auto architectureKey = getAiRuntimeArchitectureKey();
                        const auto architectureNode = macPlatformObject->getProperty(architectureKey);
                        if (! architectureNode.isVoid() && ! architectureNode.isUndefined())
                        {
                            appendAiToolsLogLine("runtimeArchitecture=" + architectureKey);
                            runtimeCandidates.add(buildCandidateFromNode("macos-" + architectureKey,
                                                                         "macOS " + architectureKey,
                                                                         "Selected by current macOS architecture.",
                                                                         architectureNode));
                        }
                        else if (! macPlatformObject->getProperty("arm64").isVoid()
                                 || ! macPlatformObject->getProperty("x64").isVoid())
                        {
                            finishWithStatus("error", 0.05f,
                                             "AI Tools are not available for this Mac yet.",
                                             "The published AI runtime metadata does not include a macOS " + architectureKey + " runtime for this release.",
                                             "runtime_platform_unsupported",
                                             false,
                                             false,
                                             false,
                                             false,
                                             kInstallSourceDownloadedRuntime,
                                             kBuildRuntimeModeDownloadedRuntime);
                            return;
                        }
                    }
                    else if (! platformNode.isVoid() && ! platformNode.isUndefined())
                    {
                        runtimeCandidates.add(buildCandidateFromNode("macos-legacy",
                                                                     "macOS runtime",
                                                                     "Using legacy macOS runtime manifest entry.",
                                                                     platformNode));
                    }
#elif JUCE_WINDOWS
                    if (auto* windowsPlatformObject = platformNode.getDynamicObject())
                    {
                        const auto likelyNvidia = isLikelyNvidiaWindowsMachine();
                        appendAiToolsLogLine("windowsHardwareClass=" + juce::String(likelyNvidia ? "nvidia" : "non-nvidia"));
                        if (auto* backendsObject = windowsPlatformObject->getProperty("backends").getDynamicObject())
                        {
                            const auto cudaNode = backendsObject->getProperty("cuda");
                            const auto directmlNode = backendsObject->getProperty("directml");
                            if (likelyNvidia && ! cudaNode.isVoid() && ! cudaNode.isUndefined())
                                runtimeCandidates.add(buildCandidateFromNode("windows-cuda-x64", "Windows CUDA runtime", "Selected first because NVIDIA hardware was detected.", cudaNode));
                            if (! directmlNode.isVoid() && ! directmlNode.isUndefined())
                                runtimeCandidates.add(buildCandidateFromNode("windows-directml-x64", "Windows DirectML runtime", likelyNvidia ? "Prepared as fallback if CUDA validation fails." : "Selected because no NVIDIA hardware was detected.", directmlNode));
                            if (! likelyNvidia && ! cudaNode.isVoid() && ! cudaNode.isUndefined() && runtimeCandidates.isEmpty())
                                runtimeCandidates.add(buildCandidateFromNode("windows-cuda-x64", "Windows CUDA runtime", "Using CUDA runtime because it is the only published Windows candidate.", cudaNode));
                        }

                        if (runtimeCandidates.isEmpty() && getPropertyString(platformNode, "url").isNotEmpty())
                            runtimeCandidates.add(buildCandidateFromNode("windows-legacy", "Windows runtime", "Using legacy flat Windows runtime manifest entry.", platformNode));
                    }
#else
                    if (! platformNode.isVoid() && ! platformNode.isUndefined())
                        runtimeCandidates.add(buildCandidateFromNode(getAiRuntimePlatformKey(), getAiRuntimePlatformKey() + " runtime", "Using platform runtime manifest entry.", platformNode));
#endif
                }
            }

            appendAiToolsLogLine(makeAiLogEvent("installer", "manifest", "manifest_fetch_succeeded", sessionId,
                                                [&] (juce::DynamicObject& obj)
                                                {
                                                    obj.setProperty("runtimeVersion", runtimeVersion);
                                                    obj.setProperty("candidateCount", runtimeCandidates.size());
                                                }));

            if (runtimeCandidates.isEmpty())
            {
                finishWithStatus("error", 0.05f,
                                 "OpenStudio received incomplete AI runtime metadata.",
                                 "The AI runtime manifest did not include the current platform runtime details.",
                                 "runtime_manifest_invalid",
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }

            juce::StringArray candidateKeys;
            for (const auto& candidate : runtimeCandidates)
                candidateKeys.add(candidate.key);
            appendAiToolsLogLine("runtimeCandidates=" + candidateKeys.joinIntoString(","));
            appendAiToolsLogLine(makeAiLogEvent("installer", "selection", "runtime_candidates_ready", sessionId,
                                                [&] (juce::DynamicObject& obj)
                                                {
                                                    obj.setProperty("candidateKeys", candidateKeys.joinIntoString(","));
                                                }));

            bool runtimePrepared = false;
            juce::String terminalUserMessage;
            juce::String terminalError;
            juce::String terminalErrorCode;

            for (int candidateIndex = 0; candidateIndex < runtimeCandidates.size(); ++candidateIndex)
            {
                const auto& candidate = runtimeCandidates.getReference(candidateIndex);
                selectedRuntimeCandidate = candidate.key;
                fallbackAttempted = candidateIndex > 0;

                appendAiToolsLogLine(makeAiLogEvent("installer", "selection", "runtime_candidate_selected", sessionId,
                                                    [&] (juce::DynamicObject& obj)
                                                    {
                                                        obj.setProperty("runtimeCandidate", candidate.key);
                                                        obj.setProperty("displayName", candidate.displayName);
                                                        obj.setProperty("selectionReason", candidate.selectionReason);
                                                        obj.setProperty("attempt", candidateIndex + 1);
                                                        obj.setProperty("fallbackAttempted", fallbackAttempted);
                                                    }));

                const auto runtimeUrl = getPropertyString(candidate.manifestNode, "url").trim();
                const auto runtimeSha256 = getPropertyString(candidate.manifestNode, "sha256").trim();
                auto runtimeFileName = getPropertyString(candidate.manifestNode, "fileName").trim();

                if (runtimeFileName.isEmpty())
                    runtimeFileName = juce::URL(runtimeUrl).getFileName();

                if (runtimeUrl.isEmpty() || runtimeSha256.isEmpty() || runtimeFileName.isEmpty())
                {
                    terminalUserMessage = "OpenStudio received incomplete AI runtime metadata.";
                    terminalError = "The AI runtime manifest did not include archive details for runtime candidate '" + candidate.key + "'.";
                    terminalErrorCode = "runtime_manifest_invalid";
                    continue;
                }

                const auto runtimeArchive = downloadsDir.getChildFile(runtimeFileName);
                appendAiToolsLogLine("runtimeArchive=" + runtimeArchive.getFullPathName());
                appendAiToolsLogLine("runtimeVersion=" + runtimeVersion);

                updateStep("downloading_runtime", 0.1f, "Downloading the OpenStudio AI runtime", kInstallSourceDownloadedRuntime);
                appendAiToolsLogLine(makeAiLogEvent("installer", "download", "runtime_download_started", sessionId,
                                                    [&] (juce::DynamicObject& obj)
                                                    {
                                                        obj.setProperty("runtimeCandidate", candidate.key);
                                                        obj.setProperty("runtimeArchive", runtimeArchive.getFullPathName());
                                                        obj.setProperty("runtimeUrl", runtimeUrl);
                                                    }));

                juce::String downloadError;
                if (! downloadFileWithProgress(juce::URL(runtimeUrl), runtimeArchive,
                                               [this, &logFile, candidate] (float progress, juce::int64 downloaded, juce::int64 total)
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
                                                       status.runtimeCandidate = candidate.key;
                                                   });
                                               }, downloadError))
                {
                    if (aiToolsCancelRequested.load())
                    {
                        finishCancelled();
                        return;
                    }

                    appendAiToolsLogLine(makeAiLogEvent("installer", "download", "runtime_download_failed", sessionId,
                                                        [&] (juce::DynamicObject& obj)
                                                        {
                                                            obj.setProperty("runtimeCandidate", candidate.key);
                                                            obj.setProperty("errorCode", "runtime_download_failed");
                                                            obj.setProperty("errorMessage", downloadError);
                                                        }));
                    terminalUserMessage = "OpenStudio could not download the AI runtime.";
                    terminalError = downloadError;
                    terminalErrorCode = "runtime_download_failed";
                    continue;
                }

                updateStep("verifying_runtime_archive", 0.6f, "Verifying the downloaded AI runtime", kInstallSourceDownloadedRuntime);
                juce::String hashError;
                if (! verifyFileSha256(runtimeArchive, runtimeSha256, hashError))
                {
                    appendAiToolsLogLine(makeAiLogEvent("installer", "checksum", "runtime_checksum_failed", sessionId,
                                                        [&] (juce::DynamicObject& obj)
                                                        {
                                                            obj.setProperty("runtimeCandidate", candidate.key);
                                                            obj.setProperty("errorCode", "runtime_checksum_failed");
                                                            obj.setProperty("errorMessage", hashError);
                                                        }));
                    terminalUserMessage = "OpenStudio could not verify the AI runtime download.";
                    terminalError = hashError;
                    terminalErrorCode = "runtime_checksum_failed";
                    continue;
                }

                if (aiToolsCancelRequested.load())
                {
                    finishCancelled();
                    return;
                }

                updateStep("extracting_runtime", 0.7f, "Extracting the OpenStudio AI runtime", kInstallSourceDownloadedRuntime);
                juce::String extractionError;
                juce::String extractionErrorCode;
                if (! extractRuntimeArchive(runtimeArchive, runtimeRoot, extractionError, extractionErrorCode))
                {
                    appendAiToolsLogLine(makeAiLogEvent("installer", "extract", "runtime_extraction_failed", sessionId,
                                                        [&] (juce::DynamicObject& obj)
                                                        {
                                                            obj.setProperty("runtimeCandidate", candidate.key);
                                                            obj.setProperty("errorCode", extractionErrorCode.isNotEmpty() ? extractionErrorCode : juce::String("runtime_extraction_failed"));
                                                            obj.setProperty("errorMessage", extractionError);
                                                        }));
                    terminalUserMessage = "OpenStudio could not prepare the AI runtime on this machine.";
                    terminalError = extractionError;
                    terminalErrorCode = extractionErrorCode.isNotEmpty() ? extractionErrorCode : juce::String("runtime_extraction_failed");
                    continue;
                }

                launcherPython = findPythonInRuntimeRoot(runtimeRoot);
                if (! launcherPython.existsAsFile())
                {
                    terminalUserMessage = "OpenStudio could not verify the downloaded AI runtime.";
                    terminalError = "The extracted AI runtime did not contain a usable Python executable.";
                    terminalErrorCode = "runtime_validation_failed";
                    continue;
                }

                updateStep("probing_runtime", 0.78f, "Probing the downloaded AI runtime", kInstallSourceDownloadedRuntime);
                const auto capabilities = probeRuntimeCapabilities(launcherPython, modelsDir, kStemModelName, "auto");
                appendAiToolsLogLine(makeAiLogEvent("installer", "probe", "runtime_probe_finished", sessionId,
                                                    [&] (juce::DynamicObject& obj)
                                                    {
                                                        obj.setProperty("runtimeCandidate", candidate.key);
                                                        obj.setProperty("runtimeReady", capabilities.runtimeReady);
                                                        obj.setProperty("selectedBackend", capabilities.selectedBackend);
                                                        obj.setProperty("supportedBackends", capabilities.supportedBackends.joinIntoString(","));
                                                    }));

                if (! capabilities.runtimeReady)
                {
                    terminalUserMessage = "OpenStudio could not verify the downloaded AI runtime.";
                    terminalError = "The extracted runtime failed its capability probe.";
                    terminalErrorCode = "runtime_validation_failed";
                    continue;
                }

#if JUCE_WINDOWS
                if (candidate.key == "windows-cuda-x64" && capabilities.selectedBackend != "cuda")
                {
                    appendAiToolsLogLine(makeAiLogEvent("installer", "fallback", "runtime_candidate_rejected", sessionId,
                                                        [&] (juce::DynamicObject& obj)
                                                        {
                                                            obj.setProperty("runtimeCandidate", candidate.key);
                                                            obj.setProperty("selectedBackend", capabilities.selectedBackend);
                                                            obj.setProperty("reason", "CUDA runtime did not activate the CUDA backend on this machine.");
                                                        }));
                    terminalUserMessage = "OpenStudio could not activate the preferred Windows GPU runtime.";
                    terminalError = "The CUDA runtime did not report a CUDA backend on this machine.";
                    terminalErrorCode = "runtime_backend_unavailable";
                    continue;
                }
#endif

                runtimePrepared = true;
                launchMode = juce::String(" --verify-existing-runtime")
                    + " --session-id " + quoteCommandPart(sessionId)
                    + " --runtime-candidate " + quoteCommandPart(candidate.key);
                if (fallbackAttempted)
                    launchMode += " --fallback-attempted";

                updateStep("verifying_runtime", 0.8f, "Verifying the downloaded AI runtime", kInstallSourceDownloadedRuntime);
                break;
            }

            if (! runtimePrepared)
            {
                finishWithStatus("error", 0.8f,
                                 terminalUserMessage.isNotEmpty() ? terminalUserMessage : juce::String("OpenStudio could not prepare the AI runtime."),
                                 terminalError,
                                 terminalErrorCode.isNotEmpty() ? terminalErrorCode : juce::String("runtime_validation_failed"),
                                 false,
                                 false,
                                 false,
                                 false,
                                 kInstallSourceDownloadedRuntime,
                                 kBuildRuntimeModeDownloadedRuntime);
                return;
            }
        }

        // Launch the installer directly via ChildProcess. Do not append shell
        // redirection here; those tokens would be passed through as literal argv.
        auto cmd = quoteCommandPart(launcherPython.getFullPathName())
            + " " + quoteCommandPart(installerScript.getFullPathName())
            + " --runtime-root " + quoteCommandPart(runtimeRoot.getFullPathName())
            + " --models-dir " + quoteCommandPart(modelsDir.getFullPathName())
            + " --model " + quoteCommandPart(kStemModelName)
            + " --log-path " + quoteCommandPart(logFile.getFullPathName())
            + launchMode;

        appendAiToolsLogLine("launcherPython=" + launcherPython.getFullPathName());
        appendAiToolsLogLine("runtimeRoot=" + runtimeRoot.getFullPathName());
        appendAiToolsLogLine("installerScript=" + installerScript.getFullPathName());
        appendAiToolsLogLine("installerCommand=" + cmd);
        appendAiToolsLogLine(makeAiLogEvent("host", "launch", "installer_launch_started", sessionId,
                                            [&] (juce::DynamicObject& obj)
                                            {
                                                obj.setProperty("runtimeCandidate", selectedRuntimeCandidate);
                                                obj.setProperty("command", cmd);
                                            }));

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
            installDiagnosticLines.clear();
            installCommandLine = cmd;
            installRuntimePythonPath = launcherPython.getFullPathName();
            installRuntimeRootPath = runtimeRoot.getFullPathName();
            installRuntimeCandidate = selectedRuntimeCandidate;
            installSessionId = sessionId;
            installLastObservedPhase = devFallbackEnabled ? juce::String("creating_venv") : juce::String("verifying_runtime");
            installLaunchTimeMs = juce::Time::getMillisecondCounterHiRes();
            installFirstOutputTimeMs = 0.0;
            installLastOutputTimeMs = 0.0;
            installSawTerminalStatus = false;
            installFallbackAttempted = fallbackAttempted;
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
            lastAiToolsStatus.runtimeCandidate = selectedRuntimeCandidate;
            lastAiToolsStatus.installSessionId = sessionId;
            lastAiToolsStatus.lastPhase = installLastObservedPhase;
            lastAiToolsStatus.terminalReason.clear();
            lastAiToolsStatus.fallbackAttempted = fallbackAttempted;
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

        auto noteInstallerOutput = [&]
        {
            const auto nowMs = juce::Time::getMillisecondCounterHiRes();
            if (installFirstOutputTimeMs <= 0.0)
            {
                installFirstOutputTimeMs = nowMs;
                appendAiToolsLogLine(makeAiLogEvent("host", "installer", "installer_first_output", installSessionId,
                                                    [&] (juce::DynamicObject& obj)
                                                    {
                                                        obj.setProperty("runtimeCandidate", installRuntimeCandidate);
                                                        obj.setProperty("launchDelayMs", juce::roundToInt(nowMs - installLaunchTimeMs));
                                                    }));
            }

            installLastOutputTimeMs = nowMs;
        };

        char buffer[4096];
        while (installProcess->isRunning())
        {
            auto bytesRead = installProcess->readProcessOutput(buffer, sizeof(buffer) - 1);
            if (bytesRead <= 0)
                break;

            buffer[bytesRead] = '\0';
            installOutputBuffer += juce::String::fromUTF8(buffer, static_cast<int>(bytesRead));
            noteInstallerOutput();
        }

        if (installProcess->isRunning()
            && installFirstOutputTimeMs <= 0.0
            && juce::Time::getMillisecondCounterHiRes() - installLaunchTimeMs >= kInstallerOutputTimeoutMs)
        {
            appendAiToolsLogLine(makeAiLogEvent("host", "installer", "installer_output_timeout", installSessionId,
                                                [&] (juce::DynamicObject& obj)
                                                {
                                                    obj.setProperty("runtimeCandidate", installRuntimeCandidate);
                                                    obj.setProperty("lastPhase", installLastObservedPhase);
                                                    obj.setProperty("timeoutMs", juce::roundToInt(kInstallerOutputTimeoutMs));
                                                }));

            lastAiToolsStatus.state = "error";
            lastAiToolsStatus.progress = 0.0f;
            lastAiToolsStatus.available = false;
            lastAiToolsStatus.message = "OpenStudio did not receive any installer progress from the AI tools setup.";
            lastAiToolsStatus.error = "The AI tools installer did not emit progress within "
                + juce::String(juce::roundToInt(kInstallerOutputTimeoutMs / 1000.0)) + " seconds.";
            lastAiToolsStatus.errorCode = "installer_output_timeout";
            lastAiToolsStatus.lastPhase = installLastObservedPhase.isNotEmpty() ? installLastObservedPhase : juce::String("installer_launch");
            lastAiToolsStatus.terminalReason = "installer_output_timeout";
            installProcess->kill();
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
                noteInstallerOutput();
            }
        }

        while (installOutputBuffer.contains("\n"))
        {
            const auto lineEnd = installOutputBuffer.indexOfChar('\n');
            const auto line = installOutputBuffer.substring(0, lineEnd).trim();
            installOutputBuffer = installOutputBuffer.substring(lineEnd + 1);

            if (line.startsWith("{"))
            {
                lastAiToolsStatus = parseInstallJsonLine(line);
                installLastObservedPhase = lastAiToolsStatus.lastPhase.isNotEmpty() ? lastAiToolsStatus.lastPhase
                                                                                    : lastAiToolsStatus.state;
                if (isAiToolsTerminalState(lastAiToolsStatus.state))
                    installSawTerminalStatus = true;
            }
            else if (line.isNotEmpty())
            {
                installDiagnosticLines.add(line);
                while (installDiagnosticLines.size() > 8)
                    installDiagnosticLines.remove(0);
                appendAiToolsLogLine("[installer] " + line);
            }
        }

        if (! installProcess->isRunning())
        {
            const auto exitCode = installProcess->getExitCode();
            const auto finalLine = installOutputBuffer.trim();
            if (finalLine.startsWith("{"))
            {
                lastAiToolsStatus = parseInstallJsonLine(finalLine);
                installLastObservedPhase = lastAiToolsStatus.lastPhase.isNotEmpty() ? lastAiToolsStatus.lastPhase
                                                                                    : lastAiToolsStatus.state;
                if (isAiToolsTerminalState(lastAiToolsStatus.state))
                    installSawTerminalStatus = true;
            }
            else if (finalLine.isNotEmpty())
            {
                installDiagnosticLines.add(finalLine);
                while (installDiagnosticLines.size() > 8)
                    installDiagnosticLines.remove(0);
                appendAiToolsLogLine("[installer] " + finalLine);
            }

            if (exitCode != 0 && lastAiToolsStatus.state != "error" && lastAiToolsStatus.state != "cancelled")
            {
                const auto lastDiagnostics = summariseDiagnosticLines(installDiagnosticLines);
                appendAiToolsLogLine("installerExitCode=" + juce::String(exitCode));
                appendAiToolsLogLine("installerRuntimePython=" + installRuntimePythonPath);
                appendAiToolsLogLine("installerRuntimeRoot=" + installRuntimeRootPath);
                appendAiToolsLogLine("installerCommandLine=" + installCommandLine);

                lastAiToolsStatus.state = "error";
                lastAiToolsStatus.progress = 0.0f;
                lastAiToolsStatus.errorCode = installDiagnosticLines.isEmpty()
                    ? "runtime_python_unlaunchable"
                    : "runtime_validation_failed";
                lastAiToolsStatus.message = installDiagnosticLines.isEmpty()
                    ? "OpenStudio could not start the downloaded AI runtime."
                    : "OpenStudio could not finish verifying the downloaded AI runtime.";
                lastAiToolsStatus.error = "AI tools installer exited with code " + juce::String(exitCode) + ".";
                lastAiToolsStatus.lastPhase = installLastObservedPhase.isNotEmpty() ? installLastObservedPhase : juce::String("installer_process");
                lastAiToolsStatus.terminalReason = lastAiToolsStatus.errorCode;

                if (lastDiagnostics.isNotEmpty())
                    lastAiToolsStatus.error += " Last output: " + lastDiagnostics;
            }
            else if (lastAiToolsStatus.state != "error"
                     && lastAiToolsStatus.state != "cancelled"
                     && lastAiToolsStatus.state != "ready")
            {
                const auto lastDiagnostics = summariseDiagnosticLines(installDiagnosticLines);
                appendAiToolsLogLine(makeAiLogEvent("host",
                                                    "installer",
                                                    "installer_exited_without_terminal_status",
                                                    installSessionId,
                                                    [&] (juce::DynamicObject& obj)
                                                    {
                                                        obj.setProperty("runtimeCandidate", installRuntimeCandidate);
                                                        obj.setProperty("exitCode", static_cast<int> (exitCode));
                                                        obj.setProperty("lastPhase", installLastObservedPhase);
                                                        obj.setProperty("sawTerminalStatus", installSawTerminalStatus);
                                                    }));

                lastAiToolsStatus.state = "error";
                lastAiToolsStatus.progress = 0.0f;
                lastAiToolsStatus.available = false;
                lastAiToolsStatus.errorCode = "installer_exited_incomplete";
                lastAiToolsStatus.message = "OpenStudio could not confirm that AI tools finished installing.";
                lastAiToolsStatus.error = "The AI tools installer exited before it reported a ready state.";
                lastAiToolsStatus.lastPhase = installLastObservedPhase.isNotEmpty() ? installLastObservedPhase : juce::String("installer_process");
                lastAiToolsStatus.terminalReason = "installer_exited_incomplete";

                if (lastDiagnostics.isNotEmpty())
                    lastAiToolsStatus.error += " Last output: " + lastDiagnostics;
            }

            lastAiToolsStatus.runtimeCandidate = installRuntimeCandidate;
            lastAiToolsStatus.installSessionId = installSessionId;
            lastAiToolsStatus.fallbackAttempted = installFallbackAttempted;

            lastAiToolsStatus.installInProgress = false;
            aiToolsInstallWorkInProgress = false;
            installProcess.reset();
            installOutputBuffer.clear();
            installDiagnosticLines.clear();
            installCommandLine.clear();
            installRuntimePythonPath.clear();
            installRuntimeRootPath.clear();
            installRuntimeCandidate.clear();
            installSessionId.clear();
            installLastObservedPhase.clear();
            installLaunchTimeMs = 0.0;
            installFirstOutputTimeMs = 0.0;
            installLastOutputTimeMs = 0.0;
            installSawTerminalStatus = false;
            installFallbackAttempted = false;
            shouldRefreshAfterExit = lastAiToolsStatus.state != "ready";
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
    if (json.hasProperty("supportedBackends"))
        status.supportedBackends = varToStringArray(json["supportedBackends"]);
    if (json.hasProperty("selectedBackend"))
        status.selectedBackend = json["selectedBackend"].toString();
    if (json.hasProperty("runtimeVersion"))
        status.runtimeVersion = json["runtimeVersion"].toString();
    if (json.hasProperty("modelVersion"))
        status.modelVersion = json["modelVersion"].toString();
    if (json.hasProperty("verificationMode"))
        status.verificationMode = json["verificationMode"].toString();
    if (json.hasProperty("runtimeCandidate"))
        status.runtimeCandidate = json["runtimeCandidate"].toString();
    if (json.hasProperty("sessionId"))
        status.installSessionId = json["sessionId"].toString();
    if (json.hasProperty("lastPhase"))
        status.lastPhase = json["lastPhase"].toString();
    if (json.hasProperty("terminalReason"))
        status.terminalReason = json["terminalReason"].toString();
    if (json.hasProperty("fallbackAttempted"))
        status.fallbackAttempted = static_cast<bool>(json["fallbackAttempted"]);
    if (json.hasProperty("restartRequired"))
        status.restartRequired = static_cast<bool>(json["restartRequired"]);

    if (status.lastPhase.isEmpty() && status.state.isNotEmpty())
        status.lastPhase = status.state;
    if (status.state == "error" && status.terminalReason.isEmpty() && status.errorCode.isNotEmpty())
        status.terminalReason = status.errorCode;

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
                                    const juce::String& accelerationMode,
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
        + " --acceleration-mode " + quoteCommandPart(accelerationMode);

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
    if (json.hasProperty("backend"))
        result.backend = json["backend"].toString();
    if (json.hasProperty("accelerationMode"))
        result.accelerationMode = json["accelerationMode"].toString();
    if (json.hasProperty("threadCap"))
        result.threadCap = static_cast<int>(json["threadCap"]);

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
        installDiagnosticLines.clear();
        installCommandLine.clear();
        installRuntimePythonPath.clear();
        installRuntimeRootPath.clear();
        installRuntimeCandidate.clear();
        installSessionId.clear();
        installLastObservedPhase.clear();
        installLaunchTimeMs = 0.0;
        installFirstOutputTimeMs = 0.0;
        installLastOutputTimeMs = 0.0;
        installSawTerminalStatus = false;
        installFallbackAttempted = false;
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
        status.lastPhase = "cancelled";
        status.terminalReason.clear();
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
