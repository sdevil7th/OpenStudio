if(NOT DEFINED JUCE_SOURCE_DIR)
    message(FATAL_ERROR "JUCE_SOURCE_DIR was not provided")
endif()

set(JUCE_ASIO_DEVICE_SOURCE
    "${JUCE_SOURCE_DIR}/modules/juce_audio_devices/native/juce_ASIO_windows.cpp")
if(NOT EXISTS "${JUCE_ASIO_DEVICE_SOURCE}")
    message(FATAL_ERROR
        "JUCE ASIO device source was not found: ${JUCE_ASIO_DEVICE_SOURCE}")
endif()

file(READ "${JUCE_ASIO_DEVICE_SOURCE}" JUCE_ASIO_SOURCE)

set(JUCE_ASIO_UNPATCHED_GETTER
"    int getXRunCount() const noexcept override          { return xruns; }")
set(JUCE_ASIO_PATCHED_GETTER
"    int getXRunCount() const noexcept override
    {
        return xruns.load (std::memory_order_relaxed);
    }")
set(JUCE_ASIO_UNPATCHED_DISABLED_WRITE
"            xruns = -1;")
set(JUCE_ASIO_PATCHED_DISABLED_WRITE
"            xruns.store (-1, std::memory_order_relaxed);")
set(JUCE_ASIO_UNPATCHED_DECLARATION
"    int xruns = 0;")
set(JUCE_ASIO_PATCHED_DECLARATION
"    std::atomic<int> xruns { 0 };")
set(JUCE_ASIO_UNPATCHED_RESET
"        xruns = 0;")
set(JUCE_ASIO_PATCHED_RESET
"        xruns.store (0, std::memory_order_relaxed);")
set(JUCE_ASIO_UNPATCHED_INCREMENT
"            case kAsioOverload:          ++xruns; return 1;")
set(JUCE_ASIO_PATCHED_INCREMENT
"            case kAsioOverload:
                xruns.fetch_add (1, std::memory_order_relaxed);
                return 1;")

string(FIND
    "${JUCE_ASIO_SOURCE}"
    "${JUCE_ASIO_PATCHED_DECLARATION}"
    JUCE_ASIO_ATOMIC_PATCHED_AT)
if(JUCE_ASIO_ATOMIC_PATCHED_AT GREATER_EQUAL 0)
    foreach(PATCHED_SNIPPET
            JUCE_ASIO_PATCHED_GETTER
            JUCE_ASIO_PATCHED_DISABLED_WRITE
            JUCE_ASIO_PATCHED_RESET
            JUCE_ASIO_PATCHED_INCREMENT)
        string(FIND
            "${JUCE_ASIO_SOURCE}"
            "${${PATCHED_SNIPPET}}"
            JUCE_ASIO_PATCHED_SNIPPET_AT)
        if(JUCE_ASIO_PATCHED_SNIPPET_AT LESS 0)
            message(FATAL_ERROR
                "JUCE ASIO x-run counter patch is incomplete at ${PATCHED_SNIPPET}")
        endif()
    endforeach()
    message(STATUS "JUCE ASIO atomic x-run counter patch is already applied")
else()
    foreach(UNPATCHED_SNIPPET
            JUCE_ASIO_UNPATCHED_GETTER
            JUCE_ASIO_UNPATCHED_DISABLED_WRITE
            JUCE_ASIO_UNPATCHED_DECLARATION
            JUCE_ASIO_UNPATCHED_RESET
            JUCE_ASIO_UNPATCHED_INCREMENT)
        string(FIND
            "${JUCE_ASIO_SOURCE}"
            "${${UNPATCHED_SNIPPET}}"
            JUCE_ASIO_UNPATCHED_SNIPPET_AT)
        if(JUCE_ASIO_UNPATCHED_SNIPPET_AT LESS 0)
            message(FATAL_ERROR
                "JUCE 8.0.0 ASIO x-run counter patch context changed at ${UNPATCHED_SNIPPET}; refusing an unverified dependency rewrite")
        endif()
    endforeach()

    string(REPLACE
        "${JUCE_ASIO_UNPATCHED_GETTER}"
        "${JUCE_ASIO_PATCHED_GETTER}"
        JUCE_ASIO_SOURCE
        "${JUCE_ASIO_SOURCE}")
    string(REPLACE
        "${JUCE_ASIO_UNPATCHED_DISABLED_WRITE}"
        "${JUCE_ASIO_PATCHED_DISABLED_WRITE}"
        JUCE_ASIO_SOURCE
        "${JUCE_ASIO_SOURCE}")
    string(REPLACE
        "${JUCE_ASIO_UNPATCHED_DECLARATION}"
        "${JUCE_ASIO_PATCHED_DECLARATION}"
        JUCE_ASIO_SOURCE
        "${JUCE_ASIO_SOURCE}")
    string(REPLACE
        "${JUCE_ASIO_UNPATCHED_RESET}"
        "${JUCE_ASIO_PATCHED_RESET}"
        JUCE_ASIO_SOURCE
        "${JUCE_ASIO_SOURCE}")
    string(REPLACE
        "${JUCE_ASIO_UNPATCHED_INCREMENT}"
        "${JUCE_ASIO_PATCHED_INCREMENT}"
        JUCE_ASIO_SOURCE
        "${JUCE_ASIO_SOURCE}")
    file(WRITE
        "${JUCE_ASIO_DEVICE_SOURCE}"
        "${JUCE_ASIO_SOURCE}")
    message(STATUS "Applied JUCE ASIO atomic x-run counter patch")
endif()

set(JUCE_BUFFERING_READER
    "${JUCE_SOURCE_DIR}/modules/juce_audio_formats/format/juce_BufferingAudioFormatReader.cpp")
if(NOT EXISTS "${JUCE_BUFFERING_READER}")
    message(FATAL_ERROR
        "JUCE BufferingAudioFormatReader source was not found: ${JUCE_BUFFERING_READER}")
endif()

file(READ "${JUCE_BUFFERING_READER}" JUCE_BUFFERING_READER_SOURCE)

set(JUCE_BLOCKING_LOCK
"    const ScopedLock sl (lock);
    nextReadPosition = startSampleInFile;")

set(JUCE_REALTIME_LOCK_V1
"    // OpenStudio uses timeoutMs == 0 from its realtime playback callback.
    // A normal ScopedLock can priority-invert against the low-priority
    // read-ahead thread. In realtime mode, report a cache miss instead of
    // waiting; non-realtime callers retain JUCE's original blocking behavior.
    const bool realtimeTryOnly = timeoutMs == 0;
    if (realtimeTryOnly)
    {
        if (! lock.tryEnter())
        {
            for (int channel = 0; channel < numDestChannels; ++channel)
                if (auto* dest = reinterpret_cast<float*> (destSamples[channel]))
                    FloatVectorOperations::clear (dest + startOffsetInDestBuffer, numSamples);

            return false;
        }
    }
    else
    {
        lock.enter();
    }

    struct ScopedCriticalSectionExit final
    {
        explicit ScopedCriticalSectionExit (CriticalSection& sectionToUse) noexcept
            : section (sectionToUse)
        {
        }

        ~ScopedCriticalSectionExit()
        {
            section.exit();
        }

        CriticalSection& section;
    };

    const ScopedCriticalSectionExit lockExit (lock);
    nextReadPosition = startSampleInFile;")

set(JUCE_REALTIME_LOCK_V2
"    if (numSamples <= 0)
        return true;

    // OpenStudio uses timeoutMs == 0 from its realtime playback callback.
    // A normal ScopedLock can priority-invert against the low-priority
    // read-ahead thread. Publish the requested position before attempting the
    // lock so the read-ahead thread can chase a realtime miss immediately.
    // In realtime mode, report that miss instead of waiting; non-realtime
    // callers retain JUCE's original blocking behavior.
    nextReadPosition = startSampleInFile;
    const bool realtimeTryOnly = timeoutMs == 0;
    if (realtimeTryOnly)
    {
        if (! lock.tryEnter())
        {
            for (int channel = 0; channel < numDestChannels; ++channel)
                if (auto* dest = reinterpret_cast<float*> (destSamples[channel]))
                    FloatVectorOperations::clear (dest + startOffsetInDestBuffer, numSamples);

            return false;
        }
    }
    else
    {
        lock.enter();
    }

    struct ScopedCriticalSectionExit final
    {
        explicit ScopedCriticalSectionExit (CriticalSection& sectionToUse) noexcept
            : section (sectionToUse)
        {
        }

        ~ScopedCriticalSectionExit()
        {
            section.exit();
        }

        CriticalSection& section;
    };

    const ScopedCriticalSectionExit lockExit (lock);")

set(JUCE_REALTIME_LOCK
"    if (numSamples <= 0)
        return true;

    // OpenStudio uses timeoutMs == 0 from its realtime playback callback.
    // A normal ScopedLock can priority-invert against the low-priority
    // read-ahead thread. Publish the requested position before attempting the
    // lock so the read-ahead thread can chase a realtime miss immediately.
    // In realtime mode, report that miss without modifying the destination;
    // the caller owns its bounded continuity-concealment policy. Non-realtime
    // callers retain JUCE's original blocking behavior.
    nextReadPosition = startSampleInFile;
    const bool realtimeTryOnly = timeoutMs == 0;
    if (realtimeTryOnly)
    {
        if (! lock.tryEnter())
            return false;
    }
    else
    {
        lock.enter();
    }

    struct ScopedCriticalSectionExit final
    {
        explicit ScopedCriticalSectionExit (CriticalSection& sectionToUse) noexcept
            : section (sectionToUse)
        {
        }

        ~ScopedCriticalSectionExit()
        {
            section.exit();
        }

        CriticalSection& section;
    };

    const ScopedCriticalSectionExit lockExit (lock);")

string(FIND
    "${JUCE_BUFFERING_READER_SOURCE}"
    "${JUCE_REALTIME_LOCK}"
    JUCE_PATCHED_AT)
if(JUCE_PATCHED_AT GREATER_EQUAL 0)
    message(STATUS
        "JUCE realtime BufferingAudioReader patch is already applied")
    return()
endif()

string(FIND
    "${JUCE_BUFFERING_READER_SOURCE}"
    "${JUCE_REALTIME_LOCK_V2}"
    JUCE_PATCH_V2_AT)
if(JUCE_PATCH_V2_AT GREATER_EQUAL 0)
    string(REPLACE
        "${JUCE_REALTIME_LOCK_V2}"
        "${JUCE_REALTIME_LOCK}"
        JUCE_BUFFERING_READER_PATCHED_SOURCE
        "${JUCE_BUFFERING_READER_SOURCE}")
    file(WRITE
        "${JUCE_BUFFERING_READER}"
        "${JUCE_BUFFERING_READER_PATCHED_SOURCE}")
    message(STATUS
        "Updated JUCE realtime BufferingAudioReader patch to continuity-safe V3")
    return()
endif()

string(FIND
    "${JUCE_BUFFERING_READER_SOURCE}"
    "${JUCE_REALTIME_LOCK_V1}"
    JUCE_PATCH_V1_AT)
if(JUCE_PATCH_V1_AT GREATER_EQUAL 0)
    string(REPLACE
        "${JUCE_REALTIME_LOCK_V1}"
        "${JUCE_REALTIME_LOCK}"
        JUCE_BUFFERING_READER_PATCHED_SOURCE
        "${JUCE_BUFFERING_READER_SOURCE}")
    file(WRITE
        "${JUCE_BUFFERING_READER}"
        "${JUCE_BUFFERING_READER_PATCHED_SOURCE}")
    message(STATUS
        "Updated JUCE realtime BufferingAudioReader patch")
    return()
endif()

string(FIND
    "${JUCE_BUFFERING_READER_SOURCE}"
    "${JUCE_BLOCKING_LOCK}"
    JUCE_UNPATCHED_AT)
if(JUCE_UNPATCHED_AT LESS 0)
    message(FATAL_ERROR
        "JUCE 8.0.0 BufferingAudioReader patch context changed; refusing an unverified dependency rewrite")
endif()

string(REPLACE
    "${JUCE_BLOCKING_LOCK}"
    "${JUCE_REALTIME_LOCK}"
    JUCE_BUFFERING_READER_PATCHED_SOURCE
    "${JUCE_BUFFERING_READER_SOURCE}")
file(WRITE
    "${JUCE_BUFFERING_READER}"
    "${JUCE_BUFFERING_READER_PATCHED_SOURCE}")
message(STATUS
    "Applied JUCE realtime non-blocking BufferingAudioReader patch")
