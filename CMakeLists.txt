cmake_minimum_required(VERSION 3.22)

# Produce one macOS application that can run natively on both Apple Silicon and
# Intel.  Setting these before project() ensures that compiler checks and every
# source-built dependency use the same deployment contract.  Callers can still
# override either cache value explicitly for a developer-only single-arch build.
if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin")
    if(NOT DEFINED CMAKE_OSX_DEPLOYMENT_TARGET)
        set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING
            "Oldest macOS version supported by OpenStudio")
    endif()
    if(NOT DEFINED CMAKE_OSX_ARCHITECTURES)
        set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING
            "macOS architectures built into OpenStudio")
    endif()
endif()

if(POLICY CMP0184)
    cmake_policy(SET CMP0184 NEW)
endif()
if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
endif()
# YSFX enables the generic ASM language on Windows even though it has no ASM
# sources. CMake 4.1+ otherwise rejects MSVC's driver during that declaration.
if(POLICY CMP0194)
    cmake_policy(SET CMP0194 OLD)
    set(CMAKE_POLICY_DEFAULT_CMP0194 OLD)
endif()

set(OPENSTUDIO_APP_VERSION "0.0.1" CACHE STRING "Application version compiled into OpenStudio")

project(OpenStudio VERSION ${OPENSTUDIO_APP_VERSION})

# Visual Studio's Debug CRT defaults to checked STL iterators. Their
# construction/destruction is serialized by a process-wide lock, so unrelated
# UI/background container work can priority-invert a 16-sample ASIO callback.
# This must be directory-wide (including source-built dependencies) because
# mixing iterator debug levels across linked C++ targets is ABI-incompatible.
if(MSVC)
    add_compile_definitions(
        $<$<CONFIG:Debug>:_ITERATOR_DEBUG_LEVEL=0>
    )
endif()

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

# Check if JUCE folder exists, otherwise fetch it (or use CPM if preferred, but standard FetchContent is fine).
# JUCE is intentionally pinned to one repository-wide release.  Dependency
# upgrades must change this tag directly and pass the complete platform matrix;
# a cache override is deliberately not exposed because it allows local and CI
# builds to silently use different framework versions.
include(FetchContent)
FetchContent_Declare(
    juce
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        9.0.1
    GIT_SHALLOW    TRUE
    PATCH_COMMAND
        "${CMAKE_COMMAND}"
        "-DJUCE_SOURCE_DIR=<SOURCE_DIR>"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyJUCERealtimePatches.cmake"
)
FetchContent_MakeAvailable(juce)
if(MSVC)
    # JUCE's VST3 wrapper has two benign C4458 warnings in vendor code.
    set_source_files_properties(
        "${juce_SOURCE_DIR}/modules/juce_audio_processors/juce_audio_processors.cpp"
        PROPERTIES COMPILE_OPTIONS "/wd4458"
    )

    # MSVC /O2 and /Ox can break WRL callback dispatch in JUCE's WebView2
    # resource-provider path, leaving Release builds on about:blank even though
    # the controller was created successfully.  Restrict /O1 to JUCE's GUI-extra
    # translation unit so audio/DSP code keeps the normal Release optimisation.
    set_property(SOURCE
        "${juce_SOURCE_DIR}/modules/juce_gui_extra/juce_gui_extra.cpp"
        APPEND PROPERTY COMPILE_OPTIONS
        $<$<OR:$<CONFIG:Release>,$<CONFIG:RelWithDebInfo>>:/O1>
    )
endif()

