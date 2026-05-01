#include "AITrackEngine.h"

namespace
{
constexpr auto kPinnedMusicGenerationModelId = "acestep-v15-xl-turbo";
constexpr auto kReaderSleepMs = 50;
constexpr auto kWorkerStartupTimeoutMs = 45000;
constexpr auto kWorkerRequestTimeoutMs = 10000;
constexpr auto kWorkerProtocolVersion = 2;
constexpr auto kMaxFramedPayloadBytes = 8 * 1024 * 1024;
constexpr auto kColdDecodeStallTimeoutMs = 90000;

juce::String createSafeMusicGenerationTimestamp()
{
    const auto now = juce::Time::getCurrentTime();
    const auto milliseconds = juce::String(static_cast<int> (now.toMilliseconds() % 1000))
        .paddedLeft('0', 3);
    return now.formatted("%Y%m%d_%H%M%S") + "_" + milliseconds;
}

juce::File getApplicationRuntimeDirectory()
{
    auto executableDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getParentDirectory();

   #if JUCE_MAC
    auto resourcesDir = executableDir.getSiblingFile("Resources");
    if (resourcesDir.isDirectory())
        return resourcesDir;
   #endif

    return executableDir;
}

juce::File findPythonInRuntimeRoot(const juce::File& runtimeRoot)
{
    if (! runtimeRoot.isDirectory())
        return {};

   #if JUCE_WINDOWS
    for (const auto& relativePath : {
             juce::String("python.exe"),
             juce::String("python/python.exe"),
             juce::String("Scripts/python.exe")
         })
    {
        auto candidate = runtimeRoot.getChildFile(relativePath);
        if (candidate.existsAsFile())
            return candidate;
    }
   #else
    for (const auto& relativePath : {
             juce::String("python3"),
             juce::String("python/bin/python3"),
             juce::String("bin/python3"),
             juce::String("python/bin/python"),
             juce::String("bin/python")
         })
    {
        auto candidate = runtimeRoot.getChildFile(relativePath);
        if (candidate.existsAsFile())
            return candidate;
    }
   #endif

    return {};
}

juce::String truncateForLog(const juce::String& text, int maxCharacters = 240)
{
    auto normalized = text.trim();
    if (normalized.length() <= maxCharacters)
        return normalized;
    return normalized.substring(0, maxCharacters) + "...";
}

juce::String computeScriptVersion(const juce::File& script)
{
    if (! script.existsAsFile())
        return {};

    juce::MemoryBlock scriptBytes;
    if (! script.loadFileAsData(scriptBytes))
        return {};

    return juce::MD5(scriptBytes.getData(), scriptBytes.getSize()).toHexString().substring(0, 16);
}

bool killWindowsProcessTree(int pid, juce::String* output = nullptr)
{
   #if JUCE_WINDOWS
    if (pid <= 0)
        return false;

    juce::StringArray command;
    command.add("taskkill");
    command.add("/PID");
    command.add(juce::String(pid));
    command.add("/F");
    command.add("/T");

    juce::ChildProcess killer;
    if (! killer.start(command, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
        return false;

    killer.waitForProcessToFinish(5000);
    if (output != nullptr)
        *output = killer.readAllProcessOutput().trim();
    return true;
   #else
    juce::ignoreUnused(pid, output);
    return false;
   #endif
}

bool writeSocketFully(juce::StreamingSocket& socket, const char* data, int totalBytes, int timeoutMs)
{
    auto bytesWritten = 0;
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;

    while (bytesWritten < totalBytes && juce::Time::currentTimeMillis() < deadline)
    {
        if (socket.waitUntilReady(false, 250) <= 0)
            continue;

        const auto chunkBytes = socket.write(data + bytesWritten, totalBytes - bytesWritten);
        if (chunkBytes <= 0)
            return false;

        bytesWritten += chunkBytes;
    }

    return bytesWritten == totalBytes;
}

bool readSocketFully(juce::StreamingSocket& socket, void* destination, int totalBytes, int timeoutMs)
{
    auto* writePtr = static_cast<char*> (destination);
    auto bytesRead = 0;
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;

    while (bytesRead < totalBytes && juce::Time::currentTimeMillis() < deadline)
    {
        if (socket.waitUntilReady(true, 250) <= 0)
            continue;

        const auto chunkBytes = socket.read(writePtr + bytesRead, totalBytes - bytesRead, false);
        if (chunkBytes <= 0)
            return false;

        bytesRead += chunkBytes;
    }

    return bytesRead == totalBytes;
}

bool writeFramedJson(juce::StreamingSocket& socket,
                     const juce::var& payload,
                     int timeoutMs,
                     int& payloadBytesWritten)
{
    auto json = juce::JSON::toString(payload, false);
    payloadBytesWritten = static_cast<int> (json.getNumBytesAsUTF8());
    if (payloadBytesWritten <= 0 || payloadBytesWritten > kMaxFramedPayloadBytes)
        return false;

    char header[4] {};
    header[0] = static_cast<char> ((payloadBytesWritten >> 24) & 0xFF);
    header[1] = static_cast<char> ((payloadBytesWritten >> 16) & 0xFF);
    header[2] = static_cast<char> ((payloadBytesWritten >> 8) & 0xFF);
    header[3] = static_cast<char> (payloadBytesWritten & 0xFF);

    return writeSocketFully(socket, header, 4, timeoutMs)
        && writeSocketFully(socket, json.toRawUTF8(), payloadBytesWritten, timeoutMs);
}

juce::var readFramedJson(juce::StreamingSocket& socket, int timeoutMs, int& payloadBytesRead)
{
    char header[4] {};
    payloadBytesRead = 0;
    if (! readSocketFully(socket, header, 4, timeoutMs))
        return {};

    payloadBytesRead = ((static_cast<unsigned char> (header[0]) << 24)
                        | (static_cast<unsigned char> (header[1]) << 16)
                        | (static_cast<unsigned char> (header[2]) << 8)
                        | static_cast<unsigned char> (header[3]));

    if (payloadBytesRead <= 0 || payloadBytesRead > kMaxFramedPayloadBytes)
        return {};

    juce::HeapBlock<char> buffer(static_cast<size_t> (payloadBytesRead + 1));
    zeromem(buffer.get(), static_cast<size_t> (payloadBytesRead + 1));
    if (! readSocketFully(socket, buffer.get(), payloadBytesRead, timeoutMs))
        return {};

    return juce::JSON::parse(juce::String::fromUTF8(buffer.get(), payloadBytesRead));
}

juce::String buildCommandLineForLog(const juce::StringArray& command)
{
    juce::StringArray escaped;
    for (const auto& part : command)
    {
        if (part.containsAnyOf(" \t\""))
            escaped.add(part.quoted());
        else
            escaped.add(part);
    }
    return escaped.joinIntoString(" ");
}
}

AITrackEngine::~AITrackEngine()
{
    stopWorker(true, false);
}

juce::File AITrackEngine::getUserDataRoot() const
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
   #elif JUCE_LINUX
    const auto xdgDataHome = juce::SystemStats::getEnvironmentVariable("XDG_DATA_HOME", {});
    if (xdgDataHome.isNotEmpty())
        return juce::File(xdgDataHome).getChildFile("OpenStudio");
    return juce::File::getSpecialLocation(juce::File::userHomeDirectory)
        .getChildFile(".local")
        .getChildFile("share")
        .getChildFile("OpenStudio");
   #endif

    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio");
}

juce::File AITrackEngine::getUserRuntimeRoot() const
{
    return getUserDataRoot().getChildFile("stem-runtime");
}

juce::File AITrackEngine::getMusicGenerationCheckpointRoot() const
{
    return juce::File::getSpecialLocation(juce::File::userHomeDirectory)
        .getChildFile(".cache")
        .getChildFile("ace-step")
        .getChildFile("checkpoints");
}

juce::File AITrackEngine::findPython() const
{
    auto runtimePython = findPythonInRuntimeRoot(getUserRuntimeRoot());
    if (runtimePython.existsAsFile())
        return runtimePython;

    auto bundledRuntime = getApplicationRuntimeDirectory().getChildFile("python");
    runtimePython = findPythonInRuntimeRoot(bundledRuntime);
    if (runtimePython.existsAsFile())
        return runtimePython;

   #if JUCE_WINDOWS
    juce::ChildProcess probe;
    if (probe.start("where python") && probe.waitForProcessToFinish(3000))
    {
        auto output = probe.readAllProcessOutput().trim();
        if (output.isNotEmpty())
        {
            auto firstLine = output.upToFirstOccurrenceOf("\n", false, false).trim();
            juce::File systemPython(firstLine);
            if (systemPython.existsAsFile())
                return systemPython;
        }
    }
   #else
    juce::ChildProcess probe;
    if (probe.start("which python3") && probe.waitForProcessToFinish(3000))
    {
        auto output = probe.readAllProcessOutput().trim();
        if (output.isNotEmpty())
        {
            juce::File systemPython(output);
            if (systemPython.existsAsFile())
                return systemPython;
        }
    }
   #endif

    return {};
}

juce::File AITrackEngine::findScript() const
{
    const auto runtimeDir = getApplicationRuntimeDirectory();
    const auto packagedScript = runtimeDir.getChildFile("scripts").getChildFile("generate_music.py");
    if (packagedScript.existsAsFile())
        return packagedScript;

    const auto bundledDevScript = runtimeDir.getChildFile("tools").getChildFile("generate_music.py");
    if (bundledDevScript.existsAsFile())
        return bundledDevScript;

    const auto workingCopyScript = juce::File::getCurrentWorkingDirectory()
        .getChildFile("tools")
        .getChildFile("generate_music.py");
    if (workingCopyScript.existsAsFile())
        return workingCopyScript;

    return {};
}

void AITrackEngine::cleanupLegacyWorkerProcesses(const juce::File& python, const juce::File& script) const
{
   #if JUCE_WINDOWS
    auto escapedScriptPath = script.getFullPathName().replace("'", "''");
    auto escapedPythonPath = python.getFullPathName().replace("'", "''");
    juce::StringArray command;
    command.add("powershell");
    command.add("-NoProfile");
    command.add("-ExecutionPolicy");
    command.add("Bypass");
    command.add("-Command");
    command.add(
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -like '*--worker*' "
        "  -and $_.CommandLine -like '*" + escapedScriptPath + "*' "
        "  -and $_.CommandLine -like '*" + escapedPythonPath + "*' } | "
        "ForEach-Object { "
        "  & taskkill /PID $_.ProcessId /F /T 2>$null | Out-Null; "
        "  Write-Output ('stopped legacy ACE-Step worker pid ' + $_.ProcessId) "
        "}");

    juce::ChildProcess cleanup;
    if (cleanup.start(command, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
    {
        cleanup.waitForProcessToFinish(5000);
        auto output = cleanup.readAllProcessOutput().trim();
        if (output.isNotEmpty())
            juce::Logger::writeToLog("AITrackEngine: " + output);
    }
   #endif
}

juce::String AITrackEngine::appendProcessDetailsLocked(const juce::String& message) const
{
    juce::String decorated = message;

    if (workerExitCode_ != 0)
        decorated += " Exit code: " + juce::String(workerExitCode_) + ".";

    if (lastStderrLine_.isNotEmpty())
        decorated += " Last stderr: " + truncateForLog(lastStderrLine_) + ".";
    else if (lastStdoutLine_.isNotEmpty())
        decorated += " Last stdout: " + truncateForLog(lastStdoutLine_) + ".";

    return decorated;
}

void AITrackEngine::setProgressErrorLocked(const juce::String& phase,
                                           const juce::String& message,
                                           const juce::String& failureKind)
{
    currentProgress_.state = "error";
    currentProgress_.progress = 0.0f;
    currentProgress_.phase = phase;
    currentProgress_.message = message;
    currentProgress_.error = message;
    currentProgress_.failureKind = failureKind;
    currentProgress_.workerExitCode = workerExitCode_;
    currentProgress_.lastStdoutLine = lastStdoutLine_;
    currentProgress_.lastStderrLine = lastStderrLine_;
    currentProgress_.requestId = currentRequestId_;
    currentProgress_.protocolVersion = std::max(workerProtocolVersion_, kWorkerProtocolVersion);
    currentProgress_.scriptVersion = workerScriptVersion_.isNotEmpty() ? workerScriptVersion_ : expectedScriptVersion_;
    if (currentProgress_.failureDetail.isEmpty())
        currentProgress_.failureDetail = message;
}

bool AITrackEngine::waitForWorkerReady(int timeoutMs)
{
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;
    auto workerExitedBeforeReady = false;

    while (juce::Time::currentTimeMillis() < deadline)
    {
        {
            const juce::ScopedLock sl(lock_);
            if (cancelRequested_)
                return false;
            if (workerReady_ && workerPort_ > 0)
                return true;
            if (workerProtocolRejected_)
                break;

            if (workerProcess_ == nullptr || ! workerProcess_->isRunning())
            {
                workerExitedBeforeReady = true;
                break;
            }
        }

        juce::Thread::sleep(50);
    }

    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;

        if (currentProgress_.error.isEmpty())
        {
            const auto message = workerExitedBeforeReady
                ? appendProcessDetailsLocked("ACE-Step worker exited before reporting ready.")
                : appendProcessDetailsLocked("ACE-Step worker did not become ready in time.");
            setProgressErrorLocked(workerExitedBeforeReady ? "worker_start_failed"
                                                           : "worker_start_timeout",
                                   message,
                                   "worker_handshake");
        }
    }

    return false;
}

void AITrackEngine::joinGenerationThread()
{
    if (generationThread_.joinable())
    {
        jassert(generationThread_.get_id() != std::this_thread::get_id());
        if (generationThread_.get_id() != std::this_thread::get_id())
            generationThread_.join();
    }
}

void AITrackEngine::stopWorkerSession(bool clearProgress, bool userCancelled, bool keepGenerationActive)
{
    std::thread readerThreadToJoin;
    bool shouldKillProcess = false;
    int workerPidToKill = 0;
    juce::ChildProcess* processToKill = nullptr;

    {
        const juce::ScopedLock sl(lock_);
        readerShouldExit_ = true;
        expectedProcessExit_ = true;
        cancelRequested_ = userCancelled;
        if (! keepGenerationActive)
            generationActive_ = false;
        workerReady_ = false;
        workerPort_ = 0;
        workerPidToKill = workerPid_;
        processToKill = workerProcess_.get();

        if (workerProcess_ != nullptr && workerProcess_->isRunning())
            shouldKillProcess = true;

        if (readerThread_.joinable())
            readerThreadToJoin = std::move(readerThread_);
    }

    if (shouldKillProcess && processToKill != nullptr && processToKill->isRunning())
    {
        auto killedTree = false;
       #if JUCE_WINDOWS
        if (workerPidToKill > 0)
        {
            juce::String killOutput;
            juce::Logger::writeToLog("AITrackEngine: stopping ACE-Step child process tree pid="
                                     + juce::String(workerPidToKill));
            killedTree = killWindowsProcessTree(workerPidToKill, &killOutput);
            if (killOutput.isNotEmpty())
                juce::Logger::writeToLog("AITrackEngine: " + truncateForLog(killOutput, 512));
        }
       #endif

        if (! killedTree && processToKill->isRunning())
        {
            juce::Logger::writeToLog("AITrackEngine: stopping ACE-Step child process");
            processToKill->kill();
        }
    }

    if (readerThreadToJoin.joinable())
        readerThreadToJoin.join();

    const juce::ScopedLock sl(lock_);
    workerProcess_.reset();
    resetProcessStateLocked();

    if (clearProgress)
    {
        currentProgress_ = {};
        currentProgress_.state = "idle";
        currentProgress_.backend = "unknown";
    }
}

bool AITrackEngine::ensureWorkerAvailable(const juce::File& python, const juce::File& script)
{
    const auto expectedScriptVersion = computeScriptVersion(script);
    {
        const juce::ScopedLock sl(lock_);
        if (workerProcess_ != nullptr
            && workerProcess_->isRunning()
            && workerReady_
            && workerPort_ > 0
            && workerProtocolVersion_ == kWorkerProtocolVersion
            && workerScriptVersion_ == expectedScriptVersion)
            return true;
    }

    stopWorkerSession(false, false, true);
    cleanupLegacyWorkerProcesses(python, script);

    for (int launchAttempt = 0; launchAttempt < 2; ++launchAttempt)
    {
        juce::StringArray command;
        command.add(python.getFullPathName());
        command.add(script.getFullPathName());
        command.add("--worker");
        command.add("--checkpoint-root");
        command.add(getMusicGenerationCheckpointRoot().getFullPathName());
        command.add("--music-gen-model");
        command.add(kPinnedMusicGenerationModelId);

        const auto commandLine = buildCommandLineForLog(command);
        juce::Logger::writeToLog("AITrackEngine: launching persistent ACE-Step worker: " + commandLine
                                 + " protocolVersion=" + juce::String(kWorkerProtocolVersion)
                                 + " expectedScriptVersion=" + expectedScriptVersion
                                 + " launchAttempt=" + juce::String(launchAttempt + 1));

        {
            const juce::ScopedLock sl(lock_);
            workerProcess_ = std::make_unique<juce::ChildProcess>();
            resetProcessStateLocked();
            readerShouldExit_ = false;
            expectedProcessExit_ = false;
            workerReady_ = false;
            workerPort_ = 0;
            workerProtocolRejected_ = false;
            expectedScriptVersion_ = expectedScriptVersion;
            workerLaunchAtMs_ = juce::Time::currentTimeMillis();

            currentProgress_.state = "loading";
            currentProgress_.progress = 0.02f;
            currentProgress_.phase = "starting_worker";
            currentProgress_.message = "Starting the ACE-Step runtime session...";
            currentProgress_.backend = "unknown";
            currentProgress_.error.clear();
            currentProgress_.runMode = "cold";
            currentProgress_.etaMs = -1.0;
            currentProgress_.phaseProgress = -1.0;
            currentProgress_.failureKind.clear();
            currentProgress_.sessionMode = "persistent";
            currentProgress_.workerExitCode = 0;
            currentProgress_.protocolVersion = kWorkerProtocolVersion;
            currentProgress_.scriptVersion = expectedScriptVersion;
            currentProgress_.lastStdoutLine.clear();
            currentProgress_.lastStderrLine.clear();
            currentProgress_.tracePath.clear();
            currentProgress_.failureDetail.clear();
            currentProgress_.lmBackend.clear();
            currentProgress_.lmStage.clear();
        }

        if (! workerProcess_->start(command, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
        {
            const juce::ScopedLock sl(lock_);
            workerProcess_.reset();
            setProgressErrorLocked("worker_start_failed",
                                   "Failed to start the ACE-Step runtime session.",
                                   "worker_start");
            return false;
        }

        readerThread_ = std::thread([this]() { readerLoop(); });
        if (waitForWorkerReady(kWorkerStartupTimeoutMs))
            return true;

        auto shouldRetryLaunch = false;
        {
            const juce::ScopedLock sl(lock_);
            shouldRetryLaunch = workerProtocolRejected_ && launchAttempt == 0;
        }

        stopWorkerSession(false, false, true);
        if (! shouldRetryLaunch)
            return false;

        cleanupLegacyWorkerProcesses(python, script);
    }

    return false;
}

bool AITrackEngine::sendGenerateRequest(const juce::String& workflowId,
                                        const juce::String& paramsJson,
                                        const juce::File& outputFile)
{
    int port = 0;
    juce::String requestId;
    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;
        port = workerPort_;
        requestId = currentRequestId_;
    }

    if (port <= 0)
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("worker_connect_failed",
                               appendProcessDetailsLocked("ACE-Step worker did not provide a listening port."),
                               "worker_request");
        return false;
    }

    juce::StreamingSocket socket;
    if (! socket.connect("127.0.0.1", port, 4000))
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("worker_connect_failed",
                               appendProcessDetailsLocked("OpenStudio could not contact the ACE-Step runtime session."),
                               "worker_request");
        return false;
    }

    auto request = std::make_unique<juce::DynamicObject>();
    request->setProperty("command", "generate");
    request->setProperty("workflow", workflowId);
    request->setProperty("params", paramsJson);
    request->setProperty("output", outputFile.getFullPathName());
    request->setProperty("requestId", requestId);
    request->setProperty("protocolVersion", kWorkerProtocolVersion);
    request->setProperty("scriptVersion", expectedScriptVersion_);

    int payloadBytesWritten = 0;
    if (! writeFramedJson(socket, juce::var(request.release()), kWorkerRequestTimeoutMs, payloadBytesWritten))
    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;

        setProgressErrorLocked("worker_request_failed",
                               appendProcessDetailsLocked("OpenStudio could not fully submit the generation request to the ACE-Step session."),
                               "worker_protocol");
        return false;
    }

