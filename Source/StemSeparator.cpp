#include "StemSeparator.h"

StemSeparator::StemSeparator() = default;

StemSeparator::~StemSeparator()
{
    cancel();
}

juce::File StemSeparator::findPython() const
{
    auto appDir = juce::File::getSpecialLocation (juce::File::currentApplicationFile).getParentDirectory();

#if JUCE_WINDOWS
    // Windows: bundled embeddable Python
    juce::String pyExe = "python.exe";
#else
    // macOS/Linux: python3 binary
    juce::String pyExe = "python3";
#endif

    // 1. Bundled Python — dev build (relative to exe in build/<config>/)
    auto bundled = appDir.getChildFile ("../../../tools/python/" + pyExe);
    if (bundled.existsAsFile())
        return bundled;

    // 2. Bundled Python — installed (next to app)
    bundled = appDir.getChildFile ("python/" + pyExe);
    if (bundled.existsAsFile())
        return bundled;

#if JUCE_MAC
    // 3. macOS app bundle: Studio13.app/Contents/Resources/python/python3
    auto resourcesDir = appDir.getParentDirectory().getChildFile ("Resources");
    bundled = resourcesDir.getChildFile ("python/python3");
    if (bundled.existsAsFile())
        return bundled;

    // 4. Homebrew Python (common on macOS)
    for (const auto& path : { "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3" })
    {
        juce::File systemPy (path);
        if (systemPy.existsAsFile())
            return systemPy;
    }
#endif

#if JUCE_WINDOWS
    // 3. System Python via PATH
    juce::ChildProcess which;
    if (which.start ("where python") && which.waitForProcessToFinish (3000))
    {
        auto output = which.readAllProcessOutput().trim();
        if (output.isNotEmpty())
        {
            auto firstLine = output.upToFirstOccurrenceOf ("\n", false, false).trim();
            juce::File systemPython (firstLine);
            if (systemPython.existsAsFile())
                return systemPython;
        }
    }
#elif JUCE_LINUX
    juce::File systemPy ("/usr/bin/python3");
    if (systemPy.existsAsFile())
        return systemPy;
#endif

    return {};
}

juce::File StemSeparator::findScript() const
{
    auto appDir = juce::File::getSpecialLocation (juce::File::currentApplicationFile).getParentDirectory();

    // 1. Dev build (relative to exe)
    auto script = appDir.getChildFile ("../../../tools/stem_separator.py");
    if (script.existsAsFile())
        return script;

    // 2. Installed — next to exe
    script = appDir.getChildFile ("scripts/stem_separator.py");
    if (script.existsAsFile())
        return script;

#if JUCE_MAC
    // 3. macOS app bundle: Studio13.app/Contents/Resources/scripts/
    auto resourcesDir = appDir.getParentDirectory().getChildFile ("Resources");
    script = resourcesDir.getChildFile ("scripts/stem_separator.py");
    if (script.existsAsFile())
        return script;
#endif

    return {};
}

juce::File StemSeparator::findModelsDir() const
{
    auto appDir = juce::File::getSpecialLocation (juce::File::currentApplicationFile).getParentDirectory();

    // 1. Dev build
    auto modelsDir = appDir.getChildFile ("../../../resources/models");
    if (modelsDir.isDirectory())
        return modelsDir;

    // 2. Installed — next to exe
    modelsDir = appDir.getChildFile ("models");
    if (modelsDir.isDirectory())
        return modelsDir;

#if JUCE_MAC
    // 3. macOS app bundle: Studio13.app/Contents/Resources/models/
    auto resourcesDir = appDir.getParentDirectory().getChildFile ("Resources");
    modelsDir = resourcesDir.getChildFile ("models");
    if (modelsDir.isDirectory())
        return modelsDir;
#endif

    // 4. Create default location
    modelsDir = appDir.getChildFile ("../../../resources/models");
    modelsDir.createDirectory();
    return modelsDir;
}

bool StemSeparator::isAvailable() const
{
    auto python = findPython();
    auto script = findScript();

    if (! python.existsAsFile() || ! script.existsAsFile())
        return false;

    // Quick check: can Python import audio_separator?
    juce::ChildProcess check;
    auto cmd = python.getFullPathName().quoted()
               + " -c \"import audio_separator.separator; print('ok')\"";

    if (check.start (cmd) && check.waitForProcessToFinish (10000))
    {
        auto output = check.readAllProcessOutput().trim();
        return output.contains ("ok");
    }

    return false;
}