# Fetch YSFX — open-source JSFX runtime (Apache 2.0)
FetchContent_Declare(
    ysfx
    GIT_REPOSITORY https://github.com/jpcima/ysfx.git
    GIT_TAG        8077347ccf4115567aed81400281dca57acbb0cc
    GIT_SUBMODULES thirdparty/dr_libs
    GIT_SUBMODULES_RECURSE FALSE
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
if(MSVC AND TARGET ysfx-private)
    # Third-party YSFX currently emits C4297 from its public noexcept C API.
    target_compile_options(ysfx-private PRIVATE /W0)
endif()

# Fetch Lua 5.4 — scripting engine (MIT license)
FetchContent_Declare(
    lua
    URL "https://www.lua.org/ftp/lua-5.4.7.tar.gz"
    URL_HASH SHA256=9fbf5e28ef86c69858f6d3d34eccc32e911c1a28b4120ff3e84aaa70cfbf1e30
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

# NeuralAmpModelerCore v0.5.4 -- native NAM/A1/A2 DSP loader.
# The upstream project primarily builds tools, so OpenStudio wraps the NAM source
# files in a local static library and links that into the native rack processor.
FetchContent_Declare(
    neural_amp_modeler_core
    GIT_REPOSITORY https://github.com/sdatkinson/NeuralAmpModelerCore.git
    GIT_TAG        v0.5.4
    GIT_SHALLOW    TRUE
    GIT_SUBMODULES Dependencies/eigen
    # Keep OpenStudio's verified v0.5.4 real-time fixes reproducible:
    # active-column WaveNet clearing, a lock-free SlimmableWavenet pending
    # fast path, allocation-free ConvNet processing after Reset(), and an A2
    # tail mirror whose work scales with the current callback rather than the
    # prepared maximum block size.
    PATCH_COMMAND
        "${CMAKE_COMMAND}"
        "-DNAM_SOURCE_DIR=<SOURCE_DIR>"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyNAMCorePatches.cmake"
)
FetchContent_GetProperties(neural_amp_modeler_core)
if(NOT neural_amp_modeler_core_POPULATED)
    if(POLICY CMP0169)
        cmake_policy(PUSH)
        cmake_policy(SET CMP0169 OLD)
    endif()
    FetchContent_Populate(neural_amp_modeler_core)
    if(POLICY CMP0169)
        cmake_policy(POP)
    endif()
endif()

file(GLOB OPENSTUDIO_NAMCORE_SOURCES CONFIGURE_DEPENDS
    "${neural_amp_modeler_core_SOURCE_DIR}/NAM/*.cpp"
    "${neural_amp_modeler_core_SOURCE_DIR}/NAM/*/*.cpp"
)
add_library(openstudio_namcore STATIC ${OPENSTUDIO_NAMCORE_SOURCES})
if(MSVC)
    # This target is intentionally optimized in Debug and cannot use /RTC1.
    set_property(TARGET openstudio_namcore PROPERTY MSVC_RUNTIME_CHECKS "")
endif()
target_include_directories(openstudio_namcore SYSTEM PUBLIC
    "${neural_amp_modeler_core_SOURCE_DIR}"
    "${neural_amp_modeler_core_SOURCE_DIR}/NAM"
    "${neural_amp_modeler_core_SOURCE_DIR}/Dependencies/eigen"
    "${neural_amp_modeler_core_SOURCE_DIR}/Dependencies/nlohmann"
)
target_compile_features(openstudio_namcore PRIVATE cxx_std_20)
target_compile_definitions(openstudio_namcore PUBLIC
    NAM_SAMPLE_FLOAT
    NAM_ENABLE_A2_FAST
    # Upstream's supported small-matrix kernels avoid generic Eigen dispatch
    # overhead for the tiny channel counts used by realtime NAM WaveNets. The
    # NeuralAmpModelerCore CI builds this path as well.
    NAM_USE_INLINE_GEMM
    NAM_DEFAULT_MAX_BUFFER_SIZE=8192
)
target_compile_definitions(openstudio_namcore PRIVATE
    $<$<CONFIG:Debug>:NDEBUG>
)
if(MSVC)
    target_compile_options(openstudio_namcore PRIVATE
        /W0
        $<$<CONFIG:Debug>:/O2>
        $<$<CONFIG:Debug>:/Ob2>
        $<$<CONFIG:Debug>:/Oi>
        $<$<CONFIG:Debug>:/Ot>
    )
else()
    target_compile_options(openstudio_namcore PRIVATE
        -w
        $<$<CONFIG:Debug>:-O3>
    )
endif()


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
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "OpenStudio needs access to your audio input to record from microphones and audio interfaces."
)
if(MSVC)
    # Realtime audio translation units below are intentionally optimized
    # in Debug. CMP0184 controls runtime checks at target scope, so the target
    # must opt out to avoid MSVC's incompatible /O2 + /RTC1 combination.
    set_property(TARGET OpenStudio PROPERTY MSVC_RUNTIME_CHECKS "")
    # The headless aggregate regression nests the complete NAM DSP suite
    # inside the host suite. Both deliberately keep sizeable fixed DSP state
    # on the calling thread, which exceeds Windows' 1 MiB executable default
    # even though either suite is safe in isolation. Reserve virtual stack
    # headroom for that supported diagnostic path; pages remain demand-
    # committed, so normal UI/audio memory use is unchanged.
    target_link_options(OpenStudio PRIVATE /STACK:8388608)
endif()
# Source files
target_sources(OpenStudio PRIVATE
    Source/Main.cpp
    Source/ApplicationLaunchState.cpp
    Source/MainComponent.cpp
    Source/MixerWindowManager.cpp
    Source/AppUpdater.cpp
    Source/CrashDiagnostics.cpp
    Source/AudioEngine.cpp
    Source/NAMDelayRegression.h
    Source/NAMDelayRegression.cpp
    Source/NAMDelayRegressionLifecycle.cpp
    Source/NAMDelayRegressionRackTail.cpp
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
    Source/NAMCabPresentation.h
    Source/NAMCabPresentation.cpp
    Source/NAMPolyOctaver.h
    Source/NAMPolyOctaver.cpp
    Source/S13PluginEditors.cpp
    Source/TunerPitchTracker.cpp
    Source/PitchDetector.cpp
    Source/PitchMapper.cpp
    Source/S13PitchCorrector.cpp
    Source/PitchAnalyzer.cpp
    Source/PitchResynthesizer.cpp
    Source/LpcEnvelopeTransfer.cpp
    Source/OwnPitchEngine.cpp
    Source/TriggerEngine.cpp
    Source/SessionInterchange.cpp
    Source/PolyPitchDetector.cpp
    Source/StemSeparator.cpp
    Source/AITrackEngine.cpp
    Source/ARAHostController.cpp
)

# Keep the complete production audio callback path optimized even in the app's
# developer build. `build.py dev --run` uses Debug; leaving JUCE's ASIO
# conversion/convolution modules or the surrounding host/track helpers at /Od
# creates periodic work spikes that do not represent the shipped DSP.
set(OPENSTUDIO_REALTIME_AUDIO_SOURCES
    Source/AudioEngine.cpp
    Source/AudioRecorder.cpp
    Source/PlaybackEngine.cpp
    Source/TrackProcessor.cpp
    Source/Metronome.cpp
    Source/MIDIRecorder.cpp
    Source/AutomationList.cpp
    Source/TimecodeSync.cpp
    Source/TriggerEngine.cpp
    Source/BuiltInEffects.cpp
    Source/BuiltInEffects2.cpp
    Source/NAMCabPresentation.cpp
    Source/NAMPolyOctaver.cpp
    Source/S13PitchCorrector.cpp
    Source/TunerPitchTracker.cpp
    "${juce_SOURCE_DIR}/modules/juce_audio_basics/juce_audio_basics.cpp"
    "${juce_SOURCE_DIR}/modules/juce_audio_devices/juce_audio_devices.cpp"
    "${juce_SOURCE_DIR}/modules/juce_audio_formats/juce_audio_formats.cpp"
    "${juce_SOURCE_DIR}/modules/juce_audio_processors/juce_audio_processors.cpp"
    "${juce_SOURCE_DIR}/modules/juce_audio_utils/juce_audio_utils.cpp"
    "${juce_SOURCE_DIR}/modules/juce_dsp/juce_dsp.cpp"
)
if(MSVC)
    set_property(SOURCE
        ${OPENSTUDIO_REALTIME_AUDIO_SOURCES}
        APPEND PROPERTY COMPILE_OPTIONS
        $<$<CONFIG:Debug>:/O2>
        $<$<CONFIG:Debug>:/Ob2>
        $<$<CONFIG:Debug>:/Oi>
        $<$<CONFIG:Debug>:/Ot>
    )
else()
    set_property(SOURCE
        ${OPENSTUDIO_REALTIME_AUDIO_SOURCES}
        APPEND PROPERTY COMPILE_OPTIONS
        $<$<CONFIG:Debug>:-O3>
    )
endif()

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
    openstudio_namcore
)
if(WIN32)
    # AudioEngine registers ASIO callback threads with the Windows Multimedia
    # Class Scheduler Service's "Pro Audio" task.
    target_link_libraries(OpenStudio PRIVATE avrt)