    juce::Logger::writeToLog("AITrackEngine: sent framed worker request"
                             " requestId=" + requestId
                             + " workerPid=" + juce::String(workerPid_)
                             + " payloadBytes=" + juce::String(payloadBytesWritten));

    int ackPayloadBytes = 0;
    auto parsed = readFramedJson(socket, kWorkerRequestTimeoutMs, ackPayloadBytes);
    if (parsed.isVoid())
    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;

        setProgressErrorLocked("worker_request_timeout",
                               appendProcessDetailsLocked("ACE-Step did not acknowledge the generation request in time."),
                               "worker_protocol");
        return false;
    }

    auto* object = parsed.getDynamicObject();
    if (object == nullptr || ! static_cast<bool> (object->getProperty("accepted")))
    {
        auto error = object != nullptr
            ? object->getProperty("error").toString()
            : "ACE-Step returned an invalid worker response.";

        if (error.isEmpty())
            error = "ACE-Step rejected the generation request.";

        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;

        setProgressErrorLocked("worker_request_rejected",
                               appendProcessDetailsLocked(error),
                               object != nullptr && object->hasProperty("failureKind")
                                   ? object->getProperty("failureKind").toString()
                                   : "worker_protocol");
        return false;
    }

    const auto ackRequestId = object->getProperty("requestId").toString();
    const auto ackProtocolVersion = static_cast<int> (double (object->getProperty("protocolVersion")));
    const auto ackScriptVersion = object->getProperty("scriptVersion").toString();
    if (ackRequestId != requestId
        || ackProtocolVersion != kWorkerProtocolVersion
        || ackScriptVersion != expectedScriptVersion_)
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("worker_protocol_failed",
                               appendProcessDetailsLocked("ACE-Step acknowledged the request with a mismatched protocol or request id."),
                               "worker_protocol");
        return false;
    }

    juce::Logger::writeToLog("AITrackEngine: persistent worker accepted generation request"
                             " requestId=" + requestId
                             + " ackBytes=" + juce::String(ackPayloadBytes)
                             + " ackPid=" + object->getProperty("pid").toString());
    return true;
}

