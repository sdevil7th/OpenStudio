#if defined(_WIN32)
#include <winsock2.h>
#endif
#include "AITrackEngine.h"
#include "RecoveryJournal.h"
#include "JsonEnvelope.h"

namespace
{
constexpr auto kPinnedMusicGenerationModelId = "ace-step-v15-xl-turbo";
constexpr auto kPinnedMusicGenerationModelRepoId = "ACE-Step/acestep-v15-xl-turbo-diffusers";
constexpr auto kStableAudioModelId = "stable-audio-3-medium";
constexpr auto kMiniMaxModelId = "minimax-music-3";
bool isDiffusersAudioModel(const juce::String& id)
{
    return id == kStableAudioModelId || id == kMiniMaxModelId;
}
juce::String audioModelLabel(const juce::String& id)
{
    return id == kMiniMaxModelId ? "MiniMax Music 3"
        : id == kStableAudioModelId ? "Stable Audio 3" : "ACE-Step";
}
constexpr auto kReaderSleepMs = 50;
constexpr auto kWorkerStartupTimeoutMs = 45000;
constexpr auto kWorkerRequestTimeoutMs = 10000;
constexpr auto kWorkerProtocolVersion = 2;
constexpr auto kMaxFramedPayloadBytes = 8 * 1024 * 1024;
constexpr size_t kMaxWorkerLineBytes = 64 * 1024;
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

    if (script.getFileName() == "stable_audio3_generate.py" || script.getFileName() == "generate_music.py")
    {
        for (const auto* module : { "diffusers_audio_pipeline.py", "ai_execution_policy.py",
                                    "ai_attention_policy.py", "ai_partial_offload.py", "ai_disk_store.py", "ai_model_variants.py" })
        {
            juce::MemoryBlock adapterBytes;
            if (! script.getSiblingFile(module).loadFileAsData(adapterBytes))
                return {};
            scriptBytes.append(adapterBytes.getData(), adapterBytes.getSize());
        }
    }

    return juce::MD5(scriptBytes.getData(), scriptBytes.getSize()).toHexString().substring(0, 16);
}

bool writeSocketFully(juce::StreamingSocket& socket, const char* data, int totalBytes, int timeoutMs, const std::atomic<bool>& cancelled)
{
    auto bytesWritten = 0;
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;

    while (!cancelled.load() && bytesWritten < totalBytes && juce::Time::currentTimeMillis() < deadline)
    {
        if (socket.waitUntilReady(false, 250) <= 0)
            continue;

        const auto chunkBytes = socket.write(data + bytesWritten, juce::jmin(4096, totalBytes - bytesWritten));
        if (chunkBytes <= 0)
            return false;

        bytesWritten += chunkBytes;
    }

    return bytesWritten == totalBytes;
}