endif()

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
    set(_OPENSTUDIO_DEFAULT_APPCAST_URL "https://openstudio.org.in/appcast/linux-stable.xml")
endif()

set(OPENSTUDIO_UPDATE_APPCAST_URL_VALUE "${_OPENSTUDIO_DEFAULT_APPCAST_URL}" CACHE STRING "Updater appcast URL compiled into OpenStudio")
set(OPENSTUDIO_AI_RUNTIME_MANIFEST_URL_VALUE "https://openstudio.org.in/releases/ai-runtime/stable/latest.json" CACHE STRING "AI runtime manifest URL compiled into OpenStudio")
set(OPENSTUDIO_TONE3000_CLIENT_ID_VALUE "" CACHE STRING "TONE3000 publishable OAuth client_id compiled into OpenStudio")

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
    OPENSTUDIO_TONE3000_CLIENT_ID="${OPENSTUDIO_TONE3000_CLIENT_ID_VALUE}"
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
        URL_HASH SHA256=464360d5eedcae0e95b0a3fe13c74b496bc9b542980ff8ecebd9ff7ea37ca39e
    )
    FetchContent_MakeAvailable(webview2)

    target_include_directories(OpenStudio PRIVATE
        "${webview2_SOURCE_DIR}/build/native/include"
    )

    if(MSVC)
        target_link_libraries(OpenStudio PRIVATE
            "${webview2_SOURCE_DIR}/build/native/x64/WebView2LoaderStatic.lib"
            dbghelp
            dwmapi
            crypt32
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
    find_package(CURL REQUIRED)
    pkg_check_modules(ALSA alsa)
    pkg_check_modules(JACK jack)
    # webkit2gtk-4.1 is standard on Ubuntu 24.04+; fall back to 4.0 for older distros
    pkg_check_modules(WEBKIT webkit2gtk-4.1)
    if(NOT WEBKIT_FOUND)
        pkg_check_modules(WEBKIT webkit2gtk-4.0)
    endif()
    pkg_check_modules(GTK gtk+-3.0)
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
    if(GTK_FOUND)
        target_link_libraries(OpenStudio PRIVATE ${GTK_LIBRARIES})
        target_include_directories(OpenStudio PRIVATE ${GTK_INCLUDE_DIRS})
    endif()
    target_link_libraries(OpenStudio PRIVATE CURL::libcurl)
endif()

# Generate the JuceHeader.h
juce_generate_juce_header(OpenStudio)

# Standard strict warnings
if(MSVC)
    target_compile_options(OpenStudio PRIVATE /W4 /FS)
else()
    target_compile_options(OpenStudio PRIVATE -Wall -Wextra)
endif()

# On Linux, set RPATH to $ORIGIN so the binary finds libonnxruntime.so etc. next to it
if(UNIX AND NOT APPLE)
    set_target_properties(OpenStudio PROPERTIES
        INSTALL_RPATH "$ORIGIN"
        BUILD_WITH_INSTALL_RPATH TRUE
    )
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
        get_filename_component(destination_directory "${destination_relative_path}" DIRECTORY)
        set(runtime_destination_directory "${OPENSTUDIO_RUNTIME_ASSET_ROOT}")
        if(NOT destination_directory STREQUAL "")
            set(runtime_destination_directory
                "${OPENSTUDIO_RUNTIME_ASSET_ROOT}/${destination_directory}")
        endif()
        add_custom_command(TARGET OpenStudio POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory
                "${runtime_destination_directory}"
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

# Verify text notices after normalizing line endings so the same pinned source
# is accepted on Windows, macOS, and Linux checkouts. The original upstream
# file is still copied byte-for-byte into the runtime bundle.
function(openstudio_require_and_copy_notice source expected_normalized_sha256 destination_relative_path description)
    if(NOT EXISTS "${source}")
        message(FATAL_ERROR "Required ${description} is missing: ${source}")
    endif()

    file(READ "${source}" notice_contents)
    string(REPLACE "\r\n" "\n" notice_contents "${notice_contents}")
    string(REPLACE "\r" "\n" notice_contents "${notice_contents}")
    string(SHA256 notice_actual_sha256 "${notice_contents}")
    if(NOT "${notice_actual_sha256}" STREQUAL "${expected_normalized_sha256}")
        message(FATAL_ERROR
            "${description} checksum mismatch. Expected ${expected_normalized_sha256}, "
            "received ${notice_actual_sha256}.")
    endif()

    openstudio_copy_runtime_file(
        "${source}"
        "${destination_relative_path}"
        "Copying ${description} to output directory"
    )
endfunction()

# Give bundle validation a display-server-independent version source. Launching
# the JUCE GUI binary just to query its version can initialise a platform GUI
# backend on headless Linux runners, so the release contract uses this manifest
# generated from the exact CMake version compiled into the target.
set(OPENSTUDIO_VERSION_MANIFEST
    "${CMAKE_CURRENT_BINARY_DIR}/OpenStudio.version")
file(WRITE "${OPENSTUDIO_VERSION_MANIFEST}" "${OPENSTUDIO_APP_VERSION}\n")
openstudio_copy_runtime_file(
    "${OPENSTUDIO_VERSION_MANIFEST}"
    "OpenStudio.version"
    "Copying OpenStudio version manifest to output directory"
)

# Ship the application license and third-party notices with every binary
# bundle. On macOS these land in Contents/Resources; on Windows and Linux they
# sit beside the executable and are consequently included by the packagers.
openstudio_copy_runtime_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE"
    "LICENSE"
    "Copying OpenStudio license to output directory"
)
openstudio_copy_runtime_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/THIRD_PARTY_LICENSES.md"
    "THIRD_PARTY_LICENSES.md"
    "Copying third-party notices to output directory"
)
openstudio_copy_runtime_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/frontend/THIRD_PARTY_NOTICES.txt"
    "licenses/Frontend-THIRD_PARTY_NOTICES.txt"
    "Copying frontend dependency notices to output directory"
)

