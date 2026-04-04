#include "StemSeparator.h"

namespace
{
constexpr auto kStemModelName = "BS-Roformer-SW.ckpt";
constexpr auto kPythonHelpUrl = "https://www.python.org/downloads/";
constexpr auto kInstallSourceBundledRuntime = "bundledRuntime";
constexpr auto kInstallSourceExternalPython = "externalPython";

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

juce::File StemSeparator::findBundledRuntimeRoot() const
{
    const auto appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();

    for (const auto& candidate : {
            appDir.getChildFile("../../../tools/python"),
            appDir.getChildFile("python")
#if JUCE_MAC
            , appDir.getParentDirectory().getChildFile("Resources").getChildFile("python")
#endif
        })
    {
        if (findPythonInRuntimeRoot(candidate).existsAsFile())
            return candidate;
    }

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
    auto appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();

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
    auto appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();

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

    auto appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();

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

StemSeparator::AiToolsStatus StemSeparator::buildAiToolsStatus (const juce::File& systemPython,
                                                                const juce::File& bundledRuntimeRoot,
                                                                const juce::File& script,
                                                                const juce::File& installerScript,
                                                                bool runtimeInstalled,
                                                                bool modelInstalled) const
{
    auto status = getCachedAiToolsStatusSnapshot();

    status.pythonDetected = systemPython.existsAsFile();
    status.scriptAvailable = script.existsAsFile();
    status.installerAvailable = installerScript.existsAsFile();
    status.runtimeInstalled = runtimeInstalled;
    status.modelInstalled = modelInstalled;
    status.requiresExternalPython = ! bundledRuntimeRoot.isDirectory();
    status.installSource = status.requiresExternalPython ? kInstallSourceExternalPython : kInstallSourceBundledRuntime;
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

    if (! status.runtimeInstalled)
    {
        if (status.requiresExternalPython && ! status.pythonDetected)
        {
            status.state = "pythonMissing";
            status.progress = 0.0f;
            status.message = "Python 3.10 or newer is required for this build before AI tools can be installed.";
            status.error.clear();
            status.errorCode = "python_missing";
            return status;
        }

        status.state = "runtimeMissing";
        status.progress = 0.0f;
        status.message = status.requiresExternalPython
            ? "Install AI Tools to create the local stem-separation runtime."
            : "Install AI Tools to prepare the built-in stem-separation runtime.";
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
    const auto bundledRuntimeRoot = findBundledRuntimeRoot();
    status.requiresExternalPython = ! bundledRuntimeRoot.isDirectory();
    status.installSource = status.requiresExternalPython ? kInstallSourceExternalPython : kInstallSourceBundledRuntime;
    status.helpUrl = status.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
    status.state = "checking";
    status.progress = 0.0f;
    status.available = false;
    status.pythonDetected = false;
    status.scriptAvailable = findScript().existsAsFile();
    status.installerAvailable = findInstallerScript().existsAsFile();
    status.runtimeInstalled = false;
    status.modelInstalled = hasRequiredModel(getUserModelsDir());
    status.installInProgress = installProcess && installProcess->isRunning();
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
    status.installInProgress = installProcess && installProcess->isRunning();

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

        if (installProcess && installProcess->isRunning())
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
        auto bundledRuntimeRoot = findBundledRuntimeRoot();
        auto script = findScript();
        auto installerScript = findInstallerScript();
        const auto modelInstalled = hasRequiredModel(getUserModelsDir());
        const auto runtimeInstalled = installedPython.existsAsFile() && canImportAudioSeparator (installedPython);
        auto refreshedStatus = buildAiToolsStatus (systemPython, bundledRuntimeRoot, script, installerScript, runtimeInstalled, modelInstalled);

        {
            const juce::ScopedLock lock (aiToolsStatusLock);
            lastAiToolsStatus = refreshedStatus;
            statusRefreshInFlight = false;
            initialStatusPrepared = true;
        }
    }).detach();
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

    updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
    {
        const auto bundledRuntimeRoot = findBundledRuntimeRoot();
        status.requiresExternalPython = ! bundledRuntimeRoot.isDirectory();
        status.installSource = status.requiresExternalPython ? kInstallSourceExternalPython : kInstallSourceBundledRuntime;
        status.state = "checking";
        status.progress = 0.0f;
        status.available = false;
        status.installInProgress = true;
        status.message = "Preparing AI tools installation...";
        status.error.clear();
        status.errorCode.clear();
        status.detailLogPath = getAiToolsInstallLogFile().getFullPathName();
        status.helpUrl = status.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
    });