void AITrackEngine::launchGenerationTask(const juce::File& python,
                                         const juce::File& script,
                                         const juce::String& workflowId,
                                         const juce::String& paramsJson,
                                         const juce::File& outputFile)
{
    if (! ensureWorkerAvailable(python, script))
    {
        const juce::ScopedLock sl(lock_);
        generationActive_ = false;
        if (cancelRequested_)
        {
            currentProgress_.state = "cancelled";
            currentProgress_.message = "Music generation cancelled.";
            currentProgress_.error.clear();
        }
        return;
    }

    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
        {
            generationActive_ = false;
            currentProgress_.state = "cancelled";
            currentProgress_.message = "Music generation cancelled.";
            currentProgress_.error.clear();
            return;
        }

        currentProgress_.state = "loading";
        currentProgress_.progress = 0.03f;
        currentProgress_.phase = "submitting_request";
        currentProgress_.message = "Submitting the generation request to the ACE-Step session...";
        currentProgress_.outputFile.clear();
        currentProgress_.error.clear();
        currentProgress_.elapsedMs = 0.0;
        currentProgress_.heartbeatTs = static_cast<double> (lastHeartbeatAtMs_);
        currentProgress_.phaseProgress = 0.0;
        currentProgress_.etaMs = -1.0;
        currentProgress_.sessionMode = "persistent";
        currentProgress_.workerExitCode = 0;
        currentProgress_.failureKind.clear();
    }

    if (! sendGenerateRequest(workflowId, paramsJson, outputFile))
    {
        const juce::ScopedLock sl(lock_);
        generationActive_ = false;
        if (cancelRequested_)
        {
            currentProgress_.state = "cancelled";
            currentProgress_.message = "Music generation cancelled.";
            currentProgress_.error.clear();
        }
    }
}

