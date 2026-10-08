#pragma once
#include <JuceHeader.h>
#include <vector>

#if JUCE_WINDOWS
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <propsys.h>
#include <wrl/client.h>
#endif

namespace WindowsAudioDefaultRate
{
// An unopened JUCE WASAPI device reports currentSampleRate=0. Read the OS mix
// format without opening a stream or changing the endpoint's configuration.
inline double query(const juce::String& input, const juce::String& output)
{
#if JUCE_WINDOWS
    using Microsoft::WRL::ComPtr;
    const auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const juce::ScopeGuard closeCom { [&] { if (SUCCEEDED(com)) CoUninitialize(); } };
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(enumerator.GetAddressOf())))) return 0;
    auto rateFor = [&](EDataFlow flow, const juce::String& selected) -> double
    {
        if (selected.isEmpty()) return 0;
        ComPtr<IMMDeviceCollection> collection;
        if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, collection.GetAddressOf()))) return 0;
        ComPtr<IMMDevice> defaultDevice;
        juce::String defaultId;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, eMultimedia, defaultDevice.GetAddressOf())))
        {
            LPWSTR id = nullptr;
            if (SUCCEEDED(defaultDevice->GetId(&id))) { defaultId = id; CoTaskMemFree(id); }
        }
        UINT count = 0;
        collection->GetCount(&count);
        juce::StringArray names;
        std::vector<ComPtr<IMMDevice>> devices;
        for (UINT index = 0; index < count; ++index)
        {
            ComPtr<IMMDevice> device;
            ComPtr<IPropertyStore> properties;
            if (FAILED(collection->Item(index, device.GetAddressOf()))
                || FAILED(device->OpenPropertyStore(STGM_READ, properties.GetAddressOf()))) continue;
            const PROPERTYKEY friendlyName = { { 0xa45c254e, 0xdf1c, 0x4efd,
                { 0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0 } }, 14 };
            PROPVARIANT value {};
            juce::String name;
            if (SUCCEEDED(properties->GetValue(friendlyName, &value)) && value.vt == VT_LPWSTR) name = value.pwszVal;
            PropVariantClear(&value);
            LPWSTR id = nullptr;
            bool isDefault = false;
            if (SUCCEEDED(device->GetId(&id))) { isDefault = defaultId == juce::String(id); CoTaskMemFree(id); }
            const int insertAt = isDefault ? 0 : names.size();
            names.insert(insertAt, name);
            devices.insert(devices.begin() + insertAt, device);
        }
        // Match JUCE's default-first, duplicate-name numbering exactly.
        names.appendNumbersToDuplicates(false, false);
        const int selectedIndex = names.indexOf(selected);
        if (selectedIndex < 0) return 0;
        ComPtr<IAudioClient> client;
        if (FAILED(devices[static_cast<size_t>(selectedIndex)]->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER,
            nullptr, reinterpret_cast<void**>(client.GetAddressOf())))) return 0;
        WAVEFORMATEX* format = nullptr;
        if (FAILED(client->GetMixFormat(&format)) || format == nullptr) return 0;
        const auto rate = static_cast<double>(format->nSamplesPerSec);
        CoTaskMemFree(format);
        return rate;
    };
    const auto inputRate = rateFor(eCapture, input);
    const auto outputRate = rateFor(eRender, output);
    return inputRate > 0 && outputRate > 0 ? juce::jmin(inputRate, outputRate) : juce::jmax(inputRate, outputRate);
#else
    juce::ignoreUnused(input, output);
    return 0;
#endif
}
}