openstudio_require_and_copy_notice(
    "${ysfx_SOURCE_DIR}/LICENSE"
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
    "licenses/YSFX-LICENSE.txt"
    "YSFX Apache-2.0 license"
)
openstudio_require_and_copy_notice(
    "${ysfx_SOURCE_DIR}/thirdparty/WDL/LICENSE.txt"
    "aeb30b800c5b402a52e4a8960601bc56a74bed26ff6356f459f88d902998f4f4"
    "licenses/WDL-LICENSE.txt"
    "WDL zlib-style license"
)
openstudio_require_and_copy_notice(
    "${ysfx_SOURCE_DIR}/thirdparty/dr_libs/LICENSE"
    "dd1c647e6f767f8ff4b2dfae0fed314726600a01e0cf1ef556afddd5fa96ff15"
    "licenses/dr_libs-LICENSE.txt"
    "dr_libs dual license"
)
openstudio_require_and_copy_notice(
    "${ysfx_SOURCE_DIR}/thirdparty/stb/LICENSE"
    "bebfe904b14301657e4e5d655c811d51fd31b97c455b9cc2d8600d6bac6cff63"
    "licenses/stb-LICENSE.txt"
    "stb dual license"
)
openstudio_require_and_copy_notice(
    "${clap_SOURCE_DIR}/LICENSE"
    "ced49f9ef950277afdb56199369ea6e8165ebfdbfbb37ebfe1827e0de892088d"
    "licenses/CLAP-LICENSE.txt"
    "CLAP SDK MIT license"
)
openstudio_require_and_copy_notice(
    "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/signalsmith/LICENSE.txt"
    "7154ecf162d91232235c9ba4619d95b30c7f1f904a39e0f22eaf914e208cb69b"
    "licenses/Signalsmith-Stretch-LICENSE.txt"
    "Signalsmith Stretch MIT license"
)
openstudio_require_and_copy_notice(
    "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/signalsmith/signalsmith-linear/LICENSE.txt"
    "072b5e9eb5b22880bdf6256324654cf3ce53dba828edb911921121e1be09d9c3"
    "licenses/Signalsmith-Linear-LICENSE.txt"
    "Signalsmith Linear MIT license"
)
openstudio_require_and_copy_notice(
    "${ARA_SDK_ROOT}/NOTICE.txt"
    "c2cb0f6d2e7142c4eaa437c658e2fef1aa6d304b9eb75e5de8a9be09f317cdd3"
    "licenses/ARA-NOTICE.txt"
    "ARA SDK notice"
)
openstudio_require_and_copy_notice(
    "${ARA_SDK_ROOT}/ARA_API/LICENSE.txt"
    "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
    "licenses/ARA-API-LICENSE.txt"
    "ARA API Apache-2.0 license"
)
openstudio_require_and_copy_notice(
    "${ARA_SDK_ROOT}/ARA_Library/LICENSE.txt"
    "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
    "licenses/ARA-Library-LICENSE.txt"
    "ARA Library Apache-2.0 license"
)