bool AITrackEngine::startGeneration(const juce::String& workflowId,
                                    const juce::String& paramsJson,
                                    const juce::File& outputDir)
{
    joinGenerationThread();

    {
        const juce::ScopedLock sl(lock_);
        if (generationActive_)
            return false;
    }

    const auto python = findPython();
    const auto script = findScript();

    if (! python.existsAsFile() || ! script.existsAsFile())
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("runtime_missing",
                               "AI runtime is not ready. Install AI Tools first.",
                               "runtime_missing");
        return false;
    }

    if (! outputDir.exists() && ! outputDir.createDirectory())
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("output_dir_failed",
                               "Failed to create the generated audio output folder.",
                               "output_dir_failed");
        return false;
    }

    juce::File outputFile;
    {
        const juce::ScopedLock sl(lock_);
        currentOutputFile_ = outputDir.getChildFile(
            "generated_music_" + createSafeMusicGenerationTimestamp() + ".wav");
        outputFile = currentOutputFile_;
        generationActive_ = true;
        cancelRequested_ = false;
        currentRequestId_ = juce::Uuid().toString();
        expectedScriptVersion_ = computeScriptVersion(script);
        generationStartedAtMs_ = juce::Time::currentTimeMillis();
        lastHeartbeatAtMs_ = generationStartedAtMs_;

        currentProgress_.state = "loading";
        currentProgress_.progress = 0.01f;
        currentProgress_.phase = "starting";
        currentProgress_.message = "Starting the ACE-Step runtime session...";
        currentProgress_.outputFile.clear();
        currentProgress_.error.clear();
        currentProgress_.elapsedMs = 0.0;
        currentProgress_.heartbeatTs = static_cast<double> (lastHeartbeatAtMs_);
        currentProgress_.phaseProgress = 0.0;
        currentProgress_.etaMs = -1.0;
        currentProgress_.failureKind.clear();
        currentProgress_.sessionMode = "persistent";
        currentProgress_.workerExitCode = 0;
        currentProgress_.lastStdoutLine.clear();
        currentProgress_.lastStderrLine.clear();
        currentProgress_.statusNote.clear();
        currentProgress_.attemptMode = "lm_dit";
        currentProgress_.attemptIndex = 1;
        currentProgress_.protocolVersion = kWorkerProtocolVersion;
        currentProgress_.scriptVersion = expectedScriptVersion_;
        currentProgress_.requestId = currentRequestId_;
        currentProgress_.priorFailure.clear();
        currentProgress_.lastProgressAgeMs = 0.0;
    }

    generationThread_ = std::thread([this, python, script, workflowId, paramsJson, outputFile]()
    {
        launchGenerationTask(python, script, workflowId, paramsJson, outputFile);
    });

    return true;
}

