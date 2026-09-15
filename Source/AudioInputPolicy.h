#pragma once
#include <JuceHeader.h>

namespace AudioInputPolicy
{
// JUCE honours explicit XML masks even when initialise() requests zero inputs.
// Sanitize a copy BEFORE opening the device, preserving the original preference.
inline void suppressInput(juce::XmlElement& setup)
{
    if (setup.hasAttribute("audioDeviceName"))
    {
        setup.setAttribute("audioOutputDeviceName", setup.getStringAttribute("audioDeviceName"));
        setup.removeAttribute("audioDeviceName");
    }
    setup.setAttribute("audioInputDeviceName", "");
    setup.setAttribute("audioDeviceInChans", "0");
}

inline void preserveInputPreference(juce::XmlElement& effective, const juce::XmlElement& desired)
{
    if (effective.getStringAttribute("deviceType") != desired.getStringAttribute("deviceType")) return;
    effective.setAttribute("audioInputDeviceName", desired.getStringAttribute("audioInputDeviceName",
        desired.getStringAttribute("audioDeviceName")));
    if (desired.hasAttribute("audioDeviceInChans"))
        effective.setAttribute("audioDeviceInChans", desired.getStringAttribute("audioDeviceInChans"));
    else
        effective.removeAttribute("audioDeviceInChans");
}
}
