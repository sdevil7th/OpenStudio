cmake_minimum_required(VERSION 3.22)

project(Studio13_v2 VERSION 0.0.1)

# ==============================================================================
# Phase 20.1: Cross-platform CMake guards
# ==============================================================================

# Set ASIO SDK path for JUCE (Windows only — required for ASIO support)
if(WIN32)
    set(JUCE_ASIOSDK_PATH "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK" CACHE PATH "Path to ASIO SDK")
    message(STATUS "ASIO SDK Path: ${JUCE_ASIOSDK_PATH}")
endif()

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

# Fetch CLAP SDK — C plugin API headers (MIT license)
FetchContent_Declare(
    clap
    GIT_REPOSITORY https://github.com/free-audio/clap.git
    GIT_TAG        1.2.2
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(clap)


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

# ==============================================================================
# ONNX Runtime — pre-built binary for neural network inference (optional)
# Download CPU-only: https://github.com/microsoft/onnxruntime/releases
# Extract to thirdparty/onnxruntime/ with include/ and lib/ subdirectories
# ==============================================================================
set(ONNXRUNTIME_ROOT "${CMAKE_SOURCE_DIR}/thirdparty/onnxruntime")
if(EXISTS "${ONNXRUNTIME_ROOT}/include/onnxruntime_cxx_api.h")
    set(HAS_ONNXRUNTIME ON)
    message(STATUS "ONNX Runtime found at ${ONNXRUNTIME_ROOT}")
else()
    set(HAS_ONNXRUNTIME OFF)
    message(STATUS "ONNX Runtime not found — polyphonic pitch detection disabled")
endif()

# ==============================================================================
# ARA SDK — Optional ARA 2 plugin hosting (for Melodyne, SpectraLayers, etc.)
# Clone from: git clone --recursive --branch releases/2.2.0 https://github.com/Celemony/ARA_SDK
# Place at: thirdparty/ARA_SDK/
# ==============================================================================
set(ARA_SDK_ROOT "${CMAKE_SOURCE_DIR}/thirdparty/ARA_SDK")
if(EXISTS "${ARA_SDK_ROOT}/ARA_API/ARAInterface.h")
    set(HAS_ARA ON)
    message(STATUS "ARA SDK found at ${ARA_SDK_ROOT}")
else()
    set(HAS_ARA OFF)
    message(STATUS "ARA SDK not found — ARA plugin hosting disabled")
endif()

# Define the JUCE application
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
    Source/S13FXGfxEditor.cpp
    Source/S13ScriptWindow.cpp
    Source/ScriptEngine.cpp
    Source/AutomationList.cpp
    Source/MIDIRecorder.cpp
    Source/CLAPPluginFormat.cpp
    Source/ControlSurfaceManager.cpp
    Source/TimecodeSync.cpp
    Source/VideoReader.cpp
    Source/DDPExporter.cpp
    Source/VBAPPanner.cpp
    Source/BuiltInEffects.cpp
    Source/BuiltInEffects2.cpp
    Source/S13PluginEditors.cpp
    Source/PitchDetector.cpp
    Source/PitchMapper.cpp
    Source/S13PitchCorrector.cpp
    Source/PitchAnalyzer.cpp
    Source/PitchResynthesizer.cpp
    Source/SignalsmithShifter.cpp
    Source/TriggerEngine.cpp
    Source/SessionInterchange.cpp
    Source/PolyPitchDetector.cpp
    Source/StemSeparator.cpp
    Source/ARAHostController.cpp
    Source/PartialTracker.cpp
    Source/SinusoidalModel.cpp
)

# Include directories — common to all platforms
target_include_directories(Studio13_v2 PRIVATE
    Source
    # YSFX include paths
    "${ysfx_SOURCE_DIR}/include"
    # CLAP SDK headers
    "${clap_SOURCE_DIR}/include"
    # Signalsmith Stretch — header-only pitch shifting (MIT)
    "${CMAKE_SOURCE_DIR}/thirdparty/signalsmith"
)

# ONNX Runtime include (optional)
if(HAS_ONNXRUNTIME)
    target_include_directories(Studio13_v2 PRIVATE "${ONNXRUNTIME_ROOT}/include")
endif()

# ARA SDK include (optional)
if(HAS_ARA)
    target_include_directories(Studio13_v2 PRIVATE
        "${ARA_SDK_ROOT}"
        "${ARA_SDK_ROOT}/ARA_Library"
    )
    target_compile_definitions(Studio13_v2 PRIVATE JUCE_PLUGINHOST_ARA=1)
endif()

# Platform-specific include directories
if(WIN32)
    target_include_directories(Studio13_v2 PRIVATE
        # ASIO SDK include paths (Windows only)
        "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK/common"
        "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK/host"
        "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK/host/pc"
    )
endif()

# Link against JUCE modules (common to all platforms)
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
    juce::juce_osc
    ysfx
    lua_static
)

# ONNX Runtime link (optional)
if(HAS_ONNXRUNTIME)
    target_link_directories(Studio13_v2 PRIVATE "${ONNXRUNTIME_ROOT}/lib")
    target_link_libraries(Studio13_v2 PRIVATE onnxruntime)
    target_compile_definitions(Studio13_v2 PRIVATE S13_HAS_ONNXRUNTIME=1)
endif()

# ==============================================================================
# Platform-specific compile definitions
# ==============================================================================

# Common definitions (all platforms)
target_compile_definitions(Studio13_v2 PRIVATE
    # Enable plugin hosting: VST3 + LV2
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_LV2=1
    JUCE_PLUGINHOST_VST=0
    # Required for JSFX gfx_showmenu() synchronous popup menus
    JUCE_MODAL_LOOPS_PERMITTED=1
)

