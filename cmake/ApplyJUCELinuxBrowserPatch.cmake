# JUCE 9.0.1 opens linker names supplied by -dev packages rather than runtime
# SONAMEs. Keep this isolated from realtime patches and fail closed on drift.
set(browser_source "${JUCE_SOURCE_DIR}/modules/juce_gui_extra/native/juce_WebBrowserComponent_linux.cpp")
if(NOT EXISTS "${browser_source}")
    message(FATAL_ERROR "Pinned JUCE Linux browser source is missing")
endif()
file(READ "${browser_source}" browser)
set(original_browser "${browser}")

function(openstudio_replace_browser_context before after)
    string(FIND "${browser}" "${after}" patched)
    if(patched GREATER_EQUAL 0)
        return()
    endif()
    string(FIND "${browser}" "${before}" original)
    if(original LESS 0)
        message(FATAL_ERROR "Pinned JUCE Linux browser patch context changed: ${before}")
    endif()
    string(REPLACE "${before}" "${after}" browser "${browser}")
    set(browser "${browser}" PARENT_SCOPE)
endfunction()

openstudio_replace_browser_context("\"libgtk-3.so\"" "\"libgtk-3.so.0\"")
openstudio_replace_browser_context("\"libglib-2.0.so\"" "\"libglib-2.0.so.0\"")
openstudio_replace_browser_context("\"libwebkit2gtk-4.1.so\"" "\"libwebkit2gtk-4.1.so.0\"")
openstudio_replace_browser_context("\"libjavascriptcoregtk-4.1.so\"" "\"libjavascriptcoregtk-4.1.so.0\"")
openstudio_replace_browser_context("\"libsoup-3.0.so\"" "\"libsoup-3.0.so.0\"")
openstudio_replace_browser_context("\"libwebkit2gtk-4.0.so\"" "\"libwebkit2gtk-4.0.so.37\"")
openstudio_replace_browser_context("\"libjavascriptcoregtk-4.0.so\"" "\"libjavascriptcoregtk-4.0.so.18\"")
openstudio_replace_browser_context("\"libsoup-2.4.so\"" "\"libsoup-2.4.so.1\"")
openstudio_replace_browser_context(
    "const bool webKitIsAvailable =    ("
    "const bool webKitIsAvailable = gtkLib && glib && ("
)
openstudio_replace_browser_context(
    "return (options.getBackend() == Options::Backend::defaultBackend);"
    "return (options.getBackend() == Options::Backend::defaultBackend)\n        && WebKitSymbols::getInstance()->isWebKitAvailable();"
)
# JavaScriptCore returns UTF-8. The implicit char* var constructor treats bytes
# as ASCII, corrupting non-ASCII filenames and prompts at the native bridge.
openstudio_replace_browser_context(
    "CommandReceiver::sendCommand (outChannel, \"invokeCallback\", var (s));"
    "CommandReceiver::sendCommand (outChannel, \"invokeCallback\", var (String::fromUTF8 (s)));"
)
if(NOT browser STREQUAL original_browser)
    file(WRITE "${browser_source}" "${browser}")
endif()
message(STATUS "Verified JUCE Linux browser runtime SONAME, availability and UTF-8 bridge patch")