# These files are pinned to Spotify Basic Pitch v0.4.0. Verify their contents
# before packaging so an HTTP/API error page can never be shipped as a notice.
set(OPENSTUDIO_BASIC_PITCH_LICENSE
    "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/basic-pitch/LICENSE")
set(OPENSTUDIO_BASIC_PITCH_NOTICE
    "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/basic-pitch/NOTICE")
set(OPENSTUDIO_BASIC_PITCH_LICENSE_SHA256
    "929c910bae2152fa87199a5d0660e09263419b7eee6d4b301d05ee2aaf211c37")
set(OPENSTUDIO_BASIC_PITCH_NOTICE_SHA256
    "b810e55c0e3b520fabb45fc2ccc74880187bf84e309971968541cc812dcde905")
foreach(basic_pitch_legal_file IN ITEMS LICENSE NOTICE)
    set(basic_pitch_legal_path "${OPENSTUDIO_BASIC_PITCH_${basic_pitch_legal_file}}")
    if(NOT EXISTS "${basic_pitch_legal_path}")
        message(FATAL_ERROR "Required Basic Pitch ${basic_pitch_legal_file} is missing: ${basic_pitch_legal_path}")
    endif()
    file(SHA256 "${basic_pitch_legal_path}" basic_pitch_legal_actual_sha256)
    if(NOT "${basic_pitch_legal_actual_sha256}" STREQUAL
           "${OPENSTUDIO_BASIC_PITCH_${basic_pitch_legal_file}_SHA256}")
        message(FATAL_ERROR
            "Basic Pitch ${basic_pitch_legal_file} checksum mismatch. Refusing to package an unverified legal file.")
    endif()
