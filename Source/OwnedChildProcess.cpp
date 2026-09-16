#include "OwnedChildProcess.h"
#if JUCE_WINDOWS
#include <windows.h>

namespace
{
void closeOwnedHandle(HANDLE& handle)
{
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    handle = nullptr;
}

juce::String quoteArgument(const juce::String& argument)
{
    juce::String result("\"");
    int backslashes = 0;
    for (const auto character : argument)
    {
        if (character == '\\') { ++backslashes; continue; }
        result += juce::String::repeatedString("\\", character == '"' ? backslashes * 2 + 1 : backslashes);
        result += juce::String::charToString(character);
        backslashes = 0;
    }
    return result + juce::String::repeatedString("\\", backslashes * 2) + "\"";
}
}

struct OwnedChildProcess::Impl
{
    HANDLE job = nullptr, process = nullptr, outputRead = nullptr;
    DWORD pid = 0;
    ~Impl()
    {
        if (job != nullptr) TerminateJobObject(job, 1);
        closeOwnedHandle(job);
        closeOwnedHandle(process);
        closeOwnedHandle(outputRead);
    }
};

bool OwnedChildProcess::start(const juce::StringArray& arguments, int streamFlags,
                              const juce::StringPairArray& environmentOverrides)
{
    if (arguments.isEmpty() || isRunning()) return false;
    impl.reset(); // A stopped owned job can be explicitly restarted; never replace a live child.
    auto next = std::make_unique<Impl>();
    next->job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (next->job == nullptr || !SetInformationJobObject(next->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return false;
    SECURITY_ATTRIBUTES security { sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    HANDLE outputWrite = nullptr;
    if (streamFlags == 0)
        outputWrite = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    else if (!CreatePipe(&next->outputRead, &outputWrite, &security, 0)) return false;
    HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (input == INVALID_HANDLE_VALUE || outputWrite == INVALID_HANDLE_VALUE
        || (next->outputRead && !SetHandleInformation(next->outputRead, HANDLE_FLAG_INHERIT, 0)))
    { closeOwnedHandle(outputWrite); closeOwnedHandle(input); return false; }
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    juce::HeapBlock<char> attributes(attributeBytes);
    auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.getData());
    const bool initialized = InitializeProcThreadAttributeList(list, 1, 0, &attributeBytes) != FALSE;
    HANDLE inherited[] { outputWrite, input };
    const bool updated = initialized && UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof(inherited), nullptr, nullptr) != FALSE;
    STARTUPINFOEXW startup {};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input;
    startup.StartupInfo.hStdOutput = outputWrite;
    startup.StartupInfo.hStdError = outputWrite;
    startup.lpAttributeList = list;
    juce::String command;
    for (const auto& argument : arguments) command += quoteArgument(argument) + " ";
    std::wstring mutableCommand(command.toWideCharPointer());
    juce::StringPairArray environment(true);
    auto* inheritedEnvironment = GetEnvironmentStringsW();
    if (inheritedEnvironment != nullptr)
    {
        for (const wchar_t* entry = inheritedEnvironment; *entry != 0; entry += std::wcslen(entry) + 1)
        {
            const juce::String value(entry);
            const int separator = value.indexOf(1, "="); // Preserve Windows '=C:' drive entries.
            if (separator > 0) environment.set(value.substring(0, separator), value.substring(separator + 1));
        }
        FreeEnvironmentStringsW(inheritedEnvironment);
    }
    environment.addArray(environmentOverrides);
    auto keys = environment.getAllKeys();
    keys.sort(true);
    std::wstring environmentBlock;
    for (const auto& key : keys)
    {
        environmentBlock += (key + "=" + environment[key]).toWideCharPointer();
        environmentBlock += L'\0';
    }
    environmentBlock += L'\0';
    PROCESS_INFORMATION information {};
    const bool created = updated && CreateProcessW(arguments[0].toWideCharPointer(), mutableCommand.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environmentOverrides.size() == 0 ? nullptr : environmentBlock.data(), nullptr, &startup.StartupInfo, &information) != FALSE;
    if (initialized) DeleteProcThreadAttributeList(list);
    closeOwnedHandle(outputWrite); closeOwnedHandle(input);
    if (!created) return false;
    next->process = information.hProcess;
    next->pid = information.dwProcessId;
    const bool assigned = AssignProcessToJobObject(next->job, next->process) != FALSE;
    const bool resumed = assigned && ResumeThread(information.hThread) != static_cast<DWORD>(-1);
    CloseHandle(information.hThread);
    if (!resumed) { TerminateProcess(next->process, 1); return false; }
    impl = std::move(next);
    return true;
}
bool OwnedChildProcess::isRunning() const { return impl && WaitForSingleObject(impl->process, 0) == WAIT_TIMEOUT; }
bool OwnedChildProcess::kill() { return !impl || TerminateJobObject(impl->job, 1) != FALSE; }
unsigned long OwnedChildProcess::getProcessId() const { return impl ? impl->pid : 0; }
juce::uint32 OwnedChildProcess::getExitCode() const
{
    DWORD code = 0;
    if (impl) GetExitCodeProcess(impl->process, &code);
    return code;
}
int OwnedChildProcess::readProcessOutput(void* destination, int capacity)
{
    if (!impl || !impl->outputRead || capacity <= 0 || destination == nullptr) return 0;
    DWORD available = 0, bytesRead = 0;
    if (!PeekNamedPipe(impl->outputRead, nullptr, 0, nullptr, &available, nullptr) || available == 0) return 0;
    const auto requested = juce::jmin(available, static_cast<DWORD>(capacity));
    return ReadFile(impl->outputRead, destination, requested, &bytesRead, nullptr) ? static_cast<int>(bytesRead) : 0;
}
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#include <mutex>
#include <vector>
#if JUCE_MAC
#include <crt_externs.h>
#else
extern char** environ;
#endif

namespace
{
void closeOwnedFd(int& descriptor)
{
    if (descriptor >= 0) ::close(descriptor);
    descriptor = -1;
}
struct SpawnResources
{
    int pipeEnds[2] { -1, -1 };
    int nullDevice = -1;
    posix_spawn_file_actions_t actions {};
    posix_spawnattr_t attributes {};
    bool actionsReady = false, attributesReady = false;
    ~SpawnResources()
    {
        if (actionsReady) posix_spawn_file_actions_destroy(&actions);
        if (attributesReady) posix_spawnattr_destroy(&attributes);
        closeOwnedFd(pipeEnds[0]); closeOwnedFd(pipeEnds[1]); closeOwnedFd(nullDevice);
    }
};
}
struct OwnedChildProcess::Impl
{
    pid_t pid = -1;
    int outputRead = -1;
    mutable std::mutex statusMutex;
    mutable bool exited = false;
    mutable bool ownsPid = true;
    mutable juce::uint32 exitCode = 0;
    bool running() const
    {
        const std::lock_guard<std::mutex> lock(statusMutex);
        if (pid <= 0 || exited) return false;
        siginfo_t information {};
        int result;
        // Keep the leader waitable until teardown so its PID/process-group ID
        // cannot be recycled underneath a later owned-tree termination.
        do { result = ::waitid(P_PID, static_cast<id_t>(pid), &information, WEXITED | WNOHANG | WNOWAIT); }
        while (result < 0 && errno == EINTR);
        if (result == 0 && information.si_pid == pid)
        {
            exited = true;
            exitCode = static_cast<juce::uint32>(information.si_code == CLD_EXITED
                ? information.si_status : 128 + information.si_status);
        }
        else if (result < 0 && errno == ECHILD) { exited = true; ownsPid = false; }
        return !exited;
    }
    bool terminate()
    {
        const std::lock_guard<std::mutex> lock(statusMutex);
        // Every child starts in a new process group. Also terminate descendants
        // after the group leader exits, matching Windows owned-job semantics.
        return pid <= 0 || !ownsPid || ::kill(-pid, SIGKILL) == 0 || errno == ESRCH;
    }
    ~Impl()
    {
        terminate();
        closeOwnedFd(outputRead);
        int status = 0;
        if (pid > 0 && ownsPid)
            while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    }
};
bool OwnedChildProcess::start(const juce::StringArray& arguments, int streamFlags,
                              const juce::StringPairArray& environmentOverrides)
{
    if (arguments.isEmpty() || isRunning()) return false;
    impl.reset();
    SpawnResources resources;
    resources.nullDevice = ::open("/dev/null", O_RDWR | O_CLOEXEC);
    if (resources.nullDevice < 0 || (streamFlags != 0 && ::pipe(resources.pipeEnds) != 0)) return false;
    // GUI launches may have closed standard descriptors. Keep sources above
    // stderr so successive dup2 actions cannot overwrite another source.
    for (auto* descriptor : { &resources.nullDevice, &resources.pipeEnds[0], &resources.pipeEnds[1] })
        if (*descriptor >= 0 && *descriptor <= STDERR_FILENO)
        {
            const auto duplicate = ::fcntl(*descriptor, F_DUPFD_CLOEXEC, STDERR_FILENO + 1);
            if (duplicate < 0) return false;
            closeOwnedFd(*descriptor);
            *descriptor = duplicate;
        }
    // Keep our pipe ends out of unrelated children and make reads nonblocking.
    for (const auto descriptor : resources.pipeEnds)
        if (descriptor >= 0 && ::fcntl(descriptor, F_SETFD, FD_CLOEXEC) < 0) return false;
    if (resources.pipeEnds[0] >= 0 && ::fcntl(resources.pipeEnds[0], F_SETFL, O_NONBLOCK) < 0) return false;
    resources.actionsReady = posix_spawn_file_actions_init(&resources.actions) == 0;
    resources.attributesReady = posix_spawnattr_init(&resources.attributes) == 0;
    if (!resources.actionsReady || !resources.attributesReady
        || posix_spawnattr_setflags(&resources.attributes, POSIX_SPAWN_SETPGROUP) != 0
        || posix_spawnattr_setpgroup(&resources.attributes, 0) != 0) return false;
    for (const int target : { STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO })
    {
        const bool capture = target == STDOUT_FILENO ? (streamFlags & 1) != 0
                           : target == STDERR_FILENO && (streamFlags & 2) != 0;
        const int source = capture ? resources.pipeEnds[1] : resources.nullDevice;
        if (posix_spawn_file_actions_adddup2(&resources.actions, source, target) != 0) return false;
    }
    std::vector<std::string> storage;
    for (const auto& argument : arguments) storage.push_back(argument.toStdString());
    std::vector<char*> argv;
    for (auto& argument : storage) argv.push_back(argument.data());
    argv.push_back(nullptr);
    auto next = std::make_unique<Impl>();
   #if JUCE_MAC
    auto* environment = *_NSGetEnviron();
   #else
    auto* environment = environ;
   #endif
    juce::StringPairArray childEnvironment(false);
    for (auto** entry = environment; *entry != nullptr; ++entry)
    {
        const juce::String value(*entry);
        const int separator = value.indexOfChar('=');
        if (separator > 0) childEnvironment.set(value.substring(0, separator), value.substring(separator + 1));
    }
    childEnvironment.addArray(environmentOverrides);
    std::vector<std::string> environmentStorage;
    for (const auto& key : childEnvironment.getAllKeys())
        environmentStorage.push_back((key + "=" + childEnvironment[key]).toStdString());
    std::vector<char*> environmentPointers;
    for (auto& entry : environmentStorage) environmentPointers.push_back(entry.data());
    environmentPointers.push_back(nullptr);
    if (environmentOverrides.size() != 0) environment = environmentPointers.data();
    if (posix_spawnp(&next->pid, argv[0], &resources.actions, &resources.attributes, argv.data(), environment) != 0)
    { next->pid = -1; return false; }
    next->outputRead = resources.pipeEnds[0];
    resources.pipeEnds[0] = -1;
    impl = std::move(next);
    return true;
}
bool OwnedChildProcess::isRunning() const { return impl && impl->running(); }
bool OwnedChildProcess::kill() { return !impl || impl->terminate(); }
unsigned long OwnedChildProcess::getProcessId() const { return impl ? static_cast<unsigned long>(impl->pid) : 0; }
juce::uint32 OwnedChildProcess::getExitCode() const
{
    if (!impl || impl->running()) return 0;
    const std::lock_guard<std::mutex> lock(impl->statusMutex);
    return impl->exitCode;
}
int OwnedChildProcess::readProcessOutput(void* destination, int capacity)
{
    if (!impl || impl->outputRead < 0 || destination == nullptr || capacity <= 0) return 0;
    const auto count = ::read(impl->outputRead, destination, static_cast<size_t>(capacity));
    // EAGAIN/EINTR return to the caller so output cannot starve cancellation.
    return count > 0 ? static_cast<int>(count) : 0;
}
#endif
OwnedChildProcess::OwnedChildProcess() = default;
OwnedChildProcess::~OwnedChildProcess() { kill(); }

bool OwnedChildProcess::waitForProcessToFinish(int timeoutMs, const std::atomic<bool>& keepRunning)
{
    const auto started = juce::Time::getMillisecondCounterHiRes();
    while (keepRunning.load(std::memory_order_acquire) && isRunning()
        && juce::Time::getMillisecondCounterHiRes() - started < timeoutMs)
    {
        // Bound each drain so even a noisy child cannot starve cancellation.
        char discarded[4096];
        for (int block = 0; block < 4; ++block)
            if (readProcessOutput(discarded, sizeof(discarded)) == 0) break;
        juce::Thread::sleep(10);
    }
    if (!keepRunning.load(std::memory_order_acquire) || isRunning())
    {
        kill();
        return false;
    }
    return true;
}
