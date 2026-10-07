#pragma once

#include <JuceHeader.h>
#if JUCE_WINDOWS
 #include <dwmapi.h>
#endif

// Colour the OS-owned frame; retain native hit testing, buttons, snapping and DPI.
// Other platforms continue to use their desktop's native window appearance.
inline void applyNativeWindowTheme(juce::Component& window)
{
   #if JUCE_WINDOWS
    if (auto* peer = window.getPeer())
    {
        auto hwnd = static_cast<HWND>(peer->getNativeHandle());
        const BOOL dark = TRUE;
        ::DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof(dark));
        // Windows 11 honours explicit caption colours even with a light desktop.
        // Older systems ignore unsupported attributes and retain dark-mode support.
        HIGHCONTRASTW contrast { sizeof(HIGHCONTRASTW), 0, nullptr };
        const bool highContrast = ::SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(contrast), &contrast, 0)
            && (contrast.dwFlags & HCF_HIGHCONTRASTON) != 0;
        const COLORREF caption = highContrast ? 0xffffffff : RGB(31, 33, 34);
        const COLORREF text = highContrast ? 0xffffffff : RGB(235, 235, 235);
        ::DwmSetWindowAttribute(hwnd, 35 /* DWMWA_CAPTION_COLOR */, &caption, sizeof(caption));
        ::DwmSetWindowAttribute(hwnd, 36 /* DWMWA_TEXT_COLOR */, &text, sizeof(text));
    }
   #else
    juce::ignoreUnused(window);
   #endif
}
