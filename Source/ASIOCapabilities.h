#pragma once
#include <JuceHeader.h>

#if JUCE_WINDOWS && JUCE_ASIO
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <juce_audio_devices/native/asio/iasiodrv.h>
#endif

namespace ASIOCapabilities
{
// Control-thread inspection of an inactive driver. Unlike JUCE's streaming
// device constructor this never sets clocks/rates, creates buffers, or starts.
inline bool query(const juce::String& name, juce::DynamicObject& result,
                  juce::DynamicObject& draft)
{
#if JUCE_WINDOWS && JUCE_ASIO
    HKEY root = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ, &root) != ERROR_SUCCESS)
        return false;
    const juce::ScopeGuard closeRoot { [&] { RegCloseKey(root); } };
    juce::String classId;
    for (DWORD index = 0;; ++index)
    {
        wchar_t key[256] {};
        DWORD length = 256;
        if (RegEnumKeyExW(root, index, key, &length, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
        const auto path = "HKEY_LOCAL_MACHINE\\SOFTWARE\\ASIO\\" + juce::String(key) + "\\";
        const auto description = juce::WindowsRegistry::getValue(path + "Description", juce::String(key));
        if (description == name || juce::String(key) == name)
        {
            classId = juce::WindowsRegistry::getValue(path + "CLSID");
            break;
        }
    }
    CLSID id {};
    if (classId.isEmpty() || FAILED(CLSIDFromString(classId.toWideCharPointer(), &id))) return false;
    const auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const juce::ScopeGuard closeCom { [&] { if (SUCCEEDED(com)) CoUninitialize(); } };
    IASIO* driver = nullptr;
    if (FAILED(CoCreateInstance(id, nullptr, CLSCTX_INPROC_SERVER, id, reinterpret_cast<void**>(&driver))) || driver == nullptr)
        return false;
    const juce::ScopeGuard release { [&] { driver->Release(); } };
    if (!driver->init(GetDesktopWindow())) return false;
    long minimum = 0, maximum = 0, preferred = 0, granularity = 0;
    if (driver->getBufferSize(&minimum, &maximum, &preferred, &granularity) != ASE_OK
        || minimum <= 0 || maximum < minimum || maximum > 1048576) return false;
    juce::Array<juce::var> buffers;
    for (long size = minimum; size <= maximum && buffers.size() < 4096;)
    {
        buffers.add(static_cast<int>(size));
        if (granularity == -1) size *= 2;
        else if (granularity > 0) size += granularity;
        else break;
    }
    if (preferred > 0 && preferred >= minimum && preferred <= maximum
        && !buffers.contains(juce::var(static_cast<int>(preferred)))) buffers.add(static_cast<int>(preferred));
    double currentRate = 0;
    driver->getSampleRate(&currentRate);
    juce::Array<juce::var> rates;
    for (const double rate : { 8000., 11025., 16000., 22050., 32000., 44100., 48000., 64000., 88200., 96000., 176400., 192000., 352800., 384000., 705600., 768000. })
        if (driver->canSampleRate(rate) == ASE_OK) rates.add(rate);
    if (currentRate > 0 && !rates.contains(juce::var(currentRate))) rates.add(currentRate);
    if (rates.isEmpty() || buffers.isEmpty()) return false;
    result.setProperty("sampleRates", rates);
    result.setProperty("bufferSizes", buffers);
    result.setProperty("defaultSampleRate", currentRate > 0 ? currentRate : static_cast<double>(rates[0]));
    result.setProperty("defaultBufferSize", static_cast<int>(preferred > 0 ? preferred : minimum));
    long inputs = 0, outputs = 0;
    if (driver->getChannels(&inputs, &outputs) == ASE_OK)
    {
        for (const bool input : { true, false })
        {
            juce::Array<juce::var> names;
            const auto count = juce::jlimit(0L, 4096L, input ? inputs : outputs);
            for (long channel = 0; channel < count; ++channel)
            {
                ASIOChannelInfo info {};
                info.channel = channel;
                info.isInput = input ? ASIOTrue : ASIOFalse;
                const bool read = driver->getChannelInfo(&info) == ASE_OK;
                names.add(read ? juce::String::fromUTF8(info.name, 32) : juce::String(channel + 1));
            }
            draft.setProperty(input ? "inputChannelNames" : "outputChannelNames", names);
            draft.setProperty(input ? "numInputChannels" : "numOutputChannels", static_cast<int>(count));
        }
    }
    return true;
#else
    juce::ignoreUnused(name, result, draft);
    return false;
#endif
}
}
