#pragma once

#include <JuceHeader.h>
#if JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #include <windows.h>
 #include <appmodel.h>
#endif

// Package identity comes from Windows, never from a writable marker file or
// environment variable. The same Release binary can serve both distributions.
namespace WindowsPackage
{
inline bool isStoreManaged()
{
   #if JUCE_WINDOWS
    static const bool packaged = [] {
        wchar_t family[256] {};
        UINT32 length = 256;
        return GetCurrentPackageFamilyName(&length, family) == ERROR_SUCCESS
            && juce::String(family) == "SouravDas.OpenStudio_sqr0dv9eeh28p";
    }();
    return packaged;
   #else
    return false;
   #endif
}

inline juce::File fixedWebViewDirectory()
{
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getParentDirectory().getChildFile("WebView2Runtime");
}

inline void configureWebView()
{
   #if JUCE_WINDOWS
    if (isStoreManaged())
    {
        // JUCE's WebView2 loader honours this documented process-local setting.
        // Set it before any availability probe, including detached browsers.
        // A missing runtime must fail startup, not fall back to an untested one.
        const auto folder = fixedWebViewDirectory().getFullPathName();
        SetEnvironmentVariableW(L"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", folder.toWideCharPointer());
    }
   #endif
}
}