void AITrackEngine::parseOutputLine(const juce::String& line)
{
    auto trimmed = line.trim();
    if (trimmed.isEmpty())
        return;

    const juce::ScopedLock sl(lock_);
    lastProcessOutputLine_ = trimmed;

    auto parsed = juce::JSON::parse(trimmed);
    if (parsed.isVoid())
    {
        lastStdoutLine_ = trimmed;
        currentProgress_.lastStdoutLine = lastStdoutLine_;
        currentProgress_.lastStderrLine = lastStderrLine_;
        currentProgress_.workerExitCode = workerExitCode_;
        juce::Logger::writeToLog("AITrackEngine: process output: " + truncateForLog(trimmed));
        return;
    }

    auto* obj = parsed.getDynamicObject();
    if (obj == nullptr)
        return;

    if (obj->hasProperty("event"))
    {
        const auto event = obj->getProperty("event").toString();

        if (event == "stderr")
        {
            lastStderrLine_ = obj->getProperty("line").toString().trim();
            currentProgress_.lastStderrLine = lastStderrLine_;
            juce::Logger::writeToLog("AITrackEngine: worker stderr: " + truncateForLog(lastStderrLine_));
            return;
        }

        if (event == "ready")
        {
            workerProtocolVersion_ = obj->hasProperty("protocolVersion")
                ? static_cast<int> (double (obj->getProperty("protocolVersion")))
                : 0;
            workerScriptVersion_ = obj->getProperty("scriptVersion").toString();
            workerScriptPath_ = obj->getProperty("scriptPath").toString();
            workerPid_ = obj->hasProperty("pid")
                ? static_cast<int> (double (obj->getProperty("pid")))
                : 0;

            currentProgress_.protocolVersion = workerProtocolVersion_;
            currentProgress_.scriptVersion = workerScriptVersion_;

            if (workerProtocolVersion_ != kWorkerProtocolVersion
                || (! expectedScriptVersion_.isEmpty() && workerScriptVersion_ != expectedScriptVersion_))
            {
                workerProtocolRejected_ = true;
                workerReady_ = false;
                workerPort_ = 0;
                setProgressErrorLocked("worker_protocol_failed",
                                       appendProcessDetailsLocked("ACE-Step worker protocol or script version mismatch."),
                                       "worker_protocol");
                currentProgress_.statusNote = "Rejecting stale worker session before generation starts.";
                juce::Logger::writeToLog("AITrackEngine: rejecting worker ready handshake due to version mismatch"
                                         " workerProtocol=" + juce::String(workerProtocolVersion_)
                                         + " expectedProtocol=" + juce::String(kWorkerProtocolVersion)
                                         + " workerScriptVersion=" + workerScriptVersion_
                                         + " expectedScriptVersion=" + expectedScriptVersion_);
                return;
            }

            workerReady_ = true;
            workerPort_ = static_cast<int> (double (obj->getProperty("port")));
            currentProgress_.state = "idle";
            currentProgress_.progress = 0.0f;
            currentProgress_.phase = "worker_ready";
            currentProgress_.message = "ACE-Step runtime session is ready.";
            currentProgress_.backend = obj->getProperty("backend").toString();
            currentProgress_.sessionMode = obj->hasProperty("sessionMode")
                ? obj->getProperty("sessionMode").toString()
                : "persistent";
            juce::Logger::writeToLog("AITrackEngine: worker ready handshake received on port "
                                     + juce::String(workerPort_)
                                     + " pid=" + juce::String(workerPid_)
                                     + " protocolVersion=" + juce::String(workerProtocolVersion_)
                                     + " scriptVersion=" + workerScriptVersion_
                                     + " after "
                                     + juce::String(static_cast<int> (juce::Time::currentTimeMillis() - workerLaunchAtMs_))
                                     + " ms");
            return;
        }
    }

    sawStructuredOutput_ = true;
    lastStdoutLine_ = trimmed;
    if (! loggedFirstStructuredOutput_)
    {
        loggedFirstStructuredOutput_ = true;
        juce::Logger::writeToLog(
            "AITrackEngine: first structured progress line state="
            + obj->getProperty("state").toString()
            + " phase=" + obj->getProperty("phase").toString());
    }

    const auto incomingState = obj->hasProperty("state")
        ? obj->getProperty("state").toString()
        : juce::String();
    const auto currentStateIsTerminal = currentProgress_.state == "done"
        || currentProgress_.state == "error"
        || currentProgress_.state == "cancelled";
    const auto incomingStateIsTerminal = incomingState == "done"
        || incomingState == "error"
        || incomingState == "cancelled";
    if (currentStateIsTerminal && ! incomingStateIsTerminal)
    {
        juce::Logger::writeToLog("AITrackEngine: ignoring late non-terminal progress after terminal state"
                                 " currentState=" + currentProgress_.state
                                 + " incomingState=" + incomingState
                                 + " requestId=" + currentProgress_.requestId);
        return;
    }

    if (obj->hasProperty("state"))
        currentProgress_.state = obj->getProperty("state").toString();
    if (obj->hasProperty("progress"))
        currentProgress_.progress = static_cast<float> (double (obj->getProperty("progress")));
    if (obj->hasProperty("phase"))
    {
        currentProgress_.phase = obj->getProperty("phase").toString();
        currentProgress_.phaseProgress = -1.0;
    }
    if (obj->hasProperty("message"))
        currentProgress_.message = obj->getProperty("message").toString();
    if (obj->hasProperty("backend"))
        currentProgress_.backend = obj->getProperty("backend").toString();
    if (obj->hasProperty("outputFile"))
        currentProgress_.outputFile = obj->getProperty("outputFile").toString();
    if (obj->hasProperty("error"))
        currentProgress_.error = obj->getProperty("error").toString();
    if (obj->hasProperty("elapsedMs"))
        currentProgress_.elapsedMs = double (obj->getProperty("elapsedMs"));
    if (obj->hasProperty("heartbeatTs"))
        currentProgress_.heartbeatTs = double (obj->getProperty("heartbeatTs"));
    if (obj->hasProperty("phaseProgress"))
        currentProgress_.phaseProgress = double (obj->getProperty("phaseProgress"));
    if (obj->hasProperty("etaMs"))
        currentProgress_.etaMs = double (obj->getProperty("etaMs"));
    if (obj->hasProperty("runMode"))
        currentProgress_.runMode = obj->getProperty("runMode").toString();
    if (obj->hasProperty("runtimeProfile"))
        currentProgress_.runtimeProfile = obj->getProperty("runtimeProfile").toString();
    if (obj->hasProperty("lmModel"))
        currentProgress_.lmModel = obj->getProperty("lmModel").toString();
    if (obj->hasProperty("statusNote"))
        currentProgress_.statusNote = obj->getProperty("statusNote").toString();
    if (obj->hasProperty("failureKind"))
        currentProgress_.failureKind = obj->getProperty("failureKind").toString();
    if (obj->hasProperty("failureDetail"))
        currentProgress_.failureDetail = obj->getProperty("failureDetail").toString();
    if (obj->hasProperty("sessionMode"))
        currentProgress_.sessionMode = obj->getProperty("sessionMode").toString();
    if (obj->hasProperty("workerExitCode"))
        currentProgress_.workerExitCode = static_cast<int> (double (obj->getProperty("workerExitCode")));
    if (obj->hasProperty("lastStdoutLine"))
        currentProgress_.lastStdoutLine = obj->getProperty("lastStdoutLine").toString();
    if (obj->hasProperty("lastStderrLine"))
        currentProgress_.lastStderrLine = obj->getProperty("lastStderrLine").toString();
    if (obj->hasProperty("attemptMode"))
        currentProgress_.attemptMode = obj->getProperty("attemptMode").toString();
    if (obj->hasProperty("attemptIndex"))
        currentProgress_.attemptIndex = static_cast<int> (double (obj->getProperty("attemptIndex")));
    if (obj->hasProperty("protocolVersion"))
        currentProgress_.protocolVersion = static_cast<int> (double (obj->getProperty("protocolVersion")));
    if (obj->hasProperty("scriptVersion"))
        currentProgress_.scriptVersion = obj->getProperty("scriptVersion").toString();
    if (obj->hasProperty("requestId"))
        currentProgress_.requestId = obj->getProperty("requestId").toString();
    if (obj->hasProperty("priorFailure"))
        currentProgress_.priorFailure = obj->getProperty("priorFailure").toString();
    if (obj->hasProperty("lastProgressAgeMs"))
        currentProgress_.lastProgressAgeMs = double (obj->getProperty("lastProgressAgeMs"));
    auto tracePathChanged = false;
    juce::String incomingTracePath;
    if (obj->hasProperty("tracePath"))
    {
        incomingTracePath = obj->getProperty("tracePath").toString();
        tracePathChanged = incomingTracePath.isNotEmpty() && incomingTracePath != currentProgress_.tracePath;
        currentProgress_.tracePath = incomingTracePath;
    }
    if (obj->hasProperty("lmBackend"))
        currentProgress_.lmBackend = obj->getProperty("lmBackend").toString();
    if (obj->hasProperty("lmStage"))
        currentProgress_.lmStage = obj->getProperty("lmStage").toString();

    lastHeartbeatAtMs_ = juce::Time::currentTimeMillis();
    currentProgress_.lastStdoutLine = lastStdoutLine_;
    currentProgress_.lastStderrLine = lastStderrLine_;
    currentProgress_.workerExitCode = workerExitCode_;

    if (currentProgress_.state == "error" && currentProgress_.failureKind.isEmpty())
        currentProgress_.failureKind = "generation";
    if (currentProgress_.state == "error" && currentProgress_.failureDetail.isEmpty())
        currentProgress_.failureDetail = currentProgress_.error.isNotEmpty() ? currentProgress_.error : currentProgress_.message;

    if (tracePathChanged)
        juce::Logger::writeToLog("AITrackEngine: AI trace path " + currentProgress_.tracePath);

    if (currentProgress_.state == "done")
        currentProgress_.failureKind.clear();

    if (currentProgress_.state == "done"
        || currentProgress_.state == "error"
        || currentProgress_.state == "cancelled")
    {
        generationActive_ = false;
    }
}