    std::thread ([this]
    {
        const auto installerScript = findInstallerScript();
        const auto bundledRuntimeRoot = findBundledRuntimeRoot();
        const auto bundledPython = findPythonInRuntimeRoot(bundledRuntimeRoot);
        const auto systemPython = findSystemPython();
        const auto logFile = getAiToolsInstallLogFile();
        const auto runtimeRoot = getUserRuntimeRoot();
        const auto modelsDir = getUserModelsDir();
        runtimeRoot.createDirectory();
        modelsDir.createDirectory();
        logFile.getParentDirectory().createDirectory();

        const auto usingBundledRuntime = bundledRuntimeRoot.isDirectory() && bundledPython.existsAsFile();
        const auto bootstrapPython = usingBundledRuntime ? bundledPython : systemPython;

        if (! installerScript.existsAsFile())
        {
            updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
            {
                status.state = "error";
                status.progress = 0.0f;
                status.available = false;
                status.installerAvailable = false;
                status.installInProgress = false;
                status.message = "The AI tools installer is unavailable in this build.";
                status.error = "AI tools installer script not found.";
                status.errorCode = "installer_unavailable";
                status.detailLogPath = logFile.getFullPathName();
                status.requiresExternalPython = ! usingBundledRuntime;
                status.installSource = usingBundledRuntime ? kInstallSourceBundledRuntime : kInstallSourceExternalPython;
                status.helpUrl = status.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
            });
            return;
        }

        if (! bootstrapPython.existsAsFile())
        {
            updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
            {
                status.state = "pythonMissing";
                status.progress = 0.0f;
                status.available = false;
                status.pythonDetected = false;
                status.runtimeInstalled = false;
                status.modelInstalled = false;
                status.installInProgress = false;
                status.message = "Python 3.10 or newer is required for this build before AI Tools can be installed.";
                status.error.clear();
                status.errorCode = "python_missing";
                status.detailLogPath = logFile.getFullPathName();
                status.requiresExternalPython = true;
                status.installSource = kInstallSourceExternalPython;
                status.helpUrl = kPythonHelpUrl;
            });
            return;
        }

        auto cmd = quoteCommandPart(bootstrapPython.getFullPathName())
            + " " + quoteCommandPart(installerScript.getFullPathName())
            + " --runtime-root " + quoteCommandPart(runtimeRoot.getFullPathName())
            + " --models-dir " + quoteCommandPart(modelsDir.getFullPathName())
            + " --model " + quoteCommandPart(kStemModelName)
            + " --log-path " + quoteCommandPart(logFile.getFullPathName());

        if (usingBundledRuntime)
            cmd += " --seed-runtime " + quoteCommandPart(bundledRuntimeRoot.getFullPathName());
        else
            cmd += " --bootstrap-with " + quoteCommandPart(systemPython.getFullPathName());

        auto nextInstallProcess = std::make_unique<juce::ChildProcess>();
        if (! nextInstallProcess->start(cmd))
        {
            updateCachedAiToolsStatus ([&] (AiToolsStatus& status)
            {
                status.state = "error";
                status.progress = 0.0f;
                status.available = false;
                status.installInProgress = false;
                status.message = "Failed to start the AI tools installer.";
                status.error = "Could not start the AI tools installer process.";
                status.errorCode = "installer_launch_failed";
                status.detailLogPath = logFile.getFullPathName();
                status.requiresExternalPython = ! usingBundledRuntime;
                status.installSource = usingBundledRuntime ? kInstallSourceBundledRuntime : kInstallSourceExternalPython;
                status.helpUrl = status.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
            });
            return;
        }

        {
            const juce::ScopedLock lock (aiToolsStatusLock);
            installOutputBuffer.clear();
            installProcess = std::move(nextInstallProcess);
            lastAiToolsStatus.state = usingBundledRuntime ? "copying_runtime" : "creating_venv";
            lastAiToolsStatus.progress = 0.0f;
            lastAiToolsStatus.available = false;
            lastAiToolsStatus.installInProgress = true;
            lastAiToolsStatus.pythonDetected = systemPython.existsAsFile();
            lastAiToolsStatus.installerAvailable = true;
            lastAiToolsStatus.requiresExternalPython = ! usingBundledRuntime;
            lastAiToolsStatus.installSource = usingBundledRuntime ? kInstallSourceBundledRuntime : kInstallSourceExternalPython;
            lastAiToolsStatus.detailLogPath = logFile.getFullPathName();
            lastAiToolsStatus.message = usingBundledRuntime
                ? "Preparing the built-in AI tools runtime..."
                : "Starting AI tools installation...";
            lastAiToolsStatus.error.clear();
            lastAiToolsStatus.errorCode.clear();
            lastAiToolsStatus.helpUrl = lastAiToolsStatus.requiresExternalPython ? juce::String(kPythonHelpUrl) : juce::String();
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
            errorMessage = "Python 3.10 or newer is required before installing AI Tools.";
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
