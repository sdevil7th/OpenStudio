# LV2 descriptions use plugin URIs rather than filesystem paths. Pinned JUCE
# also looks up each identifier as a File, triggering a Debug assertion for a
# URI such as http://drobilla.net/plugins/mda/Delay. Keep bundle lookup for
# absolute paths and leave the existing URI lookup intact.
if(NOT DEFINED JUCE_SOURCE_DIR)
    message(FATAL_ERROR "JUCE_SOURCE_DIR was not provided")
endif()
set(OPENSTUDIO_LV2_IDENTIFIER_SOURCE
    "${JUCE_SOURCE_DIR}/modules/juce_audio_processors_headless/format_types/juce_LV2PluginFormatImpl.h")
if(NOT EXISTS "${OPENSTUDIO_LV2_IDENTIFIER_SOURCE}")
    message(FATAL_ERROR "Pinned JUCE LV2 identifier source was not found")
endif()
file(READ "${OPENSTUDIO_LV2_IDENTIFIER_SOURCE}" OPENSTUDIO_LV2_IDENTIFIER_CONTENT)
set(OPENSTUDIO_LV2_IDENTIFIER_BEFORE [=[        std::vector<const LilvPlugin*> plugins { findPluginByUri (identifier) };
        findPluginsByFile (identifier, plugins);]=])
set(OPENSTUDIO_LV2_IDENTIFIER_AFTER [=[        std::vector<const LilvPlugin*> plugins { findPluginByUri (identifier) };
        // OpenStudio: an LV2 URI must not be implicitly converted to a File.
        if (File::isAbsolutePath (identifier))
            findPluginsByFile (identifier, plugins);]=])

function(openstudio_require_unique_lv2_context snippet)
    string(FIND "${OPENSTUDIO_LV2_IDENTIFIER_CONTENT}" "${snippet}" first)
    if(first LESS 0)
        message(FATAL_ERROR "Pinned JUCE LV2 identifier context changed; refusing an unverified dependency rewrite")
    endif()
    string(LENGTH "${snippet}" snippet_length)
    math(EXPR next "${first} + ${snippet_length}")
    string(SUBSTRING "${OPENSTUDIO_LV2_IDENTIFIER_CONTENT}" ${next} -1 remaining)
    string(FIND "${remaining}" "${snippet}" duplicate)
    if(NOT duplicate LESS 0)
        message(FATAL_ERROR "Pinned JUCE LV2 identifier context is ambiguous; refusing an unverified dependency rewrite")
    endif()
endfunction()

string(FIND "${OPENSTUDIO_LV2_IDENTIFIER_CONTENT}" "${OPENSTUDIO_LV2_IDENTIFIER_AFTER}" OPENSTUDIO_LV2_IDENTIFIER_PATCHED_AT)
if(OPENSTUDIO_LV2_IDENTIFIER_PATCHED_AT GREATER_EQUAL 0)
    openstudio_require_unique_lv2_context("${OPENSTUDIO_LV2_IDENTIFIER_AFTER}")
    string(FIND "${OPENSTUDIO_LV2_IDENTIFIER_CONTENT}" "${OPENSTUDIO_LV2_IDENTIFIER_BEFORE}" unpatched)
    if(NOT unpatched LESS 0)
        message(FATAL_ERROR "Pinned JUCE LV2 identifier source mixes patched and unpatched contexts")
    endif()
    message(STATUS "JUCE LV2 URI identifier patch is already applied")
else()
    openstudio_require_unique_lv2_context("${OPENSTUDIO_LV2_IDENTIFIER_BEFORE}")
    string(REPLACE "${OPENSTUDIO_LV2_IDENTIFIER_BEFORE}" "${OPENSTUDIO_LV2_IDENTIFIER_AFTER}"
        OPENSTUDIO_LV2_IDENTIFIER_CONTENT "${OPENSTUDIO_LV2_IDENTIFIER_CONTENT}")
    file(WRITE "${OPENSTUDIO_LV2_IDENTIFIER_SOURCE}" "${OPENSTUDIO_LV2_IDENTIFIER_CONTENT}")
    message(STATUS "Applied JUCE LV2 URI identifier patch")
endif()
