# A non-owning AudioBuffer still destroys an empty HeapBlock. MSVC's Debug
# free(nullptr) acquires the process-wide CRT heap lock before checking null.
# Keep empty views off that lock; actual allocations retain the original free.
set(JUCE_HEAP_BLOCK "${JUCE_SOURCE_DIR}/modules/juce_core/memory/juce_HeapBlock.h")
file(READ "${JUCE_HEAP_BLOCK}" JUCE_HEAP_SOURCE)
set(JUCE_HEAP_DESTRUCTOR_BEFORE [=[    ~HeapBlock()
    {
        std::free (data);
    }]=])
set(JUCE_HEAP_DESTRUCTOR_AFTER [=[    ~HeapBlock()
    {
        // OpenStudio: empty realtime buffer views must not enter the CRT heap lock.
        if (data != nullptr)
            std::free (data);
    }]=])
set(JUCE_HEAP_FREE_BEFORE [=[    void free() noexcept
    {
        std::free (data);
        data = nullptr;
    }]=])
set(JUCE_HEAP_FREE_AFTER [=[    void free() noexcept
    {
        // OpenStudio: rebinding an empty buffer view also needs no heap operation.
        if (data != nullptr)
            std::free (data);
        data = nullptr;
    }]=])
foreach(PART DESTRUCTOR FREE)
    string(FIND "${JUCE_HEAP_SOURCE}" "${JUCE_HEAP_${PART}_BEFORE}" BEFORE_${PART})
    string(FIND "${JUCE_HEAP_SOURCE}" "${JUCE_HEAP_${PART}_AFTER}" AFTER_${PART})
endforeach()
if(AFTER_DESTRUCTOR GREATER_EQUAL 0 AND AFTER_FREE GREATER_EQUAL 0
        AND BEFORE_DESTRUCTOR LESS 0 AND BEFORE_FREE LESS 0)
    message(STATUS "JUCE empty HeapBlock realtime guard is already applied")
elseif(BEFORE_DESTRUCTOR GREATER_EQUAL 0 AND BEFORE_FREE GREATER_EQUAL 0
        AND AFTER_DESTRUCTOR LESS 0 AND AFTER_FREE LESS 0)
    foreach(PART DESTRUCTOR FREE)
        string(REPLACE "${JUCE_HEAP_${PART}_BEFORE}" "${JUCE_HEAP_${PART}_AFTER}"
            JUCE_HEAP_SOURCE "${JUCE_HEAP_SOURCE}")
    endforeach()
    file(WRITE "${JUCE_HEAP_BLOCK}" "${JUCE_HEAP_SOURCE}")
    message(STATUS "Applied JUCE empty HeapBlock realtime guard")
else()
    message(FATAL_ERROR "Pinned JUCE HeapBlock context changed or guard is partial; refusing an unverified rewrite")
endif()