if(WIN32)
    # Windows: WebView2, ASIO, WASAPI, DirectSound
    target_compile_definitions(Studio13_v2 PRIVATE
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2=1
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
        JUCE_ASIO=1
        JUCE_WASAPI=1
        JUCE_DIRECTSOUND=1
        JUCE_PLUGINHOST_AU=0
    )
elseif(APPLE)
    # macOS: WebKit browser, CoreAudio, AU hosting
    target_compile_definitions(Studio13_v2 PRIVATE
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2=0
        JUCE_ASIO=0
        JUCE_WASAPI=0
        JUCE_DIRECTSOUND=0
        JUCE_PLUGINHOST_AU=1
    )
elseif(UNIX)
    # Linux: WebKit/GTK browser, ALSA, JACK
    target_compile_definitions(Studio13_v2 PRIVATE
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2=0
        JUCE_ASIO=0
        JUCE_WASAPI=0
        JUCE_DIRECTSOUND=0
        JUCE_PLUGINHOST_AU=0
        JUCE_ALSA=1
        JUCE_JACK=1
    )
endif()

# ==============================================================================
# Windows-only: WebView2 SDK
# ==============================================================================
if(WIN32)
    FetchContent_Declare(
        webview2
        URL "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.1901.177"
    )
    FetchContent_MakeAvailable(webview2)

    target_include_directories(Studio13_v2 PRIVATE
        "${webview2_SOURCE_DIR}/build/native/include"
    )

    if(MSVC)
        target_link_libraries(Studio13_v2 PRIVATE
            "${webview2_SOURCE_DIR}/build/native/x64/WebView2LoaderStatic.lib"
            dwmapi
        )
    endif()
endif()

# ==============================================================================
# macOS-only: Link system frameworks
# ==============================================================================
if(APPLE)
    find_library(WEBKIT_FRAMEWORK WebKit)
    find_library(COREAUDIO_FRAMEWORK CoreAudio)
    find_library(COREMIDI_FRAMEWORK CoreMIDI)
    find_library(ACCELERATE_FRAMEWORK Accelerate)
    target_link_libraries(Studio13_v2 PRIVATE
        ${WEBKIT_FRAMEWORK}
        ${COREAUDIO_FRAMEWORK}
        ${COREMIDI_FRAMEWORK}
        ${ACCELERATE_FRAMEWORK}
    )
endif()

# ==============================================================================
# Linux-only: Link system libraries
# ==============================================================================
if(UNIX AND NOT APPLE)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(ALSA alsa)
    pkg_check_modules(JACK jack)
    pkg_check_modules(WEBKIT webkit2gtk-4.0)
    if(ALSA_FOUND)
        target_link_libraries(Studio13_v2 PRIVATE ${ALSA_LIBRARIES})
        target_include_directories(Studio13_v2 PRIVATE ${ALSA_INCLUDE_DIRS})
    endif()
    if(JACK_FOUND)
        target_link_libraries(Studio13_v2 PRIVATE ${JACK_LIBRARIES})
        target_include_directories(Studio13_v2 PRIVATE ${JACK_INCLUDE_DIRS})
    endif()
    if(WEBKIT_FOUND)
        target_link_libraries(Studio13_v2 PRIVATE ${WEBKIT_LIBRARIES})
        target_include_directories(Studio13_v2 PRIVATE ${WEBKIT_INCLUDE_DIRS})
    endif()
endif()

# Generate the JuceHeader.h
juce_generate_juce_header(Studio13_v2)

# Standard strict warnings
if(MSVC)
    target_compile_options(Studio13_v2 PRIVATE /W4)
else()
    target_compile_options(Studio13_v2 PRIVATE -Wall -Wextra)
endif()

# ==============================================================================
# Post-build copy steps
# ==============================================================================

# Copy bundled FFmpeg to build output (Windows only — .exe)
if(WIN32)
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
elseif(APPLE OR UNIX)
    # On macOS/Linux, look for ffmpeg in the tools directory (no .exe extension)
    set(FFMPEG_BIN "${CMAKE_CURRENT_SOURCE_DIR}/tools/ffmpeg")
    if(EXISTS "${FFMPEG_BIN}")
        add_custom_command(TARGET Studio13_v2 POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${FFMPEG_BIN}"
                "$<TARGET_FILE_DIR:Studio13_v2>/ffmpeg"
            COMMENT "Copying bundled ffmpeg to output directory"
        )
    endif()
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

# Copy ONNX Runtime DLL + models to output directory
if(HAS_ONNXRUNTIME AND WIN32)
    add_custom_command(TARGET Studio13_v2 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${ONNXRUNTIME_ROOT}/lib/onnxruntime.dll"
            "$<TARGET_FILE_DIR:Studio13_v2>/onnxruntime.dll"
        COMMENT "Copying ONNX Runtime DLL to output directory"
    )
endif()

# Copy ML models (Basic-Pitch ONNX) to output directory
set(MODELS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/resources/models")
if(EXISTS "${MODELS_DIR}")
    add_custom_command(TARGET Studio13_v2 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${MODELS_DIR}"
            "$<TARGET_FILE_DIR:Studio13_v2>/models"
        COMMENT "Copying ML models to output directory"
    )
endif()

# Copy stem separator Python script to output directory
set(STEM_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/tools/stem_separator.py")
if(EXISTS "${STEM_SCRIPT}")
    add_custom_command(TARGET Studio13_v2 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${STEM_SCRIPT}"
            "$<TARGET_FILE_DIR:Studio13_v2>/scripts/stem_separator.py"
        COMMENT "Copying stem separator script to output directory"
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
# target_link_libraries(Studio13_v2 PRIVATE Studio13_rc_lib)
