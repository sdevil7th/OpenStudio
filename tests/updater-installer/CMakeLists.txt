cmake_minimum_required(VERSION 3.22)
project(OpenStudioInstallerQualification LANGUAGES C CXX)
if(APPLE)
    enable_language(OBJCXX)
endif()
include(FetchContent)
FetchContent_Declare(juce GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 9.0.1 GIT_SHALLOW TRUE)
FetchContent_GetProperties(juce)
if(NOT juce_POPULATED)
    FetchContent_Populate(juce)
endif()
get_filename_component(root "../.." ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
add_executable(OpenStudioUpdateInstaller
    "${root}/Source/UpdateInstallerMain.cpp"
    "${root}/Source/UpdateInstaller.cpp"
    "${root}/Source/UpdateManifest.cpp"
    "${root}/thirdparty/monocypher/monocypher.c"
    "${root}/thirdparty/monocypher/monocypher-ed25519.c"
    "${juce_SOURCE_DIR}/modules/juce_core/juce_core.cpp"
    "${juce_SOURCE_DIR}/modules/juce_core/juce_core_CompilationTime.cpp"
    "${juce_SOURCE_DIR}/modules/juce_cryptography/juce_cryptography.cpp")
target_include_directories(OpenStudioUpdateInstaller PRIVATE "${juce_SOURCE_DIR}/modules" "${root}/thirdparty/monocypher")
target_compile_features(OpenStudioUpdateInstaller PRIVATE cxx_std_17)
find_package(ZLIB REQUIRED)
target_link_libraries(OpenStudioUpdateInstaller PRIVATE ZLIB::ZLIB)
target_compile_definitions(OpenStudioUpdateInstaller PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0
    JUCE_STANDALONE_APPLICATION=1 NDEBUG=1
    OPENSTUDIO_INSTALLER_VERSION="0.0.1" OPENSTUDIO_INSTALLER_CHANNEL="stable")
if(APPLE)
    set_source_files_properties("${juce_SOURCE_DIR}/modules/juce_core/juce_core.cpp" PROPERTIES LANGUAGE OBJCXX)
    target_link_libraries(OpenStudioUpdateInstaller PRIVATE "-framework Cocoa" "-framework CoreServices" "-framework IOKit" "-framework Security")
else()
    target_link_libraries(OpenStudioUpdateInstaller PRIVATE pthread dl rt)
endif()
set_source_files_properties("${root}/Source/UpdateInstaller.cpp" "${root}/Source/UpdateInstallerMain.cpp"
    PROPERTIES COMPILE_OPTIONS "-Wall;-Wextra;-Wpedantic;-Werror")
