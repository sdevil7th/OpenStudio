//------------------------------------------------------------------------------
//! \file       ARADebug.c
//!             debug helpers for the ARA SDK Library
//! \project    ARA SDK Library
//! \copyright  Copyright (c) 2012-2022, Celemony Software GmbH, All Rights Reserved.
//! \license    Licensed under the Apache License, Version 2.0 (the "License");
//!             you may not use this file except in compliance with the License.
//!             You may obtain a copy of the License at
//!
//!               http://www.apache.org/licenses/LICENSE-2.0
//!
//!             Unless required by applicable law or agreed to in writing, software
//!             distributed under the License is distributed on an "AS IS" BASIS,
//!             WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//!             See the License for the specific language governing permissions and
//!             limitations under the License.
//------------------------------------------------------------------------------

#include "ARADebug.h"

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>

#if defined(_WIN32)
    #define WIN32_LEAN_AND_MEAN
    #include <Windows.h>

    // Windows string printing functions defined for compatibility
    #define snprintf(ptr, size, ...)  do { sprintf_s(ptr, (size) - 1, __VA_ARGS__); ptr[(size) - 1] = 0; } while (0)
    #define vsnprintf(ptr, size, ...)  do { vsprintf_s(ptr, (size) - 1, __VA_ARGS__); ptr[(size) - 1] = 0; } while (0)
#elif defined(__APPLE__)
    #include <sys/sysctl.h>
    #include <unistd.h>
#elif defined(__linux__)
    #include <sys/stat.h>
    #include <unistd.h>
    #include <fcntl.h>
    #include <ctype.h>
#endif