void AITrackEngine::handleWorkerExit()
{
    juce::String finalError;

    {
        const juce::ScopedLock sl(lock_);
        const auto expectedExit = expectedProcessExit_;
        expectedProcessExit_ = false;
        workerReady_ = false;
        workerPort_ = 0;

        workerExitCode_ = 0;
        if (workerProcess_ != nullptr)
            workerExitCode_ = static_cast<int> (workerProcess_->getExitCode());

        currentProgress_.workerExitCode = workerExitCode_;
        currentProgress_.lastStdoutLine = lastStdoutLine_;
        currentProgress_.lastStderrLine = lastStderrLine_;

        juce::Logger::writeToLog(
            "AITrackEngine: ACE-Step child process exited with code "
            + juce::String(workerExitCode_)
            + " (sessionMode=" + currentProgress_.sessionMode + ")");

        if (expectedExit)
            return;

        if (! generationActive_)
            return;

        if (currentProgress_.state == "done"
            || currentProgress_.state == "error"
            || currentProgress_.state == "cancelled")
        {
            generationActive_ = false;
            return;
        }

        if (currentOutputFile_.existsAsFile())
        {
            currentProgress_.state = "done";
            currentProgress_.progress = 1.0f;
            currentProgress_.outputFile = currentOutputFile_.getFullPathName();
            currentProgress_.phase = "done";
            currentProgress_.message = "Music generation completed.";
            currentProgress_.failureKind.clear();
            generationActive_ = false;
            return;
        }

        if (! sawStructuredOutput_)
            finalError = appendProcessDetailsLocked("The ACE-Step process exited before reporting progress.");
        else if (currentProgress_.error.isNotEmpty())
            finalError = appendProcessDetailsLocked(currentProgress_.error);
        else
            finalError = appendProcessDetailsLocked("Generation stopped unexpectedly before writing audio.");

        setProgressErrorLocked("worker_exit", finalError, "worker_exit");
        generationActive_ = false;
    }
}

