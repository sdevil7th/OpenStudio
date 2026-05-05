#include "CrashDiagnostics.h"

#include <mutex>

#if JUCE_WINDOWS
 #include <windows.h>
 #include <dbghelp.h>
#endif

namespace
{
std::once_flag installOnce;

juce::File getDiagnosticsDirectory()
{
    auto dir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
        .getChildFile("OpenStudio");
    dir.createDirectory();
    return dir;
}

void rotateIfLarge(const juce::File& file)
{
    constexpr juce::int64 maxBytes = 512 * 1024;
    if (!file.existsAsFile() || file.getSize() <= maxBytes)
        return;

    const auto archived = file.getSiblingFile(file.getFileNameWithoutExtension() + ".1." + file.getFileExtension());
    archived.deleteFile();
    file.moveFileTo(archived);
}

#if JUCE_WINDOWS
LONG WINAPI openStudioUnhandledExceptionFilter(EXCEPTION_POINTERS* exceptionInfo)
{
    const auto dumpFile = OpenStudioCrashDiagnostics::getLastCrashDumpFile();
    HANDLE dumpHandle = CreateFileW(dumpFile.getFullPathName().toWideCharPointer(),
                                    GENERIC_WRITE,
                                    0,
                                    nullptr,
                                    CREATE_ALWAYS,
                                    FILE_ATTRIBUTE_NORMAL,
                                    nullptr);

    if (dumpHandle != INVALID_HANDLE_VALUE)
    {
        MINIDUMP_EXCEPTION_INFORMATION dumpExceptionInfo {};
        dumpExceptionInfo.ThreadId = GetCurrentThreadId();
        dumpExceptionInfo.ExceptionPointers = exceptionInfo;
        dumpExceptionInfo.ClientPointers = FALSE;

        MiniDumpWriteDump(GetCurrentProcess(),
                          GetCurrentProcessId(),
                          dumpHandle,
                          MiniDumpNormal,
                          exceptionInfo != nullptr ? &dumpExceptionInfo : nullptr,
                          nullptr,
                          nullptr);
        CloseHandle(dumpHandle);
    }

    juce::String detail = "dump=" + dumpFile.getFullPathName();
    if (exceptionInfo != nullptr && exceptionInfo->ExceptionRecord != nullptr)
    {
        detail += " code=0x" + juce::String::toHexString(
            static_cast<juce::int64>(exceptionInfo->ExceptionRecord->ExceptionCode));
    }
    OpenStudioCrashDiagnostics::recordBreadcrumb("unhandled_exception", detail);
    return EXCEPTION_CONTINUE_SEARCH;
}
#endif
}

namespace OpenStudioCrashDiagnostics
{
juce::File getBreadcrumbLogFile()
{
    return getDiagnosticsDirectory().getChildFile("crash_breadcrumbs.log");
}

juce::File getLastCrashDumpFile()
{
    return getDiagnosticsDirectory().getChildFile("last_crash.dmp");
}

void recordBreadcrumb(const juce::String& stage, const juce::String& detail)
{
    const auto logFile = getBreadcrumbLogFile();
    rotateIfLarge(logFile);

    juce::String line = juce::Time::getCurrentTime().toString(true, true)
        + " | " + stage;
    if (detail.isNotEmpty())
        line += " | " + detail;

    logFile.appendText(line + "\n");
}

void installCrashHandlers()
{
    std::call_once(installOnce, []
    {
#if JUCE_WINDOWS
        SetUnhandledExceptionFilter(openStudioUnhandledExceptionFilter);
#endif
        recordBreadcrumb("crash_handlers_installed");
    });
}
}
