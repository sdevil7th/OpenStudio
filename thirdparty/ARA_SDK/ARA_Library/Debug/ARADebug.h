//------------------------------------------------------------------------------
//! \file       ARADebug.h
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

#ifndef ARADebug_h
#define ARADebug_h

#include "ARA_API/ARAInterface.h"

#if defined(__cplusplus)
namespace ARA
{
extern "C"
{
    // helper define to properly insert ARA namespace into C compatible macros
    #define ARA_NAMESPACE ARA::
#else
    #define ARA_NAMESPACE
#endif


/*******************************************************************************/
// printf-like debug output facility
// can be explicitly toggled by defining ARA_ENABLE_DEBUG_OUTPUT, is otherwise
// enabled if NDEBUG is not defined
// can be redirected to a custom implementation by defining the ARA_DEBUG_MESSAGE
// macro accordingly
/*******************************************************************************/

// enable or disable debug output
#if !defined(ARA_ENABLE_DEBUG_OUTPUT)
    #if defined(NDEBUG)
        #define ARA_ENABLE_DEBUG_OUTPUT 0
    #else
        #define ARA_ENABLE_DEBUG_OUTPUT 1
    #endif
#endif

#if ARA_ENABLE_DEBUG_OUTPUT
    // debug levels
    typedef enum ARADebugLevel
    {
        kARADebugLevelLog = 0,      // output is expected and part of the normal program flow
        kARADebugLevelWarning = 1,  // output indicates unusual runtime condition that can be recovered from
        kARADebugLevelAssert = 2    // output indicates programming error
    } ARADebugLevel;

    // primitive macro for all debug output
    // can be overridden by SDK clients to use their own custom logging system
    // typically not called directly - instead ARA_LOG, ARA_WARN or asserts are used
    #if !defined(ARA_DEBUG_MESSAGE)
        #define ARA_DEBUG_MESSAGE(level, text, ...) ARA_NAMESPACE ARADebugMessage(ARA_NAMESPACE level, text, ##__VA_ARGS__)

        // default implementation of ARA_DEBUG_MESSAGE
        // logs to the debugger console and/or to the error output (e.g. stderr)
        void ARADebugMessage(ARADebugLevel level, const char * file, int line, const char * text, ...);
        // this logging can be prefixed by a custom static string if desired, which is useful e.g.
        // if multiple plug-ins are build using the same compiled library, or in the IPC Demo example
        // typically, this setup call is made once when loading the final binary and passes its name
        void ARASetupDebugMessagePrefix(const char * prefix);
        #if defined(__cplusplus)
            // simple static singleton to set logging prefix at binary load time
            // add in one of your .cpp files: ARA_SETUP_DEBUG_MESSAGE_PREFIX("some prefix");
            #define ARA_SETUP_DEBUG_MESSAGE_PREFIX(prefix) \
            static struct LoggingConfigurator \
            { \
                explicit LoggingConfigurator(const char* txt) { ARA::ARASetupDebugMessagePrefix(txt); } \
            } loggingConfiguratorSingleton { prefix }
        #endif
    #endif

    // macros to conveniently use ARA_DEBUG_MESSAGE with predefined levels
    #define ARA_LOG(text, ...) ARA_DEBUG_MESSAGE(kARADebugLevelLog, __FILE__, __LINE__, text, ##__VA_ARGS__)
    #define ARA_WARN(text, ...) ARA_DEBUG_MESSAGE(kARADebugLevelWarning, __FILE__, __LINE__, text, ##__VA_ARGS__)
#else
    #define ARA_LOG(text, ...) ((void)0)
    #define ARA_WARN(text, ...) ((void)0)
#endif

#if defined(__cplusplus) && !defined(ARA_SETUP_DEBUG_MESSAGE_PREFIX)
    #define ARA_SETUP_DEBUG_MESSAGE_PREFIX(prefix) struct EmptyUnusedDummy {}
#endif


/*******************************************************************************/
// prevent unused variable warnings
/*******************************************************************************/

#if defined(__cplusplus) && (__cplusplus >= 201703L)
    #define ARA_MAYBE_UNUSED_VAR(var) var [[maybe_unused]]
#elif defined(__GNUC__)
    #define ARA_MAYBE_UNUSED_VAR(var) var __attribute__((unused))
#elif defined(_MSC_VER)
    #define ARA_MAYBE_UNUSED_VAR(var) var(0); (false ? (void)var : (void)false)
#else
    #define ARA_MAYBE_UNUSED_VAR(var) var; (void)var
#endif

#if defined(__cplusplus) && (__cplusplus >= 201703L)
    #define ARA_MAYBE_UNUSED_ARG(var) var [[maybe_unused]]
#elif defined(__GNUC__)
    #define ARA_MAYBE_UNUSED_ARG(var) var __attribute__((unused))
#else
    #define ARA_MAYBE_UNUSED_ARG(var) var
#endif


/*******************************************************************************/
// internal assertions, similar to the C standard assert() macro
// internal assertions are not reported through the ARA API assertion facility -
// if the assertion is related to the ARA API partner behavior, the validation
// macros below should be used instead
// can be explicitly toggled by defining ARA_ENABLE_INTERNAL_ASSERTS, is otherwise
// enabled if NDEBUG is not defined
// can be redirected to a custom implementation by defining the ARA_HANDLE_ASSERT
// macro accordingly
/*******************************************************************************/

// enable or disable asserts for internal conditions
#if !defined(ARA_ENABLE_INTERNAL_ASSERTS)
    #if defined(NDEBUG)
        #define ARA_ENABLE_INTERNAL_ASSERTS 0
    #else
        #define ARA_ENABLE_INTERNAL_ASSERTS 1
    #endif
#endif

#if ARA_ENABLE_INTERNAL_ASSERTS
    // internal assert, used to track non-ARA-API related problems.
    // behaves like C standard assert, but can be customized if desired
    // typically, some assertion technique will already be implemented in the code bases
    // using this library, any such implementation can be injected here.
    #if !defined(ARA_INTERNAL_ASSERT)
        #define ARA_INTERNAL_ASSERT(condition) ((condition) ? ((void)0) : ARA_HANDLE_ASSERT(__FILE__, __LINE__, #condition))
    #endif

    // primitive macro for handling failed assertions
    // can be overridden by the SDKs client to use their own assertion report system.
    #if !defined(ARA_HANDLE_ASSERT)
        #define ARA_HANDLE_ASSERT(file, line, diagnosis) ARA_NAMESPACE ARAHandleAssert(file, line, diagnosis)

        // default implementation of ARA_DEBUG_MESSAGE
        // prints an error message if ARA_ENABLE_DEBUG_OUTPUT is enabled, then calls abort()
        #if defined(_MSC_VER)
        __declspec (noreturn)
        #elif defined(__GNUC__)
        __attribute__ ((noreturn))
        #endif
        void ARAHandleAssert(const char * file, int line, const char * diagnosis);
    #endif
#else
    #define ARA_INTERNAL_ASSERT(condition) ((void)0)
#endif


/*******************************************************************************/
// ARA API validation: wrapper for the ARA API debug assertion facility
// the ARA API allows for communicating API contract violations to the partner
// binary, i.e. when building a host, this validates plug-in behavior and reports
// errors back, and vice versa
// can be explicitly toggled by defining ARA_VALIDATE_API_CALLS, is otherwise
// enabled if NDEBUG is not defined
// if enabled, ARASetExternalAssertReference () must be called to setup proper
// forwarding of the asserts to the partner binary if desired
/*******************************************************************************/

// enable or disable built-in validation of the API partner
#if !defined(ARA_VALIDATE_API_CALLS)
    #if defined(NDEBUG)
        #define ARA_VALIDATE_API_CALLS 0
    #else
        #define ARA_VALIDATE_API_CALLS 1
    #endif
#endif

#if ARA_VALIDATE_API_CALLS
    // helper define to properly silence Xcode static analyzer warnings triggered by repeated
    // uses of ARA_VALIDATE_... when any one of these test relies on a previous one to succeed
    #if !defined(ARA_ATTRIBUTE_ANALYZER_NORETURN)
        #define ARA_ATTRIBUTE_ANALYZER_NORETURN

        #if defined(__clang__) && defined(__has_feature)
            #if __has_feature(attribute_analyzer_noreturn)
                #undef ARA_ATTRIBUTE_ANALYZER_NORETURN
                #define ARA_ATTRIBUTE_ANALYZER_NORETURN __attribute__((analyzer_noreturn))
            #endif
        #endif
    #endif

    // setup for the ARA assert function, see ARAInterfaceConfiguration::assertFunctionAddress
    // typically, only called when debugging to inject the proper shared assertion handling,
    // see sample code for host and plug-in.
    void ARASetExternalAssertReference(ARAAssertFunction * address);

    // asserts related to the ARA API
    // the various asserts basically only differ by the assert category that they communicate across the API.
    // they are written so that their success can be used as a bool to gracefully handle asserts,
    // e.g. if (!ARA_VALIDATE_API_STATE(...)) return;
    #if defined(__cplusplus)
        #define ARA_VALIDATE_API_STATE(condition)           ((condition) ? void() : (ARA::ARAValidationFailure(ARA::kARAAssertInvalidState, nullptr, __FILE__, __LINE__, #condition)))
        #define ARA_VALIDATE_API_ARGUMENT(arg, condition)   ((condition) ? void() : (ARA::ARAValidationFailure(ARA::kARAAssertInvalidArgument, arg, __FILE__, __LINE__, #condition)))
        #define ARA_VALIDATE_API_CONDITION(condition)       ((condition) ? void() : (ARA::ARAValidationFailure(ARA::kARAAssertUnspecified, nullptr, __FILE__, __LINE__, #condition)))
        #define ARA_VALIDATE_API_STRUCT_PTR(structInstance, structType) (ARA_VALIDATE_API_ARGUMENT(structInstance, (structInstance != nullptr) && (structInstance->structSize >= ARA::k##structType##MinSize)))
//! \todo eventually we should switch to this definition which checks alignment as well - either for all structs,
//!       or at least inside ARACheckFunctionPointersAreValid since it may have actual performance impact there.
//      #define ARA_VALIDATE_API_STRUCT_PTR(structInstance, structType) (ARA_VALIDATE_API_ARGUMENT(structInstance, (structInstance != nullptr) && ((((intptr_t)(const ARA::structType *)structInstance) & (_Alignof(size_t) - 1)) == 0) && (structInstance->structSize >= ARA::k##structType##MinSize)))
        #define ARA_VALIDATE_API_INTERFACE(interfacePointer, InterfaceType) (ARA_VALIDATE_API_STRUCT_PTR(interfacePointer, InterfaceType), ARA_VALIDATE_API_ARGUMENT(interfacePointer, ARA::ARACheckFunctionPointersAreValid(interfacePointer)))
    #else
        #define ARA_VALIDATE_API_STATE(condition)           ((condition) ? ((void)0) : (ARAValidationFailure(kARAAssertInvalidState, NULL, __FILE__, __LINE__, #condition)))
        #define ARA_VALIDATE_API_ARGUMENT(arg, condition)   ((condition) ? ((void)0) : (ARAValidationFailure(kARAAssertInvalidArgument, arg, __FILE__, __LINE__, #condition)))
        #define ARA_VALIDATE_API_CONDITION(condition)       ((condition) ? ((void)0) : (ARAValidationFailure(kARAAssertUnspecified, NULL, __FILE__, __LINE__, #condition)))
        #define ARA_VALIDATE_API_STRUCT_PTR(structInstance, structType) (ARA_VALIDATE_API_ARGUMENT(structInstance, (structInstance != NULL) && (structInstance->structSize >= k##structType##MinSize)))
        #define ARA_VALIDATE_API_INTERFACE(interfacePointer, InterfaceType) (ARA_VALIDATE_API_STRUCT_PTR(interfacePointer, InterfaceType), ARA_VALIDATE_API_ARGUMENT(interfacePointer, ARACheckFunctionPointersAreValid(interfacePointer)))
    #endif

    // internal helper functions for the macros above
    void ARAInterfaceAssert(ARAAssertCategory category, const void * problematicArgument, const char * diagnosis);
    void ARAValidationFailure(ARAAssertCategory category, const void * problematicArgument, const char * file, int line, const char * diagnosis) ARA_ATTRIBUTE_ANALYZER_NORETURN;
    ARABool ARACheckFunctionPointersAreValid(const void * interfacePointer);
#else
    #define ARA_VALIDATE_API_STATE(condition) ((void)0)
    #define ARA_VALIDATE_API_ARGUMENT(arg, condition) ((void)0)
    #define ARA_VALIDATE_API_CONDITION(condition) ((void)0)
    #define ARA_VALIDATE_API_STRUCT_PTR(structInstance, structType) ((void)0)
    #define ARA_VALIDATE_API_INTERFACE(interfacePointer, InterfaceType) ((void)0)
#endif

#if defined(__cplusplus)
}   // extern "C"
}   // namespace ARA
#endif

#endif // ARADebug_h
