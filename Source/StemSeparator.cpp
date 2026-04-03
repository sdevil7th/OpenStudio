#include "StemSeparator.h"

namespace
{
constexpr auto kStemModelName = "BS-Roformer-SW.ckpt";
constexpr auto kPythonHelpUrl = "https://www.python.org/downloads/";

juce::String makePythonImportCommand()
{
    return "-c \"import audio_separator.separator; print('ok')\"";
}

juce::String getInstallPythonName()
{
   #if JUCE_WINDOWS
    return "python.exe";
   #else
    return "python3";
   #endif
}

juce::String quoteCommandPart(const juce::String& value)
{
    return value.quoted();
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

juce::File StemSeparator::findPython() const
{
    const auto userRuntime = getUserRuntimeRoot();
#if JUCE_WINDOWS
    auto python = userRuntime.getChildFile("Scripts/python.exe");
#else
    auto python = userRuntime.getChildFile("bin/python3");
    if (! python.existsAsFile())
        python = userRuntime.getChildFile("bin/python");
#endif
    if (python.existsAsFile())
        return python;

    const auto appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
    auto bundled = appDir.getChildFile("../../../tools/python/" + getInstallPythonName());
    if (bundled.existsAsFile())
        return bundled;

    bundled = appDir.getChildFile("python/" + getInstallPythonName());
    if (bundled.existsAsFile())
        return bundled;

#if JUCE_MAC
    const auto resourcesDir = appDir.getParentDirectory().getChildFile("Resources");
    bundled = resourcesDir.getChildFile("python/python3");
    if (bundled.existsAsFile())
        return bundled;
#endif

    if (auto systemPython = findSystemPython(); systemPython.existsAsFile())
        return systemPython;

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

StemSeparator::AiToolsStatus StemSeparator::buildAiToolsStatus() const
{
    auto status = lastAiToolsStatus;
    const auto python = findPython();
    const auto script = findScript();

    status.pythonDetected = python.existsAsFile();
    status.scriptAvailable = script.existsAsFile();
    status.helpUrl = kPythonHelpUrl;
    status.installInProgress = installProcess && installProcess->isRunning();

    if (status.installInProgress)
    {
        if (status.state.isEmpty() || status.state == "idle")
            status.state = "installing";
        if (status.message.isEmpty())
            status.message = "Installing AI tools...";
        return status;
    }

    const auto modelsDir = findModelsDir();
    status.runtimeInstalled = status.pythonDetected && canImportAudioSeparator(python);
    status.modelInstalled = hasRequiredModel(modelsDir);
    status.available = status.scriptAvailable && status.runtimeInstalled && status.modelInstalled;

    if (status.available)
    {
        status.state = "ready";
        status.progress = 1.0f;
        status.error.clear();
        if (status.message.isEmpty())
            status.message = "AI tools are ready.";
        return status;
    }

    if (! status.pythonDetected)
    {
        status.state = "pythonMissing";
        status.progress = 0.0f;
        status.message = "Install Python 3.10 or newer, then retry AI Tools installation.";
        status.error.clear();
        return status;
    }

    if (! status.scriptAvailable)
    {
        status.state = "error";
        status.progress = 0.0f;
        status.message = "The AI tools installer is unavailable in this build.";
        if (status.error.isEmpty())
            status.error = "AI tools installer script not found.";
        return status;
    }

    if (! status.runtimeInstalled)
    {
        status.state = "runtimeMissing";
        status.progress = 0.0f;
        status.message = "Install AI Tools to enable stem separation.";
        status.error.clear();
        return status;
    }

    status.state = "modelMissing";
    status.progress = 0.0f;
    status.message = "Install AI Tools to download the stem separation model.";
    status.error.clear();
    return status;
}

juce::var StemSeparator::aiToolsStatusToVar(const AiToolsStatus& status)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty("state", status.state);
    obj->setProperty("progress", static_cast<double>(status.progress));
    obj->setProperty("available", status.available);
    obj->setProperty("pythonDetected", status.pythonDetected);
    obj->setProperty("scriptAvailable", status.scriptAvailable);
    obj->setProperty("runtimeInstalled", status.runtimeInstalled);
    obj->setProperty("modelInstalled", status.modelInstalled);
    obj->setProperty("installInProgress", status.installInProgress);
    obj->setProperty("message", status.message);
    obj->setProperty("error", status.error);
    obj->setProperty("helpUrl", status.helpUrl);
    return juce::var(obj.release());
}

juce::var StemSeparator::getAiToolsStatus()
{
    pollInstallProgress();
    lastAiToolsStatus = buildAiToolsStatus();
    return aiToolsStatusToVar(lastAiToolsStatus);
}

juce::var StemSeparator::installAiTools()
{
    pollInstallProgress();
    lastAiToolsStatus = buildAiToolsStatus();

    auto result = std::make_unique<juce::DynamicObject>();
    if (lastAiToolsStatus.available)
    {
        result->setProperty("started", false);
        result->setProperty("message", "AI tools are already installed.");
        result->setProperty("status", aiToolsStatusToVar(lastAiToolsStatus));
        return juce::var(result.release());
    }

    if (installProcess && installProcess->isRunning())
    {
        result->setProperty("started", false);
        result->setProperty("error", "AI tools installation is already running.");
        result->setProperty("status", aiToolsStatusToVar(lastAiToolsStatus));
        return juce::var(result.release());
    }

    const auto systemPython = findSystemPython();
    if (! systemPython.existsAsFile())
    {
        lastAiToolsStatus.state = "pythonMissing";
        lastAiToolsStatus.progress = 0.0f;
        lastAiToolsStatus.available = false;
        lastAiToolsStatus.pythonDetected = false;
        lastAiToolsStatus.runtimeInstalled = false;
        lastAiToolsStatus.modelInstalled = false;
        lastAiToolsStatus.installInProgress = false;
        lastAiToolsStatus.message = "Python 3.10 or newer is required to install AI Tools.";
        lastAiToolsStatus.error.clear();
        lastAiToolsStatus.helpUrl = kPythonHelpUrl;

        result->setProperty("started", false);
        result->setProperty("error", lastAiToolsStatus.message);
        result->setProperty("status", aiToolsStatusToVar(lastAiToolsStatus));
        return juce::var(result.release());
    }

    const auto installerScript = findInstallerScript();
    if (! installerScript.existsAsFile())
    {
        lastAiToolsStatus.state = "error";
        lastAiToolsStatus.progress = 0.0f;
        lastAiToolsStatus.available = false;
        lastAiToolsStatus.installInProgress = false;
        lastAiToolsStatus.message = "The AI tools installer is unavailable in this build.";
        lastAiToolsStatus.error = "AI tools installer script not found.";
        lastAiToolsStatus.helpUrl = kPythonHelpUrl;

        result->setProperty("started", false);
        result->setProperty("error", lastAiToolsStatus.error);
        result->setProperty("status", aiToolsStatusToVar(lastAiToolsStatus));
        return juce::var(result.release());
    }

    const auto runtimeRoot = getUserRuntimeRoot();
    const auto modelsDir = getUserModelsDir();
    runtimeRoot.createDirectory();
    modelsDir.createDirectory();

    const auto cmd = quoteCommandPart(systemPython.getFullPathName())
        + " " + quoteCommandPart(installerScript.getFullPathName())
        + " --runtime-root " + quoteCommandPart(runtimeRoot.getFullPathName())
        + " --models-dir " + quoteCommandPart(modelsDir.getFullPathName())
        + " --model " + quoteCommandPart(kStemModelName);

    installOutputBuffer.clear();
    lastAiToolsStatus.state = "installing";
    lastAiToolsStatus.progress = 0.0f;
    lastAiToolsStatus.available = false;
    lastAiToolsStatus.installInProgress = true;
    lastAiToolsStatus.message = "Starting AI tools installation...";
    lastAiToolsStatus.error.clear();
    lastAiToolsStatus.helpUrl = kPythonHelpUrl;

    installProcess = std::make_unique<juce::ChildProcess>();
    if (! installProcess->start(cmd))
    {
        installProcess.reset();
        lastAiToolsStatus.state = "error";
        lastAiToolsStatus.installInProgress = false;
        lastAiToolsStatus.message = "Failed to start the AI tools installer.";
        lastAiToolsStatus.error = "Could not start the AI tools installer process.";

        result->setProperty("started", false);
        result->setProperty("error", lastAiToolsStatus.error);
        result->setProperty("status", aiToolsStatusToVar(lastAiToolsStatus));
        return juce::var(result.release());
    }

    result->setProperty("started", true);
    result->setProperty("status", aiToolsStatusToVar(lastAiToolsStatus));
    return juce::var(result.release());
}

void StemSeparator::pollInstallProgress()
{
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
            lastAiToolsStatus.message = "AI tools installation failed.";
        }

        lastAiToolsStatus.installInProgress = false;
        installProcess.reset();
        installOutputBuffer.clear();
        lastAiToolsStatus = buildAiToolsStatus();
    }
}

StemSeparator::AiToolsStatus StemSeparator::parseInstallJsonLine(const juce::String& line) const
{
    auto status = lastAiToolsStatus;
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

    status.installInProgress = (status.state != "ready" && status.state != "error" && status.state != "cancelled");
    status.helpUrl = kPythonHelpUrl;
    return status;
}

bool StemSeparator::isAvailable() const
{
    return buildAiToolsStatus().available;
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

    auto status = buildAiToolsStatus();
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
    if (installProcess && installProcess->isRunning())
    {
        installProcess->kill();
        juce::Logger::writeToLog("StemSeparator: AI tools install cancelled.");
    }
    installProcess.reset();
    installOutputBuffer.clear();
    lastAiToolsStatus.state = "cancelled";
    lastAiToolsStatus.progress = 0.0f;
    lastAiToolsStatus.available = false;
    lastAiToolsStatus.installInProgress = false;
    lastAiToolsStatus.message = "AI tools installation was cancelled.";
    lastAiToolsStatus.error.clear();
    lastAiToolsStatus.helpUrl = kPythonHelpUrl;
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