endforeach()
openstudio_copy_runtime_file(
    "${OPENSTUDIO_BASIC_PITCH_LICENSE}"
    "licenses/BasicPitch-LICENSE.txt"
    "Copying Basic Pitch license to output directory"
)
openstudio_copy_runtime_file(
    "${OPENSTUDIO_BASIC_PITCH_NOTICE}"
    "licenses/BasicPitch-NOTICE.txt"
    "Copying Basic Pitch notice to output directory"
)
openstudio_copy_runtime_file(
    "${neural_amp_modeler_core_SOURCE_DIR}/LICENSE"
    "licenses/NeuralAmpModelerCore-LICENSE.txt"
    "Copying NeuralAmpModelerCore license to output directory"
)
foreach(eigen_notice IN ITEMS COPYING.MPL2 COPYING.BSD COPYING.APACHE COPYING.MINPACK COPYING.README)
    openstudio_copy_runtime_file(
        "${neural_amp_modeler_core_SOURCE_DIR}/Dependencies/eigen/${eigen_notice}"
        "licenses/Eigen-${eigen_notice}.txt"
        "Copying Eigen ${eigen_notice} notice to output directory"
    )
endforeach()

if(WIN32)
    set(FFMPEG_EXE "${CMAKE_CURRENT_SOURCE_DIR}/tools/ffmpeg.exe")
    set(OPENSTUDIO_FFMPEG_WINDOWS_SHA256
        "5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d")
    set(OPENSTUDIO_FFMPEG_GPLV3
        "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/ffmpeg/COPYING.GPLv3")
    set(OPENSTUDIO_FFMPEG_PROVENANCE
        "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/ffmpeg/PROVENANCE.json")
    set(OPENSTUDIO_FFMPEG_GPLV3_SHA256
        "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903")
    set(OPENSTUDIO_FFMPEG_PROVENANCE_SHA256
        "30fc0edca9acc1d7a3253a81afe485a44f1de3c4b86542a18f644c1f71f312d4")
    if(EXISTS "${FFMPEG_EXE}")
        file(SHA256 "${FFMPEG_EXE}" ffmpeg_actual_sha256)
        if(NOT "${ffmpeg_actual_sha256}" STREQUAL "${OPENSTUDIO_FFMPEG_WINDOWS_SHA256}")
            message(FATAL_ERROR
                "Bundled tools/ffmpeg.exe checksum mismatch. Refusing to package an unverified FFmpeg build.")
        endif()
        foreach(ffmpeg_legal_file IN ITEMS GPLV3 PROVENANCE)
            set(ffmpeg_legal_path "${OPENSTUDIO_FFMPEG_${ffmpeg_legal_file}}")
            if(NOT EXISTS "${ffmpeg_legal_path}")
                message(FATAL_ERROR
                    "Bundled FFmpeg requires ${ffmpeg_legal_path}, but that legal/provenance file is missing.")
            endif()
            file(SHA256 "${ffmpeg_legal_path}" ffmpeg_legal_actual_sha256)
            if(NOT "${ffmpeg_legal_actual_sha256}" STREQUAL
                   "${OPENSTUDIO_FFMPEG_${ffmpeg_legal_file}_SHA256}")
                message(FATAL_ERROR
                    "Bundled FFmpeg ${ffmpeg_legal_file} checksum mismatch. Refusing to package an unverified legal/provenance file.")
            endif()
        endforeach()
        openstudio_copy_runtime_file(
            "${FFMPEG_EXE}"
            "ffmpeg.exe"
            "Copying bundled ffmpeg.exe to output directory"
        )
        openstudio_copy_runtime_file(
            "${OPENSTUDIO_FFMPEG_GPLV3}"
            "licenses/FFmpeg-COPYING.GPLv3.txt"
            "Copying FFmpeg GPLv3 license to output directory"
        )
        openstudio_copy_runtime_file(
            "${OPENSTUDIO_FFMPEG_PROVENANCE}"
            "licenses/FFmpeg-PROVENANCE.json"
            "Copying FFmpeg provenance to output directory"
        )
    else()
        message(FATAL_ERROR
            "Required bundled tools/ffmpeg.exe is missing. Run: "
            "powershell -ExecutionPolicy Bypass -File tools/setup-ffmpeg.ps1")
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