bool StemSeparator::startSeparation (const juce::File& inputFile,
                                     const juce::File& outputDir,
                                     const juce::StringArray& stemNames,
                                     bool useGPU,
                                     const juce::String& modelName)
{
    if (isRunning())
    {
        juce::Logger::writeToLog ("StemSeparator: Already running.");
        return false;
    }

    auto python = findPython();
    auto script = findScript();
    auto modelsDir = findModelsDir();

    if (! python.existsAsFile())
    {
        lastProgress = { "error", 0.0f, {}, "Python not found. Install Python in tools/python/." };
        juce::Logger::writeToLog ("StemSeparator: Python not found.");
        return false;
    }

    if (! script.existsAsFile())
    {
        lastProgress = { "error", 0.0f, {}, "stem_separator.py not found." };
        juce::Logger::writeToLog ("StemSeparator: Script not found.");
        return false;
    }

    outputDir.createDirectory();

    // Build command line
    juce::String cmd = python.getFullPathName().quoted()
        + " " + script.getFullPathName().quoted()
        + " --input " + inputFile.getFullPathName().quoted()
        + " --output-dir " + outputDir.getFullPathName().quoted()
        + " --model " + modelName.quoted()
        + " --models-dir " + modelsDir.getFullPathName().quoted()
        + " --stems " + stemNames.joinIntoString (",")
        + (useGPU ? " --gpu" : "");

    juce::Logger::writeToLog ("StemSeparator: Starting: " + cmd);

    // Reset state
    outputBuffer.clear();
    lastProgress = { "loading", 0.0f, {}, {} };

    // Launch child process
    childProcess = std::make_unique<juce::ChildProcess>();
    if (! childProcess->start (cmd))
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

    // Read any available stdout
    char buffer[4096];
    while (childProcess->isRunning())
    {
        auto bytesRead = childProcess->readProcessOutput (buffer, sizeof (buffer) - 1);
        if (bytesRead <= 0)
            break;

        buffer[bytesRead] = '\0';
        outputBuffer += juce::String::fromUTF8 (buffer, (int) bytesRead);
    }

    // If process ended, read remaining output
    if (! childProcess->isRunning())
    {
        for (;;)
        {
            auto bytesRead = childProcess->readProcessOutput (buffer, sizeof (buffer) - 1);
            if (bytesRead <= 0)
                break;
            buffer[bytesRead] = '\0';
            outputBuffer += juce::String::fromUTF8 (buffer, (int) bytesRead);
        }
    }

    // Parse JSON lines from output
    while (outputBuffer.contains ("\n"))
    {
        auto lineEnd = outputBuffer.indexOfChar ('\n');
        auto line = outputBuffer.substring (0, lineEnd).trim();
        outputBuffer = outputBuffer.substring (lineEnd + 1);

        if (line.startsWith ("{"))
            lastProgress = parseJsonLine (line);
    }

    // Check if process exited without "done" state
    if (! childProcess->isRunning() && lastProgress.state != "done" && lastProgress.state != "error")
    {
        auto exitCode = childProcess->getExitCode();
        if (exitCode != 0)
        {
            lastProgress.state = "error";
            lastProgress.error = "Python process exited with code " + juce::String (exitCode);

            // Try to parse any remaining output
            if (outputBuffer.trim().startsWith ("{"))
            {
                auto parsed = parseJsonLine (outputBuffer.trim());
                if (parsed.state == "error")
                    lastProgress = parsed;
            }
        }
    }

    return lastProgress;
}

StemSeparator::SeparationProgress StemSeparator::parseJsonLine (const juce::String& line) const
{
    SeparationProgress result = lastProgress;

    auto json = juce::JSON::parse (line);
    if (! json.isObject())
        return result;

    if (json.hasProperty ("state"))
        result.state = json["state"].toString();

    if (json.hasProperty ("progress"))
        result.progress = static_cast<float> (static_cast<double> (json["progress"]));

    if (json.hasProperty ("error"))
        result.error = json["error"].toString();

    if (json.hasProperty ("stems"))
    {
        result.stemFiles = {};
        if (auto* stemsObj = json["stems"].getDynamicObject())
        {
            for (const auto& prop : stemsObj->getProperties())
                result.stemFiles.set (prop.name.toString(), prop.value.toString());
        }
    }

    return result;
}

void StemSeparator::cancel()
{
    if (childProcess && childProcess->isRunning())
    {
        childProcess->kill();
        juce::Logger::writeToLog ("StemSeparator: Cancelled.");
    }
    childProcess.reset();
    lastProgress = { "idle", 0.0f, {}, {} };
    outputBuffer.clear();
}

bool StemSeparator::isRunning() const
{
    return childProcess && childProcess->isRunning();
}

juce::var StemSeparator::resultToJSON (const juce::StringPairArray& stemFiles, bool success,
                                       const juce::String& errorMsg)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty ("success", success);

    if (errorMsg.isNotEmpty())
        obj->setProperty ("error", errorMsg);

    juce::Array<juce::var> stems;
    for (const auto& key : stemFiles.getAllKeys())
    {
        auto stemObj = std::make_unique<juce::DynamicObject>();
        stemObj->setProperty ("name", key);
        stemObj->setProperty ("filePath", stemFiles[key]);
        stems.add (juce::var (stemObj.release()));
    }
    obj->setProperty ("stems", stems);

    return juce::var (obj.release());
}