#if defined(__cplusplus)
namespace ARA
{
extern "C"
{
#endif

// prevent warnings about using NULL if this is compiled as C++ (despite being a .c file)
#if defined(__cplusplus)
#if defined(NULL)
    #undef NULL
#endif
#define NULL nullptr
#endif

//------------------------------------------------------------------------------
#if ARA_ENABLE_INTERNAL_ASSERTS
static ARABool IsDebuggerAttached(void);
static ARABool IsDebuggerAttached(void)
{
#if defined(_WIN32)
    // Windows provides an explicit debugger test
    return (IsDebuggerPresent()) ? kARATrue : kARAFalse;
#elif defined(__APPLE__)
    // From Technical Q&A QA1361: https://developer.apple.com/qa/qa2004/qa1361.html
    // Returns true if the current process is being debugged (either
    // running under the debugger or has a debugger attached post facto).

    // Initialize mib, which tells sysctl the info we want, in this case
    // we're looking for information about a specific process ID.
    int mib[4];
    mib[0] = CTL_KERN;
    mib[1] = KERN_PROC;
    mib[2] = KERN_PROC_PID;
    mib[3] = getpid();

    // Initialize the flags so that, if sysctl fails for some bizarre
    // reason, we get a predictable result.
    struct kinfo_proc info;
    info.kp_proc.p_flag = 0;

    // Call sysctl.
    size_t size = sizeof(info);
    /*int junk =*/ sysctl(mib, (u_int)(sizeof(mib) / sizeof(*mib)), &info, &size, NULL, 0);
    //assert(junk == 0);

    // We're being debugged if the P_TRACED flag is set.
    return (info.kp_proc.p_flag & P_TRACED) ? kARATrue : kARAFalse;
#elif defined (__linux__)
    char buf[4096];

    const int status_fd = open("/proc/self/status", O_RDONLY);
    if (status_fd == -1)
        return kARAFalse;

    const ssize_t num_read = read(status_fd, buf, sizeof(buf) - 1);
    if (num_read <= 0)
        return kARAFalse;

    buf[num_read] = '\0';
    const char tracerPidString[] = "TracerPid:";
    const char* tracer_pid_ptr = strstr(buf, tracerPidString);
    if (tracer_pid_ptr == NULL)
        return kARAFalse;

    for (const char* characterPtr = tracer_pid_ptr + sizeof(tracerPidString) - 1; characterPtr <= buf + num_read; ++characterPtr)
    {
        if (isspace(*characterPtr))
            continue;
        return (isdigit(*characterPtr) != 0 && *characterPtr != '0') ? kARATrue : kARAFalse;
    }

    return kARAFalse;
#else
    #error "checking for debugger not yet implemented on this platform"
    return kARAFalse;
#endif
}
#endif    // ARA_ENABLE_INTERNAL_ASSERTS

//void BreakIntoDebugger();
//We use a macro instead of a function here to suppress the extra call stack frame displayed by the debugger.
#if defined(_MSC_VER)
    // Visual Studio provides an explicit debugger call
    #define BreakIntoDebugger(...) __debugbreak()
#elif defined(__GNUC__)
    #if defined __has_builtin
        #if __has_builtin(__builtin_debugtrap)
            #define BreakIntoDebugger(...) __builtin_debugtrap()
        #endif
    #endif
    #if !defined(BreakIntoDebugger)
        // GDB: signal SIGINT to have the debugger stop directly at the expression
        // see https://cocoawithlove.com/2008/03/break-into-debugger.html
//      #if ARA_CPU_PPC
//          #define BreakIntoDebugger(...) __asm__ volatile("li r0,20\n  sc\n  nop\n  li r0,37\n  li r4,2\n  sc\n  nop\n" : : : "memory","r0","r4")
        #if ARA_CPU_X86
            #define BreakIntoDebugger(...) __asm__ volatile("int $3\n  nop\n" : : )
        #else
            #warning "BreakIntoDebugger() not yet implemented for this processor, falling back to __builtin_trap() which aborts the program."
            #define BreakIntoDebugger(...) __builtin_trap()
        #endif
    #endif
#else
    #error "not yet implemented on this platform"
#endif

//------------------------------------------------------------------------------
#if ARA_ENABLE_DEBUG_OUTPUT

// optional binary-global logging prefix
static const char * debugPrefix = "";
static const char * prefixSpace = "";
void ARASetupDebugMessagePrefix(const char * prefix)
{
    if (prefix && strlen(prefix))
    {
        debugPrefix = prefix;
        prefixSpace = " ";
    }
    else
    {
        debugPrefix = "";
        prefixSpace = "";
    }
}

void ARADebugMessage(ARADebugLevel level, const char * file, int line, const char * text, ...)
{
    char textString[2048] = { 0 };
    char lineString[64] = { 0 };
    char output[4096] = { 0 };

#if defined (__GNUC__)
    _Pragma ("GCC diagnostic push")
    _Pragma ("GCC diagnostic ignored \"-Wformat-nonliteral\"")
#endif
    va_list vargs;
    va_start (vargs, text);
    vsnprintf (textString, sizeof(textString), text, vargs);
    va_end(vargs);
#if defined (__GNUC__)
    _Pragma ("GCC diagnostic pop")
#endif

    if (line > 0)
    {
#if defined(_MSC_VER)
        snprintf (lineString, sizeof(lineString), "(%i)", line);
#else
        snprintf (lineString, sizeof(lineString), ":%i", line);
#endif
    }

    switch (level)
    {
        case kARADebugLevelLog: snprintf (output, sizeof(output), "[%s%sARA_LOG] %s", debugPrefix, prefixSpace, textString); break;
        case kARADebugLevelWarning: snprintf (output, sizeof(output), "[%s%sARA_WARN] in file %s%s:\n\t%s", debugPrefix, prefixSpace, file, lineString, textString); break;
        case kARADebugLevelAssert: snprintf (output, sizeof(output), "[%s%sARA_ASSERT] in file %s%s:\n\t%s", debugPrefix, prefixSpace, file, lineString, textString); break;
    }

#if defined(_WIN32)
    OutputDebugStringA(output);
    OutputDebugStringA("\n");
#endif
    fprintf(stderr, "%s\n", output);
    fflush(stderr);
}
#endif    // ARA_ENABLE_DEBUG_OUTPUT

//------------------------------------------------------------------------------
#if ARA_ENABLE_INTERNAL_ASSERTS
void ARAHandleAssert(const char * file, int line, const char * diagnosis)
{
#if ARA_ENABLE_DEBUG_OUTPUT
    ARA_DEBUG_MESSAGE(kARADebugLevelAssert, file, line, diagnosis);
#endif

    if (IsDebuggerAttached())
        BreakIntoDebugger();

    abort();    // conforms to the behavior of C's standard assert() macro, should yield proper crash dump.
}
#endif    // ARA_ENABLE_INTERNAL_ASSERTS

//------------------------------------------------------------------------------

#if ARA_VALIDATE_API_CALLS

static ARAAssertFunction * araExternalAssert = NULL;

void ARASetExternalAssertReference(ARAAssertFunction * address)
{
    araExternalAssert = address;
}

#if defined (__GNUC__)
    // this might be returning depending on what ARA_HANDLE_ASSERT() injects, so just silence the warning
    _Pragma ("GCC diagnostic push")
    _Pragma ("GCC diagnostic ignored \"-Wmissing-noreturn\"")
#endif
void ARAAssertionFailure(ARAAssertCategory category, const void * problematicArgument, const char * file, int line, const char * diagnosis)
{
#if ARA_ENABLE_INTERNAL_ASSERTS
    const char * categoryText;
    switch (category)
    {
        case kARAAssertUnspecified: categoryText = "unspecified failure"; break;
        case kARAAssertInvalidArgument: categoryText = "invalid argument"; break;
        case kARAAssertInvalidState: categoryText = "invalid state"; break;
        case kARAAssertInvalidThread: categoryText = "invalid thread"; break;
        default: categoryText = "unknown failure"; break;
    }
    char failure[1024];
    snprintf (failure, sizeof(failure), "ARA API violation (%s, pointer = %p): %s", categoryText, problematicArgument, diagnosis);

    ARA_HANDLE_ASSERT(file, line, failure);
#else
    (void)category; (void)problematicArgument; (void)file; (void)line; (void)diagnosis;   // prevent unused argument warnings
#endif    // ARA_ENABLE_INTERNAL_ASSERTS
}
#if defined (__GNUC__)
    _Pragma ("GCC diagnostic pop")
#endif

void ARAInterfaceAssert(ARAAssertCategory category, const void * problematicArgument, const char * diagnosis)
{
    ARAAssertionFailure(category, problematicArgument, "ARA API PARTNER BINARY", 0, diagnosis);
}

void ARAValidationFailure(ARAAssertCategory category, const void * problematicArgument, const char * file, int line, const char * diagnosis)
{
    if (araExternalAssert && *araExternalAssert && (*araExternalAssert != &ARAInterfaceAssert))
        (*araExternalAssert)(category, problematicArgument, diagnosis);
    else
        ARAAssertionFailure(category, problematicArgument, file, line, diagnosis);
}

ARABool ARACheckFunctionPointersAreValid(const void * interfacePointer)
{
    // the structs start off with "ARASize structSize", followed by function pointers until the specified end of struct
    ARASize size = *(ARASize *)interfacePointer;
    for (const void ** functionPointer = (const void **)(((uintptr_t)interfacePointer) + sizeof(ARASize));
         functionPointer < (const void **)(((uintptr_t)interfacePointer) + size); ++functionPointer)
    {
        if (*functionPointer == NULL)
            return kARAFalse;
    }
    return kARATrue;
}

#endif // ARA_VALIDATE_API_CALLS

//------------------------------------------------------------------------------

#if defined(__cplusplus)
}   // extern "C"
}   // namespace ARA
#endif