# Copy ONNX Runtime shared library + models to output directory
if(HAS_ONNXRUNTIME AND WIN32)
    openstudio_copy_runtime_file(
        "${ONNXRUNTIME_ROOT}/lib/onnxruntime.dll"
        "onnxruntime.dll"
        "Copying ONNX Runtime DLL to output directory"
    )
elseif(HAS_ONNXRUNTIME AND UNIX AND NOT APPLE)
    file(GLOB OPENSTUDIO_ONNXRUNTIME_LINUX_LIBS "${ONNXRUNTIME_ROOT}/lib/libonnxruntime.so*")
    foreach(OPENSTUDIO_ONNXRUNTIME_LINUX_LIB IN LISTS OPENSTUDIO_ONNXRUNTIME_LINUX_LIBS)
        get_filename_component(OPENSTUDIO_ONNXRUNTIME_LINUX_LIB_NAME "${OPENSTUDIO_ONNXRUNTIME_LINUX_LIB}" NAME)
        openstudio_copy_runtime_file(
            "${OPENSTUDIO_ONNXRUNTIME_LINUX_LIB}"
            "${OPENSTUDIO_ONNXRUNTIME_LINUX_LIB_NAME}"
            "Copying ONNX Runtime Linux shared library ${OPENSTUDIO_ONNXRUNTIME_LINUX_LIB_NAME} to output directory"
        )
    endforeach()
    if(EXISTS "${ONNXRUNTIME_ROOT}/lib/libonnxruntime.so" AND NOT EXISTS "${ONNXRUNTIME_ROOT}/lib/libonnxruntime.so.1")
        add_custom_command(TARGET OpenStudio POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${ONNXRUNTIME_ROOT}/lib/libonnxruntime.so"
                "${OPENSTUDIO_RUNTIME_ASSET_ROOT}/libonnxruntime.so.1"
            COMMENT "Copying ONNX Runtime Linux SONAME fallback libonnxruntime.so.1 to output directory"
        )
    endif()
endif()

if(HAS_ONNXRUNTIME)
    foreach(onnxruntime_notice IN ITEMS LICENSE ThirdPartyNotices.txt)
        set(onnxruntime_notice_path "${ONNXRUNTIME_ROOT}/${onnxruntime_notice}")
        if(NOT EXISTS "${onnxruntime_notice_path}")
            message(FATAL_ERROR
                "ONNX Runtime is enabled but ${onnxruntime_notice_path} is missing. "
                "Reinstall the pinned runtime so its redistribution notices are complete.")
        endif()
        openstudio_copy_runtime_file(
            "${onnxruntime_notice_path}"
            "licenses/ONNXRuntime-${onnxruntime_notice}"
            "Copying ONNX Runtime ${onnxruntime_notice} to output directory"
        )
    endforeach()
endif()