bool readSocketFully(juce::StreamingSocket& socket, void* destination, int totalBytes, int timeoutMs, const std::atomic<bool>& cancelled)
{
    auto* writePtr = static_cast<char*> (destination);
    auto bytesRead = 0;
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;

    while (!cancelled.load() && bytesRead < totalBytes && juce::Time::currentTimeMillis() < deadline)
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

struct RequestSerializationAborted {};

// JUCE's JSON formatter ignores a false write result. An explicit local abort
// stops formatting as well as allocation when cancellation or the size bound
// is reached. This runs only on the generation thread, never the audio thread.
class RequestJSONStream final : public juce::OutputStream
{
public:
    explicit RequestJSONStream(const std::atomic<bool>& stop) : cancelled(stop) {}
    bool write(const void* data, size_t bytes) override
    {
        if (cancelled.load(std::memory_order_relaxed)
            || bytes > static_cast<size_t>(kMaxFramedPayloadBytes) - memory.getDataSize())
            throw RequestSerializationAborted {};
        return memory.write(data, bytes);
    }
    void flush() override {}
    juce::int64 getPosition() override { return memory.getPosition(); }
    bool setPosition(juce::int64 position) override { return memory.setPosition(position); }
    juce::MemoryOutputStream memory;
private:
    const std::atomic<bool>& cancelled;
};

bool writeFramedJson(juce::StreamingSocket& socket,
                     const juce::var& payload,
                     int timeoutMs,
                     int& payloadBytesWritten, const std::atomic<bool>& cancelled)
{
    RequestJSONStream json(cancelled);
    try { juce::JSON::writeToStream(json, payload, false); }
    catch (const RequestSerializationAborted&) { return false; }
    payloadBytesWritten = static_cast<int> (json.memory.getDataSize());
    if (payloadBytesWritten <= 0 || payloadBytesWritten > kMaxFramedPayloadBytes)
        return false;

    char header[4] {};
    header[0] = static_cast<char> ((payloadBytesWritten >> 24) & 0xFF);
    header[1] = static_cast<char> ((payloadBytesWritten >> 16) & 0xFF);
    header[2] = static_cast<char> ((payloadBytesWritten >> 8) & 0xFF);
    header[3] = static_cast<char> (payloadBytesWritten & 0xFF);

    return writeSocketFully(socket, header, 4, timeoutMs, cancelled)
        && writeSocketFully(socket, static_cast<const char*>(json.memory.getData()), payloadBytesWritten, timeoutMs, cancelled);
}

juce::var readFramedJson(juce::StreamingSocket& socket, int timeoutMs, int& payloadBytesRead, const std::atomic<bool>& cancelled)
{
    char header[4] {};
    payloadBytesRead = 0;
    if (! readSocketFully(socket, header, 4, timeoutMs, cancelled))
        return {};

    payloadBytesRead = ((static_cast<unsigned char> (header[0]) << 24)
                        | (static_cast<unsigned char> (header[1]) << 16)
                        | (static_cast<unsigned char> (header[2]) << 8)
                        | static_cast<unsigned char> (header[3]));

    if (payloadBytesRead <= 0 || payloadBytesRead > kMaxFramedPayloadBytes)
        return {};

    juce::HeapBlock<char> buffer(static_cast<size_t> (payloadBytesRead + 1));
    zeromem(buffer.get(), static_cast<size_t> (payloadBytesRead + 1));
    if (! readSocketFully(socket, buffer.get(), payloadBytesRead, timeoutMs, cancelled))
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

juce::File AITrackEngine::getStableAudioRuntimeRoot() const
{
    return getUserDataRoot().getChildFile("diffusers-audio-runtime");
}

juce::File AITrackEngine::getMusicGenerationCheckpointRoot() const
{
    return juce::File::getSpecialLocation(juce::File::userHomeDirectory)
        .getChildFile(".cache")
        .getChildFile("ace-step")
        .getChildFile("diffusers");
}

juce::File AITrackEngine::getStableAudioModelRoot(const juce::String& modelId) const
{
    return getUserDataRoot()
        .getChildFile("models")
        .getChildFile(modelId);
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

juce::File AITrackEngine::findStableAudioPython() const
{
    auto runtimePython = findPythonInRuntimeRoot(getStableAudioRuntimeRoot());
    if (runtimePython.existsAsFile())
        return runtimePython;

    return {};
}

juce::File AITrackEngine::qualifiedMiniMaxPython(const juce::File& candidateRoot)
{
    const auto manifest = candidateRoot.getChildFile("minimax-int8-qualified.json");
    if (! manifest.existsAsFile() || manifest.getSize() > 64 * 1024)
        return {};
    const auto profile = juce::JSON::parse(manifest);
    if (! profile.isObject() || static_cast<int>(profile.getProperty("schemaVersion", 0)) != 1
        || profile.getProperty("state", "").toString() != "qualified-local"
        || profile.getProperty("modelId", "").toString() != kMiniMaxModelId
        || profile.getProperty("policy", "").toString() != "minimax-int8-stage-v1")
        return {};
    const auto environment = profile.getProperty("environment", "").toString();
    if (! environment.startsWith("int8-")
        || ! environment.containsOnly("abcdefghijklmnopqrstuvwxyz0123456789-"))
        return {};
    const auto root = candidateRoot.getChildFile(environment);
    if (root.isSymbolicLink())
        return {};
    // Python revalidates the stack, model, physical adapter and request budget
    // before enabling quantization. An import-only staging manifest is ignored.
    return findPythonInRuntimeRoot(root);
}

juce::File AITrackEngine::findMiniMaxPython() const
{
    const auto candidate = qualifiedMiniMaxPython(getUserDataRoot().getChildFile("ai-candidates"));
    return candidate.existsAsFile() ? candidate : findStableAudioPython();
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

juce::File AITrackEngine::findStableAudioScript() const
{
    const auto runtimeDir = getApplicationRuntimeDirectory();
    const auto packagedScript = runtimeDir.getChildFile("scripts").getChildFile("stable_audio3_generate.py");
    if (packagedScript.existsAsFile())
        return packagedScript;

    const auto bundledDevScript = runtimeDir.getChildFile("tools").getChildFile("stable_audio3_generate.py");
    if (bundledDevScript.existsAsFile())
        return bundledDevScript;

    const auto workingCopyScript = juce::File::getCurrentWorkingDirectory()
        .getChildFile("tools")
        .getChildFile("stable_audio3_generate.py");
    if (workingCopyScript.existsAsFile())
        return workingCopyScript;

    return {};
}

juce::var AITrackEngine::getGenerationPreflight(const juce::String& modelId,
    const juce::String& workflowId, const juce::String& paramsJson,
    const std::function<bool()>& cancelled) const
{
    const auto unavailable = [](const juce::String& reason) -> juce::var {
        auto* result = new juce::DynamicObject();
        result->setProperty("status", "unavailable");
        result->setProperty("memory", juce::Array<juce::var>());
        result->setProperty("notes", juce::Array<juce::var> { reason });
        return result;
    };
    if (modelId != "minimax-music-3" && modelId != "stable-audio-3-medium"
        && modelId != "ace-step-v15-xl-turbo")
        return unavailable("Hardware check does not support this model.");
    const bool stable = modelId != "ace-step-v15-xl-turbo";
    const bool int8 = juce::JSON::parse(paramsJson).getProperty("modelVariant", "").toString() == "int8";
    const auto python = int8 ? findStableAudioPython() : modelId == "minimax-music-3" ? findMiniMaxPython()
        : stable ? findStableAudioPython() : findPython();
    const auto worker = stable ? findStableAudioScript() : findScript();
    const auto script = worker.getSiblingFile("ai_generation_preflight.py");
    const auto root = stable ? getStableAudioModelRoot(modelId) : getMusicGenerationCheckpointRoot();
    if (!python.existsAsFile() || !script.existsAsFile())
        return unavailable("Install the model runtime to check hardware requirements.");
    const auto params = juce::JSON::parse(paramsJson);
    if (!params.isObject() || paramsJson.getNumBytesAsUTF8() > 256 * 1024)
        return unavailable("Invalid generation parameters.");
    juce::TemporaryFile request(".json");
    auto* input = new juce::DynamicObject();
    input->setProperty("workflow", workflowId);
    input->setProperty("params", params);
    if (!request.getFile().replaceWithText(juce::JSON::toString(juce::var(input))))
        return unavailable("Could not prepare the hardware check.");
    OwnedChildProcess process;
    juce::StringPairArray environment;
    environment.set("HF_HUB_OFFLINE", "1");
    environment.set("TRANSFORMERS_OFFLINE", "1");
    if (cancelled() || !process.start({ python.getFullPathName(), script.getFullPathName(),
        "--model-id", modelId, "--model-root", root.getFullPathName(),
        "--request", request.getFile().getFullPathName() }, 3, environment))
        return unavailable("Could not start the hardware check.");
    std::string output;
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + 30000.0;
    for (;;)
    {
        char buffer[4096];
        const auto count = process.readProcessOutput(buffer, static_cast<int>(sizeof(buffer)));
        if (count > 0) output.append(buffer, static_cast<size_t>(count));
        if (cancelled() || juce::Time::getMillisecondCounterHiRes() > deadline || output.size() > 256 * 1024)
        {
            process.kill();
            return unavailable("Hardware check was interrupted or timed out. Runtime checks still apply.");
        }
        if (count <= 0 && !process.isRunning()) break;
        if (count <= 0) juce::Thread::sleep(10);
    }
    const auto lines = juce::StringArray::fromLines(juce::String::fromUTF8(output.data(), static_cast<int>(output.size())));
    for (int index = lines.size(); --index >= 0;)
    {
        const auto result = juce::JSON::parse(lines[index]);
        if (result.isObject() && result.hasProperty("status") && result.hasProperty("memory")) return result;
    }
    return unavailable("Hardware check could not read this runtime. Generation will validate its own requirements.");
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
            const auto modelLabel = audioModelLabel(currentProgress_.modelId);
            const auto message = workerExitedBeforeReady
                ? appendProcessDetailsLocked(modelLabel + " worker exited before reporting ready.")
                : appendProcessDetailsLocked(modelLabel + " worker did not become ready in time.");
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
    OwnedChildProcess* processToKill = nullptr;

    {
        const juce::ScopedLock sl(lock_);
        readerShouldExit_ = true;
        expectedProcessExit_ = true;
        cancelRequested_ = cancelRequested_ || userCancelled;
        if (! keepGenerationActive)
            generationActive_ = false;
        workerReady_ = false;
        workerPort_ = 0;
        processToKill = workerProcess_.get();

        if (workerProcess_ != nullptr && workerProcess_->isRunning())
            shouldKillProcess = true;

        if (readerThread_.joinable())
            readerThreadToJoin = std::move(readerThread_);
    }

    if (shouldKillProcess && processToKill != nullptr && processToKill->isRunning())
    {
        if (!processToKill->kill())
            juce::Logger::writeToLog("AITrackEngine: owned process-tree termination failed.");
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

bool AITrackEngine::ensureWorkerAvailable(const juce::File& python, const juce::File& script, const juce::String& modelId)
{
    if (stopRequested_.load(std::memory_order_acquire)) return false;
    const auto isStableAudio = isDiffusersAudioModel(modelId);
    const auto modelLabel = audioModelLabel(modelId);
    const auto expectedScriptVersion = computeScriptVersion(script);
    {
        const juce::ScopedLock sl(lock_);
        if (workerProcess_ != nullptr
            && workerProcess_->isRunning()
            && workerReady_
            && workerPort_ > 0
            && workerProtocolVersion_ == kWorkerProtocolVersion
            && workerScriptVersion_ == expectedScriptVersion
            && workerPython_ == python
            && juce::File(workerScriptPath_) == script
            && workerModelId_ == modelId)
            return true;
    }

    stopWorkerSession(false, false, true);

    for (int launchAttempt = 0; launchAttempt < 2; ++launchAttempt)
    {
        if (stopRequested_.load(std::memory_order_acquire)) return false;
        auto nextWorker = std::make_unique<OwnedChildProcess>();
        juce::StringArray command;
        command.add(python.getFullPathName());
        command.add(script.getFullPathName());
        command.add("--worker");
        if (isStableAudio)
        {
            command.add("--model-root");
            command.add(getStableAudioModelRoot(modelId).getFullPathName());
            command.add("--model-id");
            command.add(modelId);
        }
        else
        {
            command.add("--cache-root");
            command.add(getMusicGenerationCheckpointRoot().getFullPathName());
            command.add("--music-gen-model");
            command.add(kPinnedMusicGenerationModelId);
            command.add("--model-id");
            command.add(kPinnedMusicGenerationModelRepoId);
        }

        const auto commandLine = buildCommandLineForLog(command);
        juce::Logger::writeToLog("AITrackEngine: launching persistent " + modelLabel + " worker: " + commandLine
                                 + " protocolVersion=" + juce::String(kWorkerProtocolVersion)
                                 + " expectedScriptVersion=" + expectedScriptVersion
                                 + " launchAttempt=" + juce::String(launchAttempt + 1));

        {
            const juce::ScopedLock sl(lock_);
            resetProcessStateLocked();
            workerPython_ = python;
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
            currentProgress_.message = "Starting the " + modelLabel + " runtime session...";
            currentProgress_.modelId = modelId;
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
            currentProgress_.runtimeProfile.clear();
            currentProgress_.lmModel.clear();
            currentProgress_.attemptMode.clear();
            currentProgress_.lmBackend.clear();
            currentProgress_.lmStage.clear();
            currentProgress_.tracePath.clear();
            currentProgress_.failureDetail.clear();
        }

        if (! nextWorker->start(command))
        {
            const juce::ScopedLock sl(lock_);
            workerProcess_.reset();
            setProgressErrorLocked("worker_start_failed",
                                   "Failed to start the " + modelLabel + " runtime session.",
                                   "worker_start");
            return false;
        }

        {
            const juce::ScopedLock sl(lock_);
            if (stopRequested_.load(std::memory_order_acquire)) return false;
            workerProcess_ = std::move(nextWorker);
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

    }

    return false;
}

bool AITrackEngine::sendGenerateRequest(const juce::String& modelId,
                                        const juce::String& workflowId,
                                        const juce::String& paramsJson,
                                        const juce::File& outputFile)
{
    const auto modelLabel = audioModelLabel(modelId);
    int port = 0;
    juce::String requestId;
    juce::String scriptVersion;
    int workerPid = 0;
    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;
        port = workerPort_;
        requestId = currentRequestId_;
        scriptVersion = expectedScriptVersion_;
        workerPid = workerPid_;
    }

    if (port <= 0)
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("worker_connect_failed",
                               appendProcessDetailsLocked(modelLabel + " worker did not provide a listening port."),
                               "worker_request");
        return false;
    }

    juce::StreamingSocket socket;
    if (! socket.connect("127.0.0.1", port, 4000))
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("worker_connect_failed",
                               appendProcessDetailsLocked("OpenStudio could not contact the " + modelLabel + " runtime session."),
                               "worker_request");
        return false;
    }

   #if JUCE_WINDOWS
    // Readiness is not a promise that a large blocking send will complete.
    // Bound individual sends as well as the framing/cancellation loop.
    const DWORD sendTimeoutMs = 250;
    if (setsockopt(static_cast<SOCKET>(socket.getRawSocketHandle()), SOL_SOCKET, SO_SNDTIMEO,
        reinterpret_cast<const char*>(&sendTimeoutMs), sizeof(sendTimeoutMs)) != 0)
        return false;
   #endif

    auto request = std::make_unique<juce::DynamicObject>();
    request->setProperty("command", "generate");
    request->setProperty("modelId", modelId);
    request->setProperty("workflow", workflowId);
    request->setProperty("params", paramsJson);
    request->setProperty("output", outputFile.getFullPathName());
    request->setProperty("requestId", requestId);
    request->setProperty("protocolVersion", kWorkerProtocolVersion);
    request->setProperty("scriptVersion", scriptVersion);

    int payloadBytesWritten = 0;
    if (! writeFramedJson(socket, juce::var(request.release()), kWorkerRequestTimeoutMs, payloadBytesWritten, stopRequested_))
    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;

        setProgressErrorLocked("worker_request_failed",
                               appendProcessDetailsLocked("OpenStudio could not fully submit the generation request to the " + modelLabel + " session."),
                               "worker_protocol");
        return false;
    }

    juce::Logger::writeToLog("AITrackEngine: sent framed worker request"
                             " requestId=" + requestId
                             + " workerPid=" + juce::String(workerPid)
                             + " payloadBytes=" + juce::String(payloadBytesWritten));

    int ackPayloadBytes = 0;
    auto parsed = readFramedJson(socket, kWorkerRequestTimeoutMs, ackPayloadBytes, stopRequested_);
    if (parsed.isVoid())
    {
        const juce::ScopedLock sl(lock_);
        if (cancelRequested_)
            return false;

        setProgressErrorLocked("worker_request_timeout",
                               appendProcessDetailsLocked(modelLabel + " did not acknowledge the generation request in time."),
                               "worker_protocol");
        return false;
    }

    auto* object = parsed.getDynamicObject();
    if (object == nullptr || ! static_cast<bool> (object->getProperty("accepted")))
    {
        auto error = object != nullptr
            ? object->getProperty("error").toString()
            : modelLabel + " returned an invalid worker response.";

        if (error.isEmpty())
            error = modelLabel + " rejected the generation request.";

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
        || ackScriptVersion != scriptVersion)
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("worker_protocol_failed",
                               appendProcessDetailsLocked(modelLabel + " acknowledged the request with a mismatched protocol or request id."),
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
                                         const juce::String& modelId,
                                         const juce::String& workflowId,
                                         const juce::String& paramsJson,
                                         const juce::File& outputFile)
{
    const auto modelLabel = audioModelLabel(modelId);

    if (! ensureWorkerAvailable(python, script, modelId))
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
        currentProgress_.message = "Submitting the generation request to the " + modelLabel + " session...";
        currentProgress_.modelId = modelId;
        currentProgress_.workflowId = workflowId;
        currentProgress_.outputFile.clear();
        currentProgress_.error.clear();
        currentProgress_.elapsedMs = 0.0;
        currentProgress_.heartbeatTs = static_cast<double> (lastHeartbeatAtMs_);
        currentProgress_.phaseProgress = 0.0;
        currentProgress_.etaMs = -1.0;
        currentProgress_.sessionMode = "persistent";
        currentProgress_.workerExitCode = 0;
        currentProgress_.failureKind.clear();
        currentProgress_.runtimeProfile.clear();
        currentProgress_.lmModel.clear();
        currentProgress_.attemptMode.clear();
        currentProgress_.lmBackend.clear();
        currentProgress_.lmStage.clear();
    }

    if (! sendGenerateRequest(modelId, workflowId, paramsJson, outputFile))
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

bool AITrackEngine::startGeneration(const juce::String& modelId,
                                    const juce::String& workflowId,
                                    const juce::String& paramsJson,
                                    const juce::File& outputDir)
{
    if (!hasBoundedJsonEnvelope(paramsJson, 8 * 1024 * 1024)) return false;
    auto parameters = juce::JSON::parse(paramsJson);
    if (!parameters.isObject()) return false;
    const auto recoveryId = parameters.getProperty("_openStudioRecoveryId", "").toString();
    parameters.getDynamicObject()->removeProperty("_openStudioRecoveryId");
    const auto workerParameters = juce::JSON::toString(parameters, true);
    {
        const juce::ScopedLock sl(lock_);
        if (generationActive_)
            return false;
    }

    joinGenerationThread();
    if (modelId != kPinnedMusicGenerationModelId && ! isDiffusersAudioModel(modelId))
        return false;
    if (modelId == kMiniMaxModelId && workflowId != "lyrics-style" && workflowId != "structured-song")
        return false;

    const auto isStableAudio = isDiffusersAudioModel(modelId);
    const bool int8 = juce::JSON::parse(paramsJson).getProperty("modelVariant", "").toString() == "int8";
    const auto python = int8 ? findStableAudioPython() : modelId == kMiniMaxModelId ? findMiniMaxPython()
        : isStableAudio ? findStableAudioPython() : findPython();
    const auto script = isStableAudio ? findStableAudioScript() : findScript();
    const auto modelLabel = audioModelLabel(modelId);

    if (! python.existsAsFile() || ! script.existsAsFile())
    {
        const juce::ScopedLock sl(lock_);
        setProgressErrorLocked("runtime_missing",
                               modelLabel + " runtime is not ready. Install AI Tools first.",
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
            (isStableAudio ? "generated_stable_audio_" : "generated_music_")
            + createSafeMusicGenerationTimestamp() + ".wav");
        outputFile = currentOutputFile_;
        generationActive_ = true;
        cancelRequested_ = false;
        stopRequested_.store(false, std::memory_order_release);
        currentRequestId_ = juce::Uuid().toString();
        recoveryJournalId_ = recoveryId;
        expectedScriptVersion_ = computeScriptVersion(script);
        generationStartedAtMs_ = juce::Time::currentTimeMillis();
        lastHeartbeatAtMs_ = generationStartedAtMs_;

        currentProgress_.state = "loading";
        currentProgress_.progress = 0.01f;
        currentProgress_.phase = "starting";
        currentProgress_.message = "Starting the " + modelLabel + " runtime session...";
        currentProgress_.modelId = modelId;
        currentProgress_.workflowId = workflowId;
        currentProgress_.sourceClipId.clear();
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
        currentProgress_.generationDetails = juce::var();
        currentProgress_.attemptMode = isStableAudio ? juce::String() : juce::String("lm_dit");
        currentProgress_.attemptIndex = 1;
        currentProgress_.protocolVersion = kWorkerProtocolVersion;
        currentProgress_.scriptVersion = expectedScriptVersion_;
        currentProgress_.requestId = currentRequestId_;
        currentProgress_.priorFailure.clear();
        currentProgress_.lastProgressAgeMs = 0.0;
        currentProgress_.runtimeProfile.clear();
        currentProgress_.lmModel.clear();
        currentProgress_.lmBackend.clear();
        currentProgress_.lmStage.clear();
    }

    generationThread_ = std::thread([this, python, script, modelId, workflowId, workerParameters, outputFile]()
    {
        if (recoveryJournalId_.isNotEmpty()) {
            auto fields = std::make_unique<juce::DynamicObject>();
            fields->setProperty("requestId", currentRequestId_);
            fields->setProperty("expectedOutputFile", outputFile.getFullPathName());
            if (!RecoveryJournal::updateOwnedAI(recoveryJournalId_, juce::var(fields.release()))) {
                const juce::ScopedLock sl(lock_);
                setProgressErrorLocked("journal_failed", "Could not persist the generation request", "storage");
                generationActive_ = false;
                return;
            }
        }
        launchGenerationTask(python, script, modelId, workflowId, workerParameters, outputFile);
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
                const auto modelLabel = audioModelLabel(currentProgress_.modelId);
                workerProtocolRejected_ = true;
                workerReady_ = false;
                workerPort_ = 0;
                setProgressErrorLocked("worker_protocol_failed",
                                       appendProcessDetailsLocked(modelLabel + " worker protocol or script version mismatch."),
                                       "worker_protocol");
                currentProgress_.statusNote = "Rejecting stale worker session before generation starts.";
                juce::Logger::writeToLog("AITrackEngine: rejecting worker ready handshake due to version mismatch"
                                         " workerProtocol=" + juce::String(workerProtocolVersion_)
                                         + " expectedProtocol=" + juce::String(kWorkerProtocolVersion)
                                         + " workerScriptVersion=" + workerScriptVersion_
                                         + " expectedScriptVersion=" + expectedScriptVersion_);
                return;
            }

            workerModelId_ = obj->getProperty("modelId").toString();
            if (workerModelId_.isEmpty()) workerModelId_ = kPinnedMusicGenerationModelId;
            workerReady_ = true;
            workerPort_ = static_cast<int> (double (obj->getProperty("port")));
            const auto backend = obj->getProperty("backend").toString();
            const auto readyLabel = audioModelLabel(workerModelId_);
            currentProgress_.state = "idle";
            currentProgress_.progress = 0.0f;
            currentProgress_.phase = "worker_ready";
            currentProgress_.message = readyLabel + " runtime session is ready.";
            currentProgress_.backend = backend;
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

    if (obj->getProperty("requestId").toString() != currentRequestId_ || currentRequestId_.isEmpty())
        return; // Never let stale/foreign progress change ownership or release this worker.
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
    if (currentStateIsTerminal)
    {
        juce::Logger::writeToLog("AITrackEngine: ignoring late non-terminal progress after terminal state"
                                 " currentState=" + currentProgress_.state
                                 + " incomingState=" + incomingState
                                 + " requestId=" + currentProgress_.requestId);
        return;
    }

    if (incomingState == "done")
    {
        const auto output = obj->getProperty("outputFile").toString();
        if (!juce::File::isAbsolutePath(output) || juce::File(output) != currentOutputFile_
            || !currentOutputFile_.existsAsFile())
        {
            setProgressErrorLocked("invalid_worker_output", "The generation worker returned an unexpected or missing output file.", "worker_protocol");
            generationActive_ = false;
            return;
        }
        // A crash between native completion and the next frontend poll must not
        // discard a finished artifact. This executes on the worker reader thread.
        if (recoveryJournalId_.isNotEmpty()) {
            auto fields = std::make_unique<juce::DynamicObject>();
            fields->setProperty("status", "completed");
            fields->setProperty("outputFile", output);
            fields->setProperty("outputBytes", currentOutputFile_.getSize());
            fields->setProperty("requestId", currentRequestId_);
            if (!RecoveryJournal::updateOwnedAI(recoveryJournalId_, juce::var(fields.release())))
                juce::Logger::writeToLog("AI generation completed, but its recovery journal update failed");
        }
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
    if (obj->hasProperty("modelId"))
        currentProgress_.modelId = obj->getProperty("modelId").toString();
    if (obj->hasProperty("workflowId"))
        currentProgress_.workflowId = obj->getProperty("workflowId").toString();
    if (obj->hasProperty("sourceClipId"))
        currentProgress_.sourceClipId = obj->getProperty("sourceClipId").toString();
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
    if (obj->getProperty("generationDetails").isObject())
        currentProgress_.generationDetails = obj->getProperty("generationDetails");
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

        // A partial WAV may exist after a crash. Only a matching terminal
        // protocol message proves completion; never infer it from existence.

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

                if (processOutputBuffer_.size() >= kMaxWorkerLineBytes)
                {
                    setProgressErrorLocked("worker_output_overflow", "The worker emitted an oversized diagnostic line.", "worker_protocol");
                    generationActive_ = false;
                    readerShouldExit_ = true;
                    break;
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
    workerPython_ = juce::File();
}

void AITrackEngine::stopWorker(bool clearProgress, bool userCancelled)
{
    // Cancellation never resets process ownership while launch/request work is
    // still using it. Handshake and socket loops observe this before joining.
    stopRequested_.store(true, std::memory_order_release);
    {
        const juce::ScopedLock sl(lock_);
        cancelRequested_ = true;
    }
    joinGenerationThread();
    stopWorkerSession(clearProgress, userCancelled, false);
}

AIGenerationProgress AITrackEngine::pollProgress()
{
    bool shouldStopForDecodeStall = false;
    bool shouldReleaseTerminalWorker = false;

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

        // Successful sessions retain weights for bounded warm reuse. Python
        // retires idle weights after two minutes or under host memory pressure.
        const auto inTerminalState = currentProgress_.state == "error"
            || currentProgress_.state == "cancelled";
        if (inTerminalState
            && ! generationActive_
            && workerProcess_ != nullptr
            && workerProcess_->isRunning())
        {
            shouldReleaseTerminalWorker = true;
        }
    }

    if (shouldStopForDecodeStall)
        stopWorker(false, false);
    else if (shouldReleaseTerminalWorker)
        stopWorker(false, false);

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

bool AITrackEngine::releaseIdleWorker()
{
    if (isRunning())
        return false;
    stopWorker(false, false);
    return true;
}
