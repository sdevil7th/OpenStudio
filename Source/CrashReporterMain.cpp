#include "CrashReporterProtocol.h"
#include <cwchar>

namespace
{
struct QuitWatchdog { CrashReporterProtocol::SharedState* state; HANDLE parent, stop; };
DWORD WINAPI boundFinalQuit(void* argument)
{
    auto& context = *static_cast<QuitWatchdog*>(argument);
    ULONGLONG elapsed = 0, previous = GetTickCount64();
    bool observed = false;
    while (WaitForSingleObject(context.stop, 100) == WAIT_TIMEOUT)
    {
        if (WaitForSingleObject(context.parent, 0) != WAIT_TIMEOUT) return 0;
        const auto now = GetTickCount64();
        const auto gap = now - previous;
        previous = now;
        if (!InterlockedCompareExchange(&context.state->finalQuitRequested, 0, 0)) continue;
        BOOL debugged = FALSE;
        if (!CheckRemoteDebuggerPresent(context.parent, &debugged) || debugged) { elapsed = 0; continue; }
        // A sleep/resume or suspended debugger is not elapsed active shutdown.
        if (observed && gap < 2500) elapsed += gap;
        observed = true;
        const auto deadline = InterlockedCompareExchange(&context.state->finalQuitDeadlineMs, 0, 0);
        if (deadline < 1000 || elapsed < static_cast<ULONGLONG>(deadline)) continue;
        // Never kill a running session for a UI hang. This flag is only armed
        // after application shutdown has been irrevocably requested.
        if (!TerminateProcess(context.parent, 0xE0535154)) return 1;
        // Dump writing may itself be stuck in a driver. It must not strand the
        // reporter indefinitely after the already-quitting host has exited.
        if (WaitForSingleObject(context.stop, 5000) == WAIT_TIMEOUT) ExitProcess(0);
        return 0;
    }
    return 0;
}
}

int wmain(int argc, wchar_t** argv)
{
    if (argc != 6) return 2;
    HANDLE handles[5] {};
    for (int index = 0; index < 5; ++index)
    {
        wchar_t* end = nullptr;
        const auto value = _wcstoui64(argv[index + 1], &end, 10);
        if (!value || !end || *end != 0) return 2;
        handles[index] = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(value));
    }
    auto* state = static_cast<CrashReporterProtocol::SharedState*>(MapViewOfFile(handles[0], FILE_MAP_ALL_ACCESS, 0, 0,
        sizeof(CrashReporterProtocol::SharedState)));
    if (!state || state->magicValue != CrashReporterProtocol::magic
        || state->protocolVersion != CrashReporterProtocol::version
        || GetProcessId(handles[4]) != state->processId) return 3;
    QuitWatchdog watchdog { state, handles[4], CreateEventW(nullptr, TRUE, FALSE, nullptr) };
    HANDLE watchdogThread = watchdog.stop ? CreateThread(nullptr, 0, boundFinalQuit, &watchdog, 0, nullptr) : nullptr;
    if (!watchdogThread) return 6;
    SetEvent(handles[3]); // Parent installs the external path only after readiness.
    const HANDLE waitHandles[] = { handles[1], handles[4] };
    int result = 0;
    auto lastWakeTicks = GetTickCount64();
    for (;;)
    {
        const DWORD wake = WaitForMultipleObjects(2, waitHandles, FALSE, 1000);
        if (wake == WAIT_OBJECT_0)
        {
            result = CrashReporterProtocol::writeReport(*state, handles[4]) ? 0 : 4;
            SetEvent(handles[2]);
            break;
        }
        if (wake == WAIT_OBJECT_0 + 1) break;
        if (wake != WAIT_TIMEOUT) { result = 5; break; }
        const auto nowTicks = GetTickCount64();
        const auto wakeGap = nowTicks - lastWakeTicks;
        lastWakeTicks = nowTicks;
        // Sleep/resume or an unscheduled reporter is not evidence of a UI hang.
        // Give the app a fresh poll interval to publish its resumed heartbeat.
        if (wakeGap > 2500) continue;
        if (InterlockedCompareExchange(&state->watchdogArmed, 0, 0) == 0
            || InterlockedCompareExchange(&state->hangReportState, 0, 0) != 0) continue;
        BOOL debugged = FALSE;
        if (!CheckRemoteDebuggerPresent(handles[4], &debugged) || debugged) continue;
        const auto heartbeat = static_cast<ULONGLONG>(InterlockedCompareExchange64(&state->heartbeatTicks, 0, 0));
        const auto timeout = InterlockedCompareExchange(&state->hangTimeoutMs, 0, 0);
        if (heartbeat == 0 || timeout <= 0 || GetTickCount64() - heartbeat < static_cast<ULONGLONG>(timeout)) continue;
        if (InterlockedCompareExchange(&state->hangReportState, 1, 0) != 0) continue;
        const bool captured = CrashReporterProtocol::writeReport(*state, handles[4], true);
        InterlockedExchange(&state->hangReportState, captured ? 2 : 3);
    }
    SetEvent(watchdog.stop);
    WaitForSingleObject(watchdogThread, INFINITE);
    CloseHandle(watchdogThread);
    CloseHandle(watchdog.stop);
    UnmapViewOfFile(state);
    for (const auto handle : handles) CloseHandle(handle);
    return result; // No normal disk logging; one best-effort hang capture per launch.
}
