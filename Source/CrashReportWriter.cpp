#include "CrashReporterProtocol.h"
#if defined(_WIN32)
#include <dbghelp.h>
#include <cstdio>
#include <cstring>
#include <string>

namespace CrashReporterProtocol
{
bool writeReport(SharedState& state, HANDLE process, bool hang)
{
    // Only a live-process hang report needs path allocation. The exception /
    // dedicated-thread fallback keeps its preallocated paths and original dump.
    std::wstring hangDump, hangPrevious, hangPending, hangLog;
    if (hang)
    {
        const std::wstring original(state.dumpPath);
        const auto directory = original.substr(0, original.find_last_of(L"/\\") + 1);
        hangDump = directory + L"last_hang.dmp";
        hangPrevious = directory + L"last_hang.previous.dmp";
        hangPending = directory + L"last_hang.pending.dmp";
        hangLog = directory + L"hang_breadcrumbs.log";
    }
    const auto* dumpPath = hang ? hangDump.c_str() : state.dumpPath;
    const auto* previousPath = hang ? hangPrevious.c_str() : state.previousDumpPath;
    const auto* pendingPath = hang ? hangPending.c_str() : state.pendingDumpPath;
    const auto* logPath = hang ? hangLog.c_str() : state.logPath;
    // Stage first: a full disk or denied write must not destroy the last dump.
    DWORD error = ERROR_SUCCESS;
    bool succeeded = false;
    HANDLE dump = CreateFileW(pendingPath, GENERIC_WRITE, 0, nullptr,
        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (dump != INVALID_HANDLE_VALUE)
    {
        MINIDUMP_EXCEPTION_INFORMATION exception {};
        exception.ThreadId = state.threadId;
        exception.ExceptionPointers = reinterpret_cast<EXCEPTION_POINTERS*>(state.exceptionPointers);
        exception.ClientPointers = TRUE; // Pointers are in the target process.
        succeeded = MiniDumpWriteDump(process, state.processId, dump,
            static_cast<MINIDUMP_TYPE>(MiniDumpNormal | MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules),
            !hang && state.exceptionPointers ? &exception : nullptr, nullptr, nullptr) != FALSE;
        if (!succeeded) error = GetLastError();
        if (succeeded && !FlushFileBuffers(dump)) { succeeded = false; error = GetLastError(); }
        CloseHandle(dump);
        if (succeeded)
        {
            if (GetFileAttributesW(dumpPath) != INVALID_FILE_ATTRIBUTES)
                succeeded = ReplaceFileW(dumpPath, pendingPath, previousPath,
                    0, nullptr, nullptr) != FALSE;
            else
                succeeded = MoveFileExW(pendingPath, dumpPath, MOVEFILE_WRITE_THROUGH) != FALSE;
            if (!succeeded) error = GetLastError();
        }
    }
    else error = GetLastError();

    HANDLE log = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ, nullptr,
        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (log != INVALID_HANDLE_VALUE)
    {
        DWORD written = 0;
        char heading[640] {};
        const int length = _snprintf_s(heading, sizeof(heading), _TRUNCATE,
            "%s; dumpSucceeded=%s error=0x%08lX process=%lu thread=%lu reporterProcess=%lu mode=%s\r\nBuild: %s\r\n%s\r\n",
            hang ? "Unresponsive UI/shutdown (diagnostic, not a crash)" : "Unhandled exception",
            succeeded ? "true" : "false", error, state.processId, hang ? 0 : state.threadId, GetCurrentProcessId(),
            GetCurrentProcessId() == state.processId ? "in-process-fallback" : "external", state.build,
            succeeded ? (hang ? (InterlockedCompareExchange(&state.finalQuitRequested, 0, 0)
                                ? "Inspect last_hang.dmp with this build's matching PDB. Final Quit is committed; its deadline may force process exit."
                                : "Inspect last_hang.dmp with this build's matching PDB. The host was not terminated.")
                             : "Inspect last_crash.dmp with this build's matching PDB.")
                : "Dump write/publication failed. Retained previous/pending dumps may be recoverable.");
        if (length > 0) WriteFile(log, heading, static_cast<DWORD>(length), &written, nullptr);
        const LONG64 end = InterlockedCompareExchange64(&state.nextSequence, 0, 0);
        const LONG64 begin = end > entryCount ? end - entryCount : 0;
        for (LONG64 sequence = begin; sequence < end; ++sequence)
        {
            auto& entry = state.entries[sequence % entryCount];
            if (InterlockedCompareExchange64(&entry.sequence, 0, 0) != sequence + 1) continue;
            char line[sizeof(entry.text)] {};
            memcpy(line, entry.text, sizeof(line));
            MemoryBarrier();
            if (InterlockedCompareExchange64(&entry.sequence, 0, 0) != sequence + 1) continue;
            line[sizeof(line) - 1] = 0;
            WriteFile(log, line, static_cast<DWORD>(strlen(line)), &written, nullptr);
        }
        FlushFileBuffers(log);
        CloseHandle(log);
    }
    return succeeded;
}
}
#endif
