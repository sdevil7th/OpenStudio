cmake_minimum_required(VERSION 3.22)

set(OPENSTUDIO_APP_VERSION "0.0.1" CACHE STRING "Application version compiled into OpenStudio")

project(OpenStudio VERSION ${OPENSTUDIO_APP_VERSION})

option(OPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK "Allow dev/unbundled builds to bootstrap AI tools from a system Python interpreter" ON)
option(OPENSTUDIO_REQUIRE_ARA "Fail configuration when the ARA SDK is unavailable" ON)
option(OPENSTUDIO_REQUIRE_ASIO "Fail configuration when the ASIO SDK is unavailable for a Windows build" OFF)

# Some third-party dependencies still expect CMAKE_BUILD_TYPE to exist even
# under multi-config generators like Visual Studio. Seed a harmless default
# cache entry so imported subprojects can configure cleanly.
if(CMAKE_CONFIGURATION_TYPES AND NOT DEFINED CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Build type placeholder for multi-config generators" FORCE)
endif()

# ==============================================================================
# Phase 20.1: Cross-platform CMake guards
# ==============================================================================

# Set ASIO SDK path for JUCE (Windows only)
set(OPENSTUDIO_HAS_ASIO_SDK OFF)
if(WIN32)
    set(_OPENSTUDIO_LOCAL_ASIO_SDK "C:/SDKs/ASIO-SDK_2.3.4_2025-10-15/ASIOSDK")
    set(_OPENSTUDIO_REPO_ASIO_SDK "${CMAKE_SOURCE_DIR}/thirdparty/asio")

    if(NOT DEFINED JUCE_ASIOSDK_PATH OR JUCE_ASIOSDK_PATH STREQUAL "")
        if(EXISTS "${_OPENSTUDIO_REPO_ASIO_SDK}/common/iasiodrv.h")
            set(JUCE_ASIOSDK_PATH "${_OPENSTUDIO_REPO_ASIO_SDK}" CACHE PATH "Path to ASIO SDK" FORCE)
        else()
            set(JUCE_ASIOSDK_PATH "${_OPENSTUDIO_LOCAL_ASIO_SDK}" CACHE PATH "Path to ASIO SDK" FORCE)
        endif()
    endif()

    set(OPENSTUDIO_ASIO_HEADER "${JUCE_ASIOSDK_PATH}/common/iasiodrv.h")

    if(EXISTS "${OPENSTUDIO_ASIO_HEADER}")
        set(OPENSTUDIO_HAS_ASIO_SDK ON)
        message(STATUS "ASIO SDK found at ${JUCE_ASIOSDK_PATH}")
    else()
        if(OPENSTUDIO_REQUIRE_ASIO)
            message(FATAL_ERROR
                "ASIO SDK not found at ${JUCE_ASIOSDK_PATH}. "
                "ASIO support is required for this Windows build.")
        else()
            message(WARNING "ASIO SDK not found at ${JUCE_ASIOSDK_PATH}; Windows builds will continue with ASIO support disabled.")
        endif()
    endif()
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
FetchContent_GetProperties(ysfx)
set(_ysfx_deps_dir "${CMAKE_BINARY_DIR}/_deps")
set(_ysfx_subbuild_dir "${_ysfx_deps_dir}/ysfx-subbuild")
set(_ysfx_is_valid FALSE)
if (DEFINED ysfx_SOURCE_DIR
    AND EXISTS "${ysfx_SOURCE_DIR}/CMakeLists.txt"
    AND EXISTS "${ysfx_SOURCE_DIR}/thirdparty/WDL/source/WDL/fft.c"
    AND EXISTS "${ysfx_SOURCE_DIR}/sources/ysfx.cpp")
    set(_ysfx_is_valid TRUE)
elseif (DEFINED ysfx_SOURCE_DIR AND EXISTS "${ysfx_SOURCE_DIR}")
    message(WARNING "Cached ysfx dependency at '${ysfx_SOURCE_DIR}' is incomplete. Removing it so FetchContent can repopulate a clean copy.")
    file(REMOVE_RECURSE "${ysfx_SOURCE_DIR}")
    if (DEFINED ysfx_BINARY_DIR AND EXISTS "${ysfx_BINARY_DIR}")
        file(REMOVE_RECURSE "${ysfx_BINARY_DIR}")
    endif()
    if (EXISTS "${_ysfx_subbuild_dir}")
        file(REMOVE_RECURSE "${_ysfx_subbuild_dir}")
    endif()
endif()
if (_ysfx_is_valid)
    add_subdirectory("${ysfx_SOURCE_DIR}" "${ysfx_BINARY_DIR}")
else()
    FetchContent_MakeAvailable(ysfx)
endif()

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
# ARA SDK — Vendored ARA 2.2.0 plugin-hosting SDK
# OpenStudio's host adapter is intentionally aligned with the vendored tree at thirdparty/ARA_SDK.
# ==============================================================================
set(ARA_SDK_ROOT "${CMAKE_SOURCE_DIR}/thirdparty/ARA_SDK")
if(EXISTS "${ARA_SDK_ROOT}/ARA_API/ARAInterface.h")
    set(HAS_ARA ON)
    message(STATUS "ARA SDK found at ${ARA_SDK_ROOT}")
else()
    set(HAS_ARA OFF)
    if(OPENSTUDIO_REQUIRE_ARA)
        message(FATAL_ERROR
            "ARA SDK not found at ${ARA_SDK_ROOT}. "
            "ARA support is required for this build. "
            "Clone or place the ARA SDK at thirdparty/ARA_SDK before configuring.")
    else()
        message(WARNING "ARA SDK not found — ARA plugin hosting disabled")
    endif()
endif()

# Define the JUCE application
juce_add_gui_app(OpenStudio
    PRODUCT_NAME "OpenStudio"
    VERSION ${PROJECT_VERSION}
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-256x256.png"
    ICON_SMALL "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-16x16.png"
)

# Source files
target_sources(OpenStudio PRIVATE
    Source/Main.cpp
    Source/ApplicationLaunchState.cpp
    Source/MainComponent.cpp
    Source/MixerWindowManager.cpp
    Source/AppUpdater.cpp
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
)

# Include directories — common to all platforms
target_include_directories(OpenStudio PRIVATE
    Source
    # YSFX include paths
    "${ysfx_SOURCE_DIR}/include"
    "${ysfx_SOURCE_DIR}/sources"
    # CLAP SDK headers
    "${clap_SOURCE_DIR}/include"
    # Signalsmith Stretch — header-only pitch shifting (MIT)
    "${CMAKE_SOURCE_DIR}/thirdparty/signalsmith"
)

# ONNX Runtime include (optional)
if(HAS_ONNXRUNTIME)
    target_include_directories(OpenStudio PRIVATE "${ONNXRUNTIME_ROOT}/include")
endif()

# ARA SDK include (optional)
if(HAS_ARA)
    target_include_directories(OpenStudio PRIVATE
        "${ARA_SDK_ROOT}"
        "${ARA_SDK_ROOT}/ARA_Library"
    )
    target_compile_definitions(OpenStudio PRIVATE JUCE_PLUGINHOST_ARA=1)
endif()

# Platform-specific include directories
if(WIN32 AND OPENSTUDIO_HAS_ASIO_SDK)
    target_include_directories(OpenStudio PRIVATE
        # ASIO SDK include paths (Windows only)
        "${JUCE_ASIOSDK_PATH}/common"
        "${JUCE_ASIOSDK_PATH}/host"
        "${JUCE_ASIOSDK_PATH}/host/pc"
    )
endif()

# Link against JUCE modules (common to all platforms)
target_link_libraries(OpenStudio PRIVATE
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
    juce::juce_cryptography
    juce::juce_osc
    ysfx
    lua_static
)

# ONNX Runtime link (optional)
if(HAS_ONNXRUNTIME)
    target_link_directories(OpenStudio PRIVATE "${ONNXRUNTIME_ROOT}/lib")
    target_link_libraries(OpenStudio PRIVATE onnxruntime)
    target_compile_definitions(OpenStudio PRIVATE S13_HAS_ONNXRUNTIME=1)
endif()

# ==============================================================================
# Platform-specific compile definitions
# ==============================================================================

# Common updater/release URL defaults (override at configure time for production)
set(OPENSTUDIO_UPDATE_MANIFEST_URL_VALUE "https://openstudio.org.in/releases/stable/latest.json" CACHE STRING "Updater manifest URL compiled into OpenStudio")
set(OPENSTUDIO_RELEASES_PAGE_URL_VALUE "https://openstudio.org.in/download" CACHE STRING "Release/download page URL compiled into OpenStudio")
set(OPENSTUDIO_UPDATE_CHANNEL_VALUE "stable" CACHE STRING "Updater channel compiled into OpenStudio")

if(WIN32)
    set(_OPENSTUDIO_DEFAULT_APPCAST_URL "https://openstudio.org.in/appcast/windows-stable.xml")
elseif(APPLE)
    set(_OPENSTUDIO_DEFAULT_APPCAST_URL "https://openstudio.org.in/appcast/macos-stable.xml")
else()
    set(_OPENSTUDIO_DEFAULT_APPCAST_URL "")
endif()

set(OPENSTUDIO_UPDATE_APPCAST_URL_VALUE "${_OPENSTUDIO_DEFAULT_APPCAST_URL}" CACHE STRING "Updater appcast URL compiled into OpenStudio")
set(OPENSTUDIO_AI_RUNTIME_MANIFEST_URL_VALUE "https://openstudio.org.in/releases/ai-runtime/stable/latest.json" CACHE STRING "AI runtime manifest URL compiled into OpenStudio")

# Common definitions (all platforms)
target_compile_definitions(OpenStudio PRIVATE
    # Enable plugin hosting: VST3 + LV2
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_LV2=1
    JUCE_PLUGINHOST_VST=0
    # Required for JSFX gfx_showmenu() synchronous popup menus
    JUCE_MODAL_LOOPS_PERMITTED=1
    OPENSTUDIO_UPDATE_MANIFEST_URL="${OPENSTUDIO_UPDATE_MANIFEST_URL_VALUE}"
    OPENSTUDIO_UPDATE_APPCAST_URL="${OPENSTUDIO_UPDATE_APPCAST_URL_VALUE}"
    OPENSTUDIO_RELEASES_PAGE_URL="${OPENSTUDIO_RELEASES_PAGE_URL_VALUE}"
    OPENSTUDIO_UPDATE_CHANNEL="${OPENSTUDIO_UPDATE_CHANNEL_VALUE}"
    OPENSTUDIO_AI_RUNTIME_MANIFEST_URL="${OPENSTUDIO_AI_RUNTIME_MANIFEST_URL_VALUE}"
    OPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK=$<IF:$<BOOL:${OPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK}>,1,0>
)

if(WIN32)
    # Windows: WebView2, ASIO, WASAPI, DirectSound
    target_compile_definitions(OpenStudio PRIVATE
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2=1
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
        JUCE_ASIO=$<IF:$<BOOL:${OPENSTUDIO_HAS_ASIO_SDK}>,1,0>
        JUCE_WASAPI=1
        JUCE_DIRECTSOUND=1
        JUCE_PLUGINHOST_AU=0
    )
elseif(APPLE)
    # macOS: WebKit browser, CoreAudio, AU hosting
    target_compile_definitions(OpenStudio PRIVATE
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2=0
        JUCE_ASIO=0
        JUCE_WASAPI=0
        JUCE_DIRECTSOUND=0
        JUCE_PLUGINHOST_AU=1
    )
elseif(UNIX)
    # Linux: WebKit/GTK browser, ALSA, JACK
    target_compile_definitions(OpenStudio PRIVATE
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

    target_include_directories(OpenStudio PRIVATE
        "${webview2_SOURCE_DIR}/build/native/include"
    )

    if(MSVC)
        target_link_libraries(OpenStudio PRIVATE
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
    target_link_libraries(OpenStudio PRIVATE
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
        target_link_libraries(OpenStudio PRIVATE ${ALSA_LIBRARIES})
        target_include_directories(OpenStudio PRIVATE ${ALSA_INCLUDE_DIRS})
    endif()
    if(JACK_FOUND)
        target_link_libraries(OpenStudio PRIVATE ${JACK_LIBRARIES})
        target_include_directories(OpenStudio PRIVATE ${JACK_INCLUDE_DIRS})
    endif()
    if(WEBKIT_FOUND)
        target_link_libraries(OpenStudio PRIVATE ${WEBKIT_LIBRARIES})
        target_include_directories(OpenStudio PRIVATE ${WEBKIT_INCLUDE_DIRS})
    endif()
endif()

# Generate the JuceHeader.h
juce_generate_juce_header(OpenStudio)

# Standard strict warnings
if(MSVC)
    target_compile_options(OpenStudio PRIVATE /W4 /FS)
else()
    target_compile_options(OpenStudio PRIVATE -Wall -Wextra)
endif()

# ==============================================================================
# Post-build copy steps
# ==============================================================================

# Copy bundled FFmpeg to build output (Windows only — .exe)
if(APPLE)
    set(OPENSTUDIO_RUNTIME_ASSET_ROOT "$<TARGET_BUNDLE_CONTENT_DIR:OpenStudio>/Resources")
else()
    set(OPENSTUDIO_RUNTIME_ASSET_ROOT "$<TARGET_FILE_DIR:OpenStudio>")
endif()

function(openstudio_copy_runtime_file source destination_relative_path copy_comment)
    if(EXISTS "${source}")
        add_custom_command(TARGET OpenStudio POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory
                "${OPENSTUDIO_RUNTIME_ASSET_ROOT}"
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${source}"
                "${OPENSTUDIO_RUNTIME_ASSET_ROOT}/${destination_relative_path}"
            COMMENT "${copy_comment}"
        )
    endif()
endfunction()

function(openstudio_copy_runtime_directory source destination_relative_path copy_comment)
    if(EXISTS "${source}")
        add_custom_command(TARGET OpenStudio POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory
                "${OPENSTUDIO_RUNTIME_ASSET_ROOT}"
            COMMAND ${CMAKE_COMMAND} -E remove_directory
                "${OPENSTUDIO_RUNTIME_ASSET_ROOT}/${destination_relative_path}"
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${source}"
                "${OPENSTUDIO_RUNTIME_ASSET_ROOT}/${destination_relative_path}"
            COMMENT "${copy_comment}"
        )
    endif()
endfunction()

function(openstudio_remove_runtime_path destination_relative_path remove_comment)
    add_custom_command(TARGET OpenStudio POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E remove_directory
            "${OPENSTUDIO_RUNTIME_ASSET_ROOT}/${destination_relative_path}"
        COMMENT "${remove_comment}"
    )
endfunction()

function(openstudio_remove_runtime_file destination_relative_path remove_comment)
    add_custom_command(TARGET OpenStudio POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E rm -f
            "${OPENSTUDIO_RUNTIME_ASSET_ROOT}/${destination_relative_path}"
        COMMENT "${remove_comment}"
    )
endfunction()

if(WIN32)
    set(FFMPEG_EXE "${CMAKE_CURRENT_SOURCE_DIR}/tools/ffmpeg.exe")
    if(EXISTS "${FFMPEG_EXE}")
        openstudio_copy_runtime_file(
            "${FFMPEG_EXE}"
            "ffmpeg.exe"
            "Copying bundled ffmpeg.exe to output directory"
        )
    else()
        message(WARNING "tools/ffmpeg.exe not found. Run: powershell -ExecutionPolicy Bypass -File tools/setup-ffmpeg.ps1")
    endif()

    set(OPENSTUDIO_WINDOWS_PREREQS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/windows-prereqs")
    if(EXISTS "${OPENSTUDIO_WINDOWS_PREREQS_DIR}")
        openstudio_copy_runtime_directory(
            "${OPENSTUDIO_WINDOWS_PREREQS_DIR}"
            "prereqs/windows"
            "Copying Windows prerequisite installers to output directory"
        )
    else()
        message(WARNING "thirdparty/windows-prereqs not found. Run: powershell -ExecutionPolicy Bypass -File tools/setup-windows-prereqs.ps1")
    endif()
elseif(APPLE OR UNIX)
    # On macOS/Linux, look for ffmpeg in the tools directory (no .exe extension)
    set(FFMPEG_BIN "${CMAKE_CURRENT_SOURCE_DIR}/tools/ffmpeg")
    if(EXISTS "${FFMPEG_BIN}")
        openstudio_copy_runtime_file(
            "${FFMPEG_BIN}"
            "ffmpeg"
            "Copying bundled ffmpeg to output directory"
        )
    endif()
endif()

# Copy bundled JSFX effects to build output
set(EFFECTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/effects")
if(EXISTS "${EFFECTS_DIR}")
    openstudio_copy_runtime_directory(
        "${EFFECTS_DIR}"
        "effects"
        "Copying stock JSFX effects to output directory"
    )
endif()

# Copy bundled Lua scripts to build output
set(SCRIPTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/scripts")
if(EXISTS "${SCRIPTS_DIR}")
    openstudio_copy_runtime_directory(
        "${SCRIPTS_DIR}"
        "scripts"
        "Copying stock Lua scripts to output directory"
    )
endif()

# Copy ONNX Runtime DLL + models to output directory
if(HAS_ONNXRUNTIME AND WIN32)
    openstudio_copy_runtime_file(
        "${ONNXRUNTIME_ROOT}/lib/onnxruntime.dll"
        "onnxruntime.dll"
        "Copying ONNX Runtime DLL to output directory"
    )
endif()

# Copy required core ML model(s) to output directory
set(OPENSTUDIO_MODELS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/resources/models")
set(OPENSTUDIO_CORE_MODEL_FILES
    "basic_pitch_nmp.onnx"
)

foreach(OPENSTUDIO_CORE_MODEL_FILE IN LISTS OPENSTUDIO_CORE_MODEL_FILES)
    set(OPENSTUDIO_CORE_MODEL_PATH "${OPENSTUDIO_MODELS_DIR}/${OPENSTUDIO_CORE_MODEL_FILE}")
    if(EXISTS "${OPENSTUDIO_CORE_MODEL_PATH}")
        openstudio_copy_runtime_file(
            "${OPENSTUDIO_CORE_MODEL_PATH}"
            "models/${OPENSTUDIO_CORE_MODEL_FILE}"
            "Copying core ML model ${OPENSTUDIO_CORE_MODEL_FILE} to output directory"
        )
    endif()
endforeach()

# Copy stem separator Python script to output directory
set(STEM_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/tools/stem_separator.py")
if(EXISTS "${STEM_SCRIPT}")
    openstudio_copy_runtime_file(
        "${STEM_SCRIPT}"
        "scripts/stem_separator.py"
        "Copying stem separator script to output directory"
    )
endif()

set(STEM_INSTALLER_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/tools/install_ai_tools.py")
if(EXISTS "${STEM_INSTALLER_SCRIPT}")
    openstudio_copy_runtime_file(
        "${STEM_INSTALLER_SCRIPT}"
        "scripts/install_ai_tools.py"
        "Copying AI tools installer script to output directory"
    )
endif()

set(AI_RUNTIME_PROBE_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/tools/ai_runtime_probe.py")
if(EXISTS "${AI_RUNTIME_PROBE_SCRIPT}")
    openstudio_copy_runtime_file(
        "${AI_RUNTIME_PROBE_SCRIPT}"
        "scripts/ai_runtime_probe.py"
        "Copying AI runtime probe script to output directory"
    )
endif()

# Remove legacy bundled AI runtime artifacts from reused build directories.
openstudio_remove_runtime_path(
    "python"
    "Removing legacy bundled Python runtime from output directory"
)
openstudio_remove_runtime_file(
    "models/BS-Roformer-SW.ckpt"
    "Removing legacy bundled stem model checkpoint from output directory"
)
openstudio_remove_runtime_file(
    "models/BS-Roformer-SW.yaml"
    "Removing legacy bundled stem model manifest from output directory"
)
openstudio_remove_runtime_file(
    "models/download_checks.json"
    "Removing legacy bundled stem model download manifest from output directory"
)

# Copy packaged frontend assets for release/offline builds
set(FRONTEND_DIST_DIR "${CMAKE_CURRENT_SOURCE_DIR}/frontend/dist")
if(EXISTS "${FRONTEND_DIST_DIR}/index.html")
    openstudio_copy_runtime_directory(
        "${FRONTEND_DIST_DIR}"
        "webui"
        "Copying packaged frontend to output directory"
    )
else()
    message(WARNING "frontend/dist not found. Run the frontend production build before packaging OpenStudio.")
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
