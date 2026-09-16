#include "AppPaths.h"
#include "CrashDiagnostics.h"

#include <array>
#include <atomic>
#include <mutex>

#if JUCE_WINDOWS
 #include <windows.h>
 #include "CrashReporterProtocol.h"
 #include <vector>
 #include <string>
#endif

namespace
{
std::once_flag installOnce;
std::mutex breadcrumbMutex;
struct Breadcrumb { std::array<char, 1024> text {}; size_t bytes = 0; };
std::array<Breadcrumb, 64> breadcrumbs;
size_t nextBreadcrumb = 0;
std::array<std::atomic<uint32_t>, static_cast<size_t>(OpenStudioCrashDiagnostics::RealtimeFault::count)> realtimeFaults {};
double lastFaultFlushMs = -10000.0;
juce::File selfTestDirectory;
bool selfTestReporterUnavailable = false;

juce::File getDiagnosticsDirectory()
{
    if (selfTestDirectory != juce::File()) return selfTestDirectory;
    return AppPaths::diagnostics();
}

void flushBreadcrumbs()
{
    const auto file = OpenStudioCrashDiagnostics::getBreadcrumbLogFile();
    file.getParentDirectory().createDirectory();
    if (file.getSize() > 512 * 1024)
    {
        const auto archive = file.getSiblingFile("crash_breadcrumbs.previous.log");
        file.moveFileTo(archive);
    }
    std::lock_guard<std::mutex> lock(breadcrumbMutex);
    juce::String snapshot;
    const auto count = juce::jmin(nextBreadcrumb, breadcrumbs.size());
    for (size_t i = nextBreadcrumb - count; i < nextBreadcrumb; ++i)
    {
        const auto& entry = breadcrumbs[i % breadcrumbs.size()];
        snapshot += juce::String::fromUTF8(entry.text.data(), static_cast<int>(entry.bytes));
    }
    file.appendText(snapshot);
}

#if JUCE_WINDOWS
HANDLE crashRequested = nullptr, crashFinished = nullptr, fallbackRequested = nullptr;
HANDLE externalReporter = nullptr, reporterMapping = nullptr;
CrashReporterProtocol::SharedState fallbackReport {};
CrashReporterProtocol::SharedState* reportState = &fallbackReport;
volatile LONG crashStarted = 0;

bool launchExternalReporter()
{
    if (selfTestReporterUnavailable) return false;
    const auto helper = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getSiblingFile("OpenStudioCrashReporter.exe");
    if (!helper.existsAsFile() || reporterMapping == nullptr) return false;
    SECURITY_ATTRIBUTES security { sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    HANDLE ready = CreateEventW(&security, TRUE, FALSE, nullptr);
    HANDLE parent = nullptr;
    if (!ready || !DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &parent,
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE | PROCESS_TERMINATE, TRUE, 0))
    {
        if (ready) CloseHandle(ready);
        return false;
    }
    HANDLE inherited[] = { reporterMapping, crashRequested, crashFinished, ready, parent };
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    std::vector<unsigned char> attributeStorage(attributeBytes);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    bool launched = false;
    if (InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes))
    {
        if (UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                inherited, sizeof(inherited), nullptr, nullptr))
        {
            STARTUPINFOEXW startup {};
            startup.StartupInfo.cb = sizeof(startup);
            startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW;
            startup.StartupInfo.wShowWindow = SW_HIDE;
            startup.lpAttributeList = attributes;
            auto command = helper.getFullPathName().quoted();
            for (const auto handle : inherited)
                command += " " + juce::String(static_cast<juce::int64>(reinterpret_cast<std::uintptr_t>(handle)));
            std::wstring writableCommand(command.toWideCharPointer());
            PROCESS_INFORMATION process {};
            if (CreateProcessW(helper.getFullPathName().toWideCharPointer(), writableCommand.data(),
                    nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS,
                    nullptr, nullptr, &startup.StartupInfo, &process))
            {
                CloseHandle(process.hThread);
                const HANDLE readyOrExit[] = { ready, process.hProcess };
                launched = WaitForMultipleObjects(2, readyOrExit, FALSE, 2000) == WAIT_OBJECT_0;
                if (launched) externalReporter = process.hProcess;
                else
                {
                    // Only our failed-to-initialize helper, never the application.
                    TerminateProcess(process.hProcess, 2);
                    CloseHandle(process.hProcess);
                }
            }
        }
        DeleteProcThreadAttributeList(attributes);
    }
    CloseHandle(ready);
    CloseHandle(parent);
    return launched;
}

DWORD WINAPI writeCrashDump(void*)
{
    if (WaitForSingleObject(fallbackRequested, INFINITE) != WAIT_OBJECT_0) return 0;
    // Used only if the external helper is unavailable. Never run both writers.
    CrashReporterProtocol::writeReport(*reportState, GetCurrentProcess());
    SetEvent(crashFinished);
    return 0;
}