void AITrackEngine::readerLoop()
{
    juce::Logger::writeToLog("AITrackEngine: reader thread started");

    for (;;)
    {
        if (readerShouldExit_)
            break;

        auto* process = workerProcess_.get();
        if (process == nullptr)
            break;

        char byte = 0;
        const auto numRead = process->readProcessOutput(&byte, 1);
        if (numRead > 0)
        {
            juce::StringArray linesToParse;
            juce::String firstLineForLog;
            bool shouldLogFirstByte = false;
            bool shouldLogFirstLine = false;
            juce::int64 firstByteDelayMs = 0;
            juce::int64 firstLineDelayMs = 0;

            {
                const juce::ScopedLock sl(lock_);

                if (! loggedFirstOutputByte_)
                {
                    loggedFirstOutputByte_ = true;
                    firstOutputByteAtMs_ = juce::Time::currentTimeMillis();
                    firstByteDelayMs = firstOutputByteAtMs_ - workerLaunchAtMs_;
                    shouldLogFirstByte = true;
                }

                processOutputBuffer_.push_back(byte);

                while (true)
                {
                    const auto newlinePos = processOutputBuffer_.find('\n');
                    if (newlinePos == std::string::npos)
                        break;

                    auto rawLine = processOutputBuffer_.substr(0, newlinePos);
                    processOutputBuffer_.erase(0, newlinePos + 1);

                    auto parsedLine = juce::String::fromUTF8(rawLine.c_str(), static_cast<int> (rawLine.size())).trim();
                    if (parsedLine.isEmpty())
                        continue;

                    if (! loggedFirstOutputLine_)
                    {
                        loggedFirstOutputLine_ = true;
                        firstOutputLineAtMs_ = juce::Time::currentTimeMillis();
                        firstLineDelayMs = firstOutputLineAtMs_ - workerLaunchAtMs_;
                        firstLineForLog = parsedLine;
                        shouldLogFirstLine = true;
                    }

                    linesToParse.add(parsedLine);
                }
            }

            if (shouldLogFirstByte)
                juce::Logger::writeToLog("AITrackEngine: first worker output byte received after "
                                         + juce::String(static_cast<int> (firstByteDelayMs))
                                         + " ms");

            if (shouldLogFirstLine)
                juce::Logger::writeToLog("AITrackEngine: first worker output line received after "
                                         + juce::String(static_cast<int> (firstLineDelayMs))
                                         + " ms: "
                                         + truncateForLog(firstLineForLog));

            for (const auto& parsedLine : linesToParse)
                parseOutputLine(parsedLine);
        }
        else if (! process->isRunning())
        {
            juce::String trailingLine;
            {
                const juce::ScopedLock sl(lock_);
                if (! processOutputBuffer_.empty())
                {
                    trailingLine = juce::String::fromUTF8(processOutputBuffer_.data(),
                                                          static_cast<int> (processOutputBuffer_.size())).trim();
                }
                processOutputBuffer_.clear();
            }

            if (trailingLine.isNotEmpty())
                parseOutputLine(trailingLine);

            break;
        }
        else
        {
            juce::Thread::sleep(kReaderSleepMs);
        }
    }

    juce::Logger::writeToLog("AITrackEngine: reader thread exiting");
    handleWorkerExit();
}