# Copy required core ML model(s) to output directory
set(OPENSTUDIO_MODELS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/resources/models")
set(OPENSTUDIO_BASIC_PITCH_MODEL "${OPENSTUDIO_MODELS_DIR}/basic_pitch_nmp.onnx")
set(OPENSTUDIO_BASIC_PITCH_SHA256
    "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec")
if(NOT EXISTS "${OPENSTUDIO_BASIC_PITCH_MODEL}")
    message(FATAL_ERROR
        "The required bundled Basic Pitch model is missing: ${OPENSTUDIO_BASIC_PITCH_MODEL}")
endif()
file(SHA256 "${OPENSTUDIO_BASIC_PITCH_MODEL}" OPENSTUDIO_BASIC_PITCH_ACTUAL_SHA256)
if(NOT "${OPENSTUDIO_BASIC_PITCH_ACTUAL_SHA256}" STREQUAL "${OPENSTUDIO_BASIC_PITCH_SHA256}")
    message(FATAL_ERROR
        "Basic Pitch model checksum mismatch. Expected ${OPENSTUDIO_BASIC_PITCH_SHA256}, "
        "received ${OPENSTUDIO_BASIC_PITCH_ACTUAL_SHA256}.")
endif()
set(OPENSTUDIO_CORE_MODEL_FILES
    "basic_pitch_nmp.onnx"
    "basic_pitch_nmp.provenance.json"
)

foreach(OPENSTUDIO_CORE_MODEL_FILE IN LISTS OPENSTUDIO_CORE_MODEL_FILES)
    set(OPENSTUDIO_CORE_MODEL_PATH "${OPENSTUDIO_MODELS_DIR}/${OPENSTUDIO_CORE_MODEL_FILE}")
    if(NOT EXISTS "${OPENSTUDIO_CORE_MODEL_PATH}")
        message(FATAL_ERROR "Required core ML asset is missing: ${OPENSTUDIO_CORE_MODEL_PATH}")
    endif()
    openstudio_copy_runtime_file(
        "${OPENSTUDIO_CORE_MODEL_PATH}"
        "models/${OPENSTUDIO_CORE_MODEL_FILE}"
        "Copying core ML model ${OPENSTUDIO_CORE_MODEL_FILE} to output directory"
    )
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

set(AI_MUSIC_GENERATION_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/tools/generate_music.py")
if(EXISTS "${AI_MUSIC_GENERATION_SCRIPT}")
    openstudio_copy_runtime_file(
        "${AI_MUSIC_GENERATION_SCRIPT}"
        "scripts/generate_music.py"
        "Copying music generation helper script to output directory"
    )
endif()

set(AI_STABLE_AUDIO_GENERATION_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/tools/stable_audio3_generate.py")
if(EXISTS "${AI_STABLE_AUDIO_GENERATION_SCRIPT}")
    openstudio_copy_runtime_file(
        "${AI_STABLE_AUDIO_GENERATION_SCRIPT}"
        "scripts/stable_audio3_generate.py"
        "Copying Stable Audio 3 generation helper script to output directory"
    )
endif()

set(WINDOWS_AI_ACCELERATION_MANIFEST "${CMAKE_CURRENT_SOURCE_DIR}/tools/windows-ai-acceleration-manifest.json")
if(EXISTS "${WINDOWS_AI_ACCELERATION_MANIFEST}")
    openstudio_copy_runtime_file(
        "${WINDOWS_AI_ACCELERATION_MANIFEST}"
        "scripts/windows-ai-acceleration-manifest.json"
        "Copying Windows AI acceleration manifest to output directory"
    )
endif()

# Copy Linux AI backend install plans to output directory
if(UNIX AND NOT APPLE)
    foreach(LINUX_PLAN_FILE "ai-runtime-install-plan-linux-cuda.json" "ai-runtime-install-plan-linux-rocm.json")
        set(LINUX_PLAN_SRC "${CMAKE_CURRENT_SOURCE_DIR}/tools/${LINUX_PLAN_FILE}")
        if(EXISTS "${LINUX_PLAN_SRC}")
            openstudio_copy_runtime_file(
                "${LINUX_PLAN_SRC}"
                "scripts/${LINUX_PLAN_FILE}"
                "Copying Linux AI backend plan ${LINUX_PLAN_FILE} to output directory"
            )
        endif()
    endforeach()
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
openstudio_remove_runtime_file(
    "scripts/ace_step_parity_replay.py"
    "Removing ACE-Step parity replay script from output directory"
)
openstudio_remove_runtime_file(
    "scripts/compare_ace_parity_artifacts.py"
    "Removing ACE-Step parity comparison script from output directory"
)
openstudio_remove_runtime_file(
    "scripts/run_ace_step_parity_capture.ps1"
    "Removing ACE-Step parity capture helper from output directory"
)
openstudio_remove_runtime_file(
    "scripts/openstudio_ace_backend/parity_debug.py"
    "Removing ACE-Step parity backend helper from output directory"
)
openstudio_remove_runtime_file(
    "scripts/openstudio_ace_runner.py"
    "Removing legacy OpenStudio ACE split runner from output directory"
)
openstudio_remove_runtime_path(
    "scripts/openstudio_ace_backend"
    "Removing legacy OpenStudio ACE split backend from output directory"
)
set(LEGACY_EXTERNAL_ACE_RUNNER_PATH "scripts/co")
string(APPEND LEGACY_EXTERNAL_ACE_RUNNER_PATH "mfy_ace_runner.py")
openstudio_remove_runtime_file(
    "${LEGACY_EXTERNAL_ACE_RUNNER_PATH}"
    "Removing legacy external ACE runner from output directory"
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
#         # Add other assets here or point to a directory if JUCE supports it better now,
#         # but typically we list files or use a helper to glob.
#         # For now, placeholder.
# )
# Ensure binary data is linked (generated by juce_add_binary_data)
# target_link_libraries(OpenStudio PRIVATE OpenStudio_rc_lib)