LONG WINAPI openStudioUnhandledExceptionFilter(EXCEPTION_POINTERS* exceptionInfo)
{
    if (InterlockedCompareExchange(&crashStarted, 1, 0) == 0 && crashRequested != nullptr)
    {
        reportState->exceptionPointers = reinterpret_cast<std::uintptr_t>(exceptionInfo);
        reportState->threadId = GetCurrentThreadId();
        const bool externalAlive = externalReporter != nullptr
            && WaitForSingleObject(externalReporter, 0) == WAIT_TIMEOUT;
        SetEvent(externalAlive ? crashRequested : fallbackRequested);
        WaitForSingleObject(crashFinished, 5000);
    }
    return EXCEPTION_CONTINUE_SEARCH; // Never resume a corrupted audio process.
}
#endif
}

namespace OpenStudioCrashDiagnostics
{
juce::File getBreadcrumbLogFile() { return getDiagnosticsDirectory().getChildFile("crash_breadcrumbs.log"); }
juce::File getLastCrashDumpFile() { return getDiagnosticsDirectory().getChildFile("last_crash.dmp"); }

void recordBreadcrumb(const juce::String& stage, const juce::String& detail)
{
    // Control-thread API only. Normal operations remain in bounded memory.
    const auto line = juce::Time::getCurrentTime().toISO8601(true) + " | " + stage
        + (detail.isEmpty() ? juce::String() : " | " + detail) + "\n";
    {
        std::lock_guard<std::mutex> lock(breadcrumbMutex);
        auto& entry = breadcrumbs[nextBreadcrumb++ % breadcrumbs.size()];
        line.copyToUTF8(entry.text.data(), entry.text.size());
        entry.bytes = std::char_traits<char>::length(entry.text.data());
#if JUCE_WINDOWS
        const LONG64 sequence = InterlockedCompareExchange64(&reportState->nextSequence, 0, 0);
        auto& sharedEntry = reportState->entries[sequence % CrashReporterProtocol::entryCount];
        InterlockedExchange64(&sharedEntry.sequence, -1);
        memcpy(sharedEntry.text, entry.text.data(), entry.text.size());
        InterlockedExchange64(&sharedEntry.sequence, sequence + 1);
        InterlockedExchange64(&reportState->nextSequence, sequence + 1);
#endif
    }
    if (stage.containsIgnoreCase("failed") || stage.containsIgnoreCase("fault"))
        flushBreadcrumbs();
}

void recordRealtimeFault(RealtimeFault fault) noexcept
{
    realtimeFaults[static_cast<size_t>(fault)].fetch_add(1, std::memory_order_relaxed);
}

void flushRealtimeFaults()
{
    const auto now = juce::Time::getMillisecondCounterHiRes();
    if (now - lastFaultFlushMs < 5000.0)
        return;
    constexpr std::array<const char*, realtimeFaults.size()> names {
        "recordingLockMisses", "recordingOverflows", "namSafetyTrips",
        "trackBufferContract", "pluginBufferContract", "recordingBufferContract",
        "processorExceptions", "processorNonFinite", "isolatedProcessorFaults"
    };
    juce::String detail;
    for (size_t index = 0; index < realtimeFaults.size(); ++index)
    {
        const auto count = realtimeFaults[index].exchange(0, std::memory_order_relaxed);
        if (count != 0)
            detail += juce::String(names[index]) + "=" + juce::String(count) + " ";
    }
    if (detail.isEmpty())
        return;
    lastFaultFlushMs = now;
    recordBreadcrumb("realtime_fault", detail);
}

void installCrashHandlers()
{
    std::call_once(installOnce, []
    {
        getDiagnosticsDirectory().createDirectory();
#if JUCE_WINDOWS
        SECURITY_ATTRIBUTES security { sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
        reporterMapping = CreateFileMappingW(INVALID_HANDLE_VALUE, &security, PAGE_READWRITE,
            0, sizeof(CrashReporterProtocol::SharedState), nullptr);
        if (reporterMapping)
        {
            auto* mapped = static_cast<CrashReporterProtocol::SharedState*>(MapViewOfFile(reporterMapping,
                FILE_MAP_ALL_ACCESS, 0, 0, sizeof(CrashReporterProtocol::SharedState)));
            if (mapped) reportState = mapped;
            else { CloseHandle(reporterMapping); reporterMapping = nullptr; }
        }
        reportState->magicValue = CrashReporterProtocol::magic;
        reportState->protocolVersion = CrashReporterProtocol::version;
        reportState->processId = GetCurrentProcessId();
        reportState->hangTimeoutMs = 30000;
        reportState->finalQuitDeadlineMs = 60000;
        const auto file = getLastCrashDumpFile();
        wcscpy_s(reportState->dumpPath, file.getFullPathName().toWideCharPointer());
        wcscpy_s(reportState->previousDumpPath, file.getSiblingFile("last_crash.previous.dmp").getFullPathName().toWideCharPointer());
        wcscpy_s(reportState->pendingDumpPath, file.getSiblingFile("last_crash.pending.dmp").getFullPathName().toWideCharPointer());
        wcscpy_s(reportState->logPath, getBreadcrumbLogFile().getFullPathName().toWideCharPointer());
        const auto build = juce::String(ProjectInfo::versionString) + " " + OPENSTUDIO_BUILD_CONFIGURATION
            + " " + __DATE__ + " " + __TIME__;
        build.copyToUTF8(reportState->build, sizeof(reportState->build));
        crashRequested = CreateEventW(&security, TRUE, FALSE, nullptr);
        crashFinished = CreateEventW(&security, TRUE, FALSE, nullptr);
        fallbackRequested = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (crashRequested && crashFinished && fallbackRequested)
        {
            HANDLE thread = CreateThread(nullptr, 0, writeCrashDump, nullptr, 0, nullptr);
            if (thread != nullptr)
            {
                CloseHandle(thread); // Pre-created fallback, independent of the crashing stack.
                const bool external = launchExternalReporter();
                recordBreadcrumb("crash_reporter_ready", external ? "external process" : "dedicated-thread fallback");
                SetUnhandledExceptionFilter(openStudioUnhandledExceptionFilter);
            }
            else recordBreadcrumb("crash_reporter_failed", "Cannot create fallback reporter thread.");
        }
#endif
        recordBreadcrumb("crash_handlers_installed");
    });
}

void pulseMessageThread() noexcept
{
#if JUCE_WINDOWS
    InterlockedExchange64(&reportState->heartbeatTicks, static_cast<LONG64>(GetTickCount64()));
    InterlockedExchange(&reportState->watchdogArmed, 1);
#endif
}

void beginFinalShutdown()
{
    recordBreadcrumb("final_shutdown_committed", "Drain owned workers; preserve recovery evidence if a native call cannot return.");
#if JUCE_WINDOWS
    // Refresh heartbeat so a slow but healthy operation before Quit does not
    // consume shutdown's diagnostic grace period.
    pulseMessageThread();
    InterlockedExchange(&reportState->finalQuitRequested, 1);
    if (externalReporter == nullptr || WaitForSingleObject(externalReporter, 0) != WAIT_TIMEOUT)
        recordBreadcrumb("shutdown_watchdog_failed", "External reporter unavailable; safe joins may still wait indefinitely.");
#endif
}

int runSelfTest(const juce::File& isolatedDirectory, bool simulateCrash, bool simulateDumpFailure, bool simulateReporterUnavailable, bool simulateHang, bool simulateShutdownHang)
{
    selfTestDirectory = isolatedDirectory;
    selfTestReporterUnavailable = simulateReporterUnavailable;
    if (! selfTestDirectory.createDirectory() || getBreadcrumbLogFile().existsAsFile()) return 2;
    installCrashHandlers();
    for (int index = 0; index < 128; ++index)
        recordBreadcrumb("fixture_operation", "sequence=" + juce::String(index) + ";");
    if (getBreadcrumbLogFile().existsAsFile()) return 3;
    recordRealtimeFault(RealtimeFault::recordingOverflow);
    if (getBreadcrumbLogFile().existsAsFile()) return 4;
    flushRealtimeFaults();
    const auto evidence = getBreadcrumbLogFile().loadFileAsString();
    if (evidence.contains("sequence=0;") || ! evidence.contains("sequence=127;")
        || ! evidence.contains("recordingOverflows=1")) return 5;
   #if JUCE_WINDOWS
    if (simulateShutdownHang)
    {
        reportState->hangTimeoutMs = 500;
        reportState->finalQuitDeadlineMs = 4000;
        if (simulateDumpFailure && !selfTestDirectory.getChildFile("last_hang.pending.dmp").createDirectory()) return 9;
        beginFinalShutdown();
        recordBreadcrumb("shutdown_wait", "injected_final_quit_uncooperative_worker");
        juce::Thread::sleep(15000);
        return 10; // Only the reporter may terminate this deliberately hung child.
    }
    if (simulateHang)
    {
        recordBreadcrumb("shutdown_wait", "injected_uncooperative_worker");
        reportState->hangTimeoutMs = 500;
        pulseMessageThread();
        const auto deadline = GetTickCount64() + 10000;
        while (InterlockedCompareExchange(&reportState->hangReportState, 0, 0) < 2 && GetTickCount64() < deadline)
            juce::Thread::sleep(20);
        if (InterlockedCompareExchange(&reportState->hangReportState, 0, 0) != 2
            || !isolatedDirectory.getChildFile("last_hang.dmp").existsAsFile()) return 8;
    }
    if (simulateCrash)
    {
        if (simulateDumpFailure)
        {
            if (!getLastCrashDumpFile().replaceWithText("previous dump preserved")
                || !selfTestDirectory.getChildFile("last_crash.pending.dmp").createDirectory()) return 7;
        }
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
        RaiseException(0xE0425354, EXCEPTION_NONCONTINUABLE, 0, nullptr);
        return 6; // This line must never be reached.
    }
   #else
    juce::ignoreUnused(simulateCrash, simulateDumpFailure, simulateHang, simulateShutdownHang);
   #endif
    return 0;
}
}