void AITrackEngine::resetProcessStateLocked()
{
    processOutputBuffer_.clear();
    lastProcessOutputLine_.clear();
    lastStdoutLine_.clear();
    lastStderrLine_.clear();
    sawStructuredOutput_ = false;
    loggedFirstStructuredOutput_ = false;
    loggedFirstOutputByte_ = false;
    loggedFirstOutputLine_ = false;
    workerProtocolRejected_ = false;
    workerExitCode_ = 0;
    workerProtocolVersion_ = 0;
    workerPid_ = 0;
    workerLaunchAtMs_ = 0;
    firstOutputByteAtMs_ = 0;
    firstOutputLineAtMs_ = 0;
    workerScriptVersion_.clear();
    workerScriptPath_.clear();
}

void AITrackEngine::stopWorker(bool clearProgress, bool userCancelled)
{
    stopWorkerSession(clearProgress, userCancelled, false);
    joinGenerationThread();
}

AIGenerationProgress AITrackEngine::pollProgress()
{
    bool shouldStopForDecodeStall = false;

    {
        const juce::ScopedLock sl(lock_);

        if (currentProgress_.state == "error"
            && currentProgress_.failureKind == "decode_stalled"
            && workerProcess_ != nullptr
            && workerProcess_->isRunning())
        {
            shouldStopForDecodeStall = true;
        }

        if (generationActive_)
        {
            const auto nowMs = juce::Time::currentTimeMillis();
            currentProgress_.elapsedMs = static_cast<double> (nowMs - generationStartedAtMs_);

            if (lastHeartbeatAtMs_ > 0)
            {
                currentProgress_.heartbeatTs = static_cast<double> (lastHeartbeatAtMs_);
                currentProgress_.lastProgressAgeMs = static_cast<double> (nowMs - lastHeartbeatAtMs_);
            }

            const auto decodeStallTimeoutMs = kColdDecodeStallTimeoutMs;
            const auto inTerminalState = currentProgress_.state == "done"
                || currentProgress_.state == "error"
                || currentProgress_.state == "cancelled";
            if (! inTerminalState
                && currentProgress_.phase == "decoding_audio"
                && currentProgress_.lastProgressAgeMs >= static_cast<double> (decodeStallTimeoutMs))
            {
                auto message = "ACE-Step decode stalled while finalizing audio after "
                    + juce::String(static_cast<int> (currentProgress_.lastProgressAgeMs / 1000.0))
                    + " seconds.";
                if (currentProgress_.priorFailure.isNotEmpty())
                    message += " Prior failure: " + currentProgress_.priorFailure;
                setProgressErrorLocked("decode_stalled",
                                       appendProcessDetailsLocked(message),
                                       "decode_stalled");
                currentProgress_.statusNote = "Stopping the stalled ACE-Step decode process.";
                generationActive_ = false;
                shouldStopForDecodeStall = true;
            }

            if (workerProcess_ != nullptr && ! workerProcess_->isRunning()
                && currentProgress_.state != "done"
                && currentProgress_.state != "error"
                && currentProgress_.state != "cancelled")
            {
                setProgressErrorLocked("worker_missing",
                                       appendProcessDetailsLocked("Generation stopped unexpectedly before writing audio."),
                                       "worker_exit");
                generationActive_ = false;
            }
        }

        currentProgress_.workerExitCode = workerExitCode_;
        currentProgress_.lastStdoutLine = lastStdoutLine_;
        currentProgress_.lastStderrLine = lastStderrLine_;
    }

    if (shouldStopForDecodeStall)
        stopWorkerSession(false, false, false);

    const juce::ScopedLock sl(lock_);
    return currentProgress_;
}

void AITrackEngine::cancel()
{
    stopWorker(true, true);
}

bool AITrackEngine::isRunning() const
{
    const juce::ScopedLock sl(lock_);
    return generationActive_;
}
