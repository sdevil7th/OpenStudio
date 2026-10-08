# WKWebView dispatches requests while hidden. JUCE 9.0.1 otherwise retains the
# dispatched URL and replays it when a native peer first becomes visible,
# cancelling that document's asynchronous module imports during prewarm/open.
if(NOT DEFINED JUCE_SOURCE_DIR)
    message(FATAL_ERROR "JUCE_SOURCE_DIR was not provided")
endif()

set(OPENSTUDIO_MAC_BROWSER_PIN "${JUCE_SOURCE_DIR}/CMakeLists.txt")
set(OPENSTUDIO_MAC_BROWSER_SOURCE
    "${JUCE_SOURCE_DIR}/modules/juce_gui_extra/native/juce_WebBrowserComponent_mac.mm")
if(NOT EXISTS "${OPENSTUDIO_MAC_BROWSER_PIN}" OR NOT EXISTS "${OPENSTUDIO_MAC_BROWSER_SOURCE}")
    message(FATAL_ERROR "Pinned JUCE macOS browser source or version was not found")
endif()
file(READ "${OPENSTUDIO_MAC_BROWSER_PIN}" OPENSTUDIO_MAC_BROWSER_VERSION)
string(REGEX MATCHALL "project\\(JUCE VERSION [0-9]+\\.[0-9]+\\.[0-9]+ LANGUAGES C CXX\\)"
    OPENSTUDIO_MAC_BROWSER_PINS "${OPENSTUDIO_MAC_BROWSER_VERSION}")
list(LENGTH OPENSTUDIO_MAC_BROWSER_PINS OPENSTUDIO_MAC_BROWSER_PIN_COUNT)
if(NOT OPENSTUDIO_MAC_BROWSER_PIN_COUNT EQUAL 1
    OR NOT OPENSTUDIO_MAC_BROWSER_PINS STREQUAL "project(JUCE VERSION 9.0.1 LANGUAGES C CXX)")
    message(FATAL_ERROR "JUCE macOS browser patch requires the exact 9.0.1 pin")
endif()

file(READ "${OPENSTUDIO_MAC_BROWSER_SOURCE}" OPENSTUDIO_MAC_BROWSER_CONTENT)
set(OPENSTUDIO_MAC_BROWSER_BEFORE [=[            if (nsUrl != nullptr)
                [webView.get() loadFileURL: appendParametersToFileURL (url, nsUrl) allowingReadAccessToURL: accessPath];
        }
        else if (NSMutableURLRequest* request = getRequestForURL (url, headers, postData))
        {
            lastRequestedUrl = url;
            [webView.get() loadRequest: request];
        }]=])
set(OPENSTUDIO_MAC_BROWSER_AFTER [=[            if (nsUrl != nullptr)
            {
                [webView.get() loadFileURL: appendParametersToFileURL (url, nsUrl) allowingReadAccessToURL: accessPath];
                // OpenStudio: this WK request has already been dispatched, even
                // while hidden. Do not replay it on the first native-peer show.
                owner.owner.lastURL.clear();
            }
        }
        else if (NSMutableURLRequest* request = getRequestForURL (url, headers, postData))
        {
            lastRequestedUrl = url;
            [webView.get() loadRequest: request];
            owner.owner.lastURL.clear();
        }]=])

function(openstudio_require_unique_mac_browser_context snippet)
    string(FIND "${OPENSTUDIO_MAC_BROWSER_CONTENT}" "${snippet}" first)
    if(first LESS 0)
        message(FATAL_ERROR "Pinned JUCE macOS browser context changed; refusing an unverified dependency rewrite")
    endif()
    string(LENGTH "${snippet}" snippet_length)
    math(EXPR next "${first} + ${snippet_length}")
    string(SUBSTRING "${OPENSTUDIO_MAC_BROWSER_CONTENT}" ${next} -1 remaining)
    string(FIND "${remaining}" "${snippet}" duplicate)
    if(NOT duplicate LESS 0)
        message(FATAL_ERROR "Pinned JUCE macOS browser context is ambiguous; refusing an unverified dependency rewrite")
    endif()
endfunction()

string(FIND "${OPENSTUDIO_MAC_BROWSER_CONTENT}" "${OPENSTUDIO_MAC_BROWSER_AFTER}" patched)
if(patched GREATER_EQUAL 0)
    openstudio_require_unique_mac_browser_context("${OPENSTUDIO_MAC_BROWSER_AFTER}")
    string(FIND "${OPENSTUDIO_MAC_BROWSER_CONTENT}" "${OPENSTUDIO_MAC_BROWSER_BEFORE}" original)
    if(NOT original LESS 0)
        message(FATAL_ERROR "Pinned JUCE macOS browser source mixes patched and unpatched contexts")
    endif()
    message(STATUS "JUCE macOS dispatched navigation patch is already applied")
else()
    openstudio_require_unique_mac_browser_context("${OPENSTUDIO_MAC_BROWSER_BEFORE}")
    string(REPLACE "${OPENSTUDIO_MAC_BROWSER_BEFORE}" "${OPENSTUDIO_MAC_BROWSER_AFTER}"
        OPENSTUDIO_MAC_BROWSER_CONTENT "${OPENSTUDIO_MAC_BROWSER_CONTENT}")
    file(WRITE "${OPENSTUDIO_MAC_BROWSER_SOURCE}" "${OPENSTUDIO_MAC_BROWSER_CONTENT}")
    message(STATUS "Applied JUCE macOS dispatched navigation patch")
endif()
