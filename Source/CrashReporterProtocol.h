#pragma once
#if defined(_WIN32)
#include <windows.h>
#include <cstdint>

namespace CrashReporterProtocol
{
constexpr DWORD magic = 0x4f534352;
constexpr DWORD version = 3;
constexpr int entryCount = 64;
struct Entry
{
    volatile LONG64 sequence;
    char text[1024];
};
struct SharedState
{
    DWORD magicValue, protocolVersion, processId, threadId;
    std::uintptr_t exceptionPointers;
    wchar_t dumpPath[32768], previousDumpPath[32768], pendingDumpPath[32768], logPath[32768];
    char build[256];
    volatile LONG64 nextSequence;
    volatile LONG64 heartbeatTicks;
    volatile LONG watchdogArmed, hangReportState, hangTimeoutMs;
    volatile LONG finalQuitRequested, finalQuitDeadlineMs;
    Entry entries[entryCount];
};
// Called only by the reporter thread/process after a fault, never by audio.
bool writeReport(SharedState& state, HANDLE process, bool hang = false);
}
#endif
