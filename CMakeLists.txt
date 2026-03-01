cmake_minimum_required(VERSION 3.22)

project(Studio13_v2 VERSION 0.0.1)

# Set ASIO SDK path for JUCE (required for ASIO support)
# Path must point to the folder containing common/, host/, driver/ subdirectories
set(JUCE_ASIOSDK_PATH "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK" CACHE PATH "Path to ASIO SDK")
message(STATUS "ASIO SDK Path: ${JUCE_ASIOSDK_PATH}")

# Check if JUCE folder exists, otherwise fetch it (or use CPM if preferred, but standard FetchContent is fine)
# For this setup, we'll fetch JUCE 8.0.0
include(FetchContent)
FetchContent_Declare(
    juce
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.0
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(juce)

# Fetch YSFX — open-source JSFX runtime (Apache 2.0)
FetchContent_Declare(
    ysfx
    GIT_REPOSITORY https://github.com/jpcima/ysfx.git
    GIT_TAG        master
    GIT_SHALLOW    TRUE
)
set(YSFX_PLUGIN OFF CACHE BOOL "" FORCE)
set(YSFX_TOOLS OFF CACHE BOOL "" FORCE)
set(YSFX_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ysfx)

# Fetch Lua 5.4 — scripting engine (MIT license)
FetchContent_Declare(
    lua
    URL "https://www.lua.org/ftp/lua-5.4.7.tar.gz"
)
FetchContent_MakeAvailable(lua)

# Build Lua as a static library (it ships as raw C sources)
file(GLOB LUA_CORE_SOURCES "${lua_SOURCE_DIR}/src/*.c")
# Remove lua.c and luac.c (standalone interpreter/compiler, not needed)
list(FILTER LUA_CORE_SOURCES EXCLUDE REGEX "lua\\.c$|luac\\.c$")
add_library(lua_static STATIC ${LUA_CORE_SOURCES})
target_include_directories(lua_static PUBLIC "${lua_SOURCE_DIR}/src")
if(MSVC)
    target_compile_definitions(lua_static PRIVATE _CRT_SECURE_NO_WARNINGS)
    # Suppress Lua C code warnings (third-party code)
    target_compile_options(lua_static PRIVATE /W0)
else()
    target_compile_options(lua_static PRIVATE -w)
endif()

# Define the JUCE applicati# Add our executable
juce_add_gui_app(Studio13_v2
    PRODUCT_NAME "Studio13"
    VERSION 0.0.1
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-256x256.png"
    ICON_SMALL "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-16x16.png"
)

# Source files
target_sources(Studio13_v2 PRIVATE
    Source/Main.cpp
    Source/MainComponent.cpp
    Source/AudioEngine.cpp
    Source/AudioRecorder.cpp
    Source/PlaybackEngine.cpp
    Source/PeakCache.cpp
    Source/AudioConverter.cpp
    Source/MIDIManager.cpp
    Source/MIDIClip.cpp
    Source/PluginManager.cpp
    Source/PluginWindowManager.cpp
    Source/TrackProcessor.cpp
    Source/Metronome.cpp
    Source/AudioAnalyzer.cpp
    Source/S13FXProcessor.cpp
    Source/ScriptEngine.cpp
)

# Include directories
target_include_directories(Studio13_v2 PRIVATE
    Source
    # ASIO SDK include paths
    "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK/common"
    "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK/host"
    "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK/host/pc"
    # YSFX include paths
    "${ysfx_SOURCE_DIR}/include"
)

# Link against JUCE modules
target_link_libraries(Studio13_v2 PRIVATE
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_gui_extra
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_dsp
    ysfx
    lua_static
)

# Enable WebView2 on Windows
target_compile_definitions(Studio13_v2 PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2=1
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    
    # Enable ASIO support for professional audio interfaces (like Audient)
    JUCE_ASIO=1
    JUCE_WASAPI=1
    JUCE_DIRECTSOUND=1
    
    # Enable VST3 plugin hosting
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=0
    JUCE_PLUGINHOST_VST=0
)

# Fetch WebView2 if not present (Fix for missing header)
FetchContent_Declare(
    webview2
    URL "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.1901.177"
)
FetchContent_MakeAvailable(webview2)

target_include_directories(Studio13_v2 PRIVATE
    "${webview2_SOURCE_DIR}/build/native/include"
)

# Link WebView2 Static Lib + DWM API for dark title bar
if(MSVC)
    target_link_libraries(Studio13_v2 PRIVATE
        "${webview2_SOURCE_DIR}/build/native/x64/WebView2LoaderStatic.lib"
        dwmapi
    )
endif()

# Generate the JuceHeader.h
juce_generate_juce_header(Studio13_v2)

# Standard strict warnings
if(MSVC)
    target_compile_options(Studio13_v2 PRIVATE /W4)
else()
    target_compile_options(Studio13_v2 PRIVATE -Wall -Wextra)
endif()

# Copy bundled FFmpeg to build output (next to the executable)
set(FFMPEG_EXE "${CMAKE_CURRENT_SOURCE_DIR}/tools/ffmpeg.exe")
if(EXISTS "${FFMPEG_EXE}")
    add_custom_command(TARGET Studio13_v2 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${FFMPEG_EXE}"
            "$<TARGET_FILE_DIR:Studio13_v2>/ffmpeg.exe"
        COMMENT "Copying bundled ffmpeg.exe to output directory"
    )
else()
    message(WARNING "tools/ffmpeg.exe not found. Run: powershell -ExecutionPolicy Bypass -File tools/setup-ffmpeg.ps1")
endif()

# Copy bundled JSFX effects to build output
set(EFFECTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/effects")
if(EXISTS "${EFFECTS_DIR}")
    add_custom_command(TARGET Studio13_v2 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${EFFECTS_DIR}"
            "$<TARGET_FILE_DIR:Studio13_v2>/effects"
        COMMENT "Copying stock JSFX effects to output directory"
    )
endif()

# Copy bundled Lua scripts to build output
set(SCRIPTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/scripts")
if(EXISTS "${SCRIPTS_DIR}")
    add_custom_command(TARGET Studio13_v2 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${SCRIPTS_DIR}"
            "$<TARGET_FILE_DIR:Studio13_v2>/scripts"
        COMMENT "Copying stock Lua scripts to output directory"
    )
endif()

# Prepare for BinaryData (Frontend assets)
# We will uncomment this once the frontend build is set up
# juce_add_binary_data(FrontendAssets
#     SOURCES
#         frontend/dist/index.html
#         # Add other assets here or point to a directory if JUCE 8 supports it better now, 
#         # but typically we list files or use a helper to glob.
#         # For now, placeholder.
# )
# Ensure binary data is linked (generated by juce_add_binary_data)
# Ensure binary data is linked (generated by juce_add_binary_data)
# target_link_libraries(Studio13_v2 PRIVATE Studio13_rc_lib)
